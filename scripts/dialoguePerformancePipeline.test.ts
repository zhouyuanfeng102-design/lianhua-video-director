import assert from 'node:assert/strict';
import {
  DIALOGUE_DELIVERY_RULE,
  DIALOGUE_PERFORMANCE_TIMING_RULE,
  AUDIO_TRANSLATION_SCOPE_RULE,
} from '../src/audioPromptPolicy';
import { H3_DIALOGUE_FORMAT_RULE, readH3PromptProtocol, repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { applyOfficialH3Prompt, type OfficialH3ProjectContext } from '../src/officialPrompt';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { requestShotRecommendation } from '../src/services/llm';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from './fixtures/h3PipelineMock';
import { sourceContentHash } from '../src/sourceIntegrity';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import { VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_ACTING_CAMERA_TRANSLATION_RULE } from '../src/videoActingCameraRules';
import type { AiStoryboardShotPlan, Character, ConverterPreset, Project, ReferenceAsset, Storyboard, TextApiConfig, VideoShot } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

// Full synthetic sources, in-memory model replies and production request
// boundaries only. These tests do not claim to assess generated video/audio.
const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
type HttpPayload = { url: string; headers?: Record<string, string>; body?: string };
type HttpResult = { status: number; body: string };
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://dialogue-performance.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-real-key', model: 'mock-dialogue-performance', temperature: 0, maxTokens: 8192, vision: false,
};
const source = '三名成年人在旅店桌旁核对路线。齐简先喝一口水，咽下后放低水杯，再说：“请把地图给我。”安珂听完后停止向自己杯口吹气，回答：“好，我们从北门走。”周映拿着地图站在一旁，全程安静倾听，没有对白。';
const dialogue = ['无', '第0.2–3.5s @齐简（画内，成年男声，安珂与周映只倾听）：“请把地图给我。”', '第1–5s @安珂（画内，成年女声，齐简与周映只倾听）：“好，我们从北门走。”'];
const converter: ConverterPreset = {
  id: 'dialogue-performance-converter', name: '合成对白时序转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  systemPrompt: '对照完整原稿返回逐镜正文。', outputRules: '保留全部原话、说话人及镜界。',
  enabled: true, version: 'synthetic', updatedAt: 1,
};
const names = ['安珂', '周映', '齐简'];
const characters: Character[] = names.map((name, index) => ({
  id: `synthetic-character-${index + 1}`, name, gender: index === 0 ? '女' : '男', apparentAge: '成年', race: '人类',
  appearance: ['黑色短发', '棕色短发', '黑色长发'][index], outfit: ['蓝色外套', '灰色外套', '白色外套'][index],
  signatureProps: '', personality: '自然平静', motionHabits: '', anchor: `合成身份${index + 1}`, negativeContinuity: '',
  assetIds: [`synthetic-picture-${index + 1}`],
}));
const assets: ReferenceAsset[] = characters.map((character, index) => ({
  id: character.assetIds[0], name: `${character.name}·合成身份图`, type: 'character', role: 'character',
  referenceRole: 'character', mediaType: 'image', source: 'upload', sourceEntityId: character.id,
  sourceEntityKind: 'character', visualAnchor: `${character.name}的${character.appearance}及${character.outfit}`,
  dataUrl: 'data:image/png;base64,AA==', tags: ['synthetic-test'], createdAt: index + 1, updatedAt: 1,
}));
const contextFor = (fullReference: boolean): OfficialH3ProjectContext => ({ characters, assets: fullReference ? assets : [] });
const plans = (): AiStoryboardShotPlan[] => [
  {
    startSec: 0, endSec: 3, sourceExcerpt: source, purpose: '先完成喝水再说话', subject: '安珂、周映、齐简',
    action: '齐简喝水、咽下并将水杯放低；安珂与周映留在桌旁',
    camera: '桌子东侧三人中景，齐简嘴部清晰可见，保持同一对话轴侧', transition: '齐简完成喝水后转入对话',
    lighting: '窗边自然散射光', sound: '环境层-[无] 动作层-[无] 情绪层-[无配乐]',
    result: '齐简已经咽下水并放低杯子，尚未发话', space: '安珂在桌边左侧，周映居中，齐简在右侧',
    direction: '三人面向桌子及彼此', performance: '喝水时没有说话口型，另两人自然等待', dialogue: dialogue[0],
  },
  {
    startSec: 3, endSec: 8, sourceExcerpt: source, purpose: '让请求由齐简完整说出', subject: '安珂、周映、齐简',
    action: '齐简在喝水结束后请求地图，安珂与周映听完',
    camera: '同侧略收紧到齐简与两位听者的关系中景，声源焦点是齐简', transition: '在齐简说完后再接安珂回应',
    lighting: '保持窗边自然散射光', sound: '环境层-[无] 动作层-[无] 情绪层-[无配乐]',
    result: '齐简说完请求并等待，另两人未代说', space: '三人桌边位置不变', direction: '齐简面向安珂，安珂与周映面向齐简',
    performance: '只有齐简随自己的原话做说话口型，安珂和周映自然倾听', dialogue: dialogue[1],
  },
  {
    startSec: 8, endSec: 15, sourceExcerpt: source, purpose: '口部动作结束后再由安珂回答', subject: '安珂、周映、齐简',
    action: '安珂先停止向杯口吹气，再回答齐简，最后两秒三人保持自然无对白',
    camera: '同一轴侧关系镜头移向安珂，齐简和周映保留为听者，不靠站位改变身份', transition: '保持桌边空间后结束',
    lighting: '同一自然窗光', sound: '环境层-[无] 动作层-[无] 情绪层-[无配乐]',
    result: '安珂说完后自然收口，最后两秒无对白，周映从未发话', space: '三人仍在原桌边位置',
    direction: '安珂面向齐简，齐简与周映倾听', performance: '吹气和讲话不重叠，齐简和周映没有同步说话口型', dialogue: dialogue[2],
  },
];
const canonicalShot = (shot: AiStoryboardShotPlan): string => [
  `【${shot.startSec}s-${shot.endSec}s】 主体：@安珂、@周映、@齐简（自然克制）[朝向：${shot.direction}] 正在 [${shot.action}]（${shot.purpose}）`,
  `空间：${shot.space}`, `光影：${shot.lighting}`, `镜头：${shot.camera}`, `台词：${shot.dialogue}`, `音效：${shot.sound}`,
].join('；');
const makeBoard = (fullReference: boolean): Storyboard => {
  const shots: VideoShot[] = plans().map((shot, index) => ({
    ...shot, id: `synthetic-shot-${index + 1}`, index: index + 1, authoredBy: 'text-api', prompt: canonicalShot(shot),
    referenceAssetIds: fullReference ? assets.map((asset) => asset.id) : [], locked: false,
  }));
  const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
  return {
    id: fullReference ? 'synthetic-full-ref' : 'synthetic-no-ref', sceneId: 'synthetic-trio-scene', sourceStoryContent: source,
    sourceContentHash: sourceContentHash(source), workflow: 'drama', inputMode: fullReference ? 'text_reference' : 'text',
    durationSec: 15, durationPreset: '15s', shotMode: 'auto', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', stylePresetId: '', ruleSetId: 'synthetic-rule', converterPresetId: converter.id,
    globalLock: '同一桌边和对话轴侧，人物身份不变', shots, finalPrompt, createdAt: 1, updatedAt: 1,
    globalReferenceAssetIds: fullReference ? assets.map((asset) => asset.id) : [],
    targetModelId: 'minimax-h3',
    promptTrace: {
      mode: 'text-api', shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
      convertedPromptFingerprint: sourceContentHash(finalPrompt), modelRuleSetId: 'synthetic-rule', converterPresetId: converter.id,
      sourceDocumentIds: [], referenceAssetIds: fullReference ? assets.map((asset) => asset.id) : [], generatedAt: 1,
    },
  };
};

