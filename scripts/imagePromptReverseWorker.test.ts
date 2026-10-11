import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitialState, type ManagedMediaResult } from '../src/storage';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import { submitImagePromptReverse, stopImagePromptReverse, retryImagePromptReverse, waitForImagePromptReverseTask,
  type ImagePromptReverseContext } from '../src/imagePromptReverse';
import type { AppState, ImagePromptReverseResult, ImagePromptReverseTask, ReferenceAsset, VisionApiConfig } from '../src/types';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const result: ImagePromptReverseResult = { prompt: '独立完整的原图提示词', characters: '未发现可辨人物', objects: '灯具详细资料', scene: '场景详细资料', style: '具体写实3D风格' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
let counter = 0;
const fixture = () => {
  const initial = createInitialState();
  const reference: ReferenceAsset = { id: 'reference-one', name: '原图', type: 'reference', role: 'composition',
    dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 };
  const project = { ...initial.project, id: `reverse-fixture-${++counter}`, name: '反推项目', assets: [reference], generationTasks: [] };
  let state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id,
    settings: { ...initial.settings, imageApi: { ...initial.settings.imageApi, enabled: false },
      textApi: { ...initial.settings.textApi, enabled: false },
      visionApi: { ...initial.settings.visionApi, enabled: true, vision: true, model: 'fixture-vision', baseUrl: 'https://reverse.invalid/v1', apiKey: 'secret' } } };
  const mutate = (updater: (value: AppState) => AppState) => { state = updater(state); };
  const calls: Array<{ api: VisionApiConfig; image: string; requirement?: string; signal?: AbortSignal }> = [];
  const media = new Map<string, string>(); const stores: Array<{ dataUrl: string; fileName?: string }> = [];
  const notices: string[] = [];
  const ctx: ImagePromptReverseContext = { getState: () => state, update: mutate, updateBackground: mutate,
    loader: { readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      const image = media.get(relativePath); if (!image || sha256(image) !== expectedChecksum) throw new Error('frozen original checksum mismatch'); return image;
    } },
    storeImage: async (input): Promise<ManagedMediaResult> => {
      stores.push(clone(input)); const checksum = sha256(input.dataUrl); const relativePath = `images/${checksum}.png`;
      media.set(relativePath, input.dataUrl);
      return { managed: true, missing: false, relativePath, checksum, url: `lianhua-asset://fixture/${relativePath}`,
        fileName: input.fileName || 'fixture.png', mimeType: 'image/png', mediaType: 'image', sizeBytes: input.dataUrl.length };
    },
    analyzeImage: async (api, image, requirement, signal) => { calls.push({ api: clone(api), image, requirement, signal }); return clone(result); },
    notify: (message) => { notices.push(message); },
  };
  const owner = () => state.project.id === project.id ? state.project : state.projects.find((value) => value.id === project.id)!;
  const tasks = () => owner().generationTasks.filter((task): task is ImagePromptReverseTask => task.kind === 'image-prompt-reverse');
  const editOwner = (edit: (project: AppState['project']) => AppState['project']) => mutate((value) => applyOwnedProjectUpdate(value, project.id, edit));
  const submit = async (customRequirement = '') => {
    const id = await submitImagePromptReverse(ctx, { referenceAssetId: reference.id, customRequirement });
    assert.ok(id); await bounded(waitForImagePromptReverseTask(id)); return id;
  };
  return { ctx, mutate, getState: () => state, owner, tasks, editOwner, calls, media, stores, notices, submit, projectId: project.id, reference };
};
let checks = 0;

