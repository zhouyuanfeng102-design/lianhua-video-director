/**
 * Pure storyboard continuity checks used by the 0.3 workflow planner.
 *
 * The application has a deliberately small canonical `VideoShot` shape.  The
 * types in this file are structural and only add optional metadata, so a
 * normal `Storyboard` can be passed directly while integrations may provide
 * scene, anchor, prop, dialogue, and media metadata when available.
 */

export type ContinuitySeverity = 'error' | 'warning' | 'info';

/**
 * Optional, source-grounded body facts that stay stable for one character.
 *
 * The deliberately neutral free-text shape works for people of any gender or
 * anatomy.  It is never synthesized for ordinary characters: callers only
 * persist it when the source explicitly supplies a reusable detail or an
 * existing multi-shot sequence needs that detail to remain stable.
 */
export interface NsfwBodyAnchors {
  stableTraits: string[];
  sourceEvidence?: string;
}

/** Temporary visible state for one shot, kept separate from stable anatomy. */
export interface NsfwShotContinuityState {
  nudity?: string;
  clothingState?: string;
  contact?: string;
  actionStage?: string;
  residue?: string;
}

export type NsfwClothingTransitionKind = 'removal' | 'redress';

export interface ContinuityShotLike {
  id: string;
  index?: number;
  startSec: number;
  endSec: number;
  purpose?: string;
  subject?: string;
  action?: string;
  camera?: string;
  transition?: string;
  lighting?: string;
  sound?: string;
  result?: string;
  prompt?: string;
  referenceAssetIds?: readonly string[];
  scene?: string;
  sceneId?: string;
  location?: string;
  locationId?: string;
  subjectId?: string;
  characterId?: string;
  characterIds?: readonly string[];
  appearanceAnchor?: string;
  visualAnchor?: string;
  continuityAnchor?: string;
  appearance?: string;
  outfit?: string;
  clothing?: string;
  /** Optional current-shot state; absent on ordinary and legacy shots. */
  nsfwContinuity?: NsfwShotContinuityState;
  propStates?: Readonly<Record<string, string>>;
  props?: readonly string[];
  propIds?: readonly string[];
  dialogue?: string;
  dialogueText?: string;
  dialogueStartSec?: number;
  dialogueDurationSec?: number;
  axis?: string;
  motionDirection?: string;
  colorTemperatureK?: number;
  /** Optional pre-computed risk score consumed by generationPlan. */
  riskScore?: number;
}

export interface ContinuityStoryboardLike {
  durationSec?: number;
  shots: readonly ContinuityShotLike[];
  assets?: readonly ContinuityAssetLike[];
}

export interface ContinuityAssetLike {
  id: string;
  type?: string;
  role?: string;
  mediaType?: string;
  duration?: number;
}

export interface ContinuityEntityLike {
  id?: string;
  name: string;
  appearance?: string;
  outfit?: string;
  clothing?: string;
  anchor?: string;
  visualAnchor?: string;
  stateRules?: string;
}

export interface ContinuityReferenceLimits {
  targetId?: string;
  maxReferencesPerShot?: number;
  /** Alias accepted by model profiles. */
  maxReferences?: number;
  maxTotalReferences?: number;
  maxImageReferencesPerShot?: number;
  maxVideoReferencesPerShot?: number;
  maxAudioReferencesPerShot?: number;
  maxClayRenderReferencesPerShot?: number;
  supportedMediaTypes?: readonly string[];
}

export interface ContinuityOptions {
  toleranceSec?: number;
  dialogueCharsPerSec?: number;
  dialogueLeadTailSec?: number;
  lightingJumpKelvin?: number;
  requireAnchorEveryShot?: boolean;
  characters?: readonly ContinuityEntityLike[];
  locations?: readonly ContinuityEntityLike[];
  props?: readonly ContinuityEntityLike[];
  assets?: readonly ContinuityAssetLike[];
  /** All three names are supported so this module can consume a model profile directly. */
  target?: ContinuityReferenceLimits;
  targetLimits?: ContinuityReferenceLimits;
  referenceLimits?: ContinuityReferenceLimits;
}

export interface ContinuityIssue {
  id: string;
  code:
    | 'invalid-range'
    | 'time-gap'
    | 'time-overlap'
    | 'duration-mismatch'
    | 'subject-change'
    | 'appearance-anchor-change'
    | 'appearance-anchor-missing'
    | 'nsfw-nudity-state-change'
    | 'nsfw-contact-state-change'
    | 'nsfw-action-stage-regression'
    | 'nsfw-residue-state-change'
    | 'scene-jump'
    | 'prop-state-change'
    | 'lighting-jump'
    | 'axis-conflict'
    | 'dialogue-overflow'
    | 'dialogue-offset-overflow'
    | 'reference-missing'
    | 'reference-limit'
    | 'reference-type-unsupported';
  severity: ContinuitySeverity;
  message: string;
  shotIds: string[];
  details?: Readonly<Record<string, unknown>>;
  /** Optional legacy display metadata retained when older projects are loaded. */
  category?: string;
  suggestion?: string;
}

export interface ContinuityStats {
  shotCount: number;
  totalDurationSec: number;
  dialogueShotCount: number;
  referenceCount: number;
  uniqueReferenceCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
}

export interface ContinuityReport {
  valid: boolean;
  score: number;
  issues: ContinuityIssue[];
  /** Absent on legacy persisted reports created before detailed statistics. */
  stats?: ContinuityStats;
  /** Set when a live report is persisted on a storyboard. */
  checkedAt?: number;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' ? value as UnknownRecord : {}
);

const readValue = (shot: ContinuityShotLike, key: string): unknown => asRecord(shot)[key];

const readString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const firstString = (shot: ContinuityShotLike, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = readString(readValue(shot, key));
    if (value) return value;
  }
  return '';
};

