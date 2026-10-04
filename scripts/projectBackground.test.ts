import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import { openProjectWorkspace, setProjectBackgroundSuspended } from '../src/projectBackground';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, Project, VideoGenerationTask } from '../src/types';

const initial = createInitialState();
const projectFor = (id: string, suspended?: boolean): Project => ({
  ...initial.project, id, name: id, updatedAt: 1,
  backgroundSuspended: suspended,
  sourceDocuments: [], characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [],
  generationTasks: [], assets: [],
});
const stateFor = (project = projectFor('visible'), archived = projectFor('other')): AppState => ({
  ...initial, project, projects: [project, archived], activeProjectId: project.id,
});
const roundTrip = (state: AppState): AppState => normalizeState(JSON.parse(serializeStateForStorage(state).serialized));

test('marking the current project changes only its workspace marker and timestamp', () => {
  const current = stateFor();
  const before = JSON.stringify(current);
  const next = setProjectBackgroundSuspended(current, current.project.id, true, 20);
  assert.equal(next.project.backgroundSuspended, true);
  assert.equal(next.project.updatedAt, 20);
  assert.equal(next.project, next.projects[0]);
  assert.equal(next.activeProjectId, current.activeProjectId, 'marking alone does not switch the editor');
  assert.equal(next.project.generationTasks, current.project.generationTasks);
  assert.equal(next.project.assets, current.project.assets);
  assert.equal(next.projects[1], current.projects[1]);
  assert.equal(next.settings, current.settings);
  assert.equal(JSON.stringify(current), before);
});

test('marking an archived project preserves the visible owner and latest task/media references', () => {
  const current = stateFor();
  const next = setProjectBackgroundSuspended(current, 'other', true, 21);
  assert.equal(next.project, current.project);
  assert.equal(next.projects[0], current.projects[0]);
  assert.equal(next.projects[1].backgroundSuspended, true);
  assert.equal(next.projects[1].generationTasks, current.projects[1].generationTasks);
  assert.equal(next.projects[1].assets, current.projects[1].assets);
  assert.equal(next.projects[1].updatedAt, 21);
});

test('repeated actions, empty IDs, and missing projects are no-ops', () => {
  const current = stateFor(projectFor('visible', true));
  assert.equal(setProjectBackgroundSuspended(current, 'visible', true, 50), current);
  assert.equal(setProjectBackgroundSuspended(current, 'other', false, 50), current);
  assert.equal(setProjectBackgroundSuspended(current, '', true), current);
  assert.equal(setProjectBackgroundSuspended(current, 'deleted', true), current);
  assert.equal(openProjectWorkspace(current, 'deleted'), current);
  assert.equal(openProjectWorkspace(current, ''), current);
});

test('current project wins over a stale library mirror without dropping new results', () => {
  const current = stateFor();
  const latestTasks = [{ id: 'latest-task', kind: 'video', status: 'running' }] as VideoGenerationTask[];
  current.project = { ...current.project, generationTasks: latestTasks, description: 'latest draft' };
  const next = setProjectBackgroundSuspended(current, 'visible', true, 25);
  assert.equal(next.project.generationTasks, latestTasks);
  assert.equal(next.projects[0], next.project);
  assert.equal(next.project.description, 'latest draft');
});

test('opening a marked project clears only its marker and retains the outgoing project', () => {
  const current = stateFor(projectFor('visible', true), projectFor('other', true));
  const next = openProjectWorkspace(current, 'other', 30);
  assert.equal(next.activeProjectId, 'other');
  assert.equal(next.project.id, 'other');
  assert.equal(next.project.backgroundSuspended, false);
  assert.equal(next.project.updatedAt, 30);
  assert.equal(next.project.generationTasks, current.projects[1].generationTasks);
  assert.equal(next.project.assets, current.projects[1].assets);
  assert.equal(next.projects[0], current.project);
  assert.equal(next.projects[0].backgroundSuspended, true);
  assert.equal(next.project, next.projects[1]);
});

test('opening the already visible marked project clears its marker without resetting project content', () => {
  const current = stateFor(projectFor('visible', true));
  const next = openProjectWorkspace(current, 'visible', 31);
  assert.equal(next.project.backgroundSuspended, false);
  assert.equal(next.project.generationTasks, current.project.generationTasks);
  assert.equal(next.project.storyboards, current.project.storyboards);
  assert.equal(next.activeProjectId, 'visible');
  assert.equal(openProjectWorkspace(next, 'visible', 99), next);
});

