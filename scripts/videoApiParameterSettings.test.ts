import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { applyVideoApiParameterCapabilities } from '../src/videoApiParameterSettings';
import { videoApiCapabilityScope } from '../src/videoApiCapabilities';
import { videoBatchConnectionIdentity, videoBatchRequestFingerprint, videoTaskRequestFingerprint } from '../src/videoBatch';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppSettings, AppState, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoApiParameterCapabilities } from '../src/videoApiCapabilityTypes';
import type { VideoApiProfile, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// All sites, keys and tasks in this focused check are synthetic and offline.
const config: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', baseUrl: 'https://parameter-fixture.example.test',
  endpoint: 'https://parameter-fixture.example.test/v1/videos',
  statusEndpointTemplate: 'https://parameter-fixture.example.test/v1/videos/{id}',
  apiKey: 'synthetic-parameter-fixture-key', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'output.url', model: 'fixture-video',
  requestTemplate: JSON.stringify({ prompt: '{{prompt}}', model: '{{model}}', parameters: '{{parameters}}' }),
};
const capabilities = (target = config, fetchedAt = 100): VideoApiParameterCapabilities => ({
  scope: videoApiCapabilityScope(target), source: 'openapi', fetchedAt,
  sourceUrl: `${target.baseUrl}/openapi.json`,
  models: { 'fixture-video': {
    controls: { duration: { kind: 'number', min: 5, max: 15, step: 1, source: 'openapi' },
      resolution: { kind: 'select', options: ['720p'], restricted: true, source: 'openapi' } },
    defaults: { duration: 10, aspect_ratio: '16:9', resolution: '720p' },
  } },
});
const profile = (id: string, current: VideoTaskApiConfig): VideoApiProfile => ({
  ...structuredClone(current), id, name: id, createdAt: 1, updatedAt: 1,
});
const settingsFixture = (): AppSettings => ({
  ...createInitialState().settings, videoTaskApi: structuredClone(config), activeVideoApiProfileId: 'active',
  videoApiProfiles: [profile('active', config), profile('inactive', { ...config, model: 'other-model' })],
});
const stripMetadata = (value: VideoTaskApiConfig) => {
  const { parameterCapabilities: _metadata, ...rest } = value;
  return rest;
};
let groups = 0;
const check = (name: string, run: () => void) => { run(); groups += 1; console.log(`passed: ${name}`); };

check('current and active profile receive cloned metadata without changing config or defaults', () => {
  for (const selected of [undefined, 'active']) {
    const settings = settingsFixture(), incoming = capabilities();
    const before = structuredClone(settings);
    const after = applyVideoApiParameterCapabilities(settings, selected, config, incoming);
    assert.notEqual(after, settings);
    assert.deepEqual(after.videoTaskApi.parameterCapabilities, incoming);
    assert.deepEqual(after.videoApiProfiles![0].parameterCapabilities, incoming);
    assert.deepEqual(after.videoApiProfiles![1], before.videoApiProfiles![1]);
    assert.deepEqual(stripMetadata(after.videoTaskApi), before.videoTaskApi);
    const { updatedAt: _time, parameterCapabilities: _metadata, ...saved } = after.videoApiProfiles![0];
    const { updatedAt: _beforeTime, ...original } = before.videoApiProfiles![0];
    assert.deepEqual(saved, original);
    incoming.models['fixture-video'].defaults.duration = 999;
    assert.equal(after.videoTaskApi.parameterCapabilities!.models['fixture-video'].defaults.duration, 10);
    assert.equal(after.videoApiProfiles![0].parameterCapabilities!.models['fixture-video'].defaults.duration, 10);
    assert.deepEqual(settings, before, 'the existing settings object remains untouched');
  }
});

check('inactive profile updates independently of the current connection', () => {
  const settings = settingsFixture(), expected = settings.videoApiProfiles![1];
  const after = applyVideoApiParameterCapabilities(settings, 'inactive', expected, capabilities(expected));
  assert.equal(after.videoTaskApi, settings.videoTaskApi);
  assert.equal(after.videoApiProfiles![0], settings.videoApiProfiles![0]);
  assert.deepEqual(after.videoApiProfiles![1].parameterCapabilities, capabilities(expected));
  assert.equal(after.videoApiProfiles![1].model, 'other-model');
  assert.equal(after.videoApiProfiles![1].apiKey, expected.apiKey);
});

check('stale async reads reject changed account, model, service and request protocol', () => {
  const patches: Array<Partial<VideoTaskApiConfig>> = [
    { apiKey: 'synthetic-new-account-key' }, { model: 'new-model' },
    { baseUrl: 'https://another-fixture.example.test' },
    { endpoint: 'https://parameter-fixture.example.test/new/videos' },
    { statusEndpointTemplate: 'https://parameter-fixture.example.test/new/tasks/{id}' },
    { provider: 'minimax' }, { authHeader: 'X-Api-Key' }, { authScheme: '' },
  ];
  for (const selected of [undefined, 'active', 'inactive']) {
    for (const patch of patches) {
      const settings = settingsFixture();
      const target = selected ? settings.videoApiProfiles!.find((item) => item.id === selected)! : settings.videoTaskApi;
      const expected = structuredClone(target), incoming = capabilities(expected);
      Object.assign(target, patch);
      assert.equal(applyVideoApiParameterCapabilities(settings, selected, expected, incoming), settings);
    }
  }
  const settings = settingsFixture();
  assert.equal(applyVideoApiParameterCapabilities(settings, 'removed-profile', config, capabilities()), settings);
  assert.equal(applyVideoApiParameterCapabilities(settings, undefined, config, {
    ...capabilities(), scope: videoApiCapabilityScope({ ...config, baseUrl: 'https://wrong-fixture.example.test' }),
  }), settings, 'a response from the wrong service scope is never installed');
});

