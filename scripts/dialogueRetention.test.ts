import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal, hasCurrentTextApiConversion } from '../src/appEffects';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { ConverterPreset, Storyboard, VideoShot } from '../src/types';

const FIRST_LINE = '先开门。';
const SECOND_LINE = '记得带上钥匙，我们一起回家。';
const SOURCE = `旅人压住门板，说：“${FIRST_LINE}”旅人收好钥匙，又说：“${SECOND_LINE}”`;
const converter: ConverterPreset = {
  id: 'dialogue-retention-converter', name: '通用视频转换器', workflow: 'all', inputMode: 'all',
  scope: 'video', enabled: true, version: 'test', systemPrompt: '把剧情转换为可见视频动作。',
  outputRules: '保留剧情事实和对白。', updatedAt: 1,
};
const clean = (value: string) => value.trim();
const cue = (text: string, at = 1) => `第${at}s @旅人："${text}"`;
const canonical = (dialogues: string[], local = false, extraScene = '') => dialogues.map((dialogue, index) => [
  `【${index * 5}s-${(index + 1) * 5}s】 主体：@旅人（男，沉着）[朝向：木门] 正在 [${
    (local ? ['手掌压住门板', '把钥匙收好'] : ['掌心平贴门板并压稳', '右手将钥匙放入衣袋'])[index]
  }]（推进当前事件）`,
  `空间：前景-木门 中景-旅人 背景-门廊${extraScene && index === 1 ? `；${extraScene}` : ''}`,
  '光影：左侧冷灰散射光', '镜头：中景稳定侧拍', `台词：${dialogue}`,
  '音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]',
].join('；')).join('\n');

