import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  isSequencePlanningRequestStale,
  resolveSequenceSegmentDuration,
  resolveWorkspaceDirectorLook,
} from '../src/appEffects';
import { hasAiAuthoredMasterTimeline, resolveAiSequenceTotalDuration, sequencePlanMasterStoryboardIssue } from '../src/storySegmentation';
import { assertSequenceSegmentDurationContract, roundUpSequenceDurationToFullSegments } from '../src/sequenceDurationContract';
import { normalizeGridDirectorInputMode } from '../src/gridDirectorWorkflow';
import { activeDirectorWorkflow } from '../src/gridRetirement';
import { isSemanticSequencePlan } from '../src/semanticSequencePlan';
import {
  createSequenceDurationEstimateSnapshot,
  readSequencePlanDurationEstimate,
  sequenceEstimateSourceFingerprint,
} from '../src/storyPacingEstimate';
import type { SequenceDurationEstimateSnapshot, SourcedStoryDurationEstimate } from '../src/storyPacingEstimate';
import type { StoryDurationEstimate } from '../src/services/llm';
import type { StoryPacingContext } from '../src/storyPacing';
import type { VideoSequencePlan } from '../src/types';

let groups = 0;
const test = (name: string, run: () => void): void => {
  run(); groups += 1; console.log(`PASS ${name}`);
};
const story = '小师妹边格挡边说：“再练一次。”\n师兄转身接招；晨雾仍在场中。';
const pacing: StoryPacingContext = {
  pace: 'compact',
  directorCategory: '剧情',
  directorStyle: '自然写实',
  directorStyleSummary: '对白和动作自然并行，保留必要停顿。',
  extraRequirement: '环境融入动作，不为填满时间加空转。',
};
const estimate: StoryDurationEstimate = {
  minSec: 12.5, recommendedSec: 18, maxSec: 24,
  fitStatus: 'balanced', reason: '攻防和对白并行，保留转身后辨认对手的停顿。',
};
const fixture = (withSnapshot = true): VideoSequencePlan => ({
  id: 'pacing-plan-a', title: '练剑', sourceStoryTitle: '练剑', sourceStoryContent: story,
  durationMode: 'fixed', requestedTotalDurationSec: 30, totalDurationSec: 30,
  segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced',
  estimateReason: '历史计划自己的理由，不可被改写',
  ...(withSnapshot ? { durationEstimateSnapshot: createSequenceDurationEstimateSnapshot('练剑', story, pacing, estimate) } : {}),
  masterStoryboardId: 'master-kept', planningStage: 'segmented',
  masterPromptConfirmedFingerprint: 'confirmed-master-kept',
  masterPromptDirectorSettingsFingerprint: 'historical-director-kept',
  segments: [{
    id: 'segment-kept', index: 1, title: '已保存片段', globalStartSec: 0,
    globalEndSec: 30, durationSec: 30, content: story, summary: '已保存内容',
    sourceSceneIds: ['scene-kept'], sourceBeatIds: ['beat-kept'],
    narrativePurpose: '', entryState: '', exitState: '', transitionHint: '',
    storyboardId: 'board-kept', status: 'ready',
  }],
  reviewConfirmedFingerprint: 'review-kept', reviewConfirmedAt: 2,
  createdAt: 1, updatedAt: 2,
});
const fullSegmentEstimate: StoryDurationEstimate = { ...estimate, minSec: 15, recommendedSec: 30, maxSec: 45 };
const fullSegmentFixture = (): VideoSequencePlan => ({
  ...fixture(false),
  durationEstimateSnapshot: createSequenceDurationEstimateSnapshot('练剑', story, pacing, fullSegmentEstimate, 15),
});
const readMalformed = (snapshot: unknown) => readSequencePlanDurationEstimate({
  ...fixture(false), durationEstimateSnapshot: snapshot as SequenceDurationEstimateSnapshot,
});

test('完整故事与五项节奏上下文进入新的有版本指纹', () => {
  const baseline = sequenceEstimateSourceFingerprint('练剑', story, pacing);
  for (const [field, value] of [
    ['pace', 'slow'], ['directorCategory', '悬念'], ['directorStyle', '细腻叙事'],
    ['directorStyleSummary', '必要时停顿'], ['extraRequirement', '保留最后一次欲言又止'],
  ] as const) {
    assert.notEqual(sequenceEstimateSourceFingerprint('练剑', story, { ...pacing, [field]: value }), baseline, field);
  }
  assert.notEqual(sequenceEstimateSourceFingerprint('练剑·新标题', story, pacing), baseline);
  assert.notEqual(sequenceEstimateSourceFingerprint('练剑', `${story}\n随后退场。`, pacing), baseline);
  assert.notEqual(baseline, JSON.stringify(['练剑', story]), 'legacy text-only identity cannot match');
});

test('旧发话规则的估时不冒充新规则缓存，历史计划和提示词保持原样', () => {
  const plan = fullSegmentFixture();
  plan.durationEstimateSnapshot!.sourceFingerprint = JSON.stringify([
    'story-pacing-estimate-full-segments-v2', '练剑', story, pacing.pace,
    pacing.directorCategory, pacing.directorStyle, pacing.directorStyleSummary, pacing.extraRequirement, 15,
  ]);
  const before = JSON.stringify(plan);
  assert.equal(readSequencePlanDurationEstimate(plan), null);
  assert.equal(JSON.stringify(plan), before, 'cache invalidation never migrates confirmed source/shot boundaries');
  assert.notEqual(plan.durationEstimateSnapshot!.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, pacing, 15));
});

test('旧只能加时规则的v3估时失效但不修改任何已确认稿件', () => {
  const plan = fullSegmentFixture();
  const fingerprint = JSON.parse(plan.durationEstimateSnapshot!.sourceFingerprint) as unknown[];
  fingerprint[0] = 'story-pacing-speech-first-full-segments-v3';
  plan.durationEstimateSnapshot!.sourceFingerprint = JSON.stringify(fingerprint);
  const before = JSON.stringify(plan);
  assert.equal(readSequencePlanDurationEstimate(plan), null);
  assert.equal(JSON.stringify(plan), before);
});

test('正文和自定义要求末尾不会被截断；全对白和换行参与归属', () => {
  const longStory = `${'正文中间与完整对白。'.repeat(14000)}最后一句甲`;
  const longPacing = { ...pacing, extraRequirement: `${'用户要求。'.repeat(7000)}末尾甲` };
  const baseline = sequenceEstimateSourceFingerprint('长篇', longStory, longPacing);
  assert.notEqual(sequenceEstimateSourceFingerprint('长篇', longStory.replace(/甲$/u, '乙'), longPacing), baseline);
  assert.notEqual(sequenceEstimateSourceFingerprint('长篇', longStory, { ...longPacing, extraRequirement: `${longPacing.extraRequirement}乙` }), baseline);
  assert.notEqual(sequenceEstimateSourceFingerprint('练剑', story.replace('\n', '\r\n'), pacing), sequenceEstimateSourceFingerprint('练剑', story, pacing));
  assert.notEqual(sequenceEstimateSourceFingerprint('练剑', ` ${story} `, pacing), sequenceEstimateSourceFingerprint('练剑', story, pacing));
});

test('标题沿用空白规范化，节奏对象字段顺序不会误失效', () => {
  assert.equal(sequenceEstimateSourceFingerprint(' 练剑 ', story, pacing), sequenceEstimateSourceFingerprint('练剑', story, pacing));
  assert.equal(sequenceEstimateSourceFingerprint(' \n', story, pacing), sequenceEstimateSourceFingerprint('未命名剧情', story, pacing));
  const reordered = {
    extraRequirement: pacing.extraRequirement, directorStyleSummary: pacing.directorStyleSummary,
    directorStyle: pacing.directorStyle, directorCategory: pacing.directorCategory, pace: pacing.pace,
  };
  assert.equal(sequenceEstimateSourceFingerprint('练剑', story, reordered), sequenceEstimateSourceFingerprint('练剑', story, pacing));
});

test('镜头数、画幅、图片与接口等无关字段不污染估时创作指纹', () => {
  const additionalFields = { ...pacing, shotCount: 99, aspectRatio: '9:16', resolution: '4K', selectedAssetIds: ['another'], model: 'another-model' };
  assert.equal(sequenceEstimateSourceFingerprint('练剑', story, additionalFields), sequenceEstimateSourceFingerprint('练剑', story, pacing));
  assert.deepEqual(createSequenceDurationEstimateSnapshot('练剑', story, additionalFields, estimate).pacing, pacing);
});