const normalize = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\u3000]+/gu, '')
  .replace(/[，。！？、；：,.!?;:"'“”‘’「」『』()（）\[\]{}<>《》|/\\_-]+/gu, '');

const labelOf = (value: string): string => {
  const text = value.replace(/^@/u, '').trim();
  // Subject and scene fields occasionally contain a parenthetical description.
  return text.split(/[（(；;，,:：|/\\]/u)[0]?.trim() || text;
};

const subjectKeyOf = (shot: ContinuityShotLike): string => {
  const id = firstString(shot, ['subjectId', 'characterId']);
  if (id) return normalize(id);
  const names = readValue(shot, 'characterIds');
  if (Array.isArray(names) && names.length > 0) return normalize(readString(names[0]));
  return normalize(labelOf(firstString(shot, ['subject'])));
};

interface NsfwSubjectIdentity {
  key: string;
  label: string;
}

const genericNsfwSubject = /^(?:环境主体|剧情主体|当前场景|环境|场景|人物|角色|主体)$/u;

/** Keep only the performer name when a free-text subject also describes
 * placement (for example “阿莲与青竹同时位于卧室”).  Without this boundary,
 * the second label never appears verbatim in the action and both performers
 * collapse back into one shared wardrobe state. */
const nsfwSubjectLabelOf = (value: string): string => {
  const label = labelOf(value).replace(/^@/u, '').trim();
  const positioned = label.match(
    /^(.{1,32}?)(?:(?:两人|二人)?(?:同时|分别|一起|一同|均|都|各自)?\s*(?:位于|站在|坐在|躺在|跪在|靠在|处于|出现在|走入|走进|进入|来到|停在|留在)|(?:两人|二人)?(?:同时|分别|一起|一同|均|都|各自)$)/u,
  )?.[1]?.trim();
  return positioned || label;
};

/**
 * Resolve every explicitly named performer in a shot. VideoShot historically
 * stored one free-text `subject`, so multi-person shots must not collapse to
 * the first name and accidentally share one person's wardrobe with everyone.
 */
const nsfwSubjectIdentitiesOf = (shot: ContinuityShotLike): NsfwSubjectIdentity[] => {
  const rawSubject = firstString(shot, ['subject'])
    .replace(/^@/u, '')
    .replace(/[（(][\s\S]*$/u, '')
    .trim();
  const labels = rawSubject
    .split(/\s*(?:与|和|及|跟|、|&|\/|\\)\s*/u)
    .map(nsfwSubjectLabelOf)
    .filter((value) => value && !genericNsfwSubject.test(value));
  const explicitId = firstString(shot, ['subjectId', 'characterId']);
  if (explicitId) {
    const label = labels[0] || labelOf(rawSubject) || explicitId;
    return [{ key: normalize(explicitId), label }];
  }
  const rawIds = readValue(shot, 'characterIds');
  const ids = Array.isArray(rawIds)
    ? rawIds.map(readString).filter(Boolean)
    : [];
  if (ids.length) {
    return ids.map((id, index) => ({
      key: normalize(id),
      label: labels.length === ids.length ? labels[index] : (labels[index] || id),
    })).filter((item) => item.key);
  }
  const seen = new Set<string>();
  return labels.flatMap((label) => {
    const key = normalize(label);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ key, label }];
  });
};

const sceneKeyOf = (shot: ContinuityShotLike): string => {
  const id = firstString(shot, ['sceneId', 'locationId']);
  if (id) return normalize(id);
  return normalize(labelOf(firstString(shot, ['scene', 'location'])));
};

const transitionAllowsBreak = (left: ContinuityShotLike, right: ContinuityShotLike): boolean => {
  const explicit = `${left.transition || ''} ${right.transition || ''}`;
  if (/(?:切换|转场|跳转|切至|场景变换|蒙太奇|硬切|淡入|淡出|cut|dissolve|wipe|new\s+scene|fade)/iu.test(explicit)) return true;
  // Only accept an explicit scene-change phrase in narrative fields.  A plain
  // occurrence of “场景” is intentionally not enough to suppress a warning.
  const context = `${left.purpose || ''} ${right.purpose || ''}`;
  return /(?:场景切换|来到另一处|转到另一处|地点改变|time\s*jump|location\s*change)/iu.test(context);
};

const anchorOf = (shot: ContinuityShotLike): string => firstString(shot, [
  'appearanceAnchor', 'continuityAnchor', 'visualAnchor', 'appearance', 'outfit', 'clothing'
]);

const entityAnchor = (subject: string, entities: readonly ContinuityEntityLike[] | undefined): string => {
  if (!subject || !entities) return '';
  const key = normalize(labelOf(subject));
  const entity = entities.find((item) => {
    const name = normalize(item.name);
    return name && (name === key || key.includes(name) || name.includes(key));
  });
  if (!entity) return '';
  return [entity.anchor, entity.visualAnchor, entity.appearance, entity.outfit, entity.clothing]
    .map(readString).find(Boolean) || '';
};

const anchorTokens = (value: string): Set<string> => {
  const matches = value.toLocaleLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/giu) || [];
  return new Set(matches.map(normalize).filter(Boolean));
};

const anchorSimilarity = (left: string, right: string): number => {
  const a = anchorTokens(left);
  const b = anchorTokens(right);
  if (!a.size && !b.size) return normalize(left) === normalize(right) ? 1 : 0;
  let intersection = 0;
  a.forEach((token) => { if (b.has(token)) intersection += 1; });
  return intersection / Math.max(1, new Set([...a, ...b]).size);
};

const propStateMap = (shot: ContinuityShotLike): Map<string, string> => {
  const result = new Map<string, string>();
  const states = readValue(shot, 'propStates');
  if (states && typeof states === 'object' && !Array.isArray(states)) {
    Object.entries(states as UnknownRecord).forEach(([name, state]) => {
      const key = normalize(name);
      if (key) result.set(key, readString(state));
    });
  }
  const props = readValue(shot, 'props');
  if (Array.isArray(props)) {
    props.forEach((value) => {
      const text = readString(value);
      if (!text) return;
      const parts = text.split(/\s*(?:[:：=]|->|→)\s*/u);
      const key = normalize(parts[0]);
      if (key) result.set(key, parts.slice(1).join(':').trim());
    });
  }
  const propIds = readValue(shot, 'propIds');
  if (Array.isArray(propIds)) {
    propIds.forEach((value) => {
      const key = normalize(readString(value));
      if (key && !result.has(key)) result.set(key, '');
    });
  }
  return result;
};

const temperatureOf = (shot: ContinuityShotLike): number | undefined => {
  const explicit = readValue(shot, 'colorTemperatureK');
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const text = firstString(shot, ['lighting']);
  const match = text.match(/(\d{3,5})\s*[kK]/u);
  return match ? Number(match[1]) : undefined;
};

type LightFamily = 'warm' | 'cool' | 'neutral' | undefined;

const lightFamilyOf = (shot: ContinuityShotLike): LightFamily => {
  const text = firstString(shot, ['lighting']).toLocaleLowerCase();
  if (/(?:暖|橙|黄|金|红|warm|amber|orange|gold|red)/iu.test(text)) return 'warm';
  if (/(?:冷|蓝|青|白蓝|cool|blue|cyan)/iu.test(text)) return 'cool';
  if (/(?:中性|neutral|daylight)/iu.test(text)) return 'neutral';
  return undefined;
};

type MotionDirection = 'left-to-right' | 'right-to-left' | 'left' | 'right' | 'forward' | 'backward' | undefined;

const motionDirectionOf = (shot: ContinuityShotLike): MotionDirection => {
  const explicit = firstString(shot, ['motionDirection', 'axis']);
  const text = `${explicit} ${shot.camera || ''} ${shot.action || ''}`.toLocaleLowerCase();
  // Explicit enum-like values are common in adapters and should not depend on
  // natural-language regex matching.
  if (text.includes('left-to-right') || text.includes('l->r') || text.includes('l2r')) return 'left-to-right';
  if (text.includes('right-to-left') || text.includes('r->l') || text.includes('r2l')) return 'right-to-left';
  if (text.includes('forward')) return 'forward';
  if (text.includes('backward')) return 'backward';
  if (/(?:从?左(?:向|到|至|往)右|left\s*(?:to|->|→|-)\s*right|l\s*(?:to|2)\s*r)/iu.test(text)) return 'left-to-right';
  if (/(?:从?右(?:向|到|至|往)左|right\s*(?:to|->|→|-)\s*left|r\s*(?:to|2)\s*l)/iu.test(text)) return 'right-to-left';
  if (/(?:向左|往左|左移|pan\s*left|move\s*left)/iu.test(text)) return 'left';
  if (/(?:向右|往右|右移|pan\s*right|move\s*right)/iu.test(text)) return 'right';
  if (/(?:向前|前进|推进|forward|push\s*in|dolly\s*in)/iu.test(text)) return 'forward';
  if (/(?:向后|后退|拉远|backward|pull\s*out|dolly\s*out)/iu.test(text)) return 'backward';
  return undefined;
};

const oppositeDirections = (left: MotionDirection, right: MotionDirection): boolean => (
  (left === 'left-to-right' && right === 'right-to-left') ||
  (left === 'right-to-left' && right === 'left-to-right') ||
  (left === 'left' && right === 'right') ||
  (left === 'right' && right === 'left') ||
  (left === 'forward' && right === 'backward') ||
  (left === 'backward' && right === 'forward')
);

const dialogueTextOf = (shot: ContinuityShotLike): string => {
  const explicit = firstString(shot, ['dialogueText', 'dialogue']);
  if (explicit) return explicit;
  const body = `${shot.action || ''} ${shot.sound || ''} ${shot.purpose || ''}`;
  const quoted = [...body.matchAll(/[“「『"']([^”」』"']{1,})[”」』"']/gu)].map((match) => match[1]);
  return quoted.join(' ');
};

/** Estimate the wall-clock window needed for spoken text (including a small lead/tail). */
export const estimateDialogueDurationSec = (
  value: string,
  options: Pick<ContinuityOptions, 'dialogueCharsPerSec' | 'dialogueLeadTailSec'> = {}
): number => {
  const text = value.trim();
  if (!text) return 0;
  const speechText = text.replace(/[，。！？、；：…—,.!?;:]/gu, '');
  const chars = (speechText.match(/[\u4e00-\u9fff]/gu) || []).length;
  const words = (speechText.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/giu) || []).length;
  const units = Math.max(1, chars + words + Math.round((speechText.length - chars) * 0.15));
  const charsPerSec = Math.max(1, options.dialogueCharsPerSec ?? 5.5);
  const leadTail = Math.max(0, options.dialogueLeadTailSec ?? 0.25);
  return units / charsPerSec + leadTail;
};

