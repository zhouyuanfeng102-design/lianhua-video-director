import assert from 'node:assert/strict';
import type { ChapterWorkspace, Character, ComicPageAnalysis, Project, ReferenceAsset, StoryReferenceAnalysis, Storyboard, VideoSequencePlan } from '../src/types';
import { chapterWorkspace, migrateProjectChapters, withChapterSelection } from '../src/chapters';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import {
  comicIdentityCatalog, comicSourceFingerprint, isComicSourceAsset, moveComicPage, normalizeComicPageAnalysis,
  orderedComicReferences, setStoryComicSettings, setStoryImageSourceMode, storeComicStoryDraft,
  storyComicSettings, storyReferenceVideoAssetIds,
} from '../src/comicSources';
import {
  addStoryReference, applyStoryReferenceBindings, beginStoryReferenceRecognition, buildStoryReferenceContext,
  completeStoryReferenceRecognition, failStoryReferenceRecognition, normalizeStoryReferenceWorkspace,
  removeStoryReference, updateStoryReference, withStoryInputMode,
  storyReferenceFingerprint,
} from '../src/storyReferences';

const asset = (id: string): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition', mediaType: 'image',
  checksum: `checksum-${id}`, dataUrl: 'data:image/png;base64,cGl4ZWxz', tags: [], createdAt: 1, updatedAt: 1 });
const character = (id: string, name: string): Character => ({ id, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] });
const panelEvidence: ComicPageAnalysis = {
  panels: [{ id: 'p1', order: 1, bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }, description: '阿莉抬起铜灯，北辰向后退开。',
    characterIds: ['alice', 'north'], texts: [
      { id: 'bubble', type: 'dialogue', text: 'Stay back!', language: 'en', chineseText: '退后！', speakerId: 'alice' },
      { id: 'effect', type: 'sfx', text: 'CLINK', language: 'en', uncertainty: '字尾遮挡' },
    ], actions: [{ id: 'raise', eventId: 'exchange', actorId: 'alice', targetId: 'north', action: '抬起铜灯', result: '北辰后退', phase: '准备' }],
    entryState: '铜灯位于腰间', exitState: '铜灯高于肩膀', uncertainties: ['第二个气泡的说话人无法确认'] }],
  uncertainties: ['页外动作未知'],
};
const evidence = (comic = false): StoryReferenceAnalysis => ({
  description: '完整来源证据', characters: [{ id: 'alice', label: '阿莉', description: '红色外套', fields: { appearance: '完整衣物细节'.repeat(1500) } },
    { id: 'north', label: '北辰', description: '蓝色外套', fields: {} }],
  locations: [], props: [], events: ['抬灯后退'], relationships: [], readableText: ['Stay back!', 'CLINK'], uncertainties: ['气泡归属未知'],
  style: '漫画', composition: '多格页面', lighting: '侧光', colors: '红蓝', model: 'fixture-vision', revision: 1, analyzedAt: 2,
  rawResponse: '未删减回复', structuredData: { nested: { evidence: '完整嵌套细节'.repeat(1000) } }, ...(comic ? { comic: panelEvidence } : {}),
});
const base = (): Project => migrateProjectChapters({
  id: 'comic-project', name: '漫画来源', description: '', activeChapterId: 'a',
  sourceDocuments: ['a', 'b'].map((id) => ({ id, name: id, content: '既有正文', createdAt: 1, updatedAt: 1 })),
  characters: [character('alice-entity', '阿莉'), character('north-entity', '北辰')], locations: [], props: [],
  assets: [asset('page-one'), asset('page-two'), asset('portrait'), asset('single-panel')],
  scenes: [{ id: 'scene', chapterId: 'a', title: '灯光', content: '阿莉抬灯。', summary: '', characterIds: ['alice-entity', 'north-entity'],
    propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 }], storyboards: [], sequencePlans: [], generationTasks: [], createdAt: 1, updatedAt: 1,
});
const recognize = (project: Project, id: string, comic: boolean): Project => {
  const started = beginStoryReferenceRecognition(project, id, `request-${id}`, 'a', 2);
  return completeStoryReferenceRecognition(started.project, started.request, evidence(comic), 3);
};

