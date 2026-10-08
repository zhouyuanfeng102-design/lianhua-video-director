import assert from 'node:assert/strict';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import { generateSingleSegmentPrompt, getSingleSegmentReferences, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { composeDerivedLocalPrompt, hasCurrentTextApiConversion } from '../src/appEffects';
import { resolveConfirmedMasterSliceSource } from '../src/confirmedMasterSliceSource';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { sliceMasterShotsForSegment } from '../src/sequencePlan';
import { regenerateSequenceReferencePrompt } from '../src/sequenceReferencePrompt';
import { normalizeCanonicalDialogueQuotes } from '../src/dialogueCoverage';
import { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, type OfficialH3ProjectContext } from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { semanticSegmentStoryContent, type SemanticSegmentSourceContext } from '../src/semanticSequencePlan';
import type { Character, ConverterPreset, H3IdentityBindings, PromptCharacterParticipation, ReferenceAsset, Storyboard, VideoSegment, VideoSequencePlan, VideoShot } from '../src/types';

const hero: Character = {
  id: 'hero', name: '旅人', gender: '男', apparentAge: '成年', race: '人类', appearance: '黑发长眉',
  outfit: '黑色斗篷', signatureProps: '青铜钥匙', anchor: '左腕红绳', personality: '沉着',
  motionHabits: '稳住重心后迈步', negativeContinuity: '', assetIds: [],
};
const companion: Character = { ...hero, id: 'companion', name: '阿青', gender: '女', appearance: '短发圆脸', outfit: '青色短袍' };
const identity = (person: Character) => `人物“${person.name}”固定身份与外貌：性别：${person.gender}；种族/物种：${person.race}；外观：${person.appearance}；服装：${person.outfit}；固定道具：${person.signatureProps}；连续性锚点：${person.anchor}`;
const assets: ReferenceAsset[] = ['first', 'second'].map((id) => ({
  id, name: `${id}构图图`, mediaType: 'image', role: 'composition', referenceRole: 'composition', type: 'reference',
  source: 'generated', sourceStoryboardId: 'previous-board', sourceShotId: `${id}-shot`,
  visualAnchor: `${identity(hero)}\n${identity(companion)}\n本镜画面主体与站位：${id}图中旅人在左、阿青在右`,
  dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1,
}));
const context: OfficialH3ProjectContext = { assets, characters: [hero, companion] };
const sourceParts = ['旅人压住门板，说“先开门。”', '旅人接住阿青递来的钥匙。', '旅人握住门沿合拢木门。'];
const content = sourceParts.join('');
const localActions = ['手掌压住门板', '伸手接过阿青递来的钥匙', '转身把门拉上'];
const convertedActions = ['掌心平贴门板并压稳', '右手接住阿青递出的钥匙→手指合拢握紧', '转向木门握住门沿→拉拢门板直至门缝合严'];
const promptFor = (actions: string[]) => actions.map((action, index) => [
  `【${index * 5}s-${(index + 1) * 5}s】 主体：@旅人（男，警惕）[朝向：木门] 正在 [${action}]（推进当前事件）`,
  '空间：前景-木门 中景-旅人与阿青 背景-门廊', '光影：左侧冷灰散射光', '镜头：中景稳定侧拍',
  index === 0 ? '台词：第1s @旅人："先开门。"' : '台词：无',
  '音效：环境层-[无] 动作层-[第2s接触声] 情绪层-[无配乐]',
].join('；')).join('\n');
const canonical = promptFor(localActions);
const convertedCanonical = promptFor(convertedActions);
let cursor = 0;
const shots: VideoShot[] = sourceParts.map((action, index) => {
  const shot: VideoShot = {
    id: `shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
    subject: '旅人', action, purpose: '推进当前事件', camera: '中景稳定侧拍', transition: '硬切',
    lighting: '左侧冷灰散射光', sound: '第2s接触声', result: `原结果${index}`, locked: index === 1,
    referenceAssetIds: ['first'], sourceBeatIds: [`original-beat-${index}`], sourceStart: cursor, sourceEnd: cursor + action.length, sourceExcerpt: action,
    prompt: canonical.split('\n')[index],
  };
  cursor += action.length;
  return shot;
});
const shortBoard: Storyboard = {
  id: 'short-board', sceneId: 'scene', workflow: 'drama', inputMode: 'text_reference',
  sourceStoryContent: content, sourceStoryTitle: '原剧情', sourceContentHash: 'original-hash',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style', ruleSetId: 'rule', converterPresetId: 'old-converter',
  globalLock: '保持门廊内的左右关系', globalReferenceAssetIds: ['second'], shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  promptPlan: {
    canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'drama', inputMode: 'text_reference',
    shotIds: shots.map((shot) => shot.id), referenceAssetIds: ['first', 'second'], constraints: ['保持门廊内的左右关系'],
    trace: { ruleSetId: 'rule', converterId: 'old-converter' },
  },
  promptTrace: { mode: 'local-fallback', modelRuleSetId: 'rule', converterPresetId: 'old-converter', sourceDocumentIds: ['source-document'], referenceAssetIds: ['first'], generatedAt: 1 },
  targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: 'old', parameters: { seed: 1234567, steps: 15, cfg: 1, custom: { audioSteps: 15 } }, referenceManifest: [], warnings: [], generatedAt: 1 },
};
const prefix = 'OTHER_SEGMENT_BEFORE。'.repeat(3);
const longBoard: Storyboard = {
  ...shortBoard, id: 'long-board', sequencePlanId: 'whole-plan', segmentId: 'segment-2', segmentIndex: 2, segmentCount: 4,
  globalStartSec: 15, globalEndSec: 30, sourceStoryContent: `${prefix}${content}OTHER_SEGMENT_AFTER。`,
  globalLock: 'WHOLE_PLAN_PRIVATE_CONTINUITY',
  shots: shots.map((shot) => ({ ...shot, sourceStart: shot.sourceStart! + prefix.length, sourceEnd: shot.sourceEnd! + prefix.length })),
};
const conversionDraft: Storyboard = { ...longBoard, sourceStoryContent: content, globalLock: shortBoard.globalLock, sourceSceneSnapshots: [], shots };
const converter: ConverterPreset = { id: 'converter', name: '通用转换器', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true, version: 'test', systemPrompt: '将剧情转换为可见视频动作。', outputRules: '保留六字段与镜头边界。', updatedAt: 1 };
const clean = (value: string) => value.trim();
// The simulated AI owns name/dialogue fidelity. Production now receives its
// unmasked English directly and must not restore a destructive mock response.
const mockEnglish = (value: string) => value.split(/(旅人|阿青|林沐|先开门。)/u)
  .map((part) => /^(?:旅人|阿青|林沐|先开门。)$/u.test(part) ? part : part.replace(/[\p{Script=Han}]+/gu, ' translated ')).join('');
const jsonBlock = (value: string, tag: string) => JSON.parse(value.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))![1]);
const before = JSON.stringify({ shortBoard, longBoard, conversionDraft, context });
const outputs: Storyboard[] = [];
const calls: Array<Array<{ system: string; user: string; stage: SingleSegmentPromptStage }>> = [];
for (const [index, board] of [shortBoard, longBoard].entries()) {
  const captured: typeof calls[number] = [];
  const stages: SingleSegmentPromptStage[] = [];
  const result = await generateSingleSegmentPrompt({
    board, ...(index ? { conversionDraft } : {}), context, converter, sourceStoryContent: content, clean, hasImageInputs: true, now: () => 12345,
    onStage: (stage) => stages.push(stage),
    request: async (system, user, stage) => {
      captured.push({ system, user, stage });
      assert.ok(system.includes(stage === 'translate' ? 'STORY_CAUSALITY_TRANSLATION_V1' : 'STORY_CAUSALITY_V1'),
        'canonical conversion, H3 and English retain the action-causality contract');
      assert.doesNotMatch(`${system}\n${user}`, /sequence_reference|h3_translation_units|<h3_translation|OTHER_SEGMENT|WHOLE_PLAN_PRIVATE/u);
      assert.doesNotMatch(system, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符/u, 'neither shared API request carries a numeric character limit; explicit no-cap instructions are allowed');
      if (stage === 'translate') return mockEnglish(user);
      assert.match(system, /本次附有参考图真实像素/u);
      const current = jsonBlock(user, 'current_reference_data').currentReferences;
      assert.deepEqual(current.map((reference: any) => [reference.imageIndex, reference.id, reference.mediaType, reference.role]), [[1, 'first', 'image', 'composition'], [2, 'second', 'image', 'composition']]);
      assert.deepEqual(current.map((reference: any) => reference.description), getSingleSegmentReferences(board, context).map((reference) => reference.responsibility));
      assert.doesNotMatch(current[0].description, /黑发长眉/u, 'reference metadata uses derived identity deduplication');
      const data = jsonBlock(user, 'video_conversion_data');
      assert.equal(data.sourceStoryContent, content);
      assert.deepEqual(data.shotEvidence.map((item: any) => item.sourceExcerpt), sourceParts);
      return convertedCanonical;
    },
  });
  assert.deepEqual(captured.map((call) => call.stage), ['convert', 'translate']);
  assert.deepEqual(stages, ['convert', 'translate']);
  assert.equal(hasCurrentTextApiConversion(result), true);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  assert.equal(result.finalPrompt, convertedCanonical);
  assert.equal(result.officialPromptEnError, '', 'the English fixture must preserve the shared translator contract');
  assert.equal(result.officialPromptEnSource, result.officialPromptZh);
  assert.equal(result.englishPrompt, result.officialPromptEn);
  for (const key of ['sourceStoryContent', 'sourceContentHash', 'globalLock', 'globalStartSec', 'globalEndSec', 'sequencePlanId', 'segmentId'] as const) assert.deepEqual(result[key], board[key]);
  result.shots.forEach((shot, shotIndex) => {
    const { subject: _subject, action: _action, prompt: _prompt, authoredBy: _authoredBy, ...preserved } = shot;
    const { subject: _oldSubject, action: _oldAction, prompt: _oldPrompt, authoredBy: _oldAuthoredBy, ...original } = board.shots[shotIndex];
    assert.deepEqual(preserved, original, 'original IDs/source coordinates/locks/timing survive temporary local evidence');
  });
  calls.push(captured); outputs.push(result);
}
const shortContinuity = jsonBlock(calls[0][0].user, 'video_conversion_data').continuityContext;
const longContinuity = jsonBlock(calls[1][0].user, 'video_conversion_data').continuityContext;
assert.equal(shortContinuity.globalStartSec, undefined);
assert.equal(shortContinuity.globalEndSec, undefined);
assert.equal(longContinuity.globalStartSec, 15, 'the long segment carries its real whole-film start coordinate');
assert.equal(longContinuity.globalEndSec, 30, 'the long segment carries its real whole-film end coordinate');
const withoutWholeFilmCoordinates = (requests: typeof calls[number]) => requests.map((request) => {
  if (request.stage !== 'convert') return request;
  const payload = jsonBlock(request.user, 'video_conversion_data');
  const { globalStartSec: _start, globalEndSec: _end, ...localContinuity } = payload.continuityContext;
  payload.continuityContext = localContinuity;
  return { ...request, user: request.user.replace(/<video_conversion_data>[\s\S]*?<\/video_conversion_data>/u,
    `<video_conversion_data>${JSON.stringify(payload)}</video_conversion_data>`) };
});
assert.deepEqual(withoutWholeFilmCoordinates(calls[0]), withoutWholeFilmCoordinates(calls[1]),
  'short and long use the same converter/translator protocol and local evidence, with only their actual whole-film coordinates differing');
assert.equal(outputs[0].officialPromptZh, outputs[1].officialPromptZh);
assert.equal(outputs[0].officialPromptEn, outputs[1].officialPromptEn);
assert.deepEqual(outputs[0].targetOutput?.parameters, outputs[1].targetOutput?.parameters);
assert.equal(outputs[0].targetOutput?.parameters.seed, 1234567);
assert.equal(JSON.stringify({ shortBoard, longBoard, conversionDraft, context }), before);

// The AI may resolve a draft's generic identity to a name from the complete
// story. Neither canonical metadata, H3 rendering nor English can restore the
// stale subject/action simply because the old character card differs.
const aliasCanonical = convertedCanonical.replaceAll('旅人', '林沐');
const aliasCalls: SingleSegmentPromptStage[] = [];
const aliasResult = await generateSingleSegmentPrompt({
  board: shortBoard, context, converter, clean,
  sourceStoryContent: `旅人实名林沐。${content}`,
  request: async (_system, user, stage) => {
    aliasCalls.push(stage);
    if (stage === 'translate') return mockEnglish(user);
    assert.equal(jsonBlock(user, 'video_conversion_data').sourceStoryContent, `旅人实名林沐。${content}`);
    return aliasCanonical;
  },
});
assert.deepEqual(aliasCalls, ['convert', 'translate'], 'an AI-resolved name must not cause a local repair request');
assert.equal(aliasResult.finalPrompt, aliasCanonical);
assert.deepEqual(aliasResult.shots.map((shot) => shot.subject), ['林沐', '林沐', '林沐']);
assert.deepEqual(aliasResult.shots.map((shot) => shot.action), convertedActions);
assert.ok(aliasResult.officialPromptZh?.includes('林沐'));
assert.ok(aliasResult.officialPromptEn?.includes('林沐'));
assert.equal(aliasResult.officialPromptEnError, '');
assert.equal(hasCurrentOfficialH3Prompt(aliasResult, context), true);
assert.deepEqual(shortBoard.shots.map((shot) => shot.subject), ['旅人', '旅人', '旅人'], 'conversion never mutates the previous result');

// Trusted master slices still synchronize their shot views from the exact
// approved canonical text; this does not authorize re-running conversion.
const trusted = { ...outputs[1], shots: longBoard.shots.map((shot) => ({ ...shot, prompt: 'stale shot display' })) };
const skipCalls: SingleSegmentPromptStage[] = [];
const skipped = await generateSingleSegmentPrompt({ board: trusted, context, clean, skipConversion: true,
  request: async (_system, user, stage) => { skipCalls.push(stage); return mockEnglish(user); },
});
assert.deepEqual(skipCalls, ['translate']);
assert.equal(skipped.finalPrompt, trusted.finalPrompt);
assert.deepEqual(skipped.promptTrace, trusted.promptTrace);
assert.deepEqual(skipped.shots.map((shot) => shot.prompt), convertedCanonical.split('\n'));
assert.deepEqual(skipped.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.startSec, shot.endSec]), trusted.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.startSec, shot.endSec]));
assert.deepEqual(skipped.targetOutput?.parameters, outputs[1].targetOutput?.parameters);
await assert.rejects(generateSingleSegmentPrompt({ board: shortBoard, context, clean, skipConversion: true, request: async () => { throw new Error('must not request'); } }), /只有已通过 API/u);
const hugeCanonical = promptFor([`掌心平贴门板并压稳${'保持接触位置与指节方向不变'.repeat(800)}`, ...convertedActions.slice(1)]);
const oversized: Storyboard = { ...trusted, finalPrompt: hugeCanonical, promptPlan: { ...trusted.promptPlan!, canonicalPrompt: hugeCanonical }, promptTrace: { ...trusted.promptTrace!, convertedPromptFingerprint: sourceContentHash(hugeCanonical) } };
assert.ok(applyOfficialH3Prompt(oversized, context).officialPromptZh!.length > 7000);
assert.equal(getSingleSegmentReferences(oversized, context).length, 2, 'reference access does not depend on draft length');
const longSkipCalls: SingleSegmentPromptStage[] = [];
const longSkipped = await generateSingleSegmentPrompt({ board: oversized, context, clean, skipConversion: true,
  request: async (system, user, stage) => {
    longSkipCalls.push(stage);
    assert.doesNotMatch(system, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符/u);
    return mockEnglish(user);
  },
});
assert.deepEqual(longSkipCalls, ['translate'], 'a long trusted master slice does not rerun conversion to fit a local cap');
assert.equal(longSkipped.finalPrompt, hugeCanonical);
assert.ok(longSkipped.officialPromptZh!.length > 7000, 'complete long Chinese remains a valid delivery');
assert.equal(hasCurrentOfficialH3Prompt(longSkipped, context), true);
assert.deepEqual(longSkipped.targetOutput?.parameters, oversized.targetOutput?.parameters);
assert.deepEqual(longSkipped.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sourceStart, shot.sourceEnd]),
  oversized.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sourceStart, shot.sourceEnd]));

// Two segments can own different exact ranges inside one coarse source beat.
// Rechecking segment.content would pull all four lines into both segments.
const scopedSourceParts = [
  '夜色覆盖山门。',
  '两人来到门廊。',
  '旅人说：“第一句只在第三段。”',
  '阿青说：“第二句只在第四段。”旅人说：“第三句仍在第四段。”阿青说：“第四句也在第四段。”',
];
const scopedFullSource = scopedSourceParts.join('');
const coarseDialogueSource = scopedSourceParts.slice(2).join('');
const scopedDialogues = [
  '无',
  '无',
  '第1s @旅人:"第一句只在第三段。"',
  '第1s @阿青:"第二句只在第四段。"｜第6s @旅人:"第三句仍在第四段。"｜第11s @阿青:"第四句也在第四段。"',
];
let scopedCursor = 0;
const scopeMasterShots: VideoShot[] = scopedSourceParts.map((part, index) => {
  const prompt = `【${index * 15}s-${(index + 1) * 15}s】 主体：@旅人（专注）[朝向：门外] 正在 [旅人抬眼望向门外]（推进剧情）；空间：前景-木门 中景-旅人 背景-门廊；光影：柔和侧光；镜头：稳定中景；台词：${scopedDialogues[index]}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
  const shot: VideoShot = {
    ...shots[0],
    id: `scope-master-${index + 1}`,
    index: index + 1,
    startSec: index * 15,
    endSec: (index + 1) * 15,
    action: part,
    sourceBeatIds: [index >= 2 ? 'shared-large-dialogue-beat' : `scope-beat-${index}`],
    sourceStart: scopedCursor,
    sourceEnd: scopedCursor + part.length,
    sourceExcerpt: part,
    sourceLocationStatus: 'located',
    prompt,
  };
  scopedCursor += part.length;
  return shot;
});
const scopeMasterPrompt = scopeMasterShots.map((shot) => shot.prompt).join('\n');
const scopeMaster: Storyboard = {
  ...shortBoard,
  id: 'scope-master',
  sequencePlanId: 'scope-plan',
  sourceStoryContent: scopedFullSource,
  sourceContentHash: sourceContentHash(scopedFullSource),
  durationSec: 60,
  durationPreset: 'custom',
  shotCount: 4,
  shots: scopeMasterShots,
  finalPrompt: scopeMasterPrompt,
  promptPlan: { ...shortBoard.promptPlan!, canonicalPrompt: scopeMasterPrompt, durationSec: 60, shotIds: scopeMasterShots.map((shot) => shot.id) },
  promptTrace: { ...shortBoard.promptTrace!, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(scopeMasterPrompt) },
};
const scopeSegments: VideoSegment[] = scopeMasterShots.map((shot, index) => ({
  id: `scope-segment-${index + 1}`,
  index: index + 1,
  title: `第${index + 1}段`,
  globalStartSec: shot.startSec,
  globalEndSec: shot.endSec,
  durationSec: 15,
  content: index >= 2 ? coarseDialogueSource : scopedSourceParts[index],
  summary: '本段摘要',
  sourceSceneIds: ['scope-scene'],
  sourceBeatIds: shot.sourceBeatIds!,
  sourceShotIds: [shot.id],
  narrativePurpose: '推进本段',
  entryState: '',
  exitState: '',
  transitionHint: '自然接续',
  status: 'planned',
}));
const scopePlan: VideoSequencePlan = {
  id: 'scope-plan', title: '共享粗节拍', sourceStoryTitle: '原剧情', sourceStoryContent: scopedFullSource,
  sourceContentHash: sourceContentHash(scopedFullSource), durationMode: 'fixed', requestedTotalDurationSec: 60,
  totalDurationSec: 60, segmentDurationSec: 15, segmentationMode: 'fixed', segmentationSource: 'ai',
  fitStatus: 'balanced', estimateReason: '测试', masterStoryboardId: scopeMaster.id, planningStage: 'segmented',
  segments: scopeSegments, createdAt: 1, updatedAt: 1,
};
scopePlan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(scopePlan, scopeMaster);
const makeScopedBoard = (master: Storyboard, segment: VideoSegment): Storyboard => {
  const slice = sliceMasterShotsForSegment(master.shots, segment);
  const prompt = composeDerivedLocalPrompt(slice.shots, segment.entryState, segment.exitState);
  return {
    ...master,
    id: `${segment.id}-board`,
    sourceStoryContent: segment.content,
    durationSec: segment.durationSec,
    durationPreset: '15s',
    shotCount: slice.shots.length,
    shots: slice.shots,
    finalPrompt: prompt,
    segmentId: segment.id,
    segmentIndex: segment.index,
    globalStartSec: segment.globalStartSec,
    globalEndSec: segment.globalEndSec,
    promptPlan: { ...master.promptPlan!, canonicalPrompt: prompt, durationSec: segment.durationSec, shotIds: slice.shots.map((shot) => shot.id) },
    promptTrace: { ...master.promptTrace!, convertedPromptFingerprint: sourceContentHash(prompt) },
  };
};
const sourceScopeSnapshot = JSON.stringify({ scopeMaster, scopePlan, scopeSegments });
for (const index of [2, 3]) {
  const segment = scopeSegments[index];
  const scopedBoard = makeScopedBoard(scopeMaster, segment);
  const boardBefore = JSON.stringify(scopedBoard);
  const masterSource = { plan: scopePlan, masterBoard: scopeMaster, segment };
  const evidence = resolveConfirmedMasterSliceSource(scopedBoard, masterSource);
  assert.equal(evidence?.sourceStoryContent, scopedSourceParts[index], 'master shot offsets, not a shared coarse beat, own this segment source');
  assert.deepEqual(evidence?.conversionDraft.shots.map((shot) => [shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]), [[0, scopedSourceParts[index].length, []]], 'temporary evidence offsets must be rebased to the exact source union');
  const scopedCalls: SingleSegmentPromptStage[] = [];
  const scopedResult = await generateSingleSegmentPrompt({
    board: scopedBoard,
    masterSource,
    context,
    clean,
    sourceStoryContent: segment.content,
    skipConversion: true,
    request: async (_system, user, stage) => { scopedCalls.push(stage); assert.equal(stage, 'translate'); return mockEnglish(user); },
  });
  assert.deepEqual(scopedCalls, ['translate'], 'a complete master slice must not be re-converted to import the next segment dialogue');
  assert.equal(scopedResult.finalPrompt, scopedBoard.finalPrompt);
  assert.doesNotMatch(scopedResult.officialPromptZh || '', index === 2
    ? /第二句只在第四段|第三句仍在第四段|第四句也在第四段/u
    : /第一句只在第三段/u, 'H3 compilation must not import dialogue from the preserved coarse provenance text');
  assert.equal(scopedResult.sourceStoryContent, segment.content, 'stored coarse segment provenance must remain unchanged');
  assert.deepEqual(scopedResult.promptTrace, scopedBoard.promptTrace);
  assert.deepEqual(scopedResult.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]), scopedBoard.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]));
  assert.equal(JSON.stringify(scopedBoard), boardBefore);
}
assert.equal(JSON.stringify({ scopeMaster, scopePlan, scopeSegments }), sourceScopeSnapshot, 'source scoping must never mutate the master, plan or segment');

