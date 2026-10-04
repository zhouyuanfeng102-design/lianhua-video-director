import assert from 'node:assert/strict';
import { applyOfficialH3Prompt, buildOfficialH3References, hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import { AUDIO_EXISTING_SCOPE_RULE, AUDIO_H3_DELIVERY_RULE } from '../src/audioPromptPolicy';
import { regenerateSequenceReferencePrompt, type RegenerateSequenceReferencePromptInput, type SequenceReferencePromptStage } from './fixtures/h3PipelineMock';
import type { ConverterPreset, ReferenceAsset, Storyboard, VideoSegment, VideoShot } from '../src/types';
import { sourceContentHash } from '../src/sourceIntegrity';

const mockEnglish = (value: string): string => value.replaceAll('先开门。', 'Open the door first.')
  .replace(/[\p{Script=Han}]+/gu, ' translated ');

const sourceParts = [
  '旅人把手掌压在木门上，说“先开门。”',
  '旅人推开木门踏入门廊。',
  '旅人转身把木门合拢。',
];
const content = sourceParts.join('');
const localSourceRanges = sourceParts.map((part, index) => {
  const start = sourceParts.slice(0, index).join('').length;
  return [start, start + part.length];
});
const previousStory = 'OTHER_SEGMENT_PREVIOUS_STORY。'.repeat(5);
const fullStory = `${previousStory}${content}OTHER_SEGMENT_NEXT_STORY。`;
const localActions = ['手掌压住门板', '推开木门→走进门廊', '转向木门→合拢门板'];
const convertedActions = ['手掌贴住门板并压稳', '肩部前送推开木门→跨进门廊站稳', '转身握住门沿→拉拢木门直到门缝合严'];
const promptFor = (actions: readonly string[]): string => actions.map((action, index) => [
  `【${index * 5}s-${(index + 1) * 5}s】 主体：@旅人（警惕）[朝向：木门] 正在 [${action}]（推进本段）`,
  '空间：前景-木门 中景-旅人 背景-门廊',
  '光影：左侧冷灰散射光',
  '镜头：中景稳定侧拍',
  index === 0 ? '台词：第1s @旅人："先开门。"' : '台词：无',
  '音效：环境层-[无] 动作层-[第2s接触声] 情绪层-[无配乐]',
].join('；')).join('\n');
const canonical = promptFor(localActions);
const convertedCanonical = promptFor(convertedActions);
let sourceCursor = previousStory.length;
const shots: VideoShot[] = sourceParts.map((action, index) => {
  const shot: VideoShot = {
    id: `segment-shot-${index + 1}`,
    index: index + 1,
    startSec: index * 5,
    endSec: (index + 1) * 5,
    purpose: '推进本段',
    subject: '旅人',
    action,
    camera: '中景稳定侧拍',
    transition: '硬切',
    lighting: '冷灰散射光',
    sound: '第2s接触声',
    result: `本段结果${index + 1}`,
    referenceAssetIds: ['selected-image-a'],
    sourceBeatIds: [`whole-story-beat-${index + 10}`],
    sourceStart: sourceCursor,
    sourceEnd: sourceCursor + action.length,
    prompt: canonical.split('\n')[index]!,
    locked: index === 1,
  };
  sourceCursor += action.length;
  return shot;
});
const asset = (id: string, name: string): ReferenceAsset => ({
  id, name, type: 'reference', role: 'character', mediaType: 'image', source: 'upload',
  visualAnchor: `${name}的服装与构图`, tags: [], createdAt: 1, updatedAt: 1,
});
const context = {
  assets: [
    asset('other-image', 'OTHER_SEGMENT_IMAGE'),
    asset('selected-image-b', '当前门廊构图'),
    asset('selected-image-a', '当前旅人外观'),
  ],
  sceneContent: fullStory,
};
const baseBoard: Storyboard = {
  id: 'segment-board', sceneId: 'whole-scene', sourceSceneIds: ['whole-scene'],
  sourceStoryTitle: 'WHOLE_STORY_TITLE', sourceStoryContent: fullStory, sourceContentHash: 'original-source-hash',
  sourceSceneSnapshots: [{ id: 'whole-scene', title: '原场景', content: fullStory, summary: '全片原场景', characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 }],
  workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: 'style-current', ruleSetId: 'rule-current', converterPresetId: 'old-converter',
  globalLock: '保持旅人服装与木门空间方向一致', extraRequirement: '对白清晰',
  globalReferenceAssetIds: ['selected-image-b'],
  shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  sequencePlanId: 'whole-plan', segmentId: 'segment-2', segmentIndex: 2, segmentCount: 3,
  globalStartSec: 15, globalEndSec: 30, continuityIn: '原入场记录', continuityOut: '原离场记录',
  promptPlan: {
    canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    workflow: 'drama', inputMode: 'text_reference', shotIds: shots.map((shot) => shot.id), referenceAssetIds: ['selected-image-a'],
    constraints: ['保持旅人与木门的位置连续'], trace: { ruleSetId: 'rule-current', converterId: 'old-converter' },
  },
  promptTrace: {
    modelRuleSetId: 'rule-current', converterPresetId: 'old-converter', sourceDocumentIds: ['original-document'],
    referenceAssetIds: ['selected-image-a'], generatedAt: 1, mode: 'text-api', shotPlanMode: 'ai-complete',
    convertedPromptFingerprint: sourceContentHash(canonical),
  },
};
const initialOfficial = applyOfficialH3Prompt(baseBoard, context);
const board: Storyboard = {
  ...initialOfficial,
  officialPromptEn: 'old English result', officialPromptEnSource: initialOfficial.officialPromptZh,
  targetOutput: { ...initialOfficial.targetOutput!, parameters: { ...initialOfficial.targetOutput!.parameters, seed: 1234567, steps: 15, cfg: 1, custom: { audioSteps: 15 } } },
};
const segment: VideoSegment = {
  id: 'segment-2', index: 2, title: '当前单段', globalStartSec: 15, globalEndSec: 30, durationSec: 15,
  content, summary: '旅人开门进入并合门', sourceSceneIds: ['whole-scene'], sourceBeatIds: ['original-beat'],
  sourceShotIds: ['master-shot-a', 'master-shot-b', 'master-shot-c'],
  narrativePurpose: '进入门廊', entryState: '旅人已经站在门外', exitState: '旅人留在门廊内且木门合拢',
  transitionHint: '接下段门廊情节', storyboardId: board.id, status: 'ready',
};
const converter: ConverterPreset = {
  id: 'selected-converter', name: '当前转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  systemPrompt: '把本段事实转换成可见动作。', outputRules: '保留六字段与镜头边界。',
  enabled: true, version: 'test', updatedAt: 1,
};
const baseInput = {
  board, segment, context, converter, clean: (value: string) => value.trim(), now: () => 12345,
};
const jsonBlock = (prompt: string, tag: string): Record<string, any> => {
  const match = prompt.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `request must contain ${tag}`);
  return JSON.parse(match[1]!);
};
const boardSnapshot = JSON.stringify(board);
const segmentSnapshot = JSON.stringify(segment);
const contextSnapshot = JSON.stringify(context);
const otherBoard = { ...board, id: 'other-board', segmentId: 'other-segment', finalPrompt: 'OTHER_BOARD_RESULT' };
const otherBoardSnapshot = JSON.stringify(otherBoard);
const calls: SequenceReferencePromptStage[] = [];
const stages: SequenceReferencePromptStage[] = [];
const request: RegenerateSequenceReferencePromptInput['request'] = async (system, user, stage) => {
  calls.push(stage);
  assert.doesNotMatch(user, /OTHER_SEGMENT|WHOLE_STORY_TITLE|OTHER_BOARD_RESULT/u, 'only this segment and its current references may reach either API');
  assert.doesNotMatch(system, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符/u, 'neither conversion nor translation has a numeric character cap; explicit no-cap instructions are allowed');
  if (stage === 'translate') return mockEnglish(user);
  assert.doesNotMatch(system + user, /sequence_reference_data|sequence_reference_conversion_contract|h3_translation_units|unit_\d+/u);
  assert.match(system, /未发送图片像素/u);
  const conversion = jsonBlock(user, 'video_conversion_data');
  assert.equal(conversion.sourceStoryContent, content);
  assert.equal(conversion.shotEvidence.length, 3);
  assert.deepEqual(conversion.shotEvidence.map((item: any) => [item.sourceStart, item.sourceEnd]), localSourceRanges,
    'global provenance offsets must be rebased to the complete transmitted segment source');
  assert.deepEqual(conversion.shotEvidence.map((item: any) => conversion.sourceStoryContent.slice(item.sourceStart, item.sourceEnd)), sourceParts,
    'AI can locate every original source passage from the full source and unchanged advisory offsets');
  assert.ok(conversion.shotEvidence.every((item: any) => item.sourceExcerpt === ''),
    'a missing stored excerpt does not authorize local pre-extraction');
  assert.ok(conversion.globalContinuityFacts.includes(segment.entryState));
  assert.ok(conversion.globalContinuityFacts.includes(segment.exitState));
  assert.deepEqual(conversion.shotEvidence.map((item: any) => item.exactTimeLabel), shots.map(({ prompt }) => prompt.match(/^【[^】]+】/u)![0]));
  const scoped = jsonBlock(user, 'current_reference_data');
  assert.deepEqual(scoped.currentReferences.map((item: any) => item.id), buildOfficialH3References(board, context.assets).map((item) => item.id));
  assert.deepEqual(scoped.currentReferences.map((item: any) => item.imageIndex), [1, 2]);
  return convertedCanonical;
};
const result = await regenerateSequenceReferencePrompt({ ...baseInput, request, onStage: (stage) => stages.push(stage) });
assert.deepEqual(calls, ['convert', 'translate'], 'a completed reference segment must use the converter API before H3 compilation and then English API');
assert.deepEqual(stages, calls);
assert.equal(result.finalPrompt, convertedCanonical);
assert.equal(result.promptPlan?.canonicalPrompt, convertedCanonical);
assert.equal(result.promptPlan?.trace.converterId, converter.id);
assert.deepEqual(result.promptPlan?.constraints, board.promptPlan?.constraints);
assert.equal(result.converterPresetId, converter.id);
assert.equal(result.updatedAt, 12345);
assert.equal(hasCurrentTextApiConversion(result), true);
assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
assert.equal(result.officialPromptEnSource, result.officialPromptZh);
assert.equal(result.englishPrompt, result.officialPromptEn);
assert.equal(result.englishPromptSource, convertedCanonical);
assert.deepEqual(result.targetOutput?.parameters, board.targetOutput?.parameters, 'API regeneration must preserve seed and every standard/custom generation parameter');
assert.deepEqual(result.promptTrace?.sourceDocumentIds, board.promptTrace?.sourceDocumentIds);
assert.equal(result.promptTrace?.shotPlanMode, 'ai-complete');
assert.deepEqual(result.promptTrace?.referenceAssetIds, ['selected-image-a', 'selected-image-b']);
for (const key of ['id', 'sceneId', 'sourceStoryTitle', 'sourceStoryContent', 'sourceContentHash', 'sourceSceneIds', 'sourceSceneSnapshots', 'globalLock', 'extraRequirement', 'globalStartSec', 'globalEndSec', 'sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount', 'continuityIn', 'continuityOut', 'durationSec', 'shotCount', 'createdAt', 'globalReferenceAssetIds'] as const) {
  assert.deepEqual(result[key], board[key], `original provenance/settings field must survive: ${key}`);
}
result.shots.forEach((shot, index) => {
  const { subject: _subject, action: _action, prompt: _prompt, authoredBy: _authoredBy, ...preserved } = shot;
  const { subject: _oldSubject, action: _oldAction, prompt: _oldPrompt, authoredBy: _oldAuthoredBy, ...original } = board.shots[index]!;
  assert.deepEqual(preserved, original, 'shot id, boundaries, locks, references and original source coordinates must remain unchanged');
  assert.equal(shot.authoredBy, 'text-api', 'the new converted content remains marked as model-authored');
  assert.equal(shot.prompt, convertedCanonical.split('\n')[index]);
});
assert.equal(JSON.stringify(board), boardSnapshot);
assert.equal(JSON.stringify(segment), segmentSnapshot);
assert.equal(JSON.stringify(context), contextSnapshot);
assert.equal(JSON.stringify(otherBoard), otherBoardSnapshot);

