import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { createRunningHubTutorialVideoWorkflow, compileRunningHubVideoApi } from '../src/runningHubVideo';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { videoBatchRequestFingerprint } from '../src/videoBatch';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { GeneratedMediaDownloadRequest, VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (test: () => boolean, reason: string) => {
  for (let count = 0; count < 500; count += 1) { if (test()) return; await tick(); }
  assert.fail(reason);
};
const settle = async () => { for (let index = 0; index < 8; index += 1) await tick(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; };
const response = (value: unknown, status = 200) => ({ status, body: JSON.stringify(value) });
const image: ReferenceAsset = { id: 'manual-reference', name: '已选原图', type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
  relativePath: 'image/reference.png', checksum: 'reference-sha', fileName: 'reference.png', mediaType: 'image', managed: true };
const workflowA: RunningHubVideoWorkflow = { ...createRunningHubTutorialVideoWorkflow(), id: 'cloud-a', name: '云端A', outputNodeId: '328' };
const workflowB: RunningHubVideoWorkflow = { ...structuredClone(workflowA), id: 'cloud-b', name: '云端B', runKind: 'workflow', remoteId: '1923539279828742146' };
const cloudConfig: RunningHubVideoConfig = { enabled: true, baseUrl: 'https://runninghub.example.test', apiKey: 'independent-cloud-key', activeWorkflowId: workflowA.id, workflows: [workflowA, workflowB] };
const draft = (workflowId = workflowA.id, index = 1): VideoGenerationDraft => ({ name: `云端分段${index}`, backend: 'api', runningHubWorkflowId: workflowId,
  prompt: `第${index}段完整视频提示词，对白：“我们走吧。”`, references: [{ assetId: image.id, role: 'general' }], parameters: { duration: 8 },
  source: { storyboardId: `board-${index}`, sequencePlanId: 'cloud-plan', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh', label: `第${index}段` },
});
const makeHarness = (handler?: (request: Request, harness: HarnessState) => Promise<ReturnType<typeof response>>) => {
  const holder: HarnessState = { state: createInitialState(), requests: [], downloads: [], checkpoints: new Map(), credentials: new Map(),
    generationCount: 0, queryStatus: 'RUNNING', uploadCount: 0,
  };
  holder.state.settings.runningHubVideo = structuredClone(cloudConfig);
  holder.state.settings.videoTaskApi = { enabled: true, endpoint: 'https://other-provider.example.test/generate', apiKey: 'wrong-generic-key', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', statusEndpointTemplate: 'https://other-provider.example.test/status/{id}', authHeader: 'Authorization', authScheme: 'Bearer' };
  holder.state.project.assets.push(structuredClone(image));
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      holder.requests.push(structuredClone(request));
      if (handler) return handler(request, holder);
      return defaultRequest(request, holder);
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { holder.credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) ?? null,
    saveVideoTaskCheckpoint: async (task) => { holder.checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => holder.checkpoints.delete(taskId),
    readManagedImageDataUrl: async ({ expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum || 'AAAA'}` }),
    downloadGeneratedMedia: async (request) => {
      holder.downloads.push(request);
      return { fileName: `${request.fileName || 'film'}.mp4`, relativePath: `video/result-${holder.downloads.length}.mp4`, checksum: `saved-video-${holder.downloads.length}`,
        mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 200, managed: true, missing: false, url: 'lianhua-media://video/saved.mp4', durationSec: 8 };
    },
  };
  const options = { getState: () => holder.state, setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 10, persistState: async () => {},
  };
  return { holder, desktop, options, engine: new VideoGenerationEngine(options) };
};
interface HarnessState {
  state: AppState; requests: Request[]; downloads: GeneratedMediaDownloadRequest[];
  checkpoints: Map<string, VideoGenerationTask>; credentials: Map<string, string>;
  generationCount: number; queryStatus: string; uploadCount: number;
}
const defaultRequest = async (request: Request, holder: HarnessState): Promise<ReturnType<typeof response>> => {
  assert.ok(request.url.startsWith('https://runninghub.example.test/'), `must use separate cloud connection: ${request.url}`);
  if (request.url.endsWith('/media/upload/binary')) {
    assert.equal(request.method, 'POST');
    assert.equal(request.multipart?.files[0].fieldName, 'file');
    holder.uploadCount += 1;
    return response({ code: 0, data: { fileName: `openapi/reference-${holder.uploadCount}.png`, download_url: 'https://cdn.example.test/do-not-use-for-comfy.png' } });
  }
  if (request.url.includes('/run/')) {
    assert.equal(request.method, 'POST');
    holder.generationCount += 1;
    return response({ taskId: `201350878611073024${holder.generationCount}`, status: 'QUEUED', errorCode: '', results: null });
  }
  assert.ok(request.url.endsWith('/openapi/v2/query'));
  assert.equal(request.method, 'POST');
  const body = JSON.parse(request.body || '{}');
  assert.ok(typeof body.taskId === 'string');
  assert.deepEqual(Object.keys(body), ['taskId']);
  return response({ taskId: body.taskId, status: holder.queryStatus, errorCode: '', results: [
    { outputType: 'png', nodeId: '2', url: 'https://cdn.example.test/preview.png' },
    { outputType: 'mp4', nodeId: '328', url: `https://cdn.example.test/${body.taskId}.mp4` },
  ] });
};
const task = (holder: HarnessState, id: string): VideoGenerationTask => [holder.state.project, ...holder.state.projects]
  .flatMap((project) => project.generationTasks).find((entry) => entry.id === id) as VideoGenerationTask;
const generationRequests = (holder: HarnessState) => holder.requests.filter((request) => request.url.includes('/run/'));
const nodeValue = (request: Request, nodeId: string, fieldName: string) => (JSON.parse(request.body || '{}').nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>).find((entry) => entry.nodeId === nodeId && entry.fieldName === fieldName)?.fieldValue;

// Independent library, upload contract, exact query protocol, frozen key and
// correct project ownership while the user navigates to another project.
{
  const h = makeHarness(); const ownerId = h.holder.state.project.id;
  const taskId = await h.engine.start(draft());
  await waitFor(() => h.holder.requests.some((request) => request.url.endsWith('/query')), 'cloud task did not start querying');
  const request = generationRequests(h.holder)[0];
  assert.match(request.url, /run\/ai-app\/2084261333662810113$/u);
  assert.equal(nodeValue(request, '137', 'image'), 'openapi/reference-1.png');
  assert.equal(nodeValue(request, '138', 'value'), draft().prompt);
  assert.equal(nodeValue(request, '132', 'value'), '8', 'number task override preserves original string node type');
  assert.equal(nodeValue(request, '160', 'value'), 'false');
  assert.equal(h.holder.downloads.length, 0, 'RUNNING with preview/output URLs must not trigger download');
  const previous = h.holder.state.project;
  const other = { ...createInitialState().project, id: 'other-project', assets: [], generationTasks: [] };
  h.holder.state = { ...h.holder.state, project: other, projects: [previous, other], activeProjectId: other.id,
    settings: { ...h.holder.state.settings, runningHubVideo: { ...h.holder.state.settings.runningHubVideo!, baseUrl: 'https://new-cloud.example.test', apiKey: 'new-key-never-use-for-old-task' } },
  };
  h.holder.queryStatus = 'SUCCESS';
  await waitFor(() => Boolean(task(h.holder, taskId).resultAssetId), 'completed cloud result was not saved');
  assert.ok(h.holder.requests.every((entry) => entry.headers?.Authorization === 'Bearer independent-cloud-key'));
  assert.ok(h.holder.downloads[0].url.endsWith('.mp4'));
  assert.equal(h.holder.downloads[0].headers?.Authorization, undefined, 'provider key never goes to a different CDN origin');
  assert.equal(h.holder.state.project.assets.length, 0);
  assert.ok(h.holder.state.projects.find((project) => project.id === ownerId)?.assets.some((asset) => asset.id === task(h.holder, taskId).resultAssetId));
  assert.equal(JSON.stringify(task(h.holder, taskId)).includes('independent-cloud-key'), false);
  assert.equal(JSON.stringify([...h.holder.checkpoints.values()]).includes('independent-cloud-key'), false);
  h.engine.dispose();
}

// Two saved workflows remain independent, but default queue mode must wait
// beyond the first run acknowledgement for RunningHub's terminal status.
{
  const h = makeHarness();
  const result = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '两种云端工作流', concurrency: 1,
    items: [workflowA, workflowB].map((workflow, index) => ({ itemKey: `cloud-row-${index}`, draft: draft(workflow.id, index + 1) })),
  });
  await waitFor(() => h.holder.generationCount === 1, 'first RunningHub job did not enter the queue');
  await settle();
  assert.equal(h.holder.generationCount, 1, 'a RunningHub task ID is not completion and cannot release capacity');
  assert.equal(task(h.holder, result.taskIds[1]).videoJob?.stage, 'queued');
  assert.match(task(h.holder, result.taskIds[1]).videoJob?.message || '', /本地排队/u);
  h.holder.queryStatus = 'SUCCESS';
  await waitFor(() => h.holder.generationCount === 2, 'cloud batch did not submit both selected workflows');
  assert.equal(result.taskIds.length, 2);
  assert.match(generationRequests(h.holder)[0].url, /\/run\/ai-app\//u);
  assert.match(generationRequests(h.holder)[1].url, /\/run\/workflow\/1923539279828742146$/u);
  assert.notEqual(task(h.holder, result.taskIds[0]).requestFingerprint, task(h.holder, result.taskIds[1]).requestFingerprint);
  assert.ok(result.taskIds.every((id) => task(h.holder, id).videoJob?.snapshot.connection.backend === 'api'));
  await h.engine.cancelBatch(result.batchId); h.engine.dispose();
}

// Missing saved selections and excess images fail before the first paid POST.
for (const invalidDraft of [{ ...draft(), runningHubWorkflowId: 'deleted' }, { ...draft(), references: [...draft().references, ...draft().references] }]) {
  const h = makeHarness();
  await assert.rejects(() => h.engine.startBatch({ projectId: h.holder.state.project.id, label: '预检', items: [
    { itemKey: 'valid', draft: draft() }, { itemKey: 'invalid', draft: { ...invalidDraft, source: draft(workflowA.id, 2).source } },
  ] }), /不存在|参考图槽/u);
  assert.equal(h.holder.state.project.generationTasks.length, 0);
  assert.equal(h.holder.requests.length, 0);
  h.engine.dispose();
}

// Each segment owns its image count. Unused mapped nodes must actively clear
// even when the stored workflow contains an old uploaded image.
{
  const h = makeHarness(); h.holder.queryStatus = 'SUCCESS';
  const workflow = h.holder.state.settings.runningHubVideo!.workflows[0];
  const request = JSON.parse(workflow.requestTemplate);
  request.nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '137').fieldValue = 'None';
  for (const [index, nodeId] of ['23', '43', '49'].entries()) {
    request.nodeInfoList.push({ nodeId, fieldName: 'image', fieldValue: index === 2 ? 'old-cloud-person.png' : 'None' });
    workflow.mapping.images.push({ nodeId, inputName: 'image', role: 'general' });
  }
  workflow.requestTemplate = JSON.stringify(request);
  const assets = [image, ...[2, 3].map((index) => ({ ...image, id: `image-${index}`, checksum: `image-sha-${index}` }))];
  h.holder.state.project.assets.push(...assets.slice(1));
  const counts = [3, 2, 0];
  const result = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '逐段不同图片数量', concurrency: 1,
    items: counts.map((count, index) => ({ itemKey: `different-images-${index}`, draft: {
      ...draft(workflow.id, index + 1), references: assets.slice(0, count).map((asset) => ({ assetId: asset.id, role: 'general' as const })),
    } })),
  });
  await waitFor(() => result.taskIds.every((id) => Boolean(task(h.holder, id).resultAssetId)), 'variable-image batch did not complete');
  assert.equal(h.holder.generationCount, 3);
  assert.equal(h.holder.uploadCount, 5, 'only selected images upload; no repeated filler images');
  const posts = generationRequests(h.holder);
  assert.deepEqual(posts.map((post) => ['137', '23', '43', '49'].map((id) => nodeValue(post, id, 'image'))), [
    ['openapi/reference-1.png', 'openapi/reference-2.png', 'openapi/reference-3.png', 'None'],
    ['openapi/reference-4.png', 'openapi/reference-5.png', 'None', 'None'],
    ['None', 'None', 'None', 'None'],
  ]);
  assert.deepEqual(result.taskIds.map((id) => task(h.holder, id).videoJob!.snapshot.draft.references.length), counts);
  assert.equal(posts.some((post) => post.body?.includes('old-cloud-person.png')), false);
  h.engine.dispose();
}

