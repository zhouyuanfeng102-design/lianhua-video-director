import { SPOKEN_CUE_CONTENT_RULE, STORY_SPOKEN_CONTENT_RULE } from './videoInteractionRules';

export { H3_EXISTING_SOUND_SUMMARY_ZH, H3_EXISTING_SOUND_SUMMARY_EN } from './h3DeliverySections';

/** Shared generation rule; this changes sound design, never sampler settings. */
export const DIALOGUE_LANGUAGE_RULE = '提示词的描述语言不等于人物说话的语言。已有对白保留原字、原语言、原说话人和原顺序；原中文对白不能因为界面选择 English、模型使用英文提示词或要求英文描述就改成英语。原文明确要求某句用英语说、英文对白或其他语种时，必须在该句台词或音效对白的说话人旁紧邻保留语种标注（如“对白语言：英语”），不能丢成没有语种依据的普通台词。未明确要求英文对白时不得擅自改为英文，人物姓名和代号也不作意译。';

/** Exact saved V1.8.9 source rule for request-time removal, never migration. */
export const LEGACY_DIALOGUE_VOICE_IDENTITY_RULE_V1_8_9 = '把稳定声音身份与本句情绪表演分开：有明确依据的音色、基本音高范围及特殊声线属于同一人物的声音身份；慌乱、愤怒、用力、低语、喊叫或战斗移动只改变该句已有的语速、音量、停顿与发话气息，不自动换成另一人的音色或另一性别的声音。在每句已有对白紧邻的正文中用完整姓名、当前声源ID（仅格式已有时）和简短的已确认声线绑定该句，不能只靠开场人物定义或(Sn)让后镜自行继承；没有具体声线时仍保持已知人物身份与说话人，不补造音高、音色或新增人声。跨镜与跨段按同一完整姓名承接本次可用原稿、人物设定或上段最终稿中的已确认声线；不同独立视频段的S编号可按本段声源顺序变化，编号变化不等于换声线，也不把另一段同号人物的声音套来。用户或原剧情已确认的特殊声线优先，人物生理性别、外表、形态、名字及模型知道的原作设定都不能自动覆盖声音身份；只有当前原剧情或用户明确要求变声时才按其范围改变。保持项目已知身份与相应性别代词，不凭名字、参考图外貌或原作知识补造未知性别与声线。声线说明属于描述，不是新增台词、呼吸声或配音介绍。翻译、参考更新、衔接与纯格式修复只保留已有确认内容及本次有权改写的范围，不借本规则给旧稿新增声线或重新配音。';

/** Source-grounded voice planning; no voice inference, cloning or audio checks. */
export const DIALOGUE_VOICE_IDENTITY_RULE = [
  '新生成或获准重做声音时（voiceFactScope=source-grounded-new-draft），先区分声音事实的确认来源与候选描述：本次用户明确要求、当前原剧情明确的声线或变声安排优先，其次承接项目资料或上段中有确认依据的稳定声音设定；没有特殊声线依据时保持项目已知人物身份。characterContinuity、characterIdentityFacts及当前原剧情提供普通身份事实，已保存audioLedgerFacts仅在确有声线备注时提供对应声音依据；其中的姓名、性别、个性或动作不授权补造具体音色、音高。候选分镜、canonicalPrompt、candidatePrompt或旧shots里模型自行补写的音色、音高、少年音、男声或女声，不因进入候选稿就成为已确认声音事实；与当前原剧情或已知人物身份冲突时，在本次获准生成范围内按确认来源表达，不把候选自己作为证据。',
  '把稳定声音身份与本句情绪表演分开：有明确依据的音色、基本音高范围及特殊声线属于同一人物的声音身份；慌乱、愤怒、用力、低语、喊叫或战斗移动只改变该句已有的语速、音量、停顿与发话气息，不自动换成另一人的音色或另一性别的声音。低声、怯声、柔声、结巴或用力不是男声、少年音或另一声音身份的依据。',
  '在每句已有对白紧邻的正文中用完整姓名、当前声源ID（仅格式已有时）和已知人物发声身份绑定该句；仅有确认依据时附上简短声线，不能为满足“声音身份”字段而编造具体音色或音高，也不能只靠开场人物定义或(Sn)让后镜自行继承。没有已确认特殊声线时，项目已知女性保持女性发声身份，已知男性保持男性发声身份，特殊或未知身份按已知事实原样保留；不凭名字、装束、参考图外貌或原作知识改成相反性别，不把女性、纤细或怯懦自动写成少年音或男童音。没有具体声线时仍保持已知人物身份与说话人，不补造音高、音色或新增人声。',
  '新生成的中文执行稿与H3人物身份定义须简短保留项目已知性别；每句对白紧邻的发声身份与之对应，选择外观细节时不能省掉该事实，不能只把性别藏在远处的资料或globalLock中。用户或原剧情已确认的特殊声线优先，人物生理性别、外表、形态、名字及模型知道的原作设定都不能自动覆盖声音身份；只有当前原剧情或用户明确要求变声时才按其范围改变。保持项目已知身份与相应性别代词，不凭名字、参考图外貌或原作知识补造未知性别与声线。',
  '跨镜与跨段按同一完整姓名承接本次可用原稿、人物设定或上段最终稿中的已确认声线；不同独立视频段的S编号可按本段声源顺序变化，编号变化不等于换声线，也不把另一段同号人物的声音套来。声线说明属于描述，不是新增台词、呼吸声或配音介绍。',
  'characterIdentityFacts或characterContinuity中的voiceProfile是项目已确认的独立声音档案：perceivedAge为听感声龄，timbre为音色，language/accent为语言与口音，style为稳定说话习惯，notes为补充；它们不是本句情绪。本次用户明确声音要求、原剧情明确的特殊声线或变声安排优先，其次保持已确认声音档案、样音职责和有来源的声音备注。referenceAssetId只记录样音身份，不证明本次已上传或接口支持音频；只有本次实际传入的音频证据才可声明使用该样音。声音年龄独立于apparentAge外观年龄与actualAge实际年龄，用户确认的特殊声龄不能被外貌或长寿设定覆盖。',
  'currentCharacterVoiceFacts是同ID人物当前声音档案的显式更新，只覆盖声音，不替换冻结人物姓名、年龄、外貌和剧情。仅在source-grounded-new-draft范围内优先于冻结voiceProfile采用该当前档案；voiceProfile=null只表示当前没有确认的声音档案，不是静音或抹除原稿声音的指令。preserve-confirmed-source、翻译、参考更新、衔接与冻结任务重试仍保真sourcePrompt中的既定声音，不能用新档案或null清掉、重选或补写旧稿声线。',
  '仅voiceFactScope=source-grounded-new-draft且没有已确认声龄或特殊声线时，允许结合已知性别、明确叙事年龄与当前角色生命阶段做年龄相称的临时选角，例如青年女性自然发声；临时选角是本次新稿的表演安排，不冒充用户确认事实，不回写成声音档案。外观年龄和实际年龄都必须完整阅读，不能把实际数百岁的长寿、修仙或非人角色直接配成老年声，也不能仅因年轻外貌自动配成娃娃音。只有外观年龄或年龄阶段有冲突时，不擅自认定精确声龄，保持已知身份与自然发声。未知声线不编造固定音高、Hz、娃娃音、磁性或沙哑等特殊音色。',
  '轻声、低声、冷酷、强硬、威严、支配、慌乱和愤怒只约束本句情绪、音量、节奏、停顿及力度，不自动增加听感年龄、压低基础声区、加厚胸腔共鸣或换成成熟嗓音；同一角色跨句跨镜保持原有声龄和音色。新稿将有依据的简短声龄、音色与完整姓名紧邻每句台词，情绪表演另行表达；H3写在对应镜头正文的<d>之外，Seedance写在连续时间轴的台词引号之外，不能只放开场档案。voiceProfile、voiceFactScope、字段键、来源标记和临时选角的内部状态只用于理解，不输出成新章节、技术字段或可朗读台词。',
  '上述按确认来源建立发声身份的要求只用于新生成或本次明确获准重做声音的范围。voiceFactScope=preserve-confirmed-source时，翻译、参考更新、衔接与纯格式修复只保留已有确认内容及本次有权改写的范围，不把已确认sourcePrompt降为候选稿，不借新规则给旧稿新增性别、声线或重新配音；源稿缺少声音身份时保留原表达，不依据资料重新导演。没有voiceFactScope时仍以本次明确操作权限为准，格式修复或翻译不能被当成重新建立声音事实的授权。',
].join('');

