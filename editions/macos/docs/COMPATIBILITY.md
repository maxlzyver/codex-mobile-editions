# macOS 专用版 V1.0.1：兼容性

目标系统：macOS 14+；架构：Apple Silicon arm64 与 Intel x64。完整安装包包含两种架构的 Node.js 24.19.0 及 cloudflared 2026.10.0。脚本通过 `uname -m` 选择运行组件，Node 启动层验证 Darwin 内核版本；不支持在 Windows 或 Linux 运行本专用启动入口。

Codex 由用户自行安装、登录。自动发现 `/Applications/Codex.app/Contents/Resources/codex`、用户 Applications 目录、常见 Homebrew/本地安装路径及 PATH，也支持 `CODEX_BINARY`。服务使用本地 Codex app-server；原桌面聊天需要兼容的当前用户 Unix socket。发现失败保留独立任务与只读历史能力。

## 已验证与尚未验证

以下已完成的验证结果来自 V1.0.0 基线；V1.0.1 的本次回归结果以发布记录和对应 Actions 运行结果为准。

- Node 自动化测试覆盖协议、任务、模型、路径约束、身份权限、平台逻辑和更新文件校验。
- 独立 Mac 安装器用真实临时目录与 ZIP 验证升级、中文路径、哈希拒绝、保留运行组件、回滚及跨平台拒绝。
- 本地开发主机是 Windows 11；没有本地 Mac 实机验证 Finder 启动、系统授权弹窗、真实 Codex 原聊天发送或手机外网。
- GitHub Actions 为 macOS Apple 芯片与 Intel 配置原生运行器，公开结果以仓库 Actions 为准。CI 测试不包含个人账户登录或真实用户聊天。

## 运行限制

电脑不能关机或休眠；跨网络需出站网络可用。系统防火墙、访客 Wi-Fi 隔离或 macOS 文件访问权限可能影响使用。项目路径必须当前用户可读，程序和 `.runtime` 目录必须可写。

本版使用 `.command` 脚本，没有宣称签名或公证的 `.app` 安装包。更新器保留运行组件，本仓库轻量更新不会自动升级 Node.js 或 cloudflared；需要换组件时应重新发布完整安装包并说明迁移步骤。
