import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { createRunningHubTutorialVideoWorkflow } from '../src/runningHubVideo';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// All credentials, images, requests and journals in this suite are synthetic.
// Tests exercise public engine actions and never contact a provider.
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const authError = /密钥|凭据|API\s*Key/iu;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (condition: () => boolean, reason: string | (() => string)) => {
  for (let count = 0; count < 800; count += 1) { if (condition()) return; await tick(); }
  assert.fail(typeof reason === 'string' ? reason : reason());
};
const workflow: RunningHubVideoWorkflow = { ...createRunningHubTutorialVideoWorkflow(), id: 'credential-cloud', name: '凭据回归工作流', outputNodeId: '328' };
const config: RunningHubVideoConfig = { enabled: true, baseUrl: 'https://runninghub-credential.example.test', apiKey: 'synthetic-original-key', workflows: [workflow], activeWorkflowId: workflow.id };
const image: ReferenceAsset = { id: 'credential-reference', name: '合成参考图', type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
  relativePath: 'image/credential-reference.png', checksum: 'synthetic-image-checksum', fileName: 'credential-reference.png', mediaType: 'image', managed: true };
const draft = (): VideoGenerationDraft => ({ name: '凭据回归视频', backend: 'api', runningHubWorkflowId: workflow.id,
  prompt: 'A quiet landscape with mountains and soft daylight.', references: [{ assetId: image.id, role: 'general' }], parameters: { duration: 8 },
});
const makeHarness = () => {
  const holder = { state: createInitialState(), requests: [] as Request[], credentials: new Map<string, string>(),
    checkpoints: new Map<string, VideoGenerationTask>(), failUpload: true, generationCount: 0, uploadCount: 0,
    queryStatus: 'RUNNING', downloadCount: 0, uploadFailureMessage: 'HEADER_API_KEY_NOT_FOUND', aiSelectionCount: 0,
  };
  holder.state.settings.runningHubVideo = structuredClone(config);
  holder.state.settings.videoTaskApi = { enabled: true, endpoint: 'https://unrelated-provider.example.test/generate', apiKey: 'synthetic-unrelated-key',
    taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', statusEndpointTemplate: 'https://unrelated-provider.example.test/status/{id}', authHeader: 'Authorization', authScheme: 'Bearer' };
  holder.state.project.assets.push(structuredClone(image));
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      holder.requests.push(structuredClone(request));
      assert.ok(request.url.startsWith(config.baseUrl + '/'), 'a frozen task must keep its original endpoint');
      if (request.url.endsWith('/media/upload/binary')) {
        holder.uploadCount += 1;
        return holder.failUpload ? response({ code: 1602, message: holder.uploadFailureMessage })
          : response({ code: 0, data: { fileName: 'openapi/credential-reference.png' } });
      }
      if (request.url.includes('/run/')) {
        holder.generationCount += 1;
        return response({ taskId: `synthetic-remote-${holder.generationCount}`, status: 'QUEUED', results: null });
      }
      assert.ok(request.url.endsWith('/query'));
      return response({ taskId: JSON.parse(request.body || '{}').taskId, status: holder.queryStatus,
        results: holder.queryStatus === 'SUCCESS' ? [{ outputType: 'mp4', nodeId: '328', url: 'https://cdn.example.test/synthetic-result.mp4' }] : null });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { if (apiKey) holder.credentials.set(taskId, apiKey); else holder.credentials.delete(taskId); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) ?? null,
    saveVideoTaskCheckpoint: async (task) => { holder.checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => holder.checkpoints.delete(taskId),
    readManagedImageDataUrl: async () => ({ dataUrl: png }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'synthetic workbench' }),
    extractWorkbenchFrames: async () => { throw new Error('Static reference fixtures must not extract video frames'); },
    downloadGeneratedMedia: async () => {
      assert.equal(holder.queryStatus, 'SUCCESS', 'a RUNNING fixture must not download media');
      holder.downloadCount += 1;
      return { fileName: `credential-result-${holder.downloadCount}.mp4`, relativePath: `video/credential-result-${holder.downloadCount}.mp4`,
        checksum: `synthetic-video-${holder.downloadCount}`, mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 200, managed: true, missing: false,
        url: `lianhua-media://video/credential-result-${holder.downloadCount}.mp4`, durationSec: 8 };
    },
  };
  const options = { getState: () => holder.state, setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 1000, persistState: async () => {},
    selectTailFrame: async () => { holder.aiSelectionCount += 1; throw new Error('synthetic AI preparation blocked before producing a frame'); },
  };
  const harness = { holder, engine: new VideoGenerationEngine(options),
    restart(dropCredentials = true) {
      harness.engine.dispose();
      if (dropCredentials) holder.credentials.clear();
      holder.requests.length = 0;
      harness.engine = new VideoGenerationEngine(options);
    },
  };
  return harness;
};
type Harness = ReturnType<typeof makeHarness>;
const task = (h: Harness, id: string) => h.holder.state.project.generationTasks.find((entry) => entry.id === id) as VideoGenerationTask;
const failedTask = async (h: Harness) => {
  const id = await h.engine.start(draft());
  assert.equal(task(h, id).status, 'failed');
  assert.ok(task(h, id).error?.includes(h.holder.uploadFailureMessage));
  assert.equal(h.holder.generationCount, 0);
  return id;
};
const assertAuthenticated = (h: Harness, key: string) => {
  assert.ok(h.holder.requests.length > 0);
  assert.ok(h.holder.requests.every((request) => request.headers?.Authorization === `Bearer ${key}`));
};
let passed = 0;
const test = async (label: string, run: (h: Harness) => Promise<void>) => {
  const h = makeHarness();
  try { await run(h); passed += 1; console.log(`PASS ${label}`); }
  finally { h.engine.dispose(); }
};

