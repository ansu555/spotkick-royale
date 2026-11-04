#!/usr/bin/env bash
# Raw downloads (Pixabay / Mixkit / ElevenLabs) -> trimmed, normalised assets/sfx/*.mp3
# Usage: sfx/build_sfx.sh [source_dir]   (defaults to ~/Downloads)
set -euo pipefail
SRC="${1:-$HOME/Downloads}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/assets/sfx"
mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# cut <src> <name> <start> <dur> [fade_out] [extra filters]
# Trims, strips leading silence, fades out, peak-normalises to -1 dBFS, writes mp3.
cut() {
  local src="$SRC/$1" name=$2 ss=$3 dur=$4 fo=${5:-0.15} extra=${6:-}
  local f="atrim=start=${ss}:duration=${dur},asetpts=N/SR/TB,silenceremove=start_periods=1:start_threshold=-50dB"
  [ -n "$extra" ] && f="$f,$extra"
  f="$f,areverse,afade=t=in:d=${fo},areverse"
  ffmpeg -v error -y -i "$src" -af "$f" -ar 44100 "$TMP/$name.wav"
  local peak
  peak=$(ffmpeg -hide_banner -i "$TMP/$name.wav" -af volumedetect -f null - 2>&1 | grep -oE "max_volume: [-0-9.]+" | awk '{print $2}')
  ffmpeg -v error -y -i "$TMP/$name.wav" -af "volume=$(awk -v p="$peak" 'BEGIN{print -1-p}')dB" -codec:a libmp3lame -q:a 4 "$OUT/$name.mp3"
  printf "%-14s %5.2fs\n" "$name" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$name.mp3")"
}

cut "mixkit-stadium-joy-shouting-crowd-3022.wav"                 crowd_loop   0.3 15.0 1.5
cut "mixkit-huge-crowd-cheering-victory-462.wav"                 crowd_goal   0.3 6.0  2.0
cut "u_xg7ssi08yr-crowd-cheering-379666 (1).mp3"                 crowd_win    0.6 7.0  2.5
cut "ElevenLabs_Crowd_gasping_as_a_goalkeeper_makes_a_crucial_save,_collective_breath_held.mp3" crowd_save 0 2.1 0.6
cut "u_xg7ssi08yr-scan-medium-weapons-scan-572867.mp3"           scan         0   3.4  0.4
cut "existentialtaco-confirm-tap-394001.mp3"                     lock_on      0   0.6  0.2
cut "freesound_community-sword-thud-47635.mp3"                   lock_thud    3.3 2.3  0.8
cut "charlesheffley009-referee-whistle-568615.mp3"               whistle      1.1 0.6  0.08
cut "charlesheffley009-referee-whistle-568615.mp3"               kickoff      1.1 2.3  0.2
cut "freesound_community-soccer-ball-kick-37625.mp3"             kick         0   0.5  0.15
cut "freesound_community-soccer-ball-kick-37625.mp3"             save_glove   0   0.4  0.15 "asetrate=44100*0.78,aresample=44100,lowpass=f=2200"
cut "dragon-studio-whoosh-cinematic-sound-effect-376889 (1).mp3" whoosh       0   1.2  0.5
cut "forza1903-a-football-hits-the-net-goal-313216.mp3"          net_hit      0   1.6  0.5
cut "ElevenLabs_Ball_hitting_the_goalpost_with_a_loud_clang,_metallic_echo.mp3" post_clang 0.4 1.8 0.8
cut "chrysalyn-cinematic-intro-whoosh-with-deep-bass-drop-543523.mp3" blast_safe 0 2.4 0.9
cut "dragon-studio-deep-sub-drop-450456.mp3"                     blast_kill   0   2.6  0.9
cut "Eliminated!! Sound effects No copyright - Everything's for Free (128k).mp3" eliminated 1.3 1.3 0.15
cut "olivia_parker-chime-alert-demo-309545.mp3"                  advance      0   1.4  0.5
cut "floraphonic-multi-coin-payout-14-213732.mp3"                bet_place    0   0.7  0.3
cut "floraphonic-multi-coin-payout-14-213732.mp3"                coins        0   1.3  0.4
cut "freesound_community-cash-register-purchase-87313.mp3"       cash_out     0   1.6  0.5
cut "dragon-studio-clock-ticking-sfx-467486.mp3"                 tick         0.7 0.18 0.06
cut "audley_fergine-ui-mouse-click-366460.mp3"                   click        0   0.12 0.04
