/// <reference path="../src/vite-env.d.ts" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, normalizeState } from '../src/storage';
import type { AppState, Project, ReferenceAsset, VideoGenerationTask, VideoSegment, VideoSequencePlan } from '../src/types';
import type { WorkbenchExtractedFrame, WorkbenchFrameRequest, WorkbenchFrameResult, WorkbenchProgress, WorkbenchRenderRequest, WorkbenchRenderResult, WorkbenchVideoProbe } from '../src/videoWorkbenchTypes';
import { buildWorkbenchRenderRequest, createWorkbenchClip, emptyVideoWorkbenchDraft, frameReferenceRoleOverrides, frameWorkbenchAsset,
  normalizeVideoWorkbenchState, renderedWorkbenchAsset, sequenceWorkbenchAssets, videoWorkbenchDuration, workbenchSource,
  type VideoWorkbenchDraft, type VideoWorkbenchJob } from '../src/videoWorkbench';
import { VideoWorkbenchEngine } from '../src/useVideoWorkbenchController';

const probe: WorkbenchVideoProbe = { durationSec: 15, width: 1280, height: 720, fps: 30, frameCount: 450, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2 };
const checksum = (letter = 'a') => letter.repeat(64);
const video = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', relativePath: `video/${id}.mp4`,
  checksum: checksum(), durationSec: 15, width: 1280, height: 720, tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const segment = (index: number): VideoSegment => ({
  id: `seg-${index}`, index, title: `第${index}段`, globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15,
  content: `第${index}段剧情`, summary: `第${index}段摘要`, sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: `board-${index}`, status: 'ready',
});
const plan = (indices = [1, 2, 3]): VideoSequencePlan => ({
  id: 'plan', title: '长剧情计划', sourceStoryTitle: '原作', sourceStoryContent: '原作剧情', durationMode: 'ai-estimated', totalDurationSec: 45,
  segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', segments: indices.map(segment), createdAt: 1, updatedAt: 1,
});
const generatedVideo = (index: number, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => {
  const task: VideoGenerationTask = { id: `task-${index}`, kind: 'video', storyboardId: `board-${index}`, targetId: 'target', status: 'succeeded',
    requestBody: {}, sequencePlanId: 'plan', segmentId: `seg-${index}`, segmentIndex: index, createdAt: 1, updatedAt: 1 };
  return video(`video-${index}`, { videoSourceTask: task, sourceStoryboardId: task.storyboardId, ...patch });
};
const frame = (patch: Partial<WorkbenchExtractedFrame> = {}): WorkbenchExtractedFrame => ({
  fileName: '参考帧.png', relativePath: 'image/frame.png', checksum: checksum('f'), sizeBytes: 256, mediaType: 'image', mimeType: 'image/png',
  managed: true, missing: false, url: 'lianhua-asset://image/frame.png', timeSec: 14.966666667, frameIndex: 449, width: 1280, height: 720, role: 'last-frame', ...patch,
});
const renderResult = (): WorkbenchRenderResult => ({
  fileName: '剪辑成片.mp4', relativePath: 'video/output.mp4', checksum: checksum('e'), sizeBytes: 1024, mediaType: 'video', mimeType: 'video/mp4',
  managed: true, missing: false, url: 'lianhua-asset://video/output.mp4', probe: { ...probe }, renderMode: 'transcode',
});
const createProject = (id: string): Project => ({ ...structuredClone(createInitialState().project), id, name: id, assets: [video(`${id}-source`)], generationTasks: [], sequencePlans: [], videoWorkbench: undefined });
const editDraft = (project: Project): VideoWorkbenchDraft => ({ ...emptyVideoWorkbenchDraft(project.id, 1), clips: [createWorkbenchClip(project.assets[0], probe)] });
const savedJob = (patch: Partial<VideoWorkbenchJob> = {}): VideoWorkbenchJob => ({ id: 'saved-job', projectId: 'project-a', kind: 'extract', name: '历史抽帧',
  status: 'running', createdAt: 1, updatedAt: 1, resultAssetIds: [], sourceAssetId: 'project-a-source', sourceChecksum: checksum(), frameOptions: { mode: 'last' }, ...patch });
const deferred = <T>() => {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

type Bridge = NonNullable<ConstructorParameters<typeof VideoWorkbenchEngine>[0]['desktop']>;
function harness(overrides: Partial<Bridge> = {}, persist?: () => Promise<void>) {
  const a = createProject('project-a'); const b = createProject('project-b');
  let state: AppState = { ...createInitialState(), project: a, activeProjectId: a.id, projects: [a, b] };
  const calls = { extract: [] as WorkbenchFrameRequest[], render: [] as WorkbenchRenderRequest[], cancel: [] as string[], probe: [] as string[], notices: [] as string[] };
  let listener: ((event: WorkbenchProgress) => void) | undefined;
  let unsubscriptions = 0;
  const desktop: Bridge = {
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, source: 'bundled', message: 'ready' }),
    probeWorkbenchVideo: async (source) => { calls.probe.push(source.relativePath); return { ...probe }; },
    extractWorkbenchFrames: async (request) => { calls.extract.push(request); return { probe: { ...probe }, frames: [frame()] }; },
    renderWorkbenchTimeline: async (request) => { calls.render.push(request); return renderResult(); },
    cancelWorkbenchJob: async (id) => { calls.cancel.push(id); return true; },
    onWorkbenchProgress: (callback) => { listener = callback; return () => { unsubscriptions += 1; listener = undefined; }; },
    importMedia: async () => null,
    ...overrides,
  };
  const engine = new VideoWorkbenchEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop, onChange: () => {}, persist,
    notify: (message) => calls.notices.push(message) });
  const owner = (id = a.id) => state.project.id === id ? state.project : state.projects.find((item) => item.id === id)!;
  const mutateProject = (id: string, update: (project: Project) => Project) => {
    const changed = update(owner(id));
    state = { ...state, project: state.project.id === id ? changed : state.project, projects: state.projects.map((item) => item.id === id ? changed : item) };
  };
  return { engine, calls, a, b, getState: () => state, owner, mutateProject,
    switchTo: (id: string) => { state = { ...state, project: owner(id), activeProjectId: id }; },
    removeProject: (id: string) => { state = { ...state, projects: state.projects.filter((item) => item.id !== id) }; },
    progress: (event: WorkbenchProgress) => listener?.(event), unsubscriptions: () => unsubscriptions };
}

