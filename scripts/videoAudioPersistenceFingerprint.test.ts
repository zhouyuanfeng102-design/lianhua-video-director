import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { readVideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import { videoBatchReferenceFingerprint, videoBatchRequestFingerprint, videoTaskRequestFingerprint } from '../src/videoBatch';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationDraft, VideoGenerationSnapshot } from '../src/videoGenerationTypes';
import type { FrozenVideoAudioReference, VideoAudioReference } from '../src/videoAudioTypes';

const state = createInitialState();
const base: VideoGenerationDraft = { name: '音频保存测试', prompt: '甲人物说：出发。', backend: 'api', references: [], parameters: {} };
const genericConnection = { backend: 'api', api: { provider: 'generic', model: 'qa' } };
assert.equal(videoBatchRequestFingerprint(base, [], genericConnection), 'video-request-v1-df8ebeac2a1ae688', 'legacy image-only request identity stays byte-for-byte stable');
assert.equal(videoBatchReferenceFingerprint(base, []), 'video-reference-v1-09612b07b5ecb5a5', 'legacy image-only reference identity stays stable');
assert.equal(videoBatchRequestFingerprint({ ...base, audioReferences: [], audioSelectionMode: 'none' }, [], genericConnection), videoBatchRequestFingerprint(base, [], genericConnection), 'zero audio adds no manifest');

const refs: VideoAudioReference[] = [
  { assetId: 'audio-a', bindingId: '["201","audio"]', slotIndex: 0, target: { kind: 'character', characterId: 'person-a' }, retainMode: 'reference', notes: '本段台词' },
  { assetId: 'audio-b', bindingId: '["203","audio"]', slotIndex: 2, target: { kind: 'ambience' }, retainMode: 'weak_reference' },
];
const assets: ReferenceAsset[] = refs.map((ref, index) => ({ id: ref.assetId, name: ref.assetId, type: 'audio', role: 'audio', mediaType: 'audio',
  mimeType: 'audio/wav', checksum: String(index ? 'b' : 'a').repeat(64), dataUrl: `data:audio/wav;base64,${index ? 'Qg==' : 'QQ=='}`, tags: [], createdAt: 1, updatedAt: 1 }));
const audios: FrozenVideoAudioReference[] = refs.map((ref, index) => ({ ...ref, name: ref.assetId, fileName: `${ref.assetId}.wav`,
  relativePath: `audio/${assets[index].checksum}.wav`, checksum: assets[index].checksum, mimeType: 'audio/wav', durationSec: 2, freezeState: 'frozen', frozenAt: 123 }));
const draft: VideoGenerationDraft = { ...base, audioSelectionMode: 'override', audioReferences: structuredClone(refs),
  audioReferenceBinding: { version: 1, basePrompt: base.prompt, renderedPrompt: base.prompt } };
const snapshot: VideoGenerationSnapshot = { projectId: state.project.id, draft, images: [], audios, clientId: 'audio-save-client',
  connection: { backend: 'api', api: { ...state.settings.videoTaskApi, provider: 'runninghub', model: 'qa' } } };
const task = { id: 'audio-save-task', kind: 'video', name: draft.name, status: 'failed', model: 'qa', request: '', createdAt: 1, updatedAt: 1,
  videoJob: { stage: 'failed', snapshot, preparation: { version: 1, phase: 'preparing', uploadedImages: [], uploadedAudios: ['openapi/a.wav', null] } } } as VideoGenerationTask;
const chapterId = state.project.sourceDocuments[0].id;
const chapterDraft = { draft, parameterText: '{}', parameterDrafts: [], generationMode: 'batch', batch: {
  planId: 'audio-plan', backend: 'api', workflowId: '', apiProfileId: '', parameterText: '{}', parameterDrafts: [], selectedKeys: [], languages: {},
  referenceOverrides: {}, audioOverrides: { 'segment-a': { mode: 'override', references: refs }, 'segment-b': { mode: 'none', references: [] }, 'segment-c': { mode: 'project' } },
  referenceRoleOverrides: {}, automaticTails: {}, tailCharacterModes: {}, previewSegmentId: 'segment-a', previewPane: 'prompt', settingsCollapsed: true, query: '',
} };
state.project = { ...state.project, assets, voicePresets: { characters: { 'person-a': { assetId: 'audio-a', retainMode: 'partially_copy', notes: '保留人物的声线' } },
  narrator: { assetId: 'audio-b', retainMode: 'fully_copy' } }, chapterWorkspaces: { [chapterId]: { videoDirector: chapterDraft } }, generationTasks: [task] };
