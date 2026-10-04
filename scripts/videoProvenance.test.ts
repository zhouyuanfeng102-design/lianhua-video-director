import assert from 'node:assert/strict';
import { createInitialState, loadState, normalizeState, saveState, STORAGE_KEY } from '../src/storage';
import { draftFromVideoTask } from '../src/videoDirectorDraft';
import {
  findProjectVideoTask, findReusableVideoTask, findVideoAssetSourceTask, relatedVideoAssets,
  removeVideoTaskKeepingProvenance, snapshotVideoAssetSourceTask,
} from '../src/videoProvenance';
import type { ReferenceAsset, VideoGenerationTask } from '../src/types';

const state = createInitialState();
const project = state.project;
const asset = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'video', mediaType: 'video', role: 'motion', tags: [], createdAt: 10, updatedAt: 20, ...patch,
});
const workflowJson = '{\n  "312": {"class_type":"PrimitiveStringMultiline","inputs":{"value":"原提示词"}},\n  "321": {"class_type":"RandomNoise","inputs":{"noise_seed":123456789}}\n}';
const task: VideoGenerationTask = {
  id: 'video-task', kind: 'video', storyboardId: 'board-2', sequencePlanId: 'plan', segmentId: 'segment-2', segmentIndex: 2,
  targetId: '原始 H3', status: 'succeeded', remoteTaskId: 'remote-2', resultAssetId: 'video-2', resultUrl: 'https://video.example/clip-audio.mp4',
  requestBody: { prompt: '林澜：“别走，我有话要说。”', parameters: { seed: 42, nested: { cfg: 4 } } }, response: { status: 'Success' },
  createdAt: 100, updatedAt: 500,
  videoJob: {
    stage: 'succeeded', submittedAt: 110, startedAt: 130, generatedAt: 490, completedAt: 500,
    snapshot: {
      projectId: project.id, clientId: 'client-2',
      draft: {
        name: '第二段成片', prompt: '林澜：“别走，我有话要说。”', backend: 'comfyui', workflowId: 'h3',
        source: { storyboardId: 'board-2', sequencePlanId: 'plan', segmentId: 'segment-2', segmentIndex: 2, promptVersion: 'revision-2', language: 'zh', label: '长剧情 · 第2段' },
        references: [{ assetId: 'image-1', role: 'character' }, { assetId: 'image-2', role: 'composition' }],
        parameters: { seed: 42, nested: { cfg: 4 } },
      },
      connection: {
        backend: 'comfyui', comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188', activeWorkflowId: 'h3', promptPath: '/prompt' },
        workflow: { id: 'h3', name: '原始 H3', workflowJson, mapping: { prompt: [{ nodeId: '312', inputName: 'value' }], images: [{ nodeId: '335', inputName: 'image', role: 'character' }], outputNodeId: '328' }, createdAt: 1, updatedAt: 2 },
      },
      images: [
        { assetId: 'image-1', role: 'character', name: '角色旧图', fileName: 'old.png', relativePath: 'image/frozen-old.png', checksum: 'checksum-original' },
        { assetId: 'image-2', role: 'composition', name: '构图旧图', fileName: 'old-composition.png', relativePath: 'image/frozen-composition.png', checksum: 'checksum-composition' },
      ],
    },
  },
};
project.generationTasks = [task];
project.assets = [
  asset('video-2', { sourceVideoTaskId: task.id }),
  asset('unrelated-video', { sourceStoryboardId: 'board-3' }),
  asset('image-1', { type: 'reference', mediaType: 'image', role: 'character', sourceStoryboardId: 'board-2' }),
];
const before = JSON.stringify(project);
assert.equal(findProjectVideoTask(project, task.id), task);
assert.equal(findVideoAssetSourceTask(project, project.assets[0]), task, 'pre-upgrade video resolves its live source');
assert.deepEqual(relatedVideoAssets(project, 'board-2').map((item) => item.id), ['video-2'], 'only videos, not storyboard images, are linked');
const removed = removeVideoTaskKeepingProvenance(project, task.id);
assert.equal(removed.removed, true);
assert.equal(removed.blocked, false);
assert.equal(removed.project.generationTasks.length, 0, 'the deleted task is actually removed from the queue');
assert.equal(JSON.stringify(project), before, 'removal and backfill do not mutate the previous state');
assert.equal(removed.project.assets.length, 3, 'task removal never deletes the video or image assets');
assert.equal(removed.project.assets[1], project.assets[1], 'unrelated assets are untouched');
const archived = removed.project.assets[0];
const stored = archived.videoSourceTask!;
assert.deepEqual(stored, task, 'the video retains the complete terminal metadata and frozen generation inputs');
assert.notEqual(stored, task);
assert.notEqual(stored.videoJob!.snapshot.connection.workflow, task.videoJob!.snapshot.connection.workflow);
assert.equal(archived.sourceStoryboardId, 'board-2');
assert.equal(findVideoAssetSourceTask(removed.project, archived), stored);
assert.equal(findProjectVideoTask(removed.project, task.id), stored, 'original task ID continues to resolve through the asset without restoring a queue record');
assert.equal(findReusableVideoTask(removed.project, task.id), stored);
assert.deepEqual(relatedVideoAssets(removed.project, 'board-2').map((item) => item.id), ['video-2']);
const reused = draftFromVideoTask(findReusableVideoTask(removed.project, task.id)!)!;
assert.equal(reused.prompt, task.videoJob!.snapshot.draft.prompt);
assert.equal(reused.source?.promptVersion, 'revision-2');
assert.equal(reused.reuseTaskId, task.id);
assert.deepEqual(reused.references.map((reference) => reference.role), ['character', 'composition']);
assert.deepEqual(reused.parameters, { seed: 42, nested: { cfg: 4 } });
reused.references[0].role = 'style';
(reused.parameters.nested as { cfg: number }).cfg = 99;
assert.equal(stored.videoJob!.snapshot.draft.references[0].role, 'character');
assert.equal((stored.videoJob!.snapshot.draft.parameters.nested as { cfg: number }).cfg, 4);
const redundantRemoval = removeVideoTaskKeepingProvenance(removed.project, task.id);
assert.equal(redundantRemoval.project, removed.project);
assert.equal(redundantRemoval.removed, false);
const blocked = removeVideoTaskKeepingProvenance({ ...project, generationTasks: [{ ...task, status: 'submitting' }] }, task.id);
assert.equal(blocked.blocked, true);
assert.equal(blocked.project.assets[0].videoSourceTask, undefined, 'an in-flight blocked deletion does not freeze a stale partial asset record');
const otherProject = { ...removed.project, id: 'different-project' };
assert.equal(findProjectVideoTask(otherProject, task.id), undefined, 'a foreign project cannot reuse the source task or credential scope');
assert.equal(findVideoAssetSourceTask(otherProject, archived), undefined);
assert.equal(findReusableVideoTask(otherProject, task.id), undefined);
assert.deepEqual(relatedVideoAssets(otherProject, 'board-2'), [], 'foreign embedded provenance cannot link a coincidentally matching storyboard ID');

