import { applyConvertedPromptToShots, parseMasterTimelinePrompt, topLevelCanonicalFieldLocations } from './masterTimeline';
import { sourceContentHash } from './sourceIntegrity';
import type { H3StagingShotMetadata } from './h3StagingMetadata';
import { H3DeliveryValidationError, H3_METADATA_SCHEMA_RULE, h3FieldIssue, type H3DeliveryFieldIssue } from './h3DeliverySchema';
import type { Storyboard, VideoShot } from './types';

const fieldsOf = (prompt: string): Record<string, string> => {
  const body = prompt.replace(/^【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】\s*/u, '');
  const fields = topLevelCanonicalFieldLocations(body);
  return Object.fromEntries(fields.map((field, index) => [
    field.field, body.slice(field.start + field.field.length, fields[index + 1]?.start).replace(/[；;]\s*$/u, '').trim(),
  ]));
};

/** Deserialize AI-owned planning data; no speaking-rate or story quality gate. */
export const synchronizeH3StagingDelivery = (
  board: Storyboard,
  canonicalPrompt: string,
  shotSourceIds?: readonly (readonly string[])[],
  shotMetadata?: readonly (H3StagingShotMetadata | null)[],
): Storyboard => {
  const entries = parseMasterTimelinePrompt(canonicalPrompt, board.durationSec);
  const exactCount = board.shotMode === 'exact' ? board.shotCount || board.shots.length : undefined;
  if (exactCount !== undefined && entries.length !== exactCount) {
    throw new Error(`AI交付排程改变了用户指定镜数：必须保持${exactCount}镜，实际返回${entries.length}镜。`);
  }
  const sourceById = new Map(board.shots.map((shot) => [shot.id, shot]));
  const fieldIssues: H3DeliveryFieldIssue[] = [];
  if (shotSourceIds && shotSourceIds.length !== entries.length) fieldIssues.push(h3FieldIssue('shotSourceIds', `与${entries.length}个新镜头对应的来源数组`, shotSourceIds));
  if (shotMetadata && shotMetadata.length !== entries.length) fieldIssues.push(h3FieldIssue('shotMetadata', `与${entries.length}个新镜头对应的元数据数组`, shotMetadata));
  if (fieldIssues.length) throw new H3DeliveryValidationError(fieldIssues, 'AI交付元数据条数与新镜头数不一致');
  const hasSourceMetadata = (shot: VideoShot): boolean => shot.sourceBeatIds !== undefined || shot.sourceExcerpt !== undefined
    || shot.sourceStart !== undefined || shot.sourceEnd !== undefined || shot.nsfwContinuity !== undefined
    || shot.visiblePrivatePartsByCharacter !== undefined;
  if (!shotSourceIds && board.shots.some(hasSourceMetadata)
    && entries.some((entry, index) => board.shots[index]?.prompt !== entry.prompt)) {
    throw new H3DeliveryValidationError([h3FieldIssue('shotSourceIds', '明确的源镜头映射，不能按位置猜测', shotSourceIds)], 'AI交付改变了分镜但缺少shotSourceIds来源映射');
  }
  const sourceUseCounts = new Map<string, number>();
  for (const [index, ids] of (shotSourceIds || []).entries()) {
    ids.forEach((id, sourceIndex) => {
      if (!sourceById.has(id) || ids.indexOf(id) !== sourceIndex) fieldIssues.push(h3FieldIssue(`shotSourceIds[${index}][${sourceIndex}]`, '输入镜头中存在且本镜未重复使用的源编号', id));
    });
    ids.forEach((id) => sourceUseCounts.set(id, (sourceUseCounts.get(id) || 0) + 1));
  }
  if (fieldIssues.length) throw new H3DeliveryValidationError(fieldIssues, 'AI交付shotSourceIds含未知或重复的源shot.id');
  const sameCount = entries.length === board.shots.length;
  const seeds: VideoShot[] = entries.map((entry, index) => {
    const explicitSources = (shotSourceIds?.[index] || []).map((id) => sourceById.get(id)!);
    const unchangedSource = board.shots[index]?.prompt === entry.prompt ? board.shots[index] : undefined;
    const oneToOne = explicitSources.length === 1 && sourceUseCounts.get(explicitSources[0].id) === 1;
    const source = oneToOne ? explicitSources[0] : !shotSourceIds ? unchangedSource : undefined;
    const metadata = shotMetadata?.[index];
    const needsExplicitMetadata = !source && (explicitSources.some(hasSourceMetadata)
      || (!explicitSources.length && board.shots.some(hasSourceMetadata)));
    if (needsExplicitMetadata && !metadata) {
      throw new H3DeliveryValidationError([h3FieldIssue(`shotMetadata[${index}]`, '由模型依据证据明确返回的镜头元数据对象，不能由本地合并、复制或清空', metadata)],
        `AI交付第${index + 1}镜为多源合并、拆镜或无一一对应来源，缺少shotMetadata显式可见范围与连续性选择`);
    }
    // Existing slot IDs keep revisions and selections stable when the number
    // of shots is unchanged. New layouts never guess semantic provenance.
    const id = sameCount ? board.shots[index].id : `${board.id}:h3-shot-${index + 1}`;
    const references = explicitSources.length ? explicitSources.flatMap((shot) => shot.referenceAssetIds)
      : source?.referenceAssetIds || (sameCount ? board.shots[index].referenceAssetIds : []);
    return {
      ...(source || {}),
      id, index: index + 1, startSec: entry.startSec, endSec: entry.endSec,
      purpose: source?.purpose || '', subject: '', action: '', camera: '', lighting: '', sound: '',
      // Old action outcomes/performance must not be re-imported over the new
      // canonical event sequence. The full AI-authored body remains intact.
      result: unchangedSource ? source?.result || '' : '', transition: unchangedSource ? source?.transition || '' : '',
      performance: unchangedSource ? source?.performance : undefined, direction: unchangedSource ? source?.direction : undefined,
      referenceAssetIds: [...new Set(references)], prompt: entry.prompt,
      locked: source?.locked || false, authoredBy: 'text-api',
      ...(!source ? { sourceLocationStatus: 'unlocated' as const } : {}),
      ...(metadata ? {
        sourceBeatIds: [...metadata.sourceBeatIds], sourceExcerpt: metadata.sourceExcerpt,
        sourceLocationStatus: metadata.sourceLocationStatus, sourceStart: metadata.sourceStart, sourceEnd: metadata.sourceEnd,
        nsfwContinuity: metadata.nsfwContinuity ? { ...metadata.nsfwContinuity } : undefined,
        visiblePrivatePartsByCharacter: Object.fromEntries(Object.entries(metadata.visiblePrivatePartsByCharacter).map(([key, parts]) => [key, [...parts]])),
      } : {}),
    };
  });
  const shots = applyConvertedPromptToShots(seeds, canonicalPrompt, board.durationSec).map((shot) => {
    const fields = fieldsOf(shot.prompt);
    return {
      ...shot, space: fields['空间：'], lighting: fields['光影：'], camera: fields['镜头：'],
      dialogue: fields['台词：'], sound: fields['音效：'],
    };
  });
  return {
    ...board, finalPrompt: canonicalPrompt, shots,
    ...(board.shotMode === 'exact' ? { shotCount: shots.length } : { recommendedShotCount: shots.length }),
    promptPlan: board.promptPlan ? {
      ...board.promptPlan, canonicalPrompt, shotIds: shots.map((shot) => shot.id),
    } : undefined,
    promptTrace: board.promptTrace ? {
      ...board.promptTrace, convertedPromptFingerprint: sourceContentHash(canonicalPrompt),
    } : undefined,
    // The former ledger describes the old schedule. Until an AI-authored new
    // ledger exists, canonical per-shot fields are the sole sound authority.
    audioLedger: undefined,
  };
};

