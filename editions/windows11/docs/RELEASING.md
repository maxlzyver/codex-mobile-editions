# Windows 11 专用版 V1.2.0：发布与更新

作者：[maxlzyver](https://github.com/maxlzyver) · 新仓库：[maxlzyver/codex-mobile-editions](https://github.com/maxlzyver/codex-mobile-editions)

## 固定版本和目录

三个平台专用版均从 **1.0.0** 开始。此目录仅属于 **Windows 11 专用版**：

| 项目 | 固定值 |
| --- | --- |
| edition.id | windows11 |
| 当前版本 | 1.2.0 |
| platform | Windows 11 x64 |
| 更新目录 | editions/windows11 |
| 唯一清单路径 | editions/windows11/update.json |
| 首次安装便携包 | codex-mobile-windows11-1.2.0-x64.zip |

程序只检查新仓库 main 分支下的上述平台清单，固定提交后读取同次提交的程序文件。**不扫描仓库根清单、不扫描其他平台目录、不回退到旧仓库或旧 Releases。** 没有本版有效清单时显示未发布状态。

## 生成和上传

1. 在新仓库／交付根目录维护 `editions/windows10`、`editions/windows11`、`editions/macos` 三个独立目录；不要将不同平台文件放进同一更新目录。
2. 本版元数据由 `edition.json` 定义。保持 `package.json`、UI 版本、启动器常量及程序集版本一致；`lib/app-info.mjs` 从本版 profile 读取展示信息。
3. Windows 启动器修改后，在带 .NET Framework 4 编译器的 Windows 环境运行本版 `build-launcher.ps1`；然后运行 `Launch.ps1 -Check`，记录目标平台实际验证结果。编译成功不等同于目标系统已运行通过。
4. 在发布根目录使用 **`tools/package-editions.py`** 按根目录说明生成干净包与每平台 `update.json`。该工具是专用版发布入口；不要运行遗留通用版打包流程，也不要手写哈希或只修改清单版本号。
5. 将打包工具生成的干净平台文件及清单上传至 GitHub 对应的 **`editions/windows11`**，使 main 分支出现 `editions/windows11/update.json`。首次安装 ZIP 的文件名应与 `edition.json` 的 `assetName` 一致，即当前的 `codex-mobile-windows11-1.2.0-x64.zip`。
6. 上传代码与清单后，从电脑控制台“设置 → 更新与关于”检查该平台更新。实际发布前，在目标平台核验首次启动、手机配对及空闲更新流程。

运行时属于首次安装依赖；轻量更新若声明保留运行时，只适用于已经完整安装的同平台用户。清单路径、版本、文件内容和校验值必须来自同次打包。不能用其他平台运行组件或旧版清单代替。

后续版本应高于当前版本，例如 1.2.1。修改 `edition.json` 中的版本与 `assetName`、package 和启动器版本后重新编译／打包，不要仅更改网页上的版本文字。

## 旧版用户首次迁移

旧通用版 1.2 使用不同仓库与版本序列，**不会自动迁移或降级至专用版 1.0.0**。用户应退出旧助手，手动下载适用平台的完整新包，解压到新目录，选择原有项目并重新配对手机。原本 Codex 聊天和项目无需搬进程序目录。

不要将旧版 `.runtime` 整目录复制进新包，更不能把个人运行数据作为发布内容。专用版后续的同平台正常更新才由内置更新器处理。

## 更新行为和发布验收

电脑 owner 可检查、安装和设置自动更新，手机 controller 可查看状态。自动更新默认关闭，开启后定期检查，等待任务与审批空闲再安装；手动安装等待空闲时，可以在任务结束后重试。

更新下载后按固定 Git 提交和清单验证，再备份和替换本助手程序。保留本地配置与项目，失败时尝试恢复；更新会重启助手，不关闭原先的 Codex 桌面程序。重启后临时外网地址可能变化，用户可能需要重新打开管理页及配对入口。

V1.0.0 基线的 Windows 启动器合计 72 个平台边界断言通过，本机 Windows 11 的 Win11 版无界面检查通过，Win10 版按预期拒绝当前主机。**真实 Windows 10 尚未测试**；发布说明不可将策略测试写成 Win10 实机认证。

## 不得上传的内容

- `.runtime`、管理链接、配对令牌、设备 Cookie、更新运行状态。
- Codex／OpenAI 账号登录信息、任何 API 密钥、用户主目录配置。
- 项目目录、聊天记录、命令输出、测试日志与截图。
- 运行后的整个程序目录或与本次 profile 不一致的二进制。

再次分发应使用原始干净 ZIP 或重新运行根打包工具，不能简单压缩正在使用的文件夹。许可和依赖说明见 LICENSE、THIRD_PARTY_NOTICES.md。

[反馈邮件](mailto:lzyuan666666@gmail.com)由用户自行发送，请只提供版本、现象和复现步骤，不附凭证或私人项目内容。

## 新版本说明与提醒

发布前更新本平台的 docs/UPDATE-NOTES.md。根打包工具会将该文件的纯文本写入 update.json.releaseNotes，供新版本弹窗与设置页展示。启动后及每 6 小时只检查新版本；自动安装仍由原开关控制。用户勾选下次更新前不再提示后按版本记忆，下一版本会恢复提醒。

此前 V1.0.1 重制使用独立发布标签 v1.0.1-rebuild.1，已装同版本时需参照 [保留数据换装说明](V1.0.1-REBUILD.md)操作；以后正常发布仍需提高版本。
