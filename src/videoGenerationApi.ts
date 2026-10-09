import type { VideoTaskApiConfig } from './types';
import { buildRhTvBody, defaultRhTvApi, RHTV_ORIGIN } from './rhtvBridge';
import type { VideoGenerationDraft, VideoGenerationStage } from './videoGenerationTypes';
import { mapVideoTaskResponse, nestedValue } from './videoTasks';
import { bindRunningHubVideoRequest } from './runningHubVideo';
import { videoReferenceUsage } from './videoReferenceUsage';
import { assertVideoReferenceSlots, videoReferenceSlotIndex, videoReferenceSlotSpan } from './videoReferenceSlots';

export const defaultMiniMaxVideoApi: VideoTaskApiConfig = {
  enabled: true, provider: 'minimax', model: 'MiniMax-Hailuo-2.3',
  endpoint: 'https://api.minimaxi.com/v1/video_generation',
  statusEndpointTemplate: 'https://api.minimaxi.com/v1/query/video_generation?task_id={id}',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'task_id', statusPath: 'status', resultUrlPath: 'video_url',
  fileIdPath: 'file_id', fileEndpointTemplate: 'https://api.minimaxi.com/v1/files/retrieve?file_id={id}', fileUrlPath: 'file.download_url',
};

export const runningHubRequestTemplate = JSON.stringify({
  nodeInfoList: [
    {
      nodeId: '请填入提示词节点 ID',
      fieldName: 'value',
      fieldValue: '{{prompt}}',
      description: null,
    },
  ],
  instanceType: 'default',
  usePersonalQueue: false,
}, null, 2);

/**
 * RunningHub 的 AI 应用不是原生 ComfyUI /prompt 接口：提交、查询和上传均有
 * 固定协议。节点值仍由用户从其应用文档中明确映射，绝不猜测节点 ID。
 */
export const defaultRunningHubVideoApi: VideoTaskApiConfig = {
  enabled: true, provider: 'runninghub', model: 'RunningHub AI 应用',
  endpoint: 'https://www.runninghub.ai/openapi/v2/run/ai-app/{appId}',
  runningHubAppId: '',
  statusEndpointTemplate: 'https://www.runninghub.ai/openapi/v2/query',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url', errorPath: 'errorMessage',
  imageUploadEndpoint: 'https://www.runninghub.ai/openapi/v2/media/upload/binary',
  imageUploadField: 'file', imageUploadUrlPath: 'data.fileName',
  requestTemplate: runningHubRequestTemplate,
};

/** Resolve the standard RunningHub submit URL without ever putting a credential in it. */
export const videoApiSubmitEndpoint = (config: Pick<VideoTaskApiConfig, 'provider' | 'endpoint' | 'runningHubAppId'>): string => {
  if (config.provider === 'rhtv_web') return defaultRhTvApi.endpoint;
  const endpoint = config.endpoint.trim();
  if (config.provider !== 'runninghub') return endpoint;
  const appId = config.runningHubAppId?.trim();
  if (!appId) return '';
  const template = endpoint || defaultRunningHubVideoApi.endpoint;
  return template.includes('{appId}') ? template.split('{appId}').join(encodeURIComponent(appId)) : template;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Bare 64-bit IDs/seeds cannot survive JavaScript JSON parsing. Never round
 * them silently, nor change their declared JSON type behind the user's back. */
export const assertRunningHubTemplateNumbersSafe = (source: string): void => {
  const tokens = source.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) || [];
  for (const token of tokens) {
    if (token.startsWith('"')) continue;
    const value = Number(token);
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('RunningHub JSON 包含超出安全精度的裸数字。请将长 ID 或大整数节点值改为带双引号的字符串后保存；程序不会四舍五入或擅自改值。');
    }
  }
};

/** RunningHub Comfy nodes accept the uploaded cloud fileName, not only a
 * public URL. This never grants access to a local path. */
export const isRunningHubUploadedFile = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return false;
  if (/^https?:\/\//iu.test(value)) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  return !/^[./\\]|[\\:\u0000-\u001f\u007f?#]/u.test(decoded)
    && !decoded.split('/').some((part) => !part || part === '.' || part === '..');
};
const expandTemplate = (value: unknown, vars: Record<string, unknown>): unknown => {
  if (Array.isArray(value)) return value.map((item) => expandTemplate(item, vars));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandTemplate(item, vars)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{(\w+)\}\}$/u)?.[1];
  if (exact && Object.prototype.hasOwnProperty.call(vars, exact)) return vars[exact];
  return value.replace(/\{\{(\w+)\}\}/gu, (whole, key: string) => {
    const replacement = vars[key];
    return replacement === undefined ? whole : typeof replacement === 'string' ? replacement : JSON.stringify(replacement);
  });
};

