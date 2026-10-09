import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import ts from 'typescript';
import * as imageHelpers from '../src/storyboardImages';
import * as imageRules from '../src/imagePromptRules';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import * as taskHelpers from '../src/generationTasks';
import * as preparationHelpers from '../src/imageTaskPreparation';
import { buildStoryboardImagePromptWithReferences } from '../src/storyboardImageReferences';
import { imageBatchTaskIsActive } from '../src/imageBatch';
import { readGeneratedImageDimensions } from '../src/imageDimensions';
import { imageReturnedSizeWarning } from '../src/imageOutputSize';
import {
  defaultStoryboardImageOutputSize,
  resolveStoryboardImageOutputSize,
  type StoryboardImageOutputSizePreference,
} from '../src/storyboardImageOutputSize';
import { applyOwnedProjectUpdate, isCurrentProjectOperation } from '../src/appEffects';
import { checkNovelAIReferenceImagePreflight } from '../src/novelai';
import { createInitialState, safeFileName } from '../src/storage';
import type { ImageGenerationOptions, StoryboardVisibleCharacterAnalysisInput } from '../src/services/llm';
import type { AppState, Character, ImageGenerationTask, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

// Exercise the production workbench entry, not a parallel implementation. Only
// API boundaries and the React state shell are mocked; no saved project is read.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ImageWorkbenchView');
assert.ok(view && ts.isFunctionDeclaration(view) && view.body);
const handler = view.body.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === 'generateSelectedStoryboardImages'));
assert.ok(handler, 'production selected-shot image handler exists');
const javascript = ts.transpileModule(handler.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const evaluate = (bindings: Record<string, unknown>) => new Function('dependencies', `with (dependencies) {
  ${ts.transpileModule(['imagePreparationProject', 'imagePreparationContext', 'reserveStoryboardImagePreparationTasks']
    .map((name) => {
      const helper = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(helper, `production ${name}`); return helper.getText(ast);
    }).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText}
  ${javascript}
  return generateSelectedStoryboardImages;
}`)(bindings) as () => Promise<void>;

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden in selected-shot fixtures'); };
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, 'every analysis/conversion/image call must remain mocked');
});

