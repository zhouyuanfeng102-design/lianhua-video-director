import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as imageHelpers from '../src/storyboardImages';
import * as imageRules from '../src/imagePromptRules';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import * as taskHelpers from '../src/generationTasks';
import * as storyboardSizes from '../src/storyboardImageOutputSize';
import { imageReturnedSizeWarning } from '../src/imageOutputSize';
import { readGeneratedImageDimensions } from '../src/imageDimensions';
import { getComfyImageSizeOverrideSupport } from '../src/comfyui';
import { TextModelResponseError, type ImageGenerationOptions } from '../src/services/llm';
import { runtimeErrorStageLabel } from '../src/runtimeErrorLog';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import { imageBatchTaskIsActive } from '../src/imageBatch';
import { applyOwnedProjectUpdate, isCurrentProjectOperation, isCurrentStoryboardOperation } from '../src/appEffects';
import { checkNovelAIReferenceImagePreflight } from '../src/novelai';
import { refreshOfficialH3PromptAfterSourceUpdate } from '../src/officialPrompt';
import { createInitialState, normalizeState, safeFileName } from '../src/storage';
import { requestStoryboardImageFramePlan, validateStoryboardImagePlanCount } from '../src/storyboardImagePlan';
import { appendRegeneratedImageResult, buildImageRegenerationTask, executeImageRegeneration, resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import type { AppState, ImageGenerationTask, Storyboard, VideoShot } from '../src/types';

// Evaluate the production event handler with an isolated in-memory store and
// mocked API boundaries. No user profile, browser registration or paid API is used.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const director = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'DirectorView');
assert.ok(director && ts.isFunctionDeclaration(director) && director.body);
const declaration = (name: string): string => {
  const statement = director.body!.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(statement, `production ${name}`); return statement.getText(ast);
};
const evaluate = (name: string, bindings: Record<string, unknown>) => new Function('dependencies', `with (dependencies) {
  ${ts.transpileModule(declaration(name), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText}
  return ${name};
}`)(bindings);
const fixtureTextApiKey = 'batch-fixture-frozen-text-credential';
const fixtureImageApiKey = 'batch-fixture-frozen-image-credential';

const shot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5,
  purpose: '雨后漫步', subject: '女子', action: '握伞柄停在青石街道旁', camera: '固定中景',
  lighting: '柔和暖光', sound: '雨滴声', result: '女子看向街口', transition: '顺接',
  referenceAssetIds: [], prompt: '雨后青石街道上的女子。', locked: false,
});
const board = (count = 2): Storyboard => ({
  id: 'board-count', sceneId: 'scene-count', sourceStoryTitle: '雨后小巷', sourceStoryContent: '女子收拢雨伞后看向街口。',
  workflow: 'drama', inputMode: 'text', durationSec: count * 5, durationPreset: 'custom',
  shotMode: 'exact', shotCount: count, pace: 'standard', aspectRatio: '16:9', resolution: '1080p',
  audioMode: 'stereo', stylePresetId: 'cinematic', ruleSetId: 'timeline_director_cn', converterPresetId: 'converter',
  globalLock: '雨后的街道', shots: Array.from({ length: count }, (_, index) => shot(index + 1)),
  finalPrompt: '【0s-5s】主体：女子；动作：收伞。', officialPromptZh: 'original H3 artifact', createdAt: 1, updatedAt: 1,
});
const fixture = (count?: number, size?: storyboardSizes.StoryboardImageOutputSizePreference): AppState => {
  const state = createInitialState();
  const project = { ...state.project, id: 'project-count', description: '原创世界观“雨港行记”中的雨后街道。', characters: [], locations: [], props: [], scenes: [], assets: [],
    generationTasks: [], storyboards: [{ ...board(), storyboardImageCount: count }], sequencePlans: [] };
  return { ...state, project, projects: [project], activeProjectId: project.id, settings: {
    ...state.settings,
    ...(size ? { storyboardImageOutputSize: size } : {}),
    imageApi: { ...state.settings.imageApi, enabled: true, backend: 'openai', baseUrl: 'https://never-called.example.test', model: 'mock-image', apiKey: fixtureImageApiKey },
    textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://never-called.example.test', model: 'mock-text', apiKey: fixtureTextApiKey },
  } };
};
const harness = (count?: number, enriched = false, size?: storyboardSizes.StoryboardImageOutputSizePreference) => {
  let current = fixture(count, size);
  const initial = current;
  let serial = 0; let imageCalls = 0; let planCalls = 0; let conversionCalls = 0; let preparation: unknown;
  let sourceDuringPlan = '';
  const imageInputs: ImageGenerationOptions[] = [];
  let onImage: (() => void) | undefined;
  let onConversion: ((identityContext?: string) => void) | undefined;
  const errors: unknown[] = []; const notices: string[] = [];
  const errorReports: Array<{ stage: string; error: unknown; context?: { provider?: string; model?: string; endpoint?: string; projectId?: string } }> = [];
  const storyboard = initial.project.storyboards[0];
  const identity = { workspaceEpoch: 1, projectId: initial.project.id, storyboardId: storyboard.id,
    sourcePrompt: storyboard.finalPrompt, sourceStoryboardSnapshot: JSON.stringify(storyboard) };
  const context = () => ({ projectName: current.project.name, characters: current.project.characters, locations: current.project.locations,
    props: current.project.props, scenes: current.project.scenes, assets: current.project.assets,
    generationTaskNames: current.project.generationTasks.filter(taskHelpers.isImageGenerationTask).map((task) => task.name) });
  const commit = (update: AppState | ((state: AppState) => AppState)) => {
    const next = typeof update === 'function' ? update(current) : update;
    current = { ...next, projects: [next.project], activeProjectId: next.project.id };
  };
  let onPlan: (() => void) | undefined;
  const bindings: Record<string, unknown> = {
    ...imageHelpers, ...imageRules, ...taskHelpers, ...storyboardSizes, imageBatchTaskIsActive, buildImagePromptIdentityContext,
    runtimeErrorStageLabel, getSafeErrorDiagnostics,
    imageReturnedSizeWarning, readGeneratedImageDimensions, getComfyImageSizeOverrideSupport,
    state: initial, activeStoryboard: storyboard, customStoryboardImageCount: count,
    getCurrentStoryboardOperationIdentity: () => ({ ...identity }), // deliberately remains one render behind
    getCurrentProjectId: () => current.project.id, getCurrentState: () => current, getCurrentProjectImageContext: context,
    isCurrentProjectOperation, isCurrentStoryboardOperation, applyOwnedProjectUpdate,
    storyboardImageBatchLifecycle: imageHelpers.createStoryboardImageBatchLifecycle(),
    setState: commit, setBackgroundState: commit,
    setStoryboardImagePreparation: (value: unknown) => { preparation = typeof value === 'function' ? value(preparation) : value; },
    notify: (message: string) => notices.push(message), reportRuntimeError: (stage: string, error: unknown, context?: { provider?: string; model?: string; endpoint?: string; projectId?: string }) => {
      errors.push(error); errorReports.push({ stage, error, context });
    },
    setView: () => {}, setDirectorPane: () => {},
    imagePromptBackendForApi: (backend: string) => backend, checkNovelAIReferenceImagePreflight,
    validateStoryboardImagePlanCount, requestStoryboardImageFramePlan,
    prepareStoryboardImageIdentityContext: async () => ({ enriched,
      context: { ...context(), characters: enriched
        ? [{ ...createInitialState().project.characters[0], id: 'identity-qa', name: '女子', appearance: 'AI补齐的黑发青衣外貌', assetIds: [] }]
        : context().characters },
      plan: { targets: enriched ? [{ name: '女子', shotIds: ['shot-1', 'shot-2'], reason: 'missing-character', missingFields: ['appearance'] }] : [] },
    }),
    refreshOfficialH3PromptAfterSourceUpdate,
    requestTextModel: async (_api: unknown, _system: string, user: string) => {
      planCalls += 1; sourceDuringPlan = user; onPlan?.();
      const requestedCount = bindings.customStoryboardImageCount as number | undefined;
      return JSON.stringify(Array.from({ length: requestedCount || 0 }, (_, index) => ({
        sourceShotId: 'shot-1', description: `第${index + 1}个独立瞬间：女子握住伞柄，雨滴落在青石街边。`, timeSec: index / Math.max(1, requestedCount || 1),
      })));
    },
    requestImagePromptConverter: async (_api: unknown, _kind: unknown, _source: unknown, _format: unknown, _rules: unknown, identityContext?: string) => {
      conversionCalls += 1; onConversion?.(identityContext);
      return '雨后的青石街道，年轻女子站在店门旁，轻握伞柄。中景，固定机位，柔和暖光。';
    },
    requestImageModel: async (_api: unknown, input: ImageGenerationOptions, beforeSubmit?: () => void | Promise<void>) => {
      await beforeSubmit?.(); imageCalls += 1; imageInputs.push(structuredClone(input)); onImage?.();
      return { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC' };
    },
    window: {}, createId: (kind: string) => `${kind}-${++serial}`, safeFileName,
    isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  };
  return {
    run: evaluate('generateStoryboardImageBatch', bindings) as (mode: 'boundary-frames' | 'storyboard-shots') => Promise<void>,
    rerender: (nextCount: number) => {
      bindings.state = current; bindings.activeStoryboard = current.project.storyboards[0];
      bindings.customStoryboardImageCount = nextCount;
    },
    current: () => current, setCurrent: commit, initial, identity, errors, notices, errorReports,
    failImage: (error: Error) => { bindings.requestImageModel = async (_api: unknown, _input: unknown, beforeSubmit?: () => void | Promise<void>) => {
      await beforeSubmit?.(); imageCalls += 1; throw error;
    }; },
    failConversion: (error: Error) => { bindings.requestImagePromptConverter = async () => { throw error; }; },
    planResponse: (reply: (call: number) => string | Promise<string>) => {
      bindings.requestTextModel = async () => { planCalls += 1; onPlan?.(); return reply(planCalls); };
    },
    onPlan: (callback: () => void) => { onPlan = callback; },
    onConversion: (callback: (identityContext?: string) => void) => { onConversion = callback; },
    onImage: (callback: () => void) => { onImage = callback; }, imageInputs,
    conversionCalls: () => conversionCalls,
    calls: () => ({ imageCalls, planCalls }), preparation: () => preparation, sourceDuringPlan: () => sourceDuringPlan,
  };
};

test('production handler creates exactly 1/5/100 independent tasks, retains all outputs and leaves video shots unchanged', async () => {
  for (const count of [1, 5, 100]) {
    const env = harness(count);
    const before = env.initial.project.storyboards[0];
    await env.run('storyboard-shots');
    assert.deepEqual(env.errors, [], env.notices.join('\n'));
    assert.deepEqual(env.calls(), { imageCalls: count, planCalls: 1 });
    assert.equal(env.preparation(), undefined);
    const project = env.current().project;
    const tasks = project.generationTasks.filter(taskHelpers.isImageGenerationTask);
    assert.equal(tasks.length, count);
    assert.equal(project.assets.length, count);
    assert.equal(new Set(tasks.map((task) => task.name)).size, count);
    assert.deepEqual(tasks.map((task) => task.imageFrameIndex), Array.from({ length: count }, (_, index) => index + 1));
    assert.ok(tasks.every((task) => task.status === 'succeeded' && task.imageFrameCount === count && task.imageFrameDescription));
    assert.ok(project.assets.every((asset) => asset.imageFrameCount === count && asset.imageFrameDescription));
    assert.ok(tasks.every((task) => task.imageFrameBatchId === task.batchId));
    assert.ok(project.assets.every((asset) => asset.imageFrameBatchId === tasks[0].batchId));
    const after = project.storyboards[0];
    assert.equal(after.shots.length, before.shots.length);
    assert.deepEqual(after.shots.map(({ referenceAssetIds, ...rest }) => rest), before.shots.map(({ referenceAssetIds, ...rest }) => rest));
    assert.equal(after.finalPrompt, before.finalPrompt);
    assert.equal(after.durationSec, before.durationSec);
    assert.equal(after.shots[0].referenceAssetIds.length, count, 'multiple stills from one shot must not replace each other');
    assert.equal(after.shots[1].referenceAssetIds.length, 0);
  }
});

test('TLS image failures retain raw cause and actual frozen image context without replaying generation', async () => {
  const env = harness(1);
  const failure = new Error("Error invoking remote method 'lianhua:http-request': Error: Client network socket disconnected before secure TLS connection was established");
  env.failImage(failure);
  await env.run('storyboard-shots');
  assert.equal(env.calls().imageCalls, 1, 'no automatic paid retry');
  const task = env.current().project.generationTasks.find(taskHelpers.isImageGenerationTask)!;
  assert.equal(task.status, 'failed'); assert.equal(task.error, failure.message);
  assert.equal(env.current().project.assets.length, 0);
  const report = env.errorReports.find((entry) => (entry.error as { message?: string }).message === failure.message);
  assert.deepEqual(report?.error, getSafeErrorDiagnostics(failure), 'runtime reports carry safe diagnostics, not the provider error object');
  assert.equal(report?.context?.model, 'mock-image');
  assert.equal(report?.context?.provider, 'openai');
  assert.equal(report?.context?.endpoint, 'https://never-called.example.test');
  assert.equal(report?.context?.projectId, 'project-count');
});

test('conversion failure reports the text model and never pretends the image model was called', async () => {
  const failure = new TextModelResponseError('content_filter', '文本接口服务端返回内容过滤标记（content_filter）。');
  const env = harness(1); env.failConversion(failure);
  await env.run('storyboard-shots');
  assert.equal(env.calls().imageCalls, 0);
  const report = env.errorReports.find((entry) => entry.context?.model === 'mock-text');
  assert.ok(report); assert.deepEqual(report.error, getSafeErrorDiagnostics(failure), 'keep provider message and code in safe fields');
  assert.equal(report.stage, 'image-prompt-convert');
  const task = env.current().project.generationTasks.find(taskHelpers.isImageGenerationTask);
  assert.equal(task?.status, 'failed');
  assert.match(task?.error || '', /图像模型未调用.*content_filter/u);
});

test('batch errors redact raw/JSON identity evidence and frozen API keys after settings change, preserving cause and stage', async () => {
  for (const stage of ['conversion', 'image'] as const) {
    for (const encoding of ['raw', 'json'] as const) {
      const env = harness(1);
      const failWithEcho = (converterIdentityContext?: string) => {
        const task = env.current().project.generationTasks.find(taskHelpers.isImageGenerationTask)!;
        const identityContext = converterIdentityContext || task.conversionIdentityContext!;
        assert.match(identityContext, /雨港行记/u);
        assert.equal(identityContext, task.conversionIdentityContext, 'error evidence is the frozen converter input');
        env.setCurrent((state) => ({ ...state, settings: { ...state.settings,
          textApi: { ...state.settings.textApi, apiKey: 'replacement-batch-text-credential' },
          imageApi: { ...state.settings.imageApi, apiKey: 'replacement-batch-image-credential' },
        } }));
        const echo = encoding === 'json' ? JSON.stringify(identityContext) : identityContext;
        const convertedPrompt = stage === 'image' ? env.imageInputs[0].prompt : '';
        const convertedEcho = encoding === 'json' ? JSON.stringify(convertedPrompt) : convertedPrompt;
        throw Object.assign(new Error(`HTTP 504 batch upstream timeout\nEchoed evidence ${echo}\nEchoed conversion result ${convertedEcho}\nSubmitted credential ${fixtureTextApiKey} ${fixtureImageApiKey}`),
          { status: 504, code: 'ETIMEOUT' });
      };
      if (stage === 'conversion') env.onConversion(failWithEcho); else env.onImage(failWithEcho);
      await env.run('storyboard-shots');
      const task = env.current().project.generationTasks.find(taskHelpers.isImageGenerationTask)!;
      assert.equal(task.status, 'failed');
      assert.equal(env.conversionCalls(), 1, 'error display does not invoke the converter again');
      assert.equal(env.calls().imageCalls, stage === 'image' ? 1 : 0, 'no replay of image generation');
      assert.equal(env.errorReports.length, 1);
      const report = env.errorReports[0];
      assert.equal(report.stage, stage === 'image' ? 'image-generation' : 'image-prompt-convert');
      assert.equal((report.error as { status?: number }).status, 504);
      assert.equal((report.error as { code?: string }).code, 'ETIMEOUT');
      for (const value of [task.error || '', JSON.stringify(report.error), ...env.notices]) {
        assert.doesNotMatch(value, /雨港行记|batch-fixture-frozen-(?:text|image)-credential/u);
        if (stage === 'image') assert.ok(!value.includes(env.imageInputs[0].prompt), 'runtime diagnostics hide converted prompt echoes too');
      }
      assert.match(task.error || '', /HTTP 504 batch upstream timeout/u);
      assert.match((report.error as { message: string }).message, /HTTP 504 batch upstream timeout/u);
      assert.match(task.conversionIdentityContext || '', /雨港行记/u, 'error redaction leaves the saved identity evidence unchanged');
      if (stage === 'image') assert.equal(task.prompt, env.imageInputs[0].prompt);
    }
  }
});

test('equivalent wrapped plans create the requested images without an extra text call', async () => {
  const env = harness(2);
  env.planResponse(() => '规划如下：\n```json\n' + JSON.stringify({ frames: [
    { sourceShotId: 'shot-1', description: '女子正在收伞。', timeSec: 1 },
    { sourceShotId: 'shot-2', description: '女子抬头看向街口。', timeSec: 6 },
  ] }) + '\n```');
  const originalH3 = env.initial.project.storyboards[0].officialPromptZh;
  await env.run('storyboard-shots');
  assert.deepEqual(env.errors, [], env.notices.join('\n'));
  assert.deepEqual(env.calls(), { planCalls: 1, imageCalls: 2 });
  assert.equal(env.current().project.storyboards[0].officialPromptZh, originalH3);
});

test('production custom-count planner automatically recovers on the third repair with visible progress', async () => {
  const env = harness(1);
  env.planResponse((call) => call < 4 ? '{"frames":[' : JSON.stringify({ frames: [
    { sourceShotId: 'shot-1', description: '女子收拢雨伞。', timeSec: 1 },
  ] }));
  await env.run('storyboard-shots');
  assert.deepEqual(env.errors, [], env.notices.join('\n'));
  assert.deepEqual(env.calls(), { planCalls: 4, imageCalls: 1 });
  assert.ok(env.notices.some((notice) => /（3\/3）.*未闭合/u.test(notice)));
  assert.equal(env.preparation(), undefined);
});

test('planning provider refusal stops before images and logs the captured API even after selection changes', async () => {
  for (const stopAt of [1, 2]) {
    const env = harness(1);
    const failure = new TextModelResponseError('content_filter', '文本接口服务端返回内容过滤标记（content_filter）；不是本地校验。');
    env.onPlan(() => env.setCurrent((state) => ({ ...state, settings: { ...state.settings,
      textApi: { ...state.settings.textApi, model: 'new-text-selection', baseUrl: 'https://new-model.example.test' },
    } })));
    env.planResponse((call) => { if (call === stopAt) throw failure; return '{"frames":['; });
    await env.run('storyboard-shots');
    assert.deepEqual(env.calls(), { planCalls: stopAt, imageCalls: 0 });
    assert.equal(env.errorReports.length, 1);
    assert.equal(env.errorReports[0].stage, 'image-frame-plan');
    assert.equal(env.errorReports[0].error, failure);
    assert.equal(env.errorReports[0].context?.model, 'mock-text');
    assert.equal(env.errorReports[0].context?.endpoint, 'https://never-called.example.test');
    assert.equal(env.errorReports[0].context?.projectId, 'project-count');
    assert.ok(env.notices.some((notice) => /尚未提交生图.*content_filter/u.test(notice)));
    assert.equal(env.current().project.generationTasks.length, 0);
    assert.equal(env.preparation(), undefined);
  }
});

test('production full-batch replacement 2→3 retains five historical assets but binds only the three current frames', async () => {
  const env = harness(2); await env.run('storyboard-shots');
  const firstAssetIds = env.current().project.assets.map((asset) => asset.id);
  const firstBatchId = env.current().project.assets[0].imageFrameBatchId;
  env.rerender(3); await env.run('storyboard-shots');
  assert.deepEqual(env.errors, [], env.notices.join('\n'));
  assert.equal(env.current().project.assets.length, 5);
  assert.equal(env.current().project.generationTasks.length, 5);
  const currentReferences = env.current().project.storyboards[0].shots.flatMap((item) => item.referenceAssetIds);
  assert.equal(currentReferences.length, 3);
  assert.ok(currentReferences.every((id) => !firstAssetIds.includes(id)));
  assert.notEqual(env.current().project.assets[0].imageFrameBatchId, firstBatchId);
});

test('blank count keeps one image per video shot; boundary frames ignore the custom total', async () => {
  const standard = harness(); await standard.run('storyboard-shots');
  assert.deepEqual(standard.errors, [], standard.notices.join('\n'));
  assert.deepEqual(standard.calls(), { imageCalls: 2, planCalls: 0 });
  assert.ok(standard.current().project.assets.every((asset) => asset.imageFrameIndex === undefined));
  assert.ok(standard.current().project.assets.every((asset) => asset.imageFrameBatchId));
  const boundary = harness(100); await boundary.run('boundary-frames');
  assert.deepEqual(boundary.errors, [], boundary.notices.join('\n'));
  assert.deepEqual(boundary.calls(), { imageCalls: 2, planCalls: 0 });
  assert.ok(boundary.current().project.assets.every((asset) => asset.imageFrameBatchId === undefined));
});

test('all director still-image entry points use the shared resolution without modifying video dimensions or H3', async () => {
  const preferences: storyboardSizes.StoryboardImageOutputSizePreference[] = [
    { mode: '2k', width: 1024, height: 1024 },
    { mode: 'custom', width: 1600, height: 900 },
  ];
  for (const preference of preferences) {
    const expected = preference.mode === '2k' ? [2048, 1152, true] : [1600, 900, true];
    for (const [mode, count] of [['boundary-frames', undefined], ['storyboard-shots', undefined], ['storyboard-shots', 3]] as const) {
      const env = harness(count, false, preference);
      const original = structuredClone(env.initial.project.storyboards[0]);
      const ordinaryAndPrivate = structuredClone(env.initial.settings.imageOutputSizes);
      await env.run(mode);
      assert.deepEqual(env.errors, [], env.notices.join('\n'));
      assert.equal(env.imageInputs.length, count || 2);
      for (const input of env.imageInputs) assert.deepEqual([input.width, input.height, input.sizeOverride], expected, `${mode}/${count || 'per-shot'} actual model call pixels`);
      const tasks = env.current().project.generationTasks.filter(taskHelpers.isImageGenerationTask);
      for (const task of tasks) {
        assert.deepEqual([task.width, task.height, task.sizeOverride], expected, 'created task freezes the same explicit canvas');
        assert.match(task.conversionSource || '', new RegExp(`${expected[0]}.*${expected[1]}`, 'u'), 'converter receives actual still-image canvas');
        assert.match(task.bindingWarning || '', /实际返回2×2/u, 'provider downscale is visible, not silently relabeled as 2K');
        const asset = env.current().project.assets.find((entry) => entry.id === task.resultAssetId)!;
        assert.deepEqual([asset.width, asset.height], [2, 2], 'asset records actual returned pixels');
        assert.deepEqual(asset.imageRequestSize, { width: expected[0], height: expected[1], sizeOverride: true }, 'requested size is separately persisted for retry');
      }
      const updated = env.current().project.storyboards[0];
      for (const key of ['aspectRatio', 'resolution', 'durationSec', 'finalPrompt', 'officialPromptZh'] as const) assert.equal(updated[key], original[key], `still size must not mutate video ${key}`);
      assert.deepEqual(updated.shots.map(({ referenceAssetIds, ...rest }) => rest), original.shots.map(({ referenceAssetIds, ...rest }) => rest));
      assert.deepEqual(env.current().settings.imageOutputSizes, ordinaryAndPrivate, 'ordinary/private size lanes stay independent');
    }
  }
});

test('resolution is frozen before AI planning and queued image calls; setting changes only affect the next batch', async () => {
  const preference = { mode: '2k' as const, width: 1024, height: 1024 };
  const env = harness(4, false, preference);
  env.onPlan(() => env.setCurrent((current) => ({ ...current, settings: { ...current.settings,
    storyboardImageOutputSize: { mode: 'custom', width: 1400, height: 1000 },
  } })));
  env.onImage(() => env.setCurrent((current) => ({ ...current, settings: { ...current.settings,
    storyboardImageOutputSize: { mode: '4k', width: 1024, height: 1024 },
  } })));
  await env.run('storyboard-shots');
  assert.deepEqual(env.errors, [], env.notices.join('\n'));
  assert.equal(env.imageInputs.length, 4);
  for (const input of env.imageInputs) assert.deepEqual([input.width, input.height, input.sizeOverride], [2048, 1152, true], 'later queued calls never read a changed setting');
  const restored = normalizeState(JSON.parse(JSON.stringify(env.current())));
  const original = restored.project.generationTasks.find(taskHelpers.isImageGenerationTask)!;
  const source = resolveImageRegenerationSource(original, restored.project);
  const child = buildImageRegenerationTask(original, restored.project, { id: 'frozen-2k-retry', timestamp: 200, backend: 'openai', model: 'mock-image', source });
  await executeImageRegeneration(child, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { assert.fail('frozen successful prompt must not be reconverted'); }, persistPrompt: () => {},
    generateImage: async (input) => { assert.deepEqual([input.width, input.height, input.sizeOverride], [2048, 1152, true]); return 'mock'; },
  });
  const asset = restored.project.assets.find((entry) => entry.id === original.resultAssetId)!;
  const fromAsset = resolveImageAssetRegenerationTask(asset, { ...restored.project, generationTasks: [] }, restored.settings.imageApi)!;
  assert.deepEqual([fromAsset.width, fromAsset.height, fromAsset.sizeOverride], [2048, 1152, true], 'deleting the source task does not make retries use actual downscaled pixels or newest setting');
  assert.deepEqual([original.width, original.height, original.sizeOverride], [2048, 1152, true], 'historical task snapshot remains unmodified');
});

