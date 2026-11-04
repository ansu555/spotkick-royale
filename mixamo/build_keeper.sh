#!/usr/bin/env bash
# Mixamo FBX clips -> assets/goalkeeper_rigged.glb (merged + compressed)
set -euo pipefail
cd "$(dirname "$0")"
blender -b --python build_keeper.py 2>&1 | grep -E "^   |^!!|WROTE|Error" || true
npx -y @gltf-transform/cli optimize ../assets/goalkeeper_rigged_raw.glb ../assets/goalkeeper_rigged.glb \
  --texture-compress webp --texture-size 2048 --compress meshopt --simplify false
rm -f ../assets/goalkeeper_rigged_raw.glb
npx -y @gltf-transform/cli inspect ../assets/goalkeeper_rigged.glb | grep -A20 -i "animations" | head -20