const thirdSegment = scopeSegments[2];
const thirdBoard = makeScopedBoard(scopeMaster, thirdSegment);
for (const invalidContext of [
  { plan: scopePlan, masterBoard: scopeMaster, segment: { ...thirdSegment, contentOverridden: true } },
  { plan: scopePlan, masterBoard: scopeMaster, segment: { ...thirdSegment, content: `${thirdSegment.content}用户新增对白。` } },
  { plan: { ...scopePlan, masterPromptConfirmedFingerprint: 'stale' }, masterBoard: scopeMaster, segment: thirdSegment },
  { plan: scopePlan, masterBoard: scopeMaster, segment: { ...thirdSegment, sourceShotIds: [] } },
  { plan: scopePlan, masterBoard: scopeMaster, segment: { ...thirdSegment, globalStartSec: 31, durationSec: 14 } },
]) assert.equal(resolveConfirmedMasterSliceSource(thirdBoard, invalidContext), undefined, 'edited/stale/unlinked/clipped slices must retain the conservative full-source path');
assert.equal(resolveConfirmedMasterSliceSource({ ...thirdBoard, shots: thirdBoard.shots.map((shot) => ({ ...shot, sourceLocationStatus: 'unlocated' })) }, { plan: scopePlan, masterBoard: scopeMaster, segment: thirdSegment }), undefined, 'unlocated source must never be narrowed from a prompt or action guess');
assert.equal(resolveConfirmedMasterSliceSource({ ...thirdBoard, finalPrompt: thirdBoard.finalPrompt.replace('旅人抬眼', '旅人转身') }, { plan: scopePlan, masterBoard: scopeMaster, segment: thirdSegment }), undefined, 'a changed canonical body is not an exact confirmed slice');

