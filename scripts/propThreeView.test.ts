import assert from 'node:assert/strict';
import {
  IMAGE_VARIANT_OPTIONS, PROP_THREE_VIEW_LAYOUT_RULE, PROP_THREE_VIEW_NEGATIVE_PROMPT,
  getImageVariantGenerationSpec, ordinaryImageVariantConverterRule, ordinaryImageVariantNegativePrompt,
  propThreeViewCompatibleNegativePrompt,
} from '../src/imageGeneration';
import {
  BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS, BUILT_IN_IMAGE_PROMPT_RULE_SETS,
  LEGACY_IMAGE_PROMPT_CATEGORY_PRESETS_V19, LEGACY_IMAGE_PROMPT_RULE_SETS_V19,
  LEGACY_IMAGE_PROMPT_CATEGORY_PRESETS_V20, LEGACY_IMAGE_PROMPT_RULE_SETS_V20,
  IMAGE_PROMPT_RULE_CATALOG_VERSION, IMAGE_PROMPT_PROP_SPECIFICATION_RULE,
  buildImagePromptConverterSystemPrompt, migrateImagePromptRulesState,
  resolveImagePromptSelection, type ImagePromptRulesState,
} from '../src/imagePromptRules';
import { MODEL_FAMILY_CATEGORY_PRESETS, MODEL_FAMILY_RULE_SETS } from '../src/imagePromptModelFamilies';
import { defaultImageOutputSize, imageOutputAspectLocked, resolveImageOutputSize } from '../src/imageOutputSize';
import { buildImagePrompt } from '../src/promptEngine';
import { createImageGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { buildImageRegenerationTask, resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import type { ImageGenerationTask, ReferenceAsset } from '../src/types';

let checks = 0;
assert.deepEqual(IMAGE_VARIANT_OPTIONS.prop, ['close-up', 'three-view']);
const spec = getImageVariantGenerationSpec('three-view');
assert.deepEqual(spec.canvas, { width: 1536, height: 1024 });
assert.equal(spec.label, '三视图');
assert.equal(spec.direction, PROP_THREE_VIEW_LAYOUT_RULE);
for (const phrase of ['恰好三个等宽全高区域', '正面、严格90度左侧面、背面', '同一且唯一的物品', '同一尺度', '不镜像', '当前状态', '不是三张输出图片']) {
  assert.ok(spec.direction.includes(phrase), phrase);
}
assert.equal(imageOutputAspectLocked('three-view'), true);
for (const backend of ['openai', 'sd_webui', 'comfyui', 'novelai', 'runninghub'] as const) {
  const result = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: 'default' }, spec.canvas, backend, 'three-view');
  assert.equal(result.issue, '', backend);
  assert.equal(result.layoutNote.includes('多视图推荐3:2'), true, backend);
}
const actualOutput = { width: 3840, height: 2160, aspectRatio: '16:9', resolution: '4K' };
const converter = ordinaryImageVariantConverterRule('three-view', actualOutput);
assert.match(converter, /单张16:9 横向物品三视图/u);
assert.match(converter, /实际请求3840×2160像素/u);
assert.match(converter, /恰好三个等宽全高区域/u);
assert.doesNotMatch(converter, /单张横向3:2/u);
assert.equal(ordinaryImageVariantNegativePrompt('three-view'), PROP_THREE_VIEW_NEGATIVE_PROMPT);
assert.doesNotMatch(PROP_THREE_VIEW_NEGATIVE_PROMPT, /duplicate objects|multiple views|split screen|triptych/u);
assert.equal(propThreeViewCompatibleNegativePrompt('duplicate objects, broken geometry, multiple views, text, triptych'), 'broken geometry, text');
checks += 1;

