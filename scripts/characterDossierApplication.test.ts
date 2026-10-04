import assert from 'node:assert/strict';
import { applyCharacterDossierApplication, previewCharacterDossierApplication, type CharacterDossierApplicationOptions } from '../src/characterDossierApplication';
import { videoReferenceCharacterOwners } from '../src/videoH3ReferenceBinding';
import { createInitialState, normalizeState } from '../src/storage';
import type { Character, Project, ReferenceAsset, Scene, Storyboard, VideoSequencePlan } from '../src/types';
import type { VideoCreativeDirection } from '../src/videoCreativeDirection';

const initial = createInitialState();
const character = (id: string, patch: Partial<Character> = {}): Character => ({
  ...initial.project.characters[0], id, name: id, assetIds: [], ...patch,
});
const target = character('original', { name: '角色甲·原始形态', baseName: '角色甲', formLabel: '原始形态',
  appearance: '原先外观', outfit: '旧服装', anchor: '旧锚点', assetIds: ['old-ref'],
  nsfwProfile: { fullBody: 'private-target-sentinel' }, dossier: { confirmedFields: ['height'], fieldSources: { appearance: 'story', height: 'manual' } } });
const source = character('custom', { name: '角色甲-自建', baseName: '自建标记', formLabel: '自建形态',
  appearance: '手动确认的新外观', outfit: '', anchor: '手动锚点', assetIds: ['new-ref', 'private-ref'],
  nsfwProfile: { fullBody: 'private-source-sentinel' }, dossier: { useStory: false, confirmedFields: ['appearance'], fieldSources: { appearance: 'reference', anchor: 'manual' } } });
const otherForm = character('variant', { name: '角色甲·另一形态', baseName: '角色甲', formLabel: '另一形态', assetIds: ['variant-ref'] });
const asset = (id: string, owner: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'character', role: 'character', mediaType: 'image', sourceEntityId: owner, sourceEntityKind: 'character',
  relativePath: `fixtures/${id}.png`, checksum: `checksum-${id}`, managed: true, tags: ['original-tag'], createdAt: 1, updatedAt: 1, ...patch,
});
const scene = (id: string, ids: string[]): Scene => ({ ...initial.project.scenes[0], id, characterIds: ids, content: '角色甲·原始形态说话。', summary: '原文保留', storyboardIds: [] });
const originalScene = scene('scene-target', [target.id, otherForm.id]);
const sourceScene = scene('scene-custom', []);
const otherScene = scene('scene-other', [otherForm.id]);
const board = (id: string, sceneValue: Scene): Storyboard => ({
  id, sceneId: sceneValue.id, sourceSceneIds: [sceneValue.id], sourceSceneSnapshots: [sceneValue], workflow: 'drama', inputMode: 'text_reference',
  durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: '旧 H3 正文，不得静默改写。', englishPrompt: 'Frozen English.',
  h3IdentityBindings: { version: 1, characters: [{ characterId: sceneValue.characterIds[0], name: target.name, referenceAnchor: '旧外观身份句' }] },
  globalReferenceAssetIds: ['old-ref', 'unrelated-ref'],
  firstFrameAssetId: 'old-ref',
  promptPlan: { canonicalPrompt: '旧 H3 正文，不得静默改写。', durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'drama', inputMode: 'text_reference', shotIds: ['shot'], referenceAssetIds: ['old-ref'], constraints: [], trace: { ruleSetId: '', converterId: '' } },
  promptTrace: { modelRuleSetId: '', converterPresetId: '', sourceDocumentIds: [], referenceAssetIds: ['old-ref'], generatedAt: 1, mode: 'text-api' },
  imageToImage: { referenceAssetIds: ['old-ref'], selectedShotIds: ['shot'], referenceAssetIdsByShotId: { shot: ['old-ref'] } },
  shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 15, purpose: '', subject: target.name, action: '剧情原文动作', camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: ['old-ref'], prompt: '原分镜描述', locked: true }],
  revisions: [{ id: 'revision-1', createdAt: 1, finalPrompt: '历史 H3 正文', h3IdentityBindings: { version: 1, characters: [{ characterId: target.id, name: target.name, referenceAnchor: '历史身份句' }] } }],
  createdAt: 1, updatedAt: 1,
});
const primaryBoard = board('board-target', originalScene);
const unrelatedBoard = { ...board('board-other', otherScene), globalReferenceAssetIds: [], imageToImage: undefined, firstFrameAssetId: undefined, promptPlan: undefined, promptTrace: undefined,
  shots: [], h3IdentityBindings: undefined };
