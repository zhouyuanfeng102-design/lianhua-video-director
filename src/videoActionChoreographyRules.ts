import { stripLegacyVideoInteractionRules } from './videoInteractionRules';

/** Request-time action direction only. No local story grading, saved-preset
 * migration, output rewriting, extra API call, or video parameter changes. */
const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：结合本段原剧情与用户导演要求判断动作场面的实际强度。连续攻防、追逐、摔投或高频位移必须在镜内实际发生，不把已发生的战斗弱化为站立对峙、摆架势、准备出手、眼神交锋或只有音效的反应特写；普通交谈、轻微动作与原文明确的静止、蓄势、停顿仍照原意保留，不为增强动感把所有剧情改成武打。',
  '同一事件的可摄影展开不是新增剧情：原文只概述双方激烈交战时，在本次获准规划或生成的范围内，可以明确该次交战必要的起手、移动、攻防轨迹、招架或闪避、接触反馈与动作承接。人物、攻击意图、具名对象、武器、能力、已成立的先后、强度、伤情与结局是事实锁；不能凭空增加胜负、致死、断肢、受伤、新招式能力、新人物、新武器或另一场战斗。已有具体招式与结果按原文拍出来，不因套用常规打法替换。',
  '双人攻防写成互相作用的连续过程：明确谁从什么位置向哪位具名对象及哪个可见目标发起，攻击沿什么方向前进，对方怎样挡开、避让、接住或承受，真实接触如何改变双方的姿势、距离、重心或运动方向，下一动作怎样从当前状态接续。在现有镜内用清楚先后及必要的本段动作时间窗落实连续交换，不用“激烈打斗”概述代替过程，也不把每一拳都新增成At切点。落空就写实际避让和落空，格挡不等于命中，不能把未中写成击倒。选择当前动作必要的支撑、躯干传力、阻力、随动和恢复，避免只有手臂摆动、滑步、瞬移、碰撞后双方僵住或每招重新摆回起手式；不要求每招凑齐固定阶段。',
  '多人近身战斗按实际时序交代可辨的主要攻防关系、参与者方位和其他人的同步状态；换目标、交替夹击或连锁受力时明确具名行动者与对象，不把所有人写成同时扑向同一点或用“众人混战”替代已经成立的动作。可在同镜连续转换观察重点，不设每镜人数上限，不删除原文参与者；被遮挡或画外的动作按既有空间交代，不能凭摄影需要改变攻击来源或结果。',
  '摄影让实际动作可见：按招式和场景选择能读清双方距离、运动轨迹与接触点的景别、机位和必要跟随，在适用镜头保留全身或关键肢体的可见范围；并非每镜都必须全身，也不禁止原文需要的特写。复杂身体交互不要无动机地同时叠加急推、环绕、摇晃和遮挡，不用快速切脸、镜头震动、火花、慢动作或拟音替代真实攻防。原文或用户明确要求的慢动作、特写及风格化运镜保留，按其范围落实。',
  '动作节奏与时长由当前事件因果决定，不按每秒动作数、固定动作阶段、字数或最低镜数安排。没有叙事作用的反复蓄势、站立和慢推不要填满动作段；有依据的观察、喘息、停顿和收束保留。只在本次明确授权的源头规划或未确认新稿排程内调整镜长和覆盖：固定durationSec不变，exact镜数不变，auto才可在授权范围改变镜数；同步canonicalPrompt与H3及相关时间字段。已确认切点、参考更新、衔接、翻译或纯格式修复不因本规则获得重新导演权限。完整原对白、原语言、具名声源和口部互斥动作保持，不靠抢话或删句腾出动作时间。',
  '物理与风格服从原剧情：写实战斗保留可见支撑、惯性与接触反馈；武侠、仙侠、动漫、超能力或非人角色按原文及已选风格表达已有的飞行、轻功、能量和身体结构，不将明确幻想能力强改成现实限制，也不凭“激烈”补出未设定能力。参考图只提供其实际身份、服装、场景或构图职责，不锁住静态姿势；动作参考仅使用本次真实提供且接口实际接收的素材，不虚构Video或Picture引用。',
  '在本次已有回答内部核对并修复动作遗漏：行动者、目标、进攻与回应、命中或落空、可见受力、位移、下一动作和结果是否沿同一事件推进；声音贴合真实动作，不靠声音冒充动作。保留本来准确的动作与剧情，不为了丰富而加招。规划使用现有action、space、direction、performance、camera、transition、result字段；普通转换继续现有六字段格式；H3只把内容融入对应[Shot N]的integrated_multimodal_description或detailed_description。保持既有三字段或full-reference六字段模式、字段名称顺序、Subject/Picture/Video/Audio标签、S声源、<d>与原对白；首镜无At、后镜At切点按本次合法排程，不新增combat_plan、action_sequence、negative_prompt、审核说明、规则正文或附录。不增加独立审核调用，不要求先运行视频，不用本地关键词拦截判断动作好坏。',
].join('\n\n');

