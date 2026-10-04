import assert from 'node:assert/strict';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import { sourceContentHash } from '../src/sourceIntegrity';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { H3_CLIP_TIME_RULE, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { H3_IDENTITY_BINDINGS_RULE, normalizeH3IdentityBindings, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { H3_STAGING_DELIVERY_RULE, synchronizeH3StagingDelivery } from '../src/h3StagingDelivery';
import { readH3StagingShotMetadata, type H3StagingShotMetadata } from '../src/h3StagingMetadata';
import { VIDEO_LOCAL_TIME_RULE } from '../src/videoConversionRules';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import type { Character, ConverterPreset, H3IdentityBindings, Storyboard, VideoShot } from '../src/types';

const people: Character[] = [
  ['an', '安珂', '蓝外套'], ['qi', '齐简', '白外套'], ['zhou', '周映', '灰外套'],
].map(([id, name, outfit]) => ({ id, name, outfit, gender: '', apparentAge: '成年人', race: '人类', appearance: '短发',
  signatureProps: '', personality: '', motionHabits: '', anchor: outfit, negativeContinuity: '', assetIds: [] }));
const context = { characters: people, assets: [] };
const source = '齐简放下杯子，说“请把地图给我。”安珂递出地图，回答“好，我们从北门走。”周映保持安静。';
const canonical = (cuts: number[]) => cuts.slice(0, -1).map((start, index) => [
  `【${start}s-${cuts[index + 1]}s】主体：@齐简、@安珂、@周映 正在 [${index === 0 ? '放下杯子' : '交接地图并确认路线'}]`,
  '空间：桌边', '光影：日光', '镜头：同轴侧中景',
  index === 0 ? '台词：无' : '台词：齐简 第0.2–2秒：“请把地图给我。”；安珂 第2.2–5秒：“好，我们从北门走。”',
  '音效：环境层-[无] 动作层-[第0.1s纸张声] 情绪层-[无]',
].join('；')).join('\n');
const original = canonical([0, 11.5, 15]);
const revised = canonical([0, 5, 15]);
const shots: VideoShot[] = [0, 11.5].map((startSec, index) => ({
  id: `shot-${index}`, index: index + 1, startSec, endSec: [11.5, 15][index], subject: '齐简', action: '旧动作',
  purpose: '确认路线', camera: '旧机位', lighting: '旧光线', sound: '旧时间', result: '旧结果', transition: '',
  dialogue: '旧台词时窗', space: '旧空间', performance: '旧表演', referenceAssetIds: [], locked: false,
  prompt: original.split('\n')[index], sourceExcerpt: source, sourceLocationStatus: 'located', authoredBy: 'text-api',
}));
const board: Storyboard = {
  id: 'synthetic-speaker-retiming', sceneId: 'scene', sourceStoryContent: source,
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
  converterPresetId: 'converter', globalLock: '', finalPrompt: original, shots, createdAt: 1, updatedAt: 1,
  promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(original),
    modelRuleSetId: '', converterPresetId: 'converter', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1 },
  promptPlan: { canonicalPrompt: original, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    workflow: 'drama', inputMode: 'text', shotIds: shots.map((shot) => shot.id), referenceAssetIds: [], constraints: [],
    trace: { ruleSetId: '', converterId: 'converter' } },
};
const converter: ConverterPreset = { id: 'converter', name: '测试', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true,
  version: 'test', systemPrompt: '整理六字段', outputRules: '保留格式', updatedAt: 1 };
const anchors = ['Identity: 齐简 (S1), 白外套成年人。', 'Identity: 安珂 (S2), 蓝外套成年人。', 'Identity: 周映, 灰外套成年人。'];
const bindings: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'qi', name: '齐简', speakerToken: '(S1)', referenceAnchor: anchors[0] },
  { characterId: 'an', name: '安珂', speakerToken: '(S2)', referenceAnchor: anchors[1] },
  { characterId: 'zhou', name: '周映', referenceAnchor: anchors[2] },
] };
const enBindings: H3IdentityBindings = { version: 1, characters: bindings.characters.map((item) => ({
  ...item, referenceAnchor: item.referenceAnchor.replace('成年人。', 'adult.'),
})) };
const sync = synchronizeH3StagingDelivery(board, revised, [['shot-0'], ['shot-1']]);
const reference = applyOfficialH3Prompt(sync, context).officialPromptZh!;
const zh = reference.replace('[Shot 1]', `[Shot 1] ${anchors.join(' ')}`)
  .replace('[Shot 2] At 00:05.000', '[Shot 2] At 00:05.000 本段5.2–7秒齐简 (S1)画内说：<d>[Chinese] 请把地图给我。</d> 本段7.2–10秒安珂 (S2)画内说：<d>[Chinese] 好，我们从北门走。</d> 周映不代说。');
