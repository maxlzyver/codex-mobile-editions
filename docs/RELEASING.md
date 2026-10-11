# 发布与维护三种专用版

更新仓库：`maxlzyver/codex-mobile-editions`，分支：`main`。

## 目录约定

三个平台分别位于 `editions/windows11`、`editions/windows10`、`editions/macos`。每个目录的 `edition.json` 固定平台身份、更新路径、版本与完整 ZIP 文件名。初始均为 `1.0.0`，之后可以独立升版。

`update.json` 是打包工具生成的轻量更新清单，必须与同目录程序文件保持一致。不要手工修改哈希，也不要把 ZIP 当作唯一仓库内容。客户端从固定提交下载对应目录，不从 Release 选包。

## 发布新版本

1. 在目标平台目录修改代码，并提高 `edition.json`、`package.json` 中的版本；更新 `assetName`、页面版本文案与说明。Windows 同时更新启动器程序集版本，运行 `build-launcher.ps1` 重建 EXE。
2. 运行该版 `node --test test/*.test.mjs`；在对应系统验证启动、配对、Codex 连接及升级。Windows 10 和 macOS 的实机测试不能被 Windows 11 上的模拟测试替代。
3. 准备完整的运行组件。Windows 包需要 `runtime/node.exe` 和 `vendor/cloudflared.exe`；Mac 包需要 `runtime/darwin-arm64/bin/node`、`runtime/darwin-x64/bin/node` 及两种 `vendor/cloudflared-darwin-*`，并保留许可证、来源与校验信息。仓库故意不保存这些大组件，请从已有完整干净安装包或组件官方发布获取，不能复制使用后的 `.runtime`。
4. 在仓库根运行 `python tools/package-editions.py --dry-run --include-tests` 预览白名单，再运行 `python tools/package-editions.py --build --include-tests` 生成清单与完整 ZIP（默认输出到仓库上一层）；独立发布可加 `--edition windows10` 等参数，然后执行 `python tools/verify-editions.py` 核对三个目录的清单。
5. 将新版目录及同次生成的 `update.json` 提交到 `main`。网页上传时也必须保持 `editions/平台/` 路径；不要创建重复嵌套目录。尽量一次提交全部变动。等待 Actions 通过并检查原生测试结果。
6. 在 GitHub Releases 上传工具输出的完整 ZIP 及 SHA256 校验文件，供首次安装使用。初始三个版本共用 `v1.0.0` 发布页；后续独立发布时在标题和附件名中标明系统及版本即可。

不要使用各旧版遗留的 `tools/package-release.mjs`。它属于旧仓库单平台发布流程，不是本仓库入口。

## 用户数据与更新保护

生成清单仅覆盖程序白名单，排除 `.runtime`、项目工作目录、聊天、密钥、环境配置、日志、测试输出和运行组件。首次安装 ZIP 含运行组件；仓库清单采用 `runtimePolicy: preserve`，安装时检查并保留现有组件。

更新器核对仓库、平台、版本、包内 `edition.json`、逐文件哈希和大小。安装器验证归档路径，备份原文件，失败时尝试回滚，任务忙碌时等待。macOS 使用独立 Node 安装助手，Windows 使用独立 PowerShell 安装助手。

新 V1.0 使用独立版本序列，旧仓库的 1.2 不会自动降级迁移。用户首次手动安装新专用版后，才跟踪本仓库各自目录。

## 发布前人工验收

确认下载包能完整解压、目标系统启动入口可用、电脑已登录 Codex、模型列表可见、文件预览和下载有效；用手机验证局域网与实际外网。继续原桌面聊天还要确认界面标记的连接能力。请勿向用户正在使用的真实聊天发送测试指令，使用专门测试项目和聊天。