const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_PRESERVE_V1：本次处理已有稿或纯格式/序列化修复，不是新动作导演。以当前已确认正文或本次明确的修复候选为依据，忠实保留逐镜行动者、具名对象、攻防轨迹、连续速度、接触与落空、受力位移、幻想能力、动作承接及结果；不将连续动作弱化成站立对峙、摆架势或准备攻击，也不为增强动感补出原稿没有的招式、人物、武器、能力、伤情或胜负。',
  '只修本次任务授权的内容：参考更新只改参考职责及必要可见事实，衔接只改授权的短开场接力与受影响状态，人物资料更新只改对应身份资料，纯格式/元数据/序列化修复只恢复可读取结构及已确认内容。对白排程修复可按原有taskAuthority调整已有动作的时间关系，但不得借此新增战斗编排。其他镜头、动作、摄影、对白、声音、固定段长和exact镜数保持；没有本次明确授权就不改变已确认镜界和At切点。',
  '保持现有普通六字段或H3三字段/full-reference六字段格式及字段顺序、[Shot N]、首镜无At、递增切点、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与原对白，不增加动作计划、反向提示词或审核附录。不在结果里复制规则，不新增模型调用、参数调整、本地语义门禁或历史稿自动改写。',
].join('\n\n');

const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_TRANSLATE_V1：英文翻译及其复核、格式/元数据修复以已确认中文sourcePrompt为唯一执行稿，只保真，不重新导演。逐镜保留具名攻击者与对象、身体/武器运动方向、攻击与挡闪先后、命中或落空、接触点、受力位移、连续速度、动作承接和结果；保持已有幻想能力与物种身体结构，不把武侠或风格化动作改成普通现实限制。',
  '准确翻译已经发生的动作，不能将连续攻防改为poses、stands ready、prepares to attack或moves slightly等准备/微动概述；原稿确实只准备、静止、慢动作或停顿时仍忠实保留，不额外强化。不补新招式、伤情、胜负、人物、武器、能力、摄影设计或声音，不从旧shots重新编排动作。修复仅针对译文遗漏、歧义及可读取格式，不替中文稿另设计战斗。',
  '普通六字段与H3三字段/full-reference六字段各保持原格式、字段顺序、[Shot N]、首镜无At、所有At切点和段内动作时间、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与逐字对白。参考图身份和静态构图不替代动作，不虚构动作视频引用；无依据的动作问题只保留原稿，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
].join('\n\n');

