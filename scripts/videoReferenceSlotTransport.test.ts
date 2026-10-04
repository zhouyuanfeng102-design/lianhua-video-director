import assert from 'node:assert/strict';
import { bindComfyVideoWorkflow } from '../src/comfyuiVideo';
import { compileRunningHubVideoApi, createRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { buildVideoApiBody, defaultMiniMaxVideoApi, defaultRunningHubVideoApi } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { videoBatchRequestFingerprint } from '../src/videoBatch';
import { createInitialState, normalizeState } from '../src/storage';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { AppState, ReferenceAsset, ReferenceRole, VideoGenerationTask } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// Synthetic pixels, in-memory checkpoints and mocked requests only. No user
// project is loaded, and no network/paid generation is reachable from this file.
globalThis.fetch = async () => { throw new Error('Unexpected real network request in slot transport regression'); };
let checks = 0;
const check = (name: string, run: () => void) => { run(); checks += 1; console.log(`PASS ${name}`); };
const roles: ReferenceRole[] = ['first-frame', 'character', 'character', 'last-frame'];
const ids = ['frame-start', 'person-one', 'person-two', 'frame-end'];
const prompt = 'integrated_multimodal_description:\n[Shot 1] <Subject 1> referenced from <Picture 2>.\nAt 4 seconds, the subject turns. <d>原对白保持。</d>\noverall_soundscape: footsteps\nnon_diegetic_music: none';
const workflow: RunningHubVideoWorkflow = {
  ...createRunningHubVideoWorkflow('固定槽位传输隔离测试'), id: 'slot-workflow', remoteId: '1234567890123456789',
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: 'original prompt' },
    ...ids.map((nodeId, index) => ({ nodeId, fieldName: 'image', fieldValue: index === 0 ? '' : 'None' })),
    { nodeId: 'fixed', fieldName: 'image', fieldValue: 'untouched-fixed.png' },
  ], instanceType: 'default', usePersonalQueue: false }),
  mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }],
    images: ids.map((nodeId, index) => ({ nodeId, inputName: 'image', role: roles[index] })) },
};
const cloud: RunningHubVideoConfig = { enabled: true, baseUrl: 'https://slot-fixture.example.test', apiKey: 'fixture-only', activeWorkflowId: workflow.id, workflows: [workflow] };
const api = compileRunningHubVideoApi(cloud, workflow.id);
const draftFor = (slots: number[]): VideoGenerationDraft => ({
  name: '固定参考槽', backend: 'api', runningHubWorkflowId: workflow.id, prompt, parameters: {},
  references: slots.map((slotIndex) => ({ assetId: `asset-${slotIndex}`, role: roles[slotIndex], slotIndex })),
  referenceSlotRoles: [...roles],
});
const values = (body: Record<string, unknown>) => {
  const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
  assert.equal(nodes.find((node) => node.nodeId === 'prompt')?.fieldValue, prompt, 'H3 prompt remains byte-for-byte unchanged');
  assert.equal(nodes.find((node) => node.nodeId === 'fixed')?.fieldValue, 'untouched-fixed.png');
  return ids.map((id) => nodes.find((node) => node.nodeId === id)?.fieldValue);
};

for (const slots of [[1, 2, 3], [0, 2, 3], [0, 1, 3], [1, 3]]) check(`RunningHub binds physical slots ${slots.map((slot) => slot + 1).join(',')} without shifting`, () => {
  const draft = draftFor(slots); const before = structuredClone(draft);
  const uploads = slots.map((slot) => `openapi/slot-${slot}.png`);
  assert.deepEqual(values(buildVideoApiBody(api, draft, uploads)), ids.map((_, slot) => slots.includes(slot) ? `openapi/slot-${slot}.png` : slot === 0 ? '' : 'None'));
  assert.deepEqual(draft, before);
  assert.equal(JSON.stringify(buildVideoApiBody(api, draft, uploads)).includes('referenceSlotRoles'), false, 'picker role memory is not an API field');
});

check('legacy RunningHub image_N placeholders clear holes instead of moving other selected files', () => {
  const legacy = { ...defaultRunningHubVideoApi, runningHubAppId: workflow.remoteId, runningHubImageRoles: roles,
    requestTemplate: JSON.stringify({ nodeInfoList: [
      { nodeId: 'prompt', fieldName: 'text', fieldValue: '{{prompt}}' },
      ...ids.map((nodeId, index) => ({ nodeId, fieldName: 'image', fieldValue: `{{image_${index + 1}}}` })),
      { nodeId: 'fixed', fieldName: 'image', fieldValue: 'untouched-fixed.png' },
    ] }) };
  assert.deepEqual(values(buildVideoApiBody(legacy, draftFor([1, 3]), ['second.png', 'fourth.png'])), ['', 'second.png', '', 'fourth.png']);
});

