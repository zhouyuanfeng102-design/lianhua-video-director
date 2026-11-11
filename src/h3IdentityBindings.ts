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

const bindingFieldKeys = new Set(['version', 'characters', 'events', 'performance']);

/** A prose H3 body can be followed by the sidecar the delivery already asked
 * for. That object belongs in the existing metadata fields. */
const splitTrailingH3Sidecar = (text: string): { h3Prompt: string; identityBindings?: unknown; characterParticipation?: unknown } | undefined => {
  const heading = /(?:^|\n)[ \t]*non_diegetic_music[ \t]*[:：]/u.exec(text);
  if (!heading || heading.index === undefined) return undefined;
  const after = heading.index + heading[0].length;
  const brace = text.indexOf('{', after);
  if (brace < 0) return undefined;
  let value: unknown;
  try { value = JSON.parse(text.slice(brace).trim()); } catch { return undefined; }
  if (!record(value)) return undefined;
  const keys = Object.keys(value);
  let identityBindings: unknown;
  let characterParticipation: unknown;
  if (keys.some((key) => key === 'identityBindings' || key === 'characterParticipation')
    && keys.every((key) => key === 'identityBindings' || key === 'characterParticipation' || key === 'h3Prompt' || key === 'canonicalPrompt')) {
    identityBindings = value.identityBindings;
    characterParticipation = value.characterParticipation;
  } else if (keys.includes('version') && Array.isArray(value.characters) && keys.every((key) => bindingFieldKeys.has(key))) {
    const looksLikeIdentity = value.characters.some((item) => record(item) && (
      Object.prototype.hasOwnProperty.call(item, 'referenceAnchor')
      || Object.prototype.hasOwnProperty.call(item, 'speakerToken')
      || Object.prototype.hasOwnProperty.call(item, 'subjectToken')
    )) || Array.isArray(value.events) || value.performance !== undefined || value.characters.length === 0;
    const looksLikeParticipation = value.characters.some((item) => record(item) && (
      Object.prototype.hasOwnProperty.call(item, 'presence')
      || Object.prototype.hasOwnProperty.call(item, 'shotIndex')
      || Object.prototype.hasOwnProperty.call(item, 'evidence')
    ));
    if (looksLikeIdentity) identityBindings = value;
    else if (looksLikeParticipation) characterParticipation = value;
  }
  if (identityBindings === undefined && characterParticipation === undefined) return undefined;
  const h3Prompt = text.slice(0, brace).trim();
  if (!h3Prompt) return undefined;
  return { h3Prompt, ...(identityBindings !== undefined ? { identityBindings } : {}),
    ...(characterParticipation !== undefined ? { characterParticipation } : {}) };
};

