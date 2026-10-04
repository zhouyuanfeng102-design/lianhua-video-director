import assert from 'node:assert/strict';
import {
  generateSingleSegmentPrompt, getSingleSegmentReferences,
  type GenerateSingleSegmentPromptInput, type SingleSegmentPromptStage,
} from './fixtures/h3PipelineMock';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import {
  applyOfficialH3Prompt, buildOfficialH3SourceFingerprint,
  hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt,
  refreshOfficialH3PromptAfterSourceUpdate,
  type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
import {
  VIDEO_DIALOGUE_STAGING_RULE, VIDEO_SPATIAL_CONTINUITY_RULE,
  VIDEO_STAGING_REVIEW_RULE, VIDEO_PROMPT_FOCUS_RULE, VIDEO_WARDROBE_SCOPE_RULE,
} from '../src/videoConversionRules';
import type { Character, ConverterPreset, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

const character = (id: string, name: string, gender: string, outfit: string): Character => ({
  id, name, gender, apparentAge: '成年', race: '人类', appearance: `${name}身份面容`,
  outfit, signatureProps: '', personality: '沉着', motionHabits: '沿山道稳步上行',
  anchor: `${name}固定身份`, negativeContinuity: '', assetIds: [],
});
const master = { ...character('master', '师尊', '女', '白色长袍'), personality: '以沉稳女声讲解' };
const sister = character('sister', '小师姐', '女', '青色长袍');
const apprentice = character('apprentice', '林沐', '男', '灰衣与竹篓');
const characters = [master, sister, apprentice];
const source = '晨雾山道上，师尊走在最前，小师姐居中，林沐背着竹篓跟在最后，三人朝上方石门上山。'
  + '小师姐停在崖边看灵兰，问：“这里可以摘吗？”师尊没有回头，以沉稳女声回答：“灵兰喜阴，别伤了根。”林沐安静倾听。';
const reference: ReferenceAsset = {
  id: 'mountain-composition', name: '山道三人站位参考', mediaType: 'image', role: 'composition',
  referenceRole: 'composition', type: 'reference', source: 'upload',
  visualAnchor: '师尊在山道远处背面，小师姐居中，林沐在近景；石门在上方，摄影机在山道东侧。',
  dataUrl: 'data:image/png;base64,AA==', tags: ['山道'], createdAt: 1, updatedAt: 1,
};
const unusedReference: ReferenceAsset = { ...reference, id: 'unselected', name: 'UNSELECTED_IMAGE_MUST_NOT_REACH_REVIEW' };
const context: OfficialH3ProjectContext = { assets: [reference, unusedReference], characters };
const actions = [
  '师尊领路向石门上行，小师姐与林沐依次跟随',
  '小师姐停在崖边指向灵兰并发问，林沐在她后方闭口听',
  '师尊保持朝石门上行且不回头，在远处回答，小师姐与林沐闭口倾听',
];
const directions = [
  '三人面向上方石门；师尊背面远去；沿画面左下向右上行进',
  '小师姐面向左侧灵兰；师尊继续向石门上行；林沐朝向小师姐',
  '师尊保持背面向石门行进，没有转身；林沐面向师尊远处声源',
];
const spaces = [
  '首镜：师尊在前、小师姐居中、林沐在后；石门固定在山路深处',
  '次镜：山道东侧同轴线，小师姐在左侧崖边，林沐在后方，师尊仍在前方远处',
  '第三镜独立空间：师尊远处背影，林沐近景右侧，小师姐近景左侧；上方石门仍为共同目的地',
];
const dialogues = [
  '无',
  '第1s-第3s @小师姐（画内，年轻女声，可辨口型）：“这里可以摘吗？”；林沐闭口倾听',
  '第1s-第4s @师尊（远处背影发声，沉稳女声，声源在山路前方）：“灵兰喜阴，别伤了根。”；林沐和小师姐不随该句张口',
];
const canonicalFor = (edited: boolean): string => actions.map((action, i) => [
  `【${i * 5}s-${(i + 1) * 5}s】 主体：@师尊、@小师姐、@林沐（沉着）[朝向：${directions[i]}] 正在 [${action}${edited ? '，保持原来的前后顺序' : ''}]（上山采灵兰）`,
  `空间：${spaces[i]}`, '光影：晨雾散射冷光', `镜头：${i === 1 ? '中景' : '全景'}，摄影机始终在山道东侧，不越轴`,
  `台词：${dialogues[i]}`, '音效：环境层-[无] 动作层-[同步脚步] 情绪层-[无配乐]',
].join('；')).join('\n');
const canonical = canonicalFor(false);
const convertedCanonical = canonicalFor(true);
const shots: VideoShot[] = actions.map((action, i) => ({
  id: `mountain-shot-${i + 1}`, index: i + 1, startSec: i * 5, endSec: (i + 1) * 5,
  subject: '师尊、小师姐、林沐', action, space: spaces[i], direction: directions[i],
  performance: `原始表演事实${i + 1}：倾听者不随师尊台词张口`, camera: '山道东侧同轴线摄影机',
  dialogue: dialogues[i], purpose: '上山采灵兰', transition: '同侧切镜', lighting: '晨雾散射冷光',
  sound: '同步脚步', result: `原始镜尾状态${i + 1}：师尊始终在前朝石门走`,
  referenceAssetIds: [reference.id], sourceBeatIds: [`beat-${i + 1}`],
  sourceExcerpt: source, sourceLocationStatus: 'unlocated',
  prompt: canonical.split('\n')[i], locked: i === 1,
}));
const board: Storyboard = {
  id: 'mountain-board', sceneId: 'mountain-scene', sourceStoryTitle: '山道晨雾摘灵兰',
  sourceStoryContent: source, sourceContentHash: sourceContentHash(source), workflow: 'drama', inputMode: 'text_reference',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'cinematic', ruleSetId: 'test-rule',
  converterPresetId: 'staging-converter', globalLock: '上方石门是行进目标，师尊始终在前',
  globalReferenceAssetIds: [reference.id], shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  promptPlan: {
    canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    workflow: 'drama', inputMode: 'text_reference', shotIds: shots.map((shot) => shot.id),
    referenceAssetIds: [reference.id], constraints: ['摄影机保持山道东侧'],
    trace: { ruleSetId: 'test-rule', converterId: 'staging-converter' },
  },
  promptTrace: {
    mode: 'local-fallback', modelRuleSetId: 'test-rule', converterPresetId: 'staging-converter',
    sourceDocumentIds: ['original-story'], referenceAssetIds: [reference.id], generatedAt: 1,
  },
  targetModelId: 'minimax-h3', targetOutput: {
    targetId: 'minimax-h3', prompt: 'old saved target', parameters: { seed: 42987, steps: 15, cfg: 1, custom: { audioSteps: 12 } },
    referenceManifest: [], warnings: [], generatedAt: 1,
  },
  officialPromptZh: '旧中文结果', officialPromptEn: 'old saved English', officialPromptEnSource: '旧中文结果',
};
const converter: ConverterPreset = {
  id: 'staging-converter', name: '测试转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  systemPrompt: '转换可见镜头与原对白。', outputRules: '保留六字段及镜头边界。',
  enabled: true, version: 'test', updatedAt: 1,
};
const snapshot = JSON.stringify({ board, context });
const jsonBlock = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `request contains ${tag}`);
  return JSON.parse(match[1]);
};
const input = (): Omit<GenerateSingleSegmentPromptInput, 'request'> => ({
  board, context, converter, sourceStoryContent: source, reviewWithAi: true, hasImageInputs: true,
  clean: () => { throw new Error('AI content must not pass through local prose cleaning'); },
  now: () => 98765,
});
const assertUntouched = () => assert.equal(JSON.stringify({ board, context }), snapshot, 'requests and failures cannot mutate live inputs');

