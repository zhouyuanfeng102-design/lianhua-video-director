import assert from 'node:assert/strict';
import { h3PerformanceSpeakerTokens, normalizeH3PerformancePlan, parseH3PerformancePlan, renderH3PerformancePlan } from '../src/h3PerformancePlan';
import { H3_EXISTING_SOUND_SUMMARY_ZH } from '../src/h3DeliverySections';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import type { H3IdentityBindings, H3PerformancePlan } from '../src/types';

const characters: H3IdentityBindings['characters'] = [
  { characterId: 'wolf', name: '贝里尤洛', speakerToken: '(S1)', referenceAnchor: '旧贝里尤洛 (S1)' },
  { characterId: 'shalltear', name: '夏提雅', speakerToken: '(S2)', referenceAnchor: '旧夏提雅 (S2)' },
  { characterId: 'aura', name: '亚乌拉', speakerToken: '(S3)', referenceAnchor: '旧亚乌拉 (S3)' },
];
const segment4: H3PerformancePlan = {
  version: 1, timeBase: 'shot', descriptionLanguage: 'zh',
  characters: [
    { characterId: 'wolf', visualDescription: '兽人氏族王', voiceDescription: '已确认的成年男性声线' },
    { characterId: 'shalltear', visualDescription: '身穿红铠的女性' },
    { characterId: 'aura', visualDescription: '穿白衣的黑暗精灵女性', voiceDescription: '已确认的女性声线' },
  ],
  shots: [
    { shotIndex: 1, startSec: 0, visualDescription: '贝里尤洛走到两人面前。', events: [
      { eventId: 'greeting', kind: 'speech', dialogueId: 'b1-d7', speakerCharacterIds: ['wolf'], listenerCharacterIds: ['shalltear', 'aura'],
        startSec: 3, endSec: 4.6, channel: 'on-screen', language: 'Chinese', text: '让你们久等了。' },
    ] },
    { shotIndex: 2, startSec: 6.5, visualDescription: '三人保持面对面的站位。', events: [
      { eventId: 'look', kind: 'visual', startSec: 0, endSec: 4.5,
        sourceFact: '没有看见与龙僵持不下的矮人和戴着骷髅头盔的家伙。',
        description: '贝里尤洛沉默地环视王都方向，目光回到红铠，眉头微锁。', silentCharacterIds: ['wolf', 'shalltear', 'aura'],
        soundDescription: '环视动作期间保留衣料的轻微摩擦声。' },
      { eventId: 'question', kind: 'speech', dialogueId: 'b1-d8', speakerCharacterIds: ['aura'], listenerCharacterIds: ['wolf', 'shalltear'],
        startSec: 5, endSec: 6.6, channel: 'on-screen', language: 'Chinese', text: '是喔，你谁啊？', delivery: '随意而不屑',
        reactions: [{ characterId: 'wolf', description: '保持审视', presence: 'visible' }] },
    ] },
  ], overallSoundscape: '', nonDiegeticMusic: 'N/A',
};

let groups = 0;
const test = (name: string, run: () => void): void => { run(); console.log(`PASS ${++groups} ${name}`); };

