import assert from 'node:assert/strict';
import { selectDirectorStoryboard, selectSingleDirectorStoryboard } from '../src/directorStoryboardSelection';
import type { Project, Storyboard } from '../src/types';

const board = (id: string, updatedAt: number, patch: Partial<Storyboard> = {}): Storyboard => ({ id, updatedAt, ...patch } as Storyboard);
const project: Pick<Project, 'storyboards' | 'sequencePlans'> = {
  storyboards: [board('segment-6', 60, { sequencePlanId: 'plan', segmentId: 's6', segmentIndex: 6 }),
    board('single-old', 10), board('single-new', 20), board('master', 90), board('sparse-segment', 80),
    board('orphan', 70, { sequencePlanId: 'deleted-plan', segmentIndex: 2 })],
  sequencePlans: [{ id: 'plan', masterStoryboardId: 'master', segments: [
    { id: 's6', storyboardId: 'segment-6' }, { id: 's7', storyboardId: 'sparse-segment' },
  ] }] as Project['sequencePlans'],
};
const before = JSON.stringify(project);
assert.equal(selectSingleDirectorStoryboard(project, 'segment-6')?.id, 'single-new', 'single mode chooses the latest standalone, never the latest segment or master');
assert.equal(selectSingleDirectorStoryboard(project, 'segment-6', 'single-old')?.id, 'single-old', 'remember the previous standalone selection while long-story work is selected');
assert.equal(selectSingleDirectorStoryboard(project, 'single-new', 'single-old')?.id, 'single-new', 'an explicitly selected standalone replaces its remembered selection');
assert.equal(selectSingleDirectorStoryboard(project, 'segment-6', 'deleted')?.id, 'single-new', 'deleted remembered work falls back to an existing standalone');
assert.equal(selectSingleDirectorStoryboard(project, 'sparse-segment', 'master')?.id, 'single-new', 'actual plan membership identifies older sparse records');
const onlySequence = { ...project, storyboards: project.storyboards.filter((entry) => !entry.id.startsWith('single-')) };
assert.equal(selectSingleDirectorStoryboard(onlySequence, 'segment-6'), undefined, 'the reported single-mode + selected sixth segment case is truly empty');
assert.equal(selectDirectorStoryboard(project, { mode: 'sequence', selectedId: 'single-old', sequenceStoryboardId: 'segment-6' })?.id, 'segment-6');
assert.equal(selectDirectorStoryboard(project, { mode: 'sequence', selectedId: 'single-old' }), undefined, 'an ungenerated segment never borrows a standalone result');
assert.equal(selectDirectorStoryboard(project, { mode: 'single', selectedId: 'segment-6', rememberedSingleId: 'single-old' })?.id, 'single-old');
assert.equal(selectDirectorStoryboard(project, { mode: 'single', selectedId: 'orphan', sourceStoryboardId: 'orphan' })?.id, 'orphan', 'an explicit historical source link still opens its exact original');
assert.equal(selectDirectorStoryboard(project, { mode: 'single', selectedId: 'single-new', sourceStoryboardId: 'orphan' })?.id, 'single-new', 'a previous source link never overrides a later selection');
const restoredControls = JSON.parse(JSON.stringify({ productionMode: 'single', activeStoryboardId: 'segment-6', activeSingleStoryboardId: 'single-old' }));
assert.equal(selectDirectorStoryboard(project, { mode: restoredControls.productionMode, selectedId: restoredControls.activeStoryboardId,
  rememberedSingleId: restoredControls.activeSingleStoryboardId })?.id, 'single-old', 'restored mode uses its own saved result');
assert.equal(JSON.stringify(project), before, 'selection never edits, deletes, or regenerates a saved artifact');
console.log('director storyboard selection: 13 focused checks passed');