const makeDraft = (
  sourceStoryContent = SOURCE,
  localDialogues = [cue(FIRST_LINE), '无'],
): Storyboard => {
  const finalPrompt = canonical(localDialogues, true);
  // The local shot evidence deliberately covers only action prose. The full
  // source is the authority even when an earlier draft has already lost speech.
  const shots: VideoShot[] = [0, 1].map((index) => ({
    id: `dialogue-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
    subject: '旅人', action: ['手掌压住门板', '把钥匙收好'][index], purpose: '推进当前事件',
    camera: '中景稳定侧拍', lighting: '左侧冷灰散射光', sound: '', transition: '硬切',
    result: '原有结果', locked: index === 1, referenceAssetIds: [], sourceBeatIds: [],
    sourceStart: 0, sourceEnd: Math.min(7, sourceStoryContent.length),
    prompt: finalPrompt.split('\n')[index],
  }));
  return {
    id: 'dialogue-board', sceneId: 'scene', workflow: 'drama', inputMode: 'text',
    sourceStoryTitle: '门廊对白', sourceStoryContent, sourceContentHash: 'original-source-hash',
    durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style',
    ruleSetId: 'rule', converterPresetId: converter.id, globalLock: '保持旅人站在门廊内',
    shots, finalPrompt, createdAt: 1, updatedAt: 1,
    promptPlan: {
      canonicalPrompt: finalPrompt, durationSec: 10, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      workflow: 'drama', inputMode: 'text', shotIds: shots.map((shot) => shot.id), referenceAssetIds: [],
      constraints: [], trace: { ruleSetId: 'rule', converterId: converter.id },
    },
    promptTrace: {
      mode: 'local-fallback', modelRuleSetId: 'rule', converterPresetId: converter.id,
      sourceDocumentIds: ['original-source'], referenceAssetIds: [], generatedAt: 1,
    },
    targetModelId: 'minimax-h3', targetOutput: {
      targetId: 'minimax-h3', prompt: 'old result',
      parameters: { seed: 1234567, steps: 15, cfg: 1, custom: { audioSteps: 15 } },
      referenceManifest: [], warnings: [], generatedAt: 1,
    },
  };
};

const jsonBlock = (value: string, tag: string): Record<string, any> => {
  const match = value.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `${tag} must be present in the API request`);
  return JSON.parse(match[1]);
};
const assertPreserved = (result: Storyboard, original: Storyboard) => {
  assert.equal(hasCurrentTextApiConversion(result), true);
  for (const [key, value] of Object.entries(original.targetOutput?.parameters || {})) {
    assert.deepEqual(result.targetOutput?.parameters[key], value, `existing generation parameter ${key} must survive`);
  }
  assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.locked, shot.sourceStart, shot.sourceEnd]),
    original.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.locked, shot.sourceStart, shot.sourceEnd]));
  assert.equal(result.sourceStoryContent, original.sourceStoryContent);
};
const complete = canonical([cue(FIRST_LINE), cue(SECOND_LINE, 0.4)]);
const missing = canonical([cue(FIRST_LINE), '无']);

// The complete source goes to AI once. Local quotation extraction does not
// become a content whitelist or force another request after a readable answer.
{
  const draft = makeDraft();
  const before = JSON.stringify(draft);
  let requests = 0;
  const result = await convertStoryboardDraftToFinal({
    draft, converter, clean, now: () => 123,
    request: async (system, user) => {
      requests += 1;
      assert.equal(requests, 1, 'content review happens in the same model request');
      const data = jsonBlock(user, 'video_conversion_data');
      assert.equal(data.sourceStoryContent, SOURCE);
      assert.equal('requiredDialogues' in data, false);
      assert.ok(data.shotEvidence.every((shot: any) => !('allowedSubjects' in shot)));
      assert.match(system, /本次回答内完成内容自检/u);
      assert.ok(user.includes(SECOND_LINE), 'full source includes dialogue absent from the old draft');
      return missing;
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.finalPrompt, missing, 'a readable model decision is not rewritten locally');
  assertPreserved(result, draft);
  assert.equal(JSON.stringify(draft), before);
}

// Content comparison is not a local accept/reject rule. The model owns
// omissions, changed wording, timing, quote layout and cross-shot delivery.
const longLine = '你先沿着门外的小路走到桥边等我，我把留在这里的钥匙和信收好以后就过去，我们会一起平安回家的。';
for (const sample of [
  { name: 'already complete', source: SOURCE, answer: complete },
  { name: 'AI returns no second dialogue', source: SOURCE, answer: missing },
  { name: 'AI rephrases dialogue', source: SOURCE,
    answer: canonical([cue('开门吧。'), cue('把钥匙收好，我们回家。', 0.7)]) },
  { name: 'punctuation and whitespace', source: SOURCE,
    answer: canonical([cue('先，开 门！', 2.1), cue('记得带上钥匙 我们一起回家!', 0.2)]) },
  { name: 'speech split naturally across shots', source: '旅人说：“' + SECOND_LINE + '”',
    answer: canonical([cue('记得带上钥匙。', 3.2), cue('我们一起回家。', 0.3)]) },
  { name: 'long speech has no artificial chars-per-second limit', source: '旅人说：“' + longLine + '”',
    answer: canonical([cue(longLine, 0.2), '无']) },
  { name: 'AI chooses visual inscription', source: SOURCE,
    answer: canonical([cue(FIRST_LINE), '无'], false, '墙面文字写着“' + SECOND_LINE + '”') },
  { name: 'AI decides whether to repeat an utterance',
    source: '旅人第一次说：“' + FIRST_LINE + '”等了一会儿，旅人又说：“' + FIRST_LINE + '”', answer: missing },
]) {
  let requests = 0;
  const draft = makeDraft(sample.source, ['无', '无']);
  const result = await convertStoryboardDraftToFinal({ draft, converter, clean,
    request: async (_system, user) => {
      requests += 1;
      assert.equal(requests, 1, sample.name + ' must not trigger a content-repair request');
      assert.ok(!user.includes('<video_conversion_structural_repair_data>'));
      assert.equal(jsonBlock(user, 'video_conversion_data').sourceStoryContent, sample.source);
      return sample.answer;
    },
  });
  assert.equal(requests, 1, sample.name);
  assert.equal(result.finalPrompt, sample.answer, sample.name + ' must not be rewritten locally');
  assertPreserved(result, draft);
}

// AI decides which lines use which language. The converter does not locally
// reinterpret the complete story and block a readable language decision.
for (const includeChinese of [false, true]) {
  const source = '旅人用英语说：“欢迎回来。”旅人随后用中文说：“' + FIRST_LINE + '”';
  const answer = canonical([cue('Welcome back.'), includeChinese ? cue(FIRST_LINE, 0.6) : '无']);
  let requests = 0;
  const result = await convertStoryboardDraftToFinal({ draft: makeDraft(source, ['无', '无']), converter, clean,
    request: async (_system, user) => {
      requests += 1;
      assert.equal(requests, 1);
      assert.equal(jsonBlock(user, 'video_conversion_data').sourceStoryContent, source);
      return answer;
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.finalPrompt, answer);
}

// A genuine unreadable field is still repaired once by AI against the full
// source. The second usable candidate may retain content a local extractor
// would disagree with; no semantic retry is layered on top of structural repair.
const unreadable = complete.replace('空间：', '画面：');
{
  let requests = 0;
  const draft = makeDraft();
  const before = JSON.stringify(draft);
  const result = await convertStoryboardDraftToFinal({ draft, converter, clean,
    request: async (_system, user) => {
      requests += 1;
      if (requests === 1) return unreadable;
      assert.equal(requests, 2);
      const repair = jsonBlock(user, 'video_conversion_structural_repair_data');
      assert.equal(repair.invalidCandidate, unreadable);
      assert.match(repair.validationFailure, /缺少必填字段/u);
      assert.equal(repair.sourceStoryContent, SOURCE);
      assert.equal('requiredDialogues' in repair, false);
      return missing;
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.finalPrompt, missing);
  assertPreserved(result, draft);
  assert.equal(JSON.stringify(draft), before);
}
{
  const draft = makeDraft();
  const before = JSON.stringify(draft);
  let requests = 0;
  await assert.rejects(convertStoryboardDraftToFinal({ draft, converter, clean,
    request: async () => { requests += 1; return unreadable; },
  }), /本地时轴\/字段检查.*已请求 AI 修复 1 次/u);
  assert.equal(requests, 2, 'one conversion and one structural repair, never an unbounded loop');
  assert.equal(JSON.stringify(draft), before);
}

// The shared short/long wrapper receives the model-authored text as-is while
// preserving current segment scope, source coordinates and old saved results.
for (const isLongSegment of [false, true]) {
  const localDraft = makeDraft();
  const board = isLongSegment ? {
    ...localDraft, sequencePlanId: 'whole-plan', segmentId: 'segment-2', segmentIndex: 2, segmentCount: 3,
    globalStartSec: 10, globalEndSec: 20,
    sourceStoryContent: '前一段旅人说：“已经到了。”' + SOURCE + '后一段旅人说：“这里很安全。”',
  } : localDraft;
  const before = JSON.stringify(board);
  const stages: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({
    board, ...(isLongSegment ? { conversionDraft: localDraft } : {}), converter,
    sourceStoryContent: SOURCE, context: { assets: [], characters: [] }, clean,
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === 'translate') return user.replace(/[\p{Script=Han}]+/gu, ' translated ');
      assert.doesNotMatch(user, /已经到了|这里很安全/u);
      return missing;
    },
  });
  assert.deepEqual(stages, ['convert', 'translate']);
  assert.equal(result.finalPrompt, missing);
  assert.ok(!result.officialPromptZh?.includes(SECOND_LINE), 'H3 must not append a locally detected missing source line');
  assert.equal(result.officialPromptEnError, '');
  assert.ok(result.officialPromptEn?.includes(FIRST_LINE), 'English protects the accepted Chinese words, not the old draft');
  assertPreserved(result, board);
  assert.equal(JSON.stringify(board), before);
}

// Dialogue is not a technical settings field. H3 and English preserve literal
// settings spoken by a character rather than stripping them from speech.
{
  const technicalDialogue = '这是2K录像，画幅16:9。';
  const source = '旅人说：“' + technicalDialogue + '”';
  const answer = canonical([cue(technicalDialogue), '无']);
  const stages: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({ board: makeDraft(source, ['无', '无']), converter,
    sourceStoryContent: source, context: { assets: [], characters: [] }, clean,
    request: async (_system, user, stage) => {
      stages.push(stage);
      return stage === 'convert' ? answer : user.replace(/[\p{Script=Han}]+/gu, ' translated ');
    },
  });
  assert.deepEqual(stages, ['convert', 'translate']);
  assert.ok(result.officialPromptZh?.includes(technicalDialogue));
  assert.equal(result.officialPromptEnError, '');
  assert.ok(result.officialPromptEn?.includes(technicalDialogue));
}

// A confirmed master is not rejudged by local dialogue extraction. Reuse does
// not secretly submit another paid conversion, even with no converter enabled.
for (const cachedDialogueMissing of [false, true]) {
  const draft = makeDraft();
  const cachedPrompt = cachedDialogueMissing ? missing : complete;
  const board: Storyboard = {
    ...draft, sequencePlanId: 'confirmed-plan', segmentId: 'segment-2',
    finalPrompt: cachedPrompt, shots: draft.shots.map((shot, index) => ({ ...shot, prompt: cachedPrompt.split('\n')[index] })),
    promptPlan: { ...draft.promptPlan!, canonicalPrompt: cachedPrompt },
    promptTrace: { ...draft.promptTrace!, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(cachedPrompt) },
  };
  assert.equal(hasCurrentTextApiConversion(board), true);
  const before = JSON.stringify(board);
  const stages: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({ board, sourceStoryContent: SOURCE,
    skipConversion: true, context: { assets: [], characters: [] }, clean,
    request: async (_system, user, stage) => {
      stages.push(stage);
      assert.equal(stage, 'translate');
      return user.replace(/[\p{Script=Han}]+/gu, ' translated ');
    },
  });
  assert.deepEqual(stages, ['translate']);
  assert.equal(result.finalPrompt, cachedPrompt);
  assert.equal(result.officialPromptZh?.includes(SECOND_LINE), !cachedDialogueMissing);
  assertPreserved(result, board);
  assert.equal(JSON.stringify(board), before);
}

for (const [failureAt, errorMessage] of [
  [1, 'HTTP 401: invalid credentials'], [2, 'HTTP 401: invalid credentials'],
  [1, 'Network connection failed'], [2, 'Network connection failed'],
] as const) {
  const board = makeDraft();
  const before = JSON.stringify(board);
  const transportError = new Error(errorMessage);
  let requests = 0;
  await assert.rejects(generateSingleSegmentPrompt({ board, converter, context: { assets: [], characters: [] }, clean,
    request: async (_system, _user, stage) => {
      assert.equal(stage, 'convert');
      requests += 1;
      if (requests === failureAt) throw transportError;
      return unreadable;
    },
  }), (error: unknown) => error === transportError);
  assert.equal(requests, failureAt, 'API transport/authentication failure is not a candidate to repair');
  assert.equal(JSON.stringify(board), before);
}
for (const staleAt of [1, 2]) {
  const board = makeDraft();
  const before = JSON.stringify(board);
  const stages: SingleSegmentPromptStage[] = [];
  let current = true;
  await assert.rejects(generateSingleSegmentPrompt({ board, converter, context: { assets: [], characters: [] }, clean,
    isCurrent: () => current,
    request: async (_system, _user, stage) => {
      stages.push(stage);
      if (stages.length === staleAt) current = false;
      return unreadable;
    },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(stages.length, staleAt);
  assert.ok(stages.every((stage) => stage === 'convert'), 'stale Chinese work cannot start translation');
  assert.equal(JSON.stringify(board), before);
}

console.log('dialogue retention: AI full-source self-review, lossless acceptance, structural repair and atomic safety checks passed');