const en = enBindings.characters.reduce((text, item, index) => text.replace(anchors[index], item.referenceAnchor), zh);
const delivery = { canonicalPrompt: revised, h3Prompt: zh, identityBindings: bindings, shotSourceIds: [['shot-0'], ['shot-1']] };
const emptyMetadata: H3StagingShotMetadata = { sourceBeatIds: [], sourceExcerpt: '', sourceLocationStatus: 'unlocated',
  nsfwContinuity: null, visiblePrivatePartsByCharacter: {} };
const json = (user: string, tag: string) => JSON.parse(user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))![1]);
let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); count += 1; console.log(`PASS ${name}`); };

await test('metadata deserialization copies only explicit fields without guessing silent speakers', () => {
  assert.deepEqual(normalizeH3IdentityBindings(bindings), bindings);
  assert.notEqual(normalizeH3IdentityBindings(bindings), bindings);
  assert.equal(normalizeH3IdentityBindings(undefined), undefined);
  assert.equal(normalizeH3IdentityBindings({ version: 1, characters: [{ characterId: 'x', name: 'X', referenceAnchor: 'X', speakerToken: '(S0)' }] }), undefined);
  assert.equal(normalizeH3IdentityBindings(Object.create({ version: 1, characters: [] })), undefined);
  assert.equal(normalizeH3IdentityBindings(bindings)?.characters[2].speakerToken, undefined);
  assert.equal(readH3DeliveryEnvelope(zh).envelope, false);
});

await test('source-location metadata accepts only literal JSON statuses without coercing arrays or objects', () => {
  for (const sourceLocationStatus of [['located'], ['unlocated'], [], null, 0, {}, { toString: () => 'located' }]) {
    assert.throws(() => readH3StagingShotMetadata([{ ...emptyMetadata, sourceLocationStatus }]), /shotMetadata/u);
  }
  assert.equal(readH3StagingShotMetadata([{ ...emptyMetadata }])![0]!.sourceLocationStatus, 'unlocated');
  const located = { ...emptyMetadata, sourceLocationStatus: 'located', sourceStart: 0, sourceEnd: 1 };
  assert.deepEqual(readH3StagingShotMetadata([located]), [located]);
});

await test('AI six-field schedule synchronizes all shot metadata and preserves fixed 15 seconds', () => {
  assert.deepEqual(sync.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 5], [5, 15]]);
  assert.deepEqual(sync.shots.map((shot) => shot.id), board.shots.map((shot) => shot.id));
  assert.match(sync.shots[1].dialogue!, /第0.2–2秒/u);
  assert.equal(sync.shots[1].sound, '环境层-[无] 动作层-[第0.1s纸张声] 情绪层-[无]');
  assert.equal(sync.shots[1].camera, '同轴侧中景'); assert.equal(sync.shots[1].result, '');
  assert.equal(sync.shots[1].performance, undefined);
  assert.equal(sync.finalPrompt, sync.promptPlan!.canonicalPrompt);
  assert.equal(sync.durationSec, 15);
});

