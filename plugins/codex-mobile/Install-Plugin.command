#!/bin/bash
set -euo pipefail
plugin_root="$(cd -- "$(dirname -- "$0")" && pwd)"
installation="${1:-}"
if [[ -z "$installation" ]]; then read -r -p '请输入 Editions 完整安装目录: ' installation; fi
shift $(( $# > 0 ? 1 : 0 ))
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo '需要 Apple 芯片或 Intel Mac。' >&2; exit 1;; esac
node="$installation/runtime/darwin-$arch/bin/node"
if [[ ! -x "$node" ]]; then echo '没有找到完整安装包自带的 Node.js。请先完整解压 macOS 专用版。' >&2; exit 1; fi
exec "$node" "$plugin_root/scripts/setup.mjs" --installation-root "$installation" "$@"
