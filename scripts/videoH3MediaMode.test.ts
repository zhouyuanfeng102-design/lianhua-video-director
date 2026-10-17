import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { videoH3MediaModeContract, videoH3MediaModeIssue, refreshVideoH3MediaModeDraft } from '../src/videoH3MediaMode';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { videoBatchTailReferences } from '../src/videoBatch';
import { readExistingH3PromptProtocol, readH3PromptProtocol } from '../src/h3PromptProtocol';
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
assert.equal(contract.mode, 'full-reference'); assert.match(videoH3MediaModeIssue(contract)!, /可直接生成/u);
const mismatch = prepareVideoH3ReferenceDraft(project, draft, context);
assert.equal(mismatch.issue, undefined, 'a reference-mode warning does not block generation');
assert.ok(mismatch.warnings.some((warning) => /可直接生成/u.test(warning)));
assert.equal(prepareVideoH3ReferenceDraft(project, { ...draft, reuseTaskId: 'frozen-history' }, context).issue, undefined, 'old retries retain their snapshot');

const before = structuredClone({ draft, project }); let calls = 0;
const legacyUpdated = await refreshVideoH3MediaModeDraft({ project, draft, context, request: async () => {
  calls++; return JSON.stringify({ h3Prompt: rewritten });
} });
assert.equal(calls, 0, 'unknown legacy identities do not trigger an AI rewrite');
assert.equal(legacyUpdated.prompt, original); assert.equal(legacyUpdated.h3MediaModeUpdate, undefined);
assert.deepEqual({ draft, project }, before);
const identityA = 'Identity: A (S5), black hair and blue robe.';
const identityB = 'Identity: B, white robe.';
const trustedSource = original.replace('[Shot 1] ', `[Shot 1] ${identityA} ${identityB} `).replace('<d>', 'A (S5) shouts <d>');
const trustedProject = structuredClone(project);
trustedProject.characters = ['A', 'B'].map((name, index) => ({ id: name, name, assetIds: [`image-${index + 2}`], gender: '', race: '', apparentAge: '', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' }));
for (const [index, name] of ['A', 'B'].entries()) trustedProject.assets[index + 2].referenceEntityBinding = { kind: 'character', entityId: name };
// The two other pictures remain general references, without invented people.
const trustedDraft: VideoGenerationDraft = { ...draft, prompt: trustedSource,
  references: draft.references.map((reference, index) => index > 3 ? { ...reference, role: 'general' } : reference),
  h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: trustedSource, renderedPrompt: trustedSource,
    identities: { version: 1, characters: [
      { characterId: 'A', name: 'A', speakerToken: '(S5)', referenceAnchor: identityA },
      { characterId: 'B', name: 'B', referenceAnchor: identityB },
    ] } } };
const updated = await refreshVideoH3MediaModeDraft({ project: trustedProject, draft: trustedDraft, context, request: async () => {
  calls++; throw new Error('deterministic reference compilation must not call AI');
} });
assert.equal(calls, 0);
assert.equal(updated.h3MediaMode?.mode, 'full-reference'); assert.equal(updated.h3MediaMode?.authoredMode, 'full-reference');
assert.equal(updated.h3MediaModeUpdate?.sourcePrompt, trustedSource); assert.deepEqual(updated.parameters, draft.parameters);
assert.match(updated.prompt, /<Subject 1> is A \(S1\) referenced from <Picture 3>/u);
assert.match(updated.prompt, /<Subject 2> is B referenced from <Picture 4>/u);
assert.match(updated.prompt, /summary:\n\[reference generation\]/u);
assert.match(updated.prompt, /<Picture 1> is the opening composition reference/u);
assert.match(updated.prompt, /<Picture 2> is the ending composition reference/u);
assert.deepEqual(readExistingH3PromptProtocol(updated.prompt)?.shots, readExistingH3PromptProtocol(trustedSource)?.shots);
assert.deepEqual(updated.prompt.match(/<d>[\s\S]*?<\/d>/gu), trustedSource.match(/<d>[\s\S]*?<\/d>/gu));
assert.ok(updated.prompt.includes('runs toward <Subject 2> B and strikes once.'));
assert.ok(updated.prompt.includes('falls; the troops continue charging.'));
assert.equal(updated.prompt.slice(updated.prompt.indexOf('overall_soundscape:')), original.slice(original.indexOf('overall_soundscape:')));
assert.equal(prepareVideoH3ReferenceDraft(trustedProject, updated, context).issue, undefined);
const untimedSource = 'integrated_multimodal_description:\n[Shot 1] A approaches B. <d>[Chinese] 前进！</d>\n[Shot 2] Continue from the previous shot. From 12.20 to 12.90 seconds, B raises a hand.\n[Shot 3] B lowers the hand and the troops keep charging.\noverall_soundscape: Footsteps.\nnon_diegetic_music: N/A';
for (const savedSource of [untimedSource, untimedSource.replace('[Shot 3] ', '[Shot 3] At 00:13.000 ')]) {
  const savedDraft: VideoGenerationDraft = { ...draft, prompt: savedSource, parameters: { ...draft.parameters, duration: 15 },
    h3ReferenceBinding: { ...draft.h3ReferenceBinding!, basePrompt: savedSource, renderedPrompt: savedSource } };
  const savedBefore = structuredClone(savedDraft);
  let savedCalls = 0;
  assert.equal(readH3PromptProtocol(savedSource), undefined);
  assert.equal(videoH3MediaModeContract(savedDraft, context).authoredMode, 'integrated');
  const savedUpdate = await refreshVideoH3MediaModeDraft({ project, draft: savedDraft, context, request: async () => {
    savedCalls++; throw new Error('legacy prose must not be rewritten');
  } });
  assert.equal(savedCalls, 0, 'saved untimed prose stays compatible without a reference-update request');
  assert.equal(savedUpdate.prompt, savedSource);
  assert.deepEqual(savedDraft, savedBefore, 'reference update does not mutate the saved input');
  assert.deepEqual(readExistingH3PromptProtocol(savedUpdate.prompt)!.shots, readExistingH3PromptProtocol(savedSource)!.shots);
  assert.equal(savedUpdate.h3MediaModeUpdate, undefined);
  assert.equal(prepareVideoH3ReferenceDraft(project, savedUpdate, context).issue, undefined);
  assert.equal(savedUpdate.prompt.slice(savedUpdate.prompt.indexOf('[Shot 1]')), savedSource.slice(savedSource.indexOf('[Shot 1]')),
    'the saved shot body, dialogue, action intervals and sound sections remain verbatim');
}
let malformedCalls = 0;
const unreadableSource = original.replace('At 00:02.500', 'At 00:02.5');
const recoveredSource = await refreshVideoH3MediaModeDraft({ project, draft: { ...draft, prompt: unreadableSource }, context,
  request: async () => { malformedCalls++; throw new Error('unreadable source stays compatible'); },
});
assert.equal(malformedCalls, 0, 'unreadable local shot syntax does not cause an AI request or rejection');
assert.equal(recoveredSource.prompt, unreadableSource);
assert.equal(recoveredSource.h3MediaModeUpdate, undefined);
const audioDraft: VideoGenerationDraft = { ...draft, references: [], audioReferences: [{ bindingId: '["audio-node","audio"]', assetId: 'voice-sample', slotIndex: 2,
  target: { kind: 'voiceover' }, retainMode: 'reference', notes: 'Keep the existing words.' }] };
const audioProject = { ...project, assets: [...project.assets, { id: 'voice-sample', name: 'Confirmed narrator sample', type: 'audio', role: 'audio', mediaType: 'audio', tags: [], createdAt: 1, updatedAt: 1 } as ReferenceAsset] };
assert.equal(videoH3MediaModeContract(audioDraft, context).mode, 'full-reference', 'real selected audio requires full-reference even without pictures');
assert.match(videoH3MediaModeIssue(videoH3MediaModeContract(audioDraft, context))!, /音频/u);
let audioCalls = 0;
const audioUpdated = await refreshVideoH3MediaModeDraft({ project: audioProject, draft: audioDraft, context, request: async () => {
  audioCalls++; throw new Error('reference update must not invent audio prose');
} });
assert.equal(audioCalls, 0);
assert.equal(audioUpdated.h3MediaMode?.mode, 'full-reference');
assert.equal(audioUpdated.h3MediaMode?.authoredMode, 'integrated', 'unknown legacy cast is kept rather than guessed');
assert.deepEqual(audioUpdated.audioReferences, audioDraft.audioReferences);
assert.equal(audioUpdated.prompt, original); assert.doesNotMatch(audioUpdated.prompt, /<Audio /u);
const mappedApi: VideoTaskApiConfig = { ...api, provider: 'runninghub', runningHubImageRoles: draft.references.map((reference) => reference.role),
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'prompt', fieldName: 'value', fieldValue: '' }] }),
  runningHubMappedFields: draft.references.map((_, imageIndex) => ({ nodeId: `image-${imageIndex}`, fieldName: 'image', kind: 'image', imageIndex })) };
