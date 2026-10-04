/** Shared generation rule; this changes sound design, never sampler settings. */
export const DIALOGUE_LANGUAGE_RULE = '提示词的描述语言不等于人物说话的语言。已有对白保留原字、原语言、原说话人和原顺序；原中文对白不能因为界面选择 English、模型使用英文提示词或要求英文描述就改成英语。原文明确要求某句用英语说、英文对白或其他语种时，必须在该句台词或音效对白的说话人旁紧邻保留语种标注（如“对白语言：英语”），不能丢成没有语种依据的普通台词。未明确要求英文对白时不得擅自改为英文，人物姓名和代号也不作意译。';

export const NATURAL_ACTION_AUDIO_RULE = '动作音效按镜头距离、动作力度、声源距离和叙事重要性自然呈现，不为每个小动作配声，不要求每个真实接触都单列音效。只为实际可听且必要的脚步、碰撞等关键事件配声，按原时序用相对本镜开始的“第Xs”绑定实际动作时刻；必要脚步和碰撞不能因无配乐或背景近静音一律删除，普通抬头、转身、注视、轻扶或姿势变化不自动添加衣料摩擦、衣物破风或呼吸声。亲吻不强制每次都有独立音效：中景轻吻可以非常轻、甚至几乎听不见，也可以不单列吻声；近景同样服从实际力度，不突出“啵”、夸张唇部弹响或贴麦口部声，不渲染成 ASMR。只有原剧情明确要求可听吻声或本镜确有必要时，才以符合距离的自然短促轻触声同步接触，不能把“轻吻”自动升级为响亮吻声。未发生、只是靠近、想吻或差点吻不能加吻声。不自动添加持续呼吸、ASMR或摩擦声；没有画面动作就不补对应动作音。';

/** Source and temporal scope are model-owned planning decisions. This rule
 * adds no local audio detector, semantic gate or post-generation processing. */
export const DIEGETIC_AUDIO_SCOPE_RULE = '先按完整原剧情区分可见环境、明确可听的有源事件和有剧情理由的跨镜声床：看见风吹衣摆、水面、瀑布、雨景或烟雾，只是视觉事实，不自动意味着要生成风声、水声或持续环境声；原文明写听见、传来或实际可听的动作声，则保留该声源及叙事作用，不能一刀切删成无声。声源存在、一直可见、发生在同一地点，都不等于声音必须从本段0秒持续到结束。为每个必要声源根据剧情安排进入、可听范围和退出，保持远近、遮挡、镜头听觉距离及对白与关键动作的前后层级；原文没有给精确时刻时由AI结合相应事件安排，不在本地推算，也不把所有真实声音强制缩成短音。比如“远处传来瀑布坠落声”保留远处传来的听觉事件，只在本段实际听到它的事件时段呈现，不能改成整段持续的瀑布轰鸣、低频水声或循环环境铺底；未提供的声音时长不能仅凭瀑布存在推成全程。只有原文或当前连续事件的听觉关系确实支持跨镜持续，才设计跨镜声床，并明确其适用范围及进入、离开或距离变化的依据，不能把短暂听到或后段才出现的声音提前铺满全段。“轻微、低响、柔和、远处”只约束听感，不是持续时间授权，不能用压低音量来合理化多出来的持续背景声。同一声源只安排一次：镜内事件留在对应镜头，不再在overall_soundscape中变成第二条全局铺底；确有跨镜声床时全局只概括同一声源，镜内只描述必要的变化，不另起一层、不因切镜重启或叠加。没有剧情依据的全局声床时overall_soundscape写N/A，明确的局部环境声、对白与动作声仍保留在对应镜内；non_diegetic_music的无配乐规则独立保持。';

/** Relative listening intent for the text/video model, not an audio API gain
 * setting or a measured-loudness guarantee. This never changes sampler or
 * transport parameters and never post-processes the completed mixed track. */
