#!/usr/bin/env node
// Unattended Zoom meeting/webinar recorder: Xvfb + PulseAudio null sink + Playwright Chromium + FFmpeg -> MKV.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { chromium } = require('playwright');

const USAGE = `Usage: zoom-record.js -u URL -d DURATION -o OUTPUT.mkv [options]
  -u, --url URL          Zoom join link (/j/, /w/, /wc/ or /s/ form)
  -d, --duration DUR     Recording length once joined, e.g. 90m, 1h30m, 3600 (seconds)
  -o, --output FILE      Output .mkv file (must not exist)
  -n, --name NAME        Display name if Zoom asks (default: Recorder)
  -e, --email EMAIL      Email if the webinar asks for one
  -w, --wait DUR         Max time to wait for joining/host start (default: 3h)
      --size WxH         Screen and video size (default: 1920x1080)
      --fps N            Frame rate (default: 25)
      --log-dir DIR      Logs and screenshots (default: OUTPUT without extension + "_logs")
      --shot-every DUR   Periodic screenshot interval (default: 5m)
      --offline-grace DUR  Stop if "waiting for host" returns and lasts this long (default: 5m)
  -h, --help`;

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseDuration(s) {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !s) throw new Error(`invalid duration: ${s}`);
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
let logFile = null;
// Join tokens (tk) and passcodes (pwd) grant access; never write them to logs or diagnostics.
const secrets = []; // literal tk/pwd values from the input URL; Zoom also embeds them in page JS (e.g. webinarToken)
const redact = s => secrets.reduce((t, v) => t.split(v).join('<redacted>'),
  String(s).replace(/([?&](?:tk|pwd)=)[^&\s"'#]+/gi, '$1<redacted>'));
function log(...a) {
  const line = redact(`${new Date().toISOString()} ${a.join(' ')}`);
  console.error(line);
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}

// Convert any Zoom join link into the web-client URL, keeping pwd/tk/uuid query params.
function webClientUrl(raw) {
  const u = new URL(raw);
  const m = u.pathname.match(/^\/(?:j|w|s|wc|wc\/join|my)\/(\d{9,12})/) || u.pathname.match(/^\/wc\/(\d{9,12})\//);
  if (!m) return raw; // unknown form, let Zoom deal with it
  return `${u.protocol}//${u.host}/wc/join/${m[1]}${u.search}`;
}

// Spawn a helper process; its pid is recorded in pidFile for the guardian.
function spawnChild(name, cmd, args, opts, pidFile) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  fs.appendFileSync(pidFile, `${p.pid}\n`);
  p.stderrTail = '';
  p.stderr?.on('data', d => { p.stderrTail = (p.stderrTail + d).slice(-4000); });
  p.exited = new Promise(r => p.on('exit', (code, sig) => { log(`${name} exited code=${code} signal=${sig}`); r(code ?? sig); }));
  return p;
}
async function stopChild(p, name, graceMs = 5000) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGTERM');
  if (await Promise.race([p.exited.then(() => true), sleep(graceMs)])) return;
  log(`${name} did not exit, killing`);
  p.kill('SIGKILL');
  await p.exited;
}
// If we die abruptly (SIGKILL, OOM), this guardian gets SIGTERM via pdeathsig. It stops ffmpeg first so the MKV
// is finalized (ffmpeg's pulse input deadlocks if PulseAudio vanishes first), then the other helpers, then removes dir.
function startGuardian(dir) {
  const script = `cd "$1"; trap 'kill $s; f=$(cat ffmpeg.pid 2>/dev/null); [ -n "$f" ] && kill -TERM $f
    i=0; while [ -n "$f" ] && kill -0 $f 2>/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
    kill -TERM $f $(cat pids) 2>/dev/null; sleep 2; kill -KILL $f $(cat pids) 2>/dev/null; cd /; rm -rf "$1"; exit' TERM
    sleep infinity & s=$!; wait`;
  return spawn('setpriv', ['--pdeathsig', 'SIGTERM', '--', 'sh', '-c', script, 'guardian', dir], { stdio: 'ignore' });
}
const pactl = (env, ...a) => execFileSync('pactl', a, { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });

// ---------- environment: Xvfb + PulseAudio ----------
async function startXvfb(w, h, dir) {
  const p = spawnChild('Xvfb', 'Xvfb', ['-displayfd', '3', '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp', '-nolisten', 'unix', '+extension', 'RANDR'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }, path.join(dir, 'pids'));
  const display = await Promise.race([
    new Promise(r => p.stdio[3].on('data', d => r(':' + String(d).trim()))),
    p.exited.then(() => { throw new Error(`Xvfb failed: ${p.stderrTail}`); }),
    sleep(10000).then(() => { throw new Error('Xvfb start timeout'); }),
  ]);
  log(`Xvfb on ${display}`);
  return { p, display };
}

async function startPulse(dir) {
  const sock = path.join(dir, 'pulse.sock');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, PULSE_RUNTIME_PATH: dir, PULSE_SERVER: `unix:${sock}`, PULSE_SINK: 'rec' };
  const p = spawnChild('pulseaudio', 'pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=no', '--disallow-exit',
    '--disallow-module-loading=no', `--load=module-native-protocol-unix socket=${sock} auth-anonymous=1`,
    '--load=module-null-sink sink_name=rec rate=48000 sink_properties=device.description=rec', '--load=module-always-sink'], { env }, path.join(dir, 'pids'));
  for (let i = 0; i < 50; i++) {
    if (p.exitCode !== null) break;
    try { pactl(env, 'set-default-sink', 'rec'); log('PulseAudio ready, sink "rec"'); return { p, env }; } catch { await sleep(200); }
  }
  throw new Error(`PulseAudio failed to start: ${p.stderrTail}`);
}

