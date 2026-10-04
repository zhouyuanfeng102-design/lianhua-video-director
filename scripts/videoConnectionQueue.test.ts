import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { createRunningHubTutorialVideoWorkflow } from '../src/runningHubVideo';
import { videoTaskExecutionScope, videoTaskHasUnresolvedSubmission, videoTaskOccupiesGenerationSlot, videoTasksMayShareExecutionScope, videoTasksShareExecutionScope } from '../src/videoGenerationQueue';
import type { AppState, Project, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { ComfyVideoConfig, VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// All endpoints, media, credentials and journals are memory-only fixtures. This
// suite never opens a real profile, writes files or calls a generation service.
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let count = 0; count < 12; count += 1) await tick(); };
const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (predicate()) return; await tick(); }
  assert.fail(label);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const api = (origin = 'https://api.scope-fixture.test'): VideoTaskApiConfig => ({
  enabled: true, endpoint: `${origin}/generate`, statusEndpointTemplate: `${origin}/tasks/{id}`,
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'scope-fixture',
});
const cloudA = { ...createRunningHubTutorialVideoWorkflow(), id: 'cloud-a', name: 'cloud A', outputNodeId: '328' };
const cloudB = { ...structuredClone(cloudA), id: 'cloud-b', name: 'cloud B', remoteId: '1923539279828742146' };
const cloudOrigin = 'https://cloud.scope-fixture.test';
const comfy: ComfyVideoConfig = {
  enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', activeWorkflowId: 'comfy-a',
  workflows: [{ id: 'comfy-a', name: 'Comfy A', createdAt: 1, updatedAt: 1,
    workflowJson: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }),
    mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [] } }],
};
const image: ReferenceAsset = { id: 'scope-image', name: 'fixture reference', type: 'reference', role: 'composition',
  tags: [], createdAt: 1, updatedAt: 1, relativePath: 'image/scope.png', checksum: 'fixture-checksum',
  fileName: 'scope.png', mediaType: 'image', managed: true };