const calls: Array<{ stage: SingleSegmentPromptStage; system: string; user: string }> = [];
const progress: SingleSegmentPromptStage[] = [];
const translationReviews: number[] = [];
let chineseReviewed = '';
let englishReviewed = '';
let englishRequests = 0;
let reviewContext: Record<string, any> | undefined;
const result = await generateSingleSegmentPrompt({
  ...input(), onStage: (stage) => progress.push(stage),
  onAiTranslationReview: () => translationReviews.push(calls.length),
  request: async (system, user, stage) => {
    calls.push({ stage, system, user });
    if (stage === 'convert') return convertedCanonical;
    if (stage === 'review') {
      const data = jsonBlock(user, 'video_staging_review_data');
      reviewContext = data;
      assert.equal(data.sourceStoryContent, source, 'AI gets the complete original story');
      assert.equal(data.canonicalPrompt, convertedCanonical, 'review gets the actual conversion, not a stale draft');
      assert.match(data.candidatePrompt, /subject_definitions:[\s\S]*detailed_description:/u, 'the full-reference H3 Chinese candidate is reviewed');
      assert.equal(data.shots.length, 3, 'review sees every shot, including the later dialogue shot');
      for (const [i, shot] of data.shots.entries()) {
        for (const key of ['id', 'index', 'startSec', 'endSec', 'space', 'direction', 'performance', 'camera', 'lighting', 'dialogue', 'sound', 'result'] as const) {
          assert.deepEqual(shot[key], board.shots[i][key], `AI retains raw shot ${i + 1} ${key}`);
        }
        assert.ok(typeof shot.subject === 'string' && typeof shot.action === 'string' && typeof shot.prompt === 'string');
      }
      assert.deepEqual(data.characterIdentityFacts.map((person: any) => [person.name, person.gender]),
        [['师尊', '女'], ['小师姐', '女'], ['林沐', '男']], 'two distinct women and the male listener stay identifiable');
      assert.deepEqual(data.currentReferences.map((item: any) => item.id), getSingleSegmentReferences(board, context).map((item) => item.id));
      assert.doesNotMatch(user, /UNSELECTED_IMAGE/u, 'only selected references influence staging review');
      assert.match(system, /参考图真实像素/u);
      for (const rule of [VIDEO_DIALOGUE_STAGING_RULE, VIDEO_SPATIAL_CONTINUITY_RULE, VIDEO_STAGING_REVIEW_RULE, VIDEO_PROMPT_FOCUS_RULE]) {
        assert.ok(system.includes(rule), 'the review receives the shared staging and AI repair contract');
      }
      chineseReviewed = `${data.candidatePrompt}\nAI最终补充：师尊女声来自前方背影；林沐闭口倾听；镜头切换后师尊仍朝石门上山。`;
      return `  \n${chineseReviewed}\n  `;
    }
    englishRequests += 1;
    if (englishRequests === 1) {
      assert.equal(user, chineseReviewed, 'English must translate the AI-repaired Chinese delivery');
      return 'candidate with a wrong male speaker and reversed walking direction';
    }
    const data = jsonBlock(user, 'review_data');
    assert.equal(data.sourcePrompt, chineseReviewed);
    assert.equal(data.candidateEnglishPrompt, 'candidate with a wrong male speaker and reversed walking direction');
    assert.ok(data.stagingContext, 'English AI review receives shot and character staging context');
    assert.equal(data.stagingContext.sourceStoryContent, source);
    assert.deepEqual(data.stagingContext.shots, reviewContext!.shots.map((shot: Record<string, unknown>, index: number) => ({
      ...shot,
      camera: `${index === 1 ? '中景' : '全景'}，摄影机始终在山道东侧，不越轴`,
      sound: '环境层-[无] 动作层-[同步脚步] 情绪层-[无配乐]',
    })), 'English receives the synchronized canonical camera/audio fields while retaining the unchanged source facts');
    assert.equal(data.stagingContext.canonicalPrompt, convertedCanonical);
    englishReviewed = `${data.sourcePrompt.replaceAll('师尊', 'the female master').replaceAll('林沐', 'the male apprentice')}\nFinal staging: The female master speaks from ahead while walking toward the stone gate; the male apprentice keeps his mouth closed. Dialogue: “灵兰喜阴，别伤了根。”`;
    return `\n${englishReviewed}\n`;
  },
});
assert.deepEqual(calls.map((call) => call.stage), ['convert', 'review', 'translate', 'translate'], 'Chinese review is an actual request between conversion and English');
assert.deepEqual(progress, ['convert', 'review', 'translate']);
assert.deepEqual(translationReviews, [3], 'English-review progress is separate from the Chinese-review stage');
assert.equal(result.officialPromptEnError || '', '', 'the English fixture must complete without a swallowed review assertion');
assert.equal(result.officialPromptZh, chineseReviewed);
assert.equal(result.targetOutput?.prompt, chineseReviewed, 'video submission uses exactly the AI-reviewed Chinese');
assert.equal(result.officialPromptEn, englishReviewed, 'AI fixes the English candidate without local subject/tag restoration');
assert.equal(result.officialPromptEnSource, chineseReviewed);
assert.equal(result.englishPrompt, englishReviewed);
assert.equal(result.englishPromptSource, convertedCanonical);
assert.equal(result.finalPrompt, convertedCanonical, 'delivery repair does not silently rewrite canonical planning evidence');
assert.equal(result.promptTrace?.convertedPromptFingerprint, sourceContentHash(convertedCanonical));
assert.equal(result.officialPromptSource, buildOfficialH3SourceFingerprint(result, context));
assert.equal(hasCurrentTextApiConversion(result), true);
assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
assert.strictEqual(refreshOfficialH3PromptAfterSourceUpdate(result, context, { ...context }), result,
  'an unchanged source refresh must keep the AI-reviewed Chinese and its English instead of recompiling over them');
{
  const enrichedContext: OfficialH3ProjectContext = {
    ...context,
    characters: characters.map((person, index) => index === 0 ? { ...person, appearance: `${person.appearance}；AI图片资料补齐了银色发簪` } : person),
  };
  const before = JSON.stringify(result);
  const after = refreshOfficialH3PromptAfterSourceUpdate(result, context, enrichedContext);
  assert.strictEqual(after, result, 'real identity enrichment preserves every reviewed byte rather than invoking the compiler');
  assert.equal(after.officialPromptZh, chineseReviewed);
  assert.equal(after.officialPromptEn, englishReviewed);
  assert.equal(after.targetOutput?.prompt, chineseReviewed);
  assert.equal(hasCurrentOfficialH3Prompt(after, context), true, 'saved delivery remains associated with its original facts');
  assert.equal(hasCurrentOfficialH3Prompt(after, enrichedContext), false, 'changed facts require explicit AI updating, not a forged fingerprint');
  assert.equal(hasCurrentOfficialH3EnglishPrompt(after, enrichedContext), false);
  assert.equal(JSON.stringify(result), before);
}
for (const key of ['seed', 'steps', 'cfg', 'custom']) assert.deepEqual(result.targetOutput?.parameters[key], board.targetOutput?.parameters[key]);
assert.deepEqual(result.promptTrace?.sourceDocumentIds, board.promptTrace?.sourceDocumentIds);
assertUntouched();