// A mock model owns this complete H3 answer. Picture 1 is the SECOND speaker;
// Picture 2 is silent; Picture 3 is the FIRST speaker. None of these domains
// may be renumbered merely to make their integers match.
const modelH3 = (fullReference: boolean, english = false): string => {
  const qi = fullReference ? '<Subject 3> 齐简' : '齐简';
  const an = fullReference ? '<Subject 1> 安珂' : '安珂';
  const zhou = fullReference ? '<Subject 2> 周映' : '周映';
  const shots = [
    `[Shot 1] ${english
      ? `From 0 to 3 seconds, ${qi} drinks water, swallows, then lowers his cup. The mouths of ${an} and ${zhou} follow only their natural silent actions. The east-side medium shot keeps all three places clear. No dialogue or speech mouth movements occur during this interval.`
      : `0–3秒，${qi}先喝水、咽下后放低杯子。${an}与${zhou}自然等待，三人保持桌边位置。东侧中景清楚交代三人，整个区间没有对白和说话口型。`}`,
    `[Shot 2] At 00:03.000 ${english
      ? `After the water has been swallowed, ${qi} (S1), the only speaker, speaks from local 0.2 to 3.5 seconds: <d>[Chinese] 请把地图给我。</d> His mouth is unobstructed. ${an} and ${zhou} listen without matching speech mouth movements; the camera remains on the same side.`
      : `喝水动作已结束，${qi} (S1)在本镜第0.2–3.5秒独自说：<d>[Chinese] 请把地图给我。</d> 嘴部无遮挡。${an}与${zhou}仅倾听，不做对应说话口型；摄影机保持同一轴侧。`}`,
    `[Shot 3] At 00:08.000 ${english
      ? `${an} first stops blowing over her cup. From local 1 to 5 seconds, ${an} (S2), the only speaker, answers: <d>[Chinese] 好，我们从北门走。</d> ${qi} and ${zhou} listen without speaking. No dialogue is added during the final two seconds. Voice identity stays fixed through the camera movement.`
      : `${an}先停止向杯口吹气，再于本镜第1–5秒以唯一说话人(S2)回答：<d>[Chinese] 好，我们从北门走。</d> ${qi}与${zhou}倾听而不说话。最后两秒不添加对白，声源身份不随运镜改变。`}`,
  ].join('\n\n');
  return [
    ...(fullReference ? [
      'subject_definitions: <Subject 1> is 安珂 referenced from <Picture 1>: an adult woman in a blue coat, speaking identity (S2).\n<Subject 2> is 周映 referenced from <Picture 2>: a silent adult man in a grey coat, no speaking ID.\n<Subject 3> is 齐简 referenced from <Picture 3>: an adult man in a white coat, speaking identity (S1).',
      `summary: ${english ? 'Three adults discuss the map after drinking water.' : '三名成年人喝水后核对路线，原话与身份保持。'}`,
      'retention_analysis: <Picture 1>, <Picture 2> and <Picture 3> retain visual identity only; picture order does not assign speech order.',
      `detailed_description: ${shots}`,
    ] : [`integrated_multimodal_description: ${shots}`]),
    `overall_soundscape: ${english ? 'Only the two authored lines in their stated intervals; no invented voices or names, no background music.' : '只保留两句原话及明确的发话区间，非说话者不代说，不额外喊名或添加背景音乐。'}`,
    'non_diegetic_music: N/A',
  ].join('\n\n');
};
const block = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `production request includes ${tag}`);
  return JSON.parse(match[1]);
};
const promptOf = (payload: HttpPayload, role: string): string => {
  const body = JSON.parse(payload.body || '{}') as { messages?: Array<{ role: string; content: string }> };
  return body.messages?.find((message) => message.role === role)?.content || '';
};
const response = (value: unknown): HttpResult => ({ status: 200,
  body: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }),
});
const installBridge = (request: (payload: HttpPayload) => HttpResult): void => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true,
    value: { lianhuaDesktop: { request: async (payload: HttpPayload) => request(payload) } },
  });
};
const noLocalCleaning = (): never => { throw new Error('AI-authored dialogue must not pass through a local prose rewrite'); };

