import assert from 'node:assert/strict';
import { assertImageResolutionPlanForConfig, normalizeImageResolutionPlan, resolveImageResolution, resolveImageResolutionCapabilities } from '../src/imageResolution';
import { defaultImageOutputSize, normalizeImageOutputSizes, normalizePrivateFullBodyOutputSize, resolveImageOutputSize } from '../src/imageOutputSize';
import { defaultStoryboardImageOutputSize, normalizeStoryboardImageOutputSize, resolveStoryboardImageOutputSize } from '../src/storyboardImageOutputSize';
import type { ImageApiConfig, ImageVariant } from '../src/types';

let checks = 0;
const api = (fields: Partial<ImageApiConfig> = {}): ImageApiConfig => ({ enabled: true, backend: 'openai', model: 'fixture', baseUrl: '', apiKey: '', ...fields });
const gemini = api({ model: 'gemini-3-pro-image-preview', imageProtocol: 'gemini' });
const modern = api({ model: 'gpt-image-2', imageProtocol: 'openai-images' });
const legacy = api({ model: 'gpt-image-1', imageProtocol: 'openai-images' });
const nativeExpected = {
  '1:1': [1024, 1024], '3:2': [1264, 848], '2:3': [848, 1264],
  '4:3': [1200, 896], '3:4': [896, 1200], '16:9': [1376, 768], '9:16': [768, 1376],
};
for (const [tier, scale] of [['1K', 1], ['2K', 2], ['4K', 4]] as const) {
  for (const [ratio, [w, h]] of Object.entries(nativeExpected)) {
    const size = resolveImageResolution({ tier, logicalAspectRatio: ratio, exactAspect: true, config: gemini });
    assert.equal(size.issue, '');
    assert.deepEqual([size.width, size.height], [w * scale, h * scale]);
    assert.deepEqual(size.resolutionPlan?.encoding, { kind: 'tier', value: tier });
    assert.equal(size.resolutionPlan?.logicalAspectRatio, ratio);
    assertImageResolutionPlanForConfig(size.resolutionPlan!, gemini);
    assert.deepEqual(normalizeImageResolutionPlan({ ...size.resolutionPlan, credentials: 'never persist', url: 'never persist' }), size.resolutionPlan);
    checks += 6;
  }
}
for (const variant of ['five-view', 'private-five-view', 'turnaround', 'private-turnaround', 'private-four-in-one'] as ImageVariant[]) {
  const result = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '4k' }, { width: 1536, height: 1024 }, gemini, variant);
  assert.equal(result.issue, ''); assert.deepEqual([result.width, result.height], [5056, 3392]);
  assert.equal(result.resolutionPlan?.logicalAspectRatio, '3:2'); checks += 3;
}
const full = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '4k' }, { width: 1024, height: 1536 }, gemini, 'private-full-body');
assert.deepEqual([full.width, full.height, full.issue], [3392, 5056, '']); checks++;
assert.deepEqual(normalizePrivateFullBodyOutputSize(3392, 5056), { width: 3392, height: 5056 }); checks++;
const closeup = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '2k', aspect: '16:9' }, { width: 1024, height: 1024 }, gemini, 'private-close-up');
assert.deepEqual([closeup.width, closeup.height, closeup.issue], [2752, 1536, '']); checks++;
const grid = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '2k', aspect: '16:9' }, { width: 1024, height: 1024 }, gemini, 'grid');
assert.deepEqual([grid.width, grid.height, grid.issue], [2752, 1536, '']);
assert.match(grid.warning || '', /推荐1:1/u); checks += 2;
const flash = resolveImageResolution({ tier: '1K', logicalAspectRatio: '3:2', config: api({ imageProtocol: 'gemini', model: 'gemini-2.5-flash-image' }) });
assert.deepEqual([flash.width, flash.height, flash.issue], [1248, 832, '']); checks++;
for (const tier of ['2K', '4K'] as const) {
  const unsupportedFlash = resolveImageResolution({ tier, logicalAspectRatio: '3:2', config: api({ imageProtocol: 'gemini', model: 'gemini-2.5-flash-image' }) });
  assert.equal(unsupportedFlash.issue, ''); assert.match(unsupportedFlash.warning || '', /未声明/u);
  assert.match(unsupportedFlash.warning || '', /高档像素.*估算/u);
  assert.deepEqual(unsupportedFlash.resolutionPlan?.encoding, { kind: 'tier', value: tier });
  assert.equal(unsupportedFlash.resolutionPlan?.verified, false);
  assert.doesNotThrow(() => assertImageResolutionPlanForConfig(unsupportedFlash.resolutionPlan!, api({ imageProtocol: 'gemini', model: 'gemini-2.5-flash-image' }))); checks += 6;
}
assert.equal(resolveImageResolutionCapabilities(api({ model: 'gemini-nano-banana-2.1' })).profile, 'gemini-k'); checks++;
assert.equal(resolveImageResolutionCapabilities(api({ model: 'gpt-image-2.5-sunburst-low' })).verified, false); checks++;
const nativeCustom = resolveImageResolution({ tier: 'custom', width: 5056, height: 3392, logicalAspectRatio: '79:53', config: gemini });
assert.deepEqual([nativeCustom.width, nativeCustom.height, nativeCustom.issue], [5056, 3392, '']);
assert.equal(nativeCustom.resolutionPlan?.logicalAspectRatio, '3:2');
assert.deepEqual(nativeCustom.resolutionPlan?.encoding, { kind: 'tier', value: '4K' });
assertImageResolutionPlanForConfig(nativeCustom.resolutionPlan!, gemini); checks += 4;
const nativeCustomStoryboard = resolveStoryboardImageOutputSize({ mode: 'custom', width: 5056, height: 3392, resolutionVersion: 1 }, '3:2', gemini);
assert.equal(nativeCustomStoryboard.issue, '');
assert.match(nativeCustomStoryboard.layoutNote, /原生3:2画幅/u);
assert.doesNotMatch(nativeCustomStoryboard.layoutNote, /与分镜比例.*不同/u); checks += 3;
assert.throws(() => assertImageResolutionPlanForConfig({ ...nativeCustom.resolutionPlan!, encoding: { kind: 'tier', value: '1K' } }, gemini), /档位/u); checks++;
const arbitraryGemini = resolveImageResolution({ tier: 'custom', width: 4096, height: 2736, logicalAspectRatio: '3:2', config: gemini });
assert.equal(arbitraryGemini.issue, ''); assert.match(arbitraryGemini.warning || '', /原生接口仅提供档位控制.*自定义像素作为画面要求.*服务返回/u);
assert.deepEqual(arbitraryGemini.resolutionPlan?.encoding, { kind: 'size', value: '4096x2736' });
assert.equal(arbitraryGemini.resolutionPlan?.logicalAspectRatio, '256:171');
assert.doesNotThrow(() => assertImageResolutionPlanForConfig(arbitraryGemini.resolutionPlan!, gemini)); checks += 5;

