import type { H3IdentityBindings, PromptCharacterParticipation } from './types';
import { characterParticipationCoverageIssues, characterParticipationIssues, inspectCharacterParticipation } from './characterParticipation';
import { readH3StagingShotMetadata, type H3StagingShotMetadata } from './h3StagingMetadata';
import { parseH3PerformancePlan } from './h3PerformancePlan';
import { H3DeliveryValidationError, H3IdentityMetadataError, H3_IDENTITY_SCHEMA_RULE, copyH3IdentityEventBindings, h3FieldIssue, inspectH3IdentityBindings, type H3DeliveryFieldIssue } from './h3DeliverySchema';

const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export type H3IdentityBindingIssueCode = 'invalid-bindings' | 'anchor-empty' | 'anchor-missing' | 'anchor-ambiguous'
  | 'duplicate-character' | 'unknown-character';
export interface H3IdentityBindingIssue {
  code: H3IdentityBindingIssueCode;
  characterId: string;
  name: string;
  message: string;
}
export type H3IdentityCharacter = Readonly<{ id: string; name: string }>;

const anchorIssue = (prompt: string, anchor: string): Pick<H3IdentityBindingIssue, 'code' | 'message'> | undefined => {
  if (!anchor.trim()) return { code: 'anchor-empty', message: '身份定位句为空。' };
  const first = prompt.indexOf(anchor);
  if (first < 0) return { code: 'anchor-missing', message: '身份定位句不在当前语言的正文中。' };
  if (prompt.indexOf(anchor, first + 1) >= 0) return { code: 'anchor-ambiguous', message: '身份定位句在正文中重复，无法唯一定位。' };
  return undefined;
};

/** One exact location for explicit identity metadata. No prose or token audit. */
export const h3IdentityAnchorIssue = (prompt: string, anchor: string): string | undefined => anchorIssue(prompt, anchor)?.message;

/** Check readable metadata and explicit IDs against their exact text locations. */
export const getH3IdentityBindingIssues = (
  prompt: string, bindings: H3IdentityBindings | undefined, characters?: readonly H3IdentityCharacter[],
): H3IdentityBindingIssue[] => {
  if (bindings === undefined) return [];
  const normalized = normalizeH3IdentityBindings(bindings);
  if (!normalized) return [{ code: 'invalid-bindings', characterId: '', name: '', message: '人物身份绑定元数据格式无效。' }];
  const issues: H3IdentityBindingIssue[] = [];
  for (const entry of normalized.characters) {
    const add = (code: H3IdentityBindingIssueCode, message: string): void => { issues.push({ code, characterId: entry.characterId, name: entry.name, message }); };
    const issue = anchorIssue(prompt, entry.referenceAnchor);
    if (issue) add(issue.code, issue.message);
    if (normalized.characters.filter((other) => other.characterId === entry.characterId).length > 1) {
      add('duplicate-character', '人物编号被多个绑定记录共用。');
    }
    if (characters) {
      const matches = characters.filter((character) => character.id === entry.characterId);
      if (matches.length !== 1) add('unknown-character', '人物编号不在本次源人物资料中，或来源编号不唯一。');
    }
    // Explicit IDs and a unique offset establish the association. Display
    // names, Subject/S metadata and authored wording remain unchanged; they do
    // not impose additional conditions on a known character's picture anchor.
  }
  return issues;
};

/** Metadata may change its exact anchor, never silently lose an existing ID. */
export const h3IdentityBindingRetentionIssue = (source: H3IdentityBindings | undefined, candidate: H3IdentityBindings | undefined): string | undefined => {
  if (!source) return undefined;
  if (!candidate) return '本次交付遗漏 identityBindings，不能把正文与已有绑定记录分开保存。';
  for (const entry of source.characters) {
    const matches = candidate.characters.filter((item) => item.characterId === entry.characterId);
    if (matches.length !== 1) return `本次交付遗漏或重复人物“${entry.name}”的绑定记录，不能清空元数据来消除错误。`;
    const changed = (['name', 'subjectToken', 'speakerToken'] as const).filter((key) => matches[0][key] !== entry[key]);
    if (changed.length) {
      const labels = { name: '原名', subjectToken: '参考主体编号', speakerToken: '声源编号' };
      return `人物“${entry.name}”的${changed.map((key) => labels[key]).join('、')}与已确认映射不一致；须保留已确认映射。`;
    }
  }
  return undefined;
};