// Old tasks retain their cloud request even after a workflow has been deleted;
// explicit parameter edits are rebound from frozen mapping, not ignored.
{
  const h = makeHarness(); const taskId = await h.engine.start(draft());
  h.holder.state.settings.videoExecutionMode = 'concurrent';
  h.holder.state.settings.videoExecutionConcurrency = 2;
  const frozen = structuredClone(task(h.holder, taskId).videoJob!.snapshot);
  h.holder.state.settings.runningHubVideo = { ...h.holder.state.settings.runningHubVideo!, workflows: [], activeWorkflowId: null };
  const retryId = await h.engine.start({ ...frozen.draft, name: '明确重新生成', prompt: '新的完整提示词', reuseTaskId: taskId, parameters: { duration: 9 } });
  assert.notEqual(retryId, taskId);
  assert.equal(nodeValue(generationRequests(h.holder)[1], '132', 'value'), '9');
  assert.equal(nodeValue(generationRequests(h.holder)[1], '138', 'value'), '新的完整提示词');
  assert.equal(generationRequests(h.holder)[1].headers?.Authorization, 'Bearer independent-cloud-key');
  assert.deepEqual(task(h.holder, taskId).videoJob!.snapshot, frozen);
  await assert.rejects(() => h.engine.start({ ...frozen.draft, runningHubWorkflowId: 'another-deleted', reuseTaskId: taskId }), /不存在/u);
  assert.equal(h.holder.generationCount, 2, 'changing selected library ID may not silently reuse old cloud workflow');
  h.engine.dispose();
}

