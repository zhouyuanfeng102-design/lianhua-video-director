import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { validateStoryboardImagePlanCount } from '../src/storyboardImagePlan';
import { defaultStoryboardImageOutputSize, resolveStoryboardImageOutputSize } from '../src/storyboardImageOutputSize';
import type { DirectStoryboardImageGenerationOptions } from '../src/storyboardImageToImageGeneration';
import type { AppState, Storyboard, VideoShot } from '../src/types';

// Execute the actual App button handlers, with only the dispatch/API boundaries
// and React state shell mocked. This test cannot submit paid generation calls.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extract = (viewName: string, handlerName: string): string => {
  const view = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === viewName);
  assert.ok(view && ts.isFunctionDeclaration(view) && view.body, `production ${viewName}`);
  const statement = view.body.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === handlerName));
  assert.ok(statement, `production ${viewName}.${handlerName}`);
  return ts.transpileModule(statement.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
};
const directorJavascript = extract('DirectorView', 'generateStoryboardImageBatch');
const workbenchJavascript = extract('ImageWorkbenchView', 'generateSelectedStoryboardImages');
const evaluate = (javascript: string, name: string, bindings: Record<string, unknown>) =>
  new Function('dependencies', `with (dependencies) { ${javascript}\nreturn ${name}; }`)(bindings);

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden in reference-button routing tests'); };
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, 'the test must use only in-memory mocked dispatch boundaries');
});

const shot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5,
  subject: '雨后小巷的女子', action: '收伞', purpose: '经过街口', camera: '固定中景',
  lighting: '柔光', sound: '雨滴', result: '看向街口', transition: '顺接',
  referenceAssetIds: ['legacy-shot-reference'], prompt: '原视频镜头', locked: false,
});
const storyboard = (referenceIds: readonly string[]): Storyboard => ({
  id: 'board-original-buttons', sceneId: 'scene-1', workflow: 'drama', inputMode: 'text',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard',
  aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: 'cinematic',
  ruleSetId: 'timeline_director_cn', converterPresetId: 'converter', globalLock: '原角色身份',
  finalPrompt: '原视频剧情正文', officialPromptZh: '已确认 H3 原文不能变化',
  globalReferenceAssetIds: referenceIds.length ? ['missing-legacy-video-reference'] : [],
  shots: [1, 2, 3].map(shot), createdAt: 1, updatedAt: 1,
  imageToImage: {
    referenceAssetIds: [...referenceIds], selectedShotIds: ['shot-1'],
    referenceAssetIdsByShotId: { 'shot-1': ['obsolete-per-shot-selection'] },
  },
});