const selfContained = snapshotVideoAssetSourceTask(task);
selfContained.videoJob!.snapshot.images[0].name = '快照副本修改';
selfContained.videoJob!.snapshot.connection.workflow!.mapping.images[0].role = 'style';
assert.equal(task.videoJob!.snapshot.images[0].name, '角色旧图');
assert.equal(task.videoJob!.snapshot.connection.workflow!.mapping.images[0].role, 'character');
assert.equal(selfContained.videoJob!.snapshot.connection.workflow!.workflowJson, workflowJson, 'no JSON formatting change alters normal saved connection/workflow inputs');

const legacyTask: VideoGenerationTask = { ...task, id: 'legacy-task', videoJob: undefined, resultAssetId: 'legacy-video' };
const legacyProject = { ...project, generationTasks: [legacyTask], assets: [asset('legacy-video')] };
const legacyRemoved = removeVideoTaskKeepingProvenance(legacyProject, legacyTask.id).project;
assert.equal(legacyRemoved.assets[0].videoSourceTask?.id, legacyTask.id, 'old resultAssetId-only association is preserved');
assert.equal(findReusableVideoTask(legacyRemoved, legacyTask.id), undefined, 'missing historical parameters are not invented');
assert.equal(findVideoAssetSourceTask(legacyRemoved, legacyRemoved.assets[0])?.storyboardId, 'board-2');
const incomplete = snapshotVideoAssetSourceTask(task);
incomplete.videoJob!.legacyMetadataIncomplete = true;
const incompleteProject = { ...project, generationTasks: [], assets: [asset('incomplete-video', { sourceVideoTaskId: incomplete.id, videoSourceTask: incomplete })] };
assert.equal(findReusableVideoTask(incompleteProject, incomplete.id), undefined);
assert.equal(draftFromVideoTask(incomplete), undefined, 'legacyMetadataIncomplete still disables exact-setting reuse');
assert.equal(findVideoAssetSourceTask({ ...project, generationTasks: [] }, asset('untracked-video')), undefined);

