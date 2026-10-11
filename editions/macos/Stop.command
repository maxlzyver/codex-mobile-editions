#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
case "$(/usr/bin/uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) exit 1 ;; esac
"$ROOT/runtime/darwin-$ARCH/bin/node" "$ROOT/lib/mac-launcher.mjs" "$ROOT" stop
