import {
  MODEL_PROFILES,
  getModelProfile,
  resolveModelProfile,
  type ModelProfile,
  type PromptDetailMode,
  type ReferenceMediaType,
  type ReferenceRole
} from './modelProfiles';
import {
  hasNsfwDetailSignal,
  sanitizeLegacyNsfwPromptLeak,
  sanitizeNsfwAutomaticConstraints,
} from './promptConstraints';
import {
  normalizeShotAmbientSound,
  stripAmbientBedFromAction,
} from './audioPromptPolicy';

/**
 * The adapter deliberately accepts a small structural type instead of the
 * application's ReferenceAsset.  This keeps the module usable by the
 * renderer, import/export tools, and future API clients without coupling the
 * model contract to the current UI state schema.
 */
export interface PromptReferenceInput {
  id?: string;
  name?: string;
  /** `mediaType` is preferred; `type` is accepted for existing project assets. */
  mediaType?: ReferenceMediaType | string;
  type?: string;
  role?: ReferenceRole | string;
  referenceRole?: ReferenceRole | string;
  source?: string;
  sourceUrl?: string;
  fileName?: string;
  url?: string;
  /** Optional project entity id used to map several semantic subjects to one picture. */
  sourceEntityId?: string;
  durationSec?: number;
  duration?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  /** Used for first/last-frame planning and for explicit role bindings. */
  firstFrame?: boolean;
  lastFrame?: boolean;
  targetBindings?: readonly string[];
  responsibility?: string;
  description?: string;
  visualAnchor?: string;
  [key: string]: unknown;
}

export interface PromptSubjectDefinitionInput {
  name: string;
  /** Optional explicit shape-variant identity. The decorated `name` remains
   * the primary key; these fields prevent an H3 adapter from merging two
   * forms that share one narrative person. */
  baseName?: string;
  formLabel?: string;
  variantOf?: string;
  transformationType?: string;
  kind?: 'character' | 'scene' | 'prop' | 'subject' | string;
  description?: string;
  gender?: string;
  race?: string;
  /** Optional species-shape lock.  Kept separate from race for legacy data. */
  morphology?: string;
  bodyPlan?: string;
  appearance?: string;
  outfit?: string;
  /** Wardrobe inventory only, not a claim about the clothes currently worn.
   * The authored entrance/shot state has precedence during a clothing change. */
  wardrobeBaseline?: string;
  anchor?: string;
  motion?: string;
  referenceAssetIds?: readonly string[];
}

export interface PromptAdapterInput {
  canonicalPrompt: string;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audioMode: string;
  references?: readonly PromptReferenceInput[];
  /** Semantic subjects visible in the canonical timeline. Multiple subjects may
   * intentionally point at the same composite reference picture. */
  subjectDefinitions?: readonly PromptSubjectDefinitionInput[];
  /** AI-selected visible appearance facts, scoped to one exact shot only. */
  shotPrivateDetails?: readonly { shotIndex: number; subjectName: string; description: string }[];
  targetId: string;
  detailMode?: PromptDetailMode | string;
  /** Structured constraints from the canonical Prompt IR. */
  constraints?: readonly string[];
  /** Explicit source-derived NSFW mode for legacy prompts that lost source detail. */
  nsfwDetail?: boolean;
}

export type CompileTargetPromptInput = PromptAdapterInput;

export interface TargetParameters {
  model: string;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audioMode: string;
  /** API-friendly aliases are retained when they are useful for a target. */
  duration?: number;
  seconds?: string;
  size?: string;
  generateAudio?: boolean;
  [key: string]: string | number | boolean | undefined;
}

export interface ReferenceManifestEntry {
  index: number;
  id: string;
  name: string;
  mediaType: ReferenceMediaType;
  role: ReferenceRole;
  token: string;
  responsibility: string;
  source?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  targetBindings: readonly string[];
  /** A stable, human-readable label for exports and diagnostics. */
  label: string;
}

export interface ReferenceManifest {
  targetId: string;
  assets: readonly ReferenceManifestEntry[];
  /** Aliases make the manifest convenient for importers written against early previews. */
  entries: readonly ReferenceManifestEntry[];
  items: readonly ReferenceManifestEntry[];
  counts: Readonly<Partial<Record<ReferenceMediaType, number>>>;
  byMediaType: Readonly<Partial<Record<ReferenceMediaType, number>>>;
  roleCounts: Readonly<Partial<Record<ReferenceRole, number>>>;
  byRole: Readonly<Partial<Record<ReferenceRole, number>>>;
  text: string;
}

export interface CompiledTargetPrompt {
  targetId: string;
  prompt: string;
  parameters: TargetParameters;
  referenceManifest: ReferenceManifest;
  warnings: readonly string[];
}

export type TargetPromptCompilation = CompiledTargetPrompt;

interface NormalizedReference {
  id: string;
  name: string;
  mediaType: ReferenceMediaType;
  role: ReferenceRole;
  source?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  targetBindings: readonly string[];
  responsibility: string;
}

const MEDIA_TYPES: readonly ReferenceMediaType[] = ['image', 'video', 'audio', 'clay-render'];
const ROLES: readonly ReferenceRole[] = [
  'character', 'scene', 'prop', 'style', 'motion', 'composition', 'camera', 'audio',
  'dialogue', 'first-frame', 'last-frame', 'clay-render', 'creative', 'general'
];

const mediaAliases: Record<string, ReferenceMediaType> = {
  image: 'image', images: 'image', picture: 'image', photo: 'image', png: 'image', jpg: 'image', jpeg: 'image',
  video: 'video', clip: 'video', mp4: 'video', mov: 'video', webm: 'video',
  audio: 'audio', sound: 'audio', music: 'audio', speech: 'audio', mp3: 'audio', wav: 'audio',
  'clay-render': 'clay-render', clay: 'clay-render', clayrender: 'clay-render', 'clay_render': 'clay-render'
};