test('old projects do not acquire a workbench or lose unrelated story data', () => {
  assert.equal(normalizeVideoWorkbenchState(undefined, 'legacy'), undefined);
  assert.equal(normalizeVideoWorkbenchState(null, 'legacy'), undefined);
  assert.equal(normalizeVideoWorkbenchState([], 'legacy'), undefined);
  const state = createInitialState();
  const old = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(old.project.videoWorkbench, undefined);
  assert.equal(old.project.id, state.project.id);
  assert.equal(old.project.name, state.project.name);
});

test('workbench normalization supplies finite defaults without repairing prompts or overwriting valid trim data', () => {
  const raw = { draft: { clips: [{ id: 'one', sourceAssetId: 'source', inSec: 1.25, outSec: 8.75, volume: 0, transitionAfter: { type: 'cut' } }],
    output: { fps: NaN }, audio: { ducking: false, bgmVolume: 0 } }, jobs: [] };
  const normalized = normalizeVideoWorkbenchState(raw, 'owner')!;
  assert.equal(normalized.draft.output.fps, 30);
  assert.equal(normalized.draft.clips[0].inSec, 1.25);
  assert.equal(normalized.draft.clips[0].outSec, 8.75);
  assert.equal(normalized.draft.clips[0].volume, 0);
  assert.equal(normalized.draft.audio.ducking, false);
  assert.equal(normalized.draft.audio.bgmVolume, 0);
});

test('persisted job display fields and nested retry snapshots are normalized before rendering', () => {
  const raw = { draft: {}, jobs: [{ id: 'broken', projectId: 'other', kind: 'render', status: 'failed', name: { unsafe: true }, error: ['bad'],
    createdAt: 'yesterday', updatedAt: {}, resultAssetIds: ['valid', null, 4], draft: { clips: 'broken', audio: null, output: null } }] };
  const normalized = normalizeVideoWorkbenchState(raw, 'owner')!;
  const job = normalized.jobs[0];
  assert.equal(typeof job.name, 'string', 'React must never receive an object as a task title');
  assert.ok(job.error === undefined || typeof job.error === 'string', 'React must never receive object/array error text');
  assert.ok(Number.isFinite(job.createdAt)); assert.ok(Number.isFinite(job.updatedAt));
  assert.equal(job.projectId, 'owner'); assert.deepEqual(job.resultAssetIds, ['valid']);
  assert.ok(!job.draft || Array.isArray(job.draft.clips), 'retry snapshots must not crash on draft.clips.map');
});