/** Translation never re-casts from a newer project dossier. */
export const VOICE_PROFILE_TRANSLATION_PRESERVATION_RULE = '逐句保留sourcePrompt已经写明的听感声龄、音色、语言口音及稳定说话习惯，并与当前句情绪和音量分开；低声或强硬不能被译成更成熟、更低沉的声音。只翻译原稿已有声音描述，不从新voiceProfile、外观年龄、实际年龄或样音备注重新选角，也不补写未知的音高或娃娃音。不输出voiceProfile、voiceFactScope等内部技术字段，不新增声音章节或把声音描述放进台词引号/<d>内。';

/** Translation keeps the confirmed voice plan; unknown pronouns stay named. */
export const DIALOGUE_VOICE_IDENTITY_TRANSLATION_RULE = '英译仅保真sourcePrompt已确认的声音身份与人物指代：每句附近已有的完整姓名、声源ID、音色、基本音高范围、特殊声线和情绪表演关系逐项保留，不把慌乱、低语、喊叫、用力或移动译成换音色，不因人物生理性别或外表重选声音。源稿已明确的身份、性别及代词指向保持一致；源稿的女性身份与女性发声身份不能因罗马化姓名、模型知道的原作或“低声/怯声”被译成he/his、male voice或boyish timbre，已确认的特殊声线仍按源稿保留。原稿依据不足时重复原完整姓名，避免猜写he/his或she/her，不凭名字、原作常识、参考图或上下文资料补造原稿未确认的性别与声线。不同视频段的S编号可能不同，只保留本段映射和源稿已确认的同名人物声线承接，不重新编号或按同号跨段套声音。源稿没有具体声线时只忠实保留已有身份、台词和表演，不新增音色、音高、声源、声音说明或新的可发声内容，也不借翻译给旧稿重新配音。';