state.projects = [state.project];
const normalized = normalizeState(state);
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(normalized).serialized));
assert.deepEqual(reloaded.project.voicePresets, state.project.voicePresets, 'project character/narrator presets retain mode and notes');
assert.deepEqual(readVideoDirectorChapterDraft(reloaded.project.chapterWorkspaces?.[chapterId]?.videoDirector)?.batch?.audioOverrides, chapterDraft.batch.audioOverrides, 'chapter overrides and explicit none survive save/reload');
const restoredTask = reloaded.project.generationTasks[0] as VideoGenerationTask;
assert.deepEqual(restoredTask.videoJob?.snapshot.audios, audios, 'frozen audio checksum, path, slot gap, target, mode, state and frozen time survive');
assert.deepEqual(restoredTask.videoJob?.snapshot.draft.audioReferences, refs, 'draft role bindings survive');
assert.deepEqual(restoredTask.videoJob?.snapshot.draft.audioReferenceBinding, draft.audioReferenceBinding, 'task-only prompt binding survives');
assert.deepEqual(restoredTask.videoJob?.preparation, task.videoJob?.preparation, 'partial upload receipt slots remain intact');
assert.deepEqual(normalizeState(reloaded).project.voicePresets, reloaded.project.voicePresets, 'preset normalization is idempotent');

const raw = structuredClone(state) as AppState & { project: any };
raw.project.voicePresets = { characters: { 'person-a': { assetId: 'audio-a', retainMode: 'unknown' }, 'person-invalid': { assetId: 5 } }, narrator: 'invalid' };
const clean = normalizeState(raw).project.voicePresets!;
assert.deepEqual(clean, { characters: { 'person-a': { assetId: 'audio-a', retainMode: 'reference' } } }, 'malformed preset shape/mode safely normalizes');
const imported = normalizeState({ ...state, projects: [{ id: 'other-audio-project', name: '空声音配置', voicePresets: undefined, characters: [], assets: [] }] });
assert.equal(imported.projects.find((project) => project.id === 'other-audio-project')?.voicePresets, undefined, 'partial project import never inherits active voices');
const missingAsset = normalizeState({ ...state, project: { ...state.project, assets: [] } });
assert.deepEqual(missingAsset.project.voicePresets, state.project.voicePresets, 'missing assets keep explicit presets for review rather than silently clearing');

const connection = snapshot.connection;
const requestHash = (value: VideoGenerationDraft, media = assets) => videoBatchRequestFingerprint(value, media, connection);
const selectedHash = requestHash(draft);
for (const [label, patch] of [
  ['physical slot', { slotIndex: 1 }], ['mapping binding', { bindingId: '["202","audio"]' }], ['person/purpose', { target: { kind: 'voiceover' } }],
  ['mode', { retainMode: 'fully_copy' }], ['notes', { notes: '仅保留原声的一部分' }],
] as Array<[string, Partial<VideoAudioReference>]>) {
  assert.notEqual(requestHash({ ...draft, audioReferences: [{ ...refs[0], ...patch }, refs[1]] }), selectedHash, `${label} changes request identity`);
}
assert.notEqual(requestHash(draft, [{ ...assets[0], checksum: 'c'.repeat(64) }, assets[1]]), selectedHash, 'changed audio bytes change request identity');
const noChecksums = assets.map(({ checksum: _checksum, ...asset }) => asset);
assert.notEqual(requestHash(draft, noChecksums), requestHash(draft, [{ ...noChecksums[0], dataUrl: 'data:audio/wav;base64,Qw==' }, noChecksums[1]]), 'browser audio bytes are hashed without a checksum');
assert.notEqual(videoBatchReferenceFingerprint(draft, assets), videoBatchReferenceFingerprint(base, assets), 'audio participates in reference review identity');
assert.equal(requestHash({ ...draft, audioReferences: [...refs].reverse() }), selectedHash, 'array order does not renumber physical inputs');
assert.equal(videoTaskRequestFingerprint(task), selectedHash, 'snapshot uses equivalent frozen audio manifest');
const changedDraftOnly = structuredClone(task);
changedDraftOnly.videoJob!.snapshot.draft.audioReferences![0].retainMode = 'fully_copy';
assert.equal(videoTaskRequestFingerprint(changedDraftOnly), selectedHash, 'snapshot fingerprint authority is frozen audio metadata');
const changedFrozen = structuredClone(task);
changedFrozen.videoJob!.snapshot.audios![0].checksum = 'c'.repeat(64);
assert.notEqual(videoTaskRequestFingerprint(changedFrozen), selectedHash, 'frozen bytes change snapshot identity');
const durable = { ...changedFrozen, requestFingerprint: 'historical-durable-hash' };
assert.equal(videoTaskRequestFingerprint(durable), 'historical-durable-hash', 'stored historical task identity is never rewritten');
console.log('videoAudioPersistenceFingerprint: focused persistence/identity assertions passed');
