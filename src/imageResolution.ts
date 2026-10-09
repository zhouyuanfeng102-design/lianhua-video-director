import type { ImageApiConfig } from './types';

export type ImageResolutionTier = '1K' | '2K' | '4K';
export type ImageResolutionProfile = 'auto' | 'pixel-long-edge' | 'gpt-image-legacy' | 'gpt-image-modern' | 'gemini-k' | 'gemini-1k' | 'grok-k';
export type ImageResolutionProtocol = 'openai-compatible' | 'openai-images' | 'gemini' | 'xai';
export type ImageResolutionEncoding =
  | { kind: 'width-height'; width: number; height: number }
  | { kind: 'size'; value: string }
  | { kind: 'tier'; value: ImageResolutionTier };

/** Frozen, credential-free execution facts. A retry must use this plan as saved. */
export interface ImageResolutionPlan {
  version: 1;
  tier: ImageResolutionTier | 'custom' | 'default' | 'legacy';
  logicalAspectRatio: string;
  expected: { width: number; height: number };
  encoding: ImageResolutionEncoding;
  profile: ImageResolutionProfile;
  verified: boolean;
}

/** Technical storage/input limit, independent of a provider's smaller limit. */
export const IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE = 16384;
const TIERS: readonly ImageResolutionTier[] = ['1K', '2K', '4K'];
const PROFILES: readonly ImageResolutionProfile[] = ['auto', 'pixel-long-edge', 'gpt-image-legacy', 'gpt-image-modern', 'gemini-k', 'gemini-1k', 'grok-k'];
const PROTOCOLS: readonly ImageResolutionProtocol[] = ['openai-compatible', 'openai-images', 'gemini', 'xai'];
const EDGES = { '1K': 1024, '2K': 2048, '4K': 4096 } as const;
type ResolutionConfig = Pick<ImageApiConfig, 'backend' | 'model'> & {
  imageProtocol?: ImageResolutionProtocol;
  imageResolutionProfile?: ImageResolutionProfile;
  imageSupportedResolutions?: ImageResolutionTier[];
  imagePixelStep?: number;
};
export type ImageResolutionConfigInput = ImageApiConfig | ImageApiConfig['backend'];

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 64 && value <= IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE;
const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};
export const imageResolutionAspectRatio = (width: number, height: number): string => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return '';
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};
const parseAspect = (value: string): { width: number; height: number; ratio: number; label: string } | undefined => {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/u);
  if (!match) return undefined;
  const width = Number(match[1]); const height = Number(match[2]);
  const ratio = width / height;
  if (!Number.isFinite(ratio) || width <= 0 || height <= 0 || ratio < 0.001 || ratio > 1000) return undefined;
  return { width, height, ratio, label: `${width}:${height}` };
};

export const normalizeImageResolutionPlan = (value: unknown): ImageResolutionPlan | undefined => {
  if (!object(value) || value.version !== 1 || typeof value.verified !== 'boolean'
    || ![...TIERS, 'custom', 'default', 'legacy'].includes(String(value.tier))
    || !PROFILES.includes(value.profile as ImageResolutionProfile)
    || typeof value.logicalAspectRatio !== 'string' || value.logicalAspectRatio.length > 80 || !parseAspect(value.logicalAspectRatio)
    || !object(value.expected) || !dimension(value.expected.width) || !dimension(value.expected.height)
    || !object(value.encoding)) return undefined;
  const { width, height } = value.expected;
  let encoding: ImageResolutionEncoding;
  if (value.encoding.kind === 'width-height' && value.encoding.width === width && value.encoding.height === height) {
    encoding = { kind: 'width-height', width, height };
  } else if (value.encoding.kind === 'size' && value.encoding.value === `${width}x${height}`) {
    encoding = { kind: 'size', value: value.encoding.value };
  } else if (value.encoding.kind === 'tier' && TIERS.includes(value.encoding.value as ImageResolutionTier)
    && (value.tier === 'custom' || value.tier === value.encoding.value)) {
    encoding = { kind: 'tier', value: value.encoding.value as ImageResolutionTier };
  } else return undefined;
  return { version: 1, tier: value.tier as ImageResolutionPlan['tier'], logicalAspectRatio: value.logicalAspectRatio,
    expected: { width, height }, encoding, profile: value.profile as ImageResolutionProfile, verified: value.verified };
};