// The model owns content decisions. No local entity count, keyword, direction,
// or prose-cleaning heuristic can veto or rewrite its final answer. H3's
// required transport scaffold remains intact; a one-Shot response to three
// Shots is a format defect, not a permissible content decision.
{
  const stages: SingleSegmentPromptStage[] = [];
  const modelChinese = chineseReviewed.replaceAll('师尊', '山中女师父').replaceAll('林沐', '青年听者')
    + '\n备注：保留模型自定称谓与原句，山中女师父以画外声讲解；近景青年听者保持沉默。';
  const modelEnglish = modelChinese.replaceAll('山中女师父', 'the mentor').replaceAll('青年听者', 'the nearby listener')
    + '\nThe mentor explains off screen and the nearby listener remains silent.';
  const accepted = await generateSingleSegmentPrompt({ ...input(), hasImageInputs: false, request: async (system, _user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return convertedCanonical;
    if (stage === 'review') {
      assert.match(system, /未发送图片像素/u, 'metadata-only requests cannot claim visual inspection');
      return modelChinese;
    }
    return modelEnglish;
  } });
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
  assert.equal(accepted.officialPromptZh, modelChinese);
  assert.equal(accepted.officialPromptEn, modelEnglish);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(accepted, context), true);
  assertUntouched();
}