check('metadata survives normalized storage and never adds suggested defaults to submissions', () => {
  const state = createInitialState();
  state.settings = applyVideoApiParameterCapabilities(settingsFixture(), undefined, config, capabilities());
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(normalizeState(state)).serialized));
  assert.deepEqual(reloaded.settings.videoTaskApi.parameterCapabilities, capabilities());
  assert.deepEqual(reloaded.settings.videoApiProfiles!.find((item) => item.id === 'active')!.parameterCapabilities, capabilities());
  assert.equal(reloaded.settings.videoTaskApi.apiKey, config.apiKey);
  assert.equal(reloaded.settings.videoTaskApi.requestTemplate, config.requestTemplate);
  const draft: VideoGenerationDraft = { name: 'parameter fixture', prompt: 'synthetic prompt', backend: 'api', references: [], parameters: {} };
  assert.deepEqual(buildVideoApiBody(reloaded.settings.videoTaskApi, draft, []), buildVideoApiBody(config, draft, []));
  assert.deepEqual(buildVideoApiBody(reloaded.settings.videoTaskApi, draft, []).parameters, {});
  assert.deepEqual(draft.parameters, {});
  const changed = { ...draft, parameters: { duration: 12, aspect_ratio: '9:16', resolution: '720p' } };
  assert.deepEqual(buildVideoApiBody(reloaded.settings.videoTaskApi, changed, []).parameters, changed.parameters);
});

check('UI metadata preserves duplicate prevention fingerprints for current and frozen tasks', () => {
  const settings = settingsFixture();
  const draft: VideoGenerationDraft = { name: 'fingerprint fixture', prompt: 'synthetic prompt', backend: 'api', references: [], parameters: { duration: 8 } };
  for (const apiProfileId of [undefined, 'active']) {
    const selected = { ...draft, apiProfileId };
    const expected = videoBatchRequestFingerprint(selected, [], videoBatchConnectionIdentity(settings, selected));
    const updated = applyVideoApiParameterCapabilities(settings, undefined, config, capabilities());
    assert.equal(videoBatchRequestFingerprint(selected, [], videoBatchConnectionIdentity(updated, selected)), expected);
    updated.videoTaskApi.parameterCapabilities!.fetchedAt += 1;
    updated.videoTaskApi.parameterCapabilities!.models['fixture-video'].controls.duration!.max = 30;
    assert.equal(videoBatchRequestFingerprint(selected, [], videoBatchConnectionIdentity(updated, selected)), expected);
    assert.notEqual(videoBatchRequestFingerprint({ ...selected, parameters: { duration: 9 } }, [], videoBatchConnectionIdentity(updated, selected)), expected);
  }
  const state = createInitialState();
  const { apiKey: _secret, ...safe } = config;
  const task: VideoGenerationTask = { id: 'frozen-parameter-fixture', kind: 'video', name: draft.name, status: 'submitted', model: config.model!, request: '', createdAt: 1, updatedAt: 1,
    videoJob: { stage: 'queued', snapshot: { projectId: state.project.id, clientId: 'synthetic-client', draft, images: [], connection: { backend: 'api', api: safe } } } };
  const before = videoTaskRequestFingerprint(task);
  task.videoJob!.snapshot.connection.api!.parameterCapabilities = capabilities();
  assert.equal(videoTaskRequestFingerprint(task), before);
});

// Exercise public resume(), using the engine's actual encrypted-vault scope;
// no private implementation is exported or reproduced in this test.
{
  let state: AppState = createInitialState();
  state.settings = { ...settingsFixture(), videoApiProfiles: [], activeVideoApiProfileId: null };
  const vault = new Map<string, string>();
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const reads: string[] = [];
  const desktop = {
    videoRequest: async (payload: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      requests.push(payload);
      return payload.method === 'POST' ? { status: 200, body: JSON.stringify({ id: 'synthetic-remote-task', status: 'queued' }) }
        : { status: 401, body: '{}' };
    },
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { vault.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => { reads.push(taskId); return vault.get(taskId) || null; },
  } as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 };
  let engine = new VideoGenerationEngine(options);
  try {
    const draft: VideoGenerationDraft = { name: 'credential metadata fixture', prompt: 'synthetic prompt', backend: 'api', references: [], parameters: {} };
    const taskId = await engine.start(draft);
    engine.dispose();
    const scopedId = [...vault.keys()][0];
    assert.match(scopedId, /^video-task-scope-[a-f0-9]{64}$/u);
    assert.equal(vault.size, 1);
    const task = state.project.generationTasks.find((item) => item.id === taskId) as VideoGenerationTask;
    assert.equal(task.remoteTaskId, 'synthetic-remote-task');
    task.videoJob!.snapshot.connection.api!.parameterCapabilities = capabilities();
    state.settings.videoTaskApi.apiKey = '';
    requests.length = 0; reads.length = 0;
    engine = new VideoGenerationEngine(options);
    await engine.resume(taskId);
    for (let count = 0; count < 100 && !requests.length; count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(requests.length, 'resume issued the expected synthetic polling GET');
    assert.ok(reads.includes(scopedId), 'the historical vault scope survives new UI metadata');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].headers?.Authorization, `Bearer ${config.apiKey}`);
    assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
    assert.equal(vault.size, 1, 'metadata changes do not create another credential identity');
    groups += 1; console.log('passed: frozen task credential scope remains usable after metadata refresh');
  } finally { engine.dispose(); }
}

console.log(`videoApiParameterSettings: ${groups} focused persistence and identity checks passed (offline, no paid generation)`);
