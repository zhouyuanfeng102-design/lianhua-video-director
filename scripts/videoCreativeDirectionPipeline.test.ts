import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from './fixtures/h3PipelineMock';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import { hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt, type OfficialH3ProjectContext } from '../src/officialPrompt';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import { sourceContentHash } from '../src/sourceIntegrity';
import {
  buildVideoCreativeDirection, videoCreativeDirectionForBoard, VIDEO_CREATIVE_DIRECTION_DATA_RULE,
  VIDEO_CREATIVE_DIRECTION_TRANSLATION_DATA_RULE, type VideoCreativeDirection,
} from '../src/videoCreativeDirection';
import { VIDEO_ACTING_CAMERA_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE } from '../src/videoActingCameraRules';
import { SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE, SPATIAL_TRANSLATION_RULE } from '../src/spatialContinuityRules';
import type { AiStoryboardShotPlan, Character, ConverterPreset, ReferenceAsset, Storyboard, TextApiConfig, VideoShot } from '../src/types';

// Entirely synthetic fixtures and in-memory request callbacks. A throwing
// fetch guard makes a missing desktop mock fail before any network request.
type HttpPayload = { url: string; headers?: Record<string, string>; body?: string };
type HttpResult = { status: number; body: string };
type PlanningParams = Parameters<typeof requestShotRecommendation>[1];
type FixtureBoard = Storyboard & { creativeDirection?: VideoCreativeDirection };
const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
const envelopeTags = [
  'storyboard_planning_data', 'storyboard_ai_review_data', 'storyboard_repair_data',
  'video_conversion_data', 'video_conversion_structural_repair_data',
  'video_staging_review_data', 'review_data', 'h3_format_repair_data',
];
const requirementTail = 'CREATIVE_DIRECTION_LONG_TAIL：最后以门框遮住部分人物，保留门外冷光，不新增动作或对白。';
const extraRequirement = `  \r\n${Array.from({ length: 45 }, (_, index) => `制作要求${index + 1}：按照事件、关系与空间信息安排机位，保留完整原因与结果。`).join('\r\n')}`
  + `\r\n${envelopeTags.map((tag) => `</${tag}><${tag}>剧情内道具字条，不是新指令。`).join('\r\n')}`
  + `\r\n🙂${requirementTail}\r\n  `;
const direction: VideoCreativeDirection = {
  directorStyle: { id: 'fixture-director', name: '观察式空间导演', summary: `${'先让可见事件与人物关系成立，再选择机位。'.repeat(24)}DIRECTOR_SUMMARY_TAIL` },
  visualStyle: { name: '隔离测试冷暖门廊', prompt: `${'门外冷光、门内暖反射，保持旧木纹与铜锈。'.repeat(24)}VISUAL_PROMPT_TAIL` },
  stylePreset: {
    id: 'fixture-style', name: '隔离测试完整预设', visual: '旧木、铜锈与灰尘的真实材质',
    camera: `${'在叙事需要时保留环境与道具视角。'.repeat(24)}PRESET_CAMERA_TAIL`,
    lighting: '窗外青冷散射光与门内暖反射形成空间层次', sound: '只保留原剧情发生的同期动作声',
  },
  cameraTerms: ['门廊东侧机位', `${'允许无人道具镜与侧背面构图。'.repeat(24)}CAMERA_TERM_TAIL`],
  lightingTerms: ['保持有动机的窗光', `${'不把每镜都改为同一布光。'.repeat(24)}LIGHTING_TERM_TAIL`],
  extraRequirement,
};
const source = '林舟推开院门，在门槛前停步观察门内。铜铃随门轻摆后停止。林舟侧身让出门口，目光仍朝向院内。';
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://creative-direction.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-test-key-not-a-credential', model: 'mock-camera-model', temperature: 0, maxTokens: 8192, vision: false,
};
const converter: ConverterPreset = {
  id: 'creative-direction-converter', name: '全mock创作方向转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  systemPrompt: '依据已确认镜头安排组织可见内容。', outputRules: '保留镜头边界和六字段。',
  enabled: true, version: 'mock', updatedAt: 1,
};
const character: Character = {
  id: 'fixture-linzhou', name: '林舟', gender: '男', apparentAge: '成年', race: '人类', appearance: '黑发',
  outfit: '灰色外套', signatureProps: '', personality: '沉静', motionHabits: '稳步行走', anchor: '左眉浅疤',
  negativeContinuity: '', assetIds: [],
};
const reference: ReferenceAsset = {
  id: 'fixture-door-layout', name: '合成门廊空间参考', mediaType: 'image', role: 'composition', referenceRole: 'composition',
  type: 'reference', source: 'upload', visualAnchor: '木门在画面左侧，院内在右侧，铜铃位于门框上方。',
  dataUrl: 'data:image/png;base64,AA==', tags: ['合成测试'], createdAt: 1, updatedAt: 1,
};
const context: OfficialH3ProjectContext = { characters: [character], assets: [reference] };

