import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { resolveVideoExecutionLimit, videoTaskOccupiesGenerationSlot } from '../src/videoGenerationQueue';
import type { VideoGenerationTask } from '../src/types';

// Only isolated JSON round trips. No live project, network or generator.
const initial = createInitialState();
assert.equal(initial.settings.videoExecutionMode, 'queue');
assert.equal(resolveVideoExecutionLimit(initial.settings), 1);
for (const count of [1, 2, 3, 12, 100]) {
  const state = { ...initial, settings: { ...initial.settings, videoExecutionMode: 'concurrent' as const, videoExecutionConcurrency: count } };
  const loaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(loaded.settings.videoExecutionConcurrency, count);
  assert.equal(resolveVideoExecutionLimit(loaded.settings), count);
  const queued = normalizeState({ ...loaded, settings: { ...loaded.settings, videoExecutionMode: 'queue' } });
  assert.equal(queued.settings.videoExecutionConcurrency, count, 'queue mode retains the chosen parallel count for switching back');
  assert.equal(resolveVideoExecutionLimit(queued.settings), 1);
}
for (const value of [undefined, null, 0, -1, 101, 1.5, '3', {}, Infinity]) {
  const loaded = normalizeState({ ...initial, settings: { ...initial.settings, videoExecutionMode: 'concurrent', videoExecutionConcurrency: value } });
  assert.equal(resolveVideoExecutionLimit(loaded.settings), 1, 'malformed concurrency never opens extra generation slots');
}
const task: VideoGenerationTask = {
  id: 'remote-active', kind: 'video', targetId: 'mock', storyboardId: '', status: 'running', remoteTaskId: 'issued-id', requestBody: {}, createdAt: 1, updatedAt: 1,
  videoJob: { stage: 'running', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
    snapshot: { projectId: initial.project.id, clientId: 'fixture', images: [],
      draft: { name: 'fixture', prompt: 'immutable prompt', backend: 'api', references: [], parameters: {} },
      connection: { backend: 'api', api: { ...initial.settings.videoTaskApi } } } },
};
for (const value of [true, false, 'true', 1, null]) {
  const candidate = { ...task, videoJob: { ...task.videoJob, remoteGenerationEnded: value } };
  const project = { ...initial.project, generationTasks: [candidate] };
  const state = normalizeState({ ...initial, project, projects: [project] });
  const loaded = state.project.generationTasks[0] as VideoGenerationTask;
  assert.equal(loaded.videoJob?.remoteGenerationEnded, value === true ? true : undefined);
  assert.equal(videoTaskOccupiesGenerationSlot(loaded), value !== true);
  assert.equal(loaded.remoteTaskId, task.remoteTaskId);
}
console.log('Video execution settings: defaults, queue/concurrent 1–100, JSON persistence and literal remote terminal evidence passed.');
