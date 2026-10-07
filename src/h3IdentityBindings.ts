import type { H3IdentityBindings, PromptCharacterParticipation } from './types';
import { characterParticipationCoverageIssues, characterParticipationIssues, inspectCharacterParticipation } from './characterParticipation';
import { readH3StagingShotMetadata, type H3StagingShotMetadata } from './h3StagingMetadata';
import { H3DeliveryValidationError, H3IdentityMetadataError, H3_IDENTITY_SCHEMA_RULE, h3FieldIssue, inspectH3IdentityBindings, type H3DeliveryFieldIssue } from './h3DeliverySchema';

const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export type H3IdentityBindingIssueCode = 'invalid-bindings' | 'anchor-empty' | 'anchor-missing' | 'anchor-ambiguous'
  | 'anchor-protocol-content' | 'anchor-payload' | 'anchor-section' | 'anchor-shot' | 'anchor-boundary'
  | 'duplicate-character' | 'duplicate-anchor' | 'duplicate-subject' | 'duplicate-speaker'
  | 'unknown-character' | 'character-name-mismatch' | 'subject-token-mismatch' | 'speaker-token-mismatch';
export interface H3IdentityBindingIssue {
  code: H3IdentityBindingIssueCode;
  characterId: string;
  name: string;
  message: string;
}
export type H3IdentityCharacter = Readonly<{ id: string; name: string }>;