const mediaTypeOf = (asset: ContinuityAssetLike | undefined): string => {
  const raw = (asset?.mediaType || asset?.type || asset?.role || 'image').toLocaleLowerCase();
  if (/(?:clay[\s-]?render|clay_render|泥模|白模)/iu.test(raw)) return 'clay-render';
  if (/(?:video|视频|movie|clip)/iu.test(raw)) return 'video';
  if (/(?:audio|音频|sound|voice)/iu.test(raw)) return 'audio';
  return 'image';
};

const normalizedMediaType = (value: string): string => {
  const raw = value.toLocaleLowerCase();
  if (/(?:clay[\s-]?render|clay_render|泥模|白模)/iu.test(raw)) return 'clay-render';
  if (/(?:video|视频|movie|clip)/iu.test(raw)) return 'video';
  if (/(?:audio|音频|sound|voice)/iu.test(raw)) return 'audio';
  return 'image';
};

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const stateValue = (value: unknown): string => readString(value).replace(/[\r\n]+/gu, ' ');

const compactState = (state: NsfwShotContinuityState): NsfwShotContinuityState | undefined => {
  const normalized: NsfwShotContinuityState = {
    nudity: stateValue(state.nudity),
    clothingState: stateValue(state.clothingState),
    contact: stateValue(state.contact),
    actionStage: stateValue(state.actionStage),
    residue: stateValue(state.residue),
  };
  Object.keys(normalized).forEach((key) => {
    if (!normalized[key as keyof NsfwShotContinuityState]) {
      delete normalized[key as keyof NsfwShotContinuityState];
    }
  });
  return Object.keys(normalized).length ? normalized : undefined;
};

const shotStateText = (shot: ContinuityShotLike): string => [
  // A stored prompt is derived and may be stale after a user edits the shot.
  // Put it first so current structured/action/result fields win on conflicts.
  shot.prompt,
  shot.purpose,
  shot.subject,
  shot.action,
  shot.result,
  shot.outfit,
  shot.clothing,
].map(readString).filter(Boolean).join('；');

const NEGATED_STATE_PREFIX = /(?:禁止|不得(?!不)|不要|不能|不可|没有|没|尚未|还未|还没|并未|未曾|并非|不肯|拒绝|避免|阻止|制止|不应|无需|无须|准备|打算|试图|尝试|想要|正要|将要|即将|开始|停止|no|not|without)\s*[^，。！？；;,\n]{0,8}$/iu;

const lastPositivePattern = (
  text: string,
  patterns: readonly RegExp[],
): { index: number; value: string } | undefined => {
  let latest: { index: number; value: string } | undefined;
  patterns.forEach((pattern) => {
    const flags = Array.from(new Set(`${pattern.flags}g`.split(''))).join('');
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const index = match.index ?? -1;
      if (index < 0 || NEGATED_STATE_PREFIX.test(text.slice(Math.max(0, index - 18), index))) continue;
      // Earlier patterns are more specific. Preserve them when a later generic
      // pattern starts at the same character (for example “重新穿回红裙”).
      if (!latest || index > latest.index) latest = { index, value: match[0] };
    }
  });
  return latest;
};

const firstPositivePattern = (
  text: string,
  patterns: readonly RegExp[],
): { index: number; value: string } | undefined => {
  let earliest: { index: number; value: string } | undefined;
  patterns.forEach((pattern) => {
    const flags = Array.from(new Set(`${pattern.flags}g`.split(''))).join('');
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const index = match.index ?? -1;
      if (index < 0 || NEGATED_STATE_PREFIX.test(text.slice(Math.max(0, index - 18), index))) continue;
      if (!earliest || index < earliest.index) earliest = { index, value: match[0] };
    }
  });
  return earliest;
};

const lastSpecificOrGenericPattern = (
  text: string,
  specificPatterns: readonly RegExp[],
  genericPatterns: readonly RegExp[],
): { index: number; value: string } | undefined => {
  const specific = lastPositivePattern(text, specificPatterns);
  const generic = lastPositivePattern(text, genericPatterns);
  if (!specific) return generic;
  if (!generic) return specific;
  // A generic verb may begin inside the more informative object-first span
  // (“把红裙[穿回]身上”). It is the same event, not a later event.
  if (generic.index >= specific.index && generic.index < specific.index + specific.value.length) return specific;
  return generic.index > specific.index ? generic : specific;
};

const clauseContaining = (text: string, signal: RegExp): string => {
  const clauses = text.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean);
  return [...clauses].reverse().find((item) => signal.test(item))?.slice(0, 160) || '';
};

const STATE_EVENT_BOUNDARY_SOURCE = '(?=(?:后|并|而|随后|接着|，|。|！|？|；|;|\\n|$))';
const CLOTHING_REMOVAL_VERB_SOURCE = '(?:脱下|脱掉|脱去|褪下|解下|扯下|剥下)';
const CLOTHING_REDRESS_VERB_SOURCE = '(?:穿上|穿回|穿好|套上|披上|扣好|系好)';
// Keep object-first and verb-first grammar separate. Otherwise “把红裙脱下后”
// is also seen as a verb-first phrase and the text after 脱下 (“后全裸…”) is
// incorrectly persisted as the garment name.
const CLOTHING_REMOVAL_OBJECT_FIRST_PATTERN = new RegExp(
  `(?:把|将)\\s*([^，。！？；;\\n]{1,52}?)(?:\\s*从[^，。！？；;\\n]{1,16})?\\s*${CLOTHING_REMOVAL_VERB_SOURCE}(?:了)?${STATE_EVENT_BOUNDARY_SOURCE}`,
  'u',
);
const CLOTHING_REMOVAL_VERB_FIRST_PATTERN = new RegExp(
  `${CLOTHING_REMOVAL_VERB_SOURCE}(?:了)?(?!的|后|来|去|完|光|净|尽)\\s*([^，。！？；;\\n]{1,52}?)${STATE_EVENT_BOUNDARY_SOURCE}`,
  'u',
);
const CLOTHING_REMOVAL_DETAIL_PATTERNS = [
  CLOTHING_REMOVAL_OBJECT_FIRST_PATTERN,
  CLOTHING_REMOVAL_VERB_FIRST_PATTERN,
] as const;
const CLOTHING_REMOVAL_GENERIC_PATTERN = /(?:脱衣|(?:脱光|褪尽)(?:了)?(?:全部|所有|身上(?:的)?)?\s*(?:衣物|衣服|服装)?|(?:把|将)\s*(?:全部|所有|身上(?:的)?(?:全部|所有)?)?\s*(?:衣物|衣服|服装)\s*(?:全部|都)?\s*(?:脱下|脱掉|脱去|褪下|剥下|脱光)|(?:衣物|衣服|服装)(?:已经|已)?(?:全部|都)?(?:脱下|脱掉|脱去|褪下|剥下|脱光))/u;
const CLOTHING_REDRESS_OBJECT_FIRST_PATTERN = new RegExp(
  `(?:把|将)\\s*([^，。！？；;\\n]{1,52}?)\\s*(?:重新|再次)?${CLOTHING_REDRESS_VERB_SOURCE}(?:了)?(?:身上)?${STATE_EVENT_BOUNDARY_SOURCE}`,
  'u',
);
const CLOTHING_REDRESS_VERB_FIRST_PATTERN = new RegExp(
  `(?:重新|再次)?${CLOTHING_REDRESS_VERB_SOURCE}(?:了)?(?!的|后|来|去|完|好|身上)\\s*([^，。！？；;\\n]{1,52}?)${STATE_EVENT_BOUNDARY_SOURCE}`,
  'u',
);
const CLOTHING_REDRESS_DETAIL_PATTERNS = [
  CLOTHING_REDRESS_OBJECT_FIRST_PATTERN,
  CLOTHING_REDRESS_VERB_FIRST_PATTERN,
] as const;
const CLOTHING_REDRESS_RESULT_PATTERN = new RegExp(
  `([^，。！？；;\\n]{1,52}?)(?:已经|已)(?:重新|再次)?${CLOTHING_REDRESS_VERB_SOURCE}(?:了)?(?:在?身上)?${STATE_EVENT_BOUNDARY_SOURCE}`,
  'u',
);
const CLOTHING_REDRESS_STATE_DETAIL_PATTERNS = [
  ...CLOTHING_REDRESS_DETAIL_PATTERNS,
  CLOTHING_REDRESS_RESULT_PATTERN,
] as const;
const CLOTHING_REDRESS_GENERIC_PATTERN = /(?:完整着装|衣着完整|穿戴整齐|衣物已重新穿戴完整|(?:重新|再次)?穿(?:回|好)(?:了)?(?:衣物|衣服|服装)?|fully\s+dressed)/iu;