test('workbench and derived-asset provenance survive the storage round trip', () => {
  const state = createInitialState(); const draft = editDraft(state.project.assets.length ? state.project : { ...state.project, assets: [video('s')] });
  const source = video('source'); const job = savedJob({ draft });
  state.project.assets = [source, frameWorkbenchAsset(frame(), source, job, draft.clips[0])];
  state.project.videoWorkbench = { draft, jobs: [{ ...job, projectId: state.project.id }] };
  state.projects = [state.project];
  const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(normalized.project.videoWorkbench?.draft.id, draft.id);
  assert.equal(normalized.project.videoWorkbench?.jobs[0].projectId, state.project.id);
  const derived = normalized.project.assets.find((asset) => asset.sourceVideoAssetId === source.id)!;
  assert.equal(derived.sourceVideoChecksum, source.checksum);
  assert.equal(derived.sourceFrameIndex, 449); assert.equal(derived.sourceTimeSec, 14.966666667);
  assert.equal(derived.sourceClipId, draft.clips[0].id); assert.equal(derived.sourceVideoEditId, draft.id);
});

test('managed source conversion rejects missing/remote-only inputs and preserves checksums', () => {
  assert.throws(() => workbenchSource(undefined), /不存在/u);
  assert.throws(() => workbenchSource(video('v', { missing: true })), /缺失/u);
  assert.throws(() => workbenchSource(video('v', { relativePath: undefined, url: 'https://example.test/video.mp4' })), /本地托管/u);
  assert.deepEqual(workbenchSource(video('v')), { assetId: 'v', relativePath: 'video/v.mp4', expectedChecksum: checksum() });
});