const character = (id: string, name: string, appearance: string): Character => ({
  id, name, appearance, gender: '女', apparentAge: '成年', race: '人类',
  outfit: '素色长衣', signatureProps: '无', personality: '沉静', motionHabits: '自然',
  anchor: `${name}固定外貌`, negativeContinuity: '不改变身份', assetIds: [`reference-${id}`],
});
const characters = [character('a', '阿莲', '阿莲独有身份：黑发琥珀瞳'), character('b', '青岚', '青岚独有身份：短发灰瞳')];
const references: ReferenceAsset[] = characters.map((item) => ({
  id: item.assetIds[0], name: `${item.name}人物参考`, type: 'character', role: 'character',
  sourceEntityKind: 'character', sourceEntityId: item.id, mediaType: 'image', source: 'upload',
  dataUrl: `data:image/png;base64,${item.id === 'a' ? 'AA==' : 'AQ=='}`,
  tags: [], createdAt: 1, updatedAt: 1,
}));
const shot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5,
  purpose: '递茶', subject: '阿莲和青岚都在镜头中（旧结构化描述）',
  action: '旧结构化动作', camera: '旧机位', lighting: '柔和日光', sound: '茶杯轻响',
  result: '旧结构化结果', transition: '顺接', referenceAssetIds: [],
  prompt: '旧分镜未标明谁在画内', locked: false,
});
const finalH3Shots = [
  '[Shot 1] 阿莲坐在观众画面左侧，青岚坐在画面右侧，两人在茶桌两侧。摄影机位于两人互动轴线南侧。',
  '[Shot 2] At 00:05.000, 阿莲在观众画面左侧，以自身右手轻握茶杯。摄影机仍在互动轴线南侧近景；青岚仍在阿莲自身左侧、处于画外，不在画面边缘。',
  '[Shot 3] At 00:10.000, 茶桌上的茶杯特写，阿莲和青岚均在画外，没有人物或手进入画面。',
];
const finalH3 = `integrated_multimodal_description: ${finalH3Shots.join('\n\n')}\n\noverall_soundscape: 茶杯轻响\n\nnon_diegetic_music: N/A`;
const storyboard = (): Storyboard => ({
  id: 'selected-board', sceneId: 'selected-scene', sourceStoryTitle: '茶桌边',
  sourceStoryContent: '阿莲和青岚在桌边坐下，阿莲端起茶杯。', workflow: 'drama', inputMode: 'text',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard',
  aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: 'cinematic',
  ruleSetId: 'timeline_director_cn', converterPresetId: 'converter', globalLock: '同一间茶室',
  shots: [shot(1), shot(2), shot(3)],
  finalPrompt: '【0s-5s】旧视频镜头一。\n【5s-10s】旧视频镜头二。\n【10s-15s】旧视频镜头三。',
  officialPromptZh: finalH3, createdAt: 1, updatedAt: 1,
});
const visibility = { 'shot-1': ['阿莲', '青岚'], 'shot-2': ['阿莲'], 'shot-3': [] };
const fixtureTextApiKey = 'selected-fixture-frozen-text-credential';
const fixtureImageApiKey = 'selected-fixture-frozen-image-credential';
const requestSizeFacts = (size: ReferenceAsset['imageRequestSize']) => ({ width: size?.width, height: size?.height, sizeOverride: size?.sizeOverride });
const imageSamples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8')) as Record<string, string>;
const pngWithDimensions = (width: number, height: number): string => {
  const pixels = Buffer.from(imageSamples.png, 'base64');
  pixels.writeUInt32BE(width, 16);
  pixels.writeUInt32BE(height, 20);
  return `data:image/png;base64,${pixels.toString('base64')}`;
};
let fixtureNumber = 0;
const fixture = (): AppState => {
  const initial = createInitialState();
  const project = {
    ...initial.project, id: `selected-project-${++fixtureNumber}`, description: '原创世界观“青石茶港”中的阿莲和青岚。', characters: structuredClone(characters),
    locations: [], props: [], scenes: [], assets: structuredClone(references),
    storyboards: [storyboard()], generationTasks: [], sequencePlans: [],
  };
  return { ...initial, project, projects: [project], activeProjectId: project.id, settings: {
    ...initial.settings,
    imageApi: { ...initial.settings.imageApi, enabled: true, backend: 'openai', model: 'mock-image', baseUrl: 'https://never-called.example.test', apiKey: fixtureImageApiKey },
    textApi: { ...initial.settings.textApi, enabled: true, model: 'mock-text', baseUrl: 'https://never-called.example.test', apiKey: fixtureTextApiKey },
  } };
};