const identitySectionPattern = (): RegExp => /^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu;
const anchorIssue = (prompt: string, anchor: string): Pick<H3IdentityBindingIssue, 'code' | 'message'> | undefined => {
  if (!anchor.trim()) return { code: 'anchor-empty', message: '身份定位句为空。' };
  const first = prompt.indexOf(anchor);
  if (first < 0) return { code: 'anchor-missing', message: '身份定位句不在当前语言的正文中。' };
  if (prompt.indexOf(anchor, first + 1) >= 0) return { code: 'anchor-ambiguous', message: '身份定位句在正文中重复，无法唯一定位。' };
  if (/[\r\n]|<\/?(?:d|sound|Picture|Video|Audio)\b|\[Shot\s|\bAt\s+\d{2}:|\d+(?:\.\d+)?\s*(?:秒|seconds?\b|s\b)|\b\d{1,2}:\d{2}(?:\.\d+)?\b/iu.test(anchor)) {
    return { code: 'anchor-protocol-content', message: '身份定位句包含图片、镜头、时间或声音协议内容，不能作为纯身份定位。' };
  }
  for (const match of prompt.matchAll(/<(d|sound)>[\s\S]*?(?:<\/\1>|$)/giu)) {
    if (first < match.index! + match[0].length && first + anchor.length > match.index!) return { code: 'anchor-payload', message: '身份定位句位于对白或声音内容中。' };
  }
  const sections = [...prompt.matchAll(identitySectionPattern())];
  const sectionIndex = sections.filter((section) => section.index! <= first).length - 1;
  const section = sections[sectionIndex];
  if (!section || !['subject_definitions', 'integrated_multimodal_description'].includes(section[1])
    || first + anchor.length > (sections[sectionIndex + 1]?.index ?? prompt.length)) {
    return { code: 'anchor-section', message: '身份定位句不在 subject_definitions 或逐镜视觉正文中。' };
  }
  if (section[1] === 'integrated_multimodal_description') {
    const shots = [...prompt.slice(section.index! + section[0].length, first).matchAll(/\[Shot\s+(\d+)\]/gu)];
    if (!shots.length) return { code: 'anchor-shot', message: '三字段正文的身份定位句必须位于一个实际 [Shot N] 内。' };
    if (/\[Shot\s+\d+\]/u.test(prompt.slice(first, first + anchor.length))) return { code: 'anchor-shot', message: '身份定位句不能跨越镜头边界。' };
  }
  // Only check literal sentence boundaries; do not infer whether prose is a
  // name, an action or a visual description from word lists.
  const before = prompt.slice(0, first).trimEnd();
  const after = prompt.slice(first + anchor.length);
  if (before && !/[\n。.!?！？:：;；]$/u.test(before) && !/\[Shot\s+[1-9]\d*\](?:\s+At\s+\d{2}:\d{2}(?:\.\d+)?\s*[,，:]?)?$/u.test(before)
    && !/\r?\n[ \t]*$/u.test(prompt.slice(0, first))) return { code: 'anchor-boundary', message: '身份定位句的开头不是独立句边界。' };
  if (!/[。.!?！？;；]$/u.test(anchor.trimEnd()) && !/^(?:[ \t]*\r?\n|$)/u.test(after)) {
    return { code: 'anchor-boundary', message: '身份定位句的结尾不是独立句边界。' };
  }
  return undefined;
};

/** Exact offsets and protocol syntax only. No identity or story inference. */
export const h3IdentityAnchorIssue = (prompt: string, anchor: string): string | undefined => anchorIssue(prompt, anchor)?.message;

/** Validate the paired delivery, optionally against the request's frozen IDs. */
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
    for (const [field, code, label] of [
      ['characterId', 'duplicate-character', '人物编号'], ['referenceAnchor', 'duplicate-anchor', '身份定位句'],
      ['subjectToken', 'duplicate-subject', 'Subject 编号'], ['speakerToken', 'duplicate-speaker', '声源编号'],
    ] as const) {
      if (entry[field] && normalized.characters.filter((other) => other[field] === entry[field]).length > 1) add(code, `${label}被多个绑定记录共用。`);
    }
    if (characters) {
      const matches = characters.filter((character) => character.id === entry.characterId);
      if (matches.length !== 1) add('unknown-character', '人物编号不在本次源人物资料中，或来源编号不唯一。');
      else if (matches[0].name !== entry.name) add('character-name-mismatch', '绑定记录的原名与该人物编号的源资料不一致。');
    }
    const first = prompt.indexOf(entry.referenceAnchor);
    const linePrefix = first >= 0 ? prompt.slice(prompt.lastIndexOf('\n', first) + 1, first) : '';
    const localSubjects = [...new Set((entry.referenceAnchor.match(/<Subject [1-9]\d*>/gu) || []))];
    const definitionSubjects = [...new Set((linePrefix.match(/<Subject [1-9]\d*>/gu) || []))];
    const subjects = localSubjects.length ? localSubjects : definitionSubjects;
    if (entry.subjectToken && (subjects.length !== 1 || subjects[0] !== entry.subjectToken)
      || !entry.subjectToken && localSubjects.length > 0) add('subject-token-mismatch', 'Subject 编号与定位句及其定义行的声明不一致。');
    const speakers = [...new Set(entry.referenceAnchor.match(/\(S[1-9]\d*\)/gu) || [])];
    if (entry.speakerToken ? speakers.length !== 1 || speakers[0] !== entry.speakerToken : speakers.length > 0) {
      add('speaker-token-mismatch', '声源编号与身份定位句的声明不一致。');
    }
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

/** One response may carry structured delivery metadata without putting JSON in H3. */
export const readH3DeliveryEnvelope = (response: string): {
  h3Prompt: string;
  canonicalPrompt?: string;
  identityBindings?: H3IdentityBindings;
  characterParticipation?: PromptCharacterParticipation;
  shotSourceIds?: string[][];
  shotMetadata?: Array<H3StagingShotMetadata | null>;
  envelope: boolean;
} => {
  const text = response.trim();
  if (!text.startsWith('{') && !text.startsWith('```')) return { h3Prompt: text, envelope: false };
  const json = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let value: unknown;
  try { value = JSON.parse(json); } catch {
    throw new Error('AI交付数据不是完整JSON，请返回包含canonicalPrompt与h3Prompt的完整交付对象。');
  }
  if (!record(value) || typeof value.h3Prompt !== 'string' || !value.h3Prompt.trim()) {
    throw new Error('AI交付数据缺少完整h3Prompt正文，原有结果保持不变。');
  }
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
  options: { requireParticipation?: boolean } = {},
) => {
  const requiredBindings = initialBindings ? structuredClone(initialBindings) : undefined;
  // Draft voice/Subject choices are not confirmed facts. Only protect known
  // character IDs until the caller has accepted the whole paired delivery.
  const declaredIds = new Set<string>();
  let declared = initialBindings !== undefined;
  let hadCharacters = Boolean(initialBindings?.characters.length);
  return (response: string): ReturnType<typeof readH3DeliveryEnvelope> => {
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
  'identityBindings是交付元数据，不是H3正文中的新section。返回version:1和characters数组；每项为characterId、原名name、可选subjectToken（只复用正文已有<Subject N>）、可选speakerToken（本段实际发声者的稳定(Sn)）、referenceAnchor。characterId必须来自提供的characterIdentityFacts，不按姓名猜测ID；无绑定资料的临时人物不虚构资产ID。',
  'referenceAnchor必须逐字等于h3Prompt中仅出现一次的一条独立、简短纯视觉身份定义句。full-reference把这句写在subject_definitions内；三字段把这句自然写在该人物首次实际出现或发声的[Shot N]正文内，不限首镜，不放在镜头标记之前，不增section。后镜、远景、背影或静默人物同样不能遗漏，身份定义不是强迫人物提前入画。该句可包含完整姓名、已有Subject与S编号及必要外貌，但不包含Picture标签、动作、对白、口型、剧情结果、[Shot]标记或任何时间片段，不把整镜正文当锚点。可用自然句“Identity: 姓名 (S1), ... .”，不要新增identity:章节。人物实际行动和逐句发话另写在各镜正文。',
  '只给实际发声人物speakerToken，静默人物仍可有视觉身份锚点但不能因主角或有参考图而分配声音。同一人物跨镜speakerToken不变，且与每句<d>紧邻的完整姓名/声源一致；人物不同形态按给定characterId分别对应，不把形态资产按基础姓名合并。identityBindings只定位既有视觉身份，不重复朗读人物名字。',
  '交付前将每项referenceAnchor逐字对照本次最终h3Prompt，必须恰好出现一次且与已声明的Subject/声源编号一致；中文元数据不能配英文正文，后续翻译、衔接、参考更新或协议修复改动身份句时同步返回新的完整identityBindings。不能只改正文后沿用旧锚点，也不能省略、清空或删除已提供人物记录来消除绑定错误。',
].join('\n');
