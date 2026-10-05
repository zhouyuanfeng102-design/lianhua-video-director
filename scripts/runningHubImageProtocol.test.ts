import assert from 'node:assert/strict';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow, exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig, validateRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { migrateRunningHubVideoApiImageProtocol, resolveRunningHubVideoImageProtocol } from '../src/runningHubImageProtocol';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { videoBatchRequestFingerprint, findVideoBatchDuplicate } from '../src/videoBatch';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoTaskApiConfig, VideoGenerationTask } from '../src/types';

// Public input identities only; no user data, credentials, uploads or API calls.
let checks = 0;
const check = (name: string, run: () => void) => { run(); checks += 1; console.log(`PASS ${name}`); };
const slotIds = ['438', '435', '437', '439', '431', '429'];
type Node = { nodeId: string; fieldName: string; fieldValue: unknown };
const value = (body: Record<string, unknown>, nodeId: string) => (body.nodeInfoList as Node[]).find((node) => node.nodeId === nodeId)?.fieldValue;
const fixture = (): RunningHubVideoWorkflow => ({
  ...createRunningHubVideoWorkflow('隔离六图数量测试'), remoteId: '2104753059472990209',
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: 'old prompt' },
    ...slotIds.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: `default-${nodeId}.png` })),
    { nodeId: '827', fieldName: 'value', fieldValue: '1' },
    { nodeId: 'audio', fieldName: 'audio', fieldValue: 'None' },
    { nodeId: 'duration', fieldName: 'value', fieldValue: '30' },
    { nodeId: 'flag', fieldName: 'value', fieldValue: false },
  ], instanceType: 'default', usePersonalQueue: false }),
  mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: slotIds.map((nodeId) => ({ nodeId, inputName: 'image' })) },
});
const config = (workflow: RunningHubVideoWorkflow): RunningHubVideoConfig => ({ enabled: true, apiKey: '', baseUrl: 'https://runninghub.example.test', activeWorkflowId: workflow.id, workflows: [workflow] });
const compile = (workflow = fixture()) => compileRunningHubVideoApi(config(workflow));
const draft = (slots: number[]): VideoGenerationDraft => ({ name: '分段参考图测试', backend: 'api', prompt: '本段独立提示词', parameters: {},
  references: slots.map((slotIndex) => ({ assetId: `image-${slotIndex}`, role: 'character', slotIndex })) });
const uploaded = (slots: number[]) => slots.map((slotIndex) => `openapi/upload-${slotIndex}.png`);
const mutateNodes = (workflow: RunningHubVideoWorkflow, change: (nodes: Node[]) => void) => {
  const request = JSON.parse(workflow.requestTemplate); change(request.nodeInfoList); workflow.requestTemplate = JSON.stringify(request);
};

for (let count = 1; count <= 6; count += 1) check(`verified app sends actual count ${count}, restores the web app placeholder for cancelled slots`, () => {
  const workflow = fixture(); const before = structuredClone(workflow); const api = compile(workflow);
  const slots = Array.from({ length: count }, (_, index) => index); const selection = draft(slots);
  if (count === 6) { selection.references[0].role = 'first-frame'; selection.references[0].assetId = 'previous-segment-local-tail-frame'; }
  const selectionBefore = structuredClone(selection); const body = buildVideoApiBody(api, selection, uploaded(slots));
  assert.equal(value(body, '827'), String(count), 'count keeps the original string wire type');
  assert.equal(api.runningHubMappedFields!.find((field) => field.kind === 'image-count')?.imageCountSource, 'verified-app');
  assert.deepEqual(slotIds.map((nodeId) => value(body, nodeId)), [...uploaded(slots), ...Array(6 - count).fill('example.png')]);
  assert.equal(value(body, 'audio'), 'None'); assert.equal(value(body, 'duration'), '30'); assert.equal(value(body, 'flag'), false);
  assert.equal(value(body, 'prompt'), selection.prompt); assert.deepEqual(workflow, before); assert.deepEqual(selection, selectionBefore);
});