// Pure image needs only vision; original bytes and exact pixel dimensions are retained.
{
  const f = fixture(); await f.submit(); const task = f.tasks()[0];
  assert.equal(task.status, 'succeeded'); assert.deepEqual(task.result, result); assert.equal(task.width, 2); assert.equal(task.height, 2);
  assert.equal(task.referenceAssetSnapshots.length, 1); assert.equal(task.referenceAssetSnapshots[0].dataUrl, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].image, png); assert.equal(f.calls[0].requirement, '');
  assert.equal(f.stores.length, 1); assert.equal(f.owner().assets.length, 1); checks++;
}
// Project, form, library and API changes after registration cannot retarget the original request.
{
  const f = fixture(); const gate = deferred(); const entered = deferred(); const store = f.ctx.storeImage!;
  f.ctx.storeImage = async (input) => { entered.resolve(); await gate.promise; return store(input); };
  const id = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id, customRequirement: '原要求：详细看材质' });
  assert.ok(id); await entered.promise; assert.equal(f.tasks()[0].status, 'queued');
  const other = { ...f.owner(), id: `${f.projectId}-other`, assets: [], generationTasks: [] };
  f.mutate((state) => ({ ...state, project: other, projects: [state.project, other], activeProjectId: other.id,
    settings: { ...state.settings, visionApi: { ...state.settings.visionApi, model: 'new-model' } } }));
  f.editOwner((project) => ({ ...project, assets: [] }));
  gate.resolve(); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.tasks()[0].status, 'succeeded'); assert.equal(f.getState().project.generationTasks.length, 0);
  assert.equal(f.calls[0].api.model, 'fixture-vision'); assert.equal(f.calls[0].requirement, '原要求：详细看材质');
  assert.equal(f.calls[0].image, png); checks++;
}
// Stop aborts the actual call; an undo snapshot and a late model answer never restore success.
{
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.ctx.analyzeImage = async (api, image, requirement, signal) => {
    f.calls.push({ api, image, requirement, signal }); entered.resolve(); await gate.promise; return result;
  };
  const id = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id }); assert.ok(id); await entered.promise;
  const source = clone(f.tasks()[0]); stopImagePromptReverse(f.ctx, source);
  assert.equal(f.tasks()[0].status, 'cancelled'); assert.equal(f.calls[0].signal?.aborted, true);
  f.editOwner((project) => ({ ...project, generationTasks: [source] }));
  gate.resolve(); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.tasks()[0].status, 'cancelled'); assert.equal(f.tasks()[0].result, undefined); checks++;
}
// Stop during media preparation performs no billable vision call.
{
  const f = fixture(); const gate = deferred(); const entered = deferred(); const store = f.ctx.storeImage!;
  f.ctx.storeImage = async (input) => { entered.resolve(); await gate.promise; return store(input); };
  const id = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id }); assert.ok(id); await entered.promise;
  stopImagePromptReverse(f.ctx, f.tasks()[0]); gate.resolve(); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.tasks()[0].status, 'cancelled'); assert.equal(f.calls.length, 0); checks++;
}
// A queued task can be stopped without starting, even when another reverse call is active.
{
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.ctx.analyzeImage = async (api, image, requirement, signal) => { f.calls.push({ api, image, requirement, signal }); entered.resolve(); await gate.promise; return result; };
  const first = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id }); assert.ok(first); await entered.promise;
  const second = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id, customRequirement: '另一次关注构图' }); assert.ok(second);
  assert.equal(f.tasks()[0].status, 'queued'); stopImagePromptReverse(f.ctx, f.tasks()[0]);
  gate.resolve(); await bounded(waitForImagePromptReverseTask(first)); await bounded(waitForImagePromptReverseTask(second));
  assert.equal(f.calls.length, 1); assert.equal(f.tasks()[0].status, 'cancelled'); checks++;
}
// Concurrent submission/double clicks register a single task, while a completed analysis can be deliberately repeated.
{
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.ctx.analyzeImage = async () => { entered.resolve(); await gate.promise; return result; };
  const [id, duplicate] = await Promise.all([
    submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id, customRequirement: '同一要求' }),
    submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id, customRequirement: '同一要求' }),
  ]);
  assert.ok(id); assert.equal(duplicate, undefined); assert.equal(f.tasks().length, 1); await entered.promise;
  gate.resolve(); await bounded(waitForImagePromptReverseTask(id));
  f.ctx.analyzeImage = async () => result;
  const repeat = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id, customRequirement: '同一要求' });
  assert.ok(repeat); await bounded(waitForImagePromptReverseTask(repeat)); assert.equal(f.tasks().length, 2); checks++;
}
// A removed pending task is never resurrected by the worker.
{
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.ctx.analyzeImage = async () => { entered.resolve(); await gate.promise; return result; };
  const id = await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id }); assert.ok(id); await entered.promise;
  f.editOwner((project) => ({ ...project, generationTasks: [] })); gate.resolve(); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.tasks().length, 0); checks++;
}
// Retry creates a new record using original pixels/requirement and current model; double clicks produce one retry.
{
  const f = fixture(); await f.submit('旧要求'); const original = clone(f.tasks()[0]);
  f.editOwner((project) => ({ ...project, assets: [] }));
  f.mutate((state) => ({ ...state, settings: { ...state.settings, visionApi: { ...state.settings.visionApi, model: 'current-vision' } } }));
  const [id, duplicate] = await Promise.all([retryImagePromptReverse(f.ctx, original), retryImagePromptReverse(f.ctx, original)]);
  assert.ok(id); assert.equal(duplicate, undefined); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.tasks().length, 2); assert.equal(f.tasks()[1].id, original.id); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].image, png); assert.equal(f.calls[1].requirement, '旧要求'); assert.equal(f.calls[1].api.model, 'current-vision');
  assert.equal(f.tasks()[0].model, 'current-vision'); checks++;
}
// Missing/corrupt frozen media fails visibly and never substitutes library pixels.
{
  const f = fixture(); await f.submit(); const source = clone(f.tasks()[0]); f.media.clear();
  const id = await retryImagePromptReverse(f.ctx, source); assert.ok(id); await bounded(waitForImagePromptReverseTask(id));
  assert.equal(f.calls.length, 1); assert.equal(f.tasks()[0].status, 'failed'); assert.match(f.tasks()[0].error!, /checksum/u); checks++;
}
// Empty or malformed results and service failures cannot be saved as success.
{
  const f = fixture(); f.ctx.analyzeImage = async () => ({ prompt: '残缺' } as ImagePromptReverseResult); await f.submit();
  assert.equal(f.tasks()[0].status, 'failed'); assert.equal(f.tasks()[0].result, undefined); checks++;
}
// Capability validation precedes task creation; a non-image is represented as a failed preparation task.
{
  const f = fixture(); f.mutate((state) => ({ ...state, settings: { ...state.settings, visionApi: { ...state.settings.visionApi, enabled: false } } }));
  assert.equal(await submitImagePromptReverse(f.ctx, { referenceAssetId: f.reference.id }), undefined); assert.equal(f.tasks().length, 0);
  f.mutate((state) => ({ ...state, settings: { ...state.settings, visionApi: { ...state.settings.visionApi, enabled: true } } }));
  f.editOwner((project) => ({ ...project, assets: [{ ...f.reference, type: 'audio', mediaType: 'audio' }] }));
  await f.submit(); assert.equal(f.tasks()[0].status, 'failed'); assert.equal(f.calls.length, 0); checks++;
}
console.log(`image prompt reverse worker: ${checks} check groups passed`);
