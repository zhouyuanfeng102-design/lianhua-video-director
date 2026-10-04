import assert from 'node:assert/strict';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { preflightVideoBatchManagedReferences, validVideoBatchPreviousTail, videoBatchConnectionIdentity, videoBatchRequestFingerprint, videoBatchTailReferences } from '../src/videoBatch';
import { applyVideoTailReference, automaticVideoTailIssue, getVideoTailCharacterPlacement, getVideoTailReferencePlacements,
  resolveAutomaticVideoTailInput, videoTailSequenceFingerprint, type AutomaticVideoTailConfiguration } from '../src/videoTailReference';
import type { AppState, ReferenceAsset, ReferenceRole, VideoGenerationTask, VideoTaskApiConfig, VideoSequencePlan } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft, VideoImageReference } from '../src/videoGenerationTypes';
import type { VideoTailFrameSelectionResult } from '../src/videoFrameSelection';

let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`ok ${++count} - ${name}`); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 8; index += 1) await tick(); };
const waitFor = async (predicate: () => boolean, reason: string) => {
  for (let index = 0; index < 600; index += 1) { if (predicate()) return; await tick(); }
  assert.fail(reason);
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; };
const references: VideoImageReference[] = [{ assetId: 'hero', role: 'character' }, { assetId: 'mentor', role: 'character' }];
const comfyWorkflow = (roles: Array<ReferenceRole | undefined> = ['first-frame', 'character', 'character']): ComfyVideoWorkflowPreset => ({
  id: 'composite-comfy', name: '隔离三槽工作流', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({
    '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'original prompt' } },
    ...Object.fromEntries(roles.map((_, index) => [String(index + 2), { class_type: 'LoadImage', inputs: { image: `original-${index}.png` } }])),
    '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['2', 0] } },
  }),
  mapping: { prompt: [{ nodeId: '1', inputName: 'value' }], images: roles.map((role, index) => ({ nodeId: String(index + 2), inputName: 'image', role })), outputNodeId: '9' },
});
const genericApi: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://composite-api.invalid/generate',
  statusEndpointTemplate: 'https://composite-api.invalid/tasks/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', requestTemplate: JSON.stringify({ prompt: '{{prompt}}', references: '{{references}}' }) };
const cloudApi = (roles: ReferenceRole[] = ['first-frame', 'character', 'character']): VideoTaskApiConfig => ({
  ...genericApi, provider: 'runninghub', endpoint: 'https://composite-rh.invalid/openapi/v2/run/ai-app/{appId}', runningHubAppId: 'composite-test',
  statusEndpointTemplate: 'https://composite-rh.invalid/openapi/v2/query', imageUploadEndpoint: 'https://composite-rh.invalid/openapi/v2/media/upload/binary',
  imageUploadField: 'file', imageUploadUrlPath: 'data.fileName', taskIdPath: 'taskId', resultUrlPath: 'results.0.url',
  runningHubImageRoles: roles,
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'value', fieldValue: '' },
    ...roles.map((_, index) => ({ nodeId: String(index + 2), fieldName: 'image', fieldValue: '' }))] }),
  runningHubMappedFields: [{ nodeId: '1', fieldName: 'value', kind: 'prompt' },
    ...roles.map((_, imageIndex) => ({ nodeId: String(imageIndex + 2), fieldName: 'image', kind: 'image' as const, imageIndex }))],
});

await test('composite inserts exactly slot 1 and preserves all identity refs without mutating originals', () => {
  const before = structuredClone(references);
  const result = getVideoTailCharacterPlacement({ backend: 'api', api: genericApi, references });
  assert.ok(result.placement); assert.equal(result.placement.mode, 'prepend'); assert.equal(result.placement.index, 0);
  assert.equal(result.placement.semantics, 'reference'); assert.match(result.placement.warning || '', /取决于接口/u);
  const next = applyVideoTailReference({ references, tailAssetId: 'tail', placement: result.placement });
  assert.deepEqual(next, [{ assetId: 'tail', role: 'first-frame' }, ...before]); assert.deepEqual(references, before);
  assert.notEqual(next[1], references[0]);
  assert.throws(() => applyVideoTailReference({ references, tailAssetId: 'hero', placement: result.placement! }), /重复/u);
  assert.throws(() => applyVideoTailReference({ references: [...references].reverse(), tailAssetId: 'tail', placement: result.placement! }), /已变化/u);
  assert.equal(validVideoBatchPreviousTail({ predecessorItemKey: 'previous', placement: { ...result.placement, index: 1 } }), false);
  assert.equal(validVideoBatchPreviousTail({ predecessorItemKey: 'previous', placement: { ...result.placement, replacedAssetId: 'hero' } }), false);
});

await test('scene, prop and other selected image purposes are preserved rather than restricted to identities', () => {
  for (const role of ['scene', 'prop', 'composition', 'style', 'first-frame', 'last-frame', 'motion', 'camera', 'general', 'unknown'] as const) {
    const selected: VideoImageReference[] = [{ assetId: `selected-${role}`, role }, references[0]];
    const before = structuredClone(selected);
    const result = getVideoTailCharacterPlacement({ backend: 'api', api: genericApi, references: selected });
    assert.ok(result.placement, result.reason);
    assert.deepEqual(applyVideoTailReference({ references: selected, tailAssetId: 'tail', placement: result.placement }),
      [{ assetId: 'tail', role: 'first-frame' }, ...before]);
    assert.deepEqual(selected, before);
  }
  const duplicated = getVideoTailCharacterPlacement({ backend: 'api', api: genericApi, references: [references[0], references[0]] });
  assert.equal(duplicated.placement, undefined); assert.match(duplicated.reason || '', /重复/u);
});