const draft = (name: string, backend: 'api' | 'comfyui' = 'api'): VideoGenerationDraft => ({
  name, prompt: `scope fixture prompt ${name}`, backend, references: [], parameters: {},
  source: { storyboardId: `board-${name}`, sequencePlanId: `plan-${name}`, segmentId: `segment-${name}`, segmentIndex: 1, language: 'zh' },
});
const cloudDraft = (name: string, workflowId = cloudA.id): VideoGenerationDraft => ({
  ...draft(name), runningHubWorkflowId: workflowId, references: [{ assetId: image.id, role: 'general' }],
});
const isGeneration = (request: Request) => request.method === 'POST'
  && (/\/generate(?:[/?#]|$)/u.test(request.url) || request.url.endsWith('/prompt') || request.url.includes('/run/'));

const fixture = () => {
  const holder = { state: createInitialState() };
  Object.assign(holder.state.settings, { videoTaskApi: api(), comfyuiVideo: structuredClone(comfy),
    videoExecutionMode: 'concurrent', videoExecutionConcurrency: 3,
    runningHubVideo: { enabled: true, baseUrl: cloudOrigin, apiKey: 'fixture-cloud-key',
      activeWorkflowId: cloudA.id, workflows: [cloudA, cloudB] } });
  holder.state.project.assets.push(structuredClone(image));
  const requests: Request[] = [];
  const journals = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  const remoteStates = new Map<string, 'running' | 'succeeded' | 'failed'>();
  let journalRead: ((taskId: string) => Promise<VideoGenerationTask | null>) | undefined;
  let postGate: Promise<void> | undefined;
  let downloadGate: Promise<void> | undefined;
  let postIndex = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      assert.ok(url.hostname.endsWith('.scope-fixture.test') || url.hostname === '127.0.0.1', 'fixture cannot make real requests');
      if (isGeneration(request)) {
        const remoteId = `remote-${++postIndex}`;
        if (postGate) await postGate;
        remoteStates.set(remoteId, 'running');
        return response(request.url.endsWith('/prompt') ? { prompt_id: remoteId }
          : request.url.includes('/run/') ? { taskId: remoteId, status: 'RUNNING', errorCode: '', results: null }
            : { id: remoteId, status: 'running' });
      }
      if (request.url.endsWith('/media/upload/binary')) return response({ code: 0, data: { fileName: 'openapi/fixture.png' } });
      if (request.url.endsWith('/openapi/v2/query')) {
        const taskId = String(JSON.parse(request.body || '{}').taskId);
        const status = remoteStates.get(taskId) || 'running';
        return response({ taskId, status: status === 'succeeded' ? 'SUCCESS' : status.toUpperCase(), errorCode: '',
          results: status === 'succeeded' ? [{ outputType: 'mp4', nodeId: '328', url: `https://cdn.scope-fixture.test/${taskId}.mp4` }] : null });
      }
      if (url.pathname.includes('/tasks/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const status = remoteStates.get(id) || 'running';
        return response({ id, status, ...(status === 'succeeded' ? { url: `https://cdn.scope-fixture.test/${id}.mp4` } : {}) });
      }
      if (url.pathname.includes('/history/')) return response({});
      if (url.pathname === '/queue') return response({ queue_running: [], queue_pending: [] });
      assert.fail('unexpected fixture request');
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task) => { journals.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => journalRead ? journalRead(taskId) : structuredClone(journals.get(taskId) || null),
    deleteVideoTaskCheckpoint: async () => true,
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'fixture' }),
    extractWorkbenchFrames: async () => { throw new Error('completion-only fixture must not select or extract a frame'); },
    cancelWorkbenchJob: async () => true,
    downloadGeneratedMedia: async (request) => {
      if (downloadGate) await downloadGate;
      return { fileName: `${request.fileName}.mp4`, relativePath: `video/${request.requestId}.mp4`, checksum: `fixture-${request.requestId}`,
        mediaType: 'video', managed: true, missing: false, sizeBytes: 8, url: `lianhua-asset://local/video/${request.requestId}.mp4` };
    },
  };
  const options: VideoGenerationEngineOptions = { getState: () => holder.state,
    setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => {},
  };
  const h = {
    holder, requests, journals, desktop, remoteStates, engine: new VideoGenerationEngine(options),
    tasks: () => [holder.state.project, ...holder.state.projects.filter((project) => project.id !== holder.state.project.id)]
      .flatMap((project) => project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video' || task.kind == null)),
    task: (taskId: string) => h.tasks().find((task) => task.id === taskId)!,
    posts: () => requests.filter(isGeneration),
    restart: () => { h.engine.dispose(); h.engine = new VideoGenerationEngine(options); h.engine.reconcile(); },
    setJournalRead: (reader: typeof journalRead) => { journalRead = reader; },
    setPostGate: (gate: typeof postGate) => { postGate = gate; },
    setDownloadGate: (gate: typeof downloadGate) => { downloadGate = gate; },
    configure: (concurrency: number) => {
      Object.assign(holder.state.settings, { videoExecutionMode: concurrency === 1 ? 'queue' : 'concurrent', videoExecutionConcurrency: concurrency });
      h.engine.reconcile();
    },
  };
  return h;
};
type Fixture = ReturnType<typeof fixture>;
const addHistory = (h: Fixture, name: string, count: number, connection: NonNullable<VideoGenerationTask['videoJob']>['snapshot']['connection'], stopped = false) => {
  const project: Project = { ...structuredClone(h.holder.state.project), id: name, name, assets: [], generationTasks: [] };
  project.generationTasks = Array.from({ length: count }, (_, index): VideoGenerationTask => ({
    id: `${name}-${index}`, kind: 'video', storyboardId: '', targetId: 'fixture', status: 'unknown', remoteTaskId: `${name}-remote-${index}`,
    requestBody: {}, createdAt: index + 1, updatedAt: index + 1,
    videoJob: { stage: stopped ? 'stopped' : 'submission-unknown', trackingStopped: true, preparation: { version: 1, phase: 'post-started', uploadedImages: [] },
      snapshot: { projectId: name, draft: draft(`${name}-${index}`, connection.backend), connection: structuredClone(connection), images: [], clientId: `${name}-client-${index}` } },
  }));
  h.holder.state.projects.push(project);
  return project.generationTasks as VideoGenerationTask[];
};
const safeApi = (origin?: string) => { const { apiKey: _key, ...connection } = api(origin); return connection; };
const safeComfy = (baseUrl = comfy.baseUrl) => {
  const { apiKey: _key, workflows: _workflows, ...connection } = comfy;
  return { ...connection, baseUrl };
};
const batch = (h: Fixture, name: string, drafts: VideoGenerationDraft[], chain = false): VideoBatchStartInput => ({
  projectId: h.holder.state.project.id, label: name, concurrency: 3, ...(chain ? { completionOrder: true } : {}),
  items: drafts.map((value, index) => ({ itemKey: `${name}-${index}`, draft: { ...value,
    source: { ...value.source, sequencePlanId: `plan-${name}`, segmentIndex: index + 1 } } })),
});
const complete = async (h: Fixture, taskId: string) => {
  const task = h.task(taskId); assert.ok(task.remoteTaskId);
  h.remoteStates.set(task.remoteTaskId, 'succeeded');
  await h.engine.resume(taskId);
  await waitFor(() => Boolean(h.task(taskId)?.resultAssetId), 'fixture result did not save');
  h.engine.reconcile();
};
const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

test('scope contains no credentials, path, query, fragment, workflow, profile or current settings', async () => {
  const h = fixture();
  try {
    const old = addHistory(h, 'scope-label', 1, { backend: 'api', api: safeApi() })[0];
    old.videoJob!.snapshot.connection.api!.endpoint = 'HTTPS://fixture-user:fixture-pass@API.scope-fixture.test:443/private-token-path?api_key=fixture-query#fixture-fragment';
    const scope = videoTaskExecutionScope(old);
    assert.deepEqual(scope, { key: 'api:https://api.scope-fixture.test', label: '视频 API · https://api.scope-fixture.test', known: true });
    for (const secret of ['fixture-user', 'fixture-pass', 'private-token-path', 'fixture-query', 'fixture-fragment']) {
      assert.equal(JSON.stringify(scope).includes(secret), false);
    }
    const other = structuredClone(old);
    other.videoJob!.snapshot.draft.apiProfileId = 'different-profile';
    other.videoJob!.snapshot.connection.api!.provider = 'runninghub';
    other.videoJob!.snapshot.connection.api!.runningHubAppId = 'different-app';
    other.videoJob!.snapshot.connection.api!.endpoint = 'https://api.scope-fixture.test/other/workflow';
    assert.equal(videoTasksShareExecutionScope(old, other), true, 'provider/profile/workflow changes cannot split one API origin');
    h.holder.state.settings.videoTaskApi = api('https://changed.scope-fixture.test');
    assert.deepEqual(videoTaskExecutionScope(old), scope);
    other.videoJob!.legacyMetadataIncomplete = true;
    assert.equal(videoTaskExecutionScope(other).known, false, 'a synthesized current connection is not historical evidence');
    const implicitCloud = structuredClone(old);
    implicitCloud.videoJob!.snapshot.connection.api = { ...safeApi(), provider: 'runninghub', runningHubAppId: 'fixture-app', endpoint: '' };
    const explicitCloud = structuredClone(implicitCloud);
    explicitCloud.videoJob!.snapshot.connection.api!.endpoint = 'https://www.runninghub.ai/openapi/v2/run/ai-app/{appId}';
    assert.equal(videoTaskExecutionScope(implicitCloud).known, true);
    assert.equal(videoTasksShareExecutionScope(implicitCloud, explicitCloud), true,
      'implicit RunningHub default and explicit URL must share the exact service actually used by POST');
  } finally { h.engine.dispose(); }
});

test('seven stopped Comfy jobs do not stop RunningHub first segment, but preserve exact chain waiting', async () => {
  const h = fixture();
  try {
    const old = addHistory(h, 'old-comfy-project', 7, { backend: 'comfyui', comfyui: safeComfy(), workflow: comfy.workflows[0] }, true);
    const before = structuredClone(old);
    const result = await h.engine.startBatch(batch(h, 'cloud chain', [cloudDraft('first'), cloudDraft('second')], true));
    await waitFor(() => Boolean(h.task(result.taskIds[0]).remoteTaskId), 'RunningHub first segment remained blocked by unrelated ComfyUI');
    await settle();
    assert.equal(h.posts().length, 1); assert.equal(h.posts()[0].url.startsWith(cloudOrigin), true);
    assert.equal(h.task(result.taskIds[1]).remoteTaskId, undefined, 'independent service capacity does not bypass exact predecessor completion');
    assert.deepEqual(old, before, 'old stopped tasks must not be deleted, marked finished or resubmitted');
    assert.ok(old.every((task) => !videoTaskOccupiesGenerationSlot(task) && videoTaskHasUnresolvedSubmission(task)));
    assert.equal(h.requests.some((request) => request.url.includes('127.0.0.1')), false, 'unrelated stopped jobs were not queried');
    await complete(h, result.taskIds[0]);
    await waitFor(() => Boolean(h.task(result.taskIds[1]).remoteTaskId), 'second segment did not follow the exact completed predecessor');
    assert.equal(h.posts().length, 2);
  } finally { h.engine.dispose(); }
});

test('RunningHub workflows and same-origin API profiles share three real generation slots across projects', async () => {
  const h = fixture(); const gate = deferred();
  try {
    h.setPostGate(gate.promise);
    const first = await h.engine.startBatch(batch(h, 'same origin', [cloudDraft('cloud A'), cloudDraft('cloud B', cloudB.id)]));
    await waitFor(() => h.posts().length === 2, 'first two cloud submissions missing');
    const saved = h.holder.state.project;
    const next = { ...structuredClone(saved), id: 'another-project', name: 'another-project', generationTasks: [] };
    h.holder.state = { ...h.holder.state, project: next, activeProjectId: next.id,
      projects: [...h.holder.state.projects.filter((project) => project.id !== saved.id), saved, next] };
    h.holder.state.settings.videoApiProfiles = [{ ...api(cloudOrigin), id: 'cloud-generic-profile', name: 'same origin other profile', createdAt: 1, updatedAt: 1 }];
    const third = h.engine.start({ ...draft('third on same cloud origin'), apiProfileId: 'cloud-generic-profile' });
    await waitFor(() => h.posts().length === 3, 'third capacity slot missing');
    const fourth = await h.engine.start(cloudDraft('fourth on same cloud origin'));
    await settle(); assert.equal(h.posts().length, 3, 'profile, workflow and project must not each receive three slots');
    assert.equal(h.task(fourth).remoteTaskId, undefined);
    gate.resolve(); await third;
    await waitFor(() => Boolean(h.task(first.taskIds[0]).remoteTaskId), 'cloud acknowledgement missing');
    h.configure(1); await settle();
    assert.equal(h.posts().length, 3, 'lowering capacity must not cancel or re-POST existing tasks');
    assert.equal(h.tasks().filter((task) => task.remoteTaskId).length, 3);
    await complete(h, first.taskIds[0]);
    await settle(); assert.equal(h.posts().length, 3, 'still two tasks exceed the newly lowered cap');
    await complete(h, first.taskIds[1]);
    await settle(); assert.equal(h.posts().length, 3, 'one occupied slot still fills queue mode');
    const thirdTask = h.tasks().find((task) => task.videoJob?.snapshot.draft.name === 'third on same cloud origin')!;
    await complete(h, thirdTask.id);
    await waitFor(() => Boolean(h.task(fourth).remoteTaskId), 'fourth did not start once its own service truly freed');
    assert.equal(h.posts().length, 4);
  } finally { gate.resolve(); h.engine.dispose(); }
});

test('stopped history on the same RunningHub connection leaves all three local slots available after restart', async () => {
  const h = fixture();
  try {
    const old = addHistory(h, 'stopped-old-cloud-project', 1, { backend: 'api', api: safeApi(cloudOrigin) }, true)[0];
    const before = structuredClone(old);
    const first = await h.engine.start(cloudDraft('already running one'));
    const second = await h.engine.start(cloudDraft('already running two'));
    const batchResult = await h.engine.startBatch(batch(h, 'third slot regression', [cloudDraft('third allowed'), cloudDraft('fourth waits')]));
    await waitFor(() => Boolean(h.task(batchResult.taskIds[0]).remoteTaskId), 'old stopped project incorrectly blocked the third slot');
    await settle(); assert.equal(h.posts().length, 3);
    assert.equal(h.task(batchResult.taskIds[1]).remoteTaskId, undefined, 'three live tasks still exhaust the local limit');
    assert.doesNotMatch(h.task(batchResult.taskIds[1]).videoJob?.message || '', /stopped-old-cloud-project/);
    assert.deepEqual(h.task(old.id), before, 'history is not deleted or declared remotely cancelled');
    const originalIds = [first, second, batchResult.taskIds[0]].map((id) => h.task(id).remoteTaskId);
    h.restart(); await settle(); assert.equal(h.posts().length, 3);
    assert.deepEqual([first, second, batchResult.taskIds[0]].map((id) => h.task(id).remoteTaskId), originalIds);
    await h.engine.resume(old.id); await settle();
    assert.equal(h.posts().length, 3, 'explicit resume only queries the old original task');
    assert.equal(h.task(old.id).remoteTaskId, before.remoteTaskId);
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(old.id)), true, 'explicitly resumed running history is counted again');
  } finally { h.engine.dispose(); }
});

