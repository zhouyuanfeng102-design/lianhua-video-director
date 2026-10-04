import assert from 'node:assert/strict';
import { createImageGenerationTask } from '../src/generationTasks';
import { normalizeImageOutputSizes } from '../src/imageOutputSize';
import {
  defaultStoryboardImageOutputSize,
  normalizeStoryboardImageOutputSize,
  resolveStoryboardImageOutputSize,
  type StoryboardImageOutputSizePreference,
} from '../src/storyboardImageOutputSize';
import { createInitialState, defaultSettings, normalizeState, serializeStateForStorage } from '../src/storage';

let checks = 0;
const preference = (mode: StoryboardImageOutputSizePreference['mode']): StoryboardImageOutputSizePreference => ({
  ...defaultStoryboardImageOutputSize(), mode,
});

for (const [aspect, width, height] of [
  ['16:9', 1536, 1024], ['4:3', 1536, 1024], ['3:2', 1536, 1024],
  ['9:16', 1024, 1536], ['3:4', 1024, 1536], ['2:3', 1024, 1536],
  ['1:1', 1024, 1024], ['0.95:1', 1024, 1024], ['', 1536, 1024],
  ['历史画面9:16', 1024, 1536],
] as const) {
  for (const backend of ['openai', 'novelai', 'sd_webui', 'comfyui'] as const) {
    const result = resolveStoryboardImageOutputSize(preference('default'), aspect, backend);
    assert.deepEqual([result.width, result.height, result.sizeOverride, result.issue], [width, height, false, '']);
    assert.match(result.layoutNote, /保留原分镜画布/u);
    checks++;
  }
}

for (const [mode, edge] of [['1k', 1024], ['2k', 2048], ['4k', 4096]] as const) {
  for (const backend of ['openai', 'novelai', 'sd_webui', 'comfyui'] as const) {
    for (const [aspect, width, height] of [
      ['16:9', edge, edge * 9 / 16], ['9:16', edge * 9 / 16, edge],
      ['4:3', edge, edge * 3 / 4], ['3:4', edge * 3 / 4, edge], ['1:1', edge, edge],
    ] as const) {
      const result = resolveStoryboardImageOutputSize(preference(mode), aspect, backend);
      assert.deepEqual([result.width, result.height, result.sizeOverride, result.issue], [width, height, true, '']);
      assert.match(result.layoutNote, new RegExp(`按分镜 ${aspect}.*长边 ${edge}px`, 'u'));
      checks++;
    }
  }
}

for (const [backend, height, alignment] of [
  ['openai', 683, '整数像素'], ['comfyui', 683, '整数像素'],
  ['sd_webui', 688, '8像素步长'], ['novelai', 704, '64像素步长'],
] as const) {
  const result = resolveStoryboardImageOutputSize(preference('1k'), '3:2', backend);
  assert.deepEqual([result.width, result.height, result.issue], [1024, height, '']);
  assert.match(result.layoutNote, new RegExp(`短边向上对齐${alignment}.*实际比例略有差异`, 'u'));
  const portrait = resolveStoryboardImageOutputSize(preference('1k'), '2:3', backend);
  assert.deepEqual([portrait.width, portrait.height, portrait.issue], [height, 1024, '']);
  checks += 2;
}

for (const [backend, height] of [['openai', 429], ['comfyui', 429], ['sd_webui', 432], ['novelai', 448]] as const) {
  const result = resolveStoryboardImageOutputSize(preference('1k'), '2.39:1', backend);
  assert.deepEqual([result.width, result.height, result.issue], [1024, height, '']);
  assert.match(result.layoutNote, /短边向上对齐/u);
  checks++;
}
for (const aspect of ['16 x 9', '16×9', '16.0:9.0']) {
  assert.deepEqual(
    resolveStoryboardImageOutputSize(preference('2k'), aspect, 'openai'),
    resolveStoryboardImageOutputSize(preference('2k'), '16:9', 'openai'),
  );
  checks++;
}

const custom = { mode: 'custom', width: 2048, height: 2048 } as const;
for (const backend of ['openai', 'novelai', 'sd_webui', 'comfyui'] as const) {
  const result = resolveStoryboardImageOutputSize(custom, '16:9', backend);
  assert.deepEqual([result.width, result.height, result.sizeOverride, result.issue], [2048, 2048, true, '']);
  assert.match(result.layoutNote, /自定义比例 1:1.*与分镜比例 16:9 不同.*按自定义像素提交/u);
  assert.equal(resolveStoryboardImageOutputSize(custom, '', backend).issue, '', 'valid custom pixels do not need a storyboard ratio');
  checks++;
}
assert.equal(resolveStoryboardImageOutputSize(custom, '1:1', 'openai').layoutNote, '自定义比例 1:1'); checks++;
for (const backend of ['openai', 'comfyui'] as const) {
  const result = resolveStoryboardImageOutputSize({ ...custom, width: 1025, height: 1024 }, '16:9', backend);
  assert.deepEqual([result.width, result.height, result.issue], [1025, 1024, ''], 'unknown providers and workflows receive the exact custom request');
  checks++;
}
assert.match(resolveStoryboardImageOutputSize({ ...custom, width: 1025, height: 1024 }, '16:9', 'novelai').issue, /64的倍数/u); checks++;
assert.match(resolveStoryboardImageOutputSize({ ...custom, width: 1025, height: 1024 }, '16:9', 'sd_webui').issue, /8的倍数/u); checks++;