// New empty-slot metadata must not hide an identical pre-upgrade paid job.
for (const status of ['RUNNING', 'SUCCESS']) {
  const h = makeHarness(); h.holder.queryStatus = status;
  const taskId = await h.engine.start(draft());
  if (status === 'SUCCESS') await waitFor(() => Boolean(task(h.holder, taskId).resultAssetId), 'legacy duplicate fixture did not complete');
  const saved = task(h.holder, taskId);
  for (const field of saved.videoJob!.snapshot.connection.api!.runningHubMappedFields!) delete field.emptyValue;
  saved.requestFingerprint = videoBatchRequestFingerprint(saved.videoJob!.snapshot.draft, h.holder.state.project.assets, saved.videoJob!.snapshot.connection);
  h.holder.checkpoints.set(taskId, structuredClone(saved));
  h.engine.dispose();
  const restored = new VideoGenerationEngine(h.options);
  const result = await restored.startBatch({ projectId: h.holder.state.project.id, label: '升级后同稿防重复', items: [{ itemKey: 'same-request', draft: draft() }] });
  assert.deepEqual(result.taskIds, []);
  assert.equal(result.skipped[0]?.taskId, taskId);
  assert.equal(result.skipped[0]?.reason, status === 'SUCCESS' ? 'succeeded' : 'in-flight');
  assert.equal(h.holder.generationCount, 1, 'upgrade alone never creates an extra paid generation request');
  restored.dispose();
}

