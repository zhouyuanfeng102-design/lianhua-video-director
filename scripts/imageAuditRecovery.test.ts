import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { applyOwnedProjectUpdate, commitStateTransition, isCurrentProjectOperation, takeHistoryStep } from '../src/appEffects';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import {
  AUTOFILL_BASIS_CHANGED_WARNING, AUTOFILL_RESULT_NOT_APPLIED_WARNING,
  addAutofillGenerationTaskToOwningProject, advanceAutofillTargetEpoch, canApplyAutofillResult,
  createAutofillGenerationTask, imageAssetKindLabel, imageAutofillBasisChanged,
  imageAutofillBasisFieldChanged, isAutofillGenerationTask, isImageGenerationTask,
  GenerationTaskCancelledError, isGenerationTaskCancelledError, isGenerationTaskRevoked,
  patchImageGenerationTask, settleAutofillGenerationTask, settleImageGenerationTask,
} from '../src/generationTasks';
import { cloneImageBatchConfig, imageBatchTaskIsActive, isImageTaskActiveInWorkspace } from '../src/imageBatch';
import { imageApiRegenerationSourceIdentity, resolveImageApiForRegeneration } from '../src/imageApiSelection';
import {
  imageWorkbenchEntityToForm, isPrivateImageVariant, mergeCharacterPrivateProfileAutofill,
  mergeMissingImageAssetFormFields, missingCharacterPrivateProfileBasisFields, missingImageAssetFormFields,
  normalizePrivateSingleImagePrompt, privateImagePromptProblem, privateImageVariantConverterRule,
  privateImageVariantRepairRule,
} from '../src/imageGeneration';
import { buildImagePromptConverterSystemPrompt, resolveImagePromptSelection, sanitizeFinalImagePrompt } from '../src/imagePromptRules';
import {
  appendRegeneratedImageResult, buildImageRegenerationTask, canRegenerateImageTask,
  executeImageRegeneration, imageRegenerationRootId, resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { checkNovelAIReferenceImagePreflight } from '../src/novelai';
import { requestImageModel } from '../src/services/llm';
import { createInitialState } from '../src/storage';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import type { AppState, Character, ImageGenerationTask } from '../src/types';

// Execute the actual App transactions with in-memory state and mocked model
// boundaries. No user storage, generated media files, or real API is touched.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.Node>();
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && ['completeAssetDetails', 'updateField'].includes(node.name.text)) declarations.set(node.name.text, node);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'regenerateImageTask') declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
};
visit(ast);
const production = (names: string[]): string => ts.transpileModule(names.map((name) => {
  const node = declarations.get(name);
  assert.ok(node, `missing production transaction: ${name}`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const regenerationFixture = (options: {
  prompt?: string;
  identityContext?: string;
  textApiKey?: string;
  resolveApi?: typeof resolveImageApiForRegeneration;
  readImages?: (ids: string[]) => Promise<string[]>;
  convert?: () => Promise<string>;
  generate?: (start: () => void | Promise<void>) => Promise<{ url: string }>;
} = {}) => {
  let state = createInitialState();
  const original: ImageGenerationTask = {
    id: 'original-image', kind: 'image', name: '原图片', assetKind: 'character', imageVariant: 'full-body',
    status: 'succeeded', prompt: options.prompt ?? 'saved picture prompt', width: 1024, height: 1024,
    backend: 'openai', model: 'mock', conversionSource: 'saved source', converterSystemPrompt: 'saved rules',
    conversionIdentityContext: options.identityContext,
    imagePromptFormat: 'natural-language', primaryReferenceAssetIds: [], referenceAssetIds: [], createdAt: 1, updatedAt: 1,
  };
  state = {
    ...state,
    project: { ...state.project, generationTasks: [original], assets: [] },
    settings: { ...state.settings,
      imageApi: { enabled: true, backend: 'openai', baseUrl: 'https://not-called.invalid', apiKey: '', model: 'mock' },
      textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://not-called.invalid', apiKey: options.textApiKey || '', model: 'mock' },
    },
  };
  state.projects = [state.project];
  let undo: AppState[] = [];
  let redo: AppState[] = [];
  let posts = 0;
  let conversions = 0;
  const notices: string[] = [];
  const lifecycle = createStoryboardImageBatchLifecycle();
  const queued = deferred();
  const update = (recordHistory: boolean) => (reduce: (current: AppState) => AppState) => {
    const transition = commitStateTransition(state, reduce(state), undo, redo, recordHistory, 50, recordHistory ? undefined : reduce);
    state = transition.current; undo = transition.undo; redo = transition.redo;
    if (state.project.generationTasks.some((task) => task.id === 'image_task-audit' && task.kind === 'image' && task.status === 'queued')) queued.resolve();
  };
  const d = {
    GenerationTaskCancelledError, isGenerationTaskCancelledError, isGenerationTaskRevoked,
    isImageGenerationTask, canRegenerateImageTask, imageRegenerationRootId, resolveImageRegenerationSource,
    buildImageRegenerationTask, executeImageRegeneration, checkNovelAIReferenceImagePreflight, enqueueImageTask,
    applyOwnedProjectUpdate, patchImageGenerationTask, settleImageGenerationTask, isCurrentProjectOperation,
    cloneImageBatchConfig, imageBatchTaskIsActive, sanitizeFinalImagePrompt, appendRegeneratedImageResult,
    imageApiRegenerationSourceIdentity, resolveImageApiForRegeneration: options.resolveApi || resolveImageApiForRegeneration, getSafeErrorDiagnostics,
    isPrivateImageVariant, normalizePrivateSingleImagePrompt, privateImagePromptProblem,
    privateImageVariantConverterRule, privateImageVariantRepairRule,
    buildImagePromptConverterSystemPrompt, resolveImagePromptSelection,
    createId: (prefix: string) => `${prefix}-audit`, readGeneratedImageDimensions: () => undefined,
    imageReturnedSizeWarning: () => '', safeFileName: (value: string) => value,
    resolveStoryboardReferenceImages: options.readImages || (async () => []),
    requestImagePromptConverter: async () => { conversions += 1; return options.convert ? options.convert() : 'converted picture'; },
    requestImageModel: async (_api: unknown, _input: unknown, start: () => void | Promise<void>) => {
      const send = async () => { await start(); posts += 1; };
      if (options.generate) return options.generate(send);
      await send();
      return { url: 'https://fixture.invalid/result.png' };
    },
  };
  const handler = new Function('d', `with(d){${production(['regenerateImageTask'])}; return regenerateImageTask;}`)(d);
  const ctx = {
    state, setState: update(true), setBackgroundState: update(false), storyboardImageBatchLifecycle: lifecycle,
    getCurrentState: () => state, getCurrentProjectId: () => state.project.id,
    setView: () => {}, notify: (value: string) => notices.push(value),
  };
  return {
    run: () => handler(ctx, original) as Promise<void>,
    // API-route fingerprints now finish before the real insertion. These
    // tests intentionally exercise a queued request, not pre-creation input
    // invalidation (which has separate delayed-hash integration coverage).
    waitUntilQueued: (pending: Promise<void>) => Promise.race([
      queued.promise,
      pending.then(() => { assert.fail('regeneration completed without inserting its expected queued task'); }),
    ]),
    undo: () => {
      const step = takeHistoryStep(state, undo, redo); state = step.current; undo = step.source; redo = step.destination;
      if (step.changed) { lifecycle.invalidateBindings(); lifecycle.revokeMissingSubmissions((taskId) => isImageTaskActiveInWorkspace(state, taskId)); }
    },
    redo: () => {
      const step = takeHistoryStep(state, redo, undo); state = step.current; redo = step.source; undo = step.destination;
      if (step.changed) { lifecycle.invalidateBindings(); lifecycle.revokeMissingSubmissions((taskId) => isImageTaskActiveInWorkspace(state, taskId)); }
    },
    editUnrelated: () => update(true)((current) => ({ ...current, project: { ...current.project, description: 'unrelated edit' } })),
    replaceTextApiKey: (apiKey: string) => { state = { ...state, settings: { ...state.settings, textApi: { ...state.settings.textApi, apiKey } } }; },
    switchProject: () => {
      const other = { ...state.project, id: 'other-project', generationTasks: [], assets: [] };
      state = { ...state, project: other, projects: [...state.projects, other], activeProjectId: other.id };
      lifecycle.invalidateBindings();
    },
    get state() { return state; }, get posts() { return posts; }, get conversions() { return conversions; }, notices,
    ownerId: state.project.id, taskId: 'image_task-audit',
  };
};

test('regeneration preparation and converter errors redact frozen identity evidence and keys before notifying or saving errors', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
  const identityContext = '原创作品《保密巡航日志》中的角色阿莲。\n这段资料只供转换器理解身份。';
  const apiKey = 'regeneration-frozen-key-fixture';
  try {
    for (const stage of ['api-prepare', 'conversion'] as const) {
      for (const format of ['raw', 'json', 'url'] as const) {
        const started = deferred(); const finish = deferred();
        const encode = (value: string) => format === 'json' ? JSON.stringify(value).slice(1, -1)
          : format === 'url' ? encodeURIComponent(value) : value;
        const fail = async (): Promise<never> => {
          started.resolve(); await finish.promise;
          throw new Error(`HTTP 502; code=UPSTREAM_UNAVAILABLE; stage=response-read; route=direct; 合成服务暂时不可用。\n${[identityContext, apiKey, 'saved source', 'saved rules'].map(encode).join('\n')}`);
        };
        const fixture = regenerationFixture({ prompt: '', identityContext, textApiKey: apiKey,
          ...(stage === 'api-prepare' ? { resolveApi: fail } : { convert: fail }),
        });
        const pending = fixture.run(); await started.promise;
        fixture.replaceTextApiKey('later-fixture-key'); finish.resolve(); await pending;
        assert.equal(fixture.posts, 0);
        assert.equal(fixture.conversions, stage === 'conversion' ? 1 : 0, 'error display adds no retries');
        const task = fixture.state.project.generationTasks.find((item) => item.id === fixture.taskId);
        assert.equal(task?.status, stage === 'conversion' ? 'failed' : undefined);
        const visible = JSON.stringify({ notices: fixture.notices, error: task?.error });
        assert.match(visible, /合成服务暂时不可用/u);
        assert.match(visible, /HTTP 502/u); assert.match(visible, /UPSTREAM_UNAVAILABLE/u);
        assert.match(visible, /response-read/u); assert.match(visible, /route=direct/u);
        for (const sensitive of [identityContext, apiKey, 'saved source', 'saved rules']) {
          assert.ok(!visible.includes(sensitive) && !visible.includes(JSON.stringify(sensitive).slice(1, -1))
            && !visible.includes(encodeURIComponent(sensitive)), `${stage}/${format} only exposes the failure cause`);
        }
        assert.doesNotMatch(visible, /保密巡航日志/u);
      }
    }
  } finally { Object.assign(globalThis, { window: originalWindow }); }
});

test('queued regeneration undone before start never submits or resurrects a task, including a later redo', async () => {
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: {} });
  const gate = deferred();
  const blocker = enqueueImageTask(() => gate.promise);
    const fixture = regenerationFixture();
  try {
    const pending = fixture.run();
    await fixture.waitUntilQueued(pending);
    assert.equal(fixture.state.project.generationTasks[0].status, 'queued');
    fixture.undo();
    assert.equal(fixture.state.project.generationTasks.length, 1);
    gate.resolve(); await blocker; await pending;
    assert.equal(fixture.posts, 0); assert.equal(fixture.conversions, 0);
    assert.equal(fixture.state.project.generationTasks.length, 1, 'cancelled record must not be appended');
    fixture.redo();
    assert.equal(fixture.state.project.generationTasks.find((task) => task.id === fixture.taskId)?.status, 'failed');
    assert.equal(fixture.posts, 0, 'redo is not permission to send a paid request');
  } finally { gate.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});

test('undo then redo before the queued worker wakes still revokes its submission lease', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
  const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise);
  const fixture = regenerationFixture();
  try {
    const pending = fixture.run(); await fixture.waitUntilQueued(pending); fixture.undo(); fixture.redo();
    gate.resolve(); await blocker; await pending;
    assert.equal(fixture.posts, 0);
    assert.equal(fixture.state.project.generationTasks[0].status, 'failed');
  } finally { gate.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});

test('undo of an unrelated edit does not revoke a still-present queued regeneration', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
  const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise);
  const fixture = regenerationFixture();
  try {
    const pending = fixture.run();
    await fixture.waitUntilQueued(pending);
    fixture.editUnrelated();
    // The task remains in the current history snapshot, so the submission
    // lease is still valid even though an unrelated edit was undone later.
    fixture.undo();
    gate.resolve(); await blocker; await pending;
    assert.equal(fixture.posts, 1);
  } finally { gate.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});

