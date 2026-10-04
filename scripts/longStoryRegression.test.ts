import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  analyzeTextLocally,
  buildShots,
  renderFinalPrompt,
  renderShotPrompt,
  splitIntoScenes,
} from '../src/promptEngine';
import { composeDerivedLocalPrompt } from '../src/appEffects';
import { parseMasterTimelinePrompt } from '../src/masterTimeline';
import {
  defaultConverterPresets,
  defaultRuleSets,
  defaultStylePresets,
} from '../src/storage';
import {
  applySourceIntegrityResolution,
  detectSourceIntegrityIssues,
} from '../src/sourceIntegrity';
import {
  buildLocalSequencePlan,
  estimateStoryDurationLocally,
  extractStoryBeats,
} from '../src/storySegmentation';
import {
  alignSequenceSegmentsToMasterShotBoundaries,
  reconcileSequenceSegmentsToShotProvenance,
  sliceMasterShotsForSegment,
} from '../src/sequencePlan';
import type { Character, Scene, VideoShot } from '../src/types';

// This immutable text fixture preserves the original regression independently
// of the user's active projects, API settings, and changing delivery directory.
const deliveredStoryFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/qingquan-long-story.json', import.meta.url), 'utf8'),
) as { content: string };

const deliveredStory = (): string => {
  const story = deliveredStoryFixture.content;
  assert.equal(story.length, 1257, '真实回归样本必须包含完整的 1257 字剧情原文');
  assert.ok(story.includes('枪声与火炮的喧嚣揉碎了清泉市的夜晚'));
  // Reconstruct the original duplicated input only in memory.
  return story.repeat(2);
};

test('真实 2514 字长剧情在显式去重后只规划一遍剧情', () => {
  const duplicated = deliveredStory();
  assert.equal(duplicated.length, 2514);

  const issues = detectSourceIntegrityIssues(duplicated);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'whole-document-duplicate');
  assert.deepEqual(issues[0].original, { start: 0, end: 1257 });
  assert.deepEqual(issues[0].duplicate, { start: 1257, end: 2514 });

  const story = applySourceIntegrityResolution(duplicated, issues[0], 'keep-first');
  assert.equal(story, duplicated.slice(0, 1257));
  assert.equal((story.match(/枪声与火炮的喧嚣揉碎了清泉市的夜晚/gu) || []).length, 1);

  const duplicatedBeats = extractStoryBeats(duplicated);
  const beats = extractStoryBeats(story);
  assert.equal(beats.map((beat) => beat.text).join(''), story);
  assert.ok(beats.length < duplicatedBeats.length);

  const duplicatedEstimate = estimateStoryDurationLocally(duplicated);
  const estimate = estimateStoryDurationLocally(story);
  assert.ok(estimate.recommendedSec < duplicatedEstimate.recommendedSec * 0.6);

  const plan = buildLocalSequencePlan({
    title: '真实长剧情回归',
    story,
    totalDurationSec: estimate.recommendedSec,
    segmentDurationSec: 15,
    segmentationMode: 'fixed',
    sourceSceneIds: [],
  });
  assert.ok(plan.segments.every((segment) => segment.durationSec <= 15));
  assert.equal(plan.segments.map((segment) => segment.content).join(''), story);
  assert.equal(
    (plan.segments.map((segment) => segment.content).join('').match(/枪声与火炮的喧嚣/gu) || []).length,
    1,
  );
});

test('真实长剧情的人物和地点不再被句子残片污染', () => {
  const duplicated = deliveredStory();
  const issue = detectSourceIntegrityIssues(duplicated)[0];
  assert.ok(issue);
  const story = applySourceIntegrityResolution(duplicated, issue, 'keep-first');
  const analysis = analyzeTextLocally(story);

  assert.deepEqual(analysis.characterNames, ['边缘划水', '西娅']);
  assert.equal(analysis.locationName, '清泉市');
  assert.equal(splitIntoScenes(story).length, 12);
  assert.equal(splitIntoScenes(duplicated).length, 24);
});

