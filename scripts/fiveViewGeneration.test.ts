import assert from 'node:assert/strict';
import {
  FIVE_VIEW_LAYOUT_RULE,
  FIVE_VIEW_NEGATIVE_PROMPT,
  FULL_BODY_LAYOUT_RULE,
  FULL_BODY_NEGATIVE_PROMPT,
  IMAGE_VARIANT_OPTIONS,
  getImageVariantGenerationSpec,
  isPrivateImageVariant,
  ordinaryImageVariantConverterRule,
  ordinaryImageVariantNegativePrompt,
  fiveViewCompatibleNegativePrompt,
  privateImagePromptProblem,
  privateImageVariantConverterRule,
  privateImageVariantNegativePrompt,
  privateImageVariantRepairRule,
} from '../src/imageGeneration';
import { defaultImageOutputSize, imageOutputAspectLocked, resolveImageOutputSize } from '../src/imageOutputSize';
import { buildImagePrompt } from '../src/promptEngine';

let checks = 0;
for (const variant of ['five-view', 'private-five-view'] as const) {
  const spec = getImageVariantGenerationSpec(variant);
  assert.equal(spec.id, variant);
  assert.equal(spec.label, variant === 'five-view' ? '五视图' : '私密五视图');
  assert.deepEqual(spec.canvas, { width: 1536, height: 1024 });
  assert.ok(spec.direction.includes(FIVE_VIEW_LAYOUT_RULE));
  for (const marker of [
    '恰好五个区域', '两个头肩特写加三个全身视图', '左侧约占画布30%',
    '左上为正面头肩特写', '左下为严格90度左侧面头肩特写',
    '两个头肩特写各自独立放大', '右侧约占画布70%', '三个等宽全高区域',
    '正面全身、严格90度左侧面全身、背面全身', '仅右侧三个全身视图保持同一尺度',
    '不要求在特写格内展示完整全身', '不增加45度三分之四视图',
    '无头肩的物种以其真实头部或感知结构作近景', '无文字、编号、Logo和水印',
  ]) assert.ok(spec.direction.includes(marker), `${variant}: ${marker}`);
  assert.equal(imageOutputAspectLocked(variant), true);
  const size = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: '2x', aspect: '9:16' }, spec.canvas, 'openai', variant);
  assert.equal(size.width, 3072);
  assert.equal(size.height, 2048);
  assert.equal(size.issue, '');
  const invalid = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: 'custom', width: 1024, height: 1536 }, spec.canvas, 'openai', variant);
  assert.match(invalid.issue, /3:2/u);
  checks += 1;
}

assert.deepEqual(IMAGE_VARIANT_OPTIONS.character, ['portrait', 'half-body', 'full-body', 'five-view']);
assert.equal(isPrivateImageVariant('five-view'), false);
assert.equal(isPrivateImageVariant('private-five-view'), true);
assert.ok(ordinaryImageVariantConverterRule('five-view').includes(FIVE_VIEW_LAYOUT_RULE));
assert.ok(privateImageVariantConverterRule('private-five-view', 'full-body').includes(FIVE_VIEW_LAYOUT_RULE));
assert.ok(privateImageVariantRepairRule('private-five-view', 'full-body').includes(FIVE_VIEW_LAYOUT_RULE));
assert.equal(ordinaryImageVariantNegativePrompt('five-view'), FIVE_VIEW_NEGATIVE_PROMPT);
assert.equal(privateImageVariantNegativePrompt('private-five-view'), FIVE_VIEW_NEGATIVE_PROMPT);
assert.doesNotMatch(FIVE_VIEW_NEGATIVE_PROMPT, /cropped body|multiple views|contact sheet|duplicate person|split screen/iu,
  'the intentional portrait crops and five regions must not be forbidden by single-image negatives');
assert.ok(ordinaryImageVariantConverterRule('full-body').includes(FULL_BODY_LAYOUT_RULE));
assert.equal(ordinaryImageVariantNegativePrompt('full-body'), FULL_BODY_NEGATIVE_PROMPT);
assert.equal(ordinaryImageVariantNegativePrompt('turnaround'), '', 'legacy tasks retain their saved negative prompt');
assert.equal(privateImagePromptProblem('private-five-view', 'AI用自然语言描述两个头像与三个全身参考。', 'full-body'), '',
  'no new local wording or panel-count gate is introduced');
checks += 1;

