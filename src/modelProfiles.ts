/**
 * Capability declarations for the video models supported by the prompt
 * adapter layer.  These are intentionally a little conservative: a missing
 * limit is represented by `undefined` and the corresponding capability has a
 * status of `unknown`, rather than being guessed from a third-party wrapper.
 */

export type CapabilityStatus = 'supported' | 'unsupported' | 'limited' | 'unknown';

export type ReferenceMediaType = 'image' | 'video' | 'audio' | 'clay-render';

export type ReferenceRole =
  | 'character'
  | 'scene'
  | 'prop'
  | 'style'
  | 'motion'
  | 'composition'
  | 'camera'
  | 'audio'
  | 'dialogue'
  | 'first-frame'
  | 'last-frame'
  | 'clay-render'
  | 'creative'
  | 'general';

export interface DurationCapability {
  /** Explicitly documented values, when a model only accepts a set of clips. */
  allowedSec?: readonly number[];
  minSec?: number;
  maxSec?: number;
  status: CapabilityStatus;
  note?: string;
}

export interface ReferenceDurationCapability {
  minSec?: number;
  maxSec?: number;
  status: CapabilityStatus;
  note?: string;
}

export interface ModelCapabilities {
  /** Modalities accepted as references in the target's generation workflow. */
  inputModalities: Record<ReferenceMediaType, CapabilityStatus>;
  /** Known per-modality reference-count limits. Undefined means not published. */
  maxReferences?: Partial<Record<ReferenceMediaType, number>>;
  /** Known total file-count limit across all reference modalities. */
  maxReferencesTotal?: number;
  /** Some models publish a limit for a semantic role rather than a modality. */
  maxReferencesByRole?: Partial<Record<ReferenceRole, number>>;
  duration: DurationCapability;
  /** Known duration rules for source reference clips (for example character clips). */
  referenceDurationByRole?: Partial<Record<ReferenceRole, ReferenceDurationCapability>>;
  /** Known per-file duration rules published for a reference media type. */
  referenceDurationByMediaType?: Partial<Record<ReferenceMediaType, ReferenceDurationCapability>>;
  /** Known cumulative duration limit for all references of one media type. */
  maxReferenceDurationTotalSec?: Partial<Record<ReferenceMediaType, number>>;
  supportedAspectRatios?: readonly string[];
  supportedResolutions?: readonly string[];
  nativeAudio: CapabilityStatus;
  firstLastFrame: CapabilityStatus;
  timestampControl: CapabilityStatus;
  extension: CapabilityStatus;
  /** Which semantic duties the target can normally make use of. */
  referenceRoles: readonly ReferenceRole[];
  /** A short provenance note shown in diagnostics and the UI. */
  evidence?: readonly string[];
}

export type PromptDetailMode = 'concise' | 'director' | 'detailed';

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  version: string;
  capabilities: ModelCapabilities;
  /** Preferred amount of prose in a compiled prompt. */
  promptPreference: 'concise' | 'detailed' | 'both';
  /** Syntax used to refer to uploaded/reference materials in prose. */
  referenceSyntax: 'at-token' | 'named' | 'bracketed' | 'natural-language';
  /** The parameter names used by common API surfaces, when known. */
  parameterHints: {
    duration: string;
    aspectRatio: string;
    resolution: string;
    audio: string;
  };
}

/** Public vocabulary aliases used by integrations and older design notes. */
export type TargetProfile = ModelProfile;
export type TargetCapabilities = ModelCapabilities;

const allRoles: readonly ReferenceRole[] = [
  'character', 'scene', 'prop', 'style', 'motion', 'composition', 'camera',
  'audio', 'dialogue', 'first-frame', 'last-frame', 'clay-render', 'creative', 'general'
];

const imageVideoAudio: Record<ReferenceMediaType, CapabilityStatus> = {
  image: 'supported',
  video: 'supported',
  audio: 'supported',
  'clay-render': 'unknown'
};

const textAndImage: Record<ReferenceMediaType, CapabilityStatus> = {
  image: 'supported',
  video: 'unknown',
  audio: 'unknown',
  'clay-render': 'unknown'
};

const imageOnly: Record<ReferenceMediaType, CapabilityStatus> = {
  image: 'supported',
  video: 'unknown',
  audio: 'unknown',
  'clay-render': 'unknown'
};