let pixelContract = '';
await regenerateSequenceReferencePrompt({ ...baseInput, hasImageInputs: true, request: async (system, user, stage) => {
  if (stage === 'convert') { pixelContract = system; return convertedCanonical; }
  return mockEnglish(user);
} });
assert.match(pixelContract, /参考图真实像素/u);
assert.doesNotMatch(pixelContract, /未发送图片像素/u);

// Numerically valid offsets are not necessarily segment-local offsets.
const ambiguousOffsetBoard = {
  ...board,
  sourceStoryContent: content,
  shots: board.shots.map((shot) => ({ ...shot, action: `本镜已保存事实：${shot.action}`, sourceStart: 1, sourceEnd: 4 })),
};
await regenerateSequenceReferencePrompt({ ...baseInput, board: ambiguousOffsetBoard, request: async (_system, user, stage) => {
  if (stage === 'translate') return mockEnglish(user);
  const conversion = jsonBlock(user, 'video_conversion_data');
  assert.equal(conversion.sourceStoryContent, content, 'unproven excerpt coordinates never remove the complete segment source');
  const evidence = conversion.shotEvidence;
  assert.deepEqual(evidence.map((item: any) => item.sourceExcerpt), ['', '', ''], 'unproven coordinates cannot turn planned actions into fabricated source excerpts');
  assert.ok(evidence.every((item: any) => item.sourceStart === undefined && item.sourceEnd === undefined));
  assert.ok(evidence.every((item: any) => item.sourceLocationStatus === 'unlocated'));
  assert.deepEqual(evidence.map((item: any) => item.plannedAction), ambiguousOffsetBoard.shots.map((shot) => shot.action), 'the model still receives the established shot plan beside the complete segment source');
  return convertedCanonical;
} });
const whitespaceSegment = { ...segment, content: `  ${content}  ` };
const whitespaceBoard = {
  ...board,
  sourceStoryContent: `${previousStory}${whitespaceSegment.content}OTHER_SEGMENT_NEXT_STORY。`,
  shots: board.shots.map((shot) => ({ ...shot, sourceStart: shot.sourceStart! + 2, sourceEnd: shot.sourceEnd! + 2 })),
};
await regenerateSequenceReferencePrompt({ ...baseInput, board: whitespaceBoard, segment: whitespaceSegment, request: async (_system, user, stage) => {
  if (stage === 'translate') return mockEnglish(user);
  const conversion = jsonBlock(user, 'video_conversion_data');
  assert.equal(conversion.sourceStoryContent, content);
  assert.deepEqual(conversion.shotEvidence.map((item: any) => [item.sourceStart, item.sourceEnd]), localSourceRanges,
    'temporary source offsets must match the complete trimmed segment, not its padded input');
  assert.deepEqual(conversion.shotEvidence.map((item: any) => conversion.sourceStoryContent.slice(item.sourceStart, item.sourceEnd)), sourceParts,
    'rebased offsets still identify the original source without a local excerpt extractor');
  return convertedCanonical;
} });