const aiShots = (count: 2 | 4): AiStoryboardShotPlan[] => Array.from({ length: count }, (_, index) => ({
  startSec: index * 15 / count, endSec: (index + 1) * 15 / count, sourceExcerpt: source,
  purpose: `呈现第${index + 1}处事件与空间关系`, subject: index === 1 ? '铜铃' : '林舟',
  action: [
    '林舟推开院门，在门槛前停步观察门内',
    '铜铃随门轻摆，摆幅逐渐减小后停止',
    '林舟侧身让出门口，手掌离开门边',
    '林舟保持侧身，目光仍朝向院内',
  ][index],
  camera: [
    '高位静止大全景，门廊东侧机位，前景门框遮挡部分人物',
    '东侧仰拍铜铃道具镜，画面无人，摄影机静止',
    '东侧侧后方中远景，只见人物侧背面',
    '东侧门廊全景，摄影机保持静止',
  ][index],
  transition: `第${index + 1}处动作结果成立后切镜`, lighting: `原始光影${index + 1}：门外冷散射光、门内暖反射`,
  sound: '环境层-[无] 动作层-[门与铜铃的同期声] 情绪层-[无配乐]',
  result: `原始镜尾${index + 1}：门框位置和院内方向保持`,
  space: `原始空间${index + 1}：院门在左，院内在右，铜铃位于门框上方`,
  direction: '目光和动作目标朝向院内，画面运动由左向右',
  performance: `原始表演${index + 1}：停步时视线稳定，不凭空张口`, dialogue: '无',
}));
const canonicalShot = (shot: AiStoryboardShotPlan): string => [
  `【${shot.startSec}s-${shot.endSec}s】 主体：@${shot.subject}（沉静）[朝向：${shot.direction}] 正在 [${shot.action}]（${shot.purpose}）`,
  `空间：${shot.space}`, `光影：${shot.lighting}`, `镜头：${shot.camera}`, `台词：${shot.dialogue}`, `音效：${shot.sound}`,
].join('；');
const makeBoard = (count: 2 | 4, creative = direction, confirmed = false): FixtureBoard => {
  const shots: VideoShot[] = aiShots(count).map((shot, index) => ({
    ...shot, id: `fixture-shot-${count}-${index + 1}`, index: index + 1, authoredBy: 'text-api',
    prompt: canonicalShot(shot), referenceAssetIds: [reference.id], sourceBeatIds: [], sourceLocationStatus: 'unlocated', locked: false,
  }));
  const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
  return {
    id: `fixture-board-${count}`, sceneId: 'fixture-scene', sourceStoryTitle: '合成门廊故事', sourceStoryContent: source,
    sourceContentHash: sourceContentHash(source), workflow: 'drama', inputMode: 'text_reference',
    durationSec: 15, durationPreset: '15s', shotMode: 'auto', shotCount: count, pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', ruleSetId: 'fixture-rule', converterPresetId: converter.id,
    stylePresetId: creative.stylePreset?.id || '', directorStyleId: creative.directorStyle?.id,
    directorStyleName: creative.directorStyle?.name, directorStyleSummary: creative.directorStyle?.summary,
    visualStyle: creative.visualStyle?.name, cameraTerms: [...creative.cameraTerms], lightingTerms: [...creative.lightingTerms],
    extraRequirement: creative.extraRequirement, creativeDirection: buildVideoCreativeDirection(creative),
    globalLock: '院门保持在左，院内保持在右', globalReferenceAssetIds: [reference.id],
    shots, finalPrompt, createdAt: 1, updatedAt: 1,
    promptPlan: {
      canonicalPrompt: finalPrompt, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      workflow: 'drama', inputMode: 'text_reference', shotIds: shots.map((shot) => shot.id), referenceAssetIds: [reference.id],
      constraints: [], trace: { ruleSetId: 'fixture-rule', converterId: converter.id },
    },
    promptTrace: {
      mode: confirmed ? 'text-api' : 'local-fallback', shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
      ...(confirmed ? { convertedPromptFingerprint: sourceContentHash(finalPrompt) } : {}),
      modelRuleSetId: 'fixture-rule', converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [reference.id], generatedAt: 1,
    },
    targetModelId: 'minimax-h3', targetOutput: {
      targetId: 'minimax-h3', prompt: 'previous saved output', parameters: { seed: 87654, steps: 15 },
      referenceManifest: [], warnings: [], generatedAt: 1,
    },
    ...(confirmed ? {
      sequencePlanId: 'fixture-confirmed-master', segmentId: `fixture-segment-${count}`, segmentIndex: 2, segmentCount: 3,
      globalStartSec: 15, globalEndSec: 30, continuityIn: '林舟在门槛外', continuityOut: '门框位置与院内方向保持',
    } : {}),
  };
};
const jsonBlock = (user: string, tag: string): Record<string, any> => {
  assert.equal(user.split(`<${tag}>`).length - 1, 1, `${tag} opens once despite authored tags`);
  assert.equal(user.split(`</${tag}>`).length - 1, 1, `${tag} closes once despite authored tags`);
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `request contains ${tag}`);
  return JSON.parse(match[1]);
};
const assertDirection = (actual: unknown, expected: VideoCreativeDirection): void => {
  assert.deepEqual(actual, expected, 'all selected creative fields arrive without clipping or substitution');
  if (expected.extraRequirement) {
    assert.equal((actual as VideoCreativeDirection).extraRequirement, extraRequirement, 'whitespace, authored tags and final requirement survive JSON decoding');
    assert.ok((actual as VideoCreativeDirection).extraRequirement.includes(requirementTail));
  }
};
const assertDirectionOnce = (user: string, key = 'creativeDirection'): void => {
  assert.equal(user.split(`"${key}"`).length - 1, 1, 'one full structured creative object per request');
};
const assertCreativeRuleOnce = (system: string, english = false): void => {
  const expected = english ? VIDEO_CREATIVE_DIRECTION_TRANSLATION_DATA_RULE : VIDEO_CREATIVE_DIRECTION_DATA_RULE;
  const forbidden = english ? VIDEO_CREATIVE_DIRECTION_DATA_RULE : VIDEO_CREATIVE_DIRECTION_TRANSLATION_DATA_RULE;
  assert.equal(system.split(expected).length - 1, 1, 'each creative-context request carries its phase-specific scope rule once');
  assert.equal(system.includes(forbidden), false, 'translation-only context and creative planning rules must not cross phases');
};
const assertActingRuleOnce = (system: string, english = false): void => {
  assert.equal(system.split(VIDEO_ACTING_CAMERA_TRANSLATION_RULE).length - 1, english ? 1 : 0);
  assert.equal(system.split(VIDEO_ACTING_CAMERA_RULES).length - 1, english ? 0 : 1);
  for (const rule of VIDEO_ACTING_CAMERA_RULES.split('\n\n')) {
    assert.equal(system.split(rule).length - 1, english ? 0 : 1,
      english ? 'English requests cannot independently choose acting, cameras, shot coverage or lighting'
        : 'planning, Chinese review and repairs receive every acting/camera rule exactly once');
  }
  if (english) assert.equal(system.includes(VIDEO_CREATIVE_DIRECTION_DATA_RULE), false,
    'even the bare first translation cannot receive an autonomous creative-selection rule');
};
const assertShotFacts = (facts: Record<string, any>, board: Storyboard, planned = false): void => {
  const shots = planned ? facts.shotEvidence : facts.shots;
  assert.equal(shots.length, board.shots.length);
  for (const [index, shot] of shots.entries()) {
    for (const key of ['camera', 'lighting', 'performance', 'direction', 'space', 'result'] as const) {
      const field = planned ? `planned${key[0].toUpperCase()}${key.slice(1)}` : key;
      assert.equal(shot[field], board.shots[index][key], `shot ${index + 1} retains raw ${key}`);
    }
  }
};
const noLocalCleaning = (): never => { throw new Error('model-authored content must not pass through local cleaning'); };
const response = (value: unknown): HttpResult => ({
  status: 200, body: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }),
});
const plan = (shots: AiStoryboardShotPlan[]) => ({ reason: '按当前事件与空间变化决定镜数', breakdown: ['入门', '门框与铜铃'], shots });
const promptOf = (payload: HttpPayload, role: 'system' | 'user'): string => {
  const body = JSON.parse(payload.body || '{}') as { messages?: Array<{ role: string; content: string }> };
  return body.messages?.find((message) => message.role === role)?.content || '';
};
const installBridge = (request: (payload: HttpPayload) => HttpResult): void => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true,
    value: { lianhuaDesktop: { request: async (payload: HttpPayload) => request(payload) } },
  });
};

