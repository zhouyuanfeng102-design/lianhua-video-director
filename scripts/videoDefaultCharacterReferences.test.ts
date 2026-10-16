import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDefaultVideoCharacterReferences } from '../src/videoDefaultCharacterReferences';
import { videoReferenceSlotIndex } from '../src/videoReferenceSlots';
import type { Character, Project, ReferenceAsset, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

const character = (id: string, name = id, patch: Partial<Character> = {}): Character => ({
  id, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '', personality: '',
  motionHabits: '', signatureProps: '', anchor: '', negativeContinuity: '', assetIds: [`${id}-image`], ...patch,
});
const image = (id: string, owner?: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'character', role: 'character', mediaType: 'image', tags: [],
  dataUrl: 'data:image/png;base64,AAAA', createdAt: 1, updatedAt: 1,
  ...(owner ? { sourceEntityKind: 'character', sourceEntityId: owner } : {}), ...patch,
});
const prompt = (body: string): string => `integrated_multimodal_description: [Shot 1] ${body}\n\noverall_soundscape: N/A\nnon_diegetic_music: N/A\n`;
const setup = (characters: Character[], body: string, assets = characters.map((actor) => image(`${actor.id}-image`, actor.id))) => {
  const finalPrompt = prompt(body);
  const board = { id: 'board-2', sceneId: 'scene', shots: [], globalReferenceAssetIds: [],
    finalPrompt, officialPromptZh: finalPrompt, sequencePlanId: 'plan', segmentId: 'segment-2', segmentIndex: 2 } as unknown as Storyboard;
  const segment = { id: 'segment-2', index: 2, content: '', summary: '', narrativePurpose: '',
    storyboardId: board.id, sourceSceneIds: [] } as unknown as VideoSegment;
  const plan = { id: 'plan', segments: [segment] } as unknown as VideoSequencePlan;
  const project: Project = { id: 'project', name: '测试', description: '', sourceDocuments: [], characters,
    locations: [], props: [], scenes: [], storyboards: [board], sequencePlans: [plan], assets,
    generationTasks: [], createdAt: 1, updatedAt: 1 };
  const draft: VideoGenerationDraft = { name: '第2段', prompt: finalPrompt, backend: 'api', references: [], parameters: {},
    source: { storyboardId: board.id, sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: 2, language: 'zh', promptFormat: 'h3' } };
  return { project, draft, board, segment, plan };
};

test('a new segment with no board references defaults to one image for all four visible actors without altering final H3', () => {
  const actors = [character('king', '贝里洛'), character('shalltear', '夏提雅'), character('aura', '亚乌拉'), character('mare', '马雷')];
  const { project, draft, board } = setup(actors, '贝里洛站在前景。夏提雅站在中景。亚乌拉站在背景。马雷站在石台上。');
  const before = structuredClone({ project, draft });
  const next = addDefaultVideoCharacterReferences(project, draft);
  assert.deepEqual(next.references.map((reference) => reference.assetId), actors.map((actor) => `${actor.id}-image`));
  assert.deepEqual(next.references.map(videoReferenceSlotIndex), [0, 1, 2, 3]);
  assert.ok(next.references.every((reference) => reference.role === 'character'));
  assert.deepEqual(next.references.map((reference) => reference.characterIds), actors.map((actor) => [actor.id]));
  assert.equal(next.prompt, draft.prompt);
  assert.deepEqual(board.globalReferenceAssetIds, []);
  assert.deepEqual({ project, draft }, before);
});

test('only the selected final segment cast is defaulted; surrounding prose, offscreen voices and mentions are excluded', () => {
  const actors = [character('shalltear', '夏提雅'), character('aura', '亚乌拉'), character('mare', '马雷'), character('ainz', '安兹')];
  const state = setup(actors, '夏提雅站在前景。亚乌拉在画外说话。夏提雅低声说道：<d>[Chinese]马雷已经回去了。</d>');
  state.board.sourceStoryContent = '四人都参加了这场故事，安兹与马雷在另一个段落出现。';
  state.segment.content = '安兹站在大厅，马雷走进房间。';
  state.project.storyboards.push({ ...state.board, id: 'other-board', segmentId: 'other-segment',
    officialPromptZh: prompt('安兹站在大厅。马雷站在他身旁。') });
  const next = addDefaultVideoCharacterReferences(state.project, state.draft);
  assert.deepEqual(next.references.map((reference) => reference.assetId), ['shalltear-image']);
});