const garmentFromStateEvent = (
  value: string,
  patterns: readonly RegExp[],
): string => {
  for (const pattern of patterns) {
    const garment = value.match(pattern)?.[1]?.trim()
      .replace(/^(?:自己|其)?身上(?:的)?/u, '')
      .trim();
    if (garment && !/^(?:后|随后|接着|身上)$/u.test(garment)) return garment;
  }
  return '';
};

const removedClothingState = (text: string): string => {
  const removal = lastSpecificOrGenericPattern(
    text,
    CLOTHING_REMOVAL_DETAIL_PATTERNS,
    [CLOTHING_REMOVAL_GENERIC_PATTERN],
  );
  if (!removal) return '';
  const captured = garmentFromStateEvent(removal.value, CLOTHING_REMOVAL_DETAIL_PATTERNS);
  const afterRemoval = text.slice(removal.index + removal.value.length);
  if (!captured || /^(?:衣物|衣服|服装)$/u.test(captured)) {
    const remaining = wornClothingState(afterRemoval);
    return [
      '已脱衣物作为离身道具保持其可见位置与状态',
      remaining ? `其余仍有${remaining}` : '',
    ].filter(Boolean).join('；');
  }
  const location = afterRemoval.match(
    /(?:留|放|落|扔|丢|搭|堆)(?:在|到|至)\s*([^，。！？；;\n]{1,24})/u,
  )?.[1]?.trim();
  const remaining = wornClothingState(afterRemoval);
  return [
    `${captured}已脱下并作为离身道具${location ? `留在${location}` : '保持其可见位置与状态'}`,
    remaining ? `其余仍有${remaining}` : '',
  ].filter(Boolean).join('；');
};

const redressedClothingState = (text: string): string => {
  const redress = lastSpecificOrGenericPattern(
    text,
    CLOTHING_REDRESS_STATE_DETAIL_PATTERNS,
    [CLOTHING_REDRESS_GENERIC_PATTERN],
  );
  if (!redress) return '';
  const garment = garmentFromStateEvent(redress.value, CLOTHING_REDRESS_STATE_DETAIL_PATTERNS);
  return garment ? `${garment}已重新穿在身上` : '衣物已重新穿戴完整';
};

/** Whether this shot visibly removes clothing or puts it back on. Static nude
 * descriptions are deliberately not transitions. */
export const inferNsfwClothingTransitionKind = (
  shot: ContinuityShotLike,
): NsfwClothingTransitionKind | undefined => {
  // A result such as “衣物已脱下” is an end-state assertion, not proof that
  // this later shot repeats the removal. Prefer the authored action/purpose;
  // prompt is only a legacy fallback when the action field is absent.
  const text = [shot.purpose, shot.action, shot.action ? '' : shot.prompt]
    .map(readString)
    .filter(Boolean)
    .join('；');
  const removal = lastSpecificOrGenericPattern(
    text,
    CLOTHING_REMOVAL_DETAIL_PATTERNS,
    [CLOTHING_REMOVAL_GENERIC_PATTERN],
  );
  const redress = lastSpecificOrGenericPattern(
    text,
    CLOTHING_REDRESS_DETAIL_PATTERNS,
    [CLOTHING_REDRESS_GENERIC_PATTERN],
  );
  if (!removal && !redress) return undefined;
  return redress && (!removal || redress.index > removal.index) ? 'redress' : 'removal';
};

const wornClothingState = (text: string): string => {
  const worn = lastPositivePattern(text, [
    /(?:(?:仍然|依然|依旧|当前)?\s*(?:仍穿着|穿戴着|穿着|身穿|仍穿|裹着))(?:了)?\s*([^，。！？；;\n]{1,52}(?:衣|裙|裤|袍|衫|褂|甲|靴|鞋|袜|内裤|胸罩|外套|睡袍|浴巾|丝袜|斗篷))/u,
  ]);
  if (!worn) return '';
  const garment = worn.value.match(
    /(?:(?:仍然|依然|依旧|当前)?\s*(?:仍穿着|穿戴着|穿着|身穿|仍穿|裹着))(?:了)?\s*([^，。！？；;\n]{1,52}(?:衣|裙|裤|袍|衫|褂|甲|靴|鞋|袜|内裤|胸罩|外套|睡袍|浴巾|丝袜|斗篷))/u,
  )?.[1]?.trim();
  return garment ? `${garment}穿在身上` : '';
};

const nudityStateFromText = (text: string): string => {
  const nude = lastPositivePattern(text, [
    /(?:全裸|赤身裸体|一丝不挂|赤裸全身|completely\s+naked|fully\s+nude)/iu,
    /(?:脱下|脱掉|脱去|褪下|剥下)(?:了)?(?!的)\s*(?:全部|所有|身上(?:的)?(?:全部|所有)?)\s*(?:衣物|衣服|服装)/u,
    /(?:把|将)\s*(?:全部|所有|身上(?:的)?(?:全部|所有)?)?\s*(?:衣物|衣服|服装)\s*(?:全部|都)?\s*(?:脱下|脱掉|脱去|褪下|剥下|脱光)/u,
    /(?:脱光|褪尽)(?:了)?(?:全部|所有|身上(?:的)?)?\s*(?:衣物|衣服|服装)?/u,
    /(?:衣物|衣服|服装)(?:已经|已)?(?:全部|都)?(?:脱下|脱掉|脱去|褪下|剥下|脱光)/u,
    /(?:上身赤裸|赤裸上身|袒露上身|胸部裸露|topless)/iu,
    /(?:下身赤裸|下体裸露|bottomless)/iu,
    /(?:半裸|部分裸露|衣襟敞开|衣物褪至|partially\s+nude)/iu,
  ]);
  const dressed = lastPositivePattern(text, [
    /(?:重新|再次)?(?:穿上|穿回|套上|披上|扣好|系好)/u,
    /(?:完整着装|衣着完整|穿戴整齐|fully\s+dressed)/iu,
  ]);
  if (dressed && (!nude || dressed.index > nude.index)) return '完整着装';
  if (!nude) return '';
  if (/(?:上身|胸部|topless)/iu.test(nude.value)) return '上身裸露';
  if (/(?:下身|下体|bottomless)/iu.test(nude.value)) return '下身裸露';
  if (/(?:半裸|部分|敞开|褪至|partially)/iu.test(nude.value)) return '部分裸露';
  return '全裸';
};

