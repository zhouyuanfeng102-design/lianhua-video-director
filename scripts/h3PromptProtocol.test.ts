import assert from 'node:assert/strict';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import { NO_DIALOGUE_PERFORMANCE_RULE, VISUAL_IDENTITY_SPEECH_SCOPE_RULE } from '../src/audioPromptPolicy';
import {
  H3_DIALOGUE_FORMAT_RULE,
  H3_FINAL_BODY_FORMAT_RULE,
  h3DescriptionLanguageRule,
  getH3PromptProtocolIssue,
  readH3PromptProtocol,
  repairH3PromptProtocolWithAi,
} from '../src/h3PromptProtocol';

assert.doesNotMatch(H3_FINAL_BODY_FORMAT_RULE, /最终英文正文|英文风格|中文正文可作为/u,
  'the shared format contract does not select a delivery language');
for (const language of ['中文', '英文'] as const) {
  const rule = h3DescriptionLanguageRule(language);
  assert.match(rule, /描述语言与人物发话语言分开/u);
  assert.match(rule, /对白、歌词及其语言标注保持原稿指定的语言和原字/u);
  assert.match(rule, /人物姓名、代号及其身份映射保持原样/u);
  assert.match(rule, /实际出现在标牌、屏幕等画面中的文字保持原字/u);
  assert.match(rule, /本次明确要求原文保留的已确认内容仍原样保留/u);
  assert.match(rule, /不借语言要求重译整份旧稿或扩大修改范围/u);
  assert.match(rule, /H3字段名、\[Shot N\]、At切点/u);
}

const fullReferenceWithStylePreamble = [
  'subject_definitions:',
  '<Subject 1> is the baker from <Picture 1>.',
  '',
  'summary:',
  '[generation] A baker opens a shop before sunrise.',
  '',
  'retention_analysis:',
  '<Subject 1> appears in [Shot 1] and [Shot 2]: fully_preserved.',
  '',
  'detailed_description:',
  'The target video uses a cinematic live-action style with soft dawn light.',
  'The composition remains intimate and grounded in the bakery interior.',
  '[Shot 1] <Subject 1> opens the wooden shutters while the street is quiet.',
  '[Shot2] At 00:05.000, the camera cuts to a close view of the warm bread.',
  '',
  'overall_soundscape: Wooden shutters scrape open; trays clink softly.',
  '',
  'non_diegetic_music: N/A',
].join('\n');