const plan: VideoSequencePlan = { id: 'plan', title: '当前计划', sourceStoryTitle: '原故事', sourceStoryContent: '角色甲原文',
  durationMode: 'fixed', totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced', masterStoryboardId: primaryBoard.id,
  semanticPlanningSnapshot: { version: 1, directorSettingsFingerprint: 'settings', creativeDirection: {} as VideoCreativeDirection,
    characterContinuity: [{ id: target.id, name: target.name, appearance: target.appearance }, { id: otherForm.id, name: otherForm.name }] },
  reviewConfirmedFingerprint: 'review', reviewConfirmedAt: 1,
  segments: [{ id: 'segment', index: 1, title: '原段', globalStartSec: 0, globalEndSec: 15, durationSec: 15, content: '剧情内容', summary: '', sourceSceneIds: [originalScene.id], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: primaryBoard.id, status: 'ready' }], createdAt: 1, updatedAt: 1 };
const project: Project = { ...initial.project, characters: [source, target, otherForm], scenes: [originalScene, sourceScene, otherScene],
  storyboards: [primaryBoard, unrelatedBoard], sequencePlans: [plan], assets: [asset('old-ref', target.id), asset('new-ref', source.id),
    asset('private-ref', source.id, { referenceScope: 'nsfw-private-profile', imageVariant: 'private-full-body' }), asset('variant-ref', otherForm.id)],
  generationTasks: [{ id: 'submitted-task', storyboardId: primaryBoard.id, targetId: 'api', status: 'running', requestBody: { prompt: 'frozen', characterId: target.id }, createdAt: 1, updatedAt: 1 }],
};
const options: CharacterDossierApplicationOptions = { sourceCharacterId: source.id, targetCharacterId: target.id, mode: 'copy', fields: ['appearance', 'outfit', 'anchor'], now: 99 };
const before = JSON.stringify(project);

