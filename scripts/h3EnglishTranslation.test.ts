import assert from 'node:assert/strict';
import { translateH3PromptWithinBudget } from '../src/h3EnglishTranslation';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { getH3PromptProtocolIssue, H3_DIALOGUE_FORMAT_RULE, repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';

const keyframeSource = [
  'How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 2]) aligns with the 5.00-second mark of the target video.',
  '',
  'integrated_multimodal_description: [Shot 1] 门关上。',
  '',
  '[Shot 2] At 00:05.000, 门打开。',
  '',
  'overall_soundscape: N/A',
  '',
  'non_diegetic_music: N/A',
].join('\n');
const omniSource = [
  'subject_definitions:',
  '<Subject 1> is 沈砚 referenced from <Picture 1>: 黑发剑客。',
  '<Subject 2> is 阿璃 referenced from <Picture 2>: 白衣修士。',
  '<Audio 1> is the referenced audio source: 两声脚步。',
  '',
  'summary:',
  '15秒目标视频使用 <Subject 1>、<Subject 2> 和 <Audio 1> 过桥。',
  '',
  'retention_analysis:',
  '<Subject 1> appears in [Shot 1]、[Shot 2]、[Shot 3]: fully_preserved - 沈砚；reference <Picture 1>。',
  '<Subject 2> appears in [Shot 1]、[Shot 2]、[Shot 3]: fully_preserved - 阿璃；reference <Picture 2>。',
  '',
  'detailed_description:',
  '[Shot 1] <Subject 1> 对 @阿璃 说：“跟紧我。” <Subject 2> 点头；脚步两声。',
  '[Shot 2] At 00:05.000, <Subject 1> 抓住 <Subject 2>；<Video 1> 仅作运动参考。',
  '[Shot 3] At 00:10.000, <Subject 2> 站稳后说：“我没事。” <Subject 1> 松手；<Audio 1>。',
  '',
  'overall_soundscape: 安静，无持续底噪。',
  'non_diegetic_music: N/A',
].join('\n');
assert.equal(getH3PromptProtocolIssue(keyframeSource), undefined, 'H3 first/last-frame reference alignment preambles are valid protocol');
assert.equal(getH3PromptProtocolIssue(omniSource), undefined, 'H3 full-reference retention Shot mentions are not extra shots');
const translateDescriptions = (value: string): string => value
  .replace(/第(\d+(?:\.\d+)?)s(?:起)?/gu, 'at $1s ')
  .replaceAll('原对白：', 'Original dialogue: ')
  .replaceAll('台词：', 'Dialogue: ')
  .replace('门关上。', 'The door closes.')
  .replace('门打开。', 'The door opens.')
  .replace('黑发剑客。', 'black-haired swordsman.')
  .replace('白衣修士。', 'white-robed cultivator.')
  .replace('两声脚步。', 'two footsteps.')
  .replace('15秒目标视频使用 ', '15-second video: ')
  .replace(' 和 ', ' and ')
  .replace(' 过桥。', ' cross the bridge.')
  .replace(' 对 ', ' tells ')
  .replace(' 说：', ': ')
  .replace(' 点头；脚步两声。', ' nods; two footsteps.')
  .replace(' 抓住 ', ' catches ')
  .replace(' 仅作运动参考。', ' supplies motion only.')
  .replace(' 站稳后说：', ' steadies herself, then says: ')
  .replace(' 松手；', ' lets go; ')
  .replace('安静，无持续底噪。', 'Quiet; no continuous background noise.')
  .replaceAll('、', ', ')
  .replaceAll('；', '; ')
  .replaceAll('。', '.');
const translate = (value: string): string => value
  .split(/(“[^”]*”|「[^」]*」|『[^』]*』|'[^']*'|"[^"\n]*")/u)
  .map((part, index) => index % 2 ? part : translateDescriptions(part))
  .join('');

for (const sourcePrompt of [keyframeSource, omniSource]) {
  for (const characters of [undefined, 7254, 19281, 25000]) {
    const baseEnglish = translate(sourcePrompt);
    const tail = 'END_MUST_NOT_BE_TRUNCATED';
    const expected = characters === undefined ? baseEnglish
      : `${baseEnglish}\n${'x'.repeat(characters - baseEnglish.length - 1 - tail.length)}${tail}`;
    const run = async (wrapper: boolean): Promise<{ result: string; requests: [string, string][] }> => {
      const requests: [string, string][] = [];
      const options = {
        sourcePrompt,
        clean: (value: string) => value.trim(),
        isCurrent: () => true,
        request: async (system: string, user: string) => {
          requests.push([system, user]);
          assert.doesNotMatch(system + user, /7000|字符(?:上限|预算)|精简|h3_translation_units|h3_bounded_translation|unit_\d+|__LH_H3_NAME_|__LH_H3_DIALOGUE_|"translations"/u);
          return expected;
        },
      };
      const result = wrapper
        ? await translateH3PromptWithinBudget(options)
        : await translateVideoPromptToEnglish(options);
      return { result, requests };
    };
    const normal = await run(false);
    const legacyWrapper = await run(true);
    assert.deepEqual(legacyWrapper, normal, 'short and long H3 calls must have identical requests, validation and output');
    assert.equal(normal.requests.length, 1, 'legacy wrapper cannot introduce a budget or follow-up request');
    assert.equal(normal.result, expected);
    assert.equal(normal.result.length, characters ?? baseEnglish.length);
    assert.doesNotMatch(normal.result, /__LH_/u);
    if (sourcePrompt === keyframeSource) {
      assert.equal(normal.result.split('\n')[0], keyframeSource.split('\n')[0], 'both first/last-frame alignments stay unchanged');
    } else {
      assert.match(normal.result, /<Subject 1> is 沈砚 referenced from <Picture 1>/u);
      assert.match(normal.result, /<Subject 2> is 阿璃 referenced from <Picture 2>/u);
      assert.match(normal.result, /<Video 1>/u);
      assert.match(normal.result, /<Audio 1>/u);
      assert.match(normal.result, /跟紧我。/u, 'Chinese dialogue must retain its original wording');
      assert.match(normal.result, /我没事。/u, 'a later Chinese utterance must not be changed into English speech');
      assert.match(normal.result, /@阿璃/u);
    }
  }
}

for (const sourcePrompt of [keyframeSource, omniSource]) {
  let calls = 0;
  const expected = translate(sourcePrompt);
  assert.equal(await translateH3PromptWithinBudget({
    sourcePrompt,
    clean: (value) => value.trim(),
    request: async () => { calls += 1; return expected; },
  }), expected, 'a genuine model response using exact original official tags is valid for both keyframe and omni reference prompts');
  assert.equal(calls, 1);
}

let calls = 0;
const modelAlignmentText = await translateH3PromptWithinBudget({
  sourcePrompt: keyframeSource,
  clean: (value) => value.trim(),
  request: async (_system, user) => {
    calls += 1;
    return translate(user).replace('5.00-second mark', '6.00-second mark');
  },
});
assert.equal(modelAlignmentText, translate(keyframeSource).replace('5.00-second mark', '6.00-second mark'),
  'alignment prose is model-authored text, not a local literal-string rejection; official shot/cut structure is still protected');
assert.equal(calls, 1);

calls = 0;
await assert.rejects(translateH3PromptWithinBudget({
  sourcePrompt: '  \n\t ',
  clean: (value) => value,
  request: async () => { calls += 1; return ''; },
}), /没有可翻译的视频提示词/u);
assert.equal(calls, 0);

const unboundSource = omniSource.replaceAll('沈砚', '无名主角').replace(
  '<Subject 1> is 无名主角 referenced from <Picture 1>:',
  '<Subject 1> is 无名主角 defined by the canonical prompt:',
);
const unboundResult = await translateH3PromptWithinBudget({
  sourcePrompt: unboundSource,
  clean: (value) => value.trim(),
  request: async (_system, user) => {
    assert.doesNotMatch(user, /无名主角/u, 'the bare canonical name is protected without swallowing the canonical-binding description');
    assert.match(user, /defined by the canonical prompt/u);
    return translate(user);
  },
});
assert.equal(unboundResult, translate(unboundSource));

const noReferenceSource = keyframeSource.slice(keyframeSource.indexOf('integrated_multimodal_description:'));
for (const preamble of [
  '',
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
  'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 5.00-second mark of the target video.',
]) {
  const sourcePrompt = preamble ? `${preamble}\n\n${noReferenceSource}` : noReferenceSource;
  assert.equal(await translateH3PromptWithinBudget({
    sourcePrompt,
    clean: (value) => value.trim(),
    request: async (_system, user) => translate(user),
  }), translate(sourcePrompt), 'text-only and existing first/last-frame formats retain their established plain-text shape');
}

let aiReviewCalls = 0;
const aiReviewedH3 = translate(omniSource).replaceAll('沈砚', 'Lin Mu');
assert.equal(await translateH3PromptWithinBudget({
  sourcePrompt: omniSource,
  reviewWithAi: true,
  clean: () => { throw new Error('the legacy wrapper must not locally rewrite AI-reviewed text'); },
  request: async (_system, user) => {
    aiReviewCalls += 1;
    if (aiReviewCalls === 1) assert.equal(user, omniSource);
    else assert.equal(JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]).sourcePrompt, omniSource);
    return aiReviewCalls === 1 ? 'The candidate omitted a name.' : aiReviewedH3;
  },
}), aiReviewedH3, 'the H3 wrapper delegates actual full-source AI review with preserved H3 structure and no local name/prose rejection');
assert.equal(aiReviewCalls, 2);

