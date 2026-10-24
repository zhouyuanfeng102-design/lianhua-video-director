import { runtimeErrorStageLabel } from './runtimeErrorLog';

export interface TextApiUsageContext {
  operationId?: string;
  projectId?: string;
  projectName?: string;
  chapterId?: string;
  chapterName?: string;
  segmentIndex?: number;
  connectionName?: string;
  stage?: string;
}

export interface TextApiUsageRecord extends TextApiUsageContext {
  id: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  stage: string;
  provider: string;
  model: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  inputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  usageSource?: string;
}

export const TEXT_API_USAGE_STORAGE_KEY = 'lianhua_text_api_usage_v1';
export const TEXT_API_USAGE_LIMIT = 1000;
const contextKey = Symbol('text-api-usage-context');
type ContextCarrier = { [contextKey]?: TextApiUsageContext };
let sequence = 0;
const newId = () => `text-${Date.now().toString(36)}-${(++sequence).toString(36)}`;

/** Read the request stage stored beside the config. Missing stages stay empty. */
export function readTextApiUsageStage(config: object): string {
  const stage = (config as ContextCarrier)[contextKey]?.stage;
  return typeof stage === 'string' ? stage : '';
}

/** Symbol metadata follows existing config spreads, but never enters JSON, prompts or project files. */
export function withTextApiUsageContext<T extends object>(config: T, context: TextApiUsageContext = {}, stage?: string): T {
  const previous = (config as ContextCarrier)[contextKey];
  return { ...config, [contextKey]: {
    operationId: previous?.operationId || newId(), ...previous, ...context,
    ...(stage ? { stage } : {}),
  } };
}

const stageLabels: Readonly<Record<string, string>> = {
  'text-request': '文字请求', 'story-duration': '剧情时长估算', 'story-bible': '人物场景道具补齐',
  'story-visual-understanding': '剧情动作理解', 'story-visual-writing': '剧情画面转化',
  'story-visual-rewrite': '局部画面重写', 'director-look': '导演与视觉风格填写',
  'visible-characters': '出镜人物解析', 'image-asset-autofill': '视觉资产资料填写',
  'character-private-profile': '人物专项资料填写', 'image-prompt-reverse': '图片反推',
  'comic-source-analysis': '漫画来源识别', 'story-reference-analysis': '剧情参考图识别',
  'vision-analysis': '参考图资料识别', 'video-frame-selection': '视频末帧选择',
  'image-custom-convert': '自定义生图提示词转换', 'identity-repair': '人物图片关联修复',
  convert: '提示词转换', deliver: 'H3 中文提示词生成', translate: '英文提示词生成',
  review: '提示词复核', repair: '已有格式修复',
};
export const textApiStageLabel = (stage: string): string => stageLabels[stage] || runtimeErrorStageLabel(stage);

const token = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);
type UsageNumbers = Pick<TextApiUsageRecord, 'inputTokens' | 'cacheHitTokens' | 'cacheMissTokens' | 'cacheWriteTokens' | 'outputTokens' | 'usageSource'>;

/** Passive decoding of response accounting only; never changes generation or triggers another request. */
export function readTextApiUsage(payload: any, nativeClaude = false): UsageNumbers {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return {};
  const claude = nativeClaude || usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  if (claude) {
    const ordinary = token(usage.input_tokens);
    const read = token(usage.cache_read_input_tokens);
    const write = token(usage.cache_creation_input_tokens);
    return {
      inputTokens: ordinary === undefined ? undefined : ordinary + (read ?? 0) + (write ?? 0),
      cacheHitTokens: read,
      cacheMissTokens: ordinary === undefined || read === undefined ? undefined : ordinary + (write ?? 0),
      cacheWriteTokens: write,
      outputTokens: token(usage.output_tokens),
      usageSource: 'usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens',
    };
  }
  const deepSeekHit = token(usage.prompt_cache_hit_tokens);
  const deepSeekMiss = token(usage.prompt_cache_miss_tokens);
  const hit = deepSeekHit ?? token(usage.prompt_tokens_details?.cached_tokens);
  const input = token(usage.prompt_tokens) ?? (deepSeekHit !== undefined && deepSeekMiss !== undefined ? deepSeekHit + deepSeekMiss : undefined);
  return {
    inputTokens: input, cacheHitTokens: hit,
    cacheMissTokens: deepSeekMiss ?? (input !== undefined && hit !== undefined && input >= hit ? input - hit : undefined),
    outputTokens: token(usage.completion_tokens),
    usageSource: deepSeekHit !== undefined ? 'usage.prompt_cache_hit_tokens / prompt_tokens'
      : hit !== undefined ? 'usage.prompt_tokens_details.cached_tokens / prompt_tokens' : '接口未返回缓存统计',
  };
}