check('verified app replaces a persisted None or stale filename with example.png for unused slots', () => {
  const workflow = fixture();
  mutateNodes(workflow, (nodes) => {
    nodes.find((node) => node.nodeId === '435')!.fieldValue = 'None';
    nodes.find((node) => node.nodeId === '437')!.fieldValue = 'old-upload.png';
  });
  const body = buildVideoApiBody(compile(workflow), draft([0]), uploaded([0]));
  assert.equal(value(body, '435'), 'example.png');
  assert.equal(value(body, '437'), 'example.png');
  assert.equal(value(body, '429'), 'example.png');
});

check('old failed-task API snapshots migrate only at the new submission boundary', () => {
  const api = compile();
  const old = structuredClone(api);
  for (const field of old.runningHubMappedFields || []) if (field.kind === 'image') field.emptyValue = 'None';
  const migrated = migrateRunningHubVideoApiImageProtocol(old);
  assert.notEqual(migrated, old);
  assert.deepEqual(migrated.runningHubMappedFields!.filter((field) => field.kind === 'image').map((field) => field.emptyValue), Array(6).fill('example.png'));
  assert.equal(old.runningHubMappedFields!.filter((field) => field.kind === 'image').every((field) => field.emptyValue === 'None'), true, 'historical snapshot remains unchanged');
  const other = { ...old, runningHubAppId: '2104753059472990208' };
  assert.equal(migrateRunningHubVideoApiImageProtocol(other), other, 'nearby app IDs are never migrated');
});

check('verified app rejects non-contiguous slots until its sparse input behavior is known, without moving selections', () => {
  const slots = [4, 0, 2]; const selection = draft(slots); const before = structuredClone(selection);
  assert.throws(() => buildVideoApiBody(compile(), selection, uploaded(slots)), /连续选择 3 个槽位/u);
  assert.deepEqual(selection, before);
});

check('explicit count in other apps keeps non-contiguous slot identity and order; count uses selected length', () => {
  const slots = [4, 0, 2]; const selection = draft(slots); const before = structuredClone(selection);
  const workflow = fixture(); workflow.remoteId = '123456'; workflow.mapping.imageCount = { nodeId: '827', inputName: 'value' };
  workflow.nodeCatalog = slotIds.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'None', control: { kind: 'select', options: ['example.png', 'None'] } }));
  const body = buildVideoApiBody(compile(workflow), selection, uploaded(slots));
  assert.deepEqual(slotIds.map((nodeId) => value(body, nodeId)), ['openapi/upload-0.png', 'None', 'openapi/upload-2.png', 'None', 'openapi/upload-4.png', 'None']);
  assert.equal(value(body, '827'), '3'); assert.deepEqual(selection, before);
});

check('same node IDs in another app never enable a guessed count or None convention', () => {
  const workflow = fixture(); workflow.remoteId = '2104753059472990208'; const api = compile(workflow);
  assert.equal(resolveRunningHubVideoImageProtocol(workflow).verifiedProfile, false);
  assert.ok(!api.runningHubMappedFields!.some((field) => field.kind === 'image-count'));
  const body = buildVideoApiBody(api, draft([0, 1]), uploaded([0, 1]));
  assert.equal(value(body, '827'), '1'); assert.equal(value(body, '429'), '');
});

