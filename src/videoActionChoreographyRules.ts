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
/** Exact 1.8.8 blocks remain recognizable in saved first-party presets. */
const LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8 = [
  '先理解本段原剧情和只读上下文中的真实事件，再写可摄影的连续行动。先锁定具名行动者、对手或受力物、武器与能力、意图、已有招式、先后、命中或落空、伤情与结果，再安排怎样拍出来；canonicalPrompt、semanticSource和旧镜头计划是理解证据，不能用旧稿缺失的目标或停顿覆盖原文明确的持续追击。用户已修改正文时采用当前正文，不恢复旧原文已被删改的内容。',
  '小说省略的可摄影过程由你在本次获准规划或中文新稿内补足，而不是逐字照搬后让视频模型猜测。原文概述激烈交战、突袭或连续攻防时，可以安排同一次已成立交战所需的起始姿态、步法、接近路线、攻击落点、武器轨迹、挡闪与接触、传力和恢复；已有具体招式与结果照原意展开。补足这些动作细节不等于新增剧情，但不能另加攻击次数、胜负、受伤、致死、新人物、新武器、未设定能力或另一事件。原来交谈、观察、静止、蓄势和停顿仍照原意保留，不把所有剧情变成武打。',
  '每镜按当前事件写清“双方进入关系 → 真实移动与接近 → 攻击接触或落空及对方回应 → 双方退出关系”。这是理解与写作顺序，不是固定四拍或新增字段；阶段可按真实动作重叠，只表达当前事件需要的内容。具名写出进攻者从哪里以什么姿态向哪位对手的哪个部位进攻，防守者当时在哪里、怎样退避或迎击。原文仍在倒飞、后退或闪避的对手保持移动，追击者沿其退避路径追上并进入武器够及范围；不要只写远处站位和后来兵刃相撞而省略中间的接近，也不要无依据把移动防守改成落地站定或长时间僵持。',
  '两个人的动作在同一时间关系中相互作用，不能写成各自向前挥舞的独立展示。交代进攻者的哪一肢体或武器沿哪条轨迹攻向具名对手、对手何时以哪一部位或武器挡、接、退、闪或承受，真实接触点与接触后的双方位移。对手在画外时仍沿用其具名方位和路径，不把攻击目标泛化成前方、门墙或摄影机。多人换目标、夹击和连锁受力分别交代主要攻防与其他参与者的同步状态，不删除原文参与者或让所有人无因扑向同一点。',
  '按当前招式选择必要的支撑、重心变化、髋与躯干带动、发力肢体、接触阻力、随动与卸力，使速度有可见的变化和来源。迅猛动作可以是短促蹬地加速、躯干带动兵刃、被挡后偏转或回弹，再借已有余势接下一招；不能靠连续写“极速、巨力、如雷霆”替代轨迹，也不把准备、接触和恢复都演成匀速摆臂或每招重新摆架势。下一招从上一招实际结束的握持、姿态、支撑与距离接续，原文连击不插入无依据的收势等待；原文有停顿仍保留。只选择所需过程，不给所有动作套同一套阶段、固定步数、米数、力量或每秒招数。幻想速度、飞行、能量和非人结构按已有能力与风格呈现，不能凭修辞加造能力，也不强改为普通人的现实速度。',
  '直接受力对象和最终目标分别表达。踢物或投掷写出“具名施力者 → 脚、手或武器实际接触的物体及部位 → 物体的运动路径 → 袭向的具名对象或真实终点 → 对方回应与结果”。支撑脚蹬地与发力脚踢中物体是不同作用，静止物体在接触或原设驱动力前保持静止，接触后才启动。武器攻击伴随切裂墙地、碎石或火花时，先写攻向对手的同一轨迹，再交代沿途附带的环境破坏，不把主事件改成先劈墙、砸地、朝镜头挥舞而对手只在身后旁观；原剧情本就攻击环境时照原意保留。非接触施力按已设能力表达，不强加碰撞。',
  '格挡、命中和落空各自保持原结果：格挡写清武器怎样截住或偏转来袭，落空写清对方避开的方向及兵刃或物体随后沿既有方向继续，不把未中写成击倒或让物体自行追踪。接触反馈改变双方当前重心、姿势、距离或运动方向，后续动作和下一镜继承这些末态；摄影机换位、裁切和反打改变观察，不重排人物、交换身体侧别或把对手搬到进攻者身后。',
  '先让观众辨认双方、具名目标、发力肢体、必要接触点与运动路径，再安排本次已选风格、表情、光影、火花与运镜。关键进攻与回应尽量在现有同一镜内连续可读，已有镜界需要切换时直接从上一镜的动作阶段、速度、位置和距离接续。动作事实写进每个对应镜头，不能仅在开头宣布“激烈战斗、轴线一致”；不靠切脸、震动、慢动作或拟音替代动作，不虚构参考素材。完整原对白、原语言、具名声源和口部互斥动作保持，参考图按真实身份、场景或构图职责使用，不继承身份图朝观众展示的静态姿势。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_8 = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：本次源头规划或中文新稿生成由你把剧情理解转成可执行的双方连续动作，先写交互关系与进退接触，再写摄影与风格，不让视频模型自行补猜小说省略的过程。',
  LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8,
  '动作节奏与可用时长服从真实事件，连续交战不靠反复蓄势、站立、慢推填时；有依据的观察、喘息、停顿和收束保留。不按字数、固定动作阶段、每秒招数或最低镜数编排，也不把每次碰撞新增成At切点。只在当前授权的规划或未确认新稿内安排覆盖；固定durationSec和exact镜数保持，auto才可按当前授权调整镜数。已确认稿、参考更新、衔接、翻译和纯格式修复没有新的动作编排权限。',
  '直接在本次已有回答写出结果：规划使用现有action、space、direction、performance、camera、transition、result，result交代双方镜尾位置、姿态、运动阶段、间距和武器状态中下一镜需要继承的内容，不能只给形容词或空白让下镜重新摆放。普通转换沿用六字段；H3把同一事件、目标、移动接触与末态融入对应[Shot N]的现有正文。同步canonicalPrompt与H3及相关时间，保持已有section、参考标签、S声源、<d>、原对白和本次合法切点。不新增动作schema、combat_plan、action_sequence、negative_prompt、规则附录或审核报告，不增加独立模型调用、本地语义效验、拦截、重试或收费视频测试，不改历史存稿。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_8 = [
  'VIDEO_ACTION_CHOREOGRAPHY_PRESERVE_V1：本次处理已确认稿或纯格式/序列化修复，以当前已确认正文或明确修复候选为依据忠实保留，不重新编排动作。逐镜保持具名施力者、直接受力对象与接触部位、最终目标、双方进入关系、实际接近或退避、接触或落空、各自回应和退出关系。已有步法、身体与武器轨迹、阶段速度、支撑传力、被挡偏转、随动恢复、下一招承接及环境破坏的附带职责保留；摄影机切换不重排人物、目标、身体侧别或真实距离。',
  '只修本次授权的参考职责、短开场衔接、人物资料、已有对白排程或可读取格式；不借新动作规则、原小说或旧shots补写当前已确认稿未表达的步法、接触、攻防、姿态、伤情、胜负或机位。缺失的动作展开留待用户授权中文新稿或源头规划，不能自动改历史稿。其他镜头、已有幻想能力与物种结构、固定段长、exact镜数、确认切点、逐字原对白和声音保持。',
  '保持普通六字段、H3三字段或full-reference六字段及原有section、[Shot N]、At切点、Subject/Picture/Video/Audio标签、S声源与<d>；不输出规则或审核附录，不新增模型调用、参数调整、本地动作效验、拦截或重试。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8 = [
  'VIDEO_ACTION_CHOREOGRAPHY_TRANSLATE_V1：英文翻译及其复核、格式/元数据修复只保真已确认中文sourcePrompt，不重新导演。逐镜保留具名施力者、直接受力对象及接触部位、最终目标、双方进入关系、实际接近与退避、进攻轨迹和对方同时的挡闪、接触或落空、受力反馈、各自退出关系。准确保持中文已写的支撑/发力侧别、阶段速度、被挡偏转与随动、上一招末态接下一招、物体接触后启动的因果、环境破坏附属于攻向对手的同一轨迹以及真实幻想能力和身体结构。摄影机跟随或切换不转化为人物改目标、追着镜头转身或瞬间换位。',
  '具体攻击目标仍用源稿的稳定姓名和对应标签表达，不把已写对手泛化成forward、toward the corridor、camera或the audience；分清向具名对手攻击和沿途切裂墙地，保持追击与退避共同发生，不能把移动中的对手译成stands still或把连续攻击译成poses、stands ready、prepares to attack。源稿本来确实静止、蓄势、慢动作或停顿时仍照实保留。不补中文未写的步法、姿态、接触、速度阶段、时间、招式、伤情、胜负、摄影或声音，不从原小说、旧shots或场地资料另编；缺失展开留待获准中文新稿，英译无权补写。',
  '保持普通六字段、H3三字段或full-reference六字段、原section顺序、[Shot N]、首镜无At、全部At切点与段内动作时间、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与逐字对白。参考身份和静态构图不替代动作，不虚构动作素材，不新增动作schema、规则附录、审核调用、参数调整、本地语义效验、拦截或重试。',
].join('\n\n');