await test('a local-tail composite may contain no additional references without inventing a character image', () => {
  for (const context of [
    { backend: 'api' as const, api: genericApi },
    { backend: 'api' as const, api: { ...genericApi, provider: 'minimax' as const } },
    { backend: 'api' as const, api: cloudApi(['first-frame']) },
    { backend: 'comfyui' as const, workflow: comfyWorkflow(['first-frame']) },
  ]) {
    const result = getVideoTailCharacterPlacement({ ...context, references: [] });
    assert.ok(result.placement, result.reason);
    assert.deepEqual(applyVideoTailReference({ references: [], tailAssetId: 'tail', placement: result.placement }), [{ assetId: 'tail', role: 'first-frame' }]);
    assert.match(result.placement.label, /不附加其它参考图/u);
  }
  assert.deepEqual(videoBatchTailReferences([], { mode: 'prepend', index: 0, role: 'first-frame' }, 'tail'), [{ assetId: 'tail', role: 'first-frame' }]);
  assert.match(getVideoTailCharacterPlacement({ backend: 'api', api: cloudApi([]), references: [] }).reason || '', /需要 1.*只有 0/u);
  assert.match(getVideoTailCharacterPlacement({ backend: 'comfyui', workflow: comfyWorkflow([]), references: [] }).reason || '', /需要 1.*只有 0/u);
});

