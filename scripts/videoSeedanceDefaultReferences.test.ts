import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../src/storage';
import { applyVideoPromptChoice, emptyVideoDraft, videoPromptChoices } from '../src/videoDirectorDraft';
import { buildVideoBatchRows, videoPromptChoiceKey } from '../src/videoBatch';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import type { Character, Location, Project, ReferenceAsset, Storyboard, VideoSequencePlan } from '../src/types';

const fixture = () => {
  const state = createInitialState();
  const person = (id: string, name: string): Character => ({ id, name, gender: '', apparentAge: '成年', race: '人类',
    appearance: '', outfit: '', personality: '', motionHabits: '', signatureProps: '', anchor: '', negativeContinuity: '', assetIds: [`${id}-image`] });
  const hero = person('hero', '明川'), other = person('other', '白露');
  const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition',
    mediaType: 'image', dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1, ...patch });
  const prompt = '视频规格：时长10秒，画幅16:9，分辨率720p。\n参考素材与职责：本段未提供图片参考。\n主体连续性：明川为成年男性，身穿灰色外套。\n一句话概述：明川走入庭院。\n连续时间轴：0至10秒，明川走入庭院，轻声说：“我到了。”\n全局约束：保留对白和脚步声。';
  const board: Storyboard = { id: 'board', sceneId: 'scene', sourceStoryTitle: '庭院', sourceStoryContent: '明川走入庭院。',
    workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: 'custom', shotMode: 'auto', pace: 'standard',
    aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '',
    globalLock: '', globalReferenceAssetIds: [], firstFrameAssetId: 'first', lastFrameAssetId: 'last', finalPrompt: prompt,
    shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 10, purpose: '', subject: '明川', action: '走入庭院', camera: '',
      transition: '', lighting: '', sound: '', result: '', referenceAssetIds: [], prompt: '', locked: false }],
    sequencePlanId: 'plan', segmentId: 'segment', segmentIndex: 1, segmentCount: 1, createdAt: 1, updatedAt: 2,
    seedance25Output: { targetId: 'seedance-2.5', promptZh: prompt, durationSec: 10, referenceManifest: [],
      sourceFingerprint: '', warnings: [], generatedAt: 1 } };
  const plan: VideoSequencePlan = { id: 'plan', title: '庭院', sourceStoryTitle: '庭院', sourceStoryContent: '明川走入庭院。',
    durationMode: 'ai-estimated', totalDurationSec: 10, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced',
    planningStage: 'segmented', createdAt: 1, updatedAt: 1, segments: [{ id: 'segment', index: 1, title: '庭院',
      globalStartSec: 0, globalEndSec: 10, durationSec: 10, content: '明川走入庭院。', summary: '', sourceSceneIds: ['scene'],
      sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready' }] };
  const project: Project = { ...state.project, characters: [hero, other], locations: [], props: [], sourceDocuments: [], generationTasks: [],
    storyboards: [board], sequencePlans: [plan], scenes: [{ id: 'scene', title: '庭院', content: '明川走入庭院。', summary: '',
      characterIds: [hero.id], propIds: [], storyboardIds: [board.id], createdAt: 1, updatedAt: 1 }], assets: [
      image('hero-image', { type: 'character', role: 'character', characterReferenceId: hero.id, sourceEntityId: hero.id, sourceEntityKind: 'character' }),
      image('other-image', { type: 'character', role: 'character', characterReferenceId: other.id, sourceEntityId: other.id, sourceEntityKind: 'character' }),
      image('first', { type: 'first-frame', role: 'first-frame', source: 'generated', sourceStoryboardId: board.id, imageVariant: 'first-frame' }),
      image('last', { type: 'last-frame', role: 'last-frame', source: 'generated', sourceStoryboardId: board.id, imageVariant: 'last-frame' }),
      image('manifest-a'), image('manifest-b'), image('global'),
      image('custom-still', { source: 'generated', sourceStoryboardId: board.id, imageVariant: 'storyboard-frame', imageFrameIndex: 1, imageFrameCount: 9 }),
    ] };
  const settings = { ...state.settings, videoBackend: 'api' as const, videoSource: 'api' as const,
    videoTaskApi: { ...state.settings.videoTaskApi, provider: 'generic' as const, parameterCapabilities: undefined } };
  const refresh = () => { board.seedance25Output!.sourceFingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board)); };
  refresh();
  const choice = () => videoPromptChoices(project, undefined, 'seedance')[0]!;
  return { project, settings, board, plan, prompt, refresh, choice };
};

test('Seedance single and batch defaults include later boundary frames and current identities despite an empty saved manifest', () => {
  const value = fixture(), before = structuredClone(value.project);
  const draft = applyVideoPromptChoice(emptyVideoDraft(value.settings), value.choice(), value.project, true);
  assert.deepEqual(draft.references.map((reference) => [reference.assetId, reference.role]),
    [['first', 'first-frame'], ['last', 'last-frame'], ['hero-image', 'character']]);
  assert.deepEqual(draft.references.at(-1)?.characterIds, ['hero']);
  assert.equal(draft.prompt, value.prompt);
  const row = buildVideoBatchRows(value.project, value.plan, value.settings, { promptFormat: 'seedance' })[0];
  assert.deepEqual(row.zh?.draft.references, draft.references, 'single and batch use the same selection');
  assert.ok(!row.zh?.draft.references.some((reference) => reference.assetId === 'other-image'));
  assert.deepEqual(value.project, before, 'saved prompts, manifests, character records and generated images stay exact');
});

