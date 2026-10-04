import assert from 'node:assert/strict';
import { mergeImportedProjectState } from '../src/appEffects';
import { normalizeDirectorLookDraft, type DirectorLookDraft } from '../src/directorLookDraft';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, Project } from '../src/types';

// Synthetic in-memory state only: no real project, browser storage or API.
const draftFor = (label: string): DirectorLookDraft => ({
  directorStyleId: `custom-director-${label}`,
  directorCategory: `  自定义分类${label}  `,
  directorStyleName: `自定义导演风格${label}`,
  directorStyleSummary: `  导演说明${label}\r\n${'完整自定义资料，不截断。'.repeat(500)}尾句保留。  `,
  visualStyle: `视觉风格${label}\n保留第二行`,
  styleId: `custom-style-${label}`,
});
const baseline = createInitialState();
const projectFor = (id: string, draft?: DirectorLookDraft): Project => ({
  ...baseline.project,
  id,
  name: `合成项目${id}`,
  sourceDocuments: [], characters: [], locations: [], props: [], scenes: [],
  storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
  directorLookRequirement: `AI填写输入${id}`,
  directorSettingsConfirmedFingerprint: `独立的已确认参数${id}`,
  directorSettingsConfirmedAt: 100,
  ...(draft ? { directorLookDraft: draft } : {}),
});
const stateFor = (active: Project, ...archived: Project[]): AppState => ({
  ...baseline, project: active, projects: [active, ...archived], activeProjectId: active.id,
});
const roundTrip = (state: AppState): AppState => normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
const assertDraft = (actual: DirectorLookDraft | undefined, expected: DirectorLookDraft): void => {
  assert.deepEqual(actual, expected);
  assert.notStrictEqual(actual, expected, 'normalization returns an independent draft object');
};

const draftA = draftFor('A');
const draftB = draftFor('B');
const normalized = normalizeDirectorLookDraft({ ...draftA, unknown: { shouldNotPersist: true } });
assertDraft(normalized, draftA);
assert.deepEqual(Object.keys(normalized!).sort(), Object.keys(draftA).sort(), 'only the six supported fields are retained');
normalized!.directorStyleName = '只改归一化副本';
assert.equal(draftA.directorStyleName, '自定义导演风格A');

const emptyDraft: DirectorLookDraft = {
  directorStyleId: '', directorCategory: '', directorStyleName: '',
  directorStyleSummary: '', visualStyle: '', styleId: '',
};
assertDraft(normalizeDirectorLookDraft(emptyDraft), emptyDraft);
const whitespaceDraft = Object.fromEntries(Object.keys(emptyDraft).map((key) => [key, ' \t\r\n　 '])) as unknown as DirectorLookDraft;
assertDraft(normalizeDirectorLookDraft(whitespaceDraft), whitespaceDraft);
assert.deepEqual(roundTrip(stateFor(projectFor('empty', emptyDraft))).project.directorLookDraft, emptyDraft);
assert.deepEqual(roundTrip(stateFor(projectFor('space', whitespaceDraft))).project.directorLookDraft, whitespaceDraft);

const malformed: unknown[] = [undefined, null, true, 12, 'invalid', [], {}, Object.create(draftA)];
for (const key of Object.keys(draftA)) {
  const missing = { ...draftA } as Record<string, unknown>;
  delete missing[key];
  malformed.push(missing);
  for (const value of [undefined, null, false, 0, [], { value: 'not a string' }]) {
    malformed.push({ ...draftA, [key]: value });
  }
}
for (const invalid of malformed) {
  assert.equal(normalizeDirectorLookDraft(invalid), undefined, 'incomplete or malformed snapshots do not invent defaults');
  const raw = stateFor(projectFor('invalid-active'), projectFor('invalid-archived'));
  (raw.project as unknown as Record<string, unknown>).directorLookDraft = invalid;
  (raw.projects[1] as unknown as Record<string, unknown>).directorLookDraft = invalid;
  const loaded = normalizeState(raw);
  assert.equal(Object.hasOwn(loaded.project, 'directorLookDraft'), false);
  assert.equal(Object.hasOwn(loaded.projects[1], 'directorLookDraft'), false);
}