test('same-connection unknown tasks retain capacity across restart and are never re-POSTed', async () => {
  const h = fixture();
  try {
    const old = addHistory(h, 'same-api-project', 3, { backend: 'api', api: safeApi() });
    const result = await h.engine.startBatch(batch(h, 'same service blocked', [draft('blocked')], false));
    await settle(); assert.equal(h.posts().length, 0);
    assert.match(h.task(result.taskIds[0]).videoJob?.message || '', /同连接有 3 个占位任务/u);
    h.restart(); await settle(); assert.equal(h.posts().length, 0);
    assert.ok(old.every(videoTaskOccupiesGenerationSlot));
    assert.equal(h.task(result.taskIds[0]).remoteTaskId, undefined);
  } finally { h.engine.dispose(); }
});

test('a different ComfyUI server and a different API origin have independent real capacity', async () => {
  const h = fixture();
  try {
    h.configure(1);
    addHistory(h, 'old-server', 7, { backend: 'comfyui', comfyui: safeComfy(), workflow: comfy.workflows[0] });
    h.holder.state.settings.comfyuiVideo!.baseUrl = 'http://127.0.0.1:9199';
    const otherComfy = await h.engine.start(draft('other Comfy server', 'comfyui'));
    const apiTask = await h.engine.start(draft('independent API origin'));
    h.holder.state.settings.videoTaskApi = api('https://another.scope-fixture.test');
    const apiOther = await h.engine.start(draft('another API origin'));
    assert.ok(h.task(otherComfy).remoteTaskId && h.task(apiTask).remoteTaskId && h.task(apiOther).remoteTaskId);
    assert.equal(h.posts().length, 3);
  } finally { h.engine.dispose(); }
});

