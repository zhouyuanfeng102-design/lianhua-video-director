import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import {
  cancelQueuedGenerationTask, createImagePromptReverseTask, isGenerationTaskRevoked,
  isImagePromptReverseTask, patchImagePromptReverseTask, removeGenerationTask,
  revokeImagePromptReverseTask, revokeQueuedGenerationTask, settleImagePromptReverseTask,
} from '../src/generationTasks';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import type { AppState, GenerationTask, ImagePromptReverseResult, ImagePromptReverseTask, ImageReferenceAssetSnapshot, Project } from '../src/types';

const initial = createInitialState();
const reference: ImageReferenceAssetSnapshot = {
  id: 'original', name: '原图', type: 'reference', role: 'composition', relativePath: 'image/original.png',
  checksum: 'a'.repeat(64), managed: true, mediaType: 'image', width: 2048, height: 1536,
};
const result: ImagePromptReverseResult = {
  prompt: '完整独立的反推词\n包含构图、主体、材质和光线。', characters: '未发现可辨人物', objects: '一只陶瓷花瓶',
  scene: '木桌和浅色背景', style: '自然光静物摄影', composition: '居中构图', lighting: '左侧柔光',
  colors: '米白和棕色', readableText: '没有可辨文字', keyPoints: '花瓶形状与桌面纹理', avoid: '避免添加人物',
  uncertainties: '瓶口内部不可见', adjustmentSuggestions: '可根据要求更换背景',
};
const task = (overrides: Partial<ImagePromptReverseTask> = {}): ImagePromptReverseTask => ({
  id: 'reverse', kind: 'image-prompt-reverse', name: '原图 · 图片反推', status: 'succeeded', referenceAssetId: reference.id,
  referenceAssetSnapshots: [reference], customRequirement: '仔细识别花瓶材质', model: 'vision-model',
  width: 2048, height: 1536, result, createdAt: 1, updatedAt: 2, ...overrides,
});
const project = (id: string, tasks: GenerationTask[] = []): Project => ({
  ...initial.project, id, assets: [], generationTasks: tasks,
});
const state = (owner: Project, others: Project[] = []): AppState => ({
  ...initial, project: owner, projects: [owner, ...others], activeProjectId: owner.id,
});
const roundTrip = (value: AppState) => normalizeState(JSON.parse(serializeStateForStorage(value).serialized));

const restored = roundTrip(state(project('owner', [task()]), [project('background', [task({ id: 'other' })])]));
assert.deepEqual(restored.project.generationTasks[0], task(), 'complete analysis and original snapshot survive save/reload without asset cards');
assert.deepEqual(restored.projects.find((item) => item.id === 'background')?.generationTasks[0], task({ id: 'other' }));
assert.equal('chapterId' in restored.project.generationTasks[0], false, 'reverse tasks stay project-shared');

for (const status of ['queued', 'running'] as const) {
  const interrupted = roundTrip(state(project('owner', [task({ status, preparationStage: 'reference', result: undefined })]))).project.generationTasks[0];
  assert.ok(isImagePromptReverseTask(interrupted));
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error || '', /中断.*不会自动/u);
  assert.equal(interrupted.preparationStage, undefined);
}
const cancelled = roundTrip(state(project('owner', [task({ status: 'cancelled', result: undefined })]))).project.generationTasks[0];
assert.equal(cancelled.status, 'cancelled');
const damaged = roundTrip(state(project('owner', [task({ result: { ...result, scene: '' } })]))).project.generationTasks[0];
assert.ok(isImagePromptReverseTask(damaged));
assert.equal(damaged.status, 'failed');
assert.equal(damaged.result, undefined);
assert.match(damaged.error || '', /结果不完整/u);

const noisyTask = { ...task(), apiKey: 'task-secret', url: 'https://secret.invalid', chapterId: 'must-drop',
  result: { ...result, apiKey: 'result-secret', rawResponse: 'must-drop' },
  referenceAssetSnapshots: [{ ...reference, apiKey: 'snapshot-secret', dataUrl: 'data:image/png;base64,AA==', url: 'https://secret.invalid' }],
} as ImagePromptReverseTask;
const clean = roundTrip(state(project('owner', [noisyTask]))).project.generationTasks[0];
assert.deepEqual(clean, task(), 'strict allow-lists strip arbitrary task, result and snapshot fields');
for (const relativePath of ['../outside.png', 'C:/outside.png', 'https://unsafe.invalid/a.png']) {
  const unsafe = roundTrip(state(project('owner', [task({ referenceAssetSnapshots: [{ ...reference, relativePath }] })]))).project.generationTasks[0];
  assert.ok(isImagePromptReverseTask(unsafe));
  assert.deepEqual(unsafe.referenceAssetSnapshots, []);
}