test('真实去重长剧情逐镜主体和对白说话人跟随各自来源节拍', () => {
  const duplicated = deliveredStory();
  const issue = detectSourceIntegrityIssues(duplicated)[0];
  assert.ok(issue);
  const story = applySourceIntegrityResolution(duplicated, issue, 'keep-first');
  const beats = extractStoryBeats(story);
  assert.ok(beats.length >= 30, '真实去重样本必须拆出足够的可追踪语义节拍');

  const characters: Character[] = ['边缘划水', '西娅'].map((name, index) => ({
    id: `real-character-${index + 1}`,
    name,
    gender: '',
    apparentAge: '',
    race: '',
    appearance: '',
    outfit: '',
    signatureProps: '',
    personality: '',
    motionHabits: '',
    anchor: '',
    negativeContinuity: '',
    assetIds: [],
  }));
  const scene: Scene = {
    id: 'real-deduplicated-story',
    title: '清泉市北二环线',
    content: story,
    summary: '死亡兵团逼近西娅，西娅向市中心母巢求援。',
    characterIds: characters.map((character) => character.id),
    locationIds: [],
    propIds: [],
    storyboardIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const shots = buildShots({
    scene,
    characters,
    locations: [],
    props: [],
    assets: [],
    workflow: 'drama',
    durationSec: 180,
    shotMode: 'exact',
    shotCount: beats.length,
    pace: 'standard',
    camera: '稳定叙事镜头',
    lighting: '自然环境光',
    style: defaultStylePresets[0],
    extra: '',
  });
  const beatForSource = (sourceText: string) => {
    const beat = beats.find((candidate) => candidate.text.includes(sourceText));
    assert.ok(beat, `必须找到包含来源文本的节拍：${sourceText}`);
    return beat;
  };
  const shotForSource = (sourceText: string): VideoShot => {
    const beatId = beatForSource(sourceText).id;
    const shot = shots.find((candidate) => candidate.sourceBeatIds?.includes(beatId));
    assert.ok(shot, `必须找到来源节拍 ${beatId} 对应的镜头`);
    return shot;
  };
  const edgeWaterDialogue = '风暴兵团正在遭受浪潮的攻击';
  const xiaAlarmDialogue = '母亲……他们发现我了。';
  const xiaHelpDialogue = '我需要您的帮助。';
  const motherReplyDialogue = '不必惊慌，我已经向你的方向派出了增援';
  const sporeObservation = '联盟的生物研究所通过分散在战区的各个观测站点以及无人机';
  const sporeAnalysis = '根据孢子云的浓度差和流动轨迹已经分析出了“西娅”可能潜伏的区域';
  assert.deepEqual(
    [
      edgeWaterDialogue,
      xiaAlarmDialogue,
      xiaHelpDialogue,
      motherReplyDialogue,
    ].map((sourceText) => shotForSource(sourceText).subject),
    ['边缘划水', '西娅', '西娅', '母巢'],
    '逐镜主体必须来自当前来源节拍及其连续代词，不能沿用整片第一个人物',
  );
  assert.ok(
    new Set(shots.map((shot) => shot.subject)).size > 2,
    '18 镜真实剧情必须形成多个局部主体，而不是全部回退到边缘划水',
  );

  const prompt = renderFinalPrompt({
    durationSec: 180,
    aspectRatio: '16:9',
    resolution: '2K',
    audioMode: 'stereo',
    workflow: 'drama',
    inputMode: 'text',
    scene,
    globalLock: '',
    shots,
    assets: [],
    style: defaultStylePresets[0],
    ruleSet: defaultRuleSets[0],
    converter: defaultConverterPresets[0],
    extra: '',
    visualStyle: '电影写实',
    characters,
  });
  const promptLines = prompt.split('\n');
  const promptLineForSource = (sourceText: string): string => {
    const shot = shotForSource(sourceText);
    const shotIndex = shots.findIndex((candidate) => candidate.id === shot.id);
    return promptLines[shotIndex] || '';
  };
  assert.match(promptLineForSource(edgeWaterDialogue), /主体：@边缘划水/u);
  assert.match(promptLineForSource(xiaAlarmDialogue), /主体：@西娅/u);
  assert.match(promptLineForSource(xiaAlarmDialogue), /台词：第\d+(?:\.\d+)?s @西娅："母亲……他们发现我了。"/u);
  assert.match(promptLineForSource(xiaHelpDialogue), /主体：@西娅/u);
  assert.match(promptLineForSource(xiaHelpDialogue), /台词：第\d+(?:\.\d+)?s @西娅："我需要您的帮助。"/u);
  assert.match(promptLineForSource(motherReplyDialogue), /主体：@母巢/u);
  assert.match(promptLineForSource(motherReplyDialogue), /台词：第\d+(?:\.\d+)?s @母巢："不必惊慌/u);
  assert.match(
    promptLineForSource(sporeObservation),
    /主体：@联盟生物研究所观测系统/u,
    'the observation-input half of the same sentence must not inherit the previous military actor',
  );
  assert.match(promptLineForSource(sporeObservation), /观测站.*无人机.*孢子云.*回传.*分析终端/u);
  assert.notEqual(
    shotForSource(sporeAnalysis).subject,
    '西娅',
    'an entity being located by an analysis is the information target, not the visible performer',
  );
  assert.match(
    promptLineForSource(sporeAnalysis),
    /主体：@(?:联盟)?(?:生物研究所)?(?:战区)?观测系统|主体：@联盟生物研究所/u,
    'the analysis shot must use the visible observation system or institute as its subject',
  );
  assert.equal(
    (prompt.match(/西娅可能潜伏区域被高亮标记/gu) || []).length,
    1,
    'the final analysis result must be stated once instead of being repeated in both halves of a split sentence',
  );
  assert.match(promptLineForSource(sporeAnalysis), /观测站.*无人机.*孢子云.*(?:汇聚|标记).*区域/u);
  assert.match(
    promptLineForSource(sporeAnalysis),
    /西娅.*潜伏.*区域/u,
    'a quoted entity label must survive visualisation even though true dialogue is removed from the action chain',
  );
  assert.doesNotMatch(promptLineForSource(sporeAnalysis), /分析出了→可能潜伏/u);
  assert.doesNotMatch(prompt, /与第\d+镜连续/u, 'the master renderer must emit shot-local axis continuity instead of absolute shot numbers');
  assert.doesNotMatch(prompt, /面朝动作目标/u, 'the renderer fallback must describe a concrete visible orientation');
  assert.doesNotMatch(
    prompt,
    /背景-[^；]*(?:镜头重点表现|画面并改变|主要动作区域)/u,
    'camera-template prose must never be mistaken for a physical background',
  );

  const analysisShot = {
    ...shotForSource(sporeAnalysis),
    index: 1,
    startSec: 0,
    endSec: 4,
  };
  const genericTitlePrompt = renderFinalPrompt({
    durationSec: 4,
    aspectRatio: '16:9',
    resolution: '2K',
    audioMode: 'stereo',
    workflow: 'drama',
    inputMode: 'text',
    scene: { ...scene, title: '剧情原文' },
    globalLock: '',
    shots: [analysisShot],
    assets: [],
    style: defaultStylePresets[0],
    ruleSet: defaultRuleSets[0],
    converter: defaultConverterPresets[0],
    extra: '',
    visualStyle: '电影写实',
    characters,
  });
  assert.doesNotMatch(genericTitlePrompt, /背景-剧情原文(?:及延伸空间)?/u);
  assert.match(genericTitlePrompt, /背景-联盟生物研究所(?:战区)?观测中心/u);
  assert.doesNotMatch(
    prompt,
    /主体：@(?:清泉市|北二环线|潜伏的区域|那群突然调转方向|直奔北二环线的人类士兵|说来他们是怎么发现自己在这儿的)/u,
    '地点、宾语和句子残片不能升级成逐镜主体',
  );
});

test('真实长剧情按完整语义和对白轮次形成节拍并保留可执行时长', () => {
  const duplicated = deliveredStory();
  const issue = detectSourceIntegrityIssues(duplicated)[0];
  assert.ok(issue);
  const story = applySourceIntegrityResolution(duplicated, issue, 'keep-first');
  const beats = extractStoryBeats(story);

  assert.equal(
    beats.map((beat) => beat.text).join(''),
    story,
    '语义节拍必须逐字符、按原顺序恰好覆盖一次原文',
  );
  assert.equal(
    beats.some((beat) => /(?:可能|身边)$/u.test(beat.text.trim())),
    false,
    '语义节拍不能把谓语或主语补语截成“可能 / 身边”等悬空残片',
  );
  assert.equal(
    beats.some((beat) => /^(?:潜伏的区域|并没有留下)/u.test(beat.text.trim())),
    false,
    '语义节拍不能从上一节拍的悬空补语中间开始',
  );
  assert.equal(
    beats.some((beat) => beat.text.includes(
      '根据孢子云的浓度差和流动轨迹已经分析出了“西娅”可能潜伏的区域。',
    )),
    true,
    '分析结论及其“可能潜伏”的宾语从句必须保持为一个完整语义 span',
  );

  const dialogueTurns = [
    '“……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！”',
    '“我们的任务是帮他们一把，不过不是去帮他们解围，而是去彻底消灭那些恶心的玩意儿！”',
    '“它们很快就会为自己的愚蠢和狂妄，付出惨重的代价！”',
    '“前进！！”',
    '“母亲……他们发现我了。”',
    '“我需要您的帮助。”',
    '“不必惊慌，我已经向你的方向派出了增援，他们伤不到你。”',
  ];
  dialogueTurns.forEach((dialogue) => {
    assert.equal(
      beats.filter((beat) => beat.text.includes(dialogue)).length,
      1,
      `每轮对白必须完整且只属于一个节拍：${dialogue}`,
    );
  });
  assert.equal(
    beats.some((beat) => (
      dialogueTurns.filter((dialogue) => beat.text.includes(dialogue)).length > 1
    )),
    false,
    '多轮对白不能被吞进同一个巨型节拍',
  );
  const motherReplyBeat = beats.find((beat) => beat.text.includes(dialogueTurns[6]));
  assert.ok(motherReplyBeat);
  assert.equal(
    motherReplyBeat.text.includes('在母亲的安慰下'),
    false,
    '母巢的回答与后续西娅重新投入战场属于不同语义状态，不能合并成一个巨型节拍',
  );

  const meaningfulCharacters = [...story]
    .filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const densityFloorSec = Math.ceil((meaningfulCharacters / 12) * 2) / 2;
  const estimate = estimateStoryDurationLocally(story);
  assert.ok(
    estimate.recommendedSec >= densityFloorSec,
    `说明、对白与动作密度至少需要 ${densityFloorSec} 秒，实际仅 ${estimate.recommendedSec} 秒`,
  );

  const plan = buildLocalSequencePlan({
    title: '真实长剧情语义密度回归',
    story,
    totalDurationSec: estimate.recommendedSec,
    segmentDurationSec: 15,
    segmentationMode: 'natural',
    sourceSceneIds: [],
  });
  const peakMeaningfulCharactersPerSecond = Math.max(...plan.segments.map((segment) => (
    [...segment.content].filter((character) => /[\p{L}\p{N}]/u.test(character)).length
      / segment.durationSec
  )));
  assert.ok(
    peakMeaningfulCharactersPerSecond <= 18,
    `任何 15 秒以内视频段都不能承载不可执行的正文密度，峰值为 ${peakMeaningfulCharactersPerSecond.toFixed(2)} 字/秒`,
  );
});

test('真实长剧情从唯一母版切出可追踪且连续的最终分段提示词', () => {
  const duplicated = deliveredStory();
  const issue = detectSourceIntegrityIssues(duplicated)[0];
  assert.ok(issue);
  const story = applySourceIntegrityResolution(duplicated, issue, 'keep-first');
  const beats = extractStoryBeats(story);
  const estimate = estimateStoryDurationLocally(story);
  const characters: Character[] = ['边缘划水', '西娅'].map((name, index) => ({
    id: `pipeline-character-${index + 1}`,
    name,
    gender: '',
    apparentAge: '',
    race: '',
    appearance: '',
    outfit: '',
    signatureProps: '',
    personality: '',
    motionHabits: '',
    anchor: '',
    negativeContinuity: '',
    assetIds: [],
  }));
  const scene: Scene = {
    id: 'pipeline-source-scene',
    title: '清泉市北二环线',
    content: story,
    summary: '死亡兵团逼近西娅，西娅向市中心母巢求援。',
    sourceStart: 0,
    sourceEnd: story.length,
    characterIds: characters.map((character) => character.id),
    locationIds: [],
    propIds: [],
    storyboardIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const rawMasterShots = buildShots({
    scene,
    characters,
    locations: [],
    props: [],
    assets: [],
    workflow: 'drama',
    durationSec: estimate.recommendedSec,
    shotMode: 'exact',
    shotCount: beats.length,
    pace: 'standard',
    camera: '稳定叙事镜头',
    lighting: '自然环境光',
    style: defaultStylePresets[0],
    extra: '',
  });
  const masterShots = rawMasterShots.map((shot) => ({
    ...shot,
    prompt: renderShotPrompt(
      shot,
      estimate.recommendedSec,
      [],
      rawMasterShots,
      'stereo',
      defaultRuleSets[0],
      {
        characters,
        visualStyle: '电影写实',
        styleVisual: defaultStylePresets[0].visual,
      },
    ),
  }));
  const localPlan = buildLocalSequencePlan({
    title: '真实长剧情全链路回归',
    story,
    totalDurationSec: estimate.recommendedSec,
    segmentDurationSec: 15,
    segmentationMode: 'natural',
    sourceSceneIds: [scene.id],
  });
  const aligned = alignSequenceSegmentsToMasterShotBoundaries(localPlan, masterShots).plan;
  const slices = aligned.segments.map((segment) => sliceMasterShotsForSegment(masterShots, segment));
  assert.equal(slices.some((slice) => slice.shots.length === 0), false);
  const reconciled = reconcileSequenceSegmentsToShotProvenance(
    {
      ...aligned,
      segments: aligned.segments.map((segment, index) => ({
        ...segment,
        sourceShotIds: slices[index].sourceShotIds,
      })),
    },
    masterShots,
    beats,
    [scene],
  );

  assert.equal(reconciled.segments.map((segment) => segment.content).join(''), story);
  assert.ok(reconciled.segments.every((segment) => segment.durationSec <= 15));
  assert.deepEqual(
    reconciled.segments.flatMap((segment) => segment.sourceBeatIds),
    beats.map((beat) => beat.id),
    '每个来源节拍必须按原顺序恰好归属一个最终视频段',
  );
  assert.deepEqual(
    reconciled.segments.flatMap((segment) => segment.sourceShotIds || []),
    masterShots.map((shot) => shot.id),
    '每个母版镜头必须按原顺序恰好归属一个最终视频段',
  );

  const finalPrompts = reconciled.segments.map((segment, index) => composeDerivedLocalPrompt(
    slices[index].shots,
    segment.entryState,
    segment.exitState,
  ));
  finalPrompts.forEach((prompt, index) => {
    const segment = reconciled.segments[index];
    assert.doesNotThrow(() => parseMasterTimelinePrompt(prompt, segment.durationSec));
    assert.match(prompt, /^【0s-/u);
    assert.equal((prompt.match(/风格预设视觉〔/gu) || []).length, 1);
    assert.equal((prompt.match(/视觉风格锚点〔/gu) || []).length, 1);
    assert.equal((prompt.match(/本段结束状态：/gu) || []).length, 1);
    if (index > 0) assert.equal((prompt.match(/承接上一段：/gu) || []).length, 1);
    assert.doesNotMatch(prompt, /(?:完整保持|镜头结束仍保持)/u);
    assert.doesNotMatch(prompt, /与第\d+镜连续/u, 'segment-local prompts must not leak master-timeline shot numbers');
    assert.doesNotMatch(prompt, /面朝动作目标|背景-剧情原文及延伸空间/u, 'segment prompts must not contain renderer placeholders');
  });
  const combinedPrompt = finalPrompts.join('\n');
  for (const dialogue of [
    '风暴兵团正在遭受浪潮的攻击',
    '我们的任务是帮他们一把',
    '它们很快就会为自己的愚蠢和狂妄',
    '前进！！',
    '母亲……他们发现我了。',
    '我需要您的帮助。',
    '不必惊慌，我已经向你的方向派出了增援，他们伤不到你。',
  ]) {
    assert.equal(
      (combinedPrompt.match(new RegExp(dialogue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) || []).length,
      1,
      `最终分段提示词必须完整且只保留一次对白：${dialogue}`,
    );
  }
});