/** One response may carry structured delivery metadata without putting JSON in H3. */
export const readH3DeliveryEnvelope = (response: string, options: H3DeliveryReadOptions = {}): H3DeliveryEnvelope => {
  const text = response.trim();
  if (options.acceptAiAuthoredContent && !text) throw new Error('AI返回空提示词正文，原有结果保持不变。');
  if (!text.startsWith('{') && !text.startsWith('```')) {
    if (options.acceptAiAuthoredContent) {
      const split = splitTrailingH3Sidecar(text);
      if (split) return readAiAuthoredEnvelope({ h3Prompt: split.h3Prompt,
        ...(split.identityBindings !== undefined ? { identityBindings: split.identityBindings } : {}),
        ...(split.characterParticipation !== undefined ? { characterParticipation: split.characterParticipation } : {}) });
    }
    return { h3Prompt: text, envelope: false };
  }
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
  'h3Prompt写到non_diegetic_music为止。人物、事件和performance只放外层JSON的identityBindings。外层包含h3Prompt和identityBindings；identityBindings同时承载version、characters及本次任务要求的events和performance，不用仅有characters的缩减对象替代完整交付。performance是本次已授权生成或重写的唯一视听执行来源，h3Prompt是同一执行记录的可读表示；纯读取历史稿不补造performance。不要在N/A后面再附身份JSON。',
  'identityBindings是交付元数据，不是H3正文中的新section。返回version:1和characters数组；每项为characterId、原名name、可选subjectToken（只复用正文已有<Subject N>）、可选speakerToken（本段实际发声者的稳定(Sn)）、可选relationship、referenceAnchor。characterId必须来自提供的characterIdentityFacts，不按姓名猜测ID；无绑定资料的临时人物不虚构资产ID。relationship仅简记输入已有明确人物关系与称呼对象，未知时省略，不从称谓或近邻句推断关系。',
  '人物原名是稳定身份锚点：name及中文原名在中文稿、英文稿和各镜正文中保持原字，不翻译、音译或以“师父/师姐”等关系称谓替代不同人物。依据已给出的明确关系区分谁说话、谁听话和台词中谁被称呼；称呼对象不是说话人，同一人物换镜、换语言或被不同人称呼仍沿用同一characterId及已声明Subject/声源。',
  '在本次已有生成中同时给出可选identityBindings.events，逐项沿用已知源事件或对白的eventId；每项可有kind（action/dialogue）、dialogueId、referenceAnchor、actorCharacterId、targetCharacterIds、speakerCharacterId、listenerCharacterIds、addressedCharacterIds。referenceAnchor逐字引用本次H3中唯一对应的动作或发话正文片段，可包含已有动作区间和<d>，不包含section、[Shot]或At切点。动作的actor/target与对白的speaker/listener/addressed分别关联输入已有characterId，动作实施者不得从说话人、称呼对象或邻近人物反推；未知字段省略。元数据只记录本次已有动作与对白，不新增事件、镜头、时间或发话。',
  'referenceAnchor必须逐字等于h3Prompt中仅出现一次的一条独立、简短纯视觉身份定义句。full-reference把这句写在subject_definitions内；三字段把这句自然写在该人物首次实际出现或发声的[Shot N]正文内，不限首镜，不放在镜头标记之前，不增section。后镜、远景、背影或静默人物同样不能遗漏，身份定义不是强迫人物提前入画。该句可包含完整姓名、已有Subject与S编号及必要外貌，但不包含Picture标签、动作、对白、口型、剧情结果、[Shot]标记或任何时间片段，不把整镜正文当锚点。可用自然句“Identity: 姓名 (S1), ... .”，不要新增identity:章节。人物实际行动和逐句发话另写在各镜正文。',
  '只给实际发声人物speakerToken，静默人物仍可有视觉身份锚点但不能因主角或有参考图而分配声音。同一人物跨镜speakerToken不变，且与每句<d>紧邻的完整姓名/声源一致；人物不同形态按给定characterId分别对应，不把形态资产按基础姓名合并。identityBindings只定位既有视觉身份，不重复朗读人物名字。',
  '交付前将每项referenceAnchor逐字对照本次最终h3Prompt，必须恰好出现一次且与已声明的Subject/声源编号一致；中文元数据不能配英文正文，后续翻译、衔接、参考更新或协议修复改动身份句时同步返回新的完整identityBindings。不能只改正文后沿用旧锚点，也不能省略、清空或删除已提供人物记录来消除绑定错误。',
].join('\n');