const propSource = buildImagePrompt('prop', {
  name: '测试魔棒', category: '变身器', material: '银灰色金属与红色透明顶盖',
  appearance: '细长笔形主体，单个侧面按钮，背面细短卡扣', stateRules: '收起且不发光',
}, 'three-view', undefined, actualOutput);
assert.match(propSource, /同一剧情道具三视图参考板/u);
assert.match(propSource, /单个侧面按钮，背面细短卡扣/u);
assert.match(propSource, /收起且不发光/u);
assert.ok(propSource.includes(PROP_THREE_VIEW_LAYOUT_RULE));
assert.match(propSource, /实际请求3840×2160像素/u);
for (const [backend, model] of [
  ['all', undefined], ['openai', 'gpt-image-2.5'], ['openai', 'krea-2'],
  ['openai', 'gemini-2.5-flash-image'], ['openai', 'grok-imagine-image'],
  ['sd-webui', undefined], ['comfyui', undefined], ['novelai', undefined],
] as const) {
  const selection = resolveImagePromptSelection({ backend, model, assetKind: 'prop', imageVariant: 'three-view' });
  assert.ok(selection.preset.systemPrompt.includes(IMAGE_PROMPT_PROP_SPECIFICATION_RULE), selection.preset.id);
  assert.ok(selection.ruleSet.outputRules.includes(IMAGE_PROMPT_PROP_SPECIFICATION_RULE), selection.ruleSet.id);
  const system = buildImagePromptConverterSystemPrompt(selection, 'CUSTOM_EXTRA_RULE', 'three-view', actualOutput);
  assert.ok(system.lastIndexOf(converter) > system.indexOf('CUSTOM_EXTRA_RULE'), selection.ruleSet.id);
  assert.match(system, /没有人物出镜时不创建人物段/u);
  const withCallerRule = buildImagePromptConverterSystemPrompt(selection, converter, 'three-view', actualOutput);
  assert.equal(withCallerRule.split(converter).length - 1, 1, 'the explicit runtime rule is not injected twice');
}
for (const preset of BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((entry) => entry.assetKind === 'prop')) {
  assert.ok(preset.systemPrompt.includes(IMAGE_PROMPT_PROP_SPECIFICATION_RULE), preset.id);
}
for (const rule of MODEL_FAMILY_RULE_SETS) assert.deepEqual(BUILT_IN_IMAGE_PROMPT_RULE_SETS.find((entry) => entry.id === rule.id), rule);
for (const preset of MODEL_FAMILY_CATEGORY_PRESETS) assert.deepEqual(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((entry) => entry.id === preset.id), preset);
checks += 1;

