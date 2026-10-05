import assert from 'node:assert/strict';
import { imageTaskRuleMetadata } from '../src/imageTaskRuleMetadata';
import { createInitialState, normalizeState } from '../src/storage';
import { createImageGenerationTask, settleImageGenerationTask } from '../src/generationTasks';
import { buildImageRegenerationTask, resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import type { ImageGenerationTask, ReferenceAsset } from '../src/types';

const saved = {
  imagePromptRuleSetId: 'rule-test', imagePromptRuleSetName: '原始生图规则', imagePromptRuleSetVersion: '1.0.0',
  imagePromptPresetId: 'preset-test', imagePromptPresetName: '原始角色预设', imagePromptPresetVersion: '1.1.0',
};
const task = (fields: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'image-test', kind: 'image', name: '角色甲', assetKind: 'character', imageVariant: 'reference',
  status: 'succeeded', prompt: '中性角色参考图', width: 1024, height: 1024, backend: 'openai', model: 'test',
  createdAt: 1, updatedAt: 2, ...fields,
});
const asset: ReferenceAsset = {
  id: 'asset-test', name: '角色甲', type: 'character', role: 'character', prompt: '中性角色参考图',
  tags: [], createdAt: 1, updatedAt: 2, ...saved,
};
const state = createInitialState();
const rules = {
  ruleSets: [{ ...state.imagePromptRules.ruleSets[0], id: saved.imagePromptRuleSetId, name: '当前规则新名称', version: '2.0.0' }],
  categoryPresets: [{ ...state.imagePromptRules.categoryPresets[0], id: saved.imagePromptPresetId, name: '当前预设新名称', version: '2.0.0' }],
};

// A rule update/deletion never changes the captured names on historical cards.
for (const catalog of [rules, undefined]) {
  const labels = imageTaskRuleMetadata(task(saved), catalog);
  assert.equal(labels.rule.text, '原始生图规则 · v1.0.0');
  assert.equal(labels.preset.text, '原始角色预设 · v1.1.0');
}
const legacy = task({ ...saved, imagePromptRuleSetName: undefined, imagePromptPresetName: undefined });
assert.equal(imageTaskRuleMetadata(legacy, rules).rule.text, 'ID：rule-test · v1.0.0');
const matching = {
  ruleSets: [{ ...rules.ruleSets[0], version: '1.0.0' }],
  categoryPresets: [{ ...rules.categoryPresets[0], version: '1.1.0' }],
};
assert.equal(imageTaskRuleMetadata(legacy, matching).rule.text, '当前规则新名称 · v1.0.0（名称按记录匹配）');
assert.equal(imageTaskRuleMetadata(legacy, matching).preset.text, '当前预设新名称 · v1.1.0（名称按记录匹配）');
assert.equal(imageTaskRuleMetadata(task({ imagePromptRuleSetId: 'rule-test' }), rules).rule.text, 'ID：rule-test · 版本未记录');
assert.equal(imageTaskRuleMetadata(task(), rules).rule.text, '未记录');
assert.equal(imageTaskRuleMetadata(task(), rules).preset.text, '未记录');
assert.equal(imageTaskRuleMetadata(task({ imageGenerationMode: 'image-to-image' }), rules).rule.text, '未记录');

// Only a linked result can recover provenance; incomplete task records cannot
// be mixed with a different asset revision to invent a combined selection.
assert.equal(imageTaskRuleMetadata(task({ resultAssetId: asset.id }), rules, asset).rule.text, '原始生图规则 · v1.0.0');
assert.equal(imageTaskRuleMetadata(task({ resultAssetId: 'other' }), rules, asset).rule.text, '未记录');
assert.equal(imageTaskRuleMetadata(task({ resultAssetId: asset.id, imagePromptRuleSetId: 'different' }), rules, asset).preset.text, '未记录');

// Exercise queued -> settlement -> JSON reload -> asset regeneration. Names
// must survive these real persistence paths, with the original record intact.
const queued = createImageGenerationTask(task(saved), 10, 'queued');
const settled = settleImageGenerationTask([queued], queued, { status: 'succeeded', resultAssetId: asset.id }, 20);
const project = { ...state.project, assets: [asset], generationTasks: settled };
const before = JSON.stringify(project);
const restored = normalizeState(JSON.parse(JSON.stringify({ ...state, project, projects: [project] })));
const restoredTask = restored.project.generationTasks.find((item): item is ImageGenerationTask => item.kind === 'image');
assert.ok(restoredTask);
assert.equal(restoredTask.imagePromptRuleSetName, saved.imagePromptRuleSetName);
assert.equal(restoredTask.imagePromptPresetName, saved.imagePromptPresetName);
assert.equal(restored.project.assets[0].imagePromptRuleSetName, saved.imagePromptRuleSetName);
assert.equal(restored.project.assets[0].imagePromptPresetName, saved.imagePromptPresetName);
const recovered = resolveImageAssetRegenerationTask(asset, { ...project, generationTasks: [] }, {
  enabled: false, backend: 'openai', baseUrl: '', apiKey: '', model: 'test',
});
assert.ok(recovered);
const regenerated = buildImageRegenerationTask(recovered, project, {
  id: 'regenerated-test', timestamp: 30, backend: 'openai', model: 'test', source: resolveImageRegenerationSource(recovered, project),
});
assert.equal(regenerated.imagePromptRuleSetName, saved.imagePromptRuleSetName);
assert.equal(regenerated.imagePromptPresetName, saved.imagePromptPresetName);
assert.equal(JSON.stringify(project), before);
console.log('PASS image rule history: frozen names, legacy fallback, linked assets, persistence and regeneration');