export const NATURAL_ACTION_AUDIO_RULE = [
  '动作音效按镜头距离、动作力度、声源距离和叙事重要性自然呈现，不为每个小动作配声，不要求每个真实接触都单列音效。只为实际可听且必要的脚步、碰撞等关键事件配声，按原时序用相对本镜开始的“第Xs”绑定实际动作时刻；必要脚步和碰撞不能因无配乐或背景近静音一律删除，普通抬头、转身、注视、轻扶或姿势变化不自动添加衣料摩擦、衣物破风或呼吸声。',
  '新生成或明确获准重做声音时，逐项依据当前时段实际发生的动作或发声、对应人物或声源、实际接触的双方表面及材质、力度与时刻决定拟音；视觉身份、题材、道具存在和参考图内容本身不是声源。空手拳、掌、踢、擒抱、闪避与步法只按本镜真实的身体、衣物、鞋底和地面接触发声，不能仅因武侠或剑客题材、画面中静置或携带的兵器、人物持剑参考图而补刀剑出鞘、碰刃或金属撞击。拿起、携带或查看一件兵器不等于兵器相撞；没有实际碰撞就不写碰刃声，只有剧情中兵器确实出鞘、碰刃、撞击金属或硬物，或金属部件实际相碰时，才按具体接触材质、力度与时刻写相应声音，不机械禁用有真实依据的金属拟音。',
  '亲吻不强制每次都有独立音效：中景轻吻可以非常轻、甚至几乎听不见，也可以不单列吻声；近景同样服从实际力度，不突出“啵”、夸张唇部弹响或贴麦口部声，不渲染成 ASMR。只有原剧情明确要求可听吻声或本镜确有必要时，才以符合距离的自然短促轻触声同步接触，不能把“轻吻”自动升级为响亮吻声。未发生、只是靠近、想吻或差点吻不能加吻声。不自动添加持续呼吸、ASMR或摩擦声；没有画面动作就不补对应动作音。',
  '私密身体对身体的接触不归入碰撞：双方是皮肤或湿润组织时，写成持续的、很轻的、贴在耳边的湿滑黏连，没有房间敲击回响，停在压低喘息和台词下面，跟一直贴着的缓慢、小幅度、温柔的连续起伏连在一起。已经进入后的这串起伏保持缓慢，画面上没有一下一下的撞击。离开或分开只写一次很轻的湿声分离。抽送带动的桌面或床铺晃动不配声音，包括闷闷声响和轻震。打斗、落地、敲门、家具被直接击打和兵器相撞仍按实际碰撞保留。',
  '每一种声音只跟真正发出它的那一下写在一起。拂叶、拨衣、落叶离桌只写衣料和干叶的细碎摩擦，不配硬落地，不配铃。铜铃、风铃、门环、耳环、杯盏和金属饰只有原文写明它自己响的那一下才出声，写成远处、闷、短，单独成句，不跟扫、碰、走、坐绑在同一句，也不写进全程声景。普通走路、迈过门槛、沿走廊走写成很轻的鞋底声，贴着该地面材质，短，停在对白和呼吸下面。英文写成 soft footsteps of the sole on the wooden floor, quiet and under the lowered voices。不用 pressing、heavy、thudding，也不写成鼓点。脚步和敲门、拍桌、兵器相撞、东西真正落地分开写。后者仍按那一下真实撞击保留。原文写了跑、跺脚或摔倒，才把这一下写重，并写明是哪一下。整段声景只说脚步随对应镜头出现和结束，不在声景里再加力度词。',
].join('');

/** Source and temporal scope are model-owned planning decisions. This rule
 * adds no local audio detector, semantic gate or post-generation processing. */
export const DIEGETIC_AUDIO_SCOPE_RULE = [
  '先按完整原剧情区分可见环境、明确可听的有源事件和有剧情理由的跨镜声床：看见风吹衣摆、水面、瀑布、雨景或烟雾，只是视觉事实，不自动意味着要生成风声、水声或持续环境声；原文明写听见、传来或实际可听的动作声，则保留该声源及叙事作用，不能一刀切删成无声。声源存在、一直可见、发生在同一地点，都不等于声音必须从本段0秒持续到结束。为每个必要声源根据剧情安排进入、可听范围和退出，保持远近、遮挡、镜头听觉距离及对白与关键动作的前后层级；原文没有给精确时刻时由AI结合相应事件安排，不在本地推算，也不把所有真实声音强制缩成短音。比如“远处传来瀑布坠落声”保留远处传来的听觉事件，只在本段实际听到它的事件时段呈现，不能改成整段持续的瀑布轰鸣、低频水声或循环环境铺底；未提供的声音时长不能仅凭瀑布存在推成全程。只有原文或当前连续事件的听觉关系确实支持跨镜持续，才设计跨镜声床，并明确其适用范围及进入、离开或距离变化的依据，不能把短暂听到或后段才出现的声音提前铺满全段。“轻微、低响、柔和、远处”只约束听感，不是持续时间授权，不能用压低音量来合理化多出来的持续背景声。',
  '同一声源只安排一次：镜内事件留在对应镜头，不再在overall_soundscape中变成第二条全局铺底；确有跨镜声床时全局只概括同一声源，镜内只描述必要的变化，不另起一层、不因切镜重启或叠加。overall_soundscape只写整段简短的全局声学概括，包括有依据的持续声床、整体安静程度，以及局部同期声按镜头发生和结束的总体关系；它不是一次性事件清单或第二条音效轨。只在一个Shot发生的脚步、碰撞、拾取、出鞘等一次性声音，及其具体动作、器物、材质和时刻，只留在对应镜内；overall_soundscape不得按镜头顺序复述、列举或换词转述这些局部声音，也不得把后段事件抬成整段声景。无持续底噪但有局部动作声时，只概括“间隙安静，动作声均随对应镜头同步起止”这类全局关系，不写具体动作、道具、材质或时间，不添加新声源或延长原声。只有用户明确要求全片完全静音时overall_soundscape才写N/A；对白、局部环境声与动作声的具体内容和时刻仍保留在对应镜内，不复述台词。non_diegetic_music的无配乐规则独立保持。',
].join('');

/** Relative listening intent for the text/video model, not an audio API gain
 * setting or a measured-loudness guarantee. This never changes sampler or
 * transport parameters and never post-processes the completed mixed track. */