/** Official native sizes: the nominal ratio is not an exact integer ratio. */
export const GEMINI_IMAGE_RESOLUTION_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024], '2:3': [848, 1264], '3:2': [1264, 848],
  '3:4': [896, 1200], '4:3': [1200, 896], '9:16': [768, 1376], '16:9': [1376, 768],
};
export const GEMINI_FLASH_IMAGE_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832],
  '3:4': [864, 1184], '4:3': [1184, 864], '9:16': [768, 1344], '16:9': [1344, 768],
};
const canonicalAspect = (value: string): string => {
  const aspect = parseAspect(value);
  if (!aspect) return value;
  return Object.keys(GEMINI_IMAGE_RESOLUTION_SIZES).find((key) => {
    const [w, h] = key.split(':').map(Number);
    return Math.abs(aspect.ratio - w / h) < 1e-8;
  }) || aspect.label;
};
const configFields = (input: ImageResolutionConfigInput): ResolutionConfig => typeof input === 'string' ? { backend: input, model: '' } : input;
export interface ImageResolutionCapabilities {
  profile: Exclude<ImageResolutionProfile, 'auto'>;
  protocol: ImageResolutionProtocol;
  pixelStep: number;
  supportedTiers: ImageResolutionTier[];
  verified: boolean;
  note: string;
}
export const resolveImageResolutionCapabilities = (input: ImageResolutionConfigInput): ImageResolutionCapabilities => {
  const config = configFields(input);
  const protocol = PROTOCOLS.includes(config.imageProtocol as ImageResolutionProtocol) ? config.imageProtocol! : 'openai-compatible';
  const model = config.model.trim().toLowerCase();
  const explicit = config.imageResolutionProfile && config.imageResolutionProfile !== 'auto' && PROFILES.includes(config.imageResolutionProfile);
  let profile: Exclude<ImageResolutionProfile, 'auto'> = 'pixel-long-edge';
  if (explicit) profile = config.imageResolutionProfile as Exclude<ImageResolutionProfile, 'auto'>;
  else if (config.backend === 'openai') {
    if (/^gemini-2\.5-flash-image(?:-preview)?$|^nano[-_ ]?banana$/u.test(model)) profile = 'gemini-1k';
    else if (/gemini.*image|nano[-_ ]?banana/u.test(model) || protocol === 'gemini') profile = 'gemini-k';
    else if (/grok.*(?:image|imagine)/u.test(model) || protocol === 'xai') profile = 'grok-k';
    else if (/gpt[-_ ]?image[-_ ]?2(?:[.-]5)?|sunburst/u.test(model)) profile = 'gpt-image-modern';
    else if (/gpt[-_ ]?image[-_ ]?1/u.test(model)) profile = 'gpt-image-legacy';
  }
  const step = Number.isSafeInteger(config.imagePixelStep) && config.imagePixelStep! >= 1 && config.imagePixelStep! <= 1024
    ? config.imagePixelStep!
    : profile === 'gpt-image-modern' ? 16 : config.backend === 'novelai' ? 64
      : config.backend === 'sd_webui' || config.backend === 'comfyui' ? 8 : 1;
  const nativeTiers: ImageResolutionTier[] = profile === 'gemini-1k' || profile === 'gpt-image-legacy' ? ['1K']
    : profile === 'grok-k' ? ['1K', '2K'] : [...TIERS];
  const declared = config.imageSupportedResolutions;
  const localBackend = config.backend === 'comfyui' || config.backend === 'sd_webui' || config.backend === 'novelai';
  const supportedTiers = Array.isArray(declared) ? nativeTiers.filter((tier) => declared.includes(tier))
    : localBackend ? ['1K' as const] : nativeTiers;
  const official = protocol === 'gemini' && /^gemini-(?:3|3\.1)-(?:pro|flash)-image(?:-preview)?$/u.test(model)
    || protocol === 'gemini' && /^gemini-2\.5-flash-image(?:-preview)?$/u.test(model)
    || protocol === 'openai-images' && model === 'gpt-image-2'
    || protocol === 'openai-images' && /^gpt-image-1(?:\.5|-mini)?$/u.test(model);
  const verified = profile !== 'pixel-long-edge' && Boolean(official);
  const note = profile === 'pixel-long-edge'
    ? `本机档位按长边1024/2048/4096映射；${config.backend === 'comfyui' ? '模型支持范围仍由当前工作流决定' : '通道实际支持范围尚未验证'}。`
    : verified ? '按当前模型的原生分辨率规格提交。'
      : '采用所选模型能力档案；当前通道或模型别名尚未验证，实际尺寸以返回图片为准。';
  return { profile, protocol, pixelStep: step, supportedTiers, verified, note };
};