export const NATURAL_BACKGROUND_MUSIC_RULE = '本产品默认只交付剧情内实际发生的声音：对白、明确可听的环境声和动作声。非叙事背景音乐（BGM/score）不是默认声层；场景名称、天气、情绪、风格预设、普通走动或“戏剧节点”都不能授权你自行补BGM。新生成或主动重新生成时，只有用户在本次请求中明确要求非叙事配乐，才可写入non_diegetic_music；否则固定写N/A，并在逐镜声音中明确不要自动补背景音乐。仅当本次操作明确是格式修复、参考图更新或上下段衔接修复，且已有稿已经确认保留配乐时，才按已有稿保留，不重新配乐。获得明确授权时，配乐也只能简洁、柔和、极低存在感，远离前景并让位于对白和关键动作声，不把音乐抬成前景，不压低对白或整条音轨迁就配乐；该相对听感不是API音量参数或实际测量结果。切镜不突然重启或增响，不靠增大音量制造衔接，避免强鼓点、夸张低频、戏剧性渐强及忽大忽小。场景内有声源依据的演奏、收音机或人物哼唱属于剧情内声音，留在相应环境/动作/对白字段，不要误放入non_diegetic_music。';

/** Names and reference labels are visual facts, not a script to perform.
 * These are shared model instructions only; no local name filtering occurs. */
export const VISUAL_IDENTITY_SPEECH_SCOPE_RULE = '视觉身份与可发声文本必须分开：人物姓名、资料、角色/形态名称、参考图名称、图片槽位、身份映射及参考职责都是视觉定位资料，不是台词，不可把它们朗读、点名、唱出或改成旁白介绍。除用户本次明确授权扩写对白外，可发声词句只来自当前段原剧情已有的具体台词；资料中出现名字、镜头动作中提到名字，都不能授权人物喊出这些名字。保留资料与画面描述中的完整姓名和对应关系，不靠删除、改名或占位符避开问题。若原剧情的真实台词本来就在呼喊姓名，仍逐字保留该句、原说话人和时刻；禁止的是把视觉资料变成新增发声内容，不是禁止原有呼名台词。';

/** No dialogue is a timed performance constraint, not a request to mute
 * authored effects or freeze natural expressions and mouth movements. */
export const NO_DIALOGUE_PERFORMANCE_RULE = '无对白必须成为实际交付正文中的全时段表演约束，不能只写一个容易被忽略的“台词：无/Dialogue: none”：某镜无对白时，从该镜起点到镜尾都不说话；整段无对白时，从0秒到该段结束（包括最后几秒）都不说话，不新增喊名、含混交谈、耳语、旁白或说话口型，不能在片尾自行补一句。原剧情只有交谈/催促概述而没有具体原话，不得由此编词或用含混交谈填空；仅当原稿明确要求不可辨词汇的人声，且该区间没有明确要求无对白时，才按原意保留这种声音，不赋予任何可辨词句或姓名。无对白不等于整轨静音：保留原剧情明确的笑声、咳嗽、哭泣等非语言声及必要动作声，不自行补声；没有说话口型不等于嘴唇永久闭合或表情冻结，仍保留剧情合理的微笑、亲吻、进食等非说话动作。无对白约束只覆盖原定无对白区间，不删其它镜头或其它时刻的真实台词。';

/** Model-authored staging, not a local duration formula, speech detector or
 * acceptance gate. Planning may allocate time; translation cannot re-plan. */
export const DIALOGUE_PERFORMANCE_TIMING_RULE = '新剧情规划及获准重新安排的生成阶段，先让对白和动作组成唯一的可执行时序：每句先明确完整姓名、原话、开始至结束的发话区间以及与前后动作的先后关系，不能只有起点而让整句占用到哪里含糊不清。发话区间须容纳当前语种、语气、停顿和真实动作，由AI结合剧情判断，不用固定字数公式或加速朗读硬塞；不能把长句堆到最后几秒再宣称自然。画内口部动作与有声口型不能互相冲突：例如亲吻应靠近、接触、离开后再开口，不写同一人物亲吻接触期间“同时口型清晰地说”；进食、咬住物体等按实际能否发音安排，原文明确的心声、旁白或另一声源仍保持原性质，不强改成口播。走路、手势等可合理与讲话并行，不能一刀切把所有动作串行。说话权交接以具名人物为单位：前句结束后才由下一人接话，原文明确抢话、重叠或齐声时保留原关系而非擅自改成轮流。镜头主体、被称呼者、人物自身左右和参考图顺序都不能替代发话者身份；非说话者不做该句口型，但允许原剧情的自然表情与非说话动作。人物身份和镜头概述只交代静态信息；同一次剧情动作只在时间执行段写一次，不先在人物介绍里完整演完，再在时间点重演。规划阶段先为完整发话、停顿、必要动作和交接留时间，再决定镜头；已确认的转换、翻译或参考绑定阶段只保真既定区间和先后关系，不擅自改变镜界、片长、对白归属或搬运相邻段台词。旧确认稿若仅给发话起点，翻译、参考绑定和纯格式修复保持原时间表达，不借本规则补造结束时间、重新排程或改写原有动作关系；这些阶段只修复本轮操作造成的遗漏与歧义。';

