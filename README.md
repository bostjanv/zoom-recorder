# zoom-recorder

Records a Zoom webinar or meeting to a single MKV file on a headless Linux VM, unattended.
It joins with the Zoom web client as a guest (no login), waits for the host, joins audio, and
captures screen and sound until the webinar ends or a time limit is reached.

Pipeline: Xvfb (virtual display) + PulseAudio null sink (virtual sound card) + Playwright Chromium
+ FFmpeg (x11grab + pulse → H.264/Opus MKV, 1080p25).

## Setup (Ubuntu)

```bash
sudo apt-get install -y ffmpeg xvfb pulseaudio pulseaudio-utils npm
npm install
npx playwright install --with-deps chromium
```

## Usage

The usual way is the launcher. It runs detached, so you can log out, and writes
`~/recordings/webinar-<date>_<time>.mkv` plus a `_logs` folder:

```bash
ZOOM_URL='https://us06web.zoom.us/w/...?tk=...' ./run-zoom-recorder.sh
tail -f ~/recordings/webinar-*_logs/recorder.log
```

Or call the recorder directly:

```bash
node zoom-record.js -u URL -d 3h -w 4h -o out.mkv
```

| Option | Meaning |
|---|---|
| `-u URL` | Full join link; keep all query parameters (`tk`, `pwd`, …) |
| `-d DUR` | Maximum recording length after joining (`90m`, `1h30m`, `3600`) |
| `-w DUR` | How long to wait for the host to start (default `3h`) |
| `-o FILE` | Output `.mkv`; must not exist |
| `--offline-grace DUR` | Stop if "waiting for host" comes back and lasts this long (default `5m`) |
| `-n NAME`, `-e EMAIL` | Only used if Zoom asks for them |

Run `node zoom-record.js -h` for the full list.

Recording stops at whichever comes first: `-d` is reached, the host ends the webinar, Zoom leaves
the web client, the stream goes offline for `--offline-grace`, or the recorder gets SIGINT/SIGTERM.
On a SIGTERM (`kill -TERM <pid>`) the MKV is finalized properly, and even a SIGKILL leaves a playable file.

Exit codes: `0` recorded; `1` could not join or set up (timeout, invalid link, CAPTCHA, bot block);
`2` bad arguments; `3` Zoom blocked or failed during recording; `4` ffmpeg failed.

The log directory holds `recorder.log`, with each state change and the controls visible on screen,
plus screenshots on every state change and every 5 minutes. After an error it also has a page dump.
Join tokens (`tk`, `pwd`) are redacted from all of them.

## Tests

```bash
test/run-tests.sh            # offline scenarios against test/fake-meeting.html, ~4 min
test/verify-mkv.sh FILE.mkv  # fails on silent audio or frozen video
```

The offline suite never contacts Zoom.

## Limitations

- One recorder at a time per machine, because the PulseAudio D-Bus name is shared.
- It uses about 3 of 4 cores at 1080p25 (ffmpeg plus software-rendered Chromium).
- Zoom changes its web UI without notice. A new dialog may need a rule in `CLICKS` in `zoom-record.js`.
- It does not bypass CAPTCHA, registration, waiting rooms or Zoom's bot detection.
  Zoom's public test meeting (`zoom.us/test`) currently rejects it as an automated bot.