for (const stage of ['reference', 'conversion', 'transport-queue'] as const) {
  test(`regeneration revoked during ${stage} cannot POST or revive its record`, async () => {
    const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
    const started = deferred(); const finish = deferred();
    const fixture = regenerationFixture({
      ...(stage === 'reference' ? { readImages: async () => { started.resolve(); await finish.promise; return []; } } : {}),
      ...(stage === 'conversion' ? { prompt: '', convert: async () => { started.resolve(); await finish.promise; return 'new picture'; } } : {}),
      ...(stage === 'transport-queue' ? { generate: async (send: () => void | Promise<void>) => {
        started.resolve(); await finish.promise; await send(); return { url: 'https://fixture.invalid/result.png' };
      } } : {}),
    });
    try {
      const pending = fixture.run(); await started.promise; fixture.undo(); finish.resolve(); await pending;
      assert.equal(fixture.posts, 0);
      assert.equal(fixture.state.project.generationTasks.some((task) => task.id === fixture.taskId), false);
      assert.equal(fixture.state.project.assets.length, 0);
    } finally { finish.resolve(); Object.assign(globalThis, { window: originalWindow }); }
  });
}

test('a project switch retains the queued request and routes results to its owner', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
  const gate = deferred(); const blocker = enqueueImageTask(() => gate.promise); const fixture = regenerationFixture();
  try {
    const pending = fixture.run(); await fixture.waitUntilQueued(pending); fixture.switchProject(); gate.resolve(); await blocker; await pending;
    assert.equal(fixture.posts, 1); assert.equal(fixture.state.project.assets.length, 0);
    const owner = fixture.state.projects.find((project) => project.id === fixture.ownerId)!;
    assert.equal(owner.assets.length, 1);
    assert.equal(owner.generationTasks.find((task) => task.id === fixture.taskId)?.status, 'succeeded');
  } finally { gate.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});

