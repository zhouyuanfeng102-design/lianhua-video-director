import {
  SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE, SPATIAL_TRANSLATION_RULE,
  DIRECTED_ACTION_RELATION_RULE, STORYBOARD_FRAME_VISIBILITY_RULE, STORYBOARD_SPATIAL_FRAME_RULE,
  LEGACY_SPATIAL_COORDINATE_RULE_V1_8_1, LEGACY_SPATIAL_CONTINUITY_REVIEW_RULE_V1_8_1,
  LEGACY_SPATIAL_TRANSLATION_RULE_V1_8_1, LEGACY_DIRECTED_ACTION_RELATION_RULE_V1_8_1,
  LEGACY_STORYBOARD_FRAME_VISIBILITY_RULE_V1_8_1, LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V1_8_1,
} from './spatialContinuityRules';
import {
  VIDEO_INTERACTION_RULES, VIDEO_INTERACTION_TRANSLATION_RULE,
  LEGACY_VIDEO_INTERACTION_RULES_V1_8_8, LEGACY_VIDEO_INTERACTION_TRANSLATION_RULE_V1_8_8,
  LEGACY_VIDEO_INTERACTION_RULES_V1_8_1, LEGACY_VIDEO_INTERACTION_TRANSLATION_RULE_V1_8_1,
} from './videoInteractionRules';

/**
 * Request-time directing instructions, shared by planning and AI review.
 * These are text contracts only: no local performance, spatial or story validator,
 * no rewriting of saved presets, and no video generation or media inspection.
 */
export const VIDEO_NATURAL_PERFORMANCE_RULE = '由你结合原剧情、人物关系、已知性格和当前信息，逐镜判断人物注意什么、为何反应、反应如何变化，把可见表演写入现有performance/action。身份与面容稳定不等于表情冻结，人物参考图的静态表情不是全片表情锁；沉着、克制或安静不等于面部和身体僵住。普通身份资料中的性格、动作习惯与“笑容明亮”“被某事后神色如常”等静态或条件式表情锚点只是角色参考，不是当镜必须执行的事件或全程固定表情，不把整份档案逐镜复制成动作命令。以当前段真实事件触发表演变化，档案里的条件只有当前剧情实际触发才适用，不把后段才发生的动作或后果提前，也不为丰富表情添加影响剧情的动作；保留原有角色身份与用户明确设定，不擅自改变年龄、衣着、外貌或已确认状态。只在剧情有依据且景别可读时，用视线、语气、姿态或动作节奏表达刺激后的理解、回应与自然回落，不要求每镜凑齐一套微动作。表演幅度和持续时间须符合情境与已选风格：原文有强烈喜悦、恐惧、愤怒等就保留，不能一律改成面无表情或微笑，也不能把普通交谈放大成长时间瞪眼、挑眉、咧嘴或夸张点头。说话者的口型和语气跟随自己的原话及停顿；倾听者依实际听到的信息维持注意或作出有依据的反应，不代说、不随别人的台词张口，也不把不说话写成紧咬嘴唇或全程木然。表情不随切镜机械重置，同一人物的反应阶段要接续；不强迫背影和远景展示不可见的面部细节，不为表演新增剧情事件、改变原有情绪走向或添加影响因果的人物动作，不指定固定眨眼频率、每秒表情次数或所有人物同步反应。';

export const VIDEO_WORLD_SPACE_CAMERA_RULE = [
  '源头写作先理解当前事件中双方怎样相互行动及其连续世界站位，再为这个事件安排摄影机，而不是先写正面展示和炫技运镜，再让人物围着镜头摆动作。世界空间记录起点、当前所在路段、目的地、固定地标、具名人物身体朝向与视线目标；两人交战还要写清本镜进入时的相对距离、双方能否用当前肢体或武器触及对方、谁如何接近/退让/侧移及退出时的关系。场地大小、障碍与交战距离优先采用原文和已确认空间；信息不足时依据双方武器可达范围、攻防意图和可用场地补一种合理安排并持续承接，用“尚未进入武器触及范围→向对手接近→接挡距离”等可见关系表达，不硬编房间尺寸或固定米数。远距离转为接触必须表现接近过程，后退、绕行或追击也从上一动作末态连续发生；摄影机推拉和景别变化只改变投影与可见范围，不改变双方世界距离。',
  '镜头空间记录摄影机相对人物的位置、朝向、运动轨迹、轴线一侧及画面中的运动方向。按已经编排的施事者—对手交战轴和关键接触区确定机位：普通客观打斗优先选择能读清攻击指向、防御和接触反应的侧面或斜侧机位，建立关系镜保留双方及交点；接触细节、单人反应或武器近景按叙事需要裁切，画外对手仍处于同一轴线上的已知位置，不要求每个近景同时容纳两人全身。写明摄影机位于交战轴哪一侧、看向谁或哪一接触区、怎样随双方攻防移动保持动作可读。摄影机跟随人物和交点，人物的注意、躯干转向和攻击路径由对手及当前动作决定，不能为了跟上镜头或展示正脸让人物转向观众、让对手自动移到攻击者身后。基于剧情的越肩、对手主观视角、反打或可见绕行照常保留，并落实摄影机与被观察对象、轴线和视线的关系；客观侧机位是信息清晰时的优先选择，不是禁止所有其他机位。',
  '行进路线和目的地不等于摄影机朝向，也不等于人物背后可见的背景。正面跟拍可以是摄影机位于人物前方并向后退拍，人物继续向目的地前进，不代表人物掉头或倒走；此时背景应来自人物身后、摄影机实际视野所及的路段，不能仅因人物将到达某地就把该目的地凭空换成背后背景。随真实行进、道路转折、空间包围或有交代的机位变化，背景可以合理改变，不把所有背景变化都判成错误。逐镜将当前景别、视线与地标的实际可见性写清，保持人物世界中的路线和同伴关系，不能只写“轴线一致”而让空间事实互相矛盾。需要变换正背面、机位侧别或屏幕运动方向时，用当前镜头内清楚的机位关系、可见摄影机运动、规划允许的衔接镜头或原文明确的转场建立关系；摄影机换位不等于人物转身，不为修复空间虚构掉头、瞬移、时间跳跃或新路线。未知布局可在规划时合理安排并持续承接，不能声称未知布局来自未见参考图。',
  SPATIAL_COORDINATE_RULE,
  SPATIAL_CONTINUITY_REVIEW_RULE,
  VIDEO_INTERACTION_RULES,
].join('\n\n');