// Review transport failure and empty review output stop before English. The
// uncommitted converted candidate must not overwrite old Chinese or English.
for (const empty of [false, true]) {
  const failure = new Error('mock staging-review transport failure');
  const stages: SingleSegmentPromptStage[] = [];
  await assert.rejects(generateSingleSegmentPrompt({ ...input(), request: async (_system, _user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return convertedCanonical;
    if (empty) return '  \n\t';
    throw failure;
  } }), (error) => empty ? error instanceof Error && /空|没有返回/u.test(error.message) : error === failure);
  assert.deepEqual(stages, ['convert', 'review']);
  assertUntouched();
}

for (const cancelAt of ['convert', 'review', 'translate'] as const) {
  let current = true;
  const stages: SingleSegmentPromptStage[] = [];
  await assert.rejects(generateSingleSegmentPrompt({
    ...input(), isCurrent: () => current,
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === cancelAt) current = false;
      if (stage === 'convert') return convertedCanonical;
      return stage === 'review' ? jsonBlock(user, 'video_staging_review_data').candidatePrompt : englishReviewed;
    },
  }), { name: 'AbortError' });
  const expected = ['convert', 'review', 'translate'].slice(0, ['convert', 'review', 'translate'].indexOf(cancelAt) + 1);
  assert.deepEqual(stages, expected, 'late answers cannot trigger the next request after cancel');
  assertUntouched();
}
{
  let current = true;
  const stages: SingleSegmentPromptStage[] = [];
  await assert.rejects(generateSingleSegmentPrompt({
    ...input(), isCurrent: () => current, onStage: (stage) => { if (stage === 'review') current = false; },
    request: async (_system, _user, stage) => { stages.push(stage); return convertedCanonical; },
  }), { name: 'AbortError' });
  assert.deepEqual(stages, ['convert'], 'cancellation from review progress happens before paying for the review request');
}

// A confirmed converted master slice skips conversion but still asks AI to
// review the final delivery against its raw facts before English translation.
{
  const stages: SingleSegmentPromptStage[] = [];
  const reused = await generateSingleSegmentPrompt({
    ...input(), board: result, skipConversion: true, converter: undefined,
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        assert.equal(data.canonicalPrompt, convertedCanonical);
        return data.candidatePrompt;
      }
      return englishReviewed;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate']);
  assert.equal(reused.finalPrompt, result.finalPrompt);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(reused, context), true);
  assert.equal(reused.targetOutput?.parameters.seed, 42987);
}

// English-only retry must use saved Chinese and must not reopen image or
// project/context dependencies, recompile Chinese, or require a converter.
{
  const stages: SingleSegmentPromptStage[] = [];
  const untouchedContext = new Proxy({} as OfficialH3ProjectContext, {
    get() { throw new Error('English-only retry must not read current asset or character context'); },
  });
  const retried = await generateSingleSegmentPrompt({
    ...input(), board: result, context: untouchedContext, converter: undefined, mode: 'translate-english',
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stages.length === 1) assert.equal(user, result.officialPromptZh);
      else {
        const data = jsonBlock(user, 'review_data');
        assert.equal(data.sourcePrompt, result.officialPromptZh);
        assert.equal(data.stagingContext.canonicalPrompt, result.finalPrompt, 'saved-only English review may use already saved shot facts');
        assert.equal(data.stagingContext.currentReferences, undefined, 'saved-only English retry carries no freshly read reference context');
      }
      return englishReviewed;
    },
  });
  assert.deepEqual(stages, ['translate', 'translate']);
  for (const key of ['shots', 'finalPrompt', 'promptPlan', 'promptTrace', 'targetOutput', 'officialPromptZh', 'officialPromptSource'] as const) {
    assert.deepEqual(retried[key], result[key], `English-only retry keeps ${key}`);
  }
  assert.equal(hasCurrentOfficialH3EnglishPrompt(retried, context), true);
}

// If English fails after successful Chinese review, keep that reviewed Chinese
// as a usable partial result while clearing all stale English derivatives.
{
  const stages: SingleSegmentPromptStage[] = [];
  const partial = await generateSingleSegmentPrompt({ ...input(), request: async (_system, _user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return convertedCanonical;
    if (stage === 'review') return chineseReviewed;
    throw new Error('mock English transport failure');
  } });
  assert.deepEqual(stages, ['convert', 'review', 'translate']);
  assert.equal(partial.officialPromptZh, chineseReviewed);
  assert.equal(partial.targetOutput?.prompt, chineseReviewed);
  assert.equal(hasCurrentOfficialH3Prompt(partial, context), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(partial, context), false);
  assert.match(partial.officialPromptEnError || '', /mock English transport failure/u);
  for (const key of ['officialPromptEn', 'officialPromptEnSource', 'englishPrompt', 'englishPromptSource'] as const) assert.equal(partial[key], '');
  assertUntouched();
}