let verbatimCalls = 0;
const verifiedUnchanged = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (_system, user, stage) => {
  verbatimCalls += 1;
  if (stage === 'translate') return mockEnglish(user);
  return jsonBlock(user, 'video_conversion_data').shotEvidence.map((item: any) => item.localStructureDraft).join('\n');
} });
assert.equal(verbatimCalls, 2, 'confirmed reference refresh must still call converter and translator even when wording remains valid');
assert.equal(verifiedUnchanged.finalPrompt, canonical);
assert.equal(hasCurrentOfficialH3EnglishPrompt(verifiedUnchanged, context), true);
let staleTraceCalls = 0;
const renewedStaleTrace = await regenerateSequenceReferencePrompt({ ...baseInput,
  board: { ...board, promptTrace: { ...board.promptTrace!, convertedPromptFingerprint: 'stale' } },
  request: async (_system, user, stage) => { staleTraceCalls += 1; return stage === 'convert' ? jsonBlock(user, 'video_conversion_data').shotEvidence.map((item: any) => item.localStructureDraft).join('\n') : mockEnglish(user); },
});
assert.equal(staleTraceCalls, 2, 'a stale trace must still use the API, but already valid wording does not need forced changes');
assert.equal(renewedStaleTrace.finalPrompt, canonical);
assert.equal(hasCurrentTextApiConversion(renewedStaleTrace), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(renewedStaleTrace, context), true);

