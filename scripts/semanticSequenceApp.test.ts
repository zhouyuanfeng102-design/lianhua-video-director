import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { buildLocalSequencePlan } from '../src/storySegmentation';
import { canUseFinalPromptConverter, replaceProjectSourceDocument, resolveSequenceSegmentDuration, upsertSequencePlan } from '../src/appEffects';
import { materializeSemanticSequencePlan, normalizeSemanticSequenceRequestedTotalDuration, type SemanticSequencePlanningInput } from '../src/semanticSequencePlan';
import { storyDraftIdentity } from '../src/storyDraft';
import { storyboardRequestApiIdentity } from '../src/storyboardRequestIdentity';
import { buildVideoCreativeDirection } from '../src/videoCreativeDirection';
import { sourceContentHash } from '../src/sourceContentHash';
import { requestSemanticSequencePlan as productionSemanticSequencePlanner, type SemanticSequencePlannerOptions } from '../src/services/semanticSequencePlanner';
import { createRuntimeErrorLogEntry, type RuntimeErrorLogEntry } from '../src/runtimeErrorLog';
import type { AppState, SequenceDurationMode, Storyboard, TextApiConfig } from '../src/types';

// Real App callbacks under deterministic delayed adapters. These do not mount
// React, read a real project, use a desktop profile or issue network requests.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration>();
const collect = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(ast);
const compiled = ts.transpileModule(['sequenceMasterStoryboardSnapshot', 'sequencePlanningSegmentDurationSec',
  'semanticPlanningRequestedTotalDurationSec', 'buildSequencePlanningIdentity', 'generateSemanticSequencePlan', 'cancelSemanticSequencePlanning'].map((name) => {
  const declaration = declarations.get(name); assert.ok(declaration, `production callback ${name} exists`);
  return `const ${declaration.getText(ast)};`;
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const noop = () => {};
const story = '林舟把铜铃递向苏禾。苏禾接稳铜铃。';
const response = {
  segmentCount: 2, reason: 'AI决定真实动作推进', fitStatus: 'balanced' as const,
  segments: ['林舟把铜铃递向苏禾。', '苏禾接稳铜铃。'].map((content, index) => ({
    title: `第${index + 1}段`, content, summary: content, narrativePurpose: '推进原事件', entryState: '交接中', exitState: '铜铃交接推进',
    transitionHint: '接上段末端动作', boundaryReason: '模型决定的边界', continuityPack: '左右站位和道具归属不变',
    semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: 'handoff', description: content, phase: String(index) }], dialogues: [] },
  })),
};
const responseWithCount = (count: number) => ({ ...response, segmentCount: count,
  segments: Array.from({ length: count }, (_, index) => ({ ...response.segments[index % response.segments.length], title: `固定第${index + 1}段` })),
});
const responseWithoutCount = (count = 2) => {
  const result = responseWithCount(count);
  return { reason: result.reason, fitStatus: result.fitStatus, segments: result.segments };
};
type RequestCall = { input: SemanticSequencePlanningInput; signal?: AbortSignal; options: SemanticSequencePlannerOptions };
const fixture = (holdPreflight = false, useProductionPlanner = false, timing: { durationMode?: SequenceDurationMode; totalDuration?: number } = {}) => {
  let state = createInitialState();
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: 'https://qa-semantic.invalid/v1', apiKey: '', model: 'mock-semantic' };
  const oldPlan = buildLocalSequencePlan({ title: '历史总稿', story: '历史人物在旧门口站立。', totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [] });
  oldPlan.id = 'legacy-plan'; oldPlan.masterStoryboardId = 'legacy-master';
  const oldBoard: Storyboard = {
    id: 'legacy-master', sceneId: 'legacy-scene', sequencePlanId: oldPlan.id, workflow: 'drama', inputMode: 'text',
    durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'historical-converter', globalLock: '历史空间', globalReferenceAssetIds: [],
    sourceStoryContent: oldPlan.sourceStoryContent, shots: [], finalPrompt: 'HISTORICAL_MASTER_RESULT', officialPromptZh: 'HISTORICAL_FINAL_ZH',
    officialPromptEn: 'HISTORICAL_FINAL_EN', createdAt: 1, updatedAt: 1,
  };
  state.project = { ...state.project, id: 'semantic-callback-project', characters: [], locations: [], props: [], assets: [], generationTasks: [],
    scenes: [], storyboards: [oldBoard], sequencePlans: [oldPlan], sourceDocuments: [{ id: 'original-source', name: '铜铃交接', content: story, createdAt: 1, updatedAt: 1 }] };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const stateRef = { current: state }; const epoch = { current: 1 }; const identity = { current: 'initial-story-duration-director' };
  const controller: { current: AbortController | null } = { current: null };
  const draft = { current: { storyName: '铜铃交接', storyInput: story } };
  const calls: RequestCall[] = []; const notices: string[] = []; const persisted: string[] = []; const runtimeErrors: RuntimeErrorLogEntry[] = [];
  const ui: Record<string, unknown> = {};
  let release!: () => void; let started!: () => void; let releasePreflight!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
  let fail = false; let nextId = 0;
  const dependencies: Record<string, unknown> = {
    canUseFinalPromptConverter, resolveSequenceSegmentDuration, normalizeSemanticSequenceRequestedTotalDuration, upsertSequencePlan, storyDraftIdentity,
    storyboardRequestApiIdentity, buildVideoCreativeDirection, sourceContentHash,
    planningBusy: false, busy: false, sequenceBatchRunning: false, directorSettingsConfirmed: true,
    directorSettingsConfirmationIssue: '未确认导演参数', storyInput: story, directorScene: undefined,
    stateRef, workspaceEpochRef: epoch, sequencePlanningIdentityRef: identity, storyDraftRef: draft,
    sequencePlanningAbortRef: controller, sequencePlanningOperationRef: { current: 0 }, sequencePlanningRequestIdentityRef: { current: '' },
    semanticSequencePlanningActiveRef: { current: false }, activePlanId: oldPlan.id, sequencePlanningActivePlan: oldPlan,
    sequencePlanningMasterBoard: oldBoard, productionMode: 'sequence', segmentationMode: 'fixed',
    activePlanIdRef: { current: oldPlan.id }, activeStyle: { id: 'style', name: '合成风格', visual: '写实', camera: '', lighting: '', sound: '' },
    directorStyleId: 'director', directorStyleName: '合成导演', directorStyleSummary: '保持原事件', visualStyle: '写实',
    resolveVisualStylePrompt: (name: string) => name, cameraTerms: ['中景'], lightingTerms: ['晨光'], extraRequirement: '最终制作要求',
    storyName: '铜铃交接', planningSegmentDurationPreset: '15s', planningCustomSegmentDuration: 15,
    durationMode: timing.durationMode || 'ai-estimated', totalDuration: timing.totalDuration ?? 90,
    liveDirectorSettingsFingerprint: 'confirmed-director', storyPacing: { pace: 'standard' }, shotMode: 'auto', shotCount: 2,
    createId: () => `new-semantic-${++nextId}`, getSafeErrorDiagnostics: (message: string) => ({ message }),
    resolveSourceIntegrityForAction: async (value: string) => { if (holdPreflight) await preflight; return value; },
    persistPrimarySourceDocument: (value: string) => {
      persisted.push(value);
      const previous = state.project.sourceDocuments[0];
      if (previous?.name === '铜铃交接' && previous.content === value) return false;
      const next = { id: previous?.id || 'new-source', name: '铜铃交接', content: value, createdAt: 1, updatedAt: 2 };
      const replacement = replaceProjectSourceDocument(state.project, next);
      state = { ...state, project: replacement.project }; stateRef.current = state;
      return replacement.sourceChanged;
    },
    notify: (message: string) => notices.push(message),
    reportRuntimeError: (stage: string, error: unknown) => {
      const entry = createRuntimeErrorLogEntry({ stage, error, occurredAt: 10, context: { projectId: state.project.id } });
      if (entry) runtimeErrors.push(entry);
    },
    setState: (updater: (current: AppState) => AppState) => { state = updater(state); stateRef.current = state; },
    requestSemanticSequencePlan: async (config: TextApiConfig, input: SemanticSequencePlanningInput, signal?: AbortSignal, options: SemanticSequencePlannerOptions = {}) => {
      calls.push({ input, signal, options }); started(); await gate;
      if (fail) throw new Error('EXPECTED_CALLBACK_FAILURE');
      if (useProductionPlanner) return productionSemanticSequencePlanner(config, input, signal, options);
      const result = input.durationMode === 'fixed' ? responseWithCount(input.requestedTotalDurationSec! / input.segmentDurationSec) : response;
      return materializeSemanticSequencePlan(input, result, { planId: options.planId!, now: 10 });
    },
    setSequenceSettingsOpen: noop,
  };
  for (const name of ['setPlanningBusy', 'setSequenceMasterGenerationIssue', 'setActivePlanId', 'setActiveSegmentId', 'setActiveStoryboardId',
    'setDurationMode', 'setSegmentationMode', 'setTotalDuration', 'setTotalDurationTouched', 'setDurationEstimate', 'setEstimateConfirmed',
    'setConfirmedSequencePlanFingerprint', 'setAcceptedSequencePlanMismatchFingerprint', 'setAcknowledgedCompressedPlanFingerprint',
    'setProductionMode', 'setSequenceStage']) dependencies[name] = (value: unknown) => {
    ui[name] = value;
    // Reflect the busy state a React rerender would expose. A same-fixture
    // retry must rely on the actual callback clearing it, not a permanent false.
    if (name === 'setPlanningBusy') dependencies.planningBusy = value;
  };
  Object.defineProperty(dependencies, 'state', { get: () => state });
  const callbacks = new Function('d', `with(d){${compiled}; return {call:generateSemanticSequencePlan,cancel:cancelSemanticSequencePlanning};}`)(dependencies) as {
    call: () => Promise<void>; cancel: () => void;
  };
  return {
    ...callbacks, ready, release, releasePreflight, calls, notices, persisted, runtimeErrors, ui, dependencies,
    mutate: (action: (current: AppState) => void) => { state = structuredClone(state); action(state); stateRef.current = state; },
    setFail: () => { fail = true; },
    changeDraft: () => { draft.current = { storyName: '修改标题', storyInput: `${story}另一个用户修改。` }; },
    changeIdentity: () => { identity.current = 'changed-story-duration-director'; },
    changeTiming: (mode: SequenceDurationMode, totalDuration: number) => {
      dependencies.durationMode = mode; dependencies.totalDuration = totalDuration;
      identity.current = `changed-duration-${mode}-${totalDuration}`;
    },
    changeEpoch: () => { epoch.current += 1; },
    get state() { return state; },
  };
};
const begin = async (h: ReturnType<typeof fixture>) => {
  const pending = h.call(); let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([h.ready, pending.then(() => { throw new Error(`callback ended before model: ${h.notices.join('; ')}`); }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('callback model not reached')), 3000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  return { pending };
};
const mutations: Array<[string, (h: ReturnType<typeof fixture>) => void]> = [
  ['story/director/D selection identity', (h) => h.changeIdentity()],
  ['unsaved story draft', (h) => h.changeDraft()],
  ['API', (h) => h.mutate((state) => { state.settings.textApi.model = 'different-api-model'; })],
  ['character facts', (h) => h.mutate((state) => { state.project.characters = [{ ...createInitialState().project.characters[0], id: 'new-character', name: '新角色' }]; })],
  ['project', (h) => h.mutate((state) => { state.project.id = 'different-project'; })],
  ['workspace/undo epoch', (h) => h.changeEpoch()],
  ['cancellation', (h) => h.cancel()],
];
for (const [label, mutate] of mutations) {
  const h = fixture(); const { pending } = await begin(h); mutate(h); const expected = JSON.stringify(h.state);
  h.release(); await pending;
  assert.equal(JSON.stringify(h.state), expected, `${label}: delayed response ignoring cancellation must not commit`);
  assert.equal(h.calls.length, 1); assert.equal(h.ui.setActivePlanId, undefined);
  assert.deepEqual(h.runtimeErrors, [], `${label}: cancelled/stale responses must not create a user-facing failure log`);
}
{
  const h = fixture(); const before = structuredClone(h.state.project); const { pending } = await begin(h);
  h.setFail(); h.release(); await pending;
  assert.deepEqual(h.state.project, before); assert.equal(h.calls.length, 1);
  assert.match(String(h.ui.setSequenceMasterGenerationIssue), /EXPECTED_CALLBACK_FAILURE/u);
  assert.equal(h.runtimeErrors.length, 1); assert.equal(h.runtimeErrors[0].stage, 'sequence-semantic-planning');
  assert.match(h.runtimeErrors[0].message, /EXPECTED_CALLBACK_FAILURE/u);
}
{
  const h = fixture(); h.mutate((state) => { state.project.sourceDocuments[0].content = '更早的原文，仍有历史结果。'; });
  const before = structuredClone(h.state.project); const { pending } = await begin(h); h.setFail(); h.release(); await pending;
  assert.deepEqual(h.state.project, before, 'planning a changed story must not erase old plans/results/source before a successful response');
}
{
  const h = fixture(true); const pending = h.call(); h.changeIdentity(); h.releasePreflight(); await pending;
  assert.equal(h.calls.length, 0); assert.equal(h.persisted.length, 0, 'stale preflight does not persist a story or request a plan');
}
{
  const h = fixture(true); const pending = h.call(); h.cancel(); h.releasePreflight(); h.release(); await pending;
  assert.equal(h.calls.length, 0, 'cancelling while source integrity is pending must stop the later model request');
  assert.equal(h.persisted.length, 0);
}
{
  const h = fixture(); const before = structuredClone(h.state.project); const { pending } = await begin(h); h.release(); await pending;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].input.story, story); assert.equal(h.calls[0].input.segmentDurationSec, 15);
  assert.equal(h.calls[0].input.durationMode, 'ai-estimated');
  assert.equal(Object.hasOwn(h.calls[0].input, 'requestedTotalDurationSec'), false, 'AI mode must omit the prior total duration from its request');
  assert.equal(h.state.project.sequencePlans.length, 2); assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
  const plan = h.state.project.sequencePlans[0]; assert.equal(plan.planningMode, 'semantic-segments'); assert.equal(plan.masterStoryboardId, undefined);
  assert.equal(plan.reviewConfirmedFingerprint, undefined); assert.equal(h.ui.setActivePlanId, plan.id);
  assert.deepEqual(h.state.project.storyboards, before.storyboards); assert.deepEqual(h.state.project.generationTasks, before.generationTasks);
}
{
  const h = fixture(false, false, { durationMode: 'fixed', totalDuration: 100 });
  const before = structuredClone(h.state.project); const { pending } = await begin(h); h.release(); await pending;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].input.durationMode, 'fixed');
  assert.equal(h.calls[0].input.requestedTotalDurationSec, 105, 'production callback aligns a raw custom duration before requesting the planner');
  const plan = h.state.project.sequencePlans[0];
  assert.equal(plan.durationMode, 'fixed'); assert.equal(plan.requestedTotalDurationSec, 105);
  assert.equal(plan.totalDurationSec, 105); assert.equal(plan.segments.length, 7);
  assert.equal(plan.semanticPlanningSnapshot?.durationMode, 'fixed');
  assert.equal(plan.semanticPlanningSnapshot?.requestedTotalDurationSec, 105);
  assert.equal(h.ui.setDurationMode, 'fixed'); assert.equal(h.ui.setTotalDuration, 105);
  assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
  assert.deepEqual(h.state.project.storyboards, before.storyboards, 'successful custom-total planning retains the complete historical H3');
}
for (const [label, mutate] of [...mutations,
  ['custom total selection', (h: ReturnType<typeof fixture>) => h.changeTiming('fixed', 90)],
  ['custom to AI selection', (h: ReturnType<typeof fixture>) => h.changeTiming('ai-estimated', 30)],
] as Array<[string, (h: ReturnType<typeof fixture>) => void]>) {
  const h = fixture(false, false, { durationMode: 'fixed', totalDuration: 30 }); const { pending } = await begin(h);
  assert.equal(h.calls[0].input.requestedTotalDurationSec, 30); mutate(h); const expected = JSON.stringify(h.state);
  h.release(); await pending;
  assert.equal(JSON.stringify(h.state), expected, `fixed ${label}: late response must not commit over the changed selection`);
  assert.equal(h.calls.length, 1); assert.equal(h.ui.setActivePlanId, undefined); assert.deepEqual(h.runtimeErrors, []);
}
{
  const h = fixture(false, false, { durationMode: 'fixed', totalDuration: 30 }); const before = structuredClone(h.state.project);
  const { pending } = await begin(h); h.setFail(); h.release(); await pending;
  assert.deepEqual(h.state.project, before, 'failed custom-total planning preserves the old plan and final H3');
  assert.equal(h.runtimeErrors.length, 1);
}
{
  const h = fixture(false, false, { durationMode: 'fixed', totalDuration: 30 });
  const first = h.call(); const second = h.call(); await h.ready; await Promise.resolve(); await Promise.resolve();
  const count = h.calls.length; h.release(); await Promise.all([first, second]);
  assert.equal(count, 1, 'same-render custom-total double-click issues one semantic planning request');
  assert.equal(h.state.project.sequencePlans.length, 2); assert.equal(h.state.project.sequencePlans[0].durationMode, 'fixed');
}
{
  const h = fixture(); h.mutate((state) => { state.project.sourceDocuments[0].content = '更早的原文，仍有历史结果。'; });
  const before = structuredClone(h.state.project); const { pending } = await begin(h); h.release(); await pending;
  assert.equal(h.state.project.sequencePlans.length, 2, 'successful changed-story planning appends, never replaces the prior plan');
  assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
  assert.deepEqual(h.state.project.storyboards, before.storyboards, 'historical final H3 remains available after a different original is planned');
}
{
  const h = fixture(); const first = h.call(); const second = h.call(); await h.ready;
  // Give the second same-render preflight a microtask turn. React's disabled
  // rerender must not be the only safeguard against a duplicate billable call.
  await Promise.resolve(); await Promise.resolve();
  const count = h.calls.length; h.release(); await Promise.all([first, second]);
  assert.equal(count, 1, 'same-render double-click must issue exactly one semantic planning request');
  assert.equal(h.state.project.sequencePlans.length, 2);
}