await test('only auto shot mode may alter shot count; new unmapped shots never inherit private/source facts', () => {
  assert.throws(() => synchronizeH3StagingDelivery(board, canonical([0, 3, 8, 15])), /用户指定镜数/u);
  const result = synchronizeH3StagingDelivery({ ...board, shotMode: 'auto' }, canonical([0, 3, 8, 15]),
    [['shot-0'], ['shot-1'], []], [null, null, emptyMetadata]);
  assert.equal(result.shots.length, 3); assert.equal(result.shotCount, board.shotCount); assert.equal(result.recommendedShotCount, 3);
  const automatic = synchronizeH3StagingDelivery({ ...board, shotMode: 'auto', shotCount: undefined }, canonical([0, 3, 8, 15]),
    [['shot-0'], ['shot-1'], []], [null, null, emptyMetadata]);
  assert.equal(automatic.shotCount, undefined, 'AI shot count never becomes a user exact-count configuration');
  assert.equal(automatic.recommendedShotCount, 3);
  assert.equal(result.shots[2].sourceExcerpt, ''); assert.deepEqual(result.shots[2].visiblePrivatePartsByCharacter, {});
  assert.throws(() => synchronizeH3StagingDelivery(board, canonical([0, 5, 16])), /总时长/u);
});

await test('many-to-one merging requires explicit AI scope/continuity instead of clearing or unioning old metadata', () => {
  const scoped: Storyboard = { ...board, shotMode: 'auto', shots: board.shots.map((shot, index) => ({
    ...shot, sourceBeatIds: [`beat-${index}`], nsfwContinuity: { clothingState: `synthetic-state-${index}` },
    visiblePrivatePartsByCharacter: { [index ? 'an' : 'qi']: ['full-body'] },
  })) };
  assert.throws(() => synchronizeH3StagingDelivery(scoped, canonical([0, 15]), [['shot-0', 'shot-1']]), /缺少shotMetadata/u);
  const aiMetadata: H3StagingShotMetadata = { sourceBeatIds: ['beat-0', 'beat-1'], sourceExcerpt: 'synthetic merged evidence',
    sourceLocationStatus: 'unlocated', nsfwContinuity: { clothingState: 'synthetic AI merged state' },
    visiblePrivatePartsByCharacter: { qi: ['full-body'] } };
  const parsed = readH3DeliveryEnvelope(JSON.stringify({ canonicalPrompt: canonical([0, 15]), h3Prompt: zh,
    shotSourceIds: [['shot-0', 'shot-1']], shotMetadata: [aiMetadata] }));
  const result = synchronizeH3StagingDelivery(scoped, parsed.canonicalPrompt!, parsed.shotSourceIds, parsed.shotMetadata);
  assert.deepEqual(result.shots[0].sourceBeatIds, aiMetadata.sourceBeatIds);
  assert.deepEqual(result.shots[0].nsfwContinuity, aiMetadata.nsfwContinuity);
  assert.deepEqual(result.shots[0].visiblePrivatePartsByCharacter, { qi: ['full-body'] }, 'never union the other source scope');
  assert.equal(result.shots[0].sourceExcerpt, aiMetadata.sourceExcerpt);
  assert.throws(() => synchronizeH3StagingDelivery(scoped, revised), /缺少shotSourceIds/u);
  assert.throws(() => synchronizeH3StagingDelivery(scoped, revised, [['unknown'], ['shot-1']]), /未知或重复/u);
});

