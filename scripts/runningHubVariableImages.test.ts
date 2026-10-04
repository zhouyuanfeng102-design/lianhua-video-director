import assert from 'node:assert/strict';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { buildVideoApiBody, defaultRunningHubVideoApi, parseVideoApiResult } from '../src/videoGenerationApi';
import { findVideoBatchDuplicate, videoBatchRequestFingerprint } from '../src/videoBatch';
import { videoProviderErrorDiagnostics } from '../src/videoTaskErrorDiagnostics';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { ReferenceAsset, ReferenceRole, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

// Fully synthetic fixtures: no persisted user project, key, network or paid generation.
let checks = 0;
const check = (name: string, run: () => void) => { run(); checks += 1; console.log(`PASS ${name}`); };
const slotIds = ['image-a', 'image-b', 'image-c', 'image-d'];
const slotRoles: ReferenceRole[] = ['first-frame', 'character', 'character', 'character'];
type RequestNode = { nodeId: string; fieldName: string; fieldValue: unknown };
const requestNodes = (body: Record<string, unknown>): RequestNode[] => body.nodeInfoList as RequestNode[];
const imageValues = (body: Record<string, unknown>): unknown[] => slotIds.map((nodeId) => requestNodes(body).find((node) => node.nodeId === nodeId)?.fieldValue);
const valueAt = (body: Record<string, unknown>, nodeId: string): unknown => requestNodes(body).find((node) => node.nodeId === nodeId)?.fieldValue;
const uploaded = (count: number): string[] => Array.from({ length: count }, (_, index) => `openapi/test-reference-${index + 1}.png`);
const draftFor = (count: number): VideoGenerationDraft => ({
  name: '可变数量独立测试', backend: 'api', prompt: '完整中文 H3 测试原文，不发送远端。', parameters: {},
  references: Array.from({ length: count }, (_, index) => ({ assetId: `test-asset-${index + 1}`, role: slotRoles[index] || 'character' })),
});
const fixture = (defaults = ['None', 'None', 'None', 'old-cloud-file.png'], fieldNames = ['image', 'image', 'image', 'image']): RunningHubVideoWorkflow => ({
  ...createRunningHubVideoWorkflow('隔离四图槽工作流'), remoteId: '1234567890123456789',
  requestTemplate: JSON.stringify({
    nodeInfoList: [
      { nodeId: 'prompt', fieldName: 'text', fieldValue: 'default prompt' },
      ...slotIds.map((nodeId, index) => ({ nodeId, fieldName: fieldNames[index], fieldValue: defaults[index] })),
      { nodeId: 'static-image', fieldName: 'image', fieldValue: 'explicit-fixed-image.png' },
      { nodeId: 'audio', fieldName: 'audio', fieldValue: 'None' },
      { nodeId: 'flag', fieldName: 'enabled', fieldValue: true },
      { nodeId: 'opaque', fieldName: 'text', fieldValue: 'keep {{image_4}} inside literal text' },
    ],
    instanceType: 'default', usePersonalQueue: false, untouched: '{{image_4}}',
  }),
  mapping: {
    prompt: [{ nodeId: 'prompt', inputName: 'text' }],
    images: slotIds.map((nodeId, index) => ({ nodeId, inputName: fieldNames[index], role: slotRoles[index] })),
  },
});
const compile = (workflow = fixture()): VideoTaskApiConfig => {
  const config: RunningHubVideoConfig = { enabled: true, baseUrl: 'https://runninghub.example.test', apiKey: '', activeWorkflowId: workflow.id, workflows: [workflow] };
  return compileRunningHubVideoApi(config, workflow.id);
};
const emptyValues = (api: VideoTaskApiConfig) => api.runningHubMappedFields!.filter((field) => field.kind === 'image').map((field) => field.emptyValue);

for (const count of [3, 2, 1, 0, 4]) check(`four mapped slots accept ${count} images and explicitly clear only unused tail slots`, () => {
  const workflow = fixture(); const workflowBefore = structuredClone(workflow); const api = compile(workflow);
  const draft = draftFor(count); const draftBefore = structuredClone(draft); const images = uploaded(count);
  const body = buildVideoApiBody(api, draft, images);
  assert.deepEqual(imageValues(body), [...images, ...Array(4 - count).fill('None')]);
  assert.equal(requestNodes(body).length, 9, 'unused fields stay in nodeInfoList instead of falling back to cloud defaults');
  assert.equal(valueAt(body, 'prompt'), draft.prompt);
  assert.equal(valueAt(body, 'static-image'), 'explicit-fixed-image.png', 'unmapped fixed image is not cleared');
  assert.equal(valueAt(body, 'audio'), 'None');
  assert.equal(valueAt(body, 'flag'), true, 'no guessed enable/disable switch');
  assert.equal(valueAt(body, 'opaque'), 'keep {{image_4}} inside literal text');
  assert.equal(body.untouched, '{{image_4}}');
  assert.deepEqual(workflow, workflowBefore, 'saved workflow is not changed by compilation or submission');
  assert.deepEqual(draft, draftBefore, 'selected references and prompt are unchanged');
});

check('explicit per-slot empty string wins over peer None convention', () => {
  const api = compile(fixture(['', 'None', 'None', 'old-cloud-file.png']));
  assert.deepEqual(emptyValues(api), ['', 'None', 'None', 'None']);
  assert.deepEqual(imageValues(buildVideoApiBody(api, draftFor(0), [])), ['', 'None', 'None', 'None']);
});

check('peer empty convention only comes from explicitly mapped images with the same field name', () => {
  const api = compile(fixture(['None', 'None', 'None', 'old-cloud-file.png'], ['image', 'image', 'image', 'reference']));
  assert.deepEqual(emptyValues(api), ['None', 'None', 'None', '']);
  const noImageConvention = fixture(['old-a.png', 'old-b.png', 'old-c.png', 'old-d.png']);
  const raw = JSON.parse(noImageConvention.requestTemplate);
  raw.nodeInfoList.push({ nodeId: 'unmapped-none', fieldName: 'image', fieldValue: 'None' });
  noImageConvention.requestTemplate = JSON.stringify(raw);
  assert.deepEqual(emptyValues(compile(noImageConvention)), ['', '', '', ''], 'unmapped image and audio None values do not authorize image convention inference');
});

check('empty conventions are exact and never whitespace/case/filename guesses', () => {
  const api = compile(fixture(['none', ' None ', 'None.png', 'null']));
  assert.deepEqual(emptyValues(api), ['', '', '', '']);
});

check('JSON-persisted frozen connection retains empty conventions and original image ordering', () => {
  const snapshot = { connection: { backend: 'api', api: compile() }, draft: draftFor(2), uploadedImages: uploaded(2) };
  const serialized = JSON.stringify(snapshot);
  const restored = JSON.parse(serialized) as typeof snapshot;
  assert.deepEqual(emptyValues(restored.connection.api), ['None', 'None', 'None', 'None']);
  assert.deepEqual(imageValues(buildVideoApiBody(restored.connection.api, restored.draft, restored.uploadedImages)), [...uploaded(2), 'None', 'None']);
  assert.equal(JSON.stringify(restored), serialized, 'request binding never mutates frozen input metadata');
});

check('older mapped snapshots without emptyValue use explicit empty strings, never old files', () => {
  const api = compile();
  for (const field of api.runningHubMappedFields!) delete field.emptyValue;
  const restored = JSON.parse(JSON.stringify(api)) as VideoTaskApiConfig;
  assert.deepEqual(imageValues(buildVideoApiBody(restored, draftFor(2), uploaded(2))), [...uploaded(2), '', '']);
});

check('invalid persisted emptyValue cannot reintroduce a file or arbitrary node value', () => {
  const api = compile();
  for (const field of api.runningHubMappedFields!) if (field.kind === 'image') Object.assign(field, { emptyValue: 'old-or-untrusted-file.png' });
  assert.deepEqual(imageValues(buildVideoApiBody(api, draftFor(0), [])), ['', '', '', '']);
});

check('excess references and missing uploads remain errors instead of silent truncation or clearing', () => {
  const api = compile();
  assert.throws(() => buildVideoApiBody(api, draftFor(5), uploaded(5)), 'five images cannot fit four slots');
  assert.throws(() => buildVideoApiBody(api, draftFor(3), uploaded(2)), 'a selected reference cannot become an intentionally empty slot');
  assert.throws(() => buildVideoApiBody(api, draftFor(1), uploaded(2)), 'an unaccounted upload cannot enter the request');
});

check('ordinary role mismatches are warning-only while mapped first-frame use stays flexible', () => {
  const api = compile(); const draft = draftFor(2);
  draft.references[1].role = 'composition';
  const body = buildVideoApiBody(api, draft, uploaded(2));
  assert.deepEqual(imageValues(body).slice(0, 2), uploaded(2), 'the mismatched selected image remains bound to its selected physical slot');
  const arbitraryFirst = draftFor(1); arbitraryFirst.references[0].role = 'character';
  assert.doesNotThrow(() => buildVideoApiBody(api, arbitraryFirst, uploaded(1)), 'first-frame is submission usage, not original asset category');
});

check('explicitly selected empty or sparse uploads cannot be treated as unused tail slots', () => {
  const api = compile(); const holes = new Array<string>(3); holes[0] = uploaded(1)[0]; holes[2] = uploaded(3)[2];
  for (const images of [[uploaded(1)[0], ''], [uploaded(1)[0], '   '], holes]) {
    assert.throws(() => buildVideoApiBody(api, draftFor(images.length), images));
    assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, draftFor(images.length), images));
  }
});

