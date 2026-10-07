import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { canUseFinalPromptConverter } from '../src/appEffects';
import * as official from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { commitH3IdentityRepair } from '../src/h3IdentityRepairCommit';
import { H3IdentityRepairCancelledError, repairH3IdentityBindings as actualRepairEngine, type RepairH3IdentityBindingsInput } from '../src/h3IdentityRepair';
import { sourceContentHash } from '../src/sourceIntegrity';
import { resolveStoryboardCharacterParticipation } from '../src/characterParticipation';
import { createInitialState } from '../src/storage';
import type { AppState } from '../src/types';
import { identityRepairResultFor, makeIdentityRepairProject } from './h3IdentityRepairCommit.test';

// Execute the actual App callback and actual persistence helper. Only the
// model-facing repair is delayed/replaced, deliberately ignoring cancellation
// so the App itself must reject obsolete responses. All data is synthetic.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration>();
const collect = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(ast);
const compiled = ts.transpileModule(['hasActiveStoryboardBuild', 'repairStoryboardIdentityBindings'].map((name) => {
  const declaration = declarations.get(name);
  assert.ok(declaration, `production callback ${name} exists`);
  return `const ${declaration.getText(ast)};`;
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Callback = (boardId: string, language: 'zh' | 'en', characterIds?: string[]) => Promise<void>;
const evaluate = (dependencies: Record<string, unknown>): Callback => new Function('d',
  `with(d){${compiled};return repairStoryboardIdentityBindings;}`)(dependencies);
const clone = <T>(value: T): T => structuredClone(value);
type Outcome = { ok: true } | { ok: false; error: unknown };

const fixture = () => {
  let state = createInitialState();
  state.project = makeIdentityRepairProject();
  state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: 'https://synthetic.invalid', model: 'synthetic-model' };
  const targetId = 'board-2';
  const oldBoard = clone(state.project.storyboards[1]);
  const stateRef = { current: state };
  const operationRef: { current: { controller: AbortController } | null } = { current: null };
  const batchRef: { current: object | null } = { current: null };
  const leaseRef: { current: { projectId: string; epoch: number; owner: number } | undefined } = { current: undefined };
  const epochRef = { current: 1 };
  const configurationRef = { current: 'synthetic-director-configuration' };
  let busy = false;
  let busyEpoch = 0;
  let englishFailure = false;
  let selectedBoardId = 'board-1';
  let beforeCommit: (() => void) | undefined;
  const calls: RepairH3IdentityBindingsInput[] = [];
  const notices: string[] = [];
  const busyEvents: boolean[] = [];
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const update = (mutate: (current: AppState) => void): void => {
    state = clone(state); mutate(state); stateRef.current = state;
  };
  const dependencies: Record<string, unknown> = {
    ...official, canUseFinalPromptConverter, officialH3ContextForStoryboard, commitH3IdentityRepair,
    H3IdentityRepairCancelledError, sourceContentHash, resolveStoryboardCharacterParticipation, stateRef,
    get busy() { return busy; },
    sequencePromptRefreshRef: operationRef, workspaceEpochRef: epochRef,
    storyboardBuildLeaseRef: leaseRef, sequenceBatchIdentityRef: batchRef,
    segmentStoryboardConfigurationIdentityRef: configurationRef,
    getCurrentStoryboardOperationIdentity: () => ({ storyboardId: selectedBoardId, workspaceEpoch: epochRef.current }),
    setBusy: (value: boolean) => { busy = value; busyEpoch += 1; busyEvents.push(value); },
    getBusyEpoch: () => busyEpoch,
    notify: (message: string) => notices.push(message),
    requestTextModel: async () => assert.fail('App boundary test must never reach a text API transport'),
    repairH3IdentityBindings: async (input: RepairH3IdentityBindingsInput) => {
      calls.push(input); started(); await gate;
      if (!input.bindings && !input.targetCharacterIds) return actualRepairEngine(input);
      if (input.language === '英文' && englishFailure) throw new Error('SYNTHETIC_ENGLISH_FAILURE');
      return identityRepairResultFor(oldBoard, input.language === '中文' ? 'zh' : 'en');
    },
    setState: (updater: (current: AppState) => AppState) => {
      const mutate = beforeCommit; beforeCommit = undefined; mutate?.();
      state = updater(state); stateRef.current = state;
    },
  };
  const callback = evaluate(dependencies);
  return {
    targetId, ready, release, calls, notices, busyEvents, update,
    get state() { return state; },
    get board() { return state.project.storyboards.find((board) => board.id === targetId)!; },
    get operation() { return operationRef.current; },
    get busy() { return busy; },
    call: (language: 'zh' | 'en' = 'en', targets?: string[], boardId = targetId) => callback(boardId, language, targets),
    cancel: () => operationRef.current?.controller.abort(),
    changeEpoch: () => { epochRef.current += 1; },
    changeConfiguration: () => { configurationRef.current = 'changed-director-configuration'; },
    changeSelectedBoard: () => { selectedBoardId = 'board-3'; },
    setEnglishFailure: () => { englishFailure = true; },
    setBeforeCommit: (fn: () => void) => { beforeCommit = fn; },
    setBusy: () => { busy = true; },
    setBatch: () => { batchRef.current = { id: 'active-batch' }; },
    setBuild: (sameWorkspace = true) => { leaseRef.current = { projectId: sameWorkspace ? state.project.id : 'other-project', epoch: epochRef.current, owner: 1 }; },
    setOperation: () => { operationRef.current = { controller: new AbortController() }; },
    replaceBusyOwner: () => { busyEpoch += 1; },
  };
};
type Harness = ReturnType<typeof fixture>;
const start = async (h: Harness, language: 'zh' | 'en' = 'en', targets?: string[]) => {
  const outcome: Promise<Outcome> = h.call(language, targets).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([h.ready, outcome.then((result) => { throw new Error(`App stopped before repair: ${result.ok ? 'success' : String(result.error)}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('App did not reach repair')), 3000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  return { outcome };
};
const assertSuccess = (result: Outcome): void => { if (!result.ok) throw result.error; };
const assertCancelled = (result: Outcome): void => {
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error instanceof H3IdentityRepairCancelledError, String(result.error));
};
let groups = 0;
const errors: unknown[] = [];
const test = async (name: string, run: () => Promise<void>): Promise<void> => {
  try { await run(); groups += 1; console.log(`PASS ${name}`); }
  catch (error) { errors.push(error); console.error(`FAIL ${name}`); console.error(error); }
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => assert.fail('live network is forbidden')) as typeof fetch;
try {
  await test('English repair commits only English with original Chinese, shots, submitted tasks, parameters and image selections intact', async () => {
    const h = fixture();
    h.update((state) => { state.project.storyboards[1].imageToImage = { referenceAssetIds: ['selected-image'], selectedShotIds: ['shot-2'], referenceAssetIdsByShotId: {} }; });
    const before = clone(h.state.project); const { outcome } = await start(h, 'en', ['amu']);
    await assert.rejects(h.call(), /当前提示词任务/u);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].targetCharacterIds, ['amu']);
    assert.deepEqual(h.calls[0].characters, officialH3ContextForStoryboard(before, before.storyboards[1]).characters);
    h.release(); assertSuccess(await outcome);
    const board = h.board; const original = before.storyboards[1];
    assert.equal(board.officialPromptZh, original.officialPromptZh);
    assert.deepEqual(board.h3IdentityBindings, original.h3IdentityBindings);
    assert.notEqual(board.officialPromptEn, original.officialPromptEn);
    assert.equal(board.officialPromptEnSource, original.officialPromptZh);
    assert.deepEqual(board.shots, original.shots);
    assert.deepEqual(board.targetOutput, original.targetOutput);
    assert.deepEqual(board.imageToImage, original.imageToImage);
    assert.deepEqual(h.state.project.generationTasks, before.generationTasks);
    assert.deepEqual(h.state.project.storyboards.filter((item) => item.id !== h.targetId), before.storyboards.filter((item) => item.id !== h.targetId));
    assert.equal(board.revisions!.length, original.revisions!.length + 2);
    assert.equal(h.operation, null); assert.equal(h.busy, false); assert.deepEqual(h.busyEvents, [true, false]);
  });
  await test('Chinese repair pairs English and saves matched sources atomically without rewriting story', async () => {
    const h = fixture(); const before = clone(h.board); const { outcome } = await start(h, 'zh');
    h.release(); assertSuccess(await outcome);
    assert.deepEqual(h.calls.map((call) => call.language), ['中文', '英文']);
    assert.equal(h.board.officialPromptEnSource, h.board.officialPromptZh);
    assert.equal(h.board.targetOutput!.prompt, h.board.officialPromptZh);
    assert.equal(h.board.finalPrompt, before.finalPrompt); assert.deepEqual(h.board.shots, before.shots);
    assert.equal(official.hasCurrentOfficialH3EnglishPrompt(h.board, officialH3ContextForStoryboard(h.state.project, h.board)), true);
  });
  await test('paired English failure saves neither language nor revisions', async () => {
    const h = fixture(); h.setEnglishFailure(); const before = clone(h.state.project); const { outcome } = await start(h, 'zh');
    h.release(); const result = await outcome;
    assert.equal(result.ok, false); if (!result.ok) assert.match(String(result.error), /SYNTHETIC_ENGLISH_FAILURE/u);
    assert.deepEqual(h.state.project, before); assert.equal(h.operation, null); assert.equal(h.busy, false);
  });
  await test('legacy English without identity metadata inherits only the explicit Chinese repair targets', async () => {
    const h = fixture(); h.update((state) => { delete state.project.storyboards[1].h3IdentityBindingsEn; });
    const { outcome } = await start(h, 'zh'); h.release(); assertSuccess(await outcome);
    assert.deepEqual(h.calls.map((call) => [call.language, call.targetCharacterIds]), [['中文', ['amu']], ['英文', ['amu']]]);
    assert.equal(h.calls[1].bindings, undefined);
    assert.equal(h.board.officialPromptEnSource, h.board.officialPromptZh);
    assert.deepEqual(h.board.h3IdentityBindingsEn?.characters.map((item) => item.characterId), ['amu']);
    assert.equal(h.board.revisions!.at(-2)!.h3IdentityBindingsEn, undefined, 'old English metadata absence remains recoverable');
  });
  await test('missing current-language metadata never expands repair targets to the whole project cast', async () => {
    const h = fixture(); h.update((state) => { delete state.project.storyboards[1].h3IdentityBindingsEn; });
    const before = clone(h.state.project);
    const { outcome } = await start(h); assert.equal(h.calls[0].targetCharacterIds, undefined);
    assert.equal(h.calls[0].bindings, undefined); h.release(); const result = await outcome;
    assert.equal(result.ok, false); if (!result.ok) assert.match(String(result.error), /先明确选择/u);
    assert.deepEqual(h.state.project, before);
  });
  await test('Chinese repair leaves already-stale English intact and does not mark it current', async () => {
    const h = fixture(); h.update((state) => { state.project.storyboards[1].officialPromptEnSource = 'already-stale'; });
    const oldEnglish = h.board.officialPromptEn; const { outcome } = await start(h, 'zh'); h.release(); assertSuccess(await outcome);
    assert.deepEqual(h.calls.map((call) => call.language), ['中文']); assert.equal(h.board.officialPromptEn, oldEnglish);
    assert.equal(official.hasCurrentOfficialH3EnglishPrompt(h.board, officialH3ContextForStoryboard(h.state.project, h.board)), false);
  });
  const mutations: Array<[string, (h: Harness) => void]> = [
    ['project changed', (h) => h.update((state) => { state.project.id = 'changed-project'; })],
    ['board removed', (h) => h.update((state) => { state.project.storyboards = state.project.storyboards.filter((board) => board.id !== h.targetId); })],
    ['Chinese edited', (h) => h.update((state) => { state.project.storyboards[1].officialPromptZh += '\nUSER_EDIT'; })],
    ['English edited', (h) => h.update((state) => { state.project.storyboards[1].officialPromptEn += '\nUSER_EDIT'; })],
    ['shot edited', (h) => h.update((state) => { state.project.storyboards[1].shots[0].camera = 'USER_CAMERA'; })],
    ['request parameters edited', (h) => h.update((state) => { state.project.storyboards[1].targetOutput!.parameters.seed = 42; })],
    ['segment locked', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].locked = true; })],
    ['segment relinked', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].storyboardId = 'board-3'; })],
    ['segment source edited', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].content += 'CHANGED'; })],
    ['character context edited', (h) => h.update((state) => { state.project.characters[0].outfit = 'USER_OUTFIT'; })],
    ['API model changed', (h) => h.update((state) => { state.settings.textApi.model = 'changed-api'; })],
    ['API disabled', (h) => h.update((state) => { state.settings.textApi.enabled = false; })],
    ['workspace epoch changed', (h) => h.changeEpoch()],
    ['director configuration changed', (h) => h.changeConfiguration()],
    ['operation aborted', (h) => h.cancel()],
  ];
  for (const [name, mutate] of mutations) await test(`${name}: late uncancellable reply cannot overwrite current data`, async () => {
    const h = fixture(); const { outcome } = await start(h); mutate(h);
    const expected = clone(h.state.project); h.release(); assertCancelled(await outcome);
    assert.deepEqual(h.state.project, expected); assert.equal(h.operation, null);
  });
  await test('state changed immediately at commit boundary is checked again', async () => {
    const h = fixture(); const { outcome } = await start(h); let expected = clone(h.state.project);
    h.setBeforeCommit(() => { h.update((state) => { state.project.storyboards[1].officialPromptEn += '\nLAST_MOMENT_EDIT'; }); expected = clone(h.state.project); });
    h.release(); assertCancelled(await outcome); assert.deepEqual(h.state.project, expected);
  });
  await test('video preview target is independent of director selection and image-only edits survive pending repair', async () => {
    const h = fixture(); const { outcome } = await start(h); h.changeSelectedBoard();
    const images = { referenceAssetIds: ['new-image'], selectedShotIds: ['shot-2'], referenceAssetIdsByShotId: { 'shot-2': ['new-image'] } };
    h.update((state) => { state.project.storyboards[1].imageToImage = images; });
    h.release(); assertSuccess(await outcome); assert.deepEqual(h.board.imageToImage, images);
    assert.equal(h.board.id, h.targetId); assert.equal(h.calls.length, 1);
  });
  await test('finishing obsolete work never clears a newer busy owner', async () => {
    const h = fixture(); const { outcome } = await start(h); h.replaceBusyOwner();
    h.release(); assertSuccess(await outcome); assert.equal(h.busy, true); assert.deepEqual(h.busyEvents, [true]);
  });
  const blockers: Array<[string, (h: Harness) => void, RegExp]> = [
    ['busy', (h) => h.setBusy(), /当前提示词任务/u],
    ['active batch', (h) => h.setBatch(), /当前提示词任务/u],
    ['active storyboard build', (h) => h.setBuild(), /当前提示词任务/u],
    ['active repair', (h) => h.setOperation(), /当前提示词任务/u],
    ['locked segment', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].locked = true; }), /已锁定/u],
    ['changed segment link', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].storyboardId = 'board-3'; }), /关联已变化/u],
    ['disabled API', (h) => h.update((state) => { state.settings.textApi.enabled = false; }), /文本 API/u],
    ['stale English', (h) => h.update((state) => { state.project.storyboards[1].officialPromptEnSource = 'stale'; }), /提示词已失效/u],
  ];
  for (const [name, mutate, expected] of blockers) await test(`${name}: rejected before a model request`, async () => {
    const h = fixture(); mutate(h); const before = clone(h.state.project);
    await assert.rejects(h.call(), expected); assert.equal(h.calls.length, 0); assert.deepEqual(h.state.project, before);
  });
  await test('unrelated project build lease does not block the selected video prompt', async () => {
    const h = fixture(); h.setBuild(false); const { outcome } = await start(h); h.release(); assertSuccess(await outcome);
  });
} finally { globalThis.fetch = originalFetch; }
if (errors.length) throw new AggregateError(errors, `${errors.length} identity-repair App regression(s) failed`);
console.log(`h3IdentityRepairApp: ${groups} actual-callback groups passed; no paid API or real project data`);