/** Dialogue is authored story data, not a sound-effect summary.  Keep this
 * contract separate so every text-model entry point can carry it without
 * changing the H3 transport shape or adding a local semantic gate. */
export const DIALOGUE_DELIVERY_RULE = `对白交付必须以完整原剧情为准：逐句保留原话、原语言、原说话人和原顺序，不能把“催促声/回应声/女性声音”等概括改成模型自行编写的台词。每句对白只能归属一个明确说话人（原稿明确齐声时保留其具名声源集合）；该句期间只有对应说话人发声或做对应口型，其他人物只按剧情安排倾听、反应或行动。明确画内、背影、画外、通信或心灵声源；人物不在画面中也不得换成当前主体代说。原文没有可辨识台词时不得补出可辨词句，不新增旁白、画外解释、拟声词或即兴台词；原定无对白区间写“台词：无”或等价无对白指令。只有用户明确授权扩写对白时才由AI补写，并仍标明唯一说话人。${DIALOGUE_PERFORMANCE_TIMING_RULE}${VISUAL_IDENTITY_SPEECH_SCOPE_RULE}${NO_DIALOGUE_PERFORMANCE_RULE}保持原语种，不因 English 提示词翻译中文对白，不把台词改写成音效摘要。由AI在交付前自行核对说话人、台词原字、语种、顺序、时间和口型并修复，不能依赖本地关键词拦截。`;

/** Final text-model delivery, not an extra section or local semantic gate. */
export const AUDIO_H3_DELIVERY_RULE = '声音要求必须落实在本次实际交付的正文，不能只留在分析或审核说明里。新生成或主动重新生成时默认仅保留剧情内对白、明确环境声和动作声：non_diegetic_music固定写N/A，并在逐镜声音中明确不自动补背景音乐；不要因为场景、天气、情绪、风格或普通动作自行选择BGM。只有用户在本次请求中明确要求非叙事配乐，才在non_diegetic_music中写具体音乐、适用镜头和极低存在感，并让位于对白与关键动作声。若本次明确是格式修复、参考图更新或上下段衔接修复，才可保留已有确认的配乐选择、声源、音量与进退安排，不重新配乐。H3字段职责必须分开：overall_soundscape只写整段范围的简短剧情内环境/声景摘要，只有有剧情依据的跨镜声床才进入该字段；没有全局声床就写N/A，不把只在某镜或本段后半程出现的环境声提升为全程背景，可保留一句必要的全局“不自动补背景音乐/不添加填充底噪”说明。同一声源不能在镜内和overall_soundscape重复铺设；跨镜声床的全局摘要与镜内变化指向同一声音，不是两层叠加。局部环境声的出现、结束和听觉距离保留在对应镜内，“远处、轻微、低响”不能替代时段与范围；有依据的瀑布、风雨等声音不能因为overall_soundscape=N/A而删除。具体对白原字、唯一说话人、声源编号、逐镜无对白、咳嗽/动作声的镜内时刻、口型与听者、逐镜禁止项全部写在对应[Shot N]的integrated_multimodal_description或full-reference的detailed_description中，不能搬进overall_soundscape。不得在overall_soundscape中列Shot编号、对白复述、声源分配、镜内时序或长篇否定清单。不得新增negative_prompt、negative、反向提示词或其它声音section；non_diegetic_music无用户本次明确授权时固定为N/A。对白必须逐字、唯一说话人、原语言、原顺序和明确声源；“催促声/回应声”不能代替原台词，没有原台词不创造可辨词句，原定无对白区间保持全程无对白，不让视频模型即兴编词。audioMode为none时保持无音轨设计，不添加音乐、对白声或动作声。保持原有H3字段名称与顺序、对白及说话人，镜数与切点保持已确认排程；仅本次指令明确授权taskAuthority=current-segment-staging-replan时，镜数与切点以同时交付的修正canonicalPrompt为准，用户固定段长与exact镜数仍不变。不增加混音章节、增益参数或规则清单；普通六字段输出仍用原音效字段，不改成H3。';

