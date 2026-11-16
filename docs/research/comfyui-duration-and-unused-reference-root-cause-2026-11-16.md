# 本地 ComfyUI：时长映射与未选参考图问题

日期：2026-11-16。排查基线：4.7.0，实施版本：4.7.1。

本文保留排查证据，并记录用户确认后实施的修复。用户附件原件没有修改；检查和双端打包结果在本次交付说明记录。

## 1. 证据范围

用户先提供的设置截图显示：

- 工作流名称为 `H3盲流终极版_9图输入_无默认素材`，9 个图片槽。
- 参数只有 `seed → 132.value`、`fps → 148.frame_rate`。
- 生成页时长、分辨率、采样步数未绑定，输入框灰色。

后续聊天截图补充：

- 修改上述默认值没有解决问题。
- 客户工作流的 6 个图片加载器全部开启时，参考图不足 6 张会报错。

用户随后提供了实际分析附件：

`C:\Users\fgo\Desktop\H3-NSFW.json`

该附件有 100 个画布节点，经现有转换器得到 36 个执行节点、6 个图片槽、最终输出 364。附件没有节点 132、148，因此不能把这份文件的节点号套用到前面的 9 槽工作流。

尚未收到客户少图失败时的完整 ComfyUI 报错。本报告区分确定的软件行为、附件图证与尚待实际错误核实的部分，不声称已经连接客户服务端生成视频。

## 2. 时长不能选择的根因

### 2.1 当前软件缺少 duration 映射

`src/comfyuiVideo.ts:175–180` 的自动识别候选只有：

```text
seed / steps / cfg / width / height / fps
```

它既没有 `duration`，也不沿数值连线追踪上游秒数控件。

`src/videoOutputParameters.ts:44` 直接把 `mapping.parameters` 的键名作为 ComfyUI 可用参数。`src/components/VideoOutputParameters.tsx:29–42,95–97` 在缺少精确键 `duration` 时禁用时长控件。因此，仅修改 `seed` 行的默认值，不会让时长框可用。

### 2.2 这份附件的真实控制链

```text
259 PrimitiveFloat.value = 12 秒
    ↓
250 ComfyMathExpression.values.a
    ↓ INT 输出槽 1
265 MiniMaxH3ReferenceToVideo.length
    ↓ 生成、解码
364 VHS_VideoCombine，frame_rate = 24
```

259 的标题明确为“视频时长（秒）”。250 的实际表达式为：

```text
max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
```

它已经完成秒数到 24fps 帧数的换算，以及 H3 帧数对齐。官方对应版本同样使用 24fps，按 `17k+5` 对齐帧数。[S1]

因此，本附件正确的时长映射是：

```json
{
  "duration": { "nodeId": "259", "inputName": "value" }
}
```

其他已确认字段：

| 参数 | 正确位置 |
| --- | --- |
| seed | `397.seed` |
| steps | `261.steps` |
| cfg | `397.cfg` |
| fps | `364.frame_rate` |

不能把秒数直接写进 `265.length`，也不能修改 250 的表达式来代替时长输入。输出 fps 亦不是生成时长控件。

### 2.3 现有界面就能完成本附件的手工配置

通过现有“参数设置”的添加入口，添加参数名 `duration`，节点 ID 填 `259`，实际输入字段填 `value`，保存工作流。原默认秒数和换算公式可以保留。

这项配置仅适用于本附件。前面截图的 9 槽工作流还需读取其实际 JSON，不能照填259。

`videoGeneration.ts:2170–2173` 创建任务时冻结工作流；之后提交读取冻结副本。更改设置不会改写已经排队、历史复用或失败任务的原快照。

## 3. 参考图不足 6 张报错的根因

### 3.1 已选图会替换，未选图仍保留默认文件和连线

`src/comfyuiVideo.ts:213–216` 只替换已上传图片，未选图片槽明确保留工作流原值。最终请求也没有移除未选槽对应的 H3 图片连接。

本附件的真实图片消费顺序为：