export const NATURAL_BACKGROUND_MUSIC_RULE = '本产品默认只交付剧情内实际发生的声音：对白、明确可听的环境声和动作声。非叙事背景音乐（BGM/score）不是默认声层；场景名称、天气、情绪、风格预设、普通走动或“戏剧节点”都不能授权你自行补BGM。新生成或主动重新生成时，只有用户在本次请求中明确要求非叙事配乐，才可写入non_diegetic_music；没有授权且没有需要保真的已确认配乐安排时固定写N/A。无配乐由末尾唯一的non_diegetic_music字段表达，不向每个镜头重复追加禁乐口号。本次只调整动作、格式、翻译、参考图或上下段衔接等已有稿内容时，保留已经确认的配乐安排；新稿的默认无配乐不能覆盖历史已确认音乐，也不从旧候选稿或预设自行认定配乐已获授权。获得明确授权时按已有意图安排配器、强弱、进退与适用范围；未另行指定强度时采用简洁、柔和、极低存在感，远离前景并让位于对白和关键动作声，不压低对白或整条音轨迁就配乐；该相对听感不是API音量参数或实际测量结果。切镜不突然重启或增响，不靠增大音量制造衔接，避免强鼓点、夸张低频、戏剧性渐强及忽大忽小。场景内有声源依据的演奏、收音机或人物哼唱属于剧情内声音，留在相应环境/动作/对白字段，不要误放入non_diegetic_music。';

/** Names and reference labels are visual facts, not a script to perform.
 * These are shared model instructions only; no local name filtering occurs. */
export const VISUAL_IDENTITY_SPEECH_SCOPE_RULE = '视觉身份与可发声文本必须分开：人物姓名、资料、角色/形态名称、参考图名称、图片槽位、身份映射及参考职责都是视觉定位资料，不是台词，不可把它们朗读、点名、唱出或改成旁白介绍。可辨词句只来自当前段原剧情明确的原话、明确说话人和话题的转述自然化结果，或用户本次明确授权新增的对白；资料中出现名字、镜头动作中提到名字，都不能授权人物喊出这些名字。保留资料与画面描述中的完整姓名和对应关系，不靠删除、改名或占位符避开问题。若原剧情的真实台词本来就在呼喊姓名，仍逐字保留该句、原说话人和时刻；禁止的是把视觉资料变成新增发声内容，不是禁止原有呼名台词。';

/** No dialogue is a timed performance constraint, not a request to mute
 * authored effects or freeze natural expressions and mouth movements. */
export const NO_DIALOGUE_PERFORMANCE_RULE = '无对白必须成为实际交付正文中的全时段表演约束，不能只写一个容易被忽略的“台词：无/Dialogue: none”：某镜无对白时，从该镜起点到镜尾都不说话；整段无对白时，从0秒到该段结束（包括最后几秒）都不说话，不新增喊名、含混交谈、耳语、旁白或说话口型，不能在片尾自行补一句。逐镜以具名人物和真实行为正向表达沉默：他/她正在看向谁、观察什么、怎样继续防守/躲闪/移动或倾听，在自己的真实发话区间之外保持非说话状态，不把可见正脸、停顿、思考、用力或镜头推近当成开始发话的提示。原文没有该人物台词时，不借情绪、战斗、技能动作或音频参考的音色补可辨词句、拟造外语、持续低语或含混交谈；也不让此人替另一人的台词做口型。沉默人的注意与动作仍随当前事件推进，不写成面向观众等待开口，不强迫全程闭嘴僵住或固定表情。原文明确说话人和话题、但没有逐字原句时，获准生成阶段由该说话人只用已确认事实整理出自然完整的一句，不把摘要当台词；只有发声动作没有具体话题或原句时才不新增可辨词句。听者只倾听、反应或行动，不能代说。补全不另加数字、新人、新情节。已有引号的句子原字不动。动作里不再把这句台词再说一遍。接着说下去而没有新句子时，停在已经补上的句子，不再另写一层说话。笑、摆手、走路仍留在动作里。原文自己写明听不清时才保留听不清，而且不张嘴念音节。无对白不等于整轨静音：保留原剧情明确的笑声、咳嗽、哭泣等非语言声及必要动作声，不自行补声；没有说话口型不等于嘴唇永久闭合或表情冻结，仍保留剧情合理的微笑、亲吻、进食等非说话动作。无对白约束只覆盖原定无对白区间，不删其它镜头或其它时刻的真实台词。不写不可辨低声、不构成可辨台词、含混交谈、耳语填空来代替已经写明的话。同一时刻只让一个人口中有词，并给每句留出说完的时间。';

/** Model-authored staging, not a local duration formula, speech detector or
 * acceptance gate. Planning may allocate time; translation cannot re-plan. */
export const DIALOGUE_PERFORMANCE_TIMING_RULE = '新剧情规划及本次明确获准的动作重排阶段，先让对白和动作组成唯一的可执行时序：每句先明确完整姓名、原话、开始至结束的发话区间以及与前后动作的先后关系，整句须完整落在该区间内，不能只有起点而让占用范围含糊不清。发话区间须容纳当前语种、语气、停顿和真实动作，由AI结合剧情判断，不用固定字数公式或加速朗读硬塞；不能把长句堆到最后几秒再宣称自然。换人发话时明确上一句何时结束、下一句何时开始，并给自然的听取或交接留出空间；仅原剧情明确抢话、重叠或齐声时才保留重叠关系。画内口部动作与有声口型不能互相冲突：例如亲吻应靠近、接触、离开后再开口，不写同一人物亲吻接触期间“同时口型清晰地说”；进食、咬住物体等按实际能否发音安排，原文明确的心声、旁白或另一声源仍保持原性质，不强改成口播。走路、手势等可合理与讲话并行，不能一刀切把所有动作串行。说话权交接以具名人物为单位；镜头主体、被称呼者、人物自身左右和参考图顺序都不能替代发话者身份；非说话者不做该句口型，但允许原剧情的自然表情与非说话动作。人物身份和镜头概述只交代静态信息；同一次剧情动作只在时间执行段写一次，不先在人物介绍里完整演完，再在时间点重演。规划阶段先为完整发话、停顿、必要动作和交接留时间，再决定镜头；已确认的转换、翻译或参考绑定阶段只保真既定区间和先后关系，不擅自改变镜界、片长、对白归属或搬运相邻段台词。旧确认稿若仅给发话起点，翻译、参考绑定和纯格式修复保持原时间表达，不借本规则补造结束时间、重新排程或改写原有动作关系；这些阶段只修复本轮操作造成的遗漏与歧义。';