/** Model-independent facts. Target writers supply their own delivery format. */
const LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1 = [
  'VIDEO_ACTION_CAUSALITY_V1：按当前事件实际强度表现连续攻防、追逐、摔投与位移，不把已经发生的行动弱化为站立对峙、摆架势、准备攻击、反应特写或只有音效。原文确实交谈、静止、蓄势或停顿时忠实保留，不把所有剧情改成武打。',
  '行动者、具名对象、武器、能力、已有招式、方向、先后、命中或落空、伤情与结局是事实锁。原文概括交战时可在当前获准的同一事件内表达必要的攻防承接与接触反馈，不能新增人物、武器、能力、胜负或另一场战斗。落空不是命中，格挡不是击倒。多人动作交代主要攻防关系与其他参与者同步状态，不限人数、不删除参与者。',
  '接触真实改变姿势、距离、重心或运动方向，下一动作从当前状态继续，不反复恢复起手式。写实动作保留支撑、惯性与受力；武侠、动漫、超能力和非人角色服从已有风格、能力与身体结构，不凭激烈补造能力，也不强改成现实限制。',
  '摄影为动作可读性服务，按原有设计保持必要的肢体、攻击路径和接触点可见；不靠切脸、火花、镜头震动或拟音替代真实动作。完整原对白、原语言、具名声源、口部互斥动作与无对白区间保留，不删句、不抢话腾时间。参考身份和静态构图不锁定动态姿势，动作参考只用真实提供且实际接口接收的素材。',
].join('\n\n');

const LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1 = [
  ...LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1.split('\n\n').slice(0, 2),
  '保持 Seedance 自然语言章节、连续时间轴、全部已确认起止时间、段长、镜数、实际 @Image/@Video/@Audio/@Clay Render 编号、具名声源和逐字原语言对白。图像身份与静态构图不替代动作，不虚构动作参考，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
].join('\n\n');

/** Shared story-to-action direction. These are instructions for the existing
 * writer, not a new schema, semantic gate, or later output-repair pass. */
const LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_1 = [
  '先理解事件，再写可摄影的行动：完整阅读本次提供的本段原剧情、sourceStoryContent及只读理解上下文，理解人物意图、实际施力关系、先后和结果。canonicalPrompt、semanticSource与结构化分镜是同一事件的表达或理解证据；旧稿省略对象或写成地标方向时，不能覆盖原剧情中明确的行动关系。不能照搬“猛然踢飞”“狠狠甩出”“怒气冲天”“如炮弹一般”等小说概述，让视频模型自行猜测谁做了什么；只把已有事件展开成必要的可见行为。',
  '分别确定并在当前正文表达“具名施力者 → 直接受力对象及必要接触部位 → 最终具名目标或终点 → 对方回应与事件结果”。被踢或被抛的物体是直接受力对象，被物体袭向的人是最终目标，两者不能混写；直接攻击人物时二者可以是同一人。门口、墙、地面等可能是人物所在位置、支撑点或运动路径地标，不能因此替代原剧情的受力对象或具名目标。可用通用关系理解踢物、投掷、抓握、推拉、递接、追击、注视、武器接触与多人动作；不为不适用的动作硬套受力链。',
  '根据已有动作选择足以看懂的身体行为：起始姿态与物体位置、支撑脚或支撑手、发力肢体、必要的躯干传力、接触部位、运动方向，以及随动或结束姿态。支撑脚踩地借力与另一只脚踢中物体是不同作用，写明分别做什么，不能只写“战靴踩地，物体飞出”。原来静止的受力物在接触或原剧情明确的驱动力发生前保持静止，接触后才因这一动作改变速度与方向；不能跳过接触让物体自行飞走。武器、远程作用、飞行、能量和非人身体结构按照原设能力呈现，原剧情明确的非接触施力不强改为碰撞；不得凭修辞补造能力。只选当前动作必要的支撑、阻力和反馈，不要求所有动作都凑齐同一套力学阶段。',
  '把接触、运动与回应组织为同一事件的连续过程：明确是谁的哪一肢体或武器作用于谁/哪一物体的哪个部位，受力物从哪里沿什么路径运动，对方在何时挡、接、退、闪或承受，结束时人物与物体在哪里。落空就保留避让和落空，格挡不等于命中，不能把未中写成击倒；物体被避开后按已建立的方向继续，除非原设能力明确改变路径，不能自动追踪目标。下一动作从真实的结束姿态、握持状态与距离继续，不每招恢复起手式。多人换目标、递接、夹击与连锁受力使用稳定姓名分别交代主要关系及其他参与者的同步状态，不删人、不限每镜人数，也不让所有人无因扑向同一点。',
  '同一连续场景先建立人物、物体、固定地标和主交互轴线的世界关系，再沿动作继承：只有实际转身、行进、受力位移或剧情明确的换场/跳时才改变位置。摄影机换位、裁切、反打和画面左右变化不能让人物瞬移、重排攻防位置、交换身体侧别，或把具名目标改成摄影机、画面前方、门或墙。目标在画外时沿用其已建立的具名位置与路径，不为了展示目标把其搬入镜头。未知站位可在本次获准规划或新稿生成内安排一种符合剧情的关系并继续承接，不每镜重新摆放，不机械固定人物永远在同一画面侧。',
  '摄影服务于动作辨认：按当前事件选择能看清发力肢体、直接受力对象、必要接触点与通向最终目标路径的景别、机位和跟随。关键接触与启动后的运动尽量在现有同一镜内连续呈现；剧情或已有镜界需要切镜时，从上一镜物体位置、运动方向、速度与人物状态接续，不在另一镜让物体无因重新出现或换向。优先让观众看懂行动关系，再按叙事安排表情或局部特写；并非每镜都必须全身，也不禁止原文需要的特写。复杂交互不无动机叠加急推、环绕、摇晃和遮挡，不以切脸、镜头震动、火花、慢动作或拟音代替真实行为；原文或用户明确要求的风格化摄影照范围保留。',
  '心理、修辞与意图按剧情转成有依据的表演：通过视线落点、表情、呼吸、姿态和已发生的行动表达，不把人物的内心猜测当成新事件，也不靠“迅猛”“如雷霆”代替接触与位移。人物、意图、具名对象、武器、能力、已成立的先后、强度、伤情和结局是事实锁；同一事件的可摄影展开不是新增剧情，但不能凭空加招式、胜负、受伤、人物、武器或另一事件。原来交谈、观察、静止、蓄势、轻微动作与停顿仍保留，不把所有剧情改成武打。完整原对白、原语言、具名声源和口部互斥动作保持，不删句、不抢话腾时间；参考图只提供实际身份、服装、场景或构图职责，不锁住静态姿势，动作参考只使用真实提供且接口实际接收的素材。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：本次源头规划或新稿生成由你理解剧情并展开具体动作，不将小说概述照抄为视频指令。连续攻防、追逐、摔投或高频位移必须在镜内实际发生，不把已发生的行动弱化为站立对峙、摆架势、准备出手、眼神交锋或只有音效的反应特写。',
  LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_1,
  '动作节奏与时长由当前事件因果决定，不按每秒动作数、固定动作阶段、字数或最低镜数安排。不用“激烈打斗”概述代替过程，也不把每一拳都新增成At切点。没有叙事作用的反复蓄势、站立和慢推不要填满动作段；有依据的观察、喘息、停顿和收束保留。只在本次明确授权的源头规划或未确认新稿排程内调整镜长和覆盖：固定durationSec不变，exact镜数不变，auto才可在授权范围改变镜数；同步canonicalPrompt与H3及相关时间字段。已确认切点、参考更新、衔接、翻译或纯格式修复不因本规则获得重新导演权限。',
  '动作理解直接融入本次已有回答：规划使用现有action、space、direction、performance、camera、transition、result字段；普通转换继续现有六字段格式；H3只把内容融入对应[Shot N]的integrated_multimodal_description或detailed_description。保持既有三字段或full-reference六字段模式、字段名称顺序、Subject/Picture/Video/Audio标签、S声源、<d>与原对白；首镜无At、后镜At切点按本次合法排程，不新增combat_plan、action_sequence、negative_prompt、审核说明、规则正文或附录。不增加独立审核调用，不要求先运行视频，不用本地关键词拦截判断动作好坏。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_PRESERVE_V1：本次处理已有稿或纯格式/序列化修复，不是新动作导演。以当前已确认正文或本次明确的修复候选为依据，忠实保留逐镜施力者、直接受力对象及接触部位、最终具名目标或终点、对方回应、动作先后与结果。支撑/借力肢体和实际发力接触肢体的不同作用、物体接触后才启动的因果、已有身体/武器轨迹、连续速度、落空、受力位移、世界站位与动作承接保持；地面或门墙地标不能替代正文已确认的受力物和目标。保留幻想能力与物种结构，不把连续行动弱化为摆架势或准备攻击，也不为增强动感补出原稿没有的动作、接触、姿态、人物、武器、能力、伤情或胜负。',
  '只修本次任务授权的内容：参考更新只改参考职责及必要可见事实，衔接只改授权的短开场接力与受影响状态，人物资料更新只改对应身份资料，纯格式/元数据/序列化修复只恢复可读取结构及已确认内容。对白排程修复可按原有taskAuthority调整已有动作的时间关系，但不得借此新增战斗编排。其他镜头、动作、摄影、对白、声音、固定段长和exact镜数保持；没有本次明确授权就不改变已确认镜界和At切点。不借原剧情或旧shots补写当前已确认稿未表达的新动作，缺失展开留待获准源头规划或新稿生成。',
  '保持现有普通六字段或H3三字段/full-reference六字段格式及字段顺序、[Shot N]、首镜无At、递增切点、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与原对白，不增加动作计划、反向提示词或审核附录。不在结果里复制规则，不新增模型调用、参数调整、本地语义门禁或历史稿自动改写。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_1 = [
  'VIDEO_ACTION_CHOREOGRAPHY_TRANSLATE_V1：英文翻译及其复核、格式/元数据修复以已确认中文sourcePrompt为唯一执行稿，只保真，不重新导演。逐镜准确保留具名施力者、直接受力对象与接触部位、最终具名目标或终点、对方回应及结果；踢/抛的物体与袭向的人是不同角色，地面借力、门口位置和墙体地标不能替代受力对象或具名目标。明确保留中文已写的支撑脚/手与发力脚/手各自作用、接触先发生而受力物随后运动的因果、身体/武器方向、挡闪先后、命中或落空、受力位移、连续速度、世界站位与动作承接；摄影机切换不重排人物和目标。保持已有幻想能力与物种身体结构，不把武侠或风格化动作强改成普通现实限制。',
  '准确翻译已经发生的动作，不能将连续攻防改为poses、stands ready、prepares to attack或moves slightly等准备/微动概述，也不以toward the door等地标方向省略已写的具名目标；原稿确实只准备、静止、慢动作或停顿时仍忠实保留，不额外强化。不补中文未写的新动作、姿态、接触、支撑/发力侧别、时间、招式、伤情、胜负、人物、武器、能力、摄影设计或声音，不从原剧情或旧shots重新编排动作。修复仅针对译文遗漏、歧义及可读取格式，不替中文稿另设计行动；中文缺少的可摄影展开留待获准中文新稿生成，翻译无权补写。',
  '普通六字段与H3三字段/full-reference六字段各保持原格式、字段顺序、[Shot N]、首镜无At、所有At切点和段内动作时间、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与逐字对白。参考图身份和静态构图不替代动作，不虚构动作视频引用；无依据的动作问题只保留原稿，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
].join('\n\n');

