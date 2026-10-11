import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitialState, normalizeState, serializeStateForStorage, type ManagedMediaResult } from '../src/storage';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import { submitCustomImage, retryCustomImageTask, retryCustomImageSave, waitForCustomImageTask, type CustomImageGenerationContext } from '../src/customImageGeneration';
import { cancelQueuedGenerationTask, removeGenerationTask, revokeQueuedGenerationTask } from '../src/generationTasks';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { resolveImageAssetRegenerationTask } from '../src/imageRegeneration';
import type { AppState, ImageApiConfig, ImageGenerationTask, ReferenceAsset } from '../src/types';
import type { ImageGenerationOptions } from '../src/services/llm';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const sizePreference = { mode: 'custom' as const, aspect: '1:1' as const, width: 768, height: 768, resolutionVersion: 1 as const };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not settle')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
let fixtureId = 0;
const fixture = () => {
  const initial = createInitialState();
  const project = { ...initial.project, id: `custom-image-fixture-${++fixtureId}`, name: '自定义项目', generationTasks: [], assets: [] };
  let state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id,
    settings: { ...initial.settings, imageApiProfiles: [], activeImageApiProfileId: null,
      textApi: { ...initial.settings.textApi, enabled: false, baseUrl: '', model: '' },
      imageApi: { enabled: true, backend: 'openai', baseUrl: 'https://custom-image.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' } },
  };
  const calls: Array<{ api: ImageApiConfig; input: ImageGenerationOptions }> = [];
  const conversions: Array<Parameters<NonNullable<CustomImageGenerationContext['convertPrompt']>>[1]> = [];
  const stores: Array<{ dataUrl: string; fileName?: string }> = [];
  const downloads: string[] = [];
  const messages: string[] = [];
  const media = new Map<string, string>();
  const mutate = (updater: (current: AppState) => AppState) => { state = updater(state); };
  const ctx: CustomImageGenerationContext = {
    getState: () => state, update: mutate, updateBackground: mutate,
    loader: {
      readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
        const data = media.get(relativePath); if (!data || sha256(data) !== expectedChecksum) throw new Error('missing frozen reference'); return data;
      },
      downloadImage: async (remote) => { downloads.push(typeof remote === 'string' ? remote : remote.url); return png; },
    },
    storeImage: async (payload): Promise<ManagedMediaResult> => {
      stores.push({ ...payload }); const checksum = sha256(payload.dataUrl); const relativePath = `images/${checksum}.png`; media.set(relativePath, payload.dataUrl);
      return { managed: true, missing: false, relativePath, checksum, sizeBytes: payload.dataUrl.length,
        fileName: payload.fileName || 'fixture.png', mimeType: 'image/png', mediaType: 'image', url: `lianhua-asset://fixture/${relativePath}` };
    },
    generateImage: async (api, options, onStart) => {
      await onStart?.(); assert.equal(typeof options, 'object'); calls.push({ api: clone(api), input: clone(options as ImageGenerationOptions) }); return { dataUrl: png };
    },
    convertPrompt: async (_api, input) => { conversions.push(clone(input)); return '明确转换的最终提示词'; },
    notify: (message) => { messages.push(message); },
  };
  const owner = () => state.project.id === project.id ? state.project : state.projects.find((item) => item.id === project.id)!;
  const tasks = () => owner().generationTasks.filter((item): item is ImageGenerationTask => item.kind === 'image');
  const run = async (input: Partial<Parameters<typeof submitCustomImage>[1]> = {}) => {
    const id = await submitCustomImage(ctx, { userPrompt: '画一片莲花', sizePreference, ...input });
    if (id) await bounded(waitForCustomImageTask(id)); return id;
  };
  const retry = async (task: ImageGenerationTask, reconvert = false) => {
    await retryCustomImageTask(ctx, task, { reconvert }); const latest = tasks()[0];
    if (latest && latest.id !== task.id) await bounded(waitForCustomImageTask(latest.id)); return tasks().find((item) => item.id === latest.id)!;
  };
  return { ctx, calls, conversions, stores, downloads, messages, media, mutate, getState: () => state, owner, tasks, run, retry, projectId: project.id };
};
const reference = (id: string): ReferenceAsset => ({ id, name: `参考 ${id}`, type: 'reference', role: 'composition', mediaType: 'image', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 });

