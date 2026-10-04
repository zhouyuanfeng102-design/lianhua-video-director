/** Presentation-only diagnostics. Never serialize an arbitrary provider error:
 * it may also contain request bodies, credentials, reference images or prompts. */
export interface ErrorDiagnosticOptions {
  knownSecrets?: readonly string[];
  sensitiveTexts?: readonly string[];
}

export interface SafeErrorDiagnostics {
  message: string;
  status?: number;
  code?: string;
  stage?: string;
  route?: string;
  endpoint?: string;
}

const REDACTED = '[已脱敏]';
const INPUT_LIMIT = 32_000;
const MESSAGE_LIMIT = 4_000;
const FIELD_LIMIT = 240;
const EMPTY_MESSAGE = '服务未提供可读的错误说明。';

/** Only data properties are read. Accessors/toString/toJSON are not diagnostics. */
const dataProperty = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
};

const literalReplace = (source: string, target: string): string => (
  target ? source.split(target).join(REDACTED) : source
);

const redactKnown = (source: string, values: readonly string[]): string => {
  let result = source;
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const text = value.trim();
    variants.add(text);
    variants.add(JSON.stringify(text).slice(1, -1));
    try { variants.add(encodeURIComponent(text)); } catch { /* Malformed Unicode: raw form is still removed. */ }
  }
  for (const value of [...variants].sort((left, right) => right.length - left.length)) {
    result = literalReplace(result, value);
    // A bounded input can end in the middle of an echoed long prompt/secret.
    // Remove that partial suffix too; do not expose the first part of it.
    if (value.length >= 16) {
      let start = result.indexOf(value.slice(0, 16));
      while (start >= 0) {
        const suffix = result.slice(start);
        if (suffix.length < value.length && value.startsWith(suffix)) {
          result = result.slice(0, start) + REDACTED;
          break;
        }
        start = result.indexOf(value.slice(0, 16), start + 1);
      }
    }
  }
  return result;
};

const urlOrigin = (source: string): string => {
  try {
    const parsed = new URL(source);
    return /^(?:https?|wss?):$/u.test(parsed.protocol) ? parsed.origin : REDACTED;
  } catch { return REDACTED; }
};

/** Prefer hiding the remainder of a payload over guessing where a multiline
 * request/credential ends. Structured status/code fields are kept separately. */
