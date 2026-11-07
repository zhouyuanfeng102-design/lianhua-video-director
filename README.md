# 莲华视频导演台

<img src="public/icon.png" alt="莲华视频导演台图标" width="88" align="right" />

从小说与剧情出发，整理人物、场景、连续分镜和视频提示词的工作台，提供 Windows 便携版和 Android 手机 APK。

当前版本：**3.9.8** · 2026-11-07 · Windows x64 / Android

## 下载与使用

### [⬇ 下载 Windows EXE / Android APK](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest)

[最新版本下载页](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest) · [本版更新说明](docs/releases/发布说明-3.9.8.md) · [安卓安装说明](docs/android-install.md) · [反馈问题](https://github.com/zhouyuanfeng102-design/lianhua-video-director/issues)

1. 电脑下载 [Windows 便携版 EXE](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/download/v3.9.8/lianhua-video-director-3.9.8-windows-x64-portable.exe)，放在可写入的文件夹里双击运行；安卓手机下载 [Android APK](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/download/v3.9.8/lianhua-video-director-3.9.8-android.apk) 后安装。普通使用者无需安装开发环境。
2. 在“API 设置”配置需要使用的文本、图片或视频服务。
3. 导入 TXT / Markdown 分章原文或手动新建章节，选择章节后解析剧情，再进入导演台生成、编辑和导出提示词。导入不会自动调用 API 批量解析全书。

下载页里的 Source code 和恢复源码 ZIP 用于开发。第三方 AI 服务的账号和费用由使用者自行配置。手机按屏幕宽度使用紧凑顶栏、底部导航和单列页面，常用设置与长文本可纵向展开。

更新前请先保存项目并退出旧版，保留 EXE 旁的“莲华视频导演台数据”文件夹。 自 1.5.2 起项目与素材分文件保存，移动或备份时请保留整个数据文件夹；不要单独把新存档索引交给旧版打开。详见[保存与恢复说明](docs/releases/发布说明-1.5.2.md)。

安卓更新直接覆盖安装同签名新版 APK，保留应用数据；卸载或清除数据前先导出带素材的 `.lhvd` 项目包。电脑和手机通过项目包互相转移，API 密钥在各设备重新配置。安卓基础能力与既有测试边界见 [3.9.7 能力与验证记录](docs/releases/能力与验证记录-3.9.7.md)。本版 APK 已完成正式签名核对，尚无本版 Android 设备安装与原生功能实测记录。

## 使用与引用说明

本项目由作者独立开发和维护，包含程序代码、界面设计、提示词规则、文档及其他原创内容，请尊重作者的劳动成果。

如需转载、引用、二次开发、整合到其他项目，或将本项目及其内容公开发布、用于商业用途，请先征得作者同意。使用时请保留项目名称、作者信息和原项目地址，不要删除、隐藏或替换原有署名，也不要将本项目或修改后的版本作为自己的原创成果发布。

作者联系方式：QQ 815408198

完整来源声明见 [NOTICE.md](NOTICE.md)。

## 能做什么

- **章节与资料整理**：在一个项目中完整导入 TXT / Markdown 分章原文，手动新建、重命名、排序和归档章节；人物、场景、道具与参考图在项目内共享。
- **连续分镜规划**：支持单段制作与长剧情拆段，编辑镜头、时长、运镜及连续性。
- **提示词生成**：生成中英文视频提示词，单独重试、修改并保存历史版本。
- **参考图风格分析**：在导演与视觉上传单张参考图，结合自定义要求使用视觉 API 填写风格；无图沿用文本分析，参考图随章节保存。
- **漫画生成剧情**：在剧情解析的图生视频中选择漫画生视频，上传多页 PNG/JPG 或条漫，设置页序、阅读方向与对白语言；一次识别生成可编辑剧情，采用后进入现有分镜流程。原页保留为剧情证据，单格可裁图入库供视频参考。
- **图像与视频任务**：配置对应服务后提交任务，管理参考图、首尾帧、批量任务与结果，查看图片任务实际使用的生图规则与分类预设。
- **RunningHub 云端图片**：图片 API 可独立保存云端应用，导入 cURL、请求 JSON 或完整 API 说明，绑定提示词、尺寸和参考图片槽；查询生成状态并保存图片到资产库。
- **自定义生图+反推图片提示词**：输入要求生成图片，或复用上传/资产库参考图，通过视觉 API 反推可复制的提示词与人物、物品、场景、风格详情。反推同步显示在聊天和资料任务，支持后台执行、停止、重试及项目保存恢复；原有生图支持原文直发或规则转换，结果自动入库。
- **项目与资产管理**：管理图片、视频和音频，保存项目包、备份资料并导出提示词。

## 最新更新 · v3.9.8

- 下次生成提示词时，门、窗、柜门、抽屉和盖子留在原来的铰链或轨道上，只转动或滑动。
- 杯子、信、武器等可拿起的物件仍按取放写。原文写明拆下时，部件才离开安装位。
- 已保存的提示词和已经生成的视频保持原样，重新生成该段后才会用新写法。

后续常规版本持续双端交付；仅某一端独立 UI 调整使用明确单端参数。已有提示词和成片保持原样。

[查看本版完整说明](docs/releases/发布说明-3.9.8.md) · [历史版本归档](docs/releases/README.md)

## 从源码运行

项目使用 Electron、React、TypeScript 和 Vite。在源码目录执行：

```powershell
npm ci
npm run desktop:dev
```

构建前端使用 `npm run build`。本地视频处理和 Windows 打包还需按[媒体工具说明](build/media-tools/README.md)准备 FFmpeg / FFprobe。

## 文档与项目结构

| 入口 | 内容 |
| --- | --- |
| [完整使用与开发说明](docs/project-guide.md) | 详细工作流程、配置说明与开发记录 |
| [历史版本说明](docs/releases/README.md) | 按版本归档的更新记录 |
| [GitHub 发布指南](docs/github-publishing.md) | 源码上传与软件下载发布流程 |
| [版本规则](AGENTS.md) | 项目版本递增与历史文件保护规则 |
| `src/`、`electron/` | 前端界面与桌面程序源码 |
| `scripts/` | 测试、验证和交付脚本 |

分享软件下载，请使用：[最新版本下载页](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest)。