const factory20: ImagePromptRulesState = {
  schemaVersion: 1, catalogVersion: 20,
  ruleSets: structuredClone([...LEGACY_IMAGE_PROMPT_RULE_SETS_V20]),
  categoryPresets: structuredClone([...LEGACY_IMAGE_PROMPT_CATEGORY_PRESETS_V20]),
  defaultRuleSetByBackend: { openai: 'image-rule-generic', novelai: 'image-rule-novelai' },
};
const factoryBefore = structuredClone(factory20);
const upgraded = migrateImagePromptRulesState(factory20);
assert.equal(upgraded.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
assert.deepEqual(upgraded.ruleSets, BUILT_IN_IMAGE_PROMPT_RULE_SETS);
assert.deepEqual(upgraded.categoryPresets, BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS);
assert.deepEqual(upgraded.defaultRuleSetByBackend, factory20.defaultRuleSetByBackend);
assert.deepEqual(migrateImagePromptRulesState(upgraded), upgraded);
assert.deepEqual(factory20, factoryBefore);
const propPreset20 = factory20.categoryPresets.find((entry) => entry.id === 'image-preset-prop')!;
const rule20 = factory20.ruleSets.find((entry) => entry.id === 'image-rule-openai-gpt-image')!;
const disabled = migrateImagePromptRulesState({ ...factory20,
  categoryPresets: [{ ...propPreset20, enabled: false }], ruleSets: [{ ...rule20, enabled: false }],
});
assert.equal(disabled.ruleSets[0].enabled, false);
assert.equal(disabled.categoryPresets[0].enabled, false);
assert.ok(disabled.categoryPresets[0].systemPrompt.includes(IMAGE_PROMPT_PROP_SPECIFICATION_RULE));
for (const patch of [{ name: '用户名称' }, { systemPrompt: '用户系统规则' }, { outputRules: '用户输出规则' }, { version: '8.0.0' }, { updatedAt: 80 }]) {
  const rule = { ...rule20, ...patch }; const preset = { ...propPreset20, ...patch };
  const migrated = migrateImagePromptRulesState({ ...factory20, ruleSets: [rule], categoryPresets: [preset] });
  assert.deepEqual(migrated.ruleSets, [rule]); assert.deepEqual(migrated.categoryPresets, [preset]);
}
const deleted = migrateImagePromptRulesState({ ...factory20, ruleSets: [], categoryPresets: [] });
assert.deepEqual(deleted.ruleSets, []); assert.deepEqual(deleted.categoryPresets, []);
assert.deepEqual(migrateImagePromptRulesState(deleted), deleted);
const from19 = migrateImagePromptRulesState({ ...factory20, catalogVersion: 19,
  ruleSets: LEGACY_IMAGE_PROMPT_RULE_SETS_V19, categoryPresets: LEGACY_IMAGE_PROMPT_CATEGORY_PRESETS_V19,
});
assert.deepEqual(from19, upgraded, 'older factory catalogs take the full migration chain');
assert.deepEqual(migrateImagePromptRulesState(from19), from19);
checks += 1;

const state = createInitialState();
const assets: ReferenceAsset[] = [];
const tasks: ImageGenerationTask[] = [];
for (const variant of ['icon', 'showcase', 'close-up', 'three-view'] as const) {
  const canvas = getImageVariantGenerationSpec(variant).canvas;
  const negative = `frozen user negative for ${variant}`;
  const task = createImageGenerationTask({
    id: `prop-task-${variant}`, name: `魔棒-${variant}`, assetKind: 'prop', imageVariant: variant,
    prompt: `saved final prompt ${variant}`, negativePrompt: negative,
    conversionSource: `frozen source ${variant}`, converterSystemPrompt: `frozen converter ${variant}`,
    referenceAssetIds: ['prop-ref'], primaryReferenceAssetIds: ['prop-ref'],
    width: canvas.width, height: canvas.height, backend: 'openai', model: 'gpt-image-2.5',
    imagePromptRuleSetId: rule20.id, imagePromptRuleSetVersion: rule20.version,
    imagePromptPresetId: propPreset20.id, imagePromptPresetVersion: propPreset20.version,
  }, 100, 'succeeded');
  tasks.push(task);
  assets.push({ id: `prop-asset-${variant}`, name: task.name, type: 'prop', role: 'prop', tags: [],
    createdAt: 100, updatedAt: 100, imageVariant: variant, prompt: task.prompt, negativePrompt: task.negativePrompt,
    width: canvas.width, height: canvas.height, dataUrl: 'data:image/png;base64,AA==', imageBackend: 'openai' });
}
state.project = { ...state.project, id: 'prop-three-view-project', props: [], generationTasks: tasks, assets };
state.projects = [state.project]; state.activeProjectId = state.project.id;
state.imagePromptRules = factory20;
const beforeTasks = structuredClone(tasks);
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
for (const task of tasks) {
  const restoredTask = restored.project.generationTasks.find((entry): entry is ImageGenerationTask => entry.kind === 'image' && entry.id === task.id)!;
  assert.equal(restoredTask.imageVariant, task.imageVariant);
  assert.equal(restoredTask.status, 'succeeded');
  assert.equal(restoredTask.converterSystemPrompt, task.converterSystemPrompt);
  assert.equal(restoredTask.imagePromptPresetVersion, propPreset20.version);
  const source = resolveImageRegenerationSource(restoredTask, restored.project);
  const retried = buildImageRegenerationTask(restoredTask, restored.project, {
    id: `retry-${task.id}`, timestamp: 200, backend: 'openai', model: restoredTask.model, source,
  });
  assert.equal(retried.imageVariant, task.imageVariant);
  assert.equal(retried.prompt, task.prompt);
  assert.equal(retried.converterSystemPrompt, task.converterSystemPrompt);
  assert.deepEqual([retried.width, retried.height], [task.width, task.height]);
  assert.deepEqual(retried.referenceAssetIds, task.referenceAssetIds);
  if (task.imageVariant === 'three-view') assert.equal(retried.negativePrompt, task.negativePrompt);
  const asset = restored.project.assets.find((entry) => entry.id === `prop-asset-${task.imageVariant}`)!;
  const assetTask = resolveImageAssetRegenerationTask(asset, restored.project, state.settings.imageApi)!;
  assert.equal(assetTask.imageVariant, task.imageVariant);
  if (task.imageVariant === 'three-view') assert.equal(assetTask.negativePrompt, task.negativePrompt);
}
assert.deepEqual(tasks, beforeTasks, 'catalog migration and retries do not mutate historical tasks');
checks += 1;

console.log(`Prop three-view pipeline: ${checks} scenario groups passed (options/layout, output/negative rules, all formats/families, catalog migration, storage/retry compatibility).`);