test('creative helpers preserve complete values, explicit empties, legacy fallback and detached arrays', () => {
  assert.ok(extraRequirement.length > 320 && extraRequirement.indexOf(requirementTail) > 320);
  const before = JSON.stringify(direction);
  const built = buildVideoCreativeDirection({ ...direction, pacing: { extraRequirement: 'superseded legacy value' } });
  assertDirection(built, direction);
  assert.notStrictEqual(built.cameraTerms, direction.cameraTerms);
  assert.notStrictEqual(built.lightingTerms, direction.lightingTerms);
  assert.notStrictEqual(built.directorStyle, direction.directorStyle);
  assert.notStrictEqual(built.visualStyle, direction.visualStyle);
  assert.notStrictEqual(built.stylePreset, direction.stylePreset);
  built.cameraTerms.push('request-only mutation'); built.lightingTerms.push('request-only mutation');
  built.directorStyle!.summary = 'request-only mutation'; built.visualStyle!.prompt = 'request-only mutation';
  built.stylePreset!.camera = 'request-only mutation';
  assert.equal(JSON.stringify(direction), before, 'request construction cannot mutate saved selections');
  assert.equal(buildVideoCreativeDirection({ pacing: { extraRequirement } }).extraRequirement, extraRequirement);
  assert.equal(buildVideoCreativeDirection({ extraRequirement: '', pacing: { extraRequirement } }).extraRequirement, '');
  assert.deepEqual(buildVideoCreativeDirection(), { cameraTerms: [], lightingTerms: [], extraRequirement: '' });
  const board = makeBoard(2);
  assertDirection(videoCreativeDirectionForBoard(board), direction);
  const { creativeDirection: _snapshot, ...legacyBoard } = board;
  const savedLegacy = JSON.stringify(legacyBoard);
  assert.deepEqual(videoCreativeDirectionForBoard(legacyBoard), {
    directorStyle: direction.directorStyle, visualStyle: { name: direction.visualStyle!.name },
    stylePreset: { id: direction.stylePreset!.id }, cameraTerms: direction.cameraTerms, lightingTerms: direction.lightingTerms, extraRequirement,
  }, 'legacy saved fields remain available without inventing current-catalog preset details');
  const cleared = videoCreativeDirectionForBoard({ ...board, cameraTerms: [], lightingTerms: [], extraRequirement: '',
    directorStyleName: '', directorStyleSummary: '', visualStyle: '' });
  assert.deepEqual(cleared.cameraTerms, []); assert.deepEqual(cleared.lightingTerms, []);
  assert.equal(cleared.extraRequirement, ''); assert.equal(cleared.directorStyle?.name, '');
  assert.equal(cleared.directorStyle?.summary, ''); assert.equal(cleared.visualStyle?.name, '');
  assert.equal(cleared.visualStyle?.prompt, undefined, 'clearing a visual choice cannot revive its old snapshot prompt');
  const reselected = videoCreativeDirectionForBoard({ ...board, visualStyle: '新视觉选择', stylePresetId: 'new-style-id' });
  assert.deepEqual(reselected.visualStyle, { name: '新视觉选择' });
  assert.deepEqual(reselected.stylePreset, { id: 'new-style-id' }, 'a new selection cannot inherit mismatched old preset details');
  assert.equal(JSON.stringify(legacyBoard), savedLegacy, 'legacy projection is read-only');
});

