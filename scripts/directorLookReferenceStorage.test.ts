import assert from 'node:assert/strict';
import { mergeImportedProjectState } from '../src/appEffects';
import { deleteAssetFromProject } from '../src/assetDeletion';
import { archiveChapter, chapterScopeProject, chapterWorkspace, migrateProjectChapters, withChapterSelection, withChapterWorkspace } from '../src/chapters';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, Project, ReferenceAsset, Storyboard } from '../src/types';

// Synthetic metadata only: no local files, browser storage or paid requests.
const baseline = createInitialState();
const asset = (id: string): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'style', tags: ['风格参考'], createdAt: 1, updatedAt: 1,
});
const board: Storyboard = {
  id: 'saved-board', chapterId: 'chapter-a', sceneId: '', workflow: 'drama', inputMode: 'text',
  durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', stylePresetId: 'style_cinema', ruleSetId: 'timeline_director_cn',
  converterPresetId: 'converter_unified_video', globalLock: '', shots: [],
  finalPrompt: '已交付的提示词\n\n保留原有空行与措辞。', englishPrompt: 'Retain the saved English prompt.',
  createdAt: 1, updatedAt: 1,
};
const projectFor = (id = 'reference-project'): Project => migrateProjectChapters({
  ...baseline.project, id, name: id,
  sourceDocuments: [
    { id: 'chapter-a', name: '第一章', content: '旅人经过港口。', createdAt: 1, updatedAt: 1 },
    { id: 'chapter-b', name: '第二章', content: '旅人抵达灯塔。', createdAt: 1, updatedAt: 1 },
    { id: 'chapter-c', name: '历史章', content: '已保留的历史剧情。', archived: true, createdAt: 1, updatedAt: 1 },
  ],
  activeChapterId: 'chapter-a', chapterWorkspaces: {
    'chapter-a': { directorLookReferenceAssetId: 'image-a', directorLookRequirement: '保留水墨留白。' },
    'chapter-b': { directorLookReferenceAssetId: 'image-b' },
    'chapter-c': { directorLookReferenceAssetId: 'image-a' },
  },
  directorLookReferenceAssetId: 'image-a',
  directorLookRequirement: '保留水墨留白。',
  directorLookDraft: {
    directorStyleId: 'custom-calm', directorCategory: '旅途', directorStyleName: '安静的旅途调度',
    directorStyleSummary: '缓慢推进与自然场面调度。', visualStyle: '淡彩水墨', styleId: 'style_neutral',
  },
  directorSettingsConfirmedFingerprint: 'preserve-confirmed-settings', directorSettingsConfirmedAt: 3,
  characters: [], locations: [], props: [], scenes: [], storyboards: [board], sequencePlans: [],
  assets: [asset('image-a'), asset('image-b'), asset('image-replacement')], generationTasks: [],
});
const stateFor = (project: Project, ...others: Project[]): AppState => ({
  ...baseline, project, projects: [project, ...others], activeProjectId: project.id,
});
const roundTrip = (project: Project): Project => normalizeState(JSON.parse(serializeStateForStorage(stateFor(project)).serialized)).project;
const noReference = (project: Project, chapterId: string): void => {
  assert.equal(chapterWorkspace(project, chapterId).directorLookReferenceAssetId, undefined);
  assert.equal(Object.hasOwn(chapterWorkspace(project, chapterId), 'directorLookReferenceAssetId'), false);
};

const initial = projectFor();
const before = JSON.stringify(initial);
const reloaded = roundTrip(initial);
assert.equal(reloaded.directorLookReferenceAssetId, 'image-a');
assert.equal(chapterWorkspace(reloaded, 'chapter-b').directorLookReferenceAssetId, 'image-b');
assert.equal(chapterWorkspace(reloaded, 'chapter-c').directorLookReferenceAssetId, 'image-a');
assert.deepEqual(reloaded.assets.map(({ id, name, type, role, tags }) => ({ id, name, type, role, tags })),
  initial.assets.map(({ id, name, type, role, tags }) => ({ id, name, type, role, tags })),
  'image metadata stays in the project asset collection');
assert.equal(JSON.stringify(initial), before, 'saving and normalization are pure');
assert.equal(chapterScopeProject(reloaded, 'chapter-b').directorLookReferenceAssetId, 'image-b');
assert.equal(chapterScopeProject(reloaded, 'chapter-b').assets, reloaded.assets, 'chapter bindings do not copy or move project assets');

const selectedB = withChapterSelection(reloaded, 'chapter-b');
assert.equal(selectedB.directorLookReferenceAssetId, 'image-b');
assert.equal(withChapterSelection(selectedB, 'chapter-a').directorLookReferenceAssetId, 'image-a');
assert.equal(roundTrip(selectedB).directorLookReferenceAssetId, 'image-b');

const replaced = migrateProjectChapters({ ...reloaded, directorLookReferenceAssetId: 'image-replacement' });
assert.equal(chapterWorkspace(replaced, 'chapter-a').directorLookReferenceAssetId, 'image-replacement');
assert.equal(withChapterSelection(withChapterSelection(replaced, 'chapter-b'), 'chapter-a').directorLookReferenceAssetId, 'image-replacement');
assert.equal(roundTrip(replaced).directorLookReferenceAssetId, 'image-replacement');
assert.ok(replaced.assets.some((entry) => entry.id === 'image-a'), 'replacing analysis input does not delete old media');