/** Old custom templates have no mapping metadata. Clear only their explicit
 * image_N input placeholders; static fields and embedded text are not slots. */
const clearUnusedRunningHubTemplateImages = (value: unknown, occupiedSlots: ReadonlySet<number>): unknown => {
  if (!record(value) || !Array.isArray(value.nodeInfoList)) return value;
  return { ...value, nodeInfoList: value.nodeInfoList.map((node) => {
    if (!record(node) || typeof node.fieldValue !== 'string') return node;
    const match = node.fieldValue.match(/^\{\{image_([1-9]\d*)\}\}$/u);
    if (!match) return node;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) throw new Error(`RunningHub 图片占位符 ${node.fieldValue} 的槽位编号无效。`);
    return occupiedSlots.has(number - 1) ? node : { ...node, fieldValue: '' };
  }) };
};

export const buildVideoApiBody = (config: Omit<VideoTaskApiConfig, 'apiKey'>, draft: VideoGenerationDraft, images: string[]): Record<string, unknown> => {
  assertVideoReferenceSlots(draft.references);
  if (config.provider === 'rhtv_web') return buildRhTvBody(config, draft, images);
  // Resolve the per-submission boundary usage before building either named
  // first/last fields or ordered references. Never mutate a saved task draft.
  draft = { ...draft, references: videoReferenceUsage(draft.references, { backend: 'api', api: config, slotRoles: draft.referenceSlotRoles }) };
  const firstIndex = draft.references.findIndex((image) => image.role === 'first-frame');
  const lastIndex = draft.references.findIndex((image) => image.role === 'last-frame');
  const slots = draft.references.map(videoReferenceSlotIndex);
  if (config.provider === 'runninghub') {
    if (draft.references.length !== images.length) {
      throw new Error(`RunningHub 本次选了 ${draft.references.length} 张参考图，但仅取得 ${images.length} 张上传结果；不会丢图或补图，请重试图片上传。`);
    }
    for (let index = 0; index < images.length; index += 1) {
      if (typeof images[index] !== 'string' || !images[index].trim()) throw new Error(`RunningHub 第 ${index + 1} 张已选参考图未取得可用上传结果，请重试该图片上传。`);
    }
    if (config.runningHubImageRoles && videoReferenceSlotSpan(draft.references) > config.runningHubImageRoles.length) {
      throw new Error(`此 RunningHub 工作流最多支持 ${config.runningHubImageRoles.length} 个参考图槽，本次选了 ${images.length} 张，已超出容量；不会静默丢弃图片。`);
    }
    // A workflow's mapped role is a hint about the physical input, while the
    // selected image role belongs to this individual segment.  They are
    // intentionally allowed to differ: the segment-level role selection is
    // displayed to the user as a warning, but must never turn into a local
    // submission gate or silently replace/reorder the selected image.
  }
  if (config.provider === 'minimax') {
    const incompatible = draft.references.filter((image) => image.role !== 'first-frame' && image.role !== 'last-frame');
    if (incompatible.length || draft.references.filter((image) => image.role === 'first-frame').length > 1 || draft.references.filter((image) => image.role === 'last-frame').length > 1) {
      throw new Error('此 MiniMax 官方适配使用首帧/尾帧输入；人物、构图等多参考图请用支持相应用途的通用 API 或 ComfyUI，不会把参考图擅自改成首帧。');
    }
    if (lastIndex >= 0 && firstIndex < 0) throw new Error('MiniMax 首尾帧生成需要同时选择首帧。');
    // Prompt optimizer would rewrite dialogue and audio. Preserve the explicitly chosen text.
    return {
      model: config.model || 'MiniMax-Hailuo-2.3',
      ...draft.parameters,
      prompt: draft.prompt,
      prompt_optimizer: false,
      ...(firstIndex >= 0 ? { first_frame_image: images[firstIndex] } : {}),
      ...(lastIndex >= 0 ? { last_frame_image: images[lastIndex] } : {}),
    };
  }
  if (config.provider === 'runninghub' && !config.requestTemplate?.trim()) {
    throw new Error('请先在 RunningHub AI 应用配置中填写 nodeInfoList 请求模板。');
  }
  if (config.requestTemplate?.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(config.requestTemplate); } catch { throw new Error('视频 API 请求模板不是有效 JSON。'); }
    if (config.provider === 'runninghub') assertRunningHubTemplateNumbersSafe(config.requestTemplate);
    const result = config.provider === 'runninghub' && config.runningHubMappedFields
      ? bindRunningHubVideoRequest(config.requestTemplate, config.runningHubMappedFields, draft, images, config)
      : expandTemplate(config.provider === 'runninghub' ? clearUnusedRunningHubTemplateImages(raw, new Set(slots)) : raw, {
      prompt: draft.prompt, model: config.model || '', images,
      // Generic arrays remain dense: never manufacture an empty URL. A
      // reference-capable template can consume explicit physical slot metadata;
      // named image_N fields always bind the selected slot directly.
      references: images.map((image_url, index) => ({ image_url, role: draft.references[index]?.role || 'general',
        ...(slots[index] !== undefined && slots[index] !== index ? { slot_index: slots[index] } : {}) })),
      first_image: firstIndex >= 0 ? images[firstIndex] : '', last_image: lastIndex >= 0 ? images[lastIndex] : '',
      parameters: draft.parameters,
      ...(config.provider !== 'runninghub' && slots.some((slot, index) => slot !== index) ? Object.fromEntries([...config.requestTemplate.matchAll(/\{\{image_([1-9]\d*)\}\}/gu)]
        .map((match) => [`image_${match[1]}`, ''])) : {}),
      ...Object.fromEntries(images.map((image, index) => [`image_${(slots[index] ?? index) + 1}`, image])),
      ...draft.parameters,
    });
    if (!record(result)) throw new Error('视频 API 请求模板必须是 JSON 对象。');
    if (config.provider === 'runninghub') {
      const nodeInfoList = result.nodeInfoList;
      if (!Array.isArray(nodeInfoList) || nodeInfoList.length === 0) throw new Error('RunningHub 请求模板必须包含至少一个 nodeInfoList 节点映射。');
      if (nodeInfoList.some((item) => !record(item) || typeof item.nodeId !== 'string' || !item.nodeId.trim() || /请填入.*节点 ID/u.test(item.nodeId))) {
        throw new Error('请把 RunningHub 请求模板中的“请填入提示词节点 ID”替换为该 AI 应用实际允许修改的节点 ID。');
      }
      if (nodeInfoList.some((item) => !record(item) || typeof item.fieldName !== 'string' || !item.fieldName.trim())) {
        throw new Error('RunningHub 的每个 nodeInfoList 项都必须填写实际 fieldName，例如 value 或 image。');
      }
    }
    if (!JSON.stringify(result).includes(JSON.stringify(draft.prompt).slice(1, -1))) throw new Error('视频 API 模板未引用完整 {{prompt}}，请在接口配置中绑定提示词字段。');
    for (const image of images) if (!JSON.stringify(result).includes(JSON.stringify(image).slice(1, -1))) throw new Error('视频 API 模板没有包含所有选图，请绑定 {{images}} / {{references}} 或首尾帧字段。');
    return result;
  }
  return { ...(config.model ? { model: config.model } : {}), ...draft.parameters, prompt: draft.prompt,
    ...(images.length ? { images } : {}),
    ...(firstIndex >= 0 ? { first_frame_image: images[firstIndex] } : {}),
    ...(lastIndex >= 0 ? { last_frame_image: images[lastIndex] } : {}),
  };
};