const roleAliases: Record<string, ReferenceRole> = {
  character: 'character', person: 'character', subject: 'character', 人物: 'character', 角色: 'character',
  scene: 'scene', location: 'scene', background: 'scene', environment: 'scene', 场景: 'scene', 地点: 'scene',
  prop: 'prop', object: 'prop', item: 'prop', 道具: 'prop', 物体: 'prop',
  style: 'style', visual: 'style', aesthetic: 'style', 风格: 'style',
  motion: 'motion', movement: 'motion', 动作: 'motion', 运动: 'motion',
  composition: 'composition', storyboard: 'composition', 构图: 'composition', 分镜: 'composition',
  camera: 'camera', 镜头: 'camera', 摄影: 'camera',
  audio: 'audio', sound: 'audio', 音频: 'audio', 声音: 'audio',
  dialogue: 'dialogue', voice: 'dialogue', 台词: 'dialogue', 对白: 'dialogue',
  'first-frame': 'first-frame', firstframe: 'first-frame', 首帧: 'first-frame',
  'last-frame': 'last-frame', lastframe: 'last-frame', 尾帧: 'last-frame',
  'clay-render': 'clay-render', clayrender: 'clay-render', 泥模: 'clay-render',
  creative: 'creative', 创意: 'creative', general: 'general', reference: 'general', 参考: 'general'
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function finitePositive(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizeMediaType(input: PromptReferenceInput): ReferenceMediaType {
  const explicit = clean(input.mediaType).toLowerCase();
  const explicitAlias = ownValue(mediaAliases, explicit);
  if (explicitAlias) return explicitAlias;
  const legacy = clean(input.type).toLowerCase();
  const legacyAlias = ownValue(mediaAliases, legacy);
  if (legacyAlias) return legacyAlias;
  const file = clean(input.fileName || input.sourceUrl || input.url).toLowerCase();
  const extension = file.split(/[?#]/u)[0].split('.').pop() || '';
  return ownValue(mediaAliases, extension) || 'image';
}

function normalizeRole(input: PromptReferenceInput, mediaType: ReferenceMediaType): ReferenceRole {
  if (input.firstFrame) return 'first-frame';
  if (input.lastFrame) return 'last-frame';
  const raw = clean(input.referenceRole || input.role).toLowerCase();
  const rawAlias = ownValue(roleAliases, raw);
  if (rawAlias) return rawAlias;
  const legacy = clean(input.type).toLowerCase();
  const legacyAlias = ownValue(roleAliases, legacy);
  if (legacyAlias) return legacyAlias;
  return mediaType === 'audio' ? 'audio' : mediaType === 'clay-render' ? 'clay-render' : 'general';
}

function defaultResponsibility(role: ReferenceRole, mediaType: ReferenceMediaType): string {
  const labels: Partial<Record<ReferenceRole, string>> = {
    character: '锁定角色外观、服装和身份',
    scene: '锁定场景空间、材质和环境',
    prop: '锁定道具形态与状态',
    style: '参考整体视觉风格与色彩',
    motion: '参考运动节奏和动作轨迹',
    composition: '参考构图、景别和画面布局',
    camera: '参考摄影机运动与镜头语言',
    audio: '参考环境声、音乐或声音质感',
    dialogue: '参考对白、声音表演或口型节奏',
    'first-frame': '作为生成起始画面',
    'last-frame': '作为生成结束画面',
    'clay-render': '参考三维结构、体块和镜头预演',
    creative: '参考创意方向与视觉语汇',
    general: '提供补充视觉或叙事参考'
  };
  return labels[role] || `提供 ${mediaType} 参考`;
}

function normalizeReference(input: PromptReferenceInput, index: number): NormalizedReference {
  const mediaType = normalizeMediaType(input);
  const role = normalizeRole(input, mediaType);
  const id = clean(input.id) || `reference-${index + 1}`;
  const name = clean(input.name) || clean(input.fileName) || `${mediaType} reference ${index + 1}`;
  const source = clean(input.source) || clean(input.sourceUrl) || clean(input.url) || undefined;
  const durationSec = finitePositive(input.durationSec ?? input.duration);
  const width = finitePositive(input.width);
  const height = finitePositive(input.height);
  const targetBindings = Array.isArray(input.targetBindings)
    ? input.targetBindings.map(clean).filter(Boolean)
    : [];
  const responsibility = clean(input.responsibility) || clean(input.description) || clean(input.visualAnchor) || defaultResponsibility(role, mediaType);
  return { id, name, mediaType, role, source, durationSec, width, height, aspectRatio: clean(input.aspectRatio) || undefined, targetBindings, responsibility };
}

function detailModeOf(value: PromptDetailMode | string | undefined, profile: ModelProfile): 'concise' | 'director' {
  const mode = clean(value).toLowerCase();
  if (mode === 'concise' || mode === 'compact' || mode === 'simple' || mode === '简洁' || mode === '短') return 'concise';
  if (mode === 'director' || mode === 'detailed' || mode === 'director-detailed' || mode === '导演' || mode === '导演详细' || mode === '详细') return 'director';
  return profile.promptPreference === 'concise' ? 'concise' : 'director';
}

function tokenFor(profile: ModelProfile, mediaType: ReferenceMediaType, index: number, name: string): string {
  if (profile.id === 'minimax-h3') {
    const label = mediaType === 'video' ? 'Video' : mediaType === 'audio' ? 'Audio' : 'Picture';
    return `<${label} ${index}>`;
  }
  switch (profile.referenceSyntax) {
    case 'at-token':
      return `@${mediaType === 'video' ? 'Video' : mediaType === 'audio' ? 'Audio' : 'Image'} ${index}`;
    case 'bracketed':
      return `[Reference ${index}: ${name}]`;
    case 'named':
      return `reference ${index} (${name})`;
    default:
      return `provided ${mediaType} reference ${index} (${name})`;
  }
}

function tokenIndexByMediaType(references: readonly NormalizedReference[], currentIndex: number): number {
  const mediaType = references[currentIndex].mediaType;
  let index = 0;
  for (let i = 0; i <= currentIndex; i += 1) {
    if (references[i].mediaType === mediaType) index += 1;
  }
  return index;
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

interface H3CanonicalShot {
  startSec: number;
  endSec: number;
  subject: string;
  /** State at the first frame, extracted from the canonical subject parenthesis. */
  entryState: string;
  /** Authored end state from the action or purpose bracket. */
  endState: string;
  direction: string;
  action: string;
  camera: string;
  scene: string;
  lighting: string;
  dialogue: string;
  sound: string;
  music: string;
  purpose: string;
}

type H3CanonicalField = keyof Omit<H3CanonicalShot, 'startSec' | 'endSec' | 'entryState' | 'endState'>;

const H3_CANONICAL_TIMELINE = /^【\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-—–~至到]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*】[ \t]*([\s\S]*?)(?=^【\s*\d|(?![\s\S]))/gimu;

const h3FieldAliases: Readonly<Record<string, H3CanonicalField>> = {
  主体: 'subject', 人物: 'subject', 角色: 'subject', 对象: 'subject',
  朝向: 'direction', 行进方向: 'direction',
  动作: 'action', 表演: 'action', 事件: 'action', 行为: 'action',
  镜头: 'camera', 运镜: 'camera', 摄影: 'camera', 摄影机: 'camera',
  场景: 'scene', 环境: 'scene', 空间: 'scene',
  光影: 'lighting', 灯光: 'lighting', 风格: 'lighting', 视觉: 'lighting',
  台词: 'dialogue', 对白: 'dialogue',
  声音: 'sound', 音效: 'sound', 声场: 'sound', 环境声: 'sound',
  音乐: 'music', 配乐: 'music', 非叙事音乐: 'music',
  叙事作用: 'purpose', 目的: 'purpose', 结果: 'purpose'
};

function trimH3Punctuation(value: string): string {
  return clean(value).replace(/^[，,；;。\s]+|[，,；;。\s]+$/gu, '');
}

const H3_GROUP_CLOSERS: Readonly<Record<string, string>> = {
  '"': '"', '“': '”', '‘': '’', '「': '」', '『': '』',
  '[': ']', '(': ')', '（': '）', '{': '}', '〔': '〕', '【': '】',
};
const H3_QUOTE_CLOSERS = new Set(['"', '”', '’', '」', '』']);

/** Read syntax only. Quotes and nested brackets are opaque; an action or
 * direction mentioned inside them must not become a new canonical field. */
function h3TopLevelGroups(value: string): { start: number; end: number; opener: string; body: string }[] {
  const groups: { start: number; end: number; opener: string; body: string }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length;) {
    const character = h3CharacterAt(value, index);
    const expectedCloser = stack[stack.length - 1];
    if (expectedCloser && H3_QUOTE_CLOSERS.has(expectedCloser)) {
      if (character === expectedCloser && !isEscapedH3Quote(value, index)) stack.pop();
    } else if (expectedCloser === character) {
      stack.pop();
    } else if (ownValue(H3_GROUP_CLOSERS, character) && !isEscapedH3Quote(value, index)) {
      if (!stack.length) start = index;
      stack.push(H3_GROUP_CLOSERS[character]);
    } else {
      index += character.length;
      continue;
    }
    if (!stack.length) {
      groups.push({ start, end: index + character.length, opener: value[start], body: value.slice(start + 1, index) });
    }
    index += character.length;
  }
  return groups;
}

function splitH3EndState(value: string): { body: string; state: string } {
  let cursor = 0;
  const body: string[] = [];
  const states: string[] = [];
  for (const group of h3TopLevelGroups(value)) {
    if (group.opener !== '〔') continue;
    const label = value.slice(cursor, group.start).match(/镜尾(?:状态|裸露状态|衣物状态|关键接触|动作阶段|残留状态)$/u);
    if (!label) continue;
    const start = group.start - label[0].length;
    body.push(value.slice(cursor, start));
    states.push(value.slice(start, group.end));
    cursor = group.end;
  }
  body.push(value.slice(cursor));
  return { body: trimH3Punctuation(body.join('')), state: states.join('；') };
}

function splitH3SubjectPrefix(value: string): { subject: string; entryState: string; direction: string } {
  const groups = h3TopLevelGroups(value);
  const identity: string[] = [];
  const performance: string[] = [];
  const directions: string[] = [];
  let identityCursor = 0;
  let performanceCursor = 0;
  let directionIdentityStart = 0;
  let hasPerformance = false;
  for (const group of groups) {
    const direction = group.opener === '[' ? group.body.match(/^朝向\s*[：:]\s*([\s\S]*)$/u) : undefined;
    const isPerformance = group.opener === '（' || group.opener === '(';
    if (!direction && !isPerformance) continue;
    identity.push(value.slice(identityCursor, group.start));
    identityCursor = group.end;
    if (direction) {
      performance.push(value.slice(performanceCursor, group.start));
      performanceCursor = group.end;
      const owner = trimH3Punctuation(identity.slice(directionIdentityStart).join('')).replace(/^[、\s]+|[、\s]+$/gu, '');
      directions.push([owner, direction[1]].filter(Boolean).join('：'));
      directionIdentityStart = identity.length;
    } else {
      hasPerformance = true;
    }
  }
  identity.push(value.slice(identityCursor));
  performance.push(value.slice(performanceCursor));
  const subject = trimH3Punctuation(identity.join('')).replace(/^[、\s]+|[、\s]+$/gu, '');
  const entryState = hasPerformance ? trimH3Punctuation(performance.join('')).replace(/^[、\s]+|[、\s]+$/gu, '') : '';
  return { subject, entryState, direction: directions.join('；') };
}

function splitH3EmbeddedAction(subjectValue: string): {
  subject: string;
  entryState: string;
  endState: string;
  direction: string;
  action: string;
  purpose: string;
} {
  const groups = h3TopLevelGroups(subjectValue);
  const pieces: ReturnType<typeof splitH3EmbeddedAction>[] = [];
  let cursor = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group.opener !== '[' || group.start < cursor) continue;
    const before = subjectValue.slice(Math.max(cursor, groups[index - 1]?.end || 0), group.start);
    const marker = before.match(/\s*正在\s*$/u);
    if (!marker) continue;
    const prefix = splitH3SubjectPrefix(subjectValue.slice(cursor, group.start - marker[0].length));
    const action = splitH3EndState(group.body);
    const nextGroup = groups[index + 1];
    const purposeGroup = nextGroup && /^(?:（|\()$/u.test(nextGroup.opener)
      && !subjectValue.slice(group.end, nextGroup.start).trim() ? nextGroup : undefined;
    const purpose = splitH3EndState(purposeGroup?.body || '');
    pieces.push({
      ...prefix,
      action: action.body,
      endState: [action.state, purpose.state].filter(Boolean).join('；'),
      purpose: purpose.body,
    });
    cursor = purposeGroup?.end || group.end;
  }
  if (!pieces.length) {
    // Legacy prompts may separate actions into their own field while keeping
    // an explicit direction/performance in the subject field.
    return { ...splitH3SubjectPrefix(subjectValue), endState: '', action: '', purpose: '' };
  }
  const trailing = trimH3Punctuation(subjectValue.slice(cursor));
  if (trailing) pieces[pieces.length - 1].action += `；${trailing}`;
  const join = (key: keyof ReturnType<typeof splitH3EmbeddedAction>): string => pieces
    .map((piece) => piece[key]).filter(Boolean).join('；');
  return {
    subject: join('subject'),
    entryState: join('entryState'),
    endState: join('endState'),
    direction: join('direction'),
    action: join('action'),
    purpose: join('purpose'),
  };
}

function splitH3CanonicalSound(soundValue: string): { sound: string; style: string } {
  const match = soundValue.match(/^([\s\S]*?情绪层-\[[^\]]*\])\s+([\s\S]+)$/u);
  if (!match) return { sound: soundValue, style: '' };
  const style = match[2]
    .split(/[，,]/u)
    .map(trimH3Punctuation)
    .filter((item) => item && !/^(?:画幅|画面比例|分辨率|解析度|保留立体声层次|无声输出|主体始终|制作要求|追求极致|镜头偏好|光影偏好)/u.test(item))
    .join('，');
  return { sound: trimH3Punctuation(match[1]), style };
}

interface H3TopLevelSection {
  name: string;
  value: string;
  raw: string;
  start: number;
}

const H3_AUDIO_FIELD_KIND: Readonly<Record<string, 'soundscape' | 'music'>> = {
  overall_soundscape: 'soundscape', 全局声景: 'soundscape', 整段声景: 'soundscape',
  non_diegetic_music: 'music', 背景音乐: 'music', 背景配乐: 'music', 音乐: 'music', 配乐: 'music',
  非叙事音乐: 'music', 'background music': 'music', music: 'music', score: 'music', bgm: 'music',
};

/** Read section boundaries, never sound meaning. Quoted/bracketed prose and
 * dialogue are opaque, so a quoted field name cannot end a multiline value.
 * The same reader keeps the full-reference wrapper from slicing an audio
 * field at an apparent header inside its quoted source description. */
function h3TopLevelSections(value: string, audioAliases = false): H3TopLevelSection[] {
  const official = 'subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music';
  const aliases = audioAliases ? '|全局声景|整段声景|背景音乐|背景配乐|音乐|配乐|非叙事音乐|background[ \\t]+music|music|score|bgm' : '';
  const pattern = new RegExp(`^[ \\t]*(${official}${aliases})[ \\t]*[:：][ \\t]*`, 'gimu');
  const protectedRanges = h3TopLevelGroups(value).map((group) => ({ start: group.start, end: group.end }));
  for (const dialogue of value.matchAll(/<d>[\s\S]*?<\/d>/gu)) {
    protectedRanges.push({ start: dialogue.index!, end: dialogue.index! + dialogue[0].length });
  }
  const matches = [...value.matchAll(pattern)].filter((match) => !protectedRanges.some((range) => (
    range.start <= match.index! && match.index! < range.end
  )));
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? value.length;
    return {
      name: match[1].toLowerCase().replace(/[ \t]+/gu, ' '),
      value: value.slice(match.index! + match[0].length, end).trim(),
      raw: value.slice(match.index!, end).trim(),
      start: match.index!,
    };
  });
}

