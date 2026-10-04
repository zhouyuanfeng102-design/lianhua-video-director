import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  requestShotRecommendation,
  type StoryboardDurationAdjustmentPolicy,
  type StoryDurationEstimate,
} from '../src/services/llm';
import { buildShots } from '../src/promptEngine';
import { compileOfficialH3Prompt } from '../src/officialPrompt';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import { defaultStylePresets } from '../src/storage';
import { STORY_PACING_RULE, STORYBOARD_SPEECH_FIRST_PLANNING_RULE } from '../src/storyPacing';
import { VIDEO_SEQUENCE_TEXT_HANDOFF_PLANNING_RULE } from '../src/videoConversionRules';
import type { AiStoryboardShotPlan, ReferenceAsset, Scene, Storyboard, TextApiConfig } from '../src/types';

// Synthetic events and canned replies exercise the actual transport and
// numeric protocol. They are not a live-model quality or story-duration eval.
const actions = [
  '成年甲展开旧地图', '成年乙辨认地图上的渡口', '成年丙取出通行木牌',
  '成年甲说明通行约定', '成年乙推开院门', '成年丙扶稳门扇',
  '成年甲踏上石阶', '成年乙收好地图', '成年丙追上同伴',
  '成年甲停在岔路口', '成年乙指出通往渡口的方向', '成年丙确认路标',
  '成年甲转入林间小路', '成年乙绕过倒木', '成年丙跨过浅沟',
  '成年甲抵达桥头', '成年乙将木牌交给守桥人', '成年丙接回盖章木牌',
  '成年丙告诉同伴可以通过', '成年甲先行过桥', '成年乙和成年丙跟上',
  '三人抵达对岸并继续去渡口',
];
const speech = new Map<number, { speaker: string; line: string }>([
  [3, { speaker: '成年甲', line: '过桥前要先让守桥人检查木牌。' }],
  [10, { speaker: '成年乙', line: '渡口在左边，我们沿着路标走。' }],
  [18, { speaker: '成年丙', line: '木牌已经盖章，现在可以过桥了。' }],
]);
const excerpts = actions.map((action, index) => `${action}${speech.has(index) ? `，说：“${speech.get(index)!.line}”` : ''}。`);
const story = excerpts.join('');
const scene: Scene = { id: 'master-duration-fixture', title: '合成完整事件与原对白', content: story,
  summary: story, characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
const shotAt = (eventIndex: number, startSec: number, endSec: number): AiStoryboardShotPlan => ({
  startSec, endSec, sourceExcerpt: excerpts[eventIndex], purpose: `推进原文事件${eventIndex + 1}`,
  subject: '成年甲、成年乙、成年丙', action: actions[eventIndex],
  camera: '同轴中景观察当前动作与具名发话者，不重演前镜已完成事件',
  transition: '第0.00–0.50秒仅延续已成立的入镜状态，自0.50秒起推进当前动作',
  lighting: '沿用林间自然晨光', sound: '保留原对白与原文动作声，无配乐',
  result: `原文事件${eventIndex + 1}已完成`, space: '保持原路标和桥头的相对位置',
  direction: '按原文方向继续前行', performance: '听者自然聆听，不代替发话者说话',
  dialogue: speech.has(eventIndex)
    ? `第0.6–5.8s @${speech.get(eventIndex)!.speaker}（原声音身份、在画）：“${speech.get(eventIndex)!.line}”`
    : '无',
});
const estimateAt = (total: number): StoryDurationEstimate => ({
  minSec: total - 15, recommendedSec: total, maxSec: total + 15, fitStatus: 'balanced',
  reason: `AI按完整事件、对白与合理收束重新安排${total / 15}个完整15秒窗口，不删剧情。`,
});
const shotsAt = (total: number): AiStoryboardShotPlan[] => {
  const windows = total / 15;
  assert.ok(Number.isInteger(windows) && windows >= 11 && windows <= actions.length);
  return Array.from({ length: windows }, (_, window) => {
    const first = Math.floor(window * actions.length / windows);
    const end = Math.floor((window + 1) * actions.length / windows);
    const count = end - first;
    return Array.from({ length: count }, (_, offset) => shotAt(first + offset,
      window * 15 + offset * 15 / count, window * 15 + (offset + 1) * 15 / count));
  }).flat();
};
const completeAt = (total: number) => ({ shots: shotsAt(total), durationEstimate: estimateAt(total) });
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://master-duration.test/v1/chat/completions', apiKey: 'mock-only',
  model: 'mock-duration-only', temperature: 0.2, maxTokens: 8192, vision: false };
