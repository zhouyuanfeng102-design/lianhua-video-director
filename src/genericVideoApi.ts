import type { VideoTaskApiConfig } from './types';
import type { VideoDesktopRequest, VideoGenerationDraft } from './videoGenerationTypes';
import { normalizeGeneratedImageData } from './generatedImageData';
import { nestedValue, normalizeVideoTaskStatus } from './videoTasks';

type AddressConfig = Pick<VideoTaskApiConfig, 'baseUrl' | 'endpoint'>;
type EndpointConfig = AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'statusEndpointTemplate'>;
const trimSlash = (value: string) => value.trim().replace(/\/+$/u, '');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const textValue = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Display an existing connection's base without rewriting its explicit endpoints. */
export const genericVideoApiBaseUrl = (config: AddressConfig): string => {
  const explicit = trimSlash(config.baseUrl || '').replace(/[?#].*$/u, '');
  if (explicit) return explicit.replace(/\/(?:videos|models)$/iu, '');
  const endpoint = trimSlash(config.endpoint || '').replace(/[?#].*$/u, '');
  if (/\/videos$/iu.test(endpoint)) return endpoint.replace(/\/videos$/iu, '');
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname.replace(/\/[^/]*$/u, '')}`;
  } catch { return endpoint; }
};

const versionedBase = (config: AddressConfig): string => {
  const base = genericVideoApiBaseUrl(config);
  return !base ? '' : /\/v\d+(?:beta|alpha)?$/iu.test(base) ? base : `${base}/v1`;
};

export const genericVideoApiEndpoints = (config: EndpointConfig): { submit: string; status: string; models: string } => {
  const versioned = versionedBase(config);
  const submit = config.endpoint.trim() || (config.baseUrl?.trim() && versioned ? `${versioned}/videos` : '');
  // Legacy connections without baseUrl never acquire a new polling protocol.
  const status = config.statusEndpointTemplate.trim() || (config.baseUrl?.trim() && versioned ? `${versioned}/videos/{id}` : '');
  return { submit, status, models: versioned ? `${versioned}/models` : '' };
};

export const genericVideoSubmitEndpoint = (config: AddressConfig): string => config.endpoint.trim()
  || (config.baseUrl?.trim() && versionedBase(config) ? `${versionedBase(config)}/videos` : '');
export const genericVideoStatusEndpoint = (config: EndpointConfig): string => genericVideoApiEndpoints(config).status;
export const genericVideoModelsEndpoint = (config: AddressConfig): string => versionedBase(config) ? `${versionedBase(config)}/models` : '';

export const isLaoliVideoApi = (config: AddressConfig & Pick<VideoTaskApiConfig, 'provider'>): boolean => {
  if (config.provider && config.provider !== 'generic') return false;
  try { return new URL(genericVideoSubmitEndpoint(config)).hostname.toLowerCase() === 'video.laoliimage2.win'; }
  catch { return false; }
};

/** Templates and nonstandard submit paths keep their existing custom protocol. */
export const isLaoliVideoBuiltinProtocol = (config: AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'requestTemplate'>): boolean => {
  if (!isLaoliVideoApi(config) || config.requestTemplate?.trim()) return false;
  try { return /^\/v1\/videos\/?$/u.test(new URL(genericVideoSubmitEndpoint(config)).pathname); }
  catch { return false; }
};

const validHttpUrl = (value: string, label: string): URL => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`请填写有效的${label}。`); }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) throw new Error(`${label}必须是无内嵌凭据的 HTTP(S) 地址。`);
  return url;
};
const abortError = (): Error => Object.assign(new Error('已取消获取模型。'), { name: 'AbortError' });
const safeMessage = (value: unknown, secret: string): string => {
  let result = typeof value === 'string' ? value.slice(0, 1000) : '';
  if (secret) for (const token of [secret, encodeURIComponent(secret)]) result = result.split(token).join('[密钥已隐藏]');
  return result;
};

export const parseGenericVideoModelIds = (body: unknown): string[] => {
  const entries = Array.isArray(body) ? body : record(body) && Array.isArray(body.data) ? body.data
    : record(body) && Array.isArray(body.models) ? body.models
      : Array.isArray(nestedValue(body, 'result.data')) ? nestedValue(body, 'result.data') as unknown[] : [];
  // The user chooses the model. Preserve image/text/video IDs and aliases alike.
  return [...new Set(entries.map((entry) => typeof entry === 'string' ? entry
    : record(entry) ? textValue(entry.id || entry.name || entry.model) : '').map((id) => id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
};

/** Preserve model metadata so model IDs and parameter limits share one authenticated GET. */
export async function fetchGenericVideoModelMetadata(
  config: AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'apiKey' | 'authHeader' | 'authScheme'>,
  options: { signal?: AbortSignal; allowPrivateNetwork?: boolean } = {},
): Promise<{ models: string[]; body: unknown }> {
  if (options.signal?.aborted) throw abortError();
  const configuredBase = config.baseUrl?.trim();
  if (configuredBase) {
    const url = validHttpUrl(configuredBase, 'API 地址');
    if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或片段。');
  }
  const url = validHttpUrl(genericVideoModelsEndpoint(config), 'API 地址').toString();
  const key = config.apiKey.trim();
  const authHeader = config.authHeader.trim() || 'Authorization';
  const authScheme = config.authScheme ?? 'Bearer';
  if (/[\r\n]/u.test(`${key}${authHeader}${authScheme}`)) throw new Error('API 认证设置包含无效换行。');
  const headers: Record<string, string> = { Accept: 'application/json', ...(key ? { [authHeader]: `${authScheme ? `${authScheme} ` : ''}${key}` } : {}) };
  const desktop = typeof window !== 'undefined' ? window.lianhuaDesktop : undefined;
  const requestId = `video-models-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const controller = new AbortController();
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); action();
    };
    const cancel = () => { controller.abort(); try { void desktop?.cancelModelRequest?.(requestId).catch(() => undefined); } catch { /* Local cancellation still settles. */ } };
    const onAbort = () => finish(() => { cancel(); reject(abortError()); });
    const timer = setTimeout(() => finish(() => { cancel(); reject(new Error('获取模型超时，请检查 API 地址与网络后重试。')); }), 30_000);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    const perform = async () => {
      if (desktop?.request) return desktop.request({ requestId, url, method: 'GET', headers, responseType: 'text', redirect: 'error' });
      const fetched = await fetch(url, { method: 'GET', headers, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      return { status: fetched.status, body: await fetched.text() };
    };
    void perform().then((result) => finish(() => resolve(result)), () => finish(() => reject(new Error('获取模型失败，请检查 API 地址、网络与密钥。'))));
  });
  if (options.signal?.aborted) throw abortError();
  let body: unknown;
  try { body = JSON.parse(response.body); } catch { throw new Error(`获取模型失败：接口没有返回有效 JSON（HTTP ${response.status}）。`); }
  if (response.status < 200 || response.status >= 300) {
    const detail = safeMessage(nestedValue(body, 'error.message') || nestedValue(body, 'message'), key);
    const code = safeMessage(nestedValue(body, 'error.code') || nestedValue(body, 'error.type') || nestedValue(body, 'code'), key);
    throw new Error(`获取模型失败：HTTP ${response.status}${code ? `（${code}）` : ''}${detail ? `，${detail}` : ''}`);
  }
  const models = parseGenericVideoModelIds(body);
  if (!models.length) throw new Error('接口返回成功，但没有可识别的模型列表。');
  return { models, body };
}

export async function fetchGenericVideoModels(
  config: AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'apiKey' | 'authHeader' | 'authScheme'>,
  options: { signal?: AbortSignal; allowPrivateNetwork?: boolean } = {},
): Promise<string[]> {
  return (await fetchGenericVideoModelMetadata(config, options)).models;
}

type LaoliModelKind = 'classic20' | 'classic25' | 'h3' | 'native20' | 'native25' | 'wan' | 'other';
export const laoliVideoModelKind = (model = ''): LaoliModelKind => {
  if (model === '3.0' || /^特价2\.0/u.test(model)) return 'classic20';
  if (model === '3.5' || /^特价2\.5/u.test(model)) return 'classic25';
  if (/^(?:H3-KS|minimax-h3-1080p|MiniMax H3 1080P推荐)$/iu.test(model)) return 'h3';
  if (/^(?:原生不卡人脸-全参2\.0|sd-native-full-2\.0)$/iu.test(model)) return 'native20';
  if (/^(?:原生不卡人脸-全参2\.5|sd-native-full-2\.5)$/iu.test(model)) return 'native25';
  if (/^(?:WAN3\.0-|wan-3\.0-)/iu.test(model)) return 'wan';
  return 'other';
};

export const laoliVideoUsesInlineImages = (config: AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'requestTemplate' | 'model'>): boolean =>
  isLaoliVideoBuiltinProtocol(config) && /^classic/u.test(laoliVideoModelKind(config.model));

/** Canonical JSON for the documented service; custom templates bypass this adapter. */
export const buildLaoliVideoApiBody = (
  config: Pick<VideoTaskApiConfig, 'model'>, draft: VideoGenerationDraft, images: string[],
): Record<string, unknown> => {
  const kind = laoliVideoModelKind(config.model);
  const classic = kind === 'classic20' || kind === 'classic25';
  if (draft.references.length !== images.length) throw new Error('视频参考图与上传结果数量不一致，尚未提交视频。');
  const first = draft.references.filter((reference) => reference.role === 'first-frame');
  const last = draft.references.filter((reference) => reference.role === 'last-frame');
  // Classic requests use an ordered `images` array. The user's first/middle/
  // last labels describe reference responsibilities in the prompt; they do
  // not select a native first_frame/last_frame protocol or justify a refusal.
  if ((first.length || last.length) && (kind === 'h3' || kind === 'native25')) throw new Error('所选模型只支持普通参考图，不支持首尾帧模式。请调整图片用途，或改用支持首尾帧的模型。');
  if (!classic && (first.length > 1 || last.length > 1 || last.length && !first.length)) throw new Error('首尾帧模式需要一张首帧，最多一张尾帧；请核对已选图片用途。');
  const allowed = new Set(['duration', 'seconds', 'resolution', 'aspect_ratio', 'ratio', 'task_mode', 'n', 'response_format', 'metadata', 'face_direct', 'native_face']);
  const unsupported = Object.keys(draft.parameters).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`老李视频接口不支持这些通用参数：${unsupported.join('、')}。请移除，或使用明确的高级请求模板。`);
  const parameters = { ...draft.parameters };
  const duration = parameters.seconds ?? parameters.duration;
  if (parameters.seconds !== undefined && parameters.duration !== undefined && Number(parameters.seconds) !== Number(parameters.duration)) throw new Error('seconds 与 duration 时长不一致，请只保留一个时长字段。');
  if (duration === undefined && kind !== 'h3' && kind !== 'other') throw new Error('请在生成参数中填写本次请求时长（秒）。');
  if (duration !== undefined) {
    const value = typeof duration === 'number' || typeof duration === 'string' && duration.trim() ? Number(duration) : NaN;
    const minimum = kind === 'classic25' ? 16 : classic || kind === 'h3' ? 5 : 4;
    const maximum = kind === 'classic25' || kind === 'native25' || /不可参考视频|no-video-ref/iu.test(config.model || '') ? 30 : 15;
    if (!Number.isInteger(value) || kind !== 'other' && (value < minimum || value > maximum || kind === 'classic20' && ![5, 10, 15].includes(value))) throw new Error(`所选模型的请求时长无效，请按模型规格填写整数秒数。`);
    parameters[classic ? 'duration' : 'seconds'] = value;
  }
  delete parameters[classic ? 'seconds' : 'duration'];
  const ratio = parameters.aspect_ratio ?? parameters.ratio;
  if (parameters.aspect_ratio !== undefined && parameters.ratio !== undefined && parameters.aspect_ratio !== parameters.ratio) throw new Error('aspect_ratio 与 ratio 比例不一致，请只保留一个比例字段。');
  if (ratio !== undefined) parameters[classic ? 'ratio' : 'aspect_ratio'] = ratio;
  delete parameters[classic ? 'aspect_ratio' : 'ratio'];
  if (parameters.resolution === undefined && (classic || kind === 'h3')) parameters.resolution = classic ? '720p' : '1080p';
  if (parameters.resolution === undefined && (kind === 'native20' || kind === 'native25' || kind === 'wan')) throw new Error('请在生成参数中填写所选模型支持的分辨率。');
  if (typeof parameters.resolution === 'string') parameters.resolution = parameters.resolution.toLowerCase();
  const resolutions = classic || kind === 'wan' ? ['720p'] : kind === 'h3' ? ['1080p'] : kind === 'native25' ? ['480p', '720p'] : kind === 'native20' ? ['480p', '720p', '1080p'] : undefined;
  if (resolutions && !resolutions.includes(String(parameters.resolution))) throw new Error(`所选模型支持的分辨率为 ${resolutions.join(' / ')}，请调整本次参数。`);
  if (classic && Object.keys(parameters).some((key) => ['task_mode', 'n', 'response_format', 'metadata'].includes(key))) throw new Error('特价模型不支持 task_mode、n、response_format 或 metadata，请移除对应参数。');
  if (!classic && (parameters.face_direct !== undefined || parameters.native_face !== undefined)) throw new Error('此视频模型不支持人脸处理开关，请移除对应参数。');
  if (parameters.face_direct === true || parameters.native_face === true) throw new Error('特价模型的人脸处理功能已关闭，请移除对应开关。');
  return {
    ...parameters, ...(config.model ? { model: config.model } : {}), prompt: draft.prompt,
    ...(images.length ? classic ? { images: images.map((image) => image.startsWith('data:') ? normalizeGeneratedImageData(image) : image) } : { references: images.map((source, index) => ({ type: 'image', role: draft.references[index].role === 'first-frame' ? 'first_frame' : draft.references[index].role === 'last-frame' ? 'last_frame' : 'reference', source })) } : {}),
  };
};

