/** Request-time action direction only. No local story grading, saved-preset
 * migration, output rewriting, extra API call, or video parameter changes. */
export const VIDEO_ACTION_CHOREOGRAPHY_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：结合本段原剧情与用户导演要求判断动作场面的实际强度。连续攻防、追逐、摔投或高频位移必须在镜内实际发生，不把已发生的战斗弱化为站立对峙、摆架势、准备出手、眼神交锋或只有音效的反应特写；普通交谈、轻微动作与原文明确的静止、蓄势、停顿仍照原意保留，不为增强动感把所有剧情改成武打。',
  '同一事件的可摄影展开不是新增剧情：原文只概述双方激烈交战时，在本次获准规划或生成的范围内，可以明确该次交战必要的起手、移动、攻防轨迹、招架或闪避、接触反馈与动作承接。人物、攻击意图、具名对象、武器、能力、已成立的先后、强度、伤情与结局是事实锁；不能凭空增加胜负、致死、断肢、受伤、新招式能力、新人物、新武器或另一场战斗。已有具体招式与结果按原文拍出来，不因套用常规打法替换。',
  '双人攻防写成互相作用的连续过程：明确谁从什么位置向哪位具名对象及哪个可见目标发起，攻击沿什么方向前进，对方怎样挡开、避让、接住或承受，真实接触如何改变双方的姿势、距离、重心或运动方向，下一动作怎样从当前状态接续。在现有镜内用清楚先后及必要的本段动作时间窗落实连续交换，不用“激烈打斗”概述代替过程，也不把每一拳都新增成At切点。落空就写实际避让和落空，格挡不等于命中，不能把未中写成击倒。选择当前动作必要的支撑、躯干传力、阻力、随动和恢复，避免只有手臂摆动、滑步、瞬移、碰撞后双方僵住或每招重新摆回起手式；不要求每招凑齐固定阶段。',
  '多人近身战斗按实际时序交代可辨的主要攻防关系、参与者方位和其他人的同步状态；换目标、交替夹击或连锁受力时明确具名行动者与对象，不把所有人写成同时扑向同一点或用“众人混战”替代已经成立的动作。可在同镜连续转换观察重点，不设每镜人数上限，不删除原文参与者；被遮挡或画外的动作按既有空间交代，不能凭摄影需要改变攻击来源或结果。',
  '摄影让实际动作可见：按招式和场景选择能读清双方距离、运动轨迹与接触点的景别、机位和必要跟随，在适用镜头保留全身或关键肢体的可见范围；并非每镜都必须全身，也不禁止原文需要的特写。复杂身体交互不要无动机地同时叠加急推、环绕、摇晃和遮挡，不用快速切脸、镜头震动、火花、慢动作或拟音替代真实攻防。原文或用户明确要求的慢动作、特写及风格化运镜保留，按其范围落实。',
  '动作节奏与时长由当前事件因果决定，不按每秒动作数、固定动作阶段、字数或最低镜数安排。没有叙事作用的反复蓄势、站立和慢推不要填满动作段；有依据的观察、喘息、停顿和收束保留。只在本次明确授权的源头规划或未确认新稿排程内调整镜长和覆盖：固定durationSec不变，exact镜数不变，auto才可在授权范围改变镜数；同步canonicalPrompt与H3及相关时间字段。已确认切点、参考更新、衔接、翻译或纯格式修复不因本规则获得重新导演权限。完整原对白、原语言、具名声源和口部互斥动作保持，不靠抢话或删句腾出动作时间。',
  '物理与风格服从原剧情：写实战斗保留可见支撑、惯性与接触反馈；武侠、仙侠、动漫、超能力或非人角色按原文及已选风格表达已有的飞行、轻功、能量和身体结构，不将明确幻想能力强改成现实限制，也不凭“激烈”补出未设定能力。参考图只提供其实际身份、服装、场景或构图职责，不锁住静态姿势；动作参考仅使用本次真实提供且接口实际接收的素材，不虚构Video或Picture引用。',
  '在本次已有回答内部核对并修复动作遗漏：行动者、目标、进攻与回应、命中或落空、可见受力、位移、下一动作和结果是否沿同一事件推进；声音贴合真实动作，不靠声音冒充动作。保留本来准确的动作与剧情，不为了丰富而加招。规划使用现有action、space、direction、performance、camera、transition、result字段；普通转换继续现有六字段格式；H3只把内容融入对应[Shot N]的integrated_multimodal_description或detailed_description。保持既有三字段或full-reference六字段模式、字段名称顺序、Subject/Picture/Video/Audio标签、S声源、<d>与原对白；首镜无At、后镜At切点按本次合法排程，不新增combat_plan、action_sequence、negative_prompt、审核说明、规则正文或附录。不增加独立审核调用，不要求先运行视频，不用本地关键词拦截判断动作好坏。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_PRESERVE_V1：本次处理已有稿或纯格式/序列化修复，不是新动作导演。以当前已确认正文或本次明确的修复候选为依据，忠实保留逐镜行动者、具名对象、攻防轨迹、连续速度、接触与落空、受力位移、幻想能力、动作承接及结果；不将连续动作弱化成站立对峙、摆架势或准备攻击，也不为增强动感补出原稿没有的招式、人物、武器、能力、伤情或胜负。',
  '只修本次任务授权的内容：参考更新只改参考职责及必要可见事实，衔接只改授权的短开场接力与受影响状态，人物资料更新只改对应身份资料，纯格式/元数据/序列化修复只恢复可读取结构及已确认内容。对白排程修复可按原有taskAuthority调整已有动作的时间关系，但不得借此新增战斗编排。其他镜头、动作、摄影、对白、声音、固定段长和exact镜数保持；没有本次明确授权就不改变已确认镜界和At切点。',
  '保持现有普通六字段或H3三字段/full-reference六字段格式及字段顺序、[Shot N]、首镜无At、递增切点、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与原对白，不增加动作计划、反向提示词或审核附录。不在结果里复制规则，不新增模型调用、参数调整、本地语义门禁或历史稿自动改写。',
].join('\n\n');