// Explicit resume can restore a changed key only for the exact frozen cloud
// connection + workflow + original overrides; restart never reposts generation.
for (const [alterEndpoint, alterRemoteId, legacySnapshot] of [
  [false, false, false], [true, false, false], [false, false, true], [true, false, true], [false, true, true],
]) {
  const h = makeHarness(); const taskId = await h.engine.start(draft());
  if (legacySnapshot) {
    // Real pre-0.7.7 snapshots did not contain the empty-image metadata.
    const saved = task(h.holder, taskId);
    for (const field of saved.videoJob!.snapshot.connection.api!.runningHubMappedFields!) delete field.emptyValue;
    delete saved.videoJob!.snapshot.connection.api!.runningHubParameterControls;
    h.holder.checkpoints.set(taskId, structuredClone(saved));
  }
  h.engine.dispose(); h.holder.credentials.clear();
  h.holder.state.settings.runningHubVideo = { ...h.holder.state.settings.runningHubVideo!, apiKey: 'replacement-cloud-key',
    ...(alterEndpoint ? { baseUrl: 'https://unrelated-cloud.example.test' } : {}),
    ...(alterRemoteId ? { workflows: h.holder.state.settings.runningHubVideo!.workflows.map((workflow) => ({ ...workflow, remoteId: '1234567890123456788' })) } : {}),
  };
  const count = h.holder.requests.length;
  const restored = new VideoGenerationEngine(h.options);
  if (alterEndpoint || alterRemoteId) {
    await assert.rejects(() => restored.resume(taskId), /密钥|凭据|API\s*Key/iu);
    assert.equal(h.holder.requests.length, count, 'a different connection cannot lend its key or cause an anonymous RunningHub query');
  } else {
    await restored.resume(taskId);
    await waitFor(() => h.holder.requests.length > count, 'restored cloud task did not query original ID');
    const next = h.holder.requests[count];
    assert.ok(next.url.endsWith('/query'));
    assert.equal(next.headers?.Authorization, 'Bearer replacement-cloud-key');
  }
  assert.equal(h.holder.generationCount, 1);
  restored.dispose();
}