/** Optional metadata only. No names, identities, anchors or dialogue are inferred. */
export const normalizeH3IdentityBindings = (value: unknown): H3IdentityBindings | undefined => {
  return inspectH3IdentityBindings(value).value;
};

export interface H3DeliveryReadOptions {
  /** Content belongs to the AI. Only unreadable transport/body data may reject it. */
  acceptAiAuthoredContent?: boolean;
}

interface H3DeliveryEnvelope {
  h3Prompt: string;
  canonicalPrompt?: string;
  identityBindings?: H3IdentityBindings;
  characterParticipation?: PromptCharacterParticipation;
  shotSourceIds?: string[][];
  shotMetadata?: Array<H3StagingShotMetadata | null>;
  deliveryWarnings?: string[];
  envelope: boolean;
}

/** Read optional data item by item. Bad auxiliary records must not discard the
 * AI's body, and no identity, evidence or missing source mapping is invented. */
const readAiAuthoredEnvelope = (value: Record<string, unknown>): H3DeliveryEnvelope => {
  const warnings: string[] = [];
  const delivery: H3DeliveryEnvelope = { h3Prompt: (value.h3Prompt as string).trim(), envelope: true };
  if (typeof value.canonicalPrompt === 'string' && value.canonicalPrompt.trim()) delivery.canonicalPrompt = value.canonicalPrompt.trim();
  else if (value.canonicalPrompt !== undefined) warnings.push('分镜排程附属数据无法读取，已保留提示词正文，排程待完善。');

  if (value.identityBindings !== undefined) {
    const metadata = value.identityBindings;
    if (!record(metadata) || ![1, '1'].includes(metadata.version as string | number) || !Array.isArray(metadata.characters)) {
      warnings.push('人物身份绑定数据无法读取，已保留正文，参考图关联待完善。');
    } else {
      const characters: H3IdentityBindings['characters'] = [];
      metadata.characters.forEach((item: unknown, index: number) => {
        const entry = inspectH3IdentityBindings({ version: 1, characters: [item] }).value?.characters[0];
        if (entry) characters.push(entry);
        else warnings.push(`第 ${index + 1} 项人物身份绑定数据无法读取，已跳过该项，参考图关联待完善。`);
      });
      if (!metadata.characters.length || characters.length) {
        const events = copyH3IdentityEventBindings(metadata.events);
        const performance = parseH3PerformancePlan(metadata.performance);
        delivery.identityBindings = { version: 1, characters, ...(events ? { events } : {}),
          ...(performance ? { performance } : {}) };
      }
    }
  }
  if (value.characterParticipation !== undefined) {
    const metadata = value.characterParticipation;
    if (!record(metadata) || ![1, '1'].includes(metadata.version as string | number) || !Array.isArray(metadata.characters)) {
      warnings.push('人物参与记录无法读取，已保留正文，选图人物提醒待完善。');
    } else {
      const characters: PromptCharacterParticipation['characters'] = [];
      metadata.characters.forEach((item: unknown, index: number) => {
        const entry = inspectCharacterParticipation({ version: 1, characters: [item] }).value?.characters[0];
        if (entry) characters.push(entry);
        else warnings.push(`第 ${index + 1} 项人物参与记录无法读取，已跳过该项，选图人物提醒待完善。`);
      });
      if (!metadata.characters.length || characters.length) delivery.characterParticipation = { version: 1, characters };
    }
  }
  if (value.shotSourceIds !== undefined) {
    if (!Array.isArray(value.shotSourceIds)) warnings.push('镜头来源记录无法读取，来源关联待完善。');
    else delivery.shotSourceIds = value.shotSourceIds.map((ids: unknown, index: number) => {
      if (!Array.isArray(ids)) { warnings.push(`第 ${index + 1} 镜来源记录无法读取，来源关联待完善。`); return []; }
      const readable = ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
      if (readable.length !== ids.length) warnings.push(`第 ${index + 1} 镜存在无法读取的来源编号，已跳过，来源关联待完善。`);
      return readable;
    });
  }
  if (value.shotMetadata !== undefined) {
    if (!Array.isArray(value.shotMetadata)) warnings.push('镜头附属资料无法读取，已保留正文，镜头资料待完善。');
    else delivery.shotMetadata = value.shotMetadata.map((item: unknown, index: number) => {
      try { return readH3StagingShotMetadata([item])?.[0] ?? null; }
      catch { warnings.push(`第 ${index + 1} 镜附属资料无法读取，已保留正文，镜头资料待完善。`); return null; }
    });
  }
  if (warnings.length) delivery.deliveryWarnings = warnings;
  return delivery;
};