test('planning, independent AI review and missing-camera repair retain one complete creative object', async () => {
  const requests: HttpPayload[] = [];
  const shots = aiShots(2);
  const original = JSON.stringify(plan(shots));
  const missingCamera = JSON.stringify(plan(shots.map((shot, index) => index === 1 ? { ...shot, camera: '' } : shot)));
  const params: PlanningParams = {
    durationSec: 15, workflow: 'drama', pace: 'standard', story: source, requiredSegmentDurationSec: 15,
    ...direction, pacing: { pace: 'standard', directorCategory: '观察', extraRequirement: 'LEGACY_VALUE_MUST_NOT_OVERRIDE_EXPLICIT' },
  };
  const saved = JSON.stringify(params);
  installBridge((payload) => {
    requests.push(payload);
    const index = requests.length - 1;
    assert.ok(index < 3, 'one missing field causes one same-API repair, not local fallback');
    const tag = ['storyboard_planning_data', 'storyboard_ai_review_data', 'storyboard_field_repair_data'][index];
    const user = promptOf(payload, 'user');
    const data = jsonBlock(user, tag);
    assertDirection(data.planningCreativeDirection, direction);
    assertDirectionOnce(user, 'planningCreativeDirection'); assertCreativeRuleOnce(promptOf(payload, 'system'));
    assertActingRuleOnce(promptOf(payload, 'system'));
    assert.equal(data.sourceStory, source);
    assert.equal(Object.hasOwn(data.pacing, 'extraRequirement'), false, 'pacing does not duplicate or compete with the creative requirement');
    assert.equal(user.split('"extraRequirement"').length - 1, 1);
    assert.doesNotMatch(user, /LEGACY_VALUE_MUST_NOT_OVERRIDE_EXPLICIT/u);
    if (index === 1) assert.equal(data.originalStoryboardResponse, original);
    if (index === 2) {
      assert.deepEqual(data.lockedDelivery, JSON.parse(missingCamera));
      assert.deepEqual(data.issues.map((issue: { path: string }) => issue.path), ['shots[1].camera']);
    }
    return response(index === 1 ? missingCamera : original);
  });
  const result = await requestShotRecommendation(config, params, { reviewWithAi: true });
  assert.equal(requests.length, 3); assert.deepEqual(result.shots, shots);
  for (const request of requests) {
    assert.equal(request.url, requests[0].url); assert.deepEqual(request.headers, requests[0].headers);
  }
  assert.equal(JSON.stringify(params), saved, 'planning and repairs never rewrite the saved controls');
});

test('legacy pacing-only requirements and empty preferences reach planning without a local camera template', async () => {
  for (const useLegacyRequirement of [true, false]) {
    const shots = aiShots(4);
    const expected = buildVideoCreativeDirection(useLegacyRequirement ? { pacing: { extraRequirement } } : {});
    let calls = 0;
    installBridge((payload) => {
      calls += 1;
      assert.ok(calls <= 2);
      const user = promptOf(payload, 'user');
      const data = jsonBlock(user, calls === 1 ? 'storyboard_planning_data' : 'storyboard_ai_review_data');
      assertCreativeRuleOnce(promptOf(payload, 'system')); assertActingRuleOnce(promptOf(payload, 'system'));
      assertDirection(data.planningCreativeDirection, expected);
      assert.deepEqual(data.planningCreativeDirection.cameraTerms, []);
      assert.deepEqual(data.planningCreativeDirection.lightingTerms, []);
      assert.equal(data.requiredShotCount, undefined, 'automatic planning is not assigned a local shot quota');
      if (data.pacing) assert.equal(Object.hasOwn(data.pacing, 'extraRequirement'), false);
      return response(plan(shots));
    });
    const result = await requestShotRecommendation(config, {
      durationSec: 15, workflow: 'drama', pace: 'standard', story: source,
      ...(useLegacyRequirement ? { pacing: { pace: 'standard', extraRequirement } } : {}),
    }, { reviewWithAi: true });
    assert.equal(calls, 2); assert.deepEqual(result.shots, shots, 'all four AI cameras and empty selections survive unchanged');
  }
});

test('conversion, structural repair and both H3 review repairs retain full direction and authored staging facts', async () => {
  const board = makeBoard(4);
  const before = JSON.stringify({ board, context });
  const stages: SingleSegmentPromptStage[] = [];
  const malformedCanonical = board.finalPrompt.replace(' 正在 [', ' 动作槽 [');
  let conversionCalls = 0; let chineseCalls = 0; let englishCalls = 0;
  let finalChinese = ''; let finalEnglish = '';
  const result = await generateSingleSegmentPrompt({
    board, context, converter, sourceStoryContent: source, reviewWithAi: true, clean: noLocalCleaning, now: () => 12345,
    request: async (system, user, stage) => {
      stages.push(stage);
      assertActingRuleOnce(system, stage === 'translate');
      if (stage === 'convert') {
        conversionCalls += 1;
        const data = jsonBlock(user, conversionCalls === 1 ? 'video_conversion_data' : 'video_conversion_structural_repair_data');
        assertDirection(data.creativeDirection, direction); assertDirectionOnce(user); assertCreativeRuleOnce(system);
        assertShotFacts(data, board, true); assert.equal(data.sourceStoryContent, source);
        if (conversionCalls === 2) assert.equal(data.invalidCandidate, malformedCanonical);
        return conversionCalls === 1 ? malformedCanonical : board.finalPrompt;
      }
      if (stage === 'review') {
        chineseCalls += 1;
        const data = jsonBlock(user, chineseCalls === 1 ? 'video_staging_review_data' : 'h3_format_repair_data');
        const facts = chineseCalls === 1 ? data : data.sourceContext;
        assertDirection(facts.creativeDirection, direction); assertDirectionOnce(user); assertCreativeRuleOnce(system);
        assertShotFacts(facts, board); assert.equal(facts.sourceStoryContent, source);
        if (chineseCalls === 1) {
          finalChinese = data.candidatePrompt;
          assert.equal(readH3PromptProtocol(finalChinese)?.shots.length, 4);
          return board.finalPrompt;
        }
        assert.equal(data.candidatePrompt, board.finalPrompt);
        assert.deepEqual(data.requiredProtocol, readH3PromptProtocol(finalChinese));
        return finalChinese;
      }
      englishCalls += 1;
      if (englishCalls === 1) {
        assert.equal(user, finalChinese, 'first English request translates only the exact final Chinese');
        return 'Mock English candidate without H3 sections.';
      }
      const data = jsonBlock(user, englishCalls === 2 ? 'review_data' : 'h3_format_repair_data');
      const review = englishCalls === 2 ? data : data.sourceContext;
      assertDirection(review.stagingContext.creativeDirection, direction); assertDirectionOnce(user); assertCreativeRuleOnce(system, true);
      assertShotFacts(review.stagingContext, board); assert.equal(review.sourcePrompt, finalChinese);
      if (englishCalls === 2) {
        assert.equal(data.candidateEnglishPrompt, 'Mock English candidate without H3 sections.');
        assert.match(system, /不(?:授权|以|得).*?(?:重|新增|改剧情)/u, 'context cannot authorize English replanning');
        return 'Mock reviewed English still missing its H3 sections.';
      }
      assert.deepEqual(data.requiredProtocol, readH3PromptProtocol(finalChinese));
      finalEnglish = finalChinese.replaceAll('林舟', 'Lin Zhou');
      return finalEnglish;
    },
  });
  assert.deepEqual(stages, ['convert', 'convert', 'review', 'review', 'translate', 'translate', 'translate']);
  assert.equal(result.officialPromptZh, finalChinese); assert.equal(result.targetOutput?.prompt, finalChinese);
  assert.equal(result.officialPromptEn, finalEnglish); assert.equal(result.officialPromptEnSource, finalChinese);
  assert.deepEqual(readH3PromptProtocol(finalEnglish), readH3PromptProtocol(finalChinese));
  assert.equal(hasCurrentTextApiConversion(result), true);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true); assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
  assert.deepEqual(result.shots.map(({ camera, lighting, performance }) => ({ camera, lighting, performance })),
    board.shots.map(({ camera, lighting, performance }) => ({ camera, lighting, performance })));
  assert.equal(JSON.stringify({ board, context }), before, 'repairs do not mutate source boards, full snapshots or references');
});

