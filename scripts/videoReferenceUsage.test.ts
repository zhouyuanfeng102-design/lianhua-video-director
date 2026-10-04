import assert from 'node:assert/strict';
import { offsetVideoReferenceSlotRoles, videoReferenceSlotLabels, videoReferenceUsage } from '../src/videoReferenceUsage';
import { buildVideoApiBody, defaultRunningHubVideoApi } from '../src/videoGenerationApi';
import { bindComfyVideoWorkflow } from '../src/comfyuiVideo';
import { preflightVideoBatchManagedReferences, videoBatchConnectionIdentity, videoBatchRequestFingerprint, videoTaskMatchesRequestFingerprint, videoTaskRequestFingerprint } from '../src/videoBatch';
import { getVideoTailReferencePlacements } from '../src/videoTailReference';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft, VideoImageReference } from '../src/videoGenerationTypes';
import type { VideoTailFrameSelectionResult } from '../src/videoFrameSelection';

const references: VideoImageReference[] = [
  { assetId: 'opening', role: 'composition' },
  { assetId: 'identity', role: 'character' },
  { assetId: 'closing', role: 'scene' },
];

// A reserved tail changes physical slot numbers, not the editable selection's
// scene/character/general purposes or remembered empty-slot order.
{
  const mixed: VideoImageReference[] = [
    { assetId: 'scene', role: 'scene' },
    { assetId: 'general', role: 'general', slotIndex: 2 },
  ];
  const remembered = ['scene', 'character', 'general'] as const;
  const context = { backend: 'api' as const, slotRoles: offsetVideoReferenceSlotRoles(remembered, 1) };
  assert.deepEqual(context.slotRoles, [undefined, 'scene', 'character', 'general']);
  assert.deepEqual(videoReferenceUsage(mixed, context, 1), mixed);
  assert.deepEqual(videoReferenceSlotLabels(mixed, context, 1, [...remembered]), ['场景1（槽2）', '通用参考1（槽4）']);
  assert.deepEqual(offsetVideoReferenceSlotRoles(remembered, 0), remembered);
  assert.equal(offsetVideoReferenceSlotRoles(undefined, 1), undefined, 'legacy mapping fallback is not turned into an explicit empty selection');
}
const comfyWorkflow: ComfyVideoWorkflowPreset = {
  id: 'usage-workflow', name: '边界用途隔离测试', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({
    p: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'original prompt' } },
    a: { class_type: 'LoadImage', inputs: { image: 'fixed-first.png' } },
    b: { class_type: 'LoadImage', inputs: { image: 'fixed-identity.png' } },
    c: { class_type: 'LoadImage', inputs: { image: 'fixed-last.png' } },
    v: { class_type: 'SaveVideo', inputs: { images: ['a', 0], seed: '1234567890123456789' } },
  }),
  mapping: { prompt: [{ nodeId: 'p', inputName: 'value' }], images: [
    { nodeId: 'a', inputName: 'image', role: 'first-frame' },
    { nodeId: 'b', inputName: 'image', role: 'character' },
    { nodeId: 'c', inputName: 'image', role: 'last-frame' },
  ], outputNodeId: 'v' },
};
const api: VideoTaskApiConfig = {
  ...defaultRunningHubVideoApi, endpoint: 'https://reference-usage.invalid/run/{appId}', runningHubAppId: 'fixture-only',
  apiKey: 'reference-usage-fixture-key',
  statusEndpointTemplate: 'https://reference-usage.invalid/query', imageUploadEndpoint: 'https://reference-usage.invalid/upload',
  runningHubImageRoles: ['first-frame', 'character'],
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: 'p', fieldName: 'value', fieldValue: '{{prompt}}' },
    { nodeId: 'a', fieldName: 'image', fieldValue: '{{first_image}}' },
    { nodeId: 'b', fieldName: 'image', fieldValue: '{{image_2}}' },
  ], references: '{{references}}', first_image: '{{first_image}}', last_image: '{{last_image}}' }),
};
const draft = (index = 1, refs = references.slice(0, 2)): VideoGenerationDraft => ({
  name: `用途测试第${index}段`, prompt: `unchanged-prompt-${index}`, backend: 'api', references: structuredClone(refs), parameters: {},
  source: { storyboardId: `board-${index}`, sequencePlanId: 'usage-plan', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh' },
});
const image = (reference: VideoImageReference): ReferenceAsset => ({
  id: reference.assetId, name: reference.assetId, type: 'reference', role: 'composition', referenceRole: reference.role,
  fileName: `${reference.assetId}.png`, relativePath: `image/${reference.assetId}.png`, checksum: `${reference.assetId}-checksum`,
  mediaType: 'image', tags: [], createdAt: 1, updatedAt: 1,
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const waitFor = async (condition: () => boolean, reason: string) => {
  for (let i = 0; i < 600; i += 1) { if (condition()) return; await tick(); }
  assert.fail(reason);
};
const frame = (index: number) => ({
  fileName: `selected-${index}.png`, relativePath: `image/selected-${index}.png`, checksum: `selected-${index}-checksum`,
  sizeBytes: 8, mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false,
  url: `lianhua-asset://local/image/selected-${index}.png`, timeSec: 8.5, frameIndex: 85, width: 640, height: 360, role: 'custom-frame' as const,
});
const selection = (index: number): VideoTailFrameSelectionResult => ({
  frame: frame(index), selection: { source: 'ai', selectedId: `candidate-${index}`, reason: 'fixture selected exact previous state',
    selectedTimeSec: 8.5, lastFrameTimeSec: 9.9, offsetFromEndSec: 1.4, candidateCount: 1 },
  candidates: [{ id: `candidate-${index}`, timeSec: 8.5, isLastFrame: false, frame: frame(index) }],
});
const harness = () => {
  const holder = { state: createInitialState(), failPosts: new Set<number>(), unknownPosts: new Set<number>(), aiCalls: 0 };
  holder.state.settings.videoTaskApi = structuredClone(api);
  holder.state.settings.comfyuiVideo = { enabled: true, baseUrl: 'https://reference-usage-comfy.invalid', apiKey: '', workflows: [comfyWorkflow], activeWorkflowId: comfyWorkflow.id };
  holder.state.project.assets = references.map(image);
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const journals = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  const uploads: Array<{ name: string; bytes: string }> = [];
  let posts = 0;
  const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => {
      requests.push(structuredClone(payload));
      if (payload.url.endsWith('/upload') || payload.url.endsWith('/upload/image')) {
        const file = payload.multipart?.files[0]; assert.ok(file);
        const name = `input-${uploads.length + 1}.png`; uploads.push({ name, bytes: file.dataUrl });
        return response(payload.url.endsWith('/upload/image') ? { name, subfolder: 'inputs' } : { code: 0, data: { fileName: `inputs/${name}` } });
      }
      if (payload.url.endsWith('/prompt')) return response({ prompt_id: 'comfy-fixture-remote' });
      if (payload.url.includes('/run/')) {
        posts += 1;
        if (holder.unknownPosts.has(posts)) throw new Error('fixture unknown generation POST');
        return response(holder.failPosts.has(posts)
          ? { taskId: `remote-${posts}`, status: 'FAILED', errorCode: 'FIXTURE', errorMessage: 'fixture terminal failure' }
          : { taskId: `remote-${posts}`, status: 'SUCCESS', results: [{ outputType: 'mp4', url: `https://usage-cdn.invalid/result-${posts}.mp4` }] });
      }
      if (payload.url.endsWith('/queue')) return response({ queue_pending: [], queue_running: [] });
      if (payload.url.includes('/history/')) return response({});
      if (payload.url.endsWith('/query')) return response({ status: 'RUNNING' });
      throw new Error(`unexpected isolated request: ${payload.url}`);
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task) => { journals.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(journals.get(taskId) || null), deleteVideoTaskCheckpoint: async (taskId) => journals.delete(taskId),
    readManagedImageDataUrl: async ({ expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum}` }),
    storeGeneratedImage: async ({ dataUrl, fileName }) => ({ fileName: fileName || 'fixture.png', relativePath: `image/${fileName || 'fixture.png'}`,
      checksum: dataUrl.split(',')[1], mediaType: 'image', managed: true, missing: false, sizeBytes: 8, url: `lianhua-asset://local/image/${fileName || 'fixture.png'}` }),
    downloadGeneratedMedia: async ({ fileName, requestId }) => ({ fileName: `${fileName}.mp4`, relativePath: `video/${requestId}.mp4`, checksum: `video-${requestId}`,
      mediaType: 'video', managed: true, missing: false, sizeBytes: 8, url: `lianhua-asset://local/video/${requestId}.mp4` }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'fixture' }),
    extractWorkbenchFrames: async () => { throw new Error('strict AI path must not fall back to raw extraction'); }, cancelWorkbenchJob: async () => true,
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => holder.state, setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, persistState: async () => {}, onRuntime: () => {}, pollIntervalMs: 60_000,
    selectTailFrame: async (input) => { assert.equal(input.requireAiSelection, true); await input.onBeforeAI?.(); return selection(++holder.aiCalls); },
  };
  const tasks = (batchId?: string) => holder.state.project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video' && (!batchId || task.batchId === batchId))
    .sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0));
  const generationRequests = () => requests.filter((request) => request.url.includes('/run/'));
  return { holder, options, journals, uploads, requests, tasks, generationRequests, engine: new VideoGenerationEngine(options) };
};
const chain = (projectId: string, count = 3): VideoBatchStartInput => ({ projectId, label: 'manual frame plus AI continuity', items: Array.from({ length: count }, (_, index) => ({
  itemKey: `board-${index + 1}:zh`, draft: draft(index + 1, index === 0 ? references.slice(0, 2) : [references[1]]),
  ...(index > 0 ? { previousTail: { predecessorItemKey: `board-${index}:zh`, placement: { mode: 'prepend' as const, index: 0, role: 'first-frame' as const }, selectionMode: 'ai-assisted' as const, requireAiSelection: true as const } } : {}),
})) });

// Selected cards display actual slot names, not permanent asset categories or
// guessed first frames. These are pure labels and never alter the input draft.
{
  const identityRefs: VideoImageReference[] = [references[1], { assetId: 'identity-2', role: 'character' }];
  const all = [references[0], ...identityRefs];
  const original = structuredClone(all);
  const roles: VideoImageReference['role'][] = ['first-frame', 'character', 'character'];
  const contexts = [
    { backend: 'api' as const, api: { ...api, runningHubImageRoles: roles } },
    { backend: 'comfyui' as const, workflow: { ...comfyWorkflow, mapping: { ...comfyWorkflow.mapping,
      images: comfyWorkflow.mapping.images.map((slot, index) => ({ ...slot, role: roles[index] })) } } },
  ];
  for (const context of contexts) {
    assert.deepEqual(videoReferenceSlotLabels(all, context), ['首帧（槽1）', '人物1（槽2）', '人物2（槽3）']);
    assert.deepEqual(videoReferenceSlotLabels(identityRefs, context, 1), ['人物1（槽2）', '人物2（槽3）']);
    assert.deepEqual(videoReferenceSlotLabels([identityRefs[1]], context, 2), ['人物2（槽3）'], 'explicit prefix identity slots participate in numbering');
    assert.deepEqual(videoReferenceSlotLabels([...all, references[2]], context), ['首帧（槽1）', '人物1（槽2）', '人物2（槽3）', '未分配（槽4，超出槽位）']);
    assert.deepEqual(videoReferenceSlotLabels([references[2]], context, 1), ['人物1（槽2） · 当前场景，用途不匹配']);
  }
  assert.deepEqual(all, original);
  assert.deepEqual(videoReferenceSlotLabels(references, { backend: 'comfyui', workflow: comfyWorkflow }), ['首帧（槽1）', '人物1（槽2）', '尾帧（槽3）']);
  const generalContext = { backend: 'api' as const, api: { ...api, runningHubImageRoles: ['general', 'general', 'general'] as VideoImageReference['role'][] } };
  assert.deepEqual(videoReferenceSlotLabels(all, generalContext), ['构图1（槽1）', '人物1（槽2）', '人物2（槽3）']);
  assert.deepEqual(videoReferenceSlotLabels(identityRefs, generalContext, 1), ['人物1（槽2）', '人物2（槽3）']);
  assert.deepEqual(videoReferenceSlotLabels([identityRefs[0], references[0], identityRefs[1]], generalContext), ['人物1（槽1）', '构图1（槽2）', '人物2（槽3）'], 'flexible slots follow current selected ordering');
  assert.deepEqual(videoReferenceSlotLabels(all, { backend: 'api', api: { ...api, provider: 'generic' } }), ['构图1（槽1）', '人物1（槽2）', '人物2（槽3）'], 'generic APIs ignore RunningHub-only role metadata');
  assert.deepEqual(videoReferenceSlotLabels(all, { backend: 'comfyui' }), ['构图1（槽1）', '人物1（槽2）', '人物2（槽3）'], 'no workflow means no guessed boundary role');
  assert.deepEqual(videoReferenceSlotLabels([{ assetId: 'subject-a', role: 'subject' }, { assetId: 'general-a', role: 'general' }, { assetId: 'general-b', role: 'general' }, { assetId: 'unknown', role: 'unknown' }], { backend: 'api' }), ['主体1（槽1）', '通用参考1（槽2）', '通用参考2（槽3）', '未指定参考1（槽4）']);
  assert.deepEqual(videoReferenceSlotLabels([references[0]], { backend: 'api', api: { ...api, runningHubImageRoles: [] } }), ['未分配（槽1，超出槽位）'], 'declared zero capacity does not look assigned');
  assert.deepEqual(videoReferenceSlotLabels([references[0]], { backend: 'comfyui', workflow: { ...comfyWorkflow, mapping: { ...comfyWorkflow.mapping, images: [] } } }), ['未分配（槽1，超出槽位）']);
  assert.deepEqual(videoReferenceSlotLabels(all, { backend: 'api' }, -1), ['未分配（槽位无效）', '未分配（槽位无效）', '未分配（槽位无效）']);
  assert.deepEqual(videoReferenceSlotLabels([], generalContext), []);
}

// Pure operation: no guesses, reordering, omissions, category mutation, or
// reassignment of ordinary reference roles. A prepend identity starts at slot 2.
{
  const original = structuredClone(references);
  for (const context of [
    { backend: 'comfyui' as const, workflow: comfyWorkflow },
    { backend: 'api' as const, api: { ...api, runningHubImageRoles: ['first-frame', 'character', 'last-frame'] as VideoImageReference['role'][] } },
  ]) {
    const used = videoReferenceUsage(references, context);
    assert.deepEqual(used.map((ref) => ref.assetId), references.map((ref) => ref.assetId));
    assert.deepEqual(used.map((ref) => ref.role), ['first-frame', 'character', 'last-frame']);
    assert.deepEqual(videoReferenceUsage([references[1]], context, 1), [references[1]]);
  }
  for (const provider of ['generic', 'minimax'] as const) assert.deepEqual(videoReferenceUsage(references, { backend: 'api', api: { ...api, provider } }), references);
  assert.deepEqual(videoReferenceUsage(references, { backend: 'api', api: { provider: 'runninghub' } }), references);
  assert.deepEqual(videoReferenceUsage(references, { backend: 'comfyui' }), references);
  assert.equal(videoReferenceUsage([references[0]], { backend: 'api', api: { ...api, runningHubImageRoles: ['character'] } })[0].role, 'composition');
  // New drafts carry the purpose chosen in this segment's picker.  It must
  // win over the workflow/API's historical physical-slot role metadata, so
  // the same workflow can use a different purpose in every segment.
  for (const context of [
    { backend: 'api' as const, api: { ...api, runningHubImageRoles: ['first-frame', 'character', 'last-frame'] as const } },
    { backend: 'comfyui' as const, workflow: comfyWorkflow },
  ]) {
    const selected = videoReferenceUsage(references, { ...context, slotRoles: ['scene', 'subject', 'prop'] });
    assert.deepEqual(selected.map((reference) => reference.role), ['scene', 'subject', 'prop']);
    assert.deepEqual(videoReferenceSlotLabels(references, { ...context, slotRoles: ['scene', 'subject', 'prop'] }), [
      '场景1（槽1） · 原槽首帧，仅提示', '主体1（槽2） · 原槽人物，仅提示', '道具1（槽3） · 原槽尾帧，仅提示',
    ], 'new drafts show the user-selected purpose first and identify the historical one only as a hint');
  }
  assert.deepEqual(references, original);
  const tailSlots = getVideoTailReferencePlacements({ backend: 'comfyui', workflow: comfyWorkflow, references });
  assert.ok(tailSlots.options.some((slot) => slot.index === 0), 'another ordinary image in an explicitly mapped final-frame slot must not disable the first-frame tail position');
}

// Real body placeholders use resolved roles, not the original asset category.
{
  const config = { ...api, runningHubImageRoles: ['first-frame', 'character', 'last-frame'] as VideoImageReference['role'][] };
  const input = draft(1, references); const before = structuredClone(input);
  const body = buildVideoApiBody(config, input, ['exact-open.png', 'exact-identity.png', 'exact-end.png']);
  assert.equal(body.first_image, 'exact-open.png'); assert.equal(body.last_image, 'exact-end.png');
  assert.deepEqual(body.references, [
    { image_url: 'exact-open.png', role: 'first-frame' }, { image_url: 'exact-identity.png', role: 'character' }, { image_url: 'exact-end.png', role: 'last-frame' },
  ]);
  assert.deepEqual(input, before);
  assert.throws(() => buildVideoApiBody(api, input, ['a', 'b', 'c']), /超出容量/u);
  assert.doesNotThrow(() => buildVideoApiBody(api, draft(1, [references[0]]), ['a']), 'mapped slots are capacity, not a minimum image count');
  const mismatched = buildVideoApiBody(api, draft(1, [references[0], references[2]]), ['a', 'b']);
  assert.deepEqual(
    (mismatched.references as Array<{ image_url: string }>).map((reference) => reference.image_url),
    ['a', 'b'],
    'a selected image whose original category differs from the physical slot still submits unchanged',
  );
  const perSegment = draft(1, [references[0], references[2]]);
  perSegment.referenceSlotRoles = ['scene', 'subject'];
  const perSegmentBody = buildVideoApiBody(api, perSegment, ['a', 'b']);
  assert.deepEqual(
    (perSegmentBody.references as Array<{ role: string }>).map((reference) => reference.role),
    ['scene', 'subject'],
    'the API payload uses this segment\'s picker purposes rather than old workflow roles',
  );
  const nodes = bindComfyVideoWorkflow(comfyWorkflow, input.prompt, ['exact-open.png', 'exact-identity.png', 'exact-end.png']);
  assert.equal(nodes.a.inputs.image, 'exact-open.png'); assert.equal(nodes.b.inputs.image, 'exact-identity.png'); assert.equal(nodes.c.inputs.image, 'exact-end.png');
  assert.equal(nodes.v.inputs.seed, '1234567890123456789');
  assert.throws(() => bindComfyVideoWorkflow(comfyWorkflow, input.prompt, ['a', 'b', 'c', 'd']), /不会丢弃图片/u);
}

// Single generation, then an explicit frozen retry after settings change. The
// new task adopts usage, while the original assets and original snapshot stay.
{
  const h = harness();
  try {
    const originals = structuredClone(h.holder.state.project.assets);
    const id = await h.engine.start(draft());
    const task = h.tasks().find((candidate) => candidate.id === id)!;
    const snapshot = structuredClone(task.videoJob!.snapshot);
    assert.deepEqual(snapshot.draft.references.map((ref) => ref.role), ['first-frame', 'character']);
    assert.deepEqual(snapshot.images.map((ref) => ref.role), ['first-frame', 'character']);
    assert.deepEqual(h.uploads.map((entry) => entry.bytes), ['data:image/png;base64,opening-checksum', 'data:image/png;base64,identity-checksum']);
    h.holder.state.settings.videoTaskApi.runningHubImageRoles = ['character', 'character'];
    await h.engine.start({ ...structuredClone(snapshot.draft), reuseTaskId: id });
    assert.deepEqual(h.tasks().find((candidate) => candidate.id === id)!.videoJob!.snapshot, snapshot);
    assert.deepEqual(originals, h.holder.state.project.assets.filter((asset) => originals.some((original) => original.id === asset.id)));
    assert.equal(h.generationRequests().length, 2, 'only explicit retry creates another paid request');
  } finally { h.engine.dispose(); }
}

// Comfy engine freezes correct usage and sends each exact image to its mapped
// input; the asset categories are not part of the /prompt contract.
{
  const h = harness();
  try {
    const input = { ...draft(1, references), backend: 'comfyui' as const, workflowId: comfyWorkflow.id };
    const id = await h.engine.start(input);
    const request = h.requests.find((entry) => entry.url.endsWith('/prompt'))!;
    const body = JSON.parse(request.body!);
    assert.deepEqual([body.prompt.a.inputs.image, body.prompt.b.inputs.image, body.prompt.c.inputs.image], ['inputs/input-1.png', 'inputs/input-2.png', 'inputs/input-3.png']);
    assert.deepEqual(h.uploads.map((upload) => upload.bytes), ['data:image/png;base64,opening-checksum', 'data:image/png;base64,identity-checksum', 'data:image/png;base64,closing-checksum']);
    assert.deepEqual(h.tasks().find((task) => task.id === id)!.videoJob!.snapshot.images.map((img) => img.role), ['first-frame', 'character', 'last-frame']);
    assert.deepEqual(input.references, references);
  } finally { h.engine.dispose(); }
}

// A manually selected composition starts segment 1; later AI tails occupy only
// slot 1, each identity retains slot 2, and repeat submission is deduplicated.
{
  const h = harness();
  try {
    const input = chain(h.holder.state.project.id); const originals = structuredClone(input);
    const result = await h.engine.startBatch(input);
    await waitFor(() => h.tasks(result.batchId).every((task) => Boolean(task.resultAssetId)), 'mapped boundary chain did not complete');
    assert.equal(h.holder.aiCalls, 2); assert.equal(h.generationRequests().length, 3);
    const tasks = h.tasks(result.batchId);
    for (const task of tasks) assert.deepEqual(task.videoJob!.snapshot.draft.references.map((ref) => ref.role), ['first-frame', 'character']);
    assert.equal(tasks[0].videoJob!.snapshot.draft.references[0].assetId, 'opening');
    assert.deepEqual(h.uploads.map((upload) => upload.bytes), ['opening-checksum', 'identity-checksum', 'selected-1-checksum', 'identity-checksum', 'selected-2-checksum', 'identity-checksum'].map((checksum) => `data:image/png;base64,${checksum}`));
    const usedInput = structuredClone(input); usedInput.items[0].draft.references[0].role = 'first-frame';
    const duplicate = await h.engine.startBatch(usedInput);
    assert.equal(duplicate.taskIds.length, 0); assert.equal(duplicate.skipped.length, 3);
    assert.equal(h.generationRequests().length, 3); assert.deepEqual(input, originals);
  } finally { h.engine.dispose(); }
}

// Continue a failed AI composite suffix, across state/journal reload. The
// successful manual opening is never regenerated and old snapshots stay fixed.
{
  const h = harness();
  try {
    h.holder.failPosts.add(2);
    const batch = await h.engine.startBatch(chain(h.holder.state.project.id));
    await waitFor(() => h.tasks(batch.batchId)[1]?.status === 'failed', 'fixture second segment did not fail');
    await h.engine.cancelBatch(batch.batchId);
    const originalSnapshots = h.tasks(batch.batchId).map((task) => structuredClone(task.videoJob!.snapshot));
    h.engine.dispose();
    h.holder.state = normalizeState(JSON.parse(serializeStateForStorage(h.holder.state).serialized));
    h.engine = new VideoGenerationEngine(h.options);
    const preview = await h.engine.resumeBatch(batch.batchId);
    assert.ok(preview.continuation); assert.equal(h.generationRequests().length, 2);
    const continued = await h.engine.confirmContinueBatch(preview.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'continued mapped chain did not finish');
    assert.deepEqual(h.generationRequests().map((request) => (JSON.parse(request.body!).nodeInfoList as Array<{ fieldValue: unknown }>)[0].fieldValue), ['unchanged-prompt-1', 'unchanged-prompt-2', 'unchanged-prompt-2', 'unchanged-prompt-3']);
    assert.equal(h.holder.aiCalls, 2, 'first suffix retains its exact frozen AI frame');
    assert.equal(JSON.stringify(h.tasks(batch.batchId).map((task) => task.videoJob!.snapshot)), JSON.stringify(originalSnapshots));
    await h.engine.resumeBatch(batch.batchId); assert.equal(h.generationRequests().length, 4);
    for (const task of h.tasks(continued.batchId)) assert.deepEqual(task.videoJob!.snapshot.draft.references.map((ref) => ref.role), ['first-frame', 'character']);
  } finally { h.engine.dispose(); }
}

// A normalized alias is read-only: legacy stored fingerprints/dependencies
// stay untouched, while equivalent boundary labels cannot bypass deduplication.
{
  const h = harness();
  try {
    const input = chain(h.holder.state.project.id, 1);
    const result = await h.engine.startBatch(input);
    await waitFor(() => Boolean(h.tasks(result.batchId)[0]?.resultAssetId), 'legacy fixture did not finish');
    const task = h.tasks(result.batchId)[0];
    task.videoJob!.snapshot.draft.references[0].role = 'composition';
    task.videoJob!.snapshot.images[0].role = 'composition';
    task.requestFingerprint = 'legacy-frozen-fingerprint';
    const before = structuredClone(task);
    const fingerprint = videoBatchRequestFingerprint(input.items[0].draft, h.holder.state.project.assets, videoBatchConnectionIdentity(h.holder.state.settings, input.items[0].draft));
    assert.equal(videoTaskRequestFingerprint(task), 'legacy-frozen-fingerprint');
    assert.equal(videoTaskMatchesRequestFingerprint(task, fingerprint), true);
    const duplicate = await h.engine.startBatch(input);
    assert.equal(duplicate.taskIds.length, 0); assert.equal(duplicate.skipped.length, 1);
    assert.equal(h.generationRequests().length, 1); assert.deepEqual(task, before);
  } finally { h.engine.dispose(); }
}

// Unknown generation responses retain their paid boundary after an upgrade or
// role-label change; force is never permission to reissue an uncertain POST.
{
  const h = harness();
  try {
    h.holder.unknownPosts.add(1);
    const input = chain(h.holder.state.project.id, 1);
    const result = await h.engine.startBatch(input);
    await waitFor(() => h.tasks(result.batchId)[0]?.status === 'unknown', 'fixture did not reach unknown POST');
    const changed = structuredClone(input); changed.force = true; changed.items[0].draft.references[0].role = 'first-frame';
    const duplicate = await h.engine.startBatch(changed);
    assert.equal(duplicate.taskIds.length, 0); assert.equal(duplicate.skipped[0]?.reason, 'in-flight');
    assert.equal(h.generationRequests().length, 1);
  } finally { h.engine.dispose(); }
}

// A prior standalone match cannot bypass managed-file preflight when the new
// selection forms a dependency chain with a different request identity.
{
  const h = harness();
  try {
    const original = await h.engine.startBatch(chain(h.holder.state.project.id, 1));
    await waitFor(() => Boolean(h.tasks(original.batchId)[0]?.resultAssetId), 'preflight standalone fixture did not complete');
    let reads = 0;
    const unreadable = { readManagedImageDataUrl: async () => { reads += 1; throw new Error('fixture file removed'); } };
    await preflightVideoBatchManagedReferences(h.holder.state, chain(h.holder.state.project.id, 1), unreadable);
    assert.equal(reads, 0, 'completed standalone duplicate keeps the established no-work behavior');
    await assert.rejects(() => preflightVideoBatchManagedReferences(h.holder.state, chain(h.holder.state.project.id), unreadable), /fixture file removed/u);
    assert.equal(reads, 1); assert.equal(h.generationRequests().length, 1, 'preflight does not create a paid task');
  } finally { h.engine.dispose(); }
}

console.log('video reference usage: boundary selection, payload bytes/order, frozen retry, chain, continue, restart and deduplication passed');
