import type { ImageApiConfig } from '../types';
import { buildRunningHubImageRequest, type RunningHubImageInput } from '../runningHubImage';
import { normalizeReferenceImageDataUrl, referenceImageFileName } from '../imageReferenceData';
import { isRunningHubUploadedFile } from '../videoGenerationApi';

const liveRunningHubImageTasks = new Map<string, number>();
/** True while this page is already querying that accepted RunningHub image task. */
export const isRunningHubImageObservationLive = (taskId: string): boolean => (liveRunningHubImageTasks.get(taskId) || 0) > 0;
const retainRunningHubImageObservation = (taskId: string): (() => void) => {
  liveRunningHubImageTasks.set(taskId, (liveRunningHubImageTasks.get(taskId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (liveRunningHubImageTasks.get(taskId) || 1) - 1;
    if (next > 0) liveRunningHubImageTasks.set(taskId, next);
    else liveRunningHubImageTasks.delete(taskId);
  };
};

export interface RunningHubImageTransport {
  request(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal;
    multipart?: { fields: Array<{ name: string; value: string }>; files: Array<{ name: string; fileName: string; dataUrl: string }> } }): Promise<{ status: number; body: string }>;
  downloadImage?: (url: string) => Promise<string>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}
const abortError = (): Error => Object.assign(new Error('RunningHub 图像查询已取消；已提交的云端任务可能仍在运行，未重新提交。'), { name: 'AbortError' });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const safeMessage = (value: unknown, key: string): string => {
  let text = String(value ?? '').slice(0, 1200);
  if (key) text = text.split(key).join('[已隐藏]');
  return text.replace(/Bearer\s+[^\s"',;]+/giu, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^\s&,;]+/giu, '$1[已隐藏]');
};
const cancellable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(abortError()); };
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); }, error => { signal.removeEventListener('abort', stop); reject(error); });
  });
};
const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, milliseconds);
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
});
const imageUrl = (body: Record<string, unknown>, outputNodeId?: string): string | undefined => {
  if (!Array.isArray(body.results)) return undefined;
  for (const item of body.results) {
    if (!record(item) || outputNodeId && String(item.nodeId ?? item.outputNodeId ?? '') !== outputNodeId) continue;
    if (typeof item.url !== 'string') continue;
    let url: URL; try { url = new URL(item.url); } catch { continue; }
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) continue;
    const type = String(item.outputType || '').trim();
    if (type ? !/^(?:\.?png|\.?jpe?g|\.?webp|image\/(?:png|jpeg|webp))$/iu.test(type)
      : !/\.(?:png|jpe?g|webp)$/iu.test(url.pathname)) continue;
    return item.url;
  }
  return undefined;
};

const isQueryDisconnect = (error: unknown): boolean => {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'GenerationTaskCancelledError')) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/已取得 HTTP 响应|RunningHub 请求失败（HTTP |返回无效 JSON|任务结构无效|查询结果与原任务不匹配|无法识别的任务状态|图像任务失败|图像等待超时|尚未提交|未返回 taskId/u.test(message)) return false;
  return /未取得 HTTP 响应|before secure TLS connection was established|socket hang up|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|阶段：(?:TLS 握手|建立网络连接|等待接口响应|域名解析|读取系统代理|建立系统代理隧道)/u.test(message);
};
const timeoutMessage = (taskId: string): string => taskId
  ? `RunningHub 图像等待超时；原云端任务 ${taskId} 可能仍在运行，请在云端查询，不要重复提交。`
  : 'RunningHub 图像等待超时；原云端任务可能仍在运行，请在云端查询，不要重复提交。';