/** Only explicitly scoped fields supply global audio. Shot environment
 * layers, free prose and quoted dialogue are never reclassified. A single
 * constraint block can contain both audio fields without nesting one H3
 * section inside the other or losing a genuine multiline description. */
function h3StructuredAudioConstraints(constraints: readonly string[]): {
  soundscapes: string[];
  music: string[];
  remaining: string[];
} {
  const result = { soundscapes: [] as string[], music: [] as string[], remaining: [] as string[] };
  for (const constraint of constraints) {
    const source = clean(constraint);
    const sections = h3TopLevelSections(source, true);
    const first = sections[0];
    if (!first || first.start !== 0 || !ownValue(H3_AUDIO_FIELD_KIND, first.name)) {
      result.remaining.push(constraint);
      continue;
    }
    for (const section of sections) {
      const kind = ownValue(H3_AUDIO_FIELD_KIND, section.name);
      if (kind && section.value) {
        (kind === 'soundscape' ? result.soundscapes : result.music).push(section.value);
      } else {
        // This is a constraint block, not another finished H3 body. Preserve
        // unrelated/empty declarations as opaque source text in the existing
        // constraint prose; never emit them as duplicate official sections.
        result.remaining.push(`原始约束字段：${JSON.stringify(section.raw)}`);
      }
    }
  }
  return result;
}

function isH3KnownFieldSeparator(value: string, separatorIndex: number): boolean {
  const fieldMatch = value.slice(separatorIndex + 1).match(/^\s*([^：:\n]{1,16})[：:]/u);
  if (!fieldMatch) return false;
  const fieldLabel = clean(fieldMatch[1]).replace(/\s+/gu, '');
  return Boolean(ownValue(h3FieldAliases, fieldLabel));
}

function hasH3QuoteCloserAfter(value: string, start: number, closer: string): boolean {
  for (let index = start; index < value.length;) {
    const character = h3CharacterAt(value, index);
    if (character === closer && !isEscapedH3Quote(value, index)) return true;
    index += character.length;
  }
  return false;
}

function splitH3CanonicalFields(body: string, separator = /[；;\n]/u, onlyKnownFields = false): string[] {
  const stack: string[] = [];
  const fields: string[] = [];
  let current = '';
  const normalizedBody = body.replace(/\r/gu, '');
  let offset = 0;
  for (const character of normalizedBody) {
    const expectedCloser = stack[stack.length - 1];
    if (expectedCloser && H3_QUOTE_CLOSERS.has(expectedCloser)) {
      const recoversKnownField = stack.length === 1
        && /[；;]/u.test(character)
        && isH3KnownFieldSeparator(normalizedBody, offset)
        && !hasH3QuoteCloserAfter(normalizedBody, offset + character.length, expectedCloser);
      if (recoversKnownField) {
        stack.pop();
        fields.push(current);
        current = '';
        offset += character.length;
        continue;
      }
      current += character;
      if (character === expectedCloser && !isEscapedH3Quote(normalizedBody, offset)) stack.pop();
      offset += character.length;
      continue;
    }
    if (ownValue(H3_GROUP_CLOSERS, character) && !isEscapedH3Quote(normalizedBody, offset)) {
      stack.push(H3_GROUP_CLOSERS[character]);
      current += character;
    } else if (expectedCloser && character === expectedCloser) {
      stack.pop();
      current += character;
    } else if (!stack.length && separator.test(character)
      && (!onlyKnownFields || isH3KnownFieldSeparator(normalizedBody, offset))) {
      fields.push(current);
      current = '';
    } else {
      current += character;
    }
    offset += character.length;
  }
  fields.push(current);
  return fields;
}

function parseH3ShotBody(body: string, startSec: number, endSec: number): H3CanonicalShot {
  const values: Record<H3CanonicalField, string[]> = {
    subject: [], direction: [], action: [], camera: [], scene: [], lighting: [], dialogue: [], sound: [], music: [], purpose: []
  };
  const unlabelled: string[] = [];
  // Semicolons may separate clauses within a field (landmarks after space,
  // listeners after dialogue). Only a recognized label starts another field;
  // keeping the continuation in-place also preserves its exact punctuation.
  for (const chunk of splitH3CanonicalFields(body, /[；;\n]/u, true)) {
    const part = trimH3Punctuation(chunk);
    if (!part) continue;
    const match = part.match(/^([^：:\n]{1,16})[：:]\s*([\s\S]+)$/u);
    const key = match ? ownValue(h3FieldAliases, clean(match[1]).replace(/\s+/gu, '')) : undefined;
    if (match && key) values[key].push(trimH3Punctuation(match[2]));
    else unlabelled.push(part);
  }
  const embedded = values.subject.map(splitH3EmbeddedAction);
  const embeddedActions = embedded.map((item) => item.action).filter(Boolean);
  const soundParts = values.sound.map(splitH3CanonicalSound);
  return {
    startSec,
    endSec,
    subject: embedded.map((item) => item.subject).join('；'),
    entryState: embedded.map((item) => item.entryState).filter(Boolean).join('；'),
    endState: [
      ...embedded.map((item) => item.endState),
      ...values.purpose.map((item) => splitH3EndState(item).state),
    ].filter(Boolean).join('；'),
    direction: [...values.direction, ...embedded.map((item) => item.direction)].filter(Boolean).join('；'),
    action: [...values.action, ...embeddedActions].join('；') || unlabelled.join('；') || '保持当前可见状态',
    camera: values.camera.join('；'),
    scene: values.scene.join('；'),
    lighting: [...values.lighting, ...soundParts.map((item) => item.style).filter(Boolean)].join('；'),
    dialogue: values.dialogue.join('；'),
    sound: soundParts.map((item) => item.sound).join('；'),
    music: values.music.join('；'),
    purpose: [...values.purpose, ...embedded.map((item) => item.purpose).filter(Boolean)].join('；')
  };
}