const lostMasterShots = scopeMaster.shots.map((shot, index) => index === 2
  ? { ...shot, prompt: shot.prompt.replace(scopedDialogues[2], '无') }
  : shot);
const lostMasterPrompt = lostMasterShots.map((shot) => shot.prompt).join('\n');
const lostMaster: Storyboard = { ...scopeMaster, shots: lostMasterShots, finalPrompt: lostMasterPrompt,
  promptPlan: { ...scopeMaster.promptPlan!, canonicalPrompt: lostMasterPrompt },
  promptTrace: { ...scopeMaster.promptTrace!, convertedPromptFingerprint: sourceContentHash(lostMasterPrompt) } };
const lostPlan = { ...scopePlan, masterPromptConfirmedFingerprint: masterPromptConfirmationFingerprint(scopePlan, lostMaster) };
const lostBoard = makeScopedBoard(lostMaster, thirdSegment);
const confirmedContentCalls: SingleSegmentPromptStage[] = [];
const retainedThird = await generateSingleSegmentPrompt({
  board: lostBoard, masterSource: { plan: lostPlan, masterBoard: lostMaster, segment: thirdSegment },
  context, clean, converter, sourceStoryContent: thirdSegment.content, skipConversion: true,
  request: async (_system, user, stage) => {
    confirmedContentCalls.push(stage);
    assert.equal(stage, 'translate', 'confirmed content is not rejudged against a local dialogue extractor');
    return mockEnglish(user);
  },
});
assert.deepEqual(confirmedContentCalls, ['translate'], 'reuse cannot silently become another conversion request');
assert.equal(retainedThird.finalPrompt, lostBoard.finalPrompt);
assert.equal(retainedThird.sourceStoryContent, thirdSegment.content);
assert.deepEqual(retainedThird.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]), lostBoard.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]));