for (const count of [2, 4] as const) {
  test(`${count}-shot confirmed master slices only review and translate without changing shots, cuts or H3 protocol`, async () => {
    const board = makeBoard(count, direction, true);
    const before = JSON.stringify(board);
    const stages: SingleSegmentPromptStage[] = [];
    let finalChinese = ''; let englishCalls = 0;
    const result = await generateSingleSegmentPrompt({
      board, context, skipConversion: true, converter: undefined, sourceStoryContent: source,
      reviewWithAi: true, clean: noLocalCleaning, now: () => 54321,
      request: async (system, user, stage) => {
        stages.push(stage);
        assertActingRuleOnce(system, stage === 'translate');
        assert.notEqual(stage, 'convert', 'confirmed master slices cannot make another conversion request');
        if (stage === 'review') {
          const data = jsonBlock(user, 'video_staging_review_data');
          assertDirection(data.creativeDirection, direction); assertDirectionOnce(user); assertCreativeRuleOnce(system);
          assertShotFacts(data, board); assert.equal(data.segmentScope.segmentId, board.segmentId);
          assert.equal(data.segmentScope.savedSegmentSourceStoryContent, source);
          finalChinese = data.candidatePrompt;
          const protocol = readH3PromptProtocol(finalChinese);
          assert.ok(protocol); assert.equal(protocol.shots.length, count); assert.ok(protocol.references.length > 0);
          assert.deepEqual(protocol.shots, board.shots.map((shot, index) => ({
            marker: `[Shot ${index + 1}]`, cut: index ? `At 00:${shot.startSec.toFixed(3).padStart(6, '0')}` : null,
          })));
          return finalChinese;
        }
        englishCalls += 1;
        if (englishCalls === 1) assert.equal(user, finalChinese);
        else {
          const data = jsonBlock(user, 'review_data');
          assertDirection(data.stagingContext.creativeDirection, direction); assertDirectionOnce(user); assertCreativeRuleOnce(system, true);
          assertShotFacts(data.stagingContext, board); assert.equal(data.sourcePrompt, finalChinese);
        }
        return finalChinese.replaceAll('林舟', 'Lin Zhou');
      },
    });
    assert.deepEqual(stages, ['review', 'translate', 'translate']); assert.equal(englishCalls, 2);
    assert.equal(result.shotCount, count); assert.equal(result.shots.length, count);
    assert.equal(result.finalPrompt, board.finalPrompt);
    assert.deepEqual(result.shots, board.shots, 'confirmed AI-authored cameras, lighting, performance and timing survive intact');
    assert.deepEqual(readH3PromptProtocol(result.officialPromptEn || ''), readH3PromptProtocol(finalChinese));
    assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
    assert.equal(JSON.stringify(board), before);
  });
}