type Preparation = { key: string; mode: string } | undefined;
const harness = (options: { refs?: readonly string[]; count?: number; shotIds?: string[] } = {}) => {
  const initial = createInitialState();
  const board = storyboard(options.refs || ['picked-b', 'picked-a']);
  const project = { ...initial.project, id: 'project-original-buttons', storyboards: [board], assets: [], generationTasks: [] };
  const state: AppState = {
    ...initial, project, projects: [project], activeProjectId: project.id,
    settings: {
      ...initial.settings,
      imageApi: { ...initial.settings.imageApi, enabled: true, backend: 'openai', baseUrl: 'https://never-called.example.test', model: 'mock-image' },
      // Default/selected/boundary img2img must never require a text API. Custom
      // count planning is owned by the direct controller, not these buttons.
      textApi: { ...initial.settings.textApi, enabled: false, baseUrl: '', model: '' },
    },
  };
  const boardBefore = JSON.stringify(board);
  const selectedShotIds = options.shotIds || ['shot-3', 'shot-2'];
  const contextShell = { id: 'app-context-shell' };
  const directContext = { id: 'direct-generation-context' };
  const dispatches: Array<{ context: unknown; projectId: string; boardId: string; options: DirectStoryboardImageGenerationOptions }> = [];
  const contextCalls: unknown[] = [];
  const oldPathCalls: string[] = [];
  const notices: string[] = [];
  const views: string[] = [];
  const errors: unknown[] = [];
  const preparationEvents: Preparation[] = [];
  const busyEvents: boolean[] = [];
  let preparation: Preparation;
  let busy = false;
  let busyEpoch = 0;
  let dispatchWork = async (): Promise<void> => {};
  const setBusy = (next: boolean) => { busy = next; busyEpoch += 1; busyEvents.push(next); };
  const forbiddenOldStep = (name: string) => () => {
    oldPathCalls.push(name);
    assert.fail(`reference-bearing original buttons must not enter ${name}`);
  };
  const bindings: Record<string, unknown> = {
    state, ctx: contextShell, activeStoryboard: board, selectedStoryboard: board,
    customStoryboardImageCount: options.count, selectedStoryboardShotIds: selectedShotIds,
    validateStoryboardImagePlanCount, defaultStoryboardImageOutputSize, resolveStoryboardImageOutputSize,
    storyboardReferenceGenerationContext: (ctx: unknown) => { contextCalls.push(ctx); return directContext; },
    generateDirectStoryboardImages: async (context: unknown, projectId: string, boardId: string, request: DirectStoryboardImageGenerationOptions) => {
      dispatches.push({ context, projectId, boardId, options: request });
      await dispatchWork();
    },
    setStoryboardImagePreparation: (update: Preparation | ((current: Preparation) => Preparation)) => {
      preparation = typeof update === 'function' ? update(preparation) : update;
      preparationEvents.push(preparation);
    },
    setBusy, getBusyEpoch: () => busyEpoch,
    getCurrentStoryboardOperationIdentity: () => { oldPathCalls.push('legacy-operation-identity'); return {}; },
    notify: (message: string) => notices.push(message),
    setView: (view: string) => views.push(view),
    reportRuntimeError: (_stage: string, error: unknown) => errors.push(error),
    prepareStoryboardImageIdentityContext: forbiddenOldStep('identity-enrichment'),
    requestStoryboardVisibleCharacters: forbiddenOldStep('character-visibility-analysis'),
    requestImagePromptConverter: forbiddenOldStep('text-prompt-conversion'),
    requestTextModel: forbiddenOldStep('button-level-text-model'),
    requestVisionAnalysis: forbiddenOldStep('image-analysis'),
    requestStoryboardImageFramePlan: forbiddenOldStep('button-level-custom-planning'),
    requestImageModel: forbiddenOldStep('old-image-model-path'),
    getCurrentProjectImageContext: forbiddenOldStep('old-character-context'),
    setState: forbiddenOldStep('button-storyboard-mutation'),
    setBackgroundState: forbiddenOldStep('button-background-mutation'),
  };
  return {
    runDirector: evaluate(directorJavascript, 'generateStoryboardImageBatch', bindings) as (mode: 'storyboard-shots' | 'boundary-frames') => Promise<void>,
    runSelected: evaluate(workbenchJavascript, 'generateSelectedStoryboardImages', bindings) as () => Promise<void>,
    state, board, boardBefore, selectedShotIds, dispatches, contextCalls, oldPathCalls,
    contextShell, directContext, notices, views, errors, preparationEvents, busyEvents,
    preparation: () => preparation, busy: () => busy,
    onDispatch: (work: () => Promise<void>) => { dispatchWork = work; },
    replacePreparation: (next: Preparation) => { preparation = next; },
    startNewBusyOperation: () => setBusy(true),
  };
};

const assertDirectOnly = (env: ReturnType<typeof harness>) => {
  assert.deepEqual(env.oldPathCalls, [], 'the old converter/enrichment/image path must not run');
  assert.deepEqual(env.notices, [], 'a disabled text API or old video reference must not block direct dispatch');
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.views, []);
  assert.deepEqual(env.contextCalls, [env.contextShell]);
  assert.equal(env.dispatches.length, 1);
  assert.equal(env.dispatches[0].context, env.directContext);
  assert.equal(env.dispatches[0].projectId, env.state.project.id);
  assert.equal(env.dispatches[0].boardId, env.board.id);
  assert.equal(JSON.stringify(env.board), env.boardBefore, 'button dispatch never rewrites H3, references, video shots or timing');
};

test('original director default/custom-count/boundary buttons dispatch the shared-reference mode exactly once', async () => {
  for (const [mode, count] of [
    ['storyboard-shots', undefined], ['storyboard-shots', 1], ['storyboard-shots', 9], ['storyboard-shots', 100],
    ['boundary-frames', undefined], ['boundary-frames', 9], ['boundary-frames', 100],
  ] as const) {
    const env = harness({ count });
    await env.runDirector(mode);
    assertDirectOnly(env);
    assert.deepEqual(env.dispatches[0].options, { mode, count: mode === 'storyboard-shots' ? count : undefined });
    assert.deepEqual(env.preparationEvents, [{ key: `${env.state.project.id}:${env.board.id}`, mode }, undefined]);
    assert.equal(env.preparation(), undefined);
    assert.deepEqual(env.busyEvents, []);
  }
});

