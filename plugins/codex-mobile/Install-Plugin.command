#!/bin/bash
set -euo pipefail
plugin_root="$(cd -- "$(dirname -- "$0")" && pwd)"
result_dir="${CODEX_MOBILE_PLUGIN_DATA:-$HOME/Library/Application Support/CodexMobile/plugin}"
record() { mkdir -p -- "$result_dir" 2>/dev/null && printf '%s\n%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" > "$result_dir/install-result.txt" || true; }
fail() { printf '%s\n' "$1" >&2; record "$1"; printf '安装结果：%s/install-result.txt\n' "$result_dir" >&2; exit 1; }
json() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
no_links() { local current="$1"; while [[ "$current" != / && -n "$current" ]]; do [[ ! -L "$current" ]] || return 1; current="$(dirname -- "$current")"; done; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) fail '需要 Apple 芯片或 Intel Mac。';; esac
edition() {
  local directory="$1" version
  [[ -d "$directory" && -x "$directory/runtime/darwin-$arch/bin/node" ]] || return 1
  no_links "$directory/runtime/darwin-$arch/bin/node" || return 1
  [[ "$(json "$directory/edition.json" id)" == macos && "$(json "$directory/package.json" name)" == codex-mobile-console ]] || return 1
  version="$(json "$directory/edition.json" version)"
  [[ -n "$version" && "$version" == "$(json "$directory/package.json" version)" ]]
}
automatic=false
installation="${1:-}"
if [[ -z "$installation" || "$installation" == --one-click || "$installation" == --* ]]; then
  automatic=true
  if [[ "$installation" == --one-click ]]; then shift; fi
  installation=''
  arguments=("$@")
  index=0
  while (( index < ${#arguments[@]} )); do
    case "${arguments[$index]}" in
      --installation-root|--data-dir)
        key="${arguments[$index]}"; index=$((index + 1))
        (( index < ${#arguments[@]} )) || fail '安装参数缺少目录。'
        if [[ "$key" == --installation-root ]]; then installation="${arguments[$index]}"; else result_dir="${arguments[$index]}"; fi
        ;;
    esac
    index=$((index + 1))
  done
else
  shift
fi
if [[ "$automatic" == true && -z "${CODEX_MOBILE_PLUGIN_DATA:-}" && " $* " != *' --data-dir '* ]]; then
  cache="${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-mobile-local/codex-mobile"
  if [[ -d "$cache" ]] && no_links "$cache"; then
    versions=()
    for entry in "$cache"/*; do
      name="${entry##*/}"
      if [[ -d "$entry" && ! -L "$entry" && "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then versions[${#versions[@]}]="$name"; fi
    done
    if (( ${#versions[@]} > 0 )); then
      while IFS= read -r version; do
        entry="$cache/$version"
        [[ "$(json "$entry/plugin.json" name)" == codex-mobile && "$(json "$entry/plugin.json" version)" == "$version" ]] || continue
        candidate="$(json "$entry/mcp.json" mcpServers.mobile.env.CODEX_MOBILE_PLUGIN_DATA)" || continue
        [[ "$candidate" == /* ]] && no_links "$candidate" || continue
        [[ "$(json "$candidate/config.json" schema)" == 1 && "$(json "$candidate/config.json" pluginSourceRoot)" == "$candidate/marketplace/plugins/codex-mobile" ]] || continue
        [[ -n "$(json "$candidate/config.json" installationRoot)" ]] || continue
        result_dir="$candidate"; break
      done < <(printf '%s\n' "${versions[@]}" | /usr/bin/sort -t . -k1,1nr -k2,2nr -k3,3nr | /usr/bin/head -50)
    fi
  fi
fi
roots=("$plugin_root" "$(dirname -- "$plugin_root")" "$HOME/Desktop" "$HOME/Downloads" "$HOME/Applications" /Applications)
bootstrap="$installation"
if [[ -n "$bootstrap" ]]; then
  bootstrap="$(cd -- "$bootstrap" 2>/dev/null && pwd)" || fail '指定的软件目录不存在。'
  edition "$bootstrap" || fail '所选文件夹不是完整 macOS Editions 软件目录，或缺少自带的 Node.js。'
elif [[ "$automatic" == true ]]; then
  saved="$(json "$result_dir/config.json" installationRoot)" || saved=''
  if [[ -n "$saved" ]] && edition "$saved"; then bootstrap="$saved"; fi
  queue=("${roots[@]}"); depths=(0 0 0 0 0 0); index=0
  while [[ -z "$bootstrap" ]] && (( index < ${#queue[@]} && index < 300 )); do
    directory="${queue[$index]}"; depth="${depths[$index]}"; index=$((index + 1))
    [[ -d "$directory" && "$directory" != / && ! -L "$directory" ]] || continue
    if edition "$directory"; then bootstrap="$directory"; break; fi
    (( depth < 2 )) || continue
    for child in "$directory"/*; do
      [[ -d "$child" && ! -L "$child" ]] || continue
      case "${child##*/}" in runtime|node_modules|Library|AppData) continue;; esac
      queue[${#queue[@]}]="$child"; depths[${#depths[@]}]=$((depth + 1))
    done
  done
  [[ -n "$bootstrap" ]] || fail '未找到 Editions 完整软件目录。请把完整解压的插件文件夹放在软件文件夹旁边后重试。无需提前打开 Codex。'
fi
node="$bootstrap/runtime/darwin-$arch/bin/node"
if [[ "$automatic" == true ]]; then
  args=("$plugin_root/scripts/one-click.mjs" --documents-dir "$HOME/Documents")
  for directory in "${roots[@]}"; do args+=(--search-root "$directory"); done
  exec "$node" "${args[@]}" "$@"
else
  if "$node" "$plugin_root/scripts/setup.mjs" --installation-root "$bootstrap" "$@"; then record '手动安装绑定完成。已注册后可从 Codex 插件详情打开移动助手。'; else fail '手动插件安装未完成，请查看终端错误。'; fi
fi