const watchAcceptedRunningHubImage = async (
  config: ImageApiConfig,
  compiled: { queryEndpoint: string; headers: Record<string, string>; outputNodeId?: string },
  taskId: string,
  initial: Record<string, unknown> | undefined,
  transport: RunningHubImageTransport,
  signal: AbortSignal | undefined,
): Promise<{ url: string; dataUrl?: string; raw: string }> => {
  const now = transport.now ?? Date.now;
  const deadline = now() + (transport.timeoutMs ?? 20 * 60 * 1000);
  const controller = new AbortController();
  const userAbort = () => controller.abort();
  signal?.addEventListener('abort', userAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, transport.timeoutMs ?? 20 * 60 * 1000);
  const check = () => {
    if (timedOut || now() >= deadline) throw new Error(timeoutMessage(taskId));
    if (signal?.aborted || controller.signal.aborted) throw abortError();
  };
  const request = async (body: unknown): Promise<Record<string, unknown>> => {
    check();
    const response = await cancellable(transport.request(compiled.queryEndpoint, {
      method: 'POST', headers: compiled.headers, body: JSON.stringify(body), signal: controller.signal,
    }), controller.signal);
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); } catch { throw new Error(`RunningHub 返回无效 JSON（HTTP ${response.status}）；没有重新提交。`); }
    if (!record(parsed)) throw new Error('RunningHub 返回的任务结构无效；没有重新提交。');
    const payload = record(parsed.data) && ('taskId' in parsed.data || 'status' in parsed.data || 'results' in parsed.data) ? parsed.data : parsed;
    if (response.status < 200 || response.status >= 300 || parsed.code !== undefined && parsed.code !== 0 && parsed.code !== '0') {
      throw new Error(`RunningHub 请求失败（HTTP ${response.status}）：${safeMessage(payload.errorMessage || parsed.msg || parsed.message || '请检查连接与账户状态', config.apiKey)}`);
    }
    if (payload.taskId !== undefined && payload.taskId !== taskId) throw new Error('RunningHub 查询结果与原任务不匹配，已停止读取；没有重新提交。');
    return payload;
  };
  try {
    let payload = initial;
    for (;;) {
      if (!payload) {
        try { payload = await request({ taskId }); }
        catch (error) {
          if (!isQueryDisconnect(error)) throw error;
          await cancellable((transport.wait ?? wait)(transport.pollIntervalMs ?? 1000, controller.signal), controller.signal);
          continue;
        }
      }
      check();
      const status = String(payload.status || '').toUpperCase();
      if (status === 'SUCCESS') {
        const url = imageUrl(payload, compiled.outputNodeId);
        if (!url) throw new Error('RunningHub 原任务已完成，但所选输出节点没有 PNG/JPEG/WebP 图片；没有重新提交。');
        let dataUrl: string | undefined;
        if (transport.downloadImage) {
          try { dataUrl = await cancellable(transport.downloadImage(url), controller.signal); }
          catch {
            // Preserve the completed task's URL for the existing save retry.
            // A download failure must not turn a paid success into a new run.
            check();
          }
        }
        check();
        return { url, ...(dataUrl ? { dataUrl } : {}), raw: JSON.stringify(payload) };
      }
      if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(status)) {
        throw new Error(`RunningHub 图像任务失败：${safeMessage(payload.errorMessage || payload.message || status, config.apiKey)}`);
      }
      if (status && !['QUEUED', 'RUNNING', 'PENDING', 'CREATED'].includes(status)) throw new Error('RunningHub 返回无法识别的任务状态，请在云端查询原任务；没有重新提交。');
      await cancellable((transport.wait ?? wait)(transport.pollIntervalMs ?? 1000, controller.signal), controller.signal);
      check();
      try { payload = await request({ taskId }); }
      catch (error) {
        if (!isQueryDisconnect(error)) throw error;
        await cancellable((transport.wait ?? wait)(transport.pollIntervalMs ?? 1000, controller.signal), controller.signal);
        payload = undefined;
      }
    }
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message.startsWith('RunningHub 图像等待超时'))) throw new Error(timeoutMessage(taskId));
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', userAbort);
  }
};

/** Query one accepted RunningHub image task. This never uploads or submits. */
export const observeRunningHubImageTask = (
  config: ImageApiConfig,
  taskId: string,
  transport: RunningHubImageTransport,
  signal?: AbortSignal,
): Promise<{ url: string; dataUrl?: string; raw: string }> => {
  const compiled = buildRunningHubImageRequest(config, { prompt: '已接受的云端任务', referenceCount: 0, uploadedImages: [] });
  return watchAcceptedRunningHubImage(config, compiled, taskId.trim(), undefined, transport, signal);
};

