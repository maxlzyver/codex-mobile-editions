# 发布与维护三种专用版

更新仓库：`maxlzyver/codex-mobile-editions`，分支：`main`。

## 目录约定

三个平台分别位于 `editions/windows11`、`editions/windows10`、`editions/macos`。每个目录的 `edition.json` 固定平台身份、更新路径、版本与完整 ZIP 文件名。初始均为 `1.0.0`，当前三版为 `1.3.1`，之后可以独立升版。

`update.json` 是打包工具生成的轻量更新清单，必须与同目录程序文件保持一致。不要手工修改哈希，也不要把 ZIP 当作唯一仓库内容。客户端从固定提交下载对应目录，不从 Release 选包。

## 发布新版本

1. 在目标平台目录修改代码，并提高 `edition.json`、`package.json` 中的版本；更新 `assetName`、页面版本文案与说明。Windows 同时更新启动器程序集版本，运行 `build-launcher.ps1` 重建 EXE。同步修改该平台的 `docs/UPDATE-NOTES.md`：打包工具会将其作为纯文本写入 `update.json.releaseNotes`，供电脑和手机的新版本弹窗展示；最多 12000 个 UTF-16 字符、48000 字节 UTF-8。
2. 运行该版 `node --test test/*.test.mjs`；在对应系统验证启动、配对、Codex 连接及升级。Windows 10 和 macOS 的实机测试不能被 Windows 11 上的模拟测试替代。
3. 准备完整的运行组件。Windows 包需要 `runtime/node.exe` 和 `vendor/cloudflared-windows-amd64.exe` 及 `vendor/cloudflared-release.json`；Mac 包需要 `runtime/darwin-arm64/bin/node`、`runtime/darwin-x64/bin/node` 及两种 `vendor/cloudflared-darwin-*`，并保留许可证、来源与校验信息。仓库故意不保存这些大组件，请从已有完整干净安装包或组件官方发布获取，不能复制使用后的 `.runtime`。
4. 在仓库根运行 `python tools/package-editions.py --dry-run --include-tests` 预览白名单，再运行 `python tools/package-editions.py --build --include-tests` 生成清单与完整 ZIP（默认输出到仓库上一层）；独立发布可加 `--edition windows10` 等参数，然后执行 `python tools/verify-editions.py` 核对三个目录的清单。
5. 将新版目录及同次生成的 `update.json` 先提交到发布分支，等待 Actions 通过并检查原生测试结果，再将已验证提交合入 `main`，避免自动更新提前获取未验证版本。网页上传时也必须保持 `editions/平台/` 路径；不要创建重复嵌套目录。尽量一次提交全部变动。
6. 在 GitHub Releases 上传工具输出的完整 ZIP 及 SHA256 校验文件，供首次安装使用。先创建草稿并上传全部附件、核对校验值，最后发布。初始三个版本共用 `v1.0.0` 发布页，原 V1.0.1 为 `v1.0.1`，重制版使用 `v1.0.1-rebuild.1`，V1.2 使用 `v1.2.0`，当前版本使用 `v1.3.0`；后续独立发布时在标题和附件名中标明系统及版本即可。已被 GitHub 锁定的 Release 不改附件或标签。

V1.0.1 重制是一次保留软件版本号的例外。已装旧 V1.0.1 的更新器不会安装同版本，需按 [换装说明](V1.0.1-REBUILD.md)处理；后续正常发布应提高版本，才能通过自动检查、弹窗提醒和原安装更新流程到达用户。

不要使用各旧版遗留的 `tools/package-release.mjs`。它属于旧仓库单平台发布流程，不是本仓库入口。

## 用户数据与更新保护

生成清单仅覆盖程序白名单，排除 `.runtime`、项目工作目录、聊天、密钥、环境配置、日志、测试输出和运行组件。首次安装 ZIP 含运行组件；仓库清单采用 `runtimePolicy: preserve`，安装时检查并保留现有组件。