const runwayImage: Record<ReferenceMediaType, CapabilityStatus> = {
  image: 'supported',
  video: 'unknown',
  audio: 'unknown',
  'clay-render': 'unknown'
};

const soraModalities: Record<ReferenceMediaType, CapabilityStatus> = {
  image: 'limited',
  video: 'limited',
  audio: 'unknown',
  'clay-render': 'unknown'
};

/**
 * Static profiles.  Values are based on the vendors' public product/API
 * documentation available when this module was authored.  A profile is a
 * planning aid, not a guarantee that every web UI or account tier exposes the
 * same options.
 */
const MODEL_PROFILE_DEFINITIONS = {
  'minimax-h3': {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    provider: 'MiniMax',
    version: 'H3',
    capabilities: {
      inputModalities: imageVideoAudio,
      maxReferences: { image: 9, video: 3, audio: 3 },
      maxReferencesTotal: 12,
      referenceDurationByMediaType: {
        video: { minSec: 2, maxSec: 15, status: 'supported', note: '单段 2–15 秒。' },
        audio: { minSec: 2, maxSec: 15, status: 'supported', note: '单段 2–15 秒。' }
      },
      maxReferenceDurationTotalSec: { video: 15, audio: 15 },
      duration: {
        minSec: 4,
        maxSec: 15,
        status: 'supported',
        note: 'MiniMax H3 官方提示词指南要求目标视频为 4–15 秒。'
      },
      supportedResolutions: ['2K'],
      nativeAudio: 'supported',
      firstLastFrame: 'supported',
      timestampControl: 'supported',
      extension: 'unknown',
      referenceRoles: allRoles,
      evidence: [
        'MiniMax H3 官方提示词指南：目标视频时长为 4–15 秒，并使用内建视听时间线。',
        '官方多模态工作流支持最多 9 张图片、3 段视频、3 段音频，混合素材最多 12 个，并支持 2K 输出。',
        '官方资料要求参考视频和参考音频单段 2–15 秒，各类型累计不超过 15 秒。'
      ]
    },
    promptPreference: 'concise',
    referenceSyntax: 'natural-language',
    parameterHints: { duration: 'durationSec', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'audio' }
  },
  'seedance-2.0': {
    id: 'seedance-2.0',
    name: 'Seedance 2.0',
    provider: 'ByteDance',
    version: '2.0',
    capabilities: {
      inputModalities: imageVideoAudio,
      maxReferences: { image: 9, video: 3, audio: 3 },
      duration: {
        maxSec: 15,
        status: 'limited',
        note: '公开发布资料描述单次最高 15 秒；账号/API 形态可能不同。'
      },
      nativeAudio: 'supported',
      firstLastFrame: 'unknown',
      timestampControl: 'limited',
      extension: 'supported',
      referenceRoles: allRoles,
      evidence: [
        '官方发布：支持文本、图片、视频、音频四种输入。',
        '官方发布：单次最多 9 张图片、3 段视频、3 段音频，最高 15 秒。'
      ]
    },
    promptPreference: 'detailed',
    referenceSyntax: 'at-token',
    parameterHints: { duration: 'durationSec', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'audio' }
  },
  'seedance-2.5': {
    id: 'seedance-2.5',
    name: 'Seedance 2.5',
    provider: 'ByteDance',
    version: '2.5',
    capabilities: {
      inputModalities: { ...imageVideoAudio, 'clay-render': 'supported' },
      maxReferences: { image: 30, video: 10, audio: 10 },
      duration: {
        maxSec: 30,
        status: 'limited',
        note: '官方发布资料描述单次最高 30 秒，并支持多轮延展。'
      },
      nativeAudio: 'supported',
      firstLastFrame: 'limited',
      timestampControl: 'supported',
      extension: 'supported',
      referenceRoles: allRoles,
      evidence: [
        '官方发布：单次最多 30 张图片、10 段视频、10 段音频。',
        '官方发布：支持 clay render、动作等多模态参考和时间戳级编辑。'
      ]
    },
    promptPreference: 'detailed',
    referenceSyntax: 'at-token',
    parameterHints: { duration: 'durationSec', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'audio' }
  },
  'kling-3.0': {
    id: 'kling-3.0',
    name: 'Kling 3.0',
    provider: 'Kuaishou',
    version: '3.0',
    capabilities: {
      // Public product pages describe image/element references, but do not
      // publish a stable cross-endpoint count or video/audio input contract.
      inputModalities: { image: 'supported', video: 'unknown', audio: 'unknown', 'clay-render': 'unknown' },
      duration: { status: 'unknown', note: '不同入口和套餐的时长选项可能不同，请以目标入口为准。' },
      nativeAudio: 'unknown',
      firstLastFrame: 'limited',
      timestampControl: 'unknown',
      extension: 'unknown',
      referenceRoles: ['character', 'scene', 'prop', 'style', 'composition', 'general'],
      evidence: ['公开产品资料强调多图/元素参考；未将统一数量、时长、音频 API 限制作为稳定合同。']
    },
    promptPreference: 'both',
    referenceSyntax: 'at-token',
    parameterHints: { duration: 'duration', aspectRatio: 'aspect_ratio', resolution: 'resolution', audio: 'audio' }
  },
  'vidu-reference-to-video': {
    id: 'vidu-reference-to-video',
    name: 'Vidu Reference-to-Video',
    provider: 'Vidu',
    version: 'reference-to-video',
    capabilities: {
      inputModalities: imageOnly,
      maxReferences: { image: 7 },
      duration: { status: 'unknown', note: '参考生视频页面未在稳定公开合同中固定输出时长。' },
      nativeAudio: 'unknown',
      firstLastFrame: 'unknown',
      timestampControl: 'unknown',
      extension: 'unknown',
      referenceRoles: ['character', 'scene', 'prop', 'style', 'general'],
      evidence: ['官方参考生视频页面：上传最多 7 张参考图，用于角色、物体和场景一致性。']
    },
    promptPreference: 'concise',
    referenceSyntax: 'at-token',
    parameterHints: { duration: 'duration', aspectRatio: 'aspect_ratio', resolution: 'resolution', audio: 'audio' }
  },
  'veo-3.1': {
    id: 'veo-3.1',
    name: 'Veo 3.1',
    provider: 'Google',
    version: '3.1',
    capabilities: {
      inputModalities: textAndImage,
      duration: { allowedSec: [4, 6, 8], status: 'supported', note: 'Vertex AI/Google Cloud 公布 4、6、8 秒片段。' },
      supportedAspectRatios: ['16:9', '9:16'],
      supportedResolutions: ['720p', '1080p'],
      nativeAudio: 'supported',
      firstLastFrame: 'supported',
      timestampControl: 'unknown',
      extension: 'supported',
      referenceRoles: ['character', 'scene', 'prop', 'style', 'first-frame', 'last-frame', 'general'],
      evidence: [
        'Google Cloud 公布：720p/1080p、16:9/9:16、4/6/8 秒。',
        '官方指南描述 Ingredients to Video 和 First and Last Frame。'
      ]
    },
    promptPreference: 'detailed',
    referenceSyntax: 'natural-language',
    parameterHints: { duration: 'duration', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'generateAudio' }
  },
  'runway-gen-4': {
    id: 'runway-gen-4',
    name: 'Runway Gen-4',
    provider: 'Runway',
    version: 'Gen-4',
    capabilities: {
      inputModalities: runwayImage,
      maxReferences: { image: 1 },
      duration: { allowedSec: [5, 10], status: 'limited', note: 'Gen-4 提示指南以 5/10 秒镜头为主要工作单元。' },
      nativeAudio: 'unknown',
      firstLastFrame: 'limited',
      timestampControl: 'unknown',
      extension: 'supported',
      referenceRoles: ['character', 'scene', 'prop', 'style', 'first-frame', 'general'],
      evidence: ['Runway Gen-4 提示指南强调以输入图像作为视觉起点，并用简洁动作提示词驱动镜头。']
    },
    promptPreference: 'concise',
    referenceSyntax: 'bracketed',
    parameterHints: { duration: 'duration', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'audio' }
  },
  'sora-2': {
    id: 'sora-2',
    name: 'Sora 2',
    provider: 'OpenAI',
    version: '2',
    capabilities: {
      inputModalities: soraModalities,
      maxReferencesByRole: { character: 2 },
      referenceDurationByRole: {
        character: { minSec: 2, maxSec: 4, status: 'supported', note: '角色创建参考视频公开要求约 2–4 秒。' }
      },
      duration: { allowedSec: [4, 8, 12, 16, 20], status: 'supported', note: 'Sora 2 API 文档列出 4/8/12/16/20 秒。' },
      supportedAspectRatios: ['16:9', '9:16'],
      supportedResolutions: ['720p', '1080p', '1792x1024', '1024x1792', '1920x1080', '1080x1920'],
      nativeAudio: 'supported',
      firstLastFrame: 'unknown',
      timestampControl: 'unknown',
      extension: 'supported',
      referenceRoles: ['character', 'scene', 'prop', 'style', 'general'],
      evidence: [
        'OpenAI Sora 2 指南：seconds 可取 4、8、12、16、20。',
        '指南描述最多 2 个可复用 character references，以及 16:9/9:16 高分辨率输出。'
      ]
    },
    promptPreference: 'both',
    referenceSyntax: 'named',
    parameterHints: { duration: 'seconds', aspectRatio: 'size', resolution: 'size', audio: 'audio' }
  }
} satisfies Readonly<Record<string, ModelProfile>>;