export const LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_9 = '镜数与覆盖方式由你先分析剧情信息、动作因果、对白回应、空间变化、情绪转折和可用时长后决定，不默认三镜、不为凑固定镜数机械等分，也不因每句对白或每个人物都必须露正脸而切镜。规划阶段在用户指定镜数或允许范围内，选择足以清楚表现当前剧情的镜头数量；自动模式按需要决定镜数与镜长，在规划JSON已有reason（保存后对应shotCountReason）和每镜purpose/transition说明具体依据，不新增JSON属性，也不只复述“电影感”。分段时长窗口不等于一个镜头：15秒可以包含多个有叙事动机的镜头，先安排完整对白区间、换人交接和必要动作，再选择覆盖方式，不先把每段做成一镜后硬塞全部事件。多人轮流接话时明确当前具名发话者和口型可见性，可采用关系构图、说话者中近景或单镜内有动机的关注转移；观察重点须与当前话轮和动作一致，不让后面的亲吻提前成为开场正在执行的焦点。一个连续镜头可以成立，有必要的信息揭示、反应或空间建立也可以拆镜，不为镜头多样性制造事件。选择建立空间、双人关系、侧面行进、背后跟随、主观观察或反应近景等覆盖方式须服务当前情节，不把这些例子变成每段必做清单；对白不自动等于正面面部近景，正面跟拍也不被一律禁止。转换、H3复核和翻译阶段若镜数与时间边界已经确认，则保留既定镜数、顺序和切点，在现有镜头内改善调度，不借自主导演之名重切整段或裁掉对白。';

export const LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_1_0 = '先排本段各事件的实际起止、完整对白与必要反应，再决定摄影覆盖。auto从能清楚表现全部因果的最少必要视角开始，每次新增切镜要对应具体的信息揭示、视点或空间变化；一个连续镜头已能看清接触、轨迹与回应时，优先在镜内调整关注，不为每个动作阶段、每次碰撞、每句对白或每张正脸各切一镜。不预设三镜或其他镜数，不按15秒等分，也不把每个事件拉长到铺满分配的镜头；确有信息变化时可增加镜头，用户exact镜数严格保持，不能借最少必要视角减少用户固定镜数。世界行动关系先于摄影：关键接触发生时让必要的身体朝向、发力部位、物体与目标路径可读，切换后从同一事件当前阶段和速度继续，不能为换景别重置起手或让受力人物等待下一镜。短促事件完成后可继续覆盖剧情已有的反应，镜头时长不等于事件持续时长。多人对白可以用关系构图、说话者近景或单镜关注交接，具名声源、口型与话轮对应；选择侧面、越肩、反打或正面跟拍均须有信息目的，原定慢节奏与有依据的停顿保留。规划JSON沿用reason（保存后对应shotCountReason）以及purpose/transition，说明哪些事件连续覆盖、为何确需切换，不用“已复核”或“电影感”替代依据。转换、H3复核、参考更新和翻译若镜界已经确认，保留既定镜数、顺序和切点，仅在本次明确授权范围内处理，不重切已确认稿或裁掉对白。';

/** Scene understanding precedes photography; these are generation instructions. */
export const VIDEO_CONTINUOUS_SCENE_RULE = [
  '先理解完整剧情，再按地点、连续时间、人物目标、阻碍及局势变化组织连续场面；同一场面可以包含进入、交谈、行动、回应和结果，事件条目、人物登场、段落标题与生成窗口都不自动成为摄影切点。先确定观众此刻必须理解谁在何处、谁对谁做什么、为什么这样行动及结果怎样改变局势，再安排观看任务与摄影。',
  '入场与对峙先让人物、通路和相对关系可读；对白按真实话轮与听者反应推进；连续攻防让发起、轨迹、对方回应、接触或落空及反馈保持连贯；线索或身份揭示按原文的知情顺序展示。场面条件决定观看重点，不把这些场面例子变成每段必做清单。人物拥有身份、服装、武器或身体特征，不表示必须逐项扫拍、停留展示或先给道具再给脸。',
  '身份资料是辨认与连续性依据，不是需要演出的事件；在格式允许的位置简短定义必要稳定特征一次，后续保留姓名及当镜实际状态，不把整份档案、动作习惯或设定真值写成当镜行动。普通迈步、抬手、移开视线和细微停顿按自然先后或并行表达；数字时刻用于镜界、完整发话区间与确需同步的关键事件，不为每个微动作编造小数秒排程。',
].join('\n\n');