// Exercise the real callback, semantic planner, JSON parser and HTTP adapter
// together. The only fetch implementation in these cases is this local mock.
const originalFetch = globalThis.fetch;
const wireCalls: Array<Record<string, any>> = [];
let wireReply: (index: number) => Response;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://qa-semantic.invalid/v1/chat/completions', 'mock must never fall through to a paid or external endpoint');
  assert.equal(init?.method, 'POST');
  wireCalls.push(JSON.parse(String(init?.body)));
  return wireReply(wireCalls.length - 1);
};
const wireResponse = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
try {
  {
    const h = fixture(false, true); const before = structuredClone(h.state.project); wireCalls.length = 0;
    wireReply = () => wireResponse(JSON.stringify(responseWithoutCount()));
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(wireCalls.length, 1, 'complete count-free JSON is accepted without an unnecessary repair request');
    assert.equal(h.state.project.sequencePlans.length, before.sequencePlans.length + 1);
    const plan = h.state.project.sequencePlans[0];
    assert.equal(plan.segments.length, 2); assert.equal(plan.totalDurationSec, 30);
    assert.ok(plan.segments.every((segment) => segment.durationSec === 15), 'every generated segment retains the selected full duration');
    assert.deepEqual(plan.segments.map((segment) => segment.content), responseWithoutCount().segments.map((segment) => segment.content));
    assert.equal(plan.masterStoryboardId, undefined, 'count-free plans never need a fabricated global H3');
    assert.equal(h.ui.setSequenceStage, 'plan', 'generation retains the existing plan-review step');
    assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
    assert.deepEqual(h.state.project.storyboards, before.storyboards, 'generation keeps all historical H3 unchanged');
    assert.equal(h.ui.setPlanningBusy, false); assert.deepEqual(h.runtimeErrors, []);
  }
  {
    const h = fixture(false, true); const before = structuredClone(h.state.project); wireCalls.length = 0;
    const mismatch = { ...response, segmentCount: 9 };
    wireReply = (index) => wireResponse(JSON.stringify(index === 0 ? mismatch : responseWithoutCount()));
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(h.calls.length, 1); assert.equal(wireCalls.length, 2, 'a contradictory legacy count is repaired once by AI, not dropped locally');
    const repair = JSON.parse(wireCalls[1].messages.find((message: any) => message.role === 'user').content.split('semantic_sequence_repair=')[1]);
    assert.equal(repair.previousResponse, JSON.stringify(mismatch)); assert.equal(repair.input.story, story);
    assert.ok(repair.technicalIssues.some((issue: string) => /AI 声明 9 段，实际返回 2 段/u.test(issue)));
    const plan = h.state.project.sequencePlans[0];
    assert.equal(plan.segments.length, 2); assert.equal(plan.totalDurationSec, 30);
    assert.deepEqual(plan.segments.map((segment) => segment.content), responseWithoutCount().segments.map((segment) => segment.content), 'the repaired AI content is saved without filling or deleting local segments');
    assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
    assert.deepEqual(h.state.project.storyboards, before.storyboards);
    assert.ok(h.notices.some((message) => /AI 正在修复分段数据（1\/3）/u.test(message)));
    assert.equal(h.ui.setPlanningBusy, false); assert.deepEqual(h.runtimeErrors, []);
  }
  {
    const h = fixture(false, true); const before = structuredClone(h.state.project); wireCalls.length = 0;
    const mismatch = { ...response, segmentCount: 9 };
    wireReply = () => wireResponse(JSON.stringify(mismatch));
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(h.calls.length, 1); assert.equal(wireCalls.length, 4, 'one initial request and exactly three repairs share the bounded attempt budget');
    assert.deepEqual(h.state.project, before, 'exhausting legacy-count repairs commits no new plan or source, and preserves historical H3');
    for (const attempt of [1, 2, 3]) assert.ok(h.notices.some((message) => message.includes(`AI 正在修复分段数据（${attempt}/3）`)));
    assert.match(String(h.ui.setSequenceMasterGenerationIssue), /自动重试 3 次（共 4 次请求）/u);
    assert.match(String(h.ui.setSequenceMasterGenerationIssue), /AI 声明 9 段，实际返回 2 段/u);
    assert.equal(h.runtimeErrors.length, 1);
    assert.match(h.runtimeErrors[0].message, /自动重试 3 次（共 4 次请求）/u);
    assert.match(h.runtimeErrors[0].message, /AI 声明 9 段，实际返回 2 段/u);
    assert.equal(h.ui.setPlanningBusy, false); assert.equal(h.dependencies.planningBusy, false);
    assert.equal((h.dependencies.sequencePlanningAbortRef as { current: unknown }).current, null);
    assert.equal((h.dependencies.sequencePlanningRequestIdentityRef as { current: unknown }).current, '');
    assert.equal((h.dependencies.semanticSequencePlanningActiveRef as { current: unknown }).current, false);
    assert.equal(h.ui.setActivePlanId, undefined, 'the failed request does not replace the selected historical plan');
    // Retry the same UI/closure, without resetting busy, refs or state in the
    // fixture. Only the model response changes to the successful wire format.
    wireReply = () => wireResponse(JSON.stringify(responseWithoutCount()));
    await h.call();
    assert.equal(h.calls.length, 2); assert.equal(wireCalls.length, 5, 'the next user click starts one fresh request after an exhausted operation');
    assert.equal(h.state.project.sequencePlans.length, before.sequencePlans.length + 1);
    assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
    assert.deepEqual(h.state.project.storyboards, before.storyboards);
    assert.equal(h.ui.setSequenceMasterGenerationIssue, ''); assert.equal(h.ui.setPlanningBusy, false);
    assert.equal(h.runtimeErrors.length, 1, 'a successful new attempt does not duplicate or erase the previous failure log');
    assert.equal(h.ui.setSequenceStage, 'plan', 'the recovered operation returns to the existing plan-review step');
  }
  {
    const h = fixture(false, true, { durationMode: 'fixed', totalDuration: 45 });
    const before = structuredClone(h.state.project); wireCalls.length = 0;
    wireReply = (index) => wireResponse(JSON.stringify(index === 0 ? response : responseWithCount(3)));
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(h.calls.length, 1, 'one custom-total App action owns all bounded structural repair');
    assert.equal(wireCalls.length, 2, 'wrong fixed segment count is repaired through the real planner');
    const firstInput = JSON.parse(wireCalls[0].messages.find((message: any) => message.role === 'user').content.split('semantic_sequence_input=')[1]);
    const repair = JSON.parse(wireCalls[1].messages.find((message: any) => message.role === 'user').content.split('semantic_sequence_repair=')[1]);
    assert.equal(firstInput.durationMode, 'fixed'); assert.equal(firstInput.requestedTotalDurationSec, 45);
    assert.equal(repair.input.durationMode, 'fixed'); assert.equal(repair.input.requestedTotalDurationSec, 45);
    assert.equal(repair.previousResponse, JSON.stringify(response));
    assert.ok(repair.technicalIssues.length, 'wrong segment count must be a real production structural issue');
    const plan = h.state.project.sequencePlans[0];
    assert.equal(plan.durationMode, 'fixed'); assert.equal(plan.totalDurationSec, 45); assert.equal(plan.segments.length, 3);
    assert.equal(plan.semanticPlanningSnapshot?.requestedTotalDurationSec, 45);
    assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
    assert.deepEqual(h.state.project.storyboards, before.storyboards, 'custom-count recovery preserves the exact old H3');
    assert.deepEqual(h.runtimeErrors, []);
  }
  {
    const h = fixture(false, true); h.mutate((state) => { state.settings.textApi.model = 'deepseek-semantic-mock'; });
    const before = structuredClone(h.state.project); const configBefore = structuredClone(h.state.settings.textApi);
    const partial = JSON.stringify(response).slice(0, -20); wireCalls.length = 0;
    wireReply = (index) => wireResponse(index === 0 ? partial : JSON.stringify(response));
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(h.calls.length, 1, 'one App action owns the entire bounded recovery');
    assert.equal(wireCalls.length, 2, 'unclosed JSON body must recover with one automatic model request');
    assert.ok(wireCalls.every((payload) => payload.response_format?.type === 'json_object' && payload.thinking?.type === 'disabled'));
    assert.ok(wireCalls[1].max_tokens > wireCalls[0].max_tokens, 'incomplete JSON recovery raises only the request-owned output allowance');
    const repair = JSON.parse(wireCalls[1].messages.find((message: any) => message.role === 'user').content.split('semantic_sequence_repair=')[1]);
    assert.equal(repair.previousResponse, partial); assert.equal(repair.input.story, story);
    assert.equal(h.state.project.sequencePlans.length, before.sequencePlans.length + 1);
    assert.deepEqual(h.state.project.sequencePlans[1], before.sequencePlans[0]);
    assert.deepEqual(h.state.project.storyboards, before.storyboards, 'recovery preserves the complete prior final H3');
    assert.deepEqual(h.state.settings.textApi, configBefore, 'recovery must not mutate the saved API configuration');
    assert.equal(h.state.project.sequencePlans[0].planningMode, 'semantic-segments');
    assert.equal(h.state.project.sequencePlans[0].masterStoryboardId, undefined);
    assert.ok(h.notices.some((message) => /AI 正在修复分段数据（1\/3）/u.test(message)));
    assert.deepEqual(h.runtimeErrors, [], 'successful automatic recovery is not a failed operation');
  }
  {
    const h = fixture(false, true); const before = structuredClone(h.state.project); wireCalls.length = 0;
    wireReply = () => new Response(JSON.stringify({ error: { message: 'QA_HTTP400_ACCOUNT_BLOCKED: billing unavailable' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
    const { pending } = await begin(h); h.release(); await pending;
    assert.equal(wireCalls.length, 1, 'ordinary provider 400 is not an output-recovery condition');
    assert.deepEqual(h.state.project, before, 'HTTP failure retains the old plan and final H3');
    assert.match(String(h.ui.setSequenceMasterGenerationIssue), /QA_HTTP400_ACCOUNT_BLOCKED/u);
    assert.equal(h.runtimeErrors.length, 1); assert.equal(h.runtimeErrors[0].stage, 'sequence-semantic-planning');
    assert.equal(h.runtimeErrors[0].status, 400); assert.match(h.runtimeErrors[0].message, /QA_HTTP400_ACCOUNT_BLOCKED: billing unavailable/u);
  }
} finally { globalThis.fetch = originalFetch; }
console.log('semanticSequenceApp: actual callbacks accept count-free plans for review, repair legacy count mismatches, exhaust three repairs safely and recover on the same UI retry, preserve old plans/H3, enforce fixed totals, block stale commits, and log provider failures (mock only).');