await test('generic template must really carry every image; MiniMax cannot invent identity inputs', () => {
  for (const api of [{ ...genericApi, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', image: '{{first_image}}' }) },
    { ...genericApi, requestTemplate: '{bad json' }, { ...genericApi, provider: 'minimax' as const }]) {
    const result = getVideoTailCharacterPlacement({ backend: 'api', api, references });
    assert.equal(result.placement, undefined); assert.ok(result.reason);
  }
});

await test('Comfy uses exact first-slot semantics and never drops images or overwrites a mapped input', () => {
  const workflow = comfyWorkflow();
  const result = getVideoTailCharacterPlacement({ backend: 'comfyui', workflow, references });
  assert.equal(result.placement?.semantics, 'first-frame'); assert.equal(result.placement?.warning, undefined);
  for (const first of ['last-frame', 'character', 'subject'] as const) {
    const mismatch = getVideoTailCharacterPlacement({ backend: 'comfyui', workflow: comfyWorkflow([first, 'character', 'character']), references });
    assert.ok(mismatch.placement, mismatch.reason); assert.match(mismatch.placement.warning || '', /第 1 个图片槽.*仅作提示/u);
    assert.equal(mismatch.placement.role, 'general'); assert.equal(mismatch.placement.semantics, 'reference');
  }
  const ordinary = getVideoTailCharacterPlacement({ backend: 'comfyui', workflow: comfyWorkflow(['general', 'character', 'character']), references });
  assert.equal(ordinary.placement?.role, 'general'); assert.equal(ordinary.placement?.semantics, 'reference'); assert.match(ordinary.placement?.warning || '', /不保证/u);
  assert.match(getVideoTailCharacterPlacement({ backend: 'comfyui', workflow: comfyWorkflow(['first-frame', 'character']), references }).reason || '', /需要 3.*只有 2/u);
  const mismatch = getVideoTailCharacterPlacement({ backend: 'comfyui', workflow: comfyWorkflow(['first-frame', 'last-frame', 'character']), references });
  assert.ok(mismatch.placement, mismatch.reason); assert.match(mismatch.placement.warning || '', /第 2 个图片槽.*不阻止生成/u);
  workflow.mapping.images[2] = { ...workflow.mapping.images[1] };
  assert.match(getVideoTailCharacterPlacement({ backend: 'comfyui', workflow, references }).reason || '', /重复绑定/u);
  workflow.mapping.images[2] = { nodeId: 'missing-node', inputName: 'image', role: 'character' };
  assert.match(getVideoTailCharacterPlacement({ backend: 'comfyui', workflow, references }).reason || '', /映射不存在/u);
  workflow.mapping.images[2] = { nodeId: '1', inputName: 'value', role: 'character' };
  assert.match(getVideoTailCharacterPlacement({ backend: 'comfyui', workflow, references }).reason || '', /覆盖提示词/u);
});

await test('RunningHub and Comfy role labels only warn for mixed references while physical bindings remain unchanged', () => {
  const selected: VideoImageReference[] = [{ assetId: 'scene', role: 'scene' }, { assetId: 'prop', role: 'prop' }];
  for (const backend of ['api', 'comfyui'] as const) {
    const api = cloudApi(); const workflow = comfyWorkflow();
    const before = JSON.stringify({ api, workflow, selected });
    const result = getVideoTailCharacterPlacement({ backend, api, workflow, references: selected });
    assert.ok(result.placement, result.reason);
    assert.match(result.placement.warning || '', /第 2 个图片槽.*场景.*不阻止生成/u);
    assert.match(result.placement.warning || '', /第 3 个图片槽.*道具.*不阻止生成/u);
    assert.deepEqual(applyVideoTailReference({ references: selected, tailAssetId: 'tail', placement: result.placement }),
      [{ assetId: 'tail', role: 'first-frame' }, ...selected]);
    assert.equal(JSON.stringify({ api, workflow, selected }), before);
  }
});

await test('RunningHub allows unused capacity and validates actual node expansion before AI', () => {
  assert.equal(getVideoTailCharacterPlacement({ backend: 'api', api: cloudApi(), references }).placement?.semantics, 'first-frame');
  assert.match(getVideoTailCharacterPlacement({ backend: 'api', api: cloudApi(['first-frame', 'character']), references }).reason || '', /只有 2/u);
  const spare = cloudApi(['first-frame', 'character', 'character', 'character']);
  const lessThanCapacity = getVideoTailCharacterPlacement({ backend: 'api', api: spare, references });
  assert.equal(lessThanCapacity.placement?.semantics, 'first-frame');
  assert.deepEqual(applyVideoTailReference({ references, tailAssetId: 'tail', placement: lessThanCapacity.placement! }), [{ assetId: 'tail', role: 'first-frame' }, ...references]);
  const fewerCharacters = getVideoTailCharacterPlacement({ backend: 'api', api: spare, references: references.slice(0, 1) });
  assert.ok(fewerCharacters.placement, 'tail and one identity may use only two of four slots');
  assert.deepEqual(applyVideoTailReference({ references: references.slice(0, 1), tailAssetId: 'tail', placement: fewerCharacters.placement! }).map((reference) => reference.assetId), ['tail', 'hero'], 'unused slots never create duplicate or invented images');
  const wrongTemplate = cloudApi(); wrongTemplate.runningHubMappedFields!.pop();
  assert.equal(getVideoTailCharacterPlacement({ backend: 'api', api: wrongTemplate, references }).placement, undefined);
  const duplicated = cloudApi(); duplicated.runningHubMappedFields![3] = { ...duplicated.runningHubMappedFields![2], imageIndex: 2 };
  assert.match(getVideoTailCharacterPlacement({ backend: 'api', api: duplicated, references }).reason || '', /重复绑定/u);
});

await test('RunningHub tail-only placement accepts one of four slots without filling any identity slots', () => {
  const api = cloudApi(['first-frame', 'character', 'character', 'character']);
  const emptyPlacement = getVideoTailReferencePlacements({ backend: 'api', api, references: [] });
  assert.equal(emptyPlacement.options.length, 1);
  assert.equal(emptyPlacement.options[0].mode, 'append');
  assert.deepEqual(applyVideoTailReference({ references: [], tailAssetId: 'tail', placement: emptyPlacement.options[0] }), [{ assetId: 'tail', role: 'first-frame' }]);
  const existing: VideoImageReference[] = [{ assetId: 'old-frame', role: 'first-frame' }, references[0]];
  const replacement = getVideoTailReferencePlacements({ backend: 'api', api, references: existing }).options[0];
  assert.deepEqual(applyVideoTailReference({ references: existing, tailAssetId: 'tail', placement: replacement, confirmed: true }), [{ assetId: 'tail', role: 'first-frame' }, references[0]]);
  assert.deepEqual(existing.map((reference) => reference.assetId), ['old-frame', 'hero']);
  assert.equal(getVideoTailReferencePlacements({ backend: 'api', api, references: [...existing, ...references, { assetId: 'extra', role: 'character' }] }).options.length, 0);
});

const source = (index: number) => ({ storyboardId: `board-${index}`, sequencePlanId: 'composite-plan', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh' as const });
const draft = (index: number, backend: 'api' | 'comfyui' = 'api'): VideoGenerationDraft => ({ name: `组合分段${index}`, backend,
  ...(backend === 'comfyui' ? { workflowId: 'composite-comfy' } : {}), prompt: `完整第${index}段提示词：尾帧 Picture 1，人物 Picture 2、Picture 3。`,
  parameters: {}, source: source(index), references: index === 1 ? [{ assetId: 'initial-scene', role: 'first-frame' }, ...structuredClone(references)] : structuredClone(references) });
const sequencePlan = (): VideoSequencePlan => ({ id: 'composite-plan', title: '三段', sourceStoryTitle: '', sourceStoryContent: '',
  durationMode: 'ai-estimated', totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
  segments: [1, 2, 3].map((index) => ({ id: `segment-${index}`, index, title: `第${index}段`, durationSec: 15, globalStartSec: (index - 1) * 15, globalEndSec: index * 15,
    content: '', summary: '', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: `board-${index}`, status: 'ready' })) });

await test('automatic composite keeps exact predecessor and rejects stale roles/selection/mapping', () => {
  const project = { sequencePlans: [sequencePlan()] };
  const selected = [1, 2].map((index) => ({ key: `board-${index}:zh`, ...source(index), draft: draft(index) }));
  const placement = getVideoTailCharacterPlacement({ backend: 'api', api: genericApi, references })!.placement!;
  const configuration: AutomaticVideoTailConfiguration = { predecessorSegmentId: 'segment-1', predecessorSegmentIndex: 1,
    placement, connectionScope: 'scope', sequenceFingerprint: videoTailSequenceFingerprint(project, 'composite-plan'), selectionMode: 'ai-assisted', requireAiSelection: true };
  const context = { project, selected, sequencePlanId: 'composite-plan', candidate: selected[1], backend: 'api' as const,
    api: genericApi, connectionScope: 'scope', toolsAvailable: true, configuration };
  assert.equal(automaticVideoTailIssue(context), '');
  assert.equal(resolveAutomaticVideoTailInput(context)?.placement.mode, 'prepend');
  assert.equal(resolveAutomaticVideoTailInput(context)?.predecessorItemKey, 'board-1:zh');
  assert.match(automaticVideoTailIssue({ ...context, selected: selected.slice(1) }), /同时选择第 1 段/u);
  assert.match(automaticVideoTailIssue({ ...context, candidate: { ...selected[1], draft: { ...selected[1].draft, references: references.slice(1) } } }), /已变化/u);
  assert.ok(automaticVideoTailIssue({ ...context, api: { ...genericApi, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', image: '{{first_image}}' }) } }));
  assert.ok(automaticVideoTailIssue({ ...context, configuration: { ...configuration, placement: { ...placement, role: 'general' } } }));
  assert.ok(getVideoTailReferencePlacements({ backend: 'api', api: genericApi, references }).options.every((option) => option.mode !== 'prepend'), 'old tail-only choices remain independent');
});

const image = (assetId: string): ReferenceAsset => ({ id: assetId, name: assetId, type: 'reference', role: assetId === 'initial-scene' ? 'first-frame' : 'character',
  mediaType: 'image', fileName: `${assetId}.png`, relativePath: `image/${assetId}.png`, checksum: `checksum-${assetId}`, managed: true, tags: [], createdAt: 1, updatedAt: 1 });
const frameSelection = (index: number): VideoTailFrameSelectionResult => {
  const frame = { fileName: `ai-tail-${index}.png`, relativePath: `image/ai-tail-${index}.png`, checksum: `checksum-tail-${index}`, mediaType: 'image' as const,
    mimeType: 'image/png', sizeBytes: 10, managed: true, missing: false, timeSec: 14.5, frameIndex: 145, width: 640, height: 360, role: 'custom-frame' as const,
    url: `lianhua-asset://local/image/ai-tail-${index}.png` };
  return { frame, selection: { source: 'ai', selectedId: `frame-${index}`, reason: '保持本段入场画面', selectedTimeSec: 14.5, lastFrameTimeSec: 14.9,
    offsetFromEndSec: 0.4, candidateCount: 6 }, candidates: [{ id: `frame-${index}`, timeSec: 14.5, isLastFrame: false, frame }] };
};
type Provider = 'generic' | 'runninghub' | 'comfyui';
const makeHarness = (provider: Provider = 'generic', roles: ReferenceRole[] = ['first-frame', 'character', 'character']) => {
  let state = createInitialState(); state.project.assets = ['initial-scene', 'hero', 'mentor'].map(image); state.project.sequencePlans = [sequencePlan()];
  state.projects = [state.project]; state.settings.videoTaskApi = provider === 'runninghub' ? cloudApi(roles) : genericApi;
  state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 4;
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'https://composite-comfy.invalid', apiKey: '', activeWorkflowId: 'composite-comfy', workflows: [comfyWorkflow(roles)] };
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const uploads = new Map<string, string>(); const readPaths: string[] = [];
  let generationCount = 0; let analyses = 0; let localExtractions = 0;
  const control = { failGeneration: 0, failReadyCheckpoint: false, holdAi: undefined as Promise<void> | undefined, allowLocalExtraction: false };
  const result = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(structuredClone(request));
      if (request.multipart) {
        const value = `openapi/upload-${uploads.size + 1}.png`; uploads.set(value, request.multipart.files[0].dataUrl);
        return provider === 'comfyui' ? result({ name: value, subfolder: '', type: 'input' }) : result({ code: 0, data: { fileName: value } });
      }
      if (request.url.includes('/history/')) {
        const id = request.url.split('/').at(-1)!;
        return result({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { '9': { videos: [{ filename: `${id}.mp4`, subfolder: '', type: 'output' }] } } } });
      }
      generationCount += 1;
      if (generationCount === control.failGeneration) return result({ id: `remote-${generationCount}`, status: 'failed', error: 'fixture explicit failure' });
      if (provider === 'comfyui') return result({ prompt_id: `remote-${generationCount}` });
      if (provider === 'runninghub') return result({ taskId: `remote-${generationCount}`, status: 'SUCCESS', results: [{ outputType: 'mp4', nodeId: '9', url: `https://video.invalid/${generationCount}.mp4` }] });
      return result({ id: `remote-${generationCount}`, status: 'succeeded', url: `https://video.invalid/${generationCount}.mp4` });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => {
      if (control.failReadyCheckpoint && task.videoJob?.tailPreparation?.phase === 'ready') throw new Error('fixture ready checkpoint failure');
      checkpoints.set(task.id, structuredClone(task)); return { persisted: true };
    },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(checkpoints.get(taskId) || null), deleteVideoTaskCheckpoint: async () => true,
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => { readPaths.push(relativePath); return { dataUrl: `data:image/png;base64,${Buffer.from(expectedChecksum || relativePath).toString('base64')}` }; },
    downloadGeneratedMedia: async () => ({ fileName: `result-${generationCount}.mp4`, relativePath: `video/result-${generationCount}.mp4`, checksum: `movie-${generationCount}`,
      mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 200, managed: true, missing: false, url: `lianhua-asset://local/video/result-${generationCount}.mp4` }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'fixture tools' }),
    extractWorkbenchFrames: async (request) => {
      if (!control.allowLocalExtraction) throw new Error('strict composite must not fall back to raw frame extraction');
      assert.equal(request.mode, 'last');
      const index = ++localExtractions;
      return { probe: { durationSec: 15, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' },
        frames: [{ ...frameSelection(index).frame, fileName: `local-tail-${index}.png`, relativePath: `image/local-tail-${index}.png`,
          checksum: `checksum-local-tail-${index}`, role: 'last-frame', timeSec: 14.9, frameIndex: 149 }] };
    },
    cancelWorkbenchJob: async () => true,
  };
  const options: VideoGenerationEngineOptions = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); },
    desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 5,
    selectTailFrame: async (request) => { assert.equal(request.requireAiSelection, true); await request.onBeforeAI!(); analyses += 1; if (control.holdAi) await control.holdAi; return frameSelection(analyses); },
  };
  const input = (): VideoBatchStartInput => ({ projectId: state.project.id, label: 'AI尾帧和人物', concurrency: 4,
    items: [1, 2, 3].map((index) => ({ itemKey: `board-${index}:zh`, draft: draft(index, provider === 'comfyui' ? 'comfyui' : 'api'),
      ...(index > 1 ? { previousTail: { predecessorItemKey: `board-${index - 1}:zh`, placement: { mode: 'prepend' as const, index: 0,
        role: 'first-frame' as const }, selectionMode: 'ai-assisted' as const, requireAiSelection: true as const } } : {}) })) });
  return { state: () => state, requests, checkpoints, uploads, readPaths, options, desktop, control, input,
    count: () => generationCount, analyses: () => analyses, localExtractions: () => localExtractions, engine: new VideoGenerationEngine(options) };
};
type Harness = ReturnType<typeof makeHarness>;
const tasks = (h: Harness) => h.state().project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video');
const orderedTasks = (h: Harness, batchId: string) => tasks(h).filter((task) => task.batchId === batchId).sort((a, b) => a.batchIndex! - b.batchIndex!);
const generationRequests = (h: Harness) => h.requests.filter((request) => request.method === 'POST' && !request.multipart && !request.url.endsWith('/query'));
const inputData = (h: Harness, provider: Provider, requestIndex: number): string[] => {
  const body = JSON.parse(generationRequests(h)[requestIndex].body!);
  const values = provider === 'generic' ? body.references.map((reference: { image_url: string }) => reference.image_url) : provider === 'runninghub'
    ? body.nodeInfoList.filter((node: { fieldName: string }) => node.fieldName === 'image').map((node: { fieldValue: string }) => node.fieldValue)
    : ['2', '3', '4'].map((id) => body.prompt[id].inputs.image);
  return values.map((value: string) => Buffer.from((h.uploads.get(value) || value).split(',')[1], 'base64').toString());
};

for (const provider of ['generic', 'runninghub', 'comfyui'] as const) await test(`${provider}: actual mock submission uploads tail first and all identity bytes unchanged`, async () => {
  const h = makeHarness(provider);
  try {
    const started = await h.engine.startBatch(h.input());
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => task.status === 'succeeded' && Boolean(task.resultAssetId)), `${provider} composite chain did not finish`);
    assert.equal(h.count(), 3); assert.equal(h.analyses(), 2);
    assert.deepEqual(inputData(h, provider, 0), ['checksum-initial-scene', 'checksum-hero', 'checksum-mentor']);
    assert.deepEqual(inputData(h, provider, 1), ['checksum-tail-1', 'checksum-hero', 'checksum-mentor']);
    assert.deepEqual(inputData(h, provider, 2), ['checksum-tail-2', 'checksum-hero', 'checksum-mentor']);
    const complete = orderedTasks(h, started.batchId);
    for (let index = 1; index < complete.length; index += 1) {
      const snapshot = complete[index].videoJob!.snapshot;
      assert.equal(snapshot.previousTail?.referenceIndex, 0); assert.equal(snapshot.previousTail?.predecessorTaskId, complete[index - 1].id);
      assert.deepEqual(snapshot.draft.references.slice(1), references); assert.deepEqual(snapshot.images.slice(1).map((asset) => asset.assetId), ['hero', 'mentor']);
      assert.equal(snapshot.previousTail?.requireAiSelection, true);
    }
    const again = await h.engine.startBatch(h.input());
    assert.equal(again.taskIds.length, 0); assert.equal(again.skipped.length, 3); assert.equal(h.count(), 3); assert.equal(h.analyses(), 2);
  } finally { h.engine.dispose(); }
});