await test('missing frozen credential resumes the same pre-POST task exactly once', async (h) => {
  const id = await failedTask(h);
  const original = structuredClone(task(h, id).videoJob!.snapshot);
  h.restart(); h.holder.failUpload = false;
  h.holder.state.settings.runningHubVideo!.apiKey = 'synthetic-recovered-key';
  await h.engine.resume(id);
  await waitFor(() => Boolean(task(h, id).remoteTaskId), 'original task did not submit after exact credential recovery');
  assert.equal(h.holder.state.project.generationTasks.length, 1);
  assert.equal(task(h, id).id, id);
  assert.equal(h.holder.generationCount, 1);
  assert.deepEqual(task(h, id).videoJob!.snapshot.connection, original.connection);
  assert.deepEqual(task(h, id).videoJob!.snapshot.draft, original.draft);
  assertAuthenticated(h, 'synthetic-recovered-key');
  await h.engine.resume(id);
  await waitFor(() => h.holder.requests.some((request) => request.url.endsWith('/query')), 'resumed submitted task did not query its original remote ID');
  assert.equal(h.holder.generationCount, 1, 'a repeated resume must never send a second generation POST');
});

await test('continued batch recovers its inherited missing credential before upload', async (h) => {
  const first = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '凭据测试批次', items: [{ itemKey: 'one', draft: draft() }] });
  await waitFor(() => task(h, first.taskIds[0]).status === 'failed', 'initial batch did not reach mocked upload failure');
  h.restart(); h.holder.failUpload = false;
  h.holder.state.settings.runningHubVideo!.apiKey = 'synthetic-continuation-key';
  const summary = await h.engine.resumeBatch(first.batchId);
  assert.equal(h.holder.requests.length, 0, 'opening the continuation summary must not submit anything');
  assert.ok(summary.continuation);
  const next = await h.engine.confirmContinueBatch(summary.continuation.id);
  await waitFor(() => h.holder.generationCount === 1, () => `continued batch did not authenticate and submit: ${task(h, next.taskIds[0]).error || task(h, next.taskIds[0]).videoJob?.message}`);
  assert.equal(next.taskIds.length, 1);
  assert.notEqual(next.taskIds[0], first.taskIds[0]);
  assert.equal(task(h, next.taskIds[0]).videoJob!.snapshot.continuedFrom?.taskId, first.taskIds[0]);
  assert.equal(task(h, first.taskIds[0]).status, 'failed', 'the original record must remain intact');
  assertAuthenticated(h, 'synthetic-continuation-key');
  await h.engine.resume(next.taskIds[0]);
  assert.equal(h.holder.generationCount, 1);
});