// A retry can deliberately override duration yet keep the old saved connection.
// Its next restart can recover that exact connection's key without weakening
// the scope comparison to host-only or switching to a newer workflow.
{
  const h = makeHarness(); const firstId = await h.engine.start(draft());
  h.holder.state.settings.videoExecutionMode = 'concurrent';
  h.holder.state.settings.videoExecutionConcurrency = 2;
  const retryId = await h.engine.start({ ...draft(), reuseTaskId: firstId, parameters: { duration: 9 } });
  assert.equal(nodeValue(generationRequests(h.holder)[1], '132', 'value'), '9');
  h.engine.dispose(); h.holder.credentials.clear();
  h.holder.state.settings.runningHubVideo!.apiKey = 'recovered-retry-key';
  const before = h.holder.requests.length;
  const resumed = new VideoGenerationEngine(h.options); await resumed.resume(retryId);
  await waitFor(() => h.holder.requests.length > before, 'edited retry failed to recover credentials');
  assert.equal(h.holder.requests[before].headers?.Authorization, 'Bearer recovered-retry-key');
  assert.equal(h.holder.generationCount, 2);
  resumed.dispose();
}

// Upload failures do not become charged generation requests.
{
  const h = makeHarness(async (request, holder) => request.url.endsWith('/media/upload/binary')
    ? response({ code: 401, message: 'bad upload credentials', data: { fileName: 'openapi/not-trusted.png' } })
    : defaultRequest(request, holder));
  const taskId = await h.engine.start(draft());
  assert.equal(task(h.holder, taskId).status, 'failed');
  assert.match(task(h.holder, taskId).error!, /图片上传失败/u);
  assert.equal(h.holder.generationCount, 0); h.engine.dispose();
}

// Cancelling while upload is pending also blocks the late successful callback.
{
  const gate = deferred(); let enteredUpload = false;
  const h = makeHarness(async (request, holder) => {
    if (request.url.endsWith('/media/upload/binary')) { enteredUpload = true; await gate.promise; }
    return defaultRequest(request, holder);
  });
  const starting = h.engine.start(draft());
  await waitFor(() => enteredUpload, 'no upload reached cancellation gate');
  const taskId = h.holder.state.project.generationTasks[0].id;
  await h.engine.cancel(taskId); gate.resolve(); await starting; await settle();
  assert.equal(h.holder.generationCount, 0);
  assert.equal(task(h.holder, taskId).videoJob?.trackingStopped, true);
  h.engine.dispose();
}