// Regression from 0.5.150: the staging API returned canonical six-field
// timeline text. It is data for another AI repair request, never an H3 result.
{
  const stages: SingleSegmentPromptStage[] = [];
  let originalCandidate = '';
  const recovered = await generateSingleSegmentPrompt({ ...input(), request: async (system, user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return convertedCanonical;
    if (stage === 'review' && !user.includes('<h3_format_repair_data>')) {
      originalCandidate = jsonBlock(user, 'video_staging_review_data').candidatePrompt;
      return convertedCanonical;
    }
    if (stage === 'review') {
      const repair = jsonBlock(user, 'h3_format_repair_data');
      assert.equal(repair.formatReferencePrompt, originalCandidate, 'repair receives the entire real H3 candidate');
      assert.equal(repair.candidatePrompt, convertedCanonical, 'repair sees the observed bad response unchanged');
      assert.equal(repair.sourceContext.sourceStoryContent, source);
      assert.equal(repair.sourceContext.shots.length, 3);
      assert.deepEqual(repair.requiredProtocol, readH3PromptProtocol(originalCandidate));
      assert.match(system, /所有内容修复由你生成完整正文/u);
      return chineseReviewed;
    }
    return englishReviewed;
  } });
  assert.deepEqual(stages, ['convert', 'review', 'review', 'translate', 'translate']);
  assert.equal(recovered.officialPromptZh, chineseReviewed);
  assert.equal(recovered.targetOutput?.prompt, chineseReviewed);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(recovered, context), true);
  assertUntouched();
}

// Only reserved H3 protocol changes need format repair. Appearance/name
// wording and duplicate references inside the prose remain model-owned.
assert.equal(getH3PromptProtocolIssue(chineseReviewed, chineseReviewed), undefined);
assert.equal(getH3PromptProtocolIssue(chineseReviewed.replaceAll('师尊', '远处的讲解者'), chineseReviewed), undefined);
assert.equal(getH3PromptProtocolIssue(`${chineseReviewed}\n<Picture 1> <Picture 1>`, chineseReviewed), undefined);

// Both official Shot spellings describe the same structure. The complete
// Chinese -> English pipeline must keep the AI body verbatim without paying
// for a repair just because the model changes marker whitespace.
{
  const stages: SingleSegmentPromptStage[] = [];
  let reviewedChinese = '';
  let reviewedEnglish = '';
  let translationCalls = 0;
  const delivered = await generateSingleSegmentPrompt({ ...input(),
    request: async (_system, user, stage) => {
      stages.push(stage);
      assert.doesNotMatch(user, /<h3_format_repair_data>/u,
        'equivalent Shot whitespace must not trigger an extra AI format repair');
      if (stage === 'convert') return convertedCanonical;
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        reviewedChinese = data.candidatePrompt.replace(/\[Shot\s+(\d+)\]/gu, '[Shot$1]');
        return reviewedChinese;
      }
      translationCalls += 1;
      if (translationCalls === 1) {
        assert.equal(user, reviewedChinese, 'translation uses the exact accepted Chinese body');
        reviewedEnglish = reviewedChinese.replace(/\[Shot(\d+)\]/gu, '[Shot\t$1]');
        return reviewedEnglish;
      }
      const data = jsonBlock(user, 'review_data');
      assert.equal(data.sourcePrompt, reviewedChinese);
      assert.equal(data.candidateEnglishPrompt, reviewedEnglish);
      return reviewedEnglish;
    },
  });
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
  assert.equal(delivered.officialPromptZh, reviewedChinese);
  assert.equal(delivered.officialPromptEn, reviewedEnglish);
  assert.equal(hasCurrentOfficialH3Prompt(delivered, context), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(delivered, context), true);
  assertUntouched();
}

// A real missing section is still repaired by the AI, but its request now
// receives the particular missing field instead of a catch-all failure list.
{
  const stages: SingleSegmentPromptStage[] = [];
  let requiredBody = '';
  let repairedBody = '';
  let translationCalls = 0;
  const delivered = await generateSingleSegmentPrompt({ ...input(),
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === 'convert') return convertedCanonical;
      if (stage === 'review' && !user.includes('<h3_format_repair_data>')) {
        requiredBody = jsonBlock(user, 'video_staging_review_data').candidatePrompt;
        return requiredBody.replace(/^overall_soundscape:[\s\S]*?(?=^non_diegetic_music:)/mu, '');
      }
      if (stage === 'review') {
        const data = jsonBlock(user, 'h3_format_repair_data');
        assert.match(data.formatIssue, /overall_soundscape/u);
        assert.match(data.formatIssue, /缺少/u);
        assert.equal(data.formatReferencePrompt, requiredBody);
        assert.equal(data.sourceContext.sourceStoryContent, source);
        repairedBody = data.formatReferencePrompt;
        return repairedBody;
      }
      translationCalls += 1;
      if (translationCalls === 1) assert.equal(user, repairedBody);
      else assert.equal(jsonBlock(user, 'review_data').sourcePrompt, repairedBody);
      return repairedBody;
    },
  });
  assert.deepEqual(stages, ['convert', 'review', 'review', 'translate', 'translate']);
  assert.equal(delivered.officialPromptZh, repairedBody);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(delivered, context), true);
  assertUntouched();
}

