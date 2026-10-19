import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as generationTasks from '../src/generationTasks';
import { runImageTask } from '../src/generationTaskCancellation';
import { applyOwnedProjectUpdate } from '../src/appEffects';
import { enqueueImageBatchMembers, imageBatchMemberApi, imageBatchTaskIsActive } from '../src/imageBatch';
import { createInitialState } from '../src/storage';
import type { AppState, ImageGenerationTask, ReferenceAsset } from '../src/types';

// Execute the production workbench worker and asset commit callbacks. Only the
// provider and file storage boundaries are mocked; no real request or file is made.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ImageWorkbenchView');
assert.ok(view && ts.isFunctionDeclaration(view) && view.body);
let worker: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'enqueueImageBatchMembers') worker = node.arguments[2];
  ts.forEachChild(node, visit);
};
visit(view);
assert.ok(worker);
const helpers = ['addImageAssetToOwningProject', 'patchImageTaskForOwningProject'].map((name) => {
  const declaration = view.body!.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name));
  assert.ok(declaration);
  return declaration.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(`${helpers}\nlet batchConvertedPrompt; let batchProducedImage = false; const worker = ${worker.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('stopped task still occupies the image queue')), 1000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

for (const stuckStage of ['conversion', 'generation', 'storage'] as const) {
  test(`production workbench force-stop releases a stuck ${stuckStage} and ignores its late result`, async () => {
    const initial = createInitialState();
    const projectId = `force-stop-workbench-${stuckStage}`;
    const make = (id: string, index: number): ImageGenerationTask => ({
      id, kind: 'image', name: id, assetKind: 'character', imageVariant: 'full-body', status: 'queued',
      batchId: projectId, batchIndex: index, batchCount: 2, prompt: '', width: 1024, height: 1024,
      backend: 'openai', model: 'fixture', createdAt: 10 + index, updatedAt: 10 + index,
    });
    const members = [make(`${stuckStage}-stopped`, 1), make(`${stuckStage}-next`, 2)];
    const project = { ...initial.project, id: projectId, generationTasks: members, assets: [] };
    let state: AppState = { ...initial, project, projects: [project], activeProjectId: projectId };
    const update = (reduce: (current: AppState) => AppState) => { state = reduce(state); };
    const started = deferred<void>();
    const late = deferred<unknown>();
    const conversionSignals: AbortSignal[] = [];
    const generationSignals: AbortSignal[] = [];
    let stored = 0;
    let nextId = 0;
    const notices: string[] = [];
    const dependencies = {
      ...generationTasks, runImageTask, imageBatchTaskIsActive, imageBatchMemberApi, applyOwnedProjectUpdate,
      requestedProjectId: projectId, getCurrentState: () => state, setState: update, setBackgroundState: update,
      requestedTextApi: { apiKey: '' }, requestedImageApi: { enabled: true, backend: 'openai', apiKey: '' },
      requestedImagePromptAssetKind: 'character', requestedImageVariant: 'full-body', requestedAssetKind: 'character',
      requestedEntityId: '', requestedNsfwPrivatePart: undefined, requestedOutputSpecification: {},
      requestedOutputSize: { width: 1024, height: 1024 }, requestedNegativePrompt: '',
      requestedUseReferenceImage: false, requestedUploadedPreview: '', requestedGenerationMode: 'ordinary',
      conversionSource: 'fixture', conversionIdentityContext: '', converterRules: '',
      imagePromptSelection: { ruleSet: { format: 'natural-language' } }, imagePromptTrace: {},
      requestImagePromptConverter: async (...args: unknown[]) => {
        conversionSignals.push(args[7] as AbortSignal);
        if (stuckStage === 'conversion' && conversionSignals.length === 1) { started.resolve(); return late.promise; }
        return 'fixture image prompt';
      },
      requestImageModel: async (_api: unknown, input: { signal: AbortSignal }, onStart: () => void) => {
        onStart();
        generationSignals.push(input.signal);
        if (stuckStage === 'generation' && generationSignals.length === 1) { started.resolve(); return late.promise; }
        return { dataUrl: 'data:image/png;base64,fixture' };
      },
      window: { lianhuaDesktop: { storeGeneratedImage: async () => {
        stored += 1;
        if (stuckStage === 'storage' && stored === 1) { started.resolve(); return late.promise; }
        return { url: 'mock://stored-image', managed: true };
      } } },
      sanitizeFinalImagePrompt: (value: string) => value, privateImagePromptProblem: () => '',
      buildImageGenerationReferenceOptions: () => ({}), readGeneratedImageDimensions: () => undefined,
      imageReturnedSizeWarning: () => '', safeFileName: (name: string) => name,
      createId: () => `fixture-asset-${++nextId}`, assetPreviewUrl: (asset: ReferenceAsset) => asset.url || asset.dataUrl || '',
      isCurrentImageWorkbenchRequest: () => false, isCurrentProjectOperation: () => true,
      getCurrentProjectId: () => projectId, notify: (message: string) => notices.push(message),
      getSafeErrorDiagnostics: (error: Error) => ({ message: error.message }),
    };
    const run = new Function('d', `with(d){${compiled};return worker;}`)(dependencies) as (task: ImageGenerationTask) => Promise<void>;
    const batch = enqueueImageBatchMembers(members, (task) => imageBatchTaskIsActive(state, projectId, task, true), run);
    await bounded(started.promise);
    const live = state.project.generationTasks.find((task) => task.id === members[0].id)!;
    assert.equal(live.status, 'running');
    assert.equal(generationTasks.forceStopImageTask(projectId, live), true);
    update((current) => applyOwnedProjectUpdate(current, projectId, (owner) => ({
      ...owner, generationTasks: generationTasks.forceStopImageGenerationTask(owner.generationTasks, live.id).tasks,
    })));
    await bounded(batch);
    assert.equal(conversionSignals[0].aborted, true, 'converter receives the task abort signal');
    if (stuckStage !== 'conversion') assert.equal(generationSignals[0].aborted, true, 'image transport receives the same abort');
    assert.deepEqual(state.project.generationTasks.map((task) => task.status), ['cancelled', 'succeeded']);
    assert.deepEqual(state.project.assets.map((asset) => asset.name), [members[1].name]);
    assert.equal(conversionSignals.length, stuckStage === 'conversion' ? 2 : 1, 'completed conversion is reused, interrupted conversion is not');
    assert.equal(generationSignals.length, stuckStage === 'conversion' ? 1 : 2);
    const settled = JSON.stringify(state.project);
    late.resolve(stuckStage === 'conversion' ? 'late prompt' : stuckStage === 'generation'
      ? { dataUrl: 'data:image/png;base64,late' } : { url: 'mock://late-image', managed: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(state.project), settled, 'late completion cannot save an asset, bind it, or resurrect a stopped task');
    assert.equal(stored, stuckStage === 'storage' ? 2 : 1, 'late generation cannot start another image write');
    assert.equal(notices.length, 1, 'only the next successful task announces completion');
  });
}
