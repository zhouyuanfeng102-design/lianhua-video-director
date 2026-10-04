import assert from 'node:assert/strict';
import {
  normalizeCharacterDossier, dossierUsesStory, characterDossierFormForRequest,
  markDossierManualFields, markDossierAiFields, mergeDossierAutofill, canAutofillDossierField,
  dossierSourceIsCurrent, preserveConfirmedCharacterFields,
} from '../src/characterDossierPolicy';
import { reconcileAuthoritativeStoryEntities } from '../src/appEffects';
import { requestImageAssetAutofill } from '../src/services/llm';
import { createInitialState, normalizeState } from '../src/storage';
import { resolveImageRegenerationSource } from '../src/imageRegeneration';
import type { Character, ImageGenerationTask, TextApiConfig } from '../src/types';

assert.equal(dossierUsesStory(undefined), true);
assert.equal(normalizeCharacterDossier({ useStory: false }).useStory, false);
assert.deepEqual(normalizeCharacterDossier({ fieldSources: { appearance: 'manual', bogus: 'manual', gender: 'bad' }, confirmedFields: ['appearance', 'appearance', 'bogus'] }).confirmedFields, ['appearance']);
const form = { name: '剧情旧名字', appearance: '剧情旧外貌', outfit: '我写的外套', race: '参考图识别的类别', motion: '按要求写的动作', anchor: '来源未知锚点', style: '当前画风', nsfwFullBody: '独立资料' };
const initial = { useStory: false, fieldSources: { appearance: 'story', outfit: 'manual', race: 'reference', motion: 'custom' } } as const;
assert.deepEqual(characterDossierFormForRequest(form, initial), {
  name: '', appearance: '', outfit: form.outfit, race: form.race, motion: form.motion, anchor: '', style: form.style, nsfwFullBody: '',
});
assert.deepEqual(characterDossierFormForRequest(form, { useStory: true }), form);
const edited = markDossierManualFields(initial, ['appearance'], 123);
assert.equal(edited.fieldSources?.anchor, undefined);
assert.equal(edited.fieldSources?.appearance, 'manual');
assert.deepEqual(edited.confirmedFields, ['appearance']);
assert.equal(edited.useStory, false);
assert.equal(edited.updatedAt, 123);
const marked = markDossierAiFields(edited, ['appearance', 'height', 'nsfwFullBody'], 'reference', 456);
assert.equal(marked.fieldSources?.appearance, 'manual');
assert.equal(marked.fieldSources?.height, 'reference');
assert.equal(marked.fieldSources?.nsfwFullBody, undefined);
const merged = mergeDossierAutofill(form, { appearance: 'new', outfit: 'bad', race: 'bad', motion: 'bad', gender: '男' }, initial, 'custom', 789);
assert.equal(merged.form.appearance, 'new');
assert.equal(merged.form.outfit, form.outfit);
assert.equal(merged.form.race, form.race);
assert.equal(merged.form.motion, form.motion);
assert.equal(merged.form.anchor, form.anchor);
assert.equal(merged.dossier.fieldSources?.appearance, 'custom');
assert.equal(form.appearance, '剧情旧外貌', 'request merges must not mutate saved or undo records');
assert.equal(dossierSourceIsCurrent('entity-A:off:revision1', 'entity-A:off:revision1'), true);
assert.equal(dossierSourceIsCurrent('entity-A:off:revision1', 'entity-A:on:revision2'), false);

