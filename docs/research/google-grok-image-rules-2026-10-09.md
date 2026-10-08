# Google Nano Banana 与 Grok Imagine 普通生图规则调研

核对日期：2026-10-09。本文记录本次可访问的一手资料及其对提示词规则的影响；模型名识别只用于推荐规则，不证明当前渠道已开通模型。分类预设是本应用整理资料的约定，不是厂商要求的固定提示词格式，也不是生图效果保证。

## Google 官方依据

[Gemini API 生图指南](https://ai.google.dev/gemini-api/docs/image-generation) 当前列出以下家族成员：`gemini-2.5-flash-image`、`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-nano-banana-2.1`。这些名称包含明确的图像能力，不能据此把普通 Gemini 聊天模型全部归入香蕉规则。文档区分各代参考图能力；Lite 未针对多参考图和连续编辑优化，因此通用预设不固定承诺参考图数量、分辨率或自动多轮编辑。

[Google Cloud 提示词指南](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana) 建议具体描述主体、动作、环境、构图和风格，以明确操作动词开头，优先描述目标状态。多图输入说明各参考图与目标画面的关系；编辑明确要修改和要保留的部分。本应用据此使用连贯自然语言，不默认输出标签堆叠或 SD 权重。

[Google DeepMind 提示词指南](https://deepmind.google/models/gemini-image/prompt-guide/) 建议交代风格、主体、场景、动作和取景。需要图中文字时提供带引号的准确文案与字体风格；使用参考图时，为不同角色或物体赋予清楚名称以区分归属。本应用仅在实际附图时生成图号引用，不把参考图顺序推定为人物站位。

## xAI 官方依据

[xAI 当前生图指南](https://docs.x.ai/developers/model-capabilities/images/generation) 使用 `grok-imagine-image-2.0`，以 `aspect_ratio`、`resolution` 等请求字段配置图像。输出张数参数与单张图片内部的格数含义不同，不能用多张输出代替五视图或多宫格布局。

[标准模型页](https://docs.x.ai/developers/models/grok-imagine-image) 列出 `grok-imagine-image` 及 `grok-imagine-image-2026-03-02`；[质量模型页](https://docs.x.ai/developers/models/grok-imagine-image-quality) 列出 `grok-imagine-image-quality`、`grok-imagine-image-quality-20260403`、`grok-imagine-image-quality-latest`、`grok-imagine-image-pro`。规则可识别这些图像名称，但不能把 `grok-4` 等聊天模型或 `grok-imagine-video` 视频模型自动归入图像规则。

[质量模型迁移说明](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2) 计划于 2026-11-02 将 quality 名称重定向至 2.0 的 low 档，标准版不受影响。核对日尚未到达迁移日期，不能把未来行为描述为当前已生效。

[官方生成用例](https://x.ai/grok/use-cases/image-generation) 建议自然语言写清主体、风格、光线、构图和情绪；[官方编辑用例](https://x.ai/grok/use-cases/image-editing) 以可见区域和对象说明修改。本应用据此优先关键画面事实，再补充材质和情绪，不用抽象质量词代替构图与身份事实。

[官方编辑指南](https://docs.x.ai/developers/model-capabilities/images/editing) 说明 xAI 编辑接口接受 JSON，不能直接假定 OpenAI SDK 默认 multipart 编辑方法可用。[多图编辑指南](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing) 使用最多五张源图并按请求顺序引用，示例对应 2.0。此上限不写入所有渠道通用的提示词规则。

核对[官方 REST 图像文档](https://docs.x.ai/developers/rest-api-reference/inference/images) 与生图指南后，未找到公开支持独立 `negative_prompt` 字段的说明。本次预设不依赖独立负面字段，必要限制融入自然语言正文；这不等于断言所有第三方网关都拒绝该字段。[2.0 发布说明](https://x.ai/news/grok-imagine-image-2) 描述文字与复杂版式能力改进，但不应据此保证文字、身份、朝向或五视图区位百分之百准确。

## 国内使用场景下的中文兼容平台差异

下列均为平台自行发布的接口说明，只用于证明平台之间存在差异；平台文档不代表已对当前账户执行过付费请求，也不代表 xAI 或 Google 官方接口规范。

| 一手资料 | 与规则/接入有关的差异 |
| --- | --- |
| [HopBase Gemini 文档](https://hop-base.com/zh-tw/docs/media/gemini-image) | 使用 OpenAI Images 结构；不同账户分组的编辑入口不同，部分分组需要在 generations 请求中附图。文档要求模型以实际 Key 的模型列表为准。 |
| [HopBase Grok 文档](https://hop-base.com/zh-tw/docs/media/grok-image) | 编辑网关只接受 1–2 张图，可处理 JSON 和 multipart；与 xAI 官方五张图和 JSON 接口的说明不同。 |
| [UniAll Grok 文档](https://docs.uniall.ai/zh-CN/models/video/grok/grok-imagine-image/) | 除兼容 Images 端点，还提供自有异步图片任务；编辑支持 JSON 图片 URL 和 multipart。文档更新时间为 2026-05-29，不能把其较旧模型列表当成 xAI 最新全集。 |
| [速云 u 站 Grok 文档](https://uzsyapi.apifox.cn/9406952m0) | 普通编辑是单文件 multipart；自有 advanced JSON 入口说明支持 2–3 张参考图，不能照搬为其他渠道的能力。 |

因此，规则库的 `openai` 标签表示应用现有兼容 API 通道。提示词预设只负责描述目标画面，不设置或承诺某个网关的具体请求字段、上传上限和原生工具能力。

## 本应用分类整理方案

以下内容是结合现有图片规格和空间连续性约束形成的应用方案，不是官网逐字模板，也未以真实生图成功率作为结论。

| 每家预设 | 整理重点 |
| --- | --- |
| 角色参考图 | 根据当前肖像、半身或全身取景绑定身份；只展开可见外观，侧背面不为展示五官而转正。 |
| 多人角色同框 | 逐人绑定姓名、站位、外观、动作、视线和持物；人物专属属性不混为全局属性池。 |
| 角色设定图 | 当前规格决定区域与视角；所有区域保持同一身份和衣着，不自行改为固定数量的视图。 |
| 五视图参考板 | 使用现有横向 3:2、左侧两张头肩特写、右侧三张全身的合同；头像不补全身，背面不转正脸。 |
| 场景参考图 | 固定空间结构、前中后景、陈设、时间和光线；风景规格保持无人环境，人物事件不自动进入画面。 |
| 道具参考图 | 明确结构、比例、材料与当前状态；局部特写保持局部，不凭空补入使用者或标签。 |
| 分镜单帧与首尾帧 | 冻结当前时刻；首帧保留初始状态，尾帧保留完成结果和当时实际取景，不拼贴整段过程。 |
| 多人分镜与动作关系 | 明确施事者、目标、接触部位、人物自身左右、画面方向和遮挡；画外目标保持画外。 |
| 多宫格视觉母版 | 按当前行列与阅读顺序逐格描述一个时刻；连续格保持身份、场景锚点和道具归属。 |

共同边界：普通规则不自动引入私密档案或微 NSFW 风格；非类人角色保留真实结构；只有明确全身区域要求头至足端完整；实际取景、动作方向、视线与遮挡优先于“展示全部外貌”。需要图中文字时才生成准确文案与排版要求，不额外加入标题或标签。

## 验证范围

新增行为测试覆盖模型识别、两家各九种分类的可选择性、手选优先、五视图推荐与用户编辑/禁用/删除、目录 17 到新目录的增量迁移和自定义/空目录保护。测试脚本的执行结果以交付时的实际测试输出为准；本文不声称已完成付费生图或界面全量回归。