export const LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_3_7 = [
  '先排本段各事件的实际起止、完整对白与必要反应，再决定摄影覆盖。auto从能清楚表现全部因果的最少必要视角开始，选择少而充分的镜头与简单连贯的摄影；一个连续镜头已能看清接触、轨迹与回应时，优先在镜内调整关注，用稳定取景、自然跟随或必要重构图承载连续场面。',
  '切镜由观看任务改变产生：当前取景与自然镜内调整无法清楚表达下一项关键叙事信息时，才切向所需的新画面。真实换场跳时、关键揭示、叙事立场转移或决定性反应可以成立；普通目光移动、换人说话、迈步、碰撞和换一件道具本身不够。不是硬性一镜到底，也不靠在同镜堆叠推拉、环绕、摇移和反复变焦来躲避必要切镜。',
  '不预设三镜或其他镜数，不按15秒等分，不为每个动作阶段、每次碰撞、每句对白或每张正脸各切一镜。用户exact镜数严格保持，在指定镜数内完整表达原文；auto镜数来自实际观看需要，不以题材、风格术语或段长预填。世界行动关系先于摄影，关键接触及下一招从同一事件当前阶段和速度继续，不能为换景别重置起手或让受力人物等待下一镜。短促事件完成后可继续覆盖剧情已有的反应，镜头时长不等于事件持续时长，原定慢节奏与有依据的停顿保留。',
  '规划JSON沿用reason（保存后对应shotCountReason）以及purpose/transition：purpose说明本镜让观众理解的具体关系、行动或信息；transition说明剧情何处触发观看重点交接、前镜不能提供什么必要信息及如何从真实末态继续。一个镜头可以承载相互因果的多个事件、动作与话轮；不以“电影感”“节奏变化”或器物与脸部展示替代叙事职责。转换、H3转写、参考更新和翻译保留既定镜数、顺序和切点，不重切已确认稿或裁掉对白；只有用户明确请求的源头重新导演才重新选择摄影。',
].join('\n\n');

export const VIDEO_AI_SHOT_COVERAGE_RULE = [
  '先排本段各事件的实际起止、完整对白与必要反应，再决定摄影覆盖。先按自然发话速度容纳完整原话，同时留出必要行动与结果辨认，不能让长句挤进余秒或让持续交战只剩一次挥击。auto从能清楚表现全部因果的最少必要视角开始，选择少而充分的镜头与简单连贯的摄影；一个连续镜头已能看清接触、轨迹与回应时，优先在镜内调整关注，用稳定取景、自然跟随或必要重构图承载连续场面。',
  '切镜由观看任务改变产生：当前取景与自然镜内调整无法清楚表达下一项关键叙事信息时，才切向所需的新画面。真实换场跳时、关键揭示、叙事立场转移或决定性反应可以成立。群战按已成立的战场关系覆盖前景可读交点、中景队列/梯队推进与远景既有军势规模；它们可以同镜分层或按必要信息切换，不强制逐层各一镜，不把所有人同时推到同一交点，也不以远景人多替代真实攻防。普通目光移动、换人说话、迈步或碰撞本身不够；不是硬性一镜到底，也不靠在同镜堆叠推拉、环绕、摇移和反复变焦来躲避必要切镜。',
  '不预设三镜或其他镜数，不按15秒等分，不为每个动作阶段、每次碰撞、每句对白或每张正脸各切一镜。用户exact镜数严格保持，在指定镜数内完整表达原文；auto镜数来自实际观看需要，不以题材、风格术语、人数或段长预填。世界行动关系先于摄影，关键接触及下一招从同一事件当前阶段和速度继续，不能为换景别重置起手或让受力人物等待下一镜。持续交战、压倒性持续清剿、瞬杀、追逐与阵列推进按真实过程覆盖，持续迎击不缩为一挥后静止，瞬杀不拖成多回合。短促事件完成后可继续覆盖剧情已有的反应，镜头时长不等于事件持续时长，原定慢节奏与有依据的停顿保留。',
  '规划JSON沿用reason（保存后对应shotCountReason）以及purpose/transition：purpose说明本镜让观众理解的具体关系、行动或信息；transition说明剧情何处触发观看重点交接、前镜不能提供什么必要信息及如何从真实末态继续。一个镜头可以承载相互因果的多个事件、动作与话轮，真实在场人物可画外继续说完整原话并与既有行动并行，不新增旁白、不转交声源、不提前事件，也不强迫每句露正脸。不以“电影感”“节奏变化”或器物与脸部展示替代叙事职责。转换、H3转写、参考更新和翻译保留既定镜数、顺序和切点，不重切已确认稿或裁掉对白；只有用户明确请求的源头重新导演才重新选择摄影。',
].join('\n\n');