let rejectedCalls = 0;
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, request: async () => {
  rejectedCalls += 1;
  return 'CONVERSION_REJECTED: 测试结构冲突';
} }), /转化器拒绝/u);
assert.equal(rejectedCalls, 1);
const translationFailureCalls: SequenceReferencePromptStage[] = [];
const chineseAfterTranslationFailure = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (_system, _user, stage) => {
  translationFailureCalls.push(stage);
  if (stage === 'translate') throw new Error('translation transport failed');
  return convertedCanonical;
} });
assert.deepEqual(translationFailureCalls, ['convert', 'translate']);
assert.equal(hasCurrentOfficialH3Prompt(chineseAfterTranslationFailure, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(chineseAfterTranslationFailure, context), false);
assert.match(chineseAfterTranslationFailure.officialPromptEnError || '', /translation transport failed/u);
for (const key of ['officialPromptEn', 'officialPromptEnSource', 'englishPrompt', 'englishPromptSource'] as const) {
  assert.equal(chineseAfterTranslationFailure[key], '', `partial Chinese must clear stale ${key}`);
}
assert.deepEqual(chineseAfterTranslationFailure.targetOutput?.parameters, board.targetOutput?.parameters);
const translationOnlyCalls: SequenceReferencePromptStage[] = [];
const completedEnglishOnly = await regenerateSequenceReferencePrompt({ ...baseInput, board: chineseAfterTranslationFailure,
  mode: 'translate-english', converter: undefined, segment: { ...segment, content: '' },
  request: async (_system, user, stage) => { translationOnlyCalls.push(stage); return mockEnglish(user); },
});
assert.deepEqual(translationOnlyCalls, ['translate']);
assert.equal(hasCurrentOfficialH3EnglishPrompt(completedEnglishOnly, context), true);
assert.equal(completedEnglishOnly.officialPromptEnError, '');
for (const key of ['shots', 'finalPrompt', 'promptPlan', 'promptTrace', 'targetOutput', 'officialPromptZh', 'officialPromptSource'] as const) {
  assert.deepEqual(completedEnglishOnly[key], chineseAfterTranslationFailure[key], `English retry must not change ${key}`);
}

let beforeCancelCalls = 0;
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, isCurrent: () => false, request: async () => { beforeCancelCalls += 1; return ''; } }), { name: 'AbortError' });
assert.equal(beforeCancelCalls, 0);
let current = true;
const cancelCalls: SequenceReferencePromptStage[] = [];
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, isCurrent: () => current, request: async (_system, _user, stage) => {
  cancelCalls.push(stage);
  current = false;
  return convertedCanonical;
} }), { name: 'AbortError' });
assert.deepEqual(cancelCalls, ['convert'], 'stale conversion must not proceed to compilation/translation');
current = true;
let cancelledBeforeNetwork = 0;
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, isCurrent: () => current, onStage: () => { current = false; }, request: async () => { cancelledBeforeNetwork += 1; return ''; } }), { name: 'AbortError' });
assert.equal(cancelledBeforeNetwork, 0, 'guard must be checked again after a stage callback');
current = true;
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, isCurrent: () => current, request: async (_system, user, stage) => {
  if (stage === 'convert') return convertedCanonical;
  current = false;
  return user;
} }), { name: 'AbortError' });