const nativeSize = (profile: ImageResolutionCapabilities['profile'], tier: ImageResolutionTier, aspect: string): { width: number; height: number } | undefined => {
  const table = profile === 'gemini-1k' ? GEMINI_FLASH_IMAGE_SIZES : GEMINI_IMAGE_RESOLUTION_SIZES;
  const pair = table[canonicalAspect(aspect)];
  if (!pair) return undefined;
  const scale = tier === '4K' ? 4 : tier === '2K' ? 2 : 1;
  return { width: pair[0] * scale, height: pair[1] * scale };
};
/** Used for frozen private/full-body records; only known native sizes are exempt. */
export const isKnownNativeImageAspectSize = (width: number, height: number, logicalAspect: string): boolean => {
  if (!dimension(width) || !dimension(height)) return false;
  return (['gemini-k', 'gemini-1k'] as const).some((profile) => TIERS.some((tier) => {
    if (profile === 'gemini-1k' && tier !== '1K') return false;
    const size = nativeSize(profile, tier, logicalAspect);
    return size?.width === width && size.height === height;
  }));
};
const pixelWarning = (width: number, height: number, capabilities: ImageResolutionCapabilities): string => {
  const { profile, pixelStep } = capabilities;
  if (profile === 'gpt-image-modern') {
    if (Math.max(width, height) > 3840 || width * height > 8_294_400 || width * height < 655_360
      || Math.max(width / height, height / width) > 3 || width % 16 || height % 16) {
      return '当前 GPT Image 档案建议边长不超过3840、总像素655360–8294400、宽高比不超过3:1且宽高为16的倍数；本次仍按所选像素提交，由后端决定是否支持。';
    }
  } else if (profile === 'gpt-image-legacy' && ![[1024, 1024], [1536, 1024], [1024, 1536]].some(([w, h]) => w === width && h === height)) {
    return '当前 GPT Image 旧模型已知原生规格为1024×1024、1536×1024、1024×1536；本次仍按所选像素提交，由后端决定是否支持。';
  } else if (profile === 'pixel-long-edge' && (width % pixelStep || height % pixelStep)) {
    return `当前后端建议宽、高为${pixelStep}的倍数；本次按输入原样提交，由后端决定是否支持。`;
  }
  return '';
};
const protocolIssue = (capabilities: ImageResolutionCapabilities, backend: ImageApiConfig['backend']): string => {
  if (backend !== 'openai' && capabilities.protocol !== 'openai-compatible') return '当前本机后端不能使用云端图片协议，请恢复对应后端配置。';
  if (capabilities.protocol === 'gemini' && !['gemini-k', 'gemini-1k'].includes(capabilities.profile)) return 'Gemini协议必须选择Gemini原生分辨率档案，不能使用其他模型档案。';
  if (capabilities.protocol === 'xai' && capabilities.profile !== 'grok-k') return 'xAI协议必须选择Grok原生分辨率档案。';
  if (capabilities.protocol === 'openai-images' && !['gpt-image-legacy', 'gpt-image-modern', 'pixel-long-edge'].includes(capabilities.profile)) return 'OpenAI Images协议与所选模型分辨率档案不匹配，请检查配置。';
  return '';
};