check('generic image_N fields and dense reference metadata preserve explicit slots; MiniMax remains role-based', () => {
  const generic = { ...api, provider: 'generic' as const,
    requestTemplate: JSON.stringify({ prompt: '{{prompt}}', first: '{{image_1}}', second: '{{image_2}}', third: '{{image_3}}', fourth: '{{image_4}}', images: '{{images}}', references: '{{references}}' }) };
  const body = buildVideoApiBody(generic, draftFor([1, 3]), ['second.png', 'fourth.png']);
  assert.equal(body.first, ''); assert.equal(body.second, 'second.png'); assert.equal(body.third, ''); assert.equal(body.fourth, 'fourth.png');
  assert.deepEqual(body.images, ['second.png', 'fourth.png'], 'generic arrays contain no fake empty image URL');
  assert.deepEqual(body.references, [{ image_url: 'second.png', role: 'character', slot_index: 1 }, { image_url: 'fourth.png', role: 'last-frame', slot_index: 3 }]);
  assert.equal(body.prompt, prompt);
  const mini = buildVideoApiBody(defaultMiniMaxVideoApi, draftFor([0, 3]), ['start.png', 'end.png']);
  assert.equal(mini.first_frame_image, 'start.png'); assert.equal(mini.last_frame_image, 'end.png');
});

const comfy: ComfyVideoWorkflowPreset = {
  id: 'slot-comfy', name: '固定槽位本地工作流', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({
    'text-node': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old prompt' } },
    ...Object.fromEntries(ids.map((id) => [id, { class_type: 'LoadImage', inputs: { image: `old-${id}.png` } }])),
    output: { class_type: 'VHS_VideoCombine', inputs: { images: ['person-one', 0], format: 'video/h264-mp4', frame_rate: 24 } },
  }),
  mapping: { prompt: [{ nodeId: 'text-node', inputName: 'value' }], images: workflow.mapping.images, outputNodeId: 'output' },
};
check('ComfyUI preserves unselected nodes and binds selected uploads to their original physical nodes', () => {
  const original = comfy.workflowJson;
  const bound = bindComfyVideoWorkflow(comfy, prompt, ['second.png', 'fourth.png'], {}, draftFor([1, 3]).references);
  assert.equal(bound['text-node'].inputs.value, prompt);
  assert.deepEqual(ids.map((id) => bound[id].inputs.image), ['old-frame-start.png', 'second.png', 'old-person-two.png', 'fourth.png']);
  assert.equal(comfy.workflowJson, original);
  assert.throws(() => bindComfyVideoWorkflow(comfy, prompt, ['bad.png'], {}, [{ assetId: 'bad', role: 'character', slotIndex: 4 }]), /槽/u);
});

const assets: ReferenceAsset[] = ids.map((_, index) => ({ id: `asset-${index}`, name: `图片${index + 1}`, type: 'reference', role: 'composition', referenceRole: roles[index],
  dataUrl: `data:image/png;base64,${index === 1 ? 'QUFBQQ==' : 'QkJCQg=='}`, checksum: `checksum-${index}`, tags: [], createdAt: 1, updatedAt: 1 }));
check('request fingerprints preserve legacy dense identity but distinguish a changed physical slot', () => {
  const explicit = draftFor([0, 1]);
  const legacy = { ...explicit, references: explicit.references.map(({ assetId, role }) => ({ assetId, role })) };
  const connection = { backend: 'api', api: { provider: 'generic' } };
  const fingerprint = videoBatchRequestFingerprint(legacy, assets, connection);
  assert.equal(videoBatchRequestFingerprint(explicit, assets, connection), fingerprint);
  assert.notEqual(videoBatchRequestFingerprint({ ...explicit, references: explicit.references.map((reference) => ({ ...reference, slotIndex: reference.slotIndex! + 1 })) }, assets, connection), fingerprint);
});