const tooLongActions = [...convertedActions];
tooLongActions[0] = `手掌贴住门板并压稳${'保持手掌接触位置与指节方向不变'.repeat(650)}`;
const tooLongCanonical = promptFor(tooLongActions);
const oldTooLongCanonical = promptFor([tooLongActions[0]!, ...localActions.slice(1)]);
const tooLongBoard = { ...board, finalPrompt: oldTooLongCanonical, promptPlan: { ...board.promptPlan!, canonicalPrompt: oldTooLongCanonical } };
assert.ok(applyOfficialH3Prompt(tooLongBoard, context).officialPromptZh!.length > 7000);
const apiFirstCalls: SequenceReferencePromptStage[] = [];
const recoveredOldLongDraft = await regenerateSequenceReferencePrompt({ ...baseInput, board: tooLongBoard, request: async (_system, user, stage) => {
  apiFirstCalls.push(stage);
  return stage === 'convert' ? convertedCanonical : mockEnglish(user);
} });
assert.deepEqual(apiFirstCalls, ['convert', 'translate'], 'long input still uses exactly one converter and one translator request');
assert.equal(recoveredOldLongDraft.finalPrompt, convertedCanonical);

const longChineseCalls: SequenceReferencePromptStage[] = [];
const longChinese = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (system, user, stage) => {
  longChineseCalls.push(stage);
  assert.doesNotMatch(system, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符|一次无损精简/u);
  return stage === 'convert' ? tooLongCanonical : mockEnglish(user);
} });
assert.deepEqual(longChineseCalls, ['convert', 'translate'], 'long Chinese cannot trigger an extra converter request');
assert.equal(longChinese.finalPrompt, tooLongCanonical);
assert.ok(longChinese.officialPromptZh!.length > 7000);
assert.equal(hasCurrentOfficialH3Prompt(longChinese, context), true);
assert.deepEqual(longChinese.targetOutput?.parameters, board.targetOutput?.parameters);
assert.deepEqual(longChinese.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sourceStart, shot.sourceEnd]),
  board.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sourceStart, shot.sourceEnd]));