const contactStateFromText = (text: string): string => {
  const ended = lastPositivePattern(text, [
    /(?:停止|结束|退出|中断).{0,10}(?:接触|贴合|拥抱|亲吻|性交|交合|插入)/u,
    /(?:从.{0,16})?(?:抽离|退出)(?:身体|接触点|阴道|后穴|插入处)/u,
    /(?:松开对方|两人分开|双方分开|身体分开|彼此分开|离开对方)/u,
    /(?:无接触|没有身体接触|no\s+(?:physical\s+)?contact)/iu,
  ]);
  const active = lastPositivePattern(text, [
    /(?:身体|胸口|嘴唇|双腿|手掌|指尖|阴茎|阳具|阴部|阴唇|阴道|乳房|乳头|后穴).{0,24}(?:接触|贴合|抵住|压住|进入|插入|摩擦|亲吻|拥抱)/u,
    /(?:性交|交合|抽插|抽送|乳交|足交|骑乘位|持续身体接触|physical\s+contact|penetration)/iu,
  ]);
  if (ended && (!active || ended.index > active.index)) return '无接触';
  if (!active) return '';
  return clauseContaining(text, /(?:接触|贴合|抵住|压住|进入|插入|摩擦|亲吻|拥抱|性交|交合|抽插|抽送|乳交|足交|骑乘位|penetration)/iu)
    || active.value;
};

const actionStageFromText = (text: string): string => {
  const stagePatterns: Array<[string, RegExp]> = [
    ['准备', /(?:准备|靠近|脱下(?!的)|脱掉(?!的)|脱去(?!的)|褪下(?!的)|解开(?!的))/u],
    ['开始', /(?:开始|进入|初次插入|刚刚插入)/u],
    ['持续', /(?:继续|持续|抽插|抽送|加快|反复)/u],
    ['高潮', /(?:高潮|射精|痉挛)/u],
    ['结束', /(?:结束|停止|退出|抽离|分开|离开|清理完毕)/u],
  ];
  let latest: { index: number; stage: string } | undefined;
  stagePatterns.forEach(([stage, pattern]) => {
    const match = lastPositivePattern(text, [pattern]);
    if (match && (!latest || match.index >= latest.index)) latest = { index: match.index, stage };
  });
  return latest?.stage || '';
};

const residueStateFromText = (text: string): string => {
  const cleared = lastPositivePattern(text, [
    /(?:擦去|擦净|洗去|洗净|清洗|清理|冲掉|无可见残留|洁净无残留)/u,
  ]);
  const present = lastPositivePattern(text, [
    /(?:精液|体液|分泌物|汗液|唾液|黏液)/u,
    /(?:皮肤|身体|体表|胸口|腹部|腿部|私密部位).{0,18}(?:湿痕|液体|残留|污迹)/u,
    /(?:湿痕|液体|残留|污迹).{0,18}(?:皮肤|身体|体表|胸口|腹部|腿部|私密部位)/u,
  ]);
  if (cleared && (!present || cleared.index >= present.index)) return '无可见残留';
  if (!present) return '';
  return clauseContaining(text, /(?:精液|体液|分泌物|汗液|唾液|湿痕|液体|黏液|残留|污迹)/u)
    || present.value;
};

/** Read only facts visible in this shot; this function never invents anatomy. */
export const inferNsfwShotContinuityState = (
  shot: ContinuityShotLike,
): NsfwShotContinuityState | undefined => {
  const explicit = compactState(shot.nsfwContinuity || {}) || {};
  const text = shotStateText(shot);
  const removed = removedClothingState(text);
  const redressed = redressedClothingState(text);
  const worn = wornClothingState(text);
  const nudity = nudityStateFromText(text);
  const contact = contactStateFromText(text);
  const residue = residueStateFromText(text);
  const hasIntimateStageContext = Boolean(
    explicit.actionStage
    || nudity
    || contact
    || residue
    || /(?:性交|交合|行房|媾合|性行为|抽插|抽送|插入|高潮|射精|阴茎|阳具|阴道|阴部|阴唇|乳房|乳头|后穴|私密部位|penetration|orgasm|ejaculation)/iu.test(text),
  );
  return compactState({
    // A remaining inner layer after an outer layer was removed is not
    // “完整着装”. Leave the precise exposure unspecified unless the authored
    // shot states it, while preserving both garments in clothingState.
    nudity: explicit.nudity || nudity || (!removed && worn ? '完整着装' : ''),
    clothingState: explicit.clothingState || redressed || removed || worn,
    contact: explicit.contact || contact,
    actionStage: explicit.actionStage || (hasIntimateStageContext ? actionStageFromText(text) : ''),
    residue: explicit.residue || residue,
  });
};

const NSFW_STATE_SIGNAL = /(?:全裸|裸体|赤裸|一丝不挂|裸露|半裸|完整着装|衣着完整|穿戴整齐|身穿|穿着|仍穿|脱下|脱掉|脱去|褪下|剥下|穿上|穿回|套上|披上|衣物|衣服|服装|(?:衣|裙|裤|袍|衫|褂|甲|靴|鞋|袜|胸罩|文胸|抹胸|肚兜|浴巾|丝袜|斗篷)[^，。！？；;\n]{0,12}(?:留在|落在|放在|搭在|扔在|堆在)|接触|贴合|抵住|压住|进入|插入|摩擦|亲吻|拥抱|性交|交合|抽插|抽送|乳交|足交|骑乘|准备|开始|继续|持续|高潮|射精|结束|停止|退出|抽离|分开|精液|体液|分泌物|汗液|唾液|黏液|湿痕|残留|污迹|nude|naked|topless|bottomless|dressed|contact|penetration|orgasm|ejaculation)/iu;
const COLLECTIVE_STATE_SUBJECT = /(?:两人|二人|三人|双方|众人|全员|所有人|她们|他们|都|均|皆|一起|一同)/u;

const stateTextForNsfwSubject = (
  value: unknown,
  identity: NsfwSubjectIdentity,
  identities: readonly NsfwSubjectIdentity[],
  allowUnowned: boolean,
): string => {
  const text = readString(value);
  if (!text || identities.length <= 1) return text;
  const units = text.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean);
  const scoped: string[] = [];
  for (const unit of units) {
    const occurrences = identities.flatMap((candidate) => {
      const positions: Array<{ index: number; identity: NsfwSubjectIdentity }> = [];
      if (!candidate.label) return positions;
      let cursor = 0;
      while (cursor < unit.length) {
        const index = unit.indexOf(candidate.label, cursor);
        if (index < 0) break;
        positions.push({ index, identity: candidate });
        cursor = index + Math.max(1, candidate.label.length);
      }
      return positions;
    }).sort((left, right) => left.index - right.index || right.identity.label.length - left.identity.label.length);
    if (!occurrences.length) {
      if ((allowUnowned || COLLECTIVE_STATE_SUBJECT.test(unit)) && NSFW_STATE_SIGNAL.test(unit)) scoped.push(unit);
      continue;
    }
    if (!occurrences.some((item) => item.identity.key === identity.key)) continue;
    const collective = COLLECTIVE_STATE_SUBJECT.test(unit)
      && identities.every((candidate) => unit.includes(candidate.label));
    if (collective && NSFW_STATE_SIGNAL.test(unit)) {
      scoped.push(unit);
      continue;
    }
    occurrences.forEach((occurrence, index) => {
      if (occurrence.identity.key !== identity.key) return;
      const end = occurrences[index + 1]?.index ?? unit.length;
      const slice = unit.slice(occurrence.index, end).trim();
      if (NSFW_STATE_SIGNAL.test(slice)) scoped.push(slice);
    });
  }
  return scoped.join('；');
};

const scopedExplicitNsfwState = (
  shot: ContinuityShotLike,
  identity: NsfwSubjectIdentity,
  identities: readonly NsfwSubjectIdentity[],
): NsfwShotContinuityState | undefined => {
  const source = shot.nsfwContinuity;
  if (!source) return undefined;
  const value = (field: keyof NsfwShotContinuityState): string => stateTextForNsfwSubject(
    source[field],
    identity,
    identities,
    true,
  );
  const nudityText = value('nudity');
  const clothingText = value('clothingState');
  const contactText = value('contact');
  const stageText = value('actionStage');
  const residueText = value('residue');
  return compactState({
    nudity: nudityStateFromText(nudityText) || nudityText,
    clothingState: redressedClothingState(clothingText)
      || removedClothingState(clothingText)
      || wornClothingState(clothingText)
      || clothingText,
    contact: contactStateFromText(contactText) || contactText,
    actionStage: actionStageFromText(stageText) || stageText,
    residue: residueStateFromText(residueText) || residueText,
  });
};

