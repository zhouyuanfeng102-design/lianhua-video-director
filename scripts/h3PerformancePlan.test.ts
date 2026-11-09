import assert from 'node:assert/strict';
import { h3PerformanceSpeakerTokens, normalizeH3PerformancePlan, parseH3PerformancePlan, renderH3PerformancePlan } from '../src/h3PerformancePlan';
import { H3_EXISTING_SOUND_SUMMARY_ZH } from '../src/h3DeliverySections';
import { H3_PERFORMANCE_DELIVERY_RULE } from '../src/h3IdentityBindings';
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

assert.match(H3_PERFORMANCE_DELIVERY_RULE, /后出现于本段的事件继续写在后镜/u);
assert.match(H3_PERFORMANCE_DELIVERY_RULE, /最后一镜在本段已确认的事件窗口内写出最后一个已分配事件的当前结果/u);

test('segment 4 converts the declared shot clock once and never voices the source observation', () => {
  const untouched = JSON.stringify(segment4);
  const rendered = renderH3PerformancePlan({ plan: segment4, characters, language: 'zh' });
  assert.equal(rendered.plan.timeBase, 'clip');
  assert.equal(rendered.plan.shots[1].events[1].startSec, 11.5);
  assert.equal(rendered.plan.shots[1].events[1].endSec, 13.1);
  assert.deepEqual(normalizeH3PerformancePlan(rendered.plan), rendered.plan);
  assert.equal(JSON.stringify(segment4), untouched);
  assert.match(rendered.prompt, /本段11\.50–13\.10秒，亚乌拉 \(S2\)，已确认的女性声线，says:/u);
  assert.doesNotMatch(rendered.prompt, /人物身份: 贝里尤洛 \(S1\)|人物身份: 亚乌拉 \(S2\)/u);
  assert.match(rendered.prompt, /亚乌拉的胸口和眼睛留在贝里尤洛与夏提雅身上，摄影机在两人连线的侧面/u);
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
  assert.match(command, /贝里尤洛 keeps their mouth closed/u);
  assert.match(command, /The camera shows a readable view of 夏提雅's mouth/u);
  assert.match(command, /This torso remains connected from these shoulders to these hips/u);
  assert.doesNotMatch(command, /贝里尤洛 \(S1\) keeps their mouth closed/u);
  assert.match(command, /From 10\.60 to 14\.40 seconds of this clip, 夏提雅 \(S2\), the established voice, says:/u);
  assert.doesNotMatch(command, /lips move with the words|speaks on-screen/u);
  assert.match(command, /<d>\[中文\] 没错，我们的君王是为了支配你们而来的，下跪低头吧。<\/d>/u);
  assert.match(command, /夏提雅 keeps the chest and eyes toward 贝里尤洛/u);
  assert.match(command, /贝里尤洛 listens without speaking, with no speaking lip movement/u);
  assert.match(command, /亚乌拉 remains silent: watches the exchange/u);
  assert.doesNotMatch(command, /贝里尤洛 \(S1\) speaks on-screen|夏提雅 remains silent|to 夏提雅 \(S2\) seconds/u);
  assert.equal(rendered.characters.find((entry) => entry.characterId === 'aura')?.speakerToken, undefined);
});

test('reference image order changes pictures only; subjects, voices, exact dialogue and anchors remain paired', () => {
  const input = { plan: segment5, characters, language: 'en' as const, mode: 'full-reference' as const,
    subjectTokens: new Map([['wolf', '<Subject 9>'], ['shalltear', '<Subject 2>'], ['aura', '<Subject 6>']]) };
  const first = renderH3PerformancePlan({ ...input, characterPictures: new Map([['wolf', [5]], ['shalltear', [3]], ['aura', [4]]]), pictureUses: [{ number: 1, role: 'first-frame' }] });
  const second = renderH3PerformancePlan({ ...input, characterPictures: new Map([['wolf', [3]], ['shalltear', [5]], ['aura', [4]]]) });
  assert.deepEqual(first.speakerTokens, second.speakerTokens);
  assert.match(first.prompt, /<Subject 2> is 夏提雅, visually referenced from <Picture 3>/u);
  assert.match(second.prompt, /<Subject 2> is 夏提雅, visually referenced from <Picture 5>/u);
  assert.doesNotMatch(first.prompt, /<Subject 2> is 夏提雅 \(S2\)/u);
  assert.match(first.prompt, /<Subject 2> 夏提雅 \(S2\), the established voice, says:/u);
  assert.deepEqual(readH3PromptProtocol(first.prompt)?.sections,
    ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  for (const entry of first.characters) assert.equal(first.prompt.split(entry.referenceAnchor).length - 1, 1);
  assert.deepEqual(first.prompt.match(/<d>[\s\S]*?<\/d>/gu), second.prompt.match(/<d>[\s\S]*?<\/d>/gu));
  const withOtherSubject = renderH3PerformancePlan({ plan: segment5, characters, language: 'en', mode: 'full-reference',
    subjectTokens: new Map([['wolf', '<Subject 2>']]), characterAudio: new Map([['shalltear', [7]]]),
    subjectDefinitions: '<Subject 1> is the authored castle.\n<Picture 8> is the opening composition reference.',
    pictureUses: [{ number: 8, role: 'first-frame' }] });
  assert.equal(withOtherSubject.characters.find((entry) => entry.characterId === 'shalltear')?.subjectToken, '<Subject 3>');
  assert.match(withOtherSubject.prompt, /夏提雅 \(S2\), the established voice, with the voice referenced from <Audio 7>, says:/u);
  assert.doesNotMatch(withOtherSubject.prompt, /is 夏提雅 \(S2\), with the voice referenced from <Audio 7>/u);
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
  assert.match(rendered.prompt, /Voice identity: 叙述者, referenced from <Audio 4>/u);
  assert.doesNotMatch(rendered.prompt, /Voice identity: 叙述者 \(S1\)/u);
  assert.match(rendered.prompt, /叙述者 \(S1\), the established narration voice, with the voice referenced from <Audio 4>, says in an off-screen voiceover/u);
  assert.equal(rendered.prompt.match(/says in an off-screen voiceover/gu)?.length, 1);
  assert.match(rendered.prompt, /亚乌拉 \(S3\) says: <d>\[中文\] 原来如此。<\/d>/u);
  assert.match(rendered.prompt, /The mouths already in the picture stay closed/u);
  assert.match(rendered.prompt, /remains outside this shot/u);
  assert.doesNotMatch(rendered.prompt, /speaks from off-screen|speaks on-screen|is heard in an explicitly authored inner voice/u);
  assert.doesNotMatch(rendered.prompt, /<Subject \d+> (?:is )?叙述者/u);
  assert.match(rendered.prompt, /\(S2\) makes the authored off-screen non-verbal vocal sound: a short authored gasp/u);
  assert.match(rendered.prompt, /\(S2,S3\) says:/u);
  assert.equal(rendered.prompt.match(/<d>/gu)?.length, 3);
});

test('authored cross-cut dialogue keeps one voice and only the authored word split', () => {
  const plan: H3PerformancePlan = { version: 1, timeBase: 'shot', shots: [
    { shotIndex: 1, startSec: 0, visualDescription: 'First view.', events: [{ eventId: 'd-a', kind: 'speech', dialogueId: 'd', speakerCharacterIds: ['shalltear'], channel: 'on-screen', language: 'Chinese', text: '没错，', startSec: 1, endSec: 2, continuesInNextShot: true }] },
    { shotIndex: 2, startSec: 2, visualDescription: 'The authored reverse angle.', events: [{ eventId: 'd-b', kind: 'speech', dialogueId: 'd', speakerCharacterIds: ['shalltear'], channel: 'off-screen', language: 'Chinese', text: '下跪低头吧。', startSec: 0, endSec: 1.5, continuesFromPreviousShot: true }] },
  ], overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A' };
  const rendered = renderH3PerformancePlan({ plan, characters, language: 'en' });
  assert.match(rendered.prompt, /<d>\[中文\] 没错，<scenetrans><\/d>/u);
  assert.match(rendered.prompt, /<d>\[中文\] <scenetrans>下跪低头吧。<\/d>/u);
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

test('a hidden mouth is closed on everyone else before the line reaches the speaker', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [
      { characterId: 'qian', visualDescription: '白发女子' },
      { characterId: 'yu', visualDescription: '站着的男子' },
    ],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: '中景从千仞雪侧后方拍摄，她跪趴，脸朝下，后脑朝向镜头。玉小刚正对镜头站着。', events: [
      { eventId: 'line', kind: 'speech', dialogueId: 'q1', speakerCharacterIds: ['qian'], listenerCharacterIds: ['yu'], startSec: 10.7, endSec: 14.7, channel: 'on-screen', language: 'Chinese', text: '唐三，你还要让我等多久？' },
    ] }],
    overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [
      { characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' },
      { characterId: 'yu', name: '玉小刚', referenceAnchor: '玉小刚' },
    ],
    language: 'zh',
  });
  const line = rendered.events.find((event) => event.dialogueId === 'q1')!.referenceAnchor!;
  const closedAt = line.indexOf('玉小刚的嘴保持闭合');
  const cameraAt = line.indexOf('能看清千仞雪的嘴');
  const speechAt = line.indexOf('says:');
  assert.ok(closedAt >= 0 && cameraAt > closedAt && speechAt > cameraAt);
  assert.match(line, /<d>\[中文\] 唐三，你还要让我等多久？<\/d>/u);
  assert.doesNotMatch(line, /玉小刚 says:|玉小刚的嘴张开|lips move with the words/u);
});

test('a bent-over kneel keeps both palms on the support in front', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'en',
    characters: [{ characterId: 'qian', visualDescription: 'a woman in white' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'She remains kneeling bent over. Her chest and face remain down toward the platform, her back toward the ceiling.', events: [] }],
    overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'en',
  });
  assert.match(rendered.prompt, /Both palms remain on the support in front of the shoulders/u);
  const placed: H3PerformancePlan = {
    ...plan,
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'She remains kneeling bent over with both hands behind her back.', events: [] }],
  };
  const kept = renderH3PerformancePlan({
    plan: placed,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'en',
  });
  assert.doesNotMatch(kept.prompt, /Both palms remain on the support in front of the shoulders/u);
});