const harness = (selected = ['shot-2'], options: {
  outputSize?: StoryboardImageOutputSizePreference;
  imageResult?: { dataUrl?: string; url?: string };
} = {}) => {
  const fixtureState = fixture();
  let current = options.outputSize ? { ...fixtureState, settings: {
    ...fixtureState.settings, storyboardImageOutputSize: structuredClone(options.outputSize),
  } } : fixtureState;
  const initial = current;
  const board = current.project.storyboards[0];
  let serial = 0;
  let busy = false;
  let busyEpoch = 0;
  const busyEvents: boolean[] = [];
  const identity = { workspaceEpoch: 1, projectId: current.project.id, storyboardId: board.id,
    sourcePrompt: board.finalPrompt, sourceStoryboardSnapshot: JSON.stringify(board) };
  const lifecycle = imageHelpers.createStoryboardImageBatchLifecycle();
  const guardKey = `${current.project.id}:${board.id}`;
  const notices: Array<{ message: string; level?: string }> = [];
  const analyses: StoryboardVisibleCharacterAnalysisInput[] = [];
  const builds: Array<{ selected: readonly string[]; context?: imageHelpers.StoryboardImageBuildContext }> = [];
  const conversions: string[] = [];
  const imageInputs: ImageGenerationOptions[] = [];
  let onAnalyze: (() => void | Promise<void>) | undefined;
  let onConversion: ((identityContext?: string) => void) | undefined;
  let onQueued: (() => void) | undefined;
  let onImage: (() => void) | undefined;
  let analysisError: Error | undefined;
  let conversionError: Error | undefined;
  let imageError: Error | undefined;
  const commit = (update: AppState | ((state: AppState) => AppState)) => {
    const next = typeof update === 'function' ? update(current) : update;
    const projects = new Map(next.projects.map((project) => [project.id, project]));
    projects.set(next.project.id, next.project);
    current = { ...next, projects: [...projects.values()], activeProjectId: next.project.id };
  };
  const context = (): imageHelpers.StoryboardImageBuildContext => ({
    projectName: current.project.name, characters: current.project.characters, locations: current.project.locations,
    props: current.project.props, scenes: current.project.scenes, assets: current.project.assets,
    generationTaskNames: current.project.generationTasks.filter(taskHelpers.isImageGenerationTask).map((task) => task.name),
  });
  const setBusy = (value: boolean) => { busyEpoch += 1; busy = value; busyEvents.push(value); };
  const bindings: Record<string, unknown> = {
    ...imageHelpers, ...imageRules, ...taskHelpers, ...preparationHelpers, imageBatchTaskIsActive, buildImagePromptIdentityContext, getSafeErrorDiagnostics,
    resolveStoryboardImageOutputSize, defaultStoryboardImageOutputSize,
    readGeneratedImageDimensions, imageReturnedSizeWarning, buildStoryboardImagePromptWithReferences,
    applyOwnedProjectUpdate, isCurrentProjectOperation, checkNovelAIReferenceImagePreflight,
    state: initial, selectedStoryboard: board, selectedStoryboardShotIds: selected,
    activeImagePromptRuleSetId: '', activeImagePromptPresetId: '',
    storyboardImageBatchLifecycle: lifecycle, setBusy, getBusyEpoch: () => busyEpoch,
    // This ref intentionally stays one React render behind the synchronous store.
    ctx: { getCurrentStoryboardOperationIdentity: () => ({ ...identity }) },
    getCurrentState: () => current, getCurrentProjectId: () => current.project.id,
    getCurrentProjectImageContext: context,
    setState: (update: AppState | ((state: AppState) => AppState)) => { commit(update); onQueued?.(); },
    setBackgroundState: (update: AppState | ((state: AppState) => AppState)) => {
      const before = current.project.generationTasks;
      commit(update);
      if (current.project.generationTasks.some((task) => {
        const previous = before.find((item) => item.id === task.id);
        return !previous || task.kind === 'image' && previous.kind === 'image'
          && previous.preparationStage && !task.preparationStage && task.status === 'queued';
      })) onQueued?.();
    },
    notify: (message: string, level?: string) => notices.push({ message, level }), setView: () => {},
    imagePromptBackendForApi: (backend: string) => backend,
    requestStoryboardVisibleCharacters: async (_api: unknown, input: StoryboardVisibleCharacterAnalysisInput) => {
      assert.equal(lifecycle.isActive(guardKey), true, 'the lease must cover analysis, not just image submission');
      assert.equal(busy, true, 'busy must be acquired before analysis starts');
      analyses.push(input);
      await onAnalyze?.();
      if (analysisError) throw analysisError;
      return { visibleCharacterNamesByShotId: visibility };
    },
    buildSelectedStoryboardImageRequests: (sourceBoard: Storyboard, ids: readonly string[], buildContext?: imageHelpers.StoryboardImageBuildContext) => {
      builds.push({ selected: [...ids], context: buildContext });
      return imageHelpers.buildSelectedStoryboardImageRequests(sourceBoard, ids, buildContext);
    },
    requestImagePromptConverter: async (_api: unknown, _kind: unknown, conversionSource: string, _format: unknown, _rules: unknown, identityContext?: string) => {
      conversions.push(conversionSource); onConversion?.(identityContext);
      if (conversionError) throw conversionError;
      return '柔和日光下的茶室，一只茶杯安静放在木桌边，清晰自然的画面层次，保持原镜的固定机位和人物身份。';
    },
    requestImageModel: async (_api: unknown, input: ImageGenerationOptions, beforeSubmit?: () => void | Promise<void>) => {
      await beforeSubmit?.(); imageInputs.push(input); onImage?.();
      if (imageError) throw imageError;
      return options.imageResult || { dataUrl: 'data:image/png;base64,Ag==' };
    },
    window: {}, safeFileName, createId: (kind: string) => `${initial.project.id}-${kind}-${++serial}`,
    isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  };
  return {
    run: evaluate(bindings), initial, identity, lifecycle, guardKey, notices, analyses, builds, conversions, imageInputs, busyEvents,
    current: () => current, setCurrent: commit, busy: () => busy, setBusy,
    onAnalyze: (callback?: () => void | Promise<void>) => { onAnalyze = callback; },
    onConversion: (callback: (identityContext?: string) => void) => { onConversion = callback; },
    onQueued: (callback: () => void) => { onQueued = callback; },
    onImage: (callback: () => void) => { onImage = callback; },
    failAnalysis: (error?: Error) => { analysisError = error; },
    failConversion: (error: Error) => { conversionError = error; },
    failImage: (error: Error) => { imageError = error; },
    tasks: () => current.project.generationTasks.filter(taskHelpers.isImageGenerationTask),
    generated: () => current.project.assets.filter((asset) => asset.source === 'generated'),
  };
};