const requestedRepairCalls: SingleSegmentPromptStage[] = [];
const requestedRepair = await generateSingleSegmentPrompt({
  board: lostBoard, masterSource: { plan: lostPlan, masterBoard: lostMaster, segment: thirdSegment },
  context, clean, converter, sourceStoryContent: thirdSegment.content,
  request: async (_system, user, stage) => {
    requestedRepairCalls.push(stage);
    if (stage === 'translate') return mockEnglish(user);
    const evidence = jsonBlock(user, 'video_conversion_data');
    assert.equal(evidence.sourceStoryContent, scopedSourceParts[2]);
    assert.equal(evidence.shotEvidence[0].sourceExcerpt, scopedSourceParts[2]);
    assert.doesNotMatch(user, /第二句只在第四段|第三句仍在第四段|第四句也在第四段/u);
    return thirdBoard.finalPrompt;
  },
});
assert.deepEqual(requestedRepairCalls, ['convert', 'translate'], 'an explicit regeneration still asks AI to process the source');
assert.equal(requestedRepair.finalPrompt, thirdBoard.finalPrompt);

const fourthSegment = scopeSegments[3];
const fourthBoard = makeScopedBoard(scopeMaster, fourthSegment);
const referenceScopeCalls: SingleSegmentPromptStage[] = [];
const refreshedFourth = await regenerateSequenceReferencePrompt({
  board: fourthBoard,
  segment: fourthSegment,
  masterSource: { plan: scopePlan, masterBoard: scopeMaster, segment: fourthSegment },
  context, clean, converter,
  request: async (_system, user, stage) => {
    referenceScopeCalls.push(stage);
    if (stage === 'translate') return mockEnglish(user);
    const evidence = jsonBlock(user, 'video_conversion_data');
    assert.equal(evidence.sourceStoryContent, scopedSourceParts[3]);
    assert.equal(evidence.shotEvidence[0].sourceExcerpt, scopedSourceParts[3]);
    assert.doesNotMatch(user, /第一句只在第三段/u);
    return fourthBoard.finalPrompt;
  },
});
assert.deepEqual(referenceScopeCalls, ['convert', 'translate'], 'reference refresh must still call the converter, using only exact source owned by this slice');
assert.equal(refreshedFourth.sourceStoryContent, fourthSegment.content);
assert.deepEqual(refreshedFourth.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]), fourthBoard.shots.map((shot) => [shot.id, shot.sourceStart, shot.sourceEnd, shot.sourceBeatIds]));

