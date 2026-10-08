import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import { cancelQueuedGenerationTask, removeGenerationTask, revokeQueuedGenerationTask } from '../src/generationTasks';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { createInitialState, type ManagedMediaResult } from '../src/storage';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { resolveImageApiForRegeneration } from '../src/imageApiSelection';
import { resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import { generateDirectStoryboardImages, updateStoryboardImageToImageSettings, type DirectStoryboardImageErrorDetail, type DirectStoryboardImageGenerationContext, type DirectStoryboardImageGenerationOptions } from '../src/storyboardImageToImageGeneration';
import { TextModelResponseError, type ImageGenerationOptions } from '../src/services/llm';
import type { AppState, ImageApiConfig, ImageGenerationTask, ReferenceAsset, Storyboard, TextApiConfig, VideoShot } from '../src/types';

const pngA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const pngB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture did not settle within five seconds')), 5000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const makeShot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 3, endSec: index * 3,
  purpose: `第${index}镜目的`, subject: `第${index}镜主体`, action: `第${index}镜原动作`,
  camera: '中景、平视', transition: 'cut', lighting: '自然光', sound: '不应送给生图的旧音效',
  dialogue: '不应送给生图的旧对白', result: '可见结果', referenceAssetIds: ['legacy-shot-reference'],
  prompt: '保留旧H3相关字段，不允许图生图重写', locked: false,
});
const makeBoard = (): Storyboard => ({
  id: 'board-2', sceneId: 'scene-1', segmentIndex: 2, segmentCount: 4,
  workflow: 'drama', inputMode: 'reference', durationSec: 12, durationPreset: 'custom',
  shotMode: 'exact', shotCount: 4, pace: 'standard', aspectRatio: '16:9', resolution: '2K',
  audioMode: 'stereo', stylePresetId: 'cinematic', ruleSetId: 'h3', converterPresetId: 'h3',
  globalLock: '旧全局身份资料保留', globalReferenceAssetIds: ['legacy-global-reference'],
  shots: [1, 2, 3, 4].map(makeShot), finalPrompt: '保持原始 H3 源稿字节',
  officialPromptZh: [
    'subject_definitions: <Subject 1> 阿莲；<Subject 2> 守卫',
    'summary: 不要发送全片剧情摘要',
    'retention_analysis: 保留人物关系',
    'detailed_description: Warm moonlight.',
    '[Shot 1] 第一镜原画面。',
    '[Shot 2] At 00:03.000, 第二镜独有原画面，人物伸出右手。(S1)说<d>[Chinese] 不要画出来的对白。</d>',
    '[Shot 3] At 00:06.000, 第三镜原画面。',
    '[Shot 4] At 00:09.000, 第四镜独有原画面，人物向大门前行。',
    'overall_soundscape: 不要发送的风声',
    'non_diegetic_music: 不要发送的背景音乐',
  ].join('\n'),
  officialPromptEn: 'Unchanged existing English H3 result', firstFrameAssetId: 'existing-first', lastFrameAssetId: 'existing-last',
  imageToImage: {
    referenceAssetIds: ['b', 'a'], selectedShotIds: ['shot-4', 'shot-2'],
    referenceAssetIdsByShotId: { 'shot-2': ['a'], 'shot-4': ['b', 'a'], 'shot-1': ['unselected-reference'] },
  },
  createdAt: 100, updatedAt: 101,
});
const makeImage = (id: string, dataUrl = pngA): ReferenceAsset => ({
  id, name: `参考原图 ${id} · 第 2 段`, type: 'reference', role: 'character',
  dataUrl, referenceScope: 'general', mediaType: 'image', tags: [], createdAt: 1, updatedAt: 1,
});

