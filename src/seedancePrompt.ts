import type {
  PromptAdapterInput,
  PromptReferenceInput,
  ReferenceManifest,
  ReferenceManifestEntry,
  TargetParameters,
} from './promptAdapters';
import { translateVideoPromptToEnglish, type TranslateVideoPromptToEnglishOptions } from './promptTranslation';
import { STORY_CAUSALITY_TRANSLATION_RULE } from './storyCausalityRules';
import { assertVideoPromptHasNoInstructionLeak, isInternalVideoPromptConstraint } from './videoPromptInstructionLeak';
import { seedanceChineseWriterRule, SEEDANCE_PROMPT_STRATEGY_VERSION } from './seedancePromptRules';
import type { Seedance25Output } from './types';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';
import { VIDEO_SCENE_CONTEXT_RULE, type VideoSceneContext } from './videoSceneContext';
import { MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE } from './nsfwPromptRules';
import { hasNsfwDetailSignal } from './promptConstraints';
import { ADOPTED_VIDEO_EXPRESSION_RULE } from './videoCreativeDirection';
import { getPromptDialogues, getPromptQuoteSpans } from './promptDialogueLanguage';
import type { H3StagingShotMetadata } from './h3StagingMetadata';
import type { VideoPromptExecutionContext } from './videoPromptExecutionContext';

export interface OfficialSeedancePromptInput extends PromptAdapterInput {
  /** Request-local authority; ordinary target adaptation keeps confirmed timing. */
  stagingAuthority?: 'current-segment-action-retiming';
  /** Existing target prose is an action/sound source, never a fingerprint input. */
  existingPrompt?: string;
  /** Actual connection facts, independent of the authored format and source identity. */
  executionContext?: VideoPromptExecutionContext;
  /** Request authority only; not an authored section or a source-fingerprint input. */
  voiceFactScope?: 'source-grounded-new-draft' | 'preserve-confirmed-source';
  /** Complete read-only story/shot evidence used by this exact generation. */
  sourceEvidence?: Readonly<Record<string, unknown>>;
  /** Request-only understanding material; excluded from saved source identity. */
  sceneContext?: VideoSceneContext;
  /** Exact pre-fix identity with automatic image output IDs; never persisted. */
  legacySourceFingerprint?: string;
}

export interface SeedanceStagingDelivery {
  canonicalPrompt?: string;
  shotSourceIds?: string[][];
  shotMetadata?: Array<H3StagingShotMetadata | null>;
}

export interface Seedance25PromptCompilation {
  targetId: 'seedance-2.5';
  prompt: string;
  promptZh: string;
  promptEn?: string;
  durationSec: number;
  parameters: TargetParameters;
  referenceManifest: ReferenceManifest;
  warnings: string[];
  sourceFingerprint: string;
  /** Companion source returned in the same existing Chinese writer request. */
  stagingDelivery?: SeedanceStagingDelivery;
}

/**
 * Identity captured when an asynchronous Seedance request starts.  A result
 * may only be written back to the same project, chapter, and storyboard that
 * produced it.  The workspace epoch also rejects results from a project
 * switch even when two projects happen to reuse the same storyboard id.
 */
export interface SeedanceOutputSaveIdentity {
  projectId: string;
  workspaceEpoch: number;
  chapterId: string;
  storyboardId: string;
  storyboardUpdatedAt: number;
}

export const isSeedanceOutputSaveIdentityCurrent = (
  request: SeedanceOutputSaveIdentity,
  current: SeedanceOutputSaveIdentity,
): boolean => request.projectId === current.projectId
  && request.workspaceEpoch === current.workspaceEpoch
  && request.chapterId === current.chapterId
  && request.storyboardId === current.storyboardId
  && request.storyboardUpdatedAt === current.storyboardUpdatedAt;

/** Timestamp protects edits; the fingerprint also protects shared media/story facts. */
export const isSeedanceOutputSaveRequestCurrent = (
  request: SeedanceOutputSaveIdentity,
  current: SeedanceOutputSaveIdentity,
  requestFingerprint: string,
  currentFingerprint: string,
): boolean => isSeedanceOutputSaveIdentityCurrent(request, current)
  && Boolean(requestFingerprint) && requestFingerprint === currentFingerprint;

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Seedance prose can precede the first timeline row; the H3 cleaner would discard it. */
export const cleanSeedancePrompt = (value: string): string => value
  .replace(/^\uFEFF/u, '')
  .replace(/^\s*```(?:text|markdown)?\s*\r?\n/u, '')
  .replace(/\r?\n\s*```\s*$/u, '')
  .trim();