const scopedNsfwShotForSubject = (
  shot: ContinuityShotLike,
  identity: NsfwSubjectIdentity,
  identities: readonly NsfwSubjectIdentity[],
): ContinuityShotLike => ({
  ...shot,
  subject: identity.label,
  purpose: stateTextForNsfwSubject(shot.purpose, identity, identities, false),
  action: stateTextForNsfwSubject(shot.action, identity, identities, false),
  result: stateTextForNsfwSubject(shot.result, identity, identities, false),
  prompt: stateTextForNsfwSubject(shot.prompt, identity, identities, false),
  outfit: stateTextForNsfwSubject(shot.outfit, identity, identities, false),
  clothing: stateTextForNsfwSubject(shot.clothing, identity, identities, false),
  nsfwContinuity: scopedExplicitNsfwState(shot, identity, identities),
});

const inferNsfwStateForSubject = (
  shot: ContinuityShotLike,
  identity: NsfwSubjectIdentity,
  identities: readonly NsfwSubjectIdentity[],
): NsfwShotContinuityState | undefined => inferNsfwShotContinuityState(
  scopedNsfwShotForSubject(shot, identity, identities),
);

const aggregateNsfwSubjectStates = (
  values: readonly { identity: NsfwSubjectIdentity; state: NsfwShotContinuityState }[],
): NsfwShotContinuityState | undefined => {
  if (!values.length) return undefined;
  // This helper is used only when the shot declares multiple performers.
  // Keep the owner label even if just one of them has an observed state;
  // otherwise a bare “全裸” is ambiguous and can spread to every performer.
  const field = (key: keyof NsfwShotContinuityState): string => values
    .flatMap(({ identity, state }) => {
      const current = stateValue(state[key]);
      return current ? [`${identity.label}：${current}`] : [];
    })
    .join('；');
  return compactState({
    nudity: field('nudity'),
    clothingState: field('clothingState'),
    contact: field('contact'),
    actionStage: field('actionStage'),
    residue: field('residue'),
  });
};

const completeNudeState = (value: unknown): boolean => /(?:全裸|赤身裸体|一丝不挂|赤裸全身|completely\s+naked|fully\s+nude)/iu.test(stateValue(value));

const reconcileObservedNsfwState = (
  observed: NsfwShotContinuityState | undefined,
): NsfwShotContinuityState | undefined => {
  if (!observed) return undefined;
  if (completeNudeState(observed.nudity) && !stateValue(observed.clothingState)) {
    return { ...observed, clothingState: '衣物已不在身上，离身位置未在本镜交代' };
  }
  if (isDressedState(stateValue(observed.nudity)) && !stateValue(observed.clothingState)) {
    return { ...observed, clothingState: '衣物已穿在身上，具体款式沿用本镜剧情' };
  }
  return observed;
};

const entryStateBeforeNsfwTransition = (
  shot: ContinuityShotLike,
  observed: NsfwShotContinuityState | undefined,
): NsfwShotContinuityState | undefined => {
  if (!observed) return undefined;
  // Result fields and explicit continuity fields describe the visible end
  // state.  “衣物已脱下” there must not manufacture a second removal at the
  // first frame of a shot that merely inherits an already-nude state.
  const visibleTransitionShot: ContinuityShotLike = shot.action
    ? { ...shot, purpose: '', prompt: '', result: '', outfit: '', clothing: '', nsfwContinuity: undefined }
    : { ...shot, result: '', outfit: '', clothing: '', nsfwContinuity: undefined };
  if (!inferNsfwClothingTransitionKind(visibleTransitionShot)) return { ...observed };
  const text = [
    shot.action,
    shot.action ? '' : shot.prompt,
    shot.action ? '' : shot.purpose,
  ].map(readString).filter(Boolean).join('；');
  const removal = firstPositivePattern(text, [
    ...CLOTHING_REMOVAL_DETAIL_PATTERNS,
    CLOTHING_REMOVAL_GENERIC_PATTERN,
  ]);
  const redress = firstPositivePattern(text, [
    ...CLOTHING_REDRESS_DETAIL_PATTERNS,
    CLOTHING_REDRESS_GENERIC_PATTERN,
  ]);
  const removalIndex = removal?.index ?? Number.POSITIVE_INFINITY;
  const redressIndex = redress?.index ?? Number.POSITIVE_INFINITY;
  const firstTransitionIndex = Math.min(removalIndex, redressIndex);
  if (!Number.isFinite(firstTransitionIndex)) return { ...observed };
  const prefix = text.slice(0, firstTransitionIndex);
  const prefixState = inferNsfwShotContinuityState({
    id: `${shot.id}:entry`,
    startSec: shot.startSec,
    endSec: shot.endSec,
    subject: shot.subject,
    action: prefix,
  });
  if (removalIndex <= redressIndex) {
    const garment = garmentFromStateEvent(removal?.value || '', CLOTHING_REMOVAL_DETAIL_PATTERNS);
    return compactState({
      ...prefixState,
      clothingState: garment
        ? `${garment}仍穿在身上，尚未执行本镜脱衣动作`
        : '剧情起始衣物仍穿在身上，尚未执行本镜脱衣动作',
    });
  }
  const garment = garmentFromStateEvent(redress?.value || '', CLOTHING_REDRESS_DETAIL_PATTERNS);
  return compactState({
    ...prefixState,
    nudity: prefixState?.nudity,
    clothingState: garment
      ? `${garment}尚未穿回并作为离身衣物保持上一位置`
      : '待穿衣物尚未穿回并保持上一离身位置',
  });
};

export interface NsfwShotContinuityBoundary {
  /** State visible at the first frame, before this shot changes clothing/contact. */
  entry?: NsfwShotContinuityState;
  /** State visible after every authored action/result in this shot completes. */
  end?: NsfwShotContinuityState;
}

/**
 * Resolve both sides of every cut. This is the authoritative API for prompts
 * and boundary images: a removal shot starts clothed and ends with that exact
 * garment off-body; a dressing shot starts with it off-body and ends dressed.
 */
export const resolveNsfwShotContinuityBoundaries = (
  shots: readonly ContinuityShotLike[],
): NsfwShotContinuityBoundary[] => {
  const currentBySubject = new Map<string, NsfwShotContinuityState>();
  const unscopedKey = '__unscoped_nsfw_state__';
  return shots.map((shot) => {
    const identities = nsfwSubjectIdentitiesOf(shot);
    const scopedSubjects = identities.length
      ? identities.map((identity) => ({
          identity,
          shot: identities.length === 1 ? shot : scopedNsfwShotForSubject(shot, identity, identities),
        }))
      : [{ identity: { key: unscopedKey, label: '' }, shot }];
    const entryValues: Array<{ identity: NsfwSubjectIdentity; state: NsfwShotContinuityState }> = [];
    const endValues: Array<{ identity: NsfwSubjectIdentity; state: NsfwShotContinuityState }> = [];
    scopedSubjects.forEach(({ identity, shot: scopedShot }) => {
      const current = compactState(currentBySubject.get(identity.key) || {});
      const rawObserved = identities.length <= 1
        ? inferNsfwShotContinuityState(scopedShot)
        : inferNsfwStateForSubject(shot, identity, identities);
      const observed = reconcileObservedNsfwState(rawObserved);
      const entry = current || entryStateBeforeNsfwTransition(scopedShot, observed);
      const end = compactState({ ...(entry || {}), ...(observed || {}) });
      if (entry) entryValues.push({ identity, state: entry });
      if (end) {
        currentBySubject.set(identity.key, end);
        endValues.push({ identity, state: end });
      }
    });
    const aggregate = (
      values: readonly { identity: NsfwSubjectIdentity; state: NsfwShotContinuityState }[],
    ): NsfwShotContinuityState | undefined => identities.length > 1
      ? aggregateNsfwSubjectStates(values)
      : values[0]?.state ? { ...values[0].state } : undefined;
    return { entry: aggregate(entryValues), end: aggregate(endValues) };
  });
};