const params = { durationSec: 240, requiredSegmentDurationSec: 15, workflow: 'drama', pace: '自然', story };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
type RequestBody = { model: string; messages: Array<{ role: string; content: string }> };
const calls: RequestBody[] = [];
let responses: unknown[] = [];
const install = (values: unknown[]): void => {
  calls.length = 0;
  responses = [...values];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
    request: async (payload: { url: string; body: string; headers: Record<string, string> }) => {
      assert.equal(payload.url, config.baseUrl);
      assert.equal(payload.headers.Authorization, 'Bearer mock-only');
      const body: RequestBody = JSON.parse(payload.body);
      assert.equal(body.model, config.model);
      calls.push(body);
      assert.ok(responses.length, 'unexpected extra model call / added semantic audit');
      const response = responses.shift();
      return { status: 200, body: JSON.stringify({ choices: [{ message: {
        content: typeof response === 'string' ? response : JSON.stringify(response),
      } }] }) };
    },
  } } });
  globalThis.fetch = (() => assert.fail('no real network is allowed')) as typeof fetch;
};
const system = (index = 0) => calls[index].messages.find((message) => message.role === 'system')!.content;
const data = (index = 0): Record<string, any> => {
  const user = calls[index].messages.find((message) => message.role === 'user')!.content;
  const tag = index === 0 ? 'storyboard_planning_data' : index === 1 ? 'storyboard_ai_review_data' : 'storyboard_repair_data';
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, tag);
  return JSON.parse(match[1]);
};
const boundaries = (total: number) => Array.from({ length: total / 15 - 1 }, (_, index) => (index + 1) * 15);
const assertContext = (index: number, total: number, policy: StoryboardDurationAdjustmentPolicy): void => {
  const input = data(index);
  assert.equal(input.sourceStory, story, 'the complete unabridged source is transported at every stage');
  assert.equal(input.durationSec, total, 'the latest complete AI estimate, not the shot tail, is the active contract');
  assert.equal(input.initialRequestedDurationSec, 240, 'original request is provenance, not a new lower bound');
  assert.equal(input.durationAdjustmentPolicy, policy);
  assert.deepEqual(input.internalHardBoundariesSec, boundaries(total));
  if (policy !== 'fixed') assert.equal(input.durationAdjustmentScope, 'unconfirmed-full-film-only');
};
let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => {
  await run(); groups += 1; console.log(`PASS ${name}`);
};