function parseH3CanonicalPrompt(canonicalPrompt: string, durationSec: number): H3CanonicalShot[] {
  const canonical = clean(canonicalPrompt);
  const shots = Array.from(canonical.matchAll(H3_CANONICAL_TIMELINE), (match) => parseH3ShotBody(
    match[3],
    Number(match[1]),
    Number(match[2])
  ));
  if (shots.length) return shots;
  return [parseH3ShotBody(canonical || '动作：保持当前可见状态', 0, Math.max(0, durationSec))];
}

function uniqueH3Texts(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values
    .map(trimH3Punctuation)
    // Empty/delimiter-only atoms carry no prompt information.  Keeping them
    // would create labels such as `声音：｜` or duplicate separators in the
    // global soundscape when an editable preset contains a blank slot.
    .filter((item) => item && !/^[｜|；;，,。！？!?、\s]+$/u.test(item))) {
    const key = value.replace(/\s+/gu, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function stripH3GlobalSpecs(value: string, input: PromptAdapterInput): string {
  let result = value;
  for (const literal of [clean(input.aspectRatio), clean(input.resolution)].filter(Boolean)) {
    result = result.split(literal).join('');
  }
  return trimH3Punctuation(
    result
      .split(/([，,；;])/u)
      .filter((part) => !/^(?:画幅|画面比例|分辨率|解析度)$/u.test(clean(part)))
      .join('')
      .replace(/[，,]\s*[，,]/gu, '，')
      .replace(/[；;]\s*[；;]/gu, '；')
  );
}

function isH3InternalConstraint(value: string): boolean {
  const constraint = clean(value);
  if (/^(?:画幅|画面比例|分辨率|解析度)\s*[:：]?/u.test(constraint)) return true;
  return /^(?:导演风格|导演说明|镜头偏好|光影偏好|规则基础|连续性规则|输出规则|转换器(?:输出)?|内部匹配规则|执行顺序|生成规则|模型判断|制作说明)\s*[:：]?/u.test(constraint);
}

function h3Clauses(value: string): string[] {
  return splitH3CanonicalFields(value, /[，,；;。！？!?\n]/u)
    .map(clean)
    .filter((item) => item && !/^[｜|；;，,。！？!?、\s]+$/u.test(item));
}

/**
 * Subjects are identity anchors rather than optional prose. Keep every
 * distinct subject identity and normalize only its separating punctuation.
 */
function splitH3SubjectIdentities(value: string): string[] {
  const chunks = clean(value)
    // A semicolon separates repeated `主体：` values.  Commas inside one
    // subject are usually appearance/structure facts (for example
    // `银灰甲壳、金色裂纹、六足`), so do not turn those facts into fake cast
    // members.  Explicit conjunctions remain safe subject boundaries.
    .split(/[；;\n]+/u)
    .map(trimH3Punctuation)
    .filter(Boolean);
  return uniqueH3Texts(chunks.flatMap((chunk) => {
    const conjunctions = chunk.split(/\s*(?:与|和|及|、)\s*/u).map(trimH3Punctuation).filter(Boolean);
    if (conjunctions.length > 1) return conjunctions;
    // Some hand-edited prompts list multiple @-tagged subjects with commas;
    // split that unambiguous form while leaving ordinary descriptive commas
    // intact.
    if ((chunk.match(/@/gu) || []).length > 1) {
      return chunk.split(/[，,、]/u).map(trimH3Punctuation).filter(Boolean);
    }
    return [chunk];
  }));
}

function compactH3SubjectPhrase(values: readonly string[]): string {
  const identities = uniqueH3Texts(values.flatMap(splitH3SubjectIdentities));
  return identities.join('、');
}

// Keep scene/prop records out of the `主体：…` identity field, but treat any
// other kind (creature, animal, monster, custom species, etc.) as a possible
// performer.  Character records in older projects use several different kind
// labels, and a narrow allow-list would drop their gender/appearance anchors.
const h3NonSubjectKinds = /^(?:scene|location|background|environment|place|prop|object|item|场景|地点|背景|环境|空间|道具|物品)$/iu;

/**
 * Render project-bible identity facts into the first H3 Shot when no visual
 * reference manifest will be emitted.  The canonical timeline intentionally
 * keeps appearance details out of every repeated Shot; without this anchor a
 * no-reference video prompt contains only a name and the backend is free to
 * redraw the character on each cut.  Keep the facts in one stable parenthesis
 * so gender, race, appearance, outfit and custom continuity anchors remain
 * explicit and easy for the target model to bind.
 */
function h3SubjectDefinitionAnchors(
  definitions: readonly PromptSubjectDefinitionInput[] | undefined,
  subjectText: string,
  evidenceText = subjectText,
): string {
  if (!definitions?.length) return '';
  const normalizedEvidence = clean(evidenceText).replace(/@/gu, '');
  const anchors: string[] = [];
  const relevantDefinitions = definitions.filter((definition) => {
    const name = clean(definition.name).replace(/^@/u, '');
    const kind = clean(definition.kind);
    if (!name || h3NonSubjectKinds.test(kind)) return false;
    // If a caller supplies unrelated project entities, do not inject them into
    // this video's cast.  An empty subject field still accepts all explicitly
    // supplied character definitions as the only available cast evidence.
    return !normalizedEvidence || normalizedEvidence.includes(name);
  });
  // Replace each known name in-place instead of replacing the complete subject
  // string.  This keeps an unlisted co-performer or creature visible (the old
  // implementation returned only the matched definition anchors and could
  // silently erase that part of `主体：甲与怪物`).
  let merged = clean(subjectText);
  for (const definition of [...relevantDefinitions].sort((left, right) => clean(right.name).length - clean(left.name).length)) {
    const name = clean(definition.name).replace(/^@/u, '');
    const structuredValues = [
      clean(definition.baseName),
      clean(definition.formLabel),
      clean(definition.variantOf),
      clean(definition.transformationType),
      clean(definition.gender),
      clean(definition.race),
      clean(definition.morphology),
      clean(definition.bodyPlan),
      clean(definition.appearance),
      clean(definition.outfit),
      clean(definition.wardrobeBaseline),
      clean(definition.anchor),
      clean(definition.motion),
    ].filter(Boolean);
    const details = [
      clean(definition.formLabel) ? `形态：${clean(definition.formLabel)}` : '',
      clean(definition.baseName) ? `同源人物：${clean(definition.baseName)}` : '',
      clean(definition.transformationType) ? `转化类型：${clean(definition.transformationType)}` : '',
      clean(definition.gender) ? `性别：${clean(definition.gender)}` : '',
      clean(definition.race) ? `物种/族裔：${clean(definition.race)}` : '',
      clean(definition.morphology) ? `外貌形态：${clean(definition.morphology)}` : '',
      clean(definition.bodyPlan) ? `身体结构：${clean(definition.bodyPlan)}` : '',
      clean(definition.appearance) ? `外貌：${clean(definition.appearance)}` : '',
      clean(definition.outfit) ? `服装：${clean(definition.outfit)}` : '',
      clean(definition.wardrobeBaseline)
        ? `衣橱基底（不是本镜着装指令）：${clean(definition.wardrobeBaseline)}；本镜衣着以已确认入口和逐镜状态为准，未涉及的衣物保持原状`
        : '',
      clean(definition.anchor) ? `连续性锚点：${clean(definition.anchor)}` : '',
      clean(definition.motion) ? `动作习惯：${clean(definition.motion)}` : '',
    ].filter(Boolean);
    // `description` is the compatibility field used by imported projects.
    // Preserve it alongside structured facts unless it is already represented
    // by one of them; older callers often place the only appearance sentence
    // in `description` while supplying gender separately.
    const description = clean(definition.description);
    if (description && !structuredValues.some((value) => value === description || value.includes(description))) {
      details.push(`设定：${description}`);
    }
    const anchor = `@${name}${details.length ? `（${details.join('；')}）` : ''}`;
    if (merged.includes(`@${name}`)) merged = merged.split(`@${name}`).join(anchor);
    else if (merged.includes(name)) merged = merged.split(name).join(anchor);
    else merged = [merged, anchor].filter(Boolean).join('、');
    anchors.push(anchor);
  }
  return merged || uniqueH3Texts(anchors).join('、');
}

function isH3KeyframeReferenceManifest(manifest: ReferenceManifest): boolean {
  const firstFrames = manifest.assets.filter((asset) => asset.role === 'first-frame');
  const lastFrames = manifest.assets.filter((asset) => asset.role === 'last-frame');
  return manifest.assets.length <= 2
    && manifest.assets.every((asset) => asset.mediaType === 'image' && (asset.role === 'first-frame' || asset.role === 'last-frame'))
    && firstFrames.length <= 1
    && lastFrames.length <= 1;
}

/**
 * A visual anchor can arrive from an editable style preset as a delimiter-only
 * value (for example `｜`) or with a stray delimiter at either edge.  Such a
 * value has no visual meaning but still passes the normal truthy checks and
 * renders as `风格与光影：｜` in the H3 delivery prompt.  Clean only the
 * delimiter shell here; delimiters inside a protected `〔…〕` style atom are
 * meaningful separators and must be retained.
 */
function cleanH3VisualField(value: string): string {
  const raw = clean(value);
  if (!raw) return '';
  const withoutEmptyAtoms = raw.replace(
    /(?:风格预设视觉|视觉风格锚点)〔\s*[｜|；;，,]*\s*〕/gu,
    '',
  );
  const trimmed = withoutEmptyAtoms
    .replace(/^[｜|\s]+/gu, '')
    .replace(/[｜|\s]+$/gu, '')
    .trim();
  if (!trimmed || /^[｜|；;，,。！？!?\s]+$/u.test(trimmed)) return '';
  return trimmed;
}

function h3SynchronizedShotSound(value: string): string {
  // Preserve the complete authored sound field in its own shot. It can contain
  // a no-score instruction, a diegetic cue, or a style wrapper; none of these
  // are local permission to infer or move music into the global H3 field.
  return trimH3Punctuation(
    value
      .replace(/\s{2,}/gu, ' '),
  );
}

/**
 * Editable visual/audio presets may leave a descriptive `风格预设声音〔…〕`
 * atom in every canonical Shot. It is a preset annotation, not a shot event
 * or an authored score/ambient layer. Keep the surrounding authored clauses
 * (especially `无配乐`, `台词：无`, and timed foley) while removing only that
 * repeated annotation before H3 serialization. This prevents the preset from
 * being copied into each Shot without changing any real sound event.
 */
function stripH3PresetSoundAnnotation(value: string): string {
  return trimH3Punctuation(
    value
      .replace(/(?:[｜|]\s*)?风格预设声音〔[^〕]*〕/gu, '')
      .replace(/\s*[｜|]\s*(?=[；;\]])/gu, '')
      .replace(/\s{2,}/gu, ' '),
  );
}

function formatH3Timestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = (safe - minutes * 60).toFixed(3).padStart(6, '0');
  return `${String(minutes).padStart(2, '0')}:${remainder}`;
}