/** One response may carry structured delivery metadata without putting JSON in H3. */
export const readH3DeliveryEnvelope = (response: string, options: H3DeliveryReadOptions = {}): H3DeliveryEnvelope => {
  const text = response.trim();
  if (options.acceptAiAuthoredContent && !text) throw new Error('AI返回空提示词正文，原有结果保持不变。');
  if (!text.startsWith('{') && !text.startsWith('```')) return { h3Prompt: text, envelope: false };
  const json = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let value: unknown;
  try { value = JSON.parse(json); } catch {
    throw new Error('AI交付数据不是完整JSON，请返回包含canonicalPrompt与h3Prompt的完整交付对象。');
  }
  if (!record(value) || typeof value.h3Prompt !== 'string' || !value.h3Prompt.trim()) {
    throw new Error('AI交付数据缺少完整h3Prompt正文，原有结果保持不变。');
  }
  if (options.acceptAiAuthoredContent) return readAiAuthoredEnvelope(value);
  if (value.canonicalPrompt !== undefined && (typeof value.canonicalPrompt !== 'string' || !value.canonicalPrompt.trim())) {
    throw new Error('AI交付数据的canonicalPrompt必须是完整六字段排程，原有结果保持不变。');
  }
  const fieldIssues: H3DeliveryFieldIssue[] = [];
  if (value.shotSourceIds !== undefined) {
    if (!Array.isArray(value.shotSourceIds)) fieldIssues.push(h3FieldIssue('shotSourceIds', '逐镜来源数组', value.shotSourceIds));
    else value.shotSourceIds.forEach((ids: unknown, index) => {
      if (!Array.isArray(ids)) fieldIssues.push(h3FieldIssue(`shotSourceIds[${index}]`, '源镜头编号数组', ids));
      else ids.forEach((id: unknown, sourceIndex) => {
        if (typeof id !== 'string' || !id.trim()) fieldIssues.push(h3FieldIssue(`shotSourceIds[${index}][${sourceIndex}]`, '非空源镜头编号字符串', id));
      });
    });
  }
  const shotSourceIds = value.shotSourceIds as string[][] | undefined;
  let shotMetadata: Array<H3StagingShotMetadata | null> | undefined;
  try { shotMetadata = readH3StagingShotMetadata(value.shotMetadata); } catch (error) {
    if (!(error instanceof H3DeliveryValidationError)) throw error;
    fieldIssues.push(...error.issues);
  }
  const identity = Object.prototype.hasOwnProperty.call(value, 'identityBindings') ? inspectH3IdentityBindings(value.identityBindings) : undefined;
  if (identity) fieldIssues.push(...identity.issues);
  if (fieldIssues.length) throw new H3DeliveryValidationError(fieldIssues,
    identity?.issues.length ? 'AI交付identityBindings格式无效，不能静默丢弃已声明的绑定记录' : 'AI交付镜头元数据格式无效');
  const identityBindings = identity?.value;
  const participation = Object.prototype.hasOwnProperty.call(value, 'characterParticipation')
    ? inspectCharacterParticipation(value.characterParticipation) : undefined;
  if (participation?.issues.length) throw new H3DeliveryValidationError([
    h3FieldIssue('characterParticipation', participation.issues.join(' '), value.characterParticipation),
  ], 'AI交付人物参与记录格式无效');
  const bindingIssues = getH3IdentityBindingIssues(value.h3Prompt, identityBindings);
  if (bindingIssues.length) throw new H3IdentityMetadataError(`AI交付人物身份绑定与正文不同步：${bindingIssues.map((issue) => `人物“${issue.name}”[${issue.code}] ${issue.message}`).join(' ')}`);
  return {
    h3Prompt: value.h3Prompt.trim(), envelope: true,
    ...(typeof value.canonicalPrompt === 'string' ? { canonicalPrompt: value.canonicalPrompt.trim() } : {}),
    ...(identityBindings ? { identityBindings } : {}),
    ...(participation?.value ? { characterParticipation: participation.value } : {}),
    ...(shotSourceIds ? { shotSourceIds } : {}),
    ...(shotMetadata ? { shotMetadata } : {}),
  };
};

