import assert from 'node:assert/strict';
import { importRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
type Node = { nodeId: string; fieldName: string; fieldValue: unknown; description?: null; fieldData?: string };
const imageNodes = ['28', '273', '285', '436', '462', '463'];
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean, reason: string) => {
  for (let count = 0; count < 300; count += 1) { if (predicate()) return; await tick(); }
  assert.fail(reason);
};

// Structure and string-valued parameters match the user's 2026-10-10 API
// example for app 2103012816681041921. Personal prompt/file values are fixtures.
const inputNodes: Node[] = [
  ...imageNodes.map((nodeId, index) => ({ nodeId, fieldName: 'image', fieldValue: index ? 'example.png' : 'original-example.jpg', description: null })),
  { nodeId: '426', fieldName: 'aspect_ratio', fieldValue: '16:9 (Widescreen)', fieldData: '["COMBO", {"options": ["1:1 (Square)", "16:9 (Widescreen)"]}]', description: null },
  { nodeId: '426', fieldName: 'megapixels', fieldValue: '0.5', description: null },
  { nodeId: '291', fieldName: 'value', fieldValue: '35', description: null },
  { nodeId: '393', fieldName: 'value', fieldValue: 'false', description: null },
  { nodeId: '59', fieldName: 'prompt', fieldValue: 'Fixture video prompt.', description: null },
  { nodeId: '446', fieldName: 'lora_name', fieldValue: 'MysticXXX-ref2va-V4.safetensors', description: null },
  { nodeId: '446', fieldName: 'strength_model', fieldValue: '0.4000000000000001', description: null },
  { nodeId: '444', fieldName: 'lora_name', fieldValue: 'HMNSFW-AIO-V2.5.safetensors', description: null },
  { nodeId: '444', fieldName: 'strength_model', fieldValue: '0.5000000000000001', description: null },
  { nodeId: '443', fieldName: 'lora_name', fieldValue: 'H3_Motion_BoosterV2.safetensors', description: null },
  { nodeId: '443', fieldName: 'strength_model', fieldValue: '0.6000000000000001', description: null },
  { nodeId: '442', fieldName: 'text', fieldValue: 'dynv2,', description: null },
  { nodeId: '272', fieldName: 'value', fieldValue: 'false', description: null },
];

const makeHarness = (slots: number[]) => {
  const imported = importRunningHubVideoWorkflow(JSON.stringify({
    endpoint: 'https://runninghub.example.test/openapi/v2/run/ai-app/2103012816681041921',
    nodeInfoList: inputNodes, instanceType: 'default', usePersonalQueue: false,
  }), '小白全能版测试工作流').workflow;
  imported.id = 'xiaobai-fixture';
  imported.mapping = { prompt: [{ nodeId: '59', inputName: 'prompt' }], images: imageNodes.map((nodeId) => ({ nodeId, inputName: 'image', role: 'general' })) };
  const assets: ReferenceAsset[] = slots.map((slot) => ({
    id: `reference-${slot}`, name: `原始图片槽 ${slot + 1}`, type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
    relativePath: `image/original-${slot}.png`, checksum: `original-sha-${slot}`, fileName: `original-${slot}.png`, mediaType: 'image', managed: true,
  }));
  const holder = { state: createInitialState(), requests: [] as Request[], checkpoints: new Map<string, VideoGenerationTask>(),
    credentials: new Map<string, string>(), reads: [] as Array<{ relativePath: string; checksum: string }>, runCount: 0, queryStatus: 'FAILED',
  };
  holder.state.settings.runningHubVideo = { enabled: true, baseUrl: 'https://runninghub.example.test', apiKey: 'fixture-cloud-key', activeWorkflowId: imported.id, workflows: [imported] };
  holder.state.settings.videoExecutionMode = 'concurrent';
  holder.state.settings.videoExecutionConcurrency = 3;
  holder.state.project.assets = structuredClone(assets);
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      holder.requests.push(structuredClone(request));
      assert.ok(request.url.startsWith('https://runninghub.example.test/'), 'test transport accepts only the mock origin');
      if (request.url.endsWith('/media/upload/binary')) {
        assert.equal(request.multipart?.files.length, 1);
        const bytes = Buffer.from(request.multipart!.files[0].dataUrl!.split(',')[1], 'base64').toString();
        const slot = Number(/^original-sha-(\d+)$/u.exec(bytes)?.[1]);
        assert.ok(slots.includes(slot), 'uploads must contain original frozen reference bytes');
        return response({ code: 0, data: { fileName: `openapi/original-slot-${slot + 1}.png` } });
      }
      if (request.url.includes('/run/')) {
        holder.runCount += 1;
        return response({ taskId: `20135087861107302${holder.runCount.toString().padStart(2, '0')}`, status: 'QUEUED', results: null });
      }
      assert.ok(request.url.endsWith('/openapi/v2/query'));
      const { taskId } = JSON.parse(request.body || '{}');
      return response({ taskId, status: holder.queryStatus, results: null, ...(holder.queryStatus === 'FAILED' ? {
        errorCode: '805', errorMessage: '工作流运行失败', failedReason: { node_id: '465', node_name: 'ImageBatchMulti', exception_message: "'NoneType' object has no attribute 'shape'" },
      } : {}) });
    },
    cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { holder.credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task) => { holder.checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => holder.checkpoints.delete(taskId),
    storeGeneratedImage: async ({ dataUrl }) => {
      const checksum = Buffer.from(dataUrl.split(',')[1], 'base64').toString();
      const original = assets.find((asset) => asset.checksum === checksum);
      assert.ok(original, 'managed snapshots store the original bytes');
      return { fileName: original.fileName!, relativePath: original.relativePath!, checksum, sizeBytes: 100,
        mediaType: 'image', managed: true, missing: false, url: `lianhua-media://${original.relativePath}` };
    },
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      holder.reads.push({ relativePath, checksum: expectedChecksum || '' });
      assert.ok(assets.some((asset) => asset.relativePath === relativePath && asset.checksum === expectedChecksum), 'never read an edited current-project asset');
      return { dataUrl: `data:image/png;base64,${Buffer.from(expectedChecksum!).toString('base64')}` };
    },
  };
  const options = { getState: () => holder.state, setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 10,
  };
  const draft: VideoGenerationDraft = { name: '旧失败任务', prompt: 'Fixture video prompt.', backend: 'api', runningHubWorkflowId: imported.id,
    references: assets.map((asset, index) => ({ assetId: asset.id, role: 'general', slotIndex: slots[index] })), parameters: {},
  };
  const findTask = (taskId: string) => holder.state.project.generationTasks.find((task) => task.id === taskId) as VideoGenerationTask;
  const makeLegacyFailedTask = async () => {
    const initialEngine = new VideoGenerationEngine(options);
    const taskId = await initialEngine.start(draft);
    await waitFor(() => findTask(taskId)?.status === 'failed', 'failure fixture did not reach its terminal state');
    initialEngine.dispose();
    const saved = findTask(taskId);
    for (const field of saved.videoJob!.snapshot.connection.api!.runningHubMappedFields!) if (field.kind === 'image') field.emptyValue = '';
    holder.checkpoints.set(taskId, structuredClone(saved));
    holder.requests.length = 0;
    holder.reads.length = 0;
    return saved;
  };
  return { holder, options, findTask, makeLegacyFailedTask };
};

