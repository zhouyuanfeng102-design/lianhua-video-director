import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { videoH3MediaModeContract, videoH3MediaModeIssue, refreshVideoH3MediaModeDraft } from '../src/videoH3MediaMode';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { videoBatchTailReferences } from '../src/videoBatch';
import type { VideoGenerationDraft, VideoGenerationDesktop } from '../src/videoGenerationTypes';
import type { Project, ReferenceAsset, VideoTaskApiConfig, VideoGenerationTask } from '../src/types';

const original = 'integrated_multimodal_description:\n[Shot 1] A runs toward B and strikes once. <d>[Chinese] 前进！</d>\n[Shot 2] At 00:02.500 B falls; the troops continue charging.\noverall_soundscape: Footsteps.\nnon_diegetic_music: N/A';
const rewritten = 'subject_definitions:\n<Subject 1> is A from <Picture 3>. <Picture 1> is the opening composition. <Picture 2> is the ending composition.\nsummary:\n[reference generation + keyframe completion] The same charge.\nretention_analysis:\nPreserve the selected identities and composition references.\ndetailed_description:\n[Shot 1] A runs toward B and strikes once. <d>[Chinese] 前进！</d>\n[Shot 2] At 00:02.500 B falls; the troops continue charging.\noverall_soundscape: Footsteps.\nnon_diegetic_music: N/A';
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', model: 'mock-h3-workflow', apiKey: '',
  endpoint: 'https://media-mode.test.invalid/generate', statusEndpointTemplate: 'https://media-mode.test.invalid/task/{id}',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const context = { backend: 'api' as const, api };
const project: Project = createInitialState().project;
project.assets = Array.from({ length: 6 }, (_, index): ReferenceAsset => ({ id: `image-${index}`, name: `图${index + 1}`,
  role: index === 0 ? 'first-frame' : index === 1 ? 'last-frame' : 'character',
  type: index < 2 ? 'first-frame' : 'character', dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1 }));
project.characters = []; project.storyboards = []; project.generationTasks = []; project.locations = [];
const draft: VideoGenerationDraft = { name: '模式对照', prompt: original, backend: 'api',
  source: { promptFormat: 'h3', language: 'en' }, parameters: { duration: 5, seed: 42, steps: 12 },
  references: project.assets.map((asset) => ({ assetId: asset.id, role: asset.role })),
  h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: original, renderedPrompt: original, identities: { version: 1, characters: [] } } };

assert.equal(videoH3MediaModeContract({ ...draft, references: [] }, context).mode, 'base');
const keyframe = videoH3MediaModeContract({ ...draft, references: draft.references.slice(0, 2) }, context);
assert.equal(keyframe.mode, 'keyframe');
assert.equal(keyframe.boundarySemantics, 'composition-reference', 'generic slots do not prove hard frame conditioning');
assert.equal(videoH3MediaModeContract({ ...draft, references: draft.references.slice(0, 2) }, { backend: 'api', api: { ...api, provider: 'minimax' } }).boundarySemantics, 'explicit-keyframe-input');
const contract = videoH3MediaModeContract(draft, context);
assert.equal(contract.mode, 'full-reference'); assert.match(videoH3MediaModeIssue(contract)!, /格式不匹配/u);
assert.match(prepareVideoH3ReferenceDraft(project, draft, context).issue!, /格式不匹配/u);
assert.equal(prepareVideoH3ReferenceDraft(project, { ...draft, reuseTaskId: 'frozen-history' }, context).issue, undefined, 'old retries retain their snapshot');

const before = structuredClone({ draft, project }); let calls = 0;
const updated = await refreshVideoH3MediaModeDraft({ project, draft, context, request: async (system, user) => {
  calls++; assert.match(system, /不重新导演/u); assert.match(system, /普通多参考槽仅表示构图参考/u);
  const data = JSON.parse(user); assert.equal(data.actualReferences.length, 6);
  assert.equal(data.actualReferences[5].pictureNumber, 6); assert.equal(data.mode, 'full-reference');
  assert.equal(data.boundarySemantics, 'composition-reference');
  return JSON.stringify({ h3Prompt: rewritten, identityBindings: { version: 1, characters: [] } });
} });
assert.equal(calls, 1); assert.deepEqual({ draft, project }, before);
assert.equal(updated.h3MediaMode?.mode, 'full-reference'); assert.equal(updated.h3MediaMode?.authoredMode, 'full-reference');
assert.equal(updated.h3MediaModeUpdate?.sourcePrompt, original); assert.deepEqual(updated.parameters, draft.parameters);
assert.equal(prepareVideoH3ReferenceDraft(project, updated, context).issue, undefined);
const mappedApi: VideoTaskApiConfig = { ...api, provider: 'runninghub', runningHubImageRoles: draft.references.map((reference) => reference.role),
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'prompt', fieldName: 'value', fieldValue: '' }] }),
  runningHubMappedFields: draft.references.map((_, imageIndex) => ({ nodeId: `image-${imageIndex}`, fieldName: 'image', kind: 'image', imageIndex })) };