const mappedContext = { backend: 'api' as const, api: mappedApi };
const mappedIdentity = videoH3MediaModeContract(updated, mappedContext).inputIdentity;
const mappedUpdated = { ...updated, h3MediaModeUpdate: { ...updated.h3MediaModeUpdate!, inputIdentity: mappedIdentity } };
assert.equal(prepareVideoH3ReferenceDraft(trustedProject, mappedUpdated, mappedContext).issue, undefined);
const changedMapping = { ...mappedApi, runningHubMappedFields: mappedApi.runningHubMappedFields!.map((field, index) =>
  index === 0 ? { ...field, nodeId: 'another-image-input' } : field) };
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: changedMapping }).inputIdentity, mappedIdentity);
const changedMappingDraft = prepareVideoH3ReferenceDraft(trustedProject, mappedUpdated, { backend: 'api', api: changedMapping });
assert.equal(changedMappingDraft.issue, undefined, 'changed reference wiring remains a warning rather than a content gate');
assert.ok(changedMappingDraft.warnings.some((warning) => /映射已变化，可直接使用当前稿生成/u.test(warning)));
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: { ...mappedApi, runningHubImageRoles: ['scene', ...mappedApi.runningHubImageRoles!.slice(1)] } }).inputIdentity, mappedIdentity);
assert.notEqual(videoH3MediaModeContract(updated, { backend: 'api', api: { ...mappedApi, requestTemplate: '{"changed":true}' } }).inputIdentity, mappedIdentity);
const parameterTemplateApi = { ...mappedApi,
  runningHubMappedFields: [...mappedApi.runningHubMappedFields!, { nodeId: 'steps', fieldName: 'value', kind: 'parameter' as const, parameter: 'steps' }],
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'steps', fieldName: 'value', fieldValue: 10 }] }) };
assert.equal(videoH3MediaModeContract(updated, { backend: 'api', api: parameterTemplateApi }).inputIdentity,
  videoH3MediaModeContract(updated, { backend: 'api', api: { ...parameterTemplateApi,
    requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'steps', fieldName: 'value', fieldValue: 12 }] }) } }).inputIdentity,
  'normal task parameter overrides do not invalidate image protocol updates');