test('existing planning and AI review receive timing/coverage rules without a 15-second one-shot quota', async () => {
  const expected = plans();
  const requests: HttpPayload[] = [];
  installBridge((payload) => {
    requests.push(payload);
    assert.ok(requests.length <= 2, 'valid planning adds no third semantic audit call');
    const system = promptOf(payload, 'system');
    assert.ok(DIALOGUE_DELIVERY_RULE.includes(DIALOGUE_PERFORMANCE_TIMING_RULE));
    assert.ok(system.includes(DIALOGUE_PERFORMANCE_TIMING_RULE));
    assert.ok(system.includes(VIDEO_AI_SHOT_COVERAGE_RULE));
    const data = block(promptOf(payload, 'user'), requests.length === 1 ? 'storyboard_planning_data' : 'storyboard_ai_review_data');
    assert.equal(data.sourceStory, source);
    assert.equal(data.durationSec, 15);
    assert.equal(data.requiredSegmentDurationSec, 15);
    assert.equal(data.requiredShotCount, undefined, 'segment duration is not a locally forced shot count');
    return response({ reason: '先喝水再说话，按声源交接安排三镜', breakdown: ['口部动作完成', '请求地图', '听完后回应'],
      aiReview: { status: 'passed', summary: '完整原话和口部动作时序已核对', issues: [] }, shots: expected });
  });
  const result = await requestShotRecommendation(config, {
    durationSec: 15, workflow: 'drama', pace: 'standard', story: source, requiredSegmentDurationSec: 15,
  }, { reviewWithAi: true });
  assert.equal(requests.length, 2);
  assert.equal(result.shots.length, 3);
  assert.deepEqual(result.shots, expected, 'the model keeps its unequal 3/5/7-second shot design and exact speech intervals');
  assert.deepEqual(result.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 3], [3, 8], [8, 15]]);
});