export const SEEDANCE_ENGLISH_TRANSLATION_RULE = [
  STORY_CAUSALITY_TRANSLATION_RULE,
  '本次输入是 Seedance 2.5 自然语言提示词，保持视频规格、参考素材职责、主体连续性、概述、连续时间轴与全局约束的完整结构；章节标题翻译为英文，不删除开头内容。',
  '完整中文源稿是唯一翻译依据：人物原名、每句原语言对白及其说话人、全部镜头起止值和顺序逐项保留，包括小数秒；不重新编排、缩短或四舍五入。候选校验时对照完整源稿修复上述项目，不能从内部占位符猜测或恢复内容。',
  '@Image N、@Video N、@Audio N、@Clay Render N 是完整参考素材标记；保留类型、空格、编号与对应职责，不重新编号。',
  '保持 Seedance 自然语言格式，不引入 MiniMax H3 专用section、[Shot N]、<Subject N>、<Picture N>、<d>或<sound>标签；声音和对白说明仍用自然语言。',
].join('\n');

export const translateSeedancePromptToEnglish = async ({ sourcePrompt, request, isCurrent }: Pick<TranslateVideoPromptToEnglishOptions, 'sourcePrompt' | 'request' | 'isCurrent'>): Promise<string> => {
  assertVideoPromptHasNoInstructionLeak(sourcePrompt, 'Seedance 中文源稿');
  const translate = (repair?: { candidateEnglishPrompt: string; deliveryIssue: string }): Promise<string> => translateVideoPromptToEnglish({
    sourcePrompt,
    promptFormat: 'seedance',
    isCurrent,
    request: (system, user, transport) => request(`${system}\n\n${SEEDANCE_ENGLISH_TRANSLATION_RULE}${repair
      ? '\n本次仅修复上一次英文交付中已指出的完整性问题。对照完整 sourcePrompt 修复 candidateEnglishPrompt，保留已正确内容，不重新导演；只返回完整 Seedance 英文正文，不返回 JSON、内部占位符或 H3 标签。' : ''}`,
    repair ? `<seedance_translation_repair_data>\n${JSON.stringify({ sourcePrompt, ...repair })
      .replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')}\n</seedance_translation_repair_data>` : user, transport),
    clean: cleanSeedancePrompt,
    // Natural-language Seedance is translated from the complete source, never
    // the legacy token dictionary. Valid delivery takes exactly one request.
    acceptAiAuthoredContent: true,
    reviewWithAi: false,
  });
  const candidate = await translate();
  try {
    return readSeedanceEnglishDelivery(sourcePrompt, candidate);
  } catch (error) {
    if (!(error instanceof SeedanceEnglishDeliveryError)) throw error;
    // Only a concrete delivery defect permits one source-aware repair. API
    // failures/cancellation are not retried and a second defect is surfaced.
    return readSeedanceEnglishDelivery(sourcePrompt, await translate({
      candidateEnglishPrompt: candidate, deliveryIssue: error.message,
    }));
  }
};

class SeedanceEnglishDeliveryError extends Error {}