await test('one-to-many splitting requires separate AI choices; one-to-one keeps the old chosen scope', () => {
  const scoped: Storyboard = { ...board, shotMode: 'auto', shots: board.shots.map((shot, index) => ({
    ...shot, sourceBeatIds: [`beat-${index}`], nsfwContinuity: { clothingState: `synthetic-state-${index}` },
    visiblePrivatePartsByCharacter: { qi: ['full-body'] },
  })) };
  const split = canonical([0, 3, 8, 15]); const sources = [['shot-0'], ['shot-0'], ['shot-1']];
  assert.throws(() => synchronizeH3StagingDelivery(scoped, split, sources), /缺少shotMetadata/u);
  const first: H3StagingShotMetadata = { ...emptyMetadata, sourceBeatIds: ['beat-0'], sourceExcerpt: 'synthetic first phase',
    nsfwContinuity: { clothingState: 'synthetic selected phase' }, visiblePrivatePartsByCharacter: { qi: ['full-body'] } };
  const result = synchronizeH3StagingDelivery(scoped, split, sources, [first, emptyMetadata, null]);
  assert.deepEqual(result.shots[0].visiblePrivatePartsByCharacter, first.visiblePrivatePartsByCharacter);
  assert.deepEqual(result.shots[1].visiblePrivatePartsByCharacter, {}, 'second phase explicitly clears scope, never copies first phase');
  assert.equal(result.shots[1].nsfwContinuity, undefined);
  assert.deepEqual(result.shots[2].visiblePrivatePartsByCharacter, scoped.shots[1].visiblePrivatePartsByCharacter);
  assert.deepEqual(result.shots[2].nsfwContinuity, scoped.shots[1].nsfwContinuity);
  assert.deepEqual(result.shots[2].sourceBeatIds, ['beat-1']);
});