test('a line buried in a behind-view shot is spoken from the readable mouth', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'qian', visualDescription: '白发女子' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'The camera cuts to a medium-close view from the side and behind the platform. 千仞雪 remains kneeling, her blindfold still on. Her mouth opens and her lips move with the words. 千仞雪 (S1)说: <d>[中文] 唐三，你还要让我等多久？</d> 说完后她的嘴唇闭合。', events: [] }],
    overallSoundscape: '殿内安静。', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'zh',
  });
  const cameraAt = rendered.prompt.indexOf('镜头能看清千仞雪的嘴');
  const saysAt = rendered.prompt.indexOf('千仞雪 (S1) says: <d>[中文] 唐三，你还要让我等多久？</d>');
  const closedAt = rendered.prompt.indexOf('说完后她的嘴唇闭合');
  assert.ok(cameraAt >= 0 && saysAt > cameraAt && closedAt > saysAt);
  assert.doesNotMatch(rendered.prompt, /Her mouth opens and her lips move with the words|千仞雪的嘴张开/u);
  assert.doesNotMatch(rendered.prompt, /The camera cuts/u);
});

test('a Chinese prompt drops an English shot sentence and keeps the Chinese one', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'qian', visualDescription: '白发女子' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'The camera cuts to a medium-close view from behind her. 她仍跪在石台上。', events: [] }],
    overallSoundscape: '殿内空旷近静音。', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'zh',
  });
  assert.match(rendered.prompt, /她仍跪在石台上/);
  assert.match(rendered.prompt, /殿内空旷近静音/);
  assert.doesNotMatch(rendered.prompt, /The camera cuts/u);
});

