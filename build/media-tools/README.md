# 视频工作台媒体工具构建资源

- `win32-x64/`：实际运行的固定版本 FFmpeg / FFprobe、许可证、原始上游说明和校验清单。
- `sources/ffmpeg-8.1.2.tar.xz`：FFmpeg 核心源码归档，随恢复源码包保存，不需要放入运行目录。

Electron 开发模式工具目录为 `build/media-tools/win32-x64`。便携包需要将原始 EXE 作为 `extraResources` 放到 ASAR 之外；不能只将 EXE 放进 `app.asar` 再执行。

建议的 `electron-builder` 配置（由项目主维护任务合入 `package.json`）：

```json
{
  "extraResources": [
    {
      "from": "build/media-tools/win32-x64",
      "to": "media-tools",
      "filter": ["**/*"]
    }
  ]
}
```

对应便携运行路径：`path.join(process.resourcesPath, 'media-tools', 'ffmpeg.exe')` 和 `ffprobe.exe`。运行时也可兼容 `media-tools/win32-x64/` 布局。

这两个静态 EXE 合计约 194.2 MiB 未压缩。不要把下载缓存、`ffplay.exe`、不需要的上游文档或压缩包重复放入运行包。`win32-x64` 中的许可证、来源记录和校验清单应随工具一并保留。

来源与许可证注意事项详见 `win32-x64/THIRD-PARTY-NOTICES.md`。其中核心源码归档不包含所有静态依赖的对应源码，不应将其描述为完整第三方源码包；公开再分发前须完成相应合规准备。