/** Translation, including its format-only retry, preserves the Chinese mix. */
export const AUDIO_TRANSLATION_SCOPE_RULE = '声音翻译与其格式修复以已确认的sourcePrompt为准：完整保留已确认的音乐选择或N/A、适用镜头、进退时机、对白让位、无对白不抬升及不自动补乐安排。环境声和动作声也必须保留原有出现与结束时段、相对本镜或本段的时间坐标、远近与遮挡、前景或背景层级；不把局部事件改成贯穿全段的continuous/throughout ambience，不把distant/soft/faint误写成持续授权，不把镜内声音提升或重复到overall_soundscape，不因切镜新增重启或叠加。同一已确认跨镜声源保持原范围，不能一刀切删掉或改短；原稿没有给出的起止时间也不能在翻译时擅自补造。不能把“无配乐”改成有配乐或把安静背景改成整轨静音；N/A原样保留，不新增音乐或声源、不重选配器、不借新声音规则重写旧稿的混音方案。逐句保留原对白、原语言、唯一说话人、顺序、声源和口型安排；中文对白原字保留，不在英文稿中翻译台词。H3字段、切点和原语言对白保持不变。';

/** Existing-prompt refresh scope: preserve the authored sound plan while the
 * model reviews only the requested non-audio change. */
export const AUDIO_EXISTING_SCOPE_RULE = '本次操作只更新已有提示词中明确要求的非声音内容；声音以已确认稿为准，保留原有配乐选择或N/A、适用镜头、进退时机、对白让位、无对白不抬升和不自动补乐安排。环境声与动作声的原有起止、镜内或跨镜范围、听觉距离和层级同样保留，不延长局部声音、不提前引入后段声源、不在镜内与overall_soundscape新增重复铺底；没有原始时刻就不补造。不得重新选配器、添加或删除音乐/声源，也不得把已确认的N/A改成配乐；H3字段、切点、逐字对白与唯一说话人保持不变。';

/**
 * Music is an explicitly authorized non-diegetic layer, not a blanket
 * ambience bed.  Keep this rule shared by storyboard planning, conversion and
 * repair prompts so every entry point has the same default-no-BGM contract.
 */
export const STORY_DRIVEN_MUSIC_RULE = `剧情情绪转折、危险、追逐、回忆、亲密关系、胜利收束、场景名称、天气、普通走动和风格预设都不是自动添加非叙事BGM的依据。新生成或主动重新生成时默认只保留剧情内实际声源；只有用户在本次请求中明确要求非叙事配乐，AI才可写入non_diegetic_music，否则必须写N/A。仅格式修复、参考图更新或上下段衔接修复可以保留已有确认稿的配乐，不重新选乐。用户明确“无/不要/禁止配乐”始终优先。${NATURAL_BACKGROUND_MUSIC_RULE}`;

export const AUDIO_PROMPT_RULE = `环境层只写本镜有实际声源依据且叙事必要的声音；未指定时写“无”，仅无事件的背景近静音，不是整条音轨静音。不要因林地、室内、雨景或无配乐自动补连续底噪、房间底声、嘶声、白噪声，也不要用持续、低响或渐强的谷风、环境风、灵泉、溪流等环境声填满镜头及全局声景。${DIEGETIC_AUDIO_SCOPE_RULE}${NATURAL_ACTION_AUDIO_RULE}${DIALOGUE_DELIVERY_RULE}${STORY_DRIVEN_MUSIC_RULE}新生成默认仅剧情内声音，非叙事BGM没有本次明确授权时必须不生成，H3的non_diegetic_music写N/A；明确授权的既有配乐才保留并让位于对白与关键动作声。`;

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
