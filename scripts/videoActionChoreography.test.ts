import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import { buildShots, renderShotPrompt } from '../src/promptEngine';
import { convertStoryboardDraftToFinal } from '../src/appEffects';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { getH3PromptProtocolIssue, readH3PromptProtocol, repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE, withVideoActionChoreographyScope } from '../src/videoActionChoreographyRules';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import type { AiStoryboardShotPlan, Character, ConverterPreset, ReferenceAsset, Scene, Storyboard, StylePreset, TextApiConfig } from '../src/types';

// All responses are deterministic transport fixtures. This test neither reads
// user projects nor generates videos, and cannot measure model motion quality.
type Scope = 'generation' | 'existing' | 'translation';
const rules = [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE];
const assertScope = (system: string, scope: Scope): void => {
  const selected = rules[scope === 'generation' ? 0 : scope === 'existing' ? 1 : 2];
  for (const rule of rules) assert.equal(system.split(rule).length - 1, rule === selected ? 1 : 0,
    `request receives only the ${scope} action authority, once`);
};
const block = (user: string, tag: string): any => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `missing production data envelope ${tag}`);
  return JSON.parse(match[1]);
};
const clean = (value: string): string => value.trim();
const dialogue = '停下，先听我说。';
const storyParts = [
  `沈衡左脚踏入，右拳打向陆青肩侧；陆青抬左前臂挡开，身体向右侧移。沈衡收拳，说：“${dialogue}”`,
  '陆青跨步绕到沈衡左侧，再伸右手推向沈衡上臂；沈衡退半步卸力，二人保持清醒，没有人受伤或倒地。',
];
const story = storyParts.join('');
const plannedShots: AiStoryboardShotPlan[] = storyParts.map((sourceExcerpt, index) => ({
  startSec: index * 4, endSec: (index + 1) * 4, sourceExcerpt, subject: '沈衡与陆青',
  action: index === 0 ? '沈衡左脚踏入，右拳打向陆青肩侧→陆青左前臂挡开并右移→沈衡收拳后开口'
    : '陆青跨步绕至沈衡左侧→右手推沈衡上臂→沈衡退半步卸力并重新站稳',
  purpose: '呈现原文已发生的攻防', camera: '稳定侧向中全景，可见双方脚步与前臂', transition: '沿动作结果承接',
  lighting: '日光', sound: index === 0 ? '第0.8s短促格挡接触声' : '第1s脚步与衣料声',
  result: index === 0 ? '沈衡收拳，陆青站在其右前侧' : '沈衡退半步站稳，双方未受伤',
  space: '空旷庭院，沈衡在画面左侧，陆青在右侧', direction: '双方相向，按原文移动',
  performance: '完成攻防后保持平衡', dialogue: index === 0 ? `第2.5s–3.8s @沈衡：“${dialogue}”` : '无',
}));
const style: StylePreset = { id: 'action-test-style', name: '动作测试', category: 'test', visual: '写实',
  camera: '清晰动作', lighting: '日光', sound: '剧情内声音', updatedAt: 1 };
const converter: ConverterPreset = { id: 'action-test-converter', name: '用户自定义转换器', workflow: 'all', inputMode: 'all',
  scope: 'video', enabled: true, version: 'custom', systemPrompt: '保留用户选择的视角与全部原话。', outputRules: '输出完整普通六字段。', updatedAt: 1 };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-test-key', model: 'synthetic-model', temperature: .2, maxTokens: 8192, vision: false };
const references: ReferenceAsset[] = [1, 2].map((index) => ({ id: `action-ref-${index}`, name: `人物参考${index}`,
  type: 'reference', role: 'character', mediaType: 'image', source: 'upload', dataUrl: 'data:image/png;base64,AA==',
  visualAnchor: index === 1 ? '沈衡穿灰色衣服' : '陆青穿蓝色衣服', tags: [], createdAt: 1, updatedAt: 1 }));