// Clearing the compatibility field must clear the active chapter mirror during
// normalization and chapter navigation, including explicit undefined.
const explicitClear = { ...replaced, directorLookReferenceAssetId: undefined };
const normalizedClear = normalizeState(stateFor(explicitClear)).project;
noReference(normalizedClear, 'chapter-a');
assert.equal(Object.hasOwn(normalizedClear, 'directorLookReferenceAssetId'), false);
assert.deepEqual(migrateProjectChapters(normalizedClear), normalizedClear, 'cleared binding normalization is idempotent');
const returnedAfterClear = withChapterSelection(withChapterSelection(explicitClear, 'chapter-b'), 'chapter-a');
assert.equal(returnedAfterClear.directorLookReferenceAssetId, undefined, 'the old chapter image cannot return after clearing');
noReference(returnedAfterClear, 'chapter-a');

// The live editor updates both mirrors before save; JSON may drop undefined,
// so the chapter helper removes the old own property rather than hiding it.
const clearedForSave = withChapterWorkspace(explicitClear, { directorLookReferenceAssetId: undefined }, 'chapter-a');
noReference(clearedForSave, 'chapter-a');
const savedClear = roundTrip(clearedForSave);
noReference(savedClear, 'chapter-a');
assert.equal(savedClear.directorLookReferenceAssetId, undefined);
assert.equal(withChapterSelection(withChapterSelection(savedClear, 'chapter-b'), 'chapter-a').directorLookReferenceAssetId, undefined);
const archivedClear = archiveChapter(explicitClear, 'chapter-a');
assert.equal(archivedClear.directorLookReferenceAssetId, 'image-b');
noReference(archivedClear, 'chapter-a');

const deleted = deleteAssetFromProject(initial, 'image-a', 9);
assert.equal(deleted.directorLookReferenceAssetId, undefined);
assert.equal(Object.hasOwn(deleted, 'directorLookReferenceAssetId'), false);
noReference(deleted, 'chapter-a');
noReference(deleted, 'chapter-c');
assert.equal(chapterWorkspace(deleted, 'chapter-b').directorLookReferenceAssetId, 'image-b');
assert.equal(deleted.assets.some((entry) => entry.id === 'image-a'), false);
assert.strictEqual(deleted.storyboards, initial.storyboards, 'analysis-only image deletion does not rewrite delivered prompts');
assert.deepEqual(deleted.directorLookDraft, initial.directorLookDraft);
assert.equal(deleted.directorSettingsConfirmedFingerprint, initial.directorSettingsConfirmedFingerprint);
assert.equal(deleted.directorLookRequirement, initial.directorLookRequirement);
assert.equal(JSON.stringify(initial), before, 'asset deletion never mutates the input snapshot');
assert.equal(withChapterSelection(withChapterSelection(roundTrip(deleted), 'chapter-b'), 'chapter-a').directorLookReferenceAssetId, undefined);
assert.strictEqual(deleteAssetFromProject(deleted, 'missing-image'), deleted);

const other = { ...projectFor('other-project'), directorLookReferenceAssetId: 'image-b' };
const library = normalizeState(JSON.parse(serializeStateForStorage(stateFor(initial, other)).serialized));
assert.equal(library.projects.find((entry) => entry.id === 'other-project')?.directorLookReferenceAssetId, 'image-b');
const exported = serializeStateForStorage(stateFor(replaced)).serialized;
const imported = normalizeState(JSON.parse(exported));
const destination = stateFor(projectFor('destination'));
const merged = mergeImportedProjectState(destination, imported);
assert.strictEqual(merged.settings, destination.settings);
const importedReloaded = normalizeState(JSON.parse(serializeStateForStorage(merged).serialized));
assert.equal(importedReloaded.project.directorLookReferenceAssetId, 'image-replacement');
assert.equal(chapterWorkspace(importedReloaded.project, 'chapter-b').directorLookReferenceAssetId, 'image-b');
assert.equal(importedReloaded.projects.find((entry) => entry.id === 'destination')?.directorLookReferenceAssetId, 'image-a');

const legacy = structuredClone(initial);
delete legacy.directorLookReferenceAssetId;
for (const workspace of Object.values(legacy.chapterWorkspaces ?? {})) delete workspace.directorLookReferenceAssetId;
const legacyReloaded = roundTrip(legacy);
assert.equal(Object.hasOwn(legacyReloaded, 'directorLookReferenceAssetId'), false, 'old projects remain in the no-image flow');
noReference(legacyReloaded, 'chapter-a');
assert.deepEqual(legacyReloaded.directorLookDraft, initial.directorLookDraft);
assert.equal(legacyReloaded.storyboards[0].finalPrompt, board.finalPrompt);
for (const invalid of [null, true, 123, {}, [], '', ' \t\n ']) {
  const malformed = structuredClone(initial) as Project & Record<string, unknown>;
  (malformed as Record<string, unknown>).directorLookReferenceAssetId = invalid;
  malformed.chapterWorkspaces!['chapter-b'] = { directorLookReferenceAssetId: invalid } as unknown as NonNullable<Project['chapterWorkspaces']>[string];
  const cleaned = normalizeState(stateFor(malformed)).project;
  noReference(cleaned, 'chapter-a');
  noReference(cleaned, 'chapter-b');
  assert.equal(Object.hasOwn(cleaned, 'directorLookReferenceAssetId'), false);
}

console.log('Director look reference storage: save/reload, chapter isolation, replacement/clear, asset deletion, import/export and legacy compatibility passed.');
