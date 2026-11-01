#!/usr/bin/env bash
# Start an unattended recording in the background, detached from the terminal.
# Usage: ZOOM_URL='https://...zoom.us/w/...?tk=...' ./run-zoom-recorder.sh
# The URL comes from the environment so its access token never lands in this file or in git.

set -euo pipefail

: "${ZOOM_URL:?set ZOOM_URL to the full Zoom join link}"
cd "$(dirname "$0")"
mkdir -p ~/recordings
name=webinar-$(date +%F_%H%M)
setsid -f node zoom-record.js -u "$ZOOM_URL" \
  -d 3h -w 4h -o ~/recordings/"$name".mkv \
  > ~/recordings/"$name".out 2>&1 < /dev/null
echo "started; log: ~/recordings/${name}_logs/recorder.log"
