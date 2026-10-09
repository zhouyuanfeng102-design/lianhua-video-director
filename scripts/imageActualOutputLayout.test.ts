import assert from 'node:assert/strict';
import {
  getImageVariantGenerationSpec, imagePromptOutputSpecificationRule, ordinaryImageVariantConverterRule,
  privateImageVariantConverterRule, privateImageVariantRepairRule, type ImagePromptOutputSpecification,
} from '../src/imageGeneration';
import {
  BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS, BUILT_IN_IMAGE_PROMPT_RULE_SETS, FIVE_VIEW_IMAGE_PRESET_IDS,
  buildImagePromptConverterSystemPrompt, resolveImagePromptSelection,
} from '../src/imagePromptRules';
import { buildImagePrompt } from '../src/promptEngine';
import type { ImageVariant } from '../src/types';

const originalCatalog = JSON.stringify([BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS, BUILT_IN_IMAGE_PROMPT_RULE_SETS]);
const fields = { name: '测试角色', gender: '女', morphology: 'human', appearance: '固定外观', outfit: '固定衣着',
  nsfwFullBody: '固定身体轮廓', nsfwBreasts: '固定肤色纹理', nsfwVulva: '固定肤色纹理', nsfwAnus: '固定肤色纹理' };
const finalBlock = (value: string): string => {
  const blocks = value.match(/<current_image_output_specification>[\s\S]*?<\/current_image_output_specification>/gu);
  assert.ok(blocks?.length, 'the request must carry a final output contract');
  return blocks[blocks.length - 1];
};
const layouts: Array<{ variant: ImageVariant; count: RegExp }> = [
  { variant: 'full-body', count: /一个完整主体的单幅全身图/u },
  { variant: 'five-view', count: /五区域参考板.*左侧上下两头肩特写，右侧三个指定角度全身/u },
  { variant: 'turnaround', count: /四视图参考板.*四个全身视角/u },
  { variant: 'private-full-body', count: /一个完整主体的单幅全身图/u },
  { variant: 'private-close-up', count: /指定部位只出现一次.*不拉远补全身/u },
  { variant: 'private-five-view', count: /五区域参考板.*左侧上下两头肩特写，右侧三个指定角度全身/u },
  { variant: 'private-turnaround', count: /四视图参考板.*四个全身视角/u },
  { variant: 'private-four-in-one', count: /四个固定槽位.*左侧约70%.*右侧约30%.*三个辅助部位窗/u },
  { variant: 'grid', count: /当前实际画幅的3×3九宫格母版.*九格数量、阅读顺序/u },
];
for (const output of [
  { width: 3840, height: 2160, aspectRatio: '16:9', resolution: '4K' },
  { width: 2160, height: 3840, aspectRatio: '9:16', resolution: '4K' },
] satisfies ImagePromptOutputSpecification[]) {
  for (const { variant, count } of layouts) {
    const privateVariant = variant.startsWith('private-');
    const part = variant === 'private-close-up' ? 'breasts' : privateVariant ? 'full-body' : undefined;
    const source = buildImagePrompt(variant === 'grid' ? 'grid' : 'character', fields, variant, part, output);
    const block = finalBlock(source);
    assert.match(block, new RegExp(`逻辑画幅${output.aspectRatio}.*实际请求${output.width}×${output.height}像素`, 'u'));
    assert.match(block, count);
    assert.match(block, /实际请求画幅与宽高是本次最终画布依据，优先于前文规则、预设/u);
    assert.match(block, /保留当前槽位数量、左右或上下关系、视角顺序和各槽位指定的取景/u);
    assert.match(block, /不删槽位.*不拉伸身体.*不增加区域/u);
    if (privateVariant) {
      for (const rule of [privateImageVariantConverterRule(variant, part, output), privateImageVariantRepairRule(variant, part, output)]) {
        assert.match(finalBlock(rule), count);
        assert.doesNotMatch(rule, /横向\s*3:2|2:3\s*竖向|1:1\s*方形/u,
          `${variant} runtime conversion and repair must use the actual output frame`);
      }
    } else if (variant !== 'grid') {
      const rule = ordinaryImageVariantConverterRule(variant, output);
      assert.match(finalBlock(rule), count);
      assert.doesNotMatch(rule, /横向\s*3:2/u);
    }
  }
}

// A stale requested aspect cannot contradict the final adapted pixel canvas.
assert.match(imagePromptOutputSpecificationRule({ width: 3840, height: 2160, aspectRatio: '3:2', resolution: '4K' }, 'five-view'),
  /逻辑画幅16:9，横向画幅/u);
assert.match(imagePromptOutputSpecificationRule({ width: 3392, height: 5056, aspectRatio: '2:3', resolution: '4K' }, 'private-full-body'),
  /逻辑画幅2:3，竖向画幅/u, 'native alignment rounding keeps its matching logical aspect');

const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-sheet',
  manualPresetId: FIVE_VIEW_IMAGE_PRESET_IDS.gpt });
const presetBefore = JSON.stringify(selection.preset);
const custom = { ...selection, preset: { ...selection.preset, systemPrompt: `${selection.preset.systemPrompt}\n用户原文：默认横向3:2，保留highres画风。` } };
const customBefore = JSON.stringify(custom.preset);
const output = { width: 3840, height: 2160, aspectRatio: '16:9', resolution: '4K' };
const system = buildImagePromptConverterSystemPrompt(custom, '用户补充原样保留', 'five-view', output);
assert.ok(system.includes(custom.preset.systemPrompt));
assert.ok(system.includes('用户补充原样保留'));
assert.ok(system.lastIndexOf('<current_image_output_specification>') > system.lastIndexOf('</image_prompt_category_preset>'));
assert.match(finalBlock(system), /逻辑画幅16:9[\s\S]*五区域参考板/u);
assert.equal(JSON.stringify(selection.preset), presetBefore);
assert.equal(JSON.stringify(custom.preset), customBefore);
assert.equal(JSON.stringify([BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS, BUILT_IN_IMAGE_PROMPT_RULE_SETS]), originalCatalog,
  'runtime adaptation does not migrate or rewrite factory/user preset text');
assert.match(getImageVariantGenerationSpec('five-view').direction, /横向3:2/u);
assert.match(getImageVariantGenerationSpec('private-full-body').direction, /2:3竖向/u);
assert.match(privateImageVariantConverterRule('private-full-body'), /2:3\s*竖向/u,
  'legacy callers without actual output metadata retain the default recommendation');
console.log('Actual output layout: UHD landscape/portrait keep every ordinary/private/grid slot, final canvas overrides old recommendations, native rounding and stored presets remain intact.');