test('owned identity enrichment stays current before React renders, keeps the saved H3 body and uses new identity facts for images', async () => {
  const env = harness(3, true); await env.run('storyboard-shots');
  assert.deepEqual(env.errors, [], env.notices.join('\n'));
  assert.deepEqual(env.calls(), { imageCalls: 3, planCalls: 1 });
  assert.match(env.sourceDuringPlan(), /original H3 artifact/u);
  assert.equal(env.current().project.storyboards[0].officialPromptZh, 'original H3 artifact');
  assert.ok(env.current().project.generationTasks.filter(taskHelpers.isImageGenerationTask)
    .every((task) => task.conversionSource?.includes('AI补齐的黑发青衣外貌')));
});

test('edits, deletion, workspace undo and navigation during AI planning create no image tasks', async () => {
  for (const change of ['edit', 'delete', 'undo', 'navigate', 'project']) {
    const env = harness(3, true);
    env.onPlan(() => {
      if (change === 'undo') env.identity.workspaceEpoch += 1;
      else if (change === 'navigate') env.identity.storyboardId = 'another-board';
      else env.setCurrent((current) => ({ ...current, project: {
        ...current.project,
        ...(change === 'project' ? { id: 'another-project' } : {}),
        storyboards: change === 'delete' ? [] : current.project.storyboards.map((item) => change === 'edit'
          ? { ...item, finalPrompt: 'user edited canonical prompt' } : item),
      } }));
    });
    await env.run('storyboard-shots');
    assert.equal(env.calls().imageCalls, 0, change);
    assert.equal(env.current().project.generationTasks.length, 0, change);
    assert.equal(env.preparation(), undefined, change);
  }
});

