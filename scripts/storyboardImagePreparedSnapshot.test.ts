import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitialState } from '../src/storage';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { generateDirectStoryboardImages, type DirectStoryboardImageGenerationContext } from '../src/storyboardImageToImageGeneration';
import type { AppState, ImageGenerationTask, Storyboard } from '../src/types';
import type { ImageGenerationOptions } from '../src/services/llm';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async (promise: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Prepared snapshot fixture timed out')), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

const initial = createInitialState();
const board: Storyboard = {
  id: 'captured-board', sceneId: 'captured-scene', workflow: 'drama', inputMode: 'reference',
  durationSec: 3, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'cinematic',
  ruleSetId: 'h3', converterPresetId: 'h3', globalLock: '',
  // Old boards without chapterId still match only their own authored chapter.
  sourceStoryContent: '原剧情：人物站在原来的门旁。', finalPrompt: '原来镜头的有效正文',
  officialPromptZh: 'detailed_description: [Shot 1] 原画面：人物站在旧门旁，保持原来的静帧。',
  shots: [{ id: 'captured-shot', index: 1, startSec: 0, endSec: 3, purpose: '开场', subject: '人物',
    action: '站在旧门旁', camera: '中景', transition: 'cut', lighting: '暖光', sound: '', result: '静立',
    dialogue: '', referenceAssetIds: [], prompt: '原画面：人物站在旧门旁', locked: false }],
  imageToImage: { referenceAssetIds: ['captured-reference'], selectedShotIds: [], referenceAssetIdsByShotId: {} },
  createdAt: 1, updatedAt: 1,
};
const project = {
  ...initial.project, id: 'captured-project', name: 'Prepared snapshot fixture', storyboards: [board],
  characters: [], locations: [], props: [], scenes: [], generationTasks: [],
  sourceDocuments: [
    { id: 'own-chapter', name: '本章', content: board.sourceStoryContent!, createdAt: 1, updatedAt: 1 },
    { id: 'other-chapter', name: '另一章', content: '另一个章节的剧情', createdAt: 1, updatedAt: 1 },
  ],
  assets: [{ id: 'captured-reference', name: '原图', type: 'reference' as const, role: 'character' as const,
    dataUrl: png, mediaType: 'image' as const, tags: [], createdAt: 1, updatedAt: 1 }],
};
let state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id,
  settings: { ...initial.settings, imageApiProfiles: [], activeImageApiProfileId: null,
    textApi: { ...initial.settings.textApi, enabled: true, baseUrl: 'https://text.fixture.invalid/v1', model: 'captured-text-model' },
    imageApi: { enabled: true, backend: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture-model' },
    storyboardImageOutputSize: { mode: '1k', width: 1024, height: 1024 } } };
const preparationStarted = deferred();
const preparationGate = deferred();
const prepared = deferred();
const queueGate = deferred();
const blocker = enqueueImageTask(() => queueGate.promise);
const media = new Map<string, string>();
const calls: ImageGenerationOptions[] = [];
const conversionCalls: { source: string; model: string }[] = [];
const imageApiModels: string[] = [];
const update: DirectStoryboardImageGenerationContext['update'] = (updater) => {
  state = updater(state);
  if (state.project.generationTasks.some((task) => task.kind === 'image'
    && task.status === 'queued' && !task.preparationStage && task.imageApiSnapshot)) prepared.resolve();
};
const ctx: DirectStoryboardImageGenerationContext = {
  getState: () => state, update, updateBackground: update, lifecycle: createStoryboardImageBatchLifecycle(),
  loader: { readManagedImageDataUrl: async ({ relativePath }) => {
    const dataUrl = media.get(relativePath);
    assert.ok(dataUrl);
    return dataUrl;
  } },
  storeImage: async (payload) => {
    if (payload.fileName?.includes('图生图参考')) {
      preparationStarted.resolve();
      await preparationGate.promise;
    }
    const checksum = createHash('sha256').update(payload.dataUrl).digest('hex');
    const relativePath = `images/${checksum}.png`;
    media.set(relativePath, payload.dataUrl);
    return { relativePath, checksum, fileName: payload.fileName || 'fixture.png', managed: true, missing: false,
      sizeBytes: payload.dataUrl.length, mediaType: 'image', mimeType: 'image/png', url: `lianhua-asset://fixture/${relativePath}` };
  },
  convertPrompt: async (api, _kind, source) => {
    conversionCalls.push({ source, model: api.model });
    assert.match(source, /旧门/u, 'the converter receives the prepared authored text snapshot');
    assert.doesNotMatch(source, /新窗|data:image/u);
    const frozenLocation = source.match(/旧门/u)![0];
    return `一名人物站在${frozenLocation}旁，中景构图，温暖柔和的光线照亮人物和门框。`;
  },
  generateImage: async (api, input, onStart) => {
    await onStart?.();
    imageApiModels.push(api.model);
    calls.push(input as ImageGenerationOptions);
    return { dataUrl: png };
  },
  notify: () => undefined,
  reportError: (error) => { throw error; },
};
const pending = generateDirectStoryboardImages(ctx, project.id, board.id);
try {
  await bounded(preparationStarted.promise);
  const originalTaskId = state.project.generationTasks[0].id;
  state = { ...state, project: { ...state.project, sourceDocuments: state.project.sourceDocuments.map((document) =>
    document.id === 'other-chapter' ? { ...document, content: '另一章已编辑，不影响本章准备' } : document) } };
  preparationGate.resolve();
  await bounded(prepared.promise);
  assert.equal(calls.length, 0, 'prepared requests still wait behind existing FIFO image work');
  assert.equal(conversionCalls.length, 0, 'conversion also waits for the prepared request to reach the queue');
  const captured = state.project.generationTasks[0] as ImageGenerationTask;
  assert.equal(captured.id, originalTaskId);
  assert.equal(captured.status, 'queued');
  assert.equal(captured.prompt, '', 'local framing instructions are not stored as a final image prompt');
  assert.match(captured.conversionSource || '', /旧门/u);
  assert.match(captured.converterSystemPrompt || '', /当前目标静帧/u);
  state = { ...state, project: { ...state.project,
    sourceDocuments: state.project.sourceDocuments.map((document) => document.id === 'own-chapter'
      ? { ...document, content: '本章现在改成了新的剧情' } : document),
    storyboards: state.project.storyboards.map((item) => ({ ...item, finalPrompt: '新的镜头正文',
      officialPromptZh: 'detailed_description: [Shot 1] 新画面：人物站在新窗旁。',
      shots: item.shots.map((shot) => ({ ...shot, action: '站在新窗旁' })) })),
    assets: state.project.assets.map((asset) => ({ ...asset, dataUrl: 'data:image/png;base64,Y2hhbmdlZC1waXhlbHM=' })),
  }, settings: { ...state.settings,
    imageApi: { ...state.settings.imageApi, model: 'new-image-model' },
    textApi: { ...state.settings.textApi, model: 'new-text-model' },
  } };
  queueGate.resolve();
  await bounded(Promise.all([blocker, pending]));
  assert.equal(calls.length, 1, 'source edits after preparation cannot silently discard an already queued frozen request');
  assert.equal(conversionCalls.length, 1);
  assert.equal(conversionCalls[0].source, captured.conversionSource);
  assert.equal(conversionCalls[0].model, 'captured-text-model');
  assert.deepEqual(imageApiModels, ['fixture-model']);
  assert.deepEqual(calls[0].referenceImages, [png], 'image requests retain the original prepared reference pixels');
  assert.equal(calls[0].preserveReferenceImageOrder, true);
  assert.match(calls[0].prompt, /旧门/u);
  assert.doesNotMatch(calls[0].prompt, /新窗/u);
  assert.doesNotMatch(calls[0].prompt, /静帧取景/u, 'the image API receives the converted picture description');
  assert.equal(state.project.generationTasks[0].id, originalTaskId);
  assert.equal(state.project.generationTasks[0].status, 'succeeded');
  assert.equal((state.project.generationTasks[0] as ImageGenerationTask).preparationStage, undefined);
  assert.equal((state.project.generationTasks[0] as ImageGenerationTask).prompt, calls[0].prompt);
  assert.match(state.project.storyboards[0].officialPromptZh || '', /新窗/u);
  console.log('Prepared storyboard snapshot: ready FIFO tasks convert captured H3 text and retain original references/API after live edits, with a terminal task record.');
} finally {
  preparationGate.resolve();
  queueGate.resolve();
  await bounded(Promise.all([blocker, pending]));
}