await test('preflight reads every retained identity and rejects destructive duplicate binding before any generation or AI', async () => {
  const h = makeHarness('comfyui');
  try {
    await preflightVideoBatchManagedReferences(h.state(), h.input(), h.desktop);
    assert.ok(h.readPaths.includes('image/hero.png')); assert.ok(h.readPaths.includes('image/mentor.png'));
    const workflow = h.state().settings.comfyuiVideo!.workflows[0];
    workflow.mapping.images[2] = { ...workflow.mapping.images[1] };
    await assert.rejects(h.engine.startBatch(h.input()), /重复绑定/u);
    assert.equal(h.count(), 0); assert.equal(h.analyses(), 0); assert.equal(tasks(h).length, 0);
  } finally { h.engine.dispose(); }
});

for (const secondRole of ['character', 'general'] as const) for (const provider of ['generic', 'runninghub', 'comfyui'] as const) await test(`${provider}: local last frame plus scene/${secondRole} references preserves bytes, purposes and prompt without AI`, async () => {
  const h = makeHarness(provider); h.control.allowLocalExtraction = true;
  try {
    h.state().project.assets.push({ ...image('scene'), role: 'scene' });
    const selected: VideoImageReference[] = [{ assetId: 'scene', role: 'scene' }, { ...references[0], role: secondRole }];
    const input = h.input();
    for (const item of input.items.slice(1)) {
      item.draft.references = structuredClone(selected);
      item.draft.referenceSlotRoles = ['scene', secondRole];
      delete item.previousTail!.selectionMode; delete item.previousTail!.requireAiSelection;
    }
    const prompts = input.items.map((item) => item.draft.prompt);
    const started = await h.engine.startBatch(input);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => task.status === 'succeeded' && Boolean(task.resultAssetId)), `${provider} local mixed-reference chain did not finish`);
    assert.equal(h.count(), 3); assert.equal(h.localExtractions(), 2); assert.equal(h.analyses(), 0);
    for (const index of [1, 2]) {
      assert.deepEqual(inputData(h, provider, index), [`checksum-local-tail-${index}`, 'checksum-scene', 'checksum-hero']);
      const snapshot = orderedTasks(h, started.batchId)[index].videoJob!.snapshot;
      assert.deepEqual(snapshot.draft.references.slice(1), selected);
      assert.deepEqual(snapshot.draft.referenceSlotRoles, ['first-frame', 'scene', secondRole]);
      assert.equal(snapshot.draft.prompt, prompts[index]);
      assert.equal(snapshot.previousTail?.selectionMode, undefined); assert.equal(snapshot.previousTail?.requireAiSelection, undefined);
    }
    const again = await h.engine.startBatch(input);
    assert.equal(again.taskIds.length, 0); assert.equal(again.skipped.length, 3);
    assert.equal(h.count(), 3); assert.equal(h.localExtractions(), 2); assert.equal(h.analyses(), 0);
  } finally { h.engine.dispose(); }
});