const completedComicProject = (workspace: Partial<ChapterWorkspace>): Project => {
  const project = base();
  const plans: VideoSequencePlan[] = ['a', 'b'].map((id) => ({
    id: `plan-${id}`, chapterId: id, title: id, sourceStoryTitle: id, sourceStoryContent: '既有正文',
    durationMode: 'fixed', totalDurationSec: 15, requestedTotalDurationSec: 15, segmentDurationSec: 15,
    segmentationMode: 'fixed', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
    segments: [{ id: `segment-${id}`, index: 1, title: '抬灯', globalStartSec: 0, globalEndSec: 15, durationSec: 15,
      content: '已保存剧情', summary: '', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '',
      entryState: '', exitState: '', transitionHint: '', status: 'ready' }],
  }));
  return { ...project, chapterWorkspaces: { ...project.chapterWorkspaces, a: { ...chapterWorkspace(project, 'a'), ...workspace } },
    scenes: [...project.scenes, { ...project.scenes[0], id: 'scene-b', chapterId: 'b' }],
    storyboards: ['a', 'b'].map((id) => ({ id: `board-${id}`, chapterId: id, sceneId: `scene-${id}`,
      shots: [], finalPrompt: '已保存完整提示词', createdAt: 1, updatedAt: 1 } as Storyboard)), sequencePlans: plans };
};
const preparedPages = (enabled: boolean): NonNullable<ChapterWorkspace['storyReferences']> => ['page-one', 'page-two'].map((assetId, index) => ({
  id: `prepared-${index}`, number: index + 1, assetId, assetChecksum: `checksum-${assetId}`,
  sourceRole: 'comic', pageOrder: index + 1, enabled, status: 'ready', analysis: evidence(true),
  subjectBindings: [], createdAt: 1, updatedAt: 1,
}));
const assertSavedArtifacts = (actual: Project, expected: Project): void => {
  for (const key of ['sourceDocuments', 'scenes', 'storyboards', 'sequencePlans', 'generationTasks', 'assets'] as const) {
    assert.deepEqual(actual[key], expected[key], `${key} survives unused comic preparation`);
  }
  assert.deepEqual(actual.chapterWorkspaces?.b, expected.chapterWorkspaces?.b);
};
const assertChapterSourceChanged = (actual: Project, original: Project): void => {
  assertSavedArtifacts(actual, { ...original,
    scenes: original.scenes.map((scene) => scene.chapterId === 'a' ? { ...scene, sourceStale: true } : scene),
    storyboards: original.storyboards.map((board) => board.chapterId === 'a' ? { ...board, sourceStale: true } : board),
    sequencePlans: original.sequencePlans.map((plan) => plan.chapterId === 'a' ? { ...plan, sourceStale: true,
      segments: plan.segments.map((segment) => ({ ...segment, status: 'stale' as const })) } : plan),
  });
};
const preparationSettings = { readingDirection: 'vertical', dialogueMode: 'chinese', renderMode: 'motion_comic' } as const;

// Empty image controls, disabled pages and text-mode page preparation do not
// change a saved source. Full request/draft fingerprints still track the edits.
for (const storyInputMode of [undefined, 'text', 'image'] as const) {
  for (const enabled of [undefined, false, true]) {
    if (storyInputMode === 'image' && enabled === true) continue;
    const original = completedComicProject({ storyInputMode, storyImageSourceMode: 'reference',
      storyReferences: enabled === undefined ? [] : preparedPages(enabled) });
    const saved = JSON.stringify(original);
    const comicMode = setStoryImageSourceMode(original, 'comic', 'a');
    const prepared = setStoryComicSettings(comicMode, preparationSettings, 'a');
    assertSavedArtifacts(comicMode, original);
    assertSavedArtifacts(prepared, original);
    assertSavedArtifacts(moveComicPage(prepared, 'prepared-1', -1, 'a'), original);
    assert.deepEqual(storyComicSettings(prepared, 'a'), preparationSettings);
    assert.notEqual(comicSourceFingerprint(prepared, 'a'), comicSourceFingerprint(comicMode, 'a'));
    assert.equal(JSON.stringify(original), saved, 'preparation leaves the original project immutable');
  }
}
const activeReference = completedComicProject({ storyInputMode: 'image', storyImageSourceMode: 'reference', storyReferences: preparedPages(true) });
const legacyReference = completedComicProject({ storyInputMode: 'image', storyReferences: preparedPages(true) });
assertSavedArtifacts(setStoryComicSettings(legacyReference, preparationSettings, 'a'), legacyReference);
const dormantComicSettings = setStoryComicSettings(activeReference, preparationSettings, 'a');
assertSavedArtifacts(dormantComicSettings, activeReference);
assert.deepEqual(storyComicSettings(dormantComicSettings, 'a'), preparationSettings);
assert.equal(storyReferenceFingerprint(dormantComicSettings, 'a'), storyReferenceFingerprint(activeReference, 'a'));
assert.notEqual(comicSourceFingerprint(dormantComicSettings, 'a'), comicSourceFingerprint(activeReference, 'a'),
  'inactive comic settings still invalidate a pending comic request or draft, without invalidating existing reference-based output');