test('ComfyUI loopback aliases and renamed workflows cannot multiply one server capacity', async () => {
  const h = fixture();
  try {
    h.configure(1);
    const old = addHistory(h, 'loopback-origin', 1, { backend: 'comfyui', comfyui: safeComfy(), workflow: comfy.workflows[0] })[0];
    for (const address of ['http://localhost:8188/', 'http://LOCALHOST.:8188/private-path', 'http://[::1]:8188/?fixture=ignored']) {
      const alias = structuredClone(old);
      alias.videoJob!.snapshot.connection.comfyui!.baseUrl = address;
      alias.videoJob!.snapshot.connection.workflow!.id = 'renamed-workflow';
      assert.equal(videoTasksShareExecutionScope(old, alias), true);
    }
    h.holder.state.settings.comfyuiVideo!.baseUrl = 'http://localhost:8188';
    const waiting = await h.engine.start(draft('loopback alias same service', 'comfyui'));
    await settle();
    assert.equal(h.posts().length, 0);
    assert.equal(h.task(waiting).remoteTaskId, undefined);
  } finally { h.engine.dispose(); }
});

test('in-flight upload claims and pre-POST dispatch guards are scoped before and after lowering capacity', async () => {
  const h = fixture(); const imageGate = deferred(); let reads = 0;
  try {
    h.configure(3);
    h.desktop.readManagedImageDataUrl = async () => { reads += 1; await imageGate.promise; return { dataUrl: 'data:image/png;base64,AAAA' }; };
    const first = await h.engine.startBatch(batch(h, 'images before post', [1, 2, 3].map((index) => ({
      ...draft(`image preparation ${index}`), references: [{ assetId: image.id, role: 'first-frame' as const }],
    }))));
    await waitFor(() => reads >= 3, 'three local upload claims were not acquired');
    h.configure(1);
    h.holder.state.settings.videoTaskApi = api('https://other-preparing.scope-fixture.test');
    const other = await h.engine.start(draft('independent upload scope'));
    assert.ok(h.task(other).remoteTaskId, 'in-memory claims from the other origin consumed this origin capacity');
    imageGate.resolve();
    await waitFor(() => h.posts().length === 2, 'one original claim should dispatch after lower capacity');
    await settle(); assert.equal(h.posts().length, 2);
    assert.equal(first.taskIds.filter((taskId) => h.task(taskId).remoteTaskId).length, 1);
    assert.equal(h.posts().filter((request) => request.url === api().endpoint).length, 1);
  } finally { imageGate.resolve(); h.engine.dispose(); }
});

