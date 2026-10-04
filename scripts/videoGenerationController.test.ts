import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createVideoRuntimeStore, type VideoRuntimeStore } from '../src/videoRuntimeStore';
import type { AppState } from '../src/types';
import type { VideoGenerationController, VideoGenerationRuntime } from '../src/videoGenerationTypes';
import type { VideoGenerationEngineOptions } from '../src/videoGeneration';

// Execute the production hook with deterministic React ref/effect slots and a
// fake engine. No real desktop bridge, storage, network, timers or POSTs run.
// This covers controller lifetime/stale-callback behavior; React's public
// external-store hooks are also exercised with real SSR in videoRuntimeStore.
const source = readFileSync(new URL('../src/useVideoGenerationController.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('useVideoGenerationController.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = parsed.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((entry) => entry.name.getText(parsed) === 'useVideoGenerationController'));
assert.ok(declaration);
const compiled = ts.transpileModule(declaration.getText(parsed).replace(/^export\s+/u, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
assert.doesNotMatch(source, /\buseState\b|setRuntimeById/u, 'runtime callbacks must not create root React state updates');

interface EffectSlot { dependencies: unknown[]; create: () => void | (() => void); cleanup?: () => void }
const sameDependencies = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((entry, index) => Object.is(entry, right[index]));
const fixture = () => {
  const references: Array<{ current: unknown }> = [];
  const effects: EffectSlot[] = [];
  let referenceIndex = 0;
  let effectIndex = 0;
  let pendingEffects: Array<() => void> = [];
  let renderCount = 0;
  let nextTimerId = 0;
  const timers = new Map<number, () => void>();
  const engines: FakeEngine[] = [];
  const stores: VideoRuntimeStore[] = [];
  const preflights: unknown[][] = [];
  const persisted: AppState[] = [];
  const bridge = { marker: 'isolated desktop stub' };
  class FakeEngine {
    disposed = false;
    reconciles = 0;
    actions: Array<[string, unknown]> = [];
    constructor(readonly options: VideoGenerationEngineOptions) { engines.push(this); }
    reconcile() { this.reconciles++; }
    dispose() { this.disposed = true; }
    async start(value: unknown) { this.actions.push(['start', value]); return 'fake-task'; }
    async startBatch(value: unknown) { this.actions.push(['batch', value]); return { batchId: 'fake-batch', taskIds: ['fake-task'], skipped: [] }; }
    async retryDownload(id: string) { this.actions.push(['download', id]); }
    async resume(id: string) { this.actions.push(['resume', id]); }
    async cancel(id: string) { this.actions.push(['cancel', id]); }
    async cancelBatch(id: string) { this.actions.push(['cancelBatch', id]); return { batchId: id, cancelledTaskIds: [], retainedTaskIds: [] }; }
    async resumeBatch(id: string) { this.actions.push(['resumeBatch', id]); return { batchId: id, resumedTaskIds: [], completedTaskIds: [], waitingTaskIds: [], issues: [] }; }
    async confirmContinueBatch(id: string) { this.actions.push(['confirmContinueBatch', id]); return { batchId: 'continued', taskIds: [], skipped: [] }; }
  }
  const dependencies = {
    useRef: (value: unknown) => {
      const index = referenceIndex++;
      if (!(index in references)) references[index] = { current: value };
      return references[index];
    },
    useEffect: (create: () => void | (() => void), effectDependencies: unknown[]) => {
      const index = effectIndex++;
      const previous = effects[index];
      if (!previous || !sameDependencies(previous.dependencies, effectDependencies)) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          const cleanup = create();
          effects[index] = { dependencies: effectDependencies, create, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
    createVideoRuntimeStore: () => {
      const store = createVideoRuntimeStore({
        schedule: (callback) => { const id = ++nextTimerId; timers.set(id, callback); return id; },
        cancelScheduled: (id) => { timers.delete(id as number); },
      });
      stores.push(store); return store;
    },
    VideoGenerationEngine: FakeEngine,
    preflightVideoBatchManagedReferences: async (...args: unknown[]) => { preflights.push(args); },
    saveStateAsync: async (state: AppState) => { persisted.push(state); return { ok: true }; },
    window: { lianhuaDesktop: bridge },
  };
  type Input = {
    state: AppState; setState: (updater: (current: AppState) => AppState) => void;
    getCurrentState?: () => AppState; ready?: boolean; notify?: (message: string, kind?: 'normal' | 'error') => void;
  };
  const hook = new Function(...Object.keys(dependencies), `${compiled}\nreturn useVideoGenerationController;`)(...Object.values(dependencies)) as (input: Input) => VideoGenerationController;
  return {
    engines, stores, preflights, persisted, bridge,
    get renderCount() { return renderCount; },
    get timerCount() { return timers.size; },
    render(input: Input) {
      referenceIndex = 0; effectIndex = 0; pendingEffects = []; renderCount++;
      const result = hook(input);
      for (const effect of pendingEffects) effect();
      return result;
    },
    replayEffects() {
      effects.forEach((effect) => effect.cleanup?.());
      effects.forEach((effect) => { const cleanup = effect.create(); effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
    },
    flushTimers() {
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback());
    },
    unmount() { effects.forEach((effect) => effect.cleanup?.()); },
  };
};
const makeState = (id: string) => ({ project: { id }, projects: [{ id }], settings: { marker: id } }) as unknown as AppState;
let passed = 0;
const test = async (name: string, check: () => void | Promise<void>) => { await check(); passed++; console.log(`ok ${passed} - ${name}`); };

await test('controller/store/actions retain identity and onRuntime never updates App state', () => {
  const harness = fixture(); const state = makeState('first'); let stateUpdates = 0;
  const input = { state, setState: () => { stateUpdates++; } };
  const first = harness.render(input);
  const second = harness.render({ ...input, state: makeState('second') });
  assert.equal(second, first); assert.equal(second.start, first.start); assert.equal(second.runtimeStore, first.runtimeStore);
  assert.equal(harness.stores.length, 1); assert.equal(harness.engines.length, 1);
  const engine = harness.engines[0];
  engine.options.onRuntime('task', { stage: 'running', step: 0 });
  let taskRenders = 0; const unsubscribe = first.runtimeStore!.subscribeTask('task', () => { taskRenders++; });
  for (let step = 1; step <= 1000; step++) engine.options.onRuntime('task', { stage: 'running', step });
  assert.equal(harness.timerCount, 1); assert.equal(harness.renderCount, 2); assert.equal(stateUpdates, 0); assert.equal(taskRenders, 0);
  harness.flushTimers();
  assert.equal(taskRenders, 1); assert.equal(first.runtimeById.task.step, 1000); assert.equal(stateUpdates, 0); assert.equal(harness.renderCount, 2);
  unsubscribe(); harness.unmount();
});

await test('stable API uses current state/setter/notify and preserves preflight before batch action', async () => {
  const harness = fixture(); let live = makeState('before'); const firstNotices: string[] = []; const latestNotices: string[] = [];
  let firstSets = 0; let latestSets = 0;
  const controller = harness.render({ state: live, getCurrentState: () => live, setState: () => { firstSets++; }, notify: (message) => { firstNotices.push(message); } });
  live = makeState('after');
  harness.render({ state: live, getCurrentState: () => live, setState: () => { latestSets++; }, notify: (message) => { latestNotices.push(message); } });
  const engine = harness.engines[0];
  assert.equal(engine.options.getState(), live);
  engine.options.setState((value) => value); assert.equal(firstSets, 0); assert.equal(latestSets, 1);
  engine.options.notify?.('new notice'); assert.deepEqual(firstNotices, []); assert.deepEqual(latestNotices, ['new notice']);
  await engine.options.persistState?.(); assert.equal(harness.persisted[0], live);
  const input = { projectId: 'after', label: 'batch', items: [] };
  await controller.startBatch(input);
  assert.equal(harness.preflights[0][0], live); assert.equal(harness.preflights[0][1], input); assert.equal(harness.preflights[0][2], harness.bridge);
  assert.deepEqual(engine.actions, [['batch', input]]);
  await controller.cancel('one'); await controller.cancelBatch('batch'); await controller.resume('one'); await controller.retryDownload('one');
  assert.deepEqual(engine.actions.slice(1), [['cancel', 'one'], ['cancelBatch', 'batch'], ['resume', 'one'], ['download', 'one']]);
  await controller.resumeBatch!('batch'); await controller.confirmContinueBatch!('plan');
  assert.deepEqual(engine.actions.slice(-2), [['resumeBatch', 'batch'], ['confirmContinueBatch', 'plan']]);
  harness.unmount();
});

await test('ready transitions reset subscriptions safely and reject callbacks from an old engine', () => {
  const harness = fixture(); const input = { state: makeState('project'), setState: () => {} };
  const controller = harness.render({ ...input, ready: false });
  assert.equal(harness.engines.length, 0);
  assert.throws(() => controller.cancel('task'), /尚未加载/u);
  assert.equal(harness.render({ ...input, ready: true }), controller);
  const old = harness.engines[0]; old.options.onRuntime('task', { stage: 'running', step: 0 });
  old.options.onRuntime('task', { stage: 'running', step: 1 }); assert.equal(harness.timerCount, 1);
  harness.render({ ...input, ready: false });
  assert.equal(old.disposed, true); assert.equal(harness.timerCount, 0); assert.equal(Object.keys(controller.runtimeById).length, 0);
  old.options.onRuntime('task', { stage: 'succeeded' }); assert.equal(Object.keys(controller.runtimeById).length, 0);
  harness.render({ ...input, ready: true }); assert.equal(harness.engines.length, 2);
  harness.engines[1].options.onRuntime('task', { stage: 'queued' });
  old.options.onRemoveRuntime?.('task'); assert.equal(controller.runtimeById.task.stage, 'queued');
  harness.unmount();
});

await test('StrictMode effect replay and unmount release timers without disabling the reused store', () => {
  const harness = fixture(); const controller = harness.render({ state: makeState('project'), setState: () => {} });
  const first = harness.engines[0]; let notifications = 0;
  const unsubscribe = controller.runtimeStore!.subscribeTask('task', () => { notifications++; });
  first.options.onRuntime('task', { stage: 'running', step: 0 });
  first.options.onRuntime('task', { stage: 'running', step: 1 });
  harness.replayEffects(); assert.equal(first.disposed, true); assert.equal(harness.timerCount, 0); assert.equal(harness.engines.length, 2);
  first.options.onRuntime('task', { stage: 'failed' }); assert.equal(Object.keys(controller.runtimeById).length, 0);
  harness.engines[1].options.onRuntime('task', { stage: 'running', step: 2 });
  assert.equal(controller.runtimeById.task.step, 2); assert.equal(notifications, 3, 'the surviving task subscriber sees reset and resumed progress');
  harness.engines[1].options.onRuntime('task', { stage: 'running', step: 3 }); assert.equal(harness.timerCount, 1);
  unsubscribe(); harness.unmount(); assert.equal(harness.timerCount, 0); assert.equal(harness.engines[1].disposed, true);
  const prior = notifications;
  harness.engines[1].options.onRuntime('task', { stage: 'succeeded' }); harness.flushTimers();
  assert.equal(Object.keys(controller.runtimeById).length, 0); assert.equal(notifications, prior);
});

await test('execution mode and count changes wake the existing engine without resetting it', () => {
  const harness = fixture(); const state = makeState('project');
  state.settings.videoExecutionMode = 'queue'; state.settings.videoExecutionConcurrency = 1;
  const input = { state, setState: () => {} };
  const controller = harness.render(input);
  const engine = harness.engines[0]; const before = engine.reconciles;
  harness.render({ ...input, state: { ...state, settings: { ...state.settings, videoExecutionMode: 'concurrent', videoExecutionConcurrency: 3 } } });
  assert.equal(engine.reconciles, before + 1);
  assert.equal(harness.engines.length, 1); assert.equal(engine.disposed, false);
  assert.equal(harness.render({ ...input, state: { ...state, settings: { ...state.settings, videoExecutionMode: 'concurrent', videoExecutionConcurrency: 2 } } }), controller);
  assert.equal(engine.reconciles, before + 2);
  harness.unmount();
});

await test('full-job callback projection and immediate terminal publication do not touch persistence', () => {
  const harness = fixture(); let stateUpdates = 0;
  const controller = harness.render({ state: makeState('project'), setState: () => { stateUpdates++; } });
  const callback = harness.engines[0].options.onRuntime;
  callback('task', { stage: 'running', progress: 0, snapshot: { images: ['large image bytes'], draft: { prompt: 'source' } } } as VideoGenerationRuntime);
  assert.deepEqual(Object.keys(controller.runtimeById.task), ['stage', 'progress']);
  callback('task', { stage: 'running', progress: 12 });
  callback('task', { stage: 'stopped', cancellationPending: true });
  assert.equal(controller.runtimeById.task.stage, 'stopped'); assert.equal(harness.timerCount, 0);
  assert.equal(stateUpdates, 0); assert.equal(harness.persisted.length, 0); assert.deepEqual(harness.engines[0].actions, []);
  harness.unmount();
});

console.log(`videoGenerationController: ${passed} isolated lifecycle checks passed`);
