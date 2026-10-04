import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { isVideoGenerationTask } from '../src/generationTasks';
import type { AppState, Project, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// Only memory fixtures: no user project, filesystem write, or real API request.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 8; index += 1) await tick(); };
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let index = 0; index < 600; index += 1) { if (predicate()) return; await tick(); }
  assert.fail(message);
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const api: VideoTaskApiConfig = { enabled: true, endpoint: 'https://background.fixture.test/generate',
  statusEndpointTemplate: 'https://background.fixture.test/tasks/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  provider: 'generic', model: 'frozen-original-model', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const draft = (name: string): VideoGenerationDraft => ({ name, prompt: `Fixture prompt ${name}`, backend: 'api', references: [], parameters: {} });
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const allProjects = (state: AppState): Project[] => [state.project, ...state.projects.filter((project) => project.id !== state.project.id)];
const harness = () => {
  let state = createInitialState();
  state.settings.videoTaskApi = { ...api };
  state.settings.videoExecutionMode = 'queue'; state.settings.videoExecutionConcurrency = 1;
  const firstProjectId = state.project.id;
  const second: Project = { ...structuredClone(state.project), id: 'background-second-project', name: 'Project B', assets: [], generationTasks: [], description: 'Foreground creation stays here' };
  state.projects = [state.project, second];
  const requests: Request[] = [];
  const remote = new Map<string, 'running' | 'succeeded'>();
  const journals = new Map<string, VideoGenerationTask>();
  const saves: string[] = [];
  const extractions: Array<Parameters<NonNullable<VideoGenerationDesktop['extractWorkbenchFrames']>>[0]> = [];
  let postGate: Promise<void> | undefined;
  let extractionGate: Promise<void> | undefined;
  let maxConcurrentRemote = 0;
  let nextRemote = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(request);
      assert.equal(new URL(request.url).hostname, 'background.fixture.test');
      if (request.method === 'POST') {
        const id = `remote-${++nextRemote}`;
        remote.set(id, 'running');
        maxConcurrentRemote = Math.max(maxConcurrentRemote, [...remote.values()].filter((status) => status === 'running').length);
        if (postGate) await postGate;
        return response({ id, status: 'running' });
      }
      const id = new URL(request.url).pathname.split('/').at(-1)!;
      const status = remote.get(id) || 'running';
      return response({ id, status, ...(status === 'succeeded' ? { url: `https://media.fixture.test/${id}.mp4` } : {}) });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {}, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { journals.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (id) => structuredClone(journals.get(id) || null), deleteVideoTaskCheckpoint: async () => true,
    downloadGeneratedMedia: async (request) => ({ fileName: `${request.fileName}.mp4`, relativePath: `video/${request.requestId}.mp4`,
      checksum: request.requestId, sizeBytes: 8, mediaType: 'video', managed: true, missing: false, url: `lianhua-asset://local/video/${request.requestId}.mp4` }),
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum || relativePath}`, mimeType: 'image/png', sizeBytes: 8, checksum: expectedChecksum || relativePath }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'fixture' }),
    extractWorkbenchFrames: async (request) => {
      extractions.push(request);
      if (extractionGate) await extractionGate;
      const index = extractions.length;
      return { probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' },
        frames: [{ fileName: `frame-${index}.png`, relativePath: `image/frame-${index}.png`, checksum: `tail-${index}`, sizeBytes: 8,
          mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, url: `lianhua-asset://local/image/frame-${index}.png`,
          timeSec: 9.9, frameIndex: 99, width: 640, height: 360, role: 'last-frame' }] };
    },
    cancelWorkbenchJob: async () => true,
  };
  const options: VideoGenerationEngineOptions = { getState: () => state, setState: (updater) => { state = updater(state); },
    onRuntime: () => {}, desktop, pollIntervalMs: 60_000,
    persistState: async () => { saves.push(serializeStateForStorage(state).serialized); },
  };
  const h = {
    firstProjectId, secondProjectId: second.id, requests, journals, saves, remote, extractions,
    engine: new VideoGenerationEngine(options),
    state: () => state,
    owner: (id: string) => allProjects(state).find((project) => project.id === id)!,
    tasks: () => allProjects(state).flatMap((project) => project.generationTasks.filter(isVideoGenerationTask)),
    task: (id: string) => h.tasks().find((task) => task.id === id)!,
    posts: () => requests.filter((request) => request.method === 'POST'),
    setPostGate: (gate?: Promise<void>) => { postGate = gate; },
    setExtractionGate: (gate?: Promise<void>) => { extractionGate = gate; },
    maxConcurrent: () => maxConcurrentRemote,
    switchTo: (projectId: string) => {
      const target = h.owner(projectId);
      state = { ...state, project: target, activeProjectId: target.id, projects: allProjects(state) };
      h.engine.reconcile();
    },
    editCurrent: () => {
      const next = { ...state.project, description: 'Edited while original project renders', updatedAt: Date.now() };
      state = { ...state, project: next, projects: state.projects.map((project) => project.id === next.id ? next : project) };
      state.settings = { ...state.settings, videoTaskApi: { ...api, model: 'new-foreground-model' } };
    },
    restartFromSaved: () => {
      h.engine.dispose();
      assert.ok(saves.length); state = normalizeState(JSON.parse(saves.at(-1)!));
      h.engine = new VideoGenerationEngine(options); h.engine.reconcile();
    },
    complete: async (taskId: string) => {
      const task = h.task(taskId); assert.ok(task.remoteTaskId);
      remote.set(task.remoteTaskId, 'succeeded');
      await h.engine.resume(taskId);
      await waitFor(() => Boolean(h.task(taskId).resultAssetId), 'background result was not saved');
      h.engine.reconcile();
    },
  };
  return h;
};
const batch = (projectId: string, chain = false): VideoBatchStartInput => ({ projectId, label: 'Background batch', concurrency: 1,
  items: [1, 2, ...(chain ? [3] : [])].map((index) => ({ itemKey: `item-${index}`, draft: { ...draft(`Original ${index}`),
    source: { storyboardId: `board-${index}`, sequencePlanId: 'background-plan', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh' as const } },
    ...(chain && index > 1 ? { previousTail: { predecessorItemKey: `item-${index - 1}`, placement: { mode: 'append' as const, index: 0, role: 'first-frame' as const } } } : {}),
  })),
});

// An in-flight POST remains owned by A. A's next queued row and a new row in B
// share the same connection capacity, including a restart while B is active.
{
  const h = harness(); const gate = deferred(); h.setPostGate(gate.promise);
  try {
    const created = await h.engine.startBatch(batch(h.firstProjectId));
    await waitFor(() => h.posts().length === 1, 'original POST missing');
    h.switchTo(h.secondProjectId); h.editCurrent();
    const foregroundTask = await h.engine.start(draft('Foreground work'));
    await settle();
    assert.equal(h.posts().length, 1, 'changing projects does not allocate another same-connection slot');
    assert.equal(h.task(foregroundTask).remoteTaskId, undefined);
    gate.resolve(); await waitFor(() => Boolean(h.task(created.taskIds[0]).remoteTaskId), 'POST acknowledgement was lost on switch');
    // Persist the latest combined graph, as the application autosave does.
    h.saves.push(serializeStateForStorage(h.state()).serialized);
    h.restartFromSaved(); await settle();
    assert.equal(h.state().project.id, h.secondProjectId);
    assert.equal(h.posts().length, 1, 'restored background work must query its original remote ID, not POST again');
    const ids = [...created.taskIds, foregroundTask];
    for (let remaining = ids.length; remaining > 0; remaining -= 1) {
      await waitFor(() => ids.some((id) => h.task(id).remoteTaskId && !h.task(id).resultAssetId), 'queued work did not receive the shared slot');
      const next = ids.find((id) => h.task(id).remoteTaskId && !h.task(id).resultAssetId)!;
      await h.complete(next);
    }
    assert.equal(h.posts().length, 3); assert.equal(h.maxConcurrent(), 1);
    const original = h.owner(h.firstProjectId); const foreground = h.owner(h.secondProjectId);
    assert.equal(original.assets.filter((asset) => asset.mediaType === 'video').length, 2);
    assert.equal(foreground.assets.filter((asset) => asset.mediaType === 'video').length, 1);
    assert.equal(foreground.description, 'Edited while original project renders');
    assert.equal(h.state().project.id, h.secondProjectId, 'background completion never steals the foreground workspace');
    assert.ok(original.assets.every((asset) => asset.videoSourceTask?.videoJob?.snapshot.projectId === h.firstProjectId));
    assert.ok(foreground.assets.every((asset) => asset.videoSourceTask?.videoJob?.snapshot.projectId === h.secondProjectId));
    const originalBodies = h.posts().map((request) => JSON.parse(request.body!)).filter((body) => body.prompt.startsWith('Fixture prompt Original'));
    assert.ok(originalBodies.every((body) => body.model === 'frozen-original-model'), 'foreground API edits cannot alter an existing background task');
    const persisted = normalizeState(JSON.parse(h.saves.at(-1)!));
    assert.equal(allProjects(persisted).find((project) => project.id === h.firstProjectId)?.assets.filter((asset) => asset.mediaType === 'video').length, 2);
    assert.equal(allProjects(persisted).find((project) => project.id === h.secondProjectId)?.assets.filter((asset) => asset.mediaType === 'video').length, 1);
  } finally { gate.resolve(); h.engine.dispose(); }
}

// Tail extraction, its persistence barrier, and later queued segments keep
// operating in the owner project while a different project stays editable.
{
  const h = harness(); const extraction = deferred(); h.setExtractionGate(extraction.promise);
  try {
    const created = await h.engine.startBatch(batch(h.firstProjectId, true));
    await waitFor(() => Boolean(h.task(created.taskIds[0]).remoteTaskId), 'chain first POST missing');
    h.switchTo(h.secondProjectId); h.editCurrent();
    await h.complete(created.taskIds[0]);
    await waitFor(() => h.extractions.length === 1, 'background tail extraction did not start');
    h.switchTo(h.firstProjectId); h.switchTo(h.secondProjectId); await settle();
    assert.equal(h.posts().length, 1, 'project switching does not bypass a held tail extraction');
    extraction.resolve();
    for (const taskId of created.taskIds.slice(1)) {
      await waitFor(() => Boolean(h.task(taskId).remoteTaskId), 'dependent background segment did not submit');
      await h.complete(taskId);
    }
    assert.equal(h.posts().length, 3); assert.equal(h.extractions.length, 2);
    assert.equal(h.maxConcurrent(), 1);
    assert.equal(h.state().project.id, h.secondProjectId);
    assert.equal(h.owner(h.secondProjectId).assets.length, 0, 'no tail frames or original videos leak into the foreground project');
    const original = h.owner(h.firstProjectId);
    assert.equal(original.assets.filter((asset) => asset.mediaType === 'video').length, 3);
    assert.equal(original.assets.filter((asset) => asset.mediaType === 'image').length, 2);
    assert.ok(h.extractions.every((request) => request.projectId === h.firstProjectId));
    assert.deepEqual(h.extractions.map((request) => request.source.assetId), created.taskIds.slice(0, 2).map((id) => h.task(id).resultAssetId));
    const bodies = h.posts().map((request) => JSON.parse(request.body!));
    assert.match(bodies[1].first_frame_image, /tail-1/u); assert.match(bodies[2].first_frame_image, /tail-2/u);
    const saved = normalizeState(JSON.parse(h.saves.at(-1)!));
    const savedOwner = allProjects(saved).find((project) => project.id === h.firstProjectId)!;
    assert.equal(savedOwner.assets.length, 5);
    assert.equal(saved.project.id, h.secondProjectId);
  } finally { extraction.resolve(); h.engine.dispose(); }
}

const controllerSource = readFileSync(new URL('../src/useVideoGenerationController.ts', import.meta.url), 'utf8');
assert.match(controllerSource, /\}, \[ready, runtimeStore\]\);/u, 'the engine must not be recreated for each project selection');
assert.match(controllerSource, /getState:\s*\(\) => current\.current\.getCurrentState\?\.\(\)/u, 'engine callbacks must read the latest combined project state');
console.log('Background project video passed: running/queued tasks, same-connection concurrency, restart/no duplicate POST, frozen parameters, owner-only assets and saves, foreground edits, and exact tail-dependent execution across project switches.');