/**
 * Resolve the effective state at every cut. Omitted fields inherit the last
 * visible state until the story explicitly shows dressing, separation,
 * stage progression, or cleanup.
 */
export const resolveNsfwShotContinuityStates = (
  shots: readonly ContinuityShotLike[],
): Array<NsfwShotContinuityState | undefined> => resolveNsfwShotContinuityBoundaries(shots)
  .map((boundary) => boundary.end ? { ...boundary.end } : undefined);

export const stableNsfwBodyAnchorText = (
  anchors: NsfwBodyAnchors | undefined,
): string => Array.from(new Set(
  (anchors?.stableTraits || []).map(stateValue).filter(Boolean),
)).join('、');

export const hasExplicitClothingStateChange = (value: string): boolean => Boolean(
  removedClothingState(value)
  || redressedClothingState(value)
  || nudityStateFromText(value),
);

const isNudeState = (value: string): boolean => /(?:全裸|裸露|半裸|赤裸|nude|naked|topless|bottomless)/iu.test(value);
const isDressedState = (value: string): boolean => /(?:完整着装|衣着完整|穿戴整齐|穿在身上|fully\s+dressed)/iu.test(value);
const isNoContactState = (value: string): boolean => /(?:无接触|没有.*接触|no\s+contact)/iu.test(value);
const isNoResidueState = (value: string): boolean => /(?:无.*残留|洁净|已清理|clean)/iu.test(value);
const stageRank = (value: string): number => {
  if (/(?:准备)/u.test(value)) return 0;
  if (/(?:开始|进入)/u.test(value)) return 1;
  if (/(?:持续|继续|加快)/u.test(value)) return 2;
  if (/(?:高潮|射精|痉挛)/u.test(value)) return 3;
  if (/(?:结束|停止|退出|抽离|分开)/u.test(value)) return 4;
  return -1;
};

const issueId = (
  code: ContinuityIssue['code'],
  shotIds: readonly string[],
  discriminator?: string,
): string => [code, ...shotIds, discriminator].filter(Boolean).join(':');