for (const invalid of [
  convertedCanonical,
  `\`\`\`\n${chineseReviewed}\n\`\`\``,
  chineseReviewed.replace('summary:', '摘要：'),
  chineseReviewed.replace('At 00:05.000', 'At 00:06.000'),
  chineseReviewed.replace('[Shot 3] At 00:10.000', '[Shot 4] At 00:10.000'),
  chineseReviewed.replaceAll('<Picture 1>', '<Picture 99>'),
  chineseReviewed.replace('detailed_description:', 'integrated_multimodal_description:'),
]) {
  assert.ok(getH3PromptProtocolIssue(invalid, chineseReviewed), 'sections, shot boundaries and IDs cannot silently disappear');
}

// Exhausted repair, repair transport failure and cancellation never commit a
// partially converted result or proceed to English; old live inputs survive.
for (const repairOutcome of ['invalid', 'network', 'cancel'] as const) {
  let current = true;
  const stages: SingleSegmentPromptStage[] = [];
  const repairFailure = new Error('mock H3 protocol repair network failure');
  await assert.rejects(generateSingleSegmentPrompt({
    ...input(), isCurrent: () => current, request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === 'convert') return convertedCanonical;
      if (user.includes('<h3_format_repair_data>')) {
        if (repairOutcome === 'network') throw repairFailure;
        if (repairOutcome === 'cancel') current = false;
      }
      return convertedCanonical;
    },
  }), (error) => repairOutcome === 'network' ? error === repairFailure
    : error instanceof Error && (repairOutcome === 'cancel' ? error.name === 'AbortError' : /AI已自动重试修复H3格式/u.test(error.message)));
  assert.deepEqual(
    stages,
    repairOutcome === 'invalid'
      ? ['convert', 'review', 'review', 'review', 'review']
      : ['convert', 'review', 'review'],
  );
  assertUntouched();
}

// Saved malformed 150 artifacts must not be labelled ready simply because
// their fingerprints and target prompt match; reading them does not rewrite.
{
  const oldMalformed: Storyboard = {
    ...result, officialPromptZh: convertedCanonical,
    targetOutput: { ...result.targetOutput!, prompt: convertedCanonical },
    officialPromptEn: '[0s-5s] Subject: the mentor.', officialPromptEnSource: convertedCanonical,
  };
  const saved = JSON.stringify(oldMalformed);
  assert.equal(hasCurrentOfficialH3Prompt(oldMalformed, context), false);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(oldMalformed, context), false);
  assert.strictEqual(refreshOfficialH3PromptAfterSourceUpdate(oldMalformed, context, context), oldMalformed);
  await assert.rejects(generateSingleSegmentPrompt({ ...input(), board: oldMalformed, mode: 'translate-english',
    request: async () => { throw new Error('malformed saved Chinese cannot be used as a translation source'); },
  }), /重新生成中文提示词/u);
  assert.equal(JSON.stringify(oldMalformed), saved, 'legacy detection does not alter saved content');
}

// English staging review gets the same H3 repair contract. A failed repair
// leaves only qualified Chinese available; a stale answer remains cancellation.
for (const repairOutcome of ['valid', 'invalid', 'cancel'] as const) {
  const stages: SingleSegmentPromptStage[] = [];
  let current = true;
  const request: GenerateSingleSegmentPromptInput['request'] = async (_system, user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return convertedCanonical;
    if (stage === 'review') return chineseReviewed;
    if (user.includes('<h3_format_repair_data>')) {
      const data = jsonBlock(user, 'h3_format_repair_data');
      assert.equal(data.formatReferencePrompt, chineseReviewed);
      assert.equal(data.candidatePrompt, '[0s-15s] Subject: the female master.');
      assert.equal(data.sourceContext.stagingContext.sourceStoryContent, source);
      if (repairOutcome === 'cancel') current = false;
      return repairOutcome === 'valid' ? englishReviewed : '[0s-15s] Subject: the female master.';
    }
    return '[0s-15s] Subject: the female master.';
  };
  if (repairOutcome === 'cancel') {
    await assert.rejects(generateSingleSegmentPrompt({ ...input(), request, isCurrent: () => current }), { name: 'AbortError' });
  } else {
    const reviewed = await generateSingleSegmentPrompt({ ...input(), request, isCurrent: () => current });
    assert.equal(reviewed.officialPromptZh, chineseReviewed);
    assert.equal(hasCurrentOfficialH3Prompt(reviewed, context), true);
    assert.equal(hasCurrentOfficialH3EnglishPrompt(reviewed, context), repairOutcome === 'valid');
    if (repairOutcome === 'invalid') {
      assert.equal(reviewed.officialPromptEn, '');
      assert.match(reviewed.officialPromptEnError || '', /AI已自动重试修复H3格式/u);
    }
  }
  assert.deepEqual(
    stages,
    repairOutcome === 'invalid'
      ? ['convert', 'review', 'translate', 'translate', 'translate', 'translate', 'translate']
      : ['convert', 'review', 'translate', 'translate', 'translate'],
  );
  assertUntouched();
}

{
  const savedPair = JSON.stringify(result);
  const stages: SingleSegmentPromptStage[] = [];
  const failedRetry = await generateSingleSegmentPrompt({ ...input(), board: result, mode: 'translate-english',
    request: async (_system, _user, stage) => {
      stages.push(stage);
      return '[0s-15s] Subject: wrong timeline instead of H3.';
    },
  });
  assert.deepEqual(stages, ['translate', 'translate', 'translate', 'translate', 'translate']);
  assert.match(failedRetry.officialPromptEnError || '', /AI已自动重试修复H3格式/u);
  assert.equal(failedRetry.officialPromptEn, result.officialPromptEn, 'failed English-only repair keeps the prior qualified English');
  assert.equal(failedRetry.officialPromptZh, result.officialPromptZh);
  assert.equal(failedRetry.targetOutput, result.targetOutput);
  assert.equal(JSON.stringify(result), savedPair, 'the previous saved pair is never mutated');
}