// Ensure Chromium's playback streams are unmuted at 100% and going to our sink. Returns stream count.
function checkAudioStreams(env) {
  let out;
  try { out = pactl(env, 'list', 'sink-inputs'); } catch { return 0; }
  const blocks = out.split(/^Sink Input #/m).slice(1);
  for (const b of blocks) {
    const id = b.split('\n')[0].trim();
    if (/Mute: yes/.test(b)) { log(`unmuting sink-input ${id}`); pactl(env, 'set-sink-input-mute', id, '0'); }
    if (!/Volume:.* 100%/.test(b.split('\n').find(l => /^\s*Volume:/.test(l)) || '')) pactl(env, 'set-sink-input-volume', id, '100%');
  }
  return blocks.length;
}

// ---------- recorder ----------
function startFfmpeg({ display, w, h, fps, duration, output, env, dir }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats',
    '-thread_queue_size', '1024', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${w}x${h}`, '-i', display,
    '-thread_queue_size', '1024', '-f', 'pulse', '-sample_rate', '48000', '-channels', '2', '-i', 'rec.monitor',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    '-c:a', 'libopus', '-b:a', '128k', '-t', String(duration), output];
  log(`ffmpeg ${args.join(' ')}`);
  const p = spawnChild('ffmpeg', 'ffmpeg', args, { env, stdio: ['pipe', 'ignore', 'pipe'] }, path.join(dir, 'ffmpeg.pid'));
  p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log(`ffmpeg: ${l}`)));
  return p;
}
async function stopFfmpeg(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  log('stopping ffmpeg');
  try { p.stdin.write('q'); p.stdin.end(); } catch {}
  if (await Promise.race([p.exited.then(() => true), sleep(20000)])) return;
  p.kill('SIGINT');
  if (await Promise.race([p.exited.then(() => true), sleep(10000)])) return;
  p.kill('SIGKILL');
  await p.exited;
}

// ---------- Zoom page automation ----------
const RE = {
  captcha: /verify you are (a )?human|i'm not a robot|complete the captcha/i,
  fatal: /automated bots aren't allowed|meeting (id|number) is (not valid|invalid)|invalid meeting id|this (meeting|webinar) (link )?(is invalid|has expired|does not exist)|registration (is )?required|you need to register|only (authenticated|signed[- ]in) users|sign in to join|this meeting has been locked|host has removed you|you have been removed|passcode (is )?(wrong|incorrect)|your browser is not supported|meeting is at capacity|(meeting|webinar) is full/i,
  ended: /(meeting|webinar) (has been |was )?ended by (the )?host|this (meeting|webinar) has (been )?ended|the (meeting|webinar) has ended/i,
  waiting: /waiting for (the )?host|host (has not|hasn't) (yet )?(started|joined)|(meeting|webinar) (will begin soon|has not started|hasn't started|is scheduled for)|please wait.{0,60}(let you in|admit)|waiting room|practice session/i,
};
// Buttons/links we always click when visible, in priority order. Never anything that leaves.
const CLICKS = [
  ['cookies', 'role', /^(decline|reject)( all)? cookies$/i],
  ['no camera/mic', 'text', /^continue without (microphone and camera|microphone|camera)$/i],
  ['join audio by computer', 'role', /^(join audio by computer|join with computer audio|join computer audio|join audio)$/i],
  ['dismiss', 'role', /^(got it|ok|okay|dismiss|i agree|agree|accept|not now|later|maybe later|continue|close this popover)$/i],
  ['decline request', 'role', /^(stay muted|stay as (an )?attendee|keep video off)$/i],
  ['test-meeting camera check', 'role', /^yes$/i, /do you see yourself\?/i], // only with that dialog present
];

async function visibleText(page) {
  return page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
}
async function tryClick(page, kind, re) {
  for (const frame of page.frames()) {
    const loc = (kind === 'role' ? frame.getByRole('button', { name: re }) : frame.getByText(re)).first();
    try {
      if (await loc.isVisible({ timeout: 0 }) && await loc.isEnabled({ timeout: 0 })) {
        const label = ((await loc.getAttribute('aria-label').catch(() => '')) || (await loc.innerText().catch(() => ''))).trim().slice(0, 60);
        await loc.click({ timeout: 3000 });
        return label || true;
      }
    } catch {}
  }
  return false;
}
// Close a persistent notice banner whose × is often not a <button>: walk up from the notice text to the nearest
// small container holding a close control, click it, and hide that container in case the click does nothing.
async function dismissBanner(page, re) {
  return page.evaluate(src => {
    const re = new RegExp(src, 'i'), CLOSE = '[aria-label*=close i], [class*=close i], [title*=close i]';
    const leaf = [...document.body.querySelectorAll('*')].reverse().find(e => re.test(e.innerText || '') && e.getClientRects().length);
    if (!leaf) return false;
    let box = leaf;
    while (!box.querySelector(CLOSE) && box.parentElement && box.parentElement !== document.body && box.parentElement.innerText.length < 300)
      box = box.parentElement;
    box.querySelector(CLOSE)?.click();
    box.style.setProperty('display', 'none', 'important');
    return true;
  }, re.source).catch(() => false);
}
async function inMeetingUi(page) {
  // The footer auto-hides, so test presence of meeting controls in DOM rather than visibility.
  return page.evaluate(() => !!document.querySelector('#wc-footer, .footer__leave-btn, [class*="footer__leave-btn"]')).catch(() => false);
}
// Compact list of visible controls, logged on state changes for diagnostics.
async function uiSummary(page) {
  return page.evaluate(() => [...document.querySelectorAll('button,[role=button],input,[role=dialog],[role=alertdialog]')]
    .filter(e => e.offsetParent !== null || e.getClientRects().length)
    .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : ''}` +
      `${(e.innerText || e.value || '').trim() ? ' "' + (e.innerText || e.value).trim().replace(/\s+/g, ' ').slice(0, 50) + '"' : ''}`)
    .slice(0, 60).join(' | ')).catch(e => String(e));
}