function h3ReferencePrefix(manifest: ReferenceManifest, durationSec: number, shotCount: number): string {
  const first = manifest.assets.find((asset) => asset.role === 'first-frame');
  const last = manifest.assets.find((asset) => asset.role === 'last-frame');
  const end = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0).toFixed(2);
  if (first && last) {
    const firstLabel = first.token.replace(/^<|>$/gu, '');
    const lastLabel = last.token.replace(/^<|>$/gu, '');
    return `How the reference pictures align with the target video — ${firstLabel} (from Shot 1) aligns with the 0.00-second mark of the target video; ${lastLabel} (from Shot ${shotCount}) aligns with the ${end}-second mark of the target video.`;
  }
  if (first) {
    return `For the target video, at 0.00 seconds into the target video, ${first.token} (from [Shot 1]) is fully referenced.`;
  }
  if (last) {
    return `How the reference pictures align with the target video — ${last.token} (from [Shot ${shotCount}]) aligns with the ${end}-second mark of the target video.`;
  }
  return '';
}

function h3CutTime(shot: H3CanonicalShot, index: number, shotCount: number, durationSec: number): number {
  const requested = shot.startSec;
  if (Number.isFinite(requested) && requested > 0 && requested < durationSec) return requested;
  return Math.max(0, (Math.max(0, durationSec) * index) / shotCount);
}

function renderMinimaxH3Prompt(
  input: PromptAdapterInput,
  shots: readonly H3CanonicalShot[],
  manifest: ReferenceManifest
): string {
  const actionClausesFor = (shot: H3CanonicalShot): string[] => uniqueH3Texts(h3Clauses(
    stripAmbientBedFromAction(stripH3GlobalSpecs(shot.action, input)).replace(/\s*→\s*/gu, '，随后'),
  ).map((clause) => clause.replace(/^随后/u, '').trim()).filter(Boolean));
  const isSilent = /^(?:none|silent|静音)$/iu.test(clean(input.audioMode));
  const isAudibleValue = (value: string): boolean => {
    const normalized = clean(value);
    if (!normalized || /^[｜|；;，,。！？!?、\s]+$/u.test(normalized)) return false;
    return !/^(?:无(?:声音|音效|配乐|音乐)?|none|silent|n\/?a)$/iu.test(normalized);
  };
  const subjectValues = uniqueH3Texts(shots.map((shot) => stripH3GlobalSpecs(shot.subject, input)));
  const subject = compactH3SubjectPhrase(subjectValues);
  // Full Ref2VA output has a dedicated `subject_definitions` section where
  // these facts are expanded and mapped to Picture/Video tags.  Integrated
  // no-reference (and first/last-frame-only) output has no such section, so
  // carry the project-bible identity facts in the first Shot's subject anchor.
  // This is the point at which appearance continuity would otherwise vanish.
  const injectSubjectDefinitions = !manifest.assets.length || isH3KeyframeReferenceManifest(manifest);
  const subjectAnchor = injectSubjectDefinitions
    ? h3SubjectDefinitionAnchors(
        input.subjectDefinitions,
        subject,
        shots.map((shot) => [shot.subject, shot.action, shot.dialogue].filter(Boolean).join('；')).join('；'),
      )
    : '';
  const renderedSubject = subjectAnchor || subject;
  // Full Ref2VA stores each reference's own content once in its definition
  // or retention record. It must not leak into Shot 1 as a second prompt body.
  const fullReferenceWrapper = manifest.assets.length > 0 && !isH3KeyframeReferenceManifest(manifest);
  const references = manifest.assets.length && !fullReferenceWrapper
    ? manifest.assets.map((asset) => `${asset.token}（${asset.responsibility}）`).join('、')
    : '';
  const structuredAudio = h3StructuredAudioConstraints(input.constraints || []);
  const constraints = uniqueH3Texts(
    structuredAudio.remaining
      .filter((item) => !isH3InternalConstraint(item))
      .map((item) => stripAmbientBedFromAction(stripH3GlobalSpecs(item, input)))
  );

  let previousCut = 0;
  const renderedShots = shots.map((shot, index) => {
    const clauses = actionClausesFor(shot);
    const actionText = clauses.join('，随后') || '延续前镜动作';
    const entryState = stripH3GlobalSpecs(shot.entryState, input);
    const endState = stripH3GlobalSpecs(shot.endState, input);
    const direction = stripH3GlobalSpecs(shot.direction, input);
    // These describe the state at this cut. Gathering all shots' space/light
    // into Shot 1 would lose camera-side and blocking changes from later cuts.
    const scene = stripH3GlobalSpecs(shot.scene, input);
    const lighting = cleanH3VisualField(stripH3GlobalSpecs(shot.lighting, input));
    // Resolution/aspect-ratio words inside spoken dialogue are story text,
    // not redundant global parameters. Never strip or repunctuate a line.
    const dialogue = shot.dialogue.trim();
    // "台词：无" is an authored instruction, not an empty field. Dropping it
    // left indirect speech actions free to acquire invented lines/voices.
    const spokenLine = isSilent ? '台词：无（按用户静音设置）' : dialogue ? `台词：${dialogue}` : '';
    const sound = normalizeShotAmbientSound(
      h3SynchronizedShotSound(stripH3PresetSoundAnnotation(stripH3GlobalSpecs(shot.sound, input))),
    );
    const synchronizedSound = !isSilent && isAudibleValue(sound)
      ? `声音：${sound}`
      : '';
    const selectedVisibleDetails = (input.shotPrivateDetails || [])
      .filter((detail) => detail.shotIndex === index + 1 && clean(detail.description))
      .map((detail) => `本镜已确认可见外貌（不新增动作）：@${clean(detail.subjectName)}〔${clean(detail.description)}〕`);
    const actionDialogueAndSound = [
      entryState && `入镜状态：${entryState}`,
      direction && `朝向：${direction}`,
      ...selectedVisibleDetails,
      actionText, endState, spokenLine, synchronizedSound,
    ].filter(Boolean).join('；');
    const cameraText = stripH3GlobalSpecs(shot.camera, input);
    // A malformed/hand-edited canonical shot may omit its camera field.  The
    // official H3 contract still needs a composition cue for every Shot, so
    // use a neutral continuity cue instead of silently dropping the field.
    // This is a source transformation, not a validation gate, and it leaves
    // authored camera text untouched whenever one is present.
    const resolvedCameraText = cameraText || (index === 0 ? '保持当前构图' : '延续前镜构图');
    const parts = index === 0
      ? [
          renderedSubject && `主体：${renderedSubject}`,
          scene && `环境：${scene}`,
          lighting && `风格与光影：${lighting}`,
          references && `参考素材：${references}`,
          constraints.length && `约束：${constraints.join('；')}`,
          actionDialogueAndSound,
           `镜头：${resolvedCameraText}`
         ]
      : [scene && `环境：${scene}`, lighting && `风格与光影：${lighting}`, actionDialogueAndSound, `镜头：${resolvedCameraText}`];
    const description = parts.filter(Boolean).join('；');
    if (index === 0) return `[Shot 1] ${description}。`;
    const proposedCut = h3CutTime(shot, index, shots.length, input.durationSec);
    const minimumCut = previousCut + 0.001;
    const latestCut = Math.max(minimumCut, Math.max(0, input.durationSec) - (shots.length - index) * 0.001);
    const cut = Math.min(Math.max(proposedCut, minimumCut), latestCut);
    previousCut = cut;
    return `[Shot ${index + 1}] At ${formatH3Timestamp(cut)}, ${description}。`;
  });

  const explicitSoundscapes = [...new Set(structuredAudio.soundscapes)];
  const musicValues = uniqueH3Texts([
    ...shots.map((shot) => stripH3GlobalSpecs(shot.music, input)),
    ...structuredAudio.music,
  ]).filter(isAudibleValue);
  // N/A means no separately declared global bed, not that shot-local audio
  // should be erased. Explicit model/user prose (including N/A) is kept as
  // authored, with no local duration, distance or loudness reinterpretation.
  const soundscape = isSilent ? 'N/A' : explicitSoundscapes.join('；') || 'N/A';
  // Serialize explicit music without adding a second, contradictory mix plan.
  // The final AI review owns sound design and resolves any authored conflict.
  const music = isSilent ? 'N/A' : musicValues.join('；') || 'N/A';
  const core = [
    // Keep each Shot as a readable paragraph.  The official field remains a
    // single `integrated_multimodal_description` block, while blank lines make
    // cut points unambiguous in the UI and copied TXT without changing order.
    `integrated_multimodal_description: ${renderedShots.join('\n\n')}`,
    '',
    `overall_soundscape: ${soundscape}`,
    '',
    `non_diegetic_music: ${music}`
  ].join('\n');
  const prefix = h3ReferencePrefix(manifest, input.durationSec, shots.length);
  return prefix ? `${prefix}\n\n${core}` : core;
}