/** Exact former camera text is retained for request-only preset compatibility. */
export const LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_0_1 = '先把本镜的具名双方、动作对象、进入状态、连续动作和退出状态落实在现有action/space/direction，再以观众需要看清的关系、接触和反应选择camera；角色动作安排先于镜头覆盖，不能把“朝镜头冲来”“正面挥砍”当作缺失对手关系的替代。用户实际选择的cameraTerms及具体运镜要求是真实创作输入，不是可忽略的装饰；结合剧情逐镜判断它们适合表达什么，明确的必选或指定镜头要求按其范围遵守，普通多选偏好在适用镜头中合理分配。选择了多个效果不等于每镜同时叠加所有推拉、环绕、摇移或手持；不能把术语整串复制到所有镜头，也不能把用户选择全部丢掉再声称自主决定。未选择运镜时，仍由你按本镜信息目标自主选择固定、跟随或其他适合的拍法，不能回退为每镜固定同一种默认跟拍。每镜在现有camera写出景别、必要的机位/视角、相对于交互轴线的侧别、固定或运动方式及其观察目标，在purpose或camera用简短可执行语句落实选择理由，transition交代有意义的切换依据。跟随打斗时写清摄影机沿哪条路径跟上谁和哪段交点，人物依剧情看向对手、武器或事件目标，镜头平移、推近或绕行本身不让人物转身、改换攻击目标或缩短世界距离。不只写“电影级运镜”“智能选择”或罗列术语；不强制正脸覆盖，不把角色身份参考图当作必须朝镜头表演的构图命令。';

export const LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_1_0 = LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_0_1.replace(
  '再以观众需要看清的关系、接触和反应选择camera；',
  '再分别确定人物的视线/攻击目标与摄影的主体、取景范围和焦点。人物看向或攻向哪位对象的哪个部位，由剧情行动决定并写在direction/action/performance；camera依据观众需要理解的关系、接触、反应或新信息选择覆盖，二者不自动相同。观察、判断或寻找破绽先用关系构图及观察者的视线、表情、姿态表达，被观察对象按实际景别自然入画；角色的目光落点本身不构成推近局部、追随视线切特写或定格的摄影要求。局部特写在关键局部提供必要新信息、现有关系景别无法读清或用户明确指定时使用，原剧情确需的接触细节、线索及局部变化保留；裁切仍继承具名对象与方向关系。',
);

export const VIDEO_CAMERA_SELECTION_RULE = [
  '先把具名人物、动作对象、进入关系、连续行动与退出状态落实在现有action/space/direction，再分别确定人物的视线/攻击目标与摄影的主体、取景范围和焦点。人物看向或攻向谁由剧情行动决定并写在direction/action/performance；摄影的观看任务是让观众理解已经发生的关系、接触、反应或关键新信息。',
  '观察、判断或寻找破绽先用关系构图及观察者的视线、表情、姿态表达；角色的目光落点本身不构成推近局部、追随视线切特写或定格的摄影要求。局部特写在关键局部提供必要新信息、现有关系景别无法读清或用户明确指定时使用，原剧情确需的接触细节、线索及局部变化保留，裁切仍继承具名对象与方向关系。不强制正脸覆盖，不把身份图当作朝镜头表演的构图命令。',
  '用户实际选择的cameraTerms及具体运镜要求是真实创作输入，明确的必选或指定镜头要求按其范围遵守；普通多选偏好是可用手段，不是逐项展示任务。叙事与少而充分的覆盖先成立，再在适用位置体现风格；高速动作不等于快速剪辑，特写偏好不等于每次接触都切特写。选择了多个效果不等于每镜同时叠加所有推拉、环绕、摇移或手持，也不能把用户选择全部丢掉；未选择时依据观看任务选择简洁固定、自然跟随或必要运动，不能回退为每镜固定同一种默认跟拍。',
  '每镜在现有camera写出景别、必要的机位/视角、轴线一侧、观察对象及与行动一致的摄影方式，在purpose或camera用简短可执行语句落实选择理由。一个连贯主机位可通过人物调度与自然关注交接覆盖多个动作；避免单镜先扫道具再抬脸再绕行的展示链。跟随打斗说明沿哪条路径观察谁和哪个交点，推拉、裁切和反打不改变真实间距、攻击目标或人物世界朝向。',
].join('\n\n');

export const VIDEO_MOTIVATED_LIGHTING_RULE = '由你结合当前地点、时间、天气、可见或已知光源、材质及人物动作逐镜设计光影；用户选择的lightingTerms及明确光影要求应在适合的镜头中落实，而不是逐镜无差别堆叠。没有选择也要自主给出符合情境的具体光影，不能只写“电影感”。保持世界中的主光源方位和时间连续，人物或机位改变后，亮暗侧、逆光或侧光可随相对关系合理变化，不把每镜同一句“左侧光”当成光源连续。让脸部层次与动作、空间信息在所选风格和景别下可读，不用强行磨平五官或无依据戏剧光掩盖表演；原剧情需要阴影或强烈风格时照常保留。不凭空新增灯具、天气或昼夜变化，不强制固定色温数值或明暗比，在已有lighting及镜内光影文字表达有效安排和必要的连续性依据。';

export const LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V2_1_0 = '上述决定必须进入现有逐镜内容，不能只在总说明写“表情自然、轴线一致、AI自主运镜”。规划时使用现有purpose、action、performance、direction、space、camera、lighting、transition、result等shot字段：action/space/direction先落实双方动作和进入关系，result承接可见的退出关系，camera覆盖该事件，transition从这份末态交代下一镜如何继续；具体选择理由融入purpose/camera/transition，保持既有数据结构。六字段转换稿将表演与连续攻防放在主体/动作，将世界路线、距离变化和机位关系放在空间/镜头，将光源和可见效果放在光影；H3稿将这些内容融入当前每个[Shot N]的现有段落。保持既有H3顶层section名称、顺序、参考标签和输出格式，时间切点保持已确认排程；仅本次指令明确授权taskAuthority=current-segment-staging-replan时，切点以同时交付的修正canonicalPrompt为准，用户固定段长与exact镜数仍不变。不新增表演审查、空间地图、运镜理由等H3顶层字段或附录，不输出内部推理链。';

