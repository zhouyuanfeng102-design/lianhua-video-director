import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as effects from '../src/appEffects';
import * as official from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import * as handoff from '../src/sequencePromptHandoff';
import * as semantic from '../src/semanticSequencePlan';
import * as versions from '../src/storyboardVersions';
import { getSingleSegmentReferences } from '../src/singleSegmentPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { createInitialState } from '../src/storage';
import type { AppState, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';
import type { RegenerateSequenceReferencePromptInput } from '../src/sequenceReferencePrompt';

// Exercise the actual App commit callback, with a delayed model adapter that
// deliberately ignores cancellation. A stale response must still be rejected
// at the App boundary. No network, desktop bridge or production data is used.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
const collect = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(ast);
const compile = (names: string[]) => ts.transpileModule(names.map((name) => {
  const node = declarations.get(name); assert.ok(node, `production callback ${name} is covered`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const evaluate = (dependencies: Record<string, unknown>) => new Function('d', `with(d){${compile([
  'sequenceStoryboardGenerationIdentity', 'hasActiveStoryboardBuild', 'refreshSequenceSegmentOfficialPrompt',
  'regenerateCurrentSequenceSegmentPrompt',
])}; return { refresh: refreshSequenceSegmentOfficialPrompt, regenerate: regenerateCurrentSequenceSegmentPrompt };}`)(dependencies) as {
  refresh: (
    plan: VideoSequencePlan, segment: VideoSegment, board: Storyboard, context: official.OfficialH3ProjectContext,
    mode: 'regenerate' | 'translate-english' | 'continuity-repair',
  ) => Promise<boolean>;
  regenerate: () => Promise<void>;
};
const clone = <T>(value: T): T => structuredClone(value);
const noOp = () => {};

const fixture = (selectedSegmentIndex = 1) => {
  let state = createInitialState();
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: 'https://qa-text-only.invalid', apiKey: '', model: 'fixture-text' };
  const converter = state.converterPresets.find((item) => item.enabled && item.scope === 'video')!;
  const content = '师傅递出药草，徒弟正在伸手接取。';
  const plan: VideoSequencePlan = {
    id: 'qa-plan', title: '纯文本衔接', sourceStoryTitle: '纯文本衔接', sourceStoryContent: content,
    durationMode: 'fixed', requestedTotalDurationSec: 45, totalDurationSec: 45, segmentDurationSec: 15,
    segmentationMode: 'fixed', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
    segments: [1, 2, 3].map((index) => ({ id: `segment-${index}`, index, title: `第${index}段`,
      globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15, content, summary: '连续交接',
      sourceSceneIds: ['qa-scene'], sourceBeatIds: [`beat-${index}`], narrativePurpose: '药草交接', entryState: '双手正在接拢',
      exitState: '保持交接动作', transitionHint: '保持0.5秒视觉动作重合', continuityPack: '原场面、原动作',
      storyboardId: `board-${index}`, status: 'ready', locked: false })),
  };
  const context: official.OfficialH3ProjectContext = { assets: [], characters: [], locations: [], props: [], sceneContent: content };
  const boards = [1, 2, 3].map((index): Storyboard => {
    const canonical = [0, 1].map((shot) => `【${shot * 7.5}s-${(shot + 1) * 7.5}s】主体：@师傅（平静）[朝向：徒弟双手] 正在 [${shot ? `CANONICAL_TAIL_${index}` : '取出药草'}]（药草交接）；空间：前景药草，中景师徒，背景山道；光影：晨光；镜头：稳定中景；台词：无；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`).join('\n');
    const draft: Storyboard = {
      id: `board-${index}`, sceneId: 'qa-scene', sourceStoryContent: content, sourceStoryTitle: '纯文本衔接',
      workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2, pace: 'standard',
      aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
      ruleSetId: state.settings.defaultRuleSetId, converterPresetId: converter.id, globalLock: '',
      shots: canonical.split('\n').map((prompt, i) => ({ id: `shot-${index}-${i}`, index: i + 1, startSec: i * 7.5, endSec: (i + 1) * 7.5,
        subject: '师傅', action: '递出药草', purpose: '药草交接', camera: '稳定中景', transition: '连续', lighting: '晨光', sound: '', result: '双手接拢', locked: false, referenceAssetIds: [], prompt })),
      finalPrompt: canonical, sequencePlanId: plan.id, segmentId: `segment-${index}`, segmentIndex: index, segmentCount: 3,
      globalStartSec: (index - 1) * 15, globalEndSec: index * 15, continuityIn: '双手正在接拢', continuityOut: '保持交接动作',
      promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical), generatedAt: 1,
        modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [] },
      createdAt: 1, updatedAt: 1,
    };
    const board = official.applyOfficialH3Prompt(draft, context);
    board.officialPromptZh = board.officialPromptZh!.replaceAll(`CANONICAL_TAIL_${index}`, `REVIEWED_TAIL_${index}`);
    board.targetOutput!.prompt = board.officialPromptZh;
    board.targetOutput!.parameters = { ...board.targetOutput!.parameters, sentinel: 'unchanged-video-settings' };
    board.officialPromptEn = board.officialPromptZh; board.officialPromptEnSource = board.officialPromptZh;
    board.englishPrompt = board.officialPromptEn; board.englishPromptSource = board.finalPrompt;
    return board;
  });
  state.project = { ...state.project, id: 'qa-project', assets: [], characters: [], locations: [], props: [], generationTasks: [],
    scenes: [{ id: 'qa-scene', title: '纯文本衔接', content, summary: '', characterIds: [], locationIds: [], propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: 1, updatedAt: 1 }],
    sequencePlans: [plan], storyboards: boards };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const stateRef = { current: state }; const operationRef: { current: { controller: AbortController } | null } = { current: null };
  const batchIdentityRef: { current: object | null } = { current: null };
  const buildLeaseRef: { current?: { projectId: string; epoch: number; owner: number } } = {};
  let englishFailure = false;
  let conversionFailure = false;
  const notices: string[] = []; const calls: RegenerateSequenceReferencePromptInput[] = [];
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dependencies: Record<string, unknown> = {
    ...effects, ...official, ...handoff, ...semantic, ...versions, officialH3ContextForStoryboard, sourceContentHash, getSingleSegmentReferences,
    busy: false, sequenceBatchRunning: false, stateRef, sequencePromptRefreshRef: operationRef, workspaceEpochRef: { current: 1 },
    activePlanIdRef: { current: plan.id }, activeSequencePlan: plan,
    activeSegmentId: plan.segments[selectedSegmentIndex].id, activeSequenceSegment: plan.segments[selectedSegmentIndex],
    activeSequencePlanReadyForGeneration: true, sequenceSettingsOpen: false, productionMode: 'sequence',
    setSequenceStage: noOp,
    storyboardBuildLeaseRef: buildLeaseRef,
    sequenceBatchIdentityRef: batchIdentityRef, sequenceOperationIsCurrent: (identity: object) => batchIdentityRef.current === identity,
    segmentStoryboardConfigurationIdentityRef: { current: 'qa-director-config' }, storyboardBusyOwnerRef: { current: 0 },
    converterId: converter.id, notify: (message: string) => notices.push(message), cleanVideoPrompt: (value: string) => value.trim(),
    setBusy: noOp, reportRuntimeError: (kind: string, error: unknown) => notices.push(`${kind}: ${String(error)}`),
    loadVideoPromptReferenceImages: async () => { assert.fail('pure text continuity cannot request image pixels'); },
    requestTextModel: async () => { assert.fail('App guard fixture must not call a real transport'); },
    regenerateSequenceReferencePrompt: async (input: RegenerateSequenceReferencePromptInput) => {
      calls.push(input); started(); await gate;
      assert.ok(input.mode === 'continuity-repair' || input.mode === 'translate-english' || input.mode === 'regenerate');
      if (input.segment.index > 1) {
        assert.ok(input.sequenceHandoff);
        assert.equal(input.sequenceHandoff.previousFinalPrompt, boards[input.segment.index - 2].officialPromptZh);
      } else {
        assert.equal(input.sequenceHandoff, undefined, 'first-segment regeneration needs no preceding handoff');
      }
      if (conversionFailure) throw new Error('QA conversion failure');
      let next = clone(input.board);
      if (input.mode !== 'translate-english') next.officialPromptZh = next.officialPromptZh!.replace('[Shot 1]',
        input.mode === 'regenerate' ? '[Shot 1] QA_REGENERATED:师傅重新托稳药草，徒弟保持伸手接取。'
          : '[Shot 1] QA_REPAIRED_OPENING:同一药草正在递交，首镜0.5秒仍呈现双手接拢。');
      next.targetOutput!.prompt = next.officialPromptZh!;
      next.officialPromptEn = `English fixture\n${next.officialPromptZh}`; next.officialPromptEnSource = next.officialPromptZh;
      next.englishPrompt = next.officialPromptEn; next.englishPromptSource = next.finalPrompt; next.officialPromptEnError = '';
      if (input.sequenceHandoff) next = handoff.stampSequencePromptHandoff(next, input.sequenceHandoff);
      if (englishFailure) Object.assign(next, { officialPromptEn: '', officialPromptEnSource: '', englishPrompt: '', englishPromptSource: '', officialPromptEnError: 'QA English translation failure' });
      return next;
    },
    setState: (updater: (current: AppState) => AppState) => { state = updater(state); stateRef.current = state; },
  };
  const { refresh, regenerate } = evaluate(dependencies);
  return {
    call: (mode: 'continuity-repair' | 'translate-english' = 'continuity-repair') => refresh(state.project.sequencePlans[0], state.project.sequencePlans[0].segments[selectedSegmentIndex], state.project.storyboards[selectedSegmentIndex], context, mode),
    regenerate,
    ready, release, notices, calls,
    update: (mutate: (current: AppState) => void) => { state = clone(state); mutate(state); stateRef.current = state; },
    cancel: () => operationRef.current?.controller.abort(),
    startBatch: () => { batchIdentityRef.current = {}; },
    revokeBatch: () => { batchIdentityRef.current = null; },
    setEnglishFailure: (value: boolean) => { englishFailure = value; },
    setConversionFailure: (value: boolean) => { conversionFailure = value; },
    setControls: (values: Record<string, unknown>) => { Object.assign(dependencies, values); },
    setBuildLease: (projectId: string, epoch = 1) => { buildLeaseRef.current = { projectId, epoch, owner: 88 }; },
    get state() { return state; },
  };
};

const mutations: Array<[string, (state: AppState) => void]> = [
  ['parent-final-text', (state) => { state.project.storyboards[0].officialPromptZh += '\nUSER_PARENT_EDIT'; }],
  ['parent-link', (state) => { state.project.sequencePlans[0].segments[0].storyboardId = 'changed-parent'; }],
  ['parent-state', (state) => { state.project.sequencePlans[0].segments[0].exitState = 'USER_PARENT_STATE'; }],
  ['current-plan-text', (state) => { state.project.sequencePlans[0].segments[1].content += '修改原文'; }],
  ['plan-order', (state) => { state.project.sequencePlans[0].segments.reverse(); }],
  ['project', (state) => { state.project.id = 'another-project'; }],
  ['current-delivery', (state) => { state.project.storyboards[1].officialPromptZh += '\nUSER_CURRENT_EDIT'; }],
  ['api', (state) => { state.settings.textApi.model = 'another-text-model'; }],
];
const begin = async (h: ReturnType<typeof fixture>, action: () => Promise<boolean | void> = () => h.call()) => {
  const pending = action();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      h.ready,
      pending.then((result) => { throw new Error(`callback ended before mock model: ${result}; ${h.notices.join('; ')}`); }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('callback did not reach isolated model')), 3000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
  return { pending };
};
for (const [label, mutate] of mutations) {
  const h = fixture(); const { pending } = await begin(h);
  h.update(mutate); const expected = JSON.stringify(h.state.project);
  h.release(); assert.equal(await pending, false, `${label}: late response cannot commit`);
  assert.equal(JSON.stringify(h.state.project), expected, `${label}: no draft, version or task changes after invalidation`);
  assert.equal(h.calls.length, 1); assert.equal(h.state.project.generationTasks.length, 0);
}
{
  const h = fixture(); const original = JSON.stringify(h.state.project); const { pending } = await begin(h);
  h.cancel(); h.release(); assert.equal(await pending, false); assert.equal(JSON.stringify(h.state.project), original);
}
{
  const h = fixture(); h.startBatch(); const original = JSON.stringify(h.state.project); const { pending } = await begin(h);
  h.revokeBatch(); h.release(); assert.equal(await pending, false, 'a retired batch cannot commit even if transport ignores cancellation');
  assert.equal(JSON.stringify(h.state.project), original);
}
{
  const h = fixture(); const before = clone(h.state.project); const { pending: first } = await begin(h);
  assert.equal(await h.call(), false, 'repeat click cannot create a concurrent text repair');
  h.release(); assert.equal(await first, true, h.notices.join('\n'));
  const board = h.state.project.storyboards[1];
  assert.equal(h.calls.length, 1); assert.deepEqual(board.shots, before.storyboards[1].shots);
  assert.equal(board.finalPrompt, before.storyboards[1].finalPrompt);
  assert.deepEqual(board.targetOutput?.parameters, before.storyboards[1].targetOutput?.parameters);
  assert.deepEqual(h.state.project.sequencePlans, before.sequencePlans);
  assert.equal(handoff.getSequencePromptHandoffStatus(board, h.state.project).kind, 'current');
  assert.ok(board.revisions?.some((revision) => revision.officialPromptZh === before.storyboards[1].officialPromptZh), 'old reviewed draft retained');
  assert.ok(board.revisions?.some((revision) => revision.officialPromptZh === board.officialPromptZh), 'new reviewed draft retained');
  assert.deepEqual(h.state.project.generationTasks, []); assert.deepEqual(h.state.project.assets, []);
}
{
  const h = fixture(); h.setEnglishFailure(true); const before = clone(h.state.project); const { pending } = await begin(h);
  h.release(); assert.equal(await pending, false, 'English failure reports incomplete and stops downstream batch work');
  const partial = clone(h.state.project.storyboards[1]);
  assert.notEqual(partial.officialPromptZh, before.storyboards[1].officialPromptZh, 'qualified Chinese is saved despite English failure');
  assert.match(partial.officialPromptEnError!, /QA English/u); assert.equal(partial.officialPromptEn, '');
  assert.equal(handoff.getSequencePromptHandoffStatus(partial, h.state.project).kind, 'current');
  assert.ok(partial.revisions?.some((revision) => revision.officialPromptZh === before.storyboards[1].officialPromptZh));
  assert.ok(partial.revisions?.some((revision) => revision.officialPromptZh === partial.officialPromptZh));
  h.setEnglishFailure(false); assert.equal(await h.call('translate-english'), true);
  const complete = h.state.project.storyboards[1];
  assert.deepEqual(h.calls.map((call) => call.mode), ['continuity-repair', 'translate-english']);
  assert.equal(complete.officialPromptZh, partial.officialPromptZh, 'English-only retry cannot repeat Chinese repair');
  assert.deepEqual(complete.revisions, partial.revisions); assert.deepEqual(complete.sequencePromptHandoff, partial.sequencePromptHandoff);
  assert.equal(complete.officialPromptEnSource, complete.officialPromptZh); assert.equal(complete.officialPromptEnError, '');
}
{
  const h = fixture(); h.setBuildLease(h.state.project.id);
  assert.equal(await h.call(), false, 'the actual synchronous build guard blocks refresh before a model request');
  assert.equal(h.calls.length, 0);
  h.update((state) => { state.project.id = 'new-project-while-old-build-finishes'; });
  const { pending } = await begin(h); h.release(); assert.equal(await pending, true, 'a previous project lease cannot block the new project');
}
{
  const h = fixture(); h.setBuildLease(h.state.project.id, 0);
  const { pending } = await begin(h); h.release(); assert.equal(await pending, true, 'a retired workspace epoch cannot hold a current build lock');
}

// The explicit action must regenerate a completed segment. The ordinary
// generation action deliberately exits early for those same saved results.
for (const selectedSegmentIndex of [0, 1]) {
  const h = fixture(selectedSegmentIndex);
  h.update((state) => {
    const board = state.project.storyboards[selectedSegmentIndex];
    board.revisions = [versions.createStoryboardRevision(board, [], { reason: 'existing-history', createdAt: 1 })];
    board.activeRevisionId = board.revisions[0].id;
    state.project.generationTasks = [{
      id: 'already-submitted-video', kind: 'video', storyboardId: board.id,
      targetId: board.targetModelId || 'qa-video-target', status: 'succeeded',
      sequencePlanId: board.sequencePlanId, segmentId: board.segmentId,
      requestBody: { prompt: board.officialPromptZh, sentinel: 'keep-original-submitted-prompt' },
      remoteTaskId: 'fixture-remote-task', createdAt: 1, updatedAt: 2,
    }];
  });
  const before = clone(h.state.project);
  assert.equal(effects.resolveSequenceSegmentPromptAction(before.sequencePlans[0].segments[selectedSegmentIndex],
    before.storyboards, before.sequencePlans[0].id, officialH3ContextForStoryboard(before, before.storyboards[selectedSegmentIndex])).action,
  'complete', 'this explicit operation starts with already-complete Chinese and English');
  const { pending } = await begin(h, h.regenerate);
  const repeated = h.regenerate();
  assert.equal(h.calls.length, 1, 'a rapid second click cannot start another regeneration before busy rerenders');
  h.release(); await Promise.all([pending, repeated]);
  const board = h.state.project.storyboards[selectedSegmentIndex];
  const previous = before.storyboards[selectedSegmentIndex];
  assert.deepEqual(h.calls.map((call) => call.mode), ['regenerate']);
  assert.notEqual(board.officialPromptZh, previous.officialPromptZh);
  assert.match(board.officialPromptZh!, /QA_REGENERATED/u);
  assert.equal(board.officialPromptEnSource, board.officialPromptZh);
  assert.equal(board.englishPrompt, board.officialPromptEn);
  assert.equal(board.englishPromptSource, board.finalPrompt);
  assert.equal(official.hasCurrentOfficialH3EnglishPrompt(board, officialH3ContextForStoryboard(h.state.project, board)), true);
  for (const key of ['id', 'durationSec', 'globalStartSec', 'globalEndSec', 'sequencePlanId', 'segmentId', 'createdAt'] as const) {
    assert.deepEqual(board[key], previous[key], `regeneration preserves ${key}`);
  }
  assert.deepEqual(board.targetOutput?.parameters, previous.targetOutput?.parameters);
  const revisions = board.revisions!;
  assert.equal(revisions.length, 3, 'existing history plus both sides of regeneration are saved');
  assert.deepEqual(revisions[0], previous.revisions![0], 'existing revision remains byte-for-byte equivalent');
  assert.equal(revisions[1].reason, 'pre-regenerate'); assert.equal(revisions[2].reason, 'regenerate');
  assert.equal(revisions[1].officialPromptZh, previous.officialPromptZh);
  assert.equal(revisions[1].officialPromptEn, previous.officialPromptEn);
  assert.equal(revisions[2].officialPromptZh, board.officialPromptZh);
  assert.equal(revisions[2].officialPromptEn, board.officialPromptEn);
  assert.equal(board.activeRevisionId, revisions[2].id);
  assert.deepEqual(h.state.project.storyboards.filter((_board, index) => index !== selectedSegmentIndex),
    before.storyboards.filter((_board, index) => index !== selectedSegmentIndex), 'neighbouring segments are untouched');
  assert.deepEqual({ ...h.state.project, storyboards: before.storyboards, updatedAt: before.updatedAt }, before,
    'regeneration does not alter plans, project content, assets or generation tasks');
}

{
  const h = fixture(); h.setEnglishFailure(true);
  const before = clone(h.state.project); const { pending } = await begin(h, h.regenerate);
  h.release(); await pending;
  const partial = clone(h.state.project.storyboards[1]);
  assert.match(partial.officialPromptZh!, /QA_REGENERATED/u);
  assert.equal(partial.officialPromptEn, ''); assert.match(partial.officialPromptEnError!, /QA English/u);
  assert.equal(partial.revisions?.length, 2);
  assert.equal(partial.revisions![0].officialPromptZh, before.storyboards[1].officialPromptZh);
  assert.equal(partial.revisions![0].officialPromptEn, before.storyboards[1].officialPromptEn,
    'English failure must not lose the old complete bilingual revision');
  assert.equal(partial.revisions![1].officialPromptZh, partial.officialPromptZh);
  assert.equal(partial.revisions![1].officialPromptEn, '');
  assert.equal(effects.resolveSequenceSegmentPromptAction(h.state.project.sequencePlans[0].segments[1], h.state.project.storyboards,
    h.state.project.sequencePlans[0].id, officialH3ContextForStoryboard(h.state.project, partial)).action, 'translate-english');
  assert.deepEqual(h.state.project.sequencePlans, before.sequencePlans);
  assert.deepEqual(h.state.project.storyboards[0], before.storyboards[0]);
  assert.deepEqual(h.state.project.storyboards[2], before.storyboards[2]);
  h.setEnglishFailure(false); assert.equal(await h.call('translate-english'), true);
  assert.deepEqual(h.calls.map((call) => call.mode), ['regenerate', 'translate-english']);
  const complete = h.state.project.storyboards[1];
  assert.equal(complete.officialPromptZh, partial.officialPromptZh, 'English retry does not regenerate qualified Chinese');
  assert.deepEqual(complete.revisions, partial.revisions); assert.equal(complete.activeRevisionId, partial.activeRevisionId);
  assert.equal(complete.officialPromptEnSource, complete.officialPromptZh);
}

const regenerateGuards: Array<[string, (h: ReturnType<typeof fixture>) => void]> = [
  ['busy', (h) => h.setControls({ busy: true })],
  ['batch-render-state', (h) => h.setControls({ sequenceBatchRunning: true })],
  ['batch-synchronous-identity', (h) => h.startBatch()],
  ['active-storyboard-build', (h) => h.setBuildLease(h.state.project.id)],
  ['locked', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].locked = true; })],
  ['settings-open', (h) => h.setControls({ sequenceSettingsOpen: true })],
  ['unconfirmed-plan', (h) => h.setControls({ activeSequencePlanReadyForGeneration: false })],
  ['changed-active-plan', (h) => h.setControls({ activeSequencePlan: { ...h.state.project.sequencePlans[0], id: 'different-plan' } })],
  ['missing-selected-plan', (h) => h.setControls({ activePlanIdRef: { current: 'missing-plan' } })],
  ['stale-segment', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].status = 'stale'; })],
  ['mismatched-storyboard-link', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].storyboardId = 'board-3'; })],
];
for (const [label, configure] of regenerateGuards) {
  const h = fixture(); configure(h); const before = clone(h.state);
  h.release(); // A missing guard must fail its assertions instead of waiting forever at the mock transport.
  await h.regenerate();
  assert.equal(h.calls.length, 0, `${label}: explicit regeneration is rejected before any API request`);
  assert.deepEqual(h.state, before, `${label}: rejected action cannot change saved results or history`);
}