test('quantity input accepts blank/1–100, persists per board and rejects invalid totals without changing video structure', () => {
  let current = fixture(); let draft: unknown;
  const input = evaluate('changeStoryboardImageCount', {
    state: current, directorResultStoryboard: current.project.storyboards[0], storyboardImageCountKey: 'project-count:board-count',
    STORYBOARD_IMAGE_PLAN_MAX_COUNT: 100,
    setStoryboardImageCountDraft: (value: unknown) => { draft = value; },
    setState: (update: (state: AppState) => AppState) => { current = update(current); },
  }) as (value: string) => void;
  const originalShots = current.project.storyboards[0].shots;
  for (const count of ['1', '100', '12']) { input(count); assert.equal(current.project.storyboards[0].storyboardImageCount, Number(count)); }
  for (const invalid of ['0', '101', '-1', '1.5']) { input(invalid); assert.equal(current.project.storyboards[0].storyboardImageCount, 12); }
  input(''); assert.equal(current.project.storyboards[0].storyboardImageCount, undefined);
  assert.deepEqual(draft, { key: 'project-count:board-count', value: '' });
  assert.strictEqual(current.project.storyboards[0].shots, originalShots);
  assert.match(source, /aria-label="自定义分镜图片数量"/u);
  assert.match(source, /生成分镜图片（\$\{effectiveStoryboardImageCount\}张）/u);
});

