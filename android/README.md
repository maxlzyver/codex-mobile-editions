# Codex 移动助手 Android

适用于 Android 8.0 及以上，与电脑端 Codex 移动助手 1.4.0 配套。

1. 在电脑助手的「连接手机」中选择 Wi-Fi 或互联网连接，生成二维码。
2. 在 App 里扫描电脑二维码，也可以粘贴电脑端复制的配对链接。
3. 在电脑端批准设备。左上角可以打开聊天和过往项目，进入聊天或项目文件时侧栏自动收起。

手机从 Wi-Fi 切换到移动数据时，会尝试连接已保存的外网地址。外网依赖电脑上的临时隧道，同一个隧道运行期间沿用原地址。隧道重建以后，可以通过原局域网连接同步新地址，或在 App 中点连接状态并更新地址。电脑关机或休眠时，连接会等电脑助手上线。

Android Keystore 保管设备密钥。电脑批准的授权在助手重启和升级后继续有效，由电脑端「已连接与待确认设备」撤销。清除 App 数据、换机或卸载重装后，需要在电脑上重新批准。App 每次建立连接会核验首次扫码的电脑身份，聊天与文件经双方建立的加密会话传输。

手机可发送文字和文件。Android 每条消息最多 8 个附件，每个最多 8 MiB。Codex 和 GPT 的发送、停止和审批权限以电脑端返回的能力为准。

## 从源码构建

使用 JDK 21、Node.js 24、Android SDK Platform 36、Build Tools 36.0.0，以及 ZXing Core 3.5.3。ZXing 的 Apache 2.0 许可随 APK 打包。

- 用 `ANDROID_HOME` 指定 SDK 根目录。独立解压的工具也可以设置 `CODEX_ANDROID_PLATFORM` 为 `android.jar`、`CODEX_ANDROID_BUILD_TOOLS` 为 Build Tools 目录。
- 用 `CODEX_ANDROID_ZXING_JAR` 指定 ZXing Core JAR。
- 用 `CODEX_ANDROID_KEYSTORE`、`CODEX_ANDROID_STOREPASS` 指定签名材料，别名默认为 `codex-mobile`。升级沿用首次发布的签名证书。签名材料由发布者保管。
- 在仓库根目录运行 `node android/build.mjs <输出 APK 路径>`。只编译并验证资源时可加 `--unsigned`。

`node tools/test-android-access.mjs` 在隔离的桌面助手实例测试授权、重启、外网换地址和撤销。