| 槽位 | LoadImage 节点 | H3 消费字段 | 原默认值状态 |
| --- | --- | --- | --- |
| 1 | 51 | `265.ref_images.ref_image_0` | 原作者 JPG 文件名 |
| 2 | 49 | `265.ref_images.ref_image_1` | 原作者 JPG 文件名 |
| 3 | 50 | `265.ref_images.ref_image_2` | 原作者 JPG 文件名 |
| 4 | 43 | `265.ref_images.ref_image_3` | `None` |
| 5 | 19 | `265.ref_images.ref_image_4` | `None` |
| 6 | 23 | `265.ref_images.ref_image_5` | `None` |

因此，选择 2 张并不会形成只有 2 路有效参考图的请求，而是替换前 2 个槽，剩余 4 路仍然连着。`LoadImage` 对实际不存在的文件会报 `Invalid image file`。[S2]

这与客户“少图就报错”的反馈吻合。具体失败节点与错误类型仍应以客户完整报错为准。

### 3.2 H3 的这些输入本来就是可选项

附件265节点声明 `cnr_id="comfy-core"`、`ver="0.45.0"`。画布的 `ref_images.ref_image_0..8` 均为可选输入，没有参考图数量选择器。

对应版本官方实现为：

```text
ref_images: Autogrow
optional = True
min = 0
max = 9
```

执行端只遍历实际提供的图片。[S1] 所以这份附件不需要强制选满6张。上游已连接的加载器仍要能读取文件；“H3输入可选”不会自动关闭已连上的 `LoadImage`。

六个加载器的唯一直接消费者都是上表列出的 H3 图片字段，MASK 输出没有消费者。对本附件，移除未选图片的相应可选字段，可以使对应加载器脱离视频输出依赖。

### 3.3 实施中确认的空参考音频

附件的48、14、15三个LoadAudio默认值均为字符串`None`，分别连接265的三个可选ref_audios输入。官方对应版本LoadAudio会把该值作为文件名读取，不会返回空音频；路径无效会报告`Invalid audio file`。[S4]

因此，在新任务请求副本中同步省略这些明确空占位的H3可选音频输入，并清理失去用途的空加载器。非空固定音频文件名保留，不查询文件是否存在，不因“未选择”而删除未映射的固定音频，不改对白或声音规则。

## 4. 软件侧完整修复方案

### 4.1 时长识别

1. 识别明确以秒为单位的直接字段。
2. 对本附件这样“秒数控件 → 已知换算表达式 → H3 length”的结构，依据真实连线、节点类型和表达式识别秒数来源，绑定到原始秒数控件。
3. 仅凭节点号、数值10、任意 `value` 或标题，不能推断单位或参数用途。
4. 保留已有换算公式，不在软件再次换算；只有真实工作流缺少秒数入口且明确使用帧数时，才另行设计带单位的映射。
5. 在现有参数说明中明确 `duration` 是秒数入口，避免把种子、帧数或输出fps当作时长。复用现有编辑入口。

### 4.2 按实际选图构建请求

1. 在本次请求副本中，根据明确的图片映射与 H3 真实消费关系，移除未选槽对应的可选参考图输入。
2. 不再让本次未选映射槽的原作者文件名或 `None` 继续占用参考图。
3. 已选图片按真实消费顺序进入 H3；不按 LoadImage 节点 ID 排序。
4. 不重复图片填满槽位，不生成占位图片。
5. 仅移除失去有效输出用途的未选图片分支；仍用于首尾帧、蒙版、其他消费者的节点必须保留。
6. 对未知自定义节点或其他动态输入结构，不套用本附件的字段删除规则。

### 4.3 Picture 编号与实际发送一致

`src/h3ReferenceImageOrder.ts:158–160` 目前也按“未选槽保留默认”计算编号。

修复请求时必须同时修正这一处：让实际请求图片列表和 `<Picture N>` 引用复用同一份选图编译结果。例如选择物理槽2和5，实际只发送这两张时，应按真实消费顺序对应Picture1和Picture2，不能继续按原默认图片占位。

本次请求处理不回写原工作流、已保存提示词和历史冻结快照。

### 4.4 范围与验证

本方案不增加运行时校验、审核、生成拦截、自动重试、模型请求或按钮，不做哈希测试。

实施后只做一次针对性检查，覆盖：

