import { createRuntimeErrorLogEntry } from './runtimeErrorLog';

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);

/** Preserve HTTP diagnostics without exposing a provider's echoed credentials or inputs. */
export function createImageApiRequestError(
  status: number,
  responseBody: string,
  payload: unknown,
  knownSecrets: readonly string[] = [],
): Error & { status: number; code?: string } {
  const body = asRecord(payload);
  const providerError = asRecord(body?.error);
  const detail = [providerError?.message, providerError?.detail, body?.error, body?.message, body?.detail, body?.error_description]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    || (typeof payload === 'string' ? payload : body ? '服务未提供可读的错误说明' : responseBody.trim())
    || '服务未提供错误说明';
  const rawCode = providerError?.code ?? body?.code;
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  const diagnostic = createRuntimeErrorLogEntry({
    stage: 'image-generation',
    error: { message: `图像接口请求失败（HTTP ${status}）：${detail}`, status, code },
    knownSecrets,
  });
  const error = Object.assign(new Error(diagnostic?.message || `图像接口请求失败（HTTP ${status}）`), { status });
  return Object.assign(error, diagnostic?.code ? { code: diagnostic.code } : {});
}