const broadFallbackPrompt = thirdBoard.finalPrompt.replace(scopedDialogues[2], `${scopedDialogues[2]}｜${scopedDialogues[3]}`);
const conservativeCalls: SingleSegmentPromptStage[] = [];
await generateSingleSegmentPrompt({
  board: { ...thirdBoard, shots: thirdBoard.shots.map((shot) => ({ ...shot, sourceLocationStatus: 'unlocated' })) },
  masterSource: { plan: scopePlan, masterBoard: scopeMaster, segment: thirdSegment },
  context, clean, converter, sourceStoryContent: thirdSegment.content,
  request: async (_system, user, stage) => {
    conservativeCalls.push(stage);
    if (stage === 'translate') return mockEnglish(user);
    const evidence = jsonBlock(user, 'video_conversion_data');
    assert.equal(evidence.sourceStoryContent, coarseDialogueSource, 'unlocated provenance cannot narrow the original full segment source');
    assert.equal(evidence.shotEvidence[0].sourceExcerpt, scopedSourceParts[2], 'stored AI excerpts remain context, not locally recomputed authority');
    assert.equal(evidence.shotEvidence[0].sourceLocationStatus, 'unlocated');
    return broadFallbackPrompt;
  },
});
assert.deepEqual(conservativeCalls, ['convert', 'translate']);

const legacyFourthDialogue = '第1s @阿青：「“第二句只在第四段。”第6s」 @旅人：「“第三句仍在第四段。”第11s」 @阿青：“第四句也在第四段。”';
const legacyMasterShots = scopeMaster.shots.map((shot, index) => index === 3
  ? { ...shot, prompt: shot.prompt.replace(scopedDialogues[3], legacyFourthDialogue) }
  : shot);
const legacyMasterPrompt = legacyMasterShots.map((shot) => shot.prompt).join('\n');
const legacyQuoteMaster: Storyboard = { ...scopeMaster, shots: legacyMasterShots, finalPrompt: legacyMasterPrompt,
  promptPlan: { ...scopeMaster.promptPlan!, canonicalPrompt: legacyMasterPrompt },
  promptTrace: { ...scopeMaster.promptTrace!, convertedPromptFingerprint: sourceContentHash(legacyMasterPrompt) } };
