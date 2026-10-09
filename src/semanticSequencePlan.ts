import { normalizeStoryReferenceContext } from './storyReferences';
import { MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC, requestedSegmentDurationWindows } from './sequenceDurationContract';
import { sourceContentHash } from './sourceContentHash';
import type { StoryPacingContext } from './storyPacing';
import type {
  Character, SemanticEventCausality, SemanticSegmentSource, SemanticSequenceCharacter, SemanticSequencePlanningSnapshot,
  SequenceDurationMode, SequenceFitStatus, ShotMode, StoryVisualConversionSnapshot, VideoSegment, VideoSequencePlan,
} from './types';
import { buildVideoCreativeDirection, normalizeVideoCreativeDirection } from './videoCreativeDirection';
import type { VideoCreativeDirection } from './videoCreativeDirection';

export interface SemanticSequencePlanningInput {
  title: string;
  story: string;
  segmentDurationSec: number;
  /** Omission preserves the existing AI-owned segment count contract. */
  durationMode?: SequenceDurationMode;
  /** Only fixed mode owns this budget; AI mode ignores prior request values. */
  requestedTotalDurationSec?: number;
  directorSettingsFingerprint: string;
  creativeDirection: VideoCreativeDirection;
  pacing?: StoryPacingContext;
  characterContinuity?: readonly SemanticSequenceCharacter[];
  /** Original novel paired with this adopted visual-description story. */
  originalSourceContext?: StoryVisualConversionSnapshot;
  sourceSceneIds?: readonly string[];
  shotMode?: ShotMode;
  shotCount?: number;
}

export interface SemanticSequenceResponseSegment {
  title: string;
  content: string;
  summary: string;
  narrativePurpose: string;
  entryState: string;
  exitState: string;
  transitionHint: string;
  boundaryReason: string;
  continuityPack: string;
  semanticSource: SemanticSegmentSource;
}

export interface SemanticSequenceResponse {
  /** Derived from the parsed segments, not required in the model's wire JSON. */
  segmentCount: number;
  reason: string;
  fitStatus: SequenceFitStatus;
  segments: SemanticSequenceResponseSegment[];
}

/** Only JSON, field types, source identity and numeric delivery contracts can
 * fail locally. No word counts, plot classifiers, semantic gates or local cuts. */
export type SemanticSequenceTechnicalErrorKind = 'invalid-shape' | 'missing-json' | 'invalid-json' | 'incomplete-json';
export interface SemanticSequenceJsonDiagnostics {
  readonly responseLength: number;
  readonly jsonStart?: number;
  readonly jsonEnd?: number;
}
export class SemanticSequenceTechnicalError extends Error {
  constructor(
    readonly issues: readonly string[],
    readonly kind: SemanticSequenceTechnicalErrorKind = 'invalid-shape',
    readonly diagnostics?: Readonly<SemanticSequenceJsonDiagnostics>,
  ) {
    const positions = diagnostics ? [
      `响应长度 ${diagnostics.responseLength}`,
      ...(diagnostics.jsonStart !== undefined ? [`JSON 起点 ${diagnostics.jsonStart}`] : []),
      ...(diagnostics.jsonEnd !== undefined ? [`JSON 终点 ${diagnostics.jsonEnd}`] : []),
    ] : [];
    super(`AI 语义分段结构无效：${issues.join('；')}${positions.length ? `（${positions.join('，')}）` : ''}`);
    this.name = 'SemanticSequenceTechnicalError';
  }
}

const record = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const has = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const FIT_STATUS_LABELS = {
  comfortable: '宽裕', balanced: '适中', compressed: '紧凑', insufficient: '不足',
} as const satisfies Record<SequenceFitStatus, string>;
export const SEMANTIC_SEQUENCE_FIT_STATUSES: readonly SequenceFitStatus[] = Object.freeze(Object.keys(FIT_STATUS_LABELS) as SequenceFitStatus[]);
/** The parser and every generation/repair request share this same contract. */
export const SEMANTIC_SEQUENCE_FIT_STATUS_RULE = `允许值为 ${Object.entries(FIT_STATUS_LABELS)
  .map(([status, label]) => `${status}（${label}）`).join('、')}，必须仅返回一个英文状态，解释写入 reason`;

/** Normalize protocol spelling only; never infer the model's assessment or
 * supply a success default for missing, translated or ambiguous values. */
const normalizeFitStatus = (value: unknown): SequenceFitStatus | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return SEMANTIC_SEQUENCE_FIT_STATUSES.find((status) => status === normalized);
};

const fitStatusIssue = (value: Record<string, unknown>): string => {
  const status = value.fitStatus;
  let problem: string;
  if (!has(value, 'fitStatus')) problem = '缺失';
  else if (status === null) problem = '不能为空';
  else if (typeof status !== 'string') {
    const type = Array.isArray(status) ? '数组' : typeof status === 'number' ? '数字' : typeof status === 'boolean' ? '布尔值' : '对象';
    problem = `必须是字符串（收到${type}）`;
  } else problem = status.trim() ? '不是支持的状态值' : '不能是空字符串';
  // Do not echo an arbitrary model field: it may accidentally contain the
  // full story, private character facts or credentials instead of a status.
  return `$.fitStatus ${problem}；${SEMANTIC_SEQUENCE_FIT_STATUS_RULE}。`;
};
const CHARACTER_FIELDS = [
  'name', 'id', 'baseName', 'formLabel', 'variantOf', 'transformationType',
  'gender', 'apparentAge', 'actualAge', 'height', 'race', 'morphology', 'bodyPlan',
  'appearance', 'outfit', 'signatureProps', 'personality', 'motionHabits', 'anchor', 'negativeContinuity',
] as const;
const PACING_FIELDS = ['pace', 'directorCategory', 'directorStyle', 'directorStyleSummary', 'extraRequirement'] as const;
const SEGMENT_TEXT_FIELDS = [
  'title', 'content', 'summary', 'narrativePurpose', 'entryState', 'exitState',
  'transitionHint', 'boundaryReason', 'continuityPack',
] as const;