export const VIDEO_ACTING_CAMERA_FIELD_RULE = '上述源头决定进入现有逐镜内容，保持既有数据结构：purpose、action、performance、direction、space、camera、lighting、transition、result表达观看任务、连续场面与真实进入退出状态，不新增报告或计划字段。一个镜头内可连续表达多个有因果的动作与话轮，动作只实际执行一次；身份句、入镜基准和result不再次指挥同一动作。六字段与H3稿将这些既定内容融入当前每个[Shot N]的现有段落，保持既有H3顶层section名称、顺序、参考标签和输出格式，时间切点保持源头排程。转换和翻译不根据风格或资料重新设计摄影；明确的源头重新导演仍保持用户固定段长与exact镜数。不新增表演审查、空间地图、运镜理由等H3顶层字段或附录，不输出内部推理链。';

/** Faithful downstream serialization; never another photography decision. */
export const VIDEO_ACTING_CAMERA_PRESERVATION_RULES = [
  'VIDEO_ACTING_CAMERA_PRESERVE_V1：本次只忠实转写已有摄影排程，保留既定镜数、顺序、切点、景别、机位、轴线侧别、运镜、观察对象与注意交接。完整导演风格、运镜多选与人物资料只帮助理解既定内容，不授权主动选镜、改机位、切特写、拆合镜头或另编摄影；原稿的静态机位、长镜头与有意义的切换均原样传递。',
  '保留逐镜人物身份、世界站位、真实间距、朝向、行动路径、连续动作强度、对方同步回应、接触或落空及进入退出状态；不把动作降成准备、摆姿势或停顿，也不补新招式、转身或结果。原对白逐字保留原语言、具名说话人、声源、完整发话区间、听者与口型状态，画外发声和无对白安排保真，不因构图或身份资料转交台词。',
  '只在现有字段与正文中消除转写遗漏和表达歧义，说明原稿已经成立的空间与动作关系，不借澄清重做摄影。简短身份定义用于辨认，不朗读档案、不逐镜复制长外貌，不把已完成状态再写成一次行动；普通微动作按原先后自然表述，未给定的小数时间不自行添加。保持当前六字段或H3字段格式、[Shot N]、At切点、参考标签与声音标签，不新增审核字段、调用或重试。',
].join('\n\n');

export const VIDEO_ACTING_CAMERA_REVIEW_RULE = '提交前由同一AI对照当前段原文、人物资料、实际选择的运镜/光影、参考资料职责与完整候选稿自行复核并修复：表演是否有触发依据和自然变化，是否将克制误写成木偶或将普通对白写成持续夸张表情，说话者/倾听者是否分清，切镜是否重置反应；每镜的机位和视向是否确实能看到所写背景，人物是否仍沿既定世界路线行进，光源是否与空间一致；镜头是否重复怼正脸而漏掉信息或空间，所选运镜是否落实、有动机且不过度堆叠。发现问题直接在当前阶段允许的字段和边界内修正，保留身份、事件因果、原话、原说话人及当前段范围，不以新增转身、赶路事件或其他剧情来圆场；保留本来合理的强烈表演、固定镜头、正面跟拍和背景变化。复核修复后返回完整最终正文，不只给通过结论、问题清单或让用户手动修改。全部内容判断由AI完成，不增加本地语义拦截、关键词否决或表情/镜数配额，不要求先生成视频或重新运行收费视频来验证提示词。';

export const VIDEO_ACTING_CAMERA_TRANSLATION_RULE = [
  '英文翻译与其AI复核以已确认中文H3为唯一执行稿，忠实保留逐镜表演幅度、触发和回落、说话与倾听归属、世界路线、人物朝向、双方进入/退出关系、接近或退让形成的距离变化、机位视向、可见背景、运镜目的及光源关系。保留摄影机相对交战轴的侧别、具名攻击目标和关键接触关系，不把跟随双方攻防译成角色追随镜头或朝观众出招。不要把克制译成expressionless/rigid，不把自然回应强化为overacting；准确区分人物向目的地前进与摄影机向后退拍，不把人物前方目的地译为其背后背景。保留中文已经明确的强烈情绪或静止状态，不额外减弱或夸张。只修复翻译遗漏与歧义，不另作镜数、机位、剧情或光影设计，不改变H3 section、参考标签、[Shot N]和At切点，也不新增审核字段。',
  SPATIAL_TRANSLATION_RULE,
  VIDEO_INTERACTION_TRANSLATION_RULE,
].join('\n\n');

/** Translation adds its fidelity rule separately; it does not re-plan shots. */
export const VIDEO_ACTING_CAMERA_RULES = [
  VIDEO_CONTINUOUS_SCENE_RULE,
  VIDEO_NATURAL_PERFORMANCE_RULE,
  VIDEO_WORLD_SPACE_CAMERA_RULE,
  VIDEO_AI_SHOT_COVERAGE_RULE,
  VIDEO_CAMERA_SELECTION_RULE,
  VIDEO_MOTIVATED_LIGHTING_RULE,
  VIDEO_ACTING_CAMERA_FIELD_RULE,
  VIDEO_ACTING_CAMERA_REVIEW_RULE,
].join('\n\n');

