import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureImageApiSnapshot, imageApiChoiceLabel, normalizeImageApiSnapshot, resolveImageApiForRegeneration, resolveWorkbenchImageApi } from '../src/imageApiSelection';
import { cloneImageBatchConfig, enqueueImageBatchMembers, imageBatchMemberApi, imageBatchTaskIsActive } from '../src/imageBatch';
import { createImageGenerationTask } from '../src/generationTasks';
import { buildImageRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import { requestImageModel } from '../src/services/llm';
import { createInitialState, normalizeState } from '../src/storage';
import type { ImageApiConfig, ImageApiProfile, ImageGenerationTask } from '../src/types';

const profile = (id: string, backend: ImageApiConfig['backend'] = 'openai'): ImageApiProfile => ({
  id, name: `测试配置${id}`, backend, enabled: true, baseUrl: `https://${id}.example.invalid/v1`, apiKey: `fixture-key-${id}`,
  model: `fixture-model-${id}`, createdAt: 1, updatedAt: 1,
});
const state = createInitialState();
const a = profile('a'); const b = profile('b');
state.settings.imageApiProfiles = [a, b];
state.settings.imageApi = cloneImageBatchConfig(a);
state.settings.activeImageApiProfileId = a.id;
state.settings.privateImageApiProfileId = b.id;
const initialSettings = JSON.stringify(state.settings);

const ordinary = resolveWorkbenchImageApi(state.settings, 'ordinary');
const privateB = resolveWorkbenchImageApi(state.settings, 'private');
assert.equal(ordinary.profileId, a.id); assert.equal(ordinary.config.apiKey, a.apiKey);
assert.equal(privateB.profileId, b.id); assert.equal(privateB.config.apiKey, b.apiKey);
assert.equal(privateB.config.model, b.model);
assert.equal('name' in privateB.config, false, 'saved profile metadata is not transport configuration');
assert.equal(JSON.stringify(state.settings), initialSettings, 'choosing a private API does not mutate global config');
privateB.config.model = 'mutated-clone';
assert.equal(b.model, 'fixture-model-b');
assert.equal(resolveWorkbenchImageApi({ ...state.settings, privateImageApiProfileId: null }, 'private').config.model, a.model);
assert.equal(resolveWorkbenchImageApi({ ...state.settings, imageApiProfiles: [], activeImageApiProfileId: null, privateImageApiProfileId: null }, 'private').config.model, a.model);
const unsaved = {
  ...state.settings, privateImageApiProfileId: null,
  imageApi: { ...state.settings.imageApi, quality: 'unsaved-option' },
};
const unsavedChoice = resolveWorkbenchImageApi(unsaved, 'private');
assert.equal(unsavedChoice.profileId, null, 'unsaved execution edits cannot be bound to a stale saved profile');
const unsavedSnapshot = await captureImageApiSnapshot(unsavedChoice.config, unsavedChoice.profileId);
assert.deepEqual(await resolveImageApiForRegeneration(unsaved, unsavedSnapshot), unsaved.imageApi, 'no later edit means a private current-config task can immediately retry');
assert.equal(resolveWorkbenchImageApi({ ...state.settings, privateImageApiProfileId: 'deleted' }, 'private').config.enabled, false);
assert.match(resolveWorkbenchImageApi({ ...state.settings, privateImageApiProfileId: 'deleted' }, 'private').issue, /已删除/u);
assert.match(resolveWorkbenchImageApi({ ...state.settings, imageApiProfiles: [{ ...b, enabled: false }] }, 'private').issue, /已停用/u);
const label = imageApiChoiceLabel(b, b.name);
assert.match(label, /测试配置b.*fixture-model-b/u);
assert.doesNotMatch(label, /https:|fixture-key/u);

const frozenB = resolveWorkbenchImageApi(state.settings, 'private');
const snapshot = await captureImageApiSnapshot(frozenB.config, frozenB.profileId);
const mutateDuringCapture = { ...a };
const captureInFlight = captureImageApiSnapshot(mutateDuringCapture, a.id);
mutateDuringCapture.model = 'changed-after-capture-start';
assert.equal((await captureInFlight).config.model, 'fixture-model-a');
assert.equal(snapshot.profileId, b.id);
assert.equal(snapshot.config.model, b.model);
assert.equal(snapshot.connectionFingerprint.length, 64);
assert.equal(snapshot.executionFingerprint.length, 64);
assert.doesNotMatch(JSON.stringify(snapshot), /fixture-key|example\.invalid|apiKey|baseUrl/u);
state.settings.privateImageApiProfileId = a.id;
state.settings.imageApi = { ...a, model: 'new-default-model', apiKey: 'new-default-key' };
b.model = 'new-b-model'; b.apiKey = 'rotated-b-key';
const retriedB = await resolveImageApiForRegeneration(state.settings, snapshot);
assert.equal(retriedB.model, 'fixture-model-b', 'model remains the one captured at task creation');
assert.equal(retriedB.apiKey, 'rotated-b-key', 'credentials come only from the same original profile');
assert.equal(retriedB.baseUrl, b.baseUrl);
assert.equal(frozenB.config.apiKey, 'fixture-key-b', 'already queued API credentials remain frozen');
assert.equal(frozenB.config.model, 'fixture-model-b');
assert.deepEqual(await resolveImageApiForRegeneration(state.settings), state.settings.imageApi, 'legacy retry remains compatible');
await assert.rejects(resolveImageApiForRegeneration({ ...state.settings, imageApiProfiles: [a] }, snapshot), /已删除/u);
await assert.rejects(resolveImageApiForRegeneration({ ...state.settings, imageApiProfiles: [a, { ...b, enabled: false }] }, snapshot), /停用/u);
await assert.rejects(resolveImageApiForRegeneration({ ...state.settings, imageApiProfiles: [a, { ...b, baseUrl: a.baseUrl }] }, snapshot), /服务地址/u);
await assert.rejects(resolveImageApiForRegeneration(state.settings, normalizeImageApiSnapshot({ version: 3 })!), /快照不可用/u);
await assert.rejects(resolveImageApiForRegeneration(state.settings, normalizeImageApiSnapshot(null)!), /快照不可用/u);

// Unknown future/imported sampling options are also fingerprinted: never silently drift during a retry.
const extraOptions = { ...b, quality: 'standard', sampling: { strength: 0.6, sampler: 'fixed', steps: 20 } };
const extraSnapshot = await captureImageApiSnapshot(extraOptions, b.id);
const reorderedOptions = { ...b, sampling: { steps: 20, sampler: 'fixed', strength: 0.6 }, quality: 'standard' };
assert.equal((await captureImageApiSnapshot(reorderedOptions, b.id)).executionFingerprint, extraSnapshot.executionFingerprint, 'object ordering is not an execution change');
for (const changed of [
  { ...extraOptions, quality: 'hd' },
  { ...extraOptions, sampling: { ...extraOptions.sampling, strength: 0.3 } },
  { ...extraOptions, sampling: { ...extraOptions.sampling, sampler: 'changed' } },
]) {
  await assert.rejects(resolveImageApiForRegeneration({ ...state.settings, imageApiProfiles: [changed] }, extraSnapshot), /执行参数/u);
}

const comfy = {
  ...profile('comfy', 'comfyui'), activeComfyuiWorkflowId: 'wf',
  comfyuiPathMode: 'custom' as const, comfyuiPromptPath: '/custom/prompt?token=PATH_SECRET',
  baseUrl: 'https://user:USERINFO_SECRET@comfy.example.invalid?token=QUERY_SECRET',
  workflowJson: JSON.stringify({ node: { inputs: { Authorization: 'Bearer HEADER_SECRET', steps: 30 } } }),
  comfyuiWorkflows: [{ id: 'wf', name: '工作流', workflowJson: '{"inputs":{"token":"WORKFLOW_SECRET","steps":30}}', createdAt: 1, updatedAt: 1 }],
};
const comfySnapshot = await captureImageApiSnapshot(comfy, comfy.id);
assert.doesNotMatch(JSON.stringify(comfySnapshot), /SECRET|Bearer|https|\/custom|Authorization/u, 'URLs, paths and arbitrary embedded workflow credentials are never stored in task snapshots');
const comfySettings = { ...state.settings, imageApiProfiles: [comfy] };
const originalComfy = await resolveImageApiForRegeneration(comfySettings, comfySnapshot);
assert.equal(originalComfy.workflowJson, comfy.workflowJson);
assert.equal(originalComfy.comfyuiPromptPath, comfy.comfyuiPromptPath);
await assert.rejects(resolveImageApiForRegeneration({ ...comfySettings, imageApiProfiles: [{ ...comfy, comfyuiPromptPath: '/prompt' }] }, comfySnapshot), /执行参数/u);
await assert.rejects(resolveImageApiForRegeneration({ ...comfySettings, imageApiProfiles: [{ ...comfy, comfyuiWorkflows: [{ ...comfy.comfyuiWorkflows[0], workflowJson: '{"steps":99}' }] }] }, comfySnapshot), /工作流/u);
const noProfileSettings = { ...state.settings, imageApiProfiles: [], activeImageApiProfileId: null, privateImageApiProfileId: null };
const currentSnapshot = await captureImageApiSnapshot(noProfileSettings.imageApi, null);
assert.equal((await resolveImageApiForRegeneration(noProfileSettings, currentSnapshot)).model, noProfileSettings.imageApi.model);
await assert.rejects(resolveImageApiForRegeneration({ ...noProfileSettings, imageApi: b }, currentSnapshot), /服务地址/u);

// A restart preserves the route and safe snapshot, but never auto-submits interrupted work.
const task = createImageGenerationTask({
  id: 'private-api-fixture', name: '私密API路由测试', assetKind: 'character', imageVariant: 'private-full-body',
  backend: 'openai', model: snapshot.config.model, imageApiSnapshot: snapshot,
  prompt: 'Neutral QA request', width: 1024, height: 1536,
}, 1, 'queued');
state.project.generationTasks = [task]; state.projects = [state.project];
assert.equal(imageBatchTaskIsActive(state, state.project.id, task), true);
assert.equal(imageBatchTaskIsActive(state, state.project.id, { ...task, imageApiSnapshot: { ...snapshot, config: { ...snapshot.config, model: 'tampered' } } }), false,
  'a replaced API snapshot cannot authorize the original queued request');
state.settings.privateImageApiProfileId = 'deleted';
const restored = normalizeState(state);
assert.equal(restored.settings.privateImageApiProfileId, 'deleted');
const restoredTask = restored.project.generationTasks[0] as ImageGenerationTask;
assert.equal(restoredTask.status, 'failed');
assert.deepEqual(restoredTask.imageApiSnapshot, snapshot);
const polluted = { ...snapshot, leakedHeader: 'HEADER_SECRET', config: { ...snapshot.config, apiKey: 'KEY_SECRET', baseUrl: 'QUERY_SECRET', workflowJson: 'WORKFLOW_SECRET' } };
assert.doesNotMatch(JSON.stringify(normalizeImageApiSnapshot(polluted)), /SECRET/u);
const ordinaryTask = { ...restoredTask, imageVariant: 'full-body' as const, referenceScope: 'general' as const };
const retryTask = buildImageRegenerationTask(ordinaryTask, { ...restored.project, generationTasks: [ordinaryTask] }, {
  id: 'retry-safe', timestamp: 2, backend: 'openai', model: snapshot.config.model,
  source: resolveImageRegenerationSource(ordinaryTask, restored.project),
});
assert.deepEqual(retryTask.imageApiSnapshot, snapshot, 'manual regeneration lineage carries the original API snapshot');

// Actual image transport is mocked at the desktop boundary. One queued member cannot inherit a later selection.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (request: { url: string; headers?: Record<string, string>; body?: string }) => {
    calls.push(request); return { status: 200, body: JSON.stringify({ data: [{ b64_json: png }] }) };
  },
} } });
try {
  const frozenA = cloneImageBatchConfig(ordinary.config);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const queued = enqueueImageBatchMembers([frozenA, frozenB.config], () => true, async (config, index) => {
    if (!index) { started(); await gate; }
    await requestImageModel(imageBatchMemberApi(config), { prompt: 'A neutral square', width: 1024, height: 1024 });
  });
  await firstStarted;
  state.settings.imageApi = { ...profile('unrelated'), apiKey: 'do-not-send' };
  state.settings.privateImageApiProfileId = 'unrelated';
  release(); await queued;
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).hostname, 'a.example.invalid');
  assert.equal(new URL(calls[1].url).hostname, 'b.example.invalid');
  assert.equal(JSON.parse(calls[0].body!).model, 'fixture-model-a');
  assert.equal(JSON.parse(calls[1].body!).model, 'fixture-model-b');
  assert.equal(calls[0].headers?.Authorization, 'Bearer fixture-key-a');
  assert.equal(calls[1].headers?.Authorization, 'Bearer fixture-key-b');
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const workbench = app.slice(app.indexOf('function ImageWorkbenchView'), app.indexOf('function AssetsView'));
assert.match(workbench, /aria-label="私密生图 API 配置"/u);
assert.match(workbench, /const requestedImageApi = cloneImageBatchConfig\(imageWorkbenchApi\)/u);
assert.match(workbench, /privateImageApiProfileId: profileId \|\| null/u);
assert.match(workbench, /imageApiSnapshot: requestedImageApiSnapshot/u);
assert.match(app, /await resolveImageApiForRegeneration\(state.settings, originalTask.imageApiSnapshot\)/u);
console.log('Private API selection checks passed: independent selection, frozen A/B transport, credential isolation, safe snapshots, model/key retry, changed-option rejection, restart and deletion/disable safety; zero live requests.');