test('original ImageWorkbench selected-shot button passes its own selection, not retired panel shot bindings', async () => {
  const env = harness({ count: 100, shotIds: ['shot-3', 'shot-2'] });
  await env.runSelected();
  assertDirectOnly(env);
  assert.deepEqual(env.dispatches[0].options, { mode: 'selected-shots', shotIds: ['shot-3', 'shot-2'] });
  assert.notEqual(env.dispatches[0].options.shotIds, env.selectedShotIds, 'dispatch freezes the selected-shot array');
  env.selectedShotIds.push('shot-1');
  assert.deepEqual(env.dispatches[0].options.shotIds, ['shot-3', 'shot-2']);
  assert.deepEqual(env.busyEvents, [true, false]);
  assert.equal(env.busy(), false);
  assert.deepEqual(env.preparationEvents, []);
});

test('original buttons remain pending until direct generation settles and never erase a newer busy state', async () => {
  let finishDirector!: () => void;
  const director = harness();
  director.onDispatch(() => new Promise<void>((resolve) => { finishDirector = resolve; }));
  const directorRun = director.runDirector('boundary-frames');
  assert.equal(director.preparation()?.mode, 'boundary-frames');
  const newerPreparation = { key: 'new-board', mode: 'storyboard-shots' };
  director.replacePreparation(newerPreparation);
  finishDirector();
  await directorRun;
  assert.equal(director.preparation(), newerPreparation, 'old completion must retain a newer director preparation');
  assertDirectOnly(director);

  let finishWorkbench!: () => void;
  const workbench = harness();
  workbench.onDispatch(() => new Promise<void>((resolve) => { finishWorkbench = resolve; }));
  const workbenchRun = workbench.runSelected();
  assert.equal(workbench.busy(), true);
  workbench.startNewBusyOperation();
  finishWorkbench();
  await workbenchRun;
  assert.equal(workbench.busy(), true, 'old completion must retain the new busy epoch');
  assert.deepEqual(workbench.busyEvents, [true, true]);
  assertDirectOnly(workbench);
});

test('direct-dispatch failure releases each original button without falling through to conversion', async () => {
  for (const entry of ['director', 'workbench'] as const) {
    const env = harness();
    const failure = new Error('mock direct generation failed');
    env.onDispatch(async () => { throw failure; });
    await assert.rejects(entry === 'director' ? env.runDirector('storyboard-shots') : env.runSelected(), failure);
    assertDirectOnly(env);
    assert.equal(env.preparation(), undefined);
    assert.equal(env.busy(), false);
  }
});

test('without shared references the original buttons still enter their existing text-only path', async () => {
  // The complete no-reference conversion/output regression is also covered by
  // customStoryboardImages and spatialSelectedStoryboardEntry. Here the real
  // disabled-text-API guard proves neither original route is hijacked by i2i.
  for (const entry of ['director-default', 'director-custom', 'director-boundary', 'workbench'] as const) {
    const env = harness({ refs: [], count: entry === 'director-custom' ? 9 : undefined });
    if (entry === 'workbench') await env.runSelected();
    else await env.runDirector(entry === 'director-boundary' ? 'boundary-frames' : 'storyboard-shots');
    assert.deepEqual(env.dispatches, []);
    assert.deepEqual(env.contextCalls, []);
    assert.ok(env.notices.some((notice) => notice.includes('分镜图片必须先由文本模型转换成最终生图提示词')));
    assert.deepEqual(env.views, ['settings']);
    assert.equal(JSON.stringify(env.board), env.boardBefore);
  }
});

test('existing visible result buttons remain wired to the original handlers', () => {
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick' && node.initializer) {
      const click = node.initializer.getText(ast);
      if (/generateStoryboardImageBatch|generateSelectedStoryboardImages/u.test(click)) calls.push(click);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.deepEqual(calls.sort(), [
    '{() => void generateSelectedStoryboardImages()}',
    '{() => void generateStoryboardImageBatch("boundary-frames")}',
    '{() => void generateStoryboardImageBatch("storyboard-shots")}',
  ].sort());
});