// One pass over the page: handle forms/dialogs, return the observed state.
async function tick(page, opts, st) {
  const text = await visibleText(page);
  if (RE.captcha.test(text) || await page.locator('iframe[src*="recaptcha"][src*="bframe"]').first().isVisible().catch(() => false))
    return 'captcha';
  if (RE.fatal.test(text)) return 'fatal';
  if (/hardware acceleration/i.test(text) && await dismissBanner(page, /hardware acceleration/i)) {
    log('dismissed hardware acceleration banner'); return 'acting';
  }
  for (const [label, kind, re, onlyIf] of CLICKS) {
    if (onlyIf && !onlyIf.test(text)) continue;
    const c = await tryClick(page, kind, re);
    if (c) { log(`clicked ${label}: "${c}"`); return 'acting'; }
  }
  // Pre-join form: name / email / Join.
  const name = page.locator('#input-for-name, input[placeholder*="name" i]').first();
  if (await name.isVisible().catch(() => false)) {
    if (!(await name.inputValue().catch(() => ''))) { await name.fill(opts.name); log('filled name'); }
    const email = page.locator('#input-for-email, input[type="email"], input[placeholder*="email" i]').first();
    if (await email.isVisible().catch(() => false) && !(await email.inputValue().catch(() => ''))) {
      if (!opts.email) return 'needs-email';
      await email.fill(opts.email); log('filled email');
    }
    const join = page.getByRole('button', { name: /^join$/i }).first();
    if (await join.isEnabled().catch(() => false) && Date.now() - (st.lastJoin || 0) > 10000) {
      await join.click({ timeout: 3000 }).then(() => { st.lastJoin = Date.now(); log('clicked: Join'); }).catch(() => {});
    }
    return 'prejoin';
  }
  if (RE.ended.test(text) && !(await inMeetingUi(page))) return 'ended';
  if (RE.ended.test(text) && /\/post|leave/i.test(page.url())) return 'ended';
  if (RE.waiting.test(text)) return 'waiting';
  if (await inMeetingUi(page)) return 'meeting';
  return 'loading';
}

