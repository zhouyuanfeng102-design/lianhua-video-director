# 长剧情分段导演设计规格

日期：2026-08-20

## 目标

在现有“视频导演台”的单段导演能力之前增加“全片规划”阶段。系统先根据完整剧情估算或接受用户指定的全片总时长，再按照用户在现有时长控件中选择的单段生成时长，把剧情拆成多个可独立生成的视频段。每个视频段继续复用现有 Storyboard、VideoShot、提示词适配、版本恢复和生成任务能力。

首版只负责长剧情规划、分段提示词和有序导出，不包含自动视频拼接、补帧或自动抽取上一段尾帧。

## 产品术语

- 全片计划：一段完整剧情的总时长和全部视频段。
- 视频段：一次显卡或视频 API 能够生成的独立视频单元。
- 单段生成时长：现有“5秒/10秒/15秒/自定义”控件所设置的目标时长与上限。
- 段内镜头：视频段内部由现有导演功能生成的 VideoShot。
- 全局时间：视频段在完整影片中的位置。
- 本段时间：交给视频模型的局部时间线，始终从 0 秒开始。

## 用户流程

视频导演台改为两个阶段，但复用同一块主工作区，避免增加页面高度：

1. 全片规划
   - 选择“单段直出”或“长剧情拆段”。
   - 全片时长可选“AI估算”或“固定总时长”。
   - 单段生成时长继续使用现有 5/10/15 秒和自定义秒数。
   - 点击“分析并拆段”，得到可编辑的视频段计划。
2. 单段导演
   - 顶部显示紧凑的视频段胶片条。
   - 选择一个视频段后，原有导演参数、镜头推荐和提示词生成作用于该段。
   - 可生成当前段，也可按顺序生成全部未完成段。

单段直出必须保留当前行为，不要求用户先建立全片计划。

## 界面结构

在“剧情与输入”下方增加阶段栏：

`① 全片规划 → ② 单段导演`

全片规划阶段替换原“导演参数”主体，不与原参数纵向叠加。规划确认后进入单段导演阶段，顶部仅保留一行胶片条：

`全片24秒 · 3段 | 第1段 0–8s | 第2段 8–16s | 第3段 16–24s`

长剧情模式下，现有控件文案调整为：

- “视频时长”→“单段生成时长”
- “实际秒数”→“本段秒数”
- “镜头数量”→“本段镜头数”

右侧结果区显示当前段提示词，并提供“生成当前段”“顺序生成全部段”“导出全部分段提示词”。1120×720、1280×720、1280×800 必须无页面横向溢出、控件遮挡和非预期页面滚动。

## 时长估算

AI估时输出建议范围、推荐总时长和理由。估算依据包括：

- 对白自然说完所需时间；
- 动作准备、执行和结果；
- 环境建立、人物反应和情绪停顿；
- 场景转换和必要转场。

系统同时标记剧情适配状态：宽松、合适、偏紧或无法容纳。用户指定时长明显不足时必须提示，不得静默删除剧情。

## 分段算法

分段分为确定性本地步骤和可选 AI 步骤：

1. 本地把原文拆成具有稳定 ID 的剧情节拍。
2. AI只返回连续的节拍 ID 范围、叙事目标和交接状态，不返回改写后的正文。
3. 本地按节拍 ID 重建每段正文，并校验无遗漏、无重复、无重叠。
4. AI不可用或结果无效时，使用本地标点、对白、场景变化、动作和因果规则拆分。

切点优先位于动作结果、信息传递完成、人物目标变化、场景变化或可明确承接的位置。长动作按“准备—执行—结果”拆分，不随机截断。

单段生成时长默认是目标值兼上限。若总时长不能整除：

- 优先避免过短尾段；
- 支持任意秒数的模型可平衡各段时长；
- 只支持离散时长的模型必须显示可用组合；
- 不得偷偷补帧、删剧情或改变用户锁定的总时长。

## 数据模型

Project 新增可选并标准化为空数组的 `sequencePlans`：