export const VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE = [
  'VIDEO_ACTION_CHOREOGRAPHY_TRANSLATE_V1：英文翻译及其复核、格式/元数据修复以已确认中文sourcePrompt为唯一执行稿，只保真，不重新导演。逐镜保留具名攻击者与对象、身体/武器运动方向、攻击与挡闪先后、命中或落空、接触点、受力位移、连续速度、动作承接和结果；保持已有幻想能力与物种身体结构，不把武侠或风格化动作改成普通现实限制。',
  '准确翻译已经发生的动作，不能将连续攻防改为poses、stands ready、prepares to attack或moves slightly等准备/微动概述；原稿确实只准备、静止、慢动作或停顿时仍忠实保留，不额外强化。不补新招式、伤情、胜负、人物、武器、能力、摄影设计或声音，不从旧shots重新编排动作。修复仅针对译文遗漏、歧义及可读取格式，不替中文稿另设计战斗。',
  '普通六字段与H3三字段/full-reference六字段各保持原格式、字段顺序、[Shot N]、首镜无At、所有At切点和段内动作时间、Subject/Picture/Video/Audio标签、S声源、<d>、原语言与逐字对白。参考图身份和静态构图不替代动作，不虚构动作视频引用；无依据的动作问题只保留原稿，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
].join('\n\n');

/** Model-independent facts. Target writers supply their own delivery format. */
export const VIDEO_ACTION_CAUSALITY_RULE = [
  'VIDEO_ACTION_CAUSALITY_V1：按当前事件实际强度表现连续攻防、追逐、摔投与位移，不把已经发生的行动弱化为站立对峙、摆架势、准备攻击、反应特写或只有音效。原文确实交谈、静止、蓄势或停顿时忠实保留，不把所有剧情改成武打。',
  '行动者、具名对象、武器、能力、已有招式、方向、先后、命中或落空、伤情与结局是事实锁。原文概括交战时可在当前获准的同一事件内表达必要的攻防承接与接触反馈，不能新增人物、武器、能力、胜负或另一场战斗。落空不是命中，格挡不是击倒。多人动作交代主要攻防关系与其他参与者同步状态，不限人数、不删除参与者。',
  '接触真实改变姿势、距离、重心或运动方向，下一动作从当前状态继续，不反复恢复起手式。写实动作保留支撑、惯性与受力；武侠、动漫、超能力和非人角色服从已有风格、能力与身体结构，不凭激烈补造能力，也不强改成现实限制。',
  '摄影为动作可读性服务，按原有设计保持必要的肢体、攻击路径和接触点可见；不靠切脸、火花、镜头震动或拟音替代真实动作。完整原对白、原语言、具名声源、口部互斥动作与无对白区间保留，不删句、不抢话腾时间。参考身份和静态构图不锁定动态姿势，动作参考只用真实提供且实际接口接收的素材。',
].join('\n\n');

export const VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE = [
  ...VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE.split('\n\n').slice(0, 2),
  '保持 Seedance 自然语言章节、连续时间轴、全部已确认起止时间、段长、镜数、实际 @Image/@Video/@Audio/@Clay Render 编号、具名声源和逐字原语言对白。图像身份与静态构图不替代动作，不虚构动作参考，不增加规则附录、审核调用、参数调整或本地语义拒绝。',
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
  const preservedSystem = [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
    VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE, VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE].reduce((value, rule) => value.split(rule).join(''), systemPrompt).trim();
  return [preservedSystem, targetFormat === 'seedance' && scope === 'translation'
    ? VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE : videoActionChoreographyRuleForScope(scope)].filter(Boolean).join('\n\n');
};
