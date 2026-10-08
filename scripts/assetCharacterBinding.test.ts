import assert from 'node:assert/strict';
import { assetReferenceCharacterOwners, bindAssetCharacter, isAssetCharacterBindingImage } from '../src/assetCharacterBinding';
import { applyOfficialH3Prompt, buildOfficialH3SourceFingerprint, hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { addVideoDraftAssets, applyVideoPromptChoice, emptyVideoDraft, videoImageRole, videoPromptChoices } from '../src/videoDirectorDraft';
import { prepareVideoH3ReferenceDraft, videoReferenceCharacterOwners } from '../src/videoH3ReferenceBinding';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { buildVideoBatchRows } from '../src/videoBatch';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import type { Character, Project, ReferenceAsset, Storyboard, VideoSequencePlan, VideoTaskApiConfig } from '../src/types';

let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const character = (id: string, name: string, assetIds: string[] = []): Character => ({ id, name, assetIds,
  gender: '', race: '人类', apparentAge: '成年', appearance: '黑发', outfit: '蓝衣', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition',
  mediaType: 'image', dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1, ...patch });
const anchorA = 'Identity: 甲 (S1), black hair and blue robe.';
const anchorB = 'Identity: 乙 (S2), brown hair and white robe.';
const zh = `integrated_multimodal_description: [Shot 1] ${anchorA} ${anchorB} 甲与乙在院子里交谈。<d>[Chinese] 请留下。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const en = `integrated_multimodal_description: [Shot 1] ${anchorA} ${anchorB} They talk in the courtyard. <d>[Chinese] 请留下。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://binding.test.invalid/generate',
  statusEndpointTemplate: 'https://binding.test.invalid/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', model: 'mock' };
const cloud = (): VideoTaskApiConfig => ({ ...api, provider: 'runninghub', runningHubImageRoles: ['character', 'character', 'character'],
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'p', fieldName: 'value', fieldValue: '' },
    ...Array.from({ length: 3 }, (_, index) => ({ nodeId: `i${index}`, fieldName: 'image', fieldValue: '' }))] }),
  runningHubMappedFields: [{ nodeId: 'p', fieldName: 'value', kind: 'prompt' },
    ...Array.from({ length: 3 }, (_, imageIndex) => ({ nodeId: `i${imageIndex}`, fieldName: 'image', kind: 'image' as const, imageIndex }))] });
const fixture = (): Project => {
  const project = createInitialState().project;
  project.id = 'asset-binding-offline'; project.characters = [character('a', '甲', ['old']), character('b', '乙')];
  project.assets = [image('old', { sourceEntityId: 'a', sourceEntityKind: 'character' }),
    image('frame', { sourceStoryboardId: 'historic-board', sourceShotId: 'historic-shot', imageVariant: 'storyboard-frame', source: 'generated' }), image('free')];
  project.scenes = []; project.locations = []; project.props = []; project.sequencePlans = []; project.generationTasks = [];
  const board: Storyboard = { id: 'board', sceneId: '', workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s',
    shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '',
    globalLock: '', finalPrompt: '【0s-5s】主体：甲与乙；空间：院子；动作：两人交谈；光影：日光；镜头：中景；台词：甲：“请留下。”；音效：风声。',
    shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 5, subject: '甲与乙', action: '两人交谈', camera: '中景', lighting: '日光', sound: '风声', referenceAssetIds: ['old'], prompt: '甲与乙在院子交谈。', locked: false }],
    createdAt: 1, updatedAt: 1 };
  const initial = createInitialState(); initial.project = { ...project, storyboards: [board] };
  initial.projects = [initial.project]; initial.activeProjectId = project.id;
  const normalized = normalizeState(initial).project;
  const compiled = applyOfficialH3Prompt(normalized.storyboards[0], officialH3ContextForStoryboard(normalized, normalized.storyboards[0]));
  const bindings = { version: 1 as const, characters: [{ characterId: 'a', name: '甲', speakerToken: '(S1)', referenceAnchor: anchorA },
    { characterId: 'b', name: '乙', speakerToken: '(S2)', referenceAnchor: anchorB }] };
  normalized.storyboards = [{ ...compiled, officialPromptZh: zh, officialPromptEn: en, officialPromptEnSource: zh,
    targetOutput: { ...compiled.targetOutput!, prompt: zh }, h3IdentityBindings: bindings, h3IdentityBindingsEn: structuredClone(bindings) }];
  return normalized;
};
const draftFor = (project: Project, language: 'zh' | 'en' = 'zh') => {
  const choice = videoPromptChoices(project).find((entry) => entry.language === language)!;
  assert.ok(choice, `${language} saved prompt stays selectable`);
  return applyVideoPromptChoice(emptyVideoDraft(createInitialState().settings), choice, project, false);
};