const sanitizeText = (
  source: string,
  options: ErrorDiagnosticOptions,
  limit = MESSAGE_LIMIT,
): string => {
  const secrets = [...(options.knownSecrets || []), ...(options.sensitiveTexts || [])];
  let text = redactKnown(source.slice(0, INPUT_LIMIT), secrets)
    .replace(/\\u00([0-9a-f]{2})/giu, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
    // JSON-encoded diagnostic strings can escape both their quotes and slashes.
    .replace(/\\(["'\/])/gu, '$1');
  const sensitiveLabel = /(?:^|[\s,{;；，：（(])(?:["']?)(?:request[\s_-]*body|response[\s_-]*body|body|payload|prompts?|(?:system|user|negative)[\s_-]*prompt|source[\s_-]*story(?:content)?|messages|inputs?|base64|b64_json|request[\s_-]*data|model[\s_-]*response|请求体|提示词|完整剧情|模型(?:完整)?响应|authorization|proxy[\s_-]*authorization|cookies?|set[\s_-]*cookie|(?:x[\s_-]*)?api[\s_-]*key|apikey|keys?|(?:access|refresh|id|auth|session|csrf|xsrf)[\s_-]*token|tokens?|auth|password|passwd|secret(?:[\s_-]*key)?|client[\s_-]*secret|credentials?)["']?\s*[:=：]\s*/iu;
  const sensitive = sensitiveLabel.exec(text);
  if (sensitive) text = text.slice(0, sensitive.index + sensitive[0].length) + REDACTED;
  text = text
    .replace(/\b(?:bearer|basic)\s+[^\r\n]*/giu, `认证凭据 ${REDACTED}`)
    .replace(/data:[^\s,]*,[\s\S]*/giu, REDACTED)
    // No URL username/password, path, query or fragment is useful enough to
    // justify leaking embedded credentials. Endpoint origin is sufficient here.
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'，。；）}]+/giu, (url) => urlOrigin(url))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, REDACTED)
    .replace(/[A-Za-z0-9+/_=-]{128,}/gu, REDACTED);
  text = redactKnown(text, secrets).trim();
  return text.length > limit ? `${text.slice(0, limit)}\n[详情过长，已截断]` : text;
};

const scalarString = (value: unknown): string => (
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
);

/** Whitelisted, bounded traversal also handles cyclic causes and plain errors. */
export const getSafeErrorDiagnostics = (
  error: unknown,
  options: ErrorDiagnosticOptions = {},
): SafeErrorDiagnostics => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  const fields: Partial<SafeErrorDiagnostics> = {};
  while (queue.length && seen.size < 16) {
    const next = queue.shift()!;
    if (seen.has(next.value) || next.depth > 4) continue;
    seen.add(next.value);
    if (typeof next.value === 'string') {
      const message = sanitizeText(next.value, options);
      if (message && !messages.includes(message)) messages.push(message);
      continue;
    }
    if (!next.value || typeof next.value !== 'object') continue;
    for (const key of ['message', 'error_description', 'detail', 'statusText']) {
      const value = dataProperty(next.value, key);
      if (typeof value === 'string' && value.trim()) {
        const message = sanitizeText(value, options);
        if (message && !messages.includes(message)) messages.push(message);
        break;
      }
    }
    if (fields.status === undefined) {
      const value = scalarString(dataProperty(next.value, 'status') ?? dataProperty(next.value, 'statusCode'));
      if (/^[1-5]\d{2}$/u.test(value)) fields.status = Number(value);
    }
    for (const [key, aliases] of [
      ['code', ['code']],
      ['stage', ['stage', 'networkStage']],
      ['route', ['route', 'networkRoute']],
    ] as const) {
      if (fields[key]) continue;
      const value = aliases.map((alias) => scalarString(dataProperty(next.value, alias))).find((candidate) => candidate.trim()) || '';
      if (value.trim()) fields[key] = sanitizeText(value, options, FIELD_LIMIT);
    }
    if (!fields.endpoint) {
      const url = ['endpoint', 'networkEndpoint', 'url']
        .map((alias) => scalarString(dataProperty(next.value, alias)))
        .find((candidate) => candidate.trim()) || '';
      if (url.trim()) fields.endpoint = sanitizeText(urlOrigin(url.trim()), options, FIELD_LIMIT);
    }
    for (const key of ['error', 'cause', 'response']) {
      const value = dataProperty(next.value, key);
      if (value && (typeof value === 'string' || typeof value === 'object')) queue.push({ value, depth: next.depth + 1 });
    }
  }
  const message = (messages.join('\n原因：') || EMPTY_MESSAGE).slice(0, MESSAGE_LIMIT + 30);
  const status = message.match(/\b(?:HTTP[ /]*|status(?:\s*code)?["']?\s*[:=]?\s*)([1-5]\d{2})\b/iu)?.[1];
  if (fields.status === undefined && status) fields.status = Number(status);
  if (!fields.code) fields.code = message.match(/(?:\bcode|错误码)["']?\s*[:=：]\s*["']?([\w.-]{1,100})/iu)?.[1]
    || message.match(/\b(?:E[A-Z][A-Z0-9_]{2,80}|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)\b/u)?.[0];
  for (const [key, labels] of [['stage', 'stage|networkStage|阶段'], ['route', 'route|networkRoute|传输路由|路由']] as const) {
    if (!fields[key]) fields[key] = message.match(new RegExp(`(?:^|[\\s,{;；（(])["']?(?:${labels})["']?\\s*[:=：]\\s*["']?([^\\r\\n,;；，"'}\\]）)]{1,120})`, 'iu'))?.[1]?.trim();
  }
  if (!fields.endpoint) fields.endpoint = message.match(/\b(?:https?|wss?):\/\/[^\s<>"'，。；）}]+/iu)?.[0];
  return { message, ...fields };
};

export const formatSafeErrorDiagnostics = (
  error: unknown,
  options: ErrorDiagnosticOptions = {},
): string => {
  const detail = getSafeErrorDiagnostics(error, options);
  return [
    `原始错误（已脱敏）：${detail.message}`,
    detail.status !== undefined ? `HTTP 状态：${detail.status}` : '',
    detail.code ? `错误码：${detail.code}` : '',
    detail.stage ? `阶段：${detail.stage}` : '',
    detail.route ? `传输路由：${detail.route}` : '',
    detail.endpoint ? `服务地址（仅域名）：${detail.endpoint}` : '',
  ].filter(Boolean).join('\n');
};