for (const characters of [7254, 19281, 25000]) {
  const baseEnglish = result.officialPromptEn!;
  const tail = 'END_MUST_NOT_BE_TRUNCATED';
  const expected = `${baseEnglish}\n${'x'.repeat(characters - baseEnglish.length - 1 - tail.length)}${tail}`;
  const longEnglishCalls: SequenceReferencePromptStage[] = [];
  const longEnglish = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (system, user, stage) => {
    longEnglishCalls.push(stage);
    assert.doesNotMatch(system + user, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符|h3_translation_units|unit_\d+|"translations"/u);
    return stage === 'convert' ? convertedCanonical : expected;
  } });
  assert.deepEqual(longEnglishCalls, ['convert', 'translate'], 'long English is translated once without a concision retry');
  assert.equal(longEnglish.officialPromptEn, expected);
  assert.equal(longEnglish.officialPromptEn!.length, characters);
  assert.equal(longEnglish.officialPromptEnError, '');
  assert.equal(hasCurrentOfficialH3EnglishPrompt(longEnglish, context), true);
  assert.equal(longEnglish.officialPromptZh, result.officialPromptZh);
  assert.deepEqual(longEnglish.targetOutput?.parameters, board.targetOutput?.parameters);
}

const rawTagCalls: SequenceReferencePromptStage[] = [];
const restoredTagEnglish = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (_system, _user, stage) => {
  rawTagCalls.push(stage);
  return stage === 'convert' ? convertedCanonical : result.officialPromptEn!;
} });
assert.deepEqual(rawTagCalls, ['convert', 'translate']);
assert.equal(restoredTagEnglish.officialPromptEn, result.officialPromptEn, 'correct literal H3 labels must be accepted in the long-story adapter just like short stories');