const created = createImagePromptReverseTask({ id: 'created', name: '图片反推', referenceAssetId: reference.id, referenceAssetSnapshots: [reference], model: 'mock' }, 10);
assert.equal(created.status, 'queued');
assert.equal(created.createdAt, 10);
assert.equal(created.updatedAt, 10);
const started = patchImagePromptReverseTask([created], created.id, { status: 'running', preparationStage: 'reference' }, 11)[0];
assert.ok(isImagePromptReverseTask(started));
assert.equal(removeGenerationTask([started], started.id).blocked, true, 'running analysis must stop before deletion');
assert.equal(cancelQueuedGenerationTask([started], started.id).blocked, true, 'generic cancellation remains queued-only');
const queuedCancellation = cancelQueuedGenerationTask([created], created.id, 12);
assert.equal(queuedCancellation.cancelled, true);
assert.equal(queuedCancellation.tasks[0].status, 'cancelled');
assert.equal(revokeQueuedGenerationTask('queued-owner', created), true);
assert.equal(isGenerationTaskRevoked('queued-owner', created), true);

assert.equal(revokeImagePromptReverseTask('stopped-owner', started), true);
assert.equal(isGenerationTaskRevoked('stopped-owner', started), true);
assert.deepEqual(settleImagePromptReverseTask([], started, { status: 'succeeded', result }, 20, 'stopped-owner'), [],
  'a stopped then deleted request cannot be resurrected by a late response');
assert.equal(isGenerationTaskRevoked('different-owner', started), false, 'same task identity in another project is independent');
const stopped = { ...started, status: 'cancelled' as const };
assert.deepEqual(patchImagePromptReverseTask([stopped], stopped.id, { status: 'succeeded', result }, 20), [stopped]);
assert.deepEqual(settleImagePromptReverseTask([stopped], started, { status: 'succeeded', result }, 20), [stopped]);
assert.equal(removeGenerationTask([stopped], stopped.id).removed, true);
assert.equal(settleImagePromptReverseTask([created], created, { status: 'succeeded', result: { ...result, prompt: '' } }, 20)[0].status, 'failed');

const laterInstance = { ...created, createdAt: 999 };
assert.deepEqual(settleImagePromptReverseTask([laterInstance], created, { status: 'succeeded', result }, 20), [laterInstance]);
const active = project('active');
const background = project('background', [created]);
const transitioned = applyOwnedProjectUpdate(state(active, [background]), background.id, (owner) => ({
  ...owner, generationTasks: settleImagePromptReverseTask(owner.generationTasks, created, { status: 'succeeded', result }, 20, owner.id),
}));
assert.equal(transitioned.project.id, active.id);
assert.deepEqual(transitioned.project.generationTasks, []);
assert.equal(transitioned.projects.find((item) => item.id === background.id)?.generationTasks[0].status, 'succeeded',
  'background completion only updates its owning project');

const legacyImage: GenerationTask = { id: 'image', kind: 'image', name: '旧生图', assetKind: 'custom', imageVariant: 'reference',
  status: 'running', prompt: '旧词', width: 1024, height: 1024, backend: 'openai', model: 'image', createdAt: 1, updatedAt: 2 };
const legacyAutofill: GenerationTask = { id: 'autofill', kind: 'autofill', name: '旧补齐', assetKind: 'character', status: 'running',
  requestedFields: ['appearance'], model: 'text', createdAt: 1, updatedAt: 2 };
for (const legacy of [legacyImage, legacyAutofill]) {
  assert.equal(revokeImagePromptReverseTask('legacy', legacy), false, 'special running-stop permission never expands existing task kinds');
  assert.equal(revokeQueuedGenerationTask('legacy', legacy), false);
  assert.equal(removeGenerationTask([legacy], legacy.id).blocked, true);
}
const oldState = roundTrip(initial);
assert.deepEqual(oldState.project.generationTasks, []);
console.log('image prompt reverse persistence, recovery, original snapshots, cancellation and owning-project settlement passed');