/** Exact previous live bundle; compatibility only, never an extra rule. */
export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_3_7 = VIDEO_ACTING_CAMERA_RULES
  .split(VIDEO_AI_SHOT_COVERAGE_RULE).join(LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_3_7);

/** Exact previous live bundle retained only for request-time recognition. */
export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_1_0 = [
  VIDEO_NATURAL_PERFORMANCE_RULE, VIDEO_WORLD_SPACE_CAMERA_RULE,
  LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_1_0, LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_1_0,
  VIDEO_MOTIVATED_LIGHTING_RULE, LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V2_1_0,
  VIDEO_ACTING_CAMERA_REVIEW_RULE,
].join('\n\n');
export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_0_1 = LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_1_0
  .split(LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_1_0).join(LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_0_1);

export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_9 = LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_0_1
  .split(LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_1_0).join(LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_9);

/** Exact 1.8.8 combinations share unchanged camera text, with the original
 * interaction contracts restored only for recognizing old request blocks. */
export const LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_8 = VIDEO_WORLD_SPACE_CAMERA_RULE
  .split(VIDEO_INTERACTION_RULES).join(LEGACY_VIDEO_INTERACTION_RULES_V1_8_8);
export const LEGACY_VIDEO_ACTING_CAMERA_TRANSLATION_RULE_V1_8_8 = VIDEO_ACTING_CAMERA_TRANSLATION_RULE
  .split(VIDEO_INTERACTION_TRANSLATION_RULE).join(LEGACY_VIDEO_INTERACTION_TRANSLATION_RULE_V1_8_8);
export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_8 = LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_9
  .split(VIDEO_WORLD_SPACE_CAMERA_RULE).join(LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_8);

/** Exact 1.8.1 first-party text, composed with legacy dependencies. */

/**
 * Request-time directing instructions, shared by planning and AI review.
 * These are text contracts only: no local performance, spatial or story validator,
 * no rewriting of saved presets, and no video generation or media inspection.
 */
export const LEGACY_VIDEO_NATURAL_PERFORMANCE_RULE_V1_8_1 = '由你结合原剧情、人物关系、已知性格和当前信息，逐镜判断人物注意什么、为何反应、反应如何变化，把可见表演写入现有performance/action。身份与面容稳定不等于表情冻结，人物参考图的静态表情不是全片表情锁；沉着、克制或安静不等于面部和身体僵住。普通身份资料中的性格、动作习惯与“笑容明亮”“被某事后神色如常”等静态或条件式表情锚点只是角色参考，不是当镜必须执行的事件或全程固定表情，不把整份档案逐镜复制成动作命令。以当前段真实事件触发表演变化，档案里的条件只有当前剧情实际触发才适用，不把后段才发生的动作或后果提前，也不为丰富表情添加影响剧情的动作；保留原有角色身份与用户明确设定，不擅自改变年龄、衣着、外貌或已确认状态。只在剧情有依据且景别可读时，用视线、语气、姿态或动作节奏表达刺激后的理解、回应与自然回落，不要求每镜凑齐一套微动作。表演幅度和持续时间须符合情境与已选风格：原文有强烈喜悦、恐惧、愤怒等就保留，不能一律改成面无表情或微笑，也不能把普通交谈放大成长时间瞪眼、挑眉、咧嘴或夸张点头。说话者的口型和语气跟随自己的原话及停顿；倾听者依实际听到的信息维持注意或作出有依据的反应，不代说、不随别人的台词张口，也不把不说话写成紧咬嘴唇或全程木然。表情不随切镜机械重置，同一人物的反应阶段要接续；不强迫背影和远景展示不可见的面部细节，不为表演新增剧情事件、改变原有情绪走向或添加影响因果的人物动作，不指定固定眨眼频率、每秒表情次数或所有人物同步反应。';

export const LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_1 = [
  '先区分世界空间与镜头空间，再逐镜落实：世界空间记录起点、当前所在路段、目的地、地标相对位置、人物身体朝向与视线目标；镜头空间记录摄影机相对人物的位置、朝向、运动轨迹、轴线一侧及画面中的运动方向。行进路线和目的地不等于摄影机朝向，也不等于人物背后可见的背景。正面跟拍可以是摄影机位于人物前方并向后退拍，人物继续向目的地前进，不代表人物掉头或倒走；此时背景应来自人物身后、摄影机实际视野所及的路段，不能仅因人物将到达某地就把该目的地凭空换成背后背景。随真实行进、道路转折、空间包围或有交代的机位变化，背景可以合理改变，不把所有背景变化都判成错误。每次切镜核对景别、视线与地标的实际可见性，保持人物世界中的路线和同伴关系，不能只写“轴线一致”而让空间事实互相矛盾。需要变换正背面、机位侧别或屏幕运动方向时，用当前镜头内清楚的机位关系、可见摄影机运动、规划允许的衔接镜头或原文明确的转场建立关系；摄影机换位不等于人物转身，不为修复空间虚构掉头、瞬移、时间跳跃或新路线。未知布局可在规划时合理安排并持续承接，不能声称未知布局来自未见参考图。',
  LEGACY_SPATIAL_COORDINATE_RULE_V1_8_1,
  LEGACY_SPATIAL_CONTINUITY_REVIEW_RULE_V1_8_1,
  LEGACY_VIDEO_INTERACTION_RULES_V1_8_1,
].join('\n\n');