// Imported/applied dossiers may mark empty fields as manually confirmed. An
// explicit fill request must still use visible evidence for those empty fields,
// while passive reanalysis and populated user values remain protected.
const emptyConfirmedForm = { name: '角色甲', appearance: '', outfit: '  ', gender: '', anchor: '用户锚点', props: '' };
const emptyConfirmedDossier = markDossierManualFields({ useStory: false }, Object.keys(emptyConfirmedForm), 10);
const confirmedSnapshot = JSON.stringify(emptyConfirmedDossier);
assert.equal(canAutofillDossierField(emptyConfirmedForm, emptyConfirmedDossier, 'appearance'), false);
assert.equal(canAutofillDossierField(emptyConfirmedForm, emptyConfirmedDossier, 'appearance', { explicitFillEmpty: true }), true);
assert.equal(canAutofillDossierField(emptyConfirmedForm, emptyConfirmedDossier, 'anchor', { explicitFillEmpty: true }), false);
assert.equal(canAutofillDossierField(emptyConfirmedForm, emptyConfirmedDossier, 'nsfwFullBody', { explicitFillEmpty: true }), false);
const passiveFill = mergeDossierAutofill(emptyConfirmedForm, { appearance: '蓝色眼睛' }, emptyConfirmedDossier, 'story', 20);
assert.equal(passiveFill.form.appearance, '', 'passive fill retains confirmed emptiness');
assert.equal(passiveFill.dossier.updatedAt, 10);
for (const source of ['reference', 'custom', 'story'] as const) {
  const explicitFill = mergeDossierAutofill(emptyConfirmedForm, {
    appearance: ' 蓝色眼睛 ', outfit: '浅色外套', gender: '', props: '   ', anchor: '不应改写', name: '不应改名',
  }, emptyConfirmedDossier, source, 30, { explicitFillEmpty: true });
  assert.equal(explicitFill.form.appearance, '蓝色眼睛');
  assert.equal(explicitFill.form.outfit, '浅色外套');
  assert.equal(explicitFill.form.name, emptyConfirmedForm.name);
  assert.equal(explicitFill.form.anchor, emptyConfirmedForm.anchor);
  assert.equal(explicitFill.form.gender, '');
  assert.equal(explicitFill.form.props, '');
  assert.equal(explicitFill.dossier.fieldSources?.appearance, source);
  assert.equal(explicitFill.dossier.fieldSources?.outfit, source);
  assert.equal(explicitFill.dossier.fieldSources?.anchor, 'manual');
  assert.equal(explicitFill.dossier.fieldSources?.gender, 'manual', 'unanswered fields retain their original provenance');
  assert.equal(explicitFill.dossier.confirmedFields?.includes('appearance'), false);
  assert.equal(explicitFill.dossier.confirmedFields?.includes('outfit'), false);
  assert.equal(explicitFill.dossier.confirmedFields?.includes('gender'), true);
  assert.equal(explicitFill.dossier.updatedAt, 30);
}
const emptyResponse = mergeDossierAutofill(emptyConfirmedForm, { appearance: '', outfit: '   ', gender: '' }, emptyConfirmedDossier, 'reference', 40, { explicitFillEmpty: true });
assert.deepEqual(emptyResponse.form, emptyConfirmedForm);
assert.deepEqual(emptyResponse.dossier, emptyConfirmedDossier);
assert.equal(JSON.stringify(emptyConfirmedDossier), confirmedSnapshot, 'explicit merges do not mutate undo records');
const sameResponse = mergeDossierAutofill({ appearance: '既有外貌' }, { appearance: '既有外貌' }, { useStory: true }, 'story', 50);
assert.equal(sameResponse.dossier.updatedAt, undefined, 'identical responses are not successful field changes');
assert.deepEqual(sameResponse.dossier.fieldSources, {});

const character: Character = {
  id: 'custom-character', name: '角色甲', gender: '', appearance: '用户确认外貌', outfit: '外套', apparentAge: '', race: '',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
  dossier: markDossierManualFields({ useStory: false }, ['appearance', 'props']),
};
const refreshed = preserveConfirmedCharacterFields(character, { ...character, appearance: 'AI外貌', signatureProps: '凭空装备', personality: '安静' });
assert.equal(refreshed.appearance, character.appearance);
assert.equal(refreshed.signatureProps, '', 'confirmed empty values are intentional');
assert.equal(refreshed.personality, '安静');
const reconciled = reconcileAuthoritativeStoryEntities([character], [{ ...character, dossier: undefined, appearance: 'AI', signatureProps: '凭空装备' }], {
  kind: 'character', aiSucceeded: true, sourceText: '',
});
assert.equal(reconciled.records[0].appearance, character.appearance);
assert.equal(reconciled.records[0].signatureProps, '');
assert.equal(reconciled.records[0].dossier?.useStory, false);
const omitted = reconcileAuthoritativeStoryEntities([character], [], {
  kind: 'character', aiSucceeded: true, sourceText: '', provenanceById: { [character.id]: 'ai' }, previousSceneEntityIds: [character.id],
});
assert.equal(omitted.records.length, 1, 'confirmed dossiers survive automatic pruning');