/** Dialogue is authored story data, not a sound-effect summary.  Keep this
 * contract separate so every text-model entry point can carry it without
 * changing the H3 transport shape or adding a local semantic gate. */
export const DIALOGUE_DELIVERY_RULE = `对白交付必须以完整原剧情为准：先理解原文真实发声内容，再逐句保留原话、原语言、原说话人和原顺序，不能把“催促声/回应声/女性声音”等概括改成模型自行编写的台词。${STORY_SPOKEN_CONTENT_RULE}${SPOKEN_CUE_CONTENT_RULE}每句对白只能归属一个明确说话人（原稿明确齐声时保留其具名声源集合）；该句期间只有对应说话人发声或做对应口型，其他人物只按剧情安排倾听、反应或行动，明确听者不能代说。明确画内、背影、画外、通信或心灵声源；人物不在画面中也不得换成当前主体代说。引号内和明确逐字原话逐字保留；有明确说话人和话题但仅为转述时，在获准生成阶段整理成自然完整台词，不能机械复制话题摘要，也不能增加新事实。只有原文没有原句且发声动作后也没有具体话题时，才不新增旁白、画外解释、拟声词或即兴台词。原定无对白区间写“台词：无”或等价无对白指令。补上的句子仍标明唯一说话人。${DIALOGUE_PERFORMANCE_TIMING_RULE}${VISUAL_IDENTITY_SPEECH_SCOPE_RULE}${NO_DIALOGUE_PERFORMANCE_RULE}保持原语种，不因 English 提示词翻译中文对白，不把台词改写成音效摘要。由AI在交付前自行核对说话人、台词、语种、顺序、时间和口型并修复，不能依赖本地关键词拦截。`;

/** Final text-model delivery, not an extra section or local semantic gate. */
export const AUDIO_H3_DELIVERY_RULE = [
  '声音要求必须落实在本次实际交付的正文，不能只留在分析或审核说明里。新生成或主动重新生成时默认仅保留剧情内对白、明确环境声和动作声：没有本次明确配乐授权或需保真的已确认配乐安排时non_diegetic_music固定写N/A，不自动补背景音乐；无配乐只在末尾唯一字段表达，不逐镜堆叠同一句。不要因为场景、天气、情绪、风格或普通动作自行选择BGM。只有用户在本次请求中明确要求非叙事配乐，才在non_diegetic_music中按该要求写具体音乐与适用范围；未指定强度时保持极低存在感，并让位于对白与关键动作声。若本次明确是格式修复、参考图更新或上下段衔接修复，或只调整已有稿动作而未获准改动声音，保留已有确认的配乐选择、声源、音量与进退安排，不重新配乐。',
  '新稿的局部拟音必须写在实际事件对应的[Shot N]内，以当前动作或发声对象、真实接触双方的材质、力度和本段时刻为依据。武侠或剑客题材、人物视觉身份、静置或携带的兵器、人物持剑参考图都不能单独授权出鞘、碰刃或金属撞击；拿起、携带或查看一件兵器也不等于两件兵器相撞。真实发生的兵器出鞘、碰刃、金属部件互碰或兵器撞击硬物仍按实际接触保留，不能机械删除金属声。',
  'H3字段职责必须分开：overall_soundscape只写整段简短的全局声学概括，包括有依据的持续声床、整体安静程度，以及局部同期声按对应镜头发生和结束的总体关系；它不是一次性事件清单或第二条音效轨。只有用户明确要求全片完全静音才写N/A。只在某镜或本段后半程发生的脚步、碰撞、拾取、出鞘等局部声音，及其具体动作、器物、材质和时刻，只留在对应镜内；不得在overall_soundscape中按镜头顺序复述、列举或换词转述，不得把后段事件提升为全程背景。没有持续底噪但有局部SFX时，只概括间隙安静、这些同期声随对应镜头发生和结束，不写具体一次性事件。跨镜声床的全局摘要与镜内变化指向同一声音，不是两层叠加。局部环境声的出现、结束和听觉距离保留在对应镜内，“远处、轻微、低响”不能替代时段与范围；有依据的瀑布、风雨等声音保留原时段；没有持续声床不等于全片静音。',
  `具体对白、唯一说话人、声源编号、逐镜无对白、咳嗽/动作声的镜内时刻、口型与听者、逐镜禁止项全部写在对应[Shot N]的integrated_multimodal_description或full-reference的detailed_description中，不能搬进overall_soundscape。不得在overall_soundscape中列Shot编号、对白复述、声源分配、镜内时序、具体器物材质或长篇否定清单。不得新增negative_prompt、negative、反向提示词或其它声音section；non_diegetic_music在没有本次明确授权且没有需保真的已确认音乐时写N/A；这两个字段是提示词语义，不是API硬性禁乐或静音开关。引号内和明确逐字原话逐字保留；有明确说话人和话题的转述在获准生成阶段整理成自然完整的一句；话题摘要不能机械当成台词，不能增加新事实。动作、画面、人物资料、声音说明与整体声景中的文字都不是台词，不能朗读或改成旁白；${SPOKEN_CUE_CONTENT_RULE}只有没有具体话题或原句时才不创造可辨词句；明确听者只倾听、反应或行动，不能代说。“催促声/回应声”不能代替原台词，原定无对白区间保持全程无对白，不让视频模型即兴编词，非词汇笑声、哭声、咳嗽等也不能扩成可辨词句。audioMode为none时保持无音轨设计，不添加音乐、对白声或动作声。保持原有H3字段名称与顺序、对白及说话人，镜数与切点保持已确认排程；仅本次指令明确授权taskAuthority=current-segment-staging-replan时，镜数与切点以同时交付的修正canonicalPrompt为准，用户固定段长与exact镜数仍不变。不增加混音章节、增益参数或规则清单；普通六字段输出仍用原音效字段，不改成H3。`,
].join('');

