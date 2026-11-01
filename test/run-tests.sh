#!/usr/bin/env bash
# Offline lifecycle tests against test/fake-meeting.html (no Zoom traffic).
# Usage: test/run-tests.sh [workdir]
set -u
cd "$(dirname "$0")/.."
W=${1:-$(mktemp -d)}; mkdir -p "$W"
FAKE="file://$PWD/test/fake-meeting.html"
pass=0; fail=0
check() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
leftovers() { pgrep -x 'Xvfb|pulseaudio|ffmpeg' >/dev/null || pgrep -f 'ms-playwright/chromium' >/dev/null; }
start() { # name url duration [extra args...]; sets PID, LOG, OUT
  OUT=$W/$1.mkv; LOG=$W/$1.log; local u=$2 d=$3; shift 3
  node zoom-record.js -u "$u" -d "$d" -o "$OUT" "$@" >"$LOG" 2>&1 & PID=$!
}
wait_rec() { for _ in $(seq 60); do grep -q 'recording for' "$LOG" && return 0; sleep 1; done; return 1; }
# Average colour of a 600x60 box at x,y in the frame at 5 s: magenta / yellow / low (neither).
rgb() { ffmpeg -v error -ss 5 -i "$OUT" -frames:v 1 -vf "crop=600:60:$1:$2,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 |
  awk '{ if ($1>180 && $3>180 && $2<100) print "magenta"; else if ($1>180 && $2>180 && $3<100) print "yellow"; else print "low" }'; }
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null | cut -d. -f1; }

leftovers && { echo "recorder processes already running; stop them first"; exit 2; }

echo "1. waiting for host -> meeting -> late audio prompt -> host ends"
start ended "$FAKE?wait=6&end=20" 120 -w 60; wait $PID; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "saw waiting state" "grep -q 'state: - -> waiting' $LOG"
check "clicked late Join Audio" "grep -q 'clicked join audio' $LOG"
check "stopped on meeting end (~20s)" "[ \$(dur) -ge 15 ] && [ \$(dur) -le 23 ]"
check "audible audio, moving video" "test/verify-mkv.sh $OUT 15 >$W/ended.verify"
check "no leftover processes" "! leftovers"

echo "2. stops at --duration"
start duration "$FAKE" 12; wait $PID; rc=$?
check "exit 0 and ~12s" "[ $rc = 0 ] && [ \$(dur) -ge 11 ] && [ \$(dur) -le 13 ]"
check "acceleration banner (magenta) hidden, other warning (yellow) kept and moved up into its slot" "[ \"\$(rgb 600 60)\" = yellow ]"

echo "3. SIGTERM during recording finishes the file"
start sigterm "$FAKE" 300; wait_rec; sleep 8; kill -TERM $PID; wait $PID; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "valid file with content" "test/verify-mkv.sh $OUT 5 >$W/sigterm.verify"
check "no leftover processes" "! leftovers"

echo "4. SIGKILL of the recorder leaves no orphans"
start sigkill "$FAKE" 300; wait_rec; sleep 5; kill -KILL $PID; wait $PID 2>/dev/null; sleep 3
check "no leftover processes" "! leftovers"
check "partial MKV still readable" "[ \$(dur) -ge 3 ]"

echo "5. browser crash during recording is recovered"
start crash "$FAKE" 30; wait_rec; sleep 6; pkill -KILL -o -f 'ms-playwright/chromium'; wait $PID; rc=$?
check "exit 0 and full ~30s" "[ $rc = 0 ] && [ \$(dur) -ge 29 ]"
check "reopened browser" "grep -q 'reopening and rejoining' $LOG"
check "no leftover processes" "! leftovers"

echo "6. join timeout when host never starts"
start timeout "$FAKE?wait=999" 30 -w 8; wait $PID; rc=$?
check "exit 1, no output, error screenshot" "[ $rc = 1 ] && [ ! -e $OUT ] && ls $W/timeout_logs/*error.png >/dev/null"
check "no leftover processes" "! leftovers"

echo "7. stream goes offline (waiting for host returns) -> stops after --offline-grace"
start offline "$FAKE?back=12" 120 --offline-grace 8; wait $PID; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "logged stream offline" "grep -q 'stream offline' $LOG"
check "stopped at ~12s + 8s grace" "[ \$(dur) -ge 15 ] && [ \$(dur) -le 26 ]"
check "no leftover processes" "! leftovers"

echo "$pass passed, $fail failed (logs in $W)"
[ $fail = 0 ]