const character = {
  name: '普通成年测试角色', gender: '男', age: '28岁', actualAge: '28岁',
  race: '人类', morphology: 'human-like', appearance: '黑发，清晰面容，左眉短疤',
  outfit: '蓝色长袖外套，灰色长裤，黑色鞋', height: '180厘米',
  style: '用户指定清晰水彩风格', nsfwFullBody: 'PRIVATE_PROFILE_SENTINEL_ONLY',
  nsfwPenis: 'UNSELECTED_PRIVATE_SENTINEL_ONLY',
};
const ordinary = buildImagePrompt('character', character, 'five-view');
assert.match(ordinary, /角色五视图身份设定/u);
assert.ok(ordinary.includes(FIVE_VIEW_LAYOUT_RULE));
assert.match(ordinary, /蓝色长袖外套，灰色长裤，黑色鞋/u);
assert.match(ordinary, /用户指定清晰水彩风格/u);
assert.doesNotMatch(ordinary, /PRIVATE_PROFILE_SENTINEL|UNSELECTED_PRIVATE_SENTINEL/u);
assert.match(buildImagePrompt('character', { ...character, outfit: '' }, 'five-view'), /常驻服装，保持穿着状态/u);
checks += 1;

const privatePrompt = buildImagePrompt('character', character, 'private-five-view', 'full-body');
assert.match(privatePrompt, /PRIVATE_PROFILE_SENTINEL_ONLY/u);
assert.match(privatePrompt, /用户指定清晰水彩风格/u);
assert.doesNotMatch(privatePrompt, /UNSELECTED_PRIVATE_SENTINEL_ONLY/u);
assert.ok(privatePrompt.includes(FIVE_VIEW_LAYOUT_RULE));
assert.doesNotMatch(privatePrompt, /裸体全身正面、严格90度左侧面、背面、45度/u,
  'the legacy four-full-body composition must not leak into the new private layout');
assert.throws(() => buildImagePrompt('character', character, 'private-five-view'), /必须同时指定/u);
assert.throws(() => buildImagePrompt('character', character, 'private-five-view', 'penis'), /五视图只能使用私密全身/u);
assert.throws(() => buildImagePrompt('location', character, 'private-five-view', 'full-body'), /只能由人物资料/u);
checks += 1;

const nonHuman = buildImagePrompt('character', {
  name: '机械测试兽', race: '四足机械兽', morphology: 'nonhuman',
  bodyPlan: '金属头部，四条机械腿，一条尾巴，不具有人形手臂', appearance: '灰色金属外壳和蓝色光学传感器',
}, 'five-view');
assert.match(nonHuman, /角色五视图身份设定/u);
assert.match(nonHuman, /机械/u);
assert.ok(nonHuman.includes(FIVE_VIEW_LAYOUT_RULE));
assert.doesNotMatch(nonHuman, /服装：与题材匹配的常驻服装/u);
checks += 1;

for (const legacy of ['turnaround', 'private-turnaround'] as const) {
  const spec = getImageVariantGenerationSpec(legacy);
  assert.match(spec.label, /四视图/u);
  assert.match(spec.direction, /四个等比例/u);
  assert.match(spec.direction, /45度前侧三分之四/u);
  assert.doesNotMatch(spec.direction, /五视图|头肩特写/u);
  const oldPrompt = buildImagePrompt('character', character, legacy, legacy.startsWith('private-') ? 'full-body' : undefined);
  assert.match(oldPrompt, /四视图/u);
  assert.doesNotMatch(oldPrompt, /五视图|头肩特写/u);
  checks += 1;
}
for (const untouched of ['portrait', 'half-body', 'full-body', 'private-full-body', 'private-four-in-one', 'private-close-up', 'grid'] as const) {
  assert.doesNotMatch(getImageVariantGenerationSpec(untouched).direction, /五视图|头肩特写|画布30%/u);
}
assert.match(getImageVariantGenerationSpec('private-four-in-one').direction, /恰好四个区域/u);
checks += 1;
const existingMicroNegative = 'explicit sexual act, full nudity, genital close-up, pornographic pose, duplicate body, text, logo, watermark';
assert.equal(fiveViewCompatibleNegativePrompt(existingMicroNegative),
  'explicit sexual act, full nudity, genital close-up, pornographic pose, text, logo, watermark',
  'only the five-view layout conflict is adapted; existing content restrictions are kept');
assert.equal(fiveViewCompatibleNegativePrompt('cropped body, multiple views, contact sheet, inconsistent identity, text'),
  'inconsistent identity, text');
assert.equal(fiveViewCompatibleNegativePrompt(undefined), '');
assert.equal(existingMicroNegative.includes('duplicate body'), true, 'the saved preset is not rewritten');
checks += 1;
console.log(`Five-view generation: ${checks} domain groups passed; no image generation, no model calls.`);