/** Model-independent facts. Target writers supply their own delivery format. */
export const LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_1 = [
  'VIDEO_ACTION_CAUSALITY_V1：在本次获准规划或新稿生成内先理解原剧情的行动事件，再将其展开成可辨的连续动作；按当前事件实际强度表现攻防、追逐、摔投与位移，不把已经发生的行动弱化为站立对峙、摆架势、准备攻击、反应特写或只有音效。',
  LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_1,
  '动作在目标写作格式的现有正文和时间轴内表达，不新增动作schema或规则附录。保持当前固定段长、exact镜数及已确认边界，只有当前授权的规划范围允许安排镜头覆盖；不增加审核调用、参数调整、本地语义门禁或历史改写。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_1 = [
  ...LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_1.split('\n\n').slice(0, 2),
  '保持 Seedance 自然语言章节、连续时间轴、全部已确认起止时间、段长、镜数、实际 @Image/@Video/@Audio/@Clay Render 编号、具名声源和逐字原语言对白。图像身份与静态构图不替代动作，不虚构动作参考，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
].join('\n\n');

/** One directing order for the existing writer. The legacy blocks above stay
 * exact so an old built-in request cannot compete with the current scope. */
const VIDEO_ACTION_EVENT_UNDERSTANDING = [
  '先理解本段原剧情和只读上下文中的真实事件，再写可摄影的连续行动。先锁定具名行动者、对手或受力物、武器与能力、意图、已有招式、先后、命中或落空、伤情与结果，再安排怎样拍出来；canonicalPrompt、semanticSource和旧镜头计划是理解证据，不能用旧稿缺失的目标或停顿覆盖原文明确的持续追击。用户已修改正文时采用当前正文，不恢复旧原文已被删改的内容。',
  '小说省略的可摄影过程由你在本次获准规划或中文新稿内补足，而不是逐字照搬后让视频模型猜测。原文概述激烈交战、突袭或连续攻防时，可以安排同一次已成立交战所需的起始姿态、步法、接近路线、攻击落点、武器轨迹、挡闪与接触、传力和恢复；已有具体招式与结果照原意展开。补足这些动作细节不等于新增剧情，但不能另加攻击次数、胜负、受伤、致死、新人物、新武器、未设定能力或另一事件。原来交谈、观察、静止、蓄势和停顿仍照原意保留，不把所有剧情变成武打。',
  '每镜按当前事件写清“双方进入关系 → 真实移动与接近 → 攻击接触或落空及对方回应 → 双方退出关系”。这是理解与写作顺序，不是固定四拍或新增字段；阶段可按真实动作重叠，只表达当前事件需要的内容。具名写出进攻者从哪里以什么姿态向哪位对手的哪个部位进攻，防守者当时在哪里、怎样退避或迎击。原文仍在倒飞、后退或闪避的对手保持移动，追击者沿其退避路径追上并进入武器够及范围；不要只写远处站位和后来兵刃相撞而省略中间的接近，也不要无依据把移动防守改成落地站定或长时间僵持。',
  '两个人的动作在同一时间关系中相互作用，不能写成各自向前挥舞的独立展示。交代进攻者的哪一肢体或武器沿哪条轨迹攻向具名对手、对手何时以哪一部位或武器挡、接、退、闪或承受，真实接触点与接触后的双方位移。对手在画外时仍沿用其具名方位和路径，不把攻击目标泛化成前方、门墙或摄影机。多人换目标、夹击和连锁受力分别交代主要攻防与其他参与者的同步状态，不删除原文参与者或让所有人无因扑向同一点。',
  '按当前招式选择必要的支撑、重心变化、髋与躯干带动、发力肢体、接触阻力、随动与卸力，使速度有可见的变化和来源。迅猛动作可以是短促蹬地加速、躯干带动兵刃、被挡后偏转或回弹，再借已有余势接下一招；不能靠连续写“极速、巨力、如雷霆”替代轨迹，也不把准备、接触和恢复都演成匀速摆臂或每招重新摆架势。下一招从上一招实际结束的握持、姿态、支撑与距离接续，原文连击不插入无依据的收势等待；原文有停顿仍保留。只选择所需过程，不给所有动作套同一套阶段、固定步数、米数、力量或每秒招数。幻想速度、飞行、能量和非人结构按已有能力与风格呈现，不能凭修辞加造能力，也不强改为普通人的现实速度。',
  '直接受力对象和最终目标分别表达。踢物或投掷写出“具名施力者 → 脚、手或武器实际接触的物体及部位 → 物体的运动路径 → 袭向的具名对象或真实终点 → 对方回应与结果”。支撑脚蹬地与发力脚踢中物体是不同作用，静止物体在接触或原设驱动力前保持静止，接触后才启动。武器攻击伴随切裂墙地、碎石或火花时，先写攻向对手的同一轨迹，再交代沿途附带的环境破坏，不把主事件改成先劈墙、砸地、朝镜头挥舞而对手只在身后旁观；原剧情本就攻击环境时照原意保留。非接触施力按已设能力表达，不强加碰撞。',
  '格挡、命中和落空各自保持原结果：格挡写清武器怎样截住或偏转来袭，落空写清对方避开的方向及兵刃或物体随后沿既有方向继续，不把未中写成击倒或让物体自行追踪。接触反馈改变双方当前重心、姿势、距离或运动方向，后续动作和下一镜继承这些末态；摄影机换位、裁切和反打改变观察，不重排人物、交换身体侧别或把对手搬到进攻者身后。',
  '先让观众辨认双方、具名目标、发力肢体、必要接触点与运动路径，再安排本次已选风格、表情、光影、火花与运镜。关键进攻与回应尽量在现有同一镜内连续可读，已有镜界需要切换时直接从上一镜的动作阶段、速度、位置和距离接续。动作事实写进每个对应镜头，不能仅在开头宣布“激烈战斗、轴线一致”；不靠切脸、震动、慢动作或拟音替代动作，不虚构参考素材。完整原对白、原语言、具名声源和口部互斥动作保持，参考图按真实身份、场景或构图职责使用，不继承身份图朝观众展示的静态姿势。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：本次源头规划或中文新稿生成由你把剧情理解转成可执行的双方连续动作，先写交互关系与进退接触，再写摄影与风格，不让视频模型自行补猜小说省略的过程。',
  VIDEO_ACTION_EVENT_UNDERSTANDING,
  '动作节奏与可用时长服从真实事件，连续交战不靠反复蓄势、站立、慢推填时；有依据的观察、喘息、停顿和收束保留。不按字数、固定动作阶段、每秒招数或最低镜数编排，也不把每次碰撞新增成At切点。只在当前授权的规划或未确认新稿内安排覆盖；固定durationSec和exact镜数保持，auto才可按当前授权调整镜数。已确认稿、参考更新、衔接、翻译和纯格式修复没有新的动作编排权限。',
  '直接在本次已有回答写出结果：规划使用现有action、space、direction、performance、camera、transition、result，result交代双方镜尾位置、姿态、运动阶段、间距和武器状态中下一镜需要继承的内容，不能只给形容词或空白让下镜重新摆放。普通转换沿用六字段；H3把同一事件、目标、移动接触与末态融入对应[Shot N]的现有正文。同步canonicalPrompt与H3及相关时间，保持已有section、参考标签、S声源、<d>、原对白和本次合法切点。不新增动作schema、combat_plan、action_sequence、negative_prompt、规则附录或审核报告，不增加独立模型调用、本地语义效验、拦截、重试或收费视频测试，不改历史存稿。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_PRESERVE_V1：本次处理已确认稿或纯格式/序列化修复，以当前已确认正文或明确修复候选为依据忠实保留，不重新编排动作。逐镜保持具名施力者、直接受力对象与接触部位、最终目标、双方进入关系、实际接近或退避、接触或落空、各自回应和退出关系。已有步法、身体与武器轨迹、阶段速度、支撑传力、被挡偏转、随动恢复、下一招承接及环境破坏的附带职责保留；摄影机切换不重排人物、目标、身体侧别或真实距离。',
  '只修本次授权的参考职责、短开场衔接、人物资料、已有对白排程或可读取格式；不借新动作规则、原小说或旧shots补写当前已确认稿未表达的步法、接触、攻防、姿态、伤情、胜负或机位。缺失的动作展开留待用户授权中文新稿或源头规划，不能自动改历史稿。其他镜头、已有幻想能力与物种结构、固定段长、exact镜数、确认切点、逐字原对白和声音保持。',
  '保持普通六字段、H3三字段或full-reference六字段及原有section、[Shot N]、At切点、Subject/Picture/Video/Audio标签、S声源与<d>；不输出规则或审核附录，不新增模型调用、参数调整、本地动作效验、拦截或重试。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_TRANSLATE_V1：英文翻译及其复核、格式/元数据修复只保真已确认中文sourcePrompt，不重新导演。逐镜保留具名施力者、直接受力对象及接触部位、最终目标、双方进入关系、实际接近与退避、进攻轨迹和对方同时的挡闪、接触或落空、受力反馈、各自退出关系。准确保持中文已写的支撑/发力侧别、阶段速度、被挡偏转与随动、上一招末态接下一招、物体接触后启动的因果、环境破坏附属于攻向对手的同一轨迹以及真实幻想能力和身体结构。摄影机跟随或切换不转化为人物改目标、追着镜头转身或瞬间换位。',
  '具体攻击目标仍用源稿的稳定姓名和对应标签表达，不把已写对手泛化成forward、toward the corridor、camera或the audience；分清向具名对手攻击和沿途切裂墙地，保持追击与退避共同发生，不能把移动中的对手译成stands still或把连续攻击译成poses、stands ready、prepares to attack。源稿本来确实静止、蓄势、慢动作或停顿时仍照实保留。不补中文未写的步法、姿态、接触、速度阶段、时间、招式、伤情、胜负、摄影或声音，不从原小说、旧shots或场地资料另编；缺失展开留待获准中文新稿，英译无权补写。',
  '保持普通六字段、H3三字段或full-reference六字段、原section顺序、[Shot N]、首镜无At、全部At切点与段内动作时间、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与逐字对白。参考身份和静态构图不替代动作，不虚构动作素材，不新增动作schema、规则附录、审核调用、参数调整、本地语义效验、拦截或重试。',
].join('\n\n');