/** Part of the existing final delivery response, never a separate review call. */
export const H3_PERFORMANCE_DELIVERY_RULE = [
  'H3_SINGLE_SPEECH_SOURCE_V1：本次新生成或获准重做的交付只在identityBindings.performance记录一套实际执行事件；新稿返回的最终完整JSON同时包含performance，不因后面的简写字段示例而省略它。canonicalPrompt是来源排程，h3Prompt是同一performance的可读表示，不再分别编写三份不同的发话。每次真实发话对应一个speech事件，逐字原话只放该事件的text；visualDescription、visual.description、delivery、speakerAction、reactions、summary、retentionAnalysis和声景只描述各自职责，不再用引号、转述原话或另一组发话时间复演同句。sourceFact可保留原文证据，它不进入视频正文。',
  '按事件身份而非字面相同合并：原文确实两次说同一句时保留两个不同eventId/dialogueId及各自时窗；同一句跨镜续说保留同一dialogueId、各镜实际词段与已有续接标记。仅被提及、可见文字、非语言声音与人物发话职责独立，不把它们改成另一句speech，也不为凑字段另起旁白。',
  '新稿按已确认排程写清每位当前可见人物在发话前、发话时和发话后的自然动作与嘴部状态，包括听者和本段最后一次发话后的尾镜；台词结束后嘴唇保持合拢，原有动作与表情继续，直到原定下一次发话。画外声与心声保留原类别。只在已有visual或speech事件的适当字段自然表达这些状态，不补一条新的声音轨或时序，不扩写台词、增加填空人声、底噪或配乐。低声仍保持字音清楚，确有依据的耳语或非语言声音按原表演保留。',
  '在本次同一个交付JSON的identityBindings内同时返回performance。它是与当前中文稿配套的视听执行记录，不是新H3章节，不是审核结果。程序使用该记录直接构造H3正文、完整官方章节与声源编号；h3Prompt仍返回完整可读稿以兼容历史交付。已有candidateIdentityBindings.performance时沿用身份、原话与全部动作，只修改本次获准部分。action-retiming明确授权重排事件时窗及已有镜界，更新同一performance和canonicalPrompt，不继承旧等分时间；翻译、参考更新等操作仍保留已确认排程。',
  'performance结构：{version:1,timeBase:"shot"或"clip",descriptionLanguage:"zh",characters:[{characterId,name?,presence?:"visible"或"offscreen",visualDescription,voiceDescription?}],shots:[{shotIndex,startSec,visualDescription,events:[]}],overallSoundscape,nonDiegeticMusic,summary?,retentionAnalysis?}。中文稿的visualDescription、speakerAction和overallSoundscape只写中文，英文例句不抄进这些字段。shots.startSec始终是当前15秒等提交片段内切点；events的startSec/endSec服从唯一timeBase。沿用镜内相对发话时间时填写shot，已转为本段绝对时间才填clip，不重复偏移。镜数、切点、摄影、声音的修改权限沿用本次taskAuthority。',
  '每个事件用稳定eventId关联来源，sourceFact保留原叙述/观察/认知及原文依据；sourceFact不会输出给视频。静默事件kind:"visual"，用description只写当前已采用的可见表演，silentCharacterIds列本次静默人物，必要局部音效写soundDescription。新稿的soundDescription必须以当前动作或发声对象、实际接触双方的材质、力度和事件startSec/endSec为依据；视觉身份、题材、静置或携带的兵器和参考图本身不是声源。空手动作不因武侠、剑客或持剑参考图获得出鞘、碰刃或金属撞击；拿起、携带或查看一件兵器不等于两件兵器相撞。实际发生的出鞘、碰刃、金属部件互碰或兵器撞击硬物仍按真实接触保留，不机械禁用金属声。例：观察者环视场地后看回眼前人并皱眉；“确认未见某人”的背景判断留在sourceFact，不再在description、人物介绍、镜头概述或声景里作为一整句可朗读解释重复。不得凭空补被提及人物、闪回或配音，也不机械删除所有心理词；已采用动作完整保留。',
  '实际发话事件kind:"speech"，字段eventId、dialogueId、speakerCharacterIds（原文明确齐声才多个）、listenerCharacterIds、channel（on-screen/off-screen/voiceover/inner-voice）、startSec/endSec、text（完整台词，不含<d>等标签）、language（中文台词填Chinese，英文台词填English；text仍保留原语种原话）、delivery（语气）、speakerAction（人在画面里时只写身体：躯干在遮挡物下面还是在床面上，膝和髋弯还是直，胸口朝向谁；人不在这一镜时只写人留在画面外；不写摄影机说明，不写画面里的嘴）、reactions:[{characterId,description,presence:"visible"或"offscreen"}]。引号内和明确逐字原话的text必须逐字取自当前原剧情；说话人和话题转述的text可在获准生成阶段整理为自然完整句，但只能使用原文事实、称谓、对象和语气，不增加新事实。其余动作描述、人物资料、声音说明及整体声景都不是可朗读内容，未声明speech的文字不转为台词或旁白。按原剧情和已有角色关系把实际听者写入listenerCharacterIds；人在画面里照面说话时，在speakerAction里写胸口和眼睛留在听者身上，摄影机在两人连线的侧面。他在她身后的舔、含、舌、碾、磨、抬、进入、滑入、抵上或抽送，主体仍是原文里的姓名，不改成阴唇、穴口、阴蒂或屁股。用她的姓名写：她的头留在她的脖子上，胸和背留在她的躯干上，这截躯干连着她的髋。阴唇、穴口、阴蒂留在这个髋上，朝向和髋相同。他留在她身后，胸口对着她的背，脸对着她的背。不写他站到两腿中间、脸冲着镜头。他的舌留在他的嘴里，再够到她髋上的部位。进入、滑入、抵上或抽送时，写他的阴茎留在他身上，从她屁股后面进入并留在她的阴道里，抽送时仍留在这阴道里。手留在剧情写明的腰或髋上。不写没有姓名的这一条躯干或每只脚。原文没有写特写时，画面里留着两个人。写这一镜前先读剧情，确认谁对谁做了什么、这个人此刻只站在哪一处。同一个人只写这一处。侧脸近景只写剧情里被取景的这个人。上一镜他已经在她身后、这一镜只是看她的脸时，仍用这个姓名写他留在原来的身后，声音从他那里来，不在头侧再站一个人。剧情能确定他或她是谁时写成这个姓名。站位、接触的两端、嘴的开合和配乐都写进 visualDescription、speakerAction、overallSoundscape 和 nonDiegeticMusic。程序原样使用这些句子，不另补一句，也不改写。channel为off-screen、voiceover或inner-voice时，说话人留在这一镜画面外，speakerAction不写胸口、眼睛或画面里的嘴；visualDescription只写真正入画的人。同一镜换成另一个人说话时，上一句的人嘴先闭上；新的一句开始时，若这张嘴还不是画面里能看清的那张，镜头先以小幅度、慢速度转到这张嘴，再写这张嘴张开。听的人和刚才说完的人都不接这句。躲、钻、藏在床底、桌下、柜内或门后时，写躯干留在遮挡物下面，膝和髋是弯的。不把摄影机说明写成动作。也不凭空指定剧情未确认的对象。发话区间须容纳完整台词、语气、停顿与必要动作；换人接话时上一句结束后再开始下一句，按剧情留出自然交接，在本次获准排程范围内先精简重复的身份、声线和情绪修饰，再按事件先后为每一句完整原话和必要动作留出连续时间；不靠强制加速朗读塞词，不删原话、不删动作、不把后一句留到窗外。已确认时间轴的翻译或纯格式修复不重新排程。同一句原话再次出现仍各自写成一次speech。只有标明跨切镜接着说的同一句才用continuesFromPreviousShot；只有原剧情明确抢话、重叠或齐声时才安排重叠。说话、口型、声线、听者反应属于这一整组，不能把同一句另复制进visualDescription或visual事件。人物ID仅用给定身份，不按称呼、镜头主角或参考图序号猜人；明确旁白、心声按原授权channel记录，未授权的认知叙述不变speech。',
  '原文真实的笑、哭、咳等非词汇人声使用kind:"vocal"，沿用speakerCharacterIds/channel/delivery/speakerAction/reactions并用vocalDescription写实际声音，不创造可辨词句；每个vocal只归属实际发生的事件和镜头及其时间范围，不把局部人声抬升或复述进overallSoundscape，也不延长成跨镜声床。明确原文未给对应人声时不新增。对白明确跨镜时按已采用切口记录各镜实际词段，dialogueId相同并使用continuesFromPreviousShot/continuesInNextShot，不重复整句、不新造切点。人物静态视觉/声线放在characters，不把身份介绍变发话；静默人物不填speakerToken，程序按实际voice事件统一分配。原文明确的无资产旁白或画外声可用该源发声事件稳定ID作为局部声源ID，在performance.characters记录原有name与presence:offscreen，不虚构项目人物、参考图或画内身体。',
  'visualDescription写本镜摄影、空间、光影和当前场面，不重复执行events的对白及动作；有明确发话对象时，镜头内相关人物的身体/头部方向和视线按已知人物关系朝向说话者或听者，摄影机视角另行说明，不把“正脸”“看向镜头”当作默认注视对象。每个既有动作、真实音效、对白与听者回应都有对应归属，不因结构化丢掉背景、道具、攻击承接、收尾或非说话表情。反应description只描述对应characterId的动作，发话时只有speakerCharacterIds做对应口型；静默不等于冻结表情或整轨静音。overallSoundscape与nonDiegeticMusic分别完整填写：overallSoundscape只写整段简短的全局声学概括，不复述台词、逐句声线或已记入vocal事件的喘息等非语言人声；它不是一次性事件清单或第二条音效轨。没有持续底噪但有局部动作声时，只概括间隙安静、同期声随对应事件发生与结束，不列具体动作、器物、材质或时刻，不新增声源、不把局部声音延长成全局声床；只有明确全片完全静音时才写N/A。nonDiegeticMusic在没有本次明确配乐授权且没有需保真的已确认音乐时只写N/A这两个字符，不写乐器、旋律或电影感配器；仅调整动作、格式或参考图时保留已确认配乐安排，不用新稿默认覆盖历史音乐。两个字段职责不同，不能一起按“没有持续背景声”写N/A。',
  '新生成的对白必须在已确认时间窗内清楚说完<d>中的逐字原话。characters.voiceDescription只写有来源依据的稳定声线身份，speech事件delivery只写本句情绪、力度和节奏；同一声线特征不要重复出现在两处，避免每句叠加低声、断续、气声、喘息等相似修饰。原剧情明确要求的耳语、喘息或特殊声线仍保留，但不遮盖原话；不把这些表演直接删改为常态。新写的H3中文对白标签用[Chinese]，并将台词原字保留。',
  '将当前分段的sourceEvents、sourceDialogues和已采纳执行稿按原顺序落实到本段现有shots与performance.events；不能用summary、retention或场景概述代替逐镜可见动作。后出现于本段的事件继续写在后镜，明确当前入画主体、动作发生过程和可见结果；最后一镜在本段已确认的事件窗口内写出最后一个已分配事件的当前结果，并自然到达固定段尾。时间轴已经确认时不为追求完整而改动切点或把事件挪出当前段；原剧情在段尾仍进行中时保留进行中的末态，交给下一段承接。没有既定排程且本次获准安排仍有可用时间时，才给片尾事件写足能看见过程和结果的连续时间窗。不加入后续分段的剧情。',
].join('\n');