/** Backwards-friendly aliases for callers that prefer a lower-case constant. */
export type TargetId = keyof typeof MODEL_PROFILE_DEFINITIONS;
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = MODEL_PROFILE_DEFINITIONS;
export const modelProfiles = MODEL_PROFILES;
export const TARGET_PROFILES = MODEL_PROFILES;
export const targetProfiles = MODEL_PROFILES;
export const modelProfileRegistry = MODEL_PROFILES;

const aliases: Record<string, TargetId> = {
  h3: 'minimax-h3',
  minimaxh3: 'minimax-h3',
  seedance20: 'seedance-2.0',
  seedance2: 'seedance-2.0',
  'seedance-2': 'seedance-2.0',
  seedance25: 'seedance-2.5',
  'seedance-2-5': 'seedance-2.5',
  'seedance-2_5': 'seedance-2.5',
  kling3: 'kling-3.0',
  kling30: 'kling-3.0',
  'kling-3': 'kling-3.0',
  'kling-3-0': 'kling-3.0',
  vidur2v: 'vidu-reference-to-video',
  'vidu-r2v': 'vidu-reference-to-video',
  'vidu-reference': 'vidu-reference-to-video',
  veo31: 'veo-3.1',
  'veo-3': 'veo-3.1',
  runwaygen4: 'runway-gen-4',
  'runway-gen4': 'runway-gen-4',
  sora2: 'sora-2'
};