await test('composite request fingerprints read relative scene/general purposes at their shifted physical slots', () => {
  for (const provider of ['generic', 'runninghub', 'comfyui'] as const) {
    const h = makeHarness(provider);
    try {
      const candidate = draft(2, provider === 'comfyui' ? 'comfyui' : 'api');
      candidate.references = [{ assetId: 'hero', role: 'general' }, { assetId: 'mentor', role: 'general' }];
      candidate.referenceSlotRoles = ['scene', 'general'];
      const identity = videoBatchConnectionIdentity(h.state().settings, candidate);
      const expected = { ...candidate, references: [{ assetId: 'hero', role: 'scene' as const }, candidate.references[1]], referenceSlotRoles: undefined };
      const shifted = videoBatchRequestFingerprint(candidate, h.state().project.assets, identity, 1);
      assert.equal(shifted, videoBatchRequestFingerprint(expected, h.state().project.assets, identity, 1));
      assert.notEqual(shifted, videoBatchRequestFingerprint({ ...candidate, referenceSlotRoles: ['general', 'scene'] }, h.state().project.assets, identity, 1));
    } finally { h.engine.dispose(); }
  }
});

await test('preflight and frozen submission agree on scene and end-frame roles after reserving the local first slot', async () => {
  const h = makeHarness(); h.control.allowLocalExtraction = true;
  try {
    h.state().project.assets.push({ ...image('scene'), role: 'scene' });
    h.state().settings.videoTaskApi = { ...genericApi, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', first: '{{first_image}}', scene: '{{image_2}}', last: '{{last_image}}' }) };
    const selected: VideoImageReference[] = [{ assetId: 'scene', role: 'scene' }, { assetId: 'mentor', role: 'last-frame' }];
    const input = h.input();
    input.items[0].draft.references = [{ assetId: 'initial-scene', role: 'first-frame' }, ...structuredClone(selected)];
    input.items[0].draft.referenceSlotRoles = ['first-frame', 'scene', 'last-frame'];
    for (const item of input.items.slice(1)) {
      item.draft.references = structuredClone(selected); item.draft.referenceSlotRoles = ['scene', 'last-frame'];
      delete item.previousTail!.selectionMode; delete item.previousTail!.requireAiSelection;
    }
    const started = await h.engine.startBatch(input);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => task.status === 'succeeded' && Boolean(task.resultAssetId)), 'mixed role-specific generic template did not finish');
    assert.equal(h.count(), 3); assert.equal(h.localExtractions(), 2); assert.equal(h.analyses(), 0);
    for (const index of [1, 2]) {
      const body = JSON.parse(generationRequests(h)[index].body!);
      assert.deepEqual([body.first, body.scene, body.last].map((value: string) => Buffer.from(value.split(',')[1], 'base64').toString()),
        [`checksum-local-tail-${index}`, 'checksum-scene', 'checksum-mentor']);
      const snapshot = orderedTasks(h, started.batchId)[index].videoJob!.snapshot;
      assert.deepEqual(snapshot.draft.references.slice(1), selected);
      assert.deepEqual(snapshot.draft.referenceSlotRoles, ['first-frame', 'scene', 'last-frame']);
    }
  } finally { h.engine.dispose(); }
});