for (const ratio of ['16:9', '9:16']) {
  const result = resolveImageResolution({ tier: '4K', logicalAspectRatio: ratio, config: modern });
  assert.equal(result.issue, ''); assert.equal(Math.max(result.width, result.height), 3840);
  assert.equal(result.width * result.height, 8_294_400);
  assert.deepEqual(result.resolutionPlan?.encoding, { kind: 'size', value: `${result.width}x${result.height}` });
  assertImageResolutionPlanForConfig(result.resolutionPlan!, modern); checks += 5;
}
for (const ratio of ['1:1', '3:2', '4:3', '16:9', '2:3', '3:4', '9:16']) {
  const landscape = Number(ratio.split(':')[0]) >= Number(ratio.split(':')[1]);
  const adapted = resolveImageResolution({ tier: '4K', logicalAspectRatio: ratio, exactAspect: true, config: modern });
  assert.equal(adapted.issue, '');
  assert.deepEqual([adapted.width, adapted.height], landscape ? [3840, 2160] : [2160, 3840]);
  assert.equal(adapted.resolutionPlan?.logicalAspectRatio, landscape ? '16:9' : '9:16');
  if (ratio !== '16:9' && ratio !== '9:16') assert.match(adapted.warning || '', /已适配原画幅/u);
  assert.doesNotThrow(() => assertImageResolutionPlanForConfig(adapted.resolutionPlan!, modern)); checks += 5;
}
const oversizedModern = resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 4096, height: 4096, config: modern });
assert.equal(oversizedModern.issue, ''); assert.match(oversizedModern.warning || '', /后端决定/u);
assert.deepEqual(oversizedModern.resolutionPlan?.encoding, { kind: 'size', value: '4096x4096' });
assert.doesNotThrow(() => assertImageResolutionPlanForConfig(oversizedModern.resolutionPlan!, modern)); checks += 4;
const fiveViewUhd = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '4k' }, { width: 1536, height: 1024 }, modern, 'five-view');
assert.deepEqual([fiveViewUhd.width, fiveViewUhd.height, fiveViewUhd.issue], [3840, 2160, '']);
assert.equal(fiveViewUhd.resolutionPlan?.logicalAspectRatio, '16:9');
assert.match(fiveViewUhd.warning || '', /原画幅3:2.*16:9/u);
assert.equal(fiveViewUhd.resolutionPlan?.verified, false); checks += 4;
const customFiveView = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: 'custom', width: 3840, height: 2160 }, { width: 1536, height: 1024 }, modern, 'five-view');
assert.deepEqual([customFiveView.width, customFiveView.height, customFiveView.issue], [3840, 2160, '']);
assert.equal(customFiveView.resolutionPlan?.logicalAspectRatio, '16:9');
assert.match(customFiveView.warning || '', /推荐3:2/u); checks += 3;
const explicitFiveView = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '2k', aspect: '16:9' }, { width: 1536, height: 1024 }, modern, 'five-view');
assert.equal(explicitFiveView.resolutionPlan?.logicalAspectRatio, '16:9');
assert.match(explicitFiveView.warning || '', /推荐3:2/u); checks += 2;
const modern1k = resolveImageResolution({ tier: '1K', logicalAspectRatio: '16:9', config: modern });
assert.deepEqual([modern1k.width, modern1k.height, modern1k.issue], [1536, 864, '']);
assert.match(modern1k.layoutNote, /最小像素/u); checks += 2;
assert.deepEqual(resolveImageResolution({ tier: '1K', logicalAspectRatio: '3:2', config: legacy }).resolutionPlan?.expected, { width: 1536, height: 1024 }); checks++;
assert.match(resolveImageResolution({ tier: '2K', logicalAspectRatio: '1:1', config: legacy }).warning || '', /未声明/u); checks++;
assert.equal(resolveImageResolution({ tier: '1K', logicalAspectRatio: '16:9', config: legacy }).issue, ''); checks++;
const legacyUhd = resolveImageResolution({ tier: '4K', logicalAspectRatio: '2:3', config: legacy });
assert.deepEqual([legacyUhd.width, legacyUhd.height, legacyUhd.issue], [2160, 3840, '']);
assert.match(legacyUhd.warning || '', /未声明/u); checks += 2;
const xai = api({ imageProtocol: 'xai', model: 'grok-imagine-image' });
assert.match(resolveImageResolution({ tier: '4K', logicalAspectRatio: '1:1', config: xai }).warning || '', /未声明/u); checks++;
const xaiCustom = resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 1600, height: 900, config: xai });
assert.equal(xaiCustom.issue, ''); assert.match(xaiCustom.warning || '', /原生接口仅提供档位控制.*自定义像素作为画面要求.*服务返回/u);
assert.deepEqual(xaiCustom.resolutionPlan?.encoding, { kind: 'size', value: '1600x900' });
assert.equal(xaiCustom.resolutionPlan?.logicalAspectRatio, '16:9');
assert.doesNotThrow(() => assertImageResolutionPlanForConfig(xaiCustom.resolutionPlan!, xai)); checks += 5;
assert.ok(resolveImageResolution({ tier: '2K', logicalAspectRatio: '1:1', config: api({ imageProtocol: 'gemini', imageResolutionProfile: 'grok-k' }) }).issue); checks++;

