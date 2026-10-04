/** The same user-authored pacing context follows estimation and shot planning.
 * This is prompt data, not a local semantic classifier or timing quota. */
export interface StoryPacingContext {
  pace: string;
  directorCategory?: string;
  directorStyle?: string;
  directorStyleSummary?: string;
  extraRequirement?: string;
}

/** Ask the model to make and review pacing decisions within its original
 * response. No local keyword, minimum-shot-count, or character gate is added. */
export const STORY_PACING_RULE = [
  'pacing 是用户当前的节奏与导演要求，估时和分镜必须使用同一份要求：结合 pace、directorCategory、directorStyle、directorStyleSummary 和 extraRequirement 阅读完整剧情；未提供 pacing 时沿用已有 pace 和导演设置，未指定的部分由你结合全文判断。',
  '合理安排动作与对白同时进行：在因果、说话气息和表演允许时，让行走、取物等不妨碍发音的动作与对白并行，不默认把说话、动作、人物反应逐项串行相加；原对白必须完整、归属正确、自然说完，不能为紧凑而删句、截断或机械加快语速。',
  '先按原文顺序确定每句完整原话的说话人、自然发话起止、换人交接及必要反应，再安排摄影覆盖。亲吻接触、嘴里含食物、喝水、捂嘴或其他妨碍发音的动作，不能和该人物清晰说话同时发生；结合剧情明确接触/动作结束、嘴部恢复自由、再开口，不把口部互斥动作当作可并行省时项。',
  '估时须容纳完整发话区间，不是仅有开口时刻：长句不能在镜尾或段尾才开口并挤进剩余几秒。仅在本阶段授权的范围内利用相邻镜头或生成窗口重新分配未确认的原文事件；当前段归属已确定时不移入或移出其他段事件。保留对白原文、说话人和先后，总长是否可调整以本阶段明确的durationAdjustmentPolicy为准，获准时按用户所选整段时长调整，不靠抢话、重复或加速朗读消化不足。',
  '把环境描写融入人物动作、构图和正在发生的情节，不反复单独铺垫；确有空间交代、悬念或叙事价值的环境镜头仍可独立安排，不把每句环境文字都变成额外秒数。',
  '先从全文安排有先后与因果的事件、原对白及必要反应，再分配生成窗口和摄影覆盖；逐段区分正在推进的内容、尚未完成的动作与已经完成的状态。已完成状态只作为后续入镜基准，不能重新执行或改写成新事件；真实未完动作可自然跨段，但每段应继续其实际进程，而非从准备阶段重新演起。',
  '不同标题、景别、机位、横移、推拉或光影不等于新增剧情；同一事件的不同摄影覆盖可以有叙事作用，但不能仅为填窗口把已经结束的拥抱、站立、看景等状态反复拆成独立段。合理留白、环境交代与明确慢节奏要求照常保留，不强迫每段虚构新事件或一律快切。',
  '不为填满时间增加凝视、站立、慢推镜和余韵，也不让已经成立的承接状态反复重演成新的准备动作；镜头密度、动作并行关系与每镜时长由你根据全文和节奏要求判断，不按本地字数、语速配额、固定动作阶段或最低镜数安排。',
  '片尾在原文的结局、必要结果与合理收束完成后结束，不把剩余预算全部交给静默人物、景物变化或换运镜。AI自动估时只是候选预算：尚未确认且ai-estimated策略允许时，过宽就减少完整段，确实不足才增加完整段；fixed或已确认切片不擅自调时。调整要重新交付完整原文对应的全片安排，不截断结尾、删对白或新增剧情。',
  '紧凑表示减少没有叙事作用的冗余，不是一概加速或删除停顿。保留确有情绪、悬念、因果和对白表演作用的停顿；用户明确要求舒缓、缓慢叙事、长镜头或特定留白时，按其原意保留，不强改成快节奏。',
  '在同一次回答内对照完整剧情、完整对白与 pacing 自检并调整：是否把可并行的内容重复计时，是否反复铺垫，是否为凑时间增加空转，是否误删必要停顿或违背明确的慢节奏要求。自行修正后只返回当前任务规定的最终结果，不需要新增通过标志，不依赖本地内容判断。',
].join('\n');

