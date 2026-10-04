# 视频工作台本地媒体工具

此目录包含未经修改的第三方独立命令行程序 `ffmpeg.exe` 和 `ffprobe.exe`，用于视频探测、抽帧、剪辑、拼接、转场及音频处理。应用通过子进程调用这些程序，不将其 DLL 链接到应用中。

## 版本与来源

- 构建版本：`8.1.2-essentials_build-www.gyan.dev`，Windows x86-64 静态构建。
- 构建提供方：Gyan Doshi（Gyan.dev），不是 FFmpeg 项目自行发布的 Windows 二进制。
- FFmpeg 官方下载页列出的 Windows 构建入口：<https://ffmpeg.org/download.html#build-windows>。
- 提供方主页：<https://www.gyan.dev/ffmpeg/builds/>。
- 固定发行页：<https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2>。
- 固定下载：<https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip>。
- 同版本镜像：<https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip>。
- 上游压缩包 SHA-256：`db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`。
- 校验来源：提供方同名 `.zip.sha256` 文件与 GitHub 发行资产的 `digest` 字段；2026-09-13 下载后已核对一致。

## 许可证

FFmpeg: Copyright (c) 2000-2026 the FFmpeg developers.

FFprobe: Copyright (c) 2007-2026 the FFmpeg developers.

**这套构建使用 GPL version 3 或更新版本，不是 LGPL-only 构建。** 编译选项包含 `--enable-gpl --enable-version3` 和 `--enable-libx264`，不包含 `--enable-nonfree`。

- 完整原始许可证：同目录 `LICENSE.FFmpeg.GPLv3.txt`，从发行压缩包的 `LICENSE` 原样复制。
- 构建说明、配置、编解码器、滤镜与外部库版本：同目录 `UPSTREAM-README.txt`，从发行压缩包的 `README.txt` 原样复制。
- 二进制与原始说明的 SHA-256：同目录 `SHA256SUMS.txt`。
- 项目法律说明：<https://ffmpeg.org/legal.html>。
- 程序本身也可用 `ffmpeg.exe -L` / `ffprobe.exe -L` 显示许可证信息。

这些工具按各自许可证提供，不作任何保证。请保留原许可证和版权声明，不要将 GPL 工具误标为应用自有代码或 LGPL-only。

## 源码与再分发

- 此版本 FFmpeg 对应提交：<https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13>。
- FFmpeg 核心源码固定归档：<https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>。
- 该核心源码已随本项目恢复源码包存放于 `build/media-tools/sources/ffmpeg-8.1.2.tar.xz`，SHA-256：`464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`。

注意：FFmpeg 核心源码归档**不等于**这套静态构建的全部对应源码；其外部依赖见 `UPSTREAM-README.txt` 末尾。公开再分发前，发布者还须依据许可证准备并持续提供完整对应源码、适用的依赖源码、必要构建材料与许可声明，不能只把本文件中的核心源码链接当成完整的 GPL 合规证明。上游构建来源及版本记录为获取相应材料提供线索；本记录不替代发布者的合规审查。

## 本地验证

2026-09-13 已在 Windows 上直接运行这两个文件的 `-version` 和 `-L`，均退出码为 0，版本一致。还使用本目录二进制实际生成 320×180 / 24 fps / 1.25 秒的 H.264 + AAC 测试 MP4，FFprobe 正确读到两种流及 48 kHz 音频，并从中文、含空格的本地路径成功抽取 PNG 首帧；未读取或改写用户视频。

程序可以离线调用，无需用户配置系统 PATH。媒体处理仍需由主进程限制到托管资产与临时输出目录，不能让不可信项目内容提供任意执行路径或 shell 参数。
