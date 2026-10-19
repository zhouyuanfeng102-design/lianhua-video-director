import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { videoPromptExecutionForStoryboard } from '../src/videoPromptExecutionSelection';
import type { VideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import type { VideoGenerationSnapshot } from '../src/videoGenerationTypes';
import type { VideoGenerationTask } from '../src/types';

const state = createInitialState();
const { project, settings } = state;
project.id = 'selection-project'; project.activeChapterId = 'selection-chapter';
settings.videoSource = 'api'; settings.videoBackend = 'api';
settings.videoTaskApi = { ...settings.videoTaskApi, provider: 'rhtv_web', model: 'current-model', rhtvMode: 'reference' };
settings.videoApiProfiles = [{ ...settings.videoTaskApi, id: 'api-a', name: 'selected-api', createdAt: 1, updatedAt: 1 }];
const saved: VideoDirectorChapterDraft = {
  draft: { name: 'single', prompt: 'single prompt', backend: 'api', references: [], parameters: {}, apiProfileId: 'api-a', workflowId: 'wf-a' },
  parameterText: '{"rhtv_mode":"first"}', parameterDrafts: [], generationMode: 'batch',
  batch: { planId: 'batch-plan', backend: 'api', workflowId: 'wf-a', apiProfileId: 'api-a', parameterText: '',
    parameterDrafts: [], selectedKeys: [], languages: {}, referenceOverrides: {}, referenceRoleOverrides: {}, automaticTails: {}, tailCharacterModes: {},
    previewSegmentId: '', previewPane: 'prompt', settingsCollapsed: false, query: '' },
};
const save = () => { project.chapterWorkspaces = { 'selection-chapter': { videoDirector: structuredClone(saved) } }; };
const read = (planId: string) => videoPromptExecutionForStoryboard(project, settings, undefined,
  { chapterId: 'selection-chapter', sequencePlanId: planId });
let count = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++count} ${name}`); };

test('matching batch keeps blank parameter text instead of borrowing the single-segment mode', () => {
  save();
  assert.equal(read('batch-plan').generationMode, 'reference');
  assert.equal(saved.parameterText, '{"rhtv_mode":"first"}');
});

test('an unrelated plan keeps the saved single-segment selection and its parameters', () => {
  save();
  assert.equal(read('unrelated-plan').generationMode, 'first');
});

test('frozen connection is reused only for the same project and complete destination identity', () => {
  saved.generationMode = 'single'; saved.draft.reuseTaskId = 'frozen-task'; save();
  const snapshot: VideoGenerationSnapshot = { projectId: project.id, draft: structuredClone(saved.draft),
    connection: { backend: 'api', api: { ...settings.videoTaskApi, model: 'frozen-model' } }, images: [], clientId: 'fixture' };
  const task: VideoGenerationTask = { id: 'frozen-task', kind: 'video', storyboardId: '', targetId: '', status: 'failed',
    requestBody: {}, createdAt: 1, updatedAt: 1, videoJob: { stage: 'failed', snapshot } };
  project.generationTasks = [task];
  assert.equal(read('unrelated-plan').model, 'frozen-model');
  const changes: Array<(value: VideoGenerationSnapshot) => void> = [
    (value) => { value.projectId = 'another-project'; },
    (value) => { value.connection.backend = 'comfyui'; },
    (value) => { value.draft.workflowId = 'another-workflow'; },
    (value) => { value.draft.apiProfileId = 'another-api'; },
    (value) => { value.draft.runningHubWorkflowId = 'another-cloud-workflow'; },
  ];
  for (const change of changes) {
    const changed = structuredClone(snapshot); change(changed);
    task.videoJob = { stage: 'failed', snapshot: changed };
    assert.equal(read('unrelated-plan').model, 'current-model');
  }
  task.videoJob = { stage: 'failed', snapshot };
  assert.equal(read('unrelated-plan').model, 'frozen-model');
});

console.log(`video prompt execution selection: ${count} groups passed`);