/** Translation, including its format-only retry, preserves the Chinese mix. */
export const AUDIO_TRANSLATION_SCOPE_RULE = '声音翻译与其格式修复以已确认的sourcePrompt为准：完整保留已确认的音乐选择或N/A、适用镜头、进退时机、对白让位、无对白不抬升及不自动补乐安排。环境声和动作声也必须保留原有出现与结束时段、相对本镜或本段的时间坐标、远近与遮挡、前景或背景层级；不把局部事件改成贯穿全段的continuous/throughout ambience，不把distant/soft/faint误写成持续授权，不把镜内声音提升或重复到overall_soundscape，不因切镜新增重启或叠加。同一已确认跨镜声源保持原范围，不能一刀切删掉或改短；原稿没有给出的起止时间也不能在翻译时擅自补造。翻译和格式化只保留源稿中每项声音已有的动作因果、发声对象、接触材质、时刻及字段作用域，不因题材、视觉身份、道具或参考图重新推导拟音，不把局部声音改写成全局概括中的事件清单，也不依据新稿规则重新导演已确认声音。源稿是普通走路、迈过门槛或沿走廊走、又没有写跑、跺脚或摔倒时，英译写成 soft footsteps of the sole on that floor, quiet and under the lowered voices。不用 pressing、heavy、thudding。跑、跺脚、摔倒和敲门、拍桌、兵器仍按源稿的那一下撞击翻译。不能把“无配乐”改成有配乐或把安静背景改成整轨静音；N/A原样保留，不新增音乐或声源、不重选配器、不借新声音规则重写旧稿的混音方案。逐句保留原对白、原语言、唯一说话人、顺序、声源和口型安排；中文对白原字保留，不在英文稿中翻译台词。H3字段、切点和原语言对白保持不变。';

/** Existing-prompt refresh scope: preserve the authored sound plan while the
 * model reviews only the requested non-audio change. */
export const AUDIO_EXISTING_SCOPE_RULE = '本次操作只更新已有提示词中明确要求的非声音内容；声音以已确认稿为准，保留原有配乐选择或N/A、适用镜头、进退时机、对白让位、无对白不抬升和不自动补乐安排。环境声与动作声的原有动作因果、发声对象、接触材质、起止、镜内或跨镜范围、听觉距离和层级同样保留，不延长局部声音、不提前引入后段声源、不在镜内与overall_soundscape新增重复铺底；没有原始时刻就不补造。不因题材、视觉身份、道具或参考图重新推导拟音，也不把局部声音移入overall_soundscape或反向移回镜内。不得重新选配器、添加或删除音乐/声源，也不得把已确认的N/A改成配乐；H3字段、切点、逐字对白与唯一说话人保持不变。';

/**
 * Music is an explicitly authorized non-diegetic layer, not a blanket
 * ambience bed.  Keep this rule shared by storyboard planning, conversion and
 * repair prompts so every entry point has the same default-no-BGM contract.
 */
export const STORY_DRIVEN_MUSIC_RULE = `剧情情绪转折、危险、追逐、回忆、亲密关系、胜利收束、场景名称、天气、普通走动和风格预设都不是自动添加非叙事BGM的依据。新生成或主动重新生成时默认只保留剧情内实际声源；只有用户在本次请求中明确要求非叙事配乐，AI才可写入non_diegetic_music，没有授权且没有需保真的已确认配乐时写N/A。翻译、格式修复、参考图更新、上下段衔接或仅调整动作时，保留已有确认稿的音乐，不用新稿默认覆盖历史确认的配乐。用户明确“无/不要/禁止配乐”始终优先。${NATURAL_BACKGROUND_MUSIC_RULE}`;

export const AUDIO_PROMPT_RULE = `环境层只写本镜有实际声源依据且叙事必要的声音；未指定时写“无”，仅无事件的背景近静音，不是整条音轨静音。不要因林地、室内、雨景或无配乐自动补连续底噪、房间底声、嘶声、白噪声，也不要用持续、低响或渐强的谷风、环境风、灵泉、溪流等环境声填满镜头及全局声景。${DIEGETIC_AUDIO_SCOPE_RULE}${NATURAL_ACTION_AUDIO_RULE}${DIALOGUE_DELIVERY_RULE}${STORY_DRIVEN_MUSIC_RULE}新生成默认仅剧情内声音；非叙事BGM没有本次明确授权且没有需保真的已确认配乐时不生成，H3的non_diegetic_music写N/A；只改动作或格式不覆盖已确认配乐。`;

