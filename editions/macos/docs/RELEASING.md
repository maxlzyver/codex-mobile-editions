# macOS 专用版 V1.0.1：发布与自动更新

仓库：`maxlzyver/codex-mobile-editions`。本版清单路径固定为 `editions/macos/update.json`，不允许 Windows 更新混入。

日常更新可直接上传平台文件夹及同次生成的清单到 `main` 原位置。清单包含程序文件的大小和 SHA256，采用 `runtimePolicy: preserve` 保留已安装双架构组件。客户端固定一次 Git 提交，验证该提交下对应目录；没有根目录、旧仓库或 Releases 回退。

首次安装必须使用 Release 中完整的 `codex-mobile-macos-1.0.1-universal.zip`。仓库源码不含 Node.js/cloudflared；GitHub Source code ZIP 不是完整安装包。

后续提高 `edition.json` 与 `package.json` 版本，并更新 `assetName`、界面版本及说明。在仓库根使用 `python tools/package-editions.py --help` 查看参数，生成清单和完整包；运行 `python tools/verify-editions.py` 及 Mac 测试。新清单与程序必须一起提交，不能仅改版本或上传 ZIP。

Mac ZIP 必须保留 Start.command、Stop.command、Login.command、两套 Node 与 cloudflared 的执行权限和 Unix 换行。工具按此设置 ZIP 属性。禁止包含 `.runtime`、登录资料、项目文件、日志、旧 Windows 启动器和 PowerShell 更新脚本。

不要运行旧 `tools/package-release.mjs`；根发布工具是本仓库唯一打包入口。完整维护步骤见仓库根 [docs/RELEASING.md](../../../docs/RELEASING.md)。