const integratedSingleLine = [
  'integrated_multimodal_description: [Shot 1] A baker opens the shutters. The director quotes "[Shot 9]" and "subject_definitions: <Picture 9>" as literal text.',
  '[Shot2] At 00:05.000, the camera cuts to the bread while the baker listens.',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');

const dialogueLiteralPrompt = [
  'integrated_multimodal_description:',
  '[Shot 1] The speaker says <d>[Chinese] 原台词里写着 [Shot 9]、section: 和 <Picture 99>。</d> The camera stays still.',
  '[Shot 2] At 00:03.000, the camera cuts to the listener.',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const quotedLiteralPrompt = integratedSingleLine.replace(
  '"[Shot 9]"',
  '「[Shot 9]」',
);

const firstShotTimestamp = integratedSingleLine.replace('[Shot 1] A baker', '[Shot 1] At 00:00.500, a baker');
const nonIncreasingCuts = integratedSingleLine.replace(
  '[Shot2] At 00:05.000',
  '[Shot2] At 00:05.000',
).replace(
  'overall_soundscape: N/A',
  '[Shot 3] At 00:05.000, the camera cuts again.\noverall_soundscape: N/A',
);

const fullReferenceProtocol = readH3PromptProtocol(fullReferenceWithStylePreamble);
assert.ok(fullReferenceProtocol, 'full-reference style preface before Shot 1 is legal');
assert.deepEqual(fullReferenceProtocol?.sections, [
  'subject_definitions', 'summary', 'retention_analysis', 'detailed_description',
  'overall_soundscape', 'non_diegetic_music',
]);
assert.deepEqual(fullReferenceProtocol?.shots, [
  { marker: '[Shot 1]', cut: null },
  { marker: '[Shot2]', cut: 'At 00:05.000' },
]);
assert.equal(getH3PromptProtocolIssue(fullReferenceWithStylePreamble), undefined);

const integratedProtocol = readH3PromptProtocol(integratedSingleLine);
assert.ok(integratedProtocol, 'official base form permits a subsequent [Shot2] on the same line');
assert.equal(integratedProtocol?.shots.length, 2);
assert.deepEqual(integratedProtocol?.shots.map((shot) => shot.cut), [null, 'At 00:05.000']);
assert.equal(readH3PromptProtocol(dialogueLiteralPrompt)?.shots.length, 2,
  'Shot/section/Picture text inside a dialogue tag stays literal');
assert.equal(readH3PromptProtocol(quotedLiteralPrompt)?.shots.length, 2,
  'Shot text inside paired Chinese quotes stays literal');
assert.equal(readH3PromptProtocol(firstShotTimestamp), undefined,
  'the first shot must not have an At timestamp');
assert.equal(readH3PromptProtocol(nonIncreasingCuts), undefined,
  'later At timestamps must be strictly increasing');

const longMaster = [
  'integrated_multimodal_description:',
  ...Array.from({ length: 10 }, (_, index) => {
    const seconds = index * 15;
    const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000`;
    return index === 0 ? '[Shot 1] The giant faces the monster.'
      : `[Shot ${index + 1}] At ${timestamp}, the battle continues at the same scale.`;
  }),
  'overall_soundscape: Diegetic battle sounds only.',
  'non_diegetic_music: N/A',
].join('\n');
assert.equal(readH3PromptProtocol(longMaster)?.shots.length, 10,
  'a 150-second master with ten complete 15-second segments is ordinary H3 transport');
assert.equal(getH3PromptProtocolIssue(longMaster, longMaster), undefined);

for (const marker of ['[Shot2]', '[Shot 2]', '[Shot\t2]', '[Shot   2]']) {
  const equivalent = fullReferenceWithStylePreamble.replace('[Shot2]', marker);
  assert.equal(getH3PromptProtocolIssue(equivalent, fullReferenceWithStylePreamble), undefined,
    'legal marker whitespace compares by logical number and cut, not raw typography');
  let equivalentCalls = 0;
  const preserved = await repairH3PromptProtocolWithAi({
    formatReferencePrompt: fullReferenceWithStylePreamble,
    candidatePrompt: equivalent,
    language: '英文',
    request: async () => { equivalentCalls += 1; return fullReferenceWithStylePreamble; },
  });
  assert.equal(equivalentCalls, 0, 'equivalent marker whitespace must not spend an AI repair request');
  assert.equal(preserved, equivalent, 'accepted AI-authored marker and prose remain unchanged');
}

const noMusicSection = integratedSingleLine.replace('non_diegetic_music: N/A', '');
assert.equal(getH3PromptProtocolIssue(noMusicSection),
  'H3缺少必需章节：“non_diegetic_music”；章节标题必须使用正式字段名和半角冒号。');
const referenceAudioOnly = 'overall_soundscape: N/A\nnon_diegetic_music: N/A';
const referenceMarkdownHeadings = fullReferenceWithStylePreamble.replace(
  /^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gmu,
  '### $1:',
);
assert.equal(getH3PromptProtocolIssue(referenceAudioOnly, fullReferenceWithStylePreamble),
  'H3缺少必需章节：“subject_definitions”、“summary”、“retention_analysis”、“detailed_description”；章节标题必须使用正式字段名和半角冒号。');
assert.equal(getH3PromptProtocolIssue(referenceMarkdownHeadings, fullReferenceWithStylePreamble),
  'H3缺少必需章节：“subject_definitions”、“summary”、“retention_analysis”、“detailed_description”、“overall_soundscape”、“non_diegetic_music”；章节标题必须使用正式字段名和半角冒号。');
assert.match(getH3PromptProtocolIssue(referenceAudioOnly)!, /integrated_multimodal_description/u,
  'reading without a valid baseline preserves the existing mode inference');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine, fullReferenceWithStylePreamble),
  'H3官方章节名称或顺序与格式基准不一致。',
  'a valid three-field candidate is still incompatible with a six-field baseline');
for (const candidate of [referenceAudioOnly, referenceMarkdownHeadings]) {
  assert.equal(readH3PromptProtocol(candidate), undefined,
    'missing or Markdown-wrapped full-reference headings remain invalid');
  let requests = 0;
  const aiBody = fullReferenceWithStylePreamble.replace('[Shot2]', '[Shot\t2]');
  const result = await repairH3PromptProtocolWithAi({
    formatReferencePrompt: fullReferenceWithStylePreamble, candidatePrompt: candidate, language: '中文',
    request: async (_system, user) => {
      requests += 1;
      const match = user.match(/<h3_format_repair_data>\n([\s\S]*?)\n<\/h3_format_repair_data>/u);
      assert.ok(match);
      const data = JSON.parse(match[1]) as { candidatePrompt: string; formatIssue: string; requiredProtocol: { sections: string[] } };
      assert.equal(data.candidatePrompt, candidate, 'the damaged candidate is sent intact to AI');
      assert.deepEqual(data.requiredProtocol.sections, fullReferenceProtocol!.sections);
      for (const name of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description']) {
        assert.ok(data.formatIssue.includes(`“${name}”`), 'the diagnosis requests the actual full-reference mode');
      }
      assert.doesNotMatch(data.formatIssue, /integrated_multimodal_description/u,
        'AI feedback must not contradict the valid six-field required protocol');
      return aiBody;
    },
  });
  assert.equal(requests, 1);
  assert.equal(result, aiBody, 'the complete AI repaired body is returned without local normalization');
}
assert.equal(getH3PromptProtocolIssue(`${integratedSingleLine}\noverall_soundscape: N/A`),
  'H3章节“overall_soundscape”重复出现2次。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace(
  'overall_soundscape: N/A\nnon_diegetic_music: N/A',
  'non_diegetic_music: N/A\noverall_soundscape: N/A',
)), 'H3章节顺序错误；正式顺序应为“integrated_multimodal_description”、“overall_soundscape”、“non_diegetic_music”。');
assert.match(getH3PromptProtocolIssue(`\u0060\u0060\u0060text\n${integratedSingleLine}\n\u0060\u0060\u0060`)!, /代码围栏/u);
assert.equal(getH3PromptProtocolIssue(firstShotTimestamp),
  'H3首镜不应带切点；“[Shot 1]”之后应直接书写镜头正文。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace('[Shot2]', '[Shot 4]')),
  'H3第2处镜头标记编号不连续；应为“[Shot 2]”。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace('At 00:05.000, ', '')),
  'H3第2镜缺少有效切点，要求“[Shot 2] At MM:SS.mmm”。');
assert.equal(getH3PromptProtocolIssue(nonIncreasingCuts),
  'H3第3镜的切点“00:05.000”不晚于上一切点“00:05.000”；后续镜头的切点必须严格递增。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace(
  '[Shot2] At 00:05.000, the camera cuts to the bread while the baker listens.', '[Shot2]',
)), 'H3第2镜缺少镜头正文。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace(
  '[Shot2] At 00:05.000, the camera cuts to the bread while the baker listens.', '[Shot2] At 00:05.000,',
)), 'H3第2镜在切点“00:05.000”后缺少镜头正文。');
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace('[Shot 1]', '- [Shot 1]')),
  'H3章节“integrated_multimodal_description”必须直接以首镜标记“[Shot 1]”开始。');
assert.match(getH3PromptProtocolIssue([
  'integrated_multimodal_description: 剧情隐私内容不能出现在错误提示里。',
  'overall_soundscape: N/A', 'non_diegetic_music: N/A',
].join('\n'))!, /未找到镜头标记/u);
assert.doesNotMatch(getH3PromptProtocolIssue('供应商返回的私密长正文与未知字段 totally_custom_field')!, /私密|totally_custom_field|供应商/u,
  'diagnostics contain only known labels and numeric positions, never source or vendor prose');
for (const nonOfficial of [
  integratedSingleLine.replace(/^(integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu, '### $1:'),
  integratedSingleLine.replace('non_diegetic_music:', 'background_music:'),
  integratedSingleLine.replace('integrated_multimodal_description:', 'integrated_multimodal_description：'),
  integratedSingleLine.replace('00:05.000', '00:05.0'),
]) {
  assert.equal(readH3PromptProtocol(nonOfficial), undefined,
    'Markdown, field aliases, missing formal sections and non-official timestamps still need AI repair');
  assert.ok(getH3PromptProtocolIssue(nonOfficial));
}
assert.equal(getH3PromptProtocolIssue(integratedSingleLine.replace('00:05.000', '00:06.000'), integratedSingleLine),
  'H3第2镜的切点与格式基准不一致；请保留该镜原定切点。');
assert.match(getH3PromptProtocolIssue(longMaster, integratedSingleLine)!, /应为2镜，实际10镜/u);
assert.match(getH3PromptProtocolIssue(
  fullReferenceWithStylePreamble.replaceAll('<Picture 1>', '<Picture 2>'), fullReferenceWithStylePreamble,
)!, /参考标签集合/u);

let validRepairCalls = 0;
const untouched = await repairH3PromptProtocolWithAi({
  formatReferencePrompt: fullReferenceWithStylePreamble,
  candidatePrompt: fullReferenceWithStylePreamble,
  language: '英文',
  request: async () => {
    validRepairCalls += 1;
    return fullReferenceWithStylePreamble;
  },
});
assert.equal(validRepairCalls, 0, 'a legal full-reference style preface must not trigger AI repair');
assert.equal(untouched, fullReferenceWithStylePreamble);

let repairCalls = 0;
const repaired = await repairH3PromptProtocolWithAi({
  formatReferencePrompt: fullReferenceWithStylePreamble,
  candidatePrompt: 'integrated_multimodal_description: [Shot 1] At 00:00.500, malformed.',
  language: '英文',
  request: async (system) => {
    repairCalls += 1;
    assert.match(system, /H3_FINAL_BODY_FORMAT_RULE|官方H3|full-reference/u);
    return fullReferenceWithStylePreamble;
  },
});
assert.equal(repairCalls, 1, 'an invalid protocol is sent once to the AI repair stage');
assert.equal(repaired, fullReferenceWithStylePreamble);

// Format repair receives the same identity/no-speech guidance as generation
// and review. It still owns no local interpretation or rewriting of names.
const noSpeechSource = [
  'integrated_multimodal_description:',
  '[Shot 1] 15秒镜头。<Picture 1>提供尾帧构图，<Picture 2>对应林沐，<Picture 3>对应祈凌霜，<Picture 4>对应叶清碧。三人安静抬眼微笑；林沐在第2s按原剧情轻咳一声。台词：无，0秒到15秒全程不说话。',
  'overall_soundscape: 第2s轻咳，其余无声；无对白、无旁白。',
  'non_diegetic_music: N/A',
].join('\n');
const noSpeechFinal = [
  'integrated_multimodal_description:',
  '[Shot 1] A 15-second shot. <Picture 1> fixes the tail-frame composition; <Picture 2> identifies 林沐, <Picture 3> identifies 祈凌霜, and <Picture 4> identifies 叶清碧. These are visual identities, not spoken names. All three glance up and smile naturally. 林沐 gives the authored brief cough at 2s. From 0s through 15s there is no speech, name-calling, chatter, narration or speech articulation; the cough and smiles remain.',
  'overall_soundscape: Only the brief cough at 2s; no speech or narration throughout.',
  'non_diegetic_music: N/A',
].join('\n');
for (const language of ['中文', '英文'] as const) {
  let requests = 0;
  const sourceContext = { sourcePrompt: noSpeechSource, segmentIndex: 10 };
  const invalid = noSpeechFinal.replace('non_diegetic_music: N/A', '');
  const result = await repairH3PromptProtocolWithAi({
    formatReferencePrompt: noSpeechSource,
    candidatePrompt: invalid,
    language,
    sourceContext,
    request: async (system, user) => {
      requests += 1;
      assertH3DescriptionLanguage(system, language);
      assert.ok(system.includes(VISUAL_IDENTITY_SPEECH_SCOPE_RULE));
      assert.ok(system.includes(NO_DIALOGUE_PERFORMANCE_RULE));
      assert.ok(system.includes(H3_DIALOGUE_FORMAT_RULE));
      assert.match(system, /不能写成<d>None<\/d>/u,
        'no-dialogue states are not serialized into pronounceable dialogue');
      const data = JSON.parse(user.match(/<h3_format_repair_data>\n([\s\S]*?)\n<\/h3_format_repair_data>/u)![1]);
      assert.deepEqual(data.sourceContext, sourceContext);
      assert.equal(data.candidatePrompt, invalid.trim());
      return language === '中文' ? noSpeechSource : noSpeechFinal;
    },
  });
  assert.equal(requests, 1, 'the rules use the existing single format repair, without another review');
  assert.equal(result, language === '中文' ? noSpeechSource : noSpeechFinal,
    'the complete AI response, including identities, cough and expressions, is returned untouched');
  assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(noSpeechSource));
}

const structurallyValidSpeechCandidate = noSpeechFinal.replace(
  'From 0s through 15s there is no speech, name-calling, chatter, narration or speech articulation; the cough and smiles remain.',
  'At 13s, an invented voice calls the three visual names aloud.',
);
assert.equal(getH3PromptProtocolIssue(structurallyValidSpeechCandidate, noSpeechSource), undefined,
  'semantic speech errors belong to the existing AI review, not a local name or content gate');
let semanticGateCalls = 0;
assert.equal(await repairH3PromptProtocolWithAi({
  formatReferencePrompt: noSpeechSource, candidatePrompt: structurallyValidSpeechCandidate, language: '英文',
  request: async () => { semanticGateCalls += 1; return noSpeechFinal; },
}), structurallyValidSpeechCandidate);
assert.equal(semanticGateCalls, 0, 'the protocol helper must not add a hidden paid semantic-review stage');

let boundedRepairCalls = 0;
const recoveredOnThirdAttempt = await repairH3PromptProtocolWithAi({
  formatReferencePrompt: fullReferenceWithStylePreamble,
  candidatePrompt: 'ordinary timeline without H3 sections',
  language: '英文',
  request: async () => {
    boundedRepairCalls += 1;
    return boundedRepairCalls < 3
      ? 'still malformed'
      : fullReferenceWithStylePreamble;
  },
});
assert.equal(boundedRepairCalls, 3, 'the same AI gets bounded additional repair attempts before failing');
assert.equal(recoveredOnThirdAttempt, fullReferenceWithStylePreamble);

const roundCandidates = [
  `${integratedSingleLine}\noverall_soundscape: N/A`,
  nonIncreasingCuts,
  integratedSingleLine,
];
const roundIssues: string[] = [];
const repairedWithFeedback = await repairH3PromptProtocolWithAi({
  formatReferencePrompt: integratedSingleLine,
  candidatePrompt: noMusicSection,
  language: '中文',
  request: async (_system, user) => {
    const match = user.match(/<h3_format_repair_data>\n([\s\S]*?)\n<\/h3_format_repair_data>/u);
    assert.ok(match);
    const data = JSON.parse(match[1]) as { formatIssue: string; candidatePrompt: string; repairAttempt: number };
    roundIssues.push(data.formatIssue);
    assert.equal(data.repairAttempt, roundIssues.length);
    assert.equal(data.candidatePrompt, (roundIssues.length === 1 ? noMusicSection : roundCandidates[roundIssues.length - 2]).trim(),
      'every repair receives the previous complete AI response with only the existing outer trim');
    return roundCandidates[roundIssues.length - 1];
  },
});
assert.equal(repairedWithFeedback, integratedSingleLine);
assert.match(roundIssues[0], /缺少必需章节.*non_diegetic_music/u);
assert.match(roundIssues[1], /overall_soundscape.*重复出现2次/u);
assert.match(roundIssues[2], /第3镜.*不晚于上一切点/u,
  'each AI repair receives the current precise failure, not the stale first failure');

for (const changed of [
  integratedSingleLine.replace('00:05.000', '00:06.000'),
  `${integratedSingleLine}\n<Picture 2>`,
]) {
  let changedCalls = 0;
  assert.equal(await repairH3PromptProtocolWithAi({
    formatReferencePrompt: integratedSingleLine, candidatePrompt: changed, language: '中文',
    request: async () => { changedCalls += 1; return integratedSingleLine; },
  }), integratedSingleLine);
  assert.equal(changedCalls, 1, 'genuine cut or reference changes still go to AI for repair');
}

for (const language of ['中文', '英文'] as const) {
  let failedCalls = 0;
  await assert.rejects(repairH3PromptProtocolWithAi({
    formatReferencePrompt: integratedSingleLine, candidatePrompt: noMusicSection, language,
    request: async () => { failedCalls += 1; return noMusicSection; },
  }), (error: unknown) => error instanceof Error
    && error.message.includes(`AI已自动重试修复H3格式3次（${language}阶段）`)
    && error.message.includes('“non_diegetic_music”')
    && error.message.includes('原有结果保持不变'));
  assert.equal(failedCalls, 3, 'the existing three-repair ceiling remains unchanged');
}

for (const originalError of [
  Object.assign(new Error('Cancelled by caller'), { name: 'AbortError' }),
  Object.assign(new Error('Synthetic transport failure'), { status: 503 }),
]) {
  let failedCalls = 0;
  await assert.rejects(repairH3PromptProtocolWithAi({
    formatReferencePrompt: integratedSingleLine, candidatePrompt: noMusicSection, language: '中文',
    request: async () => { failedCalls += 1; throw originalError; },
  }), (error: unknown) => error === originalError,
  'cancellation and transport failures propagate unchanged, never mislabeled as format exhaustion');
  assert.equal(failedCalls, 1, 'transport/cancellation failures do not consume three format retries');
}

for (const required of [
  'integrated_multimodal_description', 'subject_definitions', 'detailed_description',
  'full-reference', '[Shot N]', 'At MM:SS.mmm', 'Subject/Picture/Video/Audio',
  '主体/空间/光影/镜头/台词/音效', 'AI负责语义与格式改写',
  'overall_soundscape只保留整段范围的简短剧情内环境/声景摘要',
  '具体对白原字、说话人/声源ID、某一镜无对白',
  '不得新增negative_prompt、negative、反向提示词或其它section',
]) {
  assert.equal(H3_FINAL_BODY_FORMAT_RULE.includes(required), true,
    `final H3 body rule mentions ${required}`);
}

console.log('H3 prompt protocol parser and final-body contract checks passed');
