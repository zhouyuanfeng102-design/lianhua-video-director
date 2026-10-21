import assert from 'node:assert/strict';
import { requestTextModel } from '../src/services/llm';
import {
  beginTextApiRequest, finishTextApiRequest, flushTextApiUsageHistory, getTextApiCacheRate,
  loadTextApiUsageHistory, readTextApiUsage, summarizeTextApiUsage, textApiUsageStore,
  TEXT_API_USAGE_LIMIT, TEXT_API_USAGE_STORAGE_KEY, withTextApiUsageContext,
  type TextApiUsageRecord,
} from '../src/textApiUsage';
import type { TextApiConfig } from '../src/types';

const deepSeekPayload = { usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
  prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 75 } };
const deepSeek = readTextApiUsage(deepSeekPayload);
assert.equal(deepSeek.inputTokens, 1000);
assert.equal(deepSeek.cacheHitTokens, 900, 'provider and compatible aliases describe the same tokens');
assert.equal(deepSeek.cacheMissTokens, 100);
assert.equal(getTextApiCacheRate(deepSeek), 0.9);
assert.equal(readTextApiUsage({ usage: { ...deepSeekPayload.usage, prompt_tokens_details: { cached_tokens: 700 } } }).cacheHitTokens, 900);
assert.equal(readTextApiUsage({ usage: { prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } }).inputTokens, 1000);
assert.equal(getTextApiCacheRate(readTextApiUsage({ usage: { prompt_tokens: 100 } })), undefined);
assert.equal(getTextApiCacheRate(readTextApiUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } })), 0);
assert.equal(getTextApiCacheRate({ inputTokens: 0, cacheHitTokens: 0 }), undefined);
assert.equal(getTextApiCacheRate({ inputTokens: 100, cacheHitTokens: 101 }), undefined);
assert.deepEqual(readTextApiUsage({}), {});
assert.equal(readTextApiUsage({ usage: { prompt_tokens: -1, prompt_cache_hit_tokens: NaN } }).inputTokens, undefined);
const claude = readTextApiUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 900,
  cache_creation_input_tokens: 50, output_tokens: 33 } }, true);
assert.equal(claude.inputTokens, 1050, 'Claude ordinary input excludes cache reads and writes');
assert.equal(claude.cacheMissTokens, 150);
assert.equal(claude.cacheWriteTokens, 50);
assert.equal(getTextApiCacheRate(claude), 900 / 1050);
assert.equal(getTextApiCacheRate(readTextApiUsage({ usage: { input_tokens: 100 } }, true)), undefined);
const record = (id: string, usage: ReturnType<typeof readTextApiUsage>): TextApiUsageRecord => ({
  id, startedAt: 1, stage: 'convert', provider: 'deepseek', model: 'fixture-model', status: 'succeeded', ...usage,
});
const summary = summarizeTextApiUsage([
  record('large', deepSeek), record('small', { inputTokens: 100, cacheHitTokens: 0 }), record('unknown', { inputTokens: 500 }),
]);
assert.deepEqual(summary, { total: 3, measured: 2, inputTokens: 1100, hitTokens: 900, missTokens: 200, rate: 900 / 1100 });
assert.notEqual(summary.rate, 0.45, 'aggregate rate is token weighted, not the mean of request percentages');

const config: TextApiConfig = { enabled: true, provider: 'deepseek', baseUrl: 'https://usage-fixture.invalid/v1',
  apiKey: 'fixture-secret-api-key', model: 'fixture-model', temperature: 0.2, maxTokens: 1000, vision: false };
const project = { projectId: 'project-before-switch', projectName: '原项目', chapterId: 'chapter-a', chapterName: '第一章', segmentIndex: 1 };
const contextual = withTextApiUsageContext(config, project, 'convert');
const spread = { ...contextual, maxTokens: 1200 };
assert.equal(Object.getOwnPropertySymbols(spread).length, 1);
assert.equal(JSON.stringify(contextual), JSON.stringify(config), 'Symbol metadata never enters a serialized config');
assert.equal(JSON.stringify(spread), JSON.stringify({ ...config, maxTokens: 1200 }));

type Reply = { status: number; body: string };
const ok = (extra: object = {}): Reply => ({ status: 200, body: JSON.stringify({ ...extra,
  choices: [{ finish_reason: 'stop', message: { content: 'fixture answer' } }] }) });