export interface ResolvedImageResolution {
  width: number;
  height: number;
  issue: string;
  warning?: string;
  layoutNote: string;
  resolutionPlan?: ImageResolutionPlan;
}
export interface ResolveImageResolutionInput {
  tier: ImageResolutionTier | 'custom';
  logicalAspectRatio: string;
  width?: number;
  height?: number;
  exactAspect?: boolean;
  config: ImageResolutionConfigInput;
}
const dimensionEncoding = (capabilities: ImageResolutionCapabilities, config: ResolutionConfig, width: number, height: number, nativeTier?: ImageResolutionTier): ImageResolutionEncoding => {
  if ((capabilities.protocol === 'gemini' || capabilities.protocol === 'xai') && nativeTier) return { kind: 'tier', value: nativeTier };
  return config.backend === 'openai' ? { kind: 'size', value: `${width}x${height}` } : { kind: 'width-height', width, height };
};

export const resolveImageResolution = (input: ResolveImageResolutionInput): ResolvedImageResolution => {
  const config = configFields(input.config); const capabilities = resolveImageResolutionCapabilities(input.config);
  let aspect = parseAspect(input.logicalAspectRatio);
  let width = input.width ?? 0; let height = input.height ?? 0; let issue = protocolIssue(capabilities, config.backend); let alignment = '';
  const warnings: string[] = [];
  let encodedTier: ImageResolutionTier | undefined = input.tier === 'custom' ? undefined : input.tier;
  if (issue) return { width, height, issue, layoutNote: '' };
  if (!aspect) return { width, height, issue: '生图画面比例无效，无法计算所选分辨率；不会自动降档。', layoutNote: '' };
  const requestedAspect = aspect;
  if (input.tier !== 'custom' && !capabilities.supportedTiers.includes(input.tier)) warnings.push(`当前模型或工作流未声明支持${input.tier}原生生图；仍按所选档位提交，由后端决定是否支持，不自动降档或执行放大。`);
  if (input.tier === 'custom') {
    if (!dimension(width) || !dimension(height)) return { width, height, issue: `宽、高须为64–${IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE}之间的整数像素；不会自动降档。`, layoutNote: '' };
    aspect = parseAspect(imageResolutionAspectRatio(width, height))!;
    if (capabilities.profile.startsWith('gemini')) {
        const nativeAspect = Object.keys(GEMINI_IMAGE_RESOLUTION_SIZES).find((candidate) => TIERS.some((tier) => {
          const size = nativeSize(capabilities.profile, tier, candidate);
          return size?.width === width && size.height === height;
        }));
        if (nativeAspect) aspect = parseAspect(nativeAspect)!;
      const aspectLabel = aspect.label;
      encodedTier = TIERS.find((tier) => {
        const size = nativeSize(capabilities.profile, tier, aspectLabel);
        return size?.width === width && size.height === height;
      });
      if (!encodedTier) warnings.push(capabilities.protocol === 'gemini'
        ? 'Gemini原生接口仅提供档位控制，自定义像素作为画面要求提交，实际像素以服务返回为准，无法保证精确自定义尺寸。'
        : '当前 Gemini 档案没有该自定义尺寸的原生档位；按自定义size像素参数提交，由后端决定是否支持，实际尺寸以返回图片为准。');
      else if (!capabilities.supportedTiers.includes(encodedTier)) warnings.push(`当前模型未声明支持${encodedTier}档位；仍按该自定义尺寸对应的档位提交，由后端决定是否支持。`);
    }
    if (capabilities.protocol === 'xai') warnings.push('xAI原生接口仅提供档位控制，自定义像素作为画面要求提交，实际像素以服务返回为准，无法保证精确自定义尺寸。');
  } else if (capabilities.profile === 'gemini-k' || capabilities.profile === 'gemini-1k') {
      const size = nativeSize(capabilities.profile, input.tier, aspect.label);
      if (size) ({ width, height } = size);
      else {
        const longSide = EDGES[input.tier];
        const shortSide = Math.round(longSide / Math.max(aspect.ratio, 1 / aspect.ratio));
        width = aspect.ratio >= 1 ? longSide : shortSide; height = aspect.ratio >= 1 ? shortSide : longSide;
        encodedTier = undefined;
        warnings.push(capabilities.protocol === 'gemini'
          ? 'Gemini原生接口仅提供档位控制，该画幅的估算像素作为画面要求提交，实际像素以服务返回为准。'
          : '当前 Gemini 档案没有该画幅的已知原生尺寸；按所选档位估算像素并以size参数提交，由后端决定是否支持。');
      }
  } else if (capabilities.profile === 'gpt-image-legacy' && input.tier === '1K' && ['1:1', '3:2', '2:3'].includes(canonicalAspect(aspect.label))) {
    const key = canonicalAspect(aspect.label);
    const size = key === '1:1' ? { width: 1024, height: 1024 } : key === '3:2' ? { width: 1536, height: 1024 }
      : key === '2:3' ? { width: 1024, height: 1536 } : undefined;
    if (size) ({ width, height } = size);
    else warnings.push('当前 GPT Image 旧模型只声明1:1、3:2和2:3画幅；仍按所选像素提交，由后端决定是否支持。');
  } else {
    let longSide: number = EDGES[input.tier];
    const step = capabilities.pixelStep;
    if ((capabilities.profile === 'gpt-image-modern' || capabilities.profile === 'gpt-image-legacy') && input.tier === '4K') {
      const key = canonicalAspect(aspect.label);
      const actualAspect = aspect.ratio >= 1 ? '16:9' : '9:16';
      if (aspect.ratio >= 1) ({ width, height } = { width: 3840, height: 2160 });
      else ({ width, height } = { width: 2160, height: 3840 });
      if (key !== actualAspect) warnings.push(`GPT Image 4K已适配原画幅${aspect.label}为${actualAspect}，按${width}×${height}提交；原版式按新画布组织。`);
      aspect = parseAspect(actualAspect)!;
    } else {
      if (capabilities.profile === 'gpt-image-modern' && input.tier === '1K' && longSide * longSide / Math.max(aspect.ratio, 1 / aspect.ratio) < 655_360) {
        longSide = 1536;
        alignment = ' · 按模型最小像素要求使用合法1K档尺寸';
      }
      if (input.exactAspect) {
        // Integer ratios and backend steps are aligned together, preserving layout.
        const factor = 10 ** Math.min(6, Math.max(String(aspect.width).split('.')[1]?.length || 0, String(aspect.height).split('.')[1]?.length || 0));
        const divisor = gcd(Math.round(aspect.width * factor), Math.round(aspect.height * factor));
        const a = Math.round(aspect.width * factor) / divisor; const b = Math.round(aspect.height * factor) / divisor;
        const unitStep = step / gcd(a, step) * (step / gcd(b, step)) / gcd(step / gcd(a, step), step / gcd(b, step));
        const unit = Math.max(unitStep, Math.round(longSide / Math.max(a, b) / unitStep) * unitStep);
        width = a * unit; height = b * unit;
        if (Math.max(width, height) !== longSide) alignment += ` · 保持${aspect.label}及${step}像素步长，实际长边${Math.max(width, height)}px`;
      } else {
        const short = longSide / Math.max(aspect.ratio, 1 / aspect.ratio);
        const aligned = Math.ceil((short - 1e-8) / step) * step;
        width = aspect.ratio >= 1 ? longSide : aligned; height = aspect.ratio >= 1 ? aligned : longSide;
        if (Math.abs(aligned - short) > 1e-8) alignment += ` · 短边向上对齐${step === 1 ? '整数像素' : `${step}像素步长`}，实际比例略有差异`;
        else if (step > 1) alignment += ` · 已满足${step}像素步长`;
      }
    }
  }
  if (!dimension(width) || !dimension(height)) issue = `宽、高须为64–${IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE}之间的整数像素；不会自动降档。`;
  if (!issue && capabilities.profile === 'gemini-1k' && encodedTier && encodedTier !== '1K') {
    warnings.push(`当前 Gemini Flash 档案的${encodedTier}高档像素由1K原生尺寸按倍率估算；仍按${encodedTier}档位请求，实际像素以服务返回为准。`);
  }
  const capabilityWarning = !issue ? pixelWarning(width, height, capabilities) : '';
  if (capabilityWarning) warnings.push(capabilityWarning);
  if (!issue && input.tier === 'custom' && capabilities.profile === 'pixel-long-edge'
    && ['comfyui', 'sd_webui', 'novelai'].includes(config.backend)) {
    const maxEdge = Math.max(0, ...capabilities.supportedTiers.map((tier) => EDGES[tier]));
    if (Math.max(width, height) > maxEdge) warnings.push(`自定义尺寸超出当前已声明最高原生生图档位（长边${maxEdge}px）；仍按输入像素提交，由后端决定是否支持，不自动降档或执行放大。`);
  }
  if (!issue && input.exactAspect && input.tier === 'custom'
    && Math.abs(width * requestedAspect.height - height * requestedAspect.width) > 1e-8
    && !(capabilities.profile.startsWith('gemini') && isKnownNativeImageAspectSize(width, height, requestedAspect.label))) {
    warnings.push(`当前版式推荐${requestedAspect.label}画幅；本次按自定义${aspect.label}及原始像素提交，请按实际画布组织布局。`);
  }
  if (!issue && capabilities.profile === 'grok-k' && !['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'].includes(canonicalAspect(aspect!.label))) {
    warnings.push('当前 Grok 档案未声明该画面比例；仍按所选比例提交，由后端决定是否支持。');
  }
  const layoutNote = `${input.tier === 'custom' ? '自定义生图' : input.tier} · 画幅${aspect.label}${capabilities.profile === 'pixel-long-edge' && input.tier !== 'custom' ? ` · 本机长边目标${EDGES[input.tier]}px` : !capabilityWarning && (encodedTier && capabilities.supportedTiers.includes(encodedTier) || capabilities.profile.startsWith('gpt')) ? ' · 模型原生规格' : ' · 按所选像素提交'}${alignment} · ${capabilities.note}`;
  if (issue) return { width, height, issue, layoutNote };
  const resolutionPlan: ImageResolutionPlan = { version: 1, tier: input.tier, logicalAspectRatio: canonicalAspect(aspect!.label), expected: { width, height },
    encoding: dimensionEncoding(capabilities, config, width, height, encodedTier), profile: capabilities.profile, verified: capabilities.verified && !warnings.length };
  return { width, height, issue: '', ...(warnings.length ? { warning: warnings.join(' ') } : {}), layoutNote, resolutionPlan };
};