interface H3DetailedSubjectMapping {
  label: string;
  name: string;
  allowBareName: boolean;
}

const H3_QUOTE_CLOSER_BY_OPENER: Readonly<Record<string, string>> = {
  '"': '"',
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
};
const H3_UNICODE_TOKEN_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}]/u;
// Chinese does not expose reliable regex word boundaries. Permit an untagged
// multi-character name to touch only a small, explainable set of action starts;
// unknown noun continuations are left literal to avoid corrupting longer terms.
const H3_BARE_HAN_ACTION_CONTINUATION = /^(?:正在|开始|继续|最终|立即|突然|缓慢|快速|轻轻|猛然|悄然|将|把|向|朝|沿|从|对|注视|凝视|看向|望向|回望|转身|回头|抬头|抬手|低头|俯身|仰头|侧身|迈步|走|跑|冲|跃|跳|飞|落|停|站|坐|起身|蹲|跪|伏|伸|收|握|持|拔|抽|挥|劈|刺|挡|格|推|拉|打开|关闭|抓|放|抛|扔|举|踢|踩|踏|撞|击|触|扶|绕|穿|进入|退出|退到|后退|前进|离开|靠近|贴近|逼近|追|躲|闪|翻|滚|旋|颤|呼吸|喊|说|问|答|笑|哭|点头|摇头|额角|双脚|左脚|右脚|左手|右手|双手|手臂|眼睛|头部|身体|尾部|足爪|的)/u;

function h3CharacterAt(value: string, index: number): string {
  return value.slice(index).match(/^[\s\S]/u)?.[0] || '';
}

function h3CharacterBefore(value: string, index: number): string {
  return value.slice(0, index).match(/[\s\S]$/u)?.[0] || '';
}