for (const fullReference of [false, true]) {
  test(`${fullReference ? 'full-reference' : 'no-reference'}: conversion, H3 review and English preserve model-owned speaker timing`, async () => {
    const board = makeBoard(fullReference); const context = contextFor(fullReference);
    const saved = JSON.stringify({ board, context });
    const chinese = modelH3(fullReference); const english = modelH3(fullReference, true);
    const reference = applyOfficialH3Prompt(board, context).officialPromptZh!;
    assert.deepEqual(readH3PromptProtocol(chinese), readH3PromptProtocol(reference), 'mock answer uses the production H3 shape and references');
    const stages: SingleSegmentPromptStage[] = [];
    let translations = 0;
    const result = await generateSingleSegmentPrompt({
      board, context, converter, sourceStoryContent: source, reviewWithAi: true, clean: noLocalCleaning, now: () => 100,
      request: async (system, user, stage) => {
        stages.push(stage);
        assert.ok(stages.length <= 4, 'no new semantic audit/API phase is appended');
        assert.ok(system.includes(DIALOGUE_PERFORMANCE_TIMING_RULE), 'all existing text phases receive the shared performance timing contract');
        if (stage === 'convert') {
          assert.equal(system.includes(H3_DIALOGUE_FORMAT_RULE), false, 'ordinary six-field conversion is not forced into H3 syntax');
          const data = block(user, 'video_conversion_data');
          assert.equal(data.sourceStoryContent, source);
          assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedDialogue), dialogue);
          assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedAction), board.shots.map((shot) => shot.action));
          return board.finalPrompt;
        }
        assert.ok(system.includes(H3_DIALOGUE_FORMAT_RULE));
        if (stage === 'review') {
          const data = block(user, 'video_staging_review_data');
          assert.equal(data.sourceStoryContent, source);
          assert.deepEqual(data.shots.map((shot: any) => [shot.startSec, shot.endSec, shot.dialogue]), board.shots.map((shot) => [shot.startSec, shot.endSec, shot.dialogue]));
          return chinese;
        }
        assert.ok(system.includes(AUDIO_TRANSLATION_SCOPE_RULE));
        assert.ok(system.includes(VIDEO_ACTING_CAMERA_TRANSLATION_RULE));
        if (++translations === 1) assert.equal(user, chinese);
        else {
          const data = block(user, 'review_data');
          assert.equal(data.sourcePrompt, chinese);
          assert.equal(data.candidateEnglishPrompt, english);
        }
        return english;
      },
    });
    assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
    assert.equal(result.officialPromptZh, chinese);
    assert.equal(result.officialPromptEn, english);
    assert.deepEqual(readH3PromptProtocol(result.officialPromptEn!), readH3PromptProtocol(chinese));
    assert.deepEqual(result.shots.map((shot) => [shot.startSec, shot.endSec, shot.action, shot.dialogue]), board.shots.map((shot) => [shot.startSec, shot.endSec, shot.action, shot.dialogue]));
    assert.equal(result.durationSec, 15); assert.equal(result.shotCount, 3);
    assert.equal(JSON.stringify({ board, context }), saved, 'saved source, identity references and original storyboard are not mutated');
    if (fullReference) {
      assert.match(result.officialPromptEn!, /<Subject 1> is 安珂 referenced from <Picture 1>:[^\n]+\(S2\)/u);
      assert.match(result.officialPromptEn!, /<Subject 3> is 齐简 referenced from <Picture 3>:[^\n]+\(S1\)/u);
      assert.match(result.officialPromptEn!, /<Subject 2> is 周映 referenced from <Picture 2>:[^\n]+no speaking ID/u);
      assert.doesNotMatch(result.officialPromptEn!, /\(S3\)/u);
    }
  });
}