try {
  await test('AI-estimated240→165/180 retains every source event/dialogue and uses the existing two-call flow', async () => {
    for (const total of [165, 180]) {
      const complete = completeAt(total);
      install([complete, complete]);
      const input = { ...params, durationAdjustmentPolicy: 'ai-estimated' as const };
      const untouched = structuredClone(input);
      const result = await requestShotRecommendation(config, input, { reviewWithAi: true });
      assert.equal(calls.length, 2);
      assert.equal(result.durationSec, total);
      assert.deepEqual(result.durationEstimate, complete.durationEstimate);
      assert.deepEqual(result.shots, complete.shots, 'no local trimming, filler shots or retiming');
      assert.deepEqual(result.shots.map((shot) => shot.action), actions);
      assert.deepEqual(result.shots.map((shot) => shot.dialogue), complete.shots.map((shot) => shot.dialogue));
      assertContext(0, 240, 'ai-estimated');
      assertContext(1, total, 'ai-estimated');
      assert.deepEqual(data(1).currentDurationEstimate, complete.durationEstimate);
      assert.deepEqual(input, untouched, 'caller-owned plan is never mutated');
      for (const index of [0, 1]) {
        assert.ok(system(index).includes(STORY_PACING_RULE));
        assert.ok(system(index).includes(STORYBOARD_SPEECH_FIRST_PLANNING_RULE));
        assert.ok(system(index).includes(VIDEO_SEQUENCE_TEXT_HANDOFF_PLANNING_RULE));
        assert.match(system(index), /完整原文|完整剧情/u);
        assert.match(system(index), /原对白|对白原文|原话/u);
        assert.match(system(index), /说话人|说话者/u);
        assert.match(system(index), /已完成状态只|已完成.*不.*重新/u);
        assert.doesNotMatch(system(index), /recommendedSec不得小于输入durationSec/u);
      }
    }
  });

  await test('review can reduce a previously expanded270-second candidate below the original240', async () => {
    install([completeAt(270), completeAt(180)]);
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' }, { reviewWithAi: true });
    assert.equal(calls.length, 2);
    assertContext(1, 270, 'ai-estimated');
    assert.equal(result.durationSec, 180);
    assert.deepEqual(result.shots, shotsAt(180));
  });

  await test('repair can reduce270→255→165 without locking prior budgets or inferring total from a short tail', async () => {
    const incompleteReview = { ...completeAt(255), shots: shotsAt(225) };
    install([completeAt(270), incompleteReview, completeAt(165)]);
    const progress: Array<{ attempt: number; maxAttempts: number }> = [];
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' },
      { reviewWithAi: true, onRepair: (value) => { progress.push(value); } });
    assert.equal(calls.length, 3);
    assert.deepEqual(progress.map(({ attempt, maxAttempts }) => [attempt, maxAttempts]), [[1, 3]]);
    assertContext(1, 270, 'ai-estimated');
    assertContext(2, 255, 'ai-estimated');
    assert.equal(data(2).masterTimelineDiagnostic.totalDurationSec, 255);
    assert.deepEqual(data(2).currentDurationEstimate, estimateAt(255));
    assert.deepEqual(JSON.parse(data(2).previousRepairResponse), incompleteReview);
    assert.deepEqual(JSON.parse(data(2).originalStoryboardResponse), completeAt(270));
    assert.match(system(2), /不等于必须往结尾补镜/u);
    assert.match(system(2), /不能借缩时掩盖.*漏/u);
    assert.equal(result.durationSec, 165);
    assert.deepEqual(result.durationEstimate, estimateAt(165));
    assert.deepEqual(result.shots, shotsAt(165));
  });

  await test('an explicitly accepted estimate survives review/repair omission, never manufactured from shots', async () => {
    for (const needsRepair of [false, true]) {
      const candidate = completeAt(165);
      const final = { shots: candidate.shots };
      install(needsRepair ? [candidate, { shots: candidate.shots.slice(0, -1) }, final] : [candidate, final]);
      const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' }, { reviewWithAi: true });
      assert.equal(calls.length, needsRepair ? 3 : 2);
      assert.equal(result.durationSec, 165);
      assert.deepEqual(result.durationEstimate, candidate.durationEstimate);
      assert.deepEqual(result.shots, candidate.shots);
      if (needsRepair) {
        assertContext(2, 165, 'ai-estimated');
        assert.deepEqual(data(2).currentDurationEstimate, candidate.durationEstimate);
      }
    }
  });

  await test('non-multiple, excess-precision and incomplete estimates use existing AI structural repair, not local rounding', async () => {
    const invalidEstimates = [
      { ...estimateAt(165), recommendedSec: 170 },
      { ...estimateAt(165), recommendedSec: 165.004 },
      { recommendedSec: 165 },
    ];
    for (const durationEstimate of invalidEstimates) {
      const invalid = { shots: shotsAt(165), durationEstimate };
      install([invalid, invalid, completeAt(165)]);
      const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' }, { reviewWithAi: true });
      assert.equal(calls.length, 3);
      assertContext(1, 240, 'ai-estimated');
      assertContext(2, 240, 'ai-estimated');
      assert.match(data(2).validationError, /整数倍|两位小数|最短时长/u);
      assert.equal(data(2).currentDurationEstimate, undefined);
      assert.deepEqual(JSON.parse(data(2).previousRepairResponse), invalid);
      assert.equal(result.durationSec, 165);
      assert.deepEqual(result.shots, shotsAt(165));
    }
  });

  await test('a short timeline without an estimate remains a structural failure until AI supplies complete authority', async () => {
    const short = { shots: shotsAt(165) };
    install([short, short, completeAt(180)]);
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' }, { reviewWithAi: true });
    assert.equal(calls.length, 3);
    assertContext(2, 240, 'ai-estimated');
    assert.equal(data(2).masterTimelineDiagnostic.totalDurationSec, 240);
    assert.match(data(2).validationError, /240秒/u);
    assert.equal(result.durationSec, 180);
    assert.deepEqual(result.durationEstimate, estimateAt(180));
  });

  await test('default/fixed policy forbids both shrinking and expanding, even with a legacy expansion flag', async () => {
    for (const permission of [{}, { durationAdjustmentPolicy: 'fixed' as const },
      { durationAdjustmentPolicy: 'fixed' as const, allowDurationExpansion: true }]) {
      for (const unauthorizedTotal of [165, 270]) {
        install([completeAt(unauthorizedTotal), completeAt(unauthorizedTotal), { shots: shotsAt(240) }]);
        const result = await requestShotRecommendation(config, { ...params, ...permission }, { reviewWithAi: true });
        assert.equal(calls.length, 3);
        for (const index of [0, 1, 2]) assertContext(index, 240, 'fixed');
        assert.equal(data(1).durationAdjustmentScope, undefined);
        assert.equal(data(1).allowDurationExpansion, undefined);
        assert.equal(result.durationSec, undefined);
        assert.equal(result.durationEstimate, undefined);
        assert.deepEqual(result.shots, shotsAt(240));
      }
    }
  });

  await test('explicit and legacy expand-only retain their original no-shrink behavior after expansion too', async () => {
    for (const permission of [{ durationAdjustmentPolicy: 'expand-only' as const }, { allowDurationExpansion: true }]) {
      install([completeAt(165), completeAt(165), completeAt(240)]);
      const unchanged = await requestShotRecommendation(config, { ...params, ...permission }, { reviewWithAi: true });
      assert.equal(calls.length, 3);
      assert.equal(unchanged.durationSec, 240);
      assertContext(2, 240, 'expand-only');
      assert.equal(data(2).allowDurationExpansion, true);
      assert.match(data(2).validationError, /不得缩短/u);
      install([completeAt(270), completeAt(255), { shots: shotsAt(270) }]);
      const expanded = await requestShotRecommendation(config, { ...params, ...permission }, { reviewWithAi: true });
      assert.equal(calls.length, 3);
      assertContext(2, 270, 'expand-only');
      assert.equal(expanded.durationSec, 270);
      assert.deepEqual(expanded.durationEstimate, estimateAt(270));
    }
  });

  await test('ordinary single-segment requests do not acquire duration authority without a master grid', async () => {
    const single = { shots: [shotAt(0, 0, 15)], durationEstimate: estimateAt(165) };
    for (const durationAdjustmentPolicy of ['ai-estimated', 'expand-only'] as const) {
      install([single, single]);
      const result = await requestShotRecommendation(config,
        { ...params, durationSec: 15, requiredSegmentDurationSec: undefined, durationAdjustmentPolicy, allowDurationExpansion: true },
        { reviewWithAi: true });
      assert.equal(calls.length, 2);
      assert.equal(data().durationAdjustmentPolicy, 'fixed');
      assert.equal(data().allowDurationExpansion, undefined);
      assert.equal(data().durationAdjustmentScope, undefined);
      assert.equal(result.durationSec, undefined);
      assert.equal(result.durationEstimate, undefined);
      assert.deepEqual(result.shots, single.shots);
    }
  });

  await test('semantic decisions remain model-owned with no new local repetition gate or extra review request', async () => {
    const candidate = completeAt(165);
    candidate.shots[candidate.shots.length - 1] = { ...candidate.shots.at(-1)!, action: candidate.shots.at(-2)!.action };
    install([candidate]);
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' });
    assert.equal(calls.length, 1, 'no hidden semantic call beyond the configured original flow');
    assert.deepEqual(result.shots, candidate.shots, 'a client regex does not rewrite or reject semantic content');
  });

  await test('persistent numeric failure remains bounded to one review plus three existing repairs', async () => {
    const invalid = { shots: shotsAt(165) };
    install(Array.from({ length: 5 }, () => invalid));
    const progress: number[] = [];
    await assert.rejects(requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' },
      { reviewWithAi: true, onRepair: ({ attempt }) => { progress.push(attempt); } }),
    /自动修复 3 次.*未覆盖已有结果/u);
    assert.equal(calls.length, 5);
    assert.deepEqual(progress, [1, 2, 3]);
  });

  await test('retimed model fields materialize unchanged and original H3 three/six-field forms still compile', async () => {
    install([completeAt(165), completeAt(165)]);
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'ai-estimated' }, { reviewWithAi: true });
    const materialized = buildShots({ scene, characters: [], locations: [], props: [], assets: [], workflow: 'drama',
      durationSec: result.durationSec!, shotMode: 'auto', shotCount: result.count, pace: 'standard', camera: '', lighting: '',
      style: defaultStylePresets[0], extra: '', aiPlan: result });
    for (const [index, expected] of result.shots.entries()) {
      for (const key of ['startSec', 'endSec', 'purpose', 'subject', 'action', 'camera', 'transition', 'lighting', 'sound', 'result',
        'space', 'direction', 'performance', 'dialogue'] as const) assert.equal(materialized[index][key], expected[key], key);
    }
    const reference: ReferenceAsset = { id: 'synthetic-reference', name: '合成场景参考', type: 'reference', role: 'composition',
      mediaType: 'image', source: 'upload', fileName: 'fixture.png', tags: [], createdAt: 1, updatedAt: 1 };
    const segmentShots = materialized.filter((shot) => shot.endSec <= 15);
    for (const useReference of [false, true]) {
      const board: Storyboard = { id: 'retimed-h3-fixture', sceneId: scene.id, workflow: 'drama', inputMode: useReference ? 'text_reference' : 'text',
        durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: segmentShots.length, pace: 'standard', aspectRatio: '16:9',
        resolution: '1080p', audioMode: 'stereo', stylePresetId: 'style-cinema', ruleSetId: 'rule-default', converterPresetId: 'converter-default',
        globalLock: '保持原人物及原剧情。', shots: segmentShots.map((shot) => ({ ...shot, referenceAssetIds: useReference ? [reference.id] : [] })),
        finalPrompt: segmentShots.map((shot) => `【${shot.startSec}s-${shot.endSec}s】主体：@${shot.subject} 正在 [${shot.transition}，${shot.action}]；空间：${shot.space}；光影：${shot.lighting}；镜头：${shot.camera}；台词：${shot.dialogue}；音效：${shot.sound}`).join('\n'),
        createdAt: 1, updatedAt: 1 };
      const output = compileOfficialH3Prompt(board, { assets: useReference ? [reference] : [] }).output.prompt;
      const protocol = readH3PromptProtocol(output);
      assert.ok(protocol, 'original H3 transport remains readable after accepted master retiming');
      assert.deepEqual(protocol.sections, useReference
        ? ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']
        : ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']);
      assert.equal(protocol.shots.length, segmentShots.length);
      assert.equal(protocol.shots[0].cut, null);
      assert.match(output, /0\.00–0\.50秒/u);
      assert.match(VIDEO_SEQUENCE_TEXT_HANDOFF_PLANNING_RULE, /0\.50秒起推进本段新内容/u);
      assert.match(VIDEO_SEQUENCE_TEXT_HANDOFF_PLANNING_RULE, /最多不能超过0\.80秒/u);
    }
  });

  await test('App grants AI retiming only to an unconfirmed full-film draft, not fixed/single/confirmed-slice callers', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const nodes = (root: ts.Node): ts.Node[] => {
      const result: ts.Node[] = [root];
      ts.forEachChild(root, (child) => { result.push(...nodes(child)); });
      return result;
    };
    const all = nodes(ast);
    const callNamed = (node: ts.Node, name: string): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
    const property = (root: ts.Node, name: string) => nodes(root).filter(ts.isPropertyAssignment)
      .find((node) => node.name.getText(ast) === name);
    const variable = (root: ts.Node, name: string) => nodes(root).filter(ts.isVariableDeclaration)
      .find((node) => node.name.getText(ast) === name);
    const ancestors = (node: ts.Node): ts.Node[] => node.parent ? [node.parent, ...ancestors(node.parent)] : [];
    const planning = variable(ast, 'generateSequenceMasterPrompt');
    assert.ok(planning?.initializer);
    const masterCall = nodes(planning.initializer).find((node) => callNamed(node, 'buildStoryboard'));
    assert.ok(masterCall && ts.isCallExpression(masterCall));
    const modePolicy = property(masterCall.arguments[0], 'durationAdjustmentPolicy');
    assert.ok(modePolicy);
    assert.equal(property(masterCall.arguments[0], 'fullTimeline')?.initializer.kind, ts.SyntaxKind.TrueKeyword);
    assert.equal(property(masterCall.arguments[0], 'deferCommit')?.initializer.kind, ts.SyntaxKind.TrueKeyword);
    // Execute only the small extracted authorization expression, never App
    // itself or project state. This checks its actual true/false branches.
    const policyForMode = new Function('durationMode', `return (${modePolicy.initializer.getText(ast)});`) as (mode: string) => string;
    assert.equal(policyForMode('ai-estimated'), 'ai-estimated');
    assert.equal(policyForMode('fixed'), 'fixed');
    const serviceCalls = all.filter((node) => callNamed(node, 'requestShotRecommendation'));
    assert.equal(serviceCalls.length, 1);
    const serviceCall = serviceCalls[0] as ts.CallExpression;
    const servicePolicy = property(serviceCall.arguments[1], 'durationAdjustmentPolicy');
    assert.ok(servicePolicy);
    const conditional = ancestors(servicePolicy).find(ts.isConditionalExpression);
    assert.ok(conditional);
    const servicePermission = new Function('fullTimeline', 'segmentForGeneration', 'override',
      `return (${conditional.getText(ast)});`) as (full: boolean, segment: unknown, override: unknown) => Record<string, unknown>;
    for (const requestedPolicy of ['ai-estimated', 'fixed'] as const) {
      const override = { durationAdjustmentPolicy: requestedPolicy, requiredSegmentDurationSec: 15 };
      assert.deepEqual(servicePermission(true, undefined, override), { durationAdjustmentPolicy: requestedPolicy });
      assert.deepEqual(servicePermission(false, undefined, override), {});
      assert.deepEqual(servicePermission(true, { id: 'confirmed-slice' }, override), {});
      assert.deepEqual(servicePermission(true, undefined, { durationAdjustmentPolicy: requestedPolicy }), {});
    }
    assert.deepEqual(servicePermission(true, undefined, { requiredSegmentDurationSec: 15 }), { durationAdjustmentPolicy: 'fixed' });
    const confirmedSliceBranch = ancestors(serviceCall).filter(ts.isIfStatement)
      .find((node) => node.expression.getText(ast) === 'canonicalMasterSlice');
    assert.ok(confirmedSliceBranch?.elseStatement);
    assert.ok(serviceCall.pos >= confirmedSliceBranch.elseStatement.pos && serviceCall.end <= confirmedSliceBranch.elseStatement.end,
      'confirmed slices bypass model planning entirely');
    assert.equal(nodes(confirmedSliceBranch.thenStatement).filter((node) => callNamed(node, 'requestShotRecommendation')).length, 0);
    assert.equal(all.filter(ts.isPropertyAssignment).filter((node) => node.name.getText(ast) === 'durationAdjustmentPolicy').length, 2,
      'no hidden policy grants in segment generation, selection or formatting');

    const durationAssignment = all.filter(ts.isBinaryExpression).find((node) =>
      node.left.getText(ast) === 'duration' && /modelPlan\.durationSec/u.test(node.right.getText(ast)));
    assert.ok(durationAssignment);
    assert.equal(durationAssignment.right.getText(ast), 'modelPlan.durationSec ?? duration',
      'accepted reductions are not clamped to the earlier budget or guessed from the final shot');
    const applicationGuard = ancestors(durationAssignment).find(ts.isIfStatement);
    assert.ok(applicationGuard);
    const mayApply = new Function('fullTimeline', 'segmentForGeneration', 'override',
      `return Boolean(${applicationGuard.expression.getText(ast)});`) as (full: boolean, segment: unknown, override: unknown) => boolean;
    const adaptive = { durationAdjustmentPolicy: 'ai-estimated', requiredSegmentDurationSec: 15 };
    assert.equal(mayApply(true, undefined, adaptive), true);
    assert.equal(mayApply(false, undefined, adaptive), false);
    assert.equal(mayApply(true, { id: 'confirmed-slice' }, adaptive), false);
    assert.equal(mayApply(true, undefined, { ...adaptive, durationAdjustmentPolicy: 'fixed' }), false);
    assert.equal(mayApply(true, undefined, { ...adaptive, requiredSegmentDurationSec: undefined }), false);
    assert.match(applicationGuard.thenStatement.getText(ast), /onDurationPlanned\?\.\(\{\s*\.\.\.modelPlan\.durationEstimate\s*\}\)/u);

    const initialPlan = variable(planning.initializer, 'plan');
    const finalPlan = variable(planning.initializer, 'draftPlan');
    assert.ok(initialPlan?.initializer && finalPlan?.initializer);
    assert.equal(property(initialPlan.initializer, 'masterPlanningInitialDurationSec')?.initializer.getText(ast), 'chosenTotalDuration');
    assert.equal(variable(planning.initializer, 'completedTotalDuration')?.initializer?.getText(ast), 'masterStoryboard.durationSec');
    for (const field of ['requestedTotalDurationSec', 'totalDurationSec']) {
      assert.equal(property(finalPlan.initializer, field)?.initializer.getText(ast), 'completedTotalDuration');
    }
    assert.equal(property(finalPlan.initializer, 'masterPlanningInitialDurationSec'), undefined,
      'final budget update preserves the original request rather than overwriting provenance');
    assert.match(finalPlan.initializer.getText(ast), /createSequenceDurationEstimateSnapshot\([\s\S]*masterDurationEstimate/u);
  });
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = originalFetch;
}

console.log(`${groups} master duration re-estimate groups passed; synthetic transport only, no paid API or project-data writes`);