for (const provider of ['generic', 'runninghub', 'comfyui'] as const) await test(`${provider}: removing every extra image submits only the locally extracted last frame`, async () => {
  const h = makeHarness(provider); h.control.allowLocalExtraction = true;
  try {
    const input = h.input();
    for (const item of input.items.slice(1)) {
      item.draft.references = []; item.draft.referenceSlotRoles = [];
      delete item.previousTail!.selectionMode; delete item.previousTail!.requireAiSelection;
    }
    const started = await h.engine.startBatch(input);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => task.status === 'succeeded' && Boolean(task.resultAssetId)), `${provider} local tail-only composite did not finish`);
    assert.equal(h.count(), 3); assert.equal(h.localExtractions(), 2); assert.equal(h.analyses(), 0);
    for (const index of [1, 2]) {
      const snapshot = orderedTasks(h, started.batchId)[index].videoJob!.snapshot;
      assert.equal(snapshot.draft.references.length, 1); assert.equal(snapshot.images.length, 1);
      assert.equal(snapshot.draft.references[0].role, 'first-frame');
      assert.equal(snapshot.images[0].checksum, `checksum-local-tail-${index}`);
    }
  } finally { h.engine.dispose(); }
});

await test('blocked frame persistence and normalized restart retain identity slots without repeating AI', async () => {
  const h = makeHarness(); h.control.failReadyCheckpoint = true;
  let engine = h.engine;
  try {
    const started = await engine.startBatch(h.input());
    await waitFor(() => tasks(h).some((task) => task.id === started.taskIds[1] && task.videoJob?.tailPreparation?.phase === 'blocked'), 'AI ready persistence did not block');
    assert.equal(h.count(), 1); assert.equal(h.analyses(), 1);
    engine.dispose();
    h.options.setState((current) => normalizeState(JSON.parse(JSON.stringify(current)))); h.control.failReadyCheckpoint = false;
    engine = new VideoGenerationEngine(h.options); engine.reconcile(); await engine.resume(started.taskIds[1]);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => Boolean(task.resultAssetId)), 'normalized composite restart failed');
    assert.equal(h.count(), 3); assert.equal(h.analyses(), 2, 'only third segment may issue a new AI request');
    assert.deepEqual(inputData(h, 'generic', 1), ['checksum-tail-1', 'checksum-hero', 'checksum-mentor']);
  } finally { engine.dispose(); }
});