test('H3 format repair carries the same speaker rules but does not become a local semantic gate', async () => {
  const chinese = modelH3(true);
  const broken = chinese.replace('overall_soundscape:', 'unexpected_soundscape:');
  let calls = 0;
  const repaired = await repairH3PromptProtocolWithAi({
    formatReferencePrompt: chinese, candidatePrompt: broken, language: '中文',
    sourceContext: { sourceStoryContent: source },
    request: async (system, user) => {
      calls++;
      assert.ok(system.includes(DIALOGUE_PERFORMANCE_TIMING_RULE));
      assert.ok(system.includes(H3_DIALOGUE_FORMAT_RULE));
      const data = block(user, 'h3_format_repair_data');
      assert.equal(data.candidatePrompt, broken);
      assert.equal(data.sourceContext.sourceStoryContent, source);
      return chinese;
    },
  });
  assert.equal(calls, 1); assert.equal(repaired, chinese);
  // Deliberately bad meaning but valid H3: the structural boundary must not
  // grow an unrequested local mouth-action classifier or extra paid review.
  const modelOwnedSemanticError = chinese.replace('喝水动作已结束', '嘴里仍含着水但模型自行写了说话');
  const retained = await repairH3PromptProtocolWithAi({
    formatReferencePrompt: chinese, candidatePrompt: modelOwnedSemanticError, language: '中文',
    request: async () => { throw new Error('A valid H3 body must not trigger a new local semantic audit'); },
  });
  assert.equal(retained, modelOwnedSemanticError);
});

test('translation of an existing H3 is source-only and keeps nonsequential Picture/S identity mapping', async () => {
  const chinese = modelH3(true); const english = modelH3(true, true);
  let calls = 0;
  const result = await translateVideoPromptToEnglish({ sourcePrompt: chinese, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user) => {
      calls++;
      assert.ok(calls <= 2);
      assert.ok(system.includes(AUDIO_TRANSLATION_SCOPE_RULE));
      assert.ok(system.includes(DIALOGUE_PERFORMANCE_TIMING_RULE));
      assert.ok(system.includes(H3_DIALOGUE_FORMAT_RULE));
      if (calls === 1) assert.equal(user, chinese);
      else assert.equal(block(user, 'review_data').sourcePrompt, chinese);
      return english;
    },
  });
  assert.equal(calls, 2); assert.equal(result, english);
  assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(chinese));
  assert.match(result, /\(S1\).*?<d>\[Chinese\] 请把地图给我。<\/d>/u);
  assert.match(result, /\(S2\).*?<d>\[Chinese\] 好，我们从北门走。<\/d>/u);
});