for (const backend of ['comfyui', 'sd_webui', 'novelai'] as const) {
  const local = api({ backend });
  assert.equal(resolveImageResolution({ tier: '1K', logicalAspectRatio: '1:1', config: local }).issue, '');
  assert.match(resolveImageResolution({ tier: '2K', logicalAspectRatio: '1:1', config: local }).warning || '', /未声明/u);
  assert.match(resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 2048, height: 2048, config: local }).warning || '', /超出/u);
  const declared = api({ backend, imageSupportedResolutions: ['1K', '2K', '4K'] });
  const allowed = resolveImageResolution({ tier: '2K', logicalAspectRatio: '3:2', exactAspect: true, config: declared });
  assert.equal(allowed.issue, ''); assert.equal(allowed.width * 2, allowed.height * 3);
  assert.equal(allowed.width % resolveImageResolutionCapabilities(declared).pixelStep, 0);
  assertImageResolutionPlanForConfig(allowed.resolutionPlan!, declared);
  assert.doesNotThrow(() => assertImageResolutionPlanForConfig(allowed.resolutionPlan!, local));
  const unaligned = resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 1025, height: 1024, config: local });
  assert.equal(unaligned.issue, ''); assert.match(unaligned.warning || '', /倍数/u);
  assert.deepEqual(unaligned.resolutionPlan?.expected, { width: 1025, height: 1024 });
  assert.doesNotThrow(() => assertImageResolutionPlanForConfig(unaligned.resolutionPlan!, local)); checks += 12;
}
assert.ok(resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 16385, height: 16385, config: api() }).issue); checks++;
assert.equal(resolveImageResolution({ tier: 'custom', logicalAspectRatio: '1:1', width: 8192, height: 8192, config: api() }).width, 8192); checks++;