/** Target writers supply their own existing delivery format. */
export const VIDEO_ACTION_CAUSALITY_RULE = [
  'VIDEO_ACTION_CAUSALITY_V1：在本次获准规划或中文新稿生成内理解真实事件，补足同一次交战所需的连续双方动作，不照搬小说概述；按实际强度表现攻防、追逐和位移，原文的静止、停顿和非战斗事件仍保留。',
  VIDEO_ACTION_EVENT_UNDERSTANDING,
  '在目标格式现有正文和时间轴写出每镜双方的进入、移动、接触或落空与退出，不新增动作schema或规则附录。保持固定段长、exact镜数和确认边界，只有当前授权规划范围可安排镜头覆盖；不增加审核调用、参数调整、本地语义效验、拦截、重试或历史改写。',
].join('\n\n');

export const VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE = [
  ...VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE.split('\n\n').slice(0, 2),
  '保持 Seedance 自然语言章节、连续时间轴、全部确认起止时间、段长、镜数、实际 @Image/@Video/@Audio/@Clay Render 编号、具名声源和逐字原语言对白。图像身份与静态构图不替代动作，不虚构动作参考，不增加动作schema、规则附录、审核调用、参数调整、本地语义效验、拦截或重试。',
].join('\n\n');

export type VideoActionChoreographyScope = 'planning' | 'generation' | 'existing' | 'translation' | 'format-only';