type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 300; attempt += 1) { if (predicate()) return; await tick(); }
  assert.fail('mock slot transport did not finish');
};
const harness = (mode: 'inline' | 'remote' | 'browser' = 'inline') => {
  const holder = { state: createInitialState(), posts: [] as Request[], uploads: [] as Request[], remoteReads: 0,
    files: new Map<string, string>(), journal: new Map<string, VideoGenerationTask>(), credentials: new Map<string, string>() };
  holder.state.settings.runningHubVideo = structuredClone(cloud);
  holder.state.project.assets = assets.map((asset) => mode === 'remote' ? { ...asset, dataUrl: undefined, checksum: undefined, url: `https://pixels.example.test/${asset.id}.png` } : { ...asset, checksum: undefined });
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      if (request.url.startsWith('https://pixels.example.test/')) {
        holder.remoteReads += 1;
        return { status: 200, body: request.url.includes('asset-1') ? 'QUFBQQ==' : 'QkJCQg==', bodyEncoding: 'base64', contentType: 'image/png' };
      }
      assert.ok(request.url.startsWith('https://slot-fixture.example.test/'), 'all requests use the synthetic snapshot connection');
      if (request.url.endsWith('/media/upload/binary')) {
        holder.uploads.push(request);
        const value = request.multipart!.files[0].dataUrl.endsWith('QUFBQQ==') ? 'second.png' : 'fourth.png';
        return response({ code: 0, data: { fileName: `openapi/${value}` } });
      }
      if (request.url.includes('/run/')) {
        holder.posts.push(request);
        return response({ taskId: `mock-slot-${holder.posts.length}`, status: 'FAILED', errorCode: 'FIXTURE', errorMessage: 'Synthetic terminal result; no generation occurred.' });
      }
      throw new Error(`Unexpected mocked endpoint ${request.url}`);
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { holder.credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task) => { holder.journal.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.journal.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => holder.journal.delete(taskId),
    storeGeneratedImage: mode === 'browser' ? undefined : async ({ dataUrl, fileName }) => {
      const key = dataUrl.endsWith('QUFBQQ==') ? 'second' : 'fourth'; const relativePath = `image/${key}.png`;
      holder.files.set(relativePath, dataUrl);
      return { relativePath, checksum: `frozen-${key}`, fileName: fileName || `${key}.png`, mediaType: 'image', sizeBytes: 4, managed: true, missing: false, url: `lianhua-asset://local/${relativePath}` };
    },
    readManagedImageDataUrl: async ({ relativePath }) => {
      const dataUrl = holder.files.get(relativePath); assert.ok(dataUrl, 'retry must read the frozen pixels, not current assets'); return { dataUrl };
    },
    downloadGeneratedMedia: async () => { throw new Error('Synthetic failed tasks have no downloadable result'); },
  };
  const options = { getState: () => holder.state, setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); }, desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 5 };
  return { holder, options, engine: new VideoGenerationEngine(options) };
};
const taskById = (state: AppState, id: string) => state.project.generationTasks.find((task) => task.id === id) as VideoGenerationTask;

for (const mode of ['inline', 'remote', 'browser'] as const) {
  const h = harness(mode);
  try {
    const taskId = await h.engine.start(draftFor([1, 3]));
    const first = taskById(h.holder.state, taskId);
    assert.equal(h.holder.posts.length, 1);
    assert.deepEqual(values(JSON.parse(h.holder.posts[0].body!)), ['', 'openapi/second.png', 'None', 'openapi/fourth.png']);
    assert.deepEqual(first.videoJob!.snapshot.draft.references.map((reference) => reference.slotIndex), [1, 3]);
    assert.deepEqual(first.videoJob!.snapshot.images.map((image) => image.slotIndex), [1, 3]);
    assert.deepEqual(first.videoJob!.preparation!.uploadedImages, ['openapi/second.png', 'openapi/fourth.png'], 'upload checkpoint is dense, not a sparse slot array');
    assert.ok(first.videoJob!.snapshot.images.every((image) => image.freezeState === 'frozen'));
    assert.deepEqual(h.holder.journal.get(taskId)!.videoJob!.snapshot.images.map((image) => image.slotIndex), [1, 3]);
    h.engine.dispose();
    h.holder.state = normalizeState(JSON.parse(JSON.stringify(h.holder.state)));
    h.holder.state.project.assets = [];
    h.holder.state.projects = [h.holder.state.project];
    const restored = taskById(h.holder.state, taskId);
    assert.deepEqual(restored.videoJob!.snapshot.draft.referenceSlotRoles, roles);
    const retry = new VideoGenerationEngine(h.options);
    try {
      const secondId = await retry.start({ ...restored.videoJob!.snapshot.draft, reuseTaskId: taskId });
      assert.equal(h.holder.posts.length, 2);
      assert.deepEqual(values(JSON.parse(h.holder.posts[1].body!)), ['', 'openapi/second.png', 'None', 'openapi/fourth.png']);
      assert.deepEqual(taskById(h.holder.state, secondId).videoJob!.snapshot.images.map((image) => image.slotIndex), [1, 3]);
      assert.equal(h.holder.remoteReads, mode === 'remote' ? 2 : 0, 'retry cannot reread mutable remote image sources');
    } finally { retry.dispose(); }
    checks += 1; console.log(`PASS ${mode} engine freeze, checkpoint, JSON restore and explicit retry preserve physical slots`);
  } finally { h.engine.dispose(); }
}