assert.equal(defaultImageOutputSize().mode, '1k'); assert.equal(defaultStoryboardImageOutputSize().mode, '1k'); checks += 2;
assert.equal(normalizeImageOutputSizes(undefined).ordinary.mode, 'default');
assert.equal(normalizeStoryboardImageOutputSize(undefined).mode, 'default'); checks += 2;
const oldPreference = normalizeStoryboardImageOutputSize({ mode: '2k', width: 1024, height: 1024 });
const oldStoryboard = resolveStoryboardImageOutputSize(oldPreference, '3:2', gemini);
assert.deepEqual([oldStoryboard.width, oldStoryboard.height, oldStoryboard.resolutionPlan], [2048, 1366, undefined]); checks++;
const newStoryboard = resolveStoryboardImageOutputSize({ ...oldPreference, resolutionVersion: 1 }, '3:2', gemini);
assert.deepEqual([newStoryboard.width, newStoryboard.height], [2528, 1696]); checks++;
const oldWorkbench = resolveImageOutputSize({ mode: '2x', aspect: '3:2', width: 1024, height: 1024 }, { width: 1024, height: 1024 }, api({ backend: 'comfyui' }), 'reference');
assert.deepEqual([oldWorkbench.width, oldWorkbench.height, oldWorkbench.issue, oldWorkbench.resolutionPlan], [3072, 2048, '', undefined]); checks++;
const oldCustom = resolveImageOutputSize({ mode: 'custom', aspect: 'variant', width: 3072, height: 2048 }, { width: 1024, height: 1024 }, api({ backend: 'comfyui' }), 'reference');
assert.deepEqual([oldCustom.width, oldCustom.height, oldCustom.issue], [3072, 2048, '']); checks++;
assert.equal(normalizeImageResolutionPlan({ ...newStoryboard.resolutionPlan!, expected: { width: Number.NaN, height: 1 } }), undefined); checks++;
assert.equal(normalizeImageResolutionPlan({ ...newStoryboard.resolutionPlan!, encoding: { kind: 'size', value: 'http://example.test' } }), undefined); checks++;
console.log(`imageResolution: ${checks} focused checks passed`);