test('render request uses immutable current-project media references and does not alter source assets', () => {
  const project = createProject('p'); const draft = editDraft(project);
  const before = JSON.stringify({ project, draft });
  const request = buildWorkbenchRenderRequest(project, draft, 'job');
  assert.equal(request.projectId, 'p'); assert.equal(request.jobId, 'job');
  assert.equal(request.clips[0].source.expectedChecksum, checksum());
  assert.deepEqual(request.clips[0].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.equal(request.audio?.bgmVolume, 0.12); assert.equal(request.audio?.ducking, true);
  assert.equal(JSON.stringify({ project, draft }), before);
});

test('render preflight rejects broken ranges, replaced assets and unknown media', () => {
  const project = createProject('p'); const draft = editDraft(project);
  assert.throws(() => buildWorkbenchRenderRequest(project, { ...draft, clips: [] }, 'j'), /添加/u);
  for (const change of [{ inSec: -1 }, { inSec: 4, outSec: 3 }, { outSec: 30 }, { volume: 3 }, { sourceAssetId: 'other-project-asset' }, { sourceChecksum: checksum('b') }]) {
    assert.throws(() => buildWorkbenchRenderRequest(project, { ...draft, clips: [{ ...draft.clips[0], ...change }] }, 'j'));
  }
});

test('duration includes overlap and rejects an excessive dissolve before any native request', () => {
  const project = createProject('p'); const draft = editDraft(project); const clip = draft.clips[0];
  draft.clips = [{ ...clip, outSec: 5, transitionAfter: { type: 'crossfade', durationSec: 1 } }, { ...clip, id: 'two', inSec: 5, outSec: 10 }];
  assert.equal(videoWorkbenchDuration(draft), 9);
  assert.equal(buildWorkbenchRenderRequest(project, draft, 'j').clips.length, 2);
  draft.clips[0].transitionAfter.durationSec = 3;
  assert.throws(() => buildWorkbenchRenderRequest(project, draft, 'j'), /转场/u);
});

test('BGM is validated independently as a managed audio asset with bounded loudness', () => {
  const project = createProject('p'); const draft = editDraft(project);
  project.assets.push(video('music', { type: 'audio', mediaType: 'audio', role: 'audio', referenceRole: 'audio', relativePath: 'audio/music.wav' }));
  draft.audio.bgmAssetId = 'music';
  assert.equal(buildWorkbenchRenderRequest(project, draft, 'j').audio?.bgm?.relativePath, 'audio/music.wav');
  draft.audio.bgmVolume = 0.8;
  assert.throws(() => buildWorkbenchRenderRequest(project, draft, 'j'), /背景音乐音量/u);
  draft.audio.bgmVolume = 0.12; draft.audio.bgmAssetId = 'p-source';
  assert.throws(() => buildWorkbenchRenderRequest(project, draft, 'j'), /不是音频/u);
});

test('long-story loading follows explicit segment indices even if the saved array is shuffled', () => {
  const project = createProject('p'); project.sequencePlans = [plan([3, 1, 2])]; project.assets = [generatedVideo(2), generatedVideo(3), generatedVideo(1)];
  assert.deepEqual(sequenceWorkbenchAssets(project, 'plan').assets.map((asset) => asset.id), ['video-1', 'video-2', 'video-3']);
});

test('long-story loading skips newer remote-only takes in favor of available local takes', () => {
  const project = createProject('p'); project.sequencePlans = [plan([1])];
  project.assets = [generatedVideo(1), generatedVideo(1, { id: 'new-remote', createdAt: 10, relativePath: undefined, url: 'https://example.test/latest.mp4' })];
  assert.deepEqual(sequenceWorkbenchAssets(project, 'plan').assets.map((asset) => asset.id), ['video-1']);
});

test('long-story loading reports absent segments instead of borrowing other segments', () => {
  const project = createProject('p'); project.sequencePlans = [plan()]; project.assets = [generatedVideo(1), generatedVideo(3), generatedVideo(2, { missing: true })];
  const result = sequenceWorkbenchAssets(project, 'plan');
  assert.deepEqual(result.missingSegments, [2]); assert.deepEqual(result.assets.map((asset) => asset.id), ['video-1', 'video-3']);
});

test('extracted images preserve exact source/frame/clip identity and private-reference metadata', () => {
  const source = video('source', { sourceStoryboardId: 'board', referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'breasts' });
  const draft = editDraft({ ...createProject('p'), assets: [source] }); const job = savedJob({ kind: 'boundaries', draft });
  const before = JSON.stringify(source); const output = frameWorkbenchAsset(frame(), source, job, draft.clips[0]);
  assert.equal(output.source, 'derived'); assert.equal(output.mediaType, 'image'); assert.equal(output.referenceRole, 'last-frame');
  assert.equal(output.sourceVideoAssetId, source.id); assert.equal(output.sourceVideoChecksum, source.checksum);
  assert.equal(output.sourceStoryboardId, 'board'); assert.equal(output.sourceFrameIndex, 449); assert.equal(output.sourceTimeSec, 14.966666667);
  assert.equal(output.sourceClipId, draft.clips[0].id); assert.equal(output.sourceVideoEditId, draft.id);
  assert.equal(output.referenceScope, source.referenceScope); assert.equal(output.nsfwPrivatePart, source.nsfwPrivatePart);
  assert.equal(JSON.stringify(source), before);
  assert.equal(frameWorkbenchAsset(frame({ role: 'custom-frame' }), source, job).referenceRole, 'composition');
  assert.deepEqual(frameReferenceRoleOverrides([output.id], 'first-frame'), { [output.id]: 'first-frame' });
});

test('rendered asset retains an independent non-destructive edit snapshot', () => {
  const draft = editDraft(createProject('p')); const output = renderedWorkbenchAsset(renderResult(), savedJob({ kind: 'render', draft }));
  assert.equal(output.type, 'video'); assert.equal(output.sourceVideoEditId, draft.id); assert.equal(output.durationSec, 15);
  draft.clips[0].outSec = 2;
  assert.equal(output.videoEditDraft?.clips[0].outSec, 15);
});

test('engine saves delayed extraction results only to the project which started the job', async () => {
  const pending = deferred<WorkbenchFrameResult>(); const h = harness({ extractWorkbenchFrames: async () => pending.promise });
  const bBefore = JSON.stringify(h.b); const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' });
  await flush(); h.switchTo(h.b.id); pending.resolve({ probe, frames: [frame()] }); const ids = await run;
  assert.equal(ids.length, 1); assert.ok(h.owner(h.a.id).assets.some((asset) => asset.id === ids[0]));
  assert.equal(JSON.stringify(h.getState().project), bBefore); assert.equal(h.calls.notices.length, 0);
  assert.equal(h.owner(h.a.id).videoWorkbench?.jobs[0].status, 'succeeded'); h.engine.dispose();
});

test('engine routes delayed renders to their owner and freezes the trim snapshot', async () => {
  const pending = deferred<WorkbenchRenderResult>(); let nativeRequest: WorkbenchRenderRequest | undefined;
  const h = harness({ renderWorkbenchTimeline: async (request) => { nativeRequest = request; return pending.promise; } });
  const draft = editDraft(h.a); const run = h.engine.renderTimeline(h.a.id, draft); draft.clips[0].outSec = 4;
  await flush(); h.switchTo(h.b.id); pending.resolve(renderResult()); const id = await run;
  assert.equal(nativeRequest?.clips[0].outSec, 15);
  assert.equal(h.owner(h.a.id).assets.find((asset) => asset.id === id)?.videoEditDraft?.clips[0].outSec, 15);
  assert.equal(h.owner(h.b.id).assets.length, 1); h.engine.dispose();
});

test('durable job checkpoint failure prevents native execution and records an actionable error', async () => {
  const h = harness({}, async () => { throw new Error('disk-full-checkpoint'); });
  await assert.rejects(h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' }), /disk-full/u);
  assert.equal(h.calls.extract.length, 0); assert.equal(h.owner().videoWorkbench?.jobs[0].status, 'failed'); assert.equal(h.engine.busy, false); h.engine.dispose();
});

test('cancelling before checkpoint completion never launches native processing', async () => {
  const checkpoint = deferred<void>(); const h = harness({}, () => checkpoint.promise);
  const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' });
  const rejection = assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await h.engine.cancel(); checkpoint.resolve(); await rejection;
  assert.equal(h.calls.extract.length, 0); assert.equal(h.owner().videoWorkbench?.jobs[0].status, 'cancelled'); h.engine.dispose();
});

test('cancelled tasks discard late successful replies and never append result assets', async () => {
  const pending = deferred<WorkbenchFrameResult>(); const h = harness({ extractWorkbenchFrames: async () => pending.promise });
  const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' });
  const rejection = assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await flush(); await h.engine.cancel(); pending.resolve({ probe, frames: [frame()] }); await rejection;
  assert.equal(h.calls.cancel.length, 1); assert.equal(h.owner().assets.length, 1); assert.equal(h.owner().videoWorkbench?.jobs[0].status, 'cancelled');
  assert.equal(h.engine.busy, false); h.engine.dispose();
});

test('removing the owner while a job runs never resurrects its project or contaminates another project', async () => {
  const pending = deferred<WorkbenchFrameResult>(); const h = harness({ extractWorkbenchFrames: async () => pending.promise });
  const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' });
  const rejection = assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await flush(); h.switchTo(h.b.id); h.removeProject(h.a.id); pending.resolve({ probe, frames: [frame()] }); await rejection;
  assert.equal(h.getState().projects.some((project) => project.id === h.a.id), false); assert.equal(h.getState().project.assets.length, 1); h.engine.dispose();
});

test('recovery marks old running jobs interrupted in both active and archived projects', () => {
  const h = harness();
  for (const id of [h.a.id, h.b.id]) h.mutateProject(id, (project) => ({ ...project, videoWorkbench: { draft: editDraft(project), jobs: [savedJob({ projectId: id })] } }));
  h.engine.recoverInterrupted();
  for (const id of [h.a.id, h.b.id]) assert.equal(h.owner(id).videoWorkbench?.jobs[0].status, 'interrupted');
  assert.equal(h.calls.extract.length, 0); assert.equal(h.calls.render.length, 0); h.engine.dispose();
});

test('retry uses the stored frame mode/range and refuses a source replaced since the first attempt', async () => {
  const h = harness(); const job = savedJob({ status: 'failed', frameOptions: { mode: 'frame', frameIndex: 96, inSec: 2, outSec: 8 } });
  h.mutateProject(h.a.id, (project) => ({ ...project, videoWorkbench: { draft: editDraft(project), jobs: [job] } }));
  await h.engine.retryJob(h.a.id, job.id);
  assert.equal(h.calls.extract[0].mode, 'frame'); assert.equal(h.calls.extract[0].frameIndex, 96); assert.equal(h.calls.extract[0].outSec, 8);
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => asset.id === job.sourceAssetId ? { ...asset, checksum: checksum('b') } : asset) }));
  await assert.rejects(h.engine.retryJob(h.a.id, job.id), /原视频内容已更换/u); assert.equal(h.calls.extract.length, 1); h.engine.dispose();
});