// Default direct requests preserve the message and ignore the rule/text paths.
{
  const f = fixture();
  f.mutate((state) => ({ ...state, imagePromptRules: null as unknown as AppState['imagePromptRules'] }));
  const userPrompt = '  画荷花 | 保留这行\n  不添加人物规则  ';
  await f.run({ userPrompt, ruleSetId: 'deleted-rule' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.prompt, userPrompt);
  assert.equal(f.calls[0].input.promptMode, 'verbatim'); assert.equal(f.conversions.length, 0);
  assert.deepEqual(f.calls[0].input.referenceImages, []);
  assert.equal(f.calls[0].input.width, 768); assert.equal(f.calls[0].input.height, 768);
  assert.equal(f.tasks()[0].status, 'succeeded'); assert.equal(f.owner().assets.length, 1);
  const asset = f.owner().assets[0]; assert.ok(asset.managed); assert.equal(asset.dataUrl, undefined);
  assert.equal(asset.customImageInput?.userPrompt, userPrompt); assert.equal(asset.imageRegenerationSnapshot?.sourceKind, 'custom');
  // Removing the visible task does not lose its frozen retry facts.
  f.mutate((state) => applyOwnedProjectUpdate(state, f.projectId, (project) => ({ ...project, generationTasks: [] })));
  const restored = resolveImageAssetRegenerationTask(asset, f.owner(), f.getState().settings.imageApi);
  assert.equal(restored?.assetKind, 'custom'); assert.equal(restored?.prompt, userPrompt);
  assert.deepEqual(restored?.referenceAssetSnapshots, []);
  assert.ok(restored);
  await retryCustomImageTask(f.ctx, { ...restored!, prompt: 'tampered restored prompt' });
  assert.equal(f.calls.length, 1); assert.equal(f.tasks().length, 0);
  const recovered = await f.retry(restored!);
  assert.equal(recovered.status, 'succeeded'); assert.equal(f.calls.length, 2);
}

// Two controls retrying one family concurrently create one new queued request.
{
  const f = fixture(); await f.run(); const source = clone(f.tasks()[0]);
  const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise);
  await Promise.all([retryCustomImageTask(f.ctx, source), retryCustomImageTask(f.ctx, source)]);
  assert.equal(f.tasks().length, 2); const retry = f.tasks()[0]; assert.notEqual(retry.id, source.id);
  assert.notEqual(retry.name, source.name);
  gate.resolve(); await blocker; await bounded(waitForCustomImageTask(retry.id));
  assert.equal(f.calls.length, 2); assert.equal(f.tasks()[0].status, 'succeeded');
}

// Reference selection and ownership are fixed before a project or API switch.
{
  const f = fixture(); const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise);
  f.mutate((state) => applyOwnedProjectUpdate(state, f.projectId, (project) => ({ ...project, assets: [reference('b'), reference('a')] })));
  const id = await submitCustomImage(f.ctx, { userPrompt: '只按这两张参考绘制', sizePreference, referenceAssetIds: ['b', 'a'] }); assert.ok(id);
  // Let reference preparation finish before replacing the library originals.
  await Promise.resolve(); await Promise.resolve();
  const other = { ...f.owner(), id: 'other-project', name: '后来切换的项目', assets: [], generationTasks: [] };
  f.mutate((state) => ({ ...state, project: other, projects: [state.project, other], activeProjectId: other.id,
    settings: { ...state.settings, imageApi: { ...state.settings.imageApi, model: 'later-model' } } }));
  f.mutate((state) => applyOwnedProjectUpdate(state, f.projectId, (project) => ({ ...project, assets: [] })));
  gate.resolve(); await blocker; await bounded(waitForCustomImageTask(id!));
  assert.equal(f.calls[0].api.model, 'fixture-model'); assert.deepEqual(f.calls[0].input.referenceImages, [png, png]);
  assert.deepEqual(f.tasks()[0].referenceAssetSnapshots?.map((asset) => asset.id), ['b', 'a']);
  assert.equal(f.owner().assets.length, 1); assert.equal(f.getState().project.assets.length, 0);
}