test('switching preserves fresh outgoing data even if the saved library mirror is stale or absent', () => {
  const current = stateFor();
  current.project = { ...current.project, description: 'new editor draft', backgroundSuspended: true };
  const next = openProjectWorkspace(current, 'other', 35);
  assert.equal(next.projects.find((project) => project.id === 'visible'), current.project);
  assert.equal(next.project, current.projects[1], 'an unmarked target need not be cloned or retimestamped');
  const withoutMirror = { ...current, projects: [current.projects[1]] };
  const opened = openProjectWorkspace(withoutMirror, 'other');
  assert.equal(opened.projects.find((project) => project.id === 'visible'), current.project);
});

test('background worker results remain owned after marking and switching, and survive reopening', () => {
  const current = stateFor();
  const marked = setProjectBackgroundSuspended(current, 'visible', true, 40);
  const switched = openProjectWorkspace(marked, 'other', 41);
  const tasks = [{ id: 'completed-in-background', kind: 'video', status: 'succeeded', resultAssetId: 'saved-video' }] as VideoGenerationTask[];
  const assets = [{ id: 'saved-video', name: 'saved in background', type: 'video' }] as Project['assets'];
  const settled = applyOwnedProjectUpdate(switched, 'visible', (project) => ({ ...project, generationTasks: tasks, assets }), 42);
  assert.equal(settled.project, switched.project);
  assert.equal(settled.projects.find((project) => project.id === 'visible')!.backgroundSuspended, true);
  const reopened = openProjectWorkspace(settled, 'visible', 43);
  assert.equal(reopened.project.backgroundSuspended, false);
  assert.equal(reopened.project.generationTasks, tasks);
  assert.equal(reopened.project.assets, assets);
  assert.equal(reopened.project.generationTasks[0].status, 'succeeded');
});

test('marking and reopening do not alter submission, tracking, queue, cancellation, or continuation metadata', () => {
  const current = stateFor();
  const tasks = ['draft', 'submitting', 'submitted', 'running', 'unknown', 'failed', 'succeeded'].map((status, index) => ({
    id: `task-${index}`, kind: 'video', status,
    videoJob: { stage: status === 'draft' ? 'preparing' : status, trackingStopped: false, batchQueueState: 'ready',
      cancellationPending: true, snapshot: { projectId: current.project.id },
      batchContinuation: { version: 1, planId: 'plan', taskId: 'child', batchId: 'next', revision: 1 } },
  })) as unknown as VideoGenerationTask[];
  current.project = { ...current.project, generationTasks: tasks };
  const before = JSON.stringify(tasks);
  const marked = setProjectBackgroundSuspended(current, current.project.id, true);
  const opened = openProjectWorkspace(marked, current.project.id);
  assert.equal(opened.project.generationTasks, tasks);
  assert.equal(JSON.stringify(tasks), before);
});

test('active and archived workspace markers survive serialization and normalization independently', () => {
  const current = stateFor(projectFor('visible', true), projectFor('other', true));
  const loaded = roundTrip(current);
  assert.equal(loaded.project.backgroundSuspended, true);
  assert.equal(loaded.projects.find((project) => project.id === 'other')!.backgroundSuspended, true);
  const opened = roundTrip(openProjectWorkspace(loaded, 'other', 51));
  assert.equal(opened.project.backgroundSuspended, false);
  assert.equal(opened.projects.find((project) => project.id === 'visible')!.backgroundSuspended, true);
});

test('old and malformed fields default to false and never inherit the active fallback marker', () => {
  for (const value of [undefined, null, 'true', 'false', 1, 0, {}, [], false]) {
    const current = stateFor(projectFor('visible', true), projectFor('other'));
    (current.projects[1] as unknown as Record<string, unknown>).backgroundSuspended = value;
    const loaded = normalizeState(current);
    assert.equal(loaded.project.backgroundSuspended, true);
    assert.equal(loaded.projects.find((project) => project.id === 'other')!.backgroundSuspended, false);
    (current.project as unknown as Record<string, unknown>).backgroundSuspended = value;
    assert.equal(normalizeState(current).project.backgroundSuspended, false);
  }
});
