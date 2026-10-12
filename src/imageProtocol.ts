/** Settings can request automatic routing or explicitly select a transport. */
export type ImageProtocolSetting = 'auto' | 'openai-compatible' | 'openai-compatible-manual' | 'openai-images' | 'openai-chat' | 'gemini' | 'xai';
export type ResolvedImageProtocol = 'openai-compatible' | 'openai-images' | 'openai-chat' | 'gemini' | 'xai';

export interface ImageProtocolConfig {
  backend: 'openai' | 'sd_webui' | 'comfyui' | 'novelai' | 'runninghub';
  model: string;
  baseUrl?: string;
  imageProtocol?: ImageProtocolSetting;
  /** In-memory pin used when executing a saved task. Never a user preference. */
  imageProtocolRuntime?: ResolvedImageProtocol;
}

export interface ImageProtocolDecision {
  protocol: ResolvedImageProtocol;
  automatic: boolean;
  reason: string;
}

export const isResolvedImageProtocol = (value: unknown): value is ResolvedImageProtocol => (
  ['openai-compatible', 'openai-images', 'openai-chat', 'gemini', 'xai'].includes(String(value))
);

/** Local inference only: no API probes, generations, retries or model renaming. */
export const inspectImageProtocol = (config: ImageProtocolConfig): ImageProtocolDecision => {
  if (config.backend !== 'openai') return { protocol: 'openai-compatible', automatic: true, reason: '使用所选后端的原生接口' };
  if (isResolvedImageProtocol(config.imageProtocolRuntime)) {
    return { protocol: config.imageProtocolRuntime, automatic: false, reason: '沿用本次任务保存的生图协议' };
  }
  if (config.imageProtocol === 'openai-compatible-manual') {
    return { protocol: 'openai-compatible', automatic: false, reason: '已手动指定 Images 兼容接口' };
  }
  if (isResolvedImageProtocol(config.imageProtocol) && config.imageProtocol !== 'openai-compatible') {
    return { protocol: config.imageProtocol, automatic: false, reason: '已手动指定生图协议' };
  }

  // Historical "openai-compatible" preferences become automatic for new work.
  // Historical tasks pin their former transport through imageProtocolRuntime.
  let hostname = ''; let pathname = '';
  try {
    const endpoint = new URL(config.baseUrl?.trim() || '');
    hostname = endpoint.hostname.toLowerCase();
    pathname = endpoint.pathname.replace(/\/+$/u, '').toLowerCase();
  } catch { /* A missing/malformed address uses the conventional Images route. */ }
  const automatic = (protocol: ResolvedImageProtocol, reason: string): ImageProtocolDecision => ({ protocol, automatic: true, reason });
  if (/\/chat\/completions$/u.test(pathname)) return automatic('openai-chat', 'API 地址已指定聊天生图接口');
  if (/\/models\/[^/]+:generatecontent$/u.test(pathname) || /\/(?:v1beta|v1alpha)(?:\/models)?$/u.test(pathname)) {
    return automatic('gemini', 'API 地址已指定 Gemini 原生接口');
  }
  if (/\/images\/(?:generations|edits|variations)$/u.test(pathname)) {
    return automatic(hostname === 'api.x.ai' ? 'xai' : hostname === 'api.openai.com' ? 'openai-images' : 'openai-compatible', 'API 地址已指定 Images 接口');
  }
  if (hostname === 'generativelanguage.googleapis.com') {
    return /\/openai$/u.test(pathname)
      ? automatic('openai-compatible', 'Google 官方 OpenAI 兼容生图接口')
      : automatic('gemini', 'Google 官方 Gemini 原生接口');
  }
  if (hostname === 'api.openai.com') return automatic('openai-images', 'OpenAI 官方 Images 接口');
  if (hostname === 'api.x.ai') return automatic('xai', 'xAI 官方生图接口');
  // Prefixes such as [Billing] are relay aliases and stay intact in the request.
  if (/gemini[^\r\n]*image|nano[-_ ]?banana|香蕉/iu.test(config.model.trim())) {
    return automatic('openai-chat', 'Gemini / 香蕉模型使用中转聊天生图兼容接口');
  }
  return automatic('openai-compatible', '使用 Images 兼容接口');
};

export const resolveImageProtocol = (config: ImageProtocolConfig): ResolvedImageProtocol => inspectImageProtocol(config).protocol;
