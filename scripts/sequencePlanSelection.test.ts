import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { resolveSequenceSegmentDuration } from '../src/appEffects';
import {
  isSemanticSequencePlan, materializeSemanticSequencePlan,
  normalizeSemanticSequenceRequestedTotalDuration,
} from '../src/semanticSequencePlan';
import { sequencePlanReviewFingerprint, sequencePlanSourceChanged } from '../src/sequencePlan';
import {
  sequencePlanMasterConfirmationIssue,
  sequencePlanMasterDirectorSettingsIssue, sequencePlanMasterStoryboardIssue,
} from '../src/storySegmentation';
import { readSequencePlanDurationEstimate } from '../src/storyPacingEstimate';
import { createInitialState } from '../src/storage';
import { resolveVideoPromptNavigation } from '../src/videoPromptNavigation';
import type { Storyboard, VideoSequencePlan } from '../src/types';

// Run the real navigation callbacks and generation readiness expressions from
// App. All fixtures stay in memory; no model, user profile or desktop is used.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration>();
const collect = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(ast);
const compile = (names: string[]) => ts.transpileModule(names.map((name) => {
  const declaration = declarations.get(name);
  assert.ok(declaration, `production declaration ${name} exists`);
  return `const ${declaration.getText(ast)};`;
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const evaluate = (names: string[], bindings: Record<string, unknown>, result: string) => (
  new Function('d', `with(d){${compile(names)}; return ${result};}`)(bindings)
);
const noOp = () => {};
const title = '纯合成方案切换';
const story = '林舟推开门，沿着山道前行，抵达山巅。';
const planFixture = (id: string, durationSec: number, compressed = false): VideoSequencePlan => {
  const plan = materializeSemanticSequencePlan({
    title, story, durationMode: 'fixed', requestedTotalDurationSec: durationSec * 2,
    segmentDurationSec: durationSec, directorSettingsFingerprint: `fixture-director-${id}`,
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' }, characterContinuity: [],
  }, {
    segmentCount: 2, reason: '两个连续推进阶段', fitStatus: compressed ? 'compressed' : 'balanced',
    segments: [1, 2].map((index) => ({
      title: `${id}第${index}段`, content: `林舟正在完成连续行进的第${index}阶段。`, summary: '行进',
      narrativePurpose: '推进抵达', entryState: '沿山道行进', exitState: '继续向前', transitionHint: '保持动作连续',
      boundaryReason: '完整阶段', continuityPack: '同一山道',
      semanticSource: { sourceEvidence: [{ text: '林舟推开门', sourceStart: 0, sourceEnd: 5 }],
        events: [{ id: 'fixture-event', description: '行进至山巅', phase: `阶段${index}` }], dialogues: [] },
    })),
  }, { planId: id, now: 1 });
  plan.generationPromptFormat = id === 'plan-b' ? 'seedance' : 'h3';
  plan.segments[0].storyboardId = `board-${id}`;
  plan.segments[0].status = 'ready';
  plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
  if (compressed) plan.compressedRiskAcknowledgedFingerprint = plan.reviewConfirmedFingerprint;
  return plan;
};

const readinessDeclarations = [
  'sequencePlanInputFingerprint', 'sequencePlanSnapshotFingerprint', 'activeSequencePlan', 'activeSequenceSegment',
  'resolvedPlanningSegmentDuration', 'liveSequencePlanInputFingerprint', 'activeSequencePlanInputFingerprint',
  'activeSequencePlanMismatch', 'activeSequencePlanMismatchFingerprint', 'activeSequencePlanMismatchAccepted',
  'activeSequencePlanReviewFingerprint', 'activeSequencePlanNeedsReview', 'activeSequencePlanIsInsufficient',
  'activeSequencePlanCompressedAcknowledged', 'activeSequencePlanMasterIssue', 'activeSequenceMasterConfirmationIssue',
  'activeSequenceDirectorSettingsIssue', 'activeSequencePlanReadyForGeneration',
];
const fixture = () => {
  const plans = [planFixture('plan-a', 15, true), planFixture('plan-b', 10)];
  const state = createInitialState();
  state.project.sequencePlans = plans;
  state.project.storyboards = plans.map((plan): Storyboard => ({
    id: `board-${plan.id}`, sceneId: '', sourceStoryContent: story, sourceStoryTitle: title,
    workflow: 'drama', inputMode: 'text', durationSec: plan.segmentDurationSec, durationPreset: 'custom',
    shotMode: 'auto', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots: [], finalPrompt: `已生成稿-${plan.id}`,
    sequencePlanId: plan.id, segmentId: plan.segments[0].id, segmentIndex: 1, segmentCount: 2,
    createdAt: 1, updatedAt: 1,
  }));
  const ui: Record<string, unknown> = {
    activePlanId: plans[0].id, activeSegmentId: plans[0].segments[0].id,
    confirmedSequencePlanFingerprint: plans[0].reviewConfirmedFingerprint,
    acknowledgedCompressedPlanFingerprint: plans[0].compressedRiskAcknowledgedFingerprint,
    acceptedSequencePlanMismatchFingerprint: '', liveSequenceStory: story, liveSequenceStoryTitle: title,
    planningSegmentDurationPreset: '15s', planningCustomSegmentDuration: 15,
    durationMode: 'fixed', totalDuration: 30, segmentationMode: 'natural',
  };
  const writes: string[] = [];
  const setterNames = [
    'GenerationPromptFormatState', 'PlanningSegmentDurationPreset', 'PlanningCustomSegmentDuration',
    'DurationMode', 'TotalDuration', 'TotalDurationTouched', 'SegmentationMode', 'DurationEstimate', 'EstimateConfirmed',
    'ConfirmedSequencePlanFingerprint', 'AcceptedSequencePlanMismatchFingerprint', 'AcknowledgedCompressedPlanFingerprint',
    'ActivePlanId', 'ActiveSegmentId', 'ActiveStoryboardId', 'CustomDuration', 'DurationPreset', 'ProductionMode',
    'SequenceStage', 'SequenceSettingsOpen', 'PromptSourceRequest', 'View',
  ];
  const activePlanIdRef = { current: plans[0].id };
  const dependencies = {
    isSemanticSequencePlan, normalizeSemanticSequenceRequestedTotalDuration, sequencePlanReviewFingerprint,
    sequencePlanSourceChanged, resolveSequenceSegmentDuration, readSequencePlanDurationEstimate,
    sequencePlanMasterStoryboardIssue, sequencePlanMasterConfirmationIssue, sequencePlanMasterDirectorSettingsIssue,
    resolveVideoPromptNavigation, stateRef: { current: state }, activePlanIdRef, state,
    cancelSequenceGeneration: noOp, restoreSequenceDirectorSettings: noOp, selectChapter: noOp,
    notify: (message: string) => assert.fail(message), createId: () => 'fixture-request',
    ...Object.fromEntries(setterNames.map((name) => [`set${name}`, (value: unknown) => {
      ui[name[0].toLowerCase() + name.slice(1)] = value;
      writes.push(name);
    }])),
  };
  const callbacks = evaluate([
    'durationPresetForSeconds', 'setDirectorDurationForSegment', 'restoreSequencePlanState',
    'chooseSequenceSegment', 'openPromptSource',
  ], dependencies, '({choose: chooseSequenceSegment, open: openPromptSource})') as {
    choose: (segmentId: string, planId?: string) => void;
    open: (storyboardId: string) => void;
  };
  const readiness = () => evaluate(readinessDeclarations, {
    ...dependencies, ...ui, editorProject: state.project, useMemo: (calculate: () => unknown) => calculate(),
    sequencePlanningUsesSemanticDuration: true, liveDirectorSettingsFingerprint: 'fixture-live-settings',
  }, '({ready: activeSequencePlanReadyForGeneration, needsReview: activeSequencePlanNeedsReview, mismatch: activeSequencePlanMismatch, mismatchFingerprint: activeSequencePlanMismatchFingerprint, acknowledged: activeSequencePlanCompressedAcknowledged})') as {
    ready: boolean; needsReview: boolean; mismatch: boolean; mismatchFingerprint: string; acknowledged: boolean;
  };
  return { ...callbacks, plans, state, ui, writes, readiness };
};

// The completed and not-yet-generated segments must both recover access after
// switching A -> B -> A. Navigation must not rewrite saved plans or results.
for (const segmentIndex of [0, 1]) {
  const h = fixture();
  const frozen = JSON.stringify(h.state.project);
  assert.equal(h.readiness().ready, true);
  for (const plan of [h.plans[1], h.plans[0]]) {
    h.choose(plan.segments[segmentIndex].id, plan.id);
    assert.equal(h.readiness().ready, true, `${plan.id}: switching restores a confirmed semantic plan`);
    assert.equal(h.ui.confirmedSequencePlanFingerprint, plan.reviewConfirmedFingerprint);
    assert.equal(h.ui.acknowledgedCompressedPlanFingerprint, plan.compressedRiskAcknowledgedFingerprint || '');
    assert.equal(h.ui.activePlanId, plan.id);
    assert.equal(h.ui.activeSegmentId, plan.segments[segmentIndex].id);
    assert.equal(h.ui.activeStoryboardId, plan.segments[segmentIndex].storyboardId || '');
    assert.equal(h.ui.totalDuration, plan.requestedTotalDurationSec);
    assert.equal(h.ui.planningCustomSegmentDuration, plan.segmentDurationSec);
    assert.equal(h.ui.customDuration, plan.segments[segmentIndex].durationSec);
    assert.equal(h.ui.generationPromptFormatState, plan.generationPromptFormat);
  }
  assert.equal(h.readiness().acknowledged, true, 'compressed acknowledgement belongs to restored plan A');
  assert.equal(JSON.stringify(h.state.project), frozen, 'switching preserves all segment IDs, links and generated drafts');
}

for (const mode of ['unconfirmed', 'edited'] as const) {
  const h = fixture();
  const target = h.plans[1];
  if (mode === 'unconfirmed') delete target.reviewConfirmedFingerprint;
  else target.segments[0].content += '用户修改后的阶段';
  h.choose(target.segments[1].id, target.id);
  assert.equal(h.readiness().needsReview, true, `${mode}: navigation cannot manufacture a valid confirmation`);
  assert.equal(h.readiness().ready, false);
}

{
  const h = fixture();
  h.ui.liveSequenceStory = `${story}新增原文。`;
  const mismatch = h.readiness().mismatchFingerprint;
  h.ui.acceptedSequencePlanMismatchFingerprint = mismatch;
  assert.equal(h.readiness().ready, true, 'explicit acceptance is valid for this unchanged plan context');
  const beforeWrites = h.writes.length;
  h.choose(h.plans[0].segments[1].id);
  assert.equal(h.ui.acceptedSequencePlanMismatchFingerprint, mismatch);
  assert.equal(h.readiness().ready, true, 'same-plan segment navigation preserves transient acceptance');
  assert.equal(h.writes.slice(beforeWrites).includes('ConfirmedSequencePlanFingerprint'), false);
  h.choose(h.plans[1].segments[0].id, h.plans[1].id);
  assert.equal(h.ui.acceptedSequencePlanMismatchFingerprint, '');
  assert.equal(h.readiness().mismatch, true);
  assert.equal(h.readiness().ready, false, 'a saved confirmation cannot bypass a changed source');
  h.choose(h.plans[0].segments[0].id, h.plans[0].id);
  assert.equal(h.readiness().ready, false, 'cross-plan navigation cannot restore an obsolete transient source acceptance');
}

{
  const h = fixture();
  const frozen = JSON.stringify(h.state.project);
  for (const plan of [h.plans[1], h.plans[0]]) {
    h.open(plan.segments[0].storyboardId!);
    assert.equal(h.ui.activePlanId, plan.id);
    assert.equal(h.ui.activeSegmentId, plan.segments[0].id);
    assert.equal(h.ui.activeStoryboardId, plan.segments[0].storyboardId);
    assert.equal(h.ui.confirmedSequencePlanFingerprint, plan.reviewConfirmedFingerprint);
    assert.equal(h.ui.acknowledgedCompressedPlanFingerprint, plan.compressedRiskAcknowledgedFingerprint || '');
    assert.equal(h.ui.totalDuration, plan.requestedTotalDurationSec);
    assert.equal(h.readiness().ready, true, 'returning from a video to its source restores generation access');
  }
  assert.equal(JSON.stringify(h.state.project), frozen);
}

console.log('Plan selection App callbacks passed: confirmed A/B/A, completed/pending segments, compressed acknowledgement, timing, source navigation and stale/unconfirmed/source-mismatch guards (memory fixtures only).');