test('绑定、更换和明确解绑不改变来源、人物assetIds、分镜或中英文原稿', () => {
  const original = fixture(); const before = structuredClone(original);
  let project = bindAssetCharacter(original, 'old', 'b', 2);
  assert.equal(project.assets[0].characterReferenceId, 'b');
  assert.equal(project.assets[0].sourceEntityId, 'a'); assert.equal(project.assets[0].sourceEntityKind, 'character');
  assert.equal(project.storyboards, original.storyboards); assert.equal(project.characters, original.characters);
  assert.equal(project.assets[1], original.assets[1]); assert.deepEqual(original, before);
  assert.deepEqual(assetReferenceCharacterOwners(project, project.assets[0]).map((person) => person.id), ['b']);
  assert.equal(bindAssetCharacter(project, 'old', 'b', 3), project);
  project = bindAssetCharacter(project, 'old', 'a', 3);
  assert.deepEqual(assetReferenceCharacterOwners(project, project.assets[0]).map((person) => person.id), ['a']);
  project = bindAssetCharacter(project, 'old', null, 4);
  assert.deepEqual(assetReferenceCharacterOwners(project, project.assets[0]), []);
  assert.equal(bindAssetCharacter(project, 'old', null, 5), project);
  for (const updated of [bindAssetCharacter(original, 'old', 'b', 2), project]) {
    const board = updated.storyboards[0]; const context = officialH3ContextForStoryboard(updated, board);
    assert.equal(buildOfficialH3SourceFingerprint(board, context), original.storyboards[0].officialPromptSource);
    assert.equal(hasCurrentOfficialH3Prompt(board, context), true); assert.equal(hasCurrentOfficialH3EnglishPrompt(board, context), true);
    assert.equal(board.officialPromptZh, zh); assert.equal(board.officialPromptEn, en);
  }
});

test('分镜来源图片可以明确绑定，缺图不阻止编辑绑定；只拒绝不存在/歧义人物和非图片', () => {
  const project = fixture(); project.assets[1].missing = true;
  assert.equal(bindAssetCharacter(project, 'frame', 'b').assets[1].sourceShotId, 'historic-shot');
  assert.equal(isAssetCharacterBindingImage(image('clay', { type: 'clay-render', mediaType: 'clay-render' })), true);
  assert.throws(() => bindAssetCharacter(project, 'frame', 'unknown'), /人物/);
  assert.throws(() => bindAssetCharacter({ ...project, characters: [...project.characters, project.characters[1]] }, 'frame', 'b'), /人物/);
  const archived = structuredClone(project); archived.characters[1].dossier = { archivedIntoCharacterId: 'a' };
  assert.throws(() => bindAssetCharacter(archived, 'frame', 'b'), /归档/);
  assert.throws(() => bindAssetCharacter({ ...project, assets: [image('video', { type: 'video' })] }, 'video', null), /图片/);
  assert.throws(() => bindAssetCharacter(project, 'missing-id', null), /不存在/);
});

test('旧项目沿用来源和assetIds，显式无效绑定不回落旧人物，本次选择仍优先', () => {
  const project = fixture(); assert.deepEqual(assetReferenceCharacterOwners(project, project.assets[0]).map((person) => person.id), ['a']);
  project.characters[1].assetIds.push('free');
  assert.deepEqual(assetReferenceCharacterOwners(project, project.assets[2]).map((person) => person.id), ['b']);
  project.assets[0].characterReferenceId = 'missing-person';
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0]), []);
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0], { assetId: 'old', role: 'character', characterIds: ['b'] }).map((person) => person.id), ['b']);
  project.assets[0].characterReferenceId = 'b';
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0], { assetId: 'old', role: 'character', characterIds: [] }), []);
});

