import assert from 'node:assert/strict';

const runtimeLog = await import('../src/runtimeErrorLog').catch(() => ({} as Record<string, unknown>)) as any;

assert.equal(
  typeof runtimeLog.createRuntimeErrorLogEntry,
  'function',
  'runtime error logging must expose a real entry builder',
);

const secret = 'sk-secret-value-for-test';
const entry = runtimeLog.createRuntimeErrorLogEntry({
  id: 'runtime-error-1',
  occurredAt: Date.parse('2026-09-01T04:30:00.000Z'),
  stage: 'storyboard-plan',
  error: new Error(
    `请求失败 Authorization: Bearer ${secret}; endpoint=https://api.deepseek.com/v1/chat/completions?api_key=${secret}`,
  ),
  context: {
    projectId: 'project-1',
    projectName: '测试项目',
    view: 'director',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    endpoint: `https://api.deepseek.com/v1/chat/completions?token=${secret}`,
  },
  knownSecrets: [secret],
});

assert.ok(entry, 'an ordinary runtime failure must create one log entry');
assert.equal(entry.id, 'runtime-error-1');
assert.equal(entry.stage, 'storyboard-plan');
assert.equal(entry.endpoint, 'https://api.deepseek.com/v1/chat/completions');
assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret, 'u'));
assert.match(entry.message, /已脱敏/u);

const aborted = new Error('请求已取消');
aborted.name = 'AbortError';
assert.equal(runtimeLog.createRuntimeErrorLogEntry({
  stage: 'storyboard-plan',
  error: aborted,
}), undefined, 'an intentional cancellation must not become a runtime error');

const entries = Array.from({ length: 105 }, (_, index) => ({
  ...entry,
  id: `runtime-error-${index + 2}`,
  occurredAt: entry.occurredAt + index + 1,
}));
const capped = runtimeLog.appendRuntimeErrorLog([entry], entries);
assert.equal(capped.length, 100);
assert.equal(capped[0]?.id, 'runtime-error-106');
assert.equal(capped[99]?.id, 'runtime-error-7');

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
runtimeLog.persistRuntimeErrorLog(capped, storage);
assert.deepEqual(runtimeLog.loadRuntimeErrorLog(storage), capped);
storage.setItem(runtimeLog.RUNTIME_ERROR_LOG_STORAGE_KEY, '{broken json');
assert.deepEqual(runtimeLog.loadRuntimeErrorLog(storage), []);
runtimeLog.persistRuntimeErrorLog([entry], storage);
runtimeLog.clearRuntimeErrorLog(storage);
assert.deepEqual(runtimeLog.loadRuntimeErrorLog(storage), []);

const copyText = runtimeLog.formatRuntimeErrorLog([entry]);
assert.match(copyText, /AI 完整分镜/u);
assert.match(copyText, /deepseek-v4-pro/u);
assert.doesNotMatch(copyText, new RegExp(secret, 'u'));

const sequenceEntry = runtimeLog.createRuntimeErrorLogEntry({
  stage: 'sequence-ai-segmentation',
  error: new Error('AI 返回未知 master shot ID：master-shot-17；boundaryAfterShotId：master-shot-17；sourceBeatIds：beat-9'),
});
assert.ok(sequenceEntry);
assert.match(runtimeLog.formatRuntimeErrorLog([sequenceEntry]), /AI 长剧情分段/u);

for (const [stage, label] of [
  ['image-preparation', '生图准备'],
  ['image-reference-load', '生图参考图读取'],
  ['image-frame-plan', '分镜静帧规划（文本 API）'],
  ['image-prompt-convert', '生图提示词转换（文本 API）'],
  ['image-identity-enrich', '人物外貌资料补齐（文本 API）'],
  ['image-generation', '图像生成'],
  ['image-result-save', '图像结果保存'],
]) {
  const stageEntry = runtimeLog.createRuntimeErrorLogEntry({
    stage,
    error: Object.assign(new Error(`接口返回 content_filter；api_key=${secret}`), { code: 'content_filter' }),
    context: { projectId: 'captured-project', projectName: 'Captured project', provider: 'captured-provider', model: 'captured-model', endpoint: `https://example.test/v1?token=${secret}` },
    knownSecrets: [secret],
  });
  assert.equal(stageEntry.code, 'content_filter');
  assert.equal(stageEntry.model, 'captured-model');
  assert.equal(runtimeLog.runtimeErrorStageLabel(stage), label);
  const formatted = runtimeLog.formatRuntimeErrorLog([stageEntry]);
  assert.ok(formatted.includes(label));
  assert.doesNotMatch(formatted, new RegExp(secret, 'u'));
}

console.log('runtime error log sanitization, persistence, cap, and copy checks passed');