// v2 has no documented targeted cancel endpoint here: stop tracking honestly,
// never call global Comfy interrupt, imply refunded charges or delete others.
{
  const h = makeHarness(); const taskId = await h.engine.start(draft());
  await h.engine.cancel(taskId); await settle();
  const count = h.holder.requests.length; h.engine.reconcile(); await settle();
  assert.equal(h.holder.requests.length, count);
  assert.equal(task(h.holder, taskId).videoJob?.cancellationConfirmed, false);
  assert.match(task(h.holder, taskId).videoJob!.message!, /未确认取消服务器任务/u);
  assert.equal(h.holder.requests.some((request) => /interrupt|cancel|\/queue/u.test(request.url)), false);
  h.engine.dispose();
}

// The cloud upload participates in automatic 1→2→3 last-frame chaining.
{
  const h = makeHarness(); h.holder.queryStatus = 'SUCCESS';
  const extracts: Array<{ assetId?: string }> = [];
  h.desktop.videoWorkbenchStatus = async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'mock FFmpeg' });
  h.desktop.extractWorkbenchFrames = async (request) => {
    extracts.push(request.source); const index = extracts.length;
    return { probe: { durationSec: 8, width: 640, height: 360, fps: 25, hasAudio: true, videoCodec: 'h264' }, frames: [{
      fileName: `tail-${index}.png`, relativePath: `image/tail-${index}.png`, checksum: `tail-sha-${index}`, sizeBytes: 8, mediaType: 'image', mimeType: 'image/png',
      managed: true, missing: false, url: `lianhua-media://image/tail-${index}.png`, timeSec: 7.96, frameIndex: 199, width: 640, height: 360, role: 'last-frame',
    }] };
  };
  const input: VideoBatchStartInput = { projectId: h.holder.state.project.id, label: '云端尾帧衔接', concurrency: 1, items: [1, 2, 3].map((index) => ({
    itemKey: `board-${index}:zh`, draft: { ...draft(workflowA.id, index), references: index === 1 ? draft().references : [] },
    previousTail: index > 1 ? { predecessorItemKey: `board-${index - 1}:zh`, placement: { mode: 'append', index: 0, role: 'general' } } : undefined,
  })) };
  const result = await h.engine.startBatch(input);
  await waitFor(() => result.taskIds.every((id) => Boolean(task(h.holder, id).resultAssetId)), 'cloud tail chain did not finish');
  assert.equal(h.holder.generationCount, 3); assert.equal(h.holder.downloads.length, 3); assert.equal(extracts.length, 2);
  const uploads = h.holder.requests.filter((request) => request.multipart);
  assert.deepEqual(uploads.map((request) => request.multipart?.files[0].dataUrl), ['data:image/png;base64,reference-sha', 'data:image/png;base64,tail-sha-1', 'data:image/png;base64,tail-sha-2']);
  assert.deepEqual(generationRequests(h.holder).map((request) => nodeValue(request, '137', 'image')), ['openapi/reference-1.png', 'openapi/reference-2.png', 'openapi/reference-3.png']);
  assert.deepEqual(extracts.map((source) => source.assetId), result.taskIds.slice(0, 2).map((id) => task(h.holder, id).resultAssetId));
  const frozenApi = task(h.holder, result.taskIds[1]).videoJob!.snapshot.connection.api!;
  assert.equal(frozenApi.imageUploadUrlPath, 'data.fileName');
  assert.equal(frozenApi.provider, 'runninghub'); h.engine.dispose();
}

assert.equal(compileRunningHubVideoApi(cloudConfig, workflowA.id, { duration: 9 }).apiKey, cloudConfig.apiKey);
console.log('RunningHub engine tests passed: independent multi-workflow single/batch tasks, uploaded filenames, exact request snapshots, safe credentials, restore/retry/cancel and automatic last-frame chain');