test('JSON保存重载保留绑定/解除/旧项目三种语义且原稿可用', () => {
  const state = createInitialState(); state.project = bindAssetCharacter(bindAssetCharacter(fixture(), 'frame', 'b', 2), 'old', null, 3);
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const normalized = normalizeState(state); const restored = normalizeState(JSON.parse(serializeStateForStorage(normalized).serialized));
  const project = restored.project;
  assert.equal(project.assets.find((asset) => asset.id === 'frame')?.characterReferenceId, 'b');
  assert.equal(project.assets.find((asset) => asset.id === 'old')?.characterReferenceId, null);
  assert.equal(project.assets.find((asset) => asset.id === 'free')?.characterReferenceId, undefined);
  assert.equal(project.storyboards[0].officialPromptZh, zh); assert.equal(project.storyboards[0].officialPromptEn, en);
  assert.equal(hasCurrentOfficialH3Prompt(project.storyboards[0], officialH3ContextForStoryboard(project, project.storyboards[0])), true);
  assert.deepEqual(normalizeState(restored), restored);
});

test('单段中英文都使用用户绑定的人物，生成请求实际带图片编号', () => {
  const project = bindAssetCharacter(fixture(), 'frame', 'b');
  assert.equal(videoImageRole(project.assets[1]), 'character');
  for (const language of ['zh', 'en'] as const) {
    const selected = addVideoDraftAssets(draftFor(project, language), ['frame'], project.assets);
    const result = prepareVideoH3ReferenceDraft(project, selected, { backend: 'api', api });
    assert.equal(result.characterStates.find((person) => person.characterId === 'b')?.status, 'bound');
    assert.match(result.draft.prompt, /Visual identity reference for 乙 \(S2\): <Picture 1>/u);
    const body = buildVideoApiBody(api, result.draft, ['frame.png']);
    assert.equal(body.prompt, result.draft.prompt);
    assert.equal(result.draft.references[0].assetId, 'frame');
    assert.equal(project.storyboards[0].officialPromptZh, zh); assert.equal(project.storyboards[0].officialPromptEn, en);
  }
});

test('RunningHub稀疏物理槽仍准确关联，不把图号当人物顺序', () => {
  const project = bindAssetCharacter(fixture(), 'frame', 'b');
  const draft = { ...draftFor(project), references: [{ assetId: 'frame', role: 'character' as const, slotIndex: 2 }] };
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.match(result.draft.prompt, /乙 \(S2\): <Picture 3>/u);
  const body = buildVideoApiBody(cloud(), result.draft, ['frame.png']);
  const fields = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
  assert.equal(fields.find((field) => field.nodeId === 'i2')?.fieldValue, 'frame.png');
  assert.equal(fields.find((field) => field.nodeId === 'i0')?.fieldValue, '');
  assert.equal(fields.find((field) => field.nodeId === 'p')?.fieldValue, result.draft.prompt);
});

test('解绑和未绑定图片仍可选中并构造视频请求，不虚假关联旧人物', () => {
  const project = bindAssetCharacter(fixture(), 'old', null);
  const draft = addVideoDraftAssets(draftFor(project), ['old', 'free'], project.assets);
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.equal(result.draft.references.length, 2);
  assert.ok(result.characterStates.every((person) => person.status !== 'bound'));
  assert.doesNotThrow(() => buildVideoApiBody(api, result.draft, ['old.png', 'free.png']));
});

test('改绑后只在请求副本移除旧人物Picture引用，原稿与对白字面值保留', () => {
  const project = bindAssetCharacter(fixture(), 'old', 'b'); const draft = draftFor(project);
  const source = zh.replace(anchorA, `${anchorA} <Picture 1>.`).replace('请留下。', '保留<Picture 1>。');
  draft.prompt = source;
  draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: source, renderedPrompt: source, sourcePictures: [{ number: 1, assetId: 'old' }] };
  const result = prepareVideoH3ReferenceDraft(project, addVideoDraftAssets(draft, ['old'], project.assets), { backend: 'api', api });
  assert.ok(!result.draft.prompt.includes(`${anchorA} <Picture 1>`));
  assert.match(result.draft.prompt, /乙 \(S2\): <Picture 1>/u);
  assert.ok(result.draft.prompt.includes('<d>[Chinese] 保留<Picture 1>。</d>'));
  assert.equal(project.storyboards[0].officialPromptZh, zh);
});

