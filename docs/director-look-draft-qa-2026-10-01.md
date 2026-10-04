# 导演与视觉草稿持久化修复

日期：2026-10-01。基于 V1.0.7 源码修复，未修改版本或生成新的交付包。

## 根因

“导演与视觉自定义要求”原本已写入项目，但导演分类、导演风格及说明、视觉风格和关联视觉预设主要存于 React 临时状态。尚未确认/生成时刷新会丢失；返回全片设置又会从旧确认指纹恢复，覆盖最新选择。旧分镜中的自定义导演 ID 还可能被内置预设解析器替换为默认值。

## 修复范围

- 新增项目级 `directorLookDraft`，保存完整六字段；手动输入、选择预设、有效 AI 回填走同一事务。AI 结果一次保存，不分多次覆盖。
- 启动、项目切换及返回全片设置统一按“草稿 → 历史确认快照 → 分镜原字段/创作资料 → 默认值”恢复。保留自定义 ID、名称、完整说明和明确清空的输入。
- 写入入口校验所属项目及工作区代次，避免切换项目或 A→B→A 后迟到的旧操作覆盖当前值；仅恢复界面不写草稿。
- 草稿在无关撤销/重做、序列化、项目导出/导入中保留。删除当前视觉预设时同步修正草稿中的关联 ID。
- 不新增模型调用或内容审核；不改已确认计划、H3 正文、NSFW 规则、媒体文件及正式项目数据。

## 验证

全部使用合成项目、内存状态或独立浏览器环境，AI 请求为 mock，未访问真实付费 API。

已通过：

- `npm run test:typecheck`
- `npm run test:director-styles`（包含新草稿存储测试与 13 个真实 App 动作测试）
- `npm run test:director-look-draft-ui`：保存/恢复五阶段（未确认手填刷新、即时项目切换、清空刷新、AI 回填刷新、预设选择刷新）；另在独立上下文验证四类过期 AI 响应及五阶段真实键鼠输入，确认迟到结果也不写入草稿
- `npm run test:video-direction`
- `npm run test:visual-styles`
- `npm run test:app-effects`（包含真实历史回放的同项目/跨项目撤销重做测试）
- `npm run test:app-context`
- `npm run test:story-pacing`
- `npm run test:sequence-plan`
- `npm run test:semantic-sequence`
- `npm run test:project-library`
- `npx --no-install tsx scripts/shotRewrite.test.ts`
- `npm run build`
- `npm run test:bundle-budget`（包含生产构建冷启动；最大块仍低于 500 KiB）

界面证据：`output/playwright/director-look-draft/report.json` 和同目录截图。未确认填写不创建分镜/全片计划、不写确认指纹。

## 既存测试问题

`npm run test:workflow` 在 `scripts/workflowFeatures.test.ts:480` 的旧源码正则断言失败：测试期待 `controller.start({ ...draft })`，现有 H3 投递链实际使用 `controller.start({ ...delivery.draft })`。本轮未修改该 H3 业务代码，也未为此扩大改动；导演草稿相关断言均已通过。不能将本次专项通过描述成整个项目全量测试通过。

构建仍有既存的循环分包/500 kB 提醒；生产冷启动及项目采用的 500 KiB 硬预算检查通过。