{
  const preview = previewCharacterDossierApplication(project, options);
  assert.deepEqual(preview.changes.map((item) => item.field), ['appearance', 'anchor']);
  assert.deepEqual(preview.affectedSceneIds, ['scene-target']);
  assert.deepEqual(preview.affectedStoryboardIds, ['board-target']);
  assert.deepEqual(preview.affectedSegmentIds, ['segment']);
  assert.deepEqual(preview.referenceAssetIds, ['old-ref']);
  const result = applyCharacterDossierApplication(project, options);
  const saved = result.characters.find((item) => item.id === target.id)!;
  assert.equal(saved.name, target.name);
  assert.equal(saved.formLabel, target.formLabel);
  assert.equal(saved.appearance, source.appearance);
  assert.equal(saved.outfit, target.outfit, 'blank does not erase existing data without explicit choice');
  assert.equal(saved.nsfwProfile, target.nsfwProfile, 'ordinary copy never copies private dossiers');
  assert.equal(saved.assetIds, target.assetIds, 'no reference option preserves reference selections');
  assert.equal(saved.dossier?.fieldSources?.appearance, 'reference');
  assert.ok(saved.dossier?.confirmedFields?.includes('appearance'));
  assert.ok(saved.dossier?.confirmedFields?.includes('height'));
  assert.equal(result.characters[0], source, 'source remains independent after copy');
  assert.equal(result.characters[2], otherForm, 'same base-name other form is untouched');
  assert.equal(result.assets, project.assets);
  assert.equal(result.storyboards[1], unrelatedBoard);
  assert.equal(result.storyboards[0].finalPrompt, primaryBoard.finalPrompt);
  assert.equal(result.storyboards[0].englishPrompt, primaryBoard.englishPrompt);
  assert.equal(result.storyboards[0].revisions, primaryBoard.revisions);
  assert.equal(result.generationTasks, project.generationTasks);
  assert.deepEqual(result.storyboards[0].characterDossierDirty?.characterIds, [target.id]);
  assert.equal(result.sequencePlans[0].segments[0].status, 'stale');
  assert.equal(result.sequencePlans[0].reviewConfirmedFingerprint, undefined);
  assert.equal(result.sequencePlans[0].semanticPlanningSnapshot?.characterContinuity[0].appearance, source.appearance);
  assert.equal(result.sourceDocuments, project.sourceDocuments);
}
{
  const result = applyCharacterDossierApplication(project, { ...options, fields: ['outfit'], clearEmpty: true });
  assert.equal(result.characters.find((item) => item.id === target.id)?.outfit, '');
  assert.equal(result.characters.find((item) => item.id === target.id)?.appearance, target.appearance, 'unselected fields stay intact');
}
{
  const result = applyCharacterDossierApplication(project, { ...options, fields: ['apparentAge', 'signatureProps', 'motionHabits', 'negativeContinuity'] });
  const metadata = result.characters.find((item) => item.id === target.id)!.dossier!;
  for (const key of ['age', 'props', 'motion', 'negativeContinuity']) assert.ok(metadata.confirmedFields?.includes(key), `${key} matches form provenance keys`);
  for (const key of ['apparentAge', 'signatureProps', 'motionHabits']) assert.ok(!metadata.confirmedFields?.includes(key));
}
{
  const result = applyCharacterDossierApplication(project, { ...options, applyReferenceImages: true });
  const applied = result.characters.find((item) => item.id === target.id)!;
  assert.equal(applied.assetIds.length, 1, 'private reference excluded from ordinary apply');
  const linked = result.assets.find((item) => item.id === applied.assetIds[0])!;
  assert.equal(linked.linkedFromAssetId, 'new-ref');
  assert.equal(linked.relativePath, project.assets[1].relativePath);
  assert.equal(linked.checksum, project.assets[1].checksum);
  assert.equal(linked.sourceEntityId, target.id);
  assert.equal(linked.imageRegenerationSnapshot, undefined);
  assert.equal(linked.source, 'derived');
  assert.deepEqual(videoReferenceCharacterOwners(result, linked).map((item) => item.id), [target.id], 'H3 uses correct actual asset owner');
  assert.deepEqual(result.storyboards[0].shots[0].referenceAssetIds, [linked.id]);
  assert.deepEqual(result.storyboards[0].globalReferenceAssetIds, ['unrelated-ref', linked.id]);
  assert.deepEqual(result.storyboards[0].imageToImage?.referenceAssetIdsByShotId.shot, [linked.id]);
  assert.deepEqual(result.storyboards[0].promptPlan?.referenceAssetIds, [linked.id]);
  assert.deepEqual(result.storyboards[0].promptTrace?.referenceAssetIds, [linked.id]);
  assert.equal(result.storyboards[0].firstFrameAssetId, linked.id, 'only character reference used as a boundary follows explicit replacement');
  for (let i = 0; i < project.assets.length; i++) assert.equal(result.assets[i], project.assets[i], 'original provenance asset is untouched');
  const again = applyCharacterDossierApplication(result, { ...options, applyReferenceImages: true });
  assert.equal(again.assets.length, result.assets.length, 'association is reused on repeated application');
}
{
  const result = applyCharacterDossierApplication(project, { ...options, mode: 'transfer' });
  const replacement = result.characters.find((item) => item.id === source.id)!;
  const archived = result.characters.find((item) => item.id === target.id)!;
  assert.equal(replacement.name, target.name, 'story-facing name survives without replacing story text');
  assert.equal(replacement.formLabel, target.formLabel);
  assert.equal(replacement.baseName, target.baseName);
  assert.equal(replacement.appearance, source.appearance);
  assert.equal(replacement.outfit, target.outfit);
  assert.equal(replacement.nsfwProfile, source.nsfwProfile, 'transfer never copies private dossier from target');
  assert.equal(replacement.dossier?.useStory, false);
  assert.ok(replacement.dossier?.aliases?.includes(source.name));
  assert.equal(archived.dossier?.archivedIntoCharacterId, source.id);
  assert.equal(archived.appearance, target.appearance);
  assert.equal(archived.assetIds, target.assetIds);
  assert.deepEqual(result.scenes[0].characterIds, [source.id, otherForm.id]);
  assert.deepEqual(result.storyboards[0].sourceSceneSnapshots?.[0].characterIds, [source.id, otherForm.id]);
  assert.equal(result.storyboards[0].h3IdentityBindings?.characters[0].characterId, source.id);
  assert.equal(result.storyboards[0].revisions?.[0].h3IdentityBindings?.characters[0].characterId, target.id);
  assert.equal(result.scenes[0].content, originalScene.content);
  const reference = result.assets.find((item) => item.linkedFromAssetId === 'old-ref')!;
  assert.equal(reference.sourceEntityId, source.id);
  assert.deepEqual(videoReferenceCharacterOwners(result, reference).map((item) => item.id), [source.id]);
  assert.ok(replacement.assetIds.includes('private-ref'), 'source existing private reference stays with its original owner');
  assert.ok(!replacement.assetIds.includes('new-ref'), 'not selected custom reference is not silently mixed in');
  assert.equal(result.sequencePlans[0].semanticPlanningSnapshot?.characterContinuity[0].id, source.id);
  assert.equal(result.sequencePlans[0].semanticPlanningSnapshot?.characterContinuity[1].id, otherForm.id);
  assert.equal(result.generationTasks, project.generationTasks);
  assert.equal(result.storyboards[1], unrelatedBoard);
  assert.throws(() => applyCharacterDossierApplication(result, options), /已转移绑定/);
  const state = normalizeState(JSON.parse(JSON.stringify({ ...initial, project: result, projects: [result], currentProjectId: result.id })));
  assert.equal(state.project.characters.find((item) => item.id === target.id)?.dossier?.archivedIntoCharacterId, source.id);
  assert.equal(state.project.assets.find((item) => item.id === reference.id)?.linkedFromAssetId, 'old-ref');
  assert.ok(state.project.storyboards.find((item) => item.id === primaryBoard.id)?.characterDossierDirty);
}
{
  const result = applyCharacterDossierApplication(project, { ...options, mode: 'transfer', applyReferenceImages: true });
  assert.deepEqual(result.characters[0].assetIds, ['private-ref', 'new-ref']);
  assert.equal(result.assets.length, project.assets.length, 'source-owned reference already matches new identity ID');
  assert.deepEqual(result.storyboards[0].shots[0].referenceAssetIds, ['new-ref']);
}
{
  const noPictureSource = { ...source, assetIds: [] };
  const input = { ...project, characters: [noPictureSource, target, otherForm] };
  const result = applyCharacterDossierApplication(input, { ...options, applyReferenceImages: true });
  assert.deepEqual(result.characters.find((item) => item.id === target.id)?.assetIds, []);
  assert.equal(result.characters.find((item) => item.id === target.id)?.appearance, source.appearance, 'no picture never blocks ordinary dossier copy');
  assert.deepEqual(result.storyboards[0].shots[0].referenceAssetIds, []);
  assert.equal(result.assets.length, project.assets.length, 'old pictures remain in library');
}
{
  assert.throws(() => applyCharacterDossierApplication(project, { ...options, targetCharacterId: source.id }), /另一个/);
  assert.throws(() => applyCharacterDossierApplication(project, { ...options, targetCharacterId: 'missing' }), /不存在/);
  assert.throws(() => applyCharacterDossierApplication({ ...project, characters: [...project.characters, target] }, options), /重复/);
  assert.throws(() => applyCharacterDossierApplication(project, { ...options, fields: ['nsfwProfile' as never] }), /普通人物资料/);
  assert.throws(() => applyCharacterDossierApplication({ ...project, scenes: [...project.scenes, scene('independent', [source.id])] },
    { ...options, mode: 'transfer' }), /已经独立绑定/);
  assert.throws(() => applyCharacterDossierApplication({ ...project, storyboards: [...project.storyboards, { ...unrelatedBoard, id: 'custom-use', finalPrompt: `${source.name}独立剧情` }] },
    { ...options, mode: 'transfer' }), /已经独立绑定/);
}
assert.equal(JSON.stringify(project), before, 'all preview/apply/reload tests leave original project unchanged; App undo can restore this exact object');
console.log('character dossier application: copy/clear/reference association/transfer/forms/immutable history/reload validation passed');
