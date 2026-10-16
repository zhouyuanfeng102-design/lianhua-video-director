import assert from 'node:assert/strict';
import { requestStoryPreparationWithReview, requestStoryAnalysis, requestShotRecommendation } from '../src/services/llm';
import { STORY_VISUAL_ENGINE_VERSION, type StoryVisualActionPlan, type StoryVisualParagraph } from '../src/storyVisualAction';
import { materializeSemanticSequencePlan, parseSemanticSequenceResponse, semanticSegmentSourceContext,
  type SemanticSequencePlanningInput } from '../src/semanticSequencePlan';
import type { BattleSceneStaging } from '../src/battleScenePlanning';
import type { StoryVisualConversionSnapshot, TextApiConfig } from '../src/types';
import { readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';

// Synthetic analogues of sustained overwhelming combat and a later instant
// defeat. These tests verify production request/response transport, not an AI's
// understanding, action quality or a generated video's visual quality.
const orders = ['继续前进！后队从中路跟上，不许停下！', '诸位，轮到你们了，守住我们的最后一道防线！'];
const sourceParagraphs = [
  `坡上的统领喊：“${orders[0]}”数千士兵继续冲向白甲卫士。卫士用长枪不断迎击，每次都让前排成片倒下，后排仍继续压上。`,
  `统领对精锐喊：“${orders[1]}”精锐一同冲向白甲卫士，只一瞬间便全部倒下。统领目睹了结果。`,
];
const source = sourceParagraphs.join('\n\n');
const factPlan: StoryVisualActionPlan = {
  version: 1, sourceParagraphs: sourceParagraphs.map((text, index) => ({ id: `p${index + 1}`, text })),
  summary: '普通士兵持续冲锋而被压倒性迎击；随后精锐也瞬间倒下。具体枪路与精锐覆灭时的攻击次数未知。',
  events: [
    { id: 'e-order', sourceParagraphIds: ['p1'], evidence: `坡上的统领喊：“${orders[0]}”`, actor: '统领', target: '士兵',
      action: `喊：“${orders[0]}”`, phases: ['在坡上向士兵下令'], result: '军势继续冲锋', uncertainties: [] },
    { id: 'e-waves', sourceParagraphIds: ['p1'], evidence: '卫士用长枪不断迎击，每次都让前排成片倒下，后排仍继续压上。',
      actor: '白甲卫士', target: '冲锋士兵', action: '用长枪持续迎击', phases: ['前排成片倒下', '后排继续压上'],
      result: '持续迎击造成成批伤亡，攻势尚未停止', uncertainties: ['每次枪路、握持与具体攻击次数原文未说明'] },
    { id: 'e-elite-order', sourceParagraphIds: ['p2'], evidence: `统领对精锐喊：“${orders[1]}”`, actor: '统领', target: '精锐',
      action: `喊：“${orders[1]}”`, result: '精锐随后冲锋', uncertainties: [] },
    { id: 'e-instant', sourceParagraphIds: ['p2'], evidence: '精锐一同冲向白甲卫士，只一瞬间便全部倒下。', actor: '白甲卫士', target: '精锐',
      action: '迎击冲来的精锐', phases: ['精锐逼近', '瞬间全部倒下'], result: '精锐覆灭，统领目睹结果',
      uncertainties: ['具体枪路与攻击次数原文未说明'] },
  ],
};
const staging: BattleSceneStaging[] = [
  { version: 1, sceneType: '压倒性持续清剿', sourceEventIds: ['e-waves'],
    factLocks: ['白甲卫士用长枪迎击', '数千士兵持续冲锋', '前排成片倒下而后排仍继续压上'],
    stagingChoices: ['卫士前刺接横扫，下一次迎击从枪势回收继续', '后排从前排让出的通路补进'],
    actionGroups: [
      { id: 'guard', participants: ['白甲卫士'], role: '迎击', spatialLayer: '前景交点', route: '沿接触线迎敌', objective: '持续清剿' },
      { id: 'front', participants: ['前排士兵'], role: '冲锋', spatialLayer: '前景', route: '逼近枪锋', objective: '接敌' },
      { id: 'rear', participants: ['后排士兵'], role: '补进', spatialLayer: '中景与远景队列', route: '沿原通路向前', objective: '继续冲锋' },
    ],
    actionPhases: [
      { id: 'first-contact', sourceEventId: 'e-waves', groupIds: ['guard', 'front'], actor: '白甲卫士', target: '前排士兵',
        setup: '前排逼近长枪范围', trigger: '枪锋迎向来敌', contact: '长枪前刺后沿接触线横扫',
        result: '首排成片倒下', recovery: '卫士顺势回收，后排继续压上' },
      { id: 'next-contact', sourceEventId: 'e-waves', groupIds: ['guard', 'rear'], actor: '白甲卫士', target: '补进士兵',
        setup: '后排进入原接触线', contact: '卫士从回收枪势继续迎击', result: '补进队列继续受击', recovery: '后续军势仍向前推进' },
    ],
    dialogueBudget: { strategy: '统领在坡上真实画外喊话，与已有冲锋并行', parallelToAction: true,
      speechDurationSec: 4.8, actionDurationSec: 10.2 },
    entryState: '军势正在逼近', exitState: '前排倒下，后排仍继续推进' },
  { version: 1, sceneType: '瞬杀', sourceEventIds: ['e-instant'],
    factLocks: ['精锐一同冲来', '精锐瞬间全部倒下', '统领目睹结果'],
    stagingChoices: ['以一段短促横向枪路衔接逼近与倒下，不编成多回合苦战'],
    actionGroups: [
      { id: 'guard', participants: ['白甲卫士'], role: '迎击', spatialLayer: '前景交点', objective: '迎击精锐' },
      { id: 'elite', participants: ['精锐'], role: '冲锋', spatialLayer: '中景进入前景', route: '冲向白甲卫士', objective: '接敌' },
    ],
    actionPhases: [{ id: 'instant-result', sourceEventId: 'e-instant', groupIds: ['guard', 'elite'], actor: '白甲卫士', target: '精锐',
      setup: '精锐闭合距离', contact: '短促枪路横越逼近者的前沿', result: '精锐即时全部倒下', recovery: '卫士保留攻击结束姿态' }],
    dialogueBudget: { strategy: '先自然说完动员原话，精锐随后冲锋', parallelToAction: false,
      speechDurationSec: 5.6, actionDurationSec: 2.1 },
    entryState: '精锐即将出战', exitState: '精锐覆灭，统领已经看到结果' },
];
const detailedBodies = [
  `坡上的统领喊：“${orders[0]}”军势仍在冲来。白甲卫士迎住进入枪锋范围的前排，前刺接横扫，首排成片倒下；她顺着余势回收长枪。后排从前排让出的通路补进，她从回收枪势继续迎击，后续队列仍不断向前压上。`,
  `统领对精锐喊：“${orders[1]}”精锐一起冲来，逼近白甲卫士；一段短促横向枪路掠过逼近者的前沿，精锐即时全部倒下。卫士保持结束姿态，统领看到了精锐覆灭的结果。`,
];
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://battle-pipeline.invalid/v1/chat/completions',
  apiKey: 'synthetic-only-key', model: 'synthetic-only-model', temperature: 0.2, maxTokens: 8192, vision: false };
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let requests: CapturedStoryRequest[] = [];
const install = (handler: (request: CapturedStoryRequest, index: number) => unknown): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      const response = handler(request, requests.length - 1);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
    },
  } } });
};
const system = (request: CapturedStoryRequest): string => request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
const envelope = (request: CapturedStoryRequest, tag: string): Record<string, any> => {
  const user = request.messages.find((message) => message.role === 'user')?.content || '';
  const begin = `<${tag}>`; const end = `</${tag}>`;
  const start = user.indexOf(begin); const stop = user.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, `missing actual ${tag} transport envelope`);
  return JSON.parse(user.slice(start + begin.length, stop));
};
let checks = 0;
try {
  globalThis.fetch = async () => { throw new Error('This synthetic test must never use a network fallback'); };
  let adopted: StoryVisualConversionSnapshot | undefined;
  for (const detailMode of ['detailed', 'faithful'] as const) {
    const paragraphs: StoryVisualParagraph[] = sourceParagraphs.map((text, index) => ({
      id: `v${index + 1}`, sourceParagraphIds: [`p${index + 1}`],
      eventIds: factPlan.events.filter((event) => event.sourceParagraphIds.includes(`p${index + 1}`)).map((event) => event.id),
      text: detailMode === 'detailed' ? detailedBodies[index] : text,
      stagingAdditions: detailMode === 'detailed' ? [...staging[index].stagingChoices!] : [],
      battleStaging: detailMode === 'detailed' ? structuredClone(staging[index]) : {
        version: 1, sceneType: staging[index].sceneType, sourceEventIds: staging[index].sourceEventIds,
        factLocks: staging[index].factLocks, stagingChoices: [],
      },
    }));
    const expectedParagraphs = structuredClone(paragraphs);
    const beforeFacts = structuredClone(factPlan);
    install((request, index) => {
      assert.ok(index < 2, 'conversion has only its existing fact stage and body stage, with no third review');
      const data = readStoryVisualData(request);
      assert.equal(data.sourceTextOrRequirement, source);
      assert.equal(data.detailMode, detailMode);
      assert.equal(data.engineVersion, 'story-action-3.1');
      if (index === 0) {
        assert.equal(data.stage, 'understanding');
        return { version: factPlan.version, summary: factPlan.summary, events: factPlan.events };
      }
      assert.equal(data.stage, 'visualizing');
      assert.deepEqual(data.actionPlan, { version: 1, summary: factPlan.summary, events: factPlan.events });
      assert.deepEqual(data.focusEvents, factPlan.events);
      assert.ok(system(request).includes('battleStaging'), 'the live stage-two system carries the battle staging contract');
      assert.ok(system(request).includes('原文概述持续交战、每次攻击或连续清剿时，可以选择'),
        'detailed source conversion actually receives permission for compatible sustained-combat staging');
      assert.ok(system(request).includes('faithful 模式仅展开原文有依据的过程'),
        'the source contract preserves the distinct faithful authority');
      const userInstruction = request.messages.find((message) => message.role === 'user')!.content;
      assert.ok(userInstruction.includes('battleStaging 对象') && userInstruction.includes('actionGroups?')
        && userInstruction.includes('actionPhases?') && userInstruction.includes('dialogueBudget?'),
      'the existing body stage receives the structured plan schema in its final instruction');
      assert.ok(userInstruction.includes('faithful 只记录已有关系，stagingChoices 留空'));
      return { paragraphs };
    });
    const converted = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize', undefined, { detailMode });
    assert.equal(requests.length, 2);
    assert.deepEqual(converted.actionPlan, factPlan, 'staging must not fill the fact table unknowns');
    assert.deepEqual(converted.paragraphs, expectedParagraphs, 'both scene types keep the returned structured staging intact');
    assert.equal(converted.text, paragraphs.map((paragraph) => paragraph.text).join('\n\n'));
    assert.equal(converted.engineVersion, STORY_VISUAL_ENGINE_VERSION);
    assert.equal(converted.engineVersion, 'story-action-3.1');
    assert.equal(converted.detailMode, detailMode);
    for (const order of orders) assert.ok(converted.text.includes(`“${order}”`), 'full original speech stays in the adopted body');
    assert.deepEqual(factPlan, beforeFacts);
    assert.deepEqual(paragraphs, expectedParagraphs, 'response normalization does not mutate the mocked model result');
    if (detailMode === 'faithful') {
      assert.equal(converted.text, source);
      assert.ok(converted.paragraphs!.every((paragraph) => paragraph.stagingAdditions.length === 0
        && paragraph.battleStaging!.stagingChoices!.length === 0));
    }
    checks++;

    const snapshot: StoryVisualConversionSnapshot = { id: `battle-${detailMode}`, chapterId: 'synthetic-battle-chapter', sourceName: '合成战斗',
      sourceText: source, resultText: converted.text, actionPlan: converted.actionPlan, paragraphs: converted.paragraphs,
      engineVersion: converted.engineVersion, detailMode, createdAt: 1 };
    const snapshotBefore = structuredClone(snapshot);
    install((request, index) => {
      assert.equal(index, 0, 'analysis keeps its existing single request for this short source');
      const data = envelope(request, 'story_analysis_data');
      assert.equal(data.sourceStory, converted.text);
      assert.deepEqual(data.visualConversion, snapshotBefore);
      assert.deepEqual(data.visualConversion.actionPlan.events.map((event: { uncertainties: string[] }) => event.uncertainties),
        factPlan.events.map((event) => event.uncertainties));
      assert.deepEqual(data.visualConversion.paragraphs.map((paragraph: StoryVisualParagraph) => paragraph.battleStaging),
        expectedParagraphs.map((paragraph) => paragraph.battleStaging));
      return { characters: [], locations: [], props: [], scenes: paragraphs.map((paragraph, sceneIndex) => ({
        title: `合成战斗${sceneIndex + 1}`, content: paragraph.text, summary: '保留本场完整行动', characters: [], location: '', props: [],
      })) };
    });
    const analysis = await requestStoryAnalysis(config, converted.text, undefined, { chapterId: snapshot.chapterId, visualConversion: snapshot });
    assert.equal(requests.length, 1);
    assert.deepEqual(analysis.scenes.map((scene) => scene.content), paragraphs.map((paragraph) => paragraph.text));
    assert.deepEqual(snapshot, snapshotBefore, 'analysis cannot modify adopted source facts or choreography');
    if (detailMode === 'detailed') adopted = snapshot;
    checks++;
  }

  assert.ok(adopted);
  const input: SemanticSequencePlanningInput = { title: '合成战斗分段', story: adopted.resultText, segmentDurationSec: 15,
    directorSettingsFingerprint: 'battle-pipeline-fixture', creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
    originalSourceContext: adopted, shotMode: 'exact', shotCount: 1 };
  const response = parseSemanticSequenceResponse(JSON.stringify({ reason: '分别承载持续清剿与瞬杀', fitStatus: 'balanced',
    segments: adopted.paragraphs!.map((paragraph, index) => ({ title: `战斗${index + 1}`, content: paragraph.text, summary: '合成战斗',
      narrativePurpose: '表现原定战力与结果', entryState: staging[index].entryState, exitState: staging[index].exitState,
      transitionHint: '沿末态推进', boundaryReason: '当前事件完整', continuityPack: staging[index].exitState,
      semanticSource: { sourceEvidence: [{ text: sourceParagraphs[index] }],
        events: factPlan.events.filter((event) => paragraph.eventIds.includes(event.id)).map((event) => ({ id: event.id, description: event.action, phase: '当前段' })),
        dialogues: [{ id: index ? 'd-elite-order' : 'd-order', speaker: '统领', text: orders[index], language: 'Chinese' }], battleStaging: [paragraph.battleStaging] },
    })) }), input);
  const plan = materializeSemanticSequencePlan(input, response, { planId: 'synthetic-battle-sequence', now: 2 });
  const planBefore = structuredClone(plan);
  for (const [index, segment] of plan.segments.entries()) {
    const context = semanticSegmentSourceContext(plan, segment);
    install((request, requestIndex) => {
      assert.equal(requestIndex, 0, 'the scoped storyboard request adds no review or repair');
      const data = envelope(request, 'storyboard_planning_data');
      assert.equal(data.sourceStory, context.generationStoryContent,
        'planning receives the complete semantic source, including its existing allocated-dialogue record');
      assert.ok(data.sourceStory.startsWith(adopted!.paragraphs![index].text));
      assert.deepEqual(data.sequenceSegmentContext, JSON.parse(JSON.stringify(context)),
        'the wire preserves the complete JSON-safe context; absent optional values stay omitted');
      assert.deepEqual(data.sequenceSegmentContext.segment.semanticSource.battleStaging, [staging[index]]);
      assert.deepEqual(data.sequenceSegmentContext.storyUnderstandingContext.originalSourceContext, adopted);
      assert.equal(data.requiredShotCount, 1);
      return { reason: '保留当前事件的群体运动与原话', shots: [{ startSec: 0, endSec: 15,
        sourceExcerpt: segment.content, purpose: '呈现原定行动与结果', subject: '白甲卫士、统领与当前冲锋者',
        action: segment.content, performance: '沿当前剧情回应', space: '既定接触线与坡上统领的位置',
        direction: '冲锋者沿既定路线接近白甲卫士', camera: '稳定斜侧关系景保持交点与后排可读',
        transition: '沿已发生结果承接', lighting: '既有日光', sound: '脚步与武器接触声',
        dialogue: `第0.2s至第5.8s @统领：“${orders[index]}”`, result: staging[index].exitState,
      }] };
    });
    const shots = await requestShotRecommendation(config, { durationSec: 15, workflow: 'action', pace: 'tight', story: segment.content,
      requiredShotCount: 1, sequenceSegmentContext: context as unknown as Record<string, unknown> }, { reviewWithAi: false });
    assert.equal(requests.length, 1);
    assert.equal(shots.count, 1);
    assert.equal(shots.shots[0].action, segment.content);
    assert.equal(shots.shots[0].dialogue, `第0.2s至第5.8s @统领：“${orders[index]}”`);
    checks++;
  }
  assert.deepEqual(plan, planBefore);
  console.log(`PASS battle scene pipeline: ${checks} synthetic production-request checks; two-stage conversion, unknown facts, full original speech, analysis and semantic staging handoff. No model or video-quality claim.`);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  globalThis.fetch = originalFetch;
}