test('saved manifest order stays first, current explicit bindings follow, and automatic custom stills stay out', () => {
  const value = fixture();
  value.board.seedance25Output!.referenceManifest = [
    { id: 'manifest-b', token: '@Image 1', mediaType: 'image' }, { id: 'manifest-a', token: '@Image 2', mediaType: 'image' },
  ];
  value.board.globalReferenceAssetIds = ['global'];
  value.board.shots[0].referenceAssetIds = ['custom-still']; value.refresh();
  const before = structuredClone(value.project);
  const draft = applyVideoPromptChoice(emptyVideoDraft(value.settings), value.choice(), value.project, true);
  assert.deepEqual(draft.references.slice(0, 2).map((reference) => reference.assetId), ['manifest-b', 'manifest-a']);
  assert.ok(draft.references.some((reference) => reference.assetId === 'global'));
  assert.ok(!draft.references.some((reference) => reference.assetId === 'custom-still'));
  assert.equal(draft.references.length, new Set(draft.references.map((reference) => reference.assetId)).size);
  assert.deepEqual(value.project, before);
});

test('declining source images and explicit empty batch overrides remain authoritative', () => {
  const value = fixture();
  assert.deepEqual(applyVideoPromptChoice(emptyVideoDraft(value.settings), value.choice(), value.project, false).references, []);
  const key = videoPromptChoiceKey(value.board.id, 'zh', 'seedance');
  const cleared = buildVideoBatchRows(value.project, value.plan, value.settings,
    { promptFormat: 'seedance', referenceOverrides: { [key]: [] } });
  assert.deepEqual(cleared[0].zh?.draft.references, []);
  const noDefaults = buildVideoBatchRows(value.project, value.plan, value.settings,
    { promptFormat: 'seedance', includeStoryboardReferences: false });
  assert.deepEqual(noDefaults[0].zh?.draft.references, []);
  const manual = buildVideoBatchRows(value.project, value.plan, value.settings,
    { promptFormat: 'seedance', referenceOverrides: { [key]: [{ assetId: 'manifest-a', role: 'style', slotIndex: 2 }] } });
  assert.deepEqual(manual[0].zh?.draft.references, [{ assetId: 'manifest-a', role: 'style', slotIndex: 2 }]);
});

test('scene defaults use exact staging or scene location IDs, preserve clear/rebind authority, and never sweep other locations', () => {
  const makeLocation = (id: string): Location => ({ id, name: id, description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: [`${id}-image`] });
  for (const source of ['staging-location', 'staging-scene', 'scene-location', 'snapshot-location'] as const) {
    const value = fixture();
    value.project.locations = [makeLocation('courtyard'), makeLocation('elsewhere')];
    value.project.assets.push(...value.project.locations.map((location): ReferenceAsset => ({
      id: location.assetIds[0], name: '不依赖同名匹配', type: 'location', role: 'scene', mediaType: 'image',
      sourceEntityKind: 'location', sourceEntityId: location.id, dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1,
    })));
    const scene = { ...value.project.scenes[0], id: 'located-scene', locationIds: ['courtyard'] };
    if (source === 'staging-location') value.board.sceneStaging = [{ version: 1, sceneId: 'courtyard' }];
    else if (source === 'staging-scene') { value.project.scenes.push(scene); value.board.sceneStaging = [{ version: 1, sceneId: scene.id }]; }
    else if (source === 'scene-location') value.project.scenes[0].locationId = 'courtyard';
    else { value.board.sourceSceneIds = [scene.id]; value.board.sourceSceneSnapshots = [scene]; }
    const select = () => { value.refresh(); return applyVideoPromptChoice(emptyVideoDraft(value.settings), value.choice(), value.project, true); };
    assert.deepEqual(select().references.filter((reference) => reference.role === 'scene').map((reference) => reference.assetId), ['courtyard-image'], source);
    value.board.globalReferenceAssetIds = ['courtyard-image'];
    assert.equal(select().references.filter((reference) => reference.assetId === 'courtyard-image').length, 1, 'existing explicit scene image is not duplicated');
    value.board.globalReferenceAssetIds = [];
    const selectedAsset = value.project.assets.find((asset) => asset.id === 'courtyard-image')!;
    selectedAsset.referenceEntityBinding = null;
    assert.ok(!select().references.some((reference) => reference.assetId === selectedAsset.id), 'explicit removal of a location binding is respected');
    selectedAsset.referenceEntityBinding = { kind: 'location', entityId: 'elsewhere' };
    assert.ok(!select().references.some((reference) => reference.assetId === selectedAsset.id), 'rebound images do not follow old provenance');
  }
});