/** Source-planning instructions only. This does not impose a local speech
 * quota, an extra model call, a minimum shot count, or a semantic pass flag. */
export const STORYBOARD_SPEECH_FIRST_PLANNING_RULE = [
  '本次是全片/单段分镜的源头规划，先完整识别原文事件与每句原话的唯一说话人、听者和顺序，再安排自然发话起止、换人交接、必要停顿及口部互斥动作先后，最后决定镜头覆盖。不要先锁定动作镜长、把余下对白全部塞进末镜，或用“柔和、断续”搭配根本容不下整句的瞬时时窗。',
  'durationSec/requiredSegmentDurationSec规定交付时间，不规定摄影镜数。15秒视频段不等于1个15秒镜头；需要看清不同说话者、动作结果或空间关系时，在用户指定镜数或AI自动镜数权限内选择完整镜头。也不强制每段多镜或一句一切，确有叙事理由的一镜到底仍可保留。',
  '每句对白在dialogue字段写完整原话、明确具名说话人、声音身份、在画/画外、与谁交谈及本镜相对起止区间；该字段的0秒始终是当前镜头startSec，而不是视频段或全片0秒。先安排完整发话再确定包含它的镜界，最后换算为本镜相对时间；镜界调整后必须同步更新dialogue、action、performance、camera和sound中的相对时刻。不要只写“第2秒开始”，也不要用主体名单、角色位置或上一句说话人代替当前声源。camera/performance同时覆盖正确的可见口型及其听者反应。',
  'action只安排该镜实际发生的一次动作及先后，performance记录入镜状态和当下反应，result记录已完成状态；人物介绍、入镜状态或结果摘要不得再下达一遍亲吻等动作。亲吻时嘴唇接触不能同时清晰念对白，离开接触后才进入该人物的发话区间。',
  '窗口分配权限以sourcePlanningAuthority为准：仅新全片源头规划允许把完整原话及对应事件顺序移入相邻窗口，当前已分配语义段或普通单段只能在本段内重排未确认的镜长与发话，不能借用前后段、增减总长或把台词交给另一人物。只有原文确需一句长话连续跨镜时，才明确同一声源持续发话和连续接点，不重新开头。',
  '根据说话者、听者、互动对象、世界方向和信息变化设计中近景、双人构图或镜内重点转移，并说明每次重点交接；不要因为三人同框就始终把三张脸平均摆在近中景里。摄影只能覆盖已经安排好的事件，不能倒过来改变说话人或强迫嘴部冲突。',
  '固定时长或固定镜数不等于固定AI草稿时窗：在源头规划及其现有修复内，保留原文事实、对白原字、说话人、顺序和用户数值合同，允许重排自己尚未确认的镜界、发话区间及摄影覆盖。已确认总稿的分段切片、参考图更新和H3中英文格式转换不适用此授权。',
].join('\n');

/** Explicit request scope prevents a shared directing rule from treating an
 * AI's provisional cut/speech window as a user-confirmed timing contract. */
export const STORYBOARD_SOURCE_PLANNING_AUTHORITY_RULE = [
  'sourcePlanningAuthority只描述本次源头规划的修改权限，不是要求新增输出字段。sourceFacts保留原文事件、原对白、唯一说话人、先后和因果；candidateStatus=unconfirmed-ai-draft表示上一版AI自定的镜界、对白时窗与摄影还未确认，不能把“保留有效内容”误读成锁死这些草稿数值。',
  'sourceScope=assigned-semantic-segment时，本段事件归属、入口出口和D固定，但本段新分镜尚未确认；只在本段内部先安排完整发话与互斥动作，再重排镜长和摄影，不能移入/移出相邻段事件。sourceScope=single-clip同样不能借用相邻视频。sourceScope=unconfirmed-full-film时才可跨未确认窗口重新分配，改总长仍须单独服从durationAdjustmentPolicy。',
  'shotCountAuthority=user-fixed时严格保持requiredShotCount；ai-auto时可调整AI自定镜数。固定总时长只锁住交付窗口外框，不锁住窗口内部AI自定切点。第一轮与同一流程的后续修复使用同一权限，不因收到旧候选稿或局部数字报错而缩小为只能补片尾。',
].join('\n');
