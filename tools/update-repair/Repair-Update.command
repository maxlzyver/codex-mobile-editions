#!/bin/bash
set -euo pipefail
repair_dir="$(cd "$(dirname "$0")" && pwd)"
installation="${1:-}"
if [ -z "$installation" ]; then
  installation="$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "先双击旧版 Stop.command 退出移动助手，再选择含 Start.command 的旧版完整程序目录。无需退出官方 Codex。")')"
fi
case "$(uname -m)" in
  arm64) repair_arch=arm64 ;;
  x86_64) repair_arch=x64 ;;
  *) echo '不支持此 Mac 架构'; exit 1 ;;
esac
"$installation/runtime/darwin-$repair_arch/bin/node" "$repair_dir/repair-update.mjs" --root "$installation"
read -r -p '按回车关闭窗口…' _