test('another job cannot start while an existing local task is running', async () => {
  const pending = deferred<WorkbenchFrameResult>(); const h = harness({ extractWorkbenchFrames: async () => pending.promise });
  const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' }); await flush();
  await assert.rejects(h.engine.extractFrames(h.b.id, h.b.assets[0].id, { mode: 'last' }), /已有本地/u);
  pending.resolve({ probe, frames: [frame()] }); await run; h.engine.dispose();
});

test('progress ignores a different project or request and unsubscribes on disposal', async () => {
  const pending = deferred<WorkbenchFrameResult>(); const h = harness({ extractWorkbenchFrames: async () => pending.promise });
  const run = h.engine.extractFrames(h.a.id, h.a.assets[0].id, { mode: 'last' }); await flush();
  const id = h.owner().videoWorkbench!.jobs[0].id;
  const progress: WorkbenchProgress = { jobId: id, projectId: h.a.id, kind: 'extract', stage: 'processing', percent: 33, message: 'working' };
  h.progress({ ...progress, projectId: h.b.id }); assert.equal(h.engine.progress, undefined);
  h.progress({ ...progress, jobId: 'unrelated' }); assert.equal(h.engine.progress, undefined);
  h.progress(progress); assert.equal((h.engine.progress as WorkbenchProgress | undefined)?.percent, 33);
  pending.resolve({ probe, frames: [frame()] }); await run; h.engine.dispose(); assert.equal(h.unsubscriptions(), 1);
});

