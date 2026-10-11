import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { normalizeCustomImageDraft, normalizeCustomImageInput } from '../src/customImageMetadata';
import { normalizeImageAssetRegenerationSnapshot, withCustomImageRegenerationSnapshot } from '../src/imageAssetRegenerationSnapshot';
import { buildImageRegenerationTask, canRegenerateImageTask, executeImageRegeneration, resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import type { AppState, CustomImageInput, ImageGenerationTask, Project, ReferenceAsset } from '../src/types';

const initial = createInitialState();
const apiSnapshot = {
  version: 1 as const, profileId: 'saved-image-api', connectionFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64),
  config: { enabled: true, backend: 'openai' as const, model: 'saved-image-model' },
};
const rawInput: CustomImageInput = { version: 1, userPrompt: '  用户原文\n保留这些字。  ', promptMode: 'raw', operation: 'initial' };
const frozenRule = { version: 1 as const, id: 'user-rule', name: '自选规则', ruleVersion: '2.0.0', format: 'natural-language' as const,
  systemPrompt: 'frozen system', outputRules: 'frozen output', negativePrompt: 'frozen negative' };
const makeTask = (overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'custom-task', kind: 'image', name: '自定义图', assetKind: 'custom', imageVariant: 'reference', status: 'succeeded',
  customImageInput: rawInput, prompt: rawInput.userPrompt, width: 1536, height: 1024, sizeOverride: true,
  backend: 'openai', model: 'saved-image-model', imageApiSnapshot: apiSnapshot,
  imageInputMode: 'text-to-image', imageGenerationMode: 'text-to-image', referenceAssetIds: [], primaryReferenceAssetIds: [],
  referenceAssetSnapshots: [], createdAt: 1, updatedAt: 2, ...overrides,
});
const makeAsset = (): ReferenceAsset => ({ id: 'custom-asset', name: '自定义图', type: 'reference', role: 'composition',
  mediaType: 'image', source: 'generated', url: 'lianhua-asset://local/image/output.png', tags: ['自定义生图'], createdAt: 3, updatedAt: 3 });
const makeProject = (overrides: Partial<Project> = {}): Project => ({
  ...initial.project, id: 'custom-project', characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [],
  assets: [], generationTasks: [], ...overrides,
});
const makeState = (project: Project): AppState => ({ ...initial, project, projects: [project], activeProjectId: project.id });

assert.equal(normalizeCustomImageDraft(undefined), undefined, 'legacy projects keep the optional draft absent');
const partialDraft = normalizeCustomImageDraft({ version: 1, userPrompt: '草稿', ruleSetId: 'deleted-rule' })!;
assert.equal(partialDraft.promptMode, 'raw');
assert.equal(partialDraft.sizePreference.aspect, '1:1');
assert.equal(partialDraft.ruleSetId, 'deleted-rule', 'missing rules remain visible choices, not silently replaced');
assert.deepEqual(normalizeCustomImageInput({ ...rawInput, apiKey: 'secret' }), rawInput);
const noisyRuleInput = normalizeCustomImageInput({ ...rawInput, promptMode: 'rules',
  ruleSelection: { ...frozenRule, apiKey: 'secret', workflowJson: 'secret workflow' } })!;
assert.deepEqual(noisyRuleInput.ruleSelection, frozenRule, 'only explicit frozen rule facts survive');

const rawTask = makeTask();
const rawAsset = withCustomImageRegenerationSnapshot(makeAsset(), rawTask);
assert.equal(rawAsset.imageRegenerationSnapshot?.sourceKind, 'custom');
assert.deepEqual(rawAsset.imageRegenerationSnapshot?.referenceAssetSnapshots, []);
assert.equal(rawAsset.prompt, rawInput.userPrompt, 'raw whitespace and line breaks stay untouched');
assert.equal(normalizeImageAssetRegenerationSnapshot({ ...rawAsset.imageRegenerationSnapshot, sourceKind: undefined }), undefined,
  'legacy storyboard snapshots still require references');

const sourceProject = makeProject({ assets: [rawAsset], customImageDraft: { ...partialDraft, promptMode: 'rules' } });
const restoredState = normalizeState(JSON.parse(serializeStateForStorage(makeState(sourceProject)).serialized));
assert.equal(restoredState.project.customImageDraft?.ruleSetId, 'deleted-rule');
assert.equal(restoredState.project.customImageDraft?.promptMode, 'rules', 'draft mode survives without choosing a replacement rule');
const restored = resolveImageAssetRegenerationTask(restoredState.project.assets[0], restoredState.project, initial.settings.imageApi)!;
assert.equal(restored.assetKind, 'custom');
assert.equal(restored.prompt, rawInput.userPrompt);
assert.equal(restored.sourceStoryboardId, undefined);
assert.equal(restored.model, 'saved-image-model');
assert.equal(restored.imageApiSnapshot?.profileId, 'saved-image-api');
assert.deepEqual(restored.referenceAssetSnapshots, []);
assert.equal(restored.width, 1536);
assert.equal(restored.height, 1024);
const partialLibrary = normalizeState({ ...makeState(sourceProject), projects: [sourceProject, { id: 'other-project', name: '其它项目' }] });
assert.equal(partialLibrary.projects.find((project) => project.id === 'other-project')?.customImageDraft, undefined,
  'a partial imported project does not inherit the active project draft');

