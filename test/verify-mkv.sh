#!/usr/bin/env bash
# Check that a recording has real content: audible audio and changing video, not just valid streams.
# Usage: test/verify-mkv.sh FILE.mkv [min_seconds]
set -u
f=$1; min=${2:-1}
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
streams=$(ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$f" | sort | tr '\n' ' ')
# Per-second RMS levels; count seconds louder than -50 dBFS.
read -r loud total < <(ffmpeg -nostats -hide_banner -i "$f" -map 0:a -af "asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null - 2>&1 |
  grep -oE 'RMS_level=[-0-9.inf]+' | cut -d= -f2 | awk '{n++} $1!="-inf" && $1>-50 {l++} END {print l+0, n+0}')
# Frozen video: total seconds of frames identical within noise for >=2 s (a freeze running to EOF has no end line).
frozen=$(ffmpeg -nostats -hide_banner -i "$f" -map 0:v -vf "fps=5,freezedetect=n=0.001:d=2" -f null - 2>&1 |
  grep -oE 'freeze_(start|duration): [0-9.]+' |
  awk -v d="$dur" '/start/ {st=$2; open=1} /duration/ {s+=$2; open=0} END {if (open) s+=d-st; printf "%.0f", s}')
echo "duration=${dur}s streams=[${streams% }] audible_seconds=${loud}/${total} frozen_video_seconds=${frozen}"
ok=1
awk -v d="$dur" -v m="$min" 'BEGIN{exit !(d>=m)}' || { echo "FAIL: shorter than ${min}s"; ok=0; }
[[ $streams == "audio video " ]] || { echo "FAIL: expected one audio and one video stream"; ok=0; }
(( loud * 2 >= total )) || { echo "FAIL: audio silent in more than half of the recording"; ok=0; }
awk -v fr="$frozen" -v d="$dur" 'BEGIN{exit !(fr < d*0.9)}' || { echo "FAIL: video frozen for most of the recording"; ok=0; }
(( ok )) && echo PASS
(( ok ))