test('unresolved checkpoint barriers block only their frozen service and still prevent duplicate POST on that service', async () => {
  const h = fixture(); const readGate = deferred(); let reading = false;
  try {
    h.configure(1);
    const original = await h.engine.start(draft('newer acknowledgement in journal'));
    const running = h.task(original);
    const stale: VideoGenerationTask = { ...running, remoteTaskId: undefined, status: 'submitting', response: undefined,
      videoJob: { ...running.videoJob!, stage: 'preparing', preparation: { version: 1, phase: 'preparing', uploadedImages: [] } } };
    h.holder.state.project.generationTasks = h.holder.state.project.generationTasks.map((task) => task.id === original ? stale : task);
    h.setJournalRead(async (taskId) => { if (taskId === original) { reading = true; await readGate.promise; } return structuredClone(h.journals.get(taskId) || null); });
    h.restart();
    await waitFor(() => reading, 'recovery did not inspect stale source');
    const waiting = await h.engine.start(draft('same service awaits journal'));
    assert.equal(h.task(waiting).remoteTaskId, undefined);
    const cloud = await h.engine.start(cloudDraft('cloud ignores unrelated journal'));
    assert.ok(h.task(cloud).remoteTaskId, 'unrelated service journal globally blocked RunningHub');
    assert.equal(h.posts().length, 2);
    readGate.resolve();
    await waitFor(() => h.task(original).remoteTaskId === running.remoteTaskId, 'journal acknowledgement not restored');
    await settle(); assert.equal(h.posts().length, 2, 'same-service checkpoint restoration is not capacity release');
    await complete(h, original);
    await waitFor(() => Boolean(h.task(waiting).remoteTaskId), 'same-service completion did not release its waiting task');
    assert.equal(h.posts().length, 3);
  } finally { readGate.resolve(); h.engine.dispose(); }
});