更新器核对仓库、平台、版本、包内 `edition.json`、逐文件哈希和大小。安装器验证归档路径，备份原文件，失败时尝试回滚，任务忙碌时等待。macOS 使用独立 Node 安装助手，Windows 使用独立 PowerShell 安装助手。

新 V1.0 使用独立版本序列，旧仓库的 1.2 不会自动降级迁移。用户首次手动安装新专用版后，才跟踪本仓库各自目录。

## 发布前人工验收

确认下载包能完整解压、目标系统启动入口可用、电脑已登录 Codex、模型列表可见、文件预览和下载有效；用手机验证局域网与实际外网。继续原桌面聊天还要确认界面标记的连接能力。请勿向用户正在使用的真实聊天发送测试指令，使用专门测试项目和聊天。

## V1.2 自动升级验收

运行 `node tools/test-update-startup.mjs` 检查真实服务入口的启动检查，再运行 `node tools/test-cross-version-update.mjs` 验证自动更新。默认从已发布标签 `v1.2.0` 读取旧程序，升级到当前工作树版本；CI 必须获取该历史标签。预先开启 autoUpdate，确认任务忙时不下载，空闲后自动安装重启及配对数据保留，不调用检查或安装按钮。测试隔离 GitHub 网络，不上传任何测试用发布。平台可用 `CODEX_UPDATE_E2E_EDITIONS` 限定。Windows 10 的系统版本门槛仅在测试副本中放宽；真实目标系统验收仍需对应电脑。

`node tools/test-update-repair.mjs` 验证可选的旧版更新修复工具；旧版本端到端矩阵需显式设置 `CODEX_UPDATE_E2E_LEGACY=1`，不是 V1.2 发布的必需门槛。


## V1.3 插件发行与验收

插件位于 `plugins/codex-mobile`。运行 `npm ci --ignore-scripts`、`npm run build`、`npm test` 后，使用 `python tools/package-plugin.py --dry-run` 预览，`python tools/package-plugin.py --build --output-dir <发布输出目录>` 生成插件 ZIP 与校验文件，`python tools/package-plugin.py --verify` 核对清单。插件的 `dist/server.mjs` 和 `ui/app.html` 是用户实际运行的构建产物，须一并提交；`mcp.json` 在仓库中保留便携模板，安装时才填入本机 Node 路径。

插件测试包括正式 MCP Apps 消息桥、手机管理受控工具、源码与宿主缓存更新、忙碌等待、校验失败和回滚。实际 Codex 中分别测试插件页直接打开、直接设置、对话入口，并确认页面显示版本。只有浏览器模拟或 stdio 协议成功不足以认定宿主集成通过。

新发布报告必须带插件使用教学，内容见 `docs/V1.3.0-PLUGIN-GUIDE.md`。保持历史 CHANGELOG 内容和旧 Release 不变，三平台更新公告保留上一版原文副本。

## V1.3.1 完整软件内置插件

先构建插件并运行 `python tools/package-plugin.py --build --output-dir <输出目录>`，再运行 `python tools/bundle-edition-plugin.py --write` 将同一份公开插件生成到三个软件目录。最后运行 `python tools/package-editions.py --build --output-dir <输出目录>`。插件源码或说明变动后需重新生成插件清单和软件内插件包，再打包软件；生成文件一起提交。

软件完整 ZIP 根目录提供 Windows `Install-Plugin.cmd` 或 macOS `Install-Plugin.command`。根入口是打包时附加的快捷入口；在线更新清单使用 `tools/` 下的安装脚本与 `lib/` 内插件包，兼容旧版更新路径校验。教学见 `docs/V1.3.1-PLUGIN-INSTALL.md`。

本次产品版本统一为 `1.3.1`。原 `v1.3.1` 发布已锁定且仅有独立插件，完整软件使用 `v1.3.1-full` 发布标签，并设为最新发布。发布应先创建草稿、上传并核对全部附件，最后公开，避免附件锁定后遗漏软件包。