type UploadRequest = Omit<VideoDesktopRequest, 'requestId'>;
export const decodeVideoBinaryBody = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const encodeBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return globalThis.btoa(binary);
};

/** Hash original image bytes; initialize-by-hash makes a failed preparation resumable. */
export async function uploadLaoliVideoImage(
  config: AddressConfig & Pick<VideoTaskApiConfig, 'model'>,
  dataUrl: string,
  headers: Record<string, string>,
  request: (payload: UploadRequest) => Promise<unknown>,
): Promise<string> {
  const normalized = normalizeGeneratedImageData(dataUrl);
  const match = normalized.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) throw new Error('老李视频参考图必须是 PNG、JPEG 或 WebP 原图。');
  const bytes = decodeVideoBinaryBody(match[2]);
  if (!bytes.length) throw new Error('参考图内容为空，尚未提交视频。');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const submit = validHttpUrl(genericVideoSubmitEndpoint(config), '视频 API 地址');
  const uploadBase = `${submit.origin}/v1/media/uploads`;
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const initialized = await request({ url: uploadBase, method: 'POST', headers: jsonHeaders, body: JSON.stringify({ size: bytes.length, sha256, mime_type: match[1] }) });
  const checkReceipt = (receipt: unknown): Record<string, unknown> => {
    if (!record(receipt) || typeof receipt.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(receipt.id)) throw new Error('素材上传接口未返回有效上传编号，尚未提交视频。');
    if (receipt.sha256 !== undefined && receipt.sha256 !== sha256 || receipt.bytes !== undefined && receipt.bytes !== bytes.length || receipt.size !== undefined && receipt.size !== bytes.length) throw new Error('素材上传回执与所选原图字节不一致，尚未提交视频。');
    return receipt;
  };
  const receipt = checkReceipt(initialized);
  const completeSource = (completed: Record<string, unknown>): string => {
    if (completed.status !== 'complete' || completed.type !== undefined && completed.type !== 'image' || typeof completed.source !== 'string') throw new Error('原图上传尚未完成，尚未提交视频。');
    const source = validHttpUrl(completed.source, '素材引用地址');
    // A completed signed reference can live on the service's separate asset
    // host. It is passed as data; API authorization is never sent to it.
    if (source.protocol !== 'https:') throw new Error('原图上传没有返回 HTTPS 素材地址，尚未提交视频。');
    return source.toString();
  };
  if (receipt.status === 'complete') return completeSource(receipt);
  const chunkSize = Number(receipt.chunk_size), chunkCount = Number(receipt.chunk_count);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkCount !== Math.ceil(bytes.length / chunkSize)) throw new Error('素材上传分片规格无效，尚未提交视频。');
  const received = receipt.received ?? [];
  if (!Array.isArray(received) || received.some((index) => !Number.isInteger(index) || index < 0 || index >= chunkCount)) throw new Error('素材上传分片回执无效，尚未提交视频。');
  const known = new Set(received);
  for (let index = 0; index < chunkCount; index += 1) {
    if (known.has(index)) continue;
    await request({ url: `${uploadBase}/${encodeURIComponent(receipt.id as string)}/chunks/${index}`, method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: encodeBytes(bytes.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, bytes.length))), bodyEncoding: 'base64' });
  }
  const completed = await request({ url: `${uploadBase}/${encodeURIComponent(receipt.id as string)}/complete`, method: 'POST', headers: jsonHeaders, body: '{}' });
  const finalReceipt = checkReceipt(completed);
  if (finalReceipt.id !== receipt.id) throw new Error('素材完成回执的上传编号不一致，尚未提交视频。');
  return completeSource(finalReceipt);
}