test('selected entry uses final natural-language H3 and AI visibility to carry only the in-frame identity', async () => {
  const env = harness();
  assert.doesNotMatch(finalH3, /@/u, 'fixture must not rely on local @name matching');
  await env.run();
  assert.equal(env.analyses.length, 1);
  assert.deepEqual(env.analyses[0].knownCharacterNames, ['阿莲', '青岚']);
  assert.deepEqual(env.analyses[0].shots.map((item) => item.id), ['shot-1', 'shot-2', 'shot-3']);
  assert.ok(env.analyses[0].shots[1].description.includes(finalH3Shots[1]));
  assert.doesNotMatch(env.analyses[0].shots[1].description, /旧视频镜头二|旧分镜未标明/u);
  assert.deepEqual(env.builds[0].selected, ['shot-2']);
  assert.strictEqual(env.builds[1].context?.visibleCharacterNamesByShotId, visibility);
  assert.equal(env.tasks().length, 1); assert.equal(env.imageInputs.length, 1);
  const task = env.tasks()[0];
  assert.equal(task.sourceShotId, 'shot-2'); assert.equal(task.status, 'succeeded');
  assert.match(task.conversionSource || '', /阿莲独有身份：黑发琥珀瞳/u);
  assert.doesNotMatch(task.conversionSource || '', /青岚独有身份：短发灰瞳/u);
  assert.deepEqual(task.referenceAssetIds, ['reference-a']);
  assert.ok(task.conversionSource?.includes(finalH3Shots[1]));
  assert.equal(env.current().project.storyboards[0].officialPromptZh, finalH3, 'H3 delivery text is not rewritten');
  assert.deepEqual(env.current().project.storyboards[0].shots.filter((item) => item.id !== 'shot-2').map((item) => item.referenceAssetIds), [[], []]);
  assert.equal(env.current().project.storyboards[0].shots[1].referenceAssetIds[0], env.generated()[0].id);
  assert.equal(env.busy(), false); assert.equal(env.lifecycle.isActive(env.guardKey), false);
});

test('all shots may inform AI continuity, but only the selected subset produces tasks and empty visibility stays empty', async () => {
  const env = harness(['shot-3', 'shot-1', 'shot-3']);
  await env.run();
  assert.deepEqual(env.tasks().map((task) => task.sourceShotId), ['shot-1', 'shot-3']);
  assert.equal(env.analyses[0].shots.length, 3); assert.equal(env.imageInputs.length, 2);
  const environmentTask = env.tasks().find((task) => task.sourceShotId === 'shot-3')!;
  assert.deepEqual(environmentTask.referenceAssetIds, []);
  assert.doesNotMatch(environmentTask.conversionSource || '', /阿莲独有身份|青岚独有身份/u);
  assert.deepEqual(env.current().project.storyboards[0].shots[1].referenceAssetIds, []);
});

test('lease and busy are held while visibility is pending and reject a duplicate click', async () => {
  const env = harness();
  let resolveAnalysis!: () => void;
  env.onAnalyze(() => new Promise<void>((resolve) => { resolveAnalysis = resolve; }));
  const running = env.run();
  assert.equal(env.analyses.length, 1); assert.equal(env.busy(), true);
  assert.equal(env.lifecycle.isActive(env.guardKey), true); assert.equal(env.tasks().length, 1);
  assert.equal(env.tasks()[0].preparationStage, 'identity', 'task is visible before delayed visibility analysis returns');
  await env.run();
  assert.equal(env.analyses.length, 1); assert.equal(env.busy(), true);
  resolveAnalysis(); await running;
  assert.equal(env.tasks().length, 1); assert.deepEqual(env.busyEvents, [true, false]);
});

