# Agent notes

Single-file Node recorder (`zoom-record.js`) plus shell tests. See README.md for usage.

## Testing

- Run `test/run-tests.sh [workdir]` after any change to `zoom-record.js`. It takes about 4 minutes,
  so run it in the background and poll. It fails right away if another recorder is running: only one can run
  at a time, because the PulseAudio D-Bus name is shared. Never start a second recorder while the suite runs.
- New Zoom UI behaviour belongs in `test/fake-meeting.html`, behind a query parameter, with a check in
  `run-tests.sh`. Check recordings with `test/verify-mkv.sh` or the frame pixels, not just the exit code.
- Live Zoom can't be tested on demand. `zoom.us/test` blocks this browser as an automated bot. Do not
  work around bot detection, CAPTCHA, registration or admission rules. Use the logs and screenshots
  from the user's real runs instead (`~/recordings/*_logs`). Each state change in `recorder.log`
  lists the visible controls (`ui: ...`).
- Don't use `pkill -f`/`pgrep -f` with patterns like `zoom-record.js`: they also match your own shell
  command and kill the test. Use `pgrep -x node -a | grep zoom-record`.

## Secrets

- Zoom links carry an attendee access token (`tk`, sometimes `pwd`). Never commit one or write one
  unredacted. `redact()` in `zoom-record.js` must cover every log line and dump, including tokens Zoom
  embeds in page JS (`webinarToken`). `run-zoom-recorder.sh` reads the link from `ZOOM_URL` for this reason.

## Process lifecycle (easy to break)

- ffmpeg must be stopped **before** PulseAudio. If PulseAudio goes first, ffmpeg's pulse input hangs forever.
- ffmpeg must get exactly **one** stop signal. A second SIGINT/SIGTERM makes it exit immediately without
  writing the file, which leaves a 0-byte MKV.
- The guardian shell (`startGuardian`) cleans up if Node is SIGKILLed. Its `--pdeathsig` SIGTERM arrives
  once per dying Node thread, so its trap first ignores further SIGTERMs. Keep that.
- Helpers write their PIDs to the temporary directory's `pids`/`ffmpeg.pid` for the guardian. Anything a new
  helper starts must also die with it: the tests' leftover check covers Xvfb, PulseAudio, ffmpeg, Chromium
  and `sleep infinity`.