// The final delivery fingerprint remains a source identity check, independent
// of whether AI kept the compiler wording or repaired its staging language.
{
  const segmentSource = '门口两位成年同伴短暂亲吻，林沐隔着灰色外套扶住对方手臂，两人衣着完整。';
  const wholeStory = `${segmentSource}\n后续第五段：众人回客栈后换成绿色外套。`;
  const privateContext: OfficialH3ProjectContext = { ...context, characters: characters.map((person) => ({
    ...person, nsfwProfile: { fullBody: 'PRIVATE_DOSSIER_SENTINEL_UNUSED_IN_THIS_SHOT', updatedAt: 1 },
  })) };
  const scopedBoard: Storyboard = { ...board, segmentId: 'segment-3', sequencePlanId: 'sequence-1', segmentIndex: 3,
    segmentCount: 5, globalStartSec: 30, globalEndSec: 45, sourceStoryContent: segmentSource,
    sourceContentHash: sourceContentHash(segmentSource), continuityIn: '上段结束：林沐穿灰色外套，衣扣系好',
    continuityOut: '本段结束：灰色外套与衣扣状态保持',
    shots: board.shots.map((shot) => ({ ...shot, sourceExcerpt: segmentSource })),
  };
  const saved = JSON.stringify({ scopedBoard, privateContext });
  let lastChinese = '';
  let translationCalls = 0;
  const requestStages: string[] = [];
  const repairedWardrobe = await generateSingleSegmentPrompt({ ...input(), board: scopedBoard, context: privateContext,
    sourceStoryContent: wholeStory, request: async (system, user, stage) => {
      requestStages.push(stage);
      assert.equal(system.split(VIDEO_WARDROBE_SCOPE_RULE).length - 1, 1, `all ${stage} requests carry the AI-only wardrobe scope contract once`);
      assert.doesNotMatch(user, /PRIVATE_DOSSIER_SENTINEL_UNUSED_IN_THIS_SHOT/u, 'a stored private profile is not automatically copied into ordinary scene generation');
      if (stage === 'convert') return convertedCanonical;
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        assert.equal(data.sourceStoryContent, wholeStory, 'full story remains context without authorizing later wardrobe changes now');
        assert.equal(data.segmentScope.savedSegmentSourceStoryContent, segmentSource);
        assert.equal(data.segmentScope.segmentIndex, 3);
        assert.equal(data.savedContinuityEvidence.entryState, scopedBoard.continuityIn);
        assert.equal(data.savedContinuityEvidence.exitState, scopedBoard.continuityOut);
        assert.equal(data.shots[0].sourceExcerpt, segmentSource);
        assert.equal(data.characterIdentityFacts.find((person: any) => person.name === '林沐').outfit, '灰衣与竹篓');
        lastChinese = `${data.candidatePrompt}\nAI修复衣着：当前段保持灰衣；后续第五段的绿色外套不提前出现。`;
        return lastChinese;
      }
      translationCalls += 1;
      if (translationCalls === 2) {
        const data = jsonBlock(user, 'review_data');
        assert.equal(data.stagingContext.savedContinuityEvidence.entryState, scopedBoard.continuityIn);
        assert.equal(data.stagingContext.segmentScope.savedSegmentSourceStoryContent, segmentSource);
      }
      return `${lastChinese}\nWardrobe is inherited without adding a wardrobe change.`;
    } });
  assert.deepEqual(requestStages, ['convert', 'review', 'translate', 'translate']);
  assert.equal(repairedWardrobe.officialPromptZh, lastChinese, 'the AI output is accepted intact without a local clothing-content gate');
  assert.equal(JSON.stringify({ scopedBoard, privateContext }), saved, 'private profiles and saved source/wardrobe evidence are never rewritten');
}
// Explicit model-authored field selection may supply only that person's
// selected keys to that shot. Neither adjacent shots nor the whole canonical
// prompt inherit a dossier just because it exists in the project.
{
  const selectedContext: OfficialH3ProjectContext = { ...context, characters: characters.map((person) => ({
    ...person, nsfwProfile: { fullBody: `SELECTED_FIELD_${person.id}`, penis: `UNSELECTED_FIELD_${person.id}` },
  })) };
  const selectedBoard: Storyboard = { ...result, shots: result.shots.map((shot, index) => ({
    ...shot, ...(index === 1 ? { visiblePrivatePartsByCharacter: { apprentice: ['full-body' as const] } } : {}),
  })) };
  const savedSelection = JSON.stringify({ selectedBoard, selectedContext });
  let finalChinese = '';
  let englishCalls = 0;
  const assertSelectedFacts = (facts: any) => {
    assert.deepEqual(facts.shots.map((shot: any) => shot.selectedPrivateFacts.length), [0, 1, 0]);
    assert.deepEqual(facts.shots[1].selectedPrivateFacts, [{ characterId: 'apprentice', name: '林沐', parts: ['full-body'], profile: { fullBody: 'SELECTED_FIELD_apprentice' } }]);
  };
  await generateSingleSegmentPrompt({ ...input(), board: selectedBoard, context: selectedContext,
    skipConversion: true, converter: undefined, request: async (system, user, stage) => {
      assert.doesNotMatch(user, /UNSELECTED_FIELD_|SELECTED_FIELD_master|SELECTED_FIELD_sister/u);
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        assertSelectedFacts(data);
        assert.match(system, /selectedPrivateFacts 只包含先前AI为该镜选择的必要资料/u);
        const shot2 = data.candidatePrompt.indexOf('[Shot 2] At');
        const shot3 = data.candidatePrompt.indexOf('[Shot 3] At');
        assert.doesNotMatch(data.candidatePrompt.slice(0, shot2), /SELECTED_FIELD/u, 'selected values do not enter global identity or the previous shot');
        assert.match(data.candidatePrompt.slice(shot2, shot3), /SELECTED_FIELD_apprentice/u, 'the explicitly selected field is scoped to its authored shot');
        assert.doesNotMatch(data.candidatePrompt.slice(shot3), /SELECTED_FIELD/u, 'selected values do not spill into the next shot');
        finalChinese = data.candidatePrompt;
        return finalChinese;
      }
      englishCalls += 1;
      if (englishCalls === 2) assertSelectedFacts(jsonBlock(user, 'review_data').stagingContext);
      return finalChinese;
    } });
  assert.equal(englishCalls, 2);
  assert.equal(JSON.stringify({ selectedBoard, selectedContext }), savedSelection);
}