test('delayed selected-shot preparation survives segment navigation and another generated asset without replacing task IDs', async () => {
  const env = harness(['shot-1', 'shot-3']);
  let release!: () => void;
  env.onAnalyze(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = env.run();
  const ids = env.tasks().map((task) => task.id);
  assert.equal(ids.length, 2);
  assert.ok(env.tasks().every((task) => task.status === 'queued' && task.preparationStage === 'identity'));
  env.identity.storyboardId = 'another-segment';
  env.setCurrent((state) => ({ ...state, project: { ...state.project, assets: [{
    id: 'other-batch-result', name: 'Unrelated completed image', type: 'reference', role: 'composition',
    mediaType: 'image', source: 'generated', dataUrl: 'data:image/png;base64,Ag==', tags: [], createdAt: 1, updatedAt: 1,
  }, ...state.project.assets] } }));
  release(); await pending;
  assert.deepEqual(env.tasks().map((task) => task.id), ids);
  assert.ok(env.tasks().every((task) => task.status === 'succeeded' && !task.preparationStage));
  assert.equal(env.imageInputs.length, 2);
  assert.equal(env.generated().length, 3, 'the other batch output is retained too');
});

test('cancelling visible tasks during delayed analysis retains records and prevents conversion and image submission', async () => {
  const env = harness(['shot-1', 'shot-3']);
  let release!: () => void;
  env.onAnalyze(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = env.run();
  const ids = env.tasks().map((task) => task.id);
  env.setCurrent((state) => ({ ...state, project: { ...state.project,
    generationTasks: ids.reduce((tasks, id) => taskHelpers.cancelQueuedGenerationTask(tasks, id).tasks, state.project.generationTasks),
  } }));
  release(); await pending;
  assert.deepEqual(env.tasks().map((task) => task.id), ids);
  assert.ok(env.tasks().every((task) => task.status === 'cancelled' && !task.preparationStage));
  assert.equal(env.conversions.length, 0); assert.equal(env.imageInputs.length, 0);
});

test('authored source edits and deletion retain stopped task records instead of silently discarding AI replies', async () => {
  for (const change of ['prompt', 'delete']) {
    const env = harness();
    env.onAnalyze(() => {
      env.setCurrent((state) => ({ ...state, project: {
        ...state.project,
        ...(change === 'prompt' ? { storyboards: state.project.storyboards.map((board) => ({ ...board, officialPromptZh: `${board.officialPromptZh}\n用户改稿` })) } : {}),
        ...(change === 'delete' ? { storyboards: [] } : {}),
      } }));
    });
    await env.run();
    assert.equal(env.analyses.length, 1, change);
    assert.equal(env.builds.length, 1, change); assert.equal(env.conversions.length, 0, change);
    assert.equal(env.imageInputs.length, 0, change); assert.equal(env.tasks().length, 1, change);
    assert.equal(env.tasks()[0].status, 'cancelled', change);
    assert.equal(env.busy(), false, change); assert.equal(env.lifecycle.isActive(env.guardKey), false, change);
  }
});

test('an older analysis cannot clear a later operation busy flag', async () => {
  const env = harness(); env.onAnalyze(() => { env.setBusy(true); });
  await env.run();
  assert.equal(env.builds.length, 2); assert.equal(env.busy(), true);
  assert.deepEqual(env.busyEvents, [true, true]); assert.equal(env.lifecycle.isActive(env.guardKey), false);
});

test('analysis errors retain their cause, release ownership and allow a fresh retry', async () => {
  const env = harness(); env.failAnalysis(new Error('fixture visibility API timeout'));
  await env.run();
  assert.equal(env.builds.length, 1); assert.equal(env.tasks().length, 1);
  assert.equal(env.tasks()[0].status, 'failed');
  assert.ok(env.notices.some((notice) => notice.level === 'error' && notice.message.includes('fixture visibility API timeout')));
  assert.equal(env.busy(), false); assert.equal(env.lifecycle.isActive(env.guardKey), false);
  env.failAnalysis(); await env.run();
  assert.equal(env.analyses.length, 2); assert.equal(env.tasks().length, 2);
  assert.equal(env.tasks()[0].status, 'succeeded'); assert.equal(env.tasks()[1].status, 'failed'); assert.equal(env.busy(), false);
});

test('converter/image failures release lease and busy without replaying paid generation', async () => {
  for (const stage of ['conversion', 'image']) {
    const env = harness();
    const failure = new Error(`fixture ${stage} failed`);
    if (stage === 'conversion') env.failConversion(failure); else env.failImage(failure);
    await env.run();
    assert.equal(env.tasks()[0].status, 'failed', stage);
    assert.equal(env.tasks()[0].error, failure.message, stage);
    assert.equal(env.conversions.length, 1, stage);
    assert.equal(env.imageInputs.length, stage === 'image' ? 1 : 0, stage);
    assert.equal(env.generated().length, 0, stage);
    assert.equal(env.busy(), false, stage); assert.equal(env.lifecycle.isActive(env.guardKey), false, stage);
  }
});

test('selected-shot errors hide identity echoes and original credentials after in-flight API settings change', async () => {
  for (const stage of ['conversion', 'image'] as const) {
    for (const encoding of ['raw', 'json'] as const) {
      const env = harness();
      const failWithEcho = (converterIdentityContext?: string) => {
        const task = env.tasks()[0];
        const identityContext = converterIdentityContext || task.conversionIdentityContext!;
        assert.match(identityContext, /青石茶港/u);
        assert.equal(identityContext, task.conversionIdentityContext);
        env.setCurrent((state) => ({ ...state, settings: { ...state.settings,
          textApi: { ...state.settings.textApi, apiKey: 'replacement-selected-text-credential' },
          imageApi: { ...state.settings.imageApi, apiKey: 'replacement-selected-image-credential' },
        } }));
        const echo = encoding === 'json' ? JSON.stringify(identityContext) : identityContext;
        const convertedPrompt = stage === 'image' ? env.imageInputs[0].prompt : '';
        const convertedEcho = encoding === 'json' ? JSON.stringify(convertedPrompt) : convertedPrompt;
        throw new Error(`HTTP 504 selected upstream timeout\nEchoed evidence ${echo}\nEchoed conversion result ${convertedEcho}\nSubmitted credential ${fixtureTextApiKey} ${fixtureImageApiKey}`);
      };
      if (stage === 'conversion') env.onConversion(failWithEcho); else env.onImage(failWithEcho);
      await env.run();
      const task = env.tasks()[0];
      assert.equal(task.status, 'failed');
      assert.equal(env.conversions.length, 1);
      assert.equal(env.imageInputs.length, stage === 'image' ? 1 : 0);
      assert.match(task.error || '', /HTTP 504 selected upstream timeout/u);
      for (const message of [task.error || '', ...env.notices.map((notice) => notice.message)]) {
        assert.doesNotMatch(message, /青石茶港|当前指定人物姓名|selected-fixture-frozen-(?:text|image)-credential/u,
          'errors and notifications do not reveal the original request after API settings change');
        if (stage === 'image') assert.ok(!message.includes(env.imageInputs[0].prompt), 'the selected image final prompt is not leaked in diagnostics');
      }
      assert.match(task.conversionIdentityContext || '', /青石茶港/u, 'conversion identity snapshot is retained');
      assert.equal(env.busy(), false); assert.equal(env.lifecycle.isActive(env.guardKey), false);
      if (stage === 'image') assert.equal(task.prompt, env.imageInputs[0].prompt);
    }
  }
});

test('queued cancellation or deletion still prevents conversion and image submission', async () => {
  for (const remove of [false, true]) {
    const env = harness();
    env.onQueued(() => env.setCurrent((state) => {
      const task = state.project.generationTasks.find(taskHelpers.isImageGenerationTask)!;
      taskHelpers.revokeQueuedGenerationTask(state.project.id, task);
      return { ...state, project: { ...state.project, generationTasks: remove ? [] : [{ ...task, status: 'cancelled' } as ImageGenerationTask] } };
    }));
    await env.run();
    assert.equal(env.conversions.length, 0); assert.equal(env.imageInputs.length, 0); assert.equal(env.generated().length, 0);
    assert.equal(env.tasks().length, remove ? 0 : 1);
    if (!remove) assert.equal(env.tasks()[0].status, 'cancelled');
    assert.equal(env.busy(), false); assert.equal(env.lifecycle.isActive(env.guardKey), false);
  }
});

test('completed images retain the original safe binding decision when history or source changes after submission', async () => {
  for (const change of ['history', 'source']) {
    const env = harness();
    env.onImage(() => {
      if (change === 'history') env.lifecycle.invalidateBindings();
      else env.setCurrent((state) => ({ ...state, project: { ...state.project,
        storyboards: state.project.storyboards.map((board) => ({ ...board, officialPromptZh: '用户提交后的新稿' })),
      } }));
    });
    await env.run();
    assert.equal(env.generated().length, 1, change); assert.equal(env.tasks()[0].status, 'succeeded', change);
    assert.ok(env.tasks()[0].bindingWarning, change);
    assert.deepEqual(env.current().project.storyboards[0].shots[1].referenceAssetIds, [], change);
    assert.equal(env.busy(), false, change); assert.equal(env.lifecycle.isActive(env.guardKey), false, change);
  }
});

test('selected-shot entry freezes one storyboard size before AI planning and retains it after queue changes', async () => {
  const env = harness(['shot-1', 'shot-3'], {
    outputSize: { mode: '2k', width: 1024, height: 1024 },
    imageResult: { dataUrl: pngWithDimensions(2048, 1152) },
  });
  const independentSizes = structuredClone(env.initial.settings.imageOutputSizes);
  const changeSize = (mode: StoryboardImageOutputSizePreference['mode']) => env.setCurrent((state) => ({
    ...state, settings: { ...state.settings, storyboardImageOutputSize: { mode, width: 1024, height: 1024 } },
  }));
  env.onAnalyze(() => changeSize('4k'));
  env.onQueued(() => changeSize('1k'));
  await env.run();

  const requested = { width: 2048, height: 1152, sizeOverride: true };
  assert.equal(env.imageInputs.length, 2);
  assert.equal(env.tasks().length, 2);
  for (const task of env.tasks()) {
    assert.equal(task.status, 'succeeded');
    assert.deepEqual({ width: task.width, height: task.height, sizeOverride: task.sizeOverride }, requested);
    assert.match(task.conversionSource || '', /画面规格：2048×1152 像素/u);
    assert.equal(task.bindingWarning, undefined, 'matching encoded size is not a warning');
  }
  for (const input of env.imageInputs) {
    assert.deepEqual({ width: input.width, height: input.height, sizeOverride: input.sizeOverride }, requested);
  }
  for (const asset of env.generated()) {
    assert.deepEqual(requestSizeFacts(asset.imageRequestSize), requested);
    assert.deepEqual({ width: asset.width, height: asset.height }, { width: 2048, height: 1152 });
  }
  assert.equal(env.current().settings.storyboardImageOutputSize?.mode, '1k', 'new preference is retained for the next batch');
  assert.deepEqual(env.current().settings.imageOutputSizes, independentSizes, 'ordinary/private preferences are independent');
  const board = env.current().project.storyboards[0];
  assert.equal(board.officialPromptZh, finalH3, 'pixel changes must not rewrite H3');
  assert.equal(board.finalPrompt, env.initial.project.storyboards[0].finalPrompt);
  assert.equal(board.resolution, '1080p', 'video output resolution must not follow image pixels');
  assert.equal(board.aspectRatio, '16:9');
  assert.deepEqual(board.shots.map(({ id, startSec, endSec }) => ({ id, startSec, endSec })),
    env.initial.project.storyboards[0].shots.map(({ id, startSec, endSec }) => ({ id, startSec, endSec })));
});

test('selected-shot default retains the legacy canvas and ignores ordinary/private output choices', async () => {
  const env = harness(['shot-2'], { outputSize: { mode: 'default', width: 1024, height: 1024 } });
  env.initial.settings.imageOutputSizes = {
    ordinary: { mode: 'custom', aspect: '1:1', width: 4096, height: 4096 },
    private: { mode: 'custom', aspect: '9:16', width: 576, height: 1024 },
  };
  const independentSizes = structuredClone(env.initial.settings.imageOutputSizes);
  await env.run();
  const requested = { width: 1536, height: 1024, sizeOverride: false };
  const task = env.tasks()[0];
  const input = env.imageInputs[0];
  assert.equal(task.status, 'succeeded');
  assert.deepEqual({ width: task.width, height: task.height, sizeOverride: task.sizeOverride }, requested);
  assert.deepEqual({ width: input.width, height: input.height, sizeOverride: input.sizeOverride }, requested);
  assert.deepEqual(requestSizeFacts(env.generated()[0].imageRequestSize), requested);
  assert.deepEqual(env.current().settings.imageOutputSizes, independentSizes);
  assert.equal(env.current().project.storyboards[0].resolution, '1080p');
});

test('selected-shot assets record encoded pixels separately from the original request snapshot', async () => {
  const env = harness(['shot-2'], {
    outputSize: { mode: '2k', width: 1024, height: 1024 },
    imageResult: { dataUrl: pngWithDimensions(1024, 576) },
  });
  await env.run();
  const requested = { width: 2048, height: 1152, sizeOverride: true };
  const task = env.tasks()[0];
  const asset = env.generated()[0];
  assert.equal(task.status, 'succeeded', 'a returned size mismatch must not reject a usable image');
  assert.deepEqual({ width: task.width, height: task.height, sizeOverride: task.sizeOverride }, requested);
  assert.deepEqual({ width: asset.width, height: asset.height }, { width: 1024, height: 576 });
  assert.deepEqual(requestSizeFacts(asset.imageRequestSize), requested);
  assert.match(task.bindingWarning || '', /实际返回1024×576.*请求2048×1152/u);
  assert.equal(env.current().project.storyboards[0].shots[1].referenceAssetIds[0], asset.id);
  env.setCurrent((state) => ({ ...state, project: { ...state.project, generationTasks: [] } }));
  assert.deepEqual(requestSizeFacts(env.generated()[0].imageRequestSize), requested, 'the request size survives deletion of its task');
});

test('selected-shot size mismatch is combined with stale-binding warnings instead of replacing them', async () => {
  for (const change of ['history', 'source']) {
    const env = harness(['shot-2'], {
      outputSize: { mode: '2k', width: 1024, height: 1024 },
      imageResult: { dataUrl: pngWithDimensions(1024, 576) },
    });
    env.onImage(() => {
      if (change === 'history') env.lifecycle.invalidateBindings();
      else env.setCurrent((state) => ({ ...state, project: { ...state.project,
        storyboards: state.project.storyboards.map((board) => ({ ...board, officialPromptZh: '提交后用户另写的新稿' })),
      } }));
    });
    await env.run();
    assert.equal(env.generated().length, 1, change);
    assert.equal(env.tasks()[0].status, 'succeeded', change);
    const warning = env.tasks()[0].bindingWarning || '';
    assert.match(warning, /未自动绑定/u, change);
    assert.match(warning, change === 'history' ? /撤销、重做或恢复/u : /分镜内容已变化/u, change);
    assert.match(warning, /实际返回1024×576.*请求2048×1152/u, change);
    assert.deepEqual(env.current().project.storyboards[0].shots[1].referenceAssetIds, [], change);
  }
});

test('selected-shot URL-only and unreadable outputs never report requested pixels as actual dimensions', async () => {
  for (const imageResult of [
    { url: 'https://never-called.example.test/generated.png' },
    { dataUrl: 'data:image/png;base64,Ag==' },
  ]) {
    const env = harness(['shot-3'], {
      outputSize: { mode: '4k', width: 1024, height: 1024 }, imageResult,
    });
    await env.run();
    assert.equal(env.tasks()[0].status, 'succeeded');
    const asset = env.generated()[0];
    assert.equal(asset.width, undefined, 'unknown width stays unknown');
    assert.equal(asset.height, undefined, 'unknown height stays unknown');
    assert.deepEqual(requestSizeFacts(asset.imageRequestSize), { width: 4096, height: 2304, sizeOverride: true });
    assert.equal(env.tasks()[0].bindingWarning, undefined, 'unknown metadata is not a confirmed mismatch');
  }
});

test('invalid custom storyboard pixels fail before visibility analysis or paid image generation', async () => {
  const env = harness(['shot-2'], { outputSize: { mode: 'custom', width: 0, height: 1152 } });
  await env.run();
  assert.equal(env.analyses.length, 0);
  assert.equal(env.conversions.length, 0);
  assert.equal(env.imageInputs.length, 0);
  assert.equal(env.tasks().length, 0);
  assert.equal(env.generated().length, 0);
  assert.ok(env.notices.some((notice) => notice.level === 'error' && /分镜图分辨率.*64–16384/u.test(notice.message)));
  assert.equal(env.busy(), false);
  assert.equal(env.lifecycle.isActive(env.guardKey), false);
});