test('a hold through the line does not cover the spoken seconds', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'en',
    characters: [{ characterId: 'qian', visualDescription: 'a woman in white' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'The camera holds a medium view of her back. It stays at this distance through her line. Qian Renxue (S1) says: <d>[中文] 唐三，你还要让我等多久？</d>', events: [] }],
    overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'en',
  });
  const framingAt = rendered.prompt.indexOf('This torso remains connected from these shoulders to these hips.');
  const saysAt = rendered.prompt.indexOf('Qian Renxue (S1) says: <d>[中文] 唐三，你还要让我等多久？</d>');
  assert.ok(framingAt >= 0 && saysAt > framingAt);
  assert.doesNotMatch(rendered.prompt, /through her line|does not move|Identity: 千仞雪 \(S1\)|that framing ends|This view ends before the line/u);
  const held: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'en',
    characters: [
      { characterId: 'qian', visualDescription: 'a woman in white' },
      { characterId: 'yu', visualDescription: 'a man in black' },
    ],
    shots: [
      { shotIndex: 1, startSec: 0, visualDescription: 'Identity: 千仞雪 (S1). The camera holds a medium-wide view from the side of her body. It stays at this distance and does not move. 台词：无', events: [
        { eventId: 'line', kind: 'speech', dialogueId: 'q1', speakerCharacterIds: ['qian'], listenerCharacterIds: ['yu'], startSec: 10.7, endSec: 14.7, channel: 'on-screen', language: 'Chinese', text: '唐三，你还要让我等多久？' },
      ] },
      { shotIndex: 2, startSec: 5, visualDescription: 'The camera cuts to 玉小刚.', events: [] },
    ],
    overallSoundscape: '殿内安静。唐三，你还要让我等多久？', nonDiegeticMusic: 'N/A',
  };
  const again = renderH3PerformancePlan({
    plan: held,
    characters: [
      { characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' },
      { characterId: 'yu', name: '玉小刚', referenceAnchor: '玉小刚' },
    ],
    language: 'en',
  });
  assert.match(again.prompt, /Identity: 千仞雪:/u);
  assert.doesNotMatch(again.prompt, /Identity: 千仞雪 \(S1\)|台词：无|does not move|唐三，你还要让我等多久？(?!<\/d>)/u);
  assert.match(again.prompt, /千仞雪 \(S1\) says: <d>\[中文\] 唐三，你还要让我等多久？<\/d>/u);
  assert.match(again.prompt, /\[Shot 2\] At 00:05\.000/u);
  assert.doesNotMatch(again.prompt, /that framing ends|玉小刚's mouth closes again/u);
  assert.match(again.prompt, /玉小刚 keeps their mouth closed/u);
});