const projectA = projectFor('A', draftA);
const projectB = projectFor('B', draftB);
const saved = stateFor(projectA, projectB);
const before = JSON.stringify(saved);
const reloadedA = roundTrip(saved);
assertDraft(reloadedA.project.directorLookDraft, draftA);
assertDraft(reloadedA.projects.find((project) => project.id === 'B')!.directorLookDraft, draftB);
assert.equal(JSON.stringify(saved), before, 'normalizing and serializing never mutate caller-owned state');

// Follow the same active-project selection contract used when opening a library row.
const reloadedB = roundTrip({
  ...reloadedA, project: reloadedA.projects.find((project) => project.id === 'B')!, activeProjectId: 'B',
});
assertDraft(reloadedB.project.directorLookDraft, draftB);
const returnedA = roundTrip({
  ...reloadedB, project: reloadedB.projects.find((project) => project.id === 'A')!, activeProjectId: 'A',
});
assertDraft(returnedA.project.directorLookDraft, draftA);
assert.equal(returnedA.project.directorLookRequirement, projectA.directorLookRequirement);
assert.equal(returnedA.project.directorSettingsConfirmedFingerprint, projectA.directorSettingsConfirmedFingerprint);
assert.equal(returnedA.project.directorSettingsConfirmedAt, projectA.directorSettingsConfirmedAt);

const edited = roundTrip({
  ...returnedA,
  project: { ...returnedA.project, directorLookDraft: draftFor('A修改后') },
});
assert.deepEqual(edited.project.directorLookDraft, draftFor('A修改后'));
assert.deepEqual(edited.projects.find((project) => project.id === 'B')!.directorLookDraft, draftB);
assert.equal(edited.project.directorLookRequirement, projectA.directorLookRequirement);
assert.equal(edited.project.directorSettingsConfirmedFingerprint, projectA.directorSettingsConfirmedFingerprint,
  'a draft edit must not silently confirm generation settings');

// A single-project .lhvd export uses this serialization envelope; imports then
// normalize and merge it without replacing machine-global settings.
const exported = serializeStateForStorage({
  ...edited, projects: [edited.project], activeProjectId: edited.project.id,
}).serialized;
const imported = normalizeState(JSON.parse(exported));
assert.deepEqual(imported.project.directorLookDraft, draftFor('A修改后'));
assert.equal(imported.projects.length, 1, 'a project export must not import another project\'s draft');
const destination = stateFor(projectFor('destination', draftB));
const merged = mergeImportedProjectState(destination, imported);
assert.strictEqual(merged.settings, destination.settings);
const importedReloaded = roundTrip(merged);
assert.equal(importedReloaded.project.id, 'A');
assert.deepEqual(importedReloaded.project.directorLookDraft, draftFor('A修改后'));
assert.deepEqual(importedReloaded.projects.find((project) => project.id === 'destination')!.directorLookDraft, draftB);

const legacyProject = projectFor('legacy');
delete legacyProject.directorLookDraft;
const legacyReloaded = roundTrip(stateFor(legacyProject, projectA));
assert.equal(Object.hasOwn(legacyReloaded.project, 'directorLookDraft'), false,
  'a legacy project remains draft-free instead of inheriting another project\'s editor choices');
assert.equal(legacyReloaded.project.directorLookRequirement, legacyProject.directorLookRequirement);
assert.equal(legacyReloaded.project.directorSettingsConfirmedFingerprint, legacyProject.directorSettingsConfirmedFingerprint);
assert.deepEqual(legacyReloaded.projects.find((project) => project.id === 'A')!.directorLookDraft, draftA);

const unknownRaw = stateFor(projectFor('whitelist', draftFor('A')));
(unknownRaw.project.directorLookDraft as unknown as Record<string, unknown>).unknown = { nested: 'discard' };
const cleaned = roundTrip(normalizeState(unknownRaw));
assert.deepEqual(Object.keys(cleaned.project.directorLookDraft!).sort(), Object.keys(emptyDraft).sort());
assert.equal(cleaned.project.directorLookDraft!.directorStyleSummary, draftA.directorStyleSummary);

console.log('Director look draft storage: exact six-field snapshots, empty values, malformed data, project switching, export/import and legacy isolation passed.');
