import assert from 'node:assert/strict';
import { defaultImageOutputSize, IMAGE_OUTPUT_ASPECTS, normalizeImageOutputSizes, normalizePrivateFullBodyOutputSize, resolveImageOutputSize, imageReturnedSizeWarning } from '../src/imageOutputSize';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { getImageVariantGenerationSpec } from '../src/imageGeneration';
import { createImageGenerationTask } from '../src/generationTasks';

let checks = 0;
const defaults = { mode: 'default' as const, aspect: 'variant' as const, width: 1024, height: 1024 };
assert.deepEqual(defaultImageOutputSize(), { ...defaults, mode: '1k', resolutionVersion: 1 }); checks++;
for (const variant of ['reference', 'private-full-body', 'five-view', 'private-five-view', 'turnaround', 'private-turnaround', 'private-four-in-one', 'grid'] as const) {
  const canvas = getImageVariantGenerationSpec(variant).canvas;
  assert.deepEqual(resolveImageOutputSize(defaults, canvas, 'openai', variant), { ...canvas, sizeOverride: false, issue: '', layoutNote: variant === 'grid' ? '九宫格推荐1:1' : variant === 'private-full-body' ? '私密全身推荐2:3竖图' : variant.includes('turnaround') || variant.includes('five-view') || variant === 'private-four-in-one' ? '多视图推荐3:2' : '' });
  const larger = resolveImageOutputSize({ ...defaults, mode: '2x' }, canvas, 'openai', variant);
  assert.equal(larger.width, canvas.width * 2); assert.equal(larger.height, canvas.height * 2); assert.equal(larger.sizeOverride, true); assert.equal(larger.issue, '');
  checks += 2;
}
for (const aspect of IMAGE_OUTPUT_ASPECTS.filter((item) => item.value !== 'variant')) {
  const result = resolveImageOutputSize({ ...defaults, mode: '2x', aspect: aspect.value }, { width: 1024, height: 1024 }, 'novelai', 'reference');
  assert.equal(result.width, aspect.width * 2); assert.equal(result.height, aspect.height * 2); assert.equal(result.issue, ''); checks++;
}
const ordinaryFullBodyLandscape = resolveImageOutputSize(
  { ...defaults, mode: '2x', aspect: '3:2' },
  getImageVariantGenerationSpec('full-body').canvas,
  'openai',
  'full-body',
);
assert.equal(ordinaryFullBodyLandscape.width, 3072);
assert.equal(ordinaryFullBodyLandscape.height, 2048);
assert.equal(ordinaryFullBodyLandscape.issue, '');
assert.equal(ordinaryFullBodyLandscape.layoutNote, '', 'ordinary full-body keeps user-selected 3:2 instead of being aspect-locked');
checks += 4;
const custom = { ...defaults, mode: 'custom' as const, width: 4096, height: 4096 };
assert.equal(resolveImageOutputSize(custom, { width: 1024, height: 1024 }, 'openai', 'reference').width, 4096); checks++;
for (const width of [0, -1, 63, 16385, 32768, NaN, Infinity, 1024.5]) {
  const result = resolveImageOutputSize({ ...custom, width }, { width: 1024, height: 1024 }, 'openai', 'reference');
  assert.ok(result.issue); assert.ok(Object.is(result.width, width), 'invalid user input is not silently clamped'); checks++;
}
assert.match(resolveImageOutputSize({ ...custom, width: 1025, height: 1024 }, { width: 1024, height: 1024 }, 'novelai', 'reference').warning || '', /64的倍数/u); checks++;
assert.match(resolveImageOutputSize({ ...custom, width: 1025, height: 1024 }, { width: 1024, height: 1024 }, 'sd_webui', 'reference').warning || '', /8的倍数/u); checks++;
assert.equal(resolveImageOutputSize({ ...custom, width: 1025, height: 1024 }, { width: 1024, height: 1024 }, 'openai', 'reference').issue, '', 'unknown Images providers receive the exact requested pixels'); checks++;
assert.equal(resolveImageOutputSize({ ...custom, width: 1024, height: 2048 }, { width: 1024, height: 1024 }, 'openai', 'grid').issue, ''); checks++;
assert.match(resolveImageOutputSize(custom, { width: 1536, height: 1024 }, 'openai', 'turnaround').warning || '', /推荐3:2/u); checks++;
const locked = resolveImageOutputSize({ ...defaults, mode: '2x', aspect: '9:16' }, { width: 1536, height: 1024 }, 'openai', 'turnaround');
assert.equal(locked.width, 1152); assert.equal(locked.height, 2048); assert.match(locked.warning || '', /推荐3:2/u); checks++;
const privateFullBodyLocked = resolveImageOutputSize(
  { ...defaults, mode: '2x', aspect: '3:2' },
  getImageVariantGenerationSpec('private-full-body').canvas,
  'comfyui',
  'private-full-body',
);
assert.equal(privateFullBodyLocked.width, 3072); assert.equal(privateFullBodyLocked.height, 2048);
assert.match(privateFullBodyLocked.warning || '', /2:3竖图/u); checks++;
assert.match(
  resolveImageOutputSize(
    { ...custom, width: 3072, height: 2048 },
    getImageVariantGenerationSpec('private-full-body').canvas,
    'comfyui',
    'private-full-body',
  ).warning || '',
  /2:3竖图/u,
); checks++;
assert.deepEqual(normalizePrivateFullBodyOutputSize(3072, 2048), { width: 3072, height: 2048 }, 'valid frozen dimensions are not reshaped to the recommended full-body ratio');
assert.deepEqual(normalizePrivateFullBodyOutputSize(2048, 3072), { width: 2048, height: 3072 }); checks += 2;
const lanes = normalizeImageOutputSizes({ ordinary: { ...defaults, mode: '2x', aspect: '3:4' }, private: custom });
assert.notEqual(lanes.ordinary, lanes.private); assert.equal(lanes.ordinary.mode, '2x'); assert.equal(lanes.private.width, 4096); checks++;
const state = createInitialState();
state.settings.imageOutputSizes = lanes;
const loaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(loaded.settings.imageOutputSizes, lanes); checks++;
assert.deepEqual(normalizeImageOutputSizes(undefined), { ordinary: defaults, private: defaults }); checks++;
assert.deepEqual(normalizeImageOutputSizes({ ordinary: { mode: 'bad', width: NaN }, private: [] }), { ordinary: defaults, private: defaults }); checks++;
const requested = resolveImageOutputSize(lanes.ordinary, { width: 1024, height: 1024 }, 'openai', 'reference');
const task = createImageGenerationTask({ id: 'size-freeze', name: 'size', assetKind: 'character', imageVariant: 'reference', prompt: 'QA', width: requested.width, height: requested.height, sizeOverride: requested.sizeOverride, backend: 'openai', model: 'qa' }, 1);
lanes.ordinary.mode = '1x';
assert.equal(task.width, 1536); assert.equal(task.height, 2048); assert.equal(task.sizeOverride, true); checks++;
assert.equal(imageReturnedSizeWarning(requested, { width: 1536, height: 2048 }), '');
assert.match(imageReturnedSizeWarning(requested, { width: 512, height: 512 }), /实际返回512×512.*请求1536×2048/u);
assert.equal(imageReturnedSizeWarning(requested, undefined), ''); checks += 3;
const grokRequest = { width: 1024, height: 683, resolutionPlan: {
  version: 1, tier: '1K', logicalAspectRatio: '3:2', expected: { width: 1024, height: 683 },
  encoding: { kind: 'tier', value: '1K' }, profile: 'grok-k', verified: false,
} } as const;
assert.match(imageReturnedSizeWarning(grokRequest, { width: 1280, height: 864 }), /按1K原生档位和3:2画幅提交.*1024×683为档位估算.*实际返回1280×864/u); checks++;
const geminiRequest = { width: 1264, height: 848, resolutionPlan: {
  ...grokRequest.resolutionPlan, profile: 'gemini-k' as const, expected: { width: 1264, height: 848 },
} };
assert.match(imageReturnedSizeWarning(geminiRequest, { width: 1024, height: 683 }), /实际返回1024×683.*1K原生预期1264×848不同/u); checks++;
console.log(`imageOutputSize: ${checks} checks passed`);
