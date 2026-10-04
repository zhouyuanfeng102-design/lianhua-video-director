# 莲华视频导演台

<img src="public/icon.png" alt="莲华视频导演台图标" width="88" align="right" />

从小说与剧情出发，整理人物、场景、连续分镜和视频提示词的 Windows 桌面工作台。

当前版本：**1.3.0** · Windows 64 位 · 便携运行

## 下载与使用

### [⬇ 下载 Windows 便携版 v1.3.0（约 228 MB）](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/download/v1.3.0/lianhua-video-director-1.3.0-windows-x64-portable.exe)

[最新版本下载页](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest) · [本版更新说明](docs/releases/发布说明-1.3.0.md) · [反馈问题](https://github.com/zhouyuanfeng102-design/lianhua-video-director/issues)

1. 下载上面的 EXE，放在可写入的文件夹里，双击运行，无需安装 Node.js。
2. 在“API 设置”配置需要使用的文本、图片或视频服务。
3. 导入剧情，整理人物和场景，进入导演台生成、编辑和导出提示词。

普通使用者下载 EXE 即可。下载页里的 Source code 和 source-recovery.zip 用于开发；第三方 AI 服务的账号和费用由使用者自行配置。

更新前请先保存项目并退出旧版，保留 EXE 旁的“莲华视频导演台数据”文件夹。

## 能做什么

- **剧情与资料整理**：导入小说、TXT 或 Markdown，整理人物、场景、道具与参考图。
- **连续分镜规划**：支持单段制作与长剧情拆段，编辑镜头、时长、运镜及连续性。
- **提示词生成**：生成中英文视频提示词，单独重试、修改并保存历史版本。
- **图像与视频任务**：配置对应服务后提交任务，管理参考图、首尾帧、批量任务与结果。
- **项目与资产管理**：管理图片、视频和音频，保存项目包、备份资料并导出提示词。

1.3.0 新增“重新生成本段提示词”，支持保留原稿历史和英文单独重试。详见[版本说明](docs/releases/发布说明-1.3.0.md)。

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