const malicious = JSON.parse(JSON.stringify(task));
malicious.apiKey = 'TOP-LEVEL-KEY';
malicious.videoJob.snapshot.connection.comfyui.apiKey = 'CONNECTION-KEY';
malicious.videoJob.snapshot.connection.workflow.workflowJson = JSON.stringify({ node: { inputs: { api_key: 'WORKFLOW-KEY', seed: 123 } } });
malicious.videoJob.snapshot.connection.api = { requestTemplate: JSON.stringify({ api_token: 'TEMPLATE-KEY', prompt: '{{prompt}}' }) };
malicious.response = { authorization: 'RESPONSE-KEY', data: { client_secret: 'CLIENT-KEY', status: 'succeeded' } };
const safe = snapshotVideoAssetSourceTask(malicious);
assert.ok(!JSON.stringify(safe).includes('-KEY'), 'the new provenance copy does not introduce credentials into assets or exports');
assert.equal(JSON.parse(safe.videoJob!.snapshot.connection.workflow!.workflowJson).node.inputs.seed, 123);
assert.equal(safe.videoJob!.snapshot.draft.prompt, task.videoJob!.snapshot.draft.prompt, 'credential stripping never rewrites dialogue or prompt prose');

// Normalization and the existing secret-free browser export/save path retain the asset-owned source.
const savedState = { ...state, project: removed.project, projects: state.projects.map((item) => item.id === project.id ? removed.project : item) };
const normalized = normalizeState(JSON.parse(JSON.stringify(savedState)));
assert.deepEqual(normalized.project.assets[0].videoSourceTask, stored);
assert.equal(normalized.project.generationTasks.length, 0, 'load must not resurrect deleted generation records');
const localStore = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = { localStorage: {
  getItem: (key: string) => localStore.get(key) ?? null,
  setItem: (key: string, value: string) => { localStore.set(key, value); },
} };
assert.equal(await saveState(savedState), true);
assert.ok(localStore.get(STORAGE_KEY));
const reopened = loadState();
assert.deepEqual(findProjectVideoTask(reopened.project, task.id)?.videoJob!.snapshot.images, task.videoJob!.snapshot.images);
assert.equal(findReusableVideoTask(reopened.project, task.id)?.videoJob!.snapshot.draft.source?.promptVersion, 'revision-2');
assert.equal(reopened.project.generationTasks.length, 0);
delete (globalThis as unknown as { window?: unknown }).window;
console.log('videoProvenance: deletion, frozen source/parameters, project ownership, legacy compatibility and save/load tests passed');