await test('initial uses same four existing API stages and saves canonical, H3 and both identity maps atomically', async () => {
  const before = JSON.stringify(board); const stages: SingleSegmentPromptStage[] = []; let translations = 0;
  const result = await generateSingleSegmentPrompt({ board, context, converter, clean: (text) => text, reviewWithAi: true,
    request: async (system, user, stage) => {
      stages.push(stage);
      if (stage === 'convert') { assert.ok(!system.includes(H3_CLIP_TIME_RULE)); return original; }
      assert.ok(system.includes(H3_CLIP_TIME_RULE)); assert.ok(!system.includes(VIDEO_LOCAL_TIME_RULE));
      if (stage === 'review') {
        assert.ok(system.includes(H3_STAGING_DELIVERY_RULE)); assert.ok(system.includes(H3_IDENTITY_BINDINGS_RULE));
        assert.equal(json(user, 'video_staging_review_data').taskAuthority, 'current-segment-staging-replan');
        return JSON.stringify(delivery);
      }
      if (++translations === 1) assert.equal(json(user, 'translation_identity_data').sourcePrompt, zh);
      else {
        const data = json(user, 'review_data');
        assert.equal(data.sourcePrompt, zh); assert.equal(data.stagingContext.canonicalPrompt, revised);
        assert.equal(data.stagingContext.shots[1].startSec, 5); assert.deepEqual(data.sourceIdentityBindings, bindings);
      }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
  assert.equal(result.finalPrompt, revised); assert.equal(result.shots[1].startSec, 5);
  assert.equal(hasCurrentTextApiConversion(result), true);
  assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en);
  assert.deepEqual(result.h3IdentityBindings, bindings); assert.deepEqual(result.h3IdentityBindingsEn, enBindings);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  assert.deepEqual(readH3PromptProtocol(result.officialPromptZh!), readH3PromptProtocol(result.officialPromptEn!));
  assert.equal(JSON.stringify(board), before);
});

await test('explicit dialogue repair bypasses converter even for confirmed old source and reuses review', async () => {
  const saved = applyOfficialH3Prompt(board, context); const stages: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({ board: saved, context, purpose: 'dialogue-repair', skipConversion: true,
    clean: (text) => text, request: async (system, _user, stage) => {
      stages.push(stage); assert.notEqual(stage, 'convert');
      if (stage === 'review') { assert.ok(system.includes(H3_STAGING_DELIVERY_RULE)); return JSON.stringify(delivery); }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.deepEqual(stages, ['review', 'translate', 'translate']);
  assert.equal(result.finalPrompt, revised); assert.equal(result.shots[1].startSec, 5);
});

await test('an old English H3 candidate does not change Chinese delivery authority or overwrite its saved result during translation', async () => {
  const chineseBody = [
    'integrated_multimodal_description: [Shot 1] 齐简放下杯子，安珂拿起地图，周映安静等候。',
    '[Shot 2] At 00:05.000, 齐简 (S1)说：<d>[Chinese] 请把地图给我。</d> 安珂递出地图并回答：<d>[Chinese] 好，我们从北门走。</d> 周映闭口倾听。',
    'overall_soundscape: N/A', 'non_diegetic_music: N/A',
  ].join('\n');
  const englishBody = [
    'integrated_multimodal_description: [Shot 1] 齐简 puts down the cup, 安珂 picks up the map, and 周映 waits quietly.',
    '[Shot 2] At 00:05.000, 齐简 (S1) says <d>[Chinese] 请把地图给我。</d> 安珂 hands over the map and replies <d>[Chinese] 好，我们从北门走。</d> 周映 listens without speaking.',
    'overall_soundscape: N/A', 'non_diegetic_music: N/A',
  ].join('\n');
  const saved = applyOfficialH3Prompt(sync, context);
  saved.officialPromptZh = englishBody;
  saved.targetOutput = { ...saved.targetOutput!, prompt: englishBody };
  const before = JSON.stringify(saved);
  const stages: SingleSegmentPromptStage[] = [];
  let englishRequests = 0;
  const result = await generateSingleSegmentPrompt({
    board: saved, context, purpose: 'dialogue-repair', reviewWithAi: true, clean: (text) => text,
    request: async (system, user, stage) => {
      stages.push(stage);
      assertH3DescriptionLanguage(system, stage === 'review' ? '中文' : '英文');
      if (stage === 'review') {
        assert.equal(json(user, 'video_staging_review_data').candidatePrompt, englishBody,
          'the existing English candidate remains evidence instead of becoming language authority');
        return JSON.stringify({ canonicalPrompt: revised, h3Prompt: chineseBody, shotSourceIds: [['shot-0'], ['shot-1']] });
      }
      englishRequests += 1;
      assert.equal(englishRequests === 1 ? user : json(user, 'review_data').sourcePrompt, chineseBody,
        'translation and its existing review receive the newly delivered Chinese, never the stale English candidate');
      return englishBody;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate'], 'language selection adds no detector or extra model request');
  assert.equal(result.officialPromptEnError || '', '');
  assert.equal(result.officialPromptZh, chineseBody);
  assert.equal(result.targetOutput?.prompt, chineseBody);
  assert.equal(result.officialPromptEn, englishBody);
  assert.equal(result.officialPromptEnSource, chineseBody);
  for (const text of [result.officialPromptZh!, result.officialPromptEn!]) {
    assert.ok(text.includes('<d>[Chinese] 请把地图给我。</d>'));
    assert.ok(text.includes('<d>[Chinese] 好，我们从北门走。</d>'));
  }
  assert.equal(JSON.stringify(saved), before, 'request processing does not mutate a saved legacy result');
});

await test('confirmed reused slice does not acquire replanning authority and legacy pure H3 remains compatible', async () => {
  let expected = ''; const calls: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({ board, context, skipConversion: true, reviewWithAi: true,
    clean: (text) => text, request: async (system, user, stage) => {
      calls.push(stage);
      if (stage === 'review') {
        assert.ok(!system.includes(H3_STAGING_DELIVERY_RULE));
        const data = json(user, 'video_staging_review_data');
        assert.equal(data.taskAuthority, 'preserve-confirmed-schedule'); expected = data.candidatePrompt; return expected;
      }
      return expected;
    } });
  assert.equal(result.finalPrompt, original); assert.equal(result.shots[1].startSec, 11.5);
  assert.equal(result.h3IdentityBindings, undefined); assert.deepEqual(calls, ['review', 'translate', 'translate']);
});

await test('malformed staging JSON is repaired through bounded same-stage retries and never saved partially', async () => {
  let reviews = 0;
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    clean: (text) => text, request: async (_system, user, stage) => {
      if (stage === 'review') {
        if (++reviews === 1) return '{"canonicalPrompt":';
        assert.ok(user.includes('h3_staging_delivery_repair_data')); return JSON.stringify(delivery);
      }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.equal(reviews, 2); assert.equal(result.finalPrompt, revised);
  let failures = 0;
  await assert.rejects(generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    clean: (text) => text, request: async () => { failures += 1; return '{"canonicalPrompt":'; } }), /自动重试修复交付排程3次/u);
  assert.equal(failures, 4); assert.equal(board.finalPrompt, original);
});

await test('explicit retiming cannot silently accept a legacy H3-only response with stale shot metadata', async () => {
  let reviews = 0;
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    clean: (text) => text, request: async (_system, user, stage) => {
      if (stage === 'review') {
        if (++reviews === 1) return zh;
        assert.match(json(user, 'h3_staging_delivery_repair_data').protocolIssue, /缺少canonicalPrompt同步交付/u);
        return JSON.stringify(delivery);
      }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.equal(reviews, 2); assert.equal(result.finalPrompt, revised); assert.equal(result.shots[1].startSec, 5);
});

await test('initial generation also requires two synchronized bodies even when H3-only retains every cut', async () => {
  let reviews = 0;
  const unchangedCuts = applyOfficialH3Prompt(board, context).officialPromptZh!;
  const result = await generateSingleSegmentPrompt({ board, context, converter, reviewWithAi: true, clean: (text) => text,
    request: async (_system, user, stage) => {
      if (stage === 'convert') return original;
      if (stage === 'review') {
        if (++reviews === 1) return unchangedCuts;
        assert.match(json(user, 'h3_staging_delivery_repair_data').protocolIssue, /缺少canonicalPrompt同步交付/u);
        return JSON.stringify(delivery);
      }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.equal(reviews, 2); assert.equal(result.finalPrompt, revised); assert.equal(result.shots[1].startSec, 5);
});

await test('English metadata is translated in the existing call even when separate review is disabled', async () => {
  let requests = 0; let translated: H3IdentityBindings | undefined;
  const result = await translateVideoPromptToEnglish({ sourcePrompt: zh, identityBindings: bindings,
    onIdentityBindings: (value) => { translated = value; }, clean: () => { throw new Error('no local prose rewrite'); },
    request: async (system) => { requests += 1; assertH3DescriptionLanguage(system, '英文'); assert.ok(system.includes(H3_CLIP_TIME_RULE)); return JSON.stringify({ h3Prompt: en, identityBindings: enBindings }); } });
  assert.equal(requests, 1); assert.equal(result, en); assert.deepEqual(translated, enBindings);
});

await test('cancellation between response and parsing leaves the original saved plan untouched', async () => {
  let current = true; const before = JSON.stringify(board);
  await assert.rejects(generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    clean: (text) => text, isCurrent: () => current,
    request: async () => { current = false; return JSON.stringify(delivery); } }), { name: 'AbortError' });
  assert.equal(JSON.stringify(board), before);
});

const outputError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { name: 'TextModelResponseError', code });
await test('capacity, JSON and H3 repairs share three retries and repeat only technical request content', async () => {
  const requests: Array<{ user: string; maxTokens?: number }> = []; const originalConfig = { maxTokens: 6000 };
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    maxOutputTokens: originalConfig.maxTokens, clean: (text) => text,
    request: async (system, user, stage, transport) => {
      assertH3DescriptionLanguage(system, stage === 'review' ? '中文' : '英文');
      if (stage === 'review') {
        requests.push({ user, maxTokens: transport?.maxTokens });
        if (requests.length === 1) throw outputError('length');
        if (requests.length === 2) return '{"canonicalPrompt":';
        if (requests.length === 3) return JSON.stringify({ ...delivery, h3Prompt: zh.replace('non_diegetic_music:', 'wrong_music_field:') });
        assert.equal(requests.length, 4, 'initial plus exactly three technical recovery requests');
        assert.ok(user.includes('h3_format_repair_data')); return JSON.stringify({ h3Prompt: zh, identityBindings: bindings });
      }
      assert.equal(transport?.maxTokens, 6000, 'English remains a single-body request');
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.deepEqual(requests.map((item) => item.maxTokens), [12000, 24000, 24000, 24000]);
  assert.equal(requests[0].user, requests[1].user, 'length recovery repeats original request, not an invented story repair');
  assert.equal(result.officialPromptZh, zh); assert.equal(originalConfig.maxTokens, 6000);
});

await test('capacity failures cannot reset a partly consumed JSON retry budget', async () => {
  let reviews = 0;
  await assert.rejects(generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    maxOutputTokens: 6000, clean: (text) => text,
    request: async (_system, _user, stage) => {
      assert.equal(stage, 'review'); reviews += 1;
      if (reviews === 1) return '{"canonicalPrompt":';
      throw outputError('length');
    } }), /中文H3交付已自动重试3次/u);
  assert.equal(reviews, 4);
});

await test('provider refusal never becomes a JSON/story repair or consumes extra calls', async () => {
  let requests = 0; const refusal = outputError('refusal');
  await assert.rejects(generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair',
    maxOutputTokens: 6000, clean: (text) => text,
    request: async () => { requests += 1; throw refusal; } }), (error) => error === refusal);
  assert.equal(requests, 1);
});

await test('English initial/review/format phases share one three-retry transport and serialization budget', async () => {
  let translations = 0;
  const sourceBoard = { ...applyOfficialH3Prompt(sync, context), officialPromptZh: zh, h3IdentityBindings: bindings };
  sourceBoard.targetOutput = { ...sourceBoard.targetOutput!, prompt: zh };
  const result = await generateSingleSegmentPrompt({ board: sourceBoard, context, mode: 'translate-english', reviewWithAi: true,
    maxOutputTokens: 6000, clean: (text) => text,
    request: async (system, _user, stage, transport) => {
      assertH3DescriptionLanguage(system, '英文');
      assert.equal(stage, 'translate'); translations += 1;
      if (translations === 1) { assert.equal(transport?.maxTokens, 6000); throw outputError('length'); }
      assert.equal(transport?.maxTokens, 12000);
      if (translations === 2) return '{"h3Prompt":';
      if (translations === 3) return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
      if (translations === 4) return '{"h3Prompt":';
      assert.equal(translations, 5); // Two scheduled calls plus three total retries.
      return JSON.stringify({ h3Prompt: en.replace('non_diegetic_music:', 'wrong_music_field:'), identityBindings: enBindings });
    } });
  assert.equal(translations, 5, 'no sixth H3 format request after the shared retry budget is exhausted');
  assert.match(result.officialPromptEnError || '', /自动重试3次/u);
  assert.equal(result.officialPromptZh, zh, 'qualified Chinese survives exhausted English retries');
});

await test('optional null and empty tokens complete the existing pipeline without an extra repair request', async () => {
  let reviews = 0;
  const flexible = { ...bindings, version: '1', characters: bindings.characters.map((item) => ({ ...item, subjectToken: null, speakerToken: item.speakerToken ?? '' })) };
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair', clean: (text) => text,
    request: async (_system, _user, stage) => {
      if (stage === 'review') { reviews += 1; return JSON.stringify({ ...delivery, identityBindings: flexible }); }
      return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
    } });
  assert.equal(reviews, 1); assert.deepEqual(result.h3IdentityBindings, bindings); assert.equal(result.officialPromptZh, zh);
});

await test('metadata repairs preserve both bodies and reuse exact field diagnostics with immutable input', async () => {
  let reviews = 0; const before = JSON.stringify(board);
  const fixedMetadata = [{ ...emptyMetadata, sourceExcerpt: 'synthetic evidence' }, null];
  const broken = { ...delivery, shotMetadata: [{ ...fixedMetadata[0], sourceBeatIds: 'wrong type' }, null] };
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair', clean: (text) => text,
    request: async (system, user, stage) => {
      if (stage !== 'review') return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
      if (++reviews === 1) return JSON.stringify(broken);
      const repair = json(user, 'h3_metadata_repair_data');
      assert.deepEqual(repair.repairFields, ['shotMetadata']);
      assert.equal(repair.issues[0].path, 'shotMetadata[0].sourceBeatIds');
      assert.equal(repair.lockedDelivery.h3Prompt, zh); assert.equal(repair.lockedDelivery.canonicalPrompt, revised);
      assert.match(system, /metadataPatch/u);
      assert.ok(!system.includes('本次明确授权当前段未确认草稿/对白排程修复'), 'metadata repair receives no authority to rewrite the schedule');
      return JSON.stringify({ metadataPatch: { shotMetadata: fixedMetadata } });
    } });
  assert.equal(reviews, 2); assert.equal(result.finalPrompt, revised); assert.equal(result.officialPromptZh, zh);
  assert.equal(result.shots[0].sourceExcerpt, 'synthetic evidence'); assert.deepEqual(result.h3IdentityBindings, bindings);
  assert.equal(JSON.stringify(board), before);
});

await test('changed bodies in a metadata repair are rejected and a later valid patch keeps the original candidate', async () => {
  let reviews = 0;
  const broken = { ...delivery, shotSourceIds: ['wrong shape', ['shot-1']] };
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair', clean: (text) => text,
    request: async (_system, user, stage) => {
      if (stage !== 'review') return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
      if (++reviews === 1) return JSON.stringify(broken);
      const repair = json(user, 'h3_metadata_repair_data');
      assert.equal(repair.lockedDelivery.h3Prompt, zh);
      if (reviews === 2) return JSON.stringify({ ...delivery, h3Prompt: `${zh} unwanted prose change` });
      assert.match(repair.protocolIssue, /正文、排程和其他字段逐字保持/u);
      return JSON.stringify({ metadataPatch: { shotSourceIds: delivery.shotSourceIds } });
    } });
  assert.equal(reviews, 3); assert.equal(result.officialPromptZh, zh); assert.equal(result.finalPrompt, revised);
});

