# 28×28 视觉风格库设计

## 目标

把导演台“视觉风格”扩充为 28 个内置选项，并为每个选项提供一对一的风格预设。视觉风格负责色彩、材质、纹理、光影和氛围锚点；风格预设负责镜头、灯光与声音规则。用户改变视觉风格时自动选中匹配预设，之后仍可手动覆盖预设。

## 风格目录

| ID | 名称 | 分类 | 匹配预设 ID |
|---|---|---|---|
| cinematic_realism | 电影写实 | 写实 | style_cinema |
| documentary | 纪录片 | 写实 | style_documentary |
| korean_portrait | 韩式偶像 | 写实 | style_korean_portrait |
| vintage_film | 复古胶片 | 写实 | style_vintage_film |
| black_cinema | 黑色电影 | 写实 | style_black_cinema |
| short_drama | 短剧质感 | 写实 | style_short_drama |
| korean_mood | 韩系氛围 | 写实 | style_korean_mood |
| raw_camera | 毛边美学 | 艺术 | style_raw_camera |
| sports_event | 赛事体育 | 写实 | style_sports_event |
| republic_vintage | 民国复古 | 国风 | style_republic_vintage |
| anime_movie | 动画电影 | 动画 | style_anime_movie |
| ink_fantasy | 水墨幻想 | 国风 | style_ink_fantasy |
| dream_surreal | 梦境超现实 | 幻想 | style_dream_surreal |
| no_style | 无附加风格 | 中性 | style_neutral |
| post_apocalyptic_wasteland | 末日废土 | 科幻 | style_post_apocalyptic_wasteland |
| cyberpunk_night | 赛博朋克夜城 | 科幻 | style_cyberpunk_night |
| hard_scifi_space | 硬科幻太空 | 科幻 | style_hard_scifi_space |
| biopunk | 生物科幻 | 科幻 | style_biopunk |
| dieselpunk | 柴油朋克 | 科幻 | style_dieselpunk |
| kaiju_disaster | 巨兽灾难 | 灾难 | style_kaiju_disaster |
| wuxia | 国风武侠 | 国风 | style_wuxia |
| oriental_myth | 东方神话 | 国风 | style_oriental_myth |
| xianxia_cloud | 仙侠云境 | 国风 | style_xianxia_cloud |
| dark_fantasy | 黑暗奇幻 | 幻想 | style_dark_fantasy |
| refined_3d | 精致3D动画 | 动画 | style_3d |
| stop_motion_clay | 定格黏土 | 动画 | style_stop_motion_clay |
| suspense_thriller | 悬疑惊悚 | 悬疑 | style_suspense |
| gothic_horror | 哥特恐怖 | 恐怖 | style_gothic_horror |

## 架构

新增 `src/visualStyles.ts` 作为唯一目录源，导出目录、按名称解析、提示词锚点解析、匹配预设 ID 和内置预设构造器。`App.tsx` 不再维护重复数组；`storage.ts` 从目录生成默认预设；`promptEngine.ts` 将名称解析成具体锚点后写入每个镜头。

每个定义包含 `id/name/category/promptAnchor/stylePresetId/preset`。除“无附加风格”外，`promptAnchor` 必须明确色彩、材质、光影、氛围和质感。每个 `preset` 必须包含非空的 `visual/camera/lighting/sound`。

## 交互与数据流

1. 用户改变视觉风格。
2. UI 保存风格名称，并查找一对一 `stylePresetId`。
3. 若该预设存在于当前状态，自动切换并提示“已自动匹配风格预设”；若用户曾删除预设，则保留当前预设并给出可操作提示。
4. 用户随后手动选择其他预设时，只改变预设，不反向改动视觉风格。
5. 加载旧项目时不主动联动，避免改写历史导演参数；只有新的用户选择触发联动。
6. 最终逐镜提示词写入完整风格锚点。动画、幻想等风格不再被统一追加“极致真实感”；未知旧风格使用兼容性文本回退。

## 迁移与兼容

状态 schema 从 7 升到 8。新安装默认包含 28 个预设。schema 7 及更早状态只补入本版本新增的 24 个预设 ID，保留四个旧内置预设的用户修改或删除状态，也保留所有自定义预设。schema 8 中用户明确删除的预设不在普通加载时复活。迁移必须幂等。

现有 14 个视觉风格名称与所有旧预设 ID 保持不变。旧 Storyboard、导演确认指纹和已生成提示词不会因启动迁移被批量重写。

## 验收

- 目录恰好 28 项，ID、名称和预设 ID 均唯一且一对一。
- “末日废土”锚点包含灰橙低饱和、锈蚀金属、风沙尘雾、破败混凝土、硬质逆光和空旷压迫感。
- 下拉框显示全部 28 项；选择任意项可自动切换同名预设，随后可手动覆盖。
- 28 个预设在规则中心可编辑、复制、导入、导出。
- schema 7 迁移补齐新增预设且不覆盖用户内容；二次迁移结果完全相同。
- 动画风格提示词不包含强制真实感，末日废土提示词包含具体锚点。
- 单元测试、构建、长剧情 UI、桌面 QA 和实际打包 EXE 冒烟通过。

## 版本

功能包版本递增为 0.5.15，生成独立便携 EXE、恢复源码、更新说明和 SHA-256 清单，保留 0.5.14 旧包。