export const H3_STAGING_DELIVERY_RULE = [
  H3_METADATA_SCHEMA_RULE,
  '本次是未确认的新稿或用户明确请求的本段对白排时修复，不是翻译/选图/衔接/格式修复。sourceStoryContent、本段原文证据及用户要求是事实；candidatePrompt、shots和canonicalPrompt是可修的时间草稿，不把AI先前写坏的短发话时窗当成用户锁定。先理解每句完整原话、原说话人、先后因果、情绪停顿与换人交接，再在当前固定durationSec内安排对白及动作，最后安排镜头。不要固定每秒字数估算、加速说话、截断/删改台词、重演事件、靠无意义停留凑时长；妨碍发话的口部动作结束后才开口。',
  '只可在本段内调整尚未确认镜长、对白时间与摄影安排，禁止从邻段挪入对白或事件。durationSec是用户已选的固定每段时长，本阶段不得增加总时长或重分段；AI适配全片段数只属于上游语义分段。shotMode=exact时必须保持用户指定shotCount，shotMode=auto时可按剧情调整镜数；完整台词、说话人、原字、事件顺序及用户要求始终锁定。',
  '仅返回一个完整JSON交付对象：{"canonicalPrompt":"普通六字段完整排程","h3Prompt":"完整合法H3正文","identityBindings":{"version":1,"characters":[]},"shotSourceIds":[["原shot.id"]],"shotMetadata":[null]}。不要代码围栏、审核说明或单独通过结论。canonicalPrompt与h3Prompt是同一份排程的两种表达，镜数、镜界、对白归属和事件必须同步；不允许只改H3保留旧shots。',
  'canonicalPrompt每镜严格为【0s-5s】主体：@完整姓名，正在 [本镜动作链]；空间：...；光影：...；镜头：...；台词：具名完整对白及完整镜内相对发话区间；音效：本镜音效和镜内相对时间，连续覆盖0至durationSec。普通六字段内部音效/发话时间从本镜0开始；h3Prompt内部则使用本段0开始的时间，转换只偏移一次。shotSourceIds按输出镜头顺序明确列出每镜源自哪些输入shots.id，不编造原文索引；一镜对应多原镜可列多个ID，没有旧镜来源列空数组。',
  'shotMetadata与输出镜头逐项对应。一对一沿用单一原镜且未改变可见范围/连续性时可填null，原镜元数据保持；合并多原镜、一原镜拆成多新镜、无原镜对应或改变这些状态时必须由你明确返回对象：sourceBeatIds（实际源beat ID数组）、sourceExcerpt（本镜依据）、sourceLocationStatus（located或unlocated）、nsfwContinuity（本镜已选状态对象或明确null）、visiblePrivatePartsByCharacter（本镜明确选中的人物ID到可见资料类别数组，无需显示时明确{}）。located还要给真实原文sourceStart/sourceEnd整数，不能定位则unlocated且不提供索引。nsfwContinuity只用已存在的nudity/clothingState/contact/actionStage/residue可选字符串字段，不把档案自动转成可见性；多源范围不能默认取并集，拆镜不能把原镜范围机械复制到每个新镜，均须依据本段原文、已选资料与实际画面选择。这些是保存分镜的元数据，不新增H3字段、不把元数据当台词，也不是删改已授权剧情的理由。',
  'h3Prompt保持当前三字段或full-reference六字段模式、官方字段顺序、参考标签职责，按同步后的canonicalPrompt给出连续[Shot N]与At切点，首镜无At。保留真实配图标签集合，不凭空新增图片/音频引用。人物S声源及逐句完整姓名在最终H3中落实，不能只留在identityBindings JSON。交付前在本次回复内部自行核对两份排程一致，不新增另一次AI审核。',
].join('\n');
