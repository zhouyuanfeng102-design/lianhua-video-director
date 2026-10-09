import assert from 'node:assert/strict';
import {
  cancelQueuedGenerationTask,
  createImageGenerationTask,
  patchImageGenerationTask,
  settleImageGenerationTask,
} from '../src/generationTasks';
import { enqueueImageTask } from '../src/imageTaskQueue';
import {
  authoredStoryboardImageSourceFingerprint,
  failImagePreparationTasks,
  imagePreparationStageLabel,
  normalizeImageTaskPreparationStage,
  updateImagePreparationTasks,
  type ImagePreparationStage,
} from '../src/imageTaskPreparation';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { GenerationTask, ImageGenerationTask, Storyboard } from '../src/types';

// Synthetic fixtures only: no real project, private text, model request or filesystem save.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stages: ImagePreparationStage[] = ['identity', 'reference', 'frame-plan', 'prompt-convert'];
const makeTask = (index: number): ImageGenerationTask => createImageGenerationTask({
  id: `preparation-${index}`, name: `Synthetic image ${index + 1}`,
  assetKind: 'storyboard', imageVariant: index % 2 ? 'storyboard-frame' : 'first-frame',
  sourceStoryboardId: 'preparation-board', sourceShotId: `shot-${index}`,
  batchId: `batch-${Math.floor(index / 5)}`, preparationStage: stages[index % stages.length],
  prompt: '', width: 1024, height: 1024, backend: 'openai', model: 'synthetic-image-model',
}, index + 1, 'queued');

const initial = createInitialState();
const savedTasks = Array.from({ length: 100 }, (_, index) => makeTask(index));
savedTasks.forEach((task, index) => { task.batchId = 'hundred-frame-batch'; task.batchIndex = index + 1; task.batchCount = 100; });
const project = { ...initial.project, id: 'preparation-project', name: 'Synthetic preparation fixture',
  generationTasks: savedTasks, assets: [], storyboards: [], scenes: [], characters: [], locations: [], props: [] };
const state = { ...initial, project, projects: [project], activeProjectId: project.id };
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.equal(restored.project.generationTasks.length, 100, 'large pending batches retain every record after reload');
assert.deepEqual(restored.project.generationTasks.map((task) => task.id), savedTasks.map((task) => task.id));
for (const [index, item] of restored.project.generationTasks.entries()) {
  assert.equal(item.kind, 'image');
  const task = item as ImageGenerationTask;
  assert.equal(task.status, 'failed', 'a restart never automatically resubmits an interrupted image');
  assert.equal(task.preparationStage, savedTasks[index].preparationStage, 'the interrupted preparation stage remains diagnosable');
  assert.match(task.error || '', /准备阶段.*中断.*记录已保留/u);
  assert.ok(task.error?.includes(imagePreparationStageLabel(stages[index % stages.length])));
  assert.equal(task.batchId, savedTasks[index].batchId);
  assert.equal(task.batchIndex, index + 1, 'every storyboard slot survives, including slots beyond the workbench limit');
  assert.equal(task.batchCount, 100, 'the large storyboard batch retains its original requested count');
}
assert.equal(savedTasks.every((task) => task.status === 'queued'), true, 'reload cannot mutate the live request');
assert.equal(normalizeImageTaskPreparationStage('identity'), 'identity');
for (const invalid of [undefined, null, {}, 'download', '__proto__', 1]) {
  assert.equal(normalizeImageTaskPreparationStage(invalid), undefined, 'unrecognized preparation stages never survive loading');
}
const damaged = clone(state);
(damaged.project.generationTasks[0] as unknown as { preparationStage: unknown }).preparationStage = 'download';
const sanitized = normalizeState(damaged).project.generationTasks[0] as ImageGenerationTask;
assert.equal(sanitized.preparationStage, undefined);