const copyStrings = <Key extends string>(value: Record<string, unknown>, fields: readonly Key[]): Partial<Record<Key, string>> => {
  const result: Partial<Record<Key, string>> = {};
  for (const field of fields) if (typeof value[field] === 'string') result[field] = value[field];
  return result;
};
const copyCharacters = (characters: readonly SemanticSequenceCharacter[] = []): SemanticSequenceCharacter[] => (
  characters.map((character) => ({ name: character.name, ...copyStrings(character, CHARACTER_FIELDS),
    ...(Array.isArray(character.aliases) ? { aliases: [...character.aliases] } : {}) }))
);
const copyPacing = (pacing: StoryPacingContext | undefined): StoryPacingContext | undefined => (
  pacing ? { pace: pacing.pace, ...copyStrings({ ...pacing }, PACING_FIELDS) } : undefined
);

/** Strict shape-only storage/request copy. Never infer an original from a draft. */
export const normalizeStoryVisualConversionSnapshot = (value: unknown): StoryVisualConversionSnapshot | undefined => {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.chapterId !== 'string' || !value.chapterId.trim()
    || typeof value.sourceName !== 'string' || typeof value.sourceText !== 'string' || !value.sourceText.trim()
    || typeof value.resultText !== 'string' || !value.resultText.trim()
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return undefined;
  return { id: value.id, chapterId: value.chapterId, sourceName: value.sourceName,
    sourceText: value.sourceText, resultText: value.resultText, createdAt: value.createdAt,
    ...(normalizeStoryReferenceContext(value.storyReferenceContext) ? { storyReferenceContext: normalizeStoryReferenceContext(value.storyReferenceContext) } : {}),
    ...(typeof value.referenceFingerprint === 'string' ? { referenceFingerprint: value.referenceFingerprint } : {}) };
};

const segmentDurationIssues = (value: unknown): string[] => (
  typeof value !== 'number' || !Number.isFinite(value) || value < 1
    || value > MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001
    ? ['单段时长 D 必须为 1–300 秒且最多两位小数'] : []
);

const requestedTotalDurationIssues = (total: unknown, segmentDurationSec: number): string[] => {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 1 || total > 3600
    || Math.abs(total * 100 - Math.round(total * 100)) > 0.00001) {
    return ['固定总时长 T 必须为 1–3600 秒且最多两位小数'];
  }
  if (segmentDurationIssues(segmentDurationSec).length) return [];
  const totalUnits = Math.round(total * 100);
  const segmentUnits = Math.round(segmentDurationSec * 100);
  if (totalUnits % segmentUnits !== 0) return ['固定总时长 T 必须为单段时长 D 的整数倍，不生成短尾段'];
  if (totalUnits / segmentUnits > 900) return ['固定总时长 T ÷ D 的分段数量不得超过 900'];
  return [];
};

/** UI selection helper only. Domain requests stay strict and are never rounded. */
export const normalizeSemanticSequenceRequestedTotalDuration = (total: number, segmentDurationSec: number): number => {
  const issues = segmentDurationIssues(segmentDurationSec);
  if (issues.length) throw new SemanticSequenceTechnicalError(issues);
  const segmentUnits = Math.round(segmentDurationSec * 100);
  const maxUnits = Math.floor(Math.min(360000, segmentUnits * 900) / segmentUnits) * segmentUnits;
  const selected = Number.isNaN(total) ? segmentDurationSec : Math.min(maxUnits / 100, Math.max(segmentDurationSec, total));
  // Whole centiseconds prevent a fractional representation of a complete D
  // window (e.g. 12.34 × 3) from accidentally selecting a fourth segment.
  const requestedUnits = Math.ceil(selected * 100 - 0.00001);
  return Math.min(maxUnits, Math.max(segmentUnits, Math.ceil(requestedUnits / segmentUnits) * segmentUnits)) / 100;
};

const creativeDirectionIsValid = (value: unknown): value is VideoCreativeDirection => {
  if (!record(value) || !stringList(value.cameraTerms) || !stringList(value.lightingTerms) || typeof value.extraRequirement !== 'string') return false;
  return (['directorStyle', 'visualStyle', 'stylePreset'] as const).every((key) => (
    value[key] === undefined || (record(value[key]) && Object.values(value[key]).every((item) => typeof item === 'string' || item === undefined))
  ));
};

export const assertSemanticSequencePlanningInput = (input: SemanticSequencePlanningInput): void => {
  const issues = segmentDurationIssues(input.segmentDurationSec);
  if (input.durationMode !== undefined && input.durationMode !== 'ai-estimated' && input.durationMode !== 'fixed') issues.push('总时长模式无效');
  if (input.durationMode === 'fixed') issues.push(...requestedTotalDurationIssues(input.requestedTotalDurationSec, input.segmentDurationSec));
  if (typeof input.title !== 'string') issues.push('原文标题必须是字符串');
  if (typeof input.story !== 'string' || !input.story.trim()) issues.push('缺少完整原文');
  if (typeof input.directorSettingsFingerprint !== 'string' || !input.directorSettingsFingerprint) issues.push('缺少导演设置指纹');
  if (!creativeDirectionIsValid(input.creativeDirection)) issues.push('完整创作方向字段格式无效');
  if (input.pacing !== undefined && (!record(input.pacing) || typeof input.pacing.pace !== 'string'
    || PACING_FIELDS.some((field) => input.pacing?.[field] !== undefined && typeof input.pacing[field] !== 'string'))) issues.push('节奏快照字段格式无效');
  if (input.characterContinuity !== undefined && (!Array.isArray(input.characterContinuity)
    || input.characterContinuity.some((character) => !record(character) || typeof character.name !== 'string'
      || (character.aliases !== undefined && !stringList(character.aliases))
      || CHARACTER_FIELDS.some((field) => character[field] !== undefined && typeof character[field] !== 'string')))) issues.push('人物事实字段格式无效');
  if (input.originalSourceContext !== undefined) {
    const original = normalizeStoryVisualConversionSnapshot(input.originalSourceContext);
    if (!original) issues.push('画面描述转化原文快照格式无效');
    else if (typeof input.story !== 'string' || original.resultText.trim() !== input.story.trim()) issues.push('画面描述转化原文快照与当前剧情不匹配');
  }
  if (input.sourceSceneIds !== undefined && !stringList(input.sourceSceneIds)) issues.push('原场景 ID 列表格式无效');
  if (input.shotMode !== undefined && input.shotMode !== 'auto' && input.shotMode !== 'exact') issues.push('拍摄镜数模式无效');
  if (input.shotCount !== undefined && (!Number.isSafeInteger(input.shotCount) || input.shotCount < 1)) issues.push('单段镜数偏好必须是正整数');
  if (issues.length) throw new SemanticSequenceTechnicalError(issues);
};

