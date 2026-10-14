---
name: mobile
description: 在 Codex 内打开移动助手管理页面，连接手机、查看设备、管理手机权限和检查软件及插件更新。
---

Use the mobile_panel MCP tool to open the embedded management UI. Keep pairing, devices, mobile permissions, help, updates and about within the Codex panel; do not open the standalone assistant website as a substitute.

Use mobile_status for connection status and mobile_diagnose for troubleshooting. Follow the reported setup state rather than guessing an installation path. The UI performs changes through bounded app tools; do not print owner URLs, session cookies or management tokens. Phone pairing is requested in the panel and still requires explicit device approval.

The assistant backend and this plugin have separate update versions. Report an update as active only when the running plugin reports that version; downloaded or source-installed packages may require a new chat or restarting Codex. Preserve current mobile permissions and existing pairings. Do not automatically enable internet access, broaden file permissions or stop running user tasks.