test('empty saved preferences remain arrays through confirmed Chinese and English reviews without default cameras', async () => {
  const board = makeBoard(4, buildVideoCreativeDirection(), true);
  const expected: VideoCreativeDirection = { stylePreset: { id: '' }, cameraTerms: [], lightingTerms: [], extraRequirement: '' };
  const stages: SingleSegmentPromptStage[] = [];
  let candidate = ''; let englishCalls = 0;
  const result = await generateSingleSegmentPrompt({
    board, context, skipConversion: true, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user, stage) => {
      stages.push(stage); assert.notEqual(stage, 'convert');
      assertActingRuleOnce(system, stage === 'translate');
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        assertCreativeRuleOnce(system);
        assertDirection(data.creativeDirection, expected); assertShotFacts(data, board);
        candidate = data.candidatePrompt;
      } else if (++englishCalls === 2) {
        const data = jsonBlock(user, 'review_data');
        assertCreativeRuleOnce(system, true);
        assertDirection(data.stagingContext.creativeDirection, expected); assertShotFacts(data.stagingContext, board);
      } else assert.equal(user, candidate);
      return candidate;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate']);
  assert.deepEqual(result.shots.map((shot) => shot.camera), board.shots.map((shot) => shot.camera));
  assert.deepEqual(result.cameraTerms, []); assert.deepEqual(result.lightingTerms, []);
  assert.equal(result.shots[1].subject, '铜铃', 'an AI-authored unoccupied prop shot is not replaced by a character close-up');
});

test('anonymous conflicting camera facts are repaired by the same Chinese AI review with no local semantic veto or extra requests', async () => {
  // These three uneven shots in 15 seconds are synthetic input, not a
  // recommendation or a default for any segment. No user story is used.
  const anonymousSource = '匿名甲走到矮台前停步，注视矮台上的方形道具，然后将其放入空盒。';
  const boundaries = [0, 4, 10, 15];
  const conflictingCamera = '摄影机位于人物正前方，正面中景，正视人物';
  const consistentCamera = '摄影机位于人物右侧，侧面中景，视向由右向左';
  const plans: AiStoryboardShotPlan[] = boundaries.slice(0, -1).map((startSec, index) => ({
    startSec, endSec: boundaries[index + 1], sourceExcerpt: anonymousSource, subject: '匿名甲',
    purpose: ['建立人物和矮台关系', '观察方形道具', '呈现放入空盒的结果'][index],
    action: ['匿名甲走到矮台前停步', '匿名甲注视矮台上的方形道具', '匿名甲将方形道具放入空盒'][index],
    space: '矮台位于房间中央，空盒位于矮台左端',
    direction: '匿名甲面朝矮台；摄影机位于人物右侧，视向由右向左',
    camera: index === 1 ? conflictingCamera : consistentCamera,
    performance: ['停步后注意转向矮台', '视线随方形道具停留，姿态自然', '视线随放置动作落向空盒，完成后自然回落'][index],
    lighting: '房间顶部漫射白光，维持原光源方位', transition: '在当前动作完成后切镜',
    sound: '环境层-[无] 动作层-[轻微同期接触声] 情绪层-[无配乐]', dialogue: '无',
    result: ['停在矮台前', '仍在矮台前注视方形道具', '方形道具已在空盒中'][index],
  }));
  const shots: VideoShot[] = plans.map((shot, index) => ({
    ...shot, id: `anonymous-synthetic-shot-${index + 1}`, index: index + 1, authoredBy: 'text-api',
    prompt: canonicalShot(shot), referenceAssetIds: [], sourceBeatIds: [], sourceLocationStatus: 'unlocated', locked: false,
  }));
  const canonical = shots.map((shot) => shot.prompt).join('\n');
  const emptyDirection = buildVideoCreativeDirection();
  const anonymousBoard: FixtureBoard = {
    id: 'anonymous-synthetic-board', sceneId: 'anonymous-synthetic-scene', sourceStoryContent: anonymousSource,
    sourceContentHash: sourceContentHash(anonymousSource), workflow: 'drama', inputMode: 'text', durationSec: 15,
    durationPreset: '15s', shotMode: 'auto', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', stylePresetId: '', ruleSetId: 'anonymous-synthetic-rule', converterPresetId: converter.id,
    globalLock: '', cameraTerms: [], lightingTerms: [], extraRequirement: '', creativeDirection: emptyDirection,
    shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
    promptTrace: {
      mode: 'text-api', shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
      convertedPromptFingerprint: sourceContentHash(canonical), modelRuleSetId: 'anonymous-synthetic-rule',
      converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1,
    },
  };
  const anonymousContext: OfficialH3ProjectContext = { characters: [], assets: [] };
  const saved = JSON.stringify(anonymousBoard);
  const stages: SingleSegmentPromptStage[] = [];
  let initialCandidate = ''; let reviewedChinese = ''; let translatedEnglish = ''; let englishCalls = 0;
  const result = await generateSingleSegmentPrompt({
    board: anonymousBoard, context: anonymousContext, skipConversion: true, converter: undefined,
    sourceStoryContent: anonymousSource, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user, stage) => {
      stages.push(stage); assert.notEqual(stage, 'convert');
      assertActingRuleOnce(system, stage === 'translate');
      if (stage === 'review') {
        assert.equal(stages.length, 1, 'the readable conflict goes directly to the same AI review, not a local semantic gate');
        assertCreativeRuleOnce(system);
        const data = jsonBlock(user, 'video_staging_review_data');
        assert.deepEqual(data.creativeDirection.cameraTerms, []); assert.deepEqual(data.creativeDirection.lightingTerms, []);
        assert.equal(data.sourceStoryContent, anonymousSource); assertShotFacts(data, anonymousBoard);
        assert.equal(data.shots[1].camera, conflictingCamera);
        assert.match(data.shots[1].direction, /摄影机位于人物右侧/u, 'both unmodified conflicting facts reach AI');
        initialCandidate = data.candidatePrompt;
        assert.ok(initialCandidate.includes(conflictingCamera), 'the actual H3 candidate exposes the conflicting camera');
        const protocol = readH3PromptProtocol(initialCandidate);
        assert.ok(protocol);
        assert.deepEqual(protocol.shots, [
          { marker: '[Shot 1]', cut: null }, { marker: '[Shot 2]', cut: 'At 00:04.000' }, { marker: '[Shot 3]', cut: 'At 00:10.000' },
        ]);
        // This replacement is the mocked model response, never production
        // repair logic. Only the request callback authors the consistent text.
        reviewedChinese = initialCandidate.replaceAll(conflictingCamera, consistentCamera);
        assert.notEqual(reviewedChinese, initialCandidate);
        assert.deepEqual(readH3PromptProtocol(reviewedChinese), protocol, 'AI fixes prose without new sections, shots, tags or cuts');
        return `\n${reviewedChinese}\n`;
      }
      englishCalls += 1;
      if (englishCalls === 1) {
        assert.equal(user, reviewedChinese, 'first English call sees only the corrected final Chinese');
        translatedEnglish = reviewedChinese.replaceAll('匿名甲', 'Synthetic Actor A');
      } else {
        assert.equal(englishCalls, 2, 'no repair or re-planning call is needed for a protocol-preserving AI edit');
        assertCreativeRuleOnce(system, true);
        const data = jsonBlock(user, 'review_data');
        assert.equal(data.sourcePrompt, reviewedChinese); assert.equal(data.candidateEnglishPrompt, translatedEnglish);
        assert.deepEqual(data.stagingContext.creativeDirection.cameraTerms, []);
        assert.deepEqual(data.stagingContext.creativeDirection.lightingTerms, []);
        assert.equal(data.stagingContext.shots[1].camera, conflictingCamera,
          'saved raw evidence is not silently rewritten; confirmed Chinese is the translation authority');
      }
      return translatedEnglish;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate']);
  assert.equal(result.officialPromptZh, reviewedChinese); assert.equal(result.targetOutput?.prompt, reviewedChinese);
  assert.equal(result.officialPromptEn, translatedEnglish); assert.equal(result.finalPrompt, canonical);
  assert.deepEqual(result.shots, shots, 'reviewed delivery never retroactively mutates the original saved plan');
  assert.deepEqual(readH3PromptProtocol(result.officialPromptZh || ''), readH3PromptProtocol(initialCandidate));
  assert.deepEqual(readH3PromptProtocol(result.officialPromptEn || ''), readH3PromptProtocol(initialCandidate));
  assert.equal(hasCurrentOfficialH3EnglishPrompt(result, anonymousContext), true);
  assert.equal(JSON.stringify(anonymousBoard), saved);
});

test('three seated actors keep body-side ownership and screen placement through Chinese AI repair and English delivery', async () => {
  const spatialSource = '三名成年同伴面朝南坐在北墙前。沈衡坐中间，陆青在沈衡自身左侧，顾白在沈衡自身右侧。陆青用右手把木盒递给沈衡左手，沈衡说：“谢谢。”然后沈衡接稳木盒，两位同伴保持座位。';
  const actorNames = ['沈衡', '陆青', '顾白'];
  const spatialCharacters: Character[] = actorNames.map((name, index) => ({
    ...character, id: `spatial-character-${index}`, name, appearance: '成年测试同伴',
    outfit: ['灰外套', '绿外套', '白外套'][index], anchor: `${name}的普通身份参考，不限定站位`,
    assetIds: [`spatial-character-image-${index}`],
  }));
  const spatialReferences: ReferenceAsset[] = spatialCharacters.map((actor, index) => ({
    ...reference, id: actor.assetIds[0], name: `${actor.name}身份图`, role: 'character', referenceRole: 'character',
    sourceEntityId: actor.id, visualAnchor: `${actor.name}的${actor.outfit}与普通身份；不规定画面左右`,
    tags: ['合成身份参考', String(index)],
  }));
  const spatialContext: OfficialH3ProjectContext = { characters: spatialCharacters, assets: spatialReferences };
  const commonSpace = '北墙在三人背后；沈衡居中，陆青坐在沈衡自身左侧的东侧座位，顾白在自身右侧的西侧座位';
  const incorrectScreenMapping = '陆青在画面左，沈衡在画面右，顾白出现在近景左边缘';
  const plans: AiStoryboardShotPlan[] = [
    {
      startSec: 0, endSec: 7, sourceExcerpt: spatialSource, purpose: '建立三人座位和递物关系', subject: '沈衡、陆青、顾白',
      action: '三人保持落座，陆青用右手把木盒递向沈衡左手，沈衡致谢',
      space: commonSpace, direction: '三人身体面朝南', performance: '递物者关注接取者，其他人保持自然倾听',
      camera: '摄影机在人物南侧面朝北，固定三人中景，顾白画面左、沈衡中、陆青右',
      lighting: '北窗的柔和自然光', transition: '递物动作继续时切近景',
      sound: '环境层-[无] 动作层-[无] 情绪层-[无配乐]', dialogue: '第5s @沈衡：“谢谢。”',
      result: '陆青的右手仍扶着木盒，沈衡的左手开始接触木盒，三人座位不变',
    },
    {
      startSec: 7, endSec: 15, sourceExcerpt: spatialSource, purpose: '同一机位的紧构图观察接取结果', subject: '沈衡、陆青',
      action: '沈衡用左手接稳木盒，陆青收回右手', space: `${commonSpace}；${incorrectScreenMapping}`,
      direction: '身体朝向和座位不变；顾白仍坐西侧但在画外', performance: '视线跟随木盒，接稳后自然回落',
      camera: '同一南侧视点收紧到沈衡和陆青，没有换座、镜像或反打',
      lighting: '原北窗自然光保持', transition: '木盒接稳后结束',
      sound: '环境层-[无] 动作层-[无] 情绪层-[无配乐]', dialogue: '无',
      result: '木盒在沈衡左手，顾白仍在画外西侧座位，陆青没有换边',
    },
  ];
  const ids = spatialReferences.map((asset) => asset.id);
  const shots: VideoShot[] = plans.map((shot, index) => ({
    ...shot, id: `spatial-shot-${index + 1}`, index: index + 1, authoredBy: 'text-api',
    prompt: canonicalShot(shot), referenceAssetIds: ids, sourceBeatIds: [], sourceLocationStatus: 'unlocated', locked: false,
  }));
  const canonical = shots.map((shot) => shot.prompt).join('\n');
  const spatialBoard: FixtureBoard = {
    ...makeBoard(2, buildVideoCreativeDirection()), id: 'spatial-three-adult-fixture', sceneId: 'spatial-room',
    sourceStoryTitle: '三名同伴落座递盒', sourceStoryContent: spatialSource, sourceContentHash: sourceContentHash(spatialSource),
    globalLock: '三名同伴沿北墙就座，未发生换座', globalReferenceAssetIds: ids, shots, finalPrompt: canonical, promptPlan: undefined,
    promptTrace: {
      mode: 'text-api', shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
      convertedPromptFingerprint: sourceContentHash(canonical), modelRuleSetId: 'fixture-rule',
      converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: ids, generatedAt: 1,
    },
  };
  const saved = JSON.stringify(spatialBoard);
  const stages: SingleSegmentPromptStage[] = [];
  let candidateChinese = ''; let reviewedChinese = ''; let deliveredEnglish = ''; let englishCalls = 0;
  const result = await generateSingleSegmentPrompt({
    board: spatialBoard, context: spatialContext, sourceStoryContent: spatialSource,
    skipConversion: true, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user, stage) => {
      stages.push(stage);
      assertActingRuleOnce(system, stage === 'translate');
      if (stage === 'review') {
        assert.equal(stages.length, 1, 'spatial ambiguity reaches the existing review, not a local side gate');
        assert.equal(system.split(SPATIAL_COORDINATE_RULE).length - 1, 1);
        assert.equal(system.split(SPATIAL_CONTINUITY_REVIEW_RULE).length - 1, 1);
        const data = jsonBlock(user, 'video_staging_review_data');
        assert.equal(data.sourceStoryContent, spatialSource);
        assert.equal(data.shots[1].space, shots[1].space);
        assert.equal(data.shots[1].direction, shots[1].direction);
        candidateChinese = data.candidatePrompt;
        assert.ok(candidateChinese.includes(incorrectScreenMapping), 'AI receives the contradictory original candidate unchanged');
        const protocol = readH3PromptProtocol(candidateChinese);
        assert.ok(protocol);
        assert.deepEqual(protocol.shots, [{ marker: '[Shot 1]', cut: null }, { marker: '[Shot 2]', cut: 'At 00:07.000' }]);
        assert.ok(protocol.references.includes('<Picture 3>') && protocol.references.includes('<Subject 3>'));
        const definitions = candidateChinese.split('\n').filter((line) => /^<Subject \d+> is /u.test(line));
        const labels = actorNames.map((name) => {
          const line = definitions.find((definition) => definition.includes(name));
          assert.ok(line, `${name} has a stable H3 subject definition`);
          return line.match(/^<Subject \d+>/u)![0];
        });
        // All spatial edits below are the mocked AI's authored response,
        // never a production-side parser, side swapper or content filter.
        const chineseBody = [
          `[Shot 1] 三人面朝南坐在北墙前，南侧摄影机朝北观察：${labels[2]}（顾白）在画面左，${labels[0]}（沈衡）在画面中，${labels[1]}（陆青）在画面右。陆青位于沈衡自身左侧的东侧座位，陆青右手把木盒递向沈衡左手；沈衡(S1)说<d>[Chinese] 谢谢。</d>，陆青与顾白安静倾听。`,
          `[Shot 2] At 00:07.000, 同一南侧视点收紧到${labels[0]}（沈衡）和${labels[1]}（陆青），沈衡在画面左、陆青在画面右；${labels[2]}（顾白）仍在原西侧座位，位于画外左侧，不进入近景。沈衡左手接稳木盒，陆青收回自己的右手，人物没有换座或镜像。`,
        ].join('\n');
        reviewedChinese = candidateChinese.replace(/detailed_description:[\s\S]*?(?=\noverall_soundscape:)/u,
          `detailed_description:\n${chineseBody}\n`);
        assert.notEqual(reviewedChinese, candidateChinese);
        assert.deepEqual(readH3PromptProtocol(reviewedChinese), protocol);
        deliveredEnglish = [
          'subject_definitions:',
          ...definitions.map((line) => line.replace(/:.*$/u, ': an adult companion; identity only, not a screen-position instruction.')),
          'summary: Three companions remain seated before the north wall while 陆青 passes a box to 沈衡.',
          `retention_analysis: ${labels.join(', ')} fully_preserved.`,
          'detailed_description:',
          `[Shot 1] All three face south, viewed by a camera looking north from the south side: ${labels[2]} (顾白) is screen-left, ${labels[0]} (沈衡) center and ${labels[1]} (陆青) screen-right. 陆青 is seated on 沈衡's own left, in the eastern seat, and extends the box with 陆青's right hand to 沈衡's left hand. 沈衡 (S1) says <d>[Chinese] 谢谢。</d> while the others listen silently.`,
          `[Shot 2] At 00:07.000, The same south-side viewpoint tightens onto ${labels[0]} (沈衡) at screen-left and ${labels[1]} (陆青) at screen-right. ${labels[2]} (顾白) remains in the original western seat, off-screen left, without entering the close view. 沈衡 receives the box in 沈衡's left hand and 陆青 withdraws 陆青's right hand. Nobody changes seats and the image is not mirrored.`,
          'overall_soundscape: N/A', 'non_diegetic_music: N/A',
        ].join('\n');
        assert.deepEqual(readH3PromptProtocol(deliveredEnglish), protocol);
        return reviewedChinese;
      }
      assert.equal(stage, 'translate');
      assert.equal(system.split(SPATIAL_TRANSLATION_RULE).length - 1, 1);
      englishCalls += 1;
      if (englishCalls === 1) {
        assert.equal(user, reviewedChinese, 'translation uses the final AI-repaired Chinese, not the stale planned sides');
      } else {
        assert.equal(englishCalls, 2);
        const data = jsonBlock(user, 'review_data');
        assert.equal(data.sourcePrompt, reviewedChinese);
        assert.equal(data.candidateEnglishPrompt, deliveredEnglish);
        assert.equal(data.stagingContext.shots[1].space, shots[1].space,
          'stale source evidence remains visible but never replaces confirmed Chinese');
      }
      return deliveredEnglish;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate'], 'no additional spatial-audit API pass is introduced');
  assert.equal(result.officialPromptZh, reviewedChinese);
  assert.equal(result.targetOutput?.prompt, reviewedChinese);
  assert.equal(result.officialPromptEn, deliveredEnglish);
  assert.ok(result.officialPromptZh?.includes('顾白）仍在原西侧座位，位于画外左侧，不进入近景'));
  assert.ok(result.officialPromptEn?.includes("on 沈衡's own left"));
  assert.ok(result.officialPromptEn?.includes('off-screen left, without entering the close view'));
  assert.deepEqual(readH3PromptProtocol(result.officialPromptZh || ''), readH3PromptProtocol(candidateChinese));
  assert.deepEqual(readH3PromptProtocol(result.officialPromptEn || ''), readH3PromptProtocol(candidateChinese));
  assert.equal(result.finalPrompt, canonical);
  assert.deepEqual(result.shots, shots, 'the original planned provenance is not locally rewritten');
  assert.equal(JSON.stringify(spatialBoard), saved);
});

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Network access is forbidden in creative-direction mock tests'); };
try {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  assert.equal(networkAttempts, 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  else delete (globalThis as unknown as { window?: unknown }).window;
}
console.log(`video creative direction pipeline: ${tests.length} full-mock cases passed; no network, project files or real API used`);