/** Exactly one paid POST; later connection failures keep querying that task. */
export const requestRunningHubImage = async (
  config: ImageApiConfig,
  input: RunningHubImageInput & {
    signal?: AbortSignal;
    referenceImages?: string[];
    onRemoteTaskId?: (taskId: string) => void | Promise<void>;
  },
  transport: RunningHubImageTransport,
  onStart?: () => void | Promise<void>,
): Promise<{ url: string; dataUrl?: string; raw: string }> => {
  const references = (input.referenceImages ?? []).map(normalizeReferenceImageDataUrl);
  if (input.referenceCount !== undefined && input.referenceCount !== references.length) {
    // Keep unsupported-reference diagnostics specific before any upload/paid POST.
    buildRunningHubImageRequest(config, { ...input, uploadedImages: references.map((_, index) => `preflight-${index}.png`) });
    throw new Error('所选参考图数量与图片内容不一致，尚未提交。');
  }
  let compiled = buildRunningHubImageRequest(config, { ...input, referenceCount: references.length,
    uploadedImages: references.map((_, index) => `preflight-${index}.png`) });
  const now = transport.now ?? Date.now;
  const deadline = now() + (transport.timeoutMs ?? 20 * 60 * 1000);
  const controller = new AbortController();
  const userAbort = () => controller.abort();
  input.signal?.addEventListener('abort', userAbort, { once: true });
  let timedOut = false;
  let acceptedTaskId = '';
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, transport.timeoutMs ?? 20 * 60 * 1000);
  const check = () => { if (timedOut || now() >= deadline) throw new Error(timeoutMessage(acceptedTaskId)); if (input.signal?.aborted || controller.signal.aborted) throw abortError(); };
  const request = async (url: string, body: unknown, multipart?: NonNullable<Parameters<RunningHubImageTransport['request']>[1]['multipart']>): Promise<Record<string, unknown>> => {
    check();
    const response = await cancellable(transport.request(url, { method: 'POST',
      headers: multipart ? { Authorization: compiled.headers.Authorization } : compiled.headers,
      ...(multipart ? { multipart } : { body: JSON.stringify(body) }), signal: controller.signal }), controller.signal);
    let parsed: unknown; try { parsed = JSON.parse(response.body); } catch { throw new Error(`RunningHub 返回无效 JSON（HTTP ${response.status}）；没有重新提交。`); }
    if (!record(parsed)) throw new Error('RunningHub 返回的任务结构无效；没有重新提交。');
    const payload = record(parsed.data) && ('taskId' in parsed.data || 'status' in parsed.data || 'results' in parsed.data) ? parsed.data : parsed;
    if (response.status < 200 || response.status >= 300 || parsed.code !== undefined && parsed.code !== 0 && parsed.code !== '0') {
      throw new Error(`RunningHub 请求失败（HTTP ${response.status}）：${safeMessage(payload.errorMessage || parsed.msg || parsed.message || '请检查连接与账户状态', config.apiKey)}`);
    }
    return payload;
  };
  try {
    check();
    const uploadedImages: string[] = [];
    for (const [index, dataUrl] of references.entries()) {
      const upload = await request(compiled.uploadEndpoint, undefined, { fields: [], files: [{ name: 'file',
        fileName: referenceImageFileName(`reference-${index + 1}`, dataUrl), dataUrl }] });
      const data = record(upload.data) ? upload.data : upload;
      const remote = typeof data.fileName === 'string' && data.fileName.trim() ? data.fileName.trim() : data.download_url;
      if (!isRunningHubUploadedFile(remote)) throw new Error('RunningHub 图片上传未返回有效的 data.fileName / download_url，尚未提交图像任务。');
      uploadedImages.push(remote);
    }
    if (references.length) compiled = buildRunningHubImageRequest(config, { ...input, referenceCount: references.length, uploadedImages });
    check(); await onStart?.(); check();
    const payload = await request(compiled.endpoint, compiled.body);
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (!taskId) throw new Error('RunningHub 未返回 taskId；提交结果未确认，不能自动重复提交。');
    acceptedTaskId = taskId;
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', userAbort);
    const releaseObservation = retainRunningHubImageObservation(taskId);
    try {
      try { await input.onRemoteTaskId?.(taskId); }
      catch (error) {
        if (input.signal?.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'GenerationTaskCancelledError'))) throw error;
      }
      const remaining = deadline - now();
      return await watchAcceptedRunningHubImage(config, compiled, taskId, payload, { ...transport, timeoutMs: Math.max(1, remaining) }, input.signal);
    } finally { releaseObservation(); }
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message.startsWith('RunningHub 图像等待超时'))) throw new Error(timeoutMessage(acceptedTaskId));
    if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    if (error instanceof Error && error.name === 'GenerationTaskCancelledError') throw error;
    throw new Error(safeMessage(error instanceof Error ? error.message : error, config.apiKey));
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', userAbort); }
};