function isEscapedH3Quote(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function hasH3SubjectLeftBoundary(value: string, start: number): boolean {
  return !H3_UNICODE_TOKEN_CHARACTER.test(h3CharacterBefore(value, start))
    // Normal H3 rendering inserts this connector between authored action
    // clauses. Its leading comma is the actual token boundary even though the
    // connective itself touches the following subject in the delivery text.
    || value.slice(Math.max(0, start - 3), start) === '，随后';
}

function hasH3UnicodeTokenBoundary(value: string, start: number, end: number): boolean {
  return hasH3SubjectLeftBoundary(value, start)
    && !H3_UNICODE_TOKEN_CHARACTER.test(h3CharacterAt(value, end));
}

function isH3StructuredBareSubject(value: string, start: number, end: number): boolean {
  const fieldPrefix = value.slice(Math.max(0, start - 96), start);
  return /(?:主体|人物|角色|对象|朝向|发言者|说话者|speaker)\s*[：:][^；;\n]*$/iu.test(fieldPrefix)
    && hasH3SubjectLeftBoundary(value, start)
    && !H3_UNICODE_TOKEN_CHARACTER.test(h3CharacterAt(value, end));
}

function canReplaceH3BareSubject(
  value: string,
  start: number,
  subject: H3DetailedSubjectMapping,
): boolean {
  if (!subject.allowBareName) return false;
  const end = start + subject.name.length;
  if (/^\p{Script=Han}+$/u.test(subject.name)) {
    if (Array.from(subject.name).length === 1) return isH3StructuredBareSubject(value, start, end);
    // Chinese names commonly begin an action clause and touch the following
    // verb directly. Require both a clause boundary and a known action start;
    // noun continuations such as “无名主角版本” remain untouched.
    if (!hasH3SubjectLeftBoundary(value, start)) return false;
    if (!H3_UNICODE_TOKEN_CHARACTER.test(h3CharacterAt(value, end))) return true;
    return H3_BARE_HAN_ACTION_CONTINUATION.test(value.slice(end));
  }
  return hasH3UnicodeTokenBoundary(value, start, end);
}

function canReplaceH3ExplicitSubject(value: string, start: number, subject: H3DetailedSubjectMapping): boolean {
  if (/^\p{Script=Han}+$/u.test(subject.name)) return true;
  const end = start + subject.name.length;
  return !H3_UNICODE_TOKEN_CHARACTER.test(h3CharacterAt(value, end));
}

/**
 * Bind full-reference subject names without rewriting authored prose. The
 * scanner deliberately emits labels only once and never scans emitted labels
 * again, so a later subject name cannot mutate an earlier replacement.
 */
function bindH3DetailedSubjectMentions(
  value: string,
  subjects: readonly H3DetailedSubjectMapping[],
): string {
  const orderedSubjects = [...subjects]
    .filter((subject) => subject.name)
    .sort((left, right) => right.name.length - left.name.length);
  let result = '';
  let quoteCloser = '';
  let index = 0;
  while (index < value.length) {
    const character = h3CharacterAt(value, index);
    if (quoteCloser) {
      const recoversKnownField = /[；;]/u.test(character)
        && isH3KnownFieldSeparator(value, index)
        && !hasH3QuoteCloserAfter(value, index + character.length, quoteCloser);
      if (recoversKnownField) {
        quoteCloser = '';
        result += character;
        index += character.length;
        continue;
      }
      result += character;
      if (character === quoteCloser && !isEscapedH3Quote(value, index)) quoteCloser = '';
      index += character.length;
      continue;
    }
    const openingQuoteCloser = H3_QUOTE_CLOSER_BY_OPENER[character];
    if (openingQuoteCloser) {
      quoteCloser = openingQuoteCloser;
      result += character;
      index += character.length;
      continue;
    }
    if (character === '@') {
      const nameStart = index + character.length;
      const explicitSubject = orderedSubjects.find((subject) => (
        value.startsWith(subject.name, nameStart)
        && canReplaceH3ExplicitSubject(value, nameStart, subject)
      ));
      if (explicitSubject) {
        result += explicitSubject.label;
        index = nameStart + explicitSubject.name.length;
        continue;
      }
    }
    const bareSubject = orderedSubjects.find((subject) => (
      value.startsWith(subject.name, index)
      && canReplaceH3BareSubject(value, index, subject)
    ));
    if (bareSubject) {
      result += bareSubject.label;
      index += bareSubject.name.length;
      continue;
    }
    result += character;
    index += character.length;
  }
  return result;
}

function renderMinimaxH3FullReference(
  basePrompt: string,
  input: PromptAdapterInput,
  manifest: ReferenceManifest
): string {
  let subjectIndex = 0;
  const assetById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const coveredVisualAssetIds = new Set<string>();
  const semanticSubjects = (input.subjectDefinitions || []).map((definition) => {
    const referencedAssets = uniqueH3Texts(definition.referenceAssetIds || [])
      .map((id) => assetById.get(id))
      .filter((asset): asset is ReferenceManifestEntry => Boolean(asset && asset.mediaType !== 'audio'));
    referencedAssets.forEach((asset) => coveredVisualAssetIds.add(asset.id));
    const description = uniqueH3Texts([
      clean(definition.description),
      clean(definition.formLabel) ? `形态：${clean(definition.formLabel)}` : '',
      clean(definition.baseName) ? `同源人物：${clean(definition.baseName)}` : '',
      clean(definition.transformationType) ? `转化类型：${clean(definition.transformationType)}` : '',
      clean(definition.gender),
      clean(definition.race),
      clean(definition.morphology),
      clean(definition.bodyPlan),
      clean(definition.appearance),
      clean(definition.outfit),
      clean(definition.wardrobeBaseline)
        ? `衣橱基底（不是本镜着装指令）：${clean(definition.wardrobeBaseline)}；本镜衣着以已确认入口和逐镜状态为准，未涉及的衣物保持原状`
        : '',
      clean(definition.anchor),
      clean(definition.motion),
    ]).join('；');
    return {
      label: `<Subject ${subjectIndex += 1}>`,
      name: clean(definition.name).replace(/^@/u, '') || '未命名主体',
      kind: clean(definition.kind),
      description,
      referenceTokens: referencedAssets.map((asset) => asset.token),
      allowBareName: true,
    };
  });
  const fallbackSubjects = manifest.assets
    .filter((asset) => asset.mediaType !== 'audio' && !coveredVisualAssetIds.has(asset.id))
    .map((asset) => ({
      label: `<Subject ${subjectIndex += 1}>`,
      name: asset.name,
      kind: asset.role,
      description: asset.responsibility,
      referenceTokens: [asset.token],
      allowBareName: Array.from(asset.name).length > 1,
    }));
  const mappedSubjects = [...semanticSubjects, ...fallbackSubjects];
  const audioAssets = manifest.assets.filter((asset) => asset.mediaType === 'audio');
  const definitions = [
    ...mappedSubjects.map((subject) => {
      const source = subject.referenceTokens.length
        ? ` referenced from ${subject.referenceTokens.join('、')}`
        : ' defined by the canonical prompt';
      const details = [subject.kind, subject.description].filter(Boolean).join('；') || '保持身份与外观一致';
      return `${subject.label} is ${subject.name}${source}: ${details}.`;
    }),
    ...audioAssets.map((asset) => `${asset.token} is the referenced audio source: ${asset.responsibility}.`),
  ];
  const subjectLabels = mappedSubjects.map((subject) => subject.label);
  const audioLabels = audioAssets.map((asset) => asset.token);
  const summaryLabels = [...subjectLabels, ...audioLabels].join('、');
  // Shot paragraphs are intentionally separated by blank lines for readable
  // delivery.  Do not split the prompt into blank-line blocks here: doing so
  // would keep only Shot 1 when the full-reference renderer searches for the
  // block that starts with `integrated_multimodal_description:`.  Capture the
  // whole section up to the next official field instead.
  const baseSections = h3TopLevelSections(basePrompt);
  const integrated = baseSections.find((section) => section.name === 'integrated_multimodal_description')?.value || '';
  const soundscape = baseSections.find((section) => section.name === 'overall_soundscape')?.raw || 'overall_soundscape: N/A';
  const music = baseSections.find((section) => section.name === 'non_diegetic_music')?.raw || 'non_diegetic_music: N/A';
  const detailed = bindH3DetailedSubjectMentions(
    integrated,
    mappedSubjects,
  );
  const detailedShots = Array.from(
    detailed.matchAll(/\[Shot\s+(\d+)\]([\s\S]*?)(?=\[Shot\s+\d+\]|$)/gu),
    (match) => ({ index: Number(match[1]), body: match[0] }),
  );
  const retention = [
    ...mappedSubjects.map((subject) => {
      const appearances = detailedShots
        .filter((shot) => shot.body.includes(subject.label))
        .map((shot) => shot.index);
      const appearance = appearances.length
        ? `appears in ${appearances.map((index) => `[Shot ${index}]`).join('、')}`
        : 'defined for visual consistency';
      const source = subject.referenceTokens.length ? `；reference ${subject.referenceTokens.join('、')}` : '';
      // The full identity bible already lives in subject_definitions. Keep
      // this preservation/appearance map lossless by referencing that exact
      // definition instead of duplicating its potentially long description.
      return `${subject.label} (${appearance}): fully_preserved - ${subject.name}${source}；完整身份、外观与设定沿用 subject_definitions 中 ${subject.label}.`;
    }),
    ...audioAssets.map((asset) => `${asset.token}: reference - ${asset.responsibility}.`),
    // Several subjects may share one composite picture, and one subject may
    // use several pictures. Preserve the picture's unique composition once,
    // rather than turning it into an extra identity or copying it per person.
    ...manifest.assets
      .filter((asset) => asset.mediaType !== 'audio' && coveredVisualAssetIds.has(asset.id))
      .map((asset) => `${asset.token}: ${asset.role} reference - ${asset.responsibility}.`),
  ];
  return [
    'subject_definitions:',
    ...definitions,
    '',
    'summary:',
    `[reference generation] ${formatDuration(input.durationSec)}秒目标视频使用 ${summaryLabels || '所提供参考素材'} 完成动作与场景生成。`,
    '',
    'retention_analysis:',
    ...retention,
    '',
    'detailed_description:',
    detailed,
    '',
    soundscape,
    '',
    music
  ].join('\n');
}

function buildMinimaxH3Prompt(input: PromptAdapterInput, manifest: ReferenceManifest): string {
  const shots = parseH3CanonicalPrompt(input.canonicalPrompt, input.durationSec);
  // Character count is informational, not a local eligibility or rendering
  // budget. Render all authored clauses once without lower-detail candidates.
  const basePrompt = renderMinimaxH3Prompt(input, shots, manifest);
  return manifest.assets.length && !isH3KeyframeReferenceManifest(manifest)
    ? renderMinimaxH3FullReference(basePrompt, input, manifest)
    : basePrompt;
}

function buildParameters(input: PromptAdapterInput, profile: ModelProfile): TargetParameters {
  const durationSec = Number.isFinite(input.durationSec) && input.durationSec > 0 ? input.durationSec : 0;
  const aspectRatio = clean(input.aspectRatio) || 'unknown';
  const resolution = clean(input.resolution) || 'unknown';
  const audioMode = clean(input.audioMode) || 'unknown';
  const parameters: TargetParameters = {
    model: profile.id,
    durationSec,
    aspectRatio,
    resolution,
    audioMode
  };
  const hints = profile.parameterHints;
  if (hints.duration === 'seconds') parameters.seconds = formatDuration(durationSec);
  else if (hints.duration) parameters.duration = durationSec;
  if (hints.aspectRatio === 'size' || hints.resolution === 'size') parameters.size = resolution;
  if (profile.id === 'veo-3.1') parameters.generateAudio = audioMode !== 'none' && audioMode !== 'silent';
  if (profile.id === 'sora-2') {
    // The API's `size` is a pixel string; preserve a caller-provided pixel
    // value and leave symbolic resolutions for the integration layer to map.
    parameters.size = soraSize(aspectRatio, resolution);
  }
  return parameters;
}

function soraSize(aspectRatio: string, resolution: string): string {
  if (/^\d+x\d+$/u.test(resolution)) return resolution;
  const normalized = aspectRatio.trim();
  if (normalized === '9:16') {
    if (/^1080p$/iu.test(resolution) || /^2k$/iu.test(resolution)) return '1080x1920';
    return '720x1280';
  }
  if (normalized === '16:9') {
    if (/^1080p$/iu.test(resolution) || /^2k$/iu.test(resolution)) return '1920x1080';
    return '1280x720';
  }
  return resolution;
}

function buildManifest(profile: ModelProfile, references: readonly NormalizedReference[]): ReferenceManifest {
  const assets = references.map((reference, i): ReferenceManifestEntry => {
    const index = i + 1;
    return {
      index,
      id: reference.id,
      name: reference.name,
      mediaType: reference.mediaType,
      role: reference.role,
      token: tokenFor(profile, reference.mediaType, tokenIndexByMediaType(references, i), reference.name),
      responsibility: reference.responsibility,
      source: reference.source,
      durationSec: reference.durationSec,
      width: reference.width,
      height: reference.height,
      aspectRatio: reference.aspectRatio,
      targetBindings: reference.targetBindings,
      label: `${reference.name} · ${reference.role}`
    };
  });
  const counts: Partial<Record<ReferenceMediaType, number>> = {};
  const roleCounts: Partial<Record<ReferenceRole, number>> = {};
  for (const item of assets) {
    counts[item.mediaType] = (counts[item.mediaType] || 0) + 1;
    roleCounts[item.role] = (roleCounts[item.role] || 0) + 1;
  }
  const text = assets.length
    ? assets.map((item) => `${item.token}：${item.responsibility}${item.targetBindings.length ? `（绑定：${item.targetBindings.join('、')}）` : ''}`).join('\n')
    : '无参考素材';
  return { targetId: profile.id, assets, entries: assets, items: assets, counts, byMediaType: counts, roleCounts, byRole: roleCounts, text };
}

function checkCapabilities(
  input: PromptAdapterInput,
  profile: ModelProfile,
  refs: readonly NormalizedReference[],
  warnings: string[]
): void {
  const capabilities = profile.capabilities;
  const duration = input.durationSec;
  const validDuration = Number.isFinite(duration) && duration > 0;
  if (!validDuration) {
    pushWarning(warnings, '时长必须是大于 0 的数字；当前参数无法直接提交。');
  } else {
    const durationRule = capabilities.duration;
    if (durationRule.allowedSec && !durationRule.allowedSec.includes(duration)) {
      pushWarning(warnings, `${profile.name}公开支持的片段时长为 ${durationRule.allowedSec.join('、')} 秒，当前 ${formatDuration(duration)} 秒需在目标入口确认或拆镜。`);
    } else if (durationRule.maxSec !== undefined && duration > durationRule.maxSec) {
      pushWarning(warnings, `${profile.name}公开单次时长上限约为 ${durationRule.maxSec} 秒，当前 ${formatDuration(duration)} 秒建议拆分或延展。`);
    } else if (durationRule.minSec !== undefined && duration < durationRule.minSec) {
      pushWarning(warnings, `${profile.name}公开单次时长下限约为 ${durationRule.minSec} 秒，当前时长可能无法提交。`);
    } else if (durationRule.status === 'unknown') {
      pushWarning(warnings, `${profile.name}的单次时长限制未在档案中确认，请以实际 API/网页入口为准。`);
    }
  }

  if (capabilities.supportedAspectRatios && input.aspectRatio && !capabilities.supportedAspectRatios.includes(input.aspectRatio)) {
    pushWarning(warnings, `${profile.name}公开画幅为 ${capabilities.supportedAspectRatios.join('、')}，当前 ${input.aspectRatio} 需核验。`);
  }
  if (capabilities.supportedResolutions && input.resolution && !capabilities.supportedResolutions.includes(input.resolution)) {
    pushWarning(warnings, `${profile.name}公开分辨率为 ${capabilities.supportedResolutions.join('、')}，当前 ${input.resolution} 需核验。`);
  }
  if (input.audioMode && input.audioMode !== 'none' && input.audioMode !== 'silent') {
    if (capabilities.nativeAudio === 'unsupported') pushWarning(warnings, `${profile.name}档案标记为不支持原生音频；请改为后期配音/音效。`);
    if (capabilities.nativeAudio === 'unknown') pushWarning(warnings, `${profile.name}是否支持原生音频尚未确认；当前音频要求会保留在交付说明中。`);
  }

  const counts: Partial<Record<ReferenceMediaType, number>> = {};
  const roleCounts: Partial<Record<ReferenceRole, number>> = {};
  const durationTotals: Partial<Record<ReferenceMediaType, number>> = {};
  for (const ref of refs) {
    counts[ref.mediaType] = (counts[ref.mediaType] || 0) + 1;
    roleCounts[ref.role] = (roleCounts[ref.role] || 0) + 1;
    if (ref.durationSec !== undefined) durationTotals[ref.mediaType] = (durationTotals[ref.mediaType] || 0) + ref.durationSec;
    const modalityStatus = capabilities.inputModalities[ref.mediaType];
    if (modalityStatus === 'unsupported') pushWarning(warnings, `${profile.name}不支持 ${ref.mediaType} 参考：${ref.name}。`);
    else if (modalityStatus === 'unknown') pushWarning(warnings, `${profile.name}是否支持 ${ref.mediaType} 参考尚未确认：${ref.name}。`);
    if (!capabilities.referenceRoles.includes(ref.role) && ref.role !== 'general') {
      pushWarning(warnings, `${profile.name}档案未声明 ${ref.role} 参考职责；已保留该职责，但请在目标入口核验。`);
    }
    if (ref.role === 'first-frame' || ref.role === 'last-frame') {
      if (capabilities.firstLastFrame === 'unsupported') pushWarning(warnings, `${profile.name}不支持首帧/尾帧职责：${ref.name}。`);
      else if (capabilities.firstLastFrame === 'unknown') pushWarning(warnings, `${profile.name}首帧/尾帧能力尚未确认：${ref.name}。`);
    }
    const referenceRule = capabilities.referenceDurationByRole?.[ref.role];
    if (referenceRule?.maxSec !== undefined && ref.durationSec !== undefined && ref.durationSec > referenceRule.maxSec) {
      pushWarning(warnings, `${profile.name}${ref.role}参考 ${ref.name} 时长 ${formatDuration(ref.durationSec)} 秒超过公开约 ${referenceRule.maxSec} 秒的建议范围。`);
    }
    if (referenceRule?.minSec !== undefined && ref.durationSec !== undefined && ref.durationSec < referenceRule.minSec) {
      pushWarning(warnings, `${profile.name}${ref.role}参考 ${ref.name} 时长短于公开约 ${referenceRule.minSec} 秒的建议范围。`);
    }
    const mediaDurationRule = capabilities.referenceDurationByMediaType?.[ref.mediaType];
    if (mediaDurationRule?.maxSec !== undefined && ref.durationSec !== undefined && ref.durationSec > mediaDurationRule.maxSec) {
      pushWarning(warnings, `${profile.name}${ref.mediaType}参考 ${ref.name} 单段时长 ${formatDuration(ref.durationSec)} 秒超过公开上限 ${mediaDurationRule.maxSec} 秒。`);
    }
    if (mediaDurationRule?.minSec !== undefined && ref.durationSec !== undefined && ref.durationSec < mediaDurationRule.minSec) {
      pushWarning(warnings, `${profile.name}${ref.mediaType}参考 ${ref.name} 单段时长 ${formatDuration(ref.durationSec)} 秒短于公开下限 ${mediaDurationRule.minSec} 秒。`);
    }
  }
  if (capabilities.maxReferencesTotal !== undefined && refs.length > capabilities.maxReferencesTotal) {
    pushWarning(warnings, `${profile.name}参考素材总数最多约 ${capabilities.maxReferencesTotal} 个，当前已提供 ${refs.length} 个。`);
  }
  for (const role of ROLES) {
    const limit = capabilities.maxReferencesByRole?.[role];
    if (limit !== undefined && (roleCounts[role] || 0) > limit) {
      pushWarning(warnings, `${profile.name}${role}参考最多约 ${limit} 个，当前已提供 ${roleCounts[role]} 个。`);
    }
  }
  for (const mediaType of MEDIA_TYPES) {
    const limit = capabilities.maxReferences?.[mediaType];
    if (limit !== undefined && (counts[mediaType] || 0) > limit) {
      pushWarning(warnings, `${profile.name}${mediaType}参考最多约 ${limit} 个，当前已提供 ${counts[mediaType]} 个。`);
    }
    const durationLimit = capabilities.maxReferenceDurationTotalSec?.[mediaType];
    const durationTotal = durationTotals[mediaType] || 0;
    if (durationLimit !== undefined && durationTotal > durationLimit) {
      pushWarning(warnings, `${profile.name}${mediaType}参考总时长 ${formatDuration(durationTotal)} 秒超过公开上限 ${durationLimit} 秒。`);
    }
  }
}

function buildPrompt(
  input: PromptAdapterInput,
  profile: ModelProfile,
  manifest: ReferenceManifest,
  detail: 'concise' | 'director'
): string {
  if (profile.id === 'minimax-h3') return buildMinimaxH3Prompt(input, manifest);
  const canonical = clean(input.canonicalPrompt) || '（未提供 canonical prompt）';
  const params = `duration=${formatDuration(input.durationSec)}s; aspectRatio=${clean(input.aspectRatio) || 'unknown'}; resolution=${clean(input.resolution) || 'unknown'}; audio=${clean(input.audioMode) || 'unknown'}`;
  const constraints = (input.constraints || []).map(clean).filter(Boolean);
  if (detail === 'concise') {
    const refs = manifest.assets.length ? `\nReferences: ${manifest.assets.map((item) => `${item.token}=${item.responsibility}`).join('; ')}` : '';
    const guardrails = constraints.length ? `\nConstraints: ${constraints.join('; ')}` : '';
    return `${canonical}\n[${profile.name} | ${params}]${refs}${guardrails}`;
  }
  const referenceLines = manifest.assets.length
    ? manifest.assets.map((item) => `- ${item.token}（${item.role}）：${item.responsibility}${item.targetBindings.length ? `；绑定 ${item.targetBindings.join('、')}` : ''}`).join('\n')
    : '- 无参考素材';
  return [
    canonical,
    '',
    `Target: ${profile.name}`,
    `Delivery parameters (set these in the target API/UI; prose does not override them): ${params}`,
    'Reference responsibilities:',
    referenceLines,
    ...(constraints.length ? ['Canonical constraints:', ...constraints.map((item) => `- ${item}`)] : []),
    'Preserve the canonical shot order, subject identity, continuity, and requested camera/action beats.'
  ].join('\n');
}

/**
 * Compile the app's canonical six-field timeline prompt for one target model.
 * This is pure and deterministic: no network calls, mutation, or model guess.
 */
export function compileTargetPrompt(input: PromptAdapterInput): CompiledTargetPrompt {
  const requestedTarget = clean(input.targetId) || 'unknown';
  const profile = resolveModelProfile(requestedTarget);
  const targetId = profile.id === 'unknown' ? requestedTarget : profile.id;
  const inputConstraints = input.constraints || [];
  const nsfwDetail = input.nsfwDetail
    ?? hasNsfwDetailSignal(input.canonicalPrompt, ...inputConstraints);
  const sanitizedCanonicalPrompt = sanitizeLegacyNsfwPromptLeak(input.canonicalPrompt);
  const sanitizedInputConstraints = inputConstraints
    .map(sanitizeLegacyNsfwPromptLeak)
    .filter(Boolean);
  const normalizedInput: PromptAdapterInput = {
    ...input,
    canonicalPrompt: sanitizedCanonicalPrompt,
    targetId,
    references: input.references || [],
    constraints: sanitizeNsfwAutomaticConstraints(sanitizedInputConstraints, nsfwDetail),
  };
  const refs = (normalizedInput.references || []).map(normalizeReference);
  const manifestBase = buildManifest(profile, refs);
  const manifest: ReferenceManifest = { ...manifestBase, targetId };
  const warnings: string[] = [];
  if (!getModelProfile(requestedTarget)) pushWarning(warnings, `未登记目标模型“${requestedTarget}”，已使用保守的未知能力档案；请核验所有参数。`);
  checkCapabilities(normalizedInput, profile, refs, warnings);
  const detail = detailModeOf(input.detailMode, profile);
  const prompt = buildPrompt(normalizedInput, profile, manifest, detail);
  return {
    targetId,
    prompt,
    parameters: buildParameters(normalizedInput, profile),
    referenceManifest: manifest,
    warnings
  };
}

export const adaptPromptForTarget = compileTargetPrompt;
export const compileForTarget = compileTargetPrompt;
export const compileTarget = compileTargetPrompt;

export function listModelProfiles(): readonly ModelProfile[] {
  return Object.values(MODEL_PROFILES);
}