/** Standard /videos envelopes, including authenticated relative result URLs. */
export const parseGenericVideoApiResult = (body: unknown, config: Omit<VideoTaskApiConfig, 'apiKey'>) => {
  const firstValue = (paths: Array<string | undefined>): unknown => paths.map((path) => path ? nestedValue(body, path) : undefined).find((value) => value !== undefined && value !== null && value !== '');
  const remoteTaskId = textValue(firstValue([config.taskIdPath, 'id', 'task_id', 'data.id', 'data.task_id']));
  const rawStatus = textValue(firstValue([config.statusPath, 'status', 'data.status']));
  let status = normalizeVideoTaskStatus(rawStatus);
  if (/^(?:preparing|queueing)$/iu.test(rawStatus)) status = 'submitted';
  const urlValue = firstValue([isLaoliVideoApi(config) ? 'download_url' : undefined, config.resultUrlPath, 'url', 'video_url', 'download_url', 'data.url', 'data.video_url', 'data.download_url', 'output.url', 'output.video_url']);
  let resultUrl: string | undefined;
  if (typeof urlValue === 'string' && !['failed', 'running', 'submitted'].includes(status)) {
    try {
      const url = new URL(urlValue, genericVideoSubmitEndpoint(config));
      if (/^https?:$/u.test(url.protocol) && !url.username && !url.password) resultUrl = url.toString();
    } catch { /* Invalid result links do not authorize downloading. */ }
  }
  if (resultUrl && status === 'unknown') status = 'succeeded';
  if (status === 'succeeded' && !resultUrl && remoteTaskId) {
    try {
      const submit = new URL(genericVideoSubmitEndpoint(config));
      if (/\/videos\/?$/u.test(submit.pathname)) resultUrl = `${submit.origin}${submit.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(remoteTaskId)}/${isLaoliVideoApi(config) ? 'download' : 'content'}`;
    } catch { /* Custom endpoints require a real result URL. */ }
  }
  if (resultUrl && isLaoliVideoApi(config)) {
    const url = new URL(resultUrl);
    if (url.origin === new URL(genericVideoSubmitEndpoint(config)).origin && /\/content\/?$/u.test(url.pathname)) { url.searchParams.set('download', '1'); resultUrl = url.toString(); }
  }
  const progressValue = firstValue([config.progressPath, 'progress', 'data.progress']);
  const progress = typeof progressValue === 'number' && Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : undefined;
  const error = firstValue([config.errorPath, 'error.message', 'message', 'error', 'data.error.message']);
  const fileId = textValue(firstValue([config.fileIdPath]));
  return { remoteTaskId, status: status === 'draft' || status === 'submitting' ? 'unknown' as const : status, resultUrl, progress, fileId: fileId || undefined,
    message: status === 'failed' ? textValue(error) || '视频接口报告任务失败' : rawStatus ? `接口状态：${rawStatus}` : '等待接口返回任务状态' };
};