export const LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_1 = '镜数与覆盖方式由你先分析剧情信息、动作因果、对白回应、空间变化、情绪转折和可用时长后决定，不默认三镜、不为凑固定镜数机械等分，也不因每句对白或每个人物都必须露正脸而切镜。规划阶段在用户指定镜数或允许范围内，选择足以清楚表现当前剧情的镜头数量；自动模式按需要决定镜数与镜长，在规划JSON已有reason（保存后对应shotCountReason）和每镜purpose/transition说明具体依据，不新增JSON属性，也不只复述“电影感”。分段时长窗口不等于一个镜头：15秒可以包含多个有叙事动机的镜头，先安排完整对白区间、换人交接和必要动作，再选择覆盖方式，不先把每段做成一镜后硬塞全部事件。多人轮流接话时明确当前具名发话者和口型可见性，可采用关系构图、说话者中近景或单镜内有动机的关注转移；观察重点须与当前话轮和动作一致，不让后面的亲吻提前成为开场正在执行的焦点。一个连续镜头可以成立，有必要的信息揭示、反应或空间建立也可以拆镜，不为镜头多样性制造事件。选择建立空间、双人关系、侧面行进、背后跟随、主观观察或反应近景等覆盖方式须服务当前情节，不把这些例子变成每段必做清单；对白不自动等于正面面部近景，正面跟拍也不被一律禁止。转换、H3复核和翻译阶段若镜数与时间边界已经确认，则保留既定镜数、顺序和切点，在现有镜头内改善调度，不借自主导演之名重切整段或裁掉对白。';

export const LEGACY_VIDEO_CAMERA_SELECTION_RULE_V1_8_1 = '用户实际选择的cameraTerms及具体运镜要求是真实创作输入，不是可忽略的装饰；结合剧情逐镜判断它们适合表达什么，明确的必选或指定镜头要求按其范围遵守，普通多选偏好在适用镜头中合理分配。选择了多个效果不等于每镜同时叠加所有推拉、环绕、摇移或手持；不能把术语整串复制到所有镜头，也不能把用户选择全部丢掉再声称自主决定。未选择运镜时，仍由你按本镜信息目标自主选择固定、跟随或其他适合的拍法，不能回退为每镜固定同一种默认跟拍。每镜在现有camera写出景别、必要的机位/视角、固定或运动方式及其观察目标，在purpose或camera用简短可执行语句落实选择理由，transition交代有意义的切换依据；不只写“电影级运镜”“智能选择”或罗列术语。运动要有可理解的起止和目的，不无故为展示效果运动；不强制正脸覆盖，不把角色身份参考图当作必须朝镜头表演的构图命令。';

export const LEGACY_VIDEO_MOTIVATED_LIGHTING_RULE_V1_8_1 = '由你结合当前地点、时间、天气、可见或已知光源、材质及人物动作逐镜设计光影；用户选择的lightingTerms及明确光影要求应在适合的镜头中落实，而不是逐镜无差别堆叠。没有选择也要自主给出符合情境的具体光影，不能只写“电影感”。保持世界中的主光源方位和时间连续，人物或机位改变后，亮暗侧、逆光或侧光可随相对关系合理变化，不把每镜同一句“左侧光”当成光源连续。让脸部层次与动作、空间信息在所选风格和景别下可读，不用强行磨平五官或无依据戏剧光掩盖表演；原剧情需要阴影或强烈风格时照常保留。不凭空新增灯具、天气或昼夜变化，不强制固定色温数值或明暗比，在已有lighting及镜内光影文字表达有效安排和必要的连续性依据。';

export const LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V1_8_1 = '上述决定必须进入现有逐镜内容，不能只在总说明写“表情自然、轴线一致、AI自主运镜”。规划时使用现有purpose、action、performance、direction、space、camera、lighting、transition、result等shot字段，具体选择理由融入purpose/camera/transition，保持既有数据结构。六字段转换稿将表演放在主体/动作，将世界路线与机位关系放在空间/镜头，将光源和可见效果放在光影；H3稿将这些内容融入当前每个[Shot N]的现有段落。保持既有H3顶层section名称、顺序、参考标签和输出格式，时间切点保持已确认排程；仅本次指令明确授权taskAuthority=current-segment-staging-replan时，切点以同时交付的修正canonicalPrompt为准，用户固定段长与exact镜数仍不变。不新增表演审查、空间地图、运镜理由等H3顶层字段或附录，不输出内部推理链。';

export const LEGACY_VIDEO_ACTING_CAMERA_REVIEW_RULE_V1_8_1 = '提交前由同一AI对照当前段原文、人物资料、实际选择的运镜/光影、参考资料职责与完整候选稿自行复核并修复：表演是否有触发依据和自然变化，是否将克制误写成木偶或将普通对白写成持续夸张表情，说话者/倾听者是否分清，切镜是否重置反应；每镜的机位和视向是否确实能看到所写背景，人物是否仍沿既定世界路线行进，光源是否与空间一致；镜头是否重复怼正脸而漏掉信息或空间，所选运镜是否落实、有动机且不过度堆叠。发现问题直接在当前阶段允许的字段和边界内修正，保留身份、事件因果、原话、原说话人及当前段范围，不以新增转身、赶路事件或其他剧情来圆场；保留本来合理的强烈表演、固定镜头、正面跟拍和背景变化。复核修复后返回完整最终正文，不只给通过结论、问题清单或让用户手动修改。全部内容判断由AI完成，不增加本地语义拦截、关键词否决或表情/镜数配额，不要求先生成视频或重新运行收费视频来验证提示词。';

