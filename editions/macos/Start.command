#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
case "$(/usr/bin/uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo '需要 Intel 或 Apple 芯片的 macOS 14 或更新版本。'; exit 1 ;;
esac
NODE="$ROOT/runtime/darwin-$ARCH/bin/node"
if [ ! -x "$NODE" ]; then echo '未找到可运行的内置 Node，请完整解压 macOS 专用版。'; exit 1; fi
"$NODE" "$ROOT/lib/mac-launcher.mjs" "$ROOT" start "$@"
