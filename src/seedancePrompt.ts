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
  '@Image N、@Video N、@Audio N、@Clay Render N 是完整参考素材标记；保留类型、空格、编号与对应职责，不重新编号。',
  '保持 Seedance 自然语言格式，不引入 MiniMax H3 专用section、[Shot N]、<Subject N>、<Picture N>、<d>或<sound>标签；声音和对白说明仍用自然语言。',
].join('\n');

export const translateSeedancePromptToEnglish = async ({ sourcePrompt, request }: Pick<TranslateVideoPromptToEnglishOptions, 'sourcePrompt' | 'request'>): Promise<string> => {
  assertVideoPromptHasNoInstructionLeak(sourcePrompt, 'Seedance 中文源稿');
  const translated = await translateVideoPromptToEnglish({
    sourcePrompt,
    request: (system, user, transport) => request(`${system}\n\n${SEEDANCE_ENGLISH_TRANSLATION_RULE}`, user, transport),
    clean: cleanSeedancePrompt,
    reviewWithAi: false,
  });
  assertVideoPromptHasNoInstructionLeak(translated, 'Seedance 英文结果');
  const referenceTokens = (prompt: string): string[] => (prompt.match(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu) || []).sort();
  if (JSON.stringify(referenceTokens(sourcePrompt)) !== JSON.stringify(referenceTokens(translated))) {
    throw new Error('Seedance 英文翻译改变了参考素材编号，中文稿已保留，请重试英文。');
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

export const getOfficialSeedanceSourceFingerprint = (input: PromptAdapterInput): string => stableHash(JSON.stringify({
  targetId: 'seedance-2.5',
  canonicalPrompt: input.canonicalPrompt,
  durationSec: finiteDuration(input.durationSec),
  aspectRatio: input.aspectRatio,
  resolution: input.resolution,
  audioMode: input.audioMode,
  references: input.references || [],
  subjectDefinitions: input.subjectDefinitions || [],
  constraints: input.constraints || [],
}));

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

export type OfficialSeedancePromptInput = PromptAdapterInput;