// MiniMax H3 dialogue is carried by the model-owned H3 body.  These fixtures
// deliberately use a line which crosses an existing shot cut: the source
// wording is split only at the cut, while the official <scenetrans> marker is
// present in both sides of the continuation.  Translation and format repair
// must preserve the speaker IDs, language tag, exact Chinese words and marker;
// they must not fall back to the ordinary six-field timeline.
const h3DialogueSource = [
  'integrated_multimodal_description:',
  '[Shot 1] 师父(S1)把药草递向徒弟，徒弟伸手接住；师父说<d>[Chinese] 我把药草交给你，<scenetrans></d>音频连续，徒弟保持闭口。',
  '[Shot 2] At 00:05.000, 师父(S1)延续上镜同一句话；<d>[Chinese] <scenetrans>你要收好。</d> 徒弟(S2)低头确认药草后说<d>[Chinese] 我记住了。</d>，师父闭口聆听。',
  'overall_soundscape: 轻微衣料摩擦。',
  'non_diegetic_music: N/A',
].join('\n');
const h3DialogueEnglish = [
  'integrated_multimodal_description:',
  '[Shot 1] The master (S1) passes the herb to the disciple, who reaches for it. The master says <d>[Chinese] 我把药草交给你，<scenetrans></d> The audio continues uninterrupted into the next shot, and the disciple keeps his mouth closed.',
  '[Shot 2] At 00:05.000, the master (S1) continues the same line from the previous shot: <d>[Chinese] <scenetrans>你要收好。</d> The disciple (S2) looks down to confirm the herb, then says <d>[Chinese] 我记住了。</d> while the master listens with lips closed.',
  'overall_soundscape: Soft fabric movement.',
  'non_diegetic_music: N/A',
].join('\n');
assert.equal(getH3PromptProtocolIssue(h3DialogueSource), undefined, 'H3 dialogue tags do not alter the existing section/shot protocol');
assert.ok(H3_DIALOGUE_FORMAT_RULE.includes('(S1)') && H3_DIALOGUE_FORMAT_RULE.includes('<d>[Chinese]'), 'the official H3 rule names stable speaker IDs and language-tagged dialogue');
assert.ok(H3_DIALOGUE_FORMAT_RULE.includes('<scenetrans>'), 'the official H3 rule covers dialogue spanning an existing cut');
let h3DialogueCalls = 0;
const translatedH3Dialogue = await translateVideoPromptToEnglish({
  sourcePrompt: h3DialogueSource,
  reviewWithAi: true,
  clean: () => { throw new Error('AI-reviewed H3 text must not be locally rewritten'); },
  request: async (system, user) => {
    h3DialogueCalls += 1;
    assert.match(system, /<d>\[Chinese\]/u);
    assert.match(system, /<scenetrans>/u);
    if (h3DialogueCalls === 1) {
      assert.equal(user, h3DialogueSource);
      return h3DialogueEnglish;
    }
    const review = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
    assert.equal(review.sourcePrompt, h3DialogueSource);
    assert.equal(review.candidateEnglishPrompt, h3DialogueEnglish);
    return h3DialogueEnglish;
  },
});
assert.equal(h3DialogueCalls, 2, 'H3 translation uses one generation and one same-API AI review');
assert.equal(translatedH3Dialogue, h3DialogueEnglish, 'English review keeps H3 speaker IDs, tags and Chinese dialogue byte-for-byte');
for (const token of ['(S1)', '(S2)', '<d>[Chinese] 我把药草交给你，<scenetrans></d>', '<d>[Chinese] <scenetrans>你要收好。</d>', '<d>[Chinese] 我记住了。</d>']) {
  assert.equal(translatedH3Dialogue.includes(token), true, `preserves ${token}`);
}
assert.doesNotMatch(translatedH3Dialogue, /主体：|空间：|光影：|镜头：|台词：|音效：/u, 'H3 translation does not become an ordinary six-field timeline');

let h3RepairCalls = 0;
const repairedH3Dialogue = await repairH3PromptProtocolWithAi({
  formatReferencePrompt: h3DialogueSource,
  candidatePrompt: '[Shot 1] At 00:00, missing H3 dialogue formatting.',
  language: '中文',
  request: async (system, user) => {
    h3RepairCalls += 1;
    assert.match(system, /稳定\(S1\)、\(S2\)/u);
    assert.match(system, /<d>\[Chinese\]/u);
    const data = JSON.parse(user.match(/<h3_format_repair_data>\n([\s\S]+)\n<\/h3_format_repair_data>/u)![1]);
    assert.equal(data.requiredProtocol.shots.length, 2);
    return h3DialogueSource;
  },
});
assert.equal(h3RepairCalls, 1, 'a malformed H3 body is sent to the same API for format repair');
assert.equal(repairedH3Dialogue, h3DialogueSource, 'format repair returns the AI-authored H3 body without local reconstruction');

console.log('H3 shared plain English translation and AI review tests passed');