const NOISE_BED = /(?:底噪|环境噪[声音]|背景噪[声音]|房间底声|白噪[声音]?|\b(?:noise\s+floor|background\s+noise|ambient\s+noise|room\s+tone|white\s+noise|(?:forest\s+)?floor\s+noise|static\s+hiss)\b)/iu;
const CONTINUOUS = /(?:持续|连续|一直|不断|贯穿|全程|整段|铺底|铺满|循环|延续|渐强|渐起|逐渐(?:升高|升起|增强|变强|响起)|\b(?:continuous(?:ly)?|constant(?:ly)?|continu(?:ing|es?|ed)|persists?|throughout|noise\s+bed|gradually\s+(?:rising|increasing)|growing\s+louder)\b)/iu;
const LOW_OR_RISING_AMBIENCE = /(?:压(?:至|到|得)?(?:极|很)?低|压低|低响|低声|低位|低音量|轻微上扬|缓慢上扬|逐渐上扬|增强|渐响|\b(?:soft(?:ly)?|quiet(?:ly)?|faint(?:ly)?|low(?:[-\s]+(?:level|volume))?|lowered|reduced|rises?|rising|swells?|swelling|increases?|increasing)\b)/iu;
const AMBIENT_SOURCE = /(?:风声|谷风|山风|林风|环境风|灵泉|泉声|泉水|山泉|溪流|溪水|流水|水声|瀑布|雨声|林地|环境[声音]|背景(?:声|音(?!乐))|嘶声|滋滋声|沙沙声|\b(?:wind|stream|water|spring|fountain|brook|creek|waterfall|rain|forest|ambien(?:ce|t)|hiss(?:ing)?)\b)/iu;
const AMBIENT_CLAUSE_START = /^(?:(?:随后|然后|接着|同时|此时|而|then|and\s+then)\s*)?(?:(?:第\s*\d+(?:\.\d+)?\s*(?:s|秒)(?:起)?|at\s+\d+(?:\.\d+)?\s*(?:s|seconds?))[，,\s]*)?(?:(?:全局|全片|整段|保持|维持|持续的?|连续的?|远处|近处|背景中|背景|环境中|潮湿|湿润|湿|低位|低响|低声|轻微|薄薄的|灵|global|overall|continuous|constantly|constant|distant|background|environmental|ambient|valley|soft|quiet|faint|low[-\s]+level|spirit|damp|the)\s*)*(?:谷风|山风|林风|环境风|风声|灵泉|泉声|泉水|山泉|溪流|溪水|流水|水声|瀑布|雨声|林地|环境[声音]|环境底噪|房间底声|白噪声|底噪|嘶声|滋滋声|wind\b|stream\b|water\b|spring\b|fountain\b|brook\b|creek\b|waterfall\b|rain\b|forest\b|ambien(?:ce|t)\b|hiss\b|noise\s+floor\b|room\s+tone\b)/iu;
const MUSIC = /(?:音乐|配乐|旋律|古琴|钢琴|弦乐|乐曲|鼓点|合唱|\b(?:music|score|melody|piano|guitar|orchestral)\b)/iu;
const EVENT_DURATION = /(?:(?:持续|响起?|延续)(?:了)?\s*\d+(?:\.\d+)?\s*(?:秒|s)|\b(?:for|lasting)\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b)/iu;
const EVENT_ONSET = /(?:第\s*\d+(?:\.\d+)?\s*(?:秒|s)|\bat\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b)/iu;
const EVENT_STOP = /(?:停止|骤停|切断|关闭|消失|\b(?:stops?|ceases?|cuts?\s+off|switch(?:es|ed)?\s+off)\b)/iu;
const BRIEF_EVENT = /(?:短暂|短促|瞬间|一瞬|\b(?:brief|momentary|transient)\b)/iu;
const WHOLE_SEGMENT_BED = /(?:全局|全片|全程|整段|贯穿|铺底|铺满|循环|\b(?:global|overall|throughout|loop(?:ing)?)\b)/iu;
const CONJUNCTION = /^(?:\s*(?:and|with|as\s+well\s+as|与|和|以及|、|，|,)\s*)$/iu;
const SOUND_SEPARATOR = /([，,；;、｜|。！？!?]|\.(?!\d)|\s+(?:and|with|as\s+well\s+as)\s+|与|和|以及|\s*→\s*)/giu;
const VISIBLE_ACTION_RESULT = /(?:@|<Subject\s|吹动|吹起|吹拂|拂动|卷起|掀开|掀起|打湿|淹没|淹过|上涨|扬起|撞开|推开|\b(?:blows?\s+(?:open|off)|(?:blows?|flutters?|tugs?|rustles?)\s+(?:(?:a|the|his|her|their)\s+)?(?:cloak|sleeves?|hair|fabric|curtains?|coat|leaves)|lifts?|floods?|knocks?|pushes?|travell?er|character)\b)/iu;
const FOREGROUND_SOUND_EVENT = /(?:亲吻|接吻|吻声|轻吻|唇(?:部)?[^，,；;\n]{0,12}(?:接触|触碰|轻触|贴合|碰触)|脚步|落脚|鞋底|碰撞|撞击|击打|开关|扣合|落锁|\b(?:kiss(?:es|ing)?|lips?[-\s]+(?:contact|touch|smack)|footsteps?|footfall|impact|collision|click|clack)\b)/iu;
const SHARED_BED_QUALIFIER = /^(?:(?:二者|两者|都|均|声音|both|all|sounds?|are|is|remain|stays?|kept|at|a|very)\s*)*(?:(?:持续|连续|铺底|铺满|延续|低响|低位|低声|低音量|压至很低|压低|轻微上扬|增强|continuous(?:ly)?|constant(?:ly)?|continu(?:ing|es?)|soft(?:ly)?|quiet(?:ly)?|low[-\s]*(?:level|volume)?|faint(?:ly)?|rising|swelling)\s*)+$/iu;

