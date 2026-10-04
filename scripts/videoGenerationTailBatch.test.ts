import assert from 'node:assert/strict';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { cancelledVideoBatchTaskBeforePost, videoBatchDependencyFingerprint } from '../src/videoBatch';
import type { AppState, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoTailFrameSelectionResult } from '../src/videoFrameSelection';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 8; index += 1) await tick(); };
const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let i = 0; i < 600; i += 1) { if (predicate()) return; await tick(); }
  assert.fail(message);
};
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const movie = (name: string) => ({ fileName: `${name}.mp4`, relativePath: `video/${name}.mp4`, checksum: `video-${name}`, sizeBytes: 8, mediaType: 'video' as const, managed: true, missing: false, url: `https://cdn.example.test/${name}.mp4` });
const frame = (index: number) => ({ fileName: `tail-${index}.png`, relativePath: `image/tail-${index}.png`, checksum: `tail-${index}`, sizeBytes: 8, mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false, url: `lianhua-asset://local/image/tail-${index}.png`, timeSec: 9.9, frameIndex: 99, width: 640, height: 360, role: 'last-frame' as const });
const config: VideoTaskApiConfig = { enabled: true, endpoint: 'https://video.example.test/generate', statusEndpointTemplate: 'https://video.example.test/tasks/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'chain-test' };
const draft = (index: number): VideoGenerationDraft => ({ name: `第${index}段`, prompt: `段落 ${index} 的视频`, backend: 'api', references: [], parameters: {}, source: { storyboardId: `board-${index}`, sequencePlanId: 'plan-chain', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh', label: `第${index}段` } });
const makeHarness = (holdExtract = false) => {
  let state = createInitialState(); state.settings.videoTaskApi = config;
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const extractions: Array<{ jobId: string; source: unknown }> = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const extractionWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let movieCount = 0; let frameCount = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => {
      requests.push(payload);
      if (payload.method === 'POST') return response({ id: `remote-${requests.filter((item) => item.method === 'POST').length}`, status: 'succeeded', url: `https://cdn.example.test/generated-${++movieCount}.mp4` });
      return response({ status: 'succeeded', url: 'https://cdn.example.test/no-poll.mp4' });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(checkpoints.get(taskId) || null), deleteVideoTaskCheckpoint: async () => true,
    downloadGeneratedMedia: async (payload) => movie(payload.fileName || `movie-${movieCount}`),
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum || relativePath}`, mimeType: 'image/png', sizeBytes: 8, checksum: expectedChecksum || relativePath }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'test' }),
    extractWorkbenchFrames: async (request) => {
      extractions.push({ jobId: request.jobId, source: request.source });
      if (holdExtract) await new Promise<void>((resolve, reject) => extractionWaiters.push({ resolve, reject }));
      return { probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' }, frames: [frame(++frameCount)] };
    },
    cancelWorkbenchJob: async () => { extractionWaiters.splice(0).forEach(({ reject }) => reject(new Error('已取消抽帧'))); return true; },
  };
  const options: VideoGenerationEngineOptions = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, persistState: async () => {} };
  return { holder: () => state, requests, extractions, checkpoints, desktop, options, mutate: options.setState, engine: new VideoGenerationEngine(options) };
};
const chainInput = (projectId: string): VideoBatchStartInput => ({ projectId, label: '三段自动衔接', concurrency: 1, items: [1, 2, 3].map((index) => ({ itemKey: `board-${index}:zh`, draft: draft(index), previousTail: index > 1 ? { predecessorItemKey: `board-${index - 1}:zh`, placement: { mode: 'append' as const, index: 0, role: 'first-frame' as const } } : undefined })) });
const posts = (h: ReturnType<typeof makeHarness>) => h.requests.filter((request) => request.method === 'POST');
const tasks = (h: ReturnType<typeof makeHarness>) => h.holder().project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video').sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0));
const aiInput = (projectId: string): VideoBatchStartInput => {
  const input = chainInput(projectId); input.items.splice(2, 1);
  input.items[1].previousTail!.selectionMode = 'ai-assisted';
  return input;
};
const strictAiInput = (projectId: string): VideoBatchStartInput => {
  const input = aiInput(projectId); input.items[1].previousTail!.requireAiSelection = true; return input;
};
const aiSelection = (source: 'ai' | 'last-frame' = 'ai'): VideoTailFrameSelectionResult => {
  const selected = { ...frame(101), role: source === 'ai' ? 'custom-frame' as const : 'last-frame' as const, timeSec: source === 'ai' ? 8.9 : 9.9, frameIndex: source === 'ai' ? 89 : 99 };
  return {
    frame: selected,
    selection: { source, selectedId: source === 'ai' ? 'frame-3' : 'frame-6', reason: '背影和被遮挡的六足生物符合完整下一段剧情，无须露脸。',
      warning: source === 'ai' ? '提前 1 秒，原视频没有被裁剪，注意动作回退。' : '视觉 AI 返回格式不可用；已回退真实尾帧，不阻止继续生成。',
      selectedTimeSec: selected.timeSec, lastFrameTimeSec: 9.9, offsetFromEndSec: source === 'ai' ? 1 : 0, candidateCount: 6 },
    candidates: [{ id: source === 'ai' ? 'frame-3' : 'frame-6', timeSec: selected.timeSec, isLastFrame: source !== 'ai', frame: selected }],
  };
};

{
  const h = makeHarness(); const projectId = h.holder().project.id;
  const result = await h.engine.startBatch(chainInput(projectId));
  assert.equal(result.taskIds.length, 3);
  await waitFor(() => h.requests.filter((item) => item.method === 'POST').length === 3, '三段链式批次没有按顺序提交');
  const posts = h.requests.filter((item) => item.method === 'POST').map((item) => JSON.parse(item.body || '{}'));
  assert.equal(posts.length, 3); assert.equal(posts[0].images, undefined);
  assert.match(posts[1].first_frame_image, /^data:image\/png;base64,tail-1/u);
  assert.match(posts[2].first_frame_image, /^data:image\/png;base64,tail-2/u);
  const tasks = h.holder().project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video').sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0));
  assert.deepEqual(h.extractions.map((entry) => (entry.source as { assetId: string }).assetId), tasks.slice(0, 2).map((task) => h.holder().project.assets.find((asset) => asset.sourceVideoTaskId === task.id)?.id));
  assert.equal(tasks[1].videoJob?.tailPreparation?.phase, 'ready'); assert.equal(tasks[2].videoJob?.tailPreparation?.phase, 'ready');
  assert.equal(tasks[1].videoJob?.snapshot.previousTail?.predecessorTaskId, tasks[0].id);
  assert.equal(tasks[2].videoJob?.snapshot.previousTail?.predecessorTaskId, tasks[1].id);
  for (const task of tasks.slice(1)) assert.equal(task.videoJob?.snapshot.draft.references.length, 1, '尾帧预留槽必须在冻结draft中稳定存在');
  h.engine.dispose();
}

{
  const h = makeHarness(true); const projectId = h.holder().project.id;
  const result = await h.engine.startBatch(chainInput(projectId));
  await waitFor(() => h.extractions.length === 1, '第二段尾帧没有进入本地抽取');
  await h.engine.cancelBatch(result.batchId);
  await tick();
  assert.equal(h.requests.filter((item) => item.method === 'POST').length, 1, '取消抽帧后不应提交后续段');
  const tasks = h.holder().project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video');
  assert.ok(tasks.slice(1).every((task) => task.videoJob?.tailPreparation?.phase === 'cancelled' || task.videoJob?.batchQueueState === 'cancelled'));
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); let downloading = false;
  const original = h.desktop.downloadGeneratedMedia;
  h.desktop.downloadGeneratedMedia = async (input) => { if (!downloading) { downloading = true; await wait.promise; } return original(input); };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => downloading, '第一段没有开始保存');
  h.engine.reconcile(); await h.engine.resume(result.taskIds[1]); await settle();
  assert.equal(posts(h).length, 1, '远端成功但下载未结束不能提交下一段');
  assert.equal(h.extractions.length, 0, '远端成功但下载未结束不能抽尾帧');
  wait.resolve();
  await waitFor(() => posts(h).length === 3, '下载完成后链没有继续');
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); let persisted = false;
  h.options.persistState = async () => {
    if (!persisted && tasks(h)[0]?.resultAssetId) { persisted = true; await wait.promise; }
  };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => persisted, '第一段没有进入项目落盘');
  for (let index = 0; index < 5; index += 1) h.engine.reconcile();
  await h.engine.resume(result.taskIds[1]); await settle();
  assert.equal(posts(h).length, 1, '成片记录落盘之前不能提交后段'); assert.equal(h.extractions.length, 0);
  wait.resolve(); await waitFor(() => posts(h).length === 3, '成片项目记录落盘后未唤醒'); h.engine.dispose();
}

for (const barrier of ['main', 'journal'] as const) {
  const h = makeHarness(); const wait = deferred(); let hit = false;
  if (barrier === 'main') h.options.persistState = async () => {
    if (!hit && tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'ready') { hit = true; await wait.promise; }
  };
  else {
    const save = h.desktop.saveVideoTaskCheckpoint!;
    h.desktop.saveVideoTaskCheckpoint = async (task) => {
      if (!hit && task.videoJob?.tailPreparation?.phase === 'ready') { hit = true; await wait.promise; }
      return save(task);
    };
  }
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => hit, `尾帧未触及${barrier}持久化门禁`);
  h.engine.reconcile(); await h.engine.resume(result.taskIds[1]); await settle();
  assert.equal(posts(h).length, 1, `尾帧${barrier}落盘之前不允许上传/POST`);
  wait.resolve(); await waitFor(() => posts(h).length === 3, `${barrier}落盘后没有继续`); h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); let entered = false; let downloads = 0; const download = h.desktop.downloadGeneratedMedia;
  h.desktop.downloadGeneratedMedia = async (input) => { downloads += 1; return download(input); };
  h.options.persistState = async () => { if (!entered && tasks(h)[0]?.resultAssetId) { entered = true; await wait.promise; } };
  const batch = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => entered, '取消存盘回归没有到达第一段持久化门禁');
  await h.engine.cancel(batch.taskIds[0]); wait.resolve(); await settle();
  assert.equal(posts(h).length, 1); assert.equal(tasks(h)[0].videoJob?.trackingStopped, true);
  await h.engine.resume(batch.taskIds[0]);
  await waitFor(() => posts(h).length === 3, '已落盘父成片停追踪后无法恢复链');
  assert.equal(downloads, 3, '恢复已保存成片不应重新下载父视频'); h.engine.dispose();
}

{
  const h = makeHarness(); const original = h.desktop.extractWorkbenchFrames!; let fail = true;
  h.desktop.extractWorkbenchFrames = async (input) => { if (fail) throw new Error('故意模拟 FFmpeg 解码失败'); return original(input); };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '抽帧失败没有明确阻塞');
  for (let index = 0; index < 10; index += 1) h.engine.reconcile();
  await settle(); assert.equal(posts(h).length, 1, '抽帧失败不许直接生成后段');
  fail = false; await h.engine.resume(result.taskIds[1]);
  await waitFor(() => posts(h).length === 3, '明确重试没有恢复抽帧'); h.engine.dispose();
}

{
  const h = makeHarness(); const original = h.desktop.saveVideoTaskCheckpoint!; let fail = true; let rejected = 0;
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (fail && task.videoJob?.tailPreparation?.phase === 'ready') { rejected += 1; throw new Error('故意模拟尾帧断点写入失败'); }
    return original(task);
  };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '断点失败没有阻塞后段');
  for (let index = 0; index < 10; index += 1) h.engine.reconcile();
  await settle(); assert.equal(posts(h).length, 1); assert.equal(rejected, 1, '失败不应无限循环重试');
  assert.equal(h.extractions.length, 1);
  fail = false; await h.engine.resume(result.taskIds[1]);
  await waitFor(() => posts(h).length === 3, '重试存盘未恢复尾帧链');
  assert.equal(h.extractions.length, 2, '第二段已有正确帧时不应再抽一张；仅第三段再抽一张'); h.engine.dispose();
}

for (const failure of ['download', 'persist'] as const) {
  const h = makeHarness(); const original = h.desktop.downloadGeneratedMedia; let fail = true; let downloads = 0;
  h.desktop.downloadGeneratedMedia = async (input) => { downloads += 1; if (failure === 'download' && fail) throw new Error('模拟成片下载失败'); return original(input); };
  if (failure === 'persist') h.options.persistState = async () => { if (fail && tasks(h)[0]?.resultAssetId) throw new Error('模拟成片主文件落盘失败'); };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => Boolean(tasks(h)[0]?.videoJob?.downloadError), `${failure}失败没有展示保存错误`);
  h.engine.reconcile(); await settle(); assert.equal(posts(h).length, 1); assert.equal(h.extractions.length, 0);
  fail = false; await h.engine.retryDownload(result.taskIds[0]);
  await waitFor(() => posts(h).length === 3, `${failure}重试未继续后段`);
  assert.equal(downloads, failure === 'download' ? 4 : 3, '保存重试不能重生成或反复下载已落盘视频');
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); const original = h.desktop.extractWorkbenchFrames!;
  h.desktop.extractWorkbenchFrames = async (input) => { const result = await original(input); await wait.promise; return result; };
  const input = chainInput(h.holder().project.id); input.concurrency = 4; delete input.items[2].previousTail;
  await h.engine.startBatch(input); await waitFor(() => h.extractions.length === 1, '第二段未抽帧');
  h.engine.reconcile(); await settle(); assert.equal(posts(h).length, 1, '链中后续手动参考图段不能越过未完成段');
  wait.resolve(); await waitFor(() => posts(h).length === 3, '手动后段未继续');
  assert.equal(h.extractions.length, 1); assert.equal(tasks(h)[2].videoJob?.snapshot.batchPredecessorTaskId, tasks(h)[1].id);
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); const original = h.desktop.extractWorkbenchFrames!; const cancelledJobs: string[] = [];
  h.desktop.extractWorkbenchFrames = async (input) => { const result = await original(input); await wait.promise; return result; };
  h.desktop.cancelWorkbenchJob = async (jobId) => { cancelledJobs.push(jobId); return true; };
  const result = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => h.extractions.length === 1, '未触发延迟抽帧');
  await h.engine.cancelBatch(result.batchId); wait.resolve(); await settle();
  assert.deepEqual(cancelledJobs, [h.extractions[0].jobId], '只能取消此任务实际拥有的抽帧job');
  assert.equal(posts(h).length, 1); assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 0, '迟到尾帧不能重新加入已取消链');
  assert.equal(h.checkpoints.get(result.taskIds[1])?.videoJob?.tailPreparation?.phase, 'cancelled'); h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); const original = h.desktop.downloadGeneratedMedia; let entered = false;
  h.desktop.downloadGeneratedMedia = async (input) => { if (!entered) { entered = true; await wait.promise; } return original(input); };
  const owner = h.holder().project.id; await h.engine.startBatch(chainInput(owner));
  await waitFor(() => entered, '第一段未开始下载');
  h.mutate((state) => ({ ...state, project: { ...createInitialState().project, id: 'unrelated-project' }, projects: [state.project] }));
  wait.resolve(); await waitFor(() => posts(h).length === 3, '切换项目后链式任务中断');
  assert.equal(h.holder().project.assets.length, 0, '尾帧或视频串入当前无关项目');
  assert.equal(h.holder().projects.find((project) => project.id === owner)?.assets.filter((asset) => asset.source === 'derived').length, 2);
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); const original = h.desktop.extractWorkbenchFrames!;
  h.desktop.extractWorkbenchFrames = async (input) => { const result = await original(input); await wait.promise; return result; };
  await h.engine.startBatch(chainInput(h.holder().project.id)); await waitFor(() => h.extractions.length === 1, '未触发精确来源测试');
  h.mutate((state) => ({ ...state, project: { ...state.project, generationTasks: state.project.generationTasks.map((task) => task.id === tasks(h)[0].id ? { ...task, requestFingerprint: 'foreign-request' } : task) } }));
  wait.resolve(); await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '父来源变化没有阻塞');
  assert.equal(posts(h).length, 1); h.engine.dispose();
}

{
  const h = makeHarness(); const input = chainInput(h.holder().project.id); input.items.splice(1, 1);
  await assert.rejects(h.engine.startBatch(input), /不能跳段/u); assert.equal(posts(h).length, 0); assert.equal(tasks(h).length, 0);
  const invalidTemplate = { ...config, requestTemplate: JSON.stringify({ prompt: '{{prompt}}' }) };
  h.mutate((state) => ({ ...state, settings: { ...state.settings, videoTaskApi: invalidTemplate } }));
  await assert.rejects(h.engine.startBatch(chainInput(h.holder().project.id)), /包含所有选图/u);
  assert.equal(posts(h).length, 0); assert.equal(tasks(h).length, 0);
  h.engine.dispose();
}

// A same-ID media asset can be relinked while decoding; matching only task IDs
// would bind a stale frame to a newly replaced predecessor video.
for (const changedField of ['relativePath', 'checksum'] as const) {
  const h = makeHarness(); const wait = deferred(); const original = h.desktop.extractWorkbenchFrames!;
  h.desktop.extractWorkbenchFrames = async (input) => { const result = await original(input); await wait.promise; return result; };
  await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => h.extractions.length === 1, '未触发原视频文件变更测试');
  const predecessorAssetId = tasks(h)[0].resultAssetId;
  h.mutate((state) => ({ ...state, project: { ...state.project, assets: state.project.assets.map((asset) => asset.id === predecessorAssetId
    ? { ...asset, [changedField]: changedField === 'relativePath' ? 'video/relinked.mp4' : 'relinked-checksum' } : asset) } }));
  wait.resolve();
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '变更后的原视频不应接受旧抽帧结果');
  assert.equal(posts(h).length, 1);
  assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 0, '旧文件的迟到尾帧不能进入资料库');
  h.engine.dispose();
}

{
  const h = makeHarness(); const input = chainInput(h.holder().project.id);
  const first = await h.engine.startBatch(input); await waitFor(() => tasks(h).every((task) => Boolean(task.resultAssetId)), '去重测试批次未结束');
  const count = posts(h).length; const duplicate = await h.engine.startBatch(input);
  assert.equal(duplicate.taskIds.length, 0); assert.equal(duplicate.skipped.length, 3); assert.equal(posts(h).length, count);
  const changed = structuredClone(input); changed.items[0].draft.prompt += ' 新剧情';
  const updated = await h.engine.startBatch(changed);
  assert.equal(updated.taskIds.length, 3, '前段提示词变化时必须连带使依赖子段指纹失效');
  await waitFor(() => posts(h).length === 6, '新剧情整链未提交');
  const partial = structuredClone(input); partial.items[2].draft.prompt += ' 仅改第三段';
  await assert.rejects(h.engine.startBatch(partial), /部分视频已生成/u);
  assert.equal(posts(h).length, 6); assert.equal(tasks(h).length, first.taskIds.length + updated.taskIds.length);
  h.engine.dispose();
}

// The final input replaces the selected slot with the future tail. The old
// slot's original bytes are no longer an input, so they need not still exist.
{
  const h = makeHarness(); const input = chainInput(h.holder().project.id);
  for (const [index, item] of input.items.entries()) {
    if (!item.previousTail) continue;
    item.draft.references = [{ assetId: `deleted-old-image-${index}`, role: 'first-frame' }];
    item.draft.referenceSlotRoles = ['composition', 'prop', 'character'];
    item.previousTail.placement = { mode: 'replace', index: 0, role: 'first-frame', replacedAssetId: `deleted-old-image-${index}` };
  }
  const originalInput = structuredClone(input);
  const batch = await h.engine.startBatch(input);
  await waitFor(() => batch.taskIds.every((taskId) => Boolean(tasks(h).find((task) => task.id === taskId)?.resultAssetId)), '替换旧图后链未完成');
  assert.equal(posts(h).length, 3);
  assert.deepEqual(input, originalInput, '尾帧替换不能修改UI传入的选图');
  for (const task of tasks(h).slice(1)) {
    assert.equal(task.videoJob?.snapshot.images.length, 1);
    assert.ok(task.videoJob?.snapshot.images[0].assetId.startsWith('asset_tail_frame_'));
    assert.ok(!task.videoJob?.snapshot.images.some((image) => image.assetId.startsWith('deleted-old-image-')));
    assert.deepEqual(task.videoJob?.snapshot.draft.referenceSlotRoles, ['first-frame', 'prop', 'character'], 'replace must preserve the confirmed tail role and every other per-segment empty-slot purpose');
  }
  const changed = structuredClone(input); changed.force = true;
  changed.items[1].draft.references.push({ assetId: 'missing-retained-reference', role: 'general' });
  await assert.rejects(h.engine.startBatch(changed), /所选图片已不存在/u, '其它未替换的缺失选图仍须在首段POST之前拦截');
  assert.equal(posts(h).length, 3);
  const invalid = structuredClone(input); invalid.force = true;
  invalid.items[1].previousTail!.placement.replacedAssetId = 'wrong-old-image-id';
  await assert.rejects(h.engine.startBatch(invalid), /尾帧替换位置已改变/u, '替换确认失效时不能偷偷替换其它选图');
  assert.equal(posts(h).length, 3);
  h.engine.dispose();
}

// One-image API replacement must project final inputs before any old asset read.
{
  const h = makeHarness(); const input = chainInput(h.holder().project.id);
  h.mutate((state) => ({ ...state, settings: { ...state.settings, videoTaskApi: {
    ...config, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', image_url: '{{first_image}}' }),
  } }, project: { ...state.project, assets: [{
    id: 'original-storyboard', name: '保留的原分镜图', type: 'reference', role: 'composition', referenceRole: 'subject', mediaType: 'image',
    relativePath: 'image/old-board.png', checksum: 'old-image', missing: true, tags: [], createdAt: 1, updatedAt: 1,
  }] } }));
  const originalAssets = structuredClone(h.holder().project.assets);
  const read = h.desktop.readManagedImageDataUrl!;
  h.desktop.readManagedImageDataUrl = async (request) => {
    assert.notEqual(request.relativePath, 'image/old-board.png', '替换全部参考图后不能读取旧分镜文件');
    return read(request);
  };
  for (const item of input.items.slice(1)) {
    item.draft.references = [{ assetId: 'original-storyboard', role: 'subject' }, { assetId: 'nonexistent-character', role: 'character' }];
    item.draft.referenceSlotRoles = ['subject', 'character', 'prop'];
    item.previousTail!.placement = { mode: 'replace-all', index: 0, role: 'first-frame', replacedReferences: structuredClone(item.draft.references) };
  }
  const originalInput = structuredClone(input);
  const batch = await h.engine.startBatch(input);
  await waitFor(() => batch.taskIds.every((taskId) => Boolean(tasks(h).find((task) => task.id === taskId)?.resultAssetId)), '单图模板整体替换的链未完成');
  assert.equal(posts(h).length, 3); assert.equal(h.extractions.length, 2);
  for (const [index, task] of tasks(h).slice(1).entries()) {
    assert.equal(task.videoJob?.snapshot.images.length, 1); assert.equal(task.videoJob?.snapshot.draft.references.length, 1);
    assert.equal(task.videoJob?.snapshot.images[0].assetId, task.videoJob?.snapshot.previousTail?.reservedFrameAssetId);
    assert.equal(task.videoJob?.snapshot.previousTail?.referenceIndex, 0);
    assert.deepEqual(task.videoJob?.snapshot.draft.referenceSlotRoles, ['first-frame'], 'replace-all resets purpose memory to the one confirmed tail slot');
    assert.equal(JSON.parse(posts(h)[index + 1].body!).image_url, `data:image/png;base64,tail-${index + 1}`);
    assert.deepEqual(task.requestBody.referenceAssetIds, task.videoJob?.snapshot.draft.references.map((reference) => reference.assetId));
    assert.ok(!JSON.stringify(task.videoJob?.snapshot.images).includes('original-storyboard'));
  }
  assert.deepEqual(input, originalInput, '任务不能改写UI原始选图');
  assert.deepEqual(h.holder().project.assets.filter((asset) => asset.id === 'original-storyboard'), originalAssets, '仅替换绑定，不删除或修改原图片资产');
  const invalid = structuredClone(input); invalid.force = true;
  invalid.items[1].draft.references[1].role = 'scene';
  await assert.rejects(h.engine.startBatch(invalid), /参考图已变化/u, '整体替换必须绑定确认时的完整选图与用途');
  assert.equal(posts(h).length, 3);
  h.mutate((state) => ({ ...state, settings: { ...state.settings, videoTaskApi: config } }));
  await assert.rejects(h.engine.startBatch({ ...input, force: true }), /整体替换只适用于/u, '更换为多图连接之后不得偷用旧的全部替换确认');
  assert.equal(posts(h).length, 3); h.engine.dispose();
}

// Replacing one slot must preserve the bytes and identity of every other slot,
// including another binding that uses the very same original image asset.
{
  const h = makeHarness(); const input = chainInput(h.holder().project.id); input.items.splice(2, 1);
  h.mutate((state) => ({ ...state, project: { ...state.project, assets: [{
    id: 'shared-original', name: '保留的人物图', type: 'reference', role: 'composition', mediaType: 'image',
    dataUrl: 'data:image/png;base64,retained-character', tags: [], createdAt: 1, updatedAt: 1,
  }] } }));
  input.items[1].draft.references = [
    { assetId: 'shared-original', role: 'first-frame' },
    { assetId: 'shared-original', role: 'general' },
  ];
  input.items[1].previousTail!.placement = { mode: 'replace', index: 0, role: 'first-frame', replacedAssetId: 'shared-original' };
  const batch = await h.engine.startBatch(input);
  await waitFor(() => Boolean(tasks(h).find((task) => task.id === batch.taskIds[1])?.resultAssetId), '多参考图替换未完成');
  const body = JSON.parse(posts(h)[1].body || '{}');
  assert.match(body.first_frame_image, /^data:image\/png;base64,tail-1/u);
  assert.deepEqual(body.images, ['data:image/png;base64,tail-1', 'data:image/png;base64,retained-character']);
  assert.equal(tasks(h)[1].videoJob?.snapshot.images[1].assetId, 'shared-original', '相同图片的另一个保留槽必须仍有真实像素');
  assert.ok(h.holder().project.assets.some((asset) => asset.id === 'shared-original'), '替换参考绑定不能删除原资产');
  h.engine.dispose();
}

// Explicit regeneration starts a NEW entire chain: a matching request
// fingerprint must not reuse old predecessor tasks or their extracted frames.
{
  const h = makeHarness(); const input = chainInput(h.holder().project.id);
  const first = await h.engine.startBatch(input);
  await waitFor(() => tasks(h).length === 3 && tasks(h).every((task) => Boolean(task.resultAssetId)), '首批没有完整保存');
  await settle();
  const originals = structuredClone(tasks(h));
  const originalAssets = structuredClone(h.holder().project.assets);
  const repeated = await h.engine.startBatch({ ...structuredClone(input), force: true });
  assert.equal(repeated.taskIds.length, 3, '用户确认再生成时必须创建全部三段的新任务');
  assert.notEqual(repeated.batchId, first.batchId);
  assert.ok(repeated.taskIds.every((taskId) => !first.taskIds.includes(taskId)));
  const repeatedTasks = () => repeated.taskIds.map((taskId) => tasks(h).find((task) => task.id === taskId)!);
  await waitFor(() => repeatedTasks().every((task) => Boolean(task?.resultAssetId)), '确认再生成后新链没有完整保存');
  assert.equal(posts(h).length, 6);
  assert.equal(h.extractions.length, 4, '每一批只为两个后段各抽取一次尾帧');
  const fresh = repeatedTasks();
  assert.equal(fresh[1].videoJob?.snapshot.previousTail?.predecessorTaskId, fresh[0].id);
  assert.equal(fresh[2].videoJob?.snapshot.previousTail?.predecessorTaskId, fresh[1].id);
  assert.deepEqual(h.extractions.slice(2).map((entry) => (entry.source as { assetId: string }).assetId), fresh.slice(0, 2).map((task) => task.resultAssetId));
  assert.match(JSON.parse(posts(h)[4].body || '{}').first_frame_image, /^data:image\/png;base64,tail-3/u);
  assert.match(JSON.parse(posts(h)[5].body || '{}').first_frame_image, /^data:image\/png;base64,tail-4/u);
  for (const original of originals) assert.deepEqual(tasks(h).find((task) => task.id === original.id), original, '再生成不能改写旧任务');
  for (const asset of originalAssets) assert.deepEqual(h.holder().project.assets.find((candidate) => candidate.id === asset.id), asset, '再生成不能覆盖旧视频/尾帧');
  const duplicate = await h.engine.startBatch(input);
  assert.equal(duplicate.taskIds.length, 0, '无明确再生成授权仍须保持整链去重');
  assert.equal(duplicate.skipped.length, 3);
  h.engine.dispose();
}

for (const recovery of ['ready', 'cancelled'] as const) {
  const h = makeHarness(); const wait = deferred(); const save = h.desktop.saveVideoTaskCheckpoint!;
  const extract = h.desktop.extractWorkbenchFrames!; let oldMain: AppState | undefined; let readyMain: AppState | undefined; let reached = false;
  h.desktop.extractWorkbenchFrames = async (input) => { oldMain = structuredClone(h.holder()); return extract(input); };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    const result = await save(task);
    if (!reached && task.videoJob?.tailPreparation?.phase === 'ready') {
      reached = true; readyMain = structuredClone(h.holder()); await wait.promise;
    }
    return result;
  };
  const input = chainInput(h.holder().project.id); input.items.splice(2, 1);
  const batch = await h.engine.startBatch(input); await waitFor(() => reached, '重启回归没有拿到ready断点');
  if (recovery === 'cancelled') await h.engine.cancel(batch.taskIds[1]);
  h.engine.dispose(); wait.resolve(); await settle();
  const checkpoint = h.checkpoints.get(batch.taskIds[1])!;
  assert.equal(checkpoint.videoJob?.tailPreparation?.phase, recovery);
  const stale = recovery === 'ready' ? oldMain! : readyMain!;
  const child = stale.project.generationTasks.find((task) => task.id === batch.taskIds[1])!;
  child.updatedAt = Date.now() + 1_000_000; // newer autosave timestamp is not tail-progress authorization.
  if (recovery === 'ready') stale.project.assets = stale.project.assets.filter((asset) => asset.source !== 'derived');
  h.mutate(() => stale); h.desktop.saveVideoTaskCheckpoint = save;
  h.engine = new VideoGenerationEngine(h.options);
  if (recovery === 'cancelled') await assert.rejects(h.engine.resume(batch.taskIds[1]), /取消/u);
  else h.engine.reconcile();
  if (recovery === 'ready') {
    await waitFor(() => posts(h).length === 2, '新journal ready未覆盖旧main extracting');
    assert.equal(h.extractions.length, 1, '恢复ready帧不能再次抽取');
    assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 1, 'ready journal帧应恢复到所属项目');
  } else {
    await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'cancelled', '新cancelled断点未压过旧ready main');
    await settle(); assert.equal(posts(h).length, 1, '已取消任务重启后不能复活提交');
    assert.equal(tasks(h)[1].videoJob?.trackingStopped, true);
  }
  h.engine.dispose();
}

{
  const h = makeHarness(); const save = h.desktop.saveVideoTaskCheckpoint!; const authorized: number[] = []; let oldMain: AppState | undefined;
  h.options.persistState = async () => { if (!oldMain && tasks(h).length) oldMain = structuredClone(h.holder()); };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (task.videoJob?.batchQueueState === 'ready') {
      authorized.push(task.batchIndex!);
      if (task.batchIndex === 2) throw new Error('模拟中间段初始化断点无法落盘');
    }
    return save(task);
  };
  await assert.rejects(h.engine.startBatch(chainInput(h.holder().project.id)), /中间段初始化/u);
  assert.deepEqual(authorized, [3, 2], '链必须从后向前授权，首段最后才可ready');
  assert.equal(posts(h).length, 0); assert.ok(tasks(h).every((task) => task.videoJob?.batchQueueState === 'cancelled'));
  assert.equal(h.checkpoints.size, 3); assert.ok([...h.checkpoints.values()].every((task) => task.videoJob?.batchQueueState === 'cancelled'), '所有已写ready记录必须持久化取消墓碑');
  h.engine.dispose(); h.mutate(() => oldMain!); h.desktop.saveVideoTaskCheckpoint = save;
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile(); await settle();
  assert.equal(posts(h).length, 0, '旧main waiting不能复活报告失败的批次');
  assert.ok(tasks(h).every((task) => task.videoJob?.batchQueueState === 'cancelled')); h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); const save = h.desktop.saveVideoTaskCheckpoint!; let boundary = false; let oldMain: AppState | undefined;
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    const result = await save(task);
    if (!boundary && task.batchIndex === 2 && task.videoJob?.preparation?.phase === 'post-started') {
      boundary = true; oldMain = structuredClone(h.holder()); await wait.promise;
    }
    return result;
  };
  const input = chainInput(h.holder().project.id); input.items.splice(2, 1);
  const batch = await h.engine.startBatch(input); await waitFor(() => boundary, '未创建可信可能POST边界');
  h.engine.dispose(); wait.resolve(); await settle();
  const invalid = oldMain!.project.generationTasks.find((task) => task.id === batch.taskIds[1]) as VideoGenerationTask;
  invalid.videoJob!.snapshot.previousTail!.version = 2 as 1;
  h.mutate(() => oldMain!); h.desktop.saveVideoTaskCheckpoint = save;
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => tasks(h)[1].status === 'unknown', '损坏依赖与可信POST断点不匹配时必须保留未知状态');
  assert.equal(cancelledVideoBatchTaskBeforePost(tasks(h)[1]), false);
  await h.engine.cancelBatch(batch.batchId); await h.engine.cancel(batch.taskIds[1]);
  assert.equal(tasks(h)[1].status, 'unknown', '停止未知任务不能伪标确定未提交');
  assert.equal(cancelledVideoBatchTaskBeforePost(tasks(h)[1]), false);
  const replay = await h.engine.startBatch(input); assert.equal(replay.taskIds.length, 0); assert.equal(posts(h).length, 1, '未决旧POST必须继续挡住重复提交');
  h.engine.dispose();
}

for (const { cancelUpload, role, replaceAll } of [
  { cancelUpload: false, role: 'first-frame' as const, replaceAll: false },
  { cancelUpload: true, role: 'first-frame' as const, replaceAll: false },
  { cancelUpload: false, role: 'first-frame' as const, replaceAll: true },
  { cancelUpload: true, role: 'first-frame' as const, replaceAll: true },
  { cancelUpload: false, role: 'general' as const, replaceAll: true },
]) {
  const h = makeHarness(); const wait = deferred(); const uploaded: string[] = []; const prompts: Array<Record<string, any>> = [];
  h.mutate((state) => ({ ...state, project: { ...state.project, assets: [{ id: 'manual-first', name: '首段手选参考图', type: 'reference', role: 'composition', dataUrl: 'data:image/png;base64,manual-first', tags: [], createdAt: 1, updatedAt: 1 }] }, settings: { ...state.settings, comfyuiVideo: {
    enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', activeWorkflowId: 'first-frame', workflows: [{
      id: 'first-frame', name: '首帧视频', workflowJson: JSON.stringify({
        '1': { class_type: 'TextNode', inputs: { text: '' } }, '2': { class_type: 'LoadImage', inputs: { image: '' } }, '3': { class_type: 'SaveVideo', inputs: { images: ['2', 0] } },
      }), mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [{ nodeId: '2', inputName: 'image', role }], outputNodeId: '3' }, createdAt: 1, updatedAt: 1,
    }],
  } } }));
  h.desktop.videoRequest = async (request) => {
    h.requests.push(request);
    if (request.url.endsWith('/upload/image')) {
      uploaded.push(request.multipart!.files[0].dataUrl);
      if (uploaded.length === 2 && cancelUpload) await wait.promise;
      return response({ name: `uploaded-${uploaded.length}.png` });
    }
    if (request.url.endsWith('/prompt')) { prompts.push(JSON.parse(request.body!)); return response({ prompt_id: `comfy-chain-${prompts.length}` }); }
    if (request.url.includes('/history/')) {
      const taskId = request.url.split('/').pop()!;
      return response({ [taskId]: { status: { completed: true, status_str: 'success' }, outputs: { '3': { videos: [{ filename: `${taskId}.mp4`, type: 'output' }] } } } });
    }
    return response({ queue_pending: [], queue_running: [] });
  };
  const input = chainInput(h.holder().project.id); input.items.forEach((item) => { item.draft.backend = 'comfyui'; item.draft.workflowId = 'first-frame'; });
  input.items[0].draft.references = [{ assetId: 'manual-first', role }];
  if (replaceAll) for (const item of input.items.slice(1)) {
    item.draft.references = [{ assetId: 'missing-storyboard', role: 'subject' }, { assetId: 'missing-character', role: 'character' }];
    item.previousTail!.placement = { mode: 'replace-all', index: 0, role, replacedReferences: structuredClone(item.draft.references) };
  }
  const batch = await h.engine.startBatch(input);
  if (cancelUpload) {
    await waitFor(() => uploaded.length === 2, 'Comfy第二段未开始上传真实尾帧');
    await h.engine.cancelBatch(batch.batchId); wait.resolve(); await settle();
    assert.equal(prompts.length, 1, '取消Comfy尾帧上传后不得继续POST /prompt');
  } else {
    await waitFor(() => prompts.length === 3, 'Comfy链没有完成三个按顺序的/prompt');
    assert.deepEqual(uploaded, ['data:image/png;base64,manual-first', 'data:image/png;base64,tail-1', 'data:image/png;base64,tail-2']);
    assert.deepEqual(prompts.map((body) => body.prompt['2'].inputs.image), ['uploaded-1.png', 'uploaded-2.png', 'uploaded-3.png']);
    assert.equal(h.extractions.length, 2);
    for (const task of tasks(h).slice(1)) {
      assert.equal(task.videoJob?.snapshot.images.length, 1); assert.equal(task.videoJob?.snapshot.images[0].role, role);
      assert.equal(task.videoJob?.snapshot.draft.references.length, 1);
    }
  }
  h.engine.dispose();
}

{
  const h = makeHarness(); const original = h.desktop.videoRequest;
  h.desktop.videoRequest = async (request) => {
    if (request.method === 'POST' && posts(h).length === 1) { h.requests.push(request); throw new Error('模拟已发送后连接中断'); }
    return original(request);
  };
  const input = chainInput(h.holder().project.id); input.items.splice(2, 1);
  const batch = await h.engine.startBatch(input);
  await waitFor(() => tasks(h)[1]?.videoJob?.stage === 'submission-unknown', 'POST不确定没有保存边界');
  const snapshot = structuredClone(h.holder());
  h.engine.dispose(); h.mutate(() => snapshot); h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await settle(); assert.equal(posts(h).length, 2);
  await assert.rejects(h.engine.resume(batch.taskIds[1]), /没有远端任务 ID/u);
  assert.equal(posts(h).length, 2, '重启/恢复不能重复POST已跨过边界的依赖任务'); h.engine.dispose();
}

{
  const h = makeHarness();
  h.mutate((state) => ({ ...state, settings: { ...state.settings, comfyuiVideo: {
    enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', activeWorkflowId: 'text-only', workflows: [{
      id: 'text-only', name: '纯文生视频无图像槽', workflowJson: JSON.stringify({ '1': { class_type: 'TextNode', inputs: { text: '' } } }),
      mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [] }, createdAt: 1, updatedAt: 1,
    }],
  } } }));
  const input = chainInput(h.holder().project.id); input.items.forEach((item) => { item.draft.backend = 'comfyui'; item.draft.workflowId = 'text-only'; });
  await assert.rejects(h.engine.startBatch(input), /图片|图像/u); assert.equal(posts(h).length, 0); assert.equal(tasks(h).length, 0);
  h.engine.dispose();
}

// A ZIP may contain several valid videos. None is an implicit primary: the
// first dependent video must wait for the user's explicit, durable selection.
{
  const h = makeHarness(); const download = h.desktop.downloadGeneratedMedia; let downloadCount = 0;
  h.desktop.downloadGeneratedMedia = async (input) => {
    downloadCount += 1;
    return downloadCount === 1 ? { ...movie('zip-choice-A'), additionalVideos: [movie('zip-choice-B')], archiveFileName: 'alternatives.zip' } : download(input);
  };
  const batch = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h)[0]?.videoJob?.resultSelectionRequired === true, 'ZIP多视频未进入待选择状态');
  await settle(); h.engine.reconcile(); await h.engine.resume(batch.taskIds[1]); await settle();
  assert.equal(posts(h).length, 1); assert.equal(h.extractions.length, 0);
  assert.equal(tasks(h)[0].resultAssetId, undefined); assert.equal(tasks(h)[0].videoJob!.resultAssetIds!.length, 2);
  assert.match(tasks(h)[1].videoJob!.tailPreparation!.message!, /选择/u);
  const chosen = tasks(h)[0].videoJob!.resultAssetIds![1]; const hold = deferred(); let hit = false;
  h.options.persistState = async () => { if (!hit && tasks(h)[0].resultAssetId === chosen) { hit = true; await hold.promise; } };
  const selecting = h.engine.selectResultVideo(batch.taskIds[0], chosen);
  await waitFor(() => hit, '成片选择未进入持久化门槛');
  h.engine.reconcile(); await h.engine.resume(batch.taskIds[1]); await settle();
  assert.equal(posts(h).length, 1, '选择记录落盘前不能提交后段'); assert.equal(h.extractions.length, 0);
  hold.resolve(); await selecting;
  await waitFor(() => posts(h).length === 3, '选择成片后没有继续尾帧链');
  assert.equal((h.extractions[0].source as { assetId: string }).assetId, chosen, '尾帧必须来自明确选中的ZIP视频，不是第一条');
  assert.equal(downloadCount, 3, '选择成片不重新下载整个ZIP'); h.engine.dispose();
}

{
  const h = makeHarness(); const download = h.desktop.downloadGeneratedMedia; let count = 0;
  h.desktop.downloadGeneratedMedia = async (input) => ++count === 1
    ? { ...movie('journal-choice-A'), additionalVideos: [movie('journal-choice-B')], archiveFileName: 'choices.zip' } : download(input);
  const batch = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h)[0]?.videoJob?.resultSelectionRequired === true, '选择断点测试未收到多视频'); await settle();
  const save = h.desktop.saveVideoTaskCheckpoint!; let fail = true;
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (fail && task.id === batch.taskIds[0] && task.resultAssetId) throw new Error('选择断点写入失败');
    return save(task);
  };
  await assert.rejects(h.engine.selectResultVideo(batch.taskIds[0], tasks(h)[0].videoJob!.resultAssetIds![1]), /断点/u);
  h.engine.reconcile(); await settle();
  assert.equal(posts(h).length, 1); assert.equal(h.extractions.length, 0); assert.ok(tasks(h)[0].videoJob!.downloadError);
  fail = false; await h.engine.retryDownload(batch.taskIds[0]);
  await waitFor(() => posts(h).length === 3, '重试选择断点后未继续尾帧链'); assert.equal(count, 3); h.engine.dispose();
}

{
  const h = makeHarness(); let count = 0; const download = h.desktop.downloadGeneratedMedia;
  h.desktop.downloadGeneratedMedia = async (input) => ++count === 1
    ? { ...movie('cancel-choice-A'), additionalVideos: [movie('cancel-choice-B')], archiveFileName: 'cancel.zip' } : download(input);
  const batch = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h)[0]?.videoJob?.resultSelectionRequired === true, '选择取消测试未收到多视频'); await settle();
  const wait = deferred(); let hit = false;
  h.options.persistState = async () => { if (!hit && tasks(h)[0].resultAssetId) { hit = true; await wait.promise; } };
  const selecting = h.engine.selectResultVideo(batch.taskIds[0], tasks(h)[0].videoJob!.resultAssetIds![1]);
  await waitFor(() => hit, '选择取消测试没有到达主文件持久化');
  await h.engine.cancel(batch.taskIds[0]); wait.resolve(); await assert.rejects(selecting, /停止/u); await settle();
  assert.equal(posts(h).length, 1); assert.equal(h.extractions.length, 0); assert.equal(tasks(h)[0].videoJob!.trackingStopped, true); h.engine.dispose();
}

{
  const h = makeHarness(); let analyses = 0;
  h.options.selectTailFrame = async () => { analyses += 1; return aiSelection(); };
  await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => posts(h).length === 3, '默认直接尾帧没有继续');
  assert.equal(analyses, 0, '旧任务与默认模式不得悄悄增加收费分析');
  assert.ok(tasks(h).every((task) => task.videoJob?.tailPreparation?.selection === undefined));
  h.engine.dispose();
}

for (const source of ['ai', 'last-frame'] as const) {
  const h = makeHarness(); const input = aiInput(h.holder().project.id); let analyses = 0; const warnings: string[] = [];
  input.items[0].draft.prompt = '上一段完整文本'.repeat(2200);
  input.items[1].draft.prompt = '下一段完整文本'.repeat(2400);
  const expected = structuredClone(input);
  h.options.notify = (message) => { warnings.push(message); };
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.maxAiAttempts, 1, '旧非严格模式不得悄悄增加付费尝试');
    assert.equal(request.previousPrompt, expected.items[0].draft.prompt, '不能本地截断上一段剧情');
    assert.equal(request.nextPrompt, expected.items[1].draft.prompt, '不能本地抽取或改写下一段剧情');
    await request.onBeforeAI!(); analyses += 1;
    assert.equal(h.checkpoints.get(tasks(h)[1].id)?.videoJob?.tailPreparation?.selection?.status, 'started', '收费分析前必须独立持久化开始边界');
    assert.equal(posts(h).length, 1, '分析未完成不得提交下一段');
    return aiSelection(source);
  };
  await h.engine.startBatch(input);
  await waitFor(() => posts(h).length === 2, 'AI选帧或AI失败回退未继续下一段');
  assert.equal(analyses, 1);
  const child = tasks(h)[1]; const selection = child.videoJob!.tailPreparation!.selection!;
  assert.equal(selection.status, 'completed'); assert.equal(selection.source, source);
  assert.equal(selection.reason, aiSelection(source).selection.reason, '不应根据不露脸、非人类或遮挡等语义否决AI选帧');
  assert.equal(selection.frame?.checksum, 'tail-101');
  assert.match(JSON.parse(posts(h)[1].body!).first_frame_image, /tail-101/u);
  assert.equal(child.videoJob!.snapshot.previousTail!.selectionMode, 'ai-assisted');
  assert.equal(child.videoJob!.snapshot.draft.prompt, expected.items[1].draft.prompt, '不能把AI解释拼接或覆盖生成提示词');
  assert.ok(warnings.some((message) => message === selection.warning), '回退或早帧必须有可见提醒');
  assert.deepEqual(input, expected, '不得改写用户批量输入');
  h.engine.dispose();
}

{
  const h = makeHarness(); await h.engine.startBatch(aiInput(h.holder().project.id));
  await waitFor(() => posts(h).length === 2, '没有可用AI服务时应回退真实尾帧继续');
  const selection = tasks(h)[1].videoJob!.tailPreparation!.selection!;
  assert.equal(selection.source, 'last-frame'); assert.match(selection.warning!, /不可用.*回退/u);
  assert.equal(h.extractions.length, 1); h.engine.dispose();
}

for (const stop of ['cancel', 'delete'] as const) {
  const h = makeHarness(); const wait = deferred(); let signal: AbortSignal | undefined; let entered = false;
  h.options.selectTailFrame = async (request) => { await request.onBeforeAI!(); signal = request.signal; entered = true; await wait.promise; return aiSelection(); };
  const batch = await h.engine.startBatch(aiInput(h.holder().project.id));
  await waitFor(() => entered, '未开始AI选帧取消回归');
  if (stop === 'cancel') await h.engine.cancel(batch.taskIds[1]);
  else {
    h.mutate((state) => ({ ...state, project: { ...state.project, generationTasks: state.project.generationTasks.filter((task) => task.id !== batch.taskIds[1]) } }));
    h.engine.reconcile();
  }
  assert.equal(signal?.aborted, true, '取消或删除必须中止视觉请求及其实际抽帧子任务');
  wait.resolve(); await settle();
  assert.equal(posts(h).length, 1, '迟到的AI选择不能复活已取消/删除任务');
  assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 0);
  if (stop === 'cancel') assert.equal(h.checkpoints.get(batch.taskIds[1])?.videoJob?.tailPreparation?.phase, 'cancelled');
  h.engine.dispose();
}

{
  const h = makeHarness(); const wait = deferred(); let entered = false; const ownerId = h.holder().project.id;
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.projectId, ownerId); assert.equal(request.nextPrompt, draft(2).prompt);
    await request.onBeforeAI!(); entered = true; await wait.promise; return aiSelection();
  };
  await h.engine.startBatch(aiInput(ownerId));
  await waitFor(() => entered, '跨项目选帧未进入AI');
  h.mutate((state) => ({ ...state, project: { ...createInitialState().project, id: 'other-ai-project' }, projects: [state.project] }));
  wait.resolve(); await waitFor(() => posts(h).length === 2, '后台原项目AI尾帧链未继续');
  assert.equal(h.holder().project.assets.length, 0, '不能把AI帧或结果串写到当前新项目');
  const owner = h.holder().projects.find((project) => project.id === ownerId)!;
  assert.equal(owner.assets.filter((asset) => asset.source === 'derived').length, 1);
  assert.equal((owner.generationTasks[1] as VideoGenerationTask).videoJob?.snapshot.projectId, ownerId);
  h.engine.dispose();
}

for (const changedField of ['relativePath', 'checksum'] as const) {
  const h = makeHarness(); const wait = deferred(); let entered = false;
  h.options.selectTailFrame = async (request) => { await request.onBeforeAI!(); entered = true; await wait.promise; return aiSelection(); };
  await h.engine.startBatch(aiInput(h.holder().project.id)); await waitFor(() => entered, 'AI选帧来源变化回归未进入分析');
  const predecessorAssetId = tasks(h)[0].resultAssetId;
  h.mutate((state) => ({ ...state, project: { ...state.project, assets: state.project.assets.map((asset) => asset.id === predecessorAssetId
    ? { ...asset, [changedField]: changedField === 'relativePath' ? 'video/replaced-during-ai.mp4' : 'replaced-during-ai' } : asset) } }));
  wait.resolve(); await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', 'AI来源变化后仍采纳迟到结果');
  assert.equal(posts(h).length, 1); assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 0);
  h.engine.dispose();
}

for (const interruptedAt of ['started', 'completed', 'ready'] as const) {
  const h = makeHarness(); const wait = deferred(); let analyses = 0; let entered = false; let staleMain: AppState | undefined;
  const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  h.options.selectTailFrame = async (request) => {
    staleMain = structuredClone(h.holder());
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 1, maxTokens: 4096 }); analyses += 1;
    if (interruptedAt === 'started') { entered = true; await wait.promise; }
    return aiSelection();
  };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    const saved = await originalSave(task);
    if (!entered && task.videoJob?.tailPreparation?.selection?.status === 'completed'
      && task.videoJob.tailPreparation.phase === (interruptedAt === 'ready' ? 'ready' : 'extracting')) {
      entered = true; await wait.promise;
    }
    return saved;
  };
  const batch = await h.engine.startBatch(aiInput(h.holder().project.id)); await waitFor(() => entered, 'AI恢复回归未到断点');
  assert.ok(staleMain);
  const staleChild = staleMain!.project.generationTasks.find((task) => task.id === batch.taskIds[1])!;
  staleChild.updatedAt = Date.now() + 1_000_000;
  h.engine.dispose(); wait.resolve(); await settle();
  h.mutate(() => staleMain!); h.desktop.saveVideoTaskCheckpoint = originalSave;
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => posts(h).length === 2, '旧main恢复未继续原链');
  assert.equal(analyses, 1, '重启或主文件落后不能重复调用计费选帧AI');
  const restored = tasks(h)[1].videoJob!.tailPreparation!.selection!;
  assert.equal(restored.status, 'completed');
  if (interruptedAt === 'started') {
    assert.equal(restored.source, 'last-frame'); assert.match(restored.warning!, /避免重复收费/u);
    assert.equal(h.extractions.length, 1, '未知AI结果只重新抽取真实尾帧，不调用AI');
  } else {
    assert.equal(restored.source, 'ai'); assert.equal(restored.frame?.checksum, 'tail-101');
    assert.equal(h.extractions.length, 0, '已保存选帧必须重用精确图片，不再次抽取');
  }
  assert.equal(h.holder().project.assets.filter((asset) => asset.source === 'derived').length, 1);
  h.engine.dispose();
}

for (const failureAt of ['completed', 'ready'] as const) {
  const h = makeHarness(); let analyses = 0; let fail = true; const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  h.options.selectTailFrame = async (request) => { await request.onBeforeAI!({ attempt: 1, maxAttempts: 1, maxTokens: 4096 }); analyses += 1; return aiSelection(); };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (fail && task.videoJob?.tailPreparation?.selection?.status === 'completed'
      && task.videoJob.tailPreparation.phase === (failureAt === 'ready' ? 'ready' : 'extracting')) throw new Error('模拟AI选择保存失败');
    return originalSave(task);
  };
  const batch = await h.engine.startBatch(aiInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', 'AI选帧记录写入失败未暂停');
  assert.equal(posts(h).length, 1); assert.equal(analyses, 1);
  fail = false; await h.engine.resume(batch.taskIds[1]);
  await waitFor(() => posts(h).length === 2, '重试持久化AI结果未恢复');
  assert.equal(analyses, 1, '持久化重试不得重复收费分析');
  assert.match(JSON.parse(posts(h)[1].body!).first_frame_image, /tail-101/u, '重试必须保留原AI选帧');
  assert.equal(h.extractions.length, 0); h.engine.dispose();
}

{
  const h = makeHarness(); let actualAiRequests = 0; const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  h.options.selectTailFrame = async (request) => { await request.onBeforeAI!(); actualAiRequests += 1; return aiSelection(); };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (task.videoJob?.tailPreparation?.selection?.status === 'started') throw new Error('收费分析边界不能落盘');
    return originalSave(task);
  };
  await h.engine.startBatch(aiInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', 'AI收费前记录写失败未停止');
  assert.equal(actualAiRequests, 0); assert.equal(posts(h).length, 1);
  h.engine.dispose();
}

{
  const direct = chainInput('fingerprint-project').items[1].previousTail!;
  const automatic = { ...direct, selectionMode: 'ai-assisted' as const };
  assert.equal(videoBatchDependencyFingerprint('base', direct, 'parent'), videoBatchDependencyFingerprint('base', { ...direct }, 'parent'));
  assert.notEqual(videoBatchDependencyFingerprint('base', direct, 'parent'), videoBatchDependencyFingerprint('base', automatic, 'parent'), '选帧策略改变必须改变依赖指纹');
}

for (const failure of ['unavailable', 'fallback', 'request-error'] as const) {
  const h = makeHarness(); const input = aiInput(h.holder().project.id); let analyses = 0;
  input.items[1].previousTail!.requireAiSelection = true;
  if (failure !== 'unavailable') h.options.selectTailFrame = async (request) => {
    assert.equal(request.requireAiSelection, true); await request.onBeforeAI!(); analyses += 1;
    if (failure === 'request-error') throw new Error('模拟视觉 API 失败');
    return aiSelection('last-frame');
  };
  const batch = await h.engine.startBatch(input);
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '严格AI失败没有保留待处理状态');
  assert.equal(posts(h).length, 1); assert.equal(h.extractions.length, 0, '严格AI不能偷偷使用原尾帧');
  assert.equal(tasks(h)[1].videoJob!.snapshot.previousTail!.requireAiSelection, true);
  const initialCalls = analyses; h.engine.reconcile(); await settle(); assert.equal(analyses, initialCalls, '后台恢复不重复收费');
  h.options.selectTailFrame = async (request) => { assert.equal(request.requireAiSelection, true); await request.onBeforeAI!(); analyses += 1; return aiSelection(); };
  await h.engine.resume(batch.taskIds[1]);
  await waitFor(() => posts(h).length === 2, '明确点击重试后严格AI没有恢复');
  assert.equal(analyses, initialCalls + 1); assert.equal(h.extractions.length, 0);
  assert.equal(tasks(h)[1].videoJob!.tailPreparation!.selection!.source, 'ai'); h.engine.dispose();
}

// AI owns semantic repair. The engine only persists every actual request's
// bounded paid boundary, and never recreates a completed predecessor video.
for (const successAt of [2, 3, 4]) {
  const h = makeHarness(); const seen: number[] = []; const persisted: number[] = [];
  h.options.persistState = async () => {
    const selection = tasks(h)[1]?.videoJob?.tailPreparation?.selection;
    if (selection?.status === 'started') persisted.push(selection.attempt!);
  };
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.maxAiAttempts, 4);
    for (let attempt = 1; attempt <= successAt; attempt += 1) {
      const boundary = { attempt, maxAttempts: 4, maxTokens: 4096 * 2 ** (attempt - 1) };
      await request.onBeforeAI!(boundary);
      seen.push(attempt);
      assert.equal(persisted.at(-1), attempt, '每次请求都必须先保存项目记录');
      assert.deepEqual(h.checkpoints.get(tasks(h)[1].id)?.videoJob?.tailPreparation?.selection, { status: 'started', run: 1, ...boundary });
      assert.equal(posts(h).length, 1, 'AI重试不重生成上一段，也不提前提交下一段');
    }
    return aiSelection();
  };
  await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => posts(h).length === 2, `第${successAt}次AI尝试成功后未继续`);
  assert.deepEqual(seen, Array.from({ length: successAt }, (_, index) => index + 1));
  const child = tasks(h)[1];
  assert.equal(child.videoJob!.snapshot.previousTail!.aiMaxAttempts, 4);
  assert.equal(child.videoJob!.tailPreparation!.selection!.attempt, successAt);
  const restored = normalizeState(JSON.parse(JSON.stringify(h.holder()))).project.generationTasks.find((task) => task.id === child.id) as VideoGenerationTask;
  assert.notEqual(restored.videoJob!.trackingStopped, true, '新尝试计数必须可正常加载');
  assert.deepEqual(restored.videoJob!.tailPreparation!.selection, child.videoJob!.tailPreparation!.selection);
  for (const invalid of [{ run: 0 }, { attempt: 5 }, { maxAttempts: 5 }, { maxTokens: 0 }, { attempt: undefined }]) {
    const damaged = structuredClone(h.holder()); const target = damaged.project.generationTasks.find((task) => task.id === child.id) as VideoGenerationTask;
    Object.assign(target.videoJob!.tailPreparation!.selection!, invalid);
    const loaded = normalizeState(JSON.parse(JSON.stringify(damaged))).project.generationTasks.find((task) => task.id === child.id) as VideoGenerationTask;
    assert.equal(loaded.videoJob!.trackingStopped, true, '损坏的请求计数不能被丢弃后继续请求');
  }
  h.engine.dispose();
}

for (const failure of ['exhausted', 'unknown-response'] as const) {
  const h = makeHarness(); let analyses = 0; const runtimeMessages = new Map<string, string | undefined>();
  h.options.onRuntime = (taskId, runtime) => { runtimeMessages.set(taskId, runtime.message); };
  h.options.selectTailFrame = async (request) => {
    const count = failure === 'exhausted' ? request.maxAiAttempts! : 1;
    for (let attempt = 1; attempt <= count; attempt += 1) {
      await request.onBeforeAI!({ attempt, maxAttempts: request.maxAiAttempts!, maxTokens: 4096 }); analyses += 1;
      request.onProgress?.(`正在重试 AI 选帧：第 ${attempt} 次`);
    }
    throw new Error(failure === 'exhausted' ? '四次明确返回均无可用选帧结果' : '请求超时，远端结果未知');
  };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '失败尝试未停在衔接阶段');
  await settle(); const expected = failure === 'exhausted' ? 4 : 1;
  assert.match(runtimeMessages.get(batch.taskIds[1])!, /自动衔接暂停/u, '失败原因必须覆盖UI运行时的旧分析/重试进度');
  assert.doesNotMatch(runtimeMessages.get(batch.taskIds[1])!, /正在重试/u);
  assert.equal(analyses, expected); assert.equal(posts(h).length, 1);
  assert.equal(h.checkpoints.get(batch.taskIds[1])!.videoJob!.tailPreparation!.selection!.attempt, expected);
  h.engine.reconcile(); await settle(); assert.equal(analyses, expected, '后台不得开始第5次或重复未知请求');
  h.engine.dispose(); h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile(); await settle();
  assert.equal(analyses, expected, '重启不得给未知started或耗尽run重新发请求');
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.maxAiAttempts, 4);
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; return aiSelection();
  };
  await h.engine.resume(batch.taskIds[1]);
  await waitFor(() => posts(h).length === 2, '用户明确授权新的选帧run后未继续');
  assert.equal(analyses, expected + 1); assert.equal(tasks(h)[1].videoJob!.tailPreparation!.selection!.run, 2);
  h.engine.dispose();
}

{
  const h = makeHarness(); const interrupted = deferred(); let analyses = 0; let staleMain: AppState | undefined;
  h.options.selectTailFrame = async (request) => {
    staleMain = structuredClone(h.holder());
    for (let attempt = 1; attempt <= 2; attempt += 1) { await request.onBeforeAI!({ attempt, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; }
    await interrupted.promise; return aiSelection();
  };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => analyses === 2, '未进入第二次AI请求的未知结果窗口');
  h.engine.dispose(); interrupted.resolve(); await settle(); h.mutate(() => staleMain!);
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '旧main必须恢复独立journal的started并停住');
  assert.equal(analyses, 2); assert.equal(posts(h).length, 1);
  assert.equal(tasks(h)[1].videoJob!.tailPreparation!.selection!.attempt, 2);
  assert.equal(h.extractions.length, 0, 'strict中断恢复不得改用原尾帧');
  h.options.selectTailFrame = async (request) => {
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; return aiSelection();
  };
  await h.engine.resume(batch.taskIds[1]); await waitFor(() => posts(h).length === 2, '中断run后明确重试应单击完成');
  assert.equal(analyses, 3); assert.equal(tasks(h)[1].videoJob!.tailPreparation!.selection!.run, 2); h.engine.dispose();
}

for (const barrier of ['journal', 'main'] as const) {
  const h = makeHarness(); const blockedWrite = deferred(); let blockedEntered = false; let analyses = 0;
  const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  h.options.selectTailFrame = async (request) => {
    await request.onBeforeAI!({ attempt: 1, maxAttempts: request.maxAiAttempts!, maxTokens: 4096 }); analyses += 1;
    if (analyses === 1) throw new Error('首轮明确失败');
    return aiSelection();
  };
  const waitOnBlocked = async (task: VideoGenerationTask | undefined) => {
    if (!blockedEntered && task?.videoJob?.tailPreparation?.phase === 'blocked') { blockedEntered = true; await blockedWrite.promise; }
  };
  if (barrier === 'journal') h.desktop.saveVideoTaskCheckpoint = async (task) => { await waitOnBlocked(task); return originalSave(task); };
  else h.options.persistState = async () => { await waitOnBlocked(tasks(h)[1]); };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => blockedEntered, '未进入可点击重试但旧写盘未结束的窗口');
  let resumed = false; const retry = h.engine.resume(batch.taskIds[1]).then(() => { resumed = true; });
  await settle(); assert.equal(analyses, 1); assert.equal(resumed, false, '第一次点击应等待旧写盘而不是空转返回');
  blockedWrite.resolve(); await retry;
  await waitFor(() => posts(h).length === 2, '只点击一次重试应在旧写盘结束后真正调用AI');
  assert.equal(analyses, 2); assert.equal(tasks(h)[1].videoJob!.tailPreparation!.selection!.run, 2);
  h.engine.dispose();
}

{
  const h = makeHarness(); const beforeSelection = deferred(); let paused = false; let analyses = 0;
  const originalStatus = h.desktop.videoWorkbenchStatus!;
  h.desktop.videoWorkbenchStatus = async () => {
    if (tasks(h)[0]?.resultAssetId) { paused = true; await beforeSelection.promise; }
    return originalStatus();
  };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => paused, '旧快照预算回归未在付费前暂停');
  h.engine.dispose(); beforeSelection.resolve(); await settle(); h.desktop.videoWorkbenchStatus = originalStatus;
  // Reproduce a strict task saved by an older release, before retry policy was
  // part of immutable dependency identity, in both main save and its journal.
  const legacyState = structuredClone(h.holder());
  const legacyChild = legacyState.project.generationTasks.find((task) => task.id === batch.taskIds[1]) as VideoGenerationTask;
  delete legacyChild.videoJob!.snapshot.previousTail!.aiMaxAttempts;
  const legacyCheckpoint = h.checkpoints.get(batch.taskIds[1])!; delete legacyCheckpoint.videoJob!.snapshot.previousTail!.aiMaxAttempts;
  h.mutate(() => legacyState);
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.maxAiAttempts, 1, '恢复旧strict任务缺省只授权原先的一次AI请求');
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 1, maxTokens: 4096 }); analyses += 1;
    throw new Error('旧任务第一次明确失败');
  };
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '旧任务首次尝试未停在原预算');
  assert.equal(analyses, 1); assert.equal(posts(h).length, 1);
  h.options.selectTailFrame = async (request) => {
    assert.equal(request.maxAiAttempts, 4, '用户明确重试旧strict任务才允许一轮四次');
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; return aiSelection();
  };
  await h.engine.resume(batch.taskIds[1]); await waitFor(() => posts(h).length === 2, '明确重试旧任务未完成');
  assert.equal(analyses, 2); assert.equal(tasks(h)[1].videoJob!.snapshot.previousTail!.aiMaxAttempts, undefined);
  h.engine.dispose();
}

{
  const h = makeHarness(); const blockedWrite = deferred(); let entered = false; let analyses = 0;
  const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  h.options.selectTailFrame = async (request) => {
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; throw new Error('选帧明确失败');
  };
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    if (!entered && task.videoJob?.tailPreparation?.phase === 'blocked') { entered = true; await blockedWrite.promise; }
    return originalSave(task);
  };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id)); await waitFor(() => entered, '未进入收尾等待窗口');
  const retry = h.engine.resume(batch.taskIds[1]); await settle();
  await h.engine.cancel(batch.taskIds[1]); blockedWrite.resolve(); await retry; await settle();
  assert.equal(analyses, 1, '等待旧run写盘时取消必须使早先的重试意图失效'); assert.equal(posts(h).length, 1);
  assert.equal(tasks(h)[1].videoJob!.batchQueueState, 'cancelled'); h.engine.dispose();
}

for (const stop of ['cancel', 'delete'] as const) {
  const h = makeHarness(); const betweenAttempts = deferred(); let analyses = 0;
  h.options.selectTailFrame = async (request) => {
    await request.onBeforeAI!({ attempt: 1, maxAttempts: 4, maxTokens: 4096 }); analyses += 1;
    await betweenAttempts.promise;
    await request.onBeforeAI!({ attempt: 2, maxAttempts: 4, maxTokens: 8192 }); analyses += 1;
    return aiSelection();
  };
  const batch = await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => analyses === 1, '取消回归未进入重试间隙');
  if (stop === 'cancel') await h.engine.cancel(batch.taskIds[1]);
  else { h.mutate((state) => ({ ...state, project: { ...state.project, generationTasks: state.project.generationTasks.filter((task) => task.id !== batch.taskIds[1]) } })); h.engine.reconcile(); }
  betweenAttempts.resolve(); await settle();
  assert.equal(analyses, 1, '取消/删除后不得放行后续收费尝试'); assert.equal(posts(h).length, 1);
  h.engine.dispose();
}

for (const barrier of ['journal', 'main'] as const) {
  const h = makeHarness(); let analyses = 0; const originalSave = h.desktop.saveVideoTaskCheckpoint!;
  const rejectSecondBoundary = (task: VideoGenerationTask | undefined) => {
    if (task?.videoJob?.tailPreparation?.phase === 'extracting' && task.videoJob.tailPreparation.selection?.attempt === 2) throw new Error('第二次收费边界落盘失败');
  };
  if (barrier === 'journal') h.desktop.saveVideoTaskCheckpoint = async (task) => { rejectSecondBoundary(task); return originalSave(task); };
  else h.options.persistState = async () => { rejectSecondBoundary(tasks(h)[1]); };
  h.options.selectTailFrame = async (request) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) { await request.onBeforeAI!({ attempt, maxAttempts: 4, maxTokens: 4096 }); analyses += 1; }
    return aiSelection();
  };
  await h.engine.startBatch(strictAiInput(h.holder().project.id));
  await waitFor(() => tasks(h)[1]?.videoJob?.tailPreparation?.phase === 'blocked', '第二次请求前落盘失败未暂停');
  assert.equal(analyses, 1, '收费边界未全部持久化前不得发起第二次请求'); assert.equal(posts(h).length, 1);
  h.engine.dispose();
}
{
  const direct = aiInput('strict-fingerprint').items[1].previousTail!;
  assert.notEqual(videoBatchDependencyFingerprint('base', direct, 'parent'),
    videoBatchDependencyFingerprint('base', { ...direct, requireAiSelection: true }, 'parent'), '严格AI行为必须单独去重');
}

{
  const h = makeHarness(); const originalRequest = h.desktop.videoRequest!;
  h.desktop.videoRequest = async (request) => {
    if (request.method === 'POST' && posts(h).length === 1) {
      h.requests.push(request); return response({ id: 'explicitly-failed-second', status: 'failed', error: 'fixture remote failure' });
    }
    return originalRequest(request);
  };
  const original = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => tasks(h).some((task) => task.id === original.taskIds[1] && task.status === 'failed'), 'second task did not fail');
  await h.engine.cancelBatch(original.batchId);
  const successfulFirst = structuredClone(tasks(h).find((task) => task.id === original.taskIds[0])!);
  const cancelledThird = structuredClone(tasks(h).find((task) => task.id === original.taskIds[2])!);
  const resumed = await h.engine.resumeBatch(original.batchId);
  assert.equal(posts(h).length, 2, 'continue preview must not repeat an acknowledged failed POST');
  assert.deepEqual(resumed.completedTaskIds, [original.taskIds[0]]);
  assert.deepEqual(resumed.continuation?.items.map((item) => [item.taskId, item.willRegenerate]), [[original.taskIds[1], true], [original.taskIds[2], false]]);
  assert.equal(resumed.continuation?.requiresAiTail, false, 'already saved exact first-tail pixels must be reused');
  const resumedBatch = await h.engine.confirmContinueBatch(resumed.continuation!.id);
  assert.notEqual(resumedBatch.batchId, original.batchId); assert.equal(resumedBatch.taskIds.length, 2);
  await waitFor(() => posts(h).length === 4, 'confirmed suffix did not generate only the remaining two segments');
  const continued = tasks(h).filter((task) => task.batchId === resumedBatch.batchId).sort((a, b) => a.batchIndex! - b.batchIndex!);
  assert.equal(continued[0].segmentIndex, 2); assert.equal(continued[0].videoJob!.snapshot.previousTail, undefined);
  assert.match(JSON.parse(posts(h)[2].body!).first_frame_image, /tail-1/u, 'first suffix segment retains exact original successful parent pixels');
  assert.equal(continued[1].videoJob!.snapshot.previousTail!.predecessorTaskId, continued[0].id);
  assert.notEqual(continued[1].videoJob!.snapshot.previousTail!.predecessorTaskId, original.taskIds[1]);
  assert.deepEqual(tasks(h).find((task) => task.id === original.taskIds[0]), successfulFirst, 'successful original task is never rewritten');
  const continuedOriginal = tasks(h).find((task) => task.id === original.taskIds[2])!;
  const { batchContinuation, ...continuedOriginalJob } = continuedOriginal.videoJob!;
  assert.ok(batchContinuation && !batchContinuation.released, 'original slot durably owns its exact continued child');
  assert.deepEqual({ ...continuedOriginal, updatedAt: cancelledThird.updatedAt, videoJob: continuedOriginalJob }, cancelledThird,
    'continuation only adds lineage; cancelled original identity, inputs and tombstone remain untouched');
  assert.deepEqual(await h.engine.confirmContinueBatch(resumed.continuation!.id), resumedBatch, 'double-confirm returns the same operation result');
  assert.equal(posts(h).length, 4); h.engine.dispose();
}
{
  const h = makeHarness(true);
  const original = await h.engine.startBatch(chainInput(h.holder().project.id));
  await waitFor(() => h.extractions.length === 1, 'local predecessor did not reach extraction');
  await h.engine.cancelBatch(original.batchId); await settle();
  const resumed = await h.engine.resumeBatch(original.batchId);
  assert.equal(resumed.continuation?.requiresAiTail, false, 'continuing a local last-frame chain never adds an AI dependency');
  assert.equal(resumed.continuation?.predecessorTaskId, original.taskIds[0]);
  let analyses = 0; let localFrames = 0;
  h.options.selectTailFrame = async () => { analyses += 1; return aiSelection(); };
  h.desktop.extractWorkbenchFrames = async (request) => {
    assert.equal(request.mode, 'last', 'the local continuation must extract the actual last frame');
    return { probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' }, frames: [frame(201 + localFrames++)] };
  };
  const continued = await h.engine.confirmContinueBatch(resumed.continuation!.id);
  await waitFor(() => posts(h).length === 3, 'local continuation did not generate the remaining two segments');
  assert.equal(continued.taskIds.length, 2); assert.equal(analyses, 0, 'local continuation cannot purchase AI tail selection');
  assert.equal(localFrames, 2, 'each remaining local dependency extracts its own predecessor last frame');
  assert.match(JSON.parse(posts(h)[1].body!).first_frame_image, /tail-201/u);
  assert.match(JSON.parse(posts(h)[2].body!).first_frame_image, /tail-202/u);
  h.engine.dispose();
}
{
  const h = makeHarness(true);
  const input = chainInput(h.holder().project.id);
  // This case tests a historical AI-assisted chain, not the current local
  // last-frame default. Only its explicit AI contract permits paid selection.
  input.items[1].previousTail!.selectionMode = 'ai-assisted';
  const original = await h.engine.startBatch(input);
  await waitFor(() => h.extractions.length === 1, 'first predecessor did not reach extraction');
  await h.engine.cancelBatch(original.batchId); await settle();
  const resumed = await h.engine.resumeBatch(original.batchId);
  assert.equal(resumed.continuation?.requiresAiTail, true);
  assert.equal(resumed.continuation?.predecessorTaskId, original.taskIds[0]);
  const gate = deferred(); let analyses = 0;
  h.options.selectTailFrame = async (request) => {
    analyses += 1; assert.equal(request.requireAiSelection, true); await request.onBeforeAI?.(); await gate.promise; return aiSelection();
  };
  const controller = new AbortController();
  const pendingContinue = h.engine.confirmContinueBatch(resumed.continuation!.id, controller.signal);
  await waitFor(() => analyses === 1, 'confirmation did not prepare missing static AI first frame');
  controller.abort(); gate.resolve();
  await assert.rejects(pendingContinue, /取消/u); assert.equal(posts(h).length, 1, 'late AI results must not submit a new suffix after cancellation');
  h.options.selectTailFrame = async (request) => { analyses += 1; await request.onBeforeAI?.(); return aiSelection(); };
  h.desktop.extractWorkbenchFrames = async () => ({ probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' }, frames: [frame(201)] });
  const continued = await h.engine.confirmContinueBatch(resumed.continuation!.id);
  await waitFor(() => posts(h).length === 3, 'explicit confirmation after cancel did not continue');
  assert.equal(continued.taskIds.length, 2); assert.equal(analyses, 2, 'only each explicit confirmation can authorize another AI attempt');
  assert.match(JSON.parse(posts(h)[1].body!).first_frame_image, /tail-101/u);
  const newFrame = h.holder().project.assets.find((asset) => asset.tags.includes('批次续跑'))!;
  assert.ok(newFrame); assert.equal(newFrame.sourceVideoAssetId, tasks(h).find((task) => task.id === original.taskIds[0])!.resultAssetId);
  h.engine.dispose();
}

console.log('Video tail dependency checks passed: zero-video sequence, exact parent pixels, download/main/journal barriers, no bypass on resume, failure recovery, cancellation/late frames, project ownership, future-slot preflight, ZIP explicit primary selection, AI selection/fallback, durable one-request AI boundaries, strict one-click AI, confirmed suffix continuation and chain idempotency.');