const storage = new Map<string, string>();
const requests: Array<{ body?: string; url: string }> = [];
let handler: () => Promise<Reply> = async () => ok(deepSeekPayload);
let cancelledRequests = 0;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  addEventListener: () => undefined,
  lianhuaDesktop: {
    request: async (request: { body?: string; url: string }) => { requests.push(request); return handler(); },
    cancelModelRequest: async () => { cancelledRequests += 1; },
  },
} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener: () => undefined } });
globalThis.fetch = async () => { throw new Error('Live network is forbidden in text API usage tests'); };
const snapshot = () => textApiUsageStore.getSnapshot();
const newest = () => snapshot()[0];
try {
  loadTextApiUsageHistory();
  assert.equal(snapshot().length, 0);
  let resolveRequest!: (reply: Reply) => void;
  handler = () => new Promise((resolve) => { resolveRequest = resolve; });
  const pending = requestTextModel(spread, 'fixture-private-system-prompt', 'fixture-private-user-prompt');
  assert.equal(snapshot().length, 1);
  assert.equal(newest().status, 'running');
  project.projectId = 'project-after-switch'; project.projectName = '新项目'; project.segmentIndex = 2;
  resolveRequest(ok(deepSeekPayload));
  assert.equal(await pending, 'fixture answer');
  assert.equal(snapshot().length, 1, 'a completed request updates its running row rather than inserting a second row');
  assert.equal(newest().projectId, 'project-before-switch');
  assert.equal(newest().projectName, '原项目');
  assert.equal(newest().segmentIndex, 1);
  assert.equal(newest().stage, 'convert');
  assert.equal(newest().status, 'succeeded');
  assert.equal(getTextApiCacheRate(newest()), 0.9);
  assert.ok(newest().finishedAt! >= newest().startedAt);
  assert.ok(newest().durationMs! >= 0);
  const firstOperationId = newest().operationId;
  assert.ok(firstOperationId);
  assert.deepEqual(JSON.parse(requests[0].body!).messages.map((item: { role: string }) => item.role), ['system', 'user']);
  assert.ok(!requests[0].body!.includes('project-before-switch'), 'metadata stays outside the wire request');

  handler = async () => ok();
  await requestTextModel(withTextApiUsageContext(spread, {}, 'translate'), 'same system', 'next user');
  assert.equal(snapshot().length, 2);
  assert.equal(newest().operationId, firstOperationId);
  assert.equal(newest().stage, 'translate');
  assert.equal(getTextApiCacheRate(newest()), undefined, 'missing usage is not reported as a zero hit');

  for (const reply of [
    { status: 429, body: JSON.stringify({ ...deepSeekPayload, error: { message: 'fixture-private-user-prompt fixture-secret-api-key' } }) },
    { status: 200, body: JSON.stringify({ ...deepSeekPayload, choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) },
  ]) {
    const beforeRows = snapshot().length; const beforeRequests = requests.length;
    handler = async () => reply;
    await assert.rejects(requestTextModel(spread, 'system', 'user'));
    assert.equal(snapshot().length, beforeRows + 1);
    assert.equal(requests.length, beforeRequests + 1, 'usage observation adds no retry');
    assert.equal(newest().status, 'failed');
    assert.equal(getTextApiCacheRate(newest()), 0.9, 'returned usage survives HTTP or response-processing failure');
  }

  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  const beforeCancelRows = snapshot().length; const beforeCancelRequests = requests.length;
  await assert.rejects(requestTextModel(spread, 'system', 'user', alreadyCancelled.signal), { name: 'AbortError' });
  assert.equal(snapshot().length, beforeCancelRows, 'a request cancelled before dispatch has no usage row');
  assert.equal(requests.length, beforeCancelRequests);
  const activeCancel = new AbortController();
  handler = () => new Promise((resolve) => { resolveRequest = resolve; });
  const cancelled = requestTextModel(spread, 'system', 'user', activeCancel.signal);
  const cancelledId = newest().id;
  activeCancel.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(newest().status, 'cancelled');
  assert.equal(newest().inputTokens, undefined);
  assert.equal(getTextApiCacheRate(newest()), undefined);
  assert.equal(cancelledRequests, 1);
  resolveRequest(ok(deepSeekPayload));
  await Promise.resolve();
  assert.equal(newest().id, cancelledId);
  assert.equal(newest().inputTokens, undefined, 'a late bridge result cannot populate a cancelled request');
  flushTextApiUsageHistory();
  const serialized = storage.get(TEXT_API_USAGE_STORAGE_KEY)!;
  for (const secret of ['fixture-secret-api-key', 'fixture-private-system-prompt', 'fixture-private-user-prompt', 'fixture answer', config.baseUrl]) {
    assert.ok(!serialized.includes(secret), `history must not retain ${secret}`);
  }

  const firstSyntheticId = beginTextApiRequest(config);
  for (let index = 0; index < TEXT_API_USAGE_LIMIT; index += 1) beginTextApiRequest(config);
  assert.equal(snapshot().length, 1000);
  assert.ok(!snapshot().some((item) => item.id === firstSyntheticId), 'oldest entries leave the bounded history');
  finishTextApiRequest(newest().id, 'succeeded');
  flushTextApiUsageHistory();
  const saved = JSON.parse(storage.get(TEXT_API_USAGE_STORAGE_KEY)!) as TextApiUsageRecord[];
  // A fresh ESM instance simulates process-local state after restart, while
  // retaining only the independently mocked localStorage bytes.
  const restarted = await import(new URL('../src/textApiUsage.ts?usage-test-restart', import.meta.url).href) as typeof import('../src/textApiUsage');
  assert.equal(restarted.textApiUsageStore.getSnapshot().length, 0);
  restarted.loadTextApiUsageHistory();
  assert.equal(restarted.textApiUsageStore.getSnapshot().length, 1000);
  assert.equal(restarted.textApiUsageStore.getSnapshot()[0].id, saved[0].id);
  assert.equal(restarted.textApiUsageStore.getSnapshot()[0].status, 'succeeded');
  assert.equal(restarted.textApiUsageStore.getSnapshot()[1].status, 'interrupted');
  restarted.loadTextApiUsageHistory();
  assert.equal(restarted.textApiUsageStore.getSnapshot().length, 1000, 'loading history is idempotent');
} finally {
  flushTextApiUsageHistory();
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window');
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
}
console.log('text API usage checks passed');
