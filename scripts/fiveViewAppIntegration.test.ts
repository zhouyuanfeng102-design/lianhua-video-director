import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as generation from '../src/imageGeneration';
import * as rules from '../src/imagePromptRules';
import * as batch from '../src/imageBatch';
import * as apiSelection from '../src/imageApiSelection';
import * as tasks from '../src/generationTasks';
import * as sizes from '../src/imageOutputSize';
import * as effects from '../src/appEffects';
import * as regeneration from '../src/imageRegeneration';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import { buildImagePrompt } from '../src/promptEngine';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { checkNovelAIReferenceImagePreflight } from '../src/novelai';
import { createInitialState } from '../src/storage';
import { characterDossierFormForRequest, dossierUsesStory } from '../src/characterDossierPolicy';
import type { AppState, Character, ImageGenerationTask, ImageVariant, ReferenceAsset } from '../src/types';

// Execute the actual App creation/retry callbacks in memory. Both model
// boundaries are recording-only fakes: no external request, image generation,
// production project read, managed-file write or desktop launch occurs.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
  'createPromptAsset', 'regenerateImageTask', 'imagePromptBackendForApi',
  'PRIVATE_CHARACTER_FIELD_SPECS', 'privateCharacterFieldsForGender', 'privateCharacterFourInOneFieldsForGender',
  'imagePromptAssetKind', 'activatePrivateImageGeneration', 'activateOrdinaryImageGeneration',
]);
const declarations = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) declarations.set(node.name.text, node);
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
};
visit(ast);
const compile = (requested: string[]) => ts.transpileModule(requested.map((name) => {
  const node = declarations.get(name);
  assert.ok(node, `the production ${name} must remain covered`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const commonNames = ['imagePromptBackendForApi', 'PRIVATE_CHARACTER_FIELD_SPECS', 'privateCharacterFieldsForGender', 'privateCharacterFourInOneFieldsForGender'];
const evaluator = (requested: string[], result: string, dependencies: Record<string, unknown>) => new Function('d', `with(d){${compile(requested)}; return ${result};}`)(dependencies);
const noOp = () => {};
const fixtureTextApiKey = 'identity-fixture-frozen-text-credential';
const fixtureImageApiKey = 'identity-fixture-frozen-image-credential';
const modelReply = 'Single 3:2 five-region character reference sheet for one adult test mannequin: upper-left front head-and-shoulders portrait, lower-left strict side-profile portrait; the right side contains front, strict side and rear full-body views. Neutral background.';
const assertFiveLayout = (value: string, label: string): void => {
  for (const marker of ['五视图', '左上', '左下', '正面头肩特写', '左侧面头肩特写', '正面全身', '左侧面全身', '背面全身', '3:2']) {
    assert.ok(value.includes(marker), `${label}: missing ${marker}`);
  }
  assert.doesNotMatch(value, /(?<!三分之)四视图|恰好四个同身份|依次表现正面、严格\s*90\s*度左侧面、背面、45\s*度前三分之四视图/u,
    `${label}: a new five-view request must not include the legacy four-view layout`);
};

function fixture(
  variant: 'portrait' | 'five-view' | 'private-five-view',
  count = 1,
  scale: 'default' | '2x' = 'default',
  useStory = true,
) {
  let state = createInitialState();
  const character: Character = {
    id: 'adult-character', name: '成年测试角色', gender: '男', apparentAge: '25岁成年', actualAge: '25岁', race: '人类',
    appearance: '普通成年测试人台，短发，固定面容', outfit: '蓝色外套与长裤', signatureProps: '', personality: '沉稳',
    motionHabits: '中性站姿', anchor: '保持原身份', negativeContinuity: '', assetIds: [],
    nsfwProfile: { fullBody: 'ADULT_PRIVATE_PROFILE_SENTINEL', penis: 'UNSELECTED_PRIVATE_FIELD_SENTINEL' },
    dossier: { useStory },
  };
  state.project = { ...state.project, id: `five-view-${variant}`, description: '测试角色属于原创世界观“云港纪事”，本次画面为中性摄影棚背景。',
    characters: [character], assets: [], generationTasks: [] };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  state.settings = { ...state.settings,
    imageApi: { enabled: true, backend: 'openai', baseUrl: 'https://not-called.invalid', apiKey: fixtureImageApiKey, model: 'mock-image-model' },
    textApi: { ...state.settings.textApi, enabled: true, baseUrl: 'https://not-called.invalid', apiKey: fixtureTextApiKey, model: 'mock-text-model' },
  };
  const privateMode = variant === 'private-five-view';
  const mode = privateMode ? 'private' : 'ordinary';
  const preferences = { ordinary: { ...sizes.defaultImageOutputSize(), mode: scale }, private: { ...sizes.defaultImageOutputSize(), mode: scale } };
  const savedCharacter = JSON.stringify(character);
  const conversions: Array<{ kind: string; source: string; rules: string; identityContext?: string }> = [];
  let onConversion: ((conversion: (typeof conversions)[number]) => void) | undefined;
  let onImage: (() => void) | undefined;
  const images: Array<{ prompt: string; width: number; height: number }> = [];
  const notices: Array<{ text: string; level?: string }> = [];
  const pending: Promise<void>[] = [];
  let identity = 0;
  const latestImageBatchIdRef = { current: { ordinary: '', private: '' } };
  const regenerationLifecycle = createStoryboardImageBatchLifecycle();
  const update = (reduce: (current: AppState) => AppState) => { state = reduce(state); };
  const deps: Record<string, any> = {
    ...generation, ...rules, ...batch, ...tasks, ...sizes, ...effects, ...regeneration, ...apiSelection,
    buildImagePrompt, buildImagePromptIdentityContext, getSafeErrorDiagnostics, enqueueImageTask, checkNovelAIReferenceImagePreflight,
    dossierUsesStory, characterDossierFormForRequest, characterDossierRef: { current: character.dossier },
    assetKind: 'character', selectedEntityId: character.id, imageGenerationMode: mode, imageVariant: variant,
    imageGenerationCount: count, imageSizePreferences: preferences, imageSizeSupport: undefined,
    autofillTargetEpochRef: { current: 1 }, autofillWorkbenchMountedRef: { current: true }, latestImageBatchIdRef,
    imageSubmissionInputsRef: { current: { projectId: state.project.id, apiSignature: 'initial', selectedReferenceAssetId: '', selectedEntityId: character.id } },
    imageWorkbenchIdentityRef: { current: {
      projectId: state.project.id, assetKind: 'character', selectedEntityId: character.id, targetEpoch: 1,
      imageSizePreferences: preferences, ordinaryImageVariant: privateMode ? 'five-view' : variant, privateImageVariant: 'private-five-view', nsfwPrivatePart: 'full-body',
    } },
    nsfwPrivatePart: 'full-body', assetForm: { ...generation.imageWorkbenchEntityToForm('character', character), style: '中性测试风格' },
    gridStates: [], uploadedPreview: '', useReferenceImage: false, selectedReferenceAssetId: '',
    activeImagePromptRuleSetId: '', activeImagePromptPresetId: '', autofillRequirement: '', negativePrompt: '',
    inheritedImageVisualStyle: '中性测试风格', createInheritedAssetForm: () => ({ style: '中性测试风格' }),
    getCurrentState: () => state, getCurrentProjectId: () => state.project.id,
    setState: update, setBackgroundState: update, setView: noOp, clearImageGenerationOutputs: noOp,
    patchImageGenerationLane: noOp, bindGridAssetForDirector: noOp,
    createId: (prefix: string) => `${prefix}-${++identity}`,
    assetPreviewUrl: (asset: ReferenceAsset | undefined) => asset?.url || asset?.dataUrl || '',
    safeFileName: (value: string) => value, readGeneratedImageDimensions: () => undefined,
    hasUsableStoryboardReferencePixels: () => false,
    notify: (text: string, level?: string) => notices.push({ text, level }),
    requestImagePromptConverter: async (_api: unknown, kind: string, source: string, _format: string, converterRules: string, identityContext?: string) => {
      const conversion = { kind, source, rules: converterRules, identityContext };
      conversions.push(conversion); onConversion?.(conversion);
      return variant === 'portrait'
        ? 'Neutral head-and-shoulders studio portrait of a short-haired adult mannequin wearing a blue coat, with a consistent face and soft even light.'
        : modelReply;
    },
    requestImageModel: async (_api: unknown, input: { prompt: string; width: number; height: number }, beforeSubmit?: () => void) => {
      beforeSubmit?.(); images.push({ ...input }); onImage?.(); return { url: `https://fixture.invalid/result-${images.length}.png` };
    },
    enqueueImageBatchMembers: (...args: Parameters<typeof batch.enqueueImageBatchMembers>) => {
      const promise = batch.enqueueImageBatchMembers(...args); pending.push(promise); return promise;
    },
    patchImageTaskForOwningProject: (projectId: string, taskId: string, patch: any) => update((current) => effects.applyOwnedProjectUpdate(current, projectId, (project) => ({
      ...project, generationTasks: tasks.patchImageGenerationTask(project.generationTasks, taskId, patch),
    }))),
    addImageAssetToOwningProject: (projectId: string, asset: ReferenceAsset, _binding: unknown, outcome: { task: ImageGenerationTask; patch: any }) => update((current) => effects.applyOwnedProjectUpdate(current, projectId, (project) => ({
      ...project, assets: [asset, ...project.assets], generationTasks: tasks.settleImageGenerationTask(project.generationTasks, outcome.task, outcome.patch),
    }))),
    resolveStoryboardReferenceImages: async () => [],
  };
  Object.defineProperty(deps, 'state', { get: () => state });
  Object.defineProperty(deps, 'imageApiSelection', { get: () => apiSelection.resolveWorkbenchImageApi(state.settings, mode) });
  Object.defineProperty(deps, 'imageWorkbenchApi', { get: () => apiSelection.resolveWorkbenchImageApi(state.settings, mode).config });
  const create = evaluator([...commonNames, 'createPromptAsset'], 'createPromptAsset', deps) as () => Promise<void>;
  const retry = evaluator([...commonNames, 'regenerateImageTask'], 'regenerateImageTask', deps) as (ctx: unknown, original: ImageGenerationTask) => Promise<void>;
  return {
    async create() { await create(); await Promise.all(pending); },
    async retry(original: ImageGenerationTask) {
      await retry({ state, setState: update, setBackgroundState: update,
        storyboardImageBatchLifecycle: regenerationLifecycle, getCurrentState: () => state,
        getCurrentProjectId: () => state.project.id, setView: noOp, notify: deps.notify }, original);
    },
    delayApiPreparation(kind: 'create' | 'retry') {
      let release!: () => void; let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { started = resolve; });
      if (kind === 'create') deps.captureImageApiSnapshot = async (...args: Parameters<typeof apiSelection.captureImageApiSnapshot>) => {
        started(); await gate; return apiSelection.captureImageApiSnapshot(...args);
      };
      else deps.resolveImageApiForRegeneration = async (...args: Parameters<typeof apiSelection.resolveImageApiForRegeneration>) => {
        started(); await gate; return apiSelection.resolveImageApiForRegeneration(...args);
      };
      return { ready, release };
    },
    changeInput(key: string, value: unknown) { deps.imageSubmissionInputsRef.current = { ...deps.imageSubmissionInputsRef.current, [key]: value }; },
    changeProject() { state = { ...state, project: { ...state.project, id: 'different-project' } }; },
    removeTask(id: string) { state = { ...state, project: { ...state.project, generationTasks: state.project.generationTasks.filter((task) => task.id !== id) } }; },
    changeTask(id: string) { state = { ...state, project: { ...state.project, generationTasks: state.project.generationTasks.map((task) => task.id === id ? { ...task, updatedAt: task.updatedAt + 1 } : task) } }; },
    changeApi(kind: 'disable' | 'endpoint') { state = { ...state, settings: { ...state.settings, imageApi: {
      ...state.settings.imageApi, ...(kind === 'disable' ? { enabled: false } : { baseUrl: 'https://changed.invalid' }),
    } } }; },
    replaceApiKeys() { state = { ...state, settings: { ...state.settings,
      textApi: { ...state.settings.textApi, apiKey: 'replacement-text-fixture-credential' },
      imageApi: { ...state.settings.imageApi, apiKey: 'replacement-image-fixture-credential' },
    } }; },
    onConversion(callback: (conversion: (typeof conversions)[number]) => void) { onConversion = callback; },
    onImage(callback: () => void) { onImage = callback; },
    unmount() { deps.autofillWorkbenchMountedRef.current = false; },
    get state() { return state; }, conversions, images, notices,
    assertNoErrors() { assert.deepEqual(notices.filter((notice) => notice.level === 'error'), []); },
    assertCharacterUnchanged() { assert.equal(JSON.stringify(state.project.characters[0]), savedCharacter); },
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
try {
  for (const variant of ['five-view', 'private-five-view'] as const) {
    const privateMode = variant === 'private-five-view';
    const uiKind = evaluator(['imagePromptAssetKind'], 'imagePromptAssetKind', {
      assetKind: 'character', imageVariant: variant, isStoryboardMode: false, isPrivateCharacterVariant: privateMode,
    });
    assert.equal(uiKind, privateMode ? 'character-private' : 'character-sheet', 'the visible rule/preset selector must use the same request kind');
    const run = fixture(variant);
    await run.create(); run.assertNoErrors(); run.assertCharacterUnchanged();
    assert.equal(run.conversions.length, 1, 'one selected reference sheet has one converter call');
    assert.equal(run.images.length, 1, 'five regions are one image request, not five generation jobs');
    assert.equal(run.state.project.generationTasks.length, 1);
    assert.equal(run.state.project.assets.length, 1);
    const original = run.state.project.generationTasks[0] as ImageGenerationTask;
    assert.equal(original.status, 'succeeded'); assert.equal(original.imageVariant, variant);
    assert.equal(original.width, 1536); assert.equal(original.height, 1024);
    assert.equal(original.referenceScope, privateMode ? 'nsfw-private-profile' : 'general');
    assert.equal(original.nsfwPrivatePart, privateMode ? 'full-body' : undefined);
    assert.equal(run.conversions[0].kind, privateMode ? 'character-private' : 'character-sheet');
    const identityContext = buildImagePromptIdentityContext(run.state.project, ['成年测试角色']);
    assert.equal(run.conversions[0].identityContext, identityContext, 'identity evidence reaches the real converter call as the sixth argument');
    assert.equal(original.conversionIdentityContext, identityContext, 'the task freezes the same identity evidence as conversion');
    assert.match(identityContext, /云港纪事/u);
    assert.match(identityContext, /当前指定人物姓名（含已明确形态）：成年测试角色/u);
    assert.doesNotMatch(run.conversions[0].source, /云港纪事/u, 'identity/world evidence stays separate from picture routing input');
    assertFiveLayout(run.conversions[0].source, `${variant} source`);
    assertFiveLayout(run.conversions[0].rules, `${variant} rules`);
    assert.doesNotMatch(run.conversions[0].source, /UNSELECTED_PRIVATE_FIELD_SENTINEL/u);
    if (privateMode) assert.match(run.conversions[0].source, /ADULT_PRIVATE_PROFILE_SENTINEL/u);
    else assert.doesNotMatch(run.conversions[0].source, /ADULT_PRIVATE_PROFILE_SENTINEL/u, 'the ordinary layout cannot borrow private dossier fields');
    assert.equal(run.images[0].prompt, modelReply);
    assert.deepEqual([run.images[0].width, run.images[0].height], [1536, 1024]);
    const originalBytes = JSON.stringify(original);
    await run.retry(original); run.assertNoErrors(); run.assertCharacterUnchanged();
    assert.equal(run.images.length, 2, 'retry creates exactly one new reference sheet');
    assert.equal(run.conversions.length, privateMode ? 2 : 1, 'ordinary retry uses its saved final prompt; private retry uses its scoped conversion source');
    if (privateMode) {
      assertFiveLayout(run.conversions[1].source, 'private retry source');
      assertFiveLayout(run.conversions[1].rules, 'private retry rules');
      assert.equal(run.conversions[1].identityContext, identityContext, 'private retry uses the saved identity snapshot');
    }
    assert.equal(JSON.stringify(run.state.project.generationTasks.find((task) => task.id === original.id)), originalBytes, 'retry never rewrites the original task snapshot');
    assert.equal(run.state.project.assets.length, 2, 'the previous sheet is retained');
    assert.deepEqual([run.images[1].width, run.images[1].height], [1536, 1024]);
  }
  {
    const run = fixture('portrait');
    await run.create(); run.assertNoErrors(); run.assertCharacterUnchanged();
    assert.equal(run.conversions.length, 1);
    assert.equal(run.images.length, 1);
    const task = run.state.project.generationTasks[0] as ImageGenerationTask;
    const identityContext = buildImagePromptIdentityContext(run.state.project, ['成年测试角色']);
    assert.equal(run.conversions[0].kind, 'character');
    assert.equal(run.conversions[0].identityContext, identityContext, 'ordinary single-image conversion receives identity evidence');
    assert.equal(task.conversionIdentityContext, identityContext);
    assert.equal(task.status, 'succeeded');
    assert.equal(run.images[0].prompt, task.prompt, 'the image request uses the converted text without an identity prefix');
    assert.doesNotMatch(run.images[0].prompt, /云港纪事|成年测试角色/u, 'the local callback must not fill in identity missing from the AI reply');
  }
  {
    const run = fixture('private-five-view', 1, 'default', false);
    await run.create(); run.assertNoErrors(); run.assertCharacterUnchanged();
    assert.equal(run.conversions.length, 1, 'story-off private generation still reaches the converter');
    assert.equal(run.images.length, 1, 'story-off private generation still reaches the image backend');
    assert.match(run.conversions[0].source, /ADULT_PRIVATE_PROFILE_SENTINEL/u,
      'the independently saved private profile survives ordinary story-source filtering');
    assert.equal(run.conversions[0].identityContext, '', 'story-off private generation excludes story identity context');
    assert.doesNotMatch(run.conversions[0].source, /云港纪事/u, 'story-off private generation does not leak project story');
  }
  for (const variant of ['portrait', 'private-five-view'] as const) {
    for (const stage of ['conversion', 'image'] as const) {
      for (const encoding of ['raw', 'json'] as const) {
        const run = fixture(variant);
        const failWithEcho = () => {
          const identityContext = run.conversions[0].identityContext!;
          assert.match(identityContext, /云港纪事/u);
          run.replaceApiKeys();
          const echo = encoding === 'json' ? JSON.stringify(identityContext) : identityContext;
          const convertedPrompt = stage === 'image' ? run.images[0].prompt : '';
          const convertedEcho = encoding === 'json' ? JSON.stringify(convertedPrompt) : convertedPrompt;
          throw new Error(`HTTP 504 fixture upstream timeout\nEchoed evidence ${echo}\nEchoed conversion result ${convertedEcho}\nSubmitted credential ${fixtureTextApiKey} ${fixtureImageApiKey}`);
        };
        if (stage === 'conversion') run.onConversion(failWithEcho); else run.onImage(failWithEcho);
        await run.create();
        const task = run.state.project.generationTasks[0] as ImageGenerationTask;
        assert.equal(task.status, 'failed', `${variant}/${stage}/${encoding}`);
        assert.equal(run.conversions.length, 1, 'diagnostic redaction adds no converter retry');
        assert.equal(run.images.length, stage === 'image' ? 1 : 0, 'diagnostic redaction never replays a paid image');
        for (const message of [task.error || '', ...run.notices.filter((notice) => notice.level === 'error').map((notice) => notice.text)]) {
          assert.match(message, /HTTP 504 fixture upstream timeout/u, 'the actionable provider cause remains visible');
          assert.doesNotMatch(message, /云港纪事|当前指定人物姓名|identity-fixture-frozen-(?:text|image)-credential/u,
            'raw and JSON identity echoes and original frozen API keys stay out of task errors and notices');
          if (stage === 'image') assert.ok(!message.includes(run.images[0].prompt), 'the final converted prompt is also redacted from errors');
        }
        assert.match(task.conversionIdentityContext || '', /云港纪事/u, 'diagnostic redaction does not alter the conversion snapshot');
        if (stage === 'image') assert.equal(task.prompt, run.images[0].prompt, 'diagnostic redaction does not alter the successful conversion');
      }
    }
  }
  const twoSheets = fixture('five-view', 2, '2x');
  await twoSheets.create(); twoSheets.assertNoErrors();
  assert.equal(twoSheets.conversions.length, 1, 'the chosen two-sheet batch shares one conversion');
  assert.equal(twoSheets.images.length, 2, 'image quantity means complete sheets, never number of views');
  assert.ok(twoSheets.images.every((image) => image.width === 3072 && image.height === 2048));

  // The new asynchronous safe-config fingerprint must not authorize a late
  // initial submission or retry after its intended UI/task context changes.
  for (const change of ['apiSignature', 'selectedReferenceAssetId', 'selectedEntityId', 'project', 'unmount']) {
    const run = fixture('private-five-view');
    const delay = run.delayApiPreparation('create');
    const pending = run.create(); await delay.ready;
    if (change === 'project') run.changeProject();
    else if (change === 'unmount') run.unmount();
    else run.changeInput(change, 'changed-during-config-hash');
    delay.release(); await pending;
    assert.equal(run.images.length, 0, `${change}: a stale preparation never submits`);
    assert.equal(run.state.project.generationTasks.length, 0, `${change}: a stale preparation never creates a task`);
    assert.equal(run.conversions.length, 0);
  }
  for (const change of ['project', 'remove', 'snapshot', 'disable', 'endpoint']) {
    const run = fixture('private-five-view'); await run.create();
    const original = run.state.project.generationTasks[0] as ImageGenerationTask;
    const delay = run.delayApiPreparation('retry');
    const pending = run.retry(original); await delay.ready;
    if (change === 'project') run.changeProject();
    else if (change === 'remove') run.removeTask(original.id);
    else if (change === 'disable' || change === 'endpoint') run.changeApi(change);
    else run.changeTask(original.id);
    delay.release(); await pending;
    assert.equal(run.images.length, 1, `${change}: changed retry context cannot submit another image`);
    assert.equal(run.state.project.generationTasks.length, change === 'remove' ? 0 : 1);
  }
  {
    const run = fixture('private-five-view'); await run.create();
    const original = run.state.project.generationTasks[0] as ImageGenerationTask;
    const delay = run.delayApiPreparation('retry');
    const first = run.retry(original); const second = run.retry(original); await delay.ready;
    delay.release(); await Promise.all([first, second]);
    assert.equal(run.images.length, 2, 'double retry through delayed API checks queues only one new request');
    assert.equal(run.state.project.generationTasks.length, 2);
  }
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

// The two production entry controls select the new IDs. Four-in-one is a
// separate existing output and is neither renamed nor reinterpreted here.
assert.ok(generation.IMAGE_VARIANT_OPTIONS.character.includes('five-view'));
assert.ok(!generation.IMAGE_VARIANT_OPTIONS.character.includes('turnaround'));
{
  const lanes: Record<string, any> = {
    assetKind: 'character', ordinaryImageVariant: 'five-view', privateImageVariant: 'private-five-view',
    imageVariant: 'five-view', imageGenerationMode: 'ordinary', nsfwPrivatePart: 'full-body',
    availablePrivateCharacterFields: [{ part: 'full-body' }], IMAGE_VARIANT_OPTIONS: generation.IMAGE_VARIANT_OPTIONS,
    latestImageBatchIdRef: { current: { private: '' } }, patchImageGenerationLane: noOp,
  };
  for (const [setter, key] of Object.entries({ setOrdinaryImageVariant: 'ordinaryImageVariant', setPrivateImageVariant: 'privateImageVariant',
    setImageVariant: 'imageVariant', setImageGenerationMode: 'imageGenerationMode', setNsfwPrivatePart: 'nsfwPrivatePart' })) {
    lanes[setter] = (value: unknown) => { lanes[key] = value; };
  }
  const controls = evaluator(['activatePrivateImageGeneration', 'activateOrdinaryImageGeneration'],
    '({ private: activatePrivateImageGeneration, ordinary: activateOrdinaryImageGeneration })', lanes);
  controls.private();
  assert.equal(lanes.imageGenerationMode, 'private'); assert.equal(lanes.imageVariant, 'private-five-view');
  controls.ordinary();
  assert.equal(lanes.imageGenerationMode, 'ordinary'); assert.equal(lanes.imageVariant, 'five-view');
  controls.private('full-body', 'private-four-in-one');
  assert.equal(lanes.imageVariant, 'private-four-in-one', 'explicit four-in-one remains its own variant');
  controls.ordinary(); controls.private('full-body', 'private-five-view');
  assert.equal(lanes.imageVariant, 'private-five-view'); assert.equal(lanes.ordinaryImageVariant, 'five-view');
}
let privateButton: ts.JsxElement | undefined;
const findButton = (node: ts.Node): void => {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button'
    && node.children.some((child) => ts.isJsxText(child) && child.text.trim() === '私密五视图')) privateButton = node;
  ts.forEachChild(node, findButton);
};
findButton(ast);
assert.ok(privateButton, 'the private workbench has an explicit five-view entry');
const click = privateButton.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'onClick');
assert.ok(click && ts.isJsxAttribute(click) && click.initializer && ts.isJsxExpression(click.initializer) && click.initializer.expression);
const clickCode = ts.transpileModule(`const onClick = ${click.initializer.expression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let clicked: unknown[] | undefined;
new Function('activatePrivateImageGeneration', `${clickCode}; onClick();`)((...args: unknown[]) => { clicked = args; });
assert.deepEqual(clicked, ['full-body', 'private-five-view']);
assert.match(appSource, /activatePrivateImageGeneration\("full-body", "private-four-in-one"\)/u, 'four-in-one keeps its independent control');
assert.match(generation.getImageVariantGenerationSpec('turnaround' as ImageVariant).direction, /四/u, 'legacy ordinary snapshots retain their original layout');
assert.match(generation.privateImageVariantConverterRule('private-turnaround'), /四视图/u, 'legacy private snapshots retain their original layout');
console.log('Five-view App integration: actual ordinary/private creation, rule routing, 3:2 sizing, one-image semantics, retries, immutable source snapshots and UI entry IDs passed; zero live requests or files generated.');