const isMusic = (value: string): boolean => MUSIC.test(value.replace(/(?:无|没有|不要)(?:背景)?(?:音乐|配乐)|\b(?:no|without)\s+(?:background\s+)?music\b/giu, ''));
const isBoundedSoundEvent = (value: string): boolean => {
  if (WHOLE_SEGMENT_BED.test(value)) return false;
  if (!NOISE_BED.test(value)) return EVENT_DURATION.test(value)
    || EVENT_ONSET.test(value) && (BRIEF_EVENT.test(value) || EVENT_STOP.test(value));
  // A radio burst with an authored onset and short duration/stop is an event,
  // even when its timbre is white noise. Do not protect an unbounded noise bed
  // merely because it has a start time or contains the word "brief".
  return EVENT_DURATION.test(value) && (EVENT_ONSET.test(value) || EVENT_STOP.test(value))
    || EVENT_ONSET.test(value) && BRIEF_EVENT.test(value) && EVENT_STOP.test(value);
};
const isAmbientBed = (value: string): boolean => !isMusic(value) && !isBoundedSoundEvent(value)
  && !VISIBLE_ACTION_RESULT.test(value) && !FOREGROUND_SOUND_EVENT.test(value) && (
  NOISE_BED.test(value)
  || ((CONTINUOUS.test(value) || LOW_OR_RISING_AMBIENCE.test(value)) && AMBIENT_SOURCE.test(value))
);
const isAmbientLed = (value: string): boolean => AMBIENT_CLAUSE_START.test(value)
  && /(?:声|音(?!乐)|噪|响|谷风|山风|林风|环境风|\b(?:wind|ambien(?:ce|t)|sounds?|noise|hiss)\b)/iu.test(value)
  && !VISIBLE_ACTION_RESULT.test(value) && !FOREGROUND_SOUND_EVENT.test(value);

/** Remove only sound clauses, preserving untouched clauses and their timing.
 * Quoted text is opaque: dialogue/lyrics must not be rewritten as sound design.
 */
function filterClauses(value: string, audioOnly: boolean): string {
  const quotes: string[] = [];
  const shielded = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu, (quote) => {
    quotes.push(quote);
    return `\uE000${quotes.length - 1}\uE001`;
  });
  const parts = shielded.split(SOUND_SEPARATOR);
  const removable = new Set<number>();
  for (let start = 0; start < parts.length;) {
    let end = start;
    while (end + 2 < parts.length && CONJUNCTION.test(parts[end + 1])) end += 2;
    const group: number[] = [];
    for (let index = start; index <= end; index += 2) group.push(index);
    const isEligible = (clause: string): boolean => !audioOnly || isAmbientLed(clause);
    // A time-bound ambient event can share its duration across a connected
    // source list. Do not let the low/continuous modifier turn only its first
    // half into a background bed. New timed onsets start independent events.
    const sharedBoundedEvent = group.length > 1
      && group.every((index) => isAmbientLed(parts[index].trim()) || SHARED_BED_QUALIFIER.test(parts[index].trim()))
      && !group.slice(1).some((index) => EVENT_ONSET.test(parts[index]))
      && isBoundedSoundEvent(parts.slice(start, end + 1).join(''));
    if (sharedBoundedEvent) {
      start = end + 2;
      continue;
    }
    const sharedQualifier = group.some((index) => SHARED_BED_QUALIFIER.test(parts[index].trim()));
    const hasBed = group.some((index) => isEligible(parts[index].trim()) && isAmbientBed(parts[index]))
      || sharedQualifier && group.some((index) => isAmbientLed(parts[index].trim()) && !isBoundedSoundEvent(parts[index]));
    for (const index of group) {
      const clause = parts[index].trim();
      if ((!isEligible(clause) && !(hasBed && SHARED_BED_QUALIFIER.test(clause)))
        || isMusic(clause) || isBoundedSoundEvent(clause)) continue;
      // A shared adjective applies across conjunctions ("continuous wind and
      // water ambience"), but never across separate sentences or sound events.
      if (isAmbientBed(clause) || hasBed && (isAmbientLed(clause) || SHARED_BED_QUALIFIER.test(clause))) removable.add(index);
    }
    start = end + 2;
  }
  const retained: number[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    if (!removable.has(index) && parts[index].trim()) retained.push(index);
  }
  if (!removable.size) return value;
  return retained.map((index, position) => `${position ? parts[index - 1] : ''}${parts[index]}`)
    .join('')
    .trim()
    .replace(/\uE000(\d+)\uE001/gu, (_, index: string) => quotes[Number(index)]);
}

/** Only use on audio fields, never on a whole prompt or a music field. */
export function stripContinuousAmbientBed(value: string): string {
  return filterClauses(value, false);
}

/** Old canonical actions can end with a stand-alone ambient handoff cue.
 * Match only audio-led clauses; never discard an action that mentions a sound.
 */
export function stripAmbientBedFromAction(value: string): string {
  return filterClauses(value, true);
}

export function normalizeShotAmbientSound(value: string): string {
  const layered = /(?:环境|动作|情绪)层\s*-\s*\[/u.test(value);
  if (!layered) return stripContinuousAmbientBed(value);
  return value.replace(/((?:环境|动作)层\s*-\s*\[)([^\]]*)(\])/gu,
    (_, prefix: string, body: string, suffix: string) => `${prefix}${stripContinuousAmbientBed(body) || '无'}${suffix}`);
}