check('malformed mapped image indices remain errors rather than clearing an unknown field', () => {
  const api = compile(); const fields = structuredClone(api.runningHubMappedFields!);
  fields.find((field) => field.kind === 'image')!.imageIndex = -1;
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, fields, draftFor(0), []));
});

check('different nodes cannot silently duplicate one mapped image index, even with no selected images', () => {
  const api = compile(); const fields = structuredClone(api.runningHubMappedFields!);
  fields.filter((field) => field.kind === 'image')[1].imageIndex = 0;
  for (const count of [0, 1]) {
    assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, fields, draftFor(count), uploaded(count)), /重复/u);
  }
});

const legacyApi = (): VideoTaskApiConfig => ({
  ...defaultRunningHubVideoApi, runningHubAppId: '1234567890123456789', runningHubImageRoles: [...slotRoles],
  requestTemplate: JSON.stringify({
    nodeInfoList: [
      { nodeId: 'prompt', fieldName: 'text', fieldValue: '{{prompt}}' },
      ...slotIds.map((nodeId, index) => ({ nodeId, fieldName: 'image', fieldValue: `{{image_${index + 1}}}` })),
      { nodeId: 'static-image', fieldName: 'image', fieldValue: 'explicit-fixed-image.png' },
      { nodeId: 'opaque', fieldName: 'text', fieldValue: 'keep {{image_4}} inside literal text' },
    ], untouched: '{{image_4}}',
  }),
});