/** Take an explicit request-owned snapshot before the first asynchronous call. */
export const copySemanticSequencePlanningInput = (input: SemanticSequencePlanningInput): SemanticSequencePlanningInput => {
  assertSemanticSequencePlanningInput(input);
  return {
    title: input.title, story: input.story, segmentDurationSec: input.segmentDurationSec,
    ...(input.durationMode !== undefined ? { durationMode: input.durationMode } : {}),
    ...(input.durationMode === 'fixed' ? { requestedTotalDurationSec: input.requestedTotalDurationSec } : {}),
    directorSettingsFingerprint: input.directorSettingsFingerprint,
    creativeDirection: buildVideoCreativeDirection(input.creativeDirection),
    ...(input.pacing ? { pacing: copyPacing(input.pacing) } : {}),
    characterContinuity: copyCharacters(input.characterContinuity), sourceSceneIds: [...(input.sourceSceneIds ?? [])],
    ...(input.originalSourceContext ? { originalSourceContext: normalizeStoryVisualConversionSnapshot(input.originalSourceContext)! } : {}),
    ...(input.shotMode !== undefined ? { shotMode: input.shotMode } : {}),
    ...(input.shotCount !== undefined ? { shotCount: input.shotCount } : {}),
  };
};

const readEventCausality = (value: unknown, label: string): SemanticEventCausality => {
  if (!record(value) || ['actor', 'target', 'action', 'result', 'evidence'].some((key) => typeof value[key] !== 'string')
    || !['explicit', 'context-supported', 'unknown'].includes(value.certainty as string)
    || ['actorCharacterId', 'targetCharacterId'].some((key) => value[key] !== undefined
      && (typeof value[key] !== 'string' || !(value[key] as string).trim()))) {
    throw new SemanticSequenceTechnicalError([`${label} 必须提供 actor、target、action、result、evidence 字符串及 certainty（explicit/context-supported/unknown）；人物 ID 仅在已确认时提供非空字符串`]);
  }
  return { actor: value.actor as string, target: value.target as string, action: value.action as string,
    result: value.result as string, evidence: value.evidence as string, certainty: value.certainty as SemanticEventCausality['certainty'],
    ...(typeof value.actorCharacterId === 'string' ? { actorCharacterId: value.actorCharacterId } : {}),
    ...(typeof value.targetCharacterId === 'string' ? { targetCharacterId: value.targetCharacterId } : {}) };
};

const readSemanticSource = (value: unknown, label: string, sourceLength?: number): SemanticSegmentSource => {
  const issues: string[] = [];
  if (!record(value)) throw new SemanticSequenceTechnicalError([`${label} 缺少 semanticSource 对象`]);
  for (const key of ['sourceEvidence', 'events', 'dialogues']) if (!Array.isArray(value[key])) issues.push(`${label}.${key} 必须是数组`);
  if (issues.length) throw new SemanticSequenceTechnicalError(issues);
  const sourceEvidence = (value.sourceEvidence as unknown[]).map((item, index) => {
    const path = `${label}.sourceEvidence[${index}]`;
    if (!record(item) || typeof item.text !== 'string') throw new SemanticSequenceTechnicalError([`${path}.text 必须是字符串`]);
    const start = item.sourceStart;
    const end = item.sourceEnd;
    if ((start === undefined) !== (end === undefined)
      || (start !== undefined && (typeof start !== 'number' || typeof end !== 'number'
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
        || (sourceLength !== undefined && end > sourceLength)))) {
      throw new SemanticSequenceTechnicalError([`${path} 原文位置必须成对提供有效范围`]);
    }
    return { text: item.text, ...(typeof start === 'number' && typeof end === 'number' ? { sourceStart: start, sourceEnd: end } : {}) };
  });
  const events = (value.events as unknown[]).map((item, index) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || typeof item.description !== 'string'
      || (item.phase !== undefined && typeof item.phase !== 'string')) throw new SemanticSequenceTechnicalError([`${label}.events[${index}] 字段格式无效`]);
    return { id: item.id, description: item.description, ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
      ...(item.causality !== undefined ? { causality: readEventCausality(item.causality, `${label}.events[${index}].causality`) } : {}) };
  });
  const dialogues = (value.dialogues as unknown[]).map((item, index) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || typeof item.speaker !== 'string' || typeof item.text !== 'string'
      || (item.language !== undefined && typeof item.language !== 'string') || (item.continuation !== undefined && typeof item.continuation !== 'string')) {
      throw new SemanticSequenceTechnicalError([`${label}.dialogues[${index}] 字段格式无效`]);
    }
    return { id: item.id, speaker: item.speaker, text: item.text,
      ...(typeof item.language === 'string' ? { language: item.language } : {}),
      ...(typeof item.continuation === 'string' ? { continuation: item.continuation } : {}) };
  });
  return { sourceEvidence, events, dialogues };
};