/** Target writers supply their own existing delivery format. */
export const LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_8 = [
  'VIDEO_ACTION_CAUSALITY_V1：在本次获准规划或中文新稿生成内理解真实事件，补足同一次交战所需的连续双方动作，不照搬小说概述；按实际强度表现攻防、追逐和位移，原文的静止、停顿和非战斗事件仍保留。',
  LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8,
  '在目标格式现有正文和时间轴写出每镜双方的进入、移动、接触或落空与退出，不新增动作schema或规则附录。保持固定段长、exact镜数和确认边界，只有当前授权规划范围可安排镜头覆盖；不增加审核调用、参数调整、本地语义效验、拦截、重试或历史改写。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_8 = [
  ...LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8.split('\n\n').slice(0, 2),
  '保持 Seedance 自然语言章节、连续时间轴、全部确认起止时间、段长、镜数、实际 @Image/@Video/@Audio/@Clay Render 编号、具名声源和逐字原语言对白。图像身份与静态构图不替代动作，不虚构动作参考，不增加动作schema、规则附录、审核调用、参数调整、本地语义效验、拦截或重试。',
].join('\n\n');

/** Exact 1.8.9 contracts remain recognizable in saved first-party presets. */
const LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_9 = [
  LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8,
  '关键动作不能只给方向和结果：在对应镜头写明起手时头部与视线关注的具名目标、胸部和髋部相对对手的朝向、发力侧与受力物位置，再写实际执行的踢、抛、挥击方式及结束姿态。踢物时说明物体位于人物哪一侧、哪只脚支撑、另一只脚以什么脚部接触物体、摆腿轨迹如何将它送向具名目标；按当前事件选择可执行的前踢、侧踢或原文已定踢法，不能由“踢飞”自行变成背对目标的后踢。头部、胸部、髋部与武器不必机械同向，但侧身、旋转、回头或背身动作须有当前事件依据并写出可见过程；原文明确的后踢、旋转踢及非人结构照原意保留。身体侧别按已确认姿态承接，缺失时只在获准新稿中安排，不固定所有角色使用同一只脚。',
  '先选定当前位移的实际方式，再把它写成可见身体过程：自主退步或侧移写清承重脚、重心转移与另一只脚换步；蹬地后跃写出屈膝与足部蹬地启动、身体离地、腾空时的躯干和腿部姿态、空中持械或招架、落地后的支撑与下一动作。只在本段实际发生的范围写这些阶段，正在腾空的段尾不补落地。被击退或倒飞说明已成立的受力来源与身体方向；滑退说明脚或其他真实部位接触地面、惯性来源和制动/转接状态。后退、后跃、倒飞、滑退和原设悬浮不是同一动作，不能统一写成身体贴地平移、脚不换步而全人滑走，或用一道影子替代移动人物。移动中保留与来袭轨迹对应的视线、上身防御姿态和武器位置，不能只让腿移动而招架凭空完成；连续招架从上一挡击偏转与握持状态继续。幻想飞行、瞬移或能量化按已设能力表达，不因高速自行增造。',
  '实物被踢、抛或击飞时，先用原有名称和已知或当前可见的外形、实体轮廓、体积与材质中必要的特征确定是哪一件物体，再持续表现同一物体的接触、启动、飞行及经过目标后的状态；不虚构未知装饰或为了可读性添加新物体。运动模糊、残影、碎屑或音效附属于这个实体，不能替换成透明影子、光线或无形冲击，也不无因消失、变形、穿过人物身体。根据原有结果写清飞行高度和相对身体的路径、对方如何退让/偏身/抬挡，避开后物体从其哪一侧或上方掠过并沿原方向离开、继续飞向既有环境中的方向或原文已定终点；画面重叠不等于穿身，遮挡后仍从同一路径接续。原文只写飞出画外而未交代撞击时，不添加碰撞、伤情或环境破坏；确有破碎、穿透、能量化或非实体攻击则按原设区别呈现。',
  '关键动作的机位、景别与速度共同保证可读：踢物/抛物保留发力肢体与实体接触、启动路径及目标回应的观察范围；退步、起跳或落地保留足部支撑及必要躯干范围，腾空招架保留人物主体、持械姿态和双方交点。按当前事件用侧面、斜侧面或其他能读清关系的既有机位，不机械要求每镜全身；面部特写安排在不遮没关键接触和支撑过程的位置。高速仍须看得出具名人物与实体，不能用全程模糊、低机位裁掉人物、贴地拖影、遮挡或运镜把过程变成结果。接触后物体才加速、对方回应来袭后才改变姿态、招架接触后才偏转或回弹；用自然先后或当前镜内必要时间窗落实这些事件，不把准备、飞行、擦身和恢复全部写成无先后的“同时”。速度可短促变化而过程连续可辨，不为看清强加慢动作、延长已定段长、增加攻击次数或切点；原文与用户已定慢动作和幻想速度保持。',
  '动作时间与所写速度保持一致：接触、启动、飞行、避让与到达按同一事件的真实先后连续推进，切镜观察同一动作的当前阶段，不把物体停在空中等待下一镜的回应。没有已设悬浮、持续飞行或明确慢动作时，短距离后跃/倒飞不为填满镜长拖成数秒匀速空中平移，瞬时高速飞行也不延迟数秒后才发生避让或撞击。规划及获准新稿先按已有事件、完整对白和必要反应安排自然时间，空余用于剧情有依据的后续状态，不用延长飞行凑时；不加固定腾空秒数或距离公式，不删台词、不新增事件。固定时间边界已确认的翻译及保真阶段只保留原稿时间与动作，不自行重新排程。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_9 = LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_8
  .split(LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8).join(LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_9);

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_9 = [
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_8,
  '保真当前正文已经写出的头部/视线目标、胸髋朝向、踢法与接触脚部、物体实体形态和擦身/遮挡后路径及终点、位移方式、起跳/腾空/落地阶段、承重换步与同步招架姿态、关键身体可见范围、速度变化和事件先后。本次只处理已确认稿时，不因新规则另选踢法、把滑退改成后跃、补落地、补物体撞击或添加原稿未写的动作细节；缺失信息留待明确授权的中文新稿或源头规划，不由参考更新、衔接或格式修复代为重编。',
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_9 = [
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8.split('\n\n')[0]
    + '准确保留头部/视线目标、胸髋朝向、具体踢法、支撑与发力脚及接触脚部，实体物的可辨轮廓与材质、飞行高度、擦身一侧、遮挡后连续路径及已有终点；不得把有实体的物体译成shadow、energy streak或无形冲击，也不把从人物旁边掠过译成穿过身体。中文确为非实体或穿透能力时照实保持。',
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8.split('\n\n')[1]
    + '逐项区分自主退步、蹬地后跃、受力倒飞、滑退和悬浮，保持已写的启动来源、足部支撑/换步、离地/腾空/落地阶段、空中持械/同步招架和恢复承接；jump/leap backward不能简化为slides along the floor，front/side kick不能变成back kick，实体passes beside/above the character不能变成passes through the body。保留关键肢体与交点的可见范围、速度变化和接触→启动→回应的先后及原时间窗，不把顺序动作译成无差别simultaneously。以上仅保真中文已有事实，不利用英文例词补造中文缺失的动作、实体特征或结果。',
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8.split('\n\n')[2],
].join('\n\n');

export const LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_9 = LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_8
  .split(LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_8).join(LEGACY_VIDEO_ACTION_EVENT_UNDERSTANDING_V1_8_9);

export const LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_9 = [
  ...LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_9.split('\n\n').slice(0, 2),
  LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_8.split('\n\n')[2],
].join('\n\n');

/** One event-first writing procedure, replacing the accumulated historical
 * paragraphs above. It uses existing fields and adds no local semantic gate. */
const VIDEO_ACTION_EVENT_UNDERSTANDING = [
  '先按实际发生次数编排事件，再选择摄影覆盖。完整理解本段原剧情、当前用户正文和只读上下文，锁定具名行动者、对手或直接受力物、武器与能力、意图、已有招式与次数、先后、命中/落空、伤情和结果；用户已改正文时不恢复被删改的旧剧情。为每次实际发生的事件明确进入状态、施力或启动、接触/经过、结束状态，以及它与下一事件的承接或并行关系。同一事件只发生一次，其他镜头观察它当前的阶段，人物介绍、performance和result不能再发出一次执行命令。原文概述的同一次交战可补足必要的可见轨迹与身体行为，不能增加攻击次数、人物、武器、能力、伤情、胜负或另一事件；静止、蓄势、观察、普通交谈仍按剧情保留。',
  '先建立世界中的行动轴线，再写每个相关动作的朝向。用稳定姓名明确谁面向谁、直接受力物在谁的哪一侧、目标相对地标的位置；在关键发力处写出头部/视线目标、胸部和髋部相对对手的朝向、支撑与发力肢体、接触部位及结束姿态。踢物写清“具名施力者 → 发力脚接触的实体物及部位 → 飞行路径 → 袭向的具名目标 → 对方回应及终点”；支撑脚踩地与另一脚踢中物体分开表达，接触前物体不自行启动。原文只写向对手踢物而未规定背身招式时，在新稿让目标位于施力者身前或侧前、视线保持目标，按物体位置选定可执行的前踢或侧踢，不能靠转髋或为露正脸变成背对目标后踢；原定背踢、回旋与非人结构照实保留。身体侧别、转身与视线变化由事件决定，镜头换位不把目标改成摄影机、观众、前方或门墙。',
  '区分镜头覆盖时间与事件实际持续时间。先按原意确定短促接触、起跳/倒飞、飞行、避让/格挡、落地或下一状态的起止，再围绕事件安排镜界；切镜不是重新启动，也不是自动延长。必要时在现有action正文写明事件的起止时间或明确结束点，跨镜事件沿用同一连续时间轴，本镜相对时刻加startSec才是段内时刻。普通速度的短距离倒飞/抛物在一个短促时间窗内完成位移并进入剧情已有的后续状态，不能把“仍悬空”续写到每个镜尾凑满D；原文明确空中交锋则让追击与招架在同一次短促腾空过程中连续发生，保留已有幻想飞行、悬浮和明确慢动作，不擅自改成落地交战或固定现实物理秒数。段尾本来未完成的动作保留未完状态。',
  '连续双方动作从上一招末态推进：双方从哪里怎样接近或退避，哪一肢体/武器沿什么轨迹攻向哪位具名对手的哪个部位，对方怎样挡、接、闪或承受，接触后双方的握持、重心、距离、轨迹如何变化，下一招怎样利用这些变化接续。自主退步、蹬地后跃、受力倒飞、接地滑退和原设悬浮分别写出启动来源、必要支撑/离地及转接过程，移动防守者保持与来袭相应的持械姿态。连击按原定次数逐次表达接触和衔接，不把同一起手、同一挥击、同一格挡复制成等间隔循环；变化来自真实招架偏转与余势，原定同向重复攻击仍保留但要交代如何回收或再次衔接。快速连击采用正常播放速度下短促连续的动作，不把“高速摄影”当作速度说明。原定慢动作、停顿与幻想速度照其范围保留。',
  '直接受力物从接触到终点始终是同一个可辨实体，保留已知必要轮廓、体积和材质；模糊、火花、碎屑只是附随效果，不能代替人物或物体。格挡、命中和落空各保留原结果，物体被避开后从具名人物已说明的一侧掠过并沿原路径继续，不穿身、自行追踪或凭空消失；原设穿透、能量化与非接触施力除外。攻向对手时的墙地损坏属于同一武器轨迹的附带结果，不另排一段朝墙地空挥而让对手等待。多人动作分别写清主要交互、换目标与其他参与者同步状态，不删人、不限人数。',
  '事件时序确定后，auto选择能完整辨认关系、接触、路径和回应的最少必要视角，每次切换对应确实新增的信息；可在同镜转移关注，不为每一招、每个表情或每个阶段新增At切点，也不按段长平均分镜。关键动作优先连续呈现，侧面或斜侧面关系镜应覆盖必要的头胸朝向、支撑/发力肢体、受力物和目标路径，局部特写不能遮没方向关系；并非每镜全身或一律固定机位。跟随保持真实交点可读，不与每次碰撞机械重复推拉、切脸或晃动。正常速度完成短动作后，镜头可继续覆盖原剧情有意义的回应、恢复与观察，不能延长腾空、重演动作或新增停顿来填满镜长。',
  '完整原对白按自然发话区间、原语言和具名声源保留；追击、位移及不妨碍发音的动作可与对白并行，不把腾空维持到说完才结束，口部互斥动作仍错开。固定durationSec与exact镜数保持；只有源头规划或获准未确认新稿可重排镜界，auto不预设三镜或其他配额。只在本段事件范围安排，原有幻想逻辑和合理留白保留。参考图按实际身份、服装、场景或构图职责使用，不继承身份图面向观众的静态展示姿势，不虚构实际未接收的Picture/Video/Audio素材。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：本次源头规划或获准中文新稿先完成事件时间与世界关系，再安排镜头；把结果落实在正文，不让视频模型自行猜测动作关系。',
  VIDEO_ACTION_EVENT_UNDERSTANDING,
  '规划沿用action、space、direction、performance、camera、transition、result：action写发生一次的事件与实际起止，result交代供下一镜继承的双方位置、姿态、运动阶段和武器状态，camera覆盖该事件。普通稿保留六字段，H3把对应内容写入各[Shot N]的现有正文，同步canonicalPrompt、H3及受影响时间字段。保持现有section、Subject/Picture/Video/Audio标签、S声源、<d>、完整对白和合法切点，不新增动作schema、combat_plan、action_sequence、negative_prompt、规则或审核附录，不增加独立调用、本地语义门禁、重试或收费视频测试，不自动改历史稿。',
].join('\n\n');

/** Supplied to the existing review request only. This requests observable
 * evidence from the candidate, never an internal reasoning transcript. */
export const VIDEO_ACTION_EVENT_REVIEW_RULE = [
  'VIDEO_ACTION_EVENT_REVIEW_V1：在现有复核中读取候选稿实际写出的动作证据，不能凭reason、shotCountReason或候选自称“已核对”判断通过。仅对当前实际存在且影响辨认的定向发力、位移或连击检查对应证据，无此类动作不强加攻击、身体阶段或时窗。检查action/direction/performance/result/transition、canonicalPrompt及目标正文对应镜头：朝向证据必须说明具名目标与头胸髋关系；时间证据必须能定位同一事件的启动、接触/经过、结束或确实未完的段尾；连击证据必须能区分每次接触及前招末态怎样进入下一招。缺失或矛盾直接在本次授权字段内补正，不把证据换成“轴线一致、速度很快、连续攻防”等总结。',
  '跨镜核对同一事件的完整跨度：统一本镜相对时刻与段内时刻，读取首次启动到真正结束之间的时间，检查后镜是否用“仍悬空/继续飞行”无因延长短促事件、是否每次从同一起手重演、是否误把一个镜长当作一次接触或位移的时长。对白、追击、招架与位移在允许并行处同时推进，原定落空/格挡/命中及幻想能力保持。再验证所写机位可见的头胸朝向、接触点、目标路径是否支持这条轴线，切镜是否引入必要信息而非重复覆盖；仅在auto有重排权限时合并多余镜头，exact保留镜数。',
  '源头规划或taskAuthority=current-segment-staging-replan可在固定段长和当前镜数权限内修复未确认事件时窗与镜界，同时更新普通正文、H3和时间字段。taskAuthority=preserve-confirmed-schedule只在既定切点内落实本次获准的动作展开，不借此改确认镜界；已有稿保真、参考更新、衔接、格式修复和翻译只核对本次允许的保留或修复内容，不补写缺失事件、不重新导演、不自动修正历史排程。只返回现有交付格式的完整修正结果，不新增审核字段、事件表、推理链或独立模型调用。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE = [
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_9,
  '已有正文中同一事件的启动与结束、跨镜进度、动作实际持续时间、连击各次接触及末态承接分别保真，镜头时长不替代事件时长；已确认的并行关系不改成串行。只保留已写事实，不能借事件复核补造起止、收缩悬空时长或合并镜头。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE = [
  ...LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_9.split('\n\n').slice(0, 2),
  '镜界与事件起止分别保持，跨镜的同一次事件只延续当前进度，不能翻译成重新启动或持续占满新镜。逐次保留连击的接触、偏转、回收与承接以及已有并行关系，正常播放速度下快速动作不译成high-speed photography或slow motion；中文确实要求高速摄影或慢动作时忠实保留。缺失或不合理时序仍无权在译文中重编。',
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_9.split('\n\n')[2],
].join('\n\n');

export const VIDEO_ACTION_CAUSALITY_RULE = [
  'VIDEO_ACTION_CAUSALITY_V1：在本次获准规划或中文新稿内，先区分各次事件、世界关系和事件时窗，再选择摄影覆盖。',
  VIDEO_ACTION_EVENT_UNDERSTANDING,
  '将上述结果融入目标格式的现有正文和时间轴，保持固定段长、exact镜数、当前授权边界、完整原对白及真实参考标签；不新增动作schema或审核附录，不增加独立调用、本地语义门禁、重试或历史改写。',
].join('\n\n');

export const VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE = [
  ...VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE.split('\n\n').slice(0, 3),
  LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_9.split('\n\n')[2],
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
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_9, LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_9,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_9, LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_9,
    LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_9,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V1_8_8, LEGACY_VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE_V1_8_8,
    LEGACY_VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE_V1_8_8, LEGACY_VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE_V1_8_8,
    LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V1_8_8,
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