const initialState = createInitialState();
const normalizedState = normalizeState({ ...initialState, project: { ...initialState.project, characters: [character] } });
const reloaded = normalizeState(JSON.parse(JSON.stringify(normalizedState)));
assert.deepEqual(reloaded.project.characters[0].dossier, normalizeCharacterDossier(character.dossier));
assert.deepEqual(characterDossierFormForRequest({ appearance: '用户确认外貌', anchor: '旧分析锚点' }, reloaded.project.characters[0].dossier), { appearance: '用户确认外貌', anchor: '' });
const project = { ...initialState.project, description: 'SECRET_RETRY_STORY', characters: [{ ...character, anchor: 'SECRET_OLD_ANCHOR' }] };
const imageTask: ImageGenerationTask = {
  id: 'legacy-image', kind: 'image', name: 'old task', assetKind: 'character', imageVariant: 'reference', status: 'failed',
  prompt: '', width: 1024, height: 1024, backend: 'openai', model: 'test', sourceEntityId: character.id, createdAt: 1, updatedAt: 1,
};
const retry = resolveImageRegenerationSource(imageTask, project);
assert.equal(retry.conversionIdentityContext, '');
assert.match(retry.conversionSource, /用户确认外貌/u);
assert.doesNotMatch(retry.conversionSource, /SECRET_OLD_ANCHOR|SECRET_RETRY_STORY/u);
const frozenRetry = resolveImageRegenerationSource({ ...imageTask, conversionSource: 'FROZEN_ORIGINAL_SOURCE', conversionIdentityContext: '', referenceAssetIds: [] }, project);
assert.equal(frozenRetry.conversionSource, 'FROZEN_ORIGINAL_SOURCE', 'frozen historical tasks retain their source');
assert.equal(frozenRetry.conversionIdentityContext, '', 'explicit empty identity context is meaningful');

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://invalid.example/v1/chat/completions', apiKey: 'test-only', model: 'test', temperature: 0.2, maxTokens: 4096, vision: true };
const originalWindow = globalThis.window;
let requestBody = '';
const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (payload: { body?: string }) => {
    requestBody = payload.body || '';
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ appearance: '参考图外观', actualAge: '', height: '' }) } }] }) };
  },
} } });
try {
  const filtered = characterDossierFormForRequest({ ...form, actualAge: '', height: '' }, initial);
  const result = await requestImageAssetAutofill(config, 'character', filtered, ['appearance', 'actualAge', 'height'], 'SECRET_STORY_CONTEXT', undefined, {
    useStory: false, referenceImages: [reference], customRequirement: '按选图补齐',
  });
  assert.deepEqual(result, { appearance: '参考图外观', actualAge: '', height: '' });
  assert.doesNotMatch(requestBody, /SECRET_STORY_CONTEXT|剧情旧名字|剧情旧外貌|来源未知锚点/u);
  assert.match(requestBody, /按选图补齐/u);
  assert.match(requestBody, /image_url/u);
  assert.ok(requestBody.includes(reference));
  assert.doesNotMatch(requestBody, /不得留空|必须根据用户明确要求、当前表单、剧情上下文/u);
  await requestImageAssetAutofill(config, 'character', { appearance: '' }, ['appearance'], 'STORY_ALLOWED');
  assert.match(requestBody, /STORY_ALLOWED/u);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('characterDossierPolicy: provenance filtering, protected merge, reanalysis retention and real request source isolation passed');