let fixtureIndex = 0;
const fixture = () => {
  const initial = createInitialState();
  const project = {
    ...initial.project, id: `direct-i2i-project-${++fixtureIndex}`, name: 'Direct image fixture',
    storyboards: [makeBoard()], characters: [], locations: [], props: [], scenes: [], generationTasks: [],
    assets: [makeImage('a'), makeImage('b', pngB), makeImage('legacy-shot-reference'), makeImage('legacy-global-reference')],
  };
  let state: AppState = {
    ...initial, project, projects: [project], activeProjectId: project.id,
    settings: {
      ...initial.settings,
      textApi: { ...initial.settings.textApi, enabled: false, baseUrl: '', apiKey: '', model: '' },
      imageApiProfiles: [], activeImageApiProfileId: null,
      imageApi: { enabled: true, backend: 'openai', baseUrl: 'https://fixture-image.invalid/v1', apiKey: 'fixture-only-never-transmitted', model: 'fixture-image-model' },
      storyboardImageOutputSize: { mode: '4k', width: 1024, height: 1024 },
    },
  };
  const queued = deferred();
  const calls: Array<{ api: ImageApiConfig; input: ImageGenerationOptions }> = [];
  const stores: Array<{ dataUrl: string; fileName?: string }> = [];
  const reads: string[] = [];
  const media = new Map<string, { dataUrl: string; checksum: string }>();
  const notices: Array<{ message: string; tone?: 'normal' | 'error' }> = [];
  const reported: unknown[] = [];
  const reportDetails: Array<DirectStoryboardImageErrorDetail | undefined> = [];
  const imageTasks = () => state.project.generationTasks.filter((task): task is ImageGenerationTask => task.kind === 'image');
  const update = (updater: (current: AppState) => AppState) => {
    state = updater(state);
    if (imageTasks().some((task) => task.status === 'queued')) queued.resolve();
  };
  const ctx: DirectStoryboardImageGenerationContext = {
    getState: () => state, update, updateBackground: update, lifecycle: createStoryboardImageBatchLifecycle(),
    loader: { readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      reads.push(relativePath);
      const saved = media.get(relativePath);
      if (!saved || expectedChecksum !== saved.checksum) throw new Error('Fixture managed image missing or checksum mismatch');
      return saved.dataUrl;
    } },
    storeImage: async (payload): Promise<ManagedMediaResult> => {
      stores.push({ ...payload });
      const checksum = sha256(payload.dataUrl);
      const relativePath = `images/${checksum}.png`;
      media.set(relativePath, { dataUrl: payload.dataUrl, checksum });
      return { relativePath, checksum, fileName: payload.fileName || 'fixture.png', managed: true, missing: false,
        sizeBytes: payload.dataUrl.length, mediaType: 'image', mimeType: 'image/png', url: `lianhua-asset://fixture/${relativePath}` };
    },
    generateImage: async (api, input, onStart) => {
      assert.equal(typeof input, 'object');
      await onStart?.();
      calls.push({ api: clone(api), input: clone(input as ImageGenerationOptions) });
      return { dataUrl: pngA };
    },
    notify: (message, tone) => { notices.push({ message, tone }); },
    reportError: (error, detail) => { reported.push(error); reportDetails.push(detail); },
  };
  const run = (options?: DirectStoryboardImageGenerationOptions) => generateDirectStoryboardImages(ctx, project.id, 'board-2', options);
  return { ctx, calls, stores, reads, media, notices, reported, reportDetails, queued, imageTasks, run, getState: () => state, mutate: update, projectId: project.id };
};
const boardWithoutImageSettings = (board: Storyboard): string => {
  const { imageToImage: _settings, ...content } = board;
  return JSON.stringify(content);
};
const waitQueued = async (instance: ReturnType<typeof fixture>, pending: Promise<void>) => bounded(Promise.race([
  instance.queued.promise,
  pending.then(() => {
    assert.ok(instance.imageTasks().length, `Expected queued jobs: ${instance.notices.map((notice) => notice.message).join('; ')}`);
  }),
]));
const prepareCustomPlanner = (instance: ReturnType<typeof fixture>, count: number, pause?: Promise<void>) => {
  const started = deferred();
  const calls: Array<{ api: TextApiConfig; system: string; user: string }> = [];
  const frames = Array.from({ length: count }, (_, index) => ({
    sourceShotId: index < 3 ? 'shot-2' : 'shot-4',
    description: `规划静帧 ${index + 1}：同一原镜头中独立可见的动作时刻。`,
    timeSec: index < 3 ? 3 + index * 0.5 : 9 + (index - 3) * 0.5,
  }));
  instance.mutate((state) => ({ ...state, settings: { ...state.settings,
    textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://fixture-text.invalid/v1', model: 'frozen-text-model', apiKey: 'frozen-text-key' },
  } }));
  instance.ctx.requestText = async (api, system, user, _signal, options) => {
    assert.equal(options?.referenceImages, undefined, 'static-frame planning receives no image pixels');
    calls.push({ api: clone(api), system, user });
    started.resolve();
    await pause;
    return JSON.stringify(frames);
  };
  return { started, calls, frames };
};

const originalFetch = globalThis.fetch;
let unexpectedNetworkCalls = 0;
globalThis.fetch = async () => {
  unexpectedNetworkCalls += 1;
  throw new Error('No real network requests are allowed in the direct image controller test');
};

