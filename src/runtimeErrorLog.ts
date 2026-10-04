/**
 * Small, project-independent runtime error history.
 *
 * The log deliberately lives outside AppState: recording a failure must not
 * create an undo step, trigger project autosave, or leak diagnostics into a
 * project export. Storage is resolved lazily so the pure helpers also work in
 * tests and non-browser runtimes.
 */

export const RUNTIME_ERROR_LOG_STORAGE_KEY = 'lianhua_runtime_error_log_v1';
export const RUNTIME_ERROR_LOG_MAX_ENTRIES = 100;

const REDACTED = '[已脱敏]';
const MESSAGE_LIMIT = 2_000;
const SHORT_FIELD_LIMIT = 240;

export interface RuntimeErrorLogContext {
  projectId?: string;
  projectName?: string;
  view?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
}

export interface RuntimeErrorLogEntry {
  id: string;
  occurredAt: number;
  stage: string;
  message: string;
  projectId?: string;
  projectName?: string;
  view?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  status?: number;
  code?: string;
}

export interface RuntimeErrorLogEntryInput {
  id?: string;
  occurredAt?: number;
  stage: string;
  error: unknown;
  context?: RuntimeErrorLogContext;
  knownSecrets?: readonly string[];
}

export interface RuntimeErrorLogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const stageLabels: Readonly<Record<string, string>> = Object.freeze({
  'storyboard-director': '智能导演判断',
  'storyboard-plan': 'AI 完整分镜',
  'storyboard-materialize': '分镜结构落地',
  'storyboard-convert': '最终提示词转换',
  'video-reference-prompt': '参考图组合提示词AI复核',
  'storyboard-translate': '英文版提示词生成',
  'storyboard-commit': '保存生成结果',
  'storyboard-preflight': '生成前检查',
  'sequence-master': '全片分镜与提示词',
  'sequence-ai-segmentation': 'AI 长剧情分段',
  'sequence-semantic-planning': 'AI 理解剧情并分段',
  'story-analysis': '剧情解析',
  'story-preparation': 'AI 剧情优化/扩写',
  'image-preparation': '生图准备',
  'image-reference-load': '生图参考图读取',
  'image-frame-plan': '分镜静帧规划（文本 API）',
  'image-prompt-convert': '生图提示词转换（文本 API）',
  'image-identity-enrich': '人物外貌资料补齐（文本 API）',
  'image-generation': '图像生成',
  'image-result-save': '图像结果保存',
  'api-connection': 'API 连接',
  'local-save': '本地保存',
  render: '界面渲染',
});

const bounded = (value: unknown, limit = SHORT_FIELD_LIMIT): string => (
  typeof value === 'string' ? value.trim().slice(0, limit) : ''
);

const replaceAllLiteral = (source: string, target: string, replacement: string): string => (
  target ? source.split(target).join(replacement) : source
);

/** Remove labelled payloads that must never enter diagnostics. */
const removeSensitivePayloads = (source: string): string => source
  .replace(
    /((?:request\s*body|requestBody|请求体|systemPrompt|userPrompt|sourceStory(?:Content)?|完整剧情|model\s*response|模型(?:完整)?响应)\s*[:=]\s*)(?:[^\r\n;]*|\{[^\r\n]*\}|\[[^\r\n]*\])/giu,
    `$1${REDACTED}`,
  )
  .replace(/data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu, REDACTED);