test('probe caches are scoped to project and source identity', async () => {
  const h = harness();
  await h.engine.probeAsset(h.a.id, h.a.assets[0].id); await h.engine.probeAsset(h.a.id, h.a.assets[0].id);
  assert.equal(h.calls.probe.length, 1);
  assert.equal(Object.keys(h.engine.probesFor(h.b.id)).length, 0);
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => ({ ...asset, checksum: checksum('c') })) }));
  await h.engine.probeAsset(h.a.id, h.a.assets[0].id); assert.equal(h.calls.probe.length, 2); h.engine.dispose();
});

test('a late probe must not overwrite a relinked checksum-less legacy asset', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: [video(h.a.assets[0].id, { checksum: undefined, durationSec: 20 })] }));
  const run = h.engine.probeAsset(h.a.id, h.a.assets[0].id);
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => ({ ...asset, relativePath: 'video/relinked.mp4', durationSec: 40 })) }));
  pending.resolve({ ...probe, durationSec: 15 }); await run;
  assert.equal(h.owner().assets[0].durationSec, 40, 'the old path metadata must not be written into the replacement video'); h.engine.dispose();
});

test('batch extraction uses exact per-clip ranges and records source clip identities', async () => {
  const h = harness({ extractWorkbenchFrames: async (request) => {
    h.calls.extract.push(request);
    return { probe, frames: [frame({ role: 'first-frame', timeSec: request.inSec!, frameIndex: request.inSec! * 30 }), frame({ timeSec: request.outSec! - 1 / 30 })] };
  } });
  const draft = editDraft(h.a); draft.clips = [{ ...draft.clips[0], id: 'one', inSec: 2, outSec: 6 }, { ...draft.clips[0], id: 'two', inSec: 8, outSec: 12 }];
  const ids = await h.engine.extractBoundaries(h.a.id, draft);
  assert.equal(ids.length, 4); assert.deepEqual(h.calls.extract.map((request) => [request.inSec, request.outSec]), [[2, 6], [8, 12]]);
  assert.equal(new Set(h.calls.extract.map((request) => request.jobId)).size, 2);
  assert.deepEqual(h.owner().assets.filter((asset) => ids.includes(asset.id)).map((asset) => asset.sourceClipId), ['one', 'one', 'two', 'two']); h.engine.dispose();
});

test('a trimmed clip first frame never replaces the original full-video first-frame association', async () => {
  const h = harness({ extractWorkbenchFrames: async () => ({ probe, frames: [frame({ role: 'first-frame', timeSec: 3, frameIndex: 90 }), frame({ timeSec: 7.966666667 })] }) });
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => ({ ...asset, thumbnailAssetId: 'original-first', firstFrameAssetId: 'original-first' })) }));
  const draft = editDraft(h.owner()); draft.clips[0].inSec = 3; draft.clips[0].outSec = 8;
  await h.engine.extractBoundaries(h.a.id, draft);
  const original = h.owner().assets.find((asset) => asset.id === h.a.assets[0].id)!;
  assert.equal(original.firstFrameAssetId, 'original-first'); assert.equal(original.thumbnailAssetId, 'original-first'); h.engine.dispose();
});

test('setup cancellation stops delayed source selection from appending timeline clips', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]);
  const settled = run.catch(() => undefined); await flush(); assert.equal(h.engine.busy, true);
  await h.engine.cancel(); pending.resolve(probe); await settled;
  assert.equal(h.engine.draft(h.a.id).clips.length, 0, 'cancel must also apply to the UI-visible preparation phase'); h.engine.dispose();
});