const legacyQuotePlan = { ...scopePlan, masterPromptConfirmedFingerprint: masterPromptConfirmationFingerprint(scopePlan, legacyQuoteMaster) };
const legacyQuoteBoard = makeScopedBoard(legacyQuoteMaster, fourthSegment);
const legacySnapshot = JSON.stringify({ legacyQuoteMaster, legacyQuotePlan, legacyQuoteBoard });
const normalizedQuotePrompt = normalizeCanonicalDialogueQuotes(legacyQuoteBoard.finalPrompt);
assert.notEqual(normalizedQuotePrompt, legacyQuoteBoard.finalPrompt);
const quoteCompatibilityCalls: SingleSegmentPromptStage[] = [];
const quoteCompatibleResult = await generateSingleSegmentPrompt({
  board: legacyQuoteBoard,
  masterSource: { plan: legacyQuotePlan, masterBoard: legacyQuoteMaster, segment: fourthSegment },
  context, clean, sourceStoryContent: fourthSegment.content, skipConversion: true,
  request: async (_system, user, stage) => { quoteCompatibilityCalls.push(stage); assert.equal(stage, 'translate'); return mockEnglish(user); },
});
assert.deepEqual(quoteCompatibilityCalls, ['translate'], 'readable confirmed quote text is preserved without local rewriting or another conversion');
assert.equal(quoteCompatibleResult.finalPrompt, legacyQuoteBoard.finalPrompt);
assert.equal(quoteCompatibleResult.promptPlan?.canonicalPrompt, legacyQuoteBoard.finalPrompt);
assert.equal(quoteCompatibleResult.shots[0].prompt, legacyQuoteBoard.finalPrompt);
assert.deepEqual(quoteCompatibleResult.promptTrace, legacyQuoteBoard.promptTrace);
assert.equal(hasCurrentTextApiConversion(quoteCompatibleResult), true);
assert.equal(quoteCompatibleResult.sourceStoryContent, fourthSegment.content);
assert.equal(JSON.stringify({ legacyQuoteMaster, legacyQuotePlan, legacyQuoteBoard }), legacySnapshot, 'quote compatibility must not mutate a confirmed master or another persisted source');
await assert.rejects(generateSingleSegmentPrompt({
  board: { ...legacyQuoteBoard, promptTrace: { ...legacyQuoteBoard.promptTrace!, convertedPromptFingerprint: 'stale' } },
  context, clean, skipConversion: true,
  request: async () => { throw new Error('must not request before verifying the original fingerprint'); },
}), /只有已通过 API/u, 'original API provenance must still be checked before accepting a confirmed slice');

const invalidTimelinePrompt = trusted.finalPrompt.replace('【5s-10s】', '【6s-10s】');
await assert.rejects(generateSingleSegmentPrompt({
  board: { ...trusted, finalPrompt: invalidTimelinePrompt,
    promptPlan: { ...trusted.promptPlan!, canonicalPrompt: invalidTimelinePrompt },
    promptTrace: { ...trusted.promptTrace!, convertedPromptFingerprint: sourceContentHash(invalidTimelinePrompt) } },
  context, clean, skipConversion: true,
  request: async () => { throw new Error('no translation or conversion may run for an unreadable timeline'); },
}), /时间空档/u, 'real timeline structure errors must still stop before H3 compilation or translation');

// With the normal AI review enabled, intermediate timeline parsing is only a
// display aid. Gaps must reach that existing review without a local retry.
for (const route of ['confirmed-slice', 'converted-gap', 'draft-gap'] as const) {
  const sourceBoard: Storyboard = route === 'confirmed-slice' ? {
    ...trusted, finalPrompt: invalidTimelinePrompt,
    promptPlan: { ...trusted.promptPlan!, canonicalPrompt: invalidTimelinePrompt },
    promptTrace: { ...trusted.promptTrace!, convertedPromptFingerprint: sourceContentHash(invalidTimelinePrompt) },
  } : route === 'draft-gap' ? { ...shortBoard, finalPrompt: invalidTimelinePrompt,
    promptPlan: { ...shortBoard.promptPlan!, canonicalPrompt: invalidTimelinePrompt } } : shortBoard;
  const snapshot = JSON.stringify(sourceBoard);
  const stages: SingleSegmentPromptStage[] = [];
  const repaired = await generateSingleSegmentPrompt({ board: sourceBoard, context, clean, converter,
    reviewWithAi: true, skipConversion: route === 'confirmed-slice',
    request: async (_system, user, stage) => {
      stages.push(stage);
      if (stage === 'convert') return invalidTimelinePrompt;
      if (stage === 'translate') return mockEnglish(outputs[0].officialPromptZh!);
      const data = jsonBlock(user, 'video_staging_review_data');
      assert.equal(data.canonicalPrompt, invalidTimelinePrompt, 'the existing review receives the untouched AI canonical response');
      assert.deepEqual(data.shots.map((shot: VideoShot) => [shot.id, shot.startSec, shot.endSec, shot.prompt]),
        sourceBoard.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.prompt]), 'failed parsing preserves the saved shot evidence');
      assert.notEqual(data.candidatePrompt, invalidTimelinePrompt, 'the canonical draft must never merely be relabelled as final H3');
      assert.equal(data.candidateState, 'canonical-awaiting-h3-delivery');
      assert.equal(data.candidatePrompt, '', 'unreadable canonical must not compile a fake successful H3 from old shots');
      return JSON.stringify({ canonicalPrompt: convertedCanonical, h3Prompt: outputs[0].officialPromptZh,
        shotSourceIds: sourceBoard.shots.map((shot) => [shot.id]) });
    },
  });
  assert.deepEqual(stages, [...(route === 'confirmed-slice' ? [] : ['convert']), 'review', 'translate', 'translate']);
  assert.equal(repaired.officialPromptZh, outputs[0].officialPromptZh);
  assert.equal(repaired.officialPromptEnError, '');
  assert.equal(JSON.stringify(sourceBoard), snapshot);
}

let noH3Calls = 0;
await assert.rejects(generateSingleSegmentPrompt({ board: shortBoard, context, clean, converter, reviewWithAi: true,
  request: async (_system, _user, stage) => {
    noH3Calls += 1;
    if (stage === 'convert') return 'AI尚未整理成时间轴的原始画面描述。';
    assert.equal(stage, 'review');
    throw new Error('Final H3 API unavailable');
  },
}), /Final H3 API unavailable/u, 'without an actual H3 body a failed review remains a failure, not a fabricated success');
assert.equal(noH3Calls, 2);