/** One final-delivery stage owns this reader, including its technical retries.
 * A rejected first response still declared metadata: a later response cannot
 * evade the error by removing that declaration or its known character IDs. */
export const createH3IdentityDeliveryReader = (
  initialBindings?: H3IdentityBindings,
  characters?: readonly H3IdentityCharacter[],
  options: H3DeliveryReadOptions & { requireParticipation?: boolean } = {},
) => {
  const requiredBindings = initialBindings ? structuredClone(initialBindings) : undefined;
  // Draft voice/Subject choices are not confirmed facts. Only protect known
  // character IDs until the caller has accepted the whole paired delivery.
  const declaredIds = new Set<string>();
  let declared = initialBindings !== undefined;
  let hadCharacters = Boolean(initialBindings?.characters.length);
  return (response: string): ReturnType<typeof readH3DeliveryEnvelope> => {
    if (options.acceptAiAuthoredContent) {
      const delivery = readH3DeliveryEnvelope(response, options);
      const warnings = [...(delivery.deliveryWarnings || [])];
      if (!delivery.identityBindings && (initialBindings || characters?.length)) {
        warnings.push('未取得可读取的人物身份绑定，已保留正文，参考图关联待完善。');
      }
      if (options.requireParticipation && !delivery.characterParticipation) {
        warnings.push('未取得可读取的人物参与记录，已保留正文，选图人物提醒待完善。');
      }
      if (warnings.length) delivery.deliveryWarnings = [...new Set(warnings)];
      return delivery;
    }
    const text = response.trim();
    if (text.startsWith('{') || text.startsWith('```')) {
      let raw: unknown;
      try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); } catch { /* The ordinary reader reports incomplete JSON. */ }
      if (record(raw) && Object.prototype.hasOwnProperty.call(raw, 'identityBindings')) {
        declared = true;
        const normalized = normalizeH3IdentityBindings(raw.identityBindings);
        if (!requiredBindings && normalized) for (const entry of normalized.characters) {
          if (!characters || characters.some((item) => item.id === entry.characterId)) declaredIds.add(entry.characterId);
        }
        const rawCharacters = record(raw.identityBindings) ? raw.identityBindings.characters : undefined;
        hadCharacters ||= Array.isArray(rawCharacters) ? rawCharacters.length > 0 : !normalized;
      }
    }
    const delivery = readH3DeliveryEnvelope(response);
    if (options.requireParticipation && !delivery.characterParticipation) {
      throw new H3DeliveryValidationError([h3FieldIssue('characterParticipation', '与本次最终H3同步的version=1人物参与记录', undefined)]);
    }
    if (declared && !delivery.identityBindings) throw new H3IdentityMetadataError('本轮已声明identityBindings，技术重试不能遗漏绑定记录后继续保存。');
    if (hadCharacters && !delivery.identityBindings?.characters.length) throw new H3IdentityMetadataError('本轮已声明人物绑定，技术重试不能清空characters来消除绑定错误。');
    for (const id of declaredIds) {
      if (delivery.identityBindings?.characters.filter((entry) => entry.characterId === id).length !== 1) {
        throw new H3IdentityMetadataError('本次交付遗漏或重复了已声明的人物绑定记录，不能通过删除人物来消除错误。');
      }
    }
    const issues = getH3IdentityBindingIssues(delivery.h3Prompt, delivery.identityBindings, characters);
    if (issues.length) throw new H3IdentityMetadataError(`AI交付人物绑定无效：${issues.map((issue) => `人物“${issue.name}”[${issue.code}] ${issue.message}`).join(' ')}`);
    const retentionIssue = h3IdentityBindingRetentionIssue(requiredBindings, delivery.identityBindings);
    if (retentionIssue) throw new H3IdentityMetadataError(retentionIssue);
    if (delivery.characterParticipation) {
      const participationIssues = characterParticipationIssues(delivery.h3Prompt, delivery.characterParticipation,
        characters || [...new Map(delivery.characterParticipation.characters.map((entry) => [entry.characterId, { id: entry.characterId, name: entry.name }])).values()], delivery.identityBindings);
      if (options.requireParticipation && characters) participationIssues.push(...characterParticipationCoverageIssues(
        delivery.h3Prompt, delivery.characterParticipation, characters,
      ));
      if (participationIssues.length) throw new H3DeliveryValidationError([
        h3FieldIssue('characterParticipation', participationIssues.join(' '), delivery.characterParticipation),
        ...(participationIssues.some((issue) => issue.includes('identityBindings'))
          ? [h3FieldIssue('identityBindings', '覆盖已声明实际出镜或发声人物的唯一身份记录', delivery.identityBindings)] : []),
      ], 'AI交付人物参与记录与身份绑定不同步');
    }
    return delivery;
  };
};