/** Run all continuity rules against a storyboard or a bare shot list. */
export const checkStoryboardContinuity = (
  input: ContinuityStoryboardLike | readonly ContinuityShotLike[],
  options: ContinuityOptions = {}
): ContinuityReport => {
  const isStoryboard = !Array.isArray(input);
  const storyboard: ContinuityStoryboardLike | undefined = isStoryboard ? input as ContinuityStoryboardLike : undefined;
  const sourceShots: readonly ContinuityShotLike[] = isStoryboard
    ? (input as ContinuityStoryboardLike).shots || []
    : input as readonly ContinuityShotLike[];
  const shots = [...sourceShots].sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.startSec - b.startSec);
  const assets: readonly ContinuityAssetLike[] | undefined = options.assets ?? storyboard?.assets;
  const assetsById = new Map<string, ContinuityAssetLike>((assets || []).map((asset: ContinuityAssetLike) => [asset.id, asset]));
  const limits = options.referenceLimits || options.targetLimits || options.target;
  const issues: ContinuityIssue[] = [];
  const add = (
    code: ContinuityIssue['code'],
    severity: ContinuitySeverity,
    message: string,
    shotIds: readonly string[],
    details?: Readonly<Record<string, unknown>>,
    idDiscriminator?: string,
  ): void => {
    issues.push({ id: issueId(code, shotIds, idDiscriminator), code, severity, message, shotIds: [...shotIds], details });
  };

  const tolerance = Math.max(0.001, options.toleranceSec ?? 0.05);
  const targetDuration = finite(storyboard?.durationSec);
  let dialogueShotCount = 0;
  let referenceCount = 0;
  const uniqueReferences = new Set<string>();
  const resolvedNsfwStates = resolveNsfwShotContinuityStates(shots);

  shots.forEach((shot) => {
    const start = finite(shot.startSec);
    const end = finite(shot.endSec);
    if (start === undefined || end === undefined || start < 0 || end <= start) {
      add('invalid-range', 'error', `Shot ${shot.id} has an invalid time range.`, [shot.id], { start, end });
    }
    const localDuration = start !== undefined && end !== undefined ? Math.max(0, end - start) : 0;
    const spoken = dialogueTextOf(shot);
    const explicitDialogueDuration = finite(readValue(shot, 'dialogueDurationSec'));
    const dialogueDuration = explicitDialogueDuration ?? estimateDialogueDurationSec(spoken, options);
    if (spoken || (explicitDialogueDuration !== undefined && explicitDialogueDuration > 0)) {
      dialogueShotCount += 1;
      if (dialogueDuration > localDuration + tolerance) {
        add('dialogue-overflow', 'error', `Dialogue in shot ${shot.id} needs ${dialogueDuration.toFixed(2)}s but the shot lasts ${localDuration.toFixed(2)}s.`, [shot.id], { dialogueDuration, localDuration });
      }
      const offset = finite(readValue(shot, 'dialogueStartSec'));
      if (offset !== undefined && (offset < -tolerance || offset + dialogueDuration > localDuration + tolerance)) {
        add('dialogue-offset-overflow', 'error', `Dialogue offset in shot ${shot.id} falls outside its time range.`, [shot.id], { offset, dialogueDuration, localDuration });
      }
    }

    const references: string[] = [...new Set((shot.referenceAssetIds || []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
    referenceCount += references.length;
    references.forEach((id: string) => uniqueReferences.add(id));
    if (assets) {
      references.forEach((id) => {
        if (!assetsById.has(id)) add('reference-missing', 'warning', `Shot ${shot.id} references missing asset ${id}.`, [shot.id], { assetId: id }, `asset:${id}`);
      });
    }
    if (limits) {
      const perShotLimit = limits.maxReferencesPerShot ?? limits.maxReferences;
      if (perShotLimit !== undefined && references.length > perShotLimit) {
        add('reference-limit', 'error', `Shot ${shot.id} uses ${references.length} references; ${limits.targetId || 'the target'} allows ${perShotLimit}.`, [shot.id], { count: references.length, limit: perShotLimit, targetId: limits.targetId }, 'total');
      }
      const counts = { image: 0, video: 0, audio: 0, 'clay-render': 0 } as Record<string, number>;
      references.forEach((id) => {
        const asset = assetsById.get(id);
        if (!asset) return;
        const mediaType = mediaTypeOf(asset);
        counts[mediaType] = (counts[mediaType] || 0) + 1;
        if (limits.supportedMediaTypes && !limits.supportedMediaTypes.map(normalizedMediaType).includes(mediaType)) {
          add('reference-type-unsupported', 'error', `Shot ${shot.id} uses ${mediaType} reference ${id}, unsupported by ${limits.targetId || 'the target'}.`, [shot.id], { assetId: id, mediaType }, `asset:${id}`);
        }
      });
      const perType: Array<[string, number | undefined]> = [
        ['image', limits.maxImageReferencesPerShot],
        ['video', limits.maxVideoReferencesPerShot],
        ['audio', limits.maxAudioReferencesPerShot],
        ['clay-render', limits.maxClayRenderReferencesPerShot]
      ];
      perType.forEach(([type, limit]) => {
        if (limit !== undefined && (counts[type] || 0) > limit) {
          add('reference-limit', 'error', `Shot ${shot.id} uses ${counts[type] || 0} ${type} references; the limit is ${limit}.`, [shot.id], { mediaType: type, count: counts[type] || 0, limit }, `type:${type}`);
        }
      });
    }
  });

  for (let i = 1; i < shots.length; i += 1) {
    const left = shots[i - 1];
    const right = shots[i];
    const leftEnd = finite(left.endSec);
    const rightStart = finite(right.startSec);
    if (leftEnd === undefined || rightStart === undefined) continue;
    const delta = rightStart - leftEnd;
    if (delta > tolerance) {
      add('time-gap', 'warning', `There is a ${delta.toFixed(2)}s gap between shots ${left.id} and ${right.id}.`, [left.id, right.id], { gapSec: delta });
    } else if (delta < -tolerance) {
      add('time-overlap', 'error', `Shots ${left.id} and ${right.id} overlap by ${Math.abs(delta).toFixed(2)}s.`, [left.id, right.id], { overlapSec: Math.abs(delta) });
    }

    const isBreak = transitionAllowsBreak(left, right);
    const leftSubject = subjectKeyOf(left);
    const rightSubject = subjectKeyOf(right);
    if (leftSubject && rightSubject && leftSubject !== rightSubject && !isBreak) {
      add('subject-change', 'warning', `Subject changes from ${labelOf(left.subject || leftSubject)} to ${labelOf(right.subject || rightSubject)} without an explicit transition.`, [left.id, right.id], { from: leftSubject, to: rightSubject });
    }

    const leftScene = sceneKeyOf(left);
    const rightScene = sceneKeyOf(right);
    if (leftScene && rightScene && leftScene !== rightScene && !isBreak) {
      add('scene-jump', 'warning', `Scene changes between shots ${left.id} and ${right.id} without an explicit transition.`, [left.id, right.id], { from: leftScene, to: rightScene });
    }

    if (leftSubject && leftSubject === rightSubject) {
      const leftAnchor = anchorOf(left) || entityAnchor(left.subject || leftSubject, options.characters);
      const rightAnchor = anchorOf(right) || entityAnchor(right.subject || rightSubject, options.characters);
      if (leftAnchor && rightAnchor && anchorSimilarity(leftAnchor, rightAnchor) < 0.25 && !isBreak) {
        add('appearance-anchor-change', 'warning', `Appearance or clothing anchor changes for ${labelOf(right.subject || rightSubject)}.`, [left.id, right.id], { from: leftAnchor, to: rightAnchor });
      } else if (options.requireAnchorEveryShot && leftAnchor && !anchorOf(right) && !isBreak) {
        add('appearance-anchor-missing', 'warning', `Shot ${right.id} omits the appearance anchor for ${labelOf(right.subject || rightSubject)}.`, [left.id, right.id], { expected: leftAnchor });
      }
    }

    const previousNsfw = resolvedNsfwStates[i - 1];
    const observedNsfw = inferNsfwShotContinuityState(right);
    const rightStateText = shotStateText(right);
    if (previousNsfw && observedNsfw && leftSubject === rightSubject && !isBreak) {
      if (
        isNudeState(previousNsfw.nudity || '')
        && isDressedState(observedNsfw.nudity || '')
        && !redressedClothingState(rightStateText)
      ) {
        add(
          'nsfw-nudity-state-change',
          'warning',
          `Shot ${right.id} restores clothing after an established nude state without showing a dressing action.`,
          [left.id, right.id],
          { from: previousNsfw.nudity, to: observedNsfw.nudity },
        );
      }
      if (
        previousNsfw.contact
        && !isNoContactState(previousNsfw.contact)
        && isNoContactState(observedNsfw.contact || '')
        && !/(?:停止|结束|退出|抽离|松开|分开|离开|中断)/u.test(rightStateText)
      ) {
        add(
          'nsfw-contact-state-change',
          'warning',
          `Shot ${right.id} drops an established contact point without showing release or separation.`,
          [left.id, right.id],
          { from: previousNsfw.contact, to: observedNsfw.contact },
        );
      }
      const previousStageRank = stageRank(previousNsfw.actionStage || '');
      const observedStageRank = stageRank(observedNsfw.actionStage || '');
      if (
        previousStageRank >= 0
        && observedStageRank >= 0
        && observedStageRank < previousStageRank
        && !/(?:再次|重新|第二次|新一轮|下一轮)/u.test(rightStateText)
      ) {
        add(
          'nsfw-action-stage-regression',
          'warning',
          `Shot ${right.id} moves an intimate action back to an earlier stage without starting a new cycle.`,
          [left.id, right.id],
          { from: previousNsfw.actionStage, to: observedNsfw.actionStage },
        );
      }
      if (
        previousNsfw.residue
        && !isNoResidueState(previousNsfw.residue)
        && isNoResidueState(observedNsfw.residue || '')
        && !/(?:擦去|擦净|洗去|洗净|清洗|清理|冲掉)/u.test(rightStateText)
      ) {
        add(
          'nsfw-residue-state-change',
          'warning',
          `Shot ${right.id} removes a visible residue state without showing cleanup.`,
          [left.id, right.id],
          { from: previousNsfw.residue, to: observedNsfw.residue },
        );
      }
    }

    const leftProps = propStateMap(left);
    const rightProps = propStateMap(right);
    leftProps.forEach((state, prop) => {
      if (!rightProps.has(prop)) return;
      const nextState = rightProps.get(prop) || '';
      if (state && nextState && normalize(state) !== normalize(nextState) && !isBreak) {
        add('prop-state-change', 'warning', `Prop ${prop} changes state between shots ${left.id} and ${right.id}.`, [left.id, right.id], { prop, from: state, to: nextState });
      }
    });

    const leftTemperature = temperatureOf(left);
    const rightTemperature = temperatureOf(right);
    const leftFamily = lightFamilyOf(left);
    const rightFamily = lightFamilyOf(right);
    const kelvinJump = leftTemperature !== undefined && rightTemperature !== undefined
      ? Math.abs(leftTemperature - rightTemperature) > (options.lightingJumpKelvin ?? 1500)
      : false;
    const familyJump = !!leftFamily && !!rightFamily && leftFamily !== rightFamily && leftFamily !== 'neutral' && rightFamily !== 'neutral';
    if ((kelvinJump || familyJump) && !isBreak) {
      add('lighting-jump', 'warning', `Lighting/color temperature changes abruptly between shots ${left.id} and ${right.id}.`, [left.id, right.id], { fromKelvin: leftTemperature, toKelvin: rightTemperature, fromFamily: leftFamily, toFamily: rightFamily });
    }

    const leftDirection = motionDirectionOf(left);
    const rightDirection = motionDirectionOf(right);
    if (oppositeDirections(leftDirection, rightDirection) && !isBreak) {
      add('axis-conflict', 'warning', `Motion direction reverses between shots ${left.id} and ${right.id} without an axis break.`, [left.id, right.id], { from: leftDirection, to: rightDirection });
    }
  }

  if (targetDuration !== undefined && shots.length) {
    const firstStart = finite(shots[0].startSec);
    const lastEnd = finite(shots[shots.length - 1].endSec);
    if (firstStart !== undefined && firstStart > tolerance) {
      add('time-gap', 'warning', `Timeline starts ${firstStart.toFixed(2)}s after zero.`, [shots[0].id], { gapSec: firstStart });
    }
    if (lastEnd !== undefined && Math.abs(lastEnd - targetDuration) > tolerance) {
      const severity: ContinuitySeverity = lastEnd > targetDuration + tolerance ? 'error' : 'warning';
      add('duration-mismatch', severity, `Storyboard ends at ${lastEnd.toFixed(2)}s but its duration is ${targetDuration.toFixed(2)}s.`, [shots[shots.length - 1].id], { actualEndSec: lastEnd, durationSec: targetDuration });
    }
  }

  if (limits?.maxTotalReferences !== undefined && referenceCount > limits.maxTotalReferences) {
    add('reference-limit', 'error', `Storyboard uses ${referenceCount} references; ${limits.targetId || 'the target'} allows ${limits.maxTotalReferences} in total.`, shots.map((shot) => shot.id), { count: referenceCount, limit: limits.maxTotalReferences, targetId: limits.targetId }, 'storyboard-total');
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const score = Math.max(0, Math.round(100 - errorCount * 20 - warningCount * 7));
  return {
    valid: errorCount === 0,
    score,
    issues,
    stats: {
      shotCount: shots.length,
      totalDurationSec: targetDuration ?? (shots.length ? Math.max(...shots.map((shot) => finite(shot.endSec) ?? 0)) : 0),
      dialogueShotCount,
      referenceCount,
      uniqueReferenceCount: uniqueReferences.size,
      issueCount: issues.length,
      errorCount,
      warningCount
    }
  };
};

export const checkContinuity = checkStoryboardContinuity;
export const validateContinuity = checkStoryboardContinuity;
export const analyzeContinuity = checkStoryboardContinuity;