for (const slots of [[0], [0, 2]]) {
  const h = makeHarness(slots);
  const failed = await h.makeLegacyFailedTask();
  const originalSnapshot = structuredClone(failed.videoJob!.snapshot);
  const originalRemoteId = failed.remoteTaskId;
  const oldRunCount = h.holder.runCount;
  // Reusing a frozen failed task must still work after deletion/editing of its
  // current-library references and saved workflow.
  h.holder.state.project.assets = [];
  h.holder.state.settings.runningHubVideo!.workflows = [];
  h.holder.state.settings.runningHubVideo!.activeWorkflowId = null;
  h.holder.queryStatus = 'RUNNING';
  const engine = new VideoGenerationEngine(h.options);
  try {
    const retryId = await engine.start({ ...structuredClone(originalSnapshot.draft), name: '明确重新生成', reuseTaskId: failed.id });
    assert.notEqual(retryId, failed.id);
    assert.equal(h.holder.runCount, oldRunCount + 1, 'an explicit retry creates exactly one new generation request');
    const uploads = h.holder.requests.filter((request) => request.url.endsWith('/media/upload/binary'));
    assert.equal(uploads.length, slots.length, 'only real selected images upload; no placeholder/filler image upload');
    const post = h.holder.requests.find((request) => request.url.includes('/run/'))!;
    assert.match(post.url, /\/ai-app\/2103012816681041921$/u);
    const body = JSON.parse(post.body || '{}');
    const nodes: Node[] = body.nodeInfoList;
    for (const [index, nodeId] of imageNodes.entries()) {
      assert.equal(nodes.find((node) => node.nodeId === nodeId && node.fieldName === 'image')?.fieldValue,
        slots.includes(index) ? `openapi/original-slot-${index + 1}.png` : 'example.png', `physical slot ${index + 1} is not compacted or duplicated`);
    }
    assert.deepEqual(nodes.filter((node) => node.fieldName !== 'image'), inputNodes.filter((node) => node.fieldName !== 'image'), 'all unrelated parameters, field metadata, string precision and prompt remain exact');
    assert.equal(body.instanceType, 'default');
    assert.equal(body.usePersonalQueue, false);
    assert.deepEqual(h.findTask(failed.id).videoJob!.snapshot, originalSnapshot, 'retry never overwrites the historical frozen request');
    assert.equal(h.findTask(failed.id).remoteTaskId, originalRemoteId, 'retry preserves the failed remote ID');
    assert.deepEqual(h.findTask(retryId).videoJob!.snapshot.images.map(({ slotIndex, checksum }) => ({ slotIndex, checksum })),
      slots.map((slotIndex) => ({ slotIndex, checksum: `original-sha-${slotIndex}` })), 'the new task preserves physical slots and frozen image identity');
  } finally { engine.dispose(); }
}

{
  const h = makeHarness([0]);
  const failed = await h.makeLegacyFailedTask();
  const originalSnapshot = structuredClone(failed.videoJob!.snapshot);
  const originalRemoteId = failed.remoteTaskId;
  const oldRunCount = h.holder.runCount;
  h.holder.queryStatus = 'RUNNING';
  const engine = new VideoGenerationEngine(h.options);
  try {
    await engine.resume(failed.id);
    await waitFor(() => h.holder.requests.length > 0, 'resume did not query the existing remote task');
    assert.ok(h.holder.requests.every((request) => request.url.endsWith('/openapi/v2/query')), 'resuming an existing remote ID never uploads or generates again');
    assert.ok(h.holder.requests.every((request) => JSON.parse(request.body || '{}').taskId === originalRemoteId));
    assert.equal(h.holder.runCount, oldRunCount);
    assert.deepEqual(h.findTask(failed.id).videoJob!.snapshot, originalSnapshot, 'query-only resume retains legacy empty-slot metadata');
    assert.equal(h.findTask(failed.id).remoteTaskId, originalRemoteId);
  } finally { engine.dispose(); }
}

console.log('RunningHub 小白 ImageBatchMulti retry: 3 focused mock-engine scenarios passed; no network or paid cloud calls.');