let unexpectedCalls = 0;
const noAiRewrite = await refreshVideoH3MediaModeDraft({ project: trustedProject, draft: trustedDraft, context, request: async () => {
  unexpectedCalls++; return JSON.stringify({ h3Prompt: rewritten.replace('前进！', '快跑！').replace('Footsteps.', 'Wind.').replace('00:02.500', '00:03.000') });
} });
assert.equal(unexpectedCalls, 0, 'reference compilation does not request a candidate, review or retry');
assert.equal(noAiRewrite.prompt, updated.prompt);
assert.ok(noAiRewrite.prompt.includes('<d>[Chinese] 前进！</d>'));
assert.ok(noAiRewrite.prompt.includes('At 00:02.500'));
assert.ok(noAiRewrite.prompt.includes('overall_soundscape: Footsteps.'));
const pendingDraft = { ...draft, references: [{ assetId: '__future_tail_binding__', role: 'first-frame' as const }, ...draft.references.slice(2)] };
const pending = await refreshVideoH3MediaModeDraft({ project, draft: pendingDraft, context,
  request: async () => JSON.stringify({ h3Prompt: rewritten, identityBindings: { version: 1, characters: [] } }) });
const resolvedPending = prepareVideoH3ReferenceDraft(project, { ...pending,
  references: videoBatchTailReferences(draft.references.slice(2), { mode: 'prepend', index: 0, role: 'first-frame' }, 'actual-reserved-tail') }, context);