test('segment 4 converts the declared shot clock once and never voices the source observation', () => {
  const untouched = JSON.stringify(segment4);
  const rendered = renderH3PerformancePlan({ plan: segment4, characters, language: 'zh' });
  assert.equal(rendered.plan.timeBase, 'clip');
  assert.equal(rendered.plan.shots[1].events[1].startSec, 11.5);
  assert.equal(rendered.plan.shots[1].events[1].endSec, 13.1);
  assert.deepEqual(normalizeH3PerformancePlan(rendered.plan), rendered.plan);
  assert.equal(JSON.stringify(segment4), untouched);
  assert.match(rendered.prompt, /本段11\.50–13\.10秒，亚乌拉 \(S2\)在画内发话面向贝里尤洛与夏提雅/u);
  assert.match(rendered.prompt, /亚乌拉的身体与头部朝向贝里尤洛与夏提雅，视线落在对方身上/u);
  assert.match(rendered.prompt, /沉默地环视王都方向/u);
  assert.doesNotMatch(rendered.prompt, /矮人|骷髅|与龙僵持/u);
  assert.match(rendered.prompt, /衣料的轻微摩擦声/u);
  assert.ok(rendered.prompt.includes(`overall_soundscape:\n${H3_EXISTING_SOUND_SUMMARY_ZH}`));
  assert.equal(rendered.characters.find((entry) => entry.characterId === 'shalltear')?.speakerToken, undefined);
  assert.doesNotMatch(rendered.prompt, /夏提雅 \(S2\)|旧夏提雅|旧贝里尤洛/u);
  assert.deepEqual(readH3PromptProtocol(rendered.prompt)?.sections,
    ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']);
});

const segment5: H3PerformancePlan = {
  ...segment4, timeBase: 'clip', descriptionLanguage: 'en', characters: segment4.characters?.map((entry) => ({ ...entry, visualDescription: entry.characterId === 'shalltear' ? 'a woman in red armor' : 'the established visual identity', voiceDescription: 'the established voice' })),
  shots: [
    { shotIndex: 1, startSec: 0, visualDescription: 'The three characters face each other.', events: [
      { eventId: 'intro', kind: 'speech', dialogueId: 'b1-d9', speakerCharacterIds: ['wolf'], startSec: 0.5, endSec: 4.1, channel: 'on-screen', language: 'Chinese', text: '请问二位是？' },
      { eventId: 'declaration', kind: 'speech', dialogueId: 'b1-d10', speakerCharacterIds: ['shalltear'], listenerCharacterIds: ['wolf'], startSec: 4.6, endSec: 7.8, channel: 'on-screen', language: 'Chinese', text: '我们是受共同前来此地的伟大君王命令，来此支配你们的。' },
    ] },
    { shotIndex: 2, startSec: 8.2, visualDescription: 'The red armor remains in view.', events: [
      { eventId: 'repeat', kind: 'speech', dialogueId: 'b1-d11', speakerCharacterIds: ['wolf'], listenerCharacterIds: ['shalltear'], startSec: 9, endSec: 10.2, channel: 'on-screen', language: 'Chinese', text: '支配？' },
      { eventId: 'command', kind: 'speech', dialogueId: 'b1-d12', speakerCharacterIds: ['shalltear'], listenerCharacterIds: ['wolf'], startSec: 10.6, endSec: 14.4, channel: 'on-screen', language: 'Chinese', text: '没错，我们的君王是为了支配你们而来的，下跪低头吧。', delivery: 'calm and commanding',
        reactions: [{ characterId: 'wolf', description: 'keeps an attentive gaze', presence: 'visible' }, { characterId: 'aura', description: 'watches the exchange', presence: 'visible' }] },
    ] },
  ],
};

test('segment 5 renders the complete command with its owner, lip action and silent listeners', () => {
  const rendered = renderH3PerformancePlan({ plan: segment5, characters, language: 'en' });
  const command = rendered.events.find((event) => event.dialogueId === 'b1-d12')!.referenceAnchor!;
  assert.match(command, /^From 10\.60 to 14\.40 seconds of this clip, 夏提雅 \(S2\) speaks on-screen to 贝里尤洛:/u);
  assert.match(command, /<d>\[Chinese\] 没错，我们的君王是为了支配你们而来的，下跪低头吧。<\/d>/u);
  assert.match(command, /夏提雅 produces the speaking lip movements/u);
  assert.match(command, /夏提雅 keeps the body and head oriented toward 贝里尤洛, with gaze on them/u);
  assert.match(command, /贝里尤洛 listens without speaking, with no speaking lip movement/u);
  assert.match(command, /亚乌拉 remains silent: watches the exchange/u);
  assert.doesNotMatch(command, /贝里尤洛.*?speaks on-screen|夏提雅 remains silent|to 夏提雅 \(S2\) seconds/u);
  assert.equal(rendered.characters.find((entry) => entry.characterId === 'aura')?.speakerToken, undefined);
});

test('reference image order changes pictures only; subjects, voices, exact dialogue and anchors remain paired', () => {
  const input = { plan: segment5, characters, language: 'en' as const, mode: 'full-reference' as const,
    subjectTokens: new Map([['wolf', '<Subject 9>'], ['shalltear', '<Subject 2>'], ['aura', '<Subject 6>']]) };
  const first = renderH3PerformancePlan({ ...input, characterPictures: new Map([['wolf', [5]], ['shalltear', [3]], ['aura', [4]]]), pictureUses: [{ number: 1, role: 'first-frame' }] });
  const second = renderH3PerformancePlan({ ...input, characterPictures: new Map([['wolf', [3]], ['shalltear', [5]], ['aura', [4]]]) });
  assert.deepEqual(first.speakerTokens, second.speakerTokens);
  assert.match(first.prompt, /<Subject 2> is 夏提雅 \(S2\), visually referenced from <Picture 3>/u);
  assert.match(second.prompt, /<Subject 2> is 夏提雅 \(S2\), visually referenced from <Picture 5>/u);
  assert.match(first.prompt, /<Subject 2> 夏提雅 \(S2\) speaks on-screen to <Subject 9> 贝里尤洛/u);
  assert.deepEqual(readH3PromptProtocol(first.prompt)?.sections,
    ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  for (const entry of first.characters) assert.equal(first.prompt.split(entry.referenceAnchor).length - 1, 1);
  assert.deepEqual(first.prompt.match(/<d>[\s\S]*?<\/d>/gu), second.prompt.match(/<d>[\s\S]*?<\/d>/gu));
  const withOtherSubject = renderH3PerformancePlan({ plan: segment5, characters, language: 'en', mode: 'full-reference',
    subjectTokens: new Map([['wolf', '<Subject 2>']]), characterAudio: new Map([['shalltear', [7]]]),
    subjectDefinitions: '<Subject 1> is the authored castle.\n<Picture 8> is the opening composition reference.',
    pictureUses: [{ number: 8, role: 'first-frame' }] });
  assert.equal(withOtherSubject.characters.find((entry) => entry.characterId === 'shalltear')?.subjectToken, '<Subject 3>');
  assert.match(withOtherSubject.prompt, /夏提雅 \(S2\), with the voice referenced from <Audio 7>/u);
  assert.equal(withOtherSubject.prompt.match(/<Picture 8> is the opening composition reference/gu)?.length, 1);

  const duplicateAnchor = first.characters[0].referenceAnchor;
  const duplicateDefinitions = renderH3PerformancePlan({ ...input, characters: first.characters,
    characterPictures: new Map([['wolf', [5]], ['shalltear', [3]], ['aura', [4]]]),
    subjectDefinitions: `${duplicateAnchor}\n${duplicateAnchor}` });
  assert.equal(duplicateDefinitions.prompt.split(duplicateAnchor).length - 1, 1,
    'identity anchors remain unique when an older definitions block repeats them');
});

test('explicit voiceover, internal voice, non-verbal voice and simultaneous speech retain their channels', () => {
  const plan: H3PerformancePlan = { version: 1, timeBase: 'clip', characters: [{ characterId: 'narrator', name: '叙述者', presence: 'offscreen', visualDescription: '', voiceDescription: 'the established narration voice' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'The existing scene remains visible.', events: [
      { eventId: 'n', kind: 'speech', dialogueId: 'n1', speakerCharacterIds: ['narrator'], startSec: 0, endSec: 1, channel: 'voiceover', language: 'Chinese', text: '夜幕降临。' },
      { eventId: 'g', kind: 'vocal', speakerCharacterIds: ['wolf'], startSec: 1, endSec: 2, channel: 'off-screen', vocalDescription: 'a short authored gasp' },
      { eventId: 'i', kind: 'speech', dialogueId: 'i1', speakerCharacterIds: ['aura'], startSec: 2, endSec: 3, channel: 'inner-voice', language: 'Chinese', text: '原来如此。' },
      { eventId: 'u', kind: 'speech', dialogueId: 'u1', speakerCharacterIds: ['wolf', 'aura'], startSec: 4, endSec: 5, channel: 'on-screen', language: 'Chinese', text: '好。' },
    ] }], overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A' };
  const rendered = renderH3PerformancePlan({ plan, characters, language: 'en', mode: 'full-reference',
    characterAudio: new Map([['narrator', [4]]]) });
  assert.match(rendered.prompt, /Voice identity: 叙述者 \(S1\)/u);
  assert.match(rendered.prompt, /Voice identity: 叙述者 \(S1\), referenced from <Audio 4>/u);
  assert.match(rendered.prompt, /叙述者 \(S1\) says in an off-screen voiceover/u);
  assert.doesNotMatch(rendered.prompt, /<Subject \d+> (?:is )?叙述者/u);
  assert.match(rendered.prompt, /\(S2\) makes the authored off-screen non-verbal vocal sound: a short authored gasp/u);
  assert.match(rendered.prompt, /\(S3\) is heard in an explicitly authored inner voice/u);
  assert.match(rendered.prompt, /\(S2,S3\) speaks on-screen in unison/u);
  assert.equal(rendered.prompt.match(/<d>/gu)?.length, 3);
});

test('authored cross-cut dialogue keeps one voice and only the authored word split', () => {
  const plan: H3PerformancePlan = { version: 1, timeBase: 'shot', shots: [
    { shotIndex: 1, startSec: 0, visualDescription: 'First view.', events: [{ eventId: 'd-a', kind: 'speech', dialogueId: 'd', speakerCharacterIds: ['shalltear'], channel: 'on-screen', language: 'Chinese', text: '没错，', startSec: 1, endSec: 2, continuesInNextShot: true }] },
    { shotIndex: 2, startSec: 2, visualDescription: 'The authored reverse angle.', events: [{ eventId: 'd-b', kind: 'speech', dialogueId: 'd', speakerCharacterIds: ['shalltear'], channel: 'off-screen', language: 'Chinese', text: '下跪低头吧。', startSec: 0, endSec: 1.5, continuesFromPreviousShot: true }] },
  ], overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A' };
  const rendered = renderH3PerformancePlan({ plan, characters, language: 'en' });
  assert.match(rendered.prompt, /<d>\[Chinese\] 没错，<scenetrans><\/d>/u);
  assert.match(rendered.prompt, /<d>\[Chinese\] <scenetrans>下跪低头吧。<\/d>/u);
  assert.equal(rendered.prompt.match(/<scenetrans>/gu)?.length, 2);
  assert.doesNotMatch(rendered.prompt, /<cutoff>/u);
  assert.equal(rendered.speakerTokens.get('shalltear'), '(S1)');
  assert.equal(rendered.plan.shots[1].events[0].startSec, 2);
  assert.equal(rendered.plan.shots[1].events[0].endSec, 3.5);
});

test('metadata parsing is optional and unknown legacy shapes do not fabricate a performance', () => {
  assert.equal(parseH3PerformancePlan(undefined), undefined);
  assert.equal(parseH3PerformancePlan({ version: 1, characters: [] }), undefined);
  assert.equal(parseH3PerformancePlan({ ...segment4, timeBase: undefined }), undefined);
  assert.deepEqual(parseH3PerformancePlan(segment4), normalizeH3PerformancePlan(segment4));
  assert.deepEqual([...h3PerformanceSpeakerTokens(segment5)], [['wolf', '(S1)'], ['shalltear', '(S2)']]);
});

console.log(`h3PerformancePlan: ${groups} groups passed`);