export const LEGACY_VIDEO_ACTING_CAMERA_TRANSLATION_RULE_V1_8_1 = [
  '英文翻译与其AI复核以已确认中文H3为唯一执行稿，忠实保留逐镜表演幅度、触发和回落、说话与倾听归属、世界路线、人物朝向、机位视向、可见背景、运镜目的及光源关系。不要把克制译成expressionless/rigid，不把自然回应强化为overacting；准确区分人物向目的地前进与摄影机向后退拍，不把人物前方目的地译为其背后背景。保留中文已经明确的强烈情绪或静止状态，不额外减弱或夸张。只修复翻译遗漏与歧义，不另作镜数、机位、剧情或光影设计，不改变H3 section、参考标签、[Shot N]和At切点，也不新增审核字段。',
  LEGACY_SPATIAL_TRANSLATION_RULE_V1_8_1,
  LEGACY_VIDEO_INTERACTION_TRANSLATION_RULE_V1_8_1,
].join('\n\n');

/** Translation adds its fidelity rule separately; it does not re-plan shots. */
export const LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_1 = [
  LEGACY_VIDEO_NATURAL_PERFORMANCE_RULE_V1_8_1,
  LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_1,
  LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_1,
  LEGACY_VIDEO_CAMERA_SELECTION_RULE_V1_8_1,
  LEGACY_VIDEO_MOTIVATED_LIGHTING_RULE_V1_8_1,
  LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V1_8_1,
  LEGACY_VIDEO_ACTING_CAMERA_REVIEW_RULE_V1_8_1,
].join('\n\n');

/** Remove known complete first-party blocks from request instructions only.
 * This never parses model answers, rewrites saved presets or rejects a task.
 * Consume the longest block at each position so shared legacy sub-blocks do
 * not alter a complete current block, and unchanged rules remain current. */
export const stripLegacyVideoActingCameraRules = (value: string): string => {
  const currentRules = [
    VIDEO_ACTING_CAMERA_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE,
    VIDEO_ACTING_CAMERA_PRESERVATION_RULES, VIDEO_CONTINUOUS_SCENE_RULE,
    VIDEO_WORLD_SPACE_CAMERA_RULE, VIDEO_NATURAL_PERFORMANCE_RULE,
    VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_CAMERA_SELECTION_RULE,
    VIDEO_MOTIVATED_LIGHTING_RULE, VIDEO_ACTING_CAMERA_FIELD_RULE,
    VIDEO_ACTING_CAMERA_REVIEW_RULE, STORYBOARD_SPATIAL_FRAME_RULE,
    STORYBOARD_FRAME_VISIBILITY_RULE, DIRECTED_ACTION_RELATION_RULE,
    SPATIAL_CONTINUITY_REVIEW_RULE, SPATIAL_TRANSLATION_RULE, SPATIAL_COORDINATE_RULE,
  ];
  const legacyRules = [
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_3_7,
    LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_3_7,
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_1_0,
    LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_1_0, LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_1_0,
    LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V2_1_0,
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_0_1,
    LEGACY_VIDEO_CAMERA_SELECTION_RULE_V2_0_1,
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_9,
    LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_9,
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_8,
    LEGACY_VIDEO_ACTING_CAMERA_TRANSLATION_RULE_V1_8_8,
    LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_8,
    LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_1,
    LEGACY_VIDEO_ACTING_CAMERA_TRANSLATION_RULE_V1_8_1,
    LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V1_8_1,
    LEGACY_VIDEO_NATURAL_PERFORMANCE_RULE_V1_8_1,
    LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V1_8_1,
    LEGACY_VIDEO_CAMERA_SELECTION_RULE_V1_8_1,
    LEGACY_VIDEO_MOTIVATED_LIGHTING_RULE_V1_8_1,
    LEGACY_VIDEO_ACTING_CAMERA_FIELD_RULE_V1_8_1,
    LEGACY_VIDEO_ACTING_CAMERA_REVIEW_RULE_V1_8_1,
    LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V1_8_1,
    LEGACY_STORYBOARD_FRAME_VISIBILITY_RULE_V1_8_1,
    LEGACY_DIRECTED_ACTION_RELATION_RULE_V1_8_1,
    LEGACY_SPATIAL_CONTINUITY_REVIEW_RULE_V1_8_1,
    LEGACY_SPATIAL_TRANSLATION_RULE_V1_8_1,
    LEGACY_SPATIAL_COORDINATE_RULE_V1_8_1,
  ];
  const candidates = [
    ...currentRules.map((text) => ({ text, preserve: true })),
    ...legacyRules.filter((text) => !currentRules.includes(text))
      .map((text) => ({ text, preserve: false })),
  ];
  const result: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let next: { text: string; preserve: boolean; index: number } | undefined;
    for (const candidate of candidates) {
      const index = value.indexOf(candidate.text, cursor);
      if (index < 0) continue;
      if (!next || index < next.index
        || (index === next.index && candidate.text.length > next.text.length)) {
        next = { ...candidate, index };
      }
    }
    if (!next) {
      result.push(value.slice(cursor));
      break;
    }
    result.push(value.slice(cursor, next.index));
    if (next.preserve) result.push(next.text);
    cursor = next.index + next.text.length;
  }
  return result.join('');
};