check('verified profile requires the AI-app endpoint, exact six mapped image fields and a unique integer count', () => {
  const wrongKind = fixture(); wrongKind.runKind = 'workflow';
  const fewerSlots = fixture(); fewerSlots.mapping.images.pop();
  const reordered = fixture(); reordered.mapping.images.reverse();
  const missingCount = fixture(); mutateNodes(missingCount, (nodes) => nodes.splice(nodes.findIndex((node) => node.nodeId === '827'), 1));
  const invalidCount = fixture(); mutateNodes(invalidCount, (nodes) => { nodes.find((node) => node.nodeId === '827')!.fieldValue = true; });
  const duplicateCount = fixture(); mutateNodes(duplicateCount, (nodes) => { nodes.push({ nodeId: '827', fieldName: 'value', fieldValue: '1' }); });
  for (const workflow of [wrongKind, fewerSlots, reordered, missingCount, invalidCount, duplicateCount]) assert.equal(resolveRunningHubVideoImageProtocol(workflow).verifiedProfile, false);
  for (const workflow of [wrongKind, fewerSlots, reordered, missingCount, invalidCount]) assert.ok(!compile(workflow).runningHubMappedFields!.some((field) => field.kind === 'image-count'));
});

check('an already assigned verified count is not silently taken over, and explicit conflicts are rejected', () => {
  const workflow = fixture(); workflow.mapping.parameters = { duration: { nodeId: '827', inputName: 'value' } };
  const api = compile(workflow); assert.ok(!api.runningHubMappedFields!.some((field) => field.kind === 'image-count'));
  const body = buildVideoApiBody(api, { ...draft([0]), parameters: { duration: 9 } }, uploaded([0])); assert.equal(value(body, '827'), '9');
  workflow.mapping.imageCount = { nodeId: '827', inputName: 'value' };
  assert.ok(validateRunningHubVideoWorkflow(workflow).some((issue) => issue.includes('实际图片数量') && issue.includes('同一个节点')));
  assert.throws(() => compile(workflow), /唯一用途/u);
  delete workflow.mapping.parameters; workflow.mapping.imageCount = workflow.mapping.images[0]; assert.throws(() => compile(workflow), /实际图片数量/u);
});

check('explicit count works in any app and keeps numeric or string original types', () => {
  for (const original of [1, '1']) {
    const workflow = fixture(); workflow.remoteId = '123456'; workflow.mapping.imageCount = { nodeId: '827', inputName: 'value' };
    mutateNodes(workflow, (nodes) => { nodes.find((node) => node.nodeId === '827')!.fieldValue = original; });
    assert.equal(resolveRunningHubVideoImageProtocol(workflow).imageCountSource, 'explicit');
    const body = buildVideoApiBody(compile(workflow), draft([0, 1, 2]), uploaded([0, 1, 2]));
    assert.equal(value(body, '827'), typeof original === 'string' ? '3' : 3);
  }
});

check('invalid explicit count types and absent fields are actionable configuration errors', () => {
  for (const original of [true, '', '1.5', -1, {}, ['link', 0]]) {
    const workflow = fixture(); workflow.mapping.imageCount = { nodeId: '827', inputName: 'value' };
    mutateNodes(workflow, (nodes) => { nodes.find((node) => node.nodeId === '827')!.fieldValue = original; });
    assert.throws(() => compile(workflow), /实际图片数量/u);
  }
  const missing = fixture(); missing.mapping.imageCount = { nodeId: 'missing', inputName: 'value' }; assert.throws(() => compile(missing), /找不到/u);
});

check('explicitly disabled adaptation and manual count mappings survive normalization, export and import', () => {
  for (const imageCount of [null, { nodeId: '827', inputName: 'value' }]) {
    const workflow = fixture(); workflow.mapping.imageCount = imageCount;
    const normalized = normalizeRunningHubVideoConfig(config(workflow)).workflows[0];
    const restored = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(workflow)).workflow;
    for (const result of [normalized, restored]) {
      assert.deepEqual(result.mapping.imageCount, imageCount);
      assert.equal(Boolean(resolveRunningHubVideoImageProtocol(result).imageCount), imageCount !== null);
    }
  }
});