for (const count of [3, 2, 0, 4]) check(`legacy template with ${count} images clears exact unused node placeholders`, () => {
  const api = legacyApi(); const before = structuredClone(api); const images = uploaded(count);
  const body = buildVideoApiBody(api, draftFor(count), images);
  assert.deepEqual(imageValues(body), [...images, ...Array(4 - count).fill('')]);
  assert.equal(requestNodes(body).length, 7);
  assert.equal(valueAt(body, 'static-image'), 'explicit-fixed-image.png');
  if (count < 4) {
    assert.equal(valueAt(body, 'opaque'), 'keep {{image_4}} inside literal text', 'missing image placeholders embedded in literals are not cleared');
    assert.equal(body.untouched, '{{image_4}}', 'new empty-slot behavior only touches nodeInfoList.fieldValue');
  }
  assert.deepEqual(api, before);
});

check('legacy exact placeholders work without role metadata, without inventing field roles', () => {
  const api = legacyApi(); delete api.runningHubImageRoles;
  assert.deepEqual(imageValues(buildVideoApiBody(api, draftFor(2), uploaded(2))), [...uploaded(2), '', '']);
});

check('legacy templates retain overflow, role, count, blank and sparse-upload protection', () => {
  const api = legacyApi();
  assert.throws(() => buildVideoApiBody(api, draftFor(5), uploaded(5)));
  assert.throws(() => buildVideoApiBody(api, draftFor(3), uploaded(2)));
  const wrongRole = draftFor(2); wrongRole.references[1].role = 'composition';
  assert.deepEqual(imageValues(buildVideoApiBody(api, wrongRole, uploaded(2))).slice(0, 2), uploaded(2), 'role mismatch is warning-only and keeps both selected images bound');
  assert.throws(() => buildVideoApiBody(api, draftFor(2), [uploaded(1)[0], '']));
  const sparse = new Array<string>(2); sparse[0] = uploaded(1)[0];
  assert.throws(() => buildVideoApiBody(api, draftFor(2), sparse));
});