await test('continued suffix replaces only its reserved tail, preserves references and cannot double bill', async () => {
  const h = makeHarness(); h.control.failGeneration = 2;
  try {
    const input = h.input();
    for (const item of input.items.slice(1)) item.draft.referenceSlotRoles = ['character', 'character', 'prop'];
    const started = await h.engine.startBatch(input);
    await waitFor(() => tasks(h).some((task) => task.id === started.taskIds[1] && task.status === 'failed'), 'second segment did not explicitly fail');
    await h.engine.cancelBatch(started.batchId);
    const firstBefore = structuredClone(tasks(h).find((task) => task.id === started.taskIds[0]));
    const preview = await h.engine.resumeBatch(started.batchId);
    assert.ok(preview.continuation); assert.equal(h.count(), 2); assert.equal(h.analyses(), 1);
    const continuation = await h.engine.confirmContinueBatch(preview.continuation.id);
    await waitFor(() => orderedTasks(h, continuation.batchId).every((task) => Boolean(task.resultAssetId)), 'composite suffix did not finish');
    assert.equal(h.count(), 4); assert.equal(h.analyses(), 2);
    assert.deepEqual(inputData(h, 'generic', 2), ['checksum-tail-1', 'checksum-hero', 'checksum-mentor']);
    assert.deepEqual(inputData(h, 'generic', 3), ['checksum-tail-2', 'checksum-hero', 'checksum-mentor']);
    const continued = orderedTasks(h, continuation.batchId);
    for (const task of continued) assert.deepEqual(task.videoJob!.snapshot.draft.referenceSlotRoles, ['first-frame', 'character', 'character', 'prop'], 'continue keeps physical purpose memory; it must not prepend the tail a second time');
    assert.equal(continued[0].videoJob!.snapshot.previousTail, undefined);
    assert.equal(continued[1].videoJob!.snapshot.previousTail?.predecessorTaskId, continued[0].id);
    assert.deepEqual(tasks(h).find((task) => task.id === started.taskIds[0]), firstBefore);
    assert.deepEqual(await h.engine.confirmContinueBatch(preview.continuation.id), continuation);
    await h.engine.resumeBatch(started.batchId); await settle(); assert.equal(h.count(), 4); assert.equal(h.analyses(), 2);
  } finally { h.engine.dispose(); }
});

await test('cancellation ignores late AI composite frame and never submits a successor', async () => {
  const h = makeHarness(); const gate = deferred(); h.control.holdAi = gate.promise;
  try {
    const started = await h.engine.startBatch(h.input());
    await waitFor(() => h.analyses() === 1, 'AI selection never began');
    await h.engine.cancelBatch(started.batchId); gate.resolve(); await settle(); h.engine.reconcile(); await settle();
    assert.equal(h.count(), 1);
    assert.ok(orderedTasks(h, started.batchId).slice(1).every((task) => task.videoJob?.batchQueueState === 'cancelled'));
    assert.deepEqual(orderedTasks(h, started.batchId)[1].videoJob!.snapshot.draft.references.slice(1), references);
  } finally { gate.resolve(); h.engine.dispose(); }
});

