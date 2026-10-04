# GitHub 发布指南

本项目是 Windows Electron 桌面软件。GitHub 仓库存放源码和文档，Releases 存放供用户下载的便携版 EXE。

## 第一次创建仓库

1. 登录 GitHub，打开 <https://github.com/new>。
2. Owner（所有者）选择自己的账号。
3. Repository name（仓库名称）填写 `lianhua-video-director`。
4. Description（描述）可填写：`莲华视频导演台：从小说到连续视频分镜与提示词的 Windows 桌面工作台`。
5. Visibility（可见性）选择 Public（公开）。
6. 不勾选添加 README；Add .gitignore 和 Choose a license 保持不添加。项目已有 README 和忽略规则，许可证尚未选择。
7. 点击 Create repository（创建仓库），复制新仓库的网页地址。

不要把整个本地文件夹拖到网页上传。本目录同时包含历史交付、用户数据、浏览器资料和大量构建缓存，应使用 Git 按忽略规则和明确的文件清单上传。

## 首次上传

维护者在上传前完成以下准备：

- 检查工作树、暂存区和已有提交中的文件；本项目有较早的暂存内容，提交前要将计划发布的文件更新到当前版本。
- 保留 `src/`、`electron/`、`scripts/`、`public/`、构建图标、第三方说明、包管理配置、项目文档、启动脚本和历史发布说明。
- 排除 `.gitignore` 中列出的交付、构建产物、测试输出、浏览器资料、用户数据、环境配置和密钥文件。忽略规则不会删除本机文件，也不会移除已经被 Git 跟踪的内容。
- 审查待发布文件中的敏感信息及大文件。文件名排除和常见密钥扫描不能代替内容检查。
- 生成本地提交后连接新仓库并推送；不覆盖已有远程提交。

本机已经安装 GitHub CLI 时，可以在 PowerShell 使用浏览器登录：

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

按终端提示在 GitHub 官方网页输入一次性代码并完成授权，然后可用 `gh auth status` 检查登录状态。不要在项目文件或聊天中保存账号密码、个人访问令牌或 API Key。

已有本地提交、已完成文件审查且远程仓库为空时，维护者可使用以下命令。把示例用户名替换为真实用户名；若已有 `origin`，先检查现有地址，不要重复添加或直接覆盖。

```powershell
git remote add origin https://github.com/YOUR-USERNAME/lianhua-video-director.git
gh auth setup-git
git push -u origin HEAD:main
```

这会把当前本地分支推到 GitHub 的 `main` 分支，无需重命名现有本地开发分支。首次提交和推送应在全部准备完成后执行。

## 从源码运行

在装有 Node.js 和 npm 的 Windows 电脑上，进入源码目录：

```powershell
npm ci
npm run desktop:dev
```

只查看浏览器界面可使用 `npm run dev`，然后打开终端给出的本机地址；桌面专属功能需要 Electron。

构建前端：

```powershell
npm run build
```

视频处理和 Windows 便携包还依赖本地 FFmpeg / FFprobe。按 [媒体工具说明](../build/media-tools/README.md) 及其引用的来源、版本和校验记录准备二进制，放入 `build/media-tools/win32-x64/`。保留目录内的许可证、来源说明和校验清单。准备好这些文件后执行：

```powershell
npm run pack:win
```

生成结果在 `release/`，不会进入 Git 提交。

## 发布软件下载

新版本的发布说明保存为 `docs/releases/发布说明-版本号.md`，并更新同目录的版本索引。根目录 README 保持简短，放软件介绍、当前版本、下载入口和文档链接；详细使用与开发记录保存在 `docs/project-guide.md`。

在 GitHub 仓库的 Releases 中创建版本，填写对应版本标签、标题和发布说明，再附加已验证的便携版 EXE。第三方媒体工具随软件分发时，应先按已有 [第三方说明](../build/media-tools/win32-x64/THIRD-PARTY-NOTICES.md) 准备所需材料。

GitHub 下载附件使用英文文件名，例如 `lianhua-video-director-版本号-windows-x64-portable.exe`；同步核对配套启动器中的 EXE 文件名和下载校验清单。历史本机交付文件保留原名与原内容。分享给软件使用者的入口为[最新版本下载页](https://github.com/zhouyuanfeng102-design/lianhua-video-director/releases/latest)。

版本规则继续遵循根目录 [AGENTS.md](../AGENTS.md)：小版本和补丁位均为 0–9，如 `0.6.9 → 0.7.0`、`0.9.9 → 1.0.0`。可运行 `npm run next-version` 查看下一个版本建议；该命令不修改文件。不要使用普通 `npm version patch` 替代此规则。

本次 GitHub 准备不修改软件版本。已经交付的 `0.5.160` 及更早文件保持原名和内容，后续也不重新编号、覆盖或删除。

## 参考

- [GitHub：将本地代码添加到 GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)
- [GitHub：管理 Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