export const H3_IDENTITY_BINDINGS_RULE = [
  H3_IDENTITY_SCHEMA_RULE,
  'identityBindings是交付元数据，不是H3正文中的新section。返回version:1和characters数组；每项为characterId、原名name、可选subjectToken（只复用正文已有<Subject N>）、可选speakerToken（本段实际发声者的稳定(Sn)）、可选relationship、referenceAnchor。characterId必须来自提供的characterIdentityFacts，不按姓名猜测ID；无绑定资料的临时人物不虚构资产ID。relationship仅简记输入已有明确人物关系与称呼对象，未知时省略，不从称谓或近邻句推断关系。',
  '人物原名是稳定身份锚点：name及中文原名在中文稿、英文稿和各镜正文中保持原字，不翻译、音译或以“师父/师姐”等关系称谓替代不同人物。依据已给出的明确关系区分谁说话、谁听话和台词中谁被称呼；称呼对象不是说话人，同一人物换镜、换语言或被不同人称呼仍沿用同一characterId及已声明Subject/声源。',
  '在本次已有生成中同时给出可选identityBindings.events，逐项沿用已知源事件或对白的eventId；每项可有kind（action/dialogue）、dialogueId、referenceAnchor、actorCharacterId、targetCharacterIds、speakerCharacterId、listenerCharacterIds、addressedCharacterIds。referenceAnchor逐字引用本次H3中唯一对应的动作或发话正文片段，可包含已有动作区间和<d>，不包含section、[Shot]或At切点。动作的actor/target与对白的speaker/listener/addressed分别关联输入已有characterId，动作实施者不得从说话人、称呼对象或邻近人物反推；未知字段省略。元数据只记录本次已有动作与对白，不新增事件、镜头、时间或发话。',
  'referenceAnchor必须逐字等于h3Prompt中仅出现一次的一条独立、简短纯视觉身份定义句。full-reference把这句写在subject_definitions内；三字段把这句自然写在该人物首次实际出现或发声的[Shot N]正文内，不限首镜，不放在镜头标记之前，不增section。后镜、远景、背影或静默人物同样不能遗漏，身份定义不是强迫人物提前入画。该句可包含完整姓名、已有Subject与S编号及必要外貌，但不包含Picture标签、动作、对白、口型、剧情结果、[Shot]标记或任何时间片段，不把整镜正文当锚点。可用自然句“Identity: 姓名 (S1), ... .”，不要新增identity:章节。人物实际行动和逐句发话另写在各镜正文。',
  '只给实际发声人物speakerToken，静默人物仍可有视觉身份锚点但不能因主角或有参考图而分配声音。同一人物跨镜speakerToken不变，且与每句<d>紧邻的完整姓名/声源一致；人物不同形态按给定characterId分别对应，不把形态资产按基础姓名合并。identityBindings只定位既有视觉身份，不重复朗读人物名字。',
  '交付前将每项referenceAnchor逐字对照本次最终h3Prompt，必须恰好出现一次且与已声明的Subject/声源编号一致；中文元数据不能配英文正文，后续翻译、衔接、参考更新或协议修复改动身份句时同步返回新的完整identityBindings。不能只改正文后沿用旧锚点，也不能省略、清空或删除已提供人物记录来消除绑定错误。',
].join('\n');