test('a close view keeps the head on the neck and the ribbon on the back of the head', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'en',
    characters: [{ characterId: 'qian', visualDescription: 'a woman in white' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: 'The camera cuts to a close view of her side. The ribbon passes behind the brain. Her head tilts.', events: [] }],
    overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }],
    language: 'en',
  });
  assert.match(rendered.prompt, /The head remains on this neck, the neck remains on these shoulders/u);
  assert.match(rendered.prompt, /across the back of the head/u);
  assert.doesNotMatch(rendered.prompt, /behind the brain/u);
});

test('an unrequested score becomes N/A and leaves the shot and soundscape', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'qian', visualDescription: '白发女子' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: '她跪在白玉石台上。低沉弦乐铺满这一镜。', events: [] }],
    overallSoundscape: '殿内安静。背景音乐使用钢琴。', nonDiegeticMusic: '无背景音乐，缓慢节拍的弦乐。',
  };
  const characters = [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }];
  const rendered = renderH3PerformancePlan({ plan, characters, language: 'zh' });
  assert.match(rendered.prompt, /non_diegetic_music:\nN\/A/u);
  assert.match(rendered.prompt, /殿内安静/);
  assert.match(rendered.prompt, /她跪在白玉石台上/);
  assert.doesNotMatch(rendered.prompt, /弦乐|钢琴|背景音乐|节拍/u);
  const kept = renderH3PerformancePlan({ plan, characters, language: 'en', keepScore: true });
  assert.match(kept.prompt, /无背景音乐，缓慢节拍的弦乐/);
  assert.match(kept.prompt, /低沉弦乐铺满这一镜/);
});