// An explicit selected rule is frozen, and failure never falls back to raw.
{
  const f = fixture(); const rule = f.getState().imagePromptRules.ruleSets.find((item) => item.enabled && item.format === 'natural-language')!;
  f.mutate((state) => ({ ...state, settings: { ...state.settings, textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://text.invalid', model: 'text-fixture' } } }));
  f.ctx.convertPrompt = async (_api, input) => { f.conversions.push(clone(input)); throw new Error('conversion intentionally failed'); };
  await f.run({ promptMode: 'rules', ruleSetId: rule.id });
  assert.equal(f.calls.length, 0); assert.equal(f.tasks()[0].status, 'failed'); assert.match(f.tasks()[0].error || '', /规则转换未完成/u);
  const failed = clone(f.tasks()[0]); const frozen = clone(failed.customImageInput!.ruleSelection!);
  f.mutate((state) => ({ ...state, imagePromptRules: { ...state.imagePromptRules, ruleSets: state.imagePromptRules.ruleSets.filter((item) => item.id !== rule.id) } }));
  f.ctx.convertPrompt = async (_api, input) => { f.conversions.push(clone(input)); return '最终画面'; };
  const retried = await f.retry(failed);
  assert.equal(retried.status, 'succeeded'); assert.deepEqual(f.conversions[1].rule, frozen);
  assert.equal(f.calls[0].input.prompt, '最终画面'); assert.equal(retried.customImageInput?.operation, 'reconvert');
  // A normal retry uses the exact final prompt, with no text API requirement.
  f.mutate((state) => ({ ...state, settings: { ...state.settings, textApi: { ...state.settings.textApi, enabled: false } } }));
  const finalRetry = await f.retry(clone(retried));
  assert.equal(finalRetry.status, 'succeeded'); assert.equal(f.conversions.length, 2); assert.equal(f.calls[1].input.prompt, '最终画面');
  assert.equal(finalRetry.customImageInput?.operation, 'saved-final');
}

// Cancelled or revoked queue entries cannot be submitted by a waiting worker.
for (const remove of [false, true]) {
  const f = fixture(); const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise);
  const id = await submitCustomImage(f.ctx, { userPrompt: '排队期间可以取消', sizePreference }); assert.ok(id);
  const task = f.tasks()[0];
  if (remove) {
    revokeQueuedGenerationTask(f.projectId, task);
    f.mutate((state) => applyOwnedProjectUpdate(state, f.projectId, (project) => ({ ...project, generationTasks: removeGenerationTask(project.generationTasks, task.id).tasks })));
  } else {
    f.mutate((state) => applyOwnedProjectUpdate(state, f.projectId, (project) => ({ ...project, generationTasks: cancelQueuedGenerationTask(project.generationTasks, task.id).tasks })));
  }
  gate.resolve(); await blocker; await bounded(waitForCustomImageTask(id!));
  assert.equal(f.calls.length, 0); assert.equal(f.owner().assets.length, 0);
  if (remove) assert.equal(f.tasks().length, 0); else assert.equal(f.tasks()[0].status, 'cancelled');
}

// Saving can resume after a failed write and state reload, without new charges.
{
  const f = fixture(); const store = f.ctx.storeImage!; let writes = 0;
  f.ctx.storeImage = async (payload) => { if (++writes === 1) throw new Error('disk temporarily unavailable'); return store(payload); };
  await f.run(); const pending = clone(f.tasks()[0]);
  assert.equal(pending.status, 'failed'); assert.equal(pending.customImageSavePending, true); assert.equal(pending.resultUrl, png);
  assert.equal(f.owner().assets.length, 0); assert.equal(f.calls.length, 1);
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(f.getState()).serialized));
  f.mutate(() => reloaded);
  await retryCustomImageSave(f.ctx, f.tasks()[0]); await retryCustomImageSave(f.ctx, f.tasks()[0]);
  assert.equal(f.calls.length, 1); assert.equal(f.tasks()[0].status, 'succeeded'); assert.equal(f.tasks()[0].customImageSavePending, false);
  assert.equal(f.owner().assets.length, 1);
}

// A returned remote URL is not reported successful until it is downloaded.
{
  const f = fixture(); let downloads = 0;
  f.ctx.generateImage = async (_api, _options, onStart) => { await onStart?.(); f.calls.push({ api: f.getState().settings.imageApi, input: {} as ImageGenerationOptions }); return { url: 'https://result.invalid/original.png' }; };
  f.ctx.loader.downloadImage = async () => { if (++downloads === 1) throw new Error('download unavailable'); return png; };
  await f.run(); assert.equal(f.tasks()[0].customImageSavePending, true); assert.equal(f.owner().assets.length, 0);
  await retryCustomImageSave(f.ctx, f.tasks()[0]);
  assert.equal(downloads, 2); assert.equal(f.calls.length, 1); assert.equal(f.tasks()[0].status, 'succeeded'); assert.ok(f.owner().assets[0].managed);
}

// Invalid API/rule/reference inputs fail closed before billable work.
{
  const f = fixture();
  assert.equal(await f.run({ promptMode: 'rules', ruleSetId: 'missing' }), undefined);
  assert.equal(await f.run({ referenceAssetIds: ['missing'] }), undefined);
  f.mutate((state) => ({ ...state, settings: { ...state.settings, imageApi: { ...state.settings.imageApi, backend: 'sd_webui' } } }));
  assert.equal(await f.run({ referenceAssetIds: ['a', 'b'] }), undefined); assert.equal(f.calls.length, 0); assert.equal(f.tasks().length, 0);
}

// Retrying a generated task cannot quietly change the selected image service.
{
  const f = fixture(); await f.run(); const source = clone(f.tasks()[0]);
  f.mutate((state) => ({ ...state, settings: { ...state.settings, imageApi: { ...state.settings.imageApi, baseUrl: 'https://other-service.invalid/v1' } } }));
  await retryCustomImageTask(f.ctx, source); assert.equal(f.calls.length, 1); assert.equal(f.tasks().length, 1);
  assert.ok(f.messages.some((message) => message.includes('不会把原任务发送到其他服务')));
}

console.log('Custom image generation behavior checks passed.');
