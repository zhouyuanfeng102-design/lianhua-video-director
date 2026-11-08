# Android 构建与双端交付

项目使用 React/Vite 共用前端、Electron Windows 客户端和 Capacitor 8 Android 客户端。Android 原生工程位于 `android/`，前端平台桥接位于 `src/platform/`。当前版本 **4.2.3**，应用包名 `com.lianhua.video_director`，最低 API 26，编译及目标 API 36。

## 构建环境

使用 Node.js 22 或更高版本，安装项目锁文件对应依赖，并按 [Capacitor 环境文档](https://capacitorjs.com/docs/getting-started/environment-setup) 配置 Android Studio 与 Android SDK。项目 Gradle Wrapper 固定构建工具版本。Android SDK、JDK、Gradle 缓存和正式签名凭据属于本机构建环境，不包含在恢复源码 ZIP 中。

```powershell
npm ci
npm run pack:all
npm run deliver:4.2.3
```

`pack:all` 对共用前端执行一次类型检查和 Vite 构建，再生成 Windows x64 便携 EXE 与正式 Android APK。Android 步骤接收 `--skip-web-build` 复用同一次前端产物，避免重复检查。`deliver:4.2.3` 默认要求两种包同时存在，任一缺失即停止交付；产物在 `交付/` 中附更新说明、恢复源码和 SHA-256。

## 单端 UI 调整例外

只修改某一端界面且不影响共享业务时，可明确选择对应客户端：

```powershell
npm run pack:all -- --ui-only=windows
npm run deliver:4.2.3 -- --ui-only=windows
```

安卓单端参数为 `--ui-only=android`。常规业务、存储、接口或共用逻辑更新仍默认双端；单端参数必须由本次改动范围支持，不能作为遗漏 APK 的替代方式。

## 签名与版本

正式 APK 必须使用长期保留的同一签名密钥。构建脚本从环境变量 `LIANHUA_ANDROID_SIGNING_FILE` 指定的仓库外 `release.properties` 读取密钥库、别名与密码；默认位于 `$CODEX_HOME/lianhua-android-signing/release.properties`，未设置 `CODEX_HOME` 时使用用户目录下 `.codex/lianhua-android-signing/`。首次无配置时安全生成正式发布密钥，后续复用；请安全备份完整签名目录，丢失后会影响原应用的覆盖更新。JDK 与 SDK 可由 `JAVA_HOME` / `ANDROID_HOME` 指定，或使用脚本准备的 `.build-tools/android/` 环境。签名证书与 SHA-256 可公开核对，私钥和密码不得进入源码仓库、恢复源码 ZIP 或公开下载附件。

`versionName` 跟随 `package.json`，从 `0.6.0` 开始遵守十进位进位：`0.6.9 → 0.7.0`、`0.9.9 → 1.0.0`。补丁位和小版本位均为 0–9。使用 `npm run next-version` 查看下一版；不要用普通 `npm version patch` 代替。Android `versionCode` 需保持递增，历史已交付版本不重编号、不覆盖、不删除。

## 必要验证

按本次改动风险做一次相关检查。类型和生产构建由打包流程完成；手机 UI 检查覆盖页面溢出、触控、软键盘、系统栏和返回导航。保存/恢复、项目包互通、素材与任务状态变更需做相应定向测试。运行结果如实写入同版能力与验证记录；浏览器模拟手机的布局检查不能替代 Android 原生保存或设备测试。

恢复源码保留 `android/`、Gradle Wrapper、原生 Java、前端平台层和公开说明，排除 `.gradle`、`build`、已复制的 Web 产物、APK/AAB、`local.properties` 与签名凭据。上架 Google Play 或国内应用市场时，再按实际目标提交 AAB、隐私说明及相应材料；生成本地 APK 不代表已经完成商店上架。