test('a result already paid for before undo remains recoverable', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: {} });
  const sent = deferred(); const finish = deferred();
  const fixture = regenerationFixture({ generate: async (send) => {
    await send(); sent.resolve(); await finish.promise; return { url: 'https://fixture.invalid/result.png' };
  } });
  try {
    const pending = fixture.run(); await sent.promise; fixture.undo(); finish.resolve(); await pending;
    assert.equal(fixture.posts, 1); assert.equal(fixture.state.project.assets.length, 1);
    assert.equal(fixture.state.project.generationTasks.find((task) => task.id === fixture.taskId)?.status, 'succeeded');
  } finally { finish.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});

const autofillFixture = (options: { manual?: boolean; private?: boolean; gate?: 'ordinary' | 'private' } = {}) => {
  let state = createInitialState();
  const character: Character = {
    id: 'character-audit', name: '原角色', race: '人类', morphology: 'human-like', gender: '女', apparentAge: '成年',
    appearance: '', bodyPlan: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '',
    negativeContinuity: '', assetIds: [],
  };
  state = { ...state, project: { ...state.project, description: '', sourceDocuments: [], scenes: [], generationTasks: [], characters: [character] },
    settings: { ...state.settings, textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://not-called.invalid', model: 'mock', apiKey: '' } } };
  state.projects = [state.project];
  const characterOwnerId = state.project.id;
  const started = deferred(); const finish = deferred(); let privateCalls = 0;
  const form = { ...imageWorkbenchEntityToForm('character', character), appearance: '', bodyPlan: '' };
  const notices: string[] = [];
  const d: Record<string, any> = {
    GenerationTaskCancelledError, isGenerationTaskCancelledError, isGenerationTaskRevoked,
    state, assetKind: 'character', assetForm: form, selectedEntityId: options.manual ? '' : character.id,
    autofillBusy: false, activeAutofillTaskIdRef: { current: '' }, autofillWorkbenchMountedRef: { current: true },
    autofillTargetEpochRef: { current: 0 }, autofillRequestBasisRef: { current: null },
    imageWorkbenchIdentityRef: { current: { projectId: state.project.id, assetKind: 'character', selectedEntityId: options.manual ? '' : character.id, targetEpoch: 0, basisForm: form } },
    autofillRequirement: '', imageGenerationMode: options.private ? 'private' : 'ordinary', privateProfileHasAnyValue: false,
    availablePrivateCharacterFields: [{ formKey: 'nsfwFullBody' }], fieldsForKind: [['name', '名称'], ['race', '种族']],
    createId: () => 'autofill-audit', notify: (value: string) => notices.push(value), setView: () => {}, setAutofillBusy: () => {},
    clearImageGenerationOutputs: () => {}, setAssetFormStyleSource: () => {}, detectNsfwCharacterNames: () => [],
    getCurrentState: () => state, getCurrentProjectId: () => state.project.id, sourceContentHash: () => 'fixture-source',
    missingImageAssetFormFields, mergeMissingImageAssetFormFields, missingCharacterPrivateProfileBasisFields,
    createAutofillGenerationTask, addAutofillGenerationTaskToOwningProject, settleAutofillGenerationTask, isAutofillGenerationTask,
    advanceAutofillTargetEpoch, canApplyAutofillResult, applyOwnedProjectUpdate, imageWorkbenchEntityToForm,
    imageAutofillBasisFieldChanged, imageAutofillBasisChanged, imageAssetKindLabel, mergeCharacterPrivateProfileAutofill,
    AUTOFILL_BASIS_CHANGED_WARNING, AUTOFILL_RESULT_NOT_APPLIED_WARNING,
    requestImageAssetAutofill: async () => {
      if (options.gate !== 'private') { started.resolve(); await finish.promise; }
      return { appearance: '旧人类外观资料', bodyPlan: '旧人类身体结构' };
    },
    requestCharacterPrivateProfileAutofill: async () => {
      privateCalls += 1;
      if (options.gate === 'private') { started.resolve(); await finish.promise; }
      return { nsfwFullBody: '旧完整身体外观资料' };
    },
  };
  d.setState = d.setBackgroundState = (update: (value: AppState) => AppState) => { state = update(state); d.state = state; };
  d.setAssetForm = (update: ((value: Record<string, string>) => Record<string, string>) | Record<string, string>) => {
    d.assetForm = typeof update === 'function' ? update(d.assetForm) : update;
    d.imageWorkbenchIdentityRef.current = { ...d.imageWorkbenchIdentityRef.current, basisForm: d.assetForm, targetEpoch: d.autofillTargetEpochRef.current };
  };
  const handlers = new Function('d', `with(d){${production(['completeAssetDetails', 'updateField'])};return {completeAssetDetails,updateField};}`)(d);
  return {
    run: () => handlers.completeAssetDetails() as Promise<void>, started: started.promise, finish: () => finish.resolve(),
    edit: (key: string, value: string) => handlers.updateField(key, value),
    changeSavedRace: () => {
      const owner = state.project.id === characterOwnerId ? state.project : state.projects.find((project) => project.id === characterOwnerId)!;
      const next = { ...owner, characters: owner.characters.map((item) => item.id === character.id ? { ...item, race: '六足甲壳兽', morphology: 'monster' as const } : item) };
      state = { ...state, project: state.project.id === owner.id ? next : state.project, projects: state.projects.map((item) => item.id === owner.id ? next : item) }; d.state = state;
    },
    switchProject: () => {
      const other = { ...state.project, id: 'other-project', characters: [], generationTasks: [] };
      state = { ...state, project: other, projects: [...state.projects, other], activeProjectId: other.id }; d.state = state;
      d.imageWorkbenchIdentityRef.current = { ...d.imageWorkbenchIdentityRef.current, projectId: other.id, selectedEntityId: '' };
    },
    get state() { return state; }, get form() { return d.assetForm as Record<string, string>; }, get privateCalls() { return privateCalls; }, notices,
  };
};

for (const manual of [false, true]) {
  test(`ordinary autofill does not apply pre-edit species facts (${manual ? 'manual' : 'saved'} record)`, async () => {
    const fixture = autofillFixture({ manual }); const pending = fixture.run(); await fixture.started;
    fixture.edit('race', '六足甲壳兽'); fixture.edit('morphology', 'monster'); fixture.finish(); await pending;
    assert.equal(fixture.form.race, '六足甲壳兽'); assert.equal(fixture.form.appearance, ''); assert.equal(fixture.form.bodyPlan, '');
    const task = fixture.state.project.generationTasks[0];
    assert.equal(task.kind, 'autofill');
    if (task.kind === 'autofill') { assert.equal(task.result?.appearance, '旧人类外观资料'); assert.equal(task.bindingWarning, AUTOFILL_BASIS_CHANGED_WARNING); }
  });
}

test('editing bodyPlan and then reverting it still invalidates the old autofill response', async () => {
  const fixture = autofillFixture(); const pending = fixture.run(); await fixture.started;
  fixture.edit('bodyPlan', '六足、甲壳'); fixture.edit('bodyPlan', ''); fixture.finish(); await pending;
  assert.equal(fixture.form.appearance, '');
  assert.equal((fixture.state.project.generationTasks[0] as { bindingWarning?: string }).bindingWarning, AUTOFILL_BASIS_CHANGED_WARNING);
});

test('filling an unrelated empty field keeps normal completion and the user value', async () => {
  const fixture = autofillFixture(); const pending = fixture.run(); await fixture.started;
  fixture.edit('props', '用户手填道具'); fixture.finish(); await pending;
  assert.equal(fixture.form.props, '用户手填道具'); assert.equal(fixture.form.appearance, '旧人类外观资料');
  assert.equal((fixture.state.project.generationTasks[0] as { bindingWarning?: string }).bindingWarning, undefined);
});

test('basis edits before the private phase skip that extra AI request', async () => {
  const fixture = autofillFixture({ private: true }); const pending = fixture.run(); await fixture.started;
  fixture.edit('morphology', 'monster'); fixture.finish(); await pending;
  assert.equal(fixture.privateCalls, 0); assert.equal(fixture.form.appearance, '');
  assert.equal(fixture.state.project.characters[0].nsfwProfile?.fullBody, undefined);
});

test('private completion cannot write either form or saved character after a basis edit', async () => {
  const fixture = autofillFixture({ private: true, gate: 'private' }); const pending = fixture.run(); await fixture.started;
  fixture.edit('bodyPlan', '六足甲壳结构'); fixture.finish(); await pending;
  assert.equal(fixture.privateCalls, 1); assert.equal(fixture.form.nsfwFullBody || '', '');
  assert.equal(fixture.form.appearance, ''); assert.equal(fixture.state.project.characters[0].nsfwProfile?.fullBody, undefined);
});

test('saved owner changes in another page also block private-profile writeback', async () => {
  const fixture = autofillFixture({ private: true, gate: 'private' }); const pending = fixture.run(); await fixture.started;
  fixture.changeSavedRace(); fixture.finish(); await pending;
  assert.equal(fixture.state.project.characters[0].race, '六足甲壳兽');
  assert.equal(fixture.state.project.characters[0].nsfwProfile?.fullBody, undefined);
  assert.equal(fixture.form.appearance, '');
});

test('an unchanged owner still receives a completed private profile after switching project', async () => {
  const fixture = autofillFixture({ private: true, gate: 'private' });
  const ownerId = fixture.state.project.id; const pending = fixture.run(); await fixture.started;
  fixture.switchProject(); fixture.finish(); await pending;
  assert.equal(fixture.state.project.characters.length, 0);
  assert.equal(fixture.state.projects.find((project) => project.id === ownerId)!.characters[0].nsfwProfile?.fullBody, '旧完整身体外观资料');
});

test('ComfyUI rechecks submission authorization after asynchronous reference upload', async () => {
  const originalWindow = globalThis.window; const uploadStarted = deferred(); const uploadFinished = deferred();
  let authorized = true; const requestedPaths: string[] = [];
  const workflow = {
    text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    image: { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
    encode: { class_type: 'VAEEncode', inputs: { pixels: ['image', 0], vae: ['model', 2] } },
    sampler: { class_type: 'KSampler', inputs: { seed: 1, positive: ['text', 0], latent_image: ['encode', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['model', 2] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0] } },
  };
  Object.assign(globalThis, { window: { lianhuaDesktop: { request: async (input: { url: string }) => {
    const path = new URL(input.url).pathname; requestedPaths.push(path);
    if (path === '/upload/image') { uploadStarted.resolve(); await uploadFinished.promise; return { status: 200, body: JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }) }; }
    throw new Error(`unexpected actual endpoint: ${path}`);
  } } } });
  try {
    const pending = requestImageModel({ enabled: true, backend: 'comfyui', baseUrl: 'https://not-called.invalid', apiKey: '', model: '', workflowJson: JSON.stringify(workflow) }, {
      prompt: 'test reference', referenceImages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W3DkAAAAASUVORK5CYII='],
      primaryReferenceImageCount: 1,
    }, () => { if (!authorized) throw new Error('submission revoked after upload'); });
    await uploadStarted.promise; authorized = false; uploadFinished.resolve();
    await assert.rejects(pending, /submission revoked after upload/u);
    assert.deepEqual(requestedPaths, ['/upload/image']);
  } finally { uploadFinished.resolve(); Object.assign(globalThis, { window: originalWindow }); }
});