assert.equal(resolvedPending.issue, undefined);
assert.match(resolvedPending.draft.prompt, /<Picture 1> opening composition reference/u, 'future-tail provenance resolves by its explicitly reserved slot');
const manuallyChanged = await refreshVideoH3MediaModeDraft({ project, draft: { ...draft, prompt: original.replace('strikes once', 'turns away') }, context,
  request: async () => JSON.stringify({ h3Prompt: rewritten.replace('strikes once', 'turns away') }) });
assert.equal(manuallyChanged.prompt, original.replace('strikes once', 'turns away'));
assert.equal(manuallyChanged.h3MediaModeUpdate, undefined, 'stale binding cannot claim an edited prompt came from the old saved artifact');

let state = createInitialState(); state.project = structuredClone(project); state.projects = []; state.settings.videoTaskApi = api;
state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 2;
let posts = 0;
const submittedPrompts: string[] = [];
const desktop = { videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
  if (request.method === 'POST') {
    posts++; submittedPrompts.push(JSON.parse(request.body || '{}').prompt);
    return { status: 200, body: JSON.stringify({ id: `mode-remote-${posts}`, status: 'queued' }) };
  }
  return { status: 200, body: JSON.stringify({ status: 'processing' }) };
}, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined } as unknown as VideoGenerationDesktop;
const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop,
  onRuntime: () => undefined, persistState: async () => {}, pollIntervalMs: 100000 });
try {
  const generationDraft: VideoGenerationDraft = { ...draft,
    references: draft.references.map((reference) => ({ ...reference, role: 'character' as const })) };
  const taskId = await engine.start(generationDraft);
  const task = state.project.generationTasks.find((item) => item.id === taskId)! as VideoGenerationTask;
  assert.equal(task.videoJob?.snapshot.draft.h3MediaMode?.mode, 'full-reference');
  assert.equal(task.videoJob?.snapshot.draft.h3MediaMode?.authoredMode, 'integrated');
  assert.equal(task.videoJob?.snapshot.draft.prompt, original, 'single generation retains the selected three-field body');
  assert.deepEqual(task.videoJob?.snapshot.draft.references, generationDraft.references);
  assert.equal(task.videoJob?.snapshot.draft.h3MediaModeUpdate, undefined, 'generation does not require an AI reference update');
  assert.equal(task.videoJob?.snapshot.connection.api?.model, api.model);
  assert.equal(task.videoJob?.snapshot.draft.parameters.steps, 12);
  assert.equal(task.videoJob?.snapshot.draft.parameters.seed, 42); assert.equal(posts, 1);
  const batchDraft = { ...generationDraft, name: '三字段多参考批量', parameters: { ...generationDraft.parameters, seed: 43 } };
  const batch = await engine.startBatch({ projectId: state.project.id, label: '参考提醒不阻止批量',
    items: [{ itemKey: 'mode-batch:en', draft: batchDraft }] });
  assert.equal(batch.taskIds.length, 1); assert.deepEqual(batch.skipped, []);
  for (let attempt = 0; attempt < 200 && !state.project.generationTasks.find((item) => item.id === batch.taskIds[0])?.remoteTaskId; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(posts, 2, 'the batch reaches the mocked provider with the original three-field body');
  const batchTask = state.project.generationTasks.find((item) => item.id === batch.taskIds[0])! as VideoGenerationTask;
  assert.ok(batchTask.remoteTaskId, 'the batch mock submission response is attached to its task');
  assert.equal(batchTask.videoJob?.snapshot.draft.prompt, original);
  assert.equal(batchTask.videoJob?.snapshot.draft.h3MediaMode?.authoredMode, 'integrated');
  assert.equal(batchTask.videoJob?.snapshot.draft.h3MediaModeUpdate, undefined);
  assert.deepEqual(batchTask.videoJob?.snapshot.draft.references, batchDraft.references);
  assert.deepEqual(batchTask.videoJob?.snapshot.draft.parameters, batchDraft.parameters);
  assert.deepEqual(submittedPrompts, [original, original], 'both mock requests use the selected body without AI or local rewriting');
} finally { engine.dispose(); }
console.log('PASS H3 deterministic reference compilation, zero AI calls, legacy source compatibility, frozen single/batch mock requests');