const activeComic = completedComicProject({ storyInputMode: 'image', storyImageSourceMode: 'comic', storyReferences: preparedPages(true) });
assertSavedArtifacts(setStoryComicSettings(activeComic, {}, 'a'), activeComic);
for (const patch of [{ readingDirection: 'vertical' }, { dialogueMode: 'chinese' }, { renderMode: 'motion_comic' }] as const) {
  assertChapterSourceChanged(setStoryComicSettings(activeComic, patch, 'a'), activeComic);
}
assertChapterSourceChanged(setStoryImageSourceMode(activeReference, 'comic', 'a'), activeReference);
assertChapterSourceChanged(setStoryImageSourceMode(activeComic, 'reference', 'a'), activeComic);
assertChapterSourceChanged(moveComicPage(activeComic, 'prepared-1', -1, 'a'), activeComic);
assertChapterSourceChanged(withStoryInputMode(activeComic, 'text', 'a'), activeComic);
const dormantPages = completedComicProject({ storyInputMode: 'text', storyImageSourceMode: 'comic', storyReferences: preparedPages(true) });
assertChapterSourceChanged(withStoryInputMode(dormantPages, 'image', 'a'), dormantPages);

const alreadyStale = completedComicProject({ storyInputMode: 'image', storyReferences: [] });
alreadyStale.scenes[0].sourceStale = true;
alreadyStale.storyboards[0].sourceStale = true;
alreadyStale.sequencePlans[0].sourceStale = true;
alreadyStale.sequencePlans[0].segments[0].status = 'stale';
assertSavedArtifacts(setStoryComicSettings(setStoryImageSourceMode(alreadyStale, 'comic', 'a'), preparationSettings, 'a'), alreadyStale);

assert.deepEqual(storyComicSettings(base(), 'a'), { readingDirection: 'rtl', dialogueMode: 'original', renderMode: 'animation' });
assert.deepEqual(normalizeComicPageAnalysis(panelEvidence), panelEvidence, 'original words, Chinese counterpart, action phases, bounds and uncertainty survive normalization');
assert.equal(normalizeComicPageAnalysis({ panels: [] }), undefined);
const repairedPanel = normalizeComicPageAnalysis({ panels: [{ ...panelEvidence.panels[0], bounds: { x: -1, y: 0, width: 0.5, height: 0.5 },
  texts: [{ ...panelEvidence.panels[0].texts[0], type: 'invalid' }] }] })!;
assert.equal(repairedPanel.panels[0].bounds, undefined);
assert.equal(repairedPanel.panels[0].texts[0].type, 'unknown');
assert.equal(repairedPanel.panels[0].texts[0].text, 'Stay back!');
const legacy = addStoryReference(withStoryInputMode(base(), 'image', 'a'), 'portrait', { id: 'old-reference', chapterId: 'a', now: 1 });
assert.equal(storyReferenceFingerprint(setStoryImageSourceMode(legacy, 'reference', 'a'), 'a'), storyReferenceFingerprint(legacy, 'a'),
  'the ordinary source-mode default does not invalidate saved legacy reference fingerprints');
assert.equal(storyReferenceFingerprint(updateStoryReference(legacy, 'old-reference', { sourceRole: 'reference' }, 'a'), 'a'), storyReferenceFingerprint(legacy, 'a'),
  'explicitly marking a legacy picture as an ordinary reference leaves its source meaning unchanged');