const mappedContext = { backend: 'api' as const, api: mappedApi };
const mappedIdentity = videoH3MediaModeContract(updated, mappedContext).inputIdentity;
const mappedUpdated = { ...updated, h3MediaModeUpdate: { ...updated.h3MediaModeUpdate!, inputIdentity: mappedIdentity } };
assert.equal(prepareVideoH3ReferenceDraft(project, mappedUpdated, mappedContext).issue, undefined);
const changedMapping = { ...mappedApi, runningHubMappedFields: mappedApi.runningHubMappedFields!.map((field, index) =>
  index === 0 ? { ...field, nodeId: 'another-image-input' } : field) };
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: changedMapping }).inputIdentity, mappedIdentity);
assert.match(prepareVideoH3ReferenceDraft(project, mappedUpdated, { backend: 'api', api: changedMapping }).issue!, /映射已变化/u);
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: { ...mappedApi, runningHubImageRoles: ['scene', ...mappedApi.runningHubImageRoles!.slice(1)] } }).inputIdentity, mappedIdentity);
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: { ...mappedApi, requestTemplate: '{"changed":true}' } }).inputIdentity, mappedIdentity);
const parameterTemplateApi = { ...mappedApi,
  runningHubMappedFields: [...mappedApi.runningHubMappedFields!, { nodeId: 'steps', fieldName: 'value', kind: 'parameter' as const, parameter: 'steps' }],
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'steps', fieldName: 'value', fieldValue: 10 }] }) };
assert.equal(videoH3MediaModeContract(updated, { backend: 'api', api: parameterTemplateApi }).inputIdentity,
  videoH3MediaModeContract(updated, { backend: 'api', api: { ...parameterTemplateApi,
    requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'steps', fieldName: 'value', fieldValue: 12 }] }) } }).inputIdentity,
  'normal task parameter overrides do not invalidate image protocol updates');
let invalidCalls = 0;
await assert.rejects(refreshVideoH3MediaModeDraft({ project, draft, context, request: async () => {
  invalidCalls++; return JSON.stringify({ h3Prompt: rewritten.replace('00:02.500', '00:03.000') });
} }), /原镜头切点/u);
assert.equal(invalidCalls, 1, 'invalid reference output never starts another review or retry');
await assert.rejects(refreshVideoH3MediaModeDraft({ project, draft, context, request: async () => JSON.stringify({ h3Prompt: rewritten.replace('前进！', '快跑！') }) }), /原对白/u);
const pendingDraft = { ...draft, references: [{ assetId: '__future_tail_binding__', role: 'first-frame' as const }, ...draft.references.slice(2)] };
const pending = await refreshVideoH3MediaModeDraft({ project, draft: pendingDraft, context,
  request: async () => JSON.stringify({ h3Prompt: rewritten, identityBindings: { version: 1, characters: [] } }) });
const resolvedPending = prepareVideoH3ReferenceDraft(project, { ...pending,
  references: videoBatchTailReferences(draft.references.slice(2), { mode: 'prepend', index: 0, role: 'first-frame' }, 'actual-reserved-tail') }, context);
assert.equal(resolvedPending.issue, undefined);
assert.match(resolvedPending.draft.prompt, /<Picture 1> is the opening composition/u, 'future-tail provenance resolves by its explicitly reserved slot');
const manuallyChanged = await refreshVideoH3MediaModeDraft({ project, draft: { ...draft, prompt: original.replace('strikes once', 'turns away') }, context,
  request: async () => JSON.stringify({ h3Prompt: rewritten.replace('strikes once', 'turns away') }) });
assert.equal(manuallyChanged.h3MediaModeUpdate?.sourcePrompt, original.replace('strikes once', 'turns away'), 'stale binding cannot claim an edited prompt came from the old saved artifact');

let state = createInitialState(); state.project = structuredClone(project); state.projects = []; state.settings.videoTaskApi = api;
let posts = 0;
const desktop = { videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
  if (request.method === 'POST') { posts++; return { status: 200, body: JSON.stringify({ id: 'mode-remote', status: 'queued' }) }; }
  return { status: 200, body: JSON.stringify({ status: 'processing' }) };
}, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined } as unknown as VideoGenerationDesktop;
const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop,
  onRuntime: () => undefined, pollIntervalMs: 100000 });
try {
  await assert.rejects(engine.start(draft), /格式不匹配/u); assert.equal(posts, 0, 'mode mismatch is resolved before a paid POST');
  const taskId = await engine.start(updated);
  const task = state.project.generationTasks.find((item) => item.id === taskId)! as VideoGenerationTask;
  assert.equal(task.videoJob?.snapshot.draft.h3MediaMode?.mode, 'full-reference');
  assert.equal(task.videoJob?.snapshot.connection.api?.model, api.model);
  assert.equal(task.videoJob?.snapshot.draft.parameters.steps, 12);
  assert.equal(task.videoJob?.snapshot.draft.parameters.seed, 42); assert.equal(posts, 1);
} finally { engine.dispose(); }
console.log('PASS H3 final-media mode: classification, one reference update, literal/time preservation, frozen history and mock task snapshot');
