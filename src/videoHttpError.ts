import { getSafeErrorDiagnostics, type ErrorDiagnosticOptions } from './errorDiagnostics';

const INPUT_LIMIT = 32_000;
const MESSAGE_LIMIT = 2_000;
const TRUNCATED = '\n[详情过长，已截断]';
const HTML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export interface VideoHttpErrorOptions extends ErrorDiagnosticOptions {
  /** Actual encoded request bytes, not the length of the JavaScript string. */
  requestBytes?: number;
  requestContentType?: string;
}

/** Read only known data fields; a provider error must not invoke accessors. */
const property = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
};

const scalar = (value: unknown): string => (
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
);

const decodeEntities = (text: string): string => text.replace(
  /&(?:#(x[0-9a-f]+|\d+)|(amp|lt|gt|quot|apos|nbsp));/giu,
  (whole, numeric: string | undefined, named: string | undefined) => {
    if (named) return HTML_ENTITIES[named.toLowerCase()] || whole;
    const code = numeric?.toLowerCase().startsWith('x')
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric || '', 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  },
);

/** Extract text without a DOM or executing scripts; an incomplete block is discarded too. */
const readableText = (source: string): string => decodeEntities(source.slice(0, INPUT_LIMIT))
  .replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)/gu, ' ')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, ' ')
  .replace(/<\/?[a-z][^>]*>/giu, ' ')
  .replace(/<![^>]*>/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

/** A bounded, safe message suitable for the existing HttpError and saved task error. */
export const formatVideoHttpError = (
  status: number,
  body: unknown,
  options: VideoHttpErrorOptions = {},
): string => {
  let payload = body;
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.length <= INPUT_LIMIT && /^[\[{]/u.test(text)) {
      try { payload = JSON.parse(text) as unknown; } catch { /* Plain text/HTML remains readable below. */ }
    }
  }

  const error = property(payload, 'error');
  const baseResponse = property(payload, 'base_resp');
  const candidates = typeof payload === 'string' ? [payload] : [
    property(error, 'message'), property(payload, 'message'),
    property(baseResponse, 'status_msg'), error,
    property(error, 'detail'), property(payload, 'detail'), property(payload, 'error_description'),
  ];
  const messages: string[] = [];
  for (const candidate of candidates) {
    const text = readableText(scalar(candidate));
    if (!text) continue;
    const safe = getSafeErrorDiagnostics(text, options).message;
    if (!messages.includes(safe)) messages.push(safe);
  }

  const codes: string[] = [];
  for (const [label, value] of [
    ['error.code', property(error, 'code')],
    ['code', property(payload, 'code')],
    ['base_resp.status_code', property(baseResponse, 'status_code')],
  ] as const) {
    const text = readableText(scalar(value));
    if (!text) continue;
    const safe = getSafeErrorDiagnostics({ code: text }, options).code;
    if (safe) codes.push(`${label}=${safe}`);
  }

  const lines = [`视频接口请求失败（HTTP ${status}）`];
  if (status === 413) {
    if (typeof options.requestBytes === 'number' && Number.isFinite(options.requestBytes) && options.requestBytes >= 0) {
      const contentType = options.requestContentType?.split(';', 1)[0]?.trim();
      const mime = contentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(contentType) ? `，${contentType}` : '';
      lines.push(`本次请求大小：${(options.requestBytes / 1024 / 1024).toFixed(2)} MiB${mime}。`);
    }
    lines.push('服务端拒绝了过大的请求体。请压缩参考图片，或按接口支持的方式使用图片 URL／文件上传；具体大小上限请向服务商确认。');
  }
  if (codes.length) lines.push(`错误码：${codes.join('；')}`);
  lines.push(messages.length ? `服务端说明：${messages.join('\n')}` : '服务端未提供可读的错误说明。');
  const result = lines.join('\n');
  return result.length > MESSAGE_LIMIT ? result.slice(0, MESSAGE_LIMIT - TRUNCATED.length) + TRUNCATED : result;
};