const makeBoard = (plan = { shots: plannedShots }, fullReference = false, shotMode: 'exact' | 'auto' = 'exact', content = story): Storyboard => {
  const assets = fullReference ? structuredClone(references) : [];
  const scene: Scene = { id: 'action-test-scene', title: '庭院', content, summary: '', characterIds: [], locationIds: [],
    propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
  const shots = buildShots({ scene, characters: [], locations: [], props: [], assets, workflow: 'action', durationSec: 8,
    shotMode, shotCount: plan.shots.length, pace: 'tight', camera: style.camera, lighting: style.lighting,
    style, extra: '', aiPlan: plan });
  shots.forEach((shot) => { shot.prompt = renderShotPrompt(shot, 8, assets, shots); });
  const canonical = shots.map((shot) => shot.prompt).join('\n');
  return { id: 'action-test-board', sceneId: scene.id, sourceStoryContent: content, workflow: 'action', inputMode: fullReference ? 'text_reference' : 'text',
    durationSec: 8, durationPreset: 'custom', shotMode, shotCount: shots.length, pace: 'tight', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: style.id, ruleSetId: '', converterPresetId: converter.id, globalLock: '身份与服装保持，实际动作按剧情推进',
    shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
    targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: '', parameters: { seed: 778899, steps: 20 }, referenceManifest: [], warnings: [], generatedAt: 1 },
    promptPlan: { canonicalPrompt: canonical, durationSec: 8, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'action',
      inputMode: fullReference ? 'text_reference' : 'text', shotIds: shots.map((shot) => shot.id), referenceAssetIds: assets.map((asset) => asset.id),
      constraints: [], trace: { ruleSetId: '', converterId: converter.id } } };
};
const h3Body = (fullReference: boolean, english = false): string => {
  const subject = fullReference ? ['<Subject 1>', '<Subject 2>'] : ['沈衡', '陆青'];
  const body = english
    ? `[Shot 1] Cinematic medium-wide shot. ${subject[0]} steps in on his left foot and drives his right fist toward ${subject[1]}'s shoulder; ${subject[1]} deflects it with her left forearm and shifts right. ${subject[0]} retracts his fist, then (S1) says at 2.5 seconds: <d>[Chinese] ${dialogue}</d>\n[Shot 2] At 00:04.000, the camera cuts to a side view. ${subject[1]} steps around to ${subject[0]}'s left and pushes his upper arm with her right hand; ${subject[0]} takes half a step back, absorbs the push and regains his balance. Both remain uninjured.`
    : `[Shot 1] 写实中全景。${subject[0]}左脚踏入，右拳打向${subject[1]}肩侧；${subject[1]}抬左前臂挡开并向右侧移。${subject[0]}收拳后于第2.5s (S1)说：<d>[Chinese] ${dialogue}</d>\n[Shot 2] At 00:04.000, 镜头切到侧景。${subject[1]}跨步绕至${subject[0]}左侧，右手推其上臂；${subject[0]}退半步卸力并恢复平衡。双方未受伤。`;
  return [
    ...(fullReference ? [
      `subject_definitions: <Subject 1> ${english ? 'is 沈衡 in' : '是沈衡，来自'} <Picture 1>. <Subject 2> ${english ? 'is 陆青 in' : '是陆青，来自'} <Picture 2>.`,
      `summary: [reference generation] ${english ? '沈衡 and 陆青 complete the authored exchange.' : '沈衡与陆青完成原文攻防。'}`,
      'retention_analysis: <Subject 1> appears in [Shot 1], [Shot 2]: fully_preserved. <Subject 2> appears in [Shot 1], [Shot 2]: fully_preserved.',
    ] : []),
    `${fullReference ? 'detailed_description' : 'integrated_multimodal_description'}: ${body}`,
    `overall_soundscape: ${english ? 'Brief forearm contact, followed by the authored footsteps and fabric movement.' : '短促前臂接触声，随后是原定脚步及衣料声。'}`,
    'non_diegetic_music: N/A',
  ].join('\n\n');
};
const envelope = (h3Prompt: string, board?: Storyboard): string => JSON.stringify({ h3Prompt,
  identityBindings: { version: 1, characters: [] }, characterParticipation: { version: 1, characters: [] },
  ...(board ? { canonicalPrompt: board.finalPrompt, shotSourceIds: board.shots.map((shot) => [shot.id]), shotMetadata: board.shots.map(() => null) } : {}) });

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const converterBefore = structuredClone(converter);
let groups = 0;
try {
  globalThis.fetch = async () => { throw new Error('Unexpected real network in action transport test'); };
  // Execute actual planning transport and materialization before the production
  // canonical -> Chinese review/checkpoint -> English stages, in both modes.
  for (const fullReference of [false, true]) {
    const planningRequests: Array<{ system: string; user: string }> = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
      request: async (payload: { body?: string }) => {
        const messages = JSON.parse(payload.body!).messages;
        const system = messages.find((message: any) => message.role === 'system').content;
        const user = messages.find((message: any) => message.role === 'user').content;
        assertScope(system, 'generation');
        const data = block(user, planningRequests.length ? 'storyboard_ai_review_data' : 'storyboard_planning_data');
        assert.equal(data.sourceStory, story); assert.equal(data.durationSec, 8);
        assert.equal(data.requiredShotCount, fullReference ? undefined : 2);
        if (planningRequests.length) assert.deepEqual(JSON.parse(data.originalStoryboardResponse).shots, plannedShots);
        planningRequests.push({ system, user });
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reason: '按原文攻防安排', shots: plannedShots }) } }] }) };
      },
    } } });
    const plan = await requestShotRecommendation(config, { durationSec: 8, story, workflow: 'action', pace: 'tight',
      ...(fullReference ? {} : { requiredShotCount: 2 }) }, { reviewWithAi: true });
    assert.equal(planningRequests.length, 2, 'the pre-existing planning/review calls gain no extra stage');
    assert.deepEqual(plan.shots, plannedShots);
    const board = makeBoard(plan, fullReference, fullReference ? 'auto' : 'exact');
    const before = structuredClone(board);
    const context = { assets: fullReference ? references : [], characters: [] };
    const zh = h3Body(fullReference); const en = h3Body(fullReference, true);
    const stages: SingleSegmentPromptStage[] = [];
    let checkpoint: Storyboard | undefined;
    const result = await generateSingleSegmentPrompt({ board, context, converter, reviewWithAi: true, clean, now: () => 123,
      onQualifiedChinese: (value) => { checkpoint = structuredClone(value); assert.equal(value.officialPromptZh, zh); assert.equal(value.officialPromptEn, ''); },
      request: async (system, user, stage) => {
        stages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'generation');
        if (stage === 'convert') {
          const data = block(user, 'video_conversion_data');
          assert.equal(data.sourceStoryContent, story);
          assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.plannedAction, shot.plannedResult]), board.shots.map((shot) => [shot.action, shot.result]));
          assert.deepEqual(block(user, 'current_reference_data').currentReferences.map((ref: any) => ref.id), context.assets.map((asset) => asset.id));
          return board.finalPrompt;
        }
        assertH3DescriptionLanguage(system, stage === 'review' ? '中文' : '英文');
        if (stage === 'review') {
          const data = block(user, 'video_staging_review_data');
          assert.equal(data.sourceStoryContent, story); assert.equal(data.taskAuthority, 'current-segment-staging-replan');
          assert.equal(data.shotMode, board.shotMode);
          return envelope(zh, board);
        }
        assert.ok(checkpoint, 'Chinese must be saved before English starts');
        const sourcePrompt = user.includes('<review_data>') ? block(user, 'review_data').sourcePrompt
          : user.includes('<translation_identity_data>') ? block(user, 'translation_identity_data').sourcePrompt : user;
        assert.equal(sourcePrompt, zh, 'translation and its existing review use the same complete Chinese execution text');
        return envelope(en);
      } });
    assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
    assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en); assert.equal(result.officialPromptEnSource, zh);
    assert.equal(result.finalPrompt, board.finalPrompt); assert.ok(hasCurrentOfficialH3Prompt(result, context));
    assert.equal(result.durationSec, 8); assert.equal(result.shotMode, board.shotMode);
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.referenceAssetIds]), board.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.referenceAssetIds]));
    assert.equal(result.targetOutput?.parameters.seed, 778899);
    assert.deepEqual(readH3PromptProtocol(zh), readH3PromptProtocol(en));
    assert.equal(getH3PromptProtocolIssue(en, zh), undefined);
    assert.deepEqual(readH3PromptProtocol(zh)?.sections.length, fullReference ? 6 : 3);
    for (const body of [result.finalPrompt, zh, en]) assert.doesNotMatch(body, /VIDEO_ACTION_CHOREOGRAPHY|combat_plan|action_sequence|negative_prompt/u);
    assert.ok(en.includes(`(S1) says at 2.5 seconds: <d>[Chinese] ${dialogue}</d>`));
    assert.deepEqual(board, before, 'generation preserves the input snapshot');

    // Existing confirmed canonical master slices may be reviewed and translated,
    // but cannot inherit new choreography permission or rerun conversion.
    const existingBefore = structuredClone(result); const reuseStages: SingleSegmentPromptStage[] = [];
    let confirmedCandidate = '';
    const reused = await generateSingleSegmentPrompt({ board: result, context, converter, skipConversion: true, reviewWithAi: true, clean,
      request: async (system, user, stage) => {
        reuseStages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'existing');
        assert.notEqual(stage, 'convert');
        if (stage === 'review') { const data = block(user, 'video_staging_review_data'); assert.equal(data.taskAuthority, 'preserve-confirmed-schedule'); confirmedCandidate = data.candidatePrompt; return envelope(confirmedCandidate); }
        return envelope(en);
      } });
    assert.deepEqual(reuseStages, ['review', 'translate', 'translate']);
    assert.equal(reused.finalPrompt, result.finalPrompt); assert.equal(reused.officialPromptZh, confirmedCandidate); assert.equal(reused.officialPromptEn, en);
    assert.deepEqual(reused.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]));
    assert.deepEqual(result, existingBefore, 'reuse never mutates the saved input');
    const englishOnlyStages: SingleSegmentPromptStage[] = [];
    const englishOnly = await generateSingleSegmentPrompt({ board: result, context, converter, mode: 'translate-english', reviewWithAi: true, clean,
      request: async (system, user, stage) => { englishOnlyStages.push(stage); assertScope(system, 'translation');
        const data = user.includes('<review_data>') ? block(user, 'review_data') : block(user, 'translation_identity_data');
        assert.equal(data.sourcePrompt, zh); return envelope(en); } });
    assert.deepEqual(englishOnlyStages, ['translate', 'translate']);
    assert.equal(englishOnly.officialPromptZh, zh); assert.equal(englishOnly.finalPrompt, result.finalPrompt);
    assert.deepEqual(englishOnly.shots, result.shots); assert.deepEqual(result, existingBefore);
    groups += 2;
  }

  // A custom preset containing an embedded generation block must lose that
  // permission at an existing-update boundary without editing the preset.
  const embeddedConverter = { ...converter, systemPrompt: `${converter.systemPrompt}\n\n${VIDEO_ACTION_CHOREOGRAPHY_RULE}` };
  const refreshBoard = makeBoard(); const refreshBefore = structuredClone(refreshBoard);
  let refreshCalls = 0;
  const refreshed = await convertStoryboardDraftToFinal({ draft: refreshBoard, converter: embeddedConverter,
    purpose: 'reference-refresh', clean, request: async (system, user) => {
      refreshCalls++; assertScope(system, 'existing'); assert.ok(system.includes(converter.systemPrompt));
      assert.equal(block(user, 'video_conversion_data').sourceStoryContent, story); return refreshBoard.finalPrompt;
    } });
  assert.equal(refreshCalls, 1); assert.equal(refreshed.finalPrompt, refreshBoard.finalPrompt); assert.deepEqual(refreshBoard, refreshBefore);
  assert.ok(embeddedConverter.systemPrompt.includes(VIDEO_ACTION_CHOREOGRAPHY_RULE));
  groups++;

  // Ordinary dialogue and non-combat close interaction are accepted unchanged.
  // Private facts are only those actually selected by a shot, not a combat
  // trigger or authorization to display unselected dossiers.
  for (const { privateSelection, isStill } of [{ privateSelection: false, isStill: false }, { privateSelection: true, isStill: false }, { privateSelection: false, isStill: true }]) {
    const neutralStory = isStill ? '沈衡与陆青静止等候，保持原站姿，不做其他动作，也没有对白。'
      : '沈衡扶住陆青的手背，帮助她站稳，随后松手，说：“谢谢。”二人平静交谈，没有冲突。';
    const board = makeBoard({ shots: plannedShots.map((shot) => ({ ...shot, sourceExcerpt: neutralStory, subject: '沈衡与陆青',
      action: isStill ? '保持原站姿静止等候' : '扶住手背帮助站稳→松手→平静交谈', result: isStill ? '静止等候' : '双方站稳，手已松开',
      purpose: '呈现普通原文事件', performance: isStill ? '原站姿静止等候' : '平静交谈', direction: '面对对方',
      camera: '固定中景', sound: isStill ? '无' : '第1s手背接触的衣料轻响',
      dialogue: isStill ? '无' : '第2.5s @沈衡：“谢谢。”' })) }, false, 'exact', neutralStory);
    const actor: Character = { id: 'neutral-adult', name: '陆青', gender: '女', apparentAge: '成年', race: '人类', appearance: '蓝衣',
      outfit: '长袖外套', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
      nsfwProfile: { fullBody: '手背有浅色圆形胎记。' } };
    if (privateSelection) board.shots.forEach((shot) => { shot.visiblePrivatePartsByCharacter = { [actor.id]: ['full-body'] }; });
    const before = structuredClone(board); let calls = 0;
    const result = await convertStoryboardDraftToFinal({ draft: board, converter, characters: [actor], clean,
      request: async (system, user) => {
        calls++; assertScope(system, 'generation');
        assert.match(system, /普通交谈、轻微动作.*照原意保留/u);
        const data = block(user, 'video_conversion_data'); assert.equal(data.sourceStoryContent, neutralStory);
        for (const shot of data.shotEvidence) assert.equal(shot.selectedPrivateFacts.length, privateSelection ? 1 : 0);
        if (privateSelection) assert.equal(data.shotEvidence[0].selectedPrivateFacts[0].profile.fullBody, actor.nsfwProfile?.fullBody);
        return board.finalPrompt;
      } });
    assert.equal(calls, 1); assert.equal(result.finalPrompt, board.finalPrompt); assert.deepEqual(board, before);
    assert.doesNotMatch(result.finalPrompt, /激烈攻防|拳击|格挡|摔投/u);
    groups++;
  }

  // Existing protocol-repair calls retain content permission and format in both
  // H3 modes. A missing section is repaired once; no action-improvement call.
  for (const fullReference of [false, true]) {
    const expected = h3Body(fullReference); const damaged = expected.replace(/^non_diegetic_music: N\/A$/mu, '');
    let repairCalls = 0;
    const repaired = await repairH3PromptProtocolWithAi({ formatReferencePrompt: expected, candidatePrompt: damaged, language: '中文',
      sourceContext: { sourcePrompt: expected, sourceStoryContent: story }, request: async (system, user) => {
        repairCalls++; assertScope(system, 'existing'); assertH3DescriptionLanguage(system, '中文');
        const data = block(user, 'h3_format_repair_data'); assert.equal(data.sourceContext.sourcePrompt, expected);
        assert.equal(data.candidatePrompt, damaged.trim()); assert.deepEqual(data.requiredProtocol.references, readH3PromptProtocol(expected)?.references);
        return expected;
      } });
    assert.equal(repairCalls, 1); assert.equal(repaired, expected); assert.equal(getH3PromptProtocolIssue(repaired, expected), undefined);
    groups++;
  }
  // Malformed JSON uses the existing transport recovery, with preservation
  // authority even though the first review was allowed to direct a new draft.
  {
    const board = makeBoard(); const before = structuredClone(board); let reviews = 0;
    const stages: SingleSegmentPromptStage[] = [];
    const result = await generateSingleSegmentPrompt({ board, context: { assets: [], characters: [] }, converter, reviewWithAi: true, clean,
      request: async (system, user, stage) => {
        stages.push(stage);
        if (stage === 'convert') { assertScope(system, 'generation'); return board.finalPrompt; }
        if (stage === 'review') {
          reviews++; assertScope(system, reviews === 1 ? 'generation' : 'existing');
          if (reviews === 1) return '{unreadable JSON';
          const data = block(user, 'h3_staging_delivery_repair_data'); assert.equal(data.candidateDelivery, '{unreadable JSON');
          assert.equal(data.sourceStoryContent, story); return envelope(h3Body(false), board);
        }
        assertScope(system, 'translation'); return envelope(h3Body(false, true));
      } });
    assert.deepEqual(stages, ['convert', 'review', 'review', 'translate', 'translate']);
    assert.equal(result.officialPromptZh, h3Body(false)); assert.equal(result.officialPromptEn, h3Body(false, true));
    assert.equal(result.finalPrompt, board.finalPrompt); assert.deepEqual(board, before);
    groups++;
  }
  // Helper strips only complete owned blocks. Literal custom additions remain
  // untouched, even if they mention the same marker as on-screen subject text.
  const custom = '用户自定义：屏幕上显示 VIDEO_ACTION_CHOREOGRAPHY_V1；保留我的构图。';
  const mixed = [custom, ...rules, VIDEO_ACTION_CHOREOGRAPHY_RULE].join('\n\n');
  const translatedScope = withVideoActionChoreographyScope(mixed, 'translation');
  assertScope(translatedScope, 'translation'); assert.ok(translatedScope.includes(custom));
  assert.deepEqual(converter, converterBefore);
  console.log(`Video action choreography: ${groups} targeted groups passed (production request scopes, planning/materialization, exact/auto, 3/6-field H3, Chinese checkpoint/English, confirmed reuse, selected private facts and format repair; synthetic mocks only, no video-quality claim).`);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  globalThis.fetch = originalFetch;
}