export const videoActionChoreographyRuleForScope = (scope: VideoActionChoreographyScope): string => (
  scope === 'translation' ? VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE
    : scope === 'planning' || scope === 'generation' ? VIDEO_ACTION_CHOREOGRAPHY_RULE
      : VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE
);

/** Strip only these complete first-party rule blocks. User additions and
 * saved presets are never rewritten, and output prose is never passed here. */
export const withVideoActionChoreographyScope = (systemPrompt: string, scope: VideoActionChoreographyScope, targetFormat?: 'seedance'): string => {
  // Longest complete blocks first: Seedance and ordinary translation share a
  // prefix, which must never be stripped independently from a user addition.
  const firstPartyBlocks = [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
    VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE, VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE, VIDEO_ACTION_CAUSALITY_RULE,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1, LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1, LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1,
    LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1, LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_1,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_1,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_1,
    LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_1,
    LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_1].sort((a, b) => b.length - a.length);
  const preservedSystem = firstPartyBlocks.reduce((value, rule) => value.split(rule).join(''),
    stripLegacyVideoInteractionRules(systemPrompt)).trim();
  return [preservedSystem, targetFormat === 'seedance' && scope === 'translation'
    ? VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE : videoActionChoreographyRuleForScope(scope)].filter(Boolean).join('\n\n');
};