const hasOwn = (record: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(record, key);

function canonicalizeTargetId(targetId: string): string {
  const normalized = String(targetId || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (hasOwn(MODEL_PROFILES, normalized)) return normalized;
  const compact = normalized.replace(/-/g, '');
  if (hasOwn(aliases, normalized)) return aliases[normalized];
  if (hasOwn(aliases, compact)) return aliases[compact];
  return normalized;
}

export function getModelProfile(targetId: string | undefined | null): ModelProfile | undefined {
  if (!targetId) return undefined;
  const id = canonicalizeTargetId(targetId);
  return hasOwn(MODEL_PROFILES, id) ? MODEL_PROFILES[id] : undefined;
}

export function resolveModelProfile(targetId: string | undefined | null): ModelProfile {
  return getModelProfile(targetId) || UNKNOWN_MODEL_PROFILE;
}

/** A safe fallback used when a new model is entered before its profile ships. */
export const UNKNOWN_MODEL_PROFILE: ModelProfile = {
  id: 'unknown',
  name: '未登记目标模型',
  provider: 'unknown',
  version: 'unknown',
  capabilities: {
    inputModalities: { image: 'unknown', video: 'unknown', audio: 'unknown', 'clay-render': 'unknown' },
    duration: { status: 'unknown' },
    nativeAudio: 'unknown',
    firstLastFrame: 'unknown',
    timestampControl: 'unknown',
    extension: 'unknown',
    referenceRoles: allRoles
  },
  promptPreference: 'both',
  referenceSyntax: 'natural-language',
  parameterHints: { duration: 'duration', aspectRatio: 'aspectRatio', resolution: 'resolution', audio: 'audio' }
};

export function isKnownTargetId(targetId: string | undefined | null): boolean {
  return Boolean(getModelProfile(targetId));
}

export function listModelProfiles(): readonly ModelProfile[] {
  return Object.values(MODEL_PROFILES);
}

export const modelProfileList = listModelProfiles;