await test('resuming the original first segment also recovers the queued second segment without replacing either task', async (h) => {
  const first = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '两段顺序恢复', completionOrder: true,
    items: [{ itemKey: 'first', draft: { ...draft(), source: { sequencePlanId: 'synthetic-credential-plan', segmentId: 'first', segmentIndex: 1, language: 'zh', label: '第一段' } } },
      { itemKey: 'second', draft: { ...draft(), name: '凭据回归第二段', prompt: 'A calm lake in soft daylight.', source: { sequencePlanId: 'synthetic-credential-plan', segmentId: 'second', segmentIndex: 2, language: 'zh', label: '第二段' } } }],
  });
  const [firstId, secondId] = first.taskIds;
  await waitFor(() => task(h, firstId).status === 'failed', 'the first segment did not reach upload failure');
  assert.equal(h.holder.generationCount, 0);
  assert.equal(task(h, secondId).remoteTaskId, undefined);
  h.restart(); h.holder.failUpload = false; h.holder.queryStatus = 'SUCCESS';
  h.holder.state.settings.runningHubVideo!.apiKey = 'synthetic-recovered-chain-key';
  await h.engine.resume(firstId);
  await waitFor(() => Boolean(task(h, secondId).resultAssetId), () => `the queued second segment did not recover credentials: first=${task(h, firstId).error || task(h, firstId).videoJob?.message}; second=${task(h, secondId).error || task(h, secondId).videoJob?.message}`);
  assert.deepEqual(h.holder.state.project.generationTasks.map((item) => item.id).sort(), [...first.taskIds].sort());
  assert.ok(task(h, firstId).resultAssetId);
  assert.equal(h.holder.generationCount, 2);
  assert.equal(h.holder.downloadCount, 2);
  assertAuthenticated(h, 'synthetic-recovered-chain-key');
  await h.engine.resume(firstId); await h.engine.resume(secondId);
  assert.equal(h.holder.generationCount, 2, 'completed segments must not be submitted again');
});

await test('continuation with no key preserves the original chain before AI preparation or child creation', async (h) => {
  h.holder.failUpload = false; h.holder.queryStatus = 'SUCCESS';
  const first = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '先校验密钥再AI续接',
    items: [{ itemKey: 'first', draft: { ...draft(), source: { sequencePlanId: 'credential-ai-plan', segmentId: 'first', segmentIndex: 1, language: 'zh', label: '第一段' } } },
      { itemKey: 'second', draft: { ...draft(), references: [], name: 'AI尾帧第二段', prompt: 'A calm lake in soft daylight.', source: { sequencePlanId: 'credential-ai-plan', segmentId: 'second', segmentIndex: 2, language: 'zh', label: '第二段' } },
        previousTail: { predecessorItemKey: 'first', placement: { mode: 'append', index: 0, role: 'general' }, selectionMode: 'ai-assisted', requireAiSelection: true } }],
  });
  const [firstId, secondId] = first.taskIds;
  await waitFor(() => task(h, secondId).videoJob?.tailPreparation?.phase === 'blocked', 'AI chain did not reach its synthetic preparation failure');
  assert.ok(task(h, firstId).resultAssetId);
  const before = structuredClone(task(h, secondId));
  const aiCalls = h.holder.aiSelectionCount;
  h.restart(); h.holder.state.settings.runningHubVideo!.apiKey = '';
  const summary = await h.engine.resumeBatch(first.batchId);
  assert.ok(summary.continuation);
  assert.equal(summary.continuation.requiresAiTail, true, 'the fixture must actually need paid AI preparation');
  await assert.rejects(() => h.engine.confirmContinueBatch(summary.continuation!.id), authError);
  assert.equal(h.holder.requests.length, 0);
  assert.equal(h.holder.aiSelectionCount, aiCalls, 'a missing credential must be rejected before another AI selection');
  assert.equal(h.holder.generationCount, 1, 'only the already completed original first segment was submitted');
  assert.deepEqual(h.holder.state.project.generationTasks.map((item) => item.id).sort(), [...first.taskIds].sort());
  assert.equal(task(h, secondId).status, before.status);
  assert.equal(task(h, secondId).videoJob?.batchQueueState, before.videoJob?.batchQueueState);
  assert.equal(task(h, secondId).videoJob?.tailPreparation?.phase, before.videoJob?.tailPreparation?.phase);
  assert.equal(task(h, secondId).videoJob?.batchContinuation?.released, true, 'failed recovery must release the temporary continuation claim');
});