let project = withStoryInputMode(base(), 'image', 'a');
project = setStoryImageSourceMode(project, 'comic', 'a');
project = addStoryReference(project, 'portrait', { id: 'ref-portrait', chapterId: 'a', now: 1 });
project = addStoryReference(project, 'page-one', { id: 'ref-page-one', sourceRole: 'comic', chapterId: 'a', now: 1 });
project = addStoryReference(project, 'page-two', { id: 'ref-page-two', sourceRole: 'comic', chapterId: 'a', now: 1 });
assert.deepEqual(orderedComicReferences(project, 'a').map((page) => [page.id, page.pageOrder, page.number]), [
  ['ref-page-one', 1, 2], ['ref-page-two', 2, 3],
]);
const beforeMove = comicSourceFingerprint(project, 'a');
project = moveComicPage(project, 'ref-page-two', -1, 'a');
assert.deepEqual(orderedComicReferences(project, 'a').map((page) => [page.id, page.pageOrder, page.number]), [
  ['ref-page-two', 1, 3], ['ref-page-one', 2, 2],
]);
assert.notEqual(comicSourceFingerprint(project, 'a'), beforeMove, 'page order invalidates old generated stories without renumbering image labels');
assert.equal(moveComicPage(project, 'ref-page-two', -1, 'a'), project, 'boundary movement does not change the project');
assert.equal(project.sourceDocuments[0].content, '既有正文');
assert.ok(project.scenes[0].sourceStale, 'source setting changes invalidate only derived source data');

project = recognize(recognize(recognize(project, 'ref-portrait', false), 'ref-page-one', true), 'ref-page-two', true);
project = updateStoryReference(project, 'ref-portrait', { subjectBindings: [{ subjectId: 'alice', kind: 'character', entityId: 'alice-entity', name: '阿莉' }] }, 'a');
project = updateStoryReference(project, 'ref-page-one', { notes: '按用户更正，北辰在灯右侧。', subjectBindings: [
  { subjectId: 'alice', kind: 'character', entityId: 'alice-entity', name: '阿莉' },
  { subjectId: 'north', kind: 'character', entityId: 'north-entity', name: '北辰' },
] }, 'a');
const context = buildStoryReferenceContext(project, 'a')!;
assert.equal(context.references.length, 3, 'ordinary identity references remain in the comic source context');
assert.deepEqual(context.references.filter((item) => item.sourceRole === 'comic').map((item) => item.analysis.comic), [panelEvidence, panelEvidence]);
assert.match(context.text, /漫画原整页仅是剧情来源/u);
assert.ok(context.text.includes('完整衣物细节'.repeat(1500)), 'complete identity evidence is not truncated');

// Request bookkeeping must not make its own captured source fingerprint obsolete.
const sourceFingerprint = comicSourceFingerprint(project, 'a');
const started = beginStoryReferenceRecognition(project, 'ref-page-one', 'pending-vision', 'a');
assert.equal(comicSourceFingerprint(started.project, 'a'), sourceFingerprint);
const failed = failStoryReferenceRecognition(started.project, started.request, '网络中断');
assert.deepEqual(chapterWorkspace(failed, 'a').storyReferences?.find((item) => item.id === 'ref-page-one')?.analysis?.comic, panelEvidence);
assert.equal(comicSourceFingerprint(failed, 'a'), sourceFingerprint);
for (const changed of [
  setStoryComicSettings(project, { readingDirection: 'vertical' }, 'a'),
  setStoryComicSettings(project, { dialogueMode: 'chinese' }, 'a'),
  setStoryComicSettings(project, { renderMode: 'motion_comic' }, 'a'),
  updateStoryReference(project, 'ref-portrait', { notes: '参考身份修正' }, 'a'),
  updateStoryReference(project, 'ref-portrait', { subjectBindings: [] }, 'a'),
  updateStoryReference(project, 'ref-page-one', { enabled: false }, 'a'),
  { ...project, assets: project.assets.map((item) => item.id === 'page-one' ? { ...item, checksum: 'new-pixels' } : item) },
  { ...project, characters: project.characters.map((item) => item.id === 'alice-entity' ? { ...item, name: '用户更正的名字' } : item) },
  { ...project, characters: project.characters.map((item) => item.id === 'alice-entity' ? { ...item, aliases: ['用户添加的别名'] } : item) },
  { ...project, characters: project.characters.map((item) => item.id === 'alice-entity' ? { ...item, appearance: '新确认的外貌' } : item) },
]) assert.notEqual(comicSourceFingerprint(changed, 'a'), sourceFingerprint, 'each participating input invalidates a stale story draft');
assert.equal(comicSourceFingerprint({ ...project, updatedAt: 999 }, 'a'), sourceFingerprint, 'workspace timestamps do not invalidate the recognition request');
assert.deepEqual(comicIdentityCatalog(project).characters.map((item) => [item.id, item.name]), [['alice-entity', '阿莉'], ['north-entity', '北辰']]);

// Comic identity evidence is retained without adding the original full page to automatic video references.
project = { ...project, characters: project.characters.map((item) => ({ ...item, assetIds: ['page-one'] })),
  scenes: project.scenes.map((scene) => ({ ...scene, sourceStale: false })) };