test('mixed-service independent batch does not let its first blocked row starve another connection', async () => {
  const h = fixture();
  try {
    h.configure(1);
    addHistory(h, 'blocked-mixed', 1, { backend: 'api', api: safeApi() });
    const result = await h.engine.startBatch(batch(h, 'mixed queue', [draft('first blocked API'), cloudDraft('second ready cloud')]));
    await waitFor(() => Boolean(h.task(result.taskIds[1]).remoteTaskId), 'later different-service batch row was starved');
    assert.equal(h.task(result.taskIds[0]).remoteTaskId, undefined);
    assert.equal(h.posts().length, 1);
  } finally { h.engine.dispose(); }
});

test('legacy and invalid-origin history conservatively reserve known connection capacity until terminal evidence exists', async () => {
  const h = fixture();
  try {
    h.configure(1);
    const old = addHistory(h, 'unknown-origin', 3, { backend: 'api', api: safeApi() });
    old[0].videoJob!.legacyMetadataIncomplete = true;
    old[1].videoJob!.snapshot.connection.api!.endpoint = 'invalid fixture endpoint with private path';
    old[2].videoJob = undefined;
    old[2].status = 'failed';
    const result = await h.engine.start(draft('known target'));
    await settle();
    assert.equal(h.task(result).remoteTaskId, undefined);
    assert.ok(old.every(videoTaskOccupiesGenerationSlot), 'quarantining unknown history is not evidence of termination');
    assert.ok(old.every((task) => !videoTaskExecutionScope(task).known));
    assert.equal(new Set(old.map((task) => videoTaskExecutionScope(task).key)).size, 1);
    assert.ok(old.every((task) => videoTasksMayShareExecutionScope(task, h.task(result))));
    assert.match(h.task(result).videoJob?.message || '', /3 个旧任务来源连接待核实/u);
    assert.equal(h.posts().length, 0);
    h.restart(); await settle(); assert.equal(h.posts().length, 0);
    const owner = h.holder.state.projects.find((project) => project.id === 'unknown-origin')!;
    owner.generationTasks = owner.generationTasks.map((task) => ({ ...task, status: 'succeeded' as const, resultAssetId: 'fixture-terminal-evidence' }));
    h.engine.reconcile();
    await waitFor(() => Boolean(h.task(result).remoteTaskId), 'proven terminal legacy jobs should finally release capacity');
    assert.equal(h.posts().length, 1);
  } finally { h.engine.dispose(); }
});