check('RunningHub empty-slot adaptation does not rewrite generic provider templates', () => {
  const api: VideoTaskApiConfig = { ...legacyApi(), provider: 'generic' };
  const body = buildVideoApiBody(api, draftFor(0), []);
  assert.deepEqual(imageValues(body), ['{{image_1}}', '{{image_2}}', '{{image_3}}', '{{image_4}}']);
});

const fingerprintAssets: ReferenceAsset[] = Array.from({ length: 4 }, (_, index) => ({
  id: `test-asset-${index + 1}`, name: `测试图${index + 1}`, type: 'reference', role: 'composition',
  mediaType: 'image', checksum: `synthetic-checksum-${index + 1}`, relativePath: `image/test-${index + 1}.png`,
  tags: [], createdAt: 1, updatedAt: 1,
}));

check('new empty-slot metadata preserves old full-selection durable request fingerprints and deduplication', () => {
  const current = compile(); const old = structuredClone(current);
  for (const field of old.runningHubMappedFields!) delete field.emptyValue;
  const draft = draftFor(4);
  const oldFingerprint = videoBatchRequestFingerprint(draft, fingerprintAssets, { backend: 'api', api: old });
  const currentFingerprint = videoBatchRequestFingerprint(draft, fingerprintAssets, { backend: 'api', api: current });
  assert.equal(currentFingerprint, oldFingerprint);
  const task: VideoGenerationTask = { id: 'pre-upgrade-completed-task', kind: 'video', storyboardId: '', targetId: '',
    status: 'succeeded', requestBody: {}, requestFingerprint: oldFingerprint, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(findVideoBatchDuplicate({ generationTasks: [task] }, currentFingerprint), {
    kind: 'succeeded', taskId: task.id, status: 'succeeded',
  });
  const oldBefore = JSON.stringify(old); const currentBefore = JSON.stringify(current);
  videoBatchRequestFingerprint(draft, fingerprintAssets, { backend: 'api', api: current });
  assert.equal(JSON.stringify(old), oldBefore); assert.equal(JSON.stringify(current), currentBefore);
});

check('request fingerprints still separate workflow node, cloud app, mapped role and service origin', () => {
  const workflow = fixture(); const draft = draftFor(4);
  const baseline = videoBatchRequestFingerprint(draft, fingerprintAssets, { backend: 'api', api: compile(workflow) });
  const otherNode = structuredClone(workflow);
  const request = JSON.parse(otherNode.requestTemplate);
  request.nodeInfoList.find((node: RequestNode) => node.nodeId === slotIds[3]).nodeId = 'another-real-image-node';
  otherNode.requestTemplate = JSON.stringify(request); otherNode.mapping.images[3].nodeId = 'another-real-image-node';
  const otherApp = { ...structuredClone(workflow), remoteId: '1234567890123456788' };
  const otherRole = structuredClone(workflow); otherRole.mapping.images[3].role = 'scene';
  const otherOrigin = compile(workflow); otherOrigin.endpoint = 'https://another.example.test/openapi/v2/run/ai-app/1234567890123456789';
  for (const [label, api] of [
    ['node', compile(otherNode)], ['app', compile(otherApp)], ['role', compile(otherRole)], ['origin', otherOrigin],
  ] as const) {
    assert.notEqual(videoBatchRequestFingerprint(draft, fingerprintAssets, { backend: 'api', api }), baseline, label);
  }
});

check('cloud-required image errors retain their real node reason without leaking input payloads', () => {
  const reason = '节点 image-d.image 是必填图片输入，当前无图值不可用。';
  const response = { taskId: 'isolated-task', status: 'FAILED', errorCode: 'REQUIRED_IMAGE', errorMessage: reason,
    failedReason: { node_id: 'image-d', node_type: 'LoadImage', exception_message: reason,
      current_inputs: { image: 'private-input-file.png', apiKey: 'isolated-secret-never-display' } } };
  const parsed = parseVideoApiResult(response, compile());
  assert.equal(parsed.status, 'failed'); assert.equal(parsed.message, reason); assert.equal(parsed.resultUrl, undefined);
  const diagnostic = videoProviderErrorDiagnostics(response)!;
  assert.ok(diagnostic.message.includes(reason)); assert.ok(diagnostic.message.includes('image-d'));
  assert.equal(diagnostic.code, 'REQUIRED_IMAGE');
  assert.ok(!JSON.stringify(diagnostic).includes('private-input-file'));
  assert.ok(!JSON.stringify(diagnostic).includes('isolated-secret-never-display'));
});

console.log(`RunningHub variable image tests passed: ${checks} checks (synthetic requests only; zero API calls)`);