check('per-field published None option is honored outside the verified app without affecting other fields', () => {
  const workflow = fixture(); workflow.remoteId = '123456';
  workflow.nodeCatalog = [{ nodeId: '429', fieldName: 'image', fieldValue: 'example.png', control: { kind: 'select', options: ['example.png', 'None'] } }];
  const body = buildVideoApiBody(compile(workflow), draft([0]), uploaded([0]));
  assert.equal(value(body, '429'), 'None'); assert.equal(value(body, '431'), ''); assert.equal(value(body, '827'), '1');
  delete workflow.nodeCatalog;
  mutateNodes(workflow, (nodes) => Object.assign(nodes.find((node) => node.nodeId === '429')!, { fieldData: '[["example.png", "None"], {"image_upload": true}]' }));
  assert.equal(value(buildVideoApiBody(compile(workflow), draft([0]), uploaded([0])), '429'), 'None');
});

check('frozen new metadata survives persistence, while old snapshots never guess new mappings at bind time', () => {
  const api = compile(); const persisted = JSON.stringify(api); const restored = JSON.parse(persisted) as VideoTaskApiConfig;
  assert.equal(value(buildVideoApiBody(restored, draft([0, 1]), uploaded([0, 1])), '827'), '2');
  assert.equal(JSON.stringify(restored), persisted);
  restored.runningHubMappedFields = restored.runningHubMappedFields!.filter((field) => field.kind !== 'image-count');
  for (const field of restored.runningHubMappedFields) if (field.kind === 'image') delete field.emptyValue;
  const oldBefore = JSON.stringify(restored); const body = buildVideoApiBody(restored, draft([0, 1]), uploaded([0, 1]));
  assert.equal(value(body, '827'), '1'); assert.equal(value(body, '429'), ''); assert.equal(JSON.stringify(restored), oldBefore);
});

check('duplicate count destinations and corrupted count snapshots cannot silently submit', () => {
  const api = compile(); const fields = structuredClone(api.runningHubMappedFields!);
  fields.push({ nodeId: 'duration', fieldName: 'value', kind: 'image-count', originalValue: '30' });
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, fields, draft([0]), uploaded([0])), /只能绑定一个字段/u);
  fields.pop(); fields.find((field) => field.kind === 'image-count')!.originalValue = true;
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, fields, draft([0]), uploaded([0])), /有效的整数/u);
});

check('automatic count compatibility preserves completed and in-flight deduplication; explicit changes still differ', () => {
  const workflow = fixture(); const selection = draft([0, 1, 2, 3, 4]); const api = compile(workflow);
  const old = structuredClone(api);
  old.runningHubMappedFields = old.runningHubMappedFields!.filter((field) => field.kind !== 'image-count');
  old.runningHubMappedFields.forEach((field) => { if (field.kind === 'image') field.emptyValue = ''; });
  const oldFingerprint = videoBatchRequestFingerprint(selection, [], { backend: 'api', api: old });
  const fingerprint = videoBatchRequestFingerprint(selection, [], { backend: 'api', api });
  assert.equal(fingerprint, oldFingerprint);
  for (const status of ['running', 'succeeded'] as const) {
    const task: VideoGenerationTask = { id: `old-${status}`, kind: 'video', storyboardId: 'fixture-board', targetId: 'fixture-target', status, requestBody: {}, remoteTaskId: 'old-remote', requestFingerprint: oldFingerprint, createdAt: 1, updatedAt: 1 };
    assert.equal(findVideoBatchDuplicate({ generationTasks: [task] }, fingerprint)?.taskId, task.id);
  }
  const explicit = structuredClone(workflow); explicit.mapping.imageCount = { nodeId: '827', inputName: 'value' };
  assert.notEqual(videoBatchRequestFingerprint(selection, [], { backend: 'api', api: compile(explicit) }), fingerprint);
  assert.notEqual(videoBatchRequestFingerprint(draft([0, 1, 2, 3, 4, 5]), [], { backend: 'api', api }), fingerprint);
});

console.log(`RunningHub image protocol tests passed: ${checks} checks (synthetic requests only; zero API calls)`);