await test('sparse character slots validate their real mapping and prepend only one physical offset', () => {
  const sparse: VideoImageReference[] = [{ assetId: 'hero', role: 'character' }, { assetId: 'mentor', role: 'character', slotIndex: 2 }];
  for (const backend of ['api', 'comfyui'] as const) {
    const placement = getVideoTailCharacterPlacement({ backend, api: cloudApi(['first-frame', 'character', 'last-frame', 'character']),
      workflow: comfyWorkflow(['first-frame', 'character', 'last-frame', 'character']), references: sparse });
    assert.ok(placement.placement, placement.reason);
    assert.deepEqual(applyVideoTailReference({ references: sparse, placement: placement.placement, tailAssetId: 'tail' }),
      [{ assetId: 'tail', role: 'first-frame' }, sparse[0], { ...sparse[1], slotIndex: 3 }]);
    const tooSmall = getVideoTailCharacterPlacement({ backend, api: cloudApi(), workflow: comfyWorkflow(), references: sparse });
    assert.match(tooSmall.reason || '', /需要 4.*只有 3/u);
  }
});

for (const provider of ['runninghub', 'comfyui'] as const) await test(`${provider}: sparse composite wire slots survive frozen snapshots`, async () => {
  const h = makeHarness(provider, ['first-frame', 'character', 'character', 'character']);
  try {
    const input = h.input();
    for (const item of input.items.slice(1)) {
      item.draft.references = [references[0], { ...references[1], slotIndex: 2 }];
      item.draft.referenceSlotRoles = ['character', 'prop', 'character'];
    }
    const started = await h.engine.startBatch(input);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => Boolean(task.resultAssetId)), `${provider} sparse composite chain did not finish`);
    assert.equal(h.analyses(), 2); assert.equal(h.count(), 3);
    const complete = orderedTasks(h, started.batchId);
    for (let index = 1; index < complete.length; index += 1) {
      const snapshot = complete[index].videoJob!.snapshot;
      assert.equal(snapshot.previousTail?.referenceIndex, 0);
      assert.deepEqual(snapshot.draft.references.slice(1), [references[0], { ...references[1], slotIndex: 3 }]);
      assert.equal(snapshot.images[2].slotIndex, 3);
      assert.deepEqual(snapshot.draft.referenceSlotRoles, ['first-frame', 'character', 'prop', 'character'], 'prepend shifts the remembered empty slot together with occupied slots');
      const body = JSON.parse(generationRequests(h)[index].body!);
      const values: string[] = provider === 'runninghub'
        ? body.nodeInfoList.filter((node: { fieldName: string }) => node.fieldName === 'image').map((node: { fieldValue: string }) => node.fieldValue)
        : ['2', '3', '4', '5'].map((id) => body.prompt[id].inputs.image);
      assert.equal(values[2], provider === 'runninghub' ? '' : 'original-2.png');
      assert.deepEqual([values[0], values[1], values[3]].map((value) => Buffer.from(h.uploads.get(value)!.split(',')[1], 'base64').toString()),
        [`checksum-tail-${index}`, 'checksum-hero', 'checksum-mentor']);
    }
  } finally { h.engine.dispose(); }
});

for (const provider of ['runninghub', 'comfyui'] as const) await test(`${provider}: a tail fills physical slot zero while dependency index stays dense`, async () => {
  const h = makeHarness(provider);
  try {
    const input = h.input();
    for (const item of input.items.slice(1)) {
      item.draft.references = [{ ...references[0], slotIndex: 1 }, { ...references[1], slotIndex: 2 }];
      item.draft.referenceSlotRoles = ['composition', 'character', 'character'];
      item.previousTail!.placement = { mode: 'append', index: 2, slotIndex: 0, role: 'first-frame' };
    }
    const started = await h.engine.startBatch(input);
    await waitFor(() => orderedTasks(h, started.batchId).every((task) => Boolean(task.resultAssetId)), `${provider} sparse tail chain did not finish`);
    const complete = orderedTasks(h, started.batchId);
    for (let index = 1; index < complete.length; index += 1) {
      const snapshot = complete[index].videoJob!.snapshot;
      assert.equal(snapshot.previousTail?.referenceIndex, 2);
      assert.deepEqual(snapshot.draft.references.slice(0, 2), [{ ...references[0], slotIndex: 1 }, { ...references[1], slotIndex: 2 }]);
      assert.equal(snapshot.draft.references[2].slotIndex, 0);
      assert.equal(snapshot.images[2].slotIndex, 0);
      assert.deepEqual(snapshot.draft.referenceSlotRoles, ['first-frame', 'character', 'character'], 'filling physical slot zero updates only its remembered purpose');
      assert.deepEqual(inputData(h, provider, index), [`checksum-tail-${index}`, 'checksum-hero', 'checksum-mentor']);
    }
    const normalized = normalizeState(JSON.parse(JSON.stringify(h.state())));
    const normalizedTasks = normalized.project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video');
    const restored = normalizedTasks.find((task) => task.id === complete[1].id)!;
    assert.equal(restored.videoJob!.snapshot.previousTail?.referenceIndex, 2);
    assert.equal(restored.videoJob!.snapshot.draft.references[2].slotIndex, 0);
    assert.deepEqual(restored.videoJob!.snapshot.draft.referenceSlotRoles, ['first-frame', 'character', 'character']);
  } finally { h.engine.dispose(); }
});

console.log(`AI-tail + character reference checks passed (${count} groups; all transports mocked, no paid requests).`);