test('缺省可选节奏字段可往返，但不能把新要求补给旧计划', () => {
  const minimal = { pace: 'standard' };
  const saved = createSequenceDurationEstimateSnapshot('练剑', story, minimal, estimate);
  const plan = { ...fixture(false), durationEstimateSnapshot: JSON.parse(JSON.stringify(saved)) };
  assert.equal(readSequencePlanDurationEstimate(plan)?.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, minimal));
  assert.notEqual(readSequencePlanDurationEstimate(plan)?.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, pacing));
  assert.equal(sequenceEstimateSourceFingerprint('练剑', story, { ...minimal, extraRequirement: undefined }), sequenceEstimateSourceFingerprint('练剑', story, minimal));
});

test('创建快照复制原请求：后续编辑不改变已保存的估时归属', () => {
  const requestPacing = { ...pacing };
  const requestEstimate = { ...estimate };
  const saved = createSequenceDurationEstimateSnapshot('练剑', story, requestPacing, requestEstimate);
  const frozen = JSON.stringify(saved);
  requestPacing.pace = 'slow'; requestPacing.extraRequirement = '改成缓慢长镜头';
  requestEstimate.recommendedSec = 21; requestEstimate.reason = '当前界面的新值';
  assert.equal(JSON.stringify(saved), frozen);
  assert.notStrictEqual(saved.pacing, requestPacing); assert.notStrictEqual(saved.estimate, requestEstimate);
});

test('新快照序列化后恢复真实AI估时而不是本地重新估算', () => {
  const plan = JSON.parse(JSON.stringify(fixture())) as VideoSequencePlan;
  assert.deepEqual(readSequencePlanDurationEstimate(plan), {
    ...estimate, sourceFingerprint: sequenceEstimateSourceFingerprint(plan.sourceStoryTitle, plan.sourceStoryContent, pacing),
  });
  assert.notEqual(readSequencePlanDurationEstimate(plan)?.recommendedSec, plan.totalDurationSec, 'historical planned total is not manufactured into an AI recommendation');
});

test('读取返回独立结果，展示层更改不修改保存快照', () => {
  const plan = fixture(); const before = JSON.stringify(plan);
  const result = readSequencePlanDurationEstimate(plan);
  assert.ok(result); result.reason = '临时显示'; result.recommendedSec = 22;
  assert.equal(JSON.stringify(plan), before);
  assert.equal(readSequencePlanDurationEstimate(plan)?.reason, estimate.reason);
});

test('旧计划无快照必须返回null，不凭正文、历史理由或当前导演设置补造', () => {
  for (const durationMode of ['ai-estimated', 'fixed'] as const) {
    const plan = { ...fixture(false), durationMode };
    const before = JSON.stringify(plan);
    assert.equal(readSequencePlanDurationEstimate(plan), null);
    assert.equal(JSON.stringify(plan), before);
  }
});

test('故事或标题换了而快照未换时，旧估时不得归属新输入', () => {
  const plan = fixture(); const snapshot = JSON.stringify(plan.durationEstimateSnapshot);
  assert.equal(readSequencePlanDurationEstimate({ ...plan, sourceStoryTitle: '另一份剧情' }), null);
  assert.equal(readSequencePlanDurationEstimate({ ...plan, sourceStoryContent: `${story}\n新的转折。` }), null);
  assert.equal(JSON.stringify(plan.durationEstimateSnapshot), snapshot);
});

test('保存的节奏被改动但指纹未更新时，不把旧估时重新贴为新节奏', () => {
  for (const field of ['pace', 'directorCategory', 'directorStyle', 'directorStyleSummary', 'extraRequirement'] as const) {
    const plan = fixture(); const saved = plan.durationEstimateSnapshot!;
    saved.pacing[field] = `修改${field}`;
    assert.equal(readSequencePlanDurationEstimate(plan), null, field);
  }
});

test('跨项目和A→B→A恢复按各自快照，不读当前界面的节奏', () => {
  const planA = fixture();
  const paceB = { ...pacing, pace: 'slow', extraRequirement: '保留悬念停顿' };
  const estimateB = { ...estimate, minSec: 20, recommendedSec: 30, maxSec: 45, reason: 'B独有估时' };
  const planB = { ...fixture(false), id: 'plan-b', durationEstimateSnapshot: createSequenceDurationEstimateSnapshot('练剑', story, paceB, estimateB) };
  const first = readSequencePlanDurationEstimate(planA);
  const second = readSequencePlanDurationEstimate(planB);
  const restored = readSequencePlanDurationEstimate(JSON.parse(JSON.stringify(planA)) as VideoSequencePlan);
  assert.deepEqual(first, restored); assert.notEqual(first?.sourceFingerprint, second?.sourceFingerprint);
  assert.equal(second?.reason, 'B独有估时'); assert.equal(restored?.reason, estimate.reason);
});

test('固定总秒数、分段、母版、确认状态与历史理由读取前后完全不变', () => {
  for (const plan of [fixture(), fixture(false), { ...fixture(), sourceStoryContent: '换了正文' }]) {
    const before = JSON.stringify(plan);
    readSequencePlanDurationEstimate(plan);
    createSequenceDurationEstimateSnapshot(plan.sourceStoryTitle, plan.sourceStoryContent, { ...pacing, pace: 'slow' }, estimate);
    assert.equal(JSON.stringify(plan), before);
    assert.equal(plan.requestedTotalDurationSec, 30); assert.equal(plan.totalDurationSec, 30);
    assert.equal(plan.segments[0].durationSec, 30); assert.equal(plan.masterStoryboardId, 'master-kept');
  }
});

test('未知版本、缺字段及损坏JSON结构仅使缓存失效，不抛错或修改计划', () => {
  const good = fixture().durationEstimateSnapshot!;
  for (const invalid of [
    undefined, null, [], 'snapshot', 1,
    { ...good, version: 0 }, { ...good, version: 2 }, { ...good, version: '1' },
    { ...good, sourceFingerprint: undefined }, { ...good, sourceFingerprint: '' },
    { ...good, sourceFingerprint: JSON.stringify(['练剑', story]) },
    { ...good, pacing: null }, { ...good, pacing: [] }, { ...good, pacing: { pace: 1 } },
    { ...good, pacing: { ...pacing, extraRequirement: null } },
    { ...good, pacing: { ...pacing, directorStyleSummary: ['wrong'] } },
    { ...good, estimate: null }, { ...good, estimate: [] }, { ...good, estimate: {} },
  ]) assert.equal(readMalformed(invalid), null);
});

test('时长仅做有限正数与有序范围检查，不加最低叙事时长或上限', () => {
  const good = fixture().durationEstimateSnapshot!;
  for (const patch of [
    { minSec: 0 }, { minSec: -1 }, { minSec: Number.NaN }, { minSec: Infinity },
    { recommendedSec: 0 }, { recommendedSec: '18' }, { recommendedSec: Infinity },
    { maxSec: null }, { maxSec: -Infinity }, { maxSec: Number.NaN },
    { minSec: 20, recommendedSec: 18 }, { maxSec: 17 },
    { fitStatus: 'unknown' }, { reason: undefined }, { reason: 42 },
  ]) assert.equal(readMalformed({ ...good, estimate: { ...estimate, ...patch } }), null, JSON.stringify(patch));
  for (const seconds of [0.01, 0.5, 1, 3600, 86400]) {
    const value = { ...estimate, minSec: seconds, recommendedSec: seconds, maxSec: seconds };
    assert.deepEqual(readMalformed(createSequenceDurationEstimateSnapshot('练剑', story, pacing, value)), {
      ...value, sourceFingerprint: sequenceEstimateSourceFingerprint('练剑', story, pacing),
    });
  }
});

test('任何模型理由和适配状态都不触发本地人物、关键词或镜数语义拦截', () => {
  for (const fitStatus of ['comfortable', 'balanced', 'compressed', 'insufficient'] as const) {
    for (const reason of ['', '   ', '修仙者仍是人类；背影和遮挡符合剧情。', '一镜到底，凝视、站立、慢推镜和余韵确有必要。', 'AI决定对白与动作并行；无需最低镜数。']) {
      const value = { ...estimate, fitStatus, reason };
      const saved = createSequenceDurationEstimateSnapshot('练剑', story, { ...pacing, pace: '用户自定义速度' }, value);
      assert.deepEqual(readMalformed(saved), { ...value, sourceFingerprint: saved.sourceFingerprint });
    }
  }
});

test('有效旧快照只保有自己来源，切换上下文不自动销毁或重写它', () => {
  const plan = fixture(); const before = JSON.stringify(plan);
  const saved = readSequencePlanDurationEstimate(plan)!;
  const currentPacing = { ...pacing, extraRequirement: '新导演要求' };
  assert.notEqual(saved.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, currentPacing));
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(readSequencePlanDurationEstimate(plan), saved);
});

