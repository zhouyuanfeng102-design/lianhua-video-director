# H3 多人相遇时的站位与视线

2026 年 11 月 21 日。调查对象为一组匿名化的三人相遇分镜示例中的《路口等候与走近》，第 1 段英文第 2 版。配套的中文稿属于第 2 段《叫住与交谈》。

## 第 11 秒发生了什么

| 证据 | 记录中的关系 |
| --- | --- |
| 原文与第 1 段分段结果 | 陈舟在槐树下等候。许宁走在林月前面，林月在她侧后半步。许宁先看见他，在距他数步处停下并笑开。开口叫“老师？”归第 2 段。 |
| 第 1 段场面规划 | 两人沿碎石路向槐树走，停点在树前数步。许宁的视线对象是陈舟。林月起初看前方路面。 |
| 第 3 镜中文分镜，11–15 秒 | `space` 写“老槐树与陈舟在前方”，`direction` 写许宁的脸和眼睛朝他。`camera` 却同时要求“机位在两人侧前方，看见许宁的脸与上半身，陈舟在画面深处槐树下”。这组描述在保存的两个版本里都出现了。 |
| 第 2 版实际提交 | 英文沿用 `camera at the front-side of the two` 和 `with Chen Zhou under the locust tree deep in the frame`，动作又写许宁的目光落到他身上。林月在这拍只有跟停和表情。冻结任务正文与成功请求正文一致，人物、场景、道具的参考图编号与实际输入相符。 |
| 成片切点 | 5–10 秒能从陈舟左肩旁看到两人沿路走向他。11 秒切镜，两人占据前景，身后的树下出现陈舟。许宁随后转向林月，收尾朝镜头一侧笑。画面通过剪切改变了三人的前后关系。 |

首次能从保存记录定位的冲突在中文分镜的摄影描述。面对面拍许宁时把陈舟放到她身后的纵深，给出了一个能呈现她的脸、却让她的视线难以落到他身上的构图。英文准确继承了这个冲突。成片和提交稿支持这条因果解释，H3 内部如何权衡多个描述无法从本地记录得知。

第 2 段首镜也沿用“两人侧前方＋深处的陈舟”。此外，开场构图先写林月看向陈舟，逐拍表演又写许宁发话时林月看许宁，随后目光随话转向陈舟。此处要交代视线变化的时机。陈舟闻声转身、唤二人过来后，二人才继续走近。

## 实施方案

1. **新分镜先安排人，再选机位。** 沿用已有 `sceneStaging` 与逐镜 `space`、`direction`、`action`、`result`、`camera`。写出同行者谁在谁侧后、朝哪个人或地标走、在哪里停，以及每个人这拍看谁。下一镜从上一镜结束时的位置选取景。需要见到反应时，可以从目标肩旁拍脸，或从路侧拍侧脸和目标。实际剧情有经过、回头或人物主观视角时，按该事件选择机位。[分镜生成](../../src/services/llm.ts) · [现有空间规则](../../src/spatialContinuityRules.ts)
2. **让“重新生成本段”能够纠正冲突的旧机位。** 目前允许依据原文重写动线，同时要求继承已采纳的摄影。建议在现有重写请求中，仅对与本段世界站位或视线冲突的镜头改观察位置、可见面和前后景，沿用镜数、切点与其余可兼容的摄影选择。把本轮逐镜摄影与动作一同传入中文 H3 稿和英文交付稿。普通翻译以已采纳的中文镜头为准，历史成片与提交记录继续对应当时的版本。[重写规则](../../src/videoCreativeDirection.ts) · [中文重写入口](../../src/appEffects.ts) · [H3 交付入口](../../src/singleSegmentPrompt.ts)
3. **改写会诱导演员看镜头的内置示例。** 现有模板给反打的英文例句是 `In the reverse shot she faces the lens`，另有“两人相对时，眼睛互相看着”的示例。把两处改成按事件分别指定谁看谁、摄影机从谁的肩旁观察。许宁先认出陈舟时，他可以继续等候，等听到呼唤再转身。剧情明确直视镜头、回看同伴或看向画外人物时，使用各自的真实目标。[表演摄影示例](../../src/videoActingCameraRules.ts) · [中英文转换示例](../../src/videoConversionRules.ts)

### 第 1 段第三镜可用的 H3 摄影与表演节选

> [Shot 3] At 00:11.000
> The camera holds a medium close shot just behind and to the side of Chen Zhou. The edge of his shoulder stays on screen-left. Several steps away, Xu Ning spots him, stops on the gravel path and smiles, her eyes on him just past his shoulder. Lin Yue stops half a step behind and beside Xu Ning. A beat later, she follows Xu Ning’s gaze to Chen Zhou. All three remain silent.

“林月晚一拍顺着许宁的目光看过去”是为让两人都看向陈舟所选的表演安排。原文只明确许宁先认出他。第 2 段允许林月听见许宁说话时短暂转看她，再看回陈舟。

实施后只需用本案做一次开发阶段的离线提交组装，观察 11 秒处中英文对人物位置、视线对象与机位的表述，以及第 2 段的台词归属。使用现有生成及重写流程即可。此文交付调查与方案，成片示例的实际生成效果尚待实施后观察。

## 第 3 版仍按冲突机位出片

第 3 版英文第 3 镜仍是 `observing from the oblique front of the two, with 陈舟 remaining under the locust tree in the depth of the frame`，动作句又写胸口朝向陈舟。0:09 沿路走向他，0:13 切到两人脸冲镜头、陈舟在身后。先前那条“发现矛盾再改机位”的说明没有换掉模型会抄的句子。第 3 版镜头字段原样抄了 `The camera holds this frame. It stays at this distance`，再自行补上斜前方和画面纵深。

H3 按镜头句摆人。斜前方是脸前，画面纵深是这台摄影机的远处，陈舟就被放到脑后。官方参考指南要求每一镜写明构图和人物位置；《问道无极》把同一失误改成“谁面对谁、镜头站在谁身后”。现行分镜、重写和英译改为可直接抄的侧后方句和肩后句。迎面后退跟拍只在被看的人留在镜头后方时使用。已保存的第 3 版成片和提示词不改写。

## 国内外资料

- MiniMax H3 官方多参考写作指南要求逐镜写构图、主体位置、动作变化和参考素材用途；中文接口文档进一步区分首帧和普通参考图。人物身份图与画面构图可以承担不同职责。[H3 官方英文指南](https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/skills/h3-prompt-writing/references/ref-en.txt) · [MiniMax 中文视频文档](https://platform.minimax.cn/docs/guides/video-generation)
- 国内《问道无极》创作者在阿里云开发者社区记录了相似失误。只写人物近景和背景中的野猪，原定迎面相遇的目标就出现在人物背后。作者将双方朝向、位置和摄影机从谁背后观察一起写入镜头。[国内创作者实录](https://developer.aliyun.com/article/1780365)
- 海外 Hugging Face 的 H3 双人镜头实测同时调整了逐镜描述和参考素材，作者说明了这两个变量。该经验支持按镜记录站位，但无法单独归因到提示词或参考图。[H3 模型讨论区原帖](https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/125)