export function getTextApiCacheRate(record: Pick<TextApiUsageRecord, 'inputTokens' | 'cacheHitTokens'>): number | undefined {
  const input = token(record.inputTokens);
  const hit = token(record.cacheHitTokens);
  return input !== undefined && input > 0 && hit !== undefined && hit <= input ? hit / input : undefined;
}

export function summarizeTextApiUsage(records: readonly TextApiUsageRecord[]) {
  let measured = 0, inputTokens = 0, hitTokens = 0, missTokens = 0;
  for (const record of records) {
    if (getTextApiCacheRate(record) === undefined) continue;
    measured += 1;
    inputTokens += record.inputTokens!;
    hitTokens += record.cacheHitTokens!;
    missTokens += record.inputTokens! - record.cacheHitTokens!;
  }
  return { total: records.length, measured, inputTokens, hitTokens, missTokens,
    rate: inputTokens > 0 ? hitTokens / inputTokens : undefined };
}

const EMPTY: readonly TextApiUsageRecord[] = Object.freeze([]);
let records: readonly TextApiUsageRecord[] = EMPTY;
const listeners = new Set<() => void>();
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* presentation cannot affect generation */ } } };
export const textApiUsageStore = {
  getSnapshot: () => records,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

export function flushTextApiUsageHistory(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  try { if (typeof window !== 'undefined') window.localStorage.setItem(TEXT_API_USAGE_STORAGE_KEY, JSON.stringify(records)); }
  catch { /* optional statistics storage never blocks a model result or workspace save */ }
}

export function loadTextApiUsageHistory(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(TEXT_API_USAGE_STORAGE_KEY) || '[]');
    if (Array.isArray(raw)) {
      records = Object.freeze(raw.filter((item) => item && typeof item.id === 'string'
        && typeof item.startedAt === 'number' && typeof item.stage === 'string'
        && typeof item.model === 'string').slice(0, TEXT_API_USAGE_LIMIT).map((item) => ({
          id: item.id, startedAt: item.startedAt, finishedAt: token(item.finishedAt), durationMs: token(item.durationMs),
          operationId: item.operationId, projectId: item.projectId, projectName: item.projectName,
          chapterId: item.chapterId, chapterName: item.chapterName, segmentIndex: item.segmentIndex,
          connectionName: item.connectionName, stage: item.stage, provider: item.provider || '', model: item.model,
          status: item.status === 'running' ? 'interrupted' : item.status,
          inputTokens: token(item.inputTokens), cacheHitTokens: token(item.cacheHitTokens),
          cacheMissTokens: token(item.cacheMissTokens), cacheWriteTokens: token(item.cacheWriteTokens),
          outputTokens: token(item.outputTokens), usageSource: item.usageSource,
        })));
    }
  } catch { /* unavailable history is not a generation error */ }
  window.addEventListener('pagehide', flushTextApiUsageHistory);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTextApiUsageHistory(); });
  notify();
}

const publish = (next: readonly TextApiUsageRecord[]) => {
  records = Object.freeze(next.slice(0, TEXT_API_USAGE_LIMIT));
  notify();
  if (typeof window !== 'undefined' && flushTimer === undefined) flushTimer = setTimeout(flushTextApiUsageHistory, 1000);
};

export function beginTextApiRequest(config: { provider: string; model: string }): string | undefined {
  try {
    loadTextApiUsageHistory();
    const context = (config as ContextCarrier)[contextKey] || {};
    const id = newId();
    publish([{ ...context, id, startedAt: Date.now(), stage: context.stage || 'text-request',
      provider: config.provider, model: config.model.trim(), status: 'running' }, ...records]);
    return id;
  } catch { return undefined; }
}

export function recordTextApiResponse(id: string | undefined, payload: unknown, nativeClaude = false): void {
  if (!id) return;
  try {
    const usage = readTextApiUsage(payload, nativeClaude);
    publish(records.map((record) => record.id === id ? { ...record, ...usage } : record));
  } catch { /* accounting is independent of protocol/answer handling */ }
}

export function finishTextApiRequest(id: string | undefined, status: TextApiUsageRecord['status']): void {
  if (!id) return;
  try {
    const now = Date.now();
    publish(records.map((record) => record.id === id && record.status === 'running'
      ? { ...record, status, finishedAt: now, durationMs: Math.max(0, now - record.startedAt) } : record));
  } catch { /* accounting cannot affect model completion */ }
}
