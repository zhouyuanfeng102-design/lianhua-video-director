# 莲华视频导演台

<img src="public/icon.png" alt="莲华视频导演台图标" width="88" align="right" />

从小说与剧情出发，整理人物、场景、连续分镜和视频提示词的 Windows 桌面工作台。

当前版本：**1.6.2** · 2026-10-09 · Windows 64 位 · 便携运行

## 下载与使用

### [⬇ 下载 Windows 便携版](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest)

[最新版本下载页](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest) · [本版更新说明](docs/releases/发布说明-1.6.2.md) · [反馈问题](https://github.com/zhouyuanfeng102-design/lianhua-video-director/issues)

1. 下载上面的 EXE，放在可写入的文件夹里，双击运行，无需安装 Node.js。
2. 在“API 设置”配置需要使用的文本、图片或视频服务。
3. 导入 TXT / Markdown 分章原文或手动新建章节，选择章节后解析剧情，再进入导演台生成、编辑和导出提示词。导入不会自动调用 API 批量解析全书。

普通使用者下载 EXE 即可。下载页里的 Source code 和 source-recovery.zip 用于开发；第三方 AI 服务的账号和费用由使用者自行配置。

更新前请先保存项目并退出旧版，保留 EXE 旁的“莲华视频导演台数据”文件夹。 自 1.5.2 起项目与素材分文件保存，移动或备份时请保留整个数据文件夹；不要单独把新存档索引交给旧版打开。详见[保存与恢复说明](docs/releases/发布说明-1.5.2.md)。

## 能做什么

- **章节与资料整理**：在一个项目中完整导入 TXT / Markdown 分章原文，手动新建、重命名、排序和归档章节；人物、场景、道具与参考图在项目内共享。
- **连续分镜规划**：支持单段制作与长剧情拆段，编辑镜头、时长、运镜及连续性。
- **提示词生成**：生成中英文视频提示词，单独重试、修改并保存历史版本。
- **图像与视频任务**：配置对应服务后提交任务，管理参考图、首尾帧、批量任务与结果，查看图片任务实际使用的生图规则与分类预设。
- **项目与资产管理**：管理图片、视频和音频，保存项目包、备份资料并导出提示词。

章节独立的文生视频 / 图生视频入口支持逐张上传与完整 AI 识图、人工修订、一图多人、跨图同人及“我”的身份设置，完整参考资料参与扩写、画面转化和解析。普通、私密、分镜和首尾帧统一使用1K／2K／4K生图分辨率。1.5.9将模型能力与推荐比例改为提醒，GPT选择4K自动使用横向3840×2160或竖向2160×3840，自定义尺寸保留输入值，规则随实际画幅调整。详见[版本说明](docs/releases/发布说明-1.5.9.md)。

1.6.2 压缩剧情参考图区域，给原文编辑更多空间；删除包含未结束视频任务的项目时，在一次确认中说明影响并允许继续。删除本地项目不会取消服务器任务，远端任务可能仍继续计费。详见[本版更新说明](docs/releases/发布说明-1.6.2.md)。

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