/** Storage helper: shape-only deep copy; does not recover or fabricate evidence. */
export const normalizeSemanticSegmentSource = (value: unknown): SemanticSegmentSource | undefined => {
  try { return readSemanticSource(value, 'semanticSource'); } catch { return undefined; }
};

const hasPlanProtocol = (value: Record<string, unknown>): boolean => has(value, 'segmentCount') || has(value, 'segments');
const nextNonWhitespace = (raw: string, start: number): number => {
  let index = start;
  while (index < raw.length && /\s/u.test(raw[index])) index += 1;
  return index;
};

interface JsonSpan { start: number; end?: number; planLike: boolean }

/** Find the original boundary only. JSON.parse remains the syntax authority. */
const readJsonSpan = (raw: string, start: number, limit = raw.length): JsonSpan => {
  const stack: string[] = [];
  const protocolScopes: boolean[] = [];
  const pendingKeys: Array<string | undefined> = [];
  let inString = raw[start] === '"'; let escaped = false; let stringStart = start; let planLike = false;
  if (!inString) { stack.push(raw[start]); protocolScopes.push(raw[start] === '{'); pendingKeys.push(undefined); }
  for (let index = start + 1; index < limit; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (!stack.length) return { start, end: index + 1, planLike };
        const top = stack.length - 1;
        if (stack[top] === '{' && protocolScopes[top]) {
          let before = stringStart - 1;
          while (before >= start && /\s/u.test(raw[before])) before -= 1;
          try {
            const key: unknown = JSON.parse(raw.slice(stringStart, index + 1));
            if (raw[before] === '{' || raw[before] === ',') {
              pendingKeys[top] = typeof key === 'string' ? key : undefined;
              if (key === 'segmentCount' || key === 'segments') planLike = true;
            }
          } catch { /* Never expose JSON.parse's content-bearing error. */ }
        }
      }
      continue;
    }
    if (char === '"') { inString = true; stringStart = index; }
    else if (char === '{' || char === '[') {
      const top = stack.length - 1;
      const scope = char === '{' && stack[top] === '{' && protocolScopes[top]
        && (pendingKeys[top] === 'data' || pendingKeys[top] === 'result');
      stack.push(char); protocolScopes.push(scope); pendingKeys.push(undefined);
    }
    else if (char === '}' || char === ']') {
      protocolScopes.pop(); pendingKeys.pop();
      if (stack.pop() !== (char === '}' ? '{' : '[') || !stack.length) return { start, end: index + 1, planLike };
    }
  }
  return { start, planLike };
};

const hasEncodedPlanProtocol = (value: unknown, depth = 0): boolean => {
  if (depth > 4) return false;
  if (typeof value === 'string') {
    try { return hasEncodedPlanProtocol(JSON.parse(value) as unknown, depth + 1); } catch {
      const start = nextNonWhitespace(value, 0);
      return value[start] === '{' && readJsonSpan(value, start).planLike;
    }
  }
  return record(value) && (hasPlanProtocol(value)
    || (['data', 'result'] as const).some((key) => has(value, key) && hasEncodedPlanProtocol(value[key], depth + 1)));
};

const decodeJsonObject = (
  initial: unknown, diagnostics: SemanticSequenceJsonDiagnostics, stringLayers = 0, wrapperLayers = 0,
): Record<string, unknown> => {
  let value = initial;
  let layers = stringLayers;
  while (typeof value === 'string') {
    if (layers >= 2) throw new SemanticSequenceTechnicalError(['响应 JSON 字符串编码层数超过上限'], 'invalid-json', diagnostics);
    const text = value.trim();
    try { value = JSON.parse(text) as unknown; } catch {
      const span = text[0] === '{' || text[0] === '[' || text[0] === '"' ? readJsonSpan(text, 0) : undefined;
      const kind = span && span.end === undefined ? 'incomplete-json' : 'invalid-json';
      throw new SemanticSequenceTechnicalError([kind === 'incomplete-json' ? '响应 JSON 未闭合，可能已截断' : '响应 JSON 语法无效'], kind, diagnostics);
    }
    layers += 1;
  }
  if (!record(value)) throw new SemanticSequenceTechnicalError(['响应根节点必须是 JSON 对象'], 'invalid-shape', diagnostics);
  if (hasPlanProtocol(value) || wrapperLayers >= 2) return value;
  const wrapped = (['data', 'result'] as const).filter((key) => has(value, key) && hasEncodedPlanProtocol(value[key]));
  const plans = wrapped.map((key) => decodeJsonObject(value[key], diagnostics, layers, wrapperLayers + 1)).filter(hasPlanProtocol);
  if (plans.length > 1) throw new SemanticSequenceTechnicalError(['响应包含多个 data/result 计划，无法确定唯一计划'], 'invalid-shape', diagnostics);
  return plans[0] ?? value;
};