// Older versions embedded the complete private dossier into an automatic
// global lock even when the canonical/current shot never used it. Do not send
// that derived inventory back into Chinese review, English review or either
// H3 structure-repair request. Keep normal locks and user directions intact.
{
  const userDirection = '制作要求：门口保持原有灯光；穿着绿色外套走出门后不换回旧外套。';
  const publicContinuity = '承接上一段：林沐已经换上绿色外套，衣扣系好。';
  const legacyGlobalLock = [
    publicContinuity,
    '固定人物：林沐：性别设定：男，人类，清晰面容，默认衣橱/身份服装基底：灰色外套，NSFW身体锚点：LEGACY_PRIVATE_DOSSIER_SENTINEL',
    '固定场景：门口，木门在左侧',
    userDirection,
  ].join('\n');
  const oldDerivedBoard: Storyboard = { ...result, globalLock: legacyGlobalLock,
    promptPlan: { ...result.promptPlan!, constraints: [`连续性锚点：${legacyGlobalLock}`] },
  };
  const frozen = JSON.stringify(oldDerivedBoard);
  let reviewCalls = 0;
  let translationCalls = 0;
  let h3Candidate = '';
  const repaired = await generateSingleSegmentPrompt({ ...input(), board: oldDerivedBoard,
    skipConversion: true, converter: undefined, request: async (system, user, stage) => {
      assert.ok(system.includes(VIDEO_WARDROBE_SCOPE_RULE));
      assert.doesNotMatch(user, /LEGACY_PRIVATE_DOSSIER_SENTINEL/u, 'a legacy derived private lock never re-enters a new model request');
      if (stage === 'review') {
        reviewCalls += 1;
        const data = jsonBlock(user, reviewCalls === 1 ? 'video_staging_review_data' : 'h3_format_repair_data');
        const facts = reviewCalls === 1 ? data : data.sourceContext;
        assert.ok(facts.globalContinuityFacts.includes(publicContinuity), 'an already confirmed outfit change remains available');
        assert.ok(facts.globalContinuityFacts.includes(userDirection), 'a user direction is not stripped as private inventory');
        assert.equal(facts.characterIdentityFacts.find((person: any) => person.name === '林沐').outfit, '灰衣与竹篓', 'ordinary identity still comes from the explicit project projection, not the old dossier-filled lock');
        if (reviewCalls === 1) {
          h3Candidate = data.candidatePrompt;
          return convertedCanonical;
        }
        return h3Candidate;
      }
      translationCalls += 1;
      if (translationCalls === 1) return 'An English draft with an incomplete H3 structure.';
      const data = jsonBlock(user, translationCalls === 2 ? 'review_data' : 'h3_format_repair_data');
      const facts = translationCalls === 2 ? data.stagingContext : data.sourceContext.stagingContext;
      assert.ok(facts.globalContinuityFacts.includes(publicContinuity));
      assert.ok(facts.globalContinuityFacts.includes(userDirection));
      return translationCalls === 2 ? 'The wardrobe is unchanged, but this reply has no H3 sections.' : h3Candidate;
    } });
  assert.equal(reviewCalls, 2, 'Chinese H3 repair keeps the cleaned request context');
  assert.equal(translationCalls, 3, 'English H3 repair keeps the same cleaned context');
  assert.equal(repaired.officialPromptZh, h3Candidate);
  assert.equal(repaired.officialPromptEn, h3Candidate);
  assert.equal(JSON.stringify(oldDerivedBoard), frozen, 'legacy stored locks and prompts are not rewritten on read');
}

const compiledBaseline = applyOfficialH3Prompt(result, context);
assert.equal(compiledBaseline.officialPromptSource, result.officialPromptSource);
assert.notEqual(compiledBaseline.officialPromptZh, result.officialPromptZh);
assertUntouched();
console.log('video staging AI review: full-shot/reference facts, real Chinese+English review calls, exact model output, no semantic veto, freshness/seed, cancellation and partial results passed');
