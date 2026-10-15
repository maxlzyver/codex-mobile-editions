#!/bin/bash
set -euo pipefail
script_directory="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ -f "$script_directory/lib/install-plugin.mjs" ]]; then edition_root="$script_directory"; else edition_root="$(cd -- "$script_directory/.." && pwd)"; fi
result_file="$edition_root/.runtime/plugin-install-result.txt"
fail() {
  printf '%s\n' "$1" >&2
  mkdir -p -- "$(dirname -- "$result_file")" 2>/dev/null && printf '%s\n' "$1" > "$result_file" || true
  printf '安装结果：%s\n' "$result_file" >&2
  exit 1
}
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) fail '需要 Apple 芯片或 Intel Mac。';; esac
node="$edition_root/runtime/darwin-$arch/bin/node"
[[ -x "$node" ]] || fail '缺少完整软件包自带的 Node.js，请完整解压 macOS 专用版后重试。'
exec "$node" "$edition_root/lib/install-plugin.mjs" --documents-dir "$HOME/Documents" "$@"