test('a line timed before its shot is played inside that shot, and the story does not end on the name', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [
      { characterId: 'qian', visualDescription: '白发女子' },
      { characterId: 'yu', visualDescription: '站着的男子' },
    ],
    shots: [
      { shotIndex: 1, startSec: 0, visualDescription: '千仞雪跪在台上。', events: [
        { eventId: 'ask', kind: 'speech', dialogueId: 'a', speakerCharacterIds: ['qian'], listenerCharacterIds: ['yu'], startSec: 0.6, endSec: 2, channel: 'on-screen', language: 'Chinese', text: '是你吗？' },
      ] },
      { shotIndex: 2, startSec: 9, visualDescription: '玉小刚按在腰侧。本段2.0-5.5秒她说完后仍跪着。', events: [
        { eventId: 'answer', kind: 'speech', dialogueId: 'b', speakerCharacterIds: ['yu'], listenerCharacterIds: ['qian'], startSec: 2, endSec: 5.5, channel: 'on-screen', language: 'Chinese', text: '你终于来了，我等你很久了。' },
      ] },
    ],
    overallSoundscape: '殿内安静。', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [
      { characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' },
      { characterId: 'yu', name: '玉小刚', referenceAnchor: '玉小刚' },
    ],
    language: 'zh',
  });
  assert.match(rendered.prompt, /<d>\[中文\] 是你吗？<\/d>/u);
  assert.match(rendered.prompt, /<d>\[中文\] 你终于来了，我等你很久了。<\/d>/u);
  assert.match(rendered.prompt, /本段9\.00–12\.50秒/u);
  assert.match(rendered.prompt, /玉小刚按在腰侧/u);
  assert.match(rendered.prompt, /From 9\.00 to 12\.50|本段9\.00–12\.50秒，玉小刚 \(S2\)/u);
  assert.doesNotMatch(rendered.prompt, /刚才的机位结束|这个画面在这句开始前结束|玉小刚的嘴重新闭合/u);
  assert.match(rendered.prompt, /这张嘴重新闭合/u);
});

test('a hip close-up keeps the torso, and two people keep their own hands', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [
      { characterId: 'qian', visualDescription: '白发女子' },
      { characterId: 'yu', visualDescription: '站着的男子' },
    ],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: '镜头对着腰和腿。玉小刚扶着千仞雪的腰。', events: [] }],
    overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan,
    characters: [
      { characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' },
      { characterId: 'yu', name: '玉小刚', referenceAnchor: '玉小刚' },
    ],
    language: 'zh',
  });
  assert.match(rendered.prompt, /这一条躯干从这对肩膀连到这截腰/u);
  assert.match(rendered.prompt, /胸和肩在画面上沿之外，也留在这条躯干上/u);
  assert.match(rendered.prompt, /千仞雪的双手留在千仞雪的手腕上，玉小刚的双手留在玉小刚的手腕上/u);
});

test('a selected picture style is written once, a sign keeps its words, and a first frame uses the official alignment line', () => {
  const plan: H3PerformancePlan = {
    version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'qian', visualDescription: '白发女子' }],
    shots: [
      { shotIndex: 1, startSec: 0, visualDescription: '门口霓虹写着「营业中」。她走进来。', events: [] },
      { shotIndex: 2, startSec: 4, visualDescription: '她停在台前。', events: [] },
    ],
    overallSoundscape: '殿内安静。', nonDiegeticMusic: 'N/A',
  };
  const rendered = renderH3PerformancePlan({
    plan, characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }], language: 'zh', durationSec: 15,
    pictureStyle: '色彩：青灰；材质：玉石；光影：冷灯；氛围：压抑；质感：细颗粒',
    pictureUses: [{ number: 1, role: 'first-frame' }],
  });
  assert.match(rendered.prompt, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./u);
  assert.equal(rendered.prompt.match(/画面风格：/gu)?.length, 1);
  assert.match(rendered.prompt, /画面风格：色彩：青灰；材质：玉石；光影：冷灯；质感：细颗粒。/u);
  assert.doesNotMatch(rendered.prompt, /氛围/);
  assert.match(rendered.prompt, /门口霓虹写着"营业中"/u);
  const custom = renderH3PerformancePlan({
    plan, characters: [{ characterId: 'qian', name: '千仞雪', referenceAnchor: '千仞雪' }], language: 'zh',
    pictureStyle: '3D电影CG写实',
  });
  assert.match(custom.prompt, /画面风格：3D电影CG写实。/u);
  assert.doesNotMatch(custom.prompt, /For the target video/u);
});

console.log(`h3PerformancePlan: ${groups} groups passed`);
