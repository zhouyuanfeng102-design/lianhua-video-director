import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInitialState, normalizeState } from '../src/storage';
import { extractVideoTailFrameSelection, type VideoTailFrameCandidate } from '../src/videoFrameSelection';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { TextModelResponseError } from '../src/services/llm';
import type { AppState, TextApiConfig, VideoGenerationTask } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop } from '../src/videoGenerationTypes';
import type { WorkbenchFrameRequest } from '../src/videoWorkbenchTypes';

// The two remote providers are mocked. Source video, decoded candidates, image
// uploads, project saves and the monotonic native journal all use real bytes.
const require = createRequire(import.meta.url);
const { createVideoWorkbench } = require('../electron/videoWorkbench.cjs');
const { createVideoTaskCheckpointJournal, collectVideoFrozenAssets } = require('../electron/videoTaskCheckpoint.cjs');
const root = path.resolve(import.meta.dirname, '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const toolsDirectory = path.join(root, 'build', 'media-tools', `${process.platform}-${process.arch}`);
const ffmpegPath = process.env.LIANHUA_FFMPEG_PATH || path.join(toolsDirectory, `ffmpeg${suffix}`);
const ffprobePath = process.env.LIANHUA_FFPROBE_PATH || path.join(toolsDirectory, `ffprobe${suffix}`);
assert.ok(fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath), 'real AI-tail QA requires the bundled media tools');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-ai-tail-real-'));
const assetRoot = path.join(directory, 'assets');
const projectFile = path.join(directory, 'project.json');
for (const folder of ['video', 'image']) fs.mkdirSync(path.join(assetRoot, folder), { recursive: true });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const atomicWriteFile = (file: string, content: string) => { fs.writeFileSync(`${file}.tmp`, content); fs.renameSync(`${file}.tmp`, file); };
const journalDirectory = path.join(directory, 'checkpoints');
let journal = createVideoTaskCheckpointJournal({ directory: journalDirectory, atomicWriteFile });
const service = createVideoWorkbench({ assetRoot, tempRoot: path.join(directory, 'temp'), ffmpegPath, ffprobePath });
const run = (args: string[]): Promise<Buffer> => new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, shell: false });
  const chunks: Buffer[] = []; let error = '';
  child.stdout.on('data', (bytes: Buffer) => chunks.push(bytes));
  child.stderr.on('data', (bytes: Buffer) => { error += bytes.toString(); });
  child.once('error', reject);
  child.once('close', (code) => code ? reject(new Error(error)) : resolve(Buffer.concat(chunks)));
});
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 25_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No network requests are permitted in real-media AI-tail regression'); };
let engine: VideoGenerationEngine | undefined;
let releaseSelectedCheckpoint: (() => void) | undefined;
try {
  const sourceFile = path.join(directory, 'remote-source.mp4');
  await run(['-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x96:r=10:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', sourceFile]);
  const sourceChecksum = hash(fs.readFileSync(sourceFile));
  for (const initialLengthFailures of [0, 2]) {
  // Separate real journals exercise both the original single-request path and
  // bounded core retries without changing the immutable first scenario's data.
  journal = createVideoTaskCheckpointJournal({ directory: path.join(journalDirectory, `length-failures-${initialLengthFailures}`), atomicWriteFile });
  releaseSelectedCheckpoint = undefined;
  const expectedAiCalls = initialLengthFailures + 1;
  let state = createInitialState();
  const ownerId = state.project.id;
  const story = `完整剧情开头：六足生物经过红色空镜，背影离场后进入蓝色空镜。${'保持前后镜头连续，允许遮挡和无人物构图。'.repeat(100)}完整剧情结尾。`;
  state.project.sequencePlans = [{ id: 'ai-tail-plan', title: 'AI 衔接真实媒体回归', sourceStoryTitle: '完整故事', sourceStoryContent: story,
    durationMode: 'fixed', totalDurationSec: 6, segmentDurationSec: 3, segmentationMode: 'fixed', fitStatus: 'balanced', segments: [], createdAt: 1, updatedAt: 1 }];
  state.settings.videoTaskApi = { enabled: true, endpoint: 'https://mock.invalid/generate', statusEndpointTemplate: 'https://mock.invalid/tasks/{id}',
    apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'test' };
  const vision: TextApiConfig = { enabled: true, vision: true, provider: 'openai_compatible', baseUrl: 'https://vision.mock.invalid/v1',
    apiKey: 'private-vision-test-key', model: 'mock-vision', temperature: 0.2, maxTokens: 2048 };
  const previousPrompt = `上一段全文：${'六足主体背影经过红色场景。'.repeat(100)}上一段结尾。`;
  const nextPrompt = `下一段全文：${'镜头允许空镜、背影，不强求完整人物入镜。'.repeat(100)}下一段结尾。`;
  const tasks = () => state.project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video').sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0));
  const childTask = () => tasks().find((task) => task.batchIndex === 2)!;
  const posts: Record<string, unknown>[] = [];
  const extractionRequests: WorkbenchFrameRequest[] = [];
  const history: VideoGenerationTask[] = [];
  const events: string[] = [];
  const tokenBudgets: number[] = [];
  const reply = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  let aiCalls = 0; let selectionCalls = 0; let holdSelected = true; let selectedSaved = false; let selectedReturned = false;
  let candidates: VideoTailFrameCandidate[] = [];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      assert.equal(request.method, 'POST', 'fixture completes mocked remote videos without polling');
      assert.equal(request.url, 'https://mock.invalid/generate');
      const number = posts.length + 1;
      if (number === 2) {
        const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
        const persistedChild = saved.project.generationTasks.find((task) => task.id === childTask().id) as VideoGenerationTask;
        assert.equal(persistedChild.videoJob?.tailPreparation?.phase, 'ready');
        assert.equal(persistedChild.videoJob?.tailPreparation?.selection?.status, 'completed');
        assert.equal(persistedChild.videoJob?.snapshot.images[0].freezeState, 'frozen');
        assert.equal(journal.get(persistedChild.id).videoJob.preparation.phase, 'post-started');
      }
      posts.push(JSON.parse(request.body || '{}')); events.push(`video-post-${number}`);
      return reply({ id: `remote-${number}`, status: 'succeeded', url: `https://mock.invalid/${number}.mp4` });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => {
      const result = journal.save(task); history.push(structuredClone(task));
      const selection = task.videoJob?.tailPreparation?.selection;
      if (selection?.status === 'started') events.push(`journal-ai-started-${selection.attempt}`);
      if (holdSelected && selection?.status === 'completed' && task.videoJob?.tailPreparation?.phase === 'extracting') {
        assert.equal(task.videoJob.snapshot.images[0].freezeState, 'pending');
        events.push('journal-ai-completed-before-binding'); selectedSaved = true;
        await new Promise<void>((resolve) => { releaseSelectedCheckpoint = resolve; });
        selectedReturned = true;
      }
      return result;
    },
    getVideoTaskCheckpoint: async (taskId) => journal.get(taskId), deleteVideoTaskCheckpoint: async (taskId) => journal.delete(taskId),
    downloadGeneratedMedia: async (request) => {
      const number = Number(/\/(\d+)\.mp4$/u.exec(request.url)?.[1]);
      assert.ok(number === 1 || number === 2);
      const relativePath = `video/generated-${number}.mp4`;
      fs.copyFileSync(sourceFile, path.join(assetRoot, relativePath));
      return { fileName: `generated-${number}.mp4`, relativePath, checksum: sourceChecksum, sizeBytes: fs.statSync(sourceFile).size,
        mediaType: 'video', mimeType: 'video/mp4', managed: true, missing: false, url: `lianhua-asset://local/${relativePath}` };
    },
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      const imagePath = path.resolve(assetRoot, relativePath);
      assert.ok(imagePath.startsWith(`${path.resolve(assetRoot)}${path.sep}`), 'read only this isolated fixture');
      const bytes = fs.readFileSync(imagePath); assert.equal(hash(bytes), expectedChecksum);
      return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    },
    videoWorkbenchStatus: () => service.status(),
    extractWorkbenchFrames: async (request) => {
      assert.equal(request.projectId, ownerId); assert.ok(request.mode === 'last' || request.mode === 'uniform');
      extractionRequests.push(structuredClone(request));
      const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
      assert.ok(saved.project.assets.some((asset) => asset.id === request.source.assetId), 'source video must already be durable');
      return service.extractFrames(request, 142);
    },
    cancelWorkbenchJob: async (jobId) => service.cancel(jobId, 142),
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {},
    persistState: async () => atomicWriteFile(projectFile, JSON.stringify(state)),
    selectTailFrame: async (input) => {
      assert.equal(input.requireAiSelection, true, 'new one-click chain requires an actual AI decision');
      assert.equal(input.maxAiAttempts, 4, 'new strict engine shell explicitly authorizes initial request plus three retries');
      selectionCalls += 1;
      assert.equal(selectionCalls, 1, 'recovering a completed choice must never issue a second AI selection');
      const result = await extractVideoTailFrameSelection({ ...input, config: vision }, {
        // These decoded PNGs are only 160x96; browser thumbnailing is not needed.
        prepareImage: async (dataUrl) => dataUrl,
        retryDelayMs: 0,
        requestModel: async (config, _system, user, _signal, requestOptions) => {
          aiCalls += 1; events.push(`vision-request-${aiCalls}`); tokenBudgets.push(config.maxTokens);
          assert.equal(config.model, vision.model);
          const record = journal.get(childTask().id) as VideoGenerationTask;
          const expectedBoundary = { status: 'started', run: 1, attempt: aiCalls, maxAttempts: 4, maxTokens: vision.maxTokens * 2 ** (aiCalls - 1) };
          assert.deepEqual(record.videoJob?.tailPreparation?.selection, expectedBoundary, 'each exact paid boundary must reach the real native journal before its model call');
          assert.equal(config.maxTokens, expectedBoundary.maxTokens);
          assert.equal(record.videoJob?.snapshot.previousTail?.aiMaxAttempts, 4);
          assert.equal(record.videoJob?.snapshot.images[0].freezeState, 'pending');
          const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
          const savedChild = saved.project.generationTasks.find((task) => task.id === record.id) as VideoGenerationTask;
          assert.deepEqual(savedChild.videoJob?.tailPreparation?.selection, expectedBoundary, 'each actual request also waits for the main project save');
          assert.deepEqual(extractionRequests.map((request) => request.mode), ['last', 'uniform'], 'retries reuse one extraction pass, never decode new candidates per attempt');
          assert.equal(posts.length, 1, 'AI repairs never regenerate the parent or prematurely submit the child');
          const payload = JSON.parse(user) as { completeStoryContext: string; completePreviousPrompt: string; completeNextPrompt: string;
            candidates: Array<{ id: string; timeSec: number; isActualLastFrame: boolean }> };
          assert.equal(payload.completeStoryContext, story); assert.equal(payload.completePreviousPrompt, previousPrompt); assert.equal(payload.completeNextPrompt, nextPrompt);
          assert.equal(payload.candidates.length, 6); assert.equal(requestOptions?.referenceImages?.length, 6);
          assert.ok(requestOptions?.referenceImages?.every((data) => data.startsWith('data:image/png;base64,iVBOR')));
          if (aiCalls > 1) { assert.ok(requestOptions?.finalInstruction); assert.equal(requestOptions?.disableThinking, true); }
          if (aiCalls <= initialLengthFailures) throw new TextModelResponseError('length', '文本模型达到最大输出额度，只返回了思考内容，没有返回正文；不会自动进行 JSON 格式重试。');
          const chosen = payload.candidates.find((candidate) => !candidate.isActualLastFrame && candidate.timeSec >= 1.2 && candidate.timeSec < 2);
          assert.ok(chosen, 'real candidates contain an earlier red frame, not the blue last frame');
          return JSON.stringify({ selectedId: chosen.id, reason: '无人物的红色空镜更适合下一段，不要求正脸或全身；可以采用背影与非人类主体。', confidence: 0 });
        },
      });
      candidates = result.candidates;
      assert.equal(result.selection.source, 'ai'); assert.ok(result.selection.offsetFromEndSec > 0);
      assert.match(result.selection.warning || '', /动作回退/u);
      return result;
    },
  };
  engine = new VideoGenerationEngine(options);
  const input: VideoBatchStartInput = { projectId: ownerId, label: '真实媒体 AI 衔接', concurrency: 2, items: [1, 2].map((number) => ({
    itemKey: `segment-${number}:zh`, draft: { name: `第${number}段`, prompt: number === 1 ? previousPrompt : nextPrompt,
      backend: 'api', parameters: {}, references: [], source: { storyboardId: `board-${number}`, sequencePlanId: 'ai-tail-plan', segmentId: `segment-${number}`, segmentIndex: number, language: 'zh' } },
    previousTail: number === 2 ? { predecessorItemKey: 'segment-1:zh', placement: { mode: 'append', index: 0, role: 'first-frame' }, selectionMode: 'ai-assisted', requireAiSelection: true } : undefined,
  })) };
  const batch = await engine.startBatch(input); assert.equal(batch.taskIds.length, 2);
  await waitFor(() => selectedSaved && Boolean(releaseSelectedCheckpoint), 'completed AI choice did not reach the real native journal');
  assert.equal(posts.length, 1); assert.equal(aiCalls, expectedAiCalls);
  assert.deepEqual(tokenBudgets, initialLengthFailures ? [2048, 4096, 8192] : [2048]);
  assert.deepEqual(extractionRequests.map((request) => request.mode), ['last', 'uniform']);
  const childId = childTask().id;
  const chosenRecord = journal.get(childId) as VideoGenerationTask;
  const chosenSelection = chosenRecord.videoJob!.tailPreparation!.selection!;
  assert.equal(chosenSelection.status, 'completed'); assert.equal(chosenRecord.videoJob!.snapshot.images[0].freezeState, 'pending');
  assert.equal(chosenSelection.run, 1); assert.equal(chosenSelection.attempt, expectedAiCalls);
  assert.equal(chosenSelection.maxTokens, tokenBudgets.at(-1));
  const chosenFrame = chosenSelection.frame!;
  assert.ok(fs.existsSync(path.join(assetRoot, chosenFrame.relativePath)));
  assert.equal(collectVideoFrozenAssets({ id: ownerId, generationTasks: [chosenRecord], assets: [] })[0].relativePath, chosenFrame.relativePath,
    'an export between result persistence and binding still includes selected pixels');
  const staleMain = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
  const staleChild = staleMain.project.generationTasks.find((task) => task.id === childId) as VideoGenerationTask;
  assert.equal(staleChild.videoJob!.tailPreparation!.selection!.status, 'started', 'main save intentionally lags completed native journal');
  assert.equal(staleChild.videoJob!.tailPreparation!.selection!.attempt, expectedAiCalls);
  assert.equal(staleChild.videoJob!.snapshot.images[0].freezeState, 'pending');
  engine.dispose(); holdSelected = false; releaseSelectedCheckpoint!();
  await waitFor(() => selectedReturned, 'old checkpoint waiter did not exit');
  assert.equal(posts.length, 1, 'a disposed engine cannot bind and submit a late result');
  state = normalizeState(staleMain);
  assert.equal(childTask().videoJob?.trackingStopped, undefined, 'valid AI protocol loads without a local semantic stop');
  journal = createVideoTaskCheckpointJournal({ directory: path.join(journalDirectory, `length-failures-${initialLengthFailures}`), atomicWriteFile });
  engine = new VideoGenerationEngine(options); engine.reconcile();
  await waitFor(() => posts.length === 2 && tasks().every((task) => task.videoJob?.stage === 'succeeded' && Boolean(task.resultAssetId)),
    `restored selected frame did not continue second segment; ${JSON.stringify(tasks().map((task) => ({ status: task.status, error: task.error })))}`);
  assert.equal(aiCalls, expectedAiCalls); assert.equal(selectionCalls, 1); assert.equal(extractionRequests.length, 2, 'recovery reuses durable selected pixels without decoding again');
  assert.equal(posts.filter((body) => body.prompt === previousPrompt).length, 1, 'parent video is purchased exactly once');
  assert.equal(posts.filter((body) => body.prompt === nextPrompt).length, 1, 'child video is purchased exactly once');
  const final = childTask(); const image = final.videoJob!.snapshot.images[0];
  assert.equal(image.freezeState, 'frozen'); assert.equal(image.relativePath, chosenFrame.relativePath); assert.equal(image.checksum, chosenFrame.checksum);
  assert.deepEqual(final.videoJob!.tailPreparation!.selection, chosenSelection);
  const boundAsset = state.project.assets.find((asset) => asset.id === final.videoJob!.snapshot.previousTail!.reservedFrameAssetId)!;
  assert.ok(boundAsset); assert.equal(boundAsset.sourceTimeSec, chosenFrame.timeSec); assert.equal(boundAsset.sourceFrameIndex, chosenFrame.frameIndex);
  const selectedBytes = fs.readFileSync(path.join(assetRoot, chosenFrame.relativePath));
  assert.equal(hash(selectedBytes), chosenFrame.checksum);
  assert.equal(posts[1].first_frame_image, `data:image/png;base64,${selectedBytes.toString('base64')}`, 'second video receives the exact AI-selected PNG');
  const last = candidates.find((candidate) => candidate.isLastFrame)!;
  assert.ok(chosenFrame.timeSec < last.timeSec); assert.notEqual(chosenFrame.checksum, last.frame.checksum);
  for (const [frame, expected] of [[chosenFrame, 'red'], [last.frame, 'blue']] as const) {
    const pixel = await run(['-i', path.join(assetRoot, frame.relativePath), '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(expected === 'red' ? pixel[0] > 200 && pixel[1] < 20 && pixel[2] < 20 : pixel[2] > 200 && pixel[0] < 20 && pixel[1] < 20,
      `${expected} frame must retain its original decoded pixels: ${[...pixel]}`);
  }
  for (let attempt = 1; attempt <= expectedAiCalls; attempt += 1) {
    assert.ok(events.indexOf(`journal-ai-started-${attempt}`) < events.indexOf(`vision-request-${attempt}`));
    assert.ok(events.indexOf(`vision-request-${attempt}`) < events.indexOf('journal-ai-completed-before-binding'));
    if (attempt > 1) assert.ok(events.indexOf(`vision-request-${attempt - 1}`) < events.indexOf(`journal-ai-started-${attempt}`));
  }
  assert.ok(events.indexOf('journal-ai-completed-before-binding') < events.indexOf('video-post-2'));
  assert.ok(history.some((task) => task.id === childId && task.videoJob?.tailPreparation?.phase === 'ready'));
  for (const task of history) {
    assert.ok(!JSON.stringify(task.videoJob?.tailPreparation?.selection || {}).includes('base64,'));
    assert.ok(!JSON.stringify(task).includes(vision.apiKey), 'vision key never enters the task journal');
  }
  const callsBeforeReconcile = posts.length;
  engine.reconcile(); engine.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(posts.length, callsBeforeReconcile); assert.equal(aiCalls, expectedAiCalls);
  assert.equal(hash(fs.readFileSync(sourceFile)), sourceChecksum, 'selection never edits the original video');
  console.log(`Real AI-tail/native-journal regression passed: ${initialLengthFailures} initial length failures, budgets ${tokenBudgets.join('→')}, one pass of 6 decoded candidates, completed-before-binding recovery without repurchase, parent/child one POST each, and unchanged source video. No network/API charges.`);
  engine.dispose();
  }
} finally {
  engine?.dispose(); releaseSelectedCheckpoint?.(); service.close(); globalThis.fetch = originalFetch;
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('lianhua-ai-tail-real-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