for (const value of ['', '   ']) {
  await test(`new task and batch reject ${value ? 'whitespace' : 'empty'} RunningHub credentials before any request`, async (h) => {
    h.holder.state.settings.runningHubVideo!.apiKey = value;
    await assert.rejects(() => h.engine.start(draft()), authError);
    await assert.rejects(() => h.engine.startBatch({ projectId: h.holder.state.project.id, label: '缺密钥批次', items: [{ itemKey: 'one', draft: draft() }] }), authError);
    assert.equal(h.holder.requests.length, 0);
    assert.equal(h.holder.state.project.generationTasks.length, 0);
  });
}

await test('restored task with no matching credential stops before upload', async (h) => {
  const id = await failedTask(h);
  h.restart(); h.holder.failUpload = false;
  h.holder.state.settings.runningHubVideo!.apiKey = '';
  await assert.rejects(() => h.engine.resume(id), authError);
  assert.equal(h.holder.requests.length, 0);
  assert.equal(h.holder.generationCount, 0);
  assert.equal(task(h, id).remoteTaskId, undefined);
});

for (const mismatch of ['host', 'workflow'] as const) {
  await test(`${mismatch} mismatch cannot lend its key to an old task or its continued batch`, async (h) => {
    const id = await failedTask(h);
    h.restart(); h.holder.failUpload = false;
    const current = h.holder.state.settings.runningHubVideo!;
    current.apiKey = 'synthetic-must-not-cross-scope';
    if (mismatch === 'host') current.baseUrl = 'https://other-runninghub.example.test';
    else current.workflows = current.workflows.map((item) => ({ ...item, remoteId: '1234567890123456788' }));
    await assert.rejects(() => h.engine.resume(id), authError);
    await assert.rejects(() => h.engine.startBatch({ projectId: h.holder.state.project.id, label: '不同连接禁止借用', items: [{ itemKey: 'one', draft: { ...draft(), reuseTaskId: id } }] }), authError);
    assert.equal(h.holder.requests.length, 0);
    assert.equal(h.holder.state.project.generationTasks.length, 1);
    assert.equal(h.holder.generationCount, 0);
  });
}

await test('valid frozen credential is preserved when current settings contain a different key', async (h) => {
  // A non-authentication failure keeps the saved key authoritative; explicit
  // recovery after an authentication rejection is allowed to refresh it.
  h.holder.uploadFailureMessage = 'synthetic temporary file service failure';
  const id = await failedTask(h);
  h.restart(false); h.holder.failUpload = false;
  h.holder.state.settings.runningHubVideo!.apiKey = 'synthetic-new-config-key';
  await h.engine.resume(id);
  await waitFor(() => h.holder.generationCount === 1, 'task with existing frozen credential did not resume');
  assertAuthenticated(h, config.apiKey);
  assert.ok(!Array.from(h.holder.credentials.values()).includes('synthetic-new-config-key'));
});

console.log(`RunningHub credential recovery: ${passed} regression cases passed.`);