// ---------- main ----------
async function main() {
  const { values: a } = parseArgs({ options: {
    url: { type: 'string', short: 'u' }, duration: { type: 'string', short: 'd' }, output: { type: 'string', short: 'o' },
    name: { type: 'string', short: 'n', default: 'Recorder' }, email: { type: 'string', short: 'e' },
    wait: { type: 'string', short: 'w', default: '3h' }, size: { type: 'string', default: '1920x1080' },
    fps: { type: 'string', default: '25' }, 'log-dir': { type: 'string' }, 'shot-every': { type: 'string', default: '5m' },
    'offline-grace': { type: 'string', default: '5m' },
    help: { type: 'boolean', short: 'h' } } });
  if (a.help || !a.url || !a.duration || !a.output) { console.error(USAGE); return a.help ? 0 : 2; }
  const duration = parseDuration(a.duration), waitSec = parseDuration(a.wait), shotEvery = parseDuration(a['shot-every']) * 1000,
    offlineGrace = parseDuration(a['offline-grace']) * 1000;
  const [w, h] = a.size.split('x').map(Number), fps = Number(a.fps);
  for (const k of ['tk', 'pwd']) { const v = new URL(a.url).searchParams.get(k); if (v && v.length >= 6) secrets.push(v, encodeURIComponent(v)); }
  const output = path.resolve(a.output);
  if (fs.existsSync(output)) throw new Error(`output exists: ${output}`);
  const logDir = path.resolve(a['log-dir'] || output.replace(/\.[^./]+$/, '') + '_logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  logFile = path.join(logDir, 'recorder.log');
  log(`url=${a.url} duration=${duration}s output=${output} wait=${waitSec}s size=${w}x${h}@${fps}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomrec-'));
  fs.writeFileSync(path.join(tmp, 'pids'), '');
  const guardian = startGuardian(tmp);
  const cleanups = [() => fs.rmSync(tmp, { recursive: true, force: true }), () => guardian.kill('SIGKILL')];
  let stopping = false, ffmpeg = null, browser = null, page = null;
  const onSignal = sig => {
    if (stopping) { log(`second ${sig}, exiting now`); process.exit(130); }
    stopping = true; log(`received ${sig}, finishing recording`);
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGHUP', onSignal);

  let shotN = 0;
  const shot = async label => {
    const f = path.join(logDir, `${String(++shotN).padStart(3, '0')}-${label}.png`);
    await page?.screenshot({ path: f, timeout: 10000 }).then(() => log(`screenshot ${path.basename(f)}`)).catch(e => log(`screenshot failed: ${e.message}`));
  };

  let exitCode = 0;
  try {
    const x = await startXvfb(w, h, tmp); cleanups.push(() => stopChild(x.p, 'Xvfb'));
    const pa = await startPulse(tmp); cleanups.push(() => stopChild(pa.p, 'pulseaudio'));
    const env = { ...pa.env, DISPLAY: x.display };

    const openPage = async () => {
      if (!browser?.isConnected()) {
        browser = await chromium.launch({ headless: false, env, ignoreDefaultArgs: ['--mute-audio'],
          args: ['--kiosk', `--window-size=${w},${h}`, '--window-position=0,0', '--autoplay-policy=no-user-gesture-required',
            '--disable-infobars', '--disable-features=Translate,MediaRouter', '--disable-notifications', '--no-default-browser-check'] });
        browser.on('disconnected', () => log('browser disconnected'));
      }
      const ctx = await browser.newContext({ viewport: null, permissions: [] });
      page = await ctx.newPage();
      // --kiosk is ignored for Playwright-created windows; go fullscreen via CDP so only page content is captured.
      const cdp = await ctx.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
      page.on('crash', () => log('page crashed'));
      page.on('dialog', d => { log(`js dialog: ${d.type()} ${d.message()}`); d.dismiss().catch(() => {}); });
      let target = a.url;
      if (/^https?:\/\/(www\.)?zoom\.us\/test\/?$/.test(target)) { // Zoom's test page: get a fresh one-person test meeting
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('#btnJoinTest').click({ timeout: 30000 });
        await page.waitForURL(/\/j\/\d+/, { timeout: 30000, waitUntil: 'commit' });
        target = page.url();
      }
      target = webClientUrl(target);
      log(`opening ${target}`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    };
    cleanups.push(() => browser?.close().catch(() => {}));
    await openPage();

    // Phase 1: get into the meeting (waiting for host as long as allowed).
    const st = {}; let state = '', joinDeadline = Date.now() + waitSec * 1000, lastShot = 0;
    while (!stopping) {
      if (Date.now() > joinDeadline) { await shot('join-timeout'); throw new Error(`not in meeting after ${waitSec}s (state: ${state})`); }
      const s = await tick(page, a, st);
      if (s !== state) { log(`state: ${state || '-'} -> ${s}; ui: ${await uiSummary(page)}`); state = s; await shot(s); lastShot = Date.now(); }
      else if (Date.now() - lastShot > shotEvery) { await shot(s); lastShot = Date.now(); }
      if (s === 'captcha') throw new Error('CAPTCHA shown; not bypassing. Try again later or from another network.');
      if (s === 'fatal' || s === 'needs-email') throw new Error(`cannot join (${s}): ${(await visibleText(page)).slice(0, 300).replace(/\s+/g, ' ')}`);
      if (s === 'ended') throw new Error('meeting already ended');
      if (s === 'meeting') break;
      await sleep(s === 'acting' ? 500 : 2000);
    }

    // Phase 2: record. Keep handling dialogs (late audio prompts etc.); recover from page crashes.
    if (!stopping) {
      await sleep(2000); // let the meeting UI settle and audio dialog appear first
      for (let i = 0; i < 10 && (await tick(page, a, st)) === 'acting'; i++) await sleep(500);
      ffmpeg = startFfmpeg({ display: x.display, w, h, fps, duration, output, env, dir: tmp });
      cleanups.push(() => stopFfmpeg(ffmpeg));
      const started = Date.now(); let lastAudioWarn = 0, noMeetingSince = 0, waitingSince = 0;
      log(`recording for ${duration}s`);
      await shot('recording-start'); lastShot = Date.now();
      while (!stopping && ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
        await Promise.race([ffmpeg.exited, sleep(2000)]);
        if (page.isClosed() || !browser.isConnected()) {
          log('browser/page gone, reopening and rejoining'); try { await openPage(); } catch (e) { log(`reopen failed: ${e.message}`); }
          continue;
        }
        const s = await tick(page, a, st);
        if (s !== state) { log(`state: ${state} -> ${s}; ui: ${await uiSummary(page)}`); state = s; await shot(s); lastShot = Date.now(); }
        if (s === 'ended') { log('meeting ended, stopping'); break; }
        // Zoom navigated away from the web client (e.g. post-attendee page): the webinar is over for us.
        if (/zoom\.us\//.test(page.url()) && (!/\/wc\//.test(page.url()) || /\/leave|postattendee/.test(page.url())) && s !== 'meeting') {
          log('left the web client, stopping'); await shot('left'); break;
        }
        // Back on "waiting for host" after broadcasting: the stream went offline. Stop if it stays that way.
        waitingSince = s === 'waiting' ? (waitingSince || Date.now()) : 0;
        if (waitingSince && Date.now() - waitingSince > offlineGrace) { log(`stream offline for ${offlineGrace / 1000}s, stopping`); break; }
        if (s === 'captcha' || s === 'fatal') { log(`unexpected state ${s} during recording, stopping`); exitCode = 3; break; }
        // Lost the meeting UI for a long time without explanation: reload to rejoin.
        noMeetingSince = s === 'meeting' || s === 'acting' || s === 'waiting' ? 0 : (noMeetingSince || Date.now());
        if (noMeetingSince && Date.now() - noMeetingSince > 120000) {
          log('meeting UI missing for 2 min, reloading'); noMeetingSince = 0; await shot('reload');
          await page.goto(webClientUrl(a.url), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log(`reload failed: ${e.message}`));
        }
        const n = checkAudioStreams(pa.env);
        if (n === 0 && s === 'meeting' && Date.now() - lastAudioWarn > 60000) { log('warning: no browser audio stream in PulseAudio yet'); lastAudioWarn = Date.now(); }
        if (Date.now() - lastShot > shotEvery) { await shot('periodic'); lastShot = Date.now(); }
      }
      if (ffmpeg.exitCode !== null && ffmpeg.exitCode !== 0) { exitCode = 4; log(`ffmpeg failed: ${ffmpeg.stderrTail}`); }
      log(`recorded ${Math.round((Date.now() - started) / 1000)}s`);
    }
  } catch (e) {
    exitCode = 1;
    log(`ERROR: ${e.stack || e}`);
    await shot('error');
    if (page) await page.content().then(c => fs.writeFileSync(path.join(logDir, 'error-page.html'), redact(c))).catch(() => {});
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch (e) { log(`cleanup: ${e.message}`); } }
  }
  if (fs.existsSync(output)) {
    const probe = execFileSync('sh', ['-c', 'ffmpeg -hide_banner -nostats -i "$1" -map 0:a -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"; ffprobe -v error -show_entries format=duration -of default=nw=1 "$1"', 'sh', output], { encoding: 'utf8', timeout: 600000 });
    log(`output ${output} ${fs.statSync(output).size} bytes; ${probe.replace(/\[Parsed_volumedetect_0 @ \w+\] /g, '').replace(/\n/g, '; ')}`);
    if (/max_volume: -91/.test(probe)) log('warning: recorded audio is silent');
  } else if (exitCode === 0) { exitCode = 1; log('no output file produced'); }
  return exitCode;
}

main().then(c => process.exit(c), e => { log(`fatal: ${e.stack || e}`); process.exit(1); });