test('saved aliases resolve to current character IDs, including English and dossier names', () => {
  const actors = [character('shalltear', '夏提雅·布拉德弗伦', { aliases: ['Shalltear Bloodfallen'] }),
    character('aura', '亚乌拉', { dossier: { aliases: ['森林游侠'] } })];
  const state = setup(actors, 'shalltear bloodfallen stands in the foreground. 森林游侠站在背景。');
  assert.deepEqual(addDefaultVideoCharacterReferences(state.project, state.draft).references.map((reference) => reference.assetId),
    ['shalltear-image', 'aura-image']);
  const ambiguous = setup([character('one', '甲', { aliases: ['师父'] }), character('two', '乙', { aliases: ['师父'] })], '师父站在门前。');
  assert.deepEqual(addDefaultVideoCharacterReferences(ambiguous.project, ambiguous.draft).references, []);
});

test('current ownership and character binding order win while explicit clear, stale IDs and unavailable pixels never restore provenance', () => {
  const actors = [character('main', '主角', { assetIds: ['cleared', 'empty-binding', 'stale', 'rebound', 'missing', 'audio', 'empty', 'private', 'first', 'preferred', 'newer'] }),
    character('support', '配角', { assetIds: [] }), character('no-link', '无绑定人物', { assetIds: [] }),
    character('no-pixels', '无图人物', { assetIds: ['no-pixels-image'] }),
    character('archived', '旧人物', { dossier: { archivedIntoCharacterId: 'main' } })];
  const assets = [image('cleared', 'main', { characterReferenceId: null }), image('empty-binding', 'main', { characterReferenceId: '' }),
    image('stale', 'main', { characterReferenceId: 'deleted' }), image('rebound', 'main', { characterReferenceId: 'support' }),
    image('missing', 'main', { missing: true }), image('audio', 'main', { type: 'audio', mediaType: 'audio' }),
    image('empty', 'main', { dataUrl: undefined }), image('private', 'main', { referenceScope: 'nsfw-private-profile' }),
    image('first', 'main', { type: 'first-frame', role: 'first-frame', characterReferenceId: 'main' }),
    image('preferred', 'main'), image('newer', 'main', { createdAt: 50, updatedAt: 50 }),
    image('extra-main', undefined, { characterReferenceId: 'main', createdAt: 100, updatedAt: 100 }),
    image('source-only-history', 'no-link'), image('no-pixels-image', 'no-pixels', { dataUrl: undefined }), image('archived-image', 'archived')];
  const state = setup(actors, '主角站在门前。配角站在身后。无绑定人物站在左侧。无图人物站在右侧。旧人物站在背景。', assets);
  const next = addDefaultVideoCharacterReferences(state.project, state.draft);
  assert.deepEqual(next.references.map((reference) => reference.assetId), ['preferred', 'rebound']);
});

test('unlinked historical frames are excluded while explicitly bound ordinary pictures can provide identity', () => {
  const actors = [character('history', '历史人物', { assetIds: ['old-shot', 'old-tail'] }),
    character('bound', '绑定人物', { assetIds: [] })];
  const assets = [image('old-shot', 'history', { sourceStoryboardId: 'old-board', sourceShotId: 'old-shot', imageVariant: 'storyboard-frame' }),
    image('old-tail', 'history', { type: 'last-frame', role: 'last-frame' }),
    image('bound-picture', undefined, { type: 'reference', role: 'composition', sourceStoryboardId: 'old-board',
      imageVariant: 'storyboard-frame', characterReferenceId: 'bound' })];
  const state = setup(actors, '历史人物站在前景。绑定人物站在背景。', assets);
  assert.deepEqual(addDefaultVideoCharacterReferences(state.project, state.draft).references.map((reference) => reference.assetId), ['bound-picture']);
});

