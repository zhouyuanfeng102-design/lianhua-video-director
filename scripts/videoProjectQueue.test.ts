import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { RHWEB_ORIGIN } from '../src/runningHubWeb';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { videoTaskHasUnresolvedSubmission, videoTaskLacksWebRemoteId, videoTaskOccupiesGenerationSlot } from '../src/videoGenerationQueue';
import type { AppState, Project, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// Memory-only. No browser, RunningHub page, or packaged app is opened.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 400; attempt += 1) { if (predicate()) return; await tick(); }
  assert.fail(label);
};
const webApi = (): VideoTaskApiConfig => ({
  enabled: true, provider: 'rh_web', model: 'page-app', endpoint: `${RHWEB_ORIGIN}/v1/videos`,
  statusEndpointTemplate: `${RHWEB_ORIGIN}/v1/videos/{id}`, apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result_url', rhWebAccountId: 'account-1',
  rhWebPageUrl: `${RHWEB_ORIGIN}/app`, rhWebInstance: 'Plus',
  rhWebFields: [{ key: 'prompt', label: '提示词', kind: 'text', bind: 'prompt', value: '' }],
});
const draft = (name: string): VideoGenerationDraft => ({
  name, prompt: `网页队列 ${name}`, backend: 'api', references: [], parameters: {},
  source: { storyboardId: 'board', sequencePlanId: 'plan', segmentId: `segment-${name}`, segmentIndex: 2, language: 'zh' },
});
const webTask = (id: string, projectId: string, phase: 'post-started' | 'acknowledged', remoteTaskId?: string): VideoGenerationTask => ({
  id, kind: 'video', storyboardId: 'board', targetId: 'page-app', status: remoteTaskId ? 'running' : 'draft',
  remoteTaskId, requestBody: { prompt: draft(id).prompt }, createdAt: 10, updatedAt: 11, batchId: remoteTaskId ? undefined : 'batch-web',
  batchIndex: remoteTaskId ? undefined : 2,
  videoJob: {
    stage: remoteTaskId ? 'running' : 'queued',
    batchQueueState: remoteTaskId ? undefined : 'ready',
    preparation: { version: 1, phase, uploadedImages: [] },
    message: remoteTaskId ? '远端运行中' : '本地排队中',
    snapshot: { projectId, clientId: `client-${id}`, images: [], draft: draft(id), connection: { backend: 'api', api: webApi() } },
  },
});
const apiPostStarted = webTask('api-boundary', 'project', 'post-started');
apiPostStarted.videoJob!.snapshot.connection.api = { ...webApi(), provider: 'generic', endpoint: 'https://api.queue-fixture.test/generate' };
assert.equal(videoTaskLacksWebRemoteId(webTask('web-boundary', 'project', 'post-started')), true);
assert.equal(videoTaskOccupiesGenerationSlot(webTask('web-boundary', 'project', 'post-started')), false);
assert.equal(videoTaskHasUnresolvedSubmission(webTask('web-boundary', 'project', 'post-started')), true);
assert.equal(videoTaskOccupiesGenerationSlot(webTask('web-running', 'project', 'acknowledged', 'remote-web')), true);
assert.equal(videoTaskLacksWebRemoteId(apiPostStarted), false);
assert.equal(videoTaskOccupiesGenerationSlot(apiPostStarted), true);

const harness = (tasks: VideoGenerationTask[], extraProjects: Project[] = []) => {
  const holder = { state: createInitialState() };
  const projectId = holder.state.project.id;
  for (const task of tasks) if (task.videoJob) task.videoJob.snapshot.projectId = projectId;
  holder.state.project.generationTasks = tasks;
  holder.state.projects = [holder.state.project, ...extraProjects];
  const urls: string[] = [];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async () => { throw new Error('ordinary API is not used'); },
    rhWebRequest: async (request) => {
      urls.push(request.url);
      assert.equal(new URL(request.url).hostname, 'rhweb.localhost');
      if (request.url.includes('/by-client/')) {
        const parts = request.url.split('/');
        const clientId = decodeURIComponent(parts[parts.length - 1] || '');
        return { status: 200, body: JSON.stringify({ client_id: clientId }) };
      }
      if (request.method === 'POST' && request.url.endsWith('/v1/videos')) {
        return { status: 200, body: JSON.stringify({ id: `remote-${urls.length}`, status: 'running', message: '已交给网页' }) };
      }
      return { status: 200, body: JSON.stringify({ id: 'remote-status', status: 'running', message: '仍在生成' }) };
    },
    cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {},
    unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }),
    getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async () => ({ persisted: true }),
    getVideoTaskCheckpoint: async () => null,
    downloadGeneratedMedia: async () => { throw new Error('queue fixture does not download'); },
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => holder.state,
    setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => {},
  };
  return { holder, urls, engine: new VideoGenerationEngine(options), posts: () => urls.filter((url) => url.endsWith('/v1/videos')) };
};

const foreignProject = (task: VideoGenerationTask): Project => {
  const initial = createInitialState();
  return { ...initial.project, id: task.videoJob!.snapshot.projectId, name: '其他项目', generationTasks: [task], assets: [] };
};

const waiting = webTask('segment-2', createInitialState().project.id, 'post-started');
const foreignRunning = webTask('other-project-running', 'other-project', 'acknowledged', 'foreign-remote');
const open = harness([waiting], [foreignProject(foreignRunning)]);
try {
  await open.engine.resume(waiting.id);
  await waitFor(() => open.posts().length === 1, '本项目没有网页任务号的段落没有再次提交');
  const live = open.holder.state.project.generationTasks.find((task) => task.id === waiting.id) as VideoGenerationTask;
  assert.equal(live.remoteTaskId?.startsWith('remote-'), true);
} finally { open.engine.dispose(); }

const blockedWaiting = webTask('segment-2-blocked', createInitialState().project.id, 'post-started');
const sibling = webTask('segment-running', blockedWaiting.videoJob!.snapshot.projectId, 'acknowledged', 'same-project-remote');
const blocked = harness([blockedWaiting, sibling]);
try {
  await blocked.engine.resume(blockedWaiting.id);
  await tick(); await tick(); await tick();
  assert.equal(blocked.posts().length, 0, '同一项目里正在生成的视频仍应占住名额');
  const live = blocked.holder.state.project.generationTasks.find((task) => task.id === blockedWaiting.id) as VideoGenerationTask;
  assert.equal(live.remoteTaskId, undefined);
  assert.match(live.videoJob?.message || '', /已占用 1 个名额/);
} finally { blocked.engine.dispose(); }

console.log('Project queue: another project does not occupy this slot, and a web task with no remote id can be submitted again.');