try {
  const success = fixture();
  const originalBoard = boardWithoutImageSettings(success.getState().project.storyboards[0]);
  await bounded(success.run());
  assert.equal(success.getState().settings.textApi.enabled, false);
  assert.equal(success.calls.length, 4, 'default generates all source shots with the text API disabled and ignores historical shot picks');
  assert.deepEqual(success.calls.map((call) => call.input.referenceImages), Array.from({ length: 4 }, () => [pngB, pngA]), 'all images use the current public originals in order; legacy per-shot and video references never enter');
  assert.deepEqual(success.calls.map((call) => [call.input.width, call.input.height, call.input.sizeOverride]), Array.from({ length: 4 }, () => [4096, 2304, true]), 'the image-workbench resolution is the exact submitted pixel request');
  assert.deepEqual(success.calls.map((call) => [call.input.primaryReferenceImageCount, call.input.preserveReferenceImageOrder]), Array.from({ length: 4 }, () => [2, true]));
  assert.match(success.calls[1].input.prompt, /第二镜独有原画面/u);
  assert.doesNotMatch(success.calls[1].input.prompt, /第四镜独有原画面|不要发送|不要画出来的对白|旧音效|旧对白/u);
  assert.match(success.calls[3].input.prompt, /第四镜独有原画面/u);
  assert.equal(boardWithoutImageSettings(success.getState().project.storyboards[0]), originalBoard, 'all H3, video refs, frame bindings, shot fields and board timestamps remain byte-for-byte unchanged');
  assert.equal(success.stores.filter((store) => store.fileName?.includes('图生图参考')).length, 2, 'a reference shared across shots is frozen only once before queueing');
  assert.ok(success.imageTasks().every((task) => task.status === 'succeeded' && task.imageGenerationMode === 'image-to-image'));
  assert.deepEqual(success.imageTasks().map((task) => task.sourceShotId), ['shot-1', 'shot-2', 'shot-3', 'shot-4']);
  const frozenTasks = JSON.stringify(success.imageTasks());
  assert.ok(!frozenTasks.includes('data:image/') && !frozenTasks.includes('fixture-only-never-transmitted'), 'persisted task snapshots contain neither embedded pixels nor credentials');
  const generatedAssets = success.getState().project.assets.filter((asset) => asset.source === 'generated');
  assert.equal(generatedAssets.length, 4);
  assert.deepEqual(new Set(generatedAssets.map((asset) => asset.sourceShotId)), new Set(['shot-1', 'shot-2', 'shot-3', 'shot-4']));
  assert.ok(generatedAssets.every((asset) => asset.sourceStoryboardId === 'board-2' && asset.width === 2 && asset.height === 2));
  assert.ok(generatedAssets.every((asset) => asset.imageGenerationMode === 'image-to-image'
    && asset.imageRegenerationSnapshot?.referenceAssetSnapshots.length === 2), 'actual result assets retain their safe direct retry inputs');
  assert.ok(generatedAssets.every((asset) => asset.imageRequestSize?.width === 4096 && asset.imageRequestSize?.height === 2304), 'actual encoded size stays distinct from requested size');
  assert.equal(success.reported.length, 0);
  const resultOnly = { ...success.getState().project, assets: [generatedAssets[0]], generationTasks: [], storyboards: [] };
  const recoveredResult = resolveImageAssetRegenerationTask(generatedAssets[0], resultOnly, success.getState().settings.imageApi)!;
  assert.equal(recoveredResult.imageGenerationMode, 'image-to-image');
  assert.deepEqual(recoveredResult.referenceAssetSnapshots?.map((reference) => reference.id), ['b', 'a']);
  assert.equal(resolveImageRegenerationSource(recoveredResult, resultOnly).converterSystemPrompt, '');
  const recoveredApi = await resolveImageApiForRegeneration({ ...success.getState().settings,
    imageApi: { ...success.getState().settings.imageApi, model: 'later-selected-model' },
  }, recoveredResult.imageApiSnapshot);
  assert.equal(recoveredApi.model, 'fixture-image-model', 'a real controller result restores its original model after task and original-card deletion');

  const micro = fixture();
  const converterCalls: Array<{ api: TextApiConfig; kind: string; source: string; format: string; rules: string; identityContext: string }> = [];
  micro.mutate((state) => ({ ...state, project: {
    ...state.project,
    description: '本项目的作品归属与角色资料来自原创故事《晨星巡航》。',
    storyDraft: { name: '尚未提交的另一剧情', content: '《未提交草稿世界》中的另一名人物正在登船。', updatedAt: 2 },
    storyboards: state.project.storyboards.map((board) => ({
      ...board, sourceStoryTitle: '晨星巡航', sourceStoryContent: '作品《晨星巡航》的世界观中，阿莲站在飞船观察窗前整理星图。',
    })),
  }, settings: { ...state.settings,
    textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://fixture-text.invalid/v1', model: 'fixture-text-model', apiKey: 'fixture-text-key' },
    imagePromptRuleSetIdByBackend: {
      ...state.settings.imagePromptRuleSetIdByBackend,
      openai: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
    },
  } }));
  const microBoardBefore = JSON.stringify(micro.getState().project.storyboards[0]);
  micro.ctx.convertPrompt = async (api, kind, source, format, rules, identityContext = '') => {
    converterCalls.push({ api: clone(api), kind, source, format, rules, identityContext });
    return '转化后的微 NSFW 分镜单帧：雨雾水汽包围山径，轻薄衣料在逆光中微微透光，贴身褶皱和发丝水光突出含蓄湿润摄影氛围。';
  };
  await bounded(micro.run({ mode: 'selected-shots', shotIds: ['shot-2'] }));
  assert.equal(converterCalls.length, 1, 'selecting the GPT2.5 micro NSFW rule converts direct storyboard text before image submission');
  assert.equal(converterCalls[0].kind, 'storyboard');
  assert.equal(converterCalls[0].format, 'natural-language');
  assert.match(converterCalls[0].source, /第二镜独有原画面/u);
  assert.doesNotMatch(converterCalls[0].source, /第四镜独有原画面|图生图参考/u);
  assert.match(converterCalls[0].identityContext, /晨星巡航/u);
  assert.match(converterCalls[0].identityContext, /阿莲站在飞船观察窗前整理星图/u,
    'the current board story supplies authored world and name evidence even when project source documents are absent');
  assert.doesNotMatch(converterCalls[0].identityContext, /未提交草稿世界/u,
    'an unrelated editor draft never takes priority over the authored board source');
  assert.doesNotMatch(converterCalls[0].source, /晨星巡航/u, 'identity context stays separate from the immutable current-shot visual source');
  assert.match(converterCalls[0].rules, /GPT Image 2\.5 微 NSFW 生图提示词整理器/u);
  assert.match(converterCalls[0].rules, /<image_converter_worldbook>/u);
  assert.match(converterCalls[0].rules, /微 NSFW|水汽|轻薄衣料|贴身褶皱/u);
  assert.match(converterCalls[0].rules, /分镜单帧.*含蓄湿润摄影状态/u);
  assert.equal(micro.calls.length, 1);
  assert.match(micro.calls[0].input.prompt, /本次实际上传图片（严格按此顺序）/u);
  assert.match(micro.calls[0].input.prompt, /转化后的微 NSFW 分镜单帧/u);
  assert.match(micro.calls[0].input.prompt, /雨雾水汽|轻薄衣料|透光|贴身褶皱|发丝水光/u);
  assert.doesNotMatch(micro.calls[0].input.prompt, /18\s*岁|年龄门禁|未成年|未满|\badult\b|\bminor\b|\bteen\b|\bchild\b/iu);
  assert.doesNotMatch(micro.calls[0].input.prompt, /不要画出来的对白|旧音效|旧对白/u);
  assert.doesNotMatch(micro.calls[0].input.prompt, /晨星巡航/u,
    'no local prefix or name gate repairs the mock converter output; identity must be authored by the converter itself');
  const microTask = micro.imageTasks()[0];
  assert.equal(microTask.imagePromptRuleSetId, 'image-rule-openai-gpt-image-2-5-micro-nsfw');
  assert.equal(microTask.imagePromptPresetId, 'image-preset-gpt-image-2-5-micro-nsfw-storyboard');
  assert.match(microTask.sourceFingerprint || '', /^direct-storyboard-image-v3-/u);
  assert.equal(microTask.conversionIdentityContext, converterCalls[0].identityContext, 'the executed converter evidence is persisted with the task');
  assert.equal(JSON.stringify(micro.getState().project.storyboards[0]), microBoardBefore, 'adding converter identity context cannot rewrite H3 or other board fields');
  const microAsset = micro.getState().project.assets.find((asset) => asset.source === 'generated')!;
  assert.equal(microAsset.imagePromptRuleSetId, microTask.imagePromptRuleSetId);
  assert.equal(microAsset.imagePromptPresetId, microTask.imagePromptPresetId);
  await bounded(micro.run({ mode: 'selected-shots', shotIds: ['shot-2'] }));
  assert.equal(converterCalls.length, 1, 'unchanged authored identity context may reuse its own completed converter result');
  micro.mutate((state) => ({ ...state, project: {
    ...state.project, description: '角色作品归属更正为原创故事《远航档案》，旧世界观仅供历史资料使用。',
  } }));
  await bounded(micro.run({ mode: 'selected-shots', shotIds: ['shot-2'] }));
  assert.equal(converterCalls.length, 2, 'editing authored identity context prevents reuse of an older converted prompt');
  assert.match(converterCalls[1].identityContext, /远航档案/u);
  assert.notEqual(micro.imageTasks()[0].sourceFingerprint, microTask.sourceFingerprint);

  for (const mode of ['boundary-frames', 'custom-count'] as const) {
    const contextual = fixture();
    const planning = mode === 'custom-count' ? prepareCustomPlanner(contextual, 3) : undefined;
    contextual.mutate((state) => ({ ...state, project: {
      ...state.project,
      description: '原创作品《晨星巡航》的飞船世界观，人物阿莲。',
    }, settings: { ...state.settings,
      textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://fixture-text.invalid/v1', model: 'fixture-text-model', apiKey: 'fixture-only' },
      imagePromptRuleSetIdByBackend: { ...state.settings.imagePromptRuleSetIdByBackend, openai: 'image-rule-openai-gpt-image-2-5-micro-nsfw' },
    } }));
    const before = JSON.stringify(contextual.getState().project.storyboards[0]);
    const identityContexts: string[] = [];
    const started = deferred();
    const gate = deferred();
    const converted = '原创作品《晨星巡航》中的阿莲站在飞船观察窗旁，暖色窗光照亮深蓝制服与桌面星图，单个清晰静帧。';
    contextual.ctx.convertPrompt = async (_api, _kind, _source, _format, _rules, identityContext = '') => {
      identityContexts.push(identityContext);
      started.resolve();
      await gate.promise;
      return converted;
    };
    const pending = contextual.run(mode === 'custom-count'
      ? { mode: 'storyboard-shots', count: 3 }
      : { mode: 'boundary-frames' });
    await bounded(started.promise);
    contextual.mutate((state) => ({ ...state, project: {
      ...state.project, description: '开始请求后输入的另一作品名称《新世界》，不影响在途任务快照。',
    } }));
    gate.resolve();
    await bounded(pending);
    const expectedCount = mode === 'custom-count' ? 3 : 2;
    assert.equal(identityContexts.length, expectedCount, `${mode} keeps exactly the original number of conversion calls`);
    assert.ok(identityContexts.every((context) => /晨星巡航/u.test(context) && !/新世界/u.test(context)),
      'every asynchronous conversion uses the same frozen identity context captured before awaiting');
    assert.ok(contextual.imageTasks().every((task) => task.conversionIdentityContext === identityContexts[0]));
    assert.equal(contextual.calls.length, expectedCount);
    assert.ok(contextual.calls.every((call) => call.input.prompt.includes(converted)), 'the complete AI converter body is retained before actual reference-use metadata');
    assert.ok(contextual.calls.every((call) => /本次实际上传图片（严格按此顺序）/u.test(call.input.prompt)), 'the image model receives the actual reference ordering after conversion');
    assert.equal(JSON.stringify(contextual.getState().project.storyboards[0]), before);
    assert.equal(contextual.reported.length, 0);
    if (planning) assert.equal(planning.calls.length, 1, 'custom count still uses one existing still-planning request');
  }

  const sdDefault = fixture();
  sdDefault.mutate((state) => ({ ...state, settings: { ...state.settings,
    imageApi: { ...state.settings.imageApi, backend: 'sd_webui', model: '' },
  } }));
  sdDefault.mutate((state) => updateStoryboardImageToImageSettings(state, sdDefault.projectId, 'board-2', {
    referenceAssetIds: ['b'], selectedShotIds: [], referenceAssetIdsByShotId: {},
  }));
  await bounded(sdDefault.run());
  assert.equal(sdDefault.calls.length, 4, 'SD WebUI img2img accepts an omitted model for the current server checkpoint');
  assert.ok(sdDefault.imageTasks().every((task) => task.status === 'succeeded' && task.model === ''));
  const sdAssets = sdDefault.getState().project.assets.filter((asset) => asset.source === 'generated');
  assert.equal(sdAssets.length, 4, 'an empty SD model must not discard a successful image while saving its retry snapshot');
  const sdResultOnly = { ...sdDefault.getState().project, assets: [sdAssets[0]], generationTasks: [], storyboards: [] };
  const sdRecovered = resolveImageAssetRegenerationTask(sdAssets[0], sdResultOnly, sdDefault.getState().settings.imageApi)!;
  assert.equal(sdRecovered.backend, 'sd_webui');
  assert.equal(sdRecovered.model, '');
  assert.deepEqual(sdRecovered.referenceAssetIds, ['b']);
  const sdRecoveredApi = await resolveImageApiForRegeneration(sdDefault.getState().settings, sdRecovered.imageApiSnapshot);
  assert.equal(sdRecoveredApi.model, '', 'asset-only retry preserves the server-default checkpoint request without inventing a model');
  assert.equal(sdDefault.reported.length, 0);

  const boundaries = fixture();
  const beforeBoundaries = JSON.stringify(boundaries.getState().project.storyboards[0]);
  await bounded(boundaries.run({ mode: 'boundary-frames' }));
  assert.equal(boundaries.calls.length, 2, 'the existing first/last-frame button needs no text model');
  assert.deepEqual(boundaries.calls.map((call) => call.input.referenceImages), [[pngB, pngA], [pngB, pngA]]);
  assert.deepEqual(boundaries.imageTasks().map((task) => [task.sourceShotId, task.imageVariant]), [['shot-1', 'first-frame'], ['shot-4', 'last-frame']]);
  const boundaryAssets = boundaries.getState().project.assets.filter((asset) => asset.source === 'generated');
  assert.deepEqual(new Set(boundaryAssets.map((asset) => `${asset.type}:${asset.role}:${asset.imageVariant}`)),
    new Set(['first-frame:first-frame:first-frame', 'last-frame:last-frame:last-frame']));
  assert.equal(JSON.stringify(boundaries.getState().project.storyboards[0]), beforeBoundaries, 'boundary output metadata does not rewrite H3 or video frame bindings');

  const draft = fixture();
  draft.mutate((state) => updateStoryboardImageToImageSettings(state, draft.projectId, 'board-2', {
    referenceAssetIds: ['b'], selectedShotIds: ['shot-2', 'shot-4'], referenceAssetIdsByShotId: { 'shot-2': ['a'], 'shot-1': ['untouched'] },
  }));
  await bounded(draft.run());
  assert.deepEqual(draft.calls.map((call) => call.input.referenceImages), Array.from({ length: 4 }, () => [pngB]), 'public selection applies to every image and never consults retired per-shot bindings');
  assert.deepEqual(draft.getState().project.storyboards[0].imageToImage?.referenceAssetIdsByShotId, {
    'shot-2': ['a'], 'shot-1': ['untouched'],
  }, 'generation retains historical data but never writes or repairs per-shot choices');

  const frozen = fixture();
  const gate = deferred();
  const blocker = enqueueImageTask(() => gate.promise);
  const pending = frozen.run();
  try {
    await waitQueued(frozen, pending);
    assert.equal(frozen.calls.length, 0, 'jobs remain queued behind existing image work');
    const originalSnapshot = structuredClone(frozen.imageTasks());
    // Deliberately mutate live objects as well as replacing the selection, to
    // prove queued work owns data rather than following current UI references.
    frozen.getState().settings.imageApi.model = 'later-model';
    frozen.getState().settings.imageApi.baseUrl = 'https://later-api.invalid/v1';
    frozen.getState().project.assets.find((asset) => asset.id === 'a')!.dataUrl = pngB;
    frozen.mutate((state) => ({ ...state, settings: { ...state.settings, storyboardImageOutputSize: { mode: '1k', width: 1024, height: 1024 } } }));
    frozen.mutate((state) => updateStoryboardImageToImageSettings(state, frozen.projectId, 'board-2', {
      referenceAssetIds: ['b'], selectedShotIds: ['shot-1'], referenceAssetIdsByShotId: { 'shot-1': ['b'], 'shot-2': ['b'], 'shot-4': ['a'] },
    }));
    frozen.mutate((state) => applyOwnedProjectUpdate(state, frozen.projectId, (project) => ({
      ...project, assets: project.assets.filter((asset) => asset.id !== 'b'),
    })));
    assert.deepEqual(frozen.imageTasks(), originalSnapshot, 'editing the workbench does not rewrite queued task snapshots');
  } finally {
    gate.resolve();
  }
  await bounded(Promise.all([blocker, pending]));
  assert.deepEqual(frozen.calls.map((call) => call.input.referenceImages), Array.from({ length: 4 }, () => [pngB, pngA]), 'queued jobs use frozen managed originals even after replacement/deletion from current library');
  assert.ok(frozen.calls.every((call) => call.api.model === 'fixture-image-model' && call.api.baseUrl === 'https://fixture-image.invalid/v1'));
  assert.ok(frozen.calls.every((call) => call.input.width === 4096 && call.input.height === 2304));
  assert.deepEqual(frozen.getState().project.storyboards[0].imageToImage?.selectedShotIds, ['shot-1'], 'completed old jobs do not undo a later picker choice');

  const cancelled = fixture();
  const cancellationGate = deferred();
  const cancellationBlocker = enqueueImageTask(() => cancellationGate.promise);
  const cancellationPending = cancelled.run({ mode: 'selected-shots', shotIds: ['shot-4', 'shot-2'] });
  try {
    await waitQueued(cancelled, cancellationPending);
    const queuedTasks = cancelled.imageTasks();
    for (const task of queuedTasks) assert.equal(revokeQueuedGenerationTask(cancelled.projectId, task), true);
    cancelled.mutate((state) => applyOwnedProjectUpdate(state, cancelled.projectId, (project) => ({
      ...project,
      generationTasks: removeGenerationTask(cancelQueuedGenerationTask(project.generationTasks, queuedTasks[0].id).tasks, queuedTasks[1].id).tasks,
    })));
  } finally {
    cancellationGate.resolve();
  }
  await bounded(Promise.all([cancellationBlocker, cancellationPending]));
  assert.equal(cancelled.calls.length, 0, 'both cancelled and directly deleted queued jobs make zero image requests');
  assert.equal(cancelled.getState().project.assets.filter((asset) => asset.source === 'generated').length, 0);
  assert.equal(cancelled.imageTasks().length, 1);
  assert.equal(cancelled.imageTasks()[0].status, 'cancelled');
  assert.ok(cancelled.notices.some((notice) => notice.message.includes('取消 2')));

  const unsupported = fixture();
  unsupported.mutate((state) => ({
    ...state, settings: { ...state.settings, imageApi: { ...state.settings.imageApi, backend: 'novelai' }, storyboardImageOutputSize: { mode: '1k', width: 1024, height: 1024 } },
  }));
  await bounded(unsupported.run());
  assert.equal(unsupported.calls.length, 0);
  assert.equal(unsupported.imageTasks().length, 0);
  assert.ok(unsupported.notices.some((notice) => notice.tone === 'error' && /NovelAI.*不会退回文生图/u.test(notice.message)), 'unsupported backends give an actionable technical reason before any paid request');

  const brokenReference = fixture();
  brokenReference.mutate((state) => applyOwnedProjectUpdate(state, brokenReference.projectId, (project) => ({
    ...project, assets: project.assets.map((asset) => asset.id === 'a' ? { ...asset, missing: true } : asset),
  })));
  await bounded(brokenReference.run());
  assert.equal(brokenReference.calls.length, 0);
  assert.ok(brokenReference.notices.some((notice) => /参考图.*(?:丢失|无法读取)/u.test(notice.message)), 'missing originals never fall back to a text-only image request');
  assert.equal(brokenReference.reportDetails[0]?.stage, 'image-reference-load');

  const customWithoutText = fixture();
  await bounded(customWithoutText.run({ mode: 'storyboard-shots', count: 5 }));
  assert.equal(customWithoutText.imageTasks().length, 0);
  assert.equal(customWithoutText.calls.length, 0);
  assert.ok(customWithoutText.notices.some((notice) => /自定义.*文本 API.*静帧/u.test(notice.message)));
  assert.equal(customWithoutText.reportDetails[0]?.stage, 'image-frame-plan');

  const custom = fixture();
  const planningGate = deferred();
  const planner = prepareCustomPlanner(custom, 5, planningGate.promise);
  const originalCustomH3 = custom.getState().project.storyboards[0].officialPromptZh;
  const customOptions: DirectStoryboardImageGenerationOptions = { mode: 'storyboard-shots', count: 5 };
  const customPending = custom.run(customOptions);
  await bounded(planner.started.promise);
  assert.equal(custom.imageTasks().length, 0, 'no image tasks are submitted while static-frame planning is pending');
  assert.equal(custom.stores.filter((entry) => entry.fileName?.includes('图生图参考')).length, 2, 'original pixels are frozen before asynchronous planning');
  customOptions.count = 1;
  custom.getState().settings.imageApi.model = 'later-image-model';
  custom.getState().settings.textApi.model = 'later-text-model';
  custom.getState().project.assets.find((asset) => asset.id === 'a')!.dataUrl = pngB;
  custom.mutate((state) => updateStoryboardImageToImageSettings(state, custom.projectId, 'board-2', {
    referenceAssetIds: ['a'], selectedShotIds: ['shot-1'], referenceAssetIdsByShotId: {},
  }));
  custom.mutate((state) => ({ ...state, settings: { ...state.settings, storyboardImageOutputSize: { mode: '1k', width: 1024, height: 1024 } },
    project: { ...state.project, assets: state.project.assets.filter((asset) => asset.id !== 'b') },
  }));
  for (const overlappingOptions of [
    { mode: 'storyboard-shots' }, { mode: 'boundary-frames' }, { mode: 'selected-shots', shotIds: ['shot-1'] },
  ] as const) await bounded(custom.run(overlappingOptions));
  assert.equal(planner.calls.length, 1, 'one custom batch owns the board lease across all image entry points');
  assert.equal(custom.calls.length, 0);
  assert.ok(custom.notices.some((notice) => /已有图片批次/u.test(notice.message)));
  planningGate.resolve();
  await bounded(customPending);
  assert.equal(custom.calls.length, 5, 'the frozen custom total is independent of source video shot count or later UI changes');
  assert.equal(planner.calls.length, 1, 'valid custom-frame plans need exactly one source-text call, not per-frame conversion');
  assert.equal(planner.calls[0].api.model, 'frozen-text-model');
  const planInput = JSON.parse(planner.calls[0].user);
  assert.equal(planInput.requestedImageCount, 5);
  assert.equal(planInput.source.officialPromptZh, originalCustomH3);
  assert.equal(planInput.source.shots.length, 4);
  assert.equal(JSON.stringify(planInput).includes('data:image/'), false);
  assert.ok(custom.calls.every((call) => call.api.model === 'fixture-image-model' && call.input.width === 4096 && call.input.height === 2304));
  assert.deepEqual(custom.calls.map((call) => call.input.referenceImages), Array.from({ length: 5 }, () => [pngB, pngA]), 'every custom still receives the exact same captured originals');
  assert.deepEqual(custom.imageTasks().map((task) => [task.imageFrameIndex, task.imageFrameCount, task.imageFrameDescription, task.imageFrameTimeSec]),
    planner.frames.map((frame, index) => [index + 1, 5, frame.description, frame.timeSec]));
  assert.ok(custom.imageTasks().every((task) => task.imageVariant === 'storyboard-frame' && task.imageFrameBatchId));
  assert.equal(new Set(custom.imageTasks().map((task) => task.imageFrameBatchId)).size, 1);
  const customAssets = custom.getState().project.assets.filter((asset) => asset.source === 'generated')
    .sort((left, right) => (left.imageFrameIndex || 0) - (right.imageFrameIndex || 0));
  assert.deepEqual(customAssets.map((asset) => [asset.imageFrameIndex, asset.imageFrameCount, asset.imageFrameDescription, asset.imageFrameTimeSec]),
    planner.frames.map((frame, index) => [index + 1, 5, frame.description, frame.timeSec]));
  assert.equal(custom.getState().project.storyboards[0].officialPromptZh, originalCustomH3);
  assert.deepEqual(custom.getState().project.storyboards[0].imageToImage?.referenceAssetIds, ['a'], 'a finished captured batch never reverts later public choices');
  assert.equal(custom.reported.length, 0);

  for (const mutation of ['h3', 'shot', 'source', 'project', 'delete-board', 'history'] as const) {
    const stale = fixture();
    const staleGate = deferred();
    const stalePlanner = prepareCustomPlanner(stale, 5, staleGate.promise);
    const stalePending = stale.run({ mode: 'storyboard-shots', count: 5 });
    await bounded(stalePlanner.started.promise);
    stale.mutate((state) => {
      const project = { ...state.project };
      switch (mutation) {
        case 'h3': project.storyboards = project.storyboards.map((board) => ({ ...board, officialPromptZh: `${board.officialPromptZh}\n新的 H3 画面` })); break;
        case 'shot': project.storyboards = project.storyboards.map((board) => ({ ...board, shots: board.shots.map((shot) => ({ ...shot, action: '已编辑的新动作' })) })); break;
        case 'source': project.sourceDocuments = [{ id: 'new-source', name: '已修改剧情', content: '新的原剧情内容', createdAt: 1, updatedAt: 2 }]; break;
        case 'project': project.id = 'another-project'; break;
        case 'delete-board': project.storyboards = []; break;
        case 'history': stale.ctx.lifecycle.invalidateBindings(); break;
      }
      return { ...state, project };
    });
    staleGate.resolve();
    await bounded(stalePending);
    assert.equal(stale.calls.length, 0, `${mutation} invalidates stale custom planning before billable image requests`);
    assert.equal(stale.imageTasks().length, 0, `${mutation} cannot queue stale planned images`);
    assert.equal(stalePlanner.calls.length, 1);
    assert.equal(stale.reported.length, 0, 'cancelled source ownership is not an upstream failure');
  }

  const replaceLiveSettings = (instance: ReturnType<typeof fixture>, switchProject: boolean) => {
    instance.mutate((state) => ({
      ...state,
      settings: {
        ...state.settings,
        textApi: { ...state.settings.textApi, provider: 'deepseek', baseUrl: 'https://changed-text.invalid/v1', model: 'changed-text-model' },
        imageApi: { ...state.settings.imageApi, backend: 'sd_webui', baseUrl: 'https://changed-image.invalid/v1', model: 'changed-image-model' },
      },
      ...(switchProject ? {
        project: { ...state.project, id: `${instance.projectId}-new`, name: 'New unrelated project', generationTasks: [] },
        projects: [state.project, ...state.projects.filter((project) => project.id !== state.project.id)],
      } : {}),
    }));
  };

  // A provider refusal remains the same typed error in either planning round.
  // Changing live settings/project must not relabel the request that failed.
  for (const filterAt of [1, 2]) {
    for (const switchProject of [false, true]) {
      const filtered = fixture();
      prepareCustomPlanner(filtered, 5);
      const capturedApi = clone(filtered.getState().settings.textApi);
      const capturedProject = { projectId: filtered.projectId, projectName: filtered.getState().project.name };
      const terminal = Object.freeze(new TextModelResponseError('content_filter', '文本供应商返回内容过滤标记（content_filter），没有完整结果。'));
      const started = deferred();
      const responseGate = deferred();
      let textCalls = 0;
      filtered.ctx.requestText = async (api) => {
        assert.equal(api.model, capturedApi.model);
        textCalls += 1;
        if (textCalls < filterAt) return 'fixture malformed JSON';
        started.resolve();
        await responseGate.promise;
        throw terminal;
      };
      const pending = filtered.run({ mode: 'storyboard-shots', count: 5 });
      await bounded(started.promise);
      replaceLiveSettings(filtered, switchProject);
      responseGate.resolve();
      await bounded(pending);
      assert.equal(textCalls, filterAt, 'content_filter must stop immediately, including a JSON repair response');
      assert.equal(filtered.calls.length, 0, 'a filtered text plan submits zero image API requests');
      assert.equal(filtered.imageTasks().length, 0);
      assert.deepEqual(filtered.reported, [terminal], 'typed errors and their content_filter code must not be wrapped or replaced');
      assert.deepEqual(filtered.reportDetails, [{ stage: 'image-frame-plan', context: {
        ...capturedProject, provider: capturedApi.provider, model: capturedApi.model, endpoint: capturedApi.baseUrl,
      } }]);
      if (!switchProject) assert.ok(filtered.notices.some((notice) => /分镜静帧规划未完成，尚未提交生图/u.test(notice.message)));
    }
  }

  const converterFailure = fixture();
  prepareCustomPlanner(converterFailure, 1);
  converterFailure.mutate((state) => ({ ...state, settings: { ...state.settings,
    imagePromptRuleSetIdByBackend: { ...state.settings.imagePromptRuleSetIdByBackend, openai: 'image-rule-openai-gpt-image-2-5-micro-nsfw' },
  } }));
  const converterApi = clone(converterFailure.getState().settings.textApi);
  const converterStarted = deferred();
  const converterGate = deferred();
  const converterError = Object.freeze(new TextModelResponseError('content_filter', '文本供应商返回内容过滤标记（content_filter）。'));
  let conversionCalls = 0;
  converterFailure.ctx.convertPrompt = async () => {
    conversionCalls += 1;
    converterStarted.resolve();
    await converterGate.promise;
    throw converterError;
  };
  const converterPending = converterFailure.run({ mode: 'selected-shots', shotIds: ['shot-2'] });
  await bounded(converterStarted.promise);
  replaceLiveSettings(converterFailure, true);
  converterGate.resolve();
  await bounded(converterPending);
  assert.equal(conversionCalls, 1);
  assert.equal(converterFailure.calls.length, 0);
  assert.deepEqual(converterFailure.reported[0], getSafeErrorDiagnostics(converterError),
    'pre-task conversion reports only safe diagnostics while preserving the provider refusal code');
  assert.deepEqual(converterFailure.reportDetails[0], { stage: 'image-prompt-convert', context: {
    projectId: converterFailure.projectId, projectName: 'Direct image fixture',
    provider: converterApi.provider, model: converterApi.model, endpoint: converterApi.baseUrl,
  } });

  for (const echoFormat of ['raw', 'json', 'url'] as const) {
    const echoed = fixture();
    prepareCustomPlanner(echoed, 1);
    echoed.mutate((state) => ({ ...state, project: {
      ...state.project, description: '原创作品《仅供模型参考的航行日志》中的阿莲拥有保密身份资料。',
    }, settings: { ...state.settings,
      imagePromptRuleSetIdByBackend: { ...state.settings.imagePromptRuleSetIdByBackend, openai: 'image-rule-openai-gpt-image-2-5-micro-nsfw' },
    } }));
    const frozenApi = clone(echoed.getState().settings.textApi);
    const exposedInputs: string[] = [];
    let echoedCalls = 0;
    const encodeEcho = (value: string) => echoFormat === 'json' ? JSON.stringify(value).slice(1, -1)
      : echoFormat === 'url' ? encodeURIComponent(value) : value;
    echoed.ctx.convertPrompt = async (api, _kind, source, _format, rules, identityContext = '') => {
      echoedCalls += 1;
      assert.match(identityContext, /仅供模型参考的航行日志/u);
      exposedInputs.push(identityContext, source, rules, api.apiKey);
      // Simulate edits while the failed request is in flight. Diagnostics must
      // use the request snapshot even though there is no queued task to scan.
      echoed.mutate((state) => ({ ...state, project: { ...state.project, description: '之后输入的另一个项目说明。' },
        settings: { ...state.settings, textApi: { ...state.settings.textApi, apiKey: 'later-diagnostic-key' } },
      }));
      throw Object.assign(new Error(`HTTP 502; 服务暂时不可用；${exposedInputs.map(encodeEcho).join('\n')}`), {
        status: 502, code: 'UPSTREAM_UNAVAILABLE', networkStage: 'response-read', networkRoute: 'direct',
        request: { body: identityContext },
      });
    };
    await bounded(echoed.run({ mode: 'selected-shots', shotIds: ['shot-2'] }));
    assert.equal(echoedCalls, 1, 'diagnostic sanitization does not add retries or model calls');
    assert.equal(echoed.calls.length, 0);
    assert.equal(echoed.imageTasks().length, 0, 'the error is safe even before any task can supply redaction context');
    assert.equal(echoed.reported.length, 1);
    const diagnostic = getSafeErrorDiagnostics(echoed.reported[0]);
    assert.equal(diagnostic.status, 502);
    assert.equal(diagnostic.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(diagnostic.stage, 'response-read');
    assert.equal(diagnostic.route, 'direct');
    assert.match(diagnostic.message, /服务暂时不可用/u);
    const visibleErrors = JSON.stringify({ notices: echoed.notices, reported: echoed.reported });
    for (const sensitive of exposedInputs) {
      assert.ok(!visibleErrors.includes(sensitive) && !visibleErrors.includes(JSON.stringify(sensitive).slice(1, -1))
        && !visibleErrors.includes(encodeURIComponent(sensitive)), `${echoFormat} converter errors do not expose frozen input data`);
    }
    assert.doesNotMatch(visibleErrors, /仅供模型参考的航行日志|request|frozen-text-key/u);
    assert.ok(echoed.notices.some((notice) => notice.tone === 'error'
      && /生图提示词转换未完成，尚未提交生图.*HTTP 502/u.test(notice.message)));
    assert.deepEqual(echoed.reportDetails[0], { stage: 'image-prompt-convert', context: {
      projectId: echoed.projectId, projectName: 'Direct image fixture', provider: frozenApi.provider,
      model: frozenApi.model, endpoint: frozenApi.baseUrl,
    } });
  }

  const switchedImageFailure = fixture();
  const capturedImageApi = clone(switchedImageFailure.getState().settings.imageApi);
  const imageStarted = deferred();
  const imageGate = deferred();
  const imageError = Object.freeze(Object.assign(new Error('fixture image endpoint failure'), { status: 503 }));
  switchedImageFailure.ctx.generateImage = async (_api, _input, onStart) => {
    await onStart?.();
    imageStarted.resolve();
    await imageGate.promise;
    throw imageError;
  };
  const switchedImagePending = switchedImageFailure.run({ mode: 'selected-shots', shotIds: ['shot-2'] });
  await bounded(imageStarted.promise);
  replaceLiveSettings(switchedImageFailure, true);
  imageGate.resolve();
  await bounded(switchedImagePending);
  assert.equal(switchedImageFailure.reported[0], imageError);
  assert.deepEqual(switchedImageFailure.reportDetails[0], { stage: 'image-generation', context: {
    projectId: switchedImageFailure.projectId, projectName: 'Direct image fixture',
    provider: capturedImageApi.backend, model: capturedImageApi.model, endpoint: capturedImageApi.baseUrl,
  } }, 'a real image failure keeps the submitted image API, never the newly selected text or image API');
  assert.equal(switchedImageFailure.imageTasks().length, 0, 'late image failure does not write into the newly active project');
  assert.equal(switchedImageFailure.getState().projects.find((project) => project.id === switchedImageFailure.projectId)?.generationTasks[0].status, 'failed');

  const failure = fixture();
  const originalGenerator = failure.ctx.generateImage!;
  let attempts = 0;
  failure.ctx.generateImage = async (...args) => {
    if (++attempts === 1) throw new Error('fixture upstream size is unsupported');
    return originalGenerator(...args);
  };
  await bounded(failure.run({ mode: 'selected-shots', shotIds: ['shot-4', 'shot-2'] }));
  assert.deepEqual(failure.imageTasks().map((task) => task.status), ['failed', 'succeeded'], 'one failed image does not block later selected shots');
  assert.match(failure.imageTasks()[0].error || '', /第 2 镜图生图失败：fixture upstream size is unsupported/u);
  assert.equal(failure.imageTasks()[1].sourceShotId, 'shot-4');
  assert.equal(failure.getState().project.assets.find((asset) => asset.source === 'generated')?.sourceShotId, 'shot-4');
  assert.equal(failure.reportDetails[0]?.stage, 'image-generation');
  assert.equal(unexpectedNetworkCalls, 0, 'the disabled text API and real image APIs are never called by this test');

  const controller = readFileSync(new URL('../src/storyboardImageToImageGeneration.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /convertImagePrompt|executeStoryboardImageGeneration|enrichStoryboardImage/u, 'direct controller has no text conversion or identity enrichment prerequisite');
  console.log('Direct storyboard image controller: shared originals, existing default/boundary/custom buttons, text-only still planning, stale-source rejection, frozen queue, cancellation and metadata preservation passed.');
} finally {
  globalThis.fetch = originalFetch;
}
