import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop } from '../src/videoGenerationTypes';

// Only the remote generator is mocked. Videos, decoded last frames, asset
// checksums, project saves and the immutable task journal use real local files.
const require = createRequire(import.meta.url);
const { createVideoWorkbench } = require('../electron/videoWorkbench.cjs');
const { createVideoTaskCheckpointJournal } = require('../electron/videoTaskCheckpoint.cjs');
const root = path.resolve(import.meta.dirname, '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = process.env.LIANHUA_FFMPEG_PATH || path.join(root, 'build', 'media-tools', `${process.platform}-${process.arch}`, `ffmpeg${suffix}`);
const ffprobePath = process.env.LIANHUA_FFPROBE_PATH || path.join(root, 'build', 'media-tools', `${process.platform}-${process.arch}`, `ffprobe${suffix}`);
assert.ok(fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath), 'real tail-chain QA requires the bundled media tools');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-tail-chain-real-'));
const assetRoot = path.join(directory, 'assets');
const projectFile = path.join(directory, 'project.json');
for (const folder of ['video', 'image']) fs.mkdirSync(path.join(assetRoot, folder), { recursive: true });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const atomicWriteFile = (file: string, content: string) => { fs.writeFileSync(`${file}.tmp`, content); fs.renameSync(`${file}.tmp`, file); };
const journal = createVideoTaskCheckpointJournal({ directory: path.join(directory, 'checkpoints'), atomicWriteFile });
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
  const deadline = Date.now() + 20_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
};
let engine: VideoGenerationEngine | undefined;
try {
  const sourceMovies: Array<{ file: string; checksum: string }> = [];
  for (const [index, first, last] of [[1, 'red', 'blue'], [2, 'yellow', 'lime'], [3, 'white', 'purple'],
    [4, 'cyan', 'magenta'], [5, 'black', 'orange'], [6, 'white', 'blue']] as const) {
    const file = path.join(directory, `remote-${index}.mp4`);
    await run(['-f', 'lavfi', '-i', `color=c=${first}:s=160x96:r=10:d=0.5`, '-f', 'lavfi', '-i', `color=c=${last}:s=160x96:r=10:d=0.5`,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
    sourceMovies.push({ file, checksum: hash(fs.readFileSync(file)) });
  }
  const seedPath = path.join(assetRoot, 'image', 'manual-first.png');
  await run(['-f', 'lavfi', '-i', 'color=c=white:s=160x96', '-frames:v', '1', '-threads', '1', seedPath]);
  const seedBytes = fs.readFileSync(seedPath);
  const seed: ReferenceAsset = { id: 'manual-first', name: '手选第一段参考图', type: 'reference', role: 'first-frame', referenceRole: 'first-frame',
    source: 'upload', mediaType: 'image', mimeType: 'image/png', relativePath: 'image/manual-first.png', checksum: hash(seedBytes),
    fileName: 'manual-first.png', width: 160, height: 96, tags: [], createdAt: Date.now(), updatedAt: Date.now() };
  let state = createInitialState(); const ownerId = state.project.id; state.project.assets.push(seed);
  state.settings.videoTaskApi = { enabled: true, endpoint: 'https://mock.invalid/generate', statusEndpointTemplate: 'https://mock.invalid/tasks/{id}',
    apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'test' };
  const owner = (from = state) => from.project.id === ownerId ? from.project : from.projects.find((project) => project.id === ownerId)!;
  const tasks = () => owner().generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video').sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0));
  const events: string[] = []; const posts: Record<string, unknown>[] = []; const extracted: string[] = [];
  const remoteComplete = new Set<number>(); let downloadRelease: (() => void) | undefined;
  const reply = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      if (request.method === 'POST') {
        const number = posts.length + 1;
        const posting = tasks().find((task) => task.videoJob?.preparation?.phase === 'post-started' && !task.remoteTaskId);
        assert.ok(posting, 'a durable POST boundary must identify the exact new task');
        if (posting.videoJob?.snapshot.previousTail) {
          const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
          const savedChild = owner(saved).generationTasks.find((task) => task.id === posting.id) as VideoGenerationTask;
          const checkpoint = journal.get(savedChild.id) as VideoGenerationTask;
          assert.equal(savedChild.videoJob?.tailPreparation?.phase, 'ready', 'next POST needs a durable ready binding in project storage');
          assert.ok(owner(saved).assets.some((asset) => asset.id === savedChild.videoJob?.snapshot.previousTail?.reservedFrameAssetId));
          assert.equal(checkpoint.videoJob?.preparation?.phase, 'post-started');
        }
        posts.push(JSON.parse(request.body || '{}')); events.push(`post-${number}`);
        return reply({ id: `remote-${number}`, status: 'queued' });
      }
      const number = Number(/remote-(\d+)/u.exec(request.url)?.[1]);
      return reply(remoteComplete.has(number) ? { status: 'succeeded', url: `https://mock.invalid/result/${number}.mp4` } : { status: 'running' });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => journal.save(task), getVideoTaskCheckpoint: async (taskId) => journal.get(taskId), deleteVideoTaskCheckpoint: async (taskId) => journal.delete(taskId),
    downloadGeneratedMedia: async (request) => {
      const number = Number(/\/(\d+)\.mp4$/u.exec(request.url)?.[1]); events.push(`download-start-${number}`);
      if (number === 1) await new Promise<void>((resolve) => { downloadRelease = resolve; });
      const relativePath = `video/generated-${number}.mp4`; const source = sourceMovies[number - 1];
      fs.copyFileSync(source.file, path.join(assetRoot, relativePath)); events.push(`download-saved-${number}`);
      return { fileName: `generated-${number}.mp4`, relativePath, checksum: source.checksum, sizeBytes: fs.statSync(source.file).size,
        mediaType: 'video', mimeType: 'video/mp4', managed: true, missing: false, url: `lianhua-asset://local/${relativePath}` };
    },
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      const bytes = fs.readFileSync(path.join(assetRoot, relativePath)); assert.equal(hash(bytes), expectedChecksum);
      return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    },
    videoWorkbenchStatus: () => service.status(),
    extractWorkbenchFrames: async (request) => {
      assert.equal(request.projectId, ownerId); assert.equal(request.mode, 'last');
      const number = extracted.length + 1;
      const persisted = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as AppState;
      assert.ok(owner(persisted).assets.some((asset) => asset.id === request.source.assetId), 'source video must be in durable owner project');
      events.push(`extract-${number}`); const result = await service.extractFrames(request, 123);
      assert.equal(result.frames.length, 1); assert.equal(result.frames[0].frameIndex, 9); assert.equal(result.frames[0].timeSec, 0.9);
      extracted.push(result.frames[0].relativePath); return result;
    },
    cancelWorkbenchJob: async (jobId) => service.cancel(jobId, 123),
  };
  engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop,
    onRuntime: () => {}, pollIntervalMs: 15, persistState: async () => atomicWriteFile(projectFile, JSON.stringify(state)) });
  const input: VideoBatchStartInput = { projectId: ownerId, label: '真实三段尾帧链', concurrency: 3, items: [1, 2, 3].map((number) => ({
    itemKey: `segment-${number}:en`, draft: { name: `第${number}段`, prompt: `Segment ${number}, continue the same action`, backend: 'api', parameters: {},
      source: { storyboardId: `board-${number}`, sequencePlanId: 'chain-plan', segmentId: `segment-${number}`, segmentIndex: number, language: 'en' },
      references: number === 1 ? [{ assetId: seed.id, role: 'first-frame' }] : [] },
    previousTail: number > 1 ? { predecessorItemKey: `segment-${number - 1}:en`, placement: { mode: 'append', index: 0, role: 'first-frame' } } : undefined,
  })) };
  const batch = await engine.startBatch(input); assert.equal(batch.taskIds.length, 3);
  await waitFor(() => posts.length === 1, 'first segment must submit without any preexisting video');
  assert.equal(extracted.length, 0);
  remoteComplete.add(1); await waitFor(() => Boolean(downloadRelease), 'first segment must enter download');
  assert.equal(posts.length, 1, 'remote success is not permission to submit the next segment');
  assert.equal(extracted.length, 0, 'unfinished download cannot be used as a tail source');
  // Navigate away while the chain is alive. All output must stay with ownerId.
  const secondProject = createInitialState().project; secondProject.id = 'unrelated-project';
  state = { ...state, project: secondProject, projects: [owner(), secondProject] };
  downloadRelease!();
  await waitFor(() => posts.length === 2, 'segment 2 did not follow persisted segment 1');
  assert.equal(extracted.length, 1); remoteComplete.add(2);
  await waitFor(() => posts.length === 3, 'segment 3 did not follow persisted segment 2');
  remoteComplete.add(3);
  await waitFor(() => tasks().every((task) => Boolean(task.resultAssetId) && task.videoJob?.stage === 'succeeded'), 'all generated videos must be saved');
  assert.equal(posts.length, 3); assert.equal(extracted.length, 2); assert.equal(state.project.assets.length, secondProject.assets.length);
  assert.deepEqual(events, ['post-1', 'download-start-1', 'download-saved-1', 'extract-1', 'post-2', 'download-start-2', 'download-saved-2', 'extract-2', 'post-3', 'download-start-3', 'download-saved-3']);
  assert.equal(posts[0].first_frame_image, `data:image/png;base64,${seedBytes.toString('base64')}`);
  for (const [index, relativePath] of extracted.entries()) {
    const bytes = fs.readFileSync(path.join(assetRoot, relativePath));
    assert.equal(posts[index + 1].first_frame_image, `data:image/png;base64,${bytes.toString('base64')}`);
    const pixel = await run(['-i', path.join(assetRoot, relativePath), '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    if (index === 0) assert.ok(pixel[2] > 200 && pixel[0] < 20 && pixel[1] < 20, `first tail must be blue, not first-frame red: ${[...pixel]}`);
    else assert.ok(pixel[1] > 200 && pixel[0] < 20 && pixel[2] < 20, `second tail must be lime, not first-frame yellow: ${[...pixel]}`);
    assert.equal(tasks()[index + 1].videoJob?.snapshot.previousTail?.predecessorTaskId, tasks()[index].id);
  }
  for (const source of sourceMovies) assert.equal(hash(fs.readFileSync(source.file)), source.checksum, 'tail extraction must not alter original videos');
  const originalTasks = structuredClone(tasks());
  const originalAssets = structuredClone(owner().assets);
  const originalFiles = originalAssets.filter((asset) => asset.relativePath).map((asset) => ({ path: asset.relativePath!, checksum: hash(fs.readFileSync(path.join(assetRoot, asset.relativePath!))) }));
  const regenerated = await engine.startBatch({ ...input, force: true });
  assert.equal(regenerated.taskIds.length, 3, 'an explicit regenerate decision must create a new complete chain');
  assert.notEqual(regenerated.batchId, batch.batchId);
  await waitFor(() => posts.length === 4, 'completed first segment could not be generated again');
  assert.equal(extracted.length, 2, 'new chain must wait for its new predecessor, not extract the old completed parent');
  assert.equal(posts[3].first_frame_image, posts[0].first_frame_image, 'new first segment keeps the original manual reference');
  const repeatWhileRunning = await engine.startBatch({ ...input, force: true });
  assert.equal(repeatWhileRunning.taskIds.length, 0, 'force never authorizes a duplicate of still-running work');
  for (const number of [4, 5, 6]) {
    remoteComplete.add(number);
    if (number < 6) await waitFor(() => posts.length === number + 1, `regenerated segment ${number - 2} did not use its new parent`);
  }
  const newTasks = () => tasks().filter((task) => regenerated.taskIds.includes(task.id));
  await waitFor(() => newTasks().every((task) => Boolean(task.resultAssetId) && task.videoJob?.stage === 'succeeded'), 'regenerated videos must finish saving');
  assert.equal(posts.length, 6); assert.equal(extracted.length, 4);
  assert.equal(new Set(tasks().map((task) => task.id)).size, 6);
  assert.deepEqual(events.slice(11), ['post-4', 'download-start-4', 'download-saved-4', 'extract-3', 'post-5', 'download-start-5', 'download-saved-5', 'extract-4', 'post-6', 'download-start-6', 'download-saved-6']);
  for (const [index, relativePath] of extracted.slice(2).entries()) {
    const bytes = fs.readFileSync(path.join(assetRoot, relativePath));
    assert.equal(posts[index + 4].first_frame_image, `data:image/png;base64,${bytes.toString('base64')}`);
    assert.notEqual(posts[index + 4].first_frame_image, posts[index + 1].first_frame_image, 'new chain must not reuse the old tail image');
    const pixel = await run(['-i', path.join(assetRoot, relativePath), '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    if (index === 0) assert.ok(pixel[0] > 200 && pixel[2] > 200 && pixel[1] < 20, `new first tail should be magenta: ${[...pixel]}`);
    else assert.ok(pixel[0] > 200 && pixel[1] > 100 && pixel[1] < 190 && pixel[2] < 20, `new second tail should be orange: ${[...pixel]}`);
    assert.equal(newTasks()[index + 1].videoJob?.snapshot.previousTail?.predecessorTaskId, newTasks()[index].id);
  }
  for (const original of originalTasks) assert.deepEqual(tasks().find((task) => task.id === original.id), original, 'regeneration must preserve old task records');
  for (const original of originalAssets) assert.deepEqual(owner().assets.find((asset) => asset.id === original.id), original, 'regeneration must preserve old assets');
  for (const original of originalFiles) assert.equal(hash(fs.readFileSync(path.join(assetRoot, original.path))), original.checksum);
  console.log('Real-media original + regenerated chain passed: 6 saved videos, 4 exact fresh last-frame PNGs, explicit force, active duplicate protection, and unchanged old versions. No external API calls.');
} finally {
  engine?.dispose(); service.close();
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('lianhua-tail-chain-real-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