const readSeedanceEnglishDelivery = (sourcePrompt: string, candidate: string): string => {
  const translated = cleanSeedancePrompt(candidate);
  if (!translated || /^\s*(?:\{|\[\s*\{|```)/u.test(translated)) {
    throw new SeedanceEnglishDeliveryError('Seedance 英文未返回完整自然语言正文，中文稿已保留，请仅重试英文。');
  }
  assertVideoPromptHasNoInstructionLeak(translated, 'Seedance 英文结果');
  const prose = maskVideoPictureReferenceLiterals(translated.replace(/<\/?(?:d|sound)>/giu, 'LH_H3_DELIVERY_TAG'));
  if (/^(?:subject_definitions|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:|\[Shot\s+\d+\]|<(?:Subject|Picture|Video|Audio)\s+\d+>|LH_H3_DELIVERY_TAG/gmu.test(prose)) {
    throw new SeedanceEnglishDeliveryError('Seedance 英文返回了 H3 专用结构，中文稿已保留，请仅重试英文。');
  }
  // Generic summary headings and standalone timecodes are also valid natural
  // language; only H3-specific sections/tags above establish a format defect.
  // Do not silently accept generated implementation tokens after leaving the
  // masker. Authored literal tokens already present in the source stay valid.
  const sourceTokens = new Set(sourcePrompt.match(/__LH_[A-Z_\d]*/giu) || []);
  if ((translated.match(/__LH_[A-Z_\d]*/giu) || []).some((token) => !sourceTokens.has(token))) {
    throw new SeedanceEnglishDeliveryError('Seedance 英文仍含新增的内部占位符，中文稿已保留，请仅重试英文。');
  }
  const referenceTokens = (prompt: string): string[] => (prompt.match(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu) || []).sort();
  if (JSON.stringify(referenceTokens(sourcePrompt)) !== JSON.stringify(referenceTokens(translated))) {
    throw new SeedanceEnglishDeliveryError('Seedance 英文翻译改变了参考素材编号，中文稿已保留，请重试英文。');
  }
  // Compare only explicit numeric time ranges, never infer or rewrite cuts.
  const timeRanges = (prompt: string): number[][] => Array.from(prompt.matchAll(
    /(?<![\d.:])((?:\d{1,2}:){0,2}\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|s)?\s*(?:[-–—~～至到]|\bto\b)\s*(?:第\s*)?((?:\d{1,2}:){0,2}\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|s)?(?![\da-z]|[.:]\d)/giu,
  )).filter((match) => match[2] || match[4] || (match[1].includes(':') && match[3].includes(':')))
    .map((match) => [match[1], match[3]].map((time) => time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0)));
  const sourceRanges = timeRanges(sourcePrompt);
  // Do not infer timings from arbitrary prose when the source has no explicit
  // numeric range that this reader can reliably compare.
  if (sourceRanges.length && JSON.stringify(sourceRanges) !== JSON.stringify(timeRanges(translated))) {
    throw new SeedanceEnglishDeliveryError('Seedance 英文翻译改变或遗漏了已确认时间范围，中文稿已保留，请仅重试英文。');
  }
  // Preserve literal utterances in source order without guessing speakers,
  // counting names or treating every quoted description as dialogue.
  const dialogue = getPromptDialogues(sourcePrompt).filter((line) => !line.translateToEnglish);
  const quotes = getPromptQuoteSpans(translated).map((quote) => quote.content);
  let quoteIndex = 0;
  for (const line of dialogue) {
    const found = quotes.indexOf(line.content, quoteIndex);
    if (found < 0) throw new SeedanceEnglishDeliveryError('Seedance 英文翻译遗漏或改变了原语言对白，中文稿已保留，请仅重试英文。');
    quoteIndex = found + 1;
  }
  return translated;
};

const finiteDuration = (value: unknown): number => {
  const duration = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 30;
};

const mediaTypeOf = (reference: PromptReferenceInput): 'image' | 'video' | 'audio' | 'clay-render' => {
  const value = clean(reference.mediaType || reference.type).toLowerCase();
  if (value.includes('clay')) return 'clay-render';
  if (value.includes('video') || value.includes('clip') || value === 'mp4' || value === 'mov') return 'video';
  if (value.includes('audio') || value.includes('sound') || value === 'mp3' || value === 'wav') return 'audio';
  return 'image';
};

const tokenPrefix = (mediaType: ReturnType<typeof mediaTypeOf>): string => ({
  image: '@Image',
  video: '@Video',
  audio: '@Audio',
  'clay-render': '@Clay Render',
}[mediaType]);

const normalizeReference = (
  reference: PromptReferenceInput,
  counters: Record<string, number>,
): ReferenceManifestEntry => {
  const mediaType = mediaTypeOf(reference);
  const prefix = tokenPrefix(mediaType);
  counters[mediaType] = (counters[mediaType] || 0) + 1;
  const index = counters[mediaType];
  const name = clean(reference.name) || clean(reference.fileName) || clean(reference.id) || `${prefix} ${index}`;
  const responsibility = clean(reference.responsibility)
    || clean(reference.visualAnchor)
    || clean(reference.description)
    || clean(reference.role)
    || '保持该参考素材的核心视觉或声音职责';
  return {
    index,
    id: clean(reference.id) || `${mediaType}-${index}`,
    name,
    mediaType,
    role: (clean(reference.referenceRole || reference.role) || 'general') as ReferenceManifestEntry['role'],
    token: `${prefix} ${index}`,
    responsibility,
    source: clean(reference.source || reference.sourceUrl || reference.url) || undefined,
    durationSec: typeof reference.durationSec === 'number' ? reference.durationSec : undefined,
    width: typeof reference.width === 'number' ? reference.width : undefined,
    height: typeof reference.height === 'number' ? reference.height : undefined,
    aspectRatio: clean(reference.aspectRatio) || undefined,
    targetBindings: Array.isArray(reference.targetBindings) ? reference.targetBindings.filter(Boolean) : [],
    label: `${prefix} ${index}：${name}`,
  };
};

const buildManifest = (input: PromptAdapterInput): ReferenceManifest => {
  const counters: Record<string, number> = {};
  const assets = (input.references || []).map((reference) => normalizeReference(reference, counters));
  const counts = assets.reduce<Record<string, number>>((result, asset) => {
    result[asset.mediaType] = (result[asset.mediaType] || 0) + 1;
    return result;
  }, {});
  const roles = assets.reduce<Record<string, number>>((result, asset) => {
    result[asset.role] = (result[asset.role] || 0) + 1;
    return result;
  }, {});
  const text = assets.length
    ? assets.map((asset) => `${asset.token}：${asset.name}（${asset.responsibility}）`).join('\n')
    : '本次没有绑定外部参考素材。';
  return {
    targetId: 'seedance-2.5',
    assets,
    entries: assets,
    items: assets,
    counts,
    byMediaType: counts,
    roleCounts: roles,
    byRole: roles,
    text,
  };
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const removeH3OnlySyntax = (value: string, warnings: string[]): string => {
  let output = value;
  if (/integrated_multimodal_description|\[Shot\s+\d+\]|<(?:Subject|Picture|Video|Audio)\s+\d+>/iu.test(output)) {
    warnings.push('输入中包含 MiniMax H3 专用标记，Seedance 输出已移除这些标记。');
    output = output
      .replace(/^\s*(?:integrated_multimodal_description|subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:\s*/gimu, '')
      .replace(/\[Shot\s+\d+\]/giu, '')
      .replace(/<(?:Subject|Picture|Video|Audio)\s+\d+>/giu, '')
      .replace(/\s{2,}/gu, ' ');
  }
  return output.trim();
};

const renderPrompt = (input: PromptAdapterInput, manifest: ReferenceManifest, warnings: string[]): string => {
  const durationSec = finiteDuration(input.durationSec);
  // The AI-confirmed canonical timeline owns story causality. This adapter
  // preserves that body; it never chooses an actor from reference metadata.
  const timeline = removeH3OnlySyntax(clean(input.canonicalPrompt), warnings) || '根据当前分镜计划连续呈现主体动作、镜头变化和声音事件。';
  const constraints = visibleSeedanceConstraints(input.constraints);
  const subjectDefinitions = (input.subjectDefinitions || [])
    .map((subject) => {
      const name = clean(subject.name);
      const description = clean(subject.description || subject.appearance || subject.outfit || subject.anchor);
      return name ? `${name}${description ? `：${description}` : ''}` : '';
    })
    .filter(Boolean);
  const specification = `视频规格：时长 ${durationSec} 秒；画面比例 ${clean(input.aspectRatio) || '16:9'}；分辨率 ${clean(input.resolution) || '按项目设置'}；声音模式 ${clean(input.audioMode) || '按剧情设置'}。`;
  const references = manifest.text;
  const subjects = subjectDefinitions.length
    ? `\n主体连续性：\n${subjectDefinitions.map((item) => `- ${item}`).join('\n')}`
    : '';
  const global = constraints.length
    ? constraints.map((item) => `- ${item}`).join('\n')
    : '- 保持人物、场景、道具、运动方向、光线和声音连续；不添加未指定的主体、对白或事件。';
  return [
    specification,
    '',
    '参考素材与职责：',
    references,
    subjects,
    '',
    '一句话概述：',
    timeline.split(/\r?\n/u).find((line) => clean(line)) || timeline,
    '',
    `连续时间轴（覆盖 0–${durationSec} 秒）：`,
    timeline,
    '',
    '全局约束：',
    global,
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n').trim();
};

export const buildOfficialSeedanceReferences = (
  references: readonly PromptReferenceInput[] | undefined,
): PromptReferenceInput[] => [...(references || [])];

const visibleSeedanceConstraints = (constraints: PromptAdapterInput['constraints']): string[] => (constraints || [])
  .map(clean).filter((value) => value && !isInternalVideoPromptConstraint(value));

const stableEvidenceValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableEvidenceValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableEvidenceValue(item)]));
};

export const getOfficialSeedanceSourceFingerprint = (input: OfficialSeedancePromptInput): string => stableHash(JSON.stringify(stableEvidenceValue({
  targetId: 'seedance-2.5',
  strategyVersion: SEEDANCE_PROMPT_STRATEGY_VERSION,
  canonicalPrompt: input.canonicalPrompt,
  durationSec: finiteDuration(input.durationSec),
  aspectRatio: input.aspectRatio,
  resolution: input.resolution,
  audioMode: input.audioMode,
  references: (input.references || []).map((reference) => ({ ...reference, targetBindings: reference.targetBindings || [], tags: reference.tags || [] })),
  subjectDefinitions: input.subjectDefinitions || [],
  shotPrivateDetails: input.shotPrivateDetails || [],
  constraints: input.constraints || [],
  sourceEvidence: input.sourceEvidence,
})));

export const hasMatchingSeedanceSourceFingerprint = (input: OfficialSeedancePromptInput, fingerprint: string): boolean =>
  fingerprint === getOfficialSeedanceSourceFingerprint(input)
  || Boolean(input.legacySourceFingerprint && fingerprint === input.legacySourceFingerprint);

export const compileOfficialSeedancePrompt = (
  input: PromptAdapterInput,
): Seedance25PromptCompilation => {
  assertVideoPromptHasNoInstructionLeak(input.canonicalPrompt, 'Seedance 镜头源稿');
  const warnings: string[] = [];
  const durationSec = finiteDuration(input.durationSec);
  const referenceManifest = buildManifest(input);
  if (durationSec !== Number(input.durationSec)) warnings.push('时长为空或无效，已使用默认 30 秒。');
  if (durationSec > 30) warnings.push('当前 Seedance 服务入口的公开能力可能与所选时长不同；本稿保留用户设置，不截断、不强制分段。');
  if ((input.references || []).some((reference) => !clean(reference.responsibility || reference.visualAnchor || reference.description || reference.role))) {
    warnings.push('部分参考素材缺少明确职责，已使用通用连续性职责。');
  }
  if ((input.constraints || []).some(isInternalVideoPromptConstraint)) warnings.push('内部生成规则已与画面要求分开，仅将剧情、参考素材职责和画面约束写入 Seedance 正文。');
  const normalizedInput: PromptAdapterInput = { ...input, durationSec };
  const promptZh = renderPrompt(normalizedInput, referenceManifest, warnings);
  assertVideoPromptHasNoInstructionLeak(promptZh, 'Seedance 中文结果');
  const sourceFingerprint = getOfficialSeedanceSourceFingerprint(normalizedInput);
  return {
    targetId: 'seedance-2.5',
    prompt: promptZh,
    promptZh,
    durationSec,
    parameters: {
      model: 'seedance-2.5',
      durationSec,
      aspectRatio: clean(input.aspectRatio) || '16:9',
      resolution: clean(input.resolution) || '按项目设置',
      audioMode: clean(input.audioMode) || '按剧情设置',
      duration: durationSec,
      seconds: String(durationSec),
    },
    referenceManifest,
    warnings,
    sourceFingerprint,
  };
};

const seedanceHeadings = ['视频规格', '参考素材与职责', '主体连续性', '一句话概述', '连续时间轴', '全局约束'];
const seedanceReferenceTokens = (prompt: string): string[] => prompt.match(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu) || [];

/** Delivery checks only; motion/story quality remains the writer's responsibility. */
export const assertSeedanceWriterDelivery = (prompt: string, manifest: ReferenceManifest): void => {
  assertVideoPromptHasNoInstructionLeak(prompt, 'Seedance 中文结果');
  let previous = -1;
  for (const heading of seedanceHeadings) {
    const expression = new RegExp(`^(?:#{1,3}\\s*)?${heading}(?:[（(][^\\r\\n]*?[）)])?\\s*(?:[：:]|$)`, 'mu');
    const position = prompt.search(expression);
    if (position <= previous) throw new Error('Seedance 中文返回缺少完整的六个自然语言章节，原保存稿已保留，请重新生成。');
    previous = position;
  }
  // The shared masker also hides entire H3 dialogue payloads. Mark delimiters
  // first so actual quoted screen text stays literal while unquoted H3 tags fail.
  const prose = maskVideoPictureReferenceLiterals(prompt.replace(/<\/?(?:d|sound)>/giu, 'LH_H3_DELIVERY_TAG'));
  if (/^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:|\[Shot\s+\d+\]|^\s*At\s+\d{2}:\d{2}\.\d{3}|<(?:Subject|Picture|Video|Audio)\s+\d+>|LH_H3_DELIVERY_TAG/gmu.test(prose)) {
    throw new Error('Seedance 中文返回使用了 H3 专用结构，原保存稿已保留，请重新生成。');
  }
  const allowed = new Set(manifest.assets.map((asset) => asset.token));
  const used = new Set(seedanceReferenceTokens(prompt));
  if ([...used].some((token) => !allowed.has(token)) || [...allowed].some((token) => !used.has(token))) {
    throw new Error('Seedance 中文返回改变或遗漏了真实参考素材编号，原保存稿已保留，请重新生成。');
  }
};

export interface GenerateOfficialSeedancePromptOptions {
  input: OfficialSeedancePromptInput;
  request: TranslateVideoPromptToEnglishOptions['request'];
  isCurrent?: () => boolean;
}

const assertSeedanceRequestCurrent = (isCurrent?: () => boolean): void => {
  if (isCurrent && !isCurrent()) {
    const error = new Error('当前项目、章节、分镜或参考素材已变化，Seedance 提示词未保存，请在当前分镜重新生成。');
    error.name = 'AbortError';
    throw error;
  }
};

/** One Chinese text-model call. The compiler supplies metadata, never the delivered body. */
export const generateOfficialSeedancePrompt = async ({ input, request, isCurrent }: GenerateOfficialSeedancePromptOptions): Promise<Seedance25PromptCompilation> => {
  assertSeedanceRequestCurrent(isCurrent);
  const metadata = compileOfficialSeedancePrompt(input);
  // Keep the saved fingerprint inputs intact, while the writer receives the
  // adopted shots rather than the original menu of directing preferences.
  const { creativeDirection: _creativeDirection, directorStyleSummary: _directorStyleSummary,
    extraRequirement: _extraRequirement, ...adoptedSourceEvidence } = input.sourceEvidence || {};
  const expressionSourceEvidence: Record<string, unknown> = { ...adoptedSourceEvidence };
  const sequenceContext = adoptedSourceEvidence.sequenceSegmentContext;
  if (sequenceContext && typeof sequenceContext === 'object' && !Array.isArray(sequenceContext)) {
    const { creativeDirection: _planningPreferences, ...adoptedContext } = sequenceContext as Record<string, unknown>;
    expressionSourceEvidence.sequenceSegmentContext = adoptedContext;
  }
  const evidence = {
    taskAuthority: input.stagingAuthority ? 'current-segment-staging-replan' : 'preserve-confirmed-schedule',
    ...(input.stagingAuthority ? { revisionScope: input.stagingAuthority } : {}),
    ...(input.existingPrompt ? { candidatePrompt: input.existingPrompt } : {}),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}),
    voiceFactScope: input.voiceFactScope || 'source-grounded-new-draft',
    canonicalPrompt: input.canonicalPrompt,
    sourceEvidence: expressionSourceEvidence,
    ...(input.sceneContext ? { sceneContext: structuredClone(input.sceneContext) } : {}),
    specification: { durationSec: metadata.durationSec, aspectRatio: input.aspectRatio, resolution: input.resolution, audioMode: input.audioMode },
    subjectDefinitions: (input.subjectDefinitions || []).map((subject) => {
      if (subject.kind !== 'character') return subject;
      const { motion: _defaultMotion, ...identity } = subject;
      return identity;
    }),
    references: input.references || [],
    referenceManifest: metadata.referenceManifest.assets,
    shotPrivateDetails: input.shotPrivateDetails || [],
    constraints: visibleSeedanceConstraints(input.constraints),
  };
  const nsfwVideoActionRule = hasNsfwDetailSignal(
    input.nsfwDetail ? 'NSFW' : '',
    input.canonicalPrompt,
    JSON.stringify(input.sourceEvidence || ''),
    ...(input.constraints || []),
  ) ? MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE : '';
  const response = await request([seedanceChineseWriterRule(Boolean(input.stagingAuthority)), ADOPTED_VIDEO_EXPRESSION_RULE, VIDEO_SCENE_CONTEXT_RULE, nsfwVideoActionRule,
    input.executionContext ? 'executionContext只提供已选视频连接的事实，与稿件格式独立。unknown表示未获知，模型或工作流名称不证明能力；不虚构参考媒体、不因此改剧情、动作、次数或固定时长，不把这些内部连接字段写进正文。' : '',
  ].filter(Boolean).join('\n\n'),
    `<seedance_source_data>\n${JSON.stringify(evidence, null, 2).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')}\n</seedance_source_data>\n依据以上当前证据返回完整 Seedance 中文成稿。`);
  assertSeedanceRequestCurrent(isCurrent);
  // Deserialize the requested envelope only. The writer owns timing and
  // content; no extra review, semantic gate or recovery request is introduced.
  const delivery = input.stagingAuthority ? JSON.parse(response.trim()
    .replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')) as SeedanceStagingDelivery & { seedancePrompt: string } : undefined;
  const promptZh = cleanSeedancePrompt(delivery ? delivery.seedancePrompt : response);
  assertSeedanceWriterDelivery(promptZh, metadata.referenceManifest);
  return { ...metadata, prompt: promptZh, promptZh, sourceFingerprint: getOfficialSeedanceSourceFingerprint(input),
    ...(delivery ? { stagingDelivery: { canonicalPrompt: delivery.canonicalPrompt,
      shotSourceIds: delivery.shotSourceIds, shotMetadata: delivery.shotMetadata } } : {}) };
};

export interface GenerateSeedanceBilingualOutputOptions extends GenerateOfficialSeedancePromptOptions {
  /** Adopt the common source before assigning the Chinese/English fingerprint. */
  onStaging?: (delivery: SeedanceStagingDelivery) => { sourceFingerprint: string; warnings?: string[] };
  /** Save the qualified Chinese immediately and advance only this own checkpoint identity. */
  onChinese: (output: Seedance25Output) => boolean | Promise<boolean>;
  onEnglish: (output: Seedance25Output) => boolean | Promise<boolean>;
}

export const generateSeedanceBilingualOutput = async ({ input, request, isCurrent, onChinese, onEnglish, onStaging }: GenerateSeedanceBilingualOutputOptions): Promise<Seedance25Output> => {
  const compiled = await generateOfficialSeedancePrompt({ input, request, isCurrent });
  const adopted = compiled.stagingDelivery ? onStaging?.(compiled.stagingDelivery) : undefined;
  const chinese: Seedance25Output = {
    targetId: 'seedance-2.5', promptZh: compiled.promptZh, durationSec: compiled.durationSec,
    sourceFingerprint: adopted?.sourceFingerprint || compiled.sourceFingerprint, referenceManifest: compiled.referenceManifest.assets.map((asset) => ({ ...asset })),
    warnings: [...compiled.warnings, ...(adopted?.warnings || [])], generatedAt: Date.now(), englishError: '',
  };
  if (!await onChinese(chinese)) assertSeedanceRequestCurrent(() => false);
  assertSeedanceRequestCurrent(isCurrent);
  let output: Seedance25Output;
  try {
    const promptEn = await translateSeedancePromptToEnglish({ sourcePrompt: chinese.promptZh, request, isCurrent });
    output = { ...chinese, promptEn, englishSourceFingerprint: chinese.sourceFingerprint };
  } catch (error) {
    assertSeedanceRequestCurrent(isCurrent);
    if (error instanceof Error && error.name === 'AbortError') throw error;
    output = { ...chinese, englishError: error instanceof Error ? error.message : '英文版 Seedance 提示词生成失败。' };
  }
  if (!await onEnglish(output)) assertSeedanceRequestCurrent(() => false);
  return output;
};
