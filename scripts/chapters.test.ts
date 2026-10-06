import assert from 'node:assert/strict';
import {
  activeChapter, addChapter, appendChapters, archiveChapter, chapterBoards, chapterContentForEntity,
  chapterIdForAsset, chapterIdForTask, chapterPlans, chapterScenes, chapterScopeProject, chapterWorkspace,
  mergeChapterPieces, migrateProjectChapters, orderedChapters, reorderChapters, replaceChapterSourceDocument,
  splitChapterPiece, splitNovelChapters, withChapterSelection, withChapterWorkspace,
} from '../src/chapters';
import { replaceProjectSourceDocument } from '../src/appEffects';
import { createInitialState, normalizeState } from '../src/storage';
import { sourceContentHash } from '../src/sourceContentHash';
import { readProjectStoryDraft, withProjectStoryDraft } from '../src/storyDraft';
import type { Project, ReferenceAsset, Scene, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';

const empty = (): Project => ({ id: 'neutral-project', name: '港口旅行记', description: '', sourceDocuments: [], characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [], createdAt: 1, updatedAt: 1 });
const source = (id: string, content: string) => ({ id, name: id, content, createdAt: 1, updatedAt: 1 });
const scene = (id: string, hash?: string): Scene => ({ id, title: id, content: '旅人走进港口。', summary: '', sourceContentHash: hash, characterIds: ['traveler'], propIds: [], locationIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 });
const board = (id: string, overrides: Partial<Storyboard> = {}): Storyboard => ({
  id, sceneId: '', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots: [], finalPrompt: '已生成的港口镜头', createdAt: 1, updatedAt: 1, ...overrides,
});
const plan = (id: string, content: string, boardId: string): VideoSequencePlan => ({
  id, title: id, sourceStoryTitle: id, sourceStoryContent: content, durationMode: 'fixed', totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced', segments: [{ id: `${id}-segment`, index: 1, title: id, globalStartSec: 0, globalEndSec: 15, durationSec: 15, content, summary: '', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: boardId, status: 'ready' }], createdAt: 1, updatedAt: 1,
});

const original = empty();
const initial = migrateProjectChapters(original);
assert.equal(initial.sourceDocuments[0].id, 'chapter-neutral-project');
assert.equal(activeChapter(initial)?.id, initial.activeChapterId);
const initialWorkspace = initial.chapterWorkspaces?.[initial.activeChapterId!];
assert.ok(initialWorkspace);
assert.equal(Object.prototype.hasOwnProperty.call(initialWorkspace, 'directorSettingsConfirmedFingerprint'), false, 'absent chapter controls stay omitted');
assert.equal(Object.prototype.hasOwnProperty.call(initialWorkspace, 'directorLookDraft'), false, 'absent look drafts stay omitted');
assert.deepEqual(migrateProjectChapters(initial), initial, 'migration is deterministic and idempotent');
assert.equal(original.sourceDocuments.length, 0, 'migration is pure');

const legacy: Project = { ...empty(), sourceDocuments: [source('legacy-chapter', '旅人抵达港口。')], scenes: [scene('legacy-scene')], storyboards: [board('legacy-board')], sequencePlans: [plan('legacy-plan', '旅人抵达港口。', 'legacy-board')], storyDraft: { name: '旧草稿', content: ' 未保存正文\r\n', updatedAt: 2 }, directorSettingsConfirmedFingerprint: 'legacy-confirmed' };
const migratedLegacy = migrateProjectChapters(legacy);
assert.ok([...migratedLegacy.scenes, ...migratedLegacy.storyboards, ...migratedLegacy.sequencePlans].every((item) => item.chapterId === 'legacy-chapter'));
assert.equal(chapterWorkspace(migratedLegacy).storyDraft?.content, ' 未保存正文\r\n');
assert.equal(chapterWorkspace(migratedLegacy).directorSettingsConfirmedFingerprint, 'legacy-confirmed');

const textA = '旅人走进港口，找到向导。';
const textB = '旅人与向导乘船前往灯塔。';
const task = { id: 'video-task', storyboardId: 'board-b', targetId: '', status: 'running', requestBody: {}, createdAt: 1, updatedAt: 1, resultAssetId: 'video-asset', videoJob: { snapshot: { draft: { source: { chapterId: 'chapter-b', storyboardId: 'board-b' }, prompt: '冻结提示词' } } } } as unknown as VideoGenerationTask;
const two = migrateProjectChapters({ ...empty(),
  sourceDocuments: [source('chapter-a', textA), source('chapter-b', textB)],
  activeChapterId: 'chapter-b',
  scenes: [scene('scene-a', sourceContentHash(textA)), scene('scene-b', sourceContentHash(textB))],
  storyboards: [board('board-a', { sceneId: 'scene-a' }), board('board-b', { sequencePlanId: 'plan-b' })],
  sequencePlans: [plan('plan-a', textA, 'board-a'), plan('plan-b', textB, 'board-b')],
  generationTasks: [task], assets: [{ id: 'video-asset' } as ReferenceAsset],
});
assert.equal(activeChapter(two)?.id, 'chapter-b');
assert.deepEqual(chapterScenes(two).map((item) => item.id), ['scene-b']);
assert.deepEqual(chapterBoards(two).map((item) => item.id), ['board-b']);
assert.deepEqual(chapterPlans(two).map((item) => item.id), ['plan-b']);
assert.equal(chapterIdForTask(two, task), 'chapter-b');
assert.equal(chapterIdForAsset(two, two.assets[0]), 'chapter-b');
const scope = chapterScopeProject(two, 'chapter-a');
assert.equal(scope.sourceDocuments.length, 1);
assert.equal(scope.storyboards[0].id, 'board-a');
assert.equal(scope.generationTasks, two.generationTasks, 'the selector retains every project task');
assert.equal(scope.assets, two.assets, 'assets remain shared');

const unmapped = migrateProjectChapters({ ...two, storyboards: [...two.storyboards, board('unmapped-board')] });
const historical = unmapped.sourceDocuments.find((item) => item.historical)!;
assert.ok(historical);
assert.equal(unmapped.storyboards.find((item) => item.id === 'unmapped-board')?.chapterId, historical.id);
assert.deepEqual(migrateProjectChapters(unmapped), unmapped);

const draftB = withProjectStoryDraft(two, { storyName: '灯塔章未保存标题', storyInput: '未提交的灯塔正文' }, 4);
const withControls = withChapterWorkspace({ ...draftB, directorSettingsConfirmedFingerprint: 'confirmed-b', directorLookRequirement: '灯塔风格' }, { directorControls: { selectedSegmentId: 'b-2' }, videoDirector: { prompt: 'B video' } });
const selectedA = withChapterSelection(withControls, 'chapter-a');
assert.equal(readProjectStoryDraft(selectedA).storyInput, textA);
assert.equal(selectedA.directorSettingsConfirmedFingerprint, undefined);
assert.equal(selectedA.directorLookRequirement, undefined);
const draftA = withProjectStoryDraft(selectedA, { storyName: '港口草稿', storyInput: '未提交的港口正文' }, 5);
const restoredB = withChapterSelection(draftA, 'chapter-b');
assert.equal(readProjectStoryDraft(restoredB).storyInput, '未提交的灯塔正文');
assert.equal(restoredB.directorSettingsConfirmedFingerprint, 'confirmed-b');
assert.equal(chapterWorkspace(restoredB).directorControls?.selectedSegmentId, 'b-2');
assert.deepEqual(chapterWorkspace(restoredB).videoDirector, { prompt: 'B video' });
const cleared = withProjectStoryDraft(restoredB, { storyName: 'chapter-b', storyInput: textB });
assert.equal(chapterWorkspace(cleared).storyDraft, undefined);
assert.equal(readProjectStoryDraft(withChapterSelection(cleared, 'chapter-a')).storyInput, '未提交的港口正文');

const changed = replaceProjectSourceDocument(restoredB, { ...activeChapter(restoredB)!, content: '旅人与向导在灯塔休息。', updatedAt: 6 });
assert.equal(changed.sourceChanged, true);
assert.deepEqual(changed.invalidatedStoryboardIds, ['board-b']);
assert.deepEqual(changed.invalidatedPlanIds, ['plan-b']);
assert.equal(changed.project.storyboards.length, 2, 'source edits retain historical prompt results');
assert.equal(changed.project.storyboards.find((item) => item.id === 'board-b')?.sourceStale, true);
assert.equal(changed.project.sequencePlans.find((item) => item.id === 'plan-b')?.segments[0].status, 'stale');
assert.deepEqual(changed.project.storyboards.find((item) => item.id === 'board-a'), two.storyboards.find((item) => item.id === 'board-a'));
assert.deepEqual(changed.project.sequencePlans.find((item) => item.id === 'plan-a'), two.sequencePlans.find((item) => item.id === 'plan-a'));
assert.equal(changed.project.generationTasks, restoredB.generationTasks, 'source updates never rewrite task snapshots or stop workers');
assert.equal(changed.project.assets, restoredB.assets);
assert.equal(readProjectStoryDraft(changed.project).storyInput, '旅人与向导在灯塔休息。');
const renamed = replaceChapterSourceDocument(two, { ...activeChapter(two)!, name: '改名灯塔章' });
assert.equal(renamed.sourceChanged, false);
assert.equal(renamed.project.storyboards[1].sourceStale, undefined);
assert.equal(renamed.project.sequencePlans[1].segments[0].status, 'ready');

const added = addChapter(two, { name: '第三章', content: '海上日出。' }, 7);
assert.equal(added.sourceDocuments.length, 3);
assert.equal(activeChapter(added)?.name, '第三章');
assert.equal(chapterBoards(added).length, 0);
assert.equal(added.generationTasks, two.generationTasks);
assert.equal(added.characters, two.characters);
const twice = appendChapters(added, [{ name: '第三章', content: '海上日出。' }], 7);
assert.equal(new Set(twice.sourceDocuments.map((item) => item.id)).size, 4, 'reimports append without overwriting old source IDs');
const archived = archiveChapter(added, activeChapter(added)!.id);
assert.equal(orderedChapters(archived).length, 2);
assert.equal(archived.generationTasks, two.generationTasks);
assert.equal(activeChapter(archived)?.id, 'chapter-a');
assert.equal(archiveChapter(initial, activeChapter(initial)!.id), initial, 'one editable chapter is always retained');
assert.deepEqual(orderedChapters(reorderChapters(two, ['chapter-b', 'chapter-a'])).map((item) => item.id), ['chapter-b', 'chapter-a']);

for (const raw of [
  '\uFEFF第一章 港口\r\n旅人抵达。\r\n\r\n第二章 灯塔\r\n向导打开地图。\r\n',
  '小说标题\n目录\n第一章 港口\n第二章 灯塔\n\n第一章 港口\n旅人抵达。\n第二章 灯塔\n向导打开地图。',
  '# Chapter 1: Harbor\nA traveler arrives.\n\n# Chapter 2: Lighthouse\nA guide opens a map.\n',
  '没有标题的短篇正文。\r\n逐字保留。', '',
]) {
  const pieces = splitNovelChapters(raw, '中性样本.txt');
  assert.equal(pieces.map((piece) => piece.content).join(''), raw, 'automatic splitting preserves every source character');
  for (const piece of pieces) assert.equal(raw.slice(piece.sourceStart, piece.sourceEnd), piece.content);
  const first = pieces[0];
  if (first.content.length > 2) {
    const split = splitChapterPiece(first, 2);
    assert.equal(split.map((piece) => piece.content).join(''), first.content);
    assert.equal(mergeChapterPieces(split, 0)[0].content, first.content);
  }
}
const toc = splitNovelChapters('目录\n第一章 港口\n第二章 灯塔\n\n第一章 港口\n旅人抵达。\n第二章 灯塔\n向导打开地图。');
assert.equal(toc.length, 3, 'the compact table of contents is retained as a preface');
assert.equal(splitNovelChapters('\n\n第一章 港口\n旅人抵达。')[0].sourceStart, 0, 'leading whitespace stays with the first chapter');
assert.equal(chapterContentForEntity(two, 'character', 'traveler'), textB, 'entity context prefers the current relevant chapter');

const state = createInitialState();
const loaded = normalizeState({ ...state, project: restoredB, projects: [restoredB, { ...legacy, id: 'archived-project' }] });
assert.equal(loaded.project.activeChapterId, 'chapter-b');
assert.equal(readProjectStoryDraft(loaded.project).storyInput, '未提交的灯塔正文');
assert.equal(chapterWorkspace(loaded.project, 'chapter-a').storyDraft?.content, '未提交的港口正文');
assert.equal(loaded.projects.find((item) => item.id === 'archived-project')?.storyboards[0].chapterId, 'legacy-chapter');
assert.deepEqual((loaded.project.generationTasks[0] as VideoGenerationTask).videoJob?.snapshot, task.videoJob?.snapshot);

console.log('chapters: migration, import text preservation, draft switching, source isolation and shared task provenance passed (neutral local fixtures)');