test('adding videos rejects an asset deleted while its probe is pending', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]);
  const rejected = assert.rejects(run, /已删除或不可用/u);
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: [] }));
  pending.resolve(probe); await rejected;
  assert.equal(h.engine.draft(h.a.id).clips.length, 0); assert.equal(h.engine.busy, false); h.engine.dispose();
});

for (const replacement of ['checksum', 'path', 'legacy-path', 'missing'] as const) test(`adding videos rejects a ${replacement} change to the same asset id during probe`, async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  if (replacement === 'legacy-path') h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => ({ ...asset, checksum: undefined })) }));
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]);
  const rejected = assert.rejects(run, /文件已更换|不可用/u);
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => ({ ...asset,
    ...(replacement === 'checksum' ? { checksum: checksum('b') } : replacement === 'missing' ? { missing: true } : { relativePath: 'video/replacement.mp4' }),
  })) }));
  pending.resolve(probe); await rejected;
  assert.equal(h.engine.draft(h.a.id).clips.length, 0); h.engine.dispose();
});

test('a multi-selection is revalidated as a whole after later probes finish', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async (source) => source.assetId === 'second-video' ? pending.promise : probe });
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: [...project.assets, video('second-video')] }));
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id, 'second-video']);
  const rejected = assert.rejects(run, /已删除或不可用/u); await flush();
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.filter((asset) => asset.id !== h.a.assets[0].id) }));
  pending.resolve(probe); await rejected;
  assert.equal(h.engine.draft(h.a.id).clips.length, 0, 'the earlier captured clip must not sneak in after its source was removed'); h.engine.dispose();
});

test('delayed video selection stays in its owner and appends to live timeline edits', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]);
  h.switchTo(h.b.id);
  const edited = { ...createWorkbenchClip(h.a.assets[0], probe), id: 'edit-during-probe', inSec: 2, outSec: 6 };
  h.engine.updateDraft(h.a.id, (draft) => ({ ...draft, name: '用户刚改的方案名称', clips: [...draft.clips, edited] }));
  pending.resolve(probe); await run;
  assert.equal(h.engine.draft(h.b.id).clips.length, 0);
  assert.equal(h.engine.draft(h.a.id).name, '用户刚改的方案名称');
  assert.equal(h.engine.draft(h.a.id).clips.length, 2); assert.equal(h.engine.draft(h.a.id).clips[0].id, edited.id);
  assert.equal(h.engine.draft(h.a.id).clips[0].outSec, 6); h.engine.dispose();
});

test('delayed selection never recreates a removed owner or appends to another project', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]); const rejected = assert.rejects(run, /所属项目已不存在/u);
  h.switchTo(h.b.id); h.removeProject(h.a.id); pending.resolve(probe); await rejected;
  assert.equal(h.engine.draft(h.b.id).clips.length, 0); assert.equal(h.getState().projects.some((project) => project.id === h.a.id), false); h.engine.dispose();
});

test('selection cannot append into a replacement timeline with a different draft id', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async () => pending.promise });
  const run = h.engine.addAssets(h.a.id, [h.a.assets[0].id]); const rejected = assert.rejects(run, /剪辑方案已切换/u);
  h.engine.updateDraft(h.a.id, (draft) => ({ ...draft, id: 'replacement-draft', clips: [] })); pending.resolve(probe); await rejected;
  assert.equal(h.engine.draft(h.a.id).id, 'replacement-draft'); assert.equal(h.engine.draft(h.a.id).clips.length, 0); h.engine.dispose();
});

test('concurrent add attempts report busy and sequential list-order adds never drop clips', async () => {
  const pending = deferred<WorkbenchVideoProbe>(); const h = harness({ probeWorkbenchVideo: async (source) => source.assetId === h.a.assets[0].id ? pending.promise : probe });
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: [...project.assets, video('second-video')] }));
  const first = h.engine.addAssets(h.a.id, [h.a.assets[0].id]);
  await assert.rejects(h.engine.addAssets(h.a.id, ['second-video']), /已有本地视频处理任务/u);
  pending.resolve(probe); await first;
  await h.engine.addAssets(h.a.id, ['second-video']);
  assert.deepEqual(h.engine.draft(h.a.id).clips.map((clip) => clip.sourceAssetId), [h.a.assets[0].id, 'second-video']); h.engine.dispose();
});

test('missing long-story segments preserve the existing timeline without calling probe', async () => {
  const h = harness(); h.mutateProject(h.a.id, (project) => ({ ...project, sequencePlans: [plan()], videoWorkbench: { draft: editDraft(project), jobs: [] } }));
  const before = JSON.stringify(h.engine.draft(h.a.id));
  await assert.rejects(h.engine.loadSequence(h.a.id, 'plan'), /尚无可用成片/u);
  assert.equal(JSON.stringify(h.engine.draft(h.a.id)), before); assert.equal(h.calls.probe.length, 0); h.engine.dispose();
});