const rulesTask = makeTask({ customImageInput: noisyRuleInput, prompt: 'saved converted final', negativePrompt: 'explicit negative' });
const rulesAsset = withCustomImageRegenerationSnapshot(makeAsset(), rulesTask);
const rulesProject = makeProject({ assets: [rulesAsset] });
const recoveredRulesTask = resolveImageAssetRegenerationTask(rulesAsset, rulesProject, initial.settings.imageApi)!;
const retry = buildImageRegenerationTask(recoveredRulesTask, rulesProject, {
  id: 'retry-custom', timestamp: 10, backend: 'openai', model: 'different-current-model',
  source: resolveImageRegenerationSource(recoveredRulesTask, rulesProject),
});
assert.equal(retry.prompt, 'saved converted final');
assert.equal(retry.model, 'saved-image-model', 'original-word retries keep the saved execution model');
assert.equal(retry.customImageInput?.operation, 'saved-final');
assert.deepEqual(retry.customImageInput?.ruleSelection, frozenRule);
let conversions = 0;
const execution = await executeImageRegeneration(retry, {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => { conversions += 1; throw new Error('must never convert a custom final-word retry'); },
  persistPrompt: () => { throw new Error('must never replace the saved final prompt'); },
  generateImage: async (input) => { assert.equal(input.prompt, 'saved converted final'); assert.equal(input.negativePrompt, 'explicit negative'); return 'image-result'; },
});
assert.equal(execution.generated, 'image-result');
assert.equal(conversions, 0);

const refs = [{ id: 'original-b', name: '原图 B', type: 'reference' as const, role: 'composition' as const,
  relativePath: 'image/b.png', checksum: 'c'.repeat(64), managed: true as const, mediaType: 'image' as const },
{ id: 'original-a', name: '原图 A', type: 'reference' as const, role: 'composition' as const,
  relativePath: 'image/a.png', checksum: 'd'.repeat(64), managed: true as const, mediaType: 'image' as const }];
const referencedTask = makeTask({ referenceAssetIds: refs.map((reference) => reference.id), referenceAssetSnapshots: refs });
const referencedAsset = withCustomImageRegenerationSnapshot(makeAsset(), referencedTask);
const recoveredRefs = resolveImageAssetRegenerationTask(referencedAsset, makeProject({ assets: [referencedAsset] }), initial.settings.imageApi)!;
assert.deepEqual(resolveImageRegenerationSource(recoveredRefs, makeProject()).referenceAssetSnapshots, refs,
  'deleted reference cards do not change original reference files or order');
await assert.rejects(() => executeImageRegeneration(recoveredRefs, {
  referenceImages: ['only-one'], primaryReferenceImageCount: 1, convertPrompt: async () => 'wrong', persistPrompt: () => {}, generateImage: async () => 'wrong',
}), /自定义参考图读取不完整/u);
assert.throws(() => resolveImageAssetRegenerationTask({ ...referencedAsset, customImageInput: undefined }, makeProject(), initial.settings.imageApi),
  /自定义图片.*缺失\/损坏/u, 'damaged custom provenance never falls back to storyboard recovery');
assert.throws(() => resolveImageRegenerationSource(makeTask({ prompt: '' }), makeProject()), /不会调用文本模型/u);

const pending = makeTask({ status: 'failed', customImageSavePending: true, resultUrl: 'data:image/png;base64,AA==' });
const pendingState = normalizeState(JSON.parse(serializeStateForStorage(makeState(makeProject({ generationTasks: [pending] }))).serialized));
const pendingTask = pendingState.project.generationTasks[0] as ImageGenerationTask;
assert.equal(pendingTask.customImageSavePending, true);
assert.equal(pendingTask.resultUrl, pending.resultUrl, 'returned pixels survive restart for save-only recovery');
assert.equal(canRegenerateImageTask(pendingTask, []), false, 'pending image saving cannot authorize another paid retry');
assert.equal(canRegenerateImageTask(makeTask({ prompt: '' }), []), false);

console.log('custom image persistence, frozen original-word retries, project drafts and save recovery passed');