export interface RunningHubVideoResultCandidate {
  resultUrl: string;
  archiveHint?: boolean;
  nodeId?: string;
}

/** A workflow may return test/reference ZIPs before its actual video ZIP.
 * Enumerate every allowed candidate; only the media receiver can determine
 * which archive contains a real video. Names are never used to guess a node. */
export const runningHubVideoResults = (body: unknown, outputNodeIds: readonly string[] = []): RunningHubVideoResultCandidate[] => {
  const results = nestedValue(body, 'results');
  if (!Array.isArray(results)) return [];
  const selectedNodes = outputNodeIds.map((nodeId) => nodeId.trim()).filter(Boolean);
  const entries = results.filter(record).filter((item) => !selectedNodes.length || selectedNodes.includes(String(item.nodeId ?? '')));
  const kind = (item: Record<string, unknown>): 'video' | 'zip' | undefined => {
    if (typeof item.url !== 'string' || !/^https?:\/\//iu.test(item.url)) return undefined;
    const type = String(item.outputType || '').trim();
    // Official outputType is a bare extension ("mp4"), not a filename.
    if (type) {
      if (/^(?:\.?\s*(?:mp4|webm|mov|mkv|avi|m4v|mpeg|mpg|ogv)|video\/[\w.+-]+)$/iu.test(type)) return 'video';
      if (/^(?:\.?zip|application\/(?:zip|x-zip-compressed))$/iu.test(type)) return 'zip';
      return undefined;
    }
    try {
      const url = new URL(item.url);
      const names = [url.pathname, url.searchParams.get('filename') || ''];
      if (names.some((name) => /\.(?:mp4|webm|mov|mkv|avi|m4v|mpeg|mpg|ogv)$/iu.test(name))) return 'video';
      if (names.some((name) => /\.zip$/iu.test(name))) return 'zip';
    } catch { /* A malformed URL is not a usable output. */ }
    return undefined;
  };
  const seen = new Set<string>();
  const candidates: RunningHubVideoResultCandidate[] = [];
  // Preserve the existing direct-video preference, but never drop later ZIPs.
  for (const outputKind of ['video', 'zip'] as const) {
    for (const item of entries) {
      if (kind(item) !== outputKind || typeof item.url !== 'string' || seen.has(item.url)) continue;
      seen.add(item.url);
      const nodeId = item.nodeId == null ? '' : String(item.nodeId).trim();
      candidates.push({ resultUrl: item.url, ...(outputKind === 'zip' ? { archiveHint: true } : {}), ...(nodeId ? { nodeId } : {}) });
    }
  }
  return candidates;
};

/** First candidate for status display/backward compatibility, not a verdict
 * that this is the workflow's only downloadable video output. */
export const runningHubVideoResult = (body: unknown, outputNodeIds: readonly string[] = []): { resultUrl: string; archiveHint?: boolean } | undefined => {
  const first = runningHubVideoResults(body, outputNodeIds)[0];
  return first ? { resultUrl: first.resultUrl, ...(first.archiveHint ? { archiveHint: true } : {}) } : undefined;
};

export const parseVideoApiResult = (body: unknown, config: Omit<VideoTaskApiConfig, 'apiKey'>): {
  remoteTaskId: string; stage: VideoGenerationStage; status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'unknown'; resultUrl?: string; archiveHint?: boolean; downloadError?: string; fileId?: string; progress?: number; message?: string;
} => {
  if (config.provider === 'rhtv_web') {
    const remoteTaskId = String(nestedValue(body, 'id') || '');
    const raw = String(nestedValue(body, 'status') || '');
    const message = String(nestedValue(body, 'message') || '等待 rhTV 桥接状态');
    const url = nestedValue(body, 'result_url');
    if (raw === 'succeeded' && url === `${RHTV_ORIGIN}/v1/videos/${remoteTaskId}/content`) return { remoteTaskId, stage: 'downloading', status: 'succeeded', resultUrl: String(url), message };
    if (raw === 'succeeded') return { remoteTaskId, stage: 'succeeded', status: 'succeeded', message, downloadError: 'rhTV 原任务已结束，但结果地址无效；未接收其他来源文件，也不会重新生成。' };
    if (raw === 'cancelled' && nestedValue(body, 'cancellation_confirmed') === true) return { remoteTaskId, stage: 'failed', status: 'failed', message };
    if (raw === 'failed' && nestedValue(body, 'terminal_confirmed') === true) return { remoteTaskId, stage: 'failed', status: 'failed', message };
    if (raw === 'submission_unknown') return { remoteTaskId, stage: 'submission-unknown', status: 'unknown', message };
    if (['waiting_review','paused','preparing','submitting'].includes(raw)) return { remoteTaskId, stage: 'queued', status: 'submitted', message };
    if (['running','downloading','download_failed'].includes(raw)) return { remoteTaskId, stage: raw === 'running' ? 'running' : 'downloading', status: 'running', message };
    return { remoteTaskId, stage: 'reconnecting', status: 'unknown', message: `rhTV 状态尚未确认：${message}` };
  }
  const settings = config.provider === 'minimax'
    ? { ...defaultMiniMaxVideoApi, ...config }
    : config.provider === 'runninghub'
      ? { ...defaultRunningHubVideoApi, ...config }
      : config;
  const baseCode = nestedValue(body, 'base_resp.status_code');
  if (baseCode !== undefined && Number(baseCode) !== 0) return { remoteTaskId: '', stage: 'failed', status: 'failed', message: String(nestedValue(body, 'base_resp.status_msg') || `接口返回错误 ${baseCode}`) };
  const mapped = mapVideoTaskResponse(body, settings);
  const rawStatus = String(nestedValue(body, settings.statusPath) || '').toLowerCase();
  if (config.provider === 'runninghub') {
    const output = runningHubVideoResult(body, config.runningHubOutputNodeIds);
    const resultUrl = output?.resultUrl;
    const code = nestedValue(body, 'errorCode');
    const envelopeCode = nestedValue(body, 'code');
    const hasError = code != null && code !== '' && String(code) !== '0'
      || envelopeCode != null && envelopeCode !== '' && String(envelopeCode) !== '0';
    const failed = /^(?:failed|fail|error|cancelled|canceled)$/u.test(rawStatus) || hasError;
    const succeeded = /^(?:success|succeeded|completed|done)$/u.test(rawStatus);
    const error = nestedValue(body, settings.errorPath || 'errorMessage') || nestedValue(body, 'message') || nestedValue(body, 'msg');
    if (failed) return { remoteTaskId: mapped.remoteTaskId, stage: 'failed', status: 'failed', message: String(error || `RunningHub 任务失败${code ? `（${String(code)}）` : ''}`) };
    if (succeeded && !resultUrl) {
      const downloadError = config.runningHubOutputNodeIds?.length
        ? 'RunningHub 已完成，但指定输出节点没有返回可下载的视频或 ZIP。请核对最终视频节点；未把图片或文本当成视频，也未重新提交。'
        : 'RunningHub 已完成，但未返回可下载的视频或 ZIP 输出（仅图片、音频、文本或空结果）。请检查工作流的视频输出节点；没有重新提交。';
      return { remoteTaskId: mapped.remoteTaskId, stage: 'succeeded', status: 'succeeded', downloadError, message: downloadError };
    }
    if (succeeded) return { remoteTaskId: mapped.remoteTaskId, stage: 'downloading', status: 'succeeded', ...output,
      message: output?.archiveHint ? 'RunningHub 已生成 ZIP，正在下载并提取视频' : 'RunningHub 视频已生成，正在下载保存' };
    // Preview images and partial outputs may be present while still running.
    // Only the provider's terminal success authorizes result download.
    const status = /^(?:running|processing|generating|in_progress)$/u.test(rawStatus) ? 'running'
      : /^(?:preparing|queueing|queued|pending|submitted|created)$/u.test(rawStatus) ? 'submitted' : 'unknown';
    return { remoteTaskId: mapped.remoteTaskId, stage: status === 'running' ? 'running' : 'queued', status,
      message: rawStatus ? `RunningHub 状态：${rawStatus}` : '等待 RunningHub 返回任务状态' };
  }
  const resultUrl = mapped.resultUrl;
  const status = /preparing|queueing|queued|pending/iu.test(rawStatus) ? 'submitted' : resultUrl ? 'succeeded' : mapped.status === 'draft' || mapped.status === 'submitting' ? 'unknown' : mapped.status;
  const progressValue = settings.progressPath ? nestedValue(body, settings.progressPath) : undefined;
  const progress = typeof progressValue === 'number' && Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : undefined;
  const fileValue = settings.fileIdPath ? nestedValue(body, settings.fileIdPath) : undefined;
  return {
    ...mapped, resultUrl, status,
    stage: status === 'succeeded' ? 'downloading' : status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'queued',
    progress,
    fileId: typeof fileValue === 'number' || typeof fileValue === 'string' ? String(fileValue) : undefined,
    message: status === 'failed' ? String(settings.errorPath ? nestedValue(body, settings.errorPath) || '视频接口报告任务失败' : nestedValue(body, 'base_resp.status_msg') || '视频接口报告任务失败') : rawStatus ? `接口状态：${rawStatus}` : '等待接口返回任务状态',
  };
};

export const redactVideoSecrets = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => redactVideoSecrets(item)) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:api[_-]?key|authorization|access[_-]?token|secret|password)$/iu.test(key))
    .map(([key, item]) => [key, redactVideoSecrets(item)])) as T;
  return value;
};

/** Connection credentials have a protected field; embedding them into persisted templates is unsupported. */
export const assertNoEmbeddedVideoCredentials = (value: unknown, label: string): void => {
  const visit = (item: unknown, path: string) => {
    if (Array.isArray(item)) { item.forEach((child, index) => visit(child, `${path}[${index}]`)); return; }
    if (!record(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|api[_-]?token|client[_-]?secret|secret|password)$/iu.test(key)
        && child != null && child !== '' && child !== false) {
        throw new Error(`${label}的 ${path ? `${path}.` : ''}${key} 包含内嵌凭据。密钥只能填写在连接的密钥字段中，不支持把密钥写进会保存的模板、工作流或参数。`);
      }
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(value, '');
};