{
  const h = harness();
  h.holder.state.settings.comfyuiVideo = { enabled: true, baseUrl: 'https://comfy-slot.example.test', apiKey: '', workflows: [comfy], activeWorkflowId: comfy.id };
  h.options.desktop.videoRequest = async (request) => {
    assert.ok(request.url.startsWith('https://comfy-slot.example.test/'));
    if (request.url.endsWith('/upload/image')) return response({ name: request.multipart!.files[0].dataUrl.endsWith('QUFBQQ==') ? 'second.png' : 'fourth.png' });
    if (request.url.endsWith('/prompt')) { h.holder.posts.push(request); return response({ prompt_id: 'comfy-slots-task' }); }
    return response({ queue_pending: [], queue_running: [] });
  };
  try {
    const taskId = await h.engine.start({ ...draftFor([1, 3]), backend: 'comfyui', workflowId: comfy.id, runningHubWorkflowId: undefined });
    assert.equal(h.holder.posts.length, 1);
    const body = JSON.parse(h.holder.posts[0].body!);
    assert.deepEqual(ids.map((id) => body.prompt[id].inputs.image), ['old-frame-start.png', 'second.png', 'old-person-two.png', 'fourth.png']);
    assert.equal(body.prompt['text-node'].inputs.value, prompt);
    assert.deepEqual(taskById(h.holder.state, taskId).videoJob!.snapshot.images.map((image) => image.slotIndex), [1, 3]);
    checks += 1; console.log('PASS ComfyUI engine preflight, uploads and final /prompt keep noncontinuous node bindings');
  } finally { h.engine.dispose(); }
}

{
  const h = harness();
  try {
    const secondRoles: ReferenceRole[] = ['scene', 'subject', 'general', 'prop'];
    const batch = await h.engine.startBatch({ projectId: h.holder.state.project.id, label: '固定槽批量隔离测试', items: [
      { itemKey: 'slot-a', draft: draftFor([1, 3]) },
      { itemKey: 'slot-b', draft: { ...draftFor([1, 3]), prompt: `${prompt}\nsecond fixture`, name: '第二段固定槽', referenceSlotRoles: secondRoles } },
    ] });
    await waitFor(() => h.holder.posts.length === 2);
    assert.equal(batch.taskIds.length, 2);
    for (const [index, taskId] of batch.taskIds.entries()) {
      const task = taskById(h.holder.state, taskId);
      assert.deepEqual(task.videoJob!.snapshot.images.map((image) => image.slotIndex), [1, 3]);
      assert.deepEqual(task.videoJob!.snapshot.draft.referenceSlotRoles, index === 0 ? roles : secondRoles, 'each segment keeps its own slot-purpose choices');
      assert.deepEqual(task.videoJob!.snapshot.draft.references.map((reference) => reference.role), index === 0 ? ['character', 'last-frame'] : ['subject', 'prop'], 'segment purposes override the shared workflow mapping without changing physical slots');
    }
    for (const post of h.holder.posts) {
      const nodes = JSON.parse(post.body!).nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
      assert.deepEqual(ids.map((id) => nodes.find((node) => node.nodeId === id)?.fieldValue), ['', 'openapi/second.png', 'None', 'openapi/fourth.png']);
    }
    checks += 1; console.log('PASS batch preflight and inline snapshots preserve holes through actual nodeInfoList construction');
  } finally { h.engine.dispose(); }
}

console.log(`Stable video slot transport passed: ${checks} checks; zero real API calls.`);