// This already-confirmed legacy H3 describes speech onsets only. New planning
// guidance must not turn later translation/reference operations into an
// unrequested end-time authoring or scene rescheduling pass.
const legacyStartOnlyH3 = [
  'integrated_multimodal_description: [Shot 1] <Picture 1> preserves only the opening composition. <Picture 2> identifies 安珂; <Picture 3> identifies the silent 周映; <Picture 4> identifies 齐简. After swallowing his water and lowering the cup, 齐简 (S1) starts at local 1.2s: <d>[Chinese] 请把地图给我。</d> 安珂 listens, then after stopping her own non-speech mouth action, 安珂 (S2) starts at local 4.8s: <d>[Chinese] 好，我们从北门走。</d> 周映 keeps listening naturally without speech mouth movements.',
  '[Shot 2] At 00:08.000 The three retain their places at the table and their natural silent reactions. No new speech is added.',
  'overall_soundscape: Only the two authored lines; original onset timing remains as stated.',
  'non_diegetic_music: N/A',
].join('\n\n');
const assertLegacyStartOnlyScope = (system: string): void => {
  assert.ok(system.includes(DIALOGUE_PERFORMANCE_TIMING_RULE));
  assert.ok(system.includes('旧确认稿若仅给发话起点，翻译、参考绑定和纯格式修复保持原时间表达，不借本规则补造结束时间、重新排程或改写原有动作关系；这些阶段只修复本轮操作造成的遗漏与歧义。'),
    'the actual production request must scope the complete-interval rule to new planning, not legacy source-only operations');
};

test('confirmed legacy onset-only H3 translation returns the existing body without inventing end times or extra calls', async () => {
  let calls = 0;
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: legacyStartOnlyH3, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user) => {
      calls++;
      assert.ok(calls <= 2, 'onset-only old dialogue is not a reason for an additional audit');
      assertLegacyStartOnlyScope(system);
      assert.ok(system.includes(AUDIO_TRANSLATION_SCOPE_RULE));
      if (calls === 1) assert.equal(user, legacyStartOnlyH3);
      else {
        const data = block(user, 'review_data');
        assert.equal(data.sourcePrompt, legacyStartOnlyH3);
        assert.equal(data.candidateEnglishPrompt, legacyStartOnlyH3);
      }
      // Already-English visual prose is a valid no-change translation result.
      return legacyStartOnlyH3;
    },
  });
  assert.equal(calls, 2);
  assert.equal(result, legacyStartOnlyH3, 'no new end-time, action order, voice ID or local text rewrite is inserted');
  assert.doesNotMatch(result, /(?:1\.2|4\.8)\s*(?:–|-|to)\s*\d/u);
  assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(legacyStartOnlyH3));
});

test('confirmed legacy onset-only tail/reference binding preserves exact source without AI', () => {
  const scene: ReferenceAsset = { ...assets[0], id: 'synthetic-opening', name: '合成开场图',
    type: 'location', role: 'scene', referenceRole: 'scene', sourceEntityId: undefined, sourceEntityKind: undefined };
  const project: Project = { id: 'isolated-tail-dialogue', name: '', description: '', sourceDocuments: [],
    characters, assets: [scene, ...assets], scenes: [], locations: [], props: [], storyboards: [],
    sequencePlans: [], generationTasks: [], createdAt: 1, updatedAt: 1 };
  const draft: VideoGenerationDraft = { name: '既有确认稿', backend: 'api', prompt: legacyStartOnlyH3,
    references: [{ assetId: scene.id, role: 'scene' }, ...assets.map((asset) => ({ assetId: asset.id, role: 'character' as const }))],
    parameters: { duration: 15 } };
  const before = JSON.stringify({ project, draft });
  const prepared = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(prepared.issue, undefined);
  const result = prepared.draft.prompt;
  assert.equal(result, legacyStartOnlyH3, 'unchanged bindings preserve the complete existing H3 byte for byte');
  assert.equal(JSON.stringify({ project, draft }), before, 'reference evidence and confirmed old source are read-only');
  assert.doesNotMatch(result, /(?:1\.2|4\.8)\s*(?:–|-|to)\s*\d/u);
  assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(legacyStartOnlyH3));
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is forbidden in dialogue-performance synthetic tests'); };
try {
  for (const item of tests) { await item.run(); console.log(`PASS ${item.name}`); }
  assert.equal(networkAttempts, 0);
  console.log(`dialogue performance pipeline: ${tests.length} synthetic production-boundary cases passed; no live data or API used`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as unknown as { window?: unknown }).window;
}