/** Validate a frozen plan without re-resolving it using today's preference. */
export const assertImageResolutionPlanForConfig = (plan: ImageResolutionPlan, input: ImageApiConfig): void => {
  const saved = normalizeImageResolutionPlan(plan);
  if (!saved) throw new Error('保存的生图分辨率计划无效；未提交生图请求。');
  if (saved.tier === 'default' || saved.tier === 'legacy') return;
  const capabilities = resolveImageResolutionCapabilities(input);
  const configIssue = protocolIssue(capabilities, input.backend);
  if (configIssue) throw new Error(configIssue);
  if (saved.profile.startsWith('gemini') && saved.encoding.kind === 'tier') {
    const nativeTier = TIERS.find((candidate) => {
      const size = nativeSize(saved.profile as ImageResolutionCapabilities['profile'], candidate, saved.logicalAspectRatio);
      return size?.width === saved.expected.width && size.height === saved.expected.height;
    });
    if (!nativeTier || saved.tier !== 'custom' && nativeTier !== saved.tier
      || saved.encoding.kind === 'tier' && saved.encoding.value !== nativeTier) throw new Error('原任务尺寸与保存的 Gemini 原生档位不一致；未提交。');
  }
  const expectedEncoding = dimensionEncoding(capabilities, configFields(input), saved.expected.width, saved.expected.height, saved.encoding.kind === 'tier' ? saved.encoding.value : undefined);
  if (expectedEncoding.kind !== saved.encoding.kind) throw new Error('当前生图协议与原任务分辨率编码不同；请恢复原配置。');
};
