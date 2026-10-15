---
name: setup
description: 检查移动助手插件的安装绑定与本地运行环境，在 Codex 内开始使用管理面板。
---

Call mobile_status first. If configured, call mobile_panel. If setup is required, explain that this plugin needs a clean complete Editions installation with its bundled Node.js 24 runtime. Run the package's Install-Plugin.ps1 on Windows or Install-Plugin.command on macOS with the chosen installation directory. The setup copies the plugin to a stable user directory and emits its local marketplace path. Register only that marketplace through the host's normal plugin installation workflow; preserve other plugins and settings.

For the simplest first installation, recommend the complete Editions V1.3.1 software ZIP, which already contains the plugin: double-click Install-Plugin.cmd on Windows or Install-Plugin.command on macOS in the software root. No separate plugin download is needed; the installer binds that software directory. Existing installations upgraded online also provide the entry under tools/. Codex must already be installed but need not be open during installation. The one-click flow registers through the CLI without starting the assistant backend, opening login/browser windows, restarting Codex, simulating keyboard/mouse input, or switching focus. The user opens Codex and the plugin page afterward; actual mobile use requires their Codex login. Keep the explicit command-line installation interfaces available for custom paths.

Do not assume a global node command exists and do not install another copy of Codex or request another account login. Never modify a published source checkout or the plugin cache as the stable installation. Do not use an external assistant management webpage as an embedded UI fallback. After setup, verify the installed plugin tools and open mobile_panel in Codex. If the host lacks MCP Apps support, report the unsupported capability accurately.