test('创建阶段只拒绝损坏技术结构，不接受可变引用带入估时快照', () => {
  assert.throws(() => createSequenceDurationEstimateSnapshot('练剑', story, pacing, { ...estimate, recommendedSec: Infinity }), TypeError);
  assert.throws(() => createSequenceDurationEstimateSnapshot('练剑', story, { pace: null } as unknown as StoryPacingContext, estimate), TypeError);
  const metadata = { ...estimate, unrelated: { mutable: true } };
  const saved = createSequenceDurationEstimateSnapshot('练剑', story, pacing, metadata);
  metadata.unrelated.mutable = false;
  assert.deepEqual(saved.estimate, estimate);
});

// Execute the actual App declarations/callbacks with recording-only boundaries.
// This is deliberately not a second implementation of the cache or request
// policy. No project files, real API, browser, or desktop data are touched.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const parsedApp = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const appFunction = parsedApp.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
assert.ok(appFunction?.body);
const appStatements = appFunction.body.statements;
const declares = (node: ts.Statement, name: string): node is ts.VariableStatement => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name)
    ? item.name.text === name
    : ts.isArrayBindingPattern(item.name) && item.name.elements.some((element) => ts.isBindingElement(element) && element.name.getText(parsedApp) === name));
const declaration = (name: string, statements: ts.NodeArray<ts.Statement> = appStatements): ts.VariableStatement => {
  const result = statements.find((node) => declares(node, name));
  assert.ok(result, `missing production declaration ${name}`); return result as ts.VariableStatement;
};
const callback = (name: string): ts.ArrowFunction => {
  const value = declaration(name).declarationList.declarations[0].initializer;
  const result = value && ts.isCallExpression(value) ? value.arguments[0] : value;
  assert.ok(result && ts.isArrowFunction(result), `missing production callback ${name}`); return result;
};
const evaluate = (nodes: readonly ts.Node[], bindings: Record<string, unknown>, result: string): any => {
  const compiled = ts.transpileModule(nodes.map((node) => node.getText(parsedApp)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn ${result};`)(...Object.values(bindings));
};
const unexpectedMutation = () => assert.fail('cache invalidation must not write project data or chosen duration');
const cacheEffect = appStatements.find((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsedApp) === 'useEffect'
  && node.getText(parsedApp).includes('liveEstimateSourceFingerprint'));
assert.ok(cacheEffect);
const runAppCache = (patch: Record<string, unknown> = {}) => {
  const effects: Array<() => void> = []; const changes: Record<string, unknown> = {};
  const saved = readSequencePlanDurationEstimate(fullSegmentFixture());
  const bindings: Record<string, unknown> = {
    storyInput: story, storyName: '练剑', storyPacing: pacing,
    state: { project: { sourceDocuments: [{ content: story }] } }, directorScene: undefined,
    durationEstimate: saved, estimateConfirmed: true,
    sequenceEstimateSourceFingerprint,
    resolvedPlanningSegmentDuration: 15,
    useEffect: (run: () => void) => effects.push(run),
    setDurationEstimate: (value: unknown) => { changes.estimate = value; },
    setEstimateConfirmed: (value: unknown) => { changes.confirmed = value; },
    setTotalDuration: unexpectedMutation, setState: unexpectedMutation,
    setDurationMode: unexpectedMutation, ...patch,
  };
  const value = evaluate([
    declaration('liveSequenceStory'), declaration('liveSequenceStoryTitle'),
    declaration('liveEstimateSourceFingerprint'), declaration('currentDurationEstimate'),
    declaration('currentEstimateConfirmed'), cacheEffect,
  ], bindings, '({ currentDurationEstimate, currentEstimateConfirmed, liveEstimateSourceFingerprint })');
  return { value, changes, flush: () => effects.forEach((effect) => effect()) };
};

test('真实App节奏对象保留导演分类、名称、摘要和完整自定义要求', () => {
  const result = evaluate([declaration('storyPacing')], {
    pace: 'tight', paceLabels: { tight: '紧凑' },
    directorCategory: pacing.directorCategory, directorStyleName: pacing.directorStyle,
    directorStyleSummary: pacing.directorStyleSummary, extraRequirement: pacing.extraRequirement,
  }, 'storyPacing');
  assert.deepEqual(result, { ...pacing, pace: '紧凑' });
});

test('真实App派生值在effect之前就隐藏异源估时，并且只清UI缓存', () => {
  for (const patch of [
    { storyName: '新标题' }, { storyInput: `${story}新事件` },
    ...(['pace', 'directorCategory', 'directorStyle', 'directorStyleSummary', 'extraRequirement'] as const)
      .map((field) => ({ storyPacing: { ...pacing, [field]: `新${field}` } })),
  ]) {
    const result = runAppCache(patch);
    assert.equal(result.value.currentDurationEstimate, null);
    assert.equal(result.value.currentEstimateConfirmed, false);
    result.flush(); assert.deepEqual(result.changes, { estimate: null, confirmed: false });
  }
});

test('真实App同源估时和源文回退保持正确，不改固定秒数和历史计划', () => {
  for (const patch of [
    {}, { storyInput: '' }, { storyInput: '', state: { project: { sourceDocuments: [] } }, directorScene: { content: story } },
  ]) {
    const result = runAppCache(patch); result.flush();
    assert.deepEqual(result.value.currentDurationEstimate, readSequencePlanDurationEstimate(fullSegmentFixture()));
    assert.equal(result.value.currentEstimateConfirmed, true); assert.deepEqual(result.changes, {});
  }
  const cleared = runAppCache({ durationEstimate: null }); cleared.flush();
  assert.equal(cleared.value.currentEstimateConfirmed, false); assert.deepEqual(cleared.changes, {});
});

test('真实App初始化和跨项目恢复仅恢复合法快照，旧计划不伪造已确认估时', () => {
  const restore = callback('syncWorkspaceUiState'); assert.ok(ts.isBlock(restore.body));
  const restoreStatements = restore.body.statements;
  const restoreWrites = restoreStatements.filter((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && ['setDurationEstimate', 'setEstimateConfirmed', 'setTotalDuration'].includes(node.expression.expression.getText(parsedApp)));
  assert.equal(restoreWrites.length, 3);
  for (const plan of [fixture(), fixture(false), undefined]) {
    const original = JSON.stringify(plan);
    const initial = evaluate([declaration('durationEstimate'), declaration('estimateConfirmed')], {
      initialSequencePlan: plan, readSequencePlanDurationEstimate,
      useState: (value: any) => [typeof value === 'function' ? value() : value, () => {}],
    }, '({ durationEstimate, estimateConfirmed })');
    const expected = plan ? readSequencePlanDurationEstimate(plan) : null;
    assert.deepEqual(initial, { durationEstimate: expected, estimateConfirmed: Boolean(expected) });
    const writes: Record<string, unknown> = {};
    evaluate([declaration('loadedPlan', restoreStatements), declaration('loadedEstimate', restoreStatements), ...restoreWrites], {
      loadedState: { project: { sequencePlans: plan ? [plan] : [] } }, readSequencePlanDurationEstimate,
      setDurationEstimate: (value: unknown) => { writes.estimate = value; },
      setEstimateConfirmed: (value: unknown) => { writes.confirmed = value; },
      setTotalDuration: (value: unknown) => { writes.total = value; },
    }, 'undefined');
    assert.deepEqual(writes, { estimate: expected, confirmed: Boolean(expected), total: plan?.requestedTotalDurationSec || plan?.totalDurationSec || 30 });
    assert.equal(JSON.stringify(plan), original);
  }
});

test('真实AppContext向UI暴露的是当前匹配估时而不是旧缓存', () => {
  let context: ts.Expression | undefined = declaration('appContext').declarationList.declarations[0].initializer;
  while (context && (ts.isAsExpression(context) || ts.isSatisfiesExpression(context) || ts.isParenthesizedExpression(context))) context = context.expression;
  assert.ok(context && ts.isObjectLiteralExpression(context));
  for (const [property, expected] of [['durationEstimate', 'currentDurationEstimate'], ['estimateConfirmed', 'currentEstimateConfirmed']]) {
    const item: ts.ObjectLiteralElementLike | undefined = context.properties.find((node) => ts.isPropertyAssignment(node) && node.name.getText(parsedApp) === property);
    assert.ok(item && ts.isPropertyAssignment(item)); assert.equal(item.initializer.getText(parsedApp), expected);
  }
});

const runEdit = (plan: VideoSequencePlan, cached: SourcedStoryDurationEstimate | null) => {
  const local = { ...estimate, minSec: 55, recommendedSec: 60, maxSec: 70, reason: '仅旧计划无估时时的本地后备' };
  let effective: unknown; let resultingEstimate: unknown = cached; let localCalls = 0;
  const writes: Record<string, unknown> = {};
  const edit = evaluate([declaration('editSequenceSegment')], {
    durationEstimate: cached, readSequencePlanDurationEstimate,
    mutateActiveSequencePlan: (update: (value: VideoSequencePlan) => VideoSequencePlan) => update(plan),
    updateSequenceSegment: (value: VideoSequencePlan) => ({ ...value, totalDurationSec: 45 }),
    estimateStoryDurationLocally: () => { localCalls += 1; return local; },
    resolveSequenceFitStatus: (_total: number, value: unknown) => { effective = value; assert.ok(value, 'null is not a duration estimate'); return 'balanced'; },
    extractSemanticStoryBeats: () => ['beat'], sequencePlanMasterConfirmationIssue: () => 'legacy-master',
    stateRef: { current: { project: { storyboards: [] } } },
    setTotalDuration: (value: unknown) => { writes.total = value; },
    setTotalDurationTouched: (value: unknown) => { writes.touched = value; },
    setEstimateConfirmed: (value: unknown) => { writes.confirmed = value; },
    setDurationEstimate: (update: (value: SourcedStoryDurationEstimate | null) => unknown) => { resultingEstimate = update(cached); },
  }, 'editSequenceSegment');
  edit('segment-kept', { durationSec: 45 });
  return { effective, resultingEstimate, localCalls, local, writes };
};

test('真实旧计划时长编辑不会让undefined===undefined选中空估时', () => {
  const result = runEdit(fixture(false), null);
  assert.deepEqual(result.effective, result.local); assert.equal(result.localCalls, 1);
  assert.equal(result.resultingEstimate, null, 'manual editing does not manufacture an AI cache');
  assert.deepEqual(result.writes, { total: 45, touched: true, confirmed: false });
});

test('真实历史计划编辑使用自己的已保存AI估时，不能回退本地或套当前异源估时', () => {
  const plan = fixture(); const expected = readSequencePlanDurationEstimate(plan);
  for (const current of [null, { ...estimate, sourceFingerprint: 'foreign-cache', reason: '别的剧情/节奏' }]) {
    const result = runEdit(plan, current);
    assert.deepEqual(result.effective, expected); assert.deepEqual(result.resultingEstimate, expected);
    assert.equal(result.localCalls, 0);
  }
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const asyncTest = async (name: string, run: () => Promise<void>) => { await run(); groups += 1; console.log(`PASS ${name}`); };
const generationHarness = (options: {
  durationMode?: 'ai-estimated' | 'fixed'; cached?: SourcedStoryDurationEstimate | null;
  confirmed?: boolean; configured?: boolean; integrity?: Promise<string | undefined>;
  response?: Promise<StoryDurationEstimate>;
  boardError?: Error;
  plannedEstimate?: StoryDurationEstimate;
  totalDuration?: number;
  beforeBoardReturn?: () => void;
  /**
   * React commits a duration edit and runs the planning-identity effect on a
   * later render.  This option models that boundary so a regression test can
   * prove that an AI estimate's automatic duration update does not cancel the
   * master-prompt request while it is still awaiting the storyboard API.
   */
  simulateDurationIdentityEffect?: boolean;
} = {}) => {
  const calls = {
    persist: [] as string[], ai: [] as any[], boards: [] as any[],
    estimates: [] as unknown[], totals: [] as number[], notices: [] as any[],
    busy: [] as unknown[], generationIssues: [] as string[],
    durationIdentityChanges: 0, durationIdentityAborts: 0,
  };
  const state: any = { project: { id: 'project-a', sequencePlans: [], storyboards: [], scenes: [], characters: [], sourceDocuments: [{ content: story }], directorSettingsConfirmedFingerprint: 'director-original' }, settings: { textApi: { enabled: options.configured !== false, baseUrl: 'https://pacing.invalid', model: 'mock-model' } } };
  const stateRef = { current: state }; const identity = { current: 'request-original' }; const epoch = { current: 1 };
  const abort = { current: null as AbortController | null }; const operation = { current: 0 };
  const requestedIdentity = { current: '' }; const activePlan = { current: '' };
  const bindings: Record<string, unknown> = {
    state, stateRef, storyInput: story, storyName: '练剑', directorScene: undefined,
    directorSettingsConfirmed: true, directorSettingsConfirmationIssue: '', liveDirectorSettingsFingerprint: 'director-original',
    setSequenceSettingsOpen: () => {},
    resolveSourceIntegrityForAction: () => options.integrity || Promise.resolve(story),
    persistPrimarySourceDocument: (text: string) => { calls.persist.push(text); },
    extractSemanticStoryBeats: () => Array.from({ length: 5 }, (_, index) => ({ id: `beat-${index}` })),
    sequencePlanMasterDirectorSettingsIssue: () => '', sequenceMasterStoryboardSnapshot: () => '',
    sequencePlanningAbortRef: abort, sequencePlanningOperationRef: operation,
    sequencePlanningRequestIdentityRef: requestedIdentity, sequencePlanningIdentityRef: identity,
    sequencePlanningIdentity: identity.current,
    workspaceEpochRef: epoch, activePlanIdRef: activePlan,
    storyDraftRef: { current: { storyInput: story, storyName: '练剑' } },
    isSequencePlanningRequestStale, sequenceEstimateSourceFingerprint,
    createSequenceDurationEstimateSnapshot, readSequencePlanDurationEstimate,
    storyPacing: { ...pacing }, durationEstimate: options.cached || null, estimateConfirmed: Boolean(options.confirmed),
    estimateStoryDurationLocally: () => ({ ...estimate, reason: 'LOCAL SHOULD NOT REPLACE AI' }),
    durationMode: options.durationMode || 'ai-estimated',
    requestStoryDurationEstimate: (_config: unknown, input: unknown, signal: AbortSignal, reviewOptions: unknown) => { calls.ai.push({ input, signal, reviewOptions }); return options.response || Promise.resolve({ ...fullSegmentEstimate }); },
    resolveAiSequenceTotalDuration, resolveSequenceSegmentDuration, hasAiAuthoredMasterTimeline, roundUpSequenceDurationToFullSegments,
    resolvedPlanningSegmentDuration: 15, planningSegmentDurationPreset: '15s', planningCustomSegmentDuration: 15,
    totalDuration: options.totalDuration ?? 45, segmentationMode: 'natural', shotMode: 'auto', shotCount: 9,
    setPlanningBusy: (value: unknown) => { calls.busy.push(value); },
    setDurationEstimate: (value: unknown) => { calls.estimates.push(value); },
    setTotalDuration: (value: number) => {
      calls.totals.push(value);
      if (!options.simulateDurationIdentityEffect) return;
      // The real useEffect observes sequencePlanningIdentity after React has
      // committed this setter.  Schedule the same check instead of mutating
      // the identity synchronously; otherwise even the fixed implementation
      // would be made stale before its finally block can release the request.
      const requestAtCommit = abort.current;
      const requestedAtCommit = requestedIdentity.current;
      if (!requestAtCommit || requestAtCommit.signal.aborted) return;
      Promise.resolve().then(() => {
        if (
          abort.current !== requestAtCommit
          || requestAtCommit.signal.aborted
          || requestedIdentity.current !== requestedAtCommit
        ) return;
        calls.durationIdentityChanges += 1;
        identity.current = `${identity.current}:total=${value}`;
        operation.current += 1;
        requestAtCommit.abort();
        calls.durationIdentityAborts += 1;
        abort.current = null;
        requestedIdentity.current = '';
      });
    },
    setTotalDurationTouched: () => {}, setEstimateConfirmed: () => {},
    setSequenceMasterGenerationIssue: (message: string) => { calls.generationIssues.push(message); },
    setActivePlanId: () => {}, setActiveSegmentId: () => {}, setActiveStoryboardId: () => {},
    setConfirmedSequencePlanFingerprint: () => {}, setAcceptedSequencePlanMismatchFingerprint: () => {},
    setAcknowledgedCompressedPlanFingerprint: () => {}, setProductionMode: () => {}, setSequenceStage: () => {},
    notify: (...args: unknown[]) => { calls.notices.push(args); },
    createId: () => 'created-sequence', sourceContentHash: (text: string) => `test-hash:${text}`,
    resolveSequenceFitStatus: () => 'balanced', buildWholeStoryScene: () => undefined,
    inferDirectorWorkflow: () => ({ workflow: 'drama' }), directorWorkflow: 'drama', extraRequirement: pacing.extraRequirement,
    buildStoryboard: async (input: any) => {
      calls.boards.push(input);
      // Yield once so a queued duration-identity effect runs at the same
      // point as it does between React renders in the real request.
      await Promise.resolve();
      if (options.plannedEstimate) input.onDurationPlanned?.({ ...options.plannedEstimate });
      if (options.boardError) throw options.boardError;
      options.beforeBoardReturn?.();
      return { id: 'created-master', finalPrompt: 'mock full prompt', shots: [],
        durationSec: options.plannedEstimate?.recommendedSec ?? input.durationSec };
    },
    parseMasterTimelinePrompt: () => [], validateSequencePlan: () => [],
    upsertSequencePlan: (plans: VideoSequencePlan[], plan: VideoSequencePlan) => [plan, ...plans],
    setState: (update: (value: unknown) => unknown) => { stateRef.current = update(stateRef.current); },
  };
  const start = evaluate([declaration('generateSequenceMasterPrompt')], bindings, 'generateSequenceMasterPrompt') as () => Promise<void>;
  return { start, calls, stateRef, identity, epoch, abort, bindings };
};

await asyncTest('发话优先规划：同次全片生成采用模型扩时、完整估时快照和UI总秒数，不追加估时API', async () => {
  const plannedEstimate: StoryDurationEstimate = { minSec: 45, recommendedSec: 60, maxSec: 75,
    fitStatus: 'balanced', reason: 'AI为完整长句、亲吻结束后发话和换人交接增加完整15秒段。' };
  const qa = generationHarness({ plannedEstimate, simulateDurationIdentityEffect: true });
  await qa.start(); await Promise.resolve();
  assert.equal(qa.calls.ai.length, 1, 'existing initial estimate only; expansion is returned in original master generation');
  assert.equal(qa.calls.boards.length, 1);
  assert.equal(qa.calls.boards[0].durationSec, 30);
  assert.equal(qa.calls.boards[0].requiredSegmentDurationSec, 15);
  assert.equal(qa.calls.boards[0].durationAdjustmentPolicy, 'ai-estimated');
  assert.equal(qa.calls.boards[0].allowDurationExpansion, undefined);
  const plan = qa.stateRef.current.project.sequencePlans[0] as VideoSequencePlan;
  assert.equal(plan.totalDurationSec, 60); assert.equal(plan.requestedTotalDurationSec, 60);
  assert.equal(qa.stateRef.current.project.storyboards[0].durationSec, 60);
  assert.equal(plan.estimateReason, plannedEstimate.reason);
  assert.deepEqual(plan.durationEstimateSnapshot?.estimate, plannedEstimate, 'no min/max or review status fabricated locally');
  assert.deepEqual(qa.calls.totals, [60]); assert.equal(qa.calls.durationIdentityAborts, 0);
  assert.deepEqual((qa.calls.estimates.at(-1) as SourcedStoryDurationEstimate).recommendedSec, 60);
});

await asyncTest('发话优先规划：扩时后的H3失败不提交新估时或覆盖已保存总稿', async () => {
  const cached = readSequencePlanDurationEstimate(fullSegmentFixture())!;
  const qa = generationHarness({ cached, confirmed: true,
    plannedEstimate: { ...fullSegmentEstimate, recommendedSec: 60, maxSec: 75, reason: 'not yet committed' },
    boardError: new Error('expanded H3 conversion failed'),
  });
  qa.stateRef.current.project.storyboards = [{ id: 'saved-master', finalPrompt: 'OLD_PRESERVED', durationSec: 45 }];
  const before = JSON.stringify(qa.stateRef.current.project);
  await qa.start();
  assert.equal(JSON.stringify(qa.stateRef.current.project), before);
  assert.deepEqual(qa.calls.totals, []); assert.deepEqual(qa.calls.estimates, []);
  assert.match(qa.calls.generationIssues.at(-1) || '', /expanded H3 conversion failed/u);
});

const wideEstimate: StoryDurationEstimate = {
  minSec: 225, recommendedSec: 240, maxSec: 255, fitStatus: 'balanced', reason: '初始AI估时',
};
const replannedEstimate: StoryDurationEstimate = {
  minSec: 165, recommendedSec: 180, maxSec: 195, fitStatus: 'balanced',
  reason: '完整保留原文事件与对白，合并重复静默收尾，按真实叙事重新分配12个完整窗口。',
};
const wideCached = (): SourcedStoryDurationEstimate => ({
  ...wideEstimate, sourceFingerprint: sequenceEstimateSourceFingerprint('练剑', story, pacing, 15),
});

await asyncTest('AI总稿240→180整段缩时同次提交，原预算与最新AI估时分别保存且不自取消', async () => {
  const qa = generationHarness({ cached: wideCached(), confirmed: true,
    totalDuration: 240, plannedEstimate: replannedEstimate, simulateDurationIdentityEffect: true });
  await qa.start(); await Promise.resolve();
  assert.equal(qa.calls.ai.length, 0, 'new master owns the reestimate; no extra duration/audit request');
  assert.equal(qa.calls.boards.length, 1);
  assert.equal(qa.calls.boards[0].durationAdjustmentPolicy, 'ai-estimated');
  assert.equal(qa.calls.boards[0].durationSec, 240);
  const plan = qa.stateRef.current.project.sequencePlans[0] as VideoSequencePlan;
  assert.equal(plan.masterPlanningInitialDurationSec, 240);
  assert.equal(plan.totalDurationSec, 180);
  assert.equal(plan.requestedTotalDurationSec, 180, 'existing effective-budget fingerprint stays compatible');
  assert.equal(qa.stateRef.current.project.storyboards[0].durationSec, 180);
  assert.deepEqual(plan.durationEstimateSnapshot?.estimate, replannedEstimate);
  assert.deepEqual(qa.calls.totals, [180]);
  assert.equal(qa.calls.durationIdentityAborts, 0);
  assert.ok(qa.calls.notices.some(([text]) => /240秒重新安排为180秒/u.test(String(text))));
});

await asyncTest('固定总时长不获AI增减权限，原始预算保持用户选择', async () => {
  const qa = generationHarness({ durationMode: 'fixed', cached: wideCached(), confirmed: true, totalDuration: 240 });
  await qa.start();
  assert.equal(qa.calls.ai.length, 0);
  assert.equal(qa.calls.boards[0].durationAdjustmentPolicy, 'fixed');
  assert.equal(qa.calls.boards[0].allowDurationExpansion, undefined);
  assert.equal(qa.stateRef.current.project.sequencePlans[0].masterPlanningInitialDurationSec, 240);
  assert.equal(qa.stateRef.current.project.sequencePlans[0].totalDurationSec, 240);
});

await asyncTest('缩时后的H3失败及迟到回包均不修改项目或提交候选短预算', async () => {
  for (const fail of [true, false]) {
    let invalidate = () => {};
    const qa = generationHarness({ cached: wideCached(), confirmed: true,
      totalDuration: 240, plannedEstimate: replannedEstimate,
      ...(fail ? { boardError: new Error('shorter H3 conversion failed') } : { beforeBoardReturn: () => invalidate() }),
    });
    qa.stateRef.current.project.storyboards = [{ id: 'old-master', finalPrompt: 'OLD_PROMPT', durationSec: 240 }];
    const before = JSON.stringify(qa.stateRef.current.project);
    invalidate = () => { qa.identity.current = 'another-request'; };
    await qa.start();
    assert.equal(JSON.stringify(qa.stateRef.current.project), before);
    assert.deepEqual(qa.calls.totals, []);
    assert.deepEqual(qa.calls.estimates, []);
  }
});

await asyncTest('旧总稿重新规划另存新计划，原分段/提示词/任务/素材及关联身份原样保留', async () => {
  const qa = generationHarness({ cached: wideCached(), confirmed: true, totalDuration: 240, plannedEstimate: replannedEstimate });
  const oldPlan = fullSegmentFixture();
  const oldMaster = { id: oldPlan.masterStoryboardId, sequencePlanId: oldPlan.id, finalPrompt: 'OLD_MASTER', durationSec: 240 };
  const oldSegment = { id: 'board-kept', sequencePlanId: oldPlan.id, segmentId: 'segment-kept', finalPrompt: 'OLD_SEGMENT', durationSec: 15 };
  const oldTask = { id: 'old-task', storyboardId: 'board-kept', resultAssetId: 'old-video' };
  const oldVideo = { id: 'old-video', name: '已生成视频', relativePath: 'video/old.mov' };
  qa.stateRef.current.project.sequencePlans = [oldPlan];
  qa.stateRef.current.project.storyboards = [oldMaster, oldSegment];
  qa.stateRef.current.project.generationTasks = [oldTask];
  qa.stateRef.current.project.assets = [oldVideo];
  (qa.bindings.activePlanIdRef as { current: string }).current = oldPlan.id;
  const originals = JSON.stringify({ oldPlan, oldMaster, oldSegment, oldTask, oldVideo });
  await qa.start();
  const project = qa.stateRef.current.project;
  assert.equal(project.sequencePlans.length, 2);
  assert.notEqual(project.sequencePlans[0].id, oldPlan.id);
  assert.strictEqual(project.sequencePlans[1], oldPlan);
  assert.ok(project.storyboards.includes(oldMaster));
  assert.ok(project.storyboards.includes(oldSegment));
  assert.deepEqual(project.generationTasks, [oldTask]);
  assert.deepEqual(project.assets, [oldVideo]);
  assert.equal(JSON.stringify({ oldPlan, oldMaster, oldSegment, oldTask, oldVideo }), originals);
  assert.ok(qa.calls.notices.some(([text]) => /旧总稿、分段和成片保留/u.test(String(text))));
});

await asyncTest('发话优先规划：扩时回包迟到时不写新项目、不更新总时长或估时', async () => {
  const cached = readSequencePlanDurationEstimate(fullSegmentFixture())!;
  let invalidate = () => {};
  const qa = generationHarness({ cached, confirmed: true,
    plannedEstimate: { ...fullSegmentEstimate, recommendedSec: 60, maxSec: 75 },
    beforeBoardReturn: () => invalidate(),
  });
  invalidate = () => { qa.identity.current = 'newer-planning-request'; };
  await qa.start();
  assert.equal(qa.stateRef.current.project.sequencePlans.length, 0);
  assert.equal(qa.stateRef.current.project.storyboards.length, 0);
  assert.deepEqual(qa.calls.totals, []); assert.deepEqual(qa.calls.estimates, []);
});

await asyncTest('真实估时请求传完整全文与冻结节奏，并在同一次点击继续生成总提示词', async () => {
  const response = deferred<StoryDurationEstimate>(); const qa = generationHarness({ response: response.promise });
  const running = qa.start(); await Promise.resolve();
  assert.equal(qa.calls.ai.length, 1);
  assert.equal(qa.calls.ai[0].input.story, story); assert.deepEqual(qa.calls.ai[0].input.pacing, pacing);
  (qa.bindings.storyPacing as StoryPacingContext).pace = 'modified-after-request';
  assert.equal(qa.calls.ai[0].input.pacing.pace, pacing.pace, 'request context is copied at request start');
  assert.equal(qa.calls.ai[0].input.segmentDurationSec, 15);
  assert.equal(typeof qa.calls.ai[0].reviewOptions.isCurrent, 'function');
  response.resolve({ ...fullSegmentEstimate }); await running;
  assert.ok(qa.calls.estimates.length >= 1, 'the reviewed AI estimate must be retained');
  assert.deepEqual(qa.calls.totals, [30], 'display the reviewed AI multiple without rewriting it locally');
  assert.equal(qa.calls.boards.length, 1, 'the first click must continue from estimation to master-prompt generation');
  assert.equal(qa.calls.boards[0].durationSec, 30);
  assert.equal(qa.stateRef.current.project.sequencePlans.length, 1);
  assert.equal((qa.calls.estimates.at(-1) as SourcedStoryDurationEstimate).sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, pacing, 15));
});

await asyncTest('AI自动更新总时长不会触发规划身份变化而取消同一次总提示词请求', async () => {
  const response = deferred<StoryDurationEstimate>();
  const qa = generationHarness({ response: response.promise, simulateDurationIdentityEffect: true });
  const running = qa.start(); await Promise.resolve();
  assert.equal(qa.calls.ai.length, 1);
  response.resolve({ ...fullSegmentEstimate });
  await running;
  // The simulated identity effect is queued after setTotalDuration.  A fixed
  // implementation releases its request in finally before that effect runs;
  // the old implementation queued the setter before buildStoryboard awaited
  // and was therefore aborted here.
  await Promise.resolve();
  assert.equal(qa.calls.durationIdentityAborts, 0, 'automatic AI duration must not abort the active master request');
  assert.equal(qa.calls.boards.length, 1);
  assert.equal(qa.stateRef.current.project.sequencePlans.length, 1, 'master prompt must be committed on the same click');
});

await asyncTest('总提示词/H3失败后保留AI估时并可直接重试，不要求手动回估时区', async () => {
  const failed = generationHarness({ boardError: new Error('H3格式转换失败：mock') });
  await failed.start();
  assert.equal(failed.calls.ai.length, 1);
  assert.equal(failed.calls.boards.length, 1);
  assert.match(failed.calls.generationIssues.at(-1) || '', /H3格式转换失败/u);
  const retained = failed.calls.estimates.at(-1) as SourcedStoryDurationEstimate;
  assert.equal(retained.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, pacing, 15));
  assert.equal(failed.calls.totals.at(-1), 30, 'the successful estimate is restored after the failed master request');
  assert.deepEqual(failed.stateRef.current.project.sequencePlans, []);

  // A second click receives the retained, source-matched estimate and goes
  // straight to the master prompt; no duplicate estimation call is needed.
  const retry = generationHarness({ cached: retained, confirmed: true });
  await retry.start();
  assert.equal(retry.calls.ai.length, 0);
  assert.equal(retry.calls.boards.length, 1);
  assert.equal(retry.stateRef.current.project.sequencePlans.length, 1);
});

await asyncTest('真实估时失败或未配置API保留原秒数，不将本地后备当AI结果', async () => {
  const failed = deferred<StoryDurationEstimate>(); const qa = generationHarness({ response: failed.promise });
  const running = qa.start(); await Promise.resolve(); failed.reject(new Error('mock AI unavailable')); await running;
  assert.deepEqual(qa.calls.totals, []); assert.deepEqual(qa.calls.estimates, []); assert.deepEqual(qa.calls.boards, []);
  assert.match(qa.calls.notices.at(-1)?.[0] || '', /mock AI unavailable/u);
  const missing = generationHarness({ configured: false }); await missing.start();
  assert.deepEqual(missing.calls.ai, []); assert.deepEqual(missing.calls.totals, []); assert.deepEqual(missing.calls.estimates, []);
  assert.match(missing.calls.notices.at(-1)?.[0] || '', /不使用本地估算替代/u);
});

await asyncTest('真实估时发出后改要求或切项目，迟到返回不能写时长和估时', async () => {
  for (const change of ['pacing', 'project'] as const) {
    const response = deferred<StoryDurationEstimate>(); const qa = generationHarness({ response: response.promise });
    const running = qa.start(); await Promise.resolve(); assert.equal(qa.calls.ai.length, 1);
    if (change === 'pacing') qa.identity.current = 'changed-pacing';
    else { qa.epoch.current += 1; qa.stateRef.current = { ...qa.stateRef.current, project: { ...qa.stateRef.current.project, id: 'project-b' } }; }
    response.resolve({ ...estimate }); await running;
    assert.deepEqual(qa.calls.totals, []); assert.deepEqual(qa.calls.estimates, []); assert.deepEqual(qa.calls.boards, []);
  }
});

await asyncTest('真实去重恢复点等待期间改节奏或换项目，在持久化原文前退出', async () => {
  for (const change of ['pacing', 'project'] as const) {
    const integrity = deferred<string | undefined>(); const qa = generationHarness({ integrity: integrity.promise });
    const running = qa.start(); await Promise.resolve();
    if (change === 'pacing') qa.identity.current = 'changed-before-ai';
    else { qa.epoch.current += 1; qa.stateRef.current = { ...qa.stateRef.current, project: { ...qa.stateRef.current.project, id: 'project-b' } }; }
    integrity.resolve(story); await running;
    assert.deepEqual(qa.calls.persist, [], 'old story may not be persisted into the new request context');
    assert.deepEqual(qa.calls.ai, []); assert.deepEqual(qa.calls.estimates, []); assert.deepEqual(qa.calls.totals, []);
  }
});

await asyncTest('真实去重流程未发生外部改变时继续采用清理后的完整原文', async () => {
  const cleaned = `${story}\n这是已确认去重后的全文。`;
  const qa = generationHarness({ integrity: Promise.resolve(cleaned) }); await qa.start();
  assert.deepEqual(qa.calls.persist, [cleaned]); assert.equal(qa.calls.ai.length, 1);
  assert.equal(qa.calls.ai[0].input.story, cleaned);
  assert.equal((qa.calls.estimates[0] as SourcedStoryDurationEstimate).sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', cleaned, pacing, 15));
});

await asyncTest('真实固定时长主稿不强制AI估时、不伪造快照，并冻结同一节奏给分镜', async () => {
  for (const cached of [null, { ...estimate, sourceFingerprint: 'foreign-pacing' }]) {
    const qa = generationHarness({ durationMode: 'fixed', cached, confirmed: true }); await qa.start();
    assert.deepEqual(qa.calls.ai, []); assert.deepEqual(qa.calls.totals, [45]);
    assert.equal(qa.calls.boards.length, 1); assert.deepEqual(qa.calls.boards[0].pacing, pacing);
    const plan = qa.stateRef.current.project.sequencePlans[0] as VideoSequencePlan;
    assert.ok(plan); assert.equal(plan.totalDurationSec, 45); assert.equal(plan.durationEstimateSnapshot, undefined);
    assert.deepEqual(qa.calls.estimates, [null]);
  }
});

await asyncTest('真实AI估时确认后主稿保存原请求快照；不匹配缓存重估后仍在同一次点击生成', async () => {
  const cached = readSequencePlanDurationEstimate(fullSegmentFixture())!;
  const qa = generationHarness({ cached, confirmed: true }); await qa.start();
  assert.deepEqual(qa.calls.ai, []); assert.equal(qa.calls.boards.length, 1);
  const plan = qa.stateRef.current.project.sequencePlans[0] as VideoSequencePlan;
  assert.deepEqual(readSequencePlanDurationEstimate(plan), cached); assert.deepEqual(plan.durationEstimateSnapshot?.pacing, qa.calls.boards[0].pacing);
  const stale = generationHarness({ cached: { ...cached, sourceFingerprint: 'other-pacing' }, confirmed: true }); await stale.start();
  assert.equal(stale.calls.ai.length, 1); assert.equal(stale.calls.boards.length, 1);
  assert.equal(stale.stateRef.current.project.sequencePlans.length, 1);
});

test('v2估时必须绑定所选段长和足额倍数，旧快照只读保留但不冒充新请求', () => {
  const plan = fullSegmentFixture(); const frozen = JSON.stringify(plan);
  assert.equal(plan.durationEstimateSnapshot?.version, 2);
  assert.equal(plan.durationEstimateSnapshot?.segmentDurationSec, 15);
  const restored = readSequencePlanDurationEstimate(JSON.parse(frozen));
  assert.equal(restored?.recommendedSec, 30);
  assert.notEqual(restored?.sourceFingerprint, sequenceEstimateSourceFingerprint('练剑', story, pacing, 10));
  assert.equal(readSequencePlanDurationEstimate({ ...plan, segmentDurationSec: 10 }), null);
  const corrupt = JSON.parse(frozen); corrupt.durationEstimateSnapshot.estimate.recommendedSec = 29;
  assert.equal(readSequencePlanDurationEstimate(corrupt), null);
  assert.throws(() => createSequenceDurationEstimateSnapshot('练剑', story, pacing,
    { ...fullSegmentEstimate, recommendedSec: 29 }, 15), /整数倍|足额/u);
  for (const patch of [
    { resolvedPlanningSegmentDuration: 10 },
    { durationEstimate: readSequencePlanDurationEstimate(fixture()) },
  ]) {
    const current = runAppCache(patch); current.flush();
    assert.equal(current.value.currentDurationEstimate, null);
    assert.deepEqual(current.changes, { estimate: null, confirmed: false });
  }
  assert.equal(JSON.stringify(plan), frozen);
});

test('手动全片输入仅形成足额AI请求预算，不生成短尾段或改写原剧情', () => {
  assert.equal(roundUpSequenceDurationToFullSegments(80, 15), 90);
  assert.equal(roundUpSequenceDurationToFullSegments(80, 10), 80);
  assert.equal(roundUpSequenceDurationToFullSegments(80, 30), 90);
  assert.equal(roundUpSequenceDurationToFullSegments(80, 300), 300);
  assert.equal(roundUpSequenceDurationToFullSegments(80, 7.5), 82.5);
  assert.throws(() => roundUpSequenceDurationToFullSegments(3599, 299), /3600/u);
});

await asyncTest('真实App手动80秒/所选15秒只向AI请求90秒，原6秒片段不会污染参数', async () => {
  const qa = generationHarness({ durationMode: 'fixed' });
  qa.bindings.totalDuration = 80; qa.bindings.customDuration = 6; qa.bindings.durationPreset = 'custom';
  const start = evaluate([declaration('generateSequenceMasterPrompt')], qa.bindings, 'generateSequenceMasterPrompt') as () => Promise<void>;
  await start();
  assert.equal(qa.calls.ai.length, 0);
  assert.equal(qa.calls.boards[0].durationSec, 90);
  assert.equal(qa.calls.boards[0].requiredSegmentDurationSec, 15);
  assert.deepEqual(qa.calls.totals, [90]);
  const plan = qa.stateRef.current.project.sequencePlans[0] as VideoSequencePlan;
  assert.equal(plan.totalDurationSec, 90); assert.equal(plan.segmentDurationSec, 15);
  assert.equal(plan.sourceStoryContent, story); assert.equal(plan.requestedTotalDurationSec, 90);
  assert.ok(qa.calls.notices.some(([message]: [string]) => /80 秒调整为 90 秒（6 段）/u.test(message)));
});

await asyncTest('真实App自定义30和300秒从估时、快照直到全片请求保持原选值', async () => {
  for (const selected of [30, 300]) {
    const response = { ...fullSegmentEstimate, minSec: selected, recommendedSec: selected * 2, maxSec: selected * 3 };
    const qa = generationHarness({ response: Promise.resolve(response) });
    qa.bindings.planningSegmentDurationPreset = 'custom'; qa.bindings.planningCustomSegmentDuration = selected;
    qa.bindings.customDuration = 6; qa.bindings.durationPreset = 'custom';
    await (evaluate([declaration('generateSequenceMasterPrompt')], qa.bindings, 'generateSequenceMasterPrompt') as () => Promise<void>)();
    assert.equal(qa.calls.ai[0].input.segmentDurationSec, selected);
    assert.deepEqual(qa.calls.totals, [selected * 2]);
    assert.equal((qa.calls.estimates[0] as SourcedStoryDurationEstimate).sourceFingerprint,
      sequenceEstimateSourceFingerprint('练剑', story, pacing, selected));
    const generation = generationHarness({ durationMode: 'fixed' });
    generation.bindings.planningSegmentDurationPreset = 'custom'; generation.bindings.planningCustomSegmentDuration = selected;
    generation.bindings.totalDuration = selected * 2;
    await (evaluate([declaration('generateSequenceMasterPrompt')], generation.bindings, 'generateSequenceMasterPrompt') as () => Promise<void>)();
    assert.equal(generation.calls.boards[0].requiredSegmentDurationSec, selected);
    assert.equal(generation.calls.boards[0].durationSec, selected * 2);
  }
  const split = callback('segmentConfirmedMasterPrompt').getText(parsedApp);
  assert.match(split, /maxSegmentDurationSec: requestSegmentDurationSec/u);
  assert.match(split, /preferredSegmentDurationSec: requestSegmentDurationSec/u);
});

test('真实切换计划恢复原所选15秒，查看旧6秒片段只更改单段显示', () => {
  const writes: Record<string, unknown> = {};
  const presetStatement = declaration('durationPresetForSeconds', parsedApp.statements);
  const setters = Object.fromEntries(['setCustomDuration', 'setDurationPreset', 'setPlanningSegmentDurationPreset',
    'setPlanningCustomSegmentDuration', 'setDurationMode', 'setTotalDuration', 'setTotalDurationTouched', 'setSegmentationMode',
    'setDurationEstimate', 'setEstimateConfirmed'].map((name) => [name, (value: unknown) => { writes[name] = value; }]));
  const { view, restore } = evaluate([presetStatement, declaration('setDirectorDurationForSegment'), declaration('restoreSequencePlanTiming')], {
    ...setters, resolveSequenceSegmentDuration, readSequencePlanDurationEstimate,
  }, '({view: setDirectorDurationForSegment, restore: restoreSequencePlanTiming})');
  const legacy = { ...fullSegmentFixture(), totalDurationSec: 80, requestedTotalDurationSec: 80,
    segments: [{ ...fixture().segments[0], durationSec: 6, globalEndSec: 6 }] };
  const frozen = JSON.stringify(legacy);
  restore(legacy); view(legacy.segments[0]);
  assert.equal(writes.setPlanningSegmentDurationPreset, '15s'); assert.equal(writes.setPlanningCustomSegmentDuration, 15);
  assert.equal(writes.setCustomDuration, 6); assert.equal(writes.setDurationPreset, 'custom');
  assert.equal(writes.setTotalDuration, 80, 'opening an old plan is not permission to rewrite its total');
  assert.equal(JSON.stringify(legacy), frozen);
  const activePlanIdRef = { current: 'another-plan' }; let restored = 0;
  const select = evaluate([declaration('chooseSequenceSegment')], {
    stateRef: { current: { project: { sequencePlans: [legacy] } } }, activePlanIdRef,
    cancelSequenceGeneration: () => {}, restoreSequencePlanTiming: () => { restored += 1; },
    isSemanticSequencePlan, restoreSequenceDirectorSettings: unexpectedMutation,
    setActivePlanId: () => {}, setActiveSegmentId: () => {}, setActiveStoryboardId: () => {},
    setDirectorDurationForSegment: view,
  }, 'chooseSequenceSegment');
  select(legacy.segments[0].id, legacy.id); select(legacy.segments[0].id, legacy.id);
  assert.equal(restored, 1, 'same-plan segment navigation must not overwrite an edited planning choice');
  assert.equal(JSON.stringify(legacy), frozen);
});

test('真实切换到语义计划恢复该计划保存的导演快照，同计划切段不覆盖界面修改', () => {
  const savedSettings = {
    directorWorkflow: 'drama', directorInputMode: 'text_reference', shotMode: 'exact', shotCount: 7,
    pace: 'slow', aspectRatio: '9:16', resolution: '4K', audioMode: 'none',
    styleId: 'saved-style', ruleSetId: 'saved-rule', converterId: 'saved-converter',
    directorStyleId: 'christopher_nolan', directorCategory: '科幻', directorStyleName: '保存的导演风格',
    directorStyleSummary: '保存的完整导演说明', cameraTerms: ['保存的运镜'], lightingTerms: ['保存的灯光'],
    visualStyle: '保存的画面风格', extraRequirement: '保存的自定义要求', selectedAssetIds: ['saved-reference'],
  };
  const fingerprint = evaluate([declaration('directorSettingsFingerprint', parsedApp.statements)], {},
    'directorSettingsFingerprint')({ ...savedSettings, textApi: {} }) as string;
  const legacy = fullSegmentFixture();
  const semantic: VideoSequencePlan = {
    ...fullSegmentFixture(), id: 'semantic-plan', planningMode: 'semantic-segments',
    masterPromptDirectorSettingsFingerprint: 'must-not-restore-legacy-master-settings',
    semanticPlanningSnapshot: {
      version: 1, directorSettingsFingerprint: fingerprint, characterContinuity: [],
      creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
    },
    segments: [
      { ...fixture().segments[0], id: 'semantic-segment-1', durationSec: 15, globalEndSec: 15 },
      { ...fixture().segments[0], id: 'semantic-segment-2', index: 2, durationSec: 15, globalStartSec: 15, globalEndSec: 30 },
    ],
  };
  const state = {
    project: { sequencePlans: [legacy, semantic], storyboards: [], directorSettingsConfirmedFingerprint: 'live-project-settings' },
    settings: { defaultStylePresetId: 'default-style' },
  };
  const frozen = JSON.stringify(state);
  const writes: Record<string, unknown> = {};
  const setters = Object.fromEntries(Object.keys(savedSettings).map((name) => [
    `set${name[0].toUpperCase()}${name.slice(1)}`,
    (value: unknown) => { writes[name] = value; },
  ]));
  const restoreDirector = evaluate([
    declaration('parseDirectorSettingsFingerprint', parsedApp.statements),
    declaration('restoreSequenceDirectorSettings'),
  ], {
    ...setters, activeSequencePlan: legacy, state, stateRef: { current: state }, directorWorkflow: 'drama', directorInputMode: 'text',
    activeDirectorWorkflow, normalizeGridDirectorInputMode, resolveWorkspaceDirectorLook,
  }, 'restoreSequenceDirectorSettings');
  const restoredFingerprints: Array<string | undefined> = [];
  const restoredTiming: string[] = [];
  const activePlanIdRef = { current: legacy.id };
  const select = evaluate([declaration('chooseSequenceSegment')], {
    stateRef: { current: state }, activePlanIdRef, isSemanticSequencePlan,
    cancelSequenceGeneration: () => {},
    restoreSequencePlanTiming: (plan: VideoSequencePlan) => restoredTiming.push(plan.id),
    restoreSequenceDirectorSettings: (savedFingerprint?: string) => {
      restoredFingerprints.push(savedFingerprint); restoreDirector(savedFingerprint);
    },
    setActivePlanId: () => {}, setActiveSegmentId: () => {}, setActiveStoryboardId: () => {},
    setDirectorDurationForSegment: () => {},
  }, 'chooseSequenceSegment');
  select(semantic.segments[0].id, semantic.id);
  assert.deepEqual(restoredFingerprints, [fingerprint], 'the destination snapshot must win over the previously active plan and live project');
  assert.deepEqual(writes, savedSettings, 'the actual App restore callback must restore every saved director control');
  writes.extraRequirement = '用户在当前计划中修改的要求';
  select(semantic.segments[1].id, semantic.id);
  assert.deepEqual(restoredFingerprints, [fingerprint]);
  assert.deepEqual(restoredTiming, [semantic.id]);
  assert.equal(writes.extraRequirement, '用户在当前计划中修改的要求');
  select(legacy.segments[0].id, legacy.id);
  assert.deepEqual(restoredFingerprints, [fingerprint], 'legacy navigation retains its original timing-only behavior');
  assert.deepEqual(restoredTiming, [semantic.id, legacy.id]);
  assert.equal(JSON.stringify(state), frozen, 'navigation must not rewrite either saved plan');
});

await asyncTest('真实旧80/15计划在任何本地调整或API之前只报告需AI重生，保存稿和媒体不变', async () => {
  const plan = { ...fixture(false), totalDurationSec: 80, requestedTotalDurationSec: 80, segmentationSource: 'ai' as const,
    segments: [6, 9, 15, 24, 26].map((durationSec, index, durations) => ({
      ...fixture().segments[0], id: `old-${index}`, index: index + 1, durationSec,
      globalStartSec: durations.slice(0, index).reduce((sum, value) => sum + value, 0),
      globalEndSec: durations.slice(0, index + 1).reduce((sum, value) => sum + value, 0),
    })) };
  const storyboard = { id: plan.masterStoryboardId, sequencePlanId: plan.id, durationSec: 80, sourceStoryContent: story,
    promptTrace: { shotPlanMode: 'ai-complete' as const }, finalPrompt: 'original full prompt remains byte-identical',
    shots: plan.segments.map((segment, index) => ({ id: `shot-${index}`, index: index + 1,
      startSec: segment.globalStartSec, endSec: segment.globalEndSec, prompt: `original shot ${index}`, authoredBy: 'text-api' as const })) };
  const state = { project: { sequencePlans: [plan], storyboards: [storyboard], scenes: [], assets: [{ id: 'old-video', url: 'saved-video.mov' }] } };
  const frozen = JSON.stringify(state); const notices: string[] = [];
  const bindings = {
    busy: false, sequenceBatchRunning: false, sequencePromptRefreshRef: { current: null }, sequenceBatchIdentityRef: { current: null },
    storyboardBuildLeaseRef: { current: undefined }, workspaceEpochRef: { current: 1 },
    stateRef: { current: state }, activePlanIdRef: { current: plan.id }, activeSequencePlan: plan,
    activeSegmentId: plan.segments[0].id, activeSequenceSegment: plan.segments[0],
    sequencePlanMasterStoryboardIssue, assertSequenceSegmentDurationContract,
    notify: (message: string) => notices.push(message), setSequenceStage: () => {},
    prepareMasterAlignedSequencePlan: unexpectedMutation, setState: unexpectedMutation, buildStoryboard: unexpectedMutation,
  };
  await evaluate([declaration('hasActiveStoryboardBuild'), declaration('generateCurrentSequenceSegment')], bindings, 'generateCurrentSequenceSegment')();
  await evaluate([declaration('hasActiveStoryboardBuild'), declaration('generateAllSequenceSegments')], bindings, 'generateAllSequenceSegments')(plan);
  assert.equal(notices.length, 2); assert.ok(notices.every((message) => /整数倍|足额/u.test(message)));
  assert.equal(JSON.stringify(state), frozen);
});

console.log(`story pacing cache: ${groups} groups passed`);