const brokenTagCalls: SequenceReferencePromptStage[] = [];
const brokenTagEnglish = await regenerateSequenceReferencePrompt({ ...baseInput, request: async (_system, _user, stage) => {
  brokenTagCalls.push(stage);
  return stage === 'convert' ? convertedCanonical : result.officialPromptEn!.replace('<Subject 1>', '<Subject 99>');
} });
assert.deepEqual(brokenTagCalls, ['convert', 'translate'], 'invalid reference labels must fail directly, without a separate long-story repair protocol');
assert.equal(hasCurrentOfficialH3Prompt(brokenTagEnglish, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(brokenTagEnglish, context), false);
assert.match(brokenTagEnglish.officialPromptEnError || '', /官方标签/u);

current = true;
const cancelledEnglishRetryCalls: SequenceReferencePromptStage[] = [];
await assert.rejects(regenerateSequenceReferencePrompt({ ...baseInput, isCurrent: () => current, request: async (_system, user, stage) => {
  cancelledEnglishRetryCalls.push(stage);
  if (stage === 'convert') return convertedCanonical;
  current = false;
  return `${user}${' additional text'.repeat(1000)}`;
} }), { name: 'AbortError' });
assert.deepEqual(cancelledEnglishRetryCalls, ['convert', 'translate'], 'cancelled translation must not be saved or retried');
assert.equal(JSON.stringify(board), boardSnapshot, 'all failure, cancellation and retry paths must leave the original board untouched');
assert.equal(JSON.stringify(segment), segmentSnapshot);
assert.equal(JSON.stringify(context), contextSnapshot);
assert.equal(JSON.stringify(otherBoard), otherBoardSnapshot);

for (const mode of ['regenerate', 'reference-refresh', 'translate-english'] as const) {
  const aiCalls: Array<{ stage: SequenceReferencePromptStage; user: string }> = [];
  const aiStages: SequenceReferencePromptStage[] = [];
  const aiReviewProgress: number[] = [];
  const sourceBoard = mode === 'translate-english' ? result : board;
  const reviewedEnglish = result.officialPromptEn!.replaceAll('旅人', 'Traveler');
  let translations = 0;
  const reviewed = await regenerateSequenceReferencePrompt({
    ...baseInput,
    mode,
    board: sourceBoard,
    reviewWithAi: true,
    onStage: (stage) => aiStages.push(stage),
    onAiTranslationReview: () => aiReviewProgress.push(aiCalls.length),
    request: async (system, user, stage) => {
      aiCalls.push({ stage, user });
      if (mode === 'regenerate' && stage !== 'translate') {
        assert.ok(system.includes(AUDIO_H3_DELIVERY_RULE), 'active regeneration receives current dialogue/audio delivery rules');
        assert.equal(system.includes(AUDIO_EXISTING_SCOPE_RULE), false, 'active regeneration may re-evaluate sound design');
      }
      if (mode === 'reference-refresh' && stage !== 'translate') {
        assert.ok(system.includes(AUDIO_EXISTING_SCOPE_RULE), 'reference-only refresh preserves the saved sound plan');
        assert.equal(system.includes(AUDIO_H3_DELIVERY_RULE), false, 'reference-only refresh does not redesign sound');
      }
      if (stage === 'convert') return convertedCanonical;
      if (stage === 'review') {
        const data = jsonBlock(user, 'video_staging_review_data');
        assert.equal(data.sourceStoryContent, content, 'Chinese staging review is scoped to this segment');
        assert.equal(data.canonicalPrompt, convertedCanonical);
        return data.candidatePrompt;
      }
      translations += 1;
      if (translations === 1) return 'A incomplete English candidate, missing the subject and dialogue.';
      const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
      assert.equal(data.sourcePrompt, result.officialPromptZh, 'the adapter forwards the full current Chinese, not a source excerpt or masked tokens');
      assert.equal(data.candidateEnglishPrompt, 'A incomplete English candidate, missing the subject and dialogue.');
      return reviewedEnglish;
    },
  });
  assert.deepEqual(aiCalls.map((call) => call.stage), mode === 'regenerate' || mode === 'reference-refresh'
    ? ['convert', 'review', 'translate', 'translate'] : ['translate', 'translate']);
  assert.deepEqual(aiStages, mode === 'regenerate' || mode === 'reference-refresh' ? ['convert', 'review', 'translate'] : ['translate']);
  assert.deepEqual(aiReviewProgress, [mode === 'regenerate' || mode === 'reference-refresh' ? 3 : 1]);
  assert.equal(reviewed.officialPromptEn, reviewedEnglish);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(reviewed, context), true,
    'source freshness still applies, but no downstream entity/translation checks may reblock the reviewed result');
  assert.equal(reviewed.officialPromptEnError, '');
  assert.equal(JSON.stringify(board), boardSnapshot, 'AI review does not mutate the existing board before commit');
}

console.log('sequence reference API regeneration and AI English review checks passed');