/** Part of the existing final delivery response, never a separate review call. */
export const H3_PERFORMANCE_DELIVERY_RULE = [
  '在本次同一个交付JSON的identityBindings内同时返回performance。它是与当前中文稿配套的视听执行记录，不是新H3章节，不是审核结果。程序使用该记录直接构造H3正文与声源编号；h3Prompt仍返回完整可读稿以兼容历史交付。已有candidateIdentityBindings.performance时沿用其身份、原话和已确认排程，只修改本次获准部分。',
  'performance结构：{version:1,timeBase:"shot"或"clip",descriptionLanguage:"zh",characters:[{characterId,name?,presence?:"visible"或"offscreen",visualDescription,voiceDescription?}],shots:[{shotIndex,startSec,visualDescription,events:[]}],overallSoundscape,nonDiegeticMusic,summary?,retentionAnalysis?}。shots.startSec始终是当前15秒等提交片段内切点；events的startSec/endSec服从唯一timeBase。沿用镜内相对发话时间时填写shot，已转为本段绝对时间才填clip，不重复偏移。镜数、切点、摄影、声音的修改权限沿用本次taskAuthority。',
  '每个事件用稳定eventId关联来源，sourceFact保留原叙述/观察/认知及原文依据；sourceFact不会输出给视频。静默事件kind:"visual"，用description只写当前已采用的可见表演，silentCharacterIds列本次静默人物，必要局部音效写soundDescription。例：观察者环视场地后看回眼前人并皱眉；“确认未见某人”的背景判断留在sourceFact，不再在description、人物介绍、镜头概述或声景里作为一整句可朗读解释重复。不得凭空补被提及人物、闪回或配音，也不机械删除所有心理词；已采用动作完整保留。',
  '实际发话事件kind:"speech"，字段eventId、dialogueId、speakerCharacterIds（原文明确齐声才多个）、listenerCharacterIds、channel（on-screen/off-screen/voiceover/inner-voice）、startSec/endSec、text（完整原字，不含<d>等标签）、language（如Chinese）、delivery（语气）、speakerAction（只描述发声者动作）、reactions:[{characterId,description,presence:"visible"或"offscreen"}]。说话、口型、声线、听者反应属于这一整组，不能把同一句另复制进visualDescription或visual事件。人物ID仅用给定身份，不按称呼、镜头主角或参考图序号猜人；明确旁白、心声按原授权channel记录，未授权的认知叙述不变speech。',
  '原文真实的笑、哭、咳等非词汇人声使用kind:"vocal"，沿用speakerCharacterIds/channel/delivery/speakerAction/reactions并用vocalDescription写实际声音，不创造可辨词句。同一句明确跨镜时按已采用切口记录各镜实际词段，dialogueId相同并使用continuesFromPreviousShot/continuesInNextShot，不重复整句、不新造切点。人物静态视觉/声线放在characters，不把身份介绍变发话；静默人物不填speakerToken，程序按实际voice事件统一分配。原文明确的无资产旁白或画外声可用该源发声事件稳定ID作为局部声源ID，在performance.characters记录原有name与presence:offscreen，不虚构项目人物、参考图或画内身体。',
  'visualDescription写本镜摄影、空间、光影和当前场面，不重复执行events的对白及动作。每个既有动作、真实音效、对白与听者回应都有对应归属，不因结构化丢掉背景、道具、攻击承接、收尾或非说话表情。反应description只描述对应characterId的动作，发话时只有speakerCharacterIds做对应口型；静默不等于冻结表情或整轨静音。overallSoundscape与nonDiegeticMusic保留当前合法声音方案，完整写两个字段；没有相应内容写N/A，不自动添加全局底噪或配乐。',
].join('\n');