for (const dimension of [0, -1, 63, 4097, 8192, 1024.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  for (const key of ['width', 'height'] as const) {
    const result = resolveStoryboardImageOutputSize({ ...custom, [key]: dimension }, '16:9', 'openai');
    assert.ok(result.issue);
    assert.ok(Object.is(result[key], dimension), 'invalid custom input cannot silently round, clamp or fall back');
    assert.equal(result.sizeOverride, true);
    checks++;
  }
}
for (const aspect of ['', 'portrait', '0:9', '16:0', '-16:9', '16:-9', '16:9 trailing junk']) {
  const result = resolveStoryboardImageOutputSize(preference('4k'), aspect, 'openai');
  assert.match(result.issue, /分镜画面比例无效.*不会自动降档/u);
  assert.equal(result.sizeOverride, true);
  checks++;
}
for (const backend of ['openai', 'novelai', 'sd_webui', 'comfyui'] as const) {
  assert.match(resolveStoryboardImageOutputSize(preference('1k'), '10000:1', backend).issue, /短边不足64/u);
  checks++;
}
assert.match(resolveStoryboardImageOutputSize({ ...custom, mode: '8k' } as unknown as StoryboardImageOutputSizePreference, '16:9', 'openai').issue, /不会自动改用默认尺寸/u); checks++;

const normalized = normalizeStoryboardImageOutputSize(custom);
assert.deepEqual(normalized, custom);
assert.notEqual(normalized, custom);
assert.notEqual(defaultStoryboardImageOutputSize(), defaultStoryboardImageOutputSize());
for (const missing of [undefined, null, [], false, '2k', {}]) {
  assert.deepEqual(normalizeStoryboardImageOutputSize(missing), defaultStoryboardImageOutputSize());
  checks++;
}
for (const invalid of [0, 8192, 10.5, -12]) {
  const result = normalizeStoryboardImageOutputSize({ ...custom, width: invalid });
  assert.equal(result.width, invalid, 'saved invalid custom pixels stay invalid instead of silently degrading');
  assert.ok(resolveStoryboardImageOutputSize(result, '16:9', 'openai').issue);
  checks++;
}
for (const malformed of [NaN, Infinity, null, undefined, '2048']) {
  const result = normalizeStoryboardImageOutputSize({ ...custom, width: malformed });
  assert.equal(result.width, 0, 'malformed saved custom values keep a visible invalid sentinel');
  assert.equal(result.height, 2048);
  assert.ok(resolveStoryboardImageOutputSize(result, '16:9', 'openai').issue);
  checks++;
}
assert.deepEqual(normalizeStoryboardImageOutputSize({ ...custom, mode: 'unknown' }), { mode: 'default', width: 2048, height: 2048 }, 'an unknown mode does not erase remembered custom pixels'); checks++;

const state = createInitialState();
const secondState = createInitialState();
assert.notEqual(state.settings.storyboardImageOutputSize, secondState.settings.storyboardImageOutputSize);
assert.notEqual(state.settings.storyboardImageOutputSize, defaultSettings.storyboardImageOutputSize);
state.settings.imageOutputSizes = normalizeImageOutputSizes({
  ordinary: { mode: '2x', aspect: '9:16', width: 768, height: 1366 },
  private: { mode: 'custom', aspect: '3:2', width: 3072, height: 2048 },
});
const ordinaryBefore = structuredClone(state.settings.imageOutputSizes);
state.settings.storyboardImageOutputSize = preference('4k');
let restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(restored.settings.storyboardImageOutputSize, preference('4k'));
assert.deepEqual(restored.settings.imageOutputSizes, ordinaryBefore, 'shared storyboard choice cannot change ordinary/private preferences');
state.settings.storyboardImageOutputSize = { mode: 'custom', width: 1920, height: 1080 };
restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(restored.settings.storyboardImageOutputSize, state.settings.storyboardImageOutputSize);
assert.deepEqual(restored.settings.imageOutputSizes, ordinaryBefore);
delete state.settings.storyboardImageOutputSize;
restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(restored.settings.storyboardImageOutputSize, defaultStoryboardImageOutputSize(), 'old projects retain the previous canvas default');
assert.deepEqual(restored.settings.imageOutputSizes, ordinaryBefore);
checks += 6;

const frozenPreference = preference('4k');
const resolved = resolveStoryboardImageOutputSize(frozenPreference, '16:9', 'openai');
const task = createImageGenerationTask({
  id: 'storyboard-resolution-freeze', name: '分镜', assetKind: 'storyboard', imageVariant: 'storyboard-frame',
  prompt: 'A city in the rain', width: resolved.width, height: resolved.height, sizeOverride: resolved.sizeOverride,
  backend: 'openai', model: 'fixture',
}, 1);
frozenPreference.mode = '1k';
assert.deepEqual([task.width, task.height, task.sizeOverride], [4096, 2304, true], 'queued task size is a snapshot, not the mutable preference');
checks++;

console.log(`storyboardImageOutputSize: ${checks} checks passed`);