test('completion ordering still waits for exact local predecessor file despite another service completion', async () => {
  const h = fixture(); const downloadGate = deferred();
  try {
    const result = await h.engine.startBatch(batch(h, 'save dependency', [cloudDraft('cloud parent'), cloudDraft('cloud child')], true));
    await waitFor(() => Boolean(h.task(result.taskIds[0]).remoteTaskId), 'parent did not start');
    const unrelated = await h.engine.start(draft('unrelated ordinary API'));
    await complete(h, unrelated);
    await settle(); assert.equal(h.task(result.taskIds[1]).remoteTaskId, undefined);
    h.setDownloadGate(downloadGate.promise);
    h.remoteStates.set(h.task(result.taskIds[0]).remoteTaskId!, 'succeeded');
    const resumed = h.engine.resume(result.taskIds[0]);
    await waitFor(() => h.task(result.taskIds[0]).videoJob?.stage === 'downloading', 'parent result did not reach blocked download');
    await settle(); assert.equal(h.task(result.taskIds[1]).remoteTaskId, undefined, 'remote completion alone cannot replace durable file readiness');
    downloadGate.resolve(); await resumed;
    await waitFor(() => Boolean(h.task(result.taskIds[0]).resultAssetId), 'parent did not persist');
    h.engine.reconcile();
    await waitFor(() => Boolean(h.task(result.taskIds[1]).remoteTaskId), 'child did not follow durable exact parent');
  } finally { downloadGate.resolve(); h.engine.dispose(); }
});

for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
console.log(`Video connection-scoped generation queue: ${tests.length} groups passed (memory-only fixtures).`);