```ts
interface VideoSequencePlan {
  id: string;
  title: string;
  sourceStoryTitle: string;
  sourceStoryContent: string;
  durationMode: 'ai-estimated' | 'fixed';
  requestedTotalDurationSec?: number;
  totalDurationSec: number;
  segmentDurationSec: number;
  segmentationMode: 'natural' | 'fixed';
  fitStatus: 'comfortable' | 'balanced' | 'compressed' | 'insufficient';
  estimateReason?: string;
  segments: VideoSegment[];
  createdAt: number;
  updatedAt: number;
}

interface VideoSegment {
  id: string;
  index: number;
  title: string;
  globalStartSec: number;
  globalEndSec: number;
  durationSec: number;
  content: string;
  summary: string;
  sourceSceneIds: string[];
  sourceBeatIds: string[];
  narrativePurpose: string;
  entryState: string;
  exitState: string;
  transitionHint: string;
  storyboardId?: string;
  status: 'planned' | 'generating' | 'ready' | 'stale' | 'failed';
  locked?: boolean;
}
```

Storyboard 增加可选关联字段：`sequencePlanId`、`segmentId`、`segmentIndex`、`segmentCount`、`globalStartSec`、`globalEndSec`、`continuityIn`、`continuityOut`。

VideoGenerationTask 增加可选的 `sequencePlanId`、`segmentId`、`segmentIndex`，便于任务排序和恢复。

存储版本升级到 schema v6。旧项目缺失 sequencePlans 时补空数组；旧 Storyboard 和任务不要求新字段。

## Storyboard 复用规则

每个视频段关联一个现有 Storyboard：

- Storyboard.durationSec 等于本段时长，不能写全片时长。
- Storyboard.sourceStoryContent 等于本段正文快照。
- VideoShot.startSec/endSec 始终是本段局部 0—N 秒。
- 全局时间只用于界面、排序、导出和任务元数据。
- entryState/exitState 合入连续性提示词。

不得复用 GenerationPlan.batches 表示视频段；该结构用于试跑、成本和镜头批次，并不保证剧情连续。

不得把固定时长的视频段直接建模为 Scene；Scene 仍表示语义场景，一个场景可以跨多个视频段。

## 连续性接力

第 N 段的 exitState 自动成为第 N+1 段的 entryState，至少覆盖：

- 主体身份、物种和外观；
- 姿态、朝向、运动方向和屏幕轴线；
- 场景、时间、天气和光线；
- 道具位置、持有者和损坏状态；
- 正在延续的对白、音乐和环境声；
- 本段尾动作与下一段首动作。

修改某段正文或边界时，当前段和下一段标记 stale。重排时，移动段及其新旧相邻段标记 stale。手工锁定的段和提示词不得被批量重建覆盖。

## 批量生成与恢复

“顺序生成全部段”采用串行队列，不并发调用文本或视频接口。每段完成后立即保存：

- 中断后从第一个未完成段继续；
- 单段失败不撤销已经完成的段；
- 支持仅重试失败段；
- 用户取消时保留已完成结果；
- 原剧情变化后计划显示“源剧情已变化”，由用户选择重新分析或保留旧快照。

## 编辑能力

全片计划支持：

- 修改段落摘要、正文、时长和交接状态；
- 拆分、合并和拖拽重排；
- 锁定单段；
- 仅重建当前段；
- 全局导演参数应用到全部段或仅当前段。

合并后的时长不得超过单段生成上限。改变边界后必须重新校验全片时间连续性。

## 导出

支持：

- 复制当前段提示词；
- 导出当前段 TXT；
- 导出全部分段提示词 TXT/JSON；
- 导出清单包含段序号、全局时间、本段时长、Storyboard ID、连续性接力和提示词。

## 校验与错误处理

保存计划前必须满足：

- 所有段按序连续，无时间空洞和重叠；
- 总时长与各段时长之和一致；
- 所有节拍恰好出现一次；
- 每段不超过单段生成上限；
- 每个 Storyboard 的局部时间从 0 开始并在本段时长结束；
- 相邻 exitState 和 entryState 可衔接。

AI输出无法修复时不保存无效计划，并指出具体段号和原因。

## 首版验收

1. 24秒剧情、单段8秒产生3段，每段 Storyboard 和提示词均为局部0—8秒。
2. 26秒剧情、单段8秒不会无提示地产生不可用的2秒尾段。
3. AI拆段结果不得遗漏、重复或改写原文节拍。
4. 修改第2段后，第2段和第3段标记连续性需更新。
5. 单段直出行为与旧项目保持不变。
6. 无文本 API 时可生成本地分段计划。
7. 批量生成可中断、续跑和仅重试失败段。
8. 1120×720、1280×720、1280×800 无重叠、横向溢出和页面级滚动。

