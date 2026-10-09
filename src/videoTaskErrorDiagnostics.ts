import { getSafeErrorDiagnostics, type ErrorDiagnosticOptions, type SafeErrorDiagnostics } from './errorDiagnostics';
import { runningHubWholePromptPictureNumbers } from './runningHubPromptPictures';
import { videoReferenceSlotIndex } from './videoReferenceSlots';
import type { VideoGenerationTask } from './types';

const dataProperty = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
};
const textValue = (value: unknown): string => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const emptyMessage = getSafeErrorDiagnostics(undefined).message;

/** Request strings are used only as redaction candidates, never as diagnostics.
 * Bound traversal and data descriptors prevent getters/toJSON from executing. */
export const videoTaskErrorOptions = (task: VideoGenerationTask, knownSecrets?: readonly string[]): ErrorDiagnosticOptions => {
  const sensitiveTexts: string[] = [];
  const prompt = task.videoJob?.snapshot.draft.prompt;
  if (prompt) sensitiveTexts.push(prompt);
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: task.requestBody, depth: 0 },
    { value: task.videoJob?.snapshot.draft.parameters, depth: 0 },
  ];
  const seen = new Set<unknown>();
  while (queue.length && seen.size < 256 && sensitiveTexts.length < 256) {
    const { value, depth } = queue.shift()!;
    if (seen.has(value) || depth > 8) continue;
    seen.add(value);
    if (typeof value === 'string') {
      if (value.trim().length >= 4) sensitiveTexts.push(value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    try {
      for (const key of Object.getOwnPropertyNames(value).slice(0, 128)) {
        const item = dataProperty(value, key);
        if (item && (typeof item === 'object' || typeof item === 'string')) queue.push({ value: item, depth: depth + 1 });
      }
    } catch { /* A non-data object is not a source of diagnostics. */ }
  }
  return { knownSecrets, sensitiveTexts };
};

/** Only provider diagnostic fields are read. In particular failedReason can
 * contain current_inputs, traceback and output pixels, which are NOT shown. */
export const videoProviderErrorDiagnostics = (response: unknown, options: ErrorDiagnosticOptions = {}): SafeErrorDiagnostics | undefined => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: response, depth: 0 }];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  const fields: Partial<SafeErrorDiagnostics> = {};
  const add = (value: string) => {
    const safe = getSafeErrorDiagnostics(value, options).message;
    if (safe !== emptyMessage && !messages.includes(safe)) messages.push(safe);
  };
  while (queue.length && seen.size < 24 && messages.length < 16) {
    const { value, depth } = queue.shift()!;
    if (seen.has(value) || depth > 5) continue;
    seen.add(value);
    if (typeof value === 'string') {
      if (/^[\s]*[{[]/u.test(value)) {
        // A structured failedReason must be whitelisted too; never fall back to
        // rendering its JSON body if it cannot be safely read.
        try {
          if (value.length <= 32_000) queue.push({ value: JSON.parse(value), depth: depth + 1 });
        } catch { /* Preserve other diagnostic fields instead. */ }
      } else if (value.trim()) add(value);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const messageParts = ['errorMessage', 'error_message', 'message', 'error_description', 'detail', 'msg', 'reason', 'exception_message', 'status_msg']
      .map((key) => textValue(dataProperty(value, key))).filter(Boolean);
    const nodeId = textValue(dataProperty(value, 'node_id') ?? dataProperty(value, 'nodeId'));
    // RunningHub also reports the failing ComfyUI class as node_name.
    const nodeType = ['node_type', 'nodeType', 'node_name', 'nodeName']
      .map((key) => textValue(dataProperty(value, key))).find(Boolean) || '';
    const exceptionType = textValue(dataProperty(value, 'exception_type'));
    const node = [nodeId ? `节点：${nodeId}` : '', nodeType ? `节点类型：${nodeType}` : '', exceptionType ? `异常类型：${exceptionType}` : ''].filter(Boolean).join('；');
    for (const message of messageParts) {
      if (/^[\s]*[{[]/u.test(message)) queue.push({ value: message, depth: depth + 1 });
      else add(message);
    }
    if (node) add(node);
    const metadata = getSafeErrorDiagnostics({
      status: dataProperty(value, 'statusCode') ?? dataProperty(value, 'httpStatus') ?? dataProperty(value, 'status'),
      code: dataProperty(value, 'errorCode') ?? dataProperty(value, 'error_code') ?? dataProperty(value, 'code') ?? dataProperty(value, 'status_code'),
      stage: dataProperty(value, 'networkStage') ?? dataProperty(value, 'stage'),
      route: dataProperty(value, 'networkRoute') ?? dataProperty(value, 'route'),
      endpoint: dataProperty(value, 'networkEndpoint') ?? dataProperty(value, 'endpoint'),
    }, options);
    for (const key of ['status', 'code', 'stage', 'route', 'endpoint'] as const) {
      const item = metadata[key];
      if (fields[key] === undefined && item !== undefined && item !== '' && item !== '0') Object.assign(fields, { [key]: item });
    }
    for (const key of ['error', 'cause', 'response', 'data', 'failedReason', 'failed_reason', 'base_resp']) {
      const item = dataProperty(value, key);
      if (item && (typeof item === 'object' || typeof item === 'string')) queue.push({ value: item, depth: depth + 1 });
    }
  }
  return messages.length || Object.keys(fields).length ? { message: messages.join('\n原因：') || emptyMessage, ...fields } : undefined;
};

export interface VideoTaskDiagnosticEntry {
  key: 'generation' | 'download' | 'action';
  label: string;
  error: SafeErrorDiagnostics;
  summaryError?: SafeErrorDiagnostics;
}
const mergeDiagnostics = (values: readonly (SafeErrorDiagnostics | undefined)[]): SafeErrorDiagnostics | undefined => {
  const diagnostics = values.filter((value): value is SafeErrorDiagnostics => Boolean(value));
  if (!diagnostics.length) return undefined;
  // Provider extraction and nested causes use this same separator. Dedupe each
  // cause, so a provider response with extra node metadata does not repeat the
  // identical task/runtime error in the visible summary.
  const messages = [...new Set(diagnostics.flatMap((value) => value.message.split('\n原因：')).filter((message) => message !== emptyMessage))];
  const fields: Partial<SafeErrorDiagnostics> = {};
  for (const value of diagnostics) {
    for (const key of ['status', 'code', 'stage', 'route', 'endpoint'] as const) {
      if (fields[key] === undefined && value[key] !== undefined) Object.assign(fields, { [key]: value[key] });
    }
  }
  return { message: messages.join('\n原因：') || emptyMessage, ...fields };
};

/** Historical evidence only. The existing provider extractor supplies its
 * whitelisted, redacted message; neither remote inputs nor tracebacks are read.
 * A completed local upload plus a verified prefix mapping proves our connected
 * set, without claiming which later cloud node changed its prompt. */
const runningHubHistoricalPictureDiagnostic = (
  task: VideoGenerationTask, provider: SafeErrorDiagnostics | undefined,
): string | undefined => {
  const job = task.videoJob; const snapshot = job?.snapshot; const api = snapshot?.connection.api;
  if (task.status !== 'failed' || !task.remoteTaskId?.trim() || snapshot?.connection.backend !== 'api'
    || api?.provider !== 'runninghub' || !provider || job?.preparation?.phase !== 'acknowledged') return;
  const counts = api.runningHubMappedFields?.filter((field) => field.kind === 'image-count') || [];
  if (counts.length !== 1 || counts[0].imageCountMode !== 'prefix'
    || !['verified-app', 'explicit'].includes(counts[0].imageCountSource || '')) return;
  const images = snapshot.images; const references = snapshot.draft.references;
  const uploads = job.preparation.uploadedImages; const count = images.length;
  if (!count || references.length !== count || uploads.length !== count
    || uploads.some((value) => typeof value !== 'string' || !value.trim())) return;
  const mappedSlots = (api.runningHubMappedFields || []).filter((field) => field.kind === 'image').map((field) => field.imageIndex);
  if (new Set(mappedSlots).size !== mappedSlots.length) return;
  if (images.some((image, index) => image.freezeState !== 'frozen'
    || image.assetId !== references[index].assetId
    || videoReferenceSlotIndex(image, index) !== index || videoReferenceSlotIndex(references[index], index) !== index
    || !mappedSlots.includes(index))) return;
  const local = runningHubWholePromptPictureNumbers(snapshot.draft.prompt);
  const connected = new Set(Array.from({ length: count }, (_, index) => String(index + 1)));
  if (local.some((number) => !connected.has(number))) return;
  const message = provider.message;
  if (!/节点类型：(?:MiniMaxH3AudioConditioningT8|MiniMaxH3NodeProviderT8)(?:；|\n|$)/iu.test(message)
    || !/MiniMax H3 prompt media tag validation failed:/iu.test(message)) return;
  const rejected = [...message.matchAll(/<Picture\s+(\d+)>\s+is not connected;\s+available picture count is\s+(\d+)\b/giu)];
  if (!rejected.length || rejected.some((match) => Number(match[2]) !== count)) return;
  const remote = [...new Set(rejected.map((match) => match[1].replace(/^0+(?=\d)/u, '')))];
  if (remote.some((number) => connected.has(number) || local.includes(number))
    || runningHubWholePromptPictureNumbers(message).some((number) => !remote.includes(number))) return;
  const labels = (numbers: readonly string[]) => numbers.map((number) => `<Picture ${number}>`).join('、') || '无图片标签';
  return `历史提交核对：本地已提交 ${count} 张图片，保存的正文仅引用 ${labels(local)}，均在已连接范围内；云端后续处理却报告未连接的 ${labels(remote)}（可用图片数 ${count}），这些编号未出现在本地保存正文中。请让工作流作者核对云端后续处理及最终 H3 输入；若公开应用不能绕过这一步，可改用直接接收最终 H3 正文的工作流。此记录保留，未重新提交任务。`;
};

/** A single generation-error block replaces the old duplicate grey/red lines;
 * distinct save/action failures keep their own labelled diagnostic block. */
export const videoTaskDiagnosticEntries = (input: {
  task: VideoGenerationTask;
  failed: boolean;
  message?: string;
  tailFailureMessage?: string;
  downloadError?: string;
  actionError?: unknown;
  suppressGenerationFailure?: boolean;
}, options: ErrorDiagnosticOptions): VideoTaskDiagnosticEntry[] => {
  const entries: VideoTaskDiagnosticEntry[] = [];
  const diagnostic = (value: unknown) => value === undefined || value === null || value === '' ? undefined : getSafeErrorDiagnostics(value, options);
  const download = diagnostic(input.downloadError);
  const taskError = diagnostic(input.task.error);
  const failureMessage = diagnostic(input.failed ? input.message : undefined);
  const providerError = input.failed && !download ? videoProviderErrorDiagnostics(input.task.response, options) : undefined;
  const historicalPictures = input.failed && !download ? runningHubHistoricalPictureDiagnostic(input.task, providerError) : undefined;
  const tailError = diagnostic(input.tailFailureMessage);
  const primaryCandidates = [
    taskError?.message === download?.message ? undefined : taskError,
    providerError,
    failureMessage?.message === download?.message ? undefined : failureMessage,
    tailError,
  ].filter((value): value is SafeErrorDiagnostics => Boolean(value));
  const failure = input.suppressGenerationFailure ? undefined : mergeDiagnostics([
    taskError?.message === download?.message ? undefined : taskError,
    failureMessage?.message === download?.message ? undefined : failureMessage,
    tailError,
    providerError,
  ]);
  if (failure) {
    // Old saved generic labels are not a more informative cause than the
    // provider's actual error. Never infer a reason from unrelated node data.
    const isPlaceholder = (message: string) => message === emptyMessage || /^(?:操作失败，暂时无法识别具体原因|视频接口报告任务失败|RunningHub 任务失败(?:（[^）]*）)?|生成失败)[。.]?$/u.test(message);
    const primary = primaryCandidates.find((value) => !isPlaceholder(value.message.split('\n原因：')[0])) || primaryCandidates[0];
    entries.push({ key: 'generation', label: '失败原因', error: historicalPictures ? { ...failure, message: `${failure.message}\n${historicalPictures}` } : failure,
      summaryError: { ...failure, message: `${primary?.message.split('\n原因：')[0] || failure.message}${historicalPictures ? `\n${historicalPictures}` : ''}` } });
  }
  else if (input.failed && !input.suppressGenerationFailure && !download) entries.push({
    key: 'generation', label: '失败原因', error: getSafeErrorDiagnostics('此任务没有保存可读的错误详情，无法从现有记录确定原因。'),
  });
  if (download) entries.push({ key: 'download', label: '保存失败原因', error: download });
  const action = diagnostic(input.actionError);
  if (action && !entries.some((entry) => JSON.stringify(entry.error) === JSON.stringify(action))) entries.push({ key: 'action', label: '操作失败原因', error: action });
  return entries;
};