test('长剧情批量中英文选图沿用资产绑定，关联不需要改分镜人物列表', () => {
  const project = bindAssetCharacter(fixture(), 'frame', 'b');
  const plan: VideoSequencePlan = { id: 'plan', title: '计划', sourceStoryTitle: '计划', sourceStoryContent: '甲与乙交谈',
    durationMode: 'ai-estimated', totalDurationSec: 5, segmentDurationSec: 5, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented',
    segments: [{ id: 'segment', index: 1, title: '交谈', globalStartSec: 0, globalEndSec: 5, durationSec: 5, content: '甲与乙交谈', summary: '', sourceSceneIds: [],
      sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: 'board', status: 'ready' }], createdAt: 1, updatedAt: 1 };
  project.sequencePlans = [plan];
  const settings = createInitialState().settings; settings.videoTaskApi = api; settings.videoApiProfiles = []; settings.activeVideoApiProfileId = null;
  const rows = buildVideoBatchRows(project, plan, settings, { backend: 'api', includeStoryboardReferences: false,
    referenceOverrides: { 'board:zh': [{ assetId: 'frame', role: videoImageRole(project.assets[1]) }], 'board:en': [{ assetId: 'frame', role: 'character' }] } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].zh!.draft.prompt, /乙 \(S2\): <Picture 1>/u);
  assert.match(rows[0].en!.draft.prompt, /乙 \(S2\): <Picture 1>/u);
});

test('本地末帧＋参考图保留用户明确绑定的分镜来源图片', () => {
  const project = bindAssetCharacter(fixture(), 'frame', 'b');
  const draft = addVideoDraftAssets(draftFor(project), ['frame'], project.assets);
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.ok(result.draft.references.some((reference) => reference.assetId === 'frame' && reference.role === 'character'));
});

test('无生成来源资产曾绑定甲，改绑乙或解除也不保留旧甲的图片引用', () => {
  for (const target of ['b', null] as const) {
    const project = bindAssetCharacter(fixture(), 'free', target); const draft = draftFor(project);
    const source = zh.replace(anchorA, `${anchorA} <Picture 1>.`);
    draft.prompt = source;
    draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: source, renderedPrompt: source, sourcePictures: [{ number: 1, assetId: 'free' }] };
    const selected = addVideoDraftAssets(draft, ['free'], project.assets);
    const result = prepareVideoH3ReferenceDraft(project, selected, { backend: 'api', api });
    assert.ok(!result.draft.prompt.includes(`${anchorA} <Picture 1>`));
    if (target === 'b') assert.match(result.draft.prompt, /乙 \(S2\): <Picture 1>/u);
    else assert.doesNotMatch(result.draft.prompt, /<Picture 1>/u);
  }
});

test('改回生成来源人物也重建旧Picture，不把生成来源误认成旧稿归属', () => {
  const project = bindAssetCharacter(bindAssetCharacter(fixture(), 'old', 'b'), 'old', 'a');
  assert.equal(project.assets[0].sourceEntityId, 'a');
  const draft = draftFor(project);
  const source = zh.replace(anchorB, `${anchorB} <Picture 1>.`);
  draft.prompt = source;
  draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: source, renderedPrompt: source, sourcePictures: [{ number: 1, assetId: 'old' }] };
  const before = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, addVideoDraftAssets(draft, ['old'], project.assets), { backend: 'api', api });
  assert.ok(!result.draft.prompt.includes(`${anchorB} <Picture 1>`));
  assert.match(result.draft.prompt, /甲 \(S1\): <Picture 1>/u);
  assert.doesNotMatch(result.draft.prompt, /Visual identity reference for 乙/u);
  assert.deepEqual({ project, draft }, before);
});

test('明确绑定的人物后来删除或归档时，不从冻结计划复活身份', () => {
  for (const removed of [false, true]) {
    const project = bindAssetCharacter(fixture(), 'frame', 'b'); const draft = draftFor(project);
    project.storyboards[0].sequencePlanId = 'frozen';
    project.sequencePlans = [{ id: 'frozen', planningMode: 'semantic-segments', semanticPlanningSnapshot: {
      version: 1, characterContinuity: structuredClone(project.characters),
    } } as unknown as VideoSequencePlan];
    if (removed) project.characters = project.characters.filter((person) => person.id !== 'b');
    else project.characters[1].dossier = { archivedIntoCharacterId: 'a' };
    const result = prepareVideoH3ReferenceDraft(project, addVideoDraftAssets(draft, ['frame'], project.assets), { backend: 'api', api });
    assert.doesNotMatch(result.draft.prompt, /Visual identity reference for 乙/u);
    assert.ok(result.characterStates.every((person) => person.characterId !== 'b' || person.status !== 'bound'));
    assert.ok(result.warnings.some((warning) => warning.includes('尚未明确绑定')));
  }
});

console.log(`PASS ${groups} asset character binding groups; synthetic data and no provider calls`);