const originals = [makeTask(200), makeTask(201), makeTask(202), makeTask(203), makeTask(204), makeTask(205)];
const cancelled = { ...originals[1], status: 'cancelled' as const };
const replaced = { ...originals[2], createdAt: originals[2].createdAt + 1 };
const foreignBatch = { ...originals[3], batchId: 'replacement-batch' };
const succeeded = { ...originals[4], status: 'succeeded' as const };
const eligible: GenerationTask[] = [originals[0], cancelled, replaced, foreignBatch, succeeded];
const updated = updateImagePreparationTasks(eligible, originals, (task, index) => ({
  ...task, preparationStage: 'frame-plan', name: `${task.name}:updated:${index}`,
}));
assert.equal((updated[0] as ImageGenerationTask).preparationStage, 'frame-plan');
assert.strictEqual(updated[1], cancelled, 'cancellation cannot be undone by late preparation');
assert.strictEqual(updated[2], replaced, 'a replaced task ID cannot accept the old result');
assert.strictEqual(updated[3], foreignBatch, 'a different batch cannot accept the old result');
assert.strictEqual(updated[4], succeeded, 'a settled task cannot be rewritten');
assert.equal(updated.length, 5, 'missing tasks are never reinserted');
const failed = failImagePreparationTasks(updated, originals, 'Synthetic preparation failed');
assert.equal(failed[0].status, 'failed');
assert.equal((failed[0] as ImageGenerationTask).preparationStage, undefined);
assert.equal((failed[0] as ImageGenerationTask).error, 'Synthetic preparation failed');
assert.strictEqual(failed[1], cancelled);
const stopped = failImagePreparationTasks([originals[0]], originals, 'Source changed', true);
assert.equal(stopped[0].status, 'cancelled');
assert.equal((stopped[0] as ImageGenerationTask).preparationStage, undefined);

for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
  const terminal = patchImageGenerationTask([originals[0]], originals[0].id, { status });
  assert.equal((terminal[0] as ImageGenerationTask).preparationStage, undefined,
    'ordinary terminal status patches cannot retain an active preparation stage');
}
const runningWithoutStage = { ...originals[0], status: 'running' as const, preparationStage: undefined };
const currentWithConversion = { ...originals[0], status: 'running' as const, preparationStage: 'prompt-convert' as const };
const settled = settleImageGenerationTask([currentWithConversion], runningWithoutStage, { status: 'succeeded' });
assert.equal((settled[0] as ImageGenerationTask).preparationStage, undefined,
  'settlement clears a stage recorded on the live task even when the original has no stage');
const queuedCancellation = cancelQueuedGenerationTask([originals[0]], originals[0].id);
assert.equal(queuedCancellation.cancelled, true);
assert.equal((queuedCancellation.tasks[0] as ImageGenerationTask).preparationStage, undefined,
  'explicit queued image cancellation clears preparation progress');

const board: Storyboard = {
  id: 'authored-board', sceneId: 'authored-scene', workflow: 'drama', inputMode: 'text',
  durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'synthetic-style',
  ruleSetId: 'synthetic-rule', converterPresetId: 'synthetic-converter', globalLock: 'One synthetic room',
  sourceStoryContent: 'An adult character sits at a desk.', finalPrompt: 'A single seated character.',
  officialPromptZh: 'Synthetic Chinese H3 delivery.', createdAt: 1, updatedAt: 1,
  sourceSceneSnapshots: [{ id: 'scene', title: 'Synthetic scene', content: 'A room and a desk', summary: '',
    characterIds: [], propIds: [], storyboardIds: ['authored-board'], createdAt: 1, updatedAt: 1 }],
  shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 10, purpose: 'introduction', subject: 'adult character',
    action: 'sitting', camera: 'medium shot', transition: 'cut', lighting: 'daylight', sound: 'room tone',
    result: 'character remains seated', prompt: 'One seated adult character.', referenceAssetIds: [], locked: false }],
};
const fingerprint = authoredStoryboardImageSourceFingerprint(board);
const completedOtherImage = clone(board);
completedOtherImage.updatedAt = 999;
completedOtherImage.firstFrameAssetId = 'new-first-frame';
completedOtherImage.lastFrameAssetId = 'new-last-frame';
completedOtherImage.shots[0].referenceAssetIds.push('new-generated-storyboard-image');
completedOtherImage.imageToImage = { referenceAssetIds: ['chosen-reference'], selectedShotIds: ['shot'], referenceAssetIdsByShotId: {} };
completedOtherImage.englishPrompt = 'New translation';
completedOtherImage.officialPromptEn = 'New English H3 delivery';
completedOtherImage.sourceSceneSnapshots![0].updatedAt = 999;
completedOtherImage.sourceSceneSnapshots![0].storyboardIds.push('another-generated-board');
assert.equal(authoredStoryboardImageSourceFingerprint(completedOtherImage), fingerprint,
  'generated image bindings, translations and timestamps cannot silently discard preparation');