project = applyStoryReferenceBindings(project, 'a', { scenes: [{ id: 'scene', referenceAssetIds: ['page-one', 'page-two', 'portrait'],
  storyReferenceBindings: [{ referenceId: 'ref-page-one', subjectId: 'north' }] }] });
assert.deepEqual(project.characters.find((item) => item.id === 'alice-entity')?.assetIds, ['portrait']);
assert.deepEqual(project.characters.find((item) => item.id === 'north-entity')?.assetIds, []);
assert.deepEqual(project.scenes[0].storyReferenceAssetIds, ['portrait']);
assert.deepEqual(project.assets.find((item) => item.id === 'page-one')?.storyReferenceSubjects?.map((item) => item.entityId), ['alice-entity', 'north-entity']);
assert.deepEqual(project.scenes[0].storyReferenceContext?.references.find((item) => item.sourceRole === 'comic')?.analysis.comic, panelEvidence);
assert.deepEqual(storyReferenceVideoAssetIds(project, ['page-one', 'single-panel', 'portrait', 'portrait', 'page-two']), ['single-panel', 'portrait']);
const manualDirectorReferences = ['page-one', 'portrait'];
storyReferenceVideoAssetIds(project, manualDirectorReferences);
assert.deepEqual(manualDirectorReferences, ['page-one', 'portrait'], 'automatic filtering never mutates explicitly chosen director references');
const detached = removeStoryReference(removeStoryReference(project, 'ref-page-one', 'a'), 'ref-page-two', 'a');
assert.equal(isComicSourceAsset(detached, 'page-one'), true, 'frozen scene provenance excludes historical comic originals from automatic reference lists');
assert.equal(isComicSourceAsset(detached, 'single-panel'), false, 'a separate single-panel asset remains a valid video reference');

project = setStoryComicSettings(project, { readingDirection: 'vertical', dialogueMode: 'chinese', renderMode: 'motion_comic' }, 'a');
project = storeComicStoryDraft(project, { storyText: '阿莉抬起铜灯：“退后！”北辰后退。', sourceFingerprint: comicSourceFingerprint(project, 'a'),
  generatedAt: 25, model: 'fixture-vision', adoptedAt: 26 }, 'a');
const adoptedFingerprint = comicSourceFingerprint(project, 'a');
project = storeComicStoryDraft(project, { ...chapterWorkspace(project, 'a').comicStoryDraft!, storyText: '用户编辑后的连续剧情' }, 'a');
assert.equal(comicSourceFingerprint(project, 'a'), adoptedFingerprint, 'editing the review does not change source evidence');
const switched = withChapterSelection(project, 'b');
assert.equal(chapterWorkspace(switched, 'b').comicStoryDraft, undefined);
assert.equal(chapterWorkspace(withChapterSelection(switched, 'a'), 'a').comicStoryDraft?.storyText, '用户编辑后的连续剧情');
const initial = createInitialState();
const state = { ...initial, project, projects: [project], activeProjectId: project.id };
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized)).project;
assert.deepEqual(chapterWorkspace(reloaded, 'a'), normalizeStoryReferenceWorkspace(chapterWorkspace(project, 'a')), 'page order, source roles, every panel field, settings and adopted story survive storage');
assert.deepEqual(reloaded.scenes[0].storyReferenceContext, project.scenes[0].storyReferenceContext);
assert.deepEqual(migrateProjectChapters(reloaded), reloaded, 'chapter migration is idempotent');
const interruptedState = { ...state, project: started.project, projects: [started.project] };
const recovered = normalizeState(JSON.parse(serializeStateForStorage(interruptedState).serialized)).project;
assert.equal(chapterWorkspace(recovered, 'a').storyReferences?.find((item) => item.id === 'ref-page-one')?.status, 'failed');
assert.deepEqual(chapterWorkspace(recovered, 'a').storyReferences?.find((item) => item.id === 'ref-page-one')?.analysis?.comic, panelEvidence);
assert.deepEqual(comicIdentityCatalog(recovered), comicIdentityCatalog(started.project), 'identity facts remain stable across storage normalization');
assert.equal(comicSourceFingerprint(recovered, 'a'), sourceFingerprint, 'restart changes only request status and preserves review identity');
assert.equal(normalizeStoryReferenceWorkspace({}).storyImageSourceMode, undefined, 'legacy chapters keep their existing source behavior');
console.log('Comic sources: ordered page evidence, original/Chinese dialogue, source guards, chapter storage and automatic video-reference isolation passed.');