const lateRegenerationMutations: Array<[string, (state: AppState) => void]> = [
  ...mutations,
  ['saved-english-only-edit', (state) => { state.project.storyboards[1].officialPromptEn += '\nUSER_ENGLISH_EDIT'; }],
  ['revision-history-edit', (state) => {
    const board = state.project.storyboards[1];
    board.revisions = [versions.createStoryboardRevision(board, [], { reason: 'user-save-during-request' })];
  }],
  ['board-director-requirement-edit', (state) => { state.project.storyboards[1].extraRequirement = 'USER_DIRECTOR_REQUIREMENT'; }],
  ['target-video-parameters', (state) => { state.project.storyboards[1].targetOutput!.parameters.seed = 42; }],
  ['segment-locked-during-request', (state) => { state.project.sequencePlans[0].segments[1].locked = true; }],
];
for (const [label, mutate] of lateRegenerationMutations) {
  const h = fixture(); const { pending } = await begin(h, h.regenerate);
  h.update(mutate); const expected = clone(h.state);
  h.release(); await pending;
  assert.deepEqual(h.state, expected, `${label}: a late regeneration cannot overwrite user edits, projects or revisions`);
  assert.equal(h.calls.length, 1);
}
{
  const h = fixture(); const before = clone(h.state); const { pending } = await begin(h, h.regenerate);
  h.cancel(); h.release(); await pending;
  assert.deepEqual(h.state, before, 'cancelled regeneration preserves the original results and history');
}
{
  const h = fixture(); h.setConversionFailure(true); const before = clone(h.state);
  const { pending } = await begin(h, h.regenerate); h.release(); await pending;
  assert.deepEqual(h.state, before, 'conversion failure cannot save partial Chinese or empty history');
  assert.ok(h.notices.some((notice) => notice.includes('QA conversion failure')));
}
console.log('Text handoff and explicit regeneration App callbacks: completed/first segments, old/new history, English-failure recovery, busy/batch/lock/double-click guards, stale edits/project changes, cancellation and fixed project boundaries passed (mock only).');