for (const mutate of [
  (value: Storyboard) => { value.sourceStoryContent = 'The authored story changed.'; },
  (value: Storyboard) => { value.finalPrompt = 'The canonical prompt changed.'; },
  (value: Storyboard) => { value.officialPromptZh = 'The authoritative H3 changed.'; },
  (value: Storyboard) => { value.shots[0].action = 'standing'; },
  (value: Storyboard) => { value.shots[0].camera = 'close-up'; },
  (value: Storyboard) => { value.sourceSceneSnapshots![0].content = 'A different room'; },
]) {
  const changed = clone(board); mutate(changed);
  assert.notEqual(authoredStoryboardImageSourceFingerprint(changed), fingerprint,
    'actual authored story, H3 and visual shot edits remain visible to source validation');
}
assert.notEqual(authoredStoryboardImageSourceFingerprint(undefined), fingerprint, 'a deleted board is no longer current');

// More than thirty requests are visible immediately, while one worker keeps
// generation plus saving serialized and a rejection releases the next item.
const queueOriginals = Array.from({ length: 36 }, (_, index) => makeTask(300 + index));
let queueTasks: GenerationTask[] = [...queueOriginals];
let releaseFirst!: () => void;
let firstStarted!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
const startedGate = new Promise<void>((resolve) => { firstStarted = resolve; });
const events: string[] = [];
let active = 0;
let peak = 0;
const jobs = queueOriginals.map((original, index) => enqueueImageTask(async () => {
  queueTasks = updateImagePreparationTasks(queueTasks, [original], (task) => ({
    ...task, status: 'running', preparationStage: undefined,
  }));
  active += 1; peak = Math.max(peak, active); events.push(`start:${original.id}`);
  try {
    if (index === 0) { firstStarted(); await firstGate; }
    if (index === 1 || index === 18) throw new Error(`Synthetic failure ${index}`);
    await Promise.resolve(); // asynchronous result saving stays inside the worker
    queueTasks = updateImagePreparationTasks(queueTasks, [original], (task) => ({ ...task, status: 'succeeded' }));
    events.push(`save:${original.id}`);
    return original.id;
  } catch (error) {
    queueTasks = failImagePreparationTasks(queueTasks, [original], String(error));
    throw error;
  } finally { active -= 1; }
}));
const drained = Promise.allSettled(jobs);
await startedGate;
assert.equal(queueTasks.length, 36);
assert.equal(queueTasks.filter((task) => task.status === 'queued').length, 35,
  'later batches are already recorded while the first image is in flight');
releaseFirst();
const results = await drained;
assert.equal(results.filter((result) => result.status === 'fulfilled').length, 34);
assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
assert.equal(peak, 1, 'queue growth never amplifies image-model concurrency');
assert.deepEqual(events.filter((event) => event.startsWith('start:')), queueOriginals.map((task) => `start:${task.id}`));
assert.equal(queueTasks.length, 36, 'failure cannot remove any pending or settled task');
assert.equal(queueTasks.filter((task) => task.status === 'failed').length, 2);
assert.equal(queueTasks[35].status, 'succeeded', 'failure in early and later batches does not block the final image');
assert.deepEqual(queueTasks.map((task) => task.id), queueOriginals.map((task) => task.id));

console.log('Image preparation checks passed: 100-task reload, stage diagnostics, source edits versus generated bindings, cancellation/replacement safety and 36-item FIFO with failed-member continuation.');
