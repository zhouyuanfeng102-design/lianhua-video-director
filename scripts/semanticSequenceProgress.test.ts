import assert from 'node:assert/strict';
import {
  createSemanticPlanningStatus, recordSemanticPlanningDiagnostic, semanticPlanningElapsedMs,
  SEMANTIC_PLANNING_DIAGNOSTIC_KEY,
} from '../src/semanticSequenceProgress';

const secret = 'sk-semantic-diagnostic-secret';
const context = {
  operationId: 'operation-1', projectId: 'project-1', chapterId: 'chapter-1', provider: 'openai_compatible',
  model: `mock-model-${secret}`, apiKey: secret, endpoint: 'https://private-endpoint.invalid/v1', story: 'PRIVATE_ORIGINAL_STORY',
};
const progress = {
  stage: 'requesting' as const, requestNumber: 1, maxRequests: 4, elapsedMs: 1200,
  durationMode: 'fixed' as const, totalDurationSec: 180, segmentDurationSec: 30, requiredSegmentCount: 6,
  detail: `正在等待响应，diagnostic secret=${secret}`, story: 'PRIVATE_ORIGINAL_STORY', apiKey: secret,
  endpoint: 'https://private-endpoint.invalid/v1',
};
const status = createSemanticPlanningStatus(progress, context, 1000);
assert.deepEqual(Object.keys(status).sort(), [
  'operationId', 'projectId', 'chapterId', 'provider', 'model', 'updatedAt', 'stage', 'requestNumber',
  'maxRequests', 'elapsedMs', 'durationMode', 'totalDurationSec', 'segmentDurationSec', 'requiredSegmentCount', 'detail',
].sort(), 'diagnostics select operational fields instead of spreading the source or API configuration');
assert.ok(!status.model.includes(secret)); assert.ok(!status.detail?.includes(secret));
assert.match(status.model, /已脱敏/u); assert.match(status.detail || '', /已脱敏/u);

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};
recordSemanticPlanningDiagnostic(status, storage);
recordSemanticPlanningDiagnostic(createSemanticPlanningStatus({ ...progress, stage: 'parsing', detail: undefined }, context, 1100), storage);
const recoveryReason = 'JSON 未闭合；使用原有技术恢复请求。';
recordSemanticPlanningDiagnostic(createSemanticPlanningStatus({ ...progress, stage: 'repairing', requestNumber: 2, detail: recoveryReason }, context, 1200), storage);
recordSemanticPlanningDiagnostic(createSemanticPlanningStatus({ ...progress, stage: 'requesting', requestNumber: 2, detail: undefined }, context, 1300), storage);
recordSemanticPlanningDiagnostic(createSemanticPlanningStatus({ ...progress, stage: 'completed', requestNumber: 2, detail: undefined }, context, 1400), storage);
let entries = JSON.parse(values.get(SEMANTIC_PLANNING_DIAGNOSTIC_KEY)!);
assert.equal(entries.length, 1, 'progress replaces one operation record instead of adding a log for each stage');
assert.equal(entries[0].stage, 'completed'); assert.equal(entries[0].requests.length, 2);
assert.equal(entries[0].requests.find((request: { requestNumber: number }) => request.requestNumber === 2).detail, recoveryReason,
  'later stages preserve the reason behind the existing technical recovery');
assert.ok(!JSON.stringify(entries).includes(secret));
assert.ok(!JSON.stringify(entries).includes('PRIVATE_ORIGINAL_STORY'));
assert.ok(!JSON.stringify(entries).includes('private-endpoint.invalid'));
recordSemanticPlanningDiagnostic(createSemanticPlanningStatus(progress, { ...context, operationId: 'operation-2' }, 1500), storage);
entries = JSON.parse(values.get(SEMANTIC_PLANNING_DIAGNOSTIC_KEY)!);
assert.equal(entries.length, 2, 'a separate user operation retains its own diagnostic');

assert.equal(semanticPlanningElapsedMs(status, 3200), 3400, 'active waiting time advances without a new request or storage write');
assert.equal(semanticPlanningElapsedMs(status, 900), 1200, 'a backward clock cannot reduce the recorded elapsed time');
for (const stage of ['completed', 'failed', 'stopped'] as const) {
  const terminal = createSemanticPlanningStatus({ ...progress, stage }, context, 1000);
  assert.equal(semanticPlanningElapsedMs(terminal, 3200), 1200, `${stage} freezes the last recorded elapsed time`);
}
assert.doesNotThrow(() => recordSemanticPlanningDiagnostic(status, {
  getItem: () => { throw new Error('storage read blocked'); }, setItem: () => { throw new Error('must not reach write'); },
}), 'diagnostic read failures do not escape into the planning request');
assert.doesNotThrow(() => recordSemanticPlanningDiagnostic(status, {
  getItem: () => '[]', setItem: () => { throw new Error('storage quota exceeded'); },
}), 'diagnostic write failures do not escape into the planning request');

console.log('semanticSequenceProgress: metadata-only redacted diagnostics replace operation records, retain recovery reasons, freeze terminal elapsed time and isolate storage errors.');