// Every English delivery is unbounded; no planning-only exception is needed.
// English-only must not touch conversion config or image data at all.
const unreadableContext = Object.defineProperty({}, 'assets', { get: () => { throw new Error('English-only read image data'); } }) as OfficialH3ProjectContext;
for (const characters of [7254, 19281, 25000]) {
  const baseEnglish = outputs[0].officialPromptEn!;
  const tail = 'END_MUST_NOT_BE_TRUNCATED';
  const expected = `${baseEnglish}\n${'x'.repeat(characters - baseEnglish.length - 1 - tail.length)}${tail}`;
  let translationCalls = 0;
  const englishOnly = { board: outputs[0], context: unreadableContext, clean, mode: 'translate-english' as const,
    request: async (system: string, _user: string, stage: SingleSegmentPromptStage) => {
      translationCalls += 1;
      assert.equal(stage, 'translate');
      assert.doesNotMatch(system, /7000|字符(?:上限|预算)\s*(?:为|是|[:：=])?\s*\d+|(?:不得超过|最多|精简到|截断到)\s*\d+\s*字符|h3_translation_units/u);
      return expected;
    },
  };
  Object.defineProperty(englishOnly, 'converter', { get: () => { throw new Error('English-only read converter'); } });
  const translated = await generateSingleSegmentPrompt(englishOnly);
  assert.equal(translationCalls, 1);
  assert.equal(translated.officialPromptEn, expected);
  assert.equal(translated.officialPromptEnError, '');
  assert.equal(translated.officialPromptEn!.length, characters);
  for (const key of ['targetOutput', 'officialPromptZh', 'officialPromptSource', 'shots', 'promptTrace', 'promptPlan', 'finalPrompt'] as const) {
    assert.deepEqual(translated[key], outputs[0][key], `long English-only recovery cannot mutate ${key}`);
  }
}
const aiReviewBoard = outputs[0];
const aiReviewSnapshot = JSON.stringify(aiReviewBoard);
const aiReviewRequests: Array<{ system: string; user: string; stage: SingleSegmentPromptStage }> = [];
const aiReviewStages: SingleSegmentPromptStage[] = [];
const aiReviewProgress: number[] = [];
const reviewedEnglish = aiReviewBoard.officialPromptEn!.replaceAll('旅人', 'Traveler');
const reviewed = await generateSingleSegmentPrompt({
  board: aiReviewBoard, context: unreadableContext, mode: 'translate-english', reviewWithAi: true,
  clean: () => { throw new Error('AI reviewed English must not be cleaned or rewritten locally'); },
  onStage: (stage) => aiReviewStages.push(stage),
  onAiTranslationReview: () => aiReviewProgress.push(aiReviewRequests.length),
  request: async (system, user, stage) => {
    aiReviewRequests.push({ system, user, stage });
    if (aiReviewRequests.length === 1) return 'Traveler opened the door. This initial draft is incomplete.';
    const reviewData = jsonBlock(user, 'review_data');
    assert.equal(reviewData.sourcePrompt, aiReviewBoard.officialPromptZh);
    assert.equal(reviewData.candidateEnglishPrompt, 'Traveler opened the door. This initial draft is incomplete.');
    return reviewedEnglish;
  },
});
assert.deepEqual(aiReviewStages, ['translate'], 'a second generic translation notice must not overwrite the dedicated AI review progress');
assert.deepEqual(aiReviewRequests.map((call) => call.stage), ['translate', 'translate']);
assert.deepEqual(aiReviewProgress, [1], 'the live caller can distinguish AI review progress');
assert.equal(aiReviewRequests[0].user, aiReviewBoard.officialPromptZh, 'the shared pipeline must forward the unmasked source');
assert.match(aiReviewRequests[0].user, /旅人/u);
assert.doesNotMatch(aiReviewRequests[0].user, /__LH_/u);
assert.equal(reviewed.officialPromptEn, reviewedEnglish);
assert.equal(reviewed.englishPrompt, reviewedEnglish);
assert.equal(reviewed.officialPromptEnError, '');
assert.equal(reviewed.officialPromptEnSource, aiReviewBoard.officialPromptZh);
assert.equal(JSON.stringify(aiReviewBoard), aiReviewSnapshot, 'AI review may not mutate saved results before the caller commits');

let failingReviewCalls = 0;
const reviewFailed = await generateSingleSegmentPrompt({
  board: aiReviewBoard, context: unreadableContext, mode: 'translate-english', reviewWithAi: true, clean,
  request: async () => {
    failingReviewCalls += 1;
    if (failingReviewCalls === 2) throw new Error('AI review API unavailable');
    return 'An incomplete candidate.';
  },
});
assert.equal(failingReviewCalls, 2);
assert.equal(reviewFailed.officialPromptEnError, '');
assert.equal(reviewFailed.officialPromptEn, 'An incomplete candidate.', 'an unavailable reviewer must not discard the AI translation already received');
assert.ok(reviewFailed.h3DeliveryWarningsEn?.some((warning) => warning.includes('复核未完成')),
  'the retained candidate must be marked as awaiting review, rather than falsely reported as reviewed');
assert.equal(JSON.stringify(aiReviewBoard), aiReviewSnapshot, 'transport failure leaves the stored input untouched for the UI atomic commit guard');