test('JSON save/reload retains high image counts and slot metadata independently of the workbench 8-image limit', async () => {
  const env = harness(100); await env.run('storyboard-shots');
  assert.deepEqual(env.errors, []);
  const restored = normalizeState(JSON.parse(JSON.stringify(env.current())));
  assert.equal(restored.project.storyboards[0].storyboardImageCount, 100);
  const tasks = restored.project.generationTasks.filter(taskHelpers.isImageGenerationTask);
  assert.equal(tasks.length, 100);
  assert.equal(tasks[99].imageFrameIndex, 100); assert.equal(tasks[99].imageFrameCount, 100);
  assert.equal(tasks[99].imageFrameBatchId, tasks[99].batchId);
  assert.equal(tasks[0].imageFrameTimeSec, 0, 'time zero is not missing');
  assert.equal(restored.project.assets[0].imageFrameIndex, 100);
  assert.equal(restored.project.assets[0].imageFrameBatchId, tasks[99].imageFrameBatchId);
  assert.equal(restored.project.assets.at(-1)?.imageFrameTimeSec, 0);
  const malformed = JSON.parse(JSON.stringify(env.current()));
  malformed.project.storyboards[0].storyboardImageCount = 101;
  malformed.project.generationTasks[0].imageFrameCount = '100';
  malformed.project.generationTasks[0].imageFrameTimeSec = '1';
  malformed.project.assets[0].imageFrameIndex = 0;
  malformed.projects = [malformed.project];
  const normalized = normalizeState(malformed);
  assert.equal(normalized.project.storyboards[0].storyboardImageCount, undefined);
  assert.equal((normalized.project.generationTasks[0] as ImageGenerationTask).imageFrameCount, undefined);
  assert.equal((normalized.project.generationTasks[0] as ImageGenerationTask).imageFrameTimeSec, undefined);
  assert.equal(normalized.project.assets[0].imageFrameIndex, undefined);
});

