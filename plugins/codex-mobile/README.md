# Codex 移动助手插件 · 1.3.0

在 Codex 内管理手机连接、二维码、设备、手机权限、使用说明、插件更新和关于。软件版与插件版使用同一个本地后台；手机继续使用浏览器。插件不会打开助手的独立管理网页。

## 首次安装

先完整解压与你系统对应的 Editions 1.3.0 软件包，并安装、登录 Codex。插件包不包含另一份 Node.js 或 Codex：安装工具和插件均使用软件包自带的 Node.js 24。

Windows PowerShell（将路径换成自己的目录）：

```powershell
.\Install-Plugin.ps1 -InstallationRoot 'D:\Apps\Codex-Mobile' -DefaultCwd 'D:\Projects' -Register
```

macOS：

```bash
bash ./Install-Plugin.command '/Users/you/Applications/Codex-Mobile' --default-cwd '/Users/you/Projects' --register
```

`InstallationRoot` 指包含 `edition.json`、`server.mjs` 与 `runtime` 的完整软件目录；`DefaultCwd`/`--default-cwd` 是已存在的独立工作目录，不能是磁盘根目录、软件安装目录或其子目录，已有软件配置时可以省略。安装器自动发现 Codex CLI，优先检查 `CODEX_BINARY`、已有启动配置、PATH 和官方常见安装位置。`-Register`/`--register` 将本插件源加入 Codex、安装插件并在后台启动助手，全程不需要打开软件网页，也不改其他插件。省略注册参数时仅准备绑定和本地插件源。

安装结果输出 `marketplaceRoot`。需要手动注册时运行：

```text
codex plugin marketplace add "输出的 marketplaceRoot"
codex plugin add codex-mobile@codex-mobile-local --json
```

Windows 可执行 `Install-Plugin.ps1 -InstallationRoot 'D:\Apps\Codex-Mobile'` 只绑定；macOS 省略 `--register` 只绑定。开发验收可用 `-DataDir PATH` 或 `--data-dir PATH` 指定隔离的插件数据目录。插件源存放在稳定的用户目录，Codex 将其安装副本放入缓存，用户配置不会保存在缓存内。

## 在 Codex 中使用

安装后在 Codex 插件详情点击“打开”，直接进入手机连接页并自动启动或复用已绑定后台；“设置”可直接调整手机权限与自动更新。也可在对话中说“打开移动助手管理面板”，调用 `mobile_panel`。页面包含手机连接、设备、手机权限、使用说明、更新、关于六个栏目，提供“启动助手”用于重试，不打开外部网页。

同一 Wi-Fi：生成局域网二维码，手机扫码，直接在当前插件页面的待批准设备卡中批准，无需切换栏目。互联网：先开启互联网连接，再生成外网二维码，手机扫码后仍需批准。“设备”栏目继续提供授权设备管理与撤销。二维码两分钟有效且仅能使用一次。三个手机权限默认保持软件原设置；可单独开启手机审批、停止任务及其他目录浏览。原桌面聊天的停止、审批仍取决于 Codex 接口能力。

电脑保持开机、联网、不休眠。关闭插件页面不停止后台。`mobile_status` 读取状态，`mobile_diagnose` 生成不含认证密钥的诊断。MCP Apps 页面在支持该能力的本地 Codex 桌面宿主使用；不支持时会明确报告，不能将打开浏览器当作嵌入页面验收通过。

## 软件与插件更新

“更新”页面分别提供助手后台和插件的检查更新、一键更新、自动更新开关。自动更新默认关闭；启用后在任务空闲时运行。插件更新下载并校验插件代码、内嵌界面、MCP 配置、Skill 和清单，更新稳定插件源后请求 Codex 刷新安装缓存。

运行版本、已安装版本和最新版本分别显示。当前 MCP 会话仍加载旧代码时显示“已安装，待 Codex 重新加载”，不会把只更新后台或源文件称作插件已经生效。新开插件会话或重启 Codex 后核对运行版本；更新器不会强制重启 Codex 或中断聊天。更新失败保留旧文件并报告错误，配对、权限和项目数据保持原位。

## 开发与验证

构建使用锁定依赖：`npm ci --ignore-scripts`、`npm run build`、`npm test`。发行包已包含 `dist/server.mjs` 与 `ui/app.html`，用户安装无需 npm。插件与后台通信仅使用本机管理认证；owner token、Cookie、CSRF 不返回模型或页面。工具只接受列明的受控参数，不提供任意命令/URL/文件接口。

`npm run test:ui` 使用官方 MCP Apps AppBridge、真实 iframe 和隔离工具响应验证页面，不接触用户 Codex。Windows 使用已安装的 Edge；其他系统先执行 `npx playwright install --with-deps chromium`，或设置 `CHROMIUM_EXECUTABLE`。这项测试与真实 Codex 宿主验收分别记录。

作者：maxlzyver · 反馈：lzyuan666666@gmail.com · MIT。