const sanitizeDiagnosticText = (
  value: unknown,
  knownSecrets: readonly string[] = [],
): { text: string; redacted: boolean } => {
  const original = typeof value === 'string' ? value : String(value ?? '未知错误');
  let text = removeSensitivePayloads(original);

  [...new Set(knownSecrets.map((secret) => secret.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .forEach((secret) => { text = replaceAllLiteral(text, secret, REDACTED); });

  text = text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/giu, `$1${REDACTED}`)
    .replace(/\bbearer\s+[^\s,;"']+/giu, `Bearer ${REDACTED}`)
    .replace(
      /((?:x-api-key|api[_-]?key|apikey|access[_-]?token|token)\s*["']?\s*[:=]\s*["']?)[^\s,;&}"']+/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:x-api-key|api[_-]?key|apikey|access[_-]?token|token|key)=)[^&#\s;]+/giu,
      `$1${REDACTED}`,
    );

  const normalized = text.trim().slice(0, MESSAGE_LIMIT) || '未知错误';
  return { text: normalized, redacted: normalized !== original.trim().slice(0, MESSAGE_LIMIT) };
};

const sanitizeEndpoint = (value: unknown, knownSecrets: readonly string[]): string => {
  const source = bounded(value, 2_000);
  if (!source) return '';
  try {
    const endpoint = new URL(source);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString().replace(/\/$/u, source.endsWith('/') ? '/' : '');
  } catch {
    return sanitizeDiagnosticText(source.replace(/[?#].*$/u, ''), knownSecrets).text;
  }
};

const runtimeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name || '未知错误';
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '未知错误');
  }
  return String(error ?? '未知错误');
};

const optionalField = <K extends keyof RuntimeErrorLogEntry>(
  target: RuntimeErrorLogEntry,
  key: K,
  value: RuntimeErrorLogEntry[K] | undefined,
): void => {
  if (value !== undefined && value !== '') target[key] = value;
};

export const createRuntimeErrorLogEntry = (
  input: RuntimeErrorLogEntryInput,
): RuntimeErrorLogEntry | undefined => {
  if (input.error instanceof Error && input.error.name === 'AbortError') return undefined;

  const occurredAt = Number.isFinite(input.occurredAt)
    ? Number(input.occurredAt)
    : Date.now();
  const sanitizedMessage = sanitizeDiagnosticText(
    runtimeErrorMessage(input.error),
    input.knownSecrets,
  );
  const message = sanitizedMessage.redacted && !sanitizedMessage.text.includes('已脱敏')
    ? `${sanitizedMessage.text}（敏感信息已脱敏）`
    : sanitizedMessage.text;
  const entry: RuntimeErrorLogEntry = {
    id: bounded(input.id, 160)
      || `runtime-error-${occurredAt}-${Math.random().toString(36).slice(2, 10)}`,
    occurredAt,
    stage: bounded(input.stage, 100) || 'runtime',
    message,
  };

  const context = input.context || {};
  optionalField(entry, 'projectId', bounded(context.projectId, 160));
  optionalField(entry, 'projectName', bounded(context.projectName));
  optionalField(entry, 'view', bounded(context.view, 80));
  optionalField(entry, 'provider', bounded(context.provider, 80));
  optionalField(entry, 'model', bounded(context.model, 160));
  optionalField(entry, 'endpoint', sanitizeEndpoint(context.endpoint, input.knownSecrets || []));

  if (input.error && typeof input.error === 'object') {
    const candidate = input.error as { status?: unknown; code?: unknown };
    const status = Number(candidate.status);
    if (Number.isFinite(status) && status >= 100 && status <= 999) entry.status = status;
    const code = bounded(candidate.code, 80);
    if (code) entry.code = sanitizeDiagnosticText(code, input.knownSecrets).text;
  }
  return entry;
};

const entryTimestamp = (entry: RuntimeErrorLogEntry): number => (
  Number.isFinite(entry.occurredAt) ? entry.occurredAt : 0
);

/** Return a new newest-first list; neither input collection is mutated. */
export const appendRuntimeErrorLog = (
  current: readonly RuntimeErrorLogEntry[],
  incoming: RuntimeErrorLogEntry | readonly RuntimeErrorLogEntry[] | undefined,
): RuntimeErrorLogEntry[] => {
  const additions = Array.isArray(incoming) ? incoming : incoming ? [incoming] : [];
  return [...current, ...additions]
    .sort((left, right) => entryTimestamp(right) - entryTimestamp(left))
    .slice(0, RUNTIME_ERROR_LOG_MAX_ENTRIES);
};

const defaultStorage = (): RuntimeErrorLogStorage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try { return window.localStorage; } catch { return undefined; }
};

const isRuntimeErrorLogEntry = (value: unknown): value is RuntimeErrorLogEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeErrorLogEntry>;
  return typeof candidate.id === 'string'
    && typeof candidate.occurredAt === 'number'
    && Number.isFinite(candidate.occurredAt)
    && typeof candidate.stage === 'string'
    && typeof candidate.message === 'string';
};

/** Explicit lazy load; importing this module never touches localStorage. */
export const loadRuntimeErrorLog = (
  storage: RuntimeErrorLogStorage | undefined = defaultStorage(),
): RuntimeErrorLogEntry[] => {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RUNTIME_ERROR_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRuntimeErrorLogEntry).slice(0, RUNTIME_ERROR_LOG_MAX_ENTRIES);
  } catch {
    return [];
  }
};

export const persistRuntimeErrorLog = (
  entries: readonly RuntimeErrorLogEntry[],
  storage: RuntimeErrorLogStorage | undefined = defaultStorage(),
): boolean => {
  if (!storage) return false;
  try {
    storage.setItem(
      RUNTIME_ERROR_LOG_STORAGE_KEY,
      JSON.stringify(entries.slice(0, RUNTIME_ERROR_LOG_MAX_ENTRIES)),
    );
    return true;
  } catch {
    return false;
  }
};

export const clearRuntimeErrorLog = (
  storage: RuntimeErrorLogStorage | undefined = defaultStorage(),
): boolean => {
  if (!storage) return false;
  try {
    storage.removeItem(RUNTIME_ERROR_LOG_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};

export const runtimeErrorStageLabel = (stage: string): string => (
  stageLabels[stage] || stage || '运行错误'
);

export const formatRuntimeErrorLog = (entries: readonly RuntimeErrorLogEntry[]): string => {
  if (!entries.length) return '莲华视频导演台报错日志\n暂无报错记录';
  const sections = entries.map((entry) => {
    const lines = [
      `[${new Date(entry.occurredAt).toLocaleString('zh-CN')}] ${runtimeErrorStageLabel(entry.stage)}`,
      entry.projectName || entry.projectId
        ? `项目：${entry.projectName || '未命名'}${entry.projectId ? `（${entry.projectId}）` : ''}`
        : '',
      entry.view ? `页面：${entry.view}` : '',
      entry.provider || entry.model
        ? `模型：${[entry.provider, entry.model].filter(Boolean).join(' / ')}`
        : '',
      entry.endpoint ? `接口：${entry.endpoint}` : '',
      entry.status ? `HTTP：${entry.status}` : '',
      entry.code ? `代码：${entry.code}` : '',
      `错误：${entry.message}`,
    ].filter(Boolean);
    return lines.join('\n');
  });
  return ['莲华视频导演台报错日志', ...sections].join('\n\n');
};