await test('provenance repair of an unknown source ID changes only its mapping, not the body or saved project', async () => {
  let reviews = 0;
  const result = await generateSingleSegmentPrompt({ board: applyOfficialH3Prompt(board, context), context, purpose: 'dialogue-repair', clean: (text) => text,
    request: async (_system, user, stage) => {
      if (stage !== 'review') return JSON.stringify({ h3Prompt: en, identityBindings: enBindings });
      if (++reviews === 1) return JSON.stringify({ ...delivery, shotSourceIds: [['unknown'], ['shot-1']] });
      const repair = json(user, 'h3_metadata_repair_data');
      assert.equal(repair.issues[0].path, 'shotSourceIds[0][0]');
      return JSON.stringify({ metadataPatch: { shotSourceIds: delivery.shotSourceIds } });
    } });
  assert.equal(reviews, 2); assert.equal(result.officialPromptZh, zh);
});

await test('bad metadata patches stop within the shared retry budget and retain the saved result', async () => {
  let reviews = 0; const saved = applyOfficialH3Prompt(board, context); const before = JSON.stringify(saved);
  await assert.rejects(generateSingleSegmentPrompt({ board: saved, context, purpose: 'dialogue-repair', clean: (text) => text,
    request: async (_system, _user, stage) => {
      assert.equal(stage, 'review');
      if (++reviews === 1) return JSON.stringify({ ...delivery, shotMetadata: 'invalid' });
      return JSON.stringify({ metadataPatch: {} });
    } }), /自动重试修复交付排程3次.*metadataPatch\.shotMetadata/u);
  assert.equal(reviews, 4); assert.equal(JSON.stringify(saved), before);
});

await test('switching project during a metadata repair cancels the response before commit or translation', async () => {
  let current = true; let requests = 0; const saved = applyOfficialH3Prompt(board, context); const before = JSON.stringify(saved);
  await assert.rejects(generateSingleSegmentPrompt({ board: saved, context, purpose: 'dialogue-repair', clean: (text) => text, isCurrent: () => current,
    request: async () => {
      if (++requests === 1) return JSON.stringify({ ...delivery, shotMetadata: 'invalid' });
      current = false;
      return JSON.stringify({ metadataPatch: { shotMetadata: [null, null] } });
    } }), (error) => error instanceof Error && error.name === 'AbortError');
  assert.equal(requests, 2); assert.equal(JSON.stringify(saved), before);
});

console.log(`H3 staging delivery: ${count} synthetic offline cases passed; no project data or live API used`);