test('retry preserves the same custom frame, frozen prompt and references, including after original task deletion', async () => {
  const env = harness(3); await env.run('storyboard-shots');
  const project = normalizeState(JSON.parse(JSON.stringify(env.current()))).project;
  const original = project.generationTasks.filter(taskHelpers.isImageGenerationTask)[1];
  const retrySource = resolveImageRegenerationSource(original, project);
  assert.equal(retrySource.conversionSource, original.conversionSource);
  const retried = buildImageRegenerationTask(original, project, {
    id: 'retry-frame-2', timestamp: 99, backend: 'openai', model: 'mock-image', source: retrySource,
  });
  assert.equal(retried.imageFrameIndex, 2); assert.equal(retried.imageFrameCount, 3);
  assert.equal(retried.imageFrameBatchId, original.imageFrameBatchId);
  assert.equal(retried.imageFrameDescription, original.imageFrameDescription);
  let conversionCalls = 0; let promptSent = '';
  await executeImageRegeneration(retried, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { conversionCalls += 1; return 'unexpected'; }, persistPrompt: () => {},
    generateImage: async (input) => { promptSent = input.prompt; return 'mock'; },
  });
  assert.equal(conversionCalls, 0); assert.equal(promptSent, original.prompt);
  const asset = project.assets.find((item) => item.id === original.resultAssetId)!;
  const synthetic = resolveImageAssetRegenerationTask(asset, { ...project, generationTasks: [] }, env.current().settings.imageApi)!;
  assert.equal(synthetic.imageFrameIndex, 2); assert.equal(synthetic.imageFrameDescription, asset.imageFrameDescription);
  assert.equal(synthetic.imageFrameBatchId, asset.imageFrameBatchId);
  const legacy = { ...synthetic, prompt: '' };
  const recovered = resolveImageRegenerationSource(legacy, project);
  assert.ok(recovered.conversionSource.includes(asset.imageFrameDescription!));
  assert.ok(!recovered.conversionSource.includes(project.assets.find((item) => item.imageFrameIndex === 1)!.imageFrameDescription!));
  assert.throws(() => resolveImageRegenerationSource({ ...legacy, imageFrameDescription: undefined }, project), /自定义分镜图片缺少/u);
  const savedOnly = resolveImageRegenerationSource({ ...synthetic, imageFrameDescription: undefined }, project);
  assert.equal(savedOnly.conversionSource, ''); assert.match(savedOnly.warning || '', /已保存的最终提示词/u);
  assert.deepEqual(original, project.generationTasks.find((item) => item.id === original.id), 'never rewrite the source task');
  const newBatchAsset = { ...asset, id: 'new-batch-result', imageFrameBatchId: 'newer-full-batch' };
  const newBatchProject = { ...project, assets: [newBatchAsset, ...project.assets], generationTasks: [retried, ...project.generationTasks],
    storyboards: project.storyboards.map((item) => ({ ...item, shots: item.shots.map((shot) => ({ ...shot, referenceAssetIds: [newBatchAsset.id] })) })),
  };
  const retriedAsset = { ...asset, id: 'retried-old-batch-result', imageFrameBatchId: retried.imageFrameBatchId };
  const appended = appendRegeneratedImageResult(newBatchProject, retried, retriedAsset);
  assert.strictEqual(appended.storyboards, newBatchProject.storyboards, 'retrying an old batch never replaces the newer selected image batch');
  assert.ok(appended.assets.some((item) => item.id === retriedAsset.id), 'retry result remains available as a separate asset');
});

test('regenerated result asset construction carries the batch identity and four frozen custom-frame fields', () => {
  const frameFields = ['imageFrameBatchId', 'imageFrameIndex', 'imageFrameCount', 'imageFrameDescription', 'imageFrameTimeSec'];
  const assetObjects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property)
      && property.name.getText(ast) === 'prompt' && property.initializer.getText(ast) === 'result.finalPrompt')) assetObjects.push(node);
    ts.forEachChild(node, visit);
  }; visit(ast);
  assert.ok(assetObjects.some((node) => frameFields.every((field) => node.properties.some((property) => ts.isPropertyAssignment(property)
    && property.name.getText(ast) === field && property.initializer.getText(ast) === `task.${field}`))));
});