test('render retries retain the BGM fingerprint and refuse a silently replaced soundtrack', async () => {
  const h = harness({ renderWorkbenchTimeline: async () => { throw new Error('encoder-failed'); } });
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: [...project.assets, video('music', { type: 'audio', mediaType: 'audio', role: 'audio', referenceRole: 'audio', relativePath: 'audio/music.wav', checksum: checksum('b') })] }));
  const draft = editDraft(h.owner()); draft.audio.bgmAssetId = 'music';
  await assert.rejects(h.engine.renderTimeline(h.a.id, draft), /encoder-failed/u);
  const job = h.owner().videoWorkbench!.jobs[0];
  h.mutateProject(h.a.id, (project) => ({ ...project, assets: project.assets.map((asset) => asset.id === 'music' ? { ...asset, checksum: checksum('c') } : asset) }));
  await assert.rejects(h.engine.retryJob(h.a.id, job.id), /背景音乐内容已改变/u); h.engine.dispose();
});

test('boundary cancellation targets the current native sub-job and never launches subsequent clips', async () => {
  const second = deferred<WorkbenchFrameResult>();
  const requests: WorkbenchFrameRequest[] = [];
  const h = harness({ extractWorkbenchFrames: async (request) => {
    requests.push(request);
    return requests.length === 1 ? { probe, frames: [frame()] } : second.promise;
  } });
  const draft = editDraft(h.a); draft.clips = [0, 1, 2].map((index) => ({ ...draft.clips[0], id: `clip-${index}`, inSec: index * 3, outSec: index * 3 + 2 }));
  const run = h.engine.extractBoundaries(h.a.id, draft);
  const rejection = assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await flush(); assert.equal(requests.length, 2);
  await h.engine.cancel(); assert.equal(h.calls.cancel[0], requests[1].jobId);
  second.resolve({ probe, frames: [frame()] }); await rejection;
  assert.equal(requests.length, 2); assert.equal(h.owner().videoWorkbench?.jobs[0].status, 'cancelled'); h.engine.dispose();
});

test('delayed file imports stay in their starting project after a project switch', async () => {
  const imported = deferred<Awaited<ReturnType<Bridge['importMedia']>>>();
  const h = harness({ importMedia: async () => imported.promise });
  const run = h.engine.importFiles(h.a.id, [new File(['fixture'], '导入片段.mp4', { type: 'video/mp4' })]);
  await flush(); h.switchTo(h.b.id);
  const { probe: _probe, renderMode: _mode, ...managed } = renderResult(); imported.resolve(managed); await run;
  assert.equal(h.owner(h.a.id).assets.length, 2); assert.equal(h.owner(h.b.id).assets.length, 1);
  assert.equal(h.owner(h.a.id).assets.find((asset) => asset.name === '导入片段')?.relativePath, managed.relativePath); h.engine.dispose();
});

test('boundary extraction ignores unrelated output and soundtrack settings', async () => {
  const h = harness(); const draft = editDraft(h.a);
  draft.output.width = 13; draft.output.fadeInSec = 999; draft.audio.bgmAssetId = 'deleted-music';
  draft.audio.fadeOutSec = 999;
  assert.equal((await h.engine.extractBoundaries(h.a.id, draft)).length, 1);
  assert.equal(h.owner().videoWorkbench?.jobs[0].status, 'succeeded'); h.engine.dispose();
});

test('a later boundary failure retains already completed frame assets with partial-result provenance', async () => {
  let count = 0;
  const h = harness({ extractWorkbenchFrames: async () => { if (++count === 2) throw new Error('second-video-corrupt'); return { probe, frames: [frame()] }; } });
  const draft = editDraft(h.a); draft.clips = [0, 1].map((index) => ({ ...draft.clips[0], id: `partial-${index}` }));
  await assert.rejects(h.engine.extractBoundaries(h.a.id, draft), /second-video-corrupt/u);
  const job = h.owner().videoWorkbench!.jobs[0]; assert.equal(job.status, 'failed');
  assert.equal(job.resultAssetIds.length, 1); assert.match(job.error || '', /已保留/u);
  assert.equal(h.owner().assets.find((asset) => asset.id === job.resultAssetIds[0])?.sourceClipId, 'partial-0'); h.engine.dispose();
});