const parseJsonObject = (raw: string): Record<string, unknown> => {
  const start = nextNonWhitespace(raw, 0);
  const diagnostics = (jsonStart?: number, jsonEnd?: number): SemanticSequenceJsonDiagnostics => ({
    responseLength: raw.length, ...(jsonStart !== undefined ? { jsonStart } : {}), ...(jsonEnd !== undefined ? { jsonEnd } : {}),
  });
  let direct: unknown;
  let directParsed = false;
  try { direct = JSON.parse(raw.trim()) as unknown; directParsed = true; } catch { /* Extract original JSON boundaries below. */ }
  if (directParsed) return decodeJsonObject(direct, diagnostics(start, raw.trimEnd().length));

  const candidates: Array<JsonSpan & { value?: Record<string, unknown>; error?: SemanticSequenceTechnicalError }> = [];
  // Fence lines give explicit response boundaries even when the prose before
  // the fence contains an unfinished example. All spans keep original offsets.
  const boundaries: Array<[number, number]> = [];
  const fences = /^[\t ]*```(?:[A-Za-z][\w-]*)?[\t ]*(?:\r?\n|$)/gmu;
  let rangeStart = start;
  for (let fence = fences.exec(raw); fence; fence = fences.exec(raw)) {
    boundaries.push([rangeStart, fence.index]); rangeStart = fence.index + fence[0].length;
  }
  boundaries.push([rangeStart, raw.length]);
  for (const [rangeBegin, rangeEnd] of boundaries) for (let index = rangeBegin; index < rangeEnd; index += 1) {
    const char = raw[index];
    if (char !== '{' && char !== '[' && char !== '"') continue;
    const next = raw[nextNonWhitespace(raw, index + 1)];
    // Ordinary prose braces such as {title never establish a JSON boundary.
    const objectStart = char === '{' && (next === '"' || next === '}');
    const arrayStart = char === '[' && (next === '{' || next === '[' || next === '"' || next === ']');
    const stringStart = char === '"' && (next === '{' || next === '\\');
    if (!objectStart && !arrayStart && !stringStart) continue;
    const span = readJsonSpan(raw, index, rangeEnd);
    if (span.end === undefined) { candidates.push(span); break; }
    let planLike = span.planLike;
    try {
      const parsed: unknown = JSON.parse(raw.slice(index, span.end));
      planLike = planLike || hasEncodedPlanProtocol(parsed);
      const value = decodeJsonObject(parsed, diagnostics(index, span.end));
      candidates.push({ ...span, value, planLike: planLike || hasPlanProtocol(value) });
    } catch (error) {
      candidates.push({ ...span, planLike, error: error instanceof SemanticSequenceTechnicalError ? error
        : new SemanticSequenceTechnicalError(['响应 JSON 语法无效'], 'invalid-json', diagnostics(index, span.end)) });
    }
    index = span.end - 1;
  }
  const plans = candidates.filter((candidate) => candidate.planLike);
  const selected = plans[plans.length - 1];
  // A later unfinished JSON value is an interrupted response, including a
  // trailing {"incomplete":. Do not publish an earlier example in its place.
  const incomplete = candidates.find((candidate) => candidate.end === undefined
    && (!selected || candidate.start >= (selected.end ?? selected.start)));
  if (incomplete) throw new SemanticSequenceTechnicalError(['响应 JSON 未闭合，可能已截断'], 'incomplete-json', diagnostics(incomplete.start));
  if (selected?.error) throw selected.error;
  if (selected?.value) return selected.value;
  const last = candidates[candidates.length - 1];
  if (last?.error) throw last.error;
  if (last?.value) return last.value;
  if (raw.trim() === '{' || raw.trim() === '[') throw new SemanticSequenceTechnicalError(['响应 JSON 未闭合，可能已截断'], 'incomplete-json', diagnostics(start));
  if (raw[start] === '{' || raw[start] === '[') throw new SemanticSequenceTechnicalError(['响应 JSON 语法无效'], 'invalid-json', diagnostics(start));
  throw new SemanticSequenceTechnicalError(['响应没有可解析的 JSON 对象'], 'missing-json', diagnostics());
};

/** Deserialize AI-owned prose unchanged. The complete array owns N; an optional
 * legacy count is checked for contradictions, never used to drop or pad prose. */
export const parseSemanticSequenceResponse = (raw: string, input: SemanticSequencePlanningInput): SemanticSequenceResponse => {
  assertSemanticSequencePlanningInput(input);
  const value = parseJsonObject(raw);
  const issues: string[] = [];
  const segmentCount = Array.isArray(value.segments) ? value.segments.length : 0;
  if (!Array.isArray(value.segments) || !segmentCount) issues.push('segments 必须是非空数组');
  if (segmentCount > 900) issues.push(`实际返回 ${segmentCount} 段，分段数量不得超过 900 段`);
  // Older providers may retain the previous schema. A contradictory count can
  // signal omitted story, so only the model may resolve it against the source.
  if (has(value, 'segmentCount')) {
    if (!Number.isSafeInteger(value.segmentCount) || (value.segmentCount as number) < 1 || (value.segmentCount as number) > 900) {
      issues.push('旧格式段数字段 segmentCount 必须为 1–900 的整数；新格式无需填写该字段');
    } else if (Array.isArray(value.segments) && value.segmentCount !== segmentCount) {
      issues.push(`分段数量不一致：AI 声明 ${value.segmentCount} 段，实际返回 ${segmentCount} 段（segmentCount 与 segments 数量不一致）`);
    }
  }
  if (input.durationMode === 'fixed' && Array.isArray(value.segments)) {
    const requiredCount = Math.round(input.requestedTotalDurationSec! * 100) / Math.round(input.segmentDurationSec * 100);
    if (segmentCount !== requiredCount) {
      issues.push(`固定总时长需要 ${requiredCount} 段（${input.requestedTotalDurationSec} 秒 ÷ 每段 ${input.segmentDurationSec} 秒），实际返回 ${segmentCount} 段`);
    }
  }
  if (typeof value.reason !== 'string') issues.push('reason 必须是字符串');
  const fitStatus = normalizeFitStatus(value.fitStatus);
  if (fitStatus === undefined) issues.push(fitStatusIssue(value));
  const totalUnits = Math.round(input.segmentDurationSec * 100) * segmentCount;
  if (totalUnits > 360000) issues.push(`实际 ${segmentCount} 段 × 每段 ${input.segmentDurationSec} 秒 = ${totalUnits / 100} 秒，超过全片 3600 秒上限`);
  if (has(value, 'segmentDurationSec') && value.segmentDurationSec !== input.segmentDurationSec) issues.push('segmentDurationSec 必须等于输入 D');
  if (has(value, 'totalDurationSec') && value.totalDurationSec !== totalUnits / 100) issues.push('totalDurationSec 必须等于 D × N');
  if (issues.length || fitStatus === undefined) throw new SemanticSequenceTechnicalError(issues);
  const windows = requestedSegmentDurationWindows(totalUnits / 100, input.segmentDurationSec);
  const segments = (value.segments as unknown[]).map((item, index): SemanticSequenceResponseSegment => {
    if (!record(item)) throw new SemanticSequenceTechnicalError([`第 ${index + 1} 段必须是对象`]);
    const missing = SEGMENT_TEXT_FIELDS.filter((field) => typeof item[field] !== 'string');
    if (missing.length) throw new SemanticSequenceTechnicalError([`第 ${index + 1} 段字符串字段无效：${missing.join('、')}`]);
    if (!(item.content as string).trim()) throw new SemanticSequenceTechnicalError([`第 ${index + 1} 段缺少 content 正文`]);
    for (const field of ['durationSec', 'globalStartSec', 'globalEndSec', 'index'] as const) {
      if (has(item, field) && item[field] !== windows[index][field]) throw new SemanticSequenceTechnicalError([`第 ${index + 1} 段 ${field} 与 D 固定窗口不一致`]);
    }
    const texts = copyStrings(item, SEGMENT_TEXT_FIELDS) as Omit<SemanticSequenceResponseSegment, 'semanticSource'>;
    return { ...texts, semanticSource: readSemanticSource(item.semanticSource, `第 ${index + 1} 段`, input.story.length) };
  });
  return { segmentCount, reason: value.reason as string, fitStatus, segments };
};

export const materializeSemanticSequencePlan = (
  input: SemanticSequencePlanningInput, response: SemanticSequenceResponse, options: { planId: string; now?: number },
): VideoSequencePlan => {
  const snapshot = copySemanticSequencePlanningInput(input);
  // Recheck typed callers too; never publish a partial or manually coerced plan.
  const parsed = parseSemanticSequenceResponse(JSON.stringify(response), snapshot);
  const totalDurationSec = Math.round(snapshot.segmentDurationSec * 100) * parsed.segments.length / 100;
  const windows = requestedSegmentDurationWindows(totalDurationSec, snapshot.segmentDurationSec);
  const now = options.now ?? Date.now();
  if (!options.planId.trim() || !Number.isFinite(now)) throw new SemanticSequenceTechnicalError(['计划 ID 或创建时间无效']);
  const plan: VideoSequencePlan = {
    id: options.planId, title: snapshot.title, sourceStoryTitle: snapshot.title, sourceStoryContent: snapshot.story,
    sourceContentHash: sourceContentHash(snapshot.story), planningMode: 'semantic-segments', planningStage: 'segmented',
    durationMode: snapshot.durationMode ?? 'ai-estimated',
    ...(snapshot.durationMode === 'fixed' ? { requestedTotalDurationSec: snapshot.requestedTotalDurationSec } : {}),
    totalDurationSec, segmentDurationSec: snapshot.segmentDurationSec,
    segmentationMode: 'natural', segmentationSource: 'ai', segmentationReason: parsed.reason, estimateReason: parsed.reason,
    fitStatus: parsed.fitStatus,
    semanticPlanningSnapshot: {
      version: 1, directorSettingsFingerprint: snapshot.directorSettingsFingerprint,
      ...(snapshot.durationMode !== undefined ? { durationMode: snapshot.durationMode } : {}),
      ...(snapshot.durationMode === 'fixed' ? { requestedTotalDurationSec: snapshot.requestedTotalDurationSec } : {}),
      creativeDirection: snapshot.creativeDirection, pacing: snapshot.pacing,
      characterContinuity: copyCharacters(snapshot.characterContinuity),
      ...(snapshot.originalSourceContext ? { originalSourceContext: normalizeStoryVisualConversionSnapshot(snapshot.originalSourceContext)! } : {}),
      ...(snapshot.shotMode !== undefined ? { shotMode: snapshot.shotMode } : {}),
      ...(snapshot.shotCount !== undefined ? { shotCount: snapshot.shotCount } : {}),
    },
    segments: parsed.segments.map((segment, index) => ({
      ...segment, ...windows[index], id: `${options.planId}_segment_${index + 1}`,
      sourceSceneIds: [...(snapshot.sourceSceneIds ?? [])], sourceBeatIds: [], status: 'planned',
    })), createdAt: now, updatedAt: now,
  };
  const issues = validateSemanticSequencePlan(plan);
  if (issues.length) throw new SemanticSequenceTechnicalError(issues);
  return plan;
};

export const isSemanticSequencePlan = (plan: unknown): plan is VideoSequencePlan & { planningMode: 'semantic-segments' } => (
  record(plan) && plan.planningMode === 'semantic-segments'
);

/** A semantic plan owns all public character facts used by its segments.
 * Live records may only supply same-ID media and the existing separately
 * scoped private dossiers; their current appearance/name/form must not leak
 * into a frozen plan. Missing live records do not erase saved identities. */
export const semanticSequenceCharacters = (
  plan: VideoSequencePlan | undefined,
  liveCharacters: readonly Character[],
): Character[] => {
  if (!isSemanticSequencePlan(plan)) return liveCharacters
    .filter((character) => !character.dossier?.archivedIntoCharacterId)
    .map((character) => structuredClone(character));
  const liveById = new Map(liveCharacters.map((character) => [character.id, character]));
  return (plan.semanticPlanningSnapshot?.characterContinuity ?? []).map((saved, index): Character => {
    const savedId = typeof saved.id === 'string' && saved.id.trim() ? saved.id : undefined;
    // Never join by display name, array position or a generated fallback ID:
    // a similarly named live character could be a different person or form.
    const live = savedId ? liveById.get(savedId) : undefined;
    return {
      gender: '', apparentAge: '', race: '', appearance: '', outfit: '',
      signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '',
      ...copyStrings(saved, CHARACTER_FIELDS),
      ...(Array.isArray(saved.aliases) ? { aliases: [...saved.aliases] } : {}),
      id: savedId ?? `semantic-character-${sourceContentHash(JSON.stringify([plan.id, index, saved.name]))}`,
      name: typeof saved.name === 'string' ? saved.name : '',
      assetIds: live ? [...live.assetIds] : [],
      ...(live?.nsfwProfile !== undefined ? { nsfwProfile: structuredClone(live.nsfwProfile) } : {}),
      ...(live?.nsfwBodyAnchors !== undefined ? { nsfwBodyAnchors: structuredClone(live.nsfwBodyAnchors) } : {}),
    };
  });
};

/** Legacy plans are deliberately not migrated or semantically reinterpreted. */
export const validateSemanticSequencePlan = (plan: VideoSequencePlan): string[] => {
  if (!isSemanticSequencePlan(plan)) return [];
  const issues = segmentDurationIssues(plan.segmentDurationSec);
  if (plan.durationMode !== 'ai-estimated' && plan.durationMode !== 'fixed') issues.push('语义分段总时长模式无效');
  if (plan.durationMode === 'fixed') issues.push(...requestedTotalDurationIssues(plan.requestedTotalDurationSec, plan.segmentDurationSec));
  else if (plan.requestedTotalDurationSec !== undefined) issues.push('AI 适配计划不应保留固定总时长 T');
  if (typeof plan.id !== 'string' || !plan.id.trim()) issues.push('语义分段计划缺少 ID');
  if (typeof plan.sourceStoryContent !== 'string' || !plan.sourceStoryContent.trim()) issues.push('语义分段计划缺少原文');
  if (typeof plan.sourceStoryContent === 'string' && plan.sourceContentHash !== sourceContentHash(plan.sourceStoryContent)) issues.push('语义分段原文指纹失效，请重新规划');
  if (plan.planningStage !== 'segmented' || plan.segmentationSource !== 'ai') issues.push('语义分段计划来源或阶段无效');
  if (plan.masterStoryboardId) issues.push('原文语义分段不应绑定全片总稿');
  const snapshot = plan.semanticPlanningSnapshot;
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.characterContinuity)) issues.push('缺少语义分段输入快照');
  else {
    if ((snapshot.durationMode ?? 'ai-estimated') !== plan.durationMode) issues.push('语义分段总时长模式与输入快照不一致');
    if (plan.durationMode === 'fixed' && snapshot.requestedTotalDurationSec !== plan.requestedTotalDurationSec) issues.push('固定总时长 T 与输入快照不一致');
    if ((snapshot.durationMode ?? 'ai-estimated') === 'ai-estimated' && snapshot.requestedTotalDurationSec !== undefined) issues.push('AI 适配输入快照不应保留固定总时长 T');
    try { assertSemanticSequencePlanningInput({ ...snapshot, title: plan.sourceStoryTitle, story: plan.sourceStoryContent, segmentDurationSec: plan.segmentDurationSec }); }
    catch (error) { issues.push(...(error instanceof SemanticSequenceTechnicalError ? error.issues : ['语义分段输入快照无效'])); }
  }
  if (!Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > 900) issues.push('语义分段数量必须为 1–900');
  const totalUnits = Math.round(plan.segmentDurationSec * 100) * (Array.isArray(plan.segments) ? plan.segments.length : 0);
  if (!Number.isFinite(plan.totalDurationSec) || plan.totalDurationSec !== totalUnits / 100 || totalUnits > 360000) issues.push('语义分段总时长必须等于 D × N，且不超过 3600 秒');
  if (plan.durationMode === 'fixed' && Math.round(plan.requestedTotalDurationSec! * 100) !== totalUnits) issues.push('固定模式分段数量必须准确等于 T ÷ D');
  if (issues.length) return [...new Set(issues)];
  const windows = requestedSegmentDurationWindows(plan.totalDurationSec, plan.segmentDurationSec);
  const ids = new Set<string>();
  for (const [index, segment] of plan.segments.entries()) {
    if (!segment || typeof segment.id !== 'string' || !segment.id.trim() || ids.has(segment.id)) { issues.push(`第 ${index + 1} 段 ID 缺失或重复`); continue; }
    ids.add(segment.id);
    for (const key of ['index', 'durationSec', 'globalStartSec', 'globalEndSec'] as const) if (segment[key] !== windows[index][key]) issues.push(`第 ${index + 1} 段 ${key} 与固定 D 窗口不符`);
    if (SEGMENT_TEXT_FIELDS.some((field) => typeof segment[field] !== 'string') || !segment.content.trim()) issues.push(`第 ${index + 1} 段正文字段不完整`);
    if (!stringList(segment.sourceSceneIds) || !stringList(segment.sourceBeatIds)) issues.push(`第 ${index + 1} 段来源 ID 列表无效`);
    try { readSemanticSource(segment.semanticSource, `第 ${index + 1} 段`, plan.sourceStoryContent.length); }
    catch (error) { issues.push(...(error instanceof SemanticSequenceTechnicalError ? error.issues : ['语义来源字段无效'])); }
  }
  return issues;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

/** Changes to real source facts invalidate work; job status/board IDs do not. */
export const semanticSequenceSourceFingerprint = (plan: VideoSequencePlan): string => sourceContentHash(JSON.stringify(stableValue({
  planningMode: plan.planningMode, sourceStoryTitle: plan.sourceStoryTitle, sourceStoryContent: plan.sourceStoryContent,
  sourceContentHash: plan.sourceContentHash, segmentDurationSec: plan.segmentDurationSec, totalDurationSec: plan.totalDurationSec,
  // Preserve the original identity for old AI snapshots with no request mode
  // or total. Every new explicit mode and fixed request owns its identity.
  ...(plan.semanticPlanningSnapshot?.durationMode !== undefined || plan.durationMode !== 'ai-estimated'
    || plan.requestedTotalDurationSec !== undefined ? {
      durationMode: plan.durationMode,
      ...(plan.requestedTotalDurationSec !== undefined ? { requestedTotalDurationSec: plan.requestedTotalDurationSec } : {}),
    } : {}),
  snapshot: plan.semanticPlanningSnapshot,
  segments: plan.segments.map((segment) => ({
    id: segment.id, index: segment.index, globalStartSec: segment.globalStartSec, globalEndSec: segment.globalEndSec, durationSec: segment.durationSec,
    ...copyStrings(segment as unknown as Record<string, unknown>, SEGMENT_TEXT_FIELDS),
    sourceSceneIds: segment.sourceSceneIds, semanticSource: segment.semanticSource,
  })),
})));

/** Compose a request source from a saved/raw segment, without changing that
 * segment or guessing whether its prose already quotes a recorded utterance.
 * Consumers of SemanticSegmentSourceContext use generationStoryContent
 * directly; they must not feed that composed source back into this helper. */
export const semanticSegmentStoryContent = (
  segment: Pick<VideoSegment, 'content' | 'contentOverridden' | 'semanticSource'>,
): string => {
  const dialogues = segment.semanticSource?.dialogues;
  if (segment.contentOverridden === true || !dialogues?.length) return segment.content;
  return [
    // Keep the saved body as an exact prefix, so old body-relative source
    // locations remain usable when an existing board is explicitly revised.
    segment.content,
    '【本段实际对白记录】',
    JSON.stringify(dialogues, null, 2),
    '【正文与对白记录的关系】',
    '上方剧情正文与实际对白记录共同构成本段完整剧情来源。对白记录保留本段真实发话的原话、说话人、稳定ID、语言和接续关系；由导演结合动作安排发话时序。',
    '正文与对白记录中的同一次发话只执行一次；正文已写出的同一句与对应记录不是两次发话，也不增加播放次数。正文未写出的已分配对白仍属于本段，须和动作一起安排；原文真实重复发话及continuation接续按各自记录保留，不重新从头重复。',
  ].join('\n');
};

export interface SemanticSegmentSourceContext {
  kind: 'semantic-segment-source-v1';
  sourceStoryTitle: string;
  sourceContentHash: string;
  segmentIndex: number;
  segmentCount: number;
  segmentDurationSec: number;
  segment: SemanticSequenceResponseSegment;
  /** Complete request-only source; segment.content remains the saved AI prose. */
  generationStoryContent: string;
  /** Read-only narrative context; never an extension of this segment's events. */
  storyUnderstandingContext?: {
    usage: 'understanding-only';
    sourceStoryContent: string;
    originalSourceContext?: StoryVisualConversionSnapshot;
    characterIdentities: Array<Pick<SemanticSequenceCharacter, 'name' | 'id' | 'aliases'>>;
    instruction: string;
  };
  /** Explicit user edits take precedence without rewriting original evidence. */
  contentOverridden?: boolean;
  creativeDirection: VideoCreativeDirection;
  pacing?: StoryPacingContext;
  characterContinuity: SemanticSequenceCharacter[];
  shotMode?: ShotMode;
  shotCount?: number;
}

/** Assigned events/lines are the only performance scope. The full story is
 * separate read-only context for identity and causality, never segment prose. */
export const semanticSegmentSourceContext = (plan: VideoSequencePlan, segment: VideoSegment): SemanticSegmentSourceContext => {
  if (!isSemanticSequencePlan(plan) || !plan.semanticPlanningSnapshot || !segment.semanticSource
    || !plan.segments.some((item) => item.id === segment.id)) throw new SemanticSequenceTechnicalError(['缺少当前语义片段来源']);
  const snapshot: SemanticSequencePlanningSnapshot = plan.semanticPlanningSnapshot;
  const creativeDirection = normalizeVideoCreativeDirection(snapshot.creativeDirection);
  if (!creativeDirection) throw new SemanticSequenceTechnicalError(['缺少语义片段创作方向']);
  const originalSourceContext = normalizeStoryVisualConversionSnapshot(snapshot.originalSourceContext);
  const matchingOriginal = originalSourceContext?.resultText.trim() === plan.sourceStoryContent.trim()
    ? originalSourceContext : undefined;
  return {
    kind: 'semantic-segment-source-v1', sourceStoryTitle: plan.sourceStoryTitle,
    sourceContentHash: plan.sourceContentHash ?? sourceContentHash(plan.sourceStoryContent),
    segmentIndex: segment.index, segmentCount: plan.segments.length, segmentDurationSec: plan.segmentDurationSec,
    segment: { ...(copyStrings(segment as unknown as Record<string, unknown>, SEGMENT_TEXT_FIELDS) as Omit<SemanticSequenceResponseSegment, 'semanticSource'>),
      semanticSource: readSemanticSource(segment.semanticSource, '当前片段', plan.sourceStoryContent.length) },
    generationStoryContent: semanticSegmentStoryContent(segment),
    storyUnderstandingContext: {
      usage: 'understanding-only', sourceStoryContent: plan.sourceStoryContent,
      ...(matchingOriginal ? { originalSourceContext: matchingOriginal } : {}),
      characterIdentities: copyCharacters(snapshot.characterContinuity).map((character) => ({
        name: character.name, ...(character.id ? { id: character.id } : {}),
        ...(character.aliases ? { aliases: [...character.aliases] } : {}),
      })),
      instruction: '本区全文及原始小说只用于理解人物指代、别名、攻击来源、比喻和跨段因果，不是本段演出清单。实际演出仅限本段已分配事件和对白，不搬入前后段新剧情，不重演已完成事件，不提前揭示身份。contentOverridden=true时以用户当前正文为准，不从旧证据或全文恢复用户已删除、修改的事件和对白。',
    },
    ...(segment.contentOverridden ? { contentOverridden: true } : {}),
    creativeDirection, pacing: copyPacing(snapshot.pacing), characterContinuity: copyCharacters(snapshot.characterContinuity),
    ...(snapshot.shotMode !== undefined ? { shotMode: snapshot.shotMode } : {}),
    ...(snapshot.shotCount !== undefined ? { shotCount: snapshot.shotCount } : {}),
  };
};
