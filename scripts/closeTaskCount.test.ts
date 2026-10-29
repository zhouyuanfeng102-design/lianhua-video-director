import assert from 'node:assert/strict';
import test from 'node:test';
import { countOpenGenerationTasks } from '../src/closeTaskCount';
import { createInitialState } from '../src/storage';
import type { GenerationTask, VideoGenerationTask } from '../src/types';

const baseState = createInitialState();
const videoTask = (id: string, patch: Partial<VideoGenerationTask> = {}): VideoGenerationTask => ({
  id,
  kind: 'video',
  status: 'unknown',
  remoteTaskId: `remote-${id}`,
  requestFingerprint: `fingerprint-${id}`,
  storyboardId: 'storyboard',
  targetId: 'target',
  createdAt: 1,
  updatedAt: 2,
  requestBody: { prompt: 'fixture' },
  response: { status: 'pending' },
  videoJob: {
    stage: 'stopped',
    trackingStopped: true,
    cancellationPending: false,
    cancellationConfirmed: false,
    preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
    snapshot: {
      projectId: 'project-close-count',
      clientId: `client-${id}`,
      images: [],
      draft: { name: id, backend: 'api', prompt: 'fixture', references: [], parameters: {} },
      connection: { backend: 'api', api: { ...baseState.settings.videoTaskApi, endpoint: 'https://example.invalid/generate' } },
    },
  },
  ...patch,
});

const imageTask = (id: string, status: 'queued' | 'running'): GenerationTask => ({
  id,
  kind: 'image',
  status,
  name: id,
  createdAt: 1,
  updatedAt: 2,
  prompt: 'fixture',
  width: 1,
  height: 1,
} as GenerationTask);

const stateWithTasks = (...tasks: GenerationTask[]) => {
  const project = { ...baseState.project, id: 'project-close-count', generationTasks: tasks };
  return { project, projects: [project] };
};

test('locally stopped video tasks do not block app close', () => {
  const stopped = videoTask('stopped');
  const active = videoTask('active', { videoJob: { ...stopped.videoJob!, stage: 'running', trackingStopped: false } });
  assert.equal(countOpenGenerationTasks(stateWithTasks(stopped)), 0);
  assert.equal(countOpenGenerationTasks(stateWithTasks(stopped, active)), 1);
});

test('queued and running local image work still blocks app close', () => {
  assert.equal(countOpenGenerationTasks(stateWithTasks(imageTask('queued', 'queued'), imageTask('running', 'running'))), 2);
});