- 秒数写到259，原250公式和265.length连线不变。
- 少图、满图和非连续槽位的实际请求与Picture编号一致。
- 仍有其他消费者的图片节点保留。
- 单段、批量、自定义视频复用相同处理。
- 原工作流与历史任务快照不被改写。

用户已要求实施和打包，共享业务修改按项目规则交付同版本EXE和正式签名APK。

## 5. 实施范围

- 新增 `src/comfyuiVideoDuration.ts`，以明确的H3消费者、数字来源、公式和输出槽确认秒数绑定，不执行用户表达式。当前支持的公式就是附件使用的24fps、17k+5换算结构，节点编号可变。未知公式继续使用已有手工映射。
- 新导入工作流写入识别出的duration映射；已保存工作流缺少映射时，生成页和绑定器共享有效映射读取。只补缺项，不覆盖显式配置、不自动改写存档。相同工作流文本和输出节点的推断使用有上限的缓存，避免在每次界面交互中重复解析完整图。
- `compileComfyH3ReferenceImageOrders()` 同时供实际请求和Picture编号使用。只缩减明确的官方H3可选参考图输入；固定未映射素材、首尾帧、未知图片变换、带标量选择器的其他动态结构保留各自语义。
- 新断开的独占LoadImage及已知单图操作会从请求副本移除；全图仍有消费者的加载器、MASK分支及其他输出保留。
- 同一已知H3可选音频结构中，直接LoadAudio来源为明确空字符串、`None`或`null`占位时，省略该可选输入并清理独占加载器；非空固定音频与未知来源保留。旧冻结任务仍按原默认策略执行。
- 新任务快照记录 `mapping.h3ReferenceSelection="selected"`。缺少该标记的旧冻结任务在恢复执行及预览时，通过临时副本沿用 `workflow-defaults`，避免旧提示词编号与旧请求突然改变；不修改原任务快照。该兼容标记不参与已有任务身份。
- 现有参数说明补充duration的秒数语义；自定义视频现有图片行显示能够确定的Picture编号。没有新增按钮。

## 6. 本轮实际核对

执行了一次纯本地请求绑定观察，无网络请求、无模型生成：

```text
输入：本附件 + 2 个本地诊断图片名
已映射图片槽：6
绑定后 H3 仍连接图片：6
其余4槽默认值：全部保持原值
自动导入的 duration 映射：缺失
```

已读取源码、附件图结构，并核对官方对应版本的H3输入定义。没有进行全量回归、界面验收或客户ComfyUI实机生成。

实施后的五个定向脚本一次集中执行全部通过：秒数识别及有效映射、15组图片/音频省略边界、真实任务引擎的模拟上传提交和旧任务恢复、8组H3图片顺序、画布导入。记录为 `output/diagnostics/comfy-video-4.7.1/focused-checks.json`。没有新增产品运行时检查或真实模型请求。

修复后的同一附件纯本地观察：

```text
自动识别：duration → 259.value
时长覆盖：10秒写入259，250公式与265.length连线保持
选图物理槽：[4,1]（零基）
请求只保留：ref_image_1、ref_image_4
剩余LoadImage：49、19
对应上传顺序的Picture编号：[2,1]
原附件未改写；未发出模型请求
```

## 官方原始来源

- [S1] ComfyUI v0.45.0，`comfy_extras/nodes_minimax_h3.py`：24fps、帧数对齐、ReferenceToVideo的Autogrow可选输入与执行。
  `https://raw.githubusercontent.com/Comfy-Org/ComfyUI/v0.45.0/comfy_extras/nodes_minimax_h3.py`
- [S2] ComfyUI，`nodes.py`，`LoadImage.INPUT_TYPES` 与 `LoadImage.VALIDATE_INPUTS`。
  `https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/nodes.py`
- [S3] ComfyUI，`comfy_api/latest/_io.py`，Autogrow与DynamicCombo的输入结构定义。两者不能混为一种数量选择机制。
  `https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/comfy_api/latest/_io.py`
- [S4] ComfyUI v0.45.0，`comfy_extras/nodes_audio.py`，LoadAudio的文件读取与路径检查。
  `https://raw.githubusercontent.com/Comfy-Org/ComfyUI/v0.45.0/comfy_extras/nodes_audio.py`
