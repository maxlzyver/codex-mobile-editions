# Codex 移动助手 · V1.0.1 专用版

作者：[maxlzyver](https://github.com/maxlzyver) · [反馈邮件](mailto:lzyuan666666@gmail.com) · MIT 许可证

让手机浏览器连接自己的电脑：查看 Codex 输出、选择模型和思考强度、远程发送指令，并翻阅、预览及下载电脑项目文件。支持同一 Wi-Fi 配对和互联网连接，内置外观设置、使用说明、分平台更新及自愿赞助入口。

## 下载与首次使用

请从 [V1.0.1 发布页](https://github.com/maxlzyver/codex-mobile-editions/releases/tag/v1.0.1) 下载与你电脑匹配的完整 ZIP。三个平台分别从 **V1.0 / 1.0.0** 开始，今后独立升级。

| 专用版 | 系统要求 | 完整安装包 | 启动入口 |
| --- | --- | --- | --- |
| [Windows 11](editions/windows11/README.md) | 原生 x64，内部版本 22000+ | codex-mobile-windows11-1.0.1-x64.zip | Codex-Mobile.exe |
| [Windows 10](editions/windows10/README.md) | 22H2，内部版本 19045，原生 x64 | codex-mobile-windows10-1.0.1-x64.zip | Codex-Mobile.exe |
| [macOS](editions/macos/README.md) | macOS 14+，Apple 芯片 / Intel | codex-mobile-macos-1.0.1-universal.zip | Start.command |

完整解压到当前用户可写目录；在电脑安装并登录兼容的 Codex，启动本版助手并选择项目目录。电脑页面点击“连接手机”，手机扫码后由电脑批准。macOS 首次打开未签名脚本，可能需要在 Finder 右键打开并按系统提示批准；本项目不要求关闭系统安全功能。

程序内置 Node.js 与 cloudflared，不包含 Codex 本身或任何人的账户。Windows ARM64、32 位系统不在本次发布范围。Windows 10 专用启动器不会让不兼容的官方 Codex 版本变得兼容。

旧版 **1.2 不会自动降级到新的专用版 1.0**。请退出旧助手，将新完整包解压到新文件夹，重新选择项目并配对手机。电脑项目和 Codex 聊天仍在原位置。

## V1.0.1 更新

- 公开过程说明（commentary）支持触屏展开与收起，并保留开关选择。
- 已确认接收的指令保留本地回执，刷新页面后仍可查看；真实聊天记录同步后自动去重，并清楚区分发送中、待同步和失败状态。

完整变更见 [更新日志](CHANGELOG.md)。

## 能做什么

- 手机查看电脑聊天与任务进度、远程发出指令，选择账户提供的模型与思考强度。
- 原桌面聊天在兼容的本地桌面接口可用时支持继续发送；接口不可用时显示只读历史，并可创建独立分支。原桌面聊天的审批与强制停止仍在电脑处理。
- 助手创建的新任务可在网页继续、停止并处理支持的审批；它使用电脑账户和文件，但不继承所有桌面专有工具。
- 浏览已授权项目的真实目录，预览代码、文本、图片，打开 PDF，下载单个文件。电脑端可添加其他已有项目目录。
- 外观可更改主题、字体、字号、主色和文字颜色；反馈打开邮件草稿；“赞助一下”展示作者提供的微信二维码，不自动支付。

手机沿用电脑的 Codex 登录，不必在手机重复输入账号。只要登录仍有效、电脑开机联网且不休眠、助手持续运行，即可继续使用。手机首次连接需要配对并由电脑批准；授权默认 30 天，清除 Cookie、入口变化或授权过期后需要重新配对。这不增加账号额度或模型权限，也不是多人账号隔离系统；每个获准设备都能操作相应电脑项目。

## 与官方 ChatGPT App 的区别

本工具是独立社区项目，侧重**自托管、浏览器访问、本地项目文件预览下载、界面自定义和分平台安装**。官方 ChatGPT 移动端也提供 Codex 远程连接能力，具体可用性取决于账户、工作区和功能开放情况，见 [官方说明](https://learn.chatgpt.com/docs/mobile)。本工具不是 OpenAI 官方客户端，不保证复制全部桌面功能。

## 这个仓库怎样用于自动更新

首次安装使用 Release 中的完整 ZIP。**仓库文件夹和 GitHub 自动生成的 Source code ZIP 不包含运行组件，不能代替首次安装包。**

| 已安装版本 | 唯一更新清单（main 分支） |
| --- | --- |
| Windows 11 专用版 | editions/windows11/update.json |
| Windows 10 专用版 | editions/windows10/update.json |
| macOS 专用版 | editions/macos/update.json |

程序先固定 Git 提交，再读取同一提交中的对应目录和文件校验值，拒绝跨平台包。清单使用 `runtimePolicy: preserve`，更新程序文件，保留已安装的 Node.js / cloudflared 和本地运行数据。没有根目录清单、旧仓库或 Releases 回退。

作者可直接上传生成后的平台文件夹，但必须连同同次生成的 `update.json` 一起覆盖原位置。推荐 Git 提交一次性发布，避免网页分批上传产生暂时不完整的版本。版本号必须提高；相同版本不重复安装。开发步骤见 [发布指南](docs/RELEASING.md)。

只有电脑管理端可安装或设置自动更新。自动更新默认关闭，开启后等待任务和审批空闲再应用。更新重启助手，互联网临时地址可能变化。

## 运行与验证范围

V1.0.0 基线中，Windows 11 启动器已在开发用 Windows 11 机器检查；Windows 10 启动器已编译并验证系统边界，但尚未在 Windows 10 实机完整运行。macOS 的启动、进程管理、Unix socket 和更新代码独立实现；已在 macOS 15 的 Apple 芯片与 Intel GitHub 运行器分别通过 143 项测试，包含中文路径下的原生进程核验。自动化测试不能替代 Finder、真实 Codex 和手机网络的完整实机验收。V1.0.1 本次回归结果及各次记录见 [Actions](https://github.com/maxlzyver/codex-mobile-editions/actions)。

原桌面连接依赖 Codex 内部接口，可能随其升级变化。局域网需要设备互通；互联网模式使用 Cloudflare Quick Tunnel，地址不固定、流量经过 Cloudflare。电脑需要保持开机、联网且不休眠。

仓库只包含程序，不包含 `.runtime`、账号令牌、设备配对、聊天和项目文件。不要上传使用后的整个程序目录，也不要公开管理链接或配对二维码。程序文件夹内含各组件的许可证说明。