const semanticRawSegment: SemanticSegmentSourceContext['segment'] = {
  title: '门廊交接', content: '旅人压住门板，接过钥匙后合上木门。', summary: '开门和钥匙交接',
  narrativePurpose: '完成门廊事件', entryState: '旅人守在门边', exitState: '木门合拢',
  transitionHint: '自然结束', boundaryReason: '事件结束', continuityPack: '只处理当前门廊片段',
  semanticSource: {
    sourceEvidence: [{ text: '旅人压住门板，说：“先开门。”' }],
    events: [{ id: 'door-event', description: '压门、接钥匙和关门', phase: '当前片段' }],
    dialogues: [{ id: 'door-line', speaker: '旅人', text: '先开门。', language: 'Chinese' }],
  },
};
const semanticInput: SemanticSegmentSourceContext = {
  kind: 'semantic-segment-source-v1', sourceStoryTitle: '门廊片段', sourceContentHash: 'original-story-hash',
  segmentIndex: 1, segmentCount: 2, segmentDurationSec: 15, segment: semanticRawSegment,
  generationStoryContent: semanticSegmentStoryContent(semanticRawSegment),
  storyUnderstandingContext: {
    usage: 'understanding-only', sourceStoryContent: '此前阿青把钥匙交给旅人。' + content + '随后二人前往庭院。',
    characterIdentities: [{ id: hero.id, name: hero.name, aliases: ['门口旅客'] }],
    instruction: '只用于理解本段代词和动作来源，不扩展本段事件。',
  },
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' }, characterContinuity: [],
};
assert.ok(!semanticInput.segment.content.includes('先开门。'), 'regression fixture must keep dialogue only in the assigned source records');
for (const { purpose, formatRepair } of [
  { purpose: 'initial' as const, formatRepair: false },
  { purpose: 'initial' as const, formatRepair: true },
  { purpose: 'dialogue-repair' as const, formatRepair: false },
  { purpose: 'reference-refresh' as const, formatRepair: false },
]) {
  const stages: SingleSegmentPromptStage[] = [];
  const sourceBoard: Storyboard = {
    ...(purpose === 'dialogue-repair' ? outputs[0] : shortBoard),
    sequencePlanId: 'semantic-source-plan', segmentId: 'semantic-source-segment',
    sourceStoryContent: semanticRawSegment.content,
    shots: (purpose === 'dialogue-repair' ? outputs[0] : shortBoard).shots.map((shot, index) => index === 0
      ? { ...shot, sourceStart: 0, sourceEnd: 7, sourceExcerpt: semanticRawSegment.content.slice(0, 7) } : shot),
  };
  const sourceSnapshot = JSON.stringify(sourceBoard);
  let candidateChinese = '';
  let candidateIdentityBindings: H3IdentityBindings | undefined;
  let candidateParticipation: PromptCharacterParticipation | undefined;
  const generated = await generateSingleSegmentPrompt({
    board: sourceBoard, context, converter, purpose, sequenceSegmentContext: semanticInput,
    sourceStoryContent: semanticInput.segment.content, reviewWithAi: true, clean,
    request: async (system, user, stage) => {
      stages.push(stage);
      if (stage !== 'convert') assertH3DescriptionLanguage(system, stage === 'review' ? '中文' : '英文');
      if (stage === 'translate') {
        assert.ok(!user.includes('<semantic_segment_source_data>'), 'translation does not receive a fresh semantic assignment');
        assert.ok(system.includes('STORY_CAUSALITY_TRANSLATION_V1'));
        assert.ok(!user.includes('随后二人前往庭院。'), 'English translates the approved Chinese, not fresh outside events');
        assert.match(system, /以已确认的 sourcePrompt|保真已确认中文sourcePrompt/u);
        return candidateIdentityBindings ? JSON.stringify({ h3Prompt: candidateChinese, identityBindings: candidateIdentityBindings }) : candidateChinese;
      }
      assert.match(system, /同一次发话/u);
      assert.ok(system.includes('STORY_UNDERSTANDING_CONTEXT_V1'));
      assert.match(system, /contentOverridden=true.*用户当前编辑正文优先/u);
      assert.doesNotMatch(system, /也不提供全片原文/u);
      assert.match(system, /没有对应历史逐字证据就省略坐标并标记sourceLocationStatus=unlocated/u);
      assert.match(system, /不能把generationStoryContent附加对白记录的位置冒充保存原文位置/u);
      assert.deepEqual(jsonBlock(user, 'semantic_segment_source_data').sequenceSegmentContext, semanticInput);
      if (stage === 'convert') {
        assert.equal(jsonBlock(user, 'video_conversion_data').sourceStoryContent, semanticInput.generationStoryContent);
        return convertedCanonical;
      }
      if (user.includes('<h3_format_repair_data>')) {
        const data = jsonBlock(user, 'h3_format_repair_data');
        assert.equal(data.sourceContext.sourceStoryContent, semanticInput.generationStoryContent);
        assert.equal(data.sourceContext.taskAuthority, 'preserve-confirmed-schedule');
        assert.equal(data.sourceContext.shotSourceCoordinateBasis, 'segmentScope.savedSegmentSourceStoryContent');
        assert.equal(data.sourceContext.segmentScope.savedSegmentSourceStoryContent, semanticRawSegment.content);
        return candidateIdentityBindings ? JSON.stringify({ h3Prompt: candidateChinese, identityBindings: candidateIdentityBindings,
          characterParticipation: candidateParticipation }) : candidateChinese;
      }
      const data = jsonBlock(user, 'video_staging_review_data');
      assert.equal(data.sourceStoryContent, semanticInput.generationStoryContent, 'H3 and explicit dialogue repair must see the complete primary source');
      assert.equal(data.shotSourceCoordinateBasis, 'segmentScope.savedSegmentSourceStoryContent');
      assert.equal(data.segmentScope.savedSegmentSourceStoryContent, semanticRawSegment.content, 'saved provenance remains the original coordinate basis');
      assert.equal(data.shots[0].sourceStart, 0);
      assert.equal(data.shots[0].sourceEnd, 7);
      assert.equal(data.segmentScope.savedSegmentSourceStoryContent.slice(data.shots[0].sourceStart, data.shots[0].sourceEnd), data.shots[0].sourceExcerpt);
      candidateChinese = data.candidatePrompt;
      if (purpose === 'reference-refresh') {
        assert.equal(data.taskAuthority, 'preserve-confirmed-schedule');
        assert.equal(data.revisionScope, 'reference-refresh-non-audio-only');
        return candidateChinese;
      }
      const anchors = ['Identity: 旅人，黑色斗篷。', 'Identity: 阿青，青色短袍。'];
      candidateChinese = candidateChinese.startsWith('subject_definitions:')
        ? candidateChinese.replace('subject_definitions:', `subject_definitions:\n${anchors.join('\n')}`)
        : candidateChinese.replace('[Shot 1]', `[Shot 1] ${anchors.join(' ')}`);
      candidateIdentityBindings = { version: 1, characters: [hero, companion].map((person, index) => ({
        characterId: person.id, name: person.name, referenceAnchor: anchors[index],
      })) };
      candidateParticipation = { version: 1, characters: [hero, companion].map((person) => ({
        characterId: person.id, name: person.name, presence: 'visible', shotIndex: 1, evidence: person.name,
      })) };
      return JSON.stringify({
        canonicalPrompt: data.canonicalPrompt,
        h3Prompt: formatRepair ? candidateChinese.replace('overall_soundscape:', 'invalid_soundscape:') : candidateChinese,
        identityBindings: candidateIdentityBindings,
        characterParticipation: candidateParticipation,
        shotSourceIds: data.shots.map((shot: { id: string }) => [shot.id]),
      });
    },
  });
  assert.deepEqual(stages, [
    ...(purpose === 'dialogue-repair' ? [] : ['convert']), 'review',
    'translate', 'translate',
  ], 'local format differences must not add another check, review or repair request');
  if (formatRepair) assert.ok(generated.officialPromptZh?.includes('invalid_soundscape:'),
    'the AI review result is preserved instead of being rewritten or rejected by the local protocol checker');
  assert.equal(generated.officialPromptEnError, '');
  assert.equal(JSON.stringify(sourceBoard), sourceSnapshot, 'request preparation never rewrites existing saved prompts');
}

console.log('single-segment short/long shared prompt and AI translation review checks passed');