test('manual references keep their order, purposes and physical slots; only identity uses count as coverage', () => {
  const actors = [character('shalltear', '夏提雅', { assetIds: ['manual-scene', 'shalltear-image'] }),
    character('aura', '亚乌拉'), character('mare', '马雷')];
  const assets = [image('manual-scene', 'shalltear', { type: 'reference', role: 'scene' }),
    image('manual-prop', undefined, { type: 'prop', role: 'prop' }),
    image('shalltear-image', 'shalltear'), image('aura-image', 'aura'), image('mare-image', 'mare')];
  const state = setup(actors, '夏提雅站在前景。亚乌拉站在背景。马雷站在右侧。', assets);
  state.draft.references = [{ assetId: 'manual-scene', role: 'scene', slotIndex: 1 },
    { assetId: 'manual-prop', role: 'prop', slotIndex: 3, characterIds: ['aura'] }];
  state.draft.referenceSlotRoles = ['character', 'scene', 'character', 'prop'];
  const before = structuredClone(state.draft);
  const next = addDefaultVideoCharacterReferences(state.project, state.draft);
  assert.deepEqual(next.references.slice(0, 2), before.references);
  assert.deepEqual(next.references.map((reference) => reference.assetId), ['manual-scene', 'manual-prop', 'shalltear-image', 'mare-image']);
  assert.deepEqual(next.references.map(videoReferenceSlotIndex), [1, 3, 0, 2]);
  assert.deepEqual(next.referenceSlotRoles, before.referenceSlotRoles);
  assert.equal(next.prompt, before.prompt);
  assert.deepEqual(state.draft, before);
});

test('an explicit empty per-selection identity mapping does not borrow an asset owner', () => {
  const actor = character('hero', '夏提雅', { assetIds: ['chosen', 'hero-image'] });
  const state = setup([actor], '夏提雅站在门前。', [image('chosen', actor.id), image('hero-image', actor.id)]);
  state.draft.references = [{ assetId: 'chosen', role: 'character', characterIds: [] }];
  const next = addDefaultVideoCharacterReferences(state.project, state.draft);
  assert.deepEqual(next.references.map((reference) => reference.assetId), ['chosen', 'hero-image']);
  assert.deepEqual(next.references[0], state.draft.references[0]);
});

test('remembered non-identity vacancies remain empty while defaults use an identity vacancy or a new slot', () => {
  const actors = [character('shalltear', '夏提雅'), character('aura', '亚乌拉')];
  const state = setup(actors, '夏提雅站在前景。亚乌拉站在背景。',
    [image('scene', undefined, { type: 'reference', role: 'scene' }), image('shalltear-image', 'shalltear'), image('aura-image', 'aura')]);
  state.draft.references = [{ assetId: 'scene', role: 'scene', slotIndex: 1 }];
  state.draft.referenceSlotRoles = ['style', 'scene', 'subject', 'last-frame'];
  const before = structuredClone(state.draft);
  const next = addDefaultVideoCharacterReferences(state.project, state.draft);
  assert.deepEqual(next.references[0], before.references[0]);
  assert.deepEqual(next.references.map(videoReferenceSlotIndex), [1, 2, 4]);
  assert.ok(next.references.slice(1).every((reference) => reference.role === 'character'));
  assert.deepEqual(next.referenceSlotRoles, ['style', 'scene', 'character', 'last-frame', 'character']);
  assert.deepEqual(state.draft, before);
});

test('a sole actor image already used as a scene keeps that purpose and is never duplicated', () => {
  const actor = character('hero', '夏提雅');
  const state = setup([actor], '夏提雅站在门前。');
  state.draft.references = [{ assetId: 'hero-image', role: 'scene', slotIndex: 2 }];
  const before = structuredClone(state.draft);
  assert.strictEqual(addDefaultVideoCharacterReferences(state.project, state.draft), state.draft);
  assert.deepEqual(state.draft, before);
});

test('frozen retries, missing source boards and empty prompts remain untouched', () => {
  const state = setup([character('hero', '夏提雅')], '夏提雅站在门前。');
  for (const draft of [{ ...state.draft, reuseTaskId: 'frozen-task' },
    { ...state.draft, source: { ...state.draft.source!, storyboardId: 'deleted-board' } },
    { ...state.draft, prompt: '' }]) {
    assert.strictEqual(addDefaultVideoCharacterReferences(state.project, draft), draft);
  }
});
