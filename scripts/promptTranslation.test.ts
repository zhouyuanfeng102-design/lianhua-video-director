import assert from 'node:assert/strict';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import {
  AUDIO_PROMPT_RULE, AUDIO_TRANSLATION_SCOPE_RULE, DIALOGUE_DELIVERY_RULE,
  NO_DIALOGUE_PERFORMANCE_RULE, VISUAL_IDENTITY_SPEECH_SCOPE_RULE,
} from '../src/audioPromptPolicy';
import { VIDEO_WARDROBE_SCOPE_RULE } from '../src/videoConversionRules';
import { H3_CLIP_TIME_RULE, H3_FINAL_BODY_FORMAT_RULE, h3DescriptionLanguageRule, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { VIDEO_ACTING_CAMERA_TRANSLATION_RULE } from '../src/videoActingCameraRules';
import { SPATIAL_COORDINATE_RULE, SPATIAL_TRANSLATION_RULE } from '../src/spatialContinuityRules';
import { requestTextModel } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';
import {
  translateVideoPromptToEnglish,
  VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT,
  VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT,
  VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT,
} from '../src/promptTranslation';

const sourcePrompt = [
  '【0s-2.5s】主体：@沈砚。动作：推开木门。',
  '【2.5s—5s】主体：@阿璃。动作：转身看向 @沈砚。',
].join('\n');

let receivedSystemPrompt = '';
let receivedUserPrompt = '';
let cleanedValue = '';
const english = await translateVideoPromptToEnglish({
  sourcePrompt,
  request: async (systemPrompt, userPrompt) => {
    receivedSystemPrompt = systemPrompt;
    receivedUserPrompt = userPrompt;
    return [
      '[0 to 2.5] Subject: __LH_ENTITY_001__. Action: pushes open the wooden door.',
      '[2.5s-5s] Subject: __LH_ENTITY_002__. Action: turns toward __LH_ENTITY_001__.',
    ].join('\n');
  },
  clean: (value) => {
    cleanedValue = value;
    return value.trim();
  },
});

assert.equal(
  receivedSystemPrompt,
  `${VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT}\n本次只返回完整提示词正文，不返回JSON。`,
  'body-only callers receive the shared translation rules plus one explicit body output contract',
);
assert.match(
  receivedSystemPrompt,
  /只翻译语言，不改写剧情，不添加或删除镜头/u,
  'the model must be told to translate without changing the storyboard structure',
);
assert.match(receivedSystemPrompt, /不把“无”、N\/A、安静背景或声音间隙扩写成连续底噪/u);
assert.match(receivedSystemPrompt, /原文明确要求的背景音乐必须保留.*低音量/u);
assert.ok(receivedSystemPrompt.includes(AUDIO_TRANSLATION_SCOPE_RULE), 'English preserves the confirmed quiet-background mix without re-planning audio');
assert.doesNotMatch(receivedSystemPrompt, new RegExp(AUDIO_PROMPT_RULE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
assert.match(receivedSystemPrompt, /不授权翻译阶段新增原稿没有的动作或声音/u);
assert.match(receivedSystemPrompt, /距离、力度、可听程度和原相对时间/u);
assert.match(receivedSystemPrompt, /非常轻、几乎听不见.*very soft \/ barely audible/u);
assert.match(receivedSystemPrompt, /不得一律追加 clearly audible、loud kiss、lip smack 或 close-miked mouth sound/u);
assert.doesNotMatch(receivedSystemPrompt, /应明确译为 brief soft kiss sound|保留细微但清楚可辨（subtle but clearly audible）/u);
assert.match(receivedSystemPrompt, /没有吻声的原稿、未发生或被否定的亲吻不得自行补吻声/u);
assert.doesNotMatch(
  receivedUserPrompt,
  /@沈砚|@阿璃/u,
  'named entities must be protected before the prompt reaches the model',
);
assert.equal(
  receivedUserPrompt.match(/__LH_ENTITY_001__/gu)?.length,
  2,
  'repeated entities must use the same protected token',
);
assert.equal(
  english,
  [
    '【0s-2.5s】 Subject: @沈砚. Action: pushes open the wooden door.',
    '【2.5s—5s】 Subject: @阿璃. Action: turns toward @沈砚.',
  ].join('\n'),
  'the helper must return cleaned English while restoring entities and the exact source timestamps',
);
assert.equal(
  cleanedValue,
  english,
  'timestamp and entity normalization must happen before the existing prompt cleaner runs',
);

await assert.rejects(
  translateVideoPromptToEnglish({
    sourcePrompt,
    request: async () => [
      '[0s-2.5s] Subject: __LH_ENTITY_001__.',
      '[2.5s-5s] Subject: a woman looking toward __LH_ENTITY_001__.',
    ].join('\n'),
    clean: (value) => value.trim(),
  }),
  /英文翻译修改或遗漏了主体 @阿璃/u,
  'an entity token omitted by the model must keep the established clear retry error',
);

await assert.rejects(
  translateVideoPromptToEnglish({
    sourcePrompt,
    request: async () => '[0s-5s] Subject: __LH_ENTITY_001__ and __LH_ENTITY_002__. Action: __LH_ENTITY_001__ enters.',
    clean: (value) => value.trim(),
  }),
  /英文翻译未完整保留时间戳或分镜数量/u,
  'a changed timestamp count must be rejected by the existing completeness check',
);

const officialH3Source = [
  'subject_definitions:',
  '<Subject 1> is @沈砚 referenced from <Picture 1>: 男性剑客。',
  '',
  'summary:',
  '5秒目标视频。',
  '',
  'retention_analysis:',
  '<Subject 1> appears in [Shot 1] through [Shot 2]: fully_preserved。',
  '',
  'detailed_description:',
  '[Shot 1] 5秒；<Subject 1>；<Picture 1>；动作：推门。',
  '[Shot 2] At 00:02.000, <Subject 1>；动作：转身。',
  '',
  'overall_soundscape: 雨声。',
  '',
  'non_diegetic_music: N/A',
].join('\n');
await assert.rejects(
  translateVideoPromptToEnglish({
    sourcePrompt: officialH3Source,
    request: async (_systemPrompt, userPrompt) => userPrompt.replace('__LH_H3_CUT_001__', 'At 00:03.000'),
    clean: (value) => value.trim(),
  }),
  /英文翻译修改或遗漏了官方切点/u,
  'an H3 translation that changes an At MM:SS.mmm cut point must be rejected',
);

const translatedOfficialH3 = await translateVideoPromptToEnglish({
  sourcePrompt: officialH3Source,
  request: async (_systemPrompt, userPrompt) => userPrompt
    .replace('男性剑客', 'male swordsman')
    .replaceAll('5秒', '5 seconds')
    .replace('目标视频', 'target video')
    .replace('动作：推门', 'Action: opens the door')
    .replace('动作：转身', 'Action: turns around')
    .replace('雨声。', 'rain ambience.'),
  clean: (value) => value.trim(),
});
assert.match(
  translatedOfficialH3,
  /subject_definitions:/u,
  'a valid H3 translation must retain the official section names',
);
assert.match(
  translatedOfficialH3,
  /\[Shot 2\] At 00:02\.000/u,
  'a valid H3 translation must retain the exact At cut marker',
);
assert.doesNotMatch(
  translatedOfficialH3,
  /__LH_/u,
  'protected H3 placeholders must be restored before persistence',
);

let blankRequestCalled = false;
await assert.rejects(
  translateVideoPromptToEnglish({
    sourcePrompt: '  \n\t ',
    request: async () => {
      blankRequestCalled = true;
      return 'unused';
    },
    clean: (value) => value,
  }),
  /没有可翻译的视频提示词/u,
  'blank input must fail with an actionable message before requesting the model',
);
assert.equal(blankRequestCalled, false, 'blank input must not call the text model');

const plainH3Source = [
  'subject_definitions:',
  '<Subject 1> is 沈砚 referenced from <Picture 1>: 剑客。',
  '<Subject 2> is 阿璃 referenced from <Picture 2>: 白衣修士。',
  'summary:',
  '<Subject 1> 与 <Subject 2> 过桥。',
  'retention_analysis:',
  '<Subject 1> appears in [Shot 1] through [Shot 2]: 沈砚。',
  '<Subject 2> appears in [Shot 1] through [Shot 2]: 阿璃。',
  'detailed_description:',
  '[Shot 1] <Subject 1> 对 @阿璃 说：“跟紧我。” <Subject 2> 点头。',
  '[Shot 2] At 00:05.000, <Subject 2> 站稳；<Subject 1> 松手。',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const translatePlainH3Descriptions = (value: string): string => value
  .replace(/第(\d+(?:\.\d+)?)s(?:起)?/gu, 'at $1s ')
  .replaceAll('原对白：', 'Original dialogue: ')
  .replaceAll('台词：', 'Dialogue: ')
  .replace('剑客。', 'swordsman.')
  .replace('白衣修士。', 'white-robed cultivator.')
  .replace(' 与 ', ' and ')
  .replace(' 过桥。', ' cross the bridge.')
  .replace(' 对 ', ' tells ')
  .replace(' 说：', ': ')
  .replace(' 点头。', ' nods.')
  .replace(' 站稳；', ' steadies herself; ')
  .replace(' 松手。', ' lets go.')
  .replaceAll('。', '.');
const translatePlainH3 = (value: string): string => value
  .split(/(“[^”]*”|「[^」]*」|『[^』]*』|'[^']*'|"[^"\n]*")/u)
  .map((part, index) => index % 2 ? part : translatePlainH3Descriptions(part))
  .join('');
const expectedPlainH3 = translatePlainH3(plainH3Source);

for (const responseMode of ['placeholder', 'original', 'mixed'] as const) {
  let requests = 0;
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: plainH3Source,
    clean: (value) => value.trim(),
    request: async (system, user) => {
      requests += 1;
      assert.doesNotMatch(user, /沈砚|阿璃/u, 'bare defined names and @entities share the same whole-prompt protection');
      assert.doesNotMatch(system + user, /h3_translation_units|h3_bounded_translation|__LH_H3_NAME_|__LH_H3_DIALOGUE_|"translations"/u);
      if (responseMode === 'original') return expectedPlainH3;
      const translated = translatePlainH3(user);
      if (responseMode === 'placeholder') return translated;
      return translated
        .replace('__LH_H3_TAG_001__', '<Subject 1>')
        .replace('__LH_H3_SECTION_001__', 'subject_definitions:')
        .replace('__LH_H3_CUT_001__', 'At 00:05.000')
        .replace('__LH_ENTITY_001__', '@阿璃');
    },
  });
  assert.equal(requests, 1, `valid ${responseMode} response must take the same single translation path`);
  assert.equal(result, expectedPlainH3);
  assert.doesNotMatch(result, /__LH_/u);
}

for (const corruption of ['missing', 'duplicate', 'wrong', 'unknown', 'order', 'section', 'cut', 'placeholder', 'entity', 'empty-dialogue'] as const) {
  let requests = 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: plainH3Source,
    clean: (value) => value.trim(),
    request: async (_system, user) => {
      requests += 1;
      const translated = translatePlainH3(user);
      if (corruption === 'missing') return translated.replace('__LH_H3_TAG_001__', '');
      if (corruption === 'duplicate') return translated.replace('__LH_H3_TAG_001__', '__LH_H3_TAG_001__ <Subject 1>');
      if (corruption === 'wrong') return translated.replace('__LH_H3_TAG_001__', '<Subject 99>');
      if (corruption === 'unknown') return `${translated}\n<Picture 99>`;
      if (corruption === 'order') return translated.replace('__LH_H3_TAG_001__', '__SWAP__')
        .replace('__LH_H3_TAG_002__', '__LH_H3_TAG_001__').replace('__SWAP__', '__LH_H3_TAG_002__');
      if (corruption === 'section') return `${translated}\nsummary: invented`;
      if (corruption === 'cut') return translated.replace('__LH_H3_CUT_001__', 'At 00:06.000');
      if (corruption === 'placeholder') return `${translated}\n__LH_H3_TAG_999__`;
      if (corruption === 'entity') return translated.replace('__LH_ENTITY_001__', '@阿狸');
      if (corruption === 'empty-dialogue') return translated.replace('__LH_DIALOGUE_001__', '“”');
      return user;
    },
  }), /英文翻译/u, `${corruption} must be rejected without silently inventing or restoring missing content`);
  assert.equal(requests, 1, `${corruption} must not invoke the removed JSON fallback`);
}

let mixedLanguageCalls = 0;
assert.equal(await translateVideoPromptToEnglish({
  sourcePrompt: plainH3Source,
  clean: (value) => value.trim(),
  request: async (_system, user) => {
    mixedLanguageCalls += 1;
    return user.replace('白衣修士。', 'a 白衣修士 in white robes.');
  },
}), plainH3Source.replace('白衣修士。', 'a 白衣修士 in white robes.'),
'a structurally valid model response is not rejected by a local Chinese-character detector');
assert.equal(mixedLanguageCalls, 1);

const quotedSignSource = officialH3Source.replace('5秒目标视频。', '5秒目标视频。招牌写着“夜市”。');
for (const modelDescription of [
  'The sign reads 「Night market」.',
  'The sign reads “Night market”; a second label says "Open".',
  'The sign reads Night Market without quotation marks.',
  'The blank sign shows “”.',
]) {
  let requests = 0;
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: quotedSignSource,
    clean: (value) => value.trim(),
    request: async (_system, user) => {
      requests += 1;
      return user.replace('招牌写着“夜市”。', modelDescription);
    },
  });
  assert.equal(result, quotedSignSource.replace('招牌写着“夜市”。', modelDescription),
    'readable model-authored description and quotation choices are not local semantic failures');
  assert.equal(requests, 1);
}

const translatedSpeechContextSource = [
  'integrated_multimodal_description: [Shot 1] 第1s @沈砚 说：“跟紧我。”',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const changedSpeechContext = await translateVideoPromptToEnglish({
  sourcePrompt: translatedSpeechContextSource,
  clean: (value) => value.trim(),
  request: async (_system, user) => user.replace('第1s', 'at 2 seconds').replace(' 说：', ' gestures: '),
});
assert.equal(changedSpeechContext, translatedSpeechContextSource.replace('第1s', 'at 2 seconds').replace(' 说：', ' gestures: '),
  'the local parser does not second-guess readable speaker/timing prose; opaque dialogue and official cut tokens remain protected');

for (const emptyResponse of ['', ' \n\t ']) {
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: '普通场景。',
    clean: (value) => value,
    request: async () => emptyResponse,
  }), /返回空内容/u, 'empty responses remain technical failures even without H3 tags or time ranges');
}
await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: '普通场景。',
  clean: () => ' \n ',
  request: async () => 'An ordinary scene.',
}), /返回空内容/u, 'a cleaner must not turn usable content into a saved blank');

await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: plainH3Source,
  clean: (value) => value.replace('<Subject 1>', '').trim(),
  request: async (_system, user) => translatePlainH3(user),
}), /英文翻译/u, 'the cleaned result must still preserve the original complete official structure');

let invalidOverlongCalls = 0;
await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: plainH3Source,
  clean: (value) => value.trim(),
  request: async (_system, user) => {
    invalidOverlongCalls += 1;
    return `${translatePlainH3(user).replace('__LH_H3_TAG_001__', '')}\n${'long '.repeat(2000)}`;
  },
}), /英文翻译修改或遗漏了官方标签/u);
assert.equal(invalidOverlongCalls, 1, 'a long structurally invalid response still fails without any retry');

for (const characters of [7254, 19281, 25000]) {
  let requests = 0;
  const tail = 'END_MUST_NOT_BE_TRUNCATED';
  const expected = `${expectedPlainH3}\n${'x'.repeat(characters - expectedPlainH3.length - 1 - tail.length)}${tail}`;
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: plainH3Source,
    clean: (value) => value.trim(),
    request: async (system, user) => {
      requests += 1;
      assert.equal(system, `${VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT}\n\n${H3_CLIP_TIME_RULE}\n本次只返回完整提示词正文，不返回JSON。\n\n${h3DescriptionLanguageRule('英文')}`);
      assertH3DescriptionLanguage(system, '英文');
      assert.doesNotMatch(system + user, /7000|字符(?:上限|预算)|精简|unit_\d+|<h3_|"translations"/u);
      return expected;
    },
  });
  assert.equal(result.length, characters);
  assert.equal(result, expected, 'long English is saved whole, including the final tail');
  assert.equal(requests, 1, 'prompt length cannot trigger another translation or concision request');
}

for (const failure of [new Error('network failed'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
  let calls = 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: plainH3Source,
    clean: (value) => value.trim(),
    request: async () => {
      calls += 1;
      throw failure;
    },
  }), (error: unknown) => error === failure);
  assert.equal(calls, 1, 'network errors and cancellation must never trigger another request');
}

for (const cancelCall of [0, 1]) {
  let calls = 0;
  let current = cancelCall !== 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: plainH3Source,
    isCurrent: () => current,
    clean: (value) => value.trim(),
    request: async (_system, user) => {
      calls += 1;
      if (calls === cancelCall) current = false;
      return `${translatePlainH3(user)}\n${'long '.repeat(2000)}`;
    },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls, cancelCall, 'a stale project/segment/reference must stop before a follow-up request or saving');
}

let genericCalls = 0;
const genericWithoutBudget = await translateVideoPromptToEnglish({
  sourcePrompt: '普通场景。',
  clean: (value) => value.trim(),
  request: async (system, user) => {
    genericCalls += 1;
    assert.equal(system, `${VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT}\n本次只返回完整提示词正文，不返回JSON。`);
    assert.equal(user, '普通场景。');
    return 'An ordinary scene. '.repeat(600);
  },
});
assert.equal(genericCalls, 1);
assert.ok(genericWithoutBudget.length > 7000, 'ordinary non-H3 translation remains unbounded');

let stale = false;
await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: plainH3Source,
  isCurrent: () => !stale,
  clean: (value) => value,
  request: async () => { stale = true; throw new Error('connection closed after selection changed'); },
}), (error: unknown) => error instanceof Error && error.name === 'AbortError', 'stale rejection is cancellation, never a recoverable translation error');

await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: 'integrated_multimodal_description: [Shot 1] __LH_ENTITY_001__',
  clean: (value) => value,
  request: async () => { throw new Error('must not request corrupted source'); },
}), /原稿含有未还原的内部占位符/u);

const latinNameSource = [
  'subject_definitions:',
  '<Subject 1> is Ben referenced from <Picture 1>: 男子。',
  '<Subject 2> is Li referenced from <Picture 2>: 女子。',
  'summary: Ben扶住Li。 Lightbox marks the location.',
  'detailed_description:',
  '[Shot 1] <Subject 1> 弯腰；<Subject 2> 举灯。',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const translateLatinNames = (value: string): string => value
  .replace('男子。', 'a man.')
  .replace('女子。', 'a woman.')
  .replace('扶住', ' steadies ')
  .replace('弯腰', 'Bends down')
  .replace('举灯', 'raises the lamp; Light brightens the room')
  .replaceAll('。', '.')
  .replaceAll('；', '; ');
for (const originalTags of [false, true]) {
  const expected = translateLatinNames(latinNameSource);
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: latinNameSource,
    clean: (value) => value.trim(),
    request: async (_system, user) => {
      assert.match(user, /Lightbox marks the location/u, 'a Latin definition name must not match inside an existing longer Latin word');
      assert.match(user, /__LH_ENTITY_\d+__扶住__LH_ENTITY_\d+__/u, 'Latin names next to Chinese prose still need their normal identity protection');
      return originalTags ? expected : translateLatinNames(user);
    },
  });
  assert.equal(result, expected, 'new English words Bends and Light must not create false extra Ben/Li identity occurrences');
}
await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: latinNameSource,
  clean: (value) => value.trim(),
  request: async () => translateLatinNames(latinNameSource).replace('is Ben ', 'is Benny '),
}), /英文翻译修改或遗漏了主体 Ben/u, 'a longer different Latin identity cannot pass as the original short name');

for (const between of ['', 'translated']) {
  const adjacent = await translateVideoPromptToEnglish({
    sourcePrompt: '@沈砚 和 @阿璃',
    clean: (value) => value.trim(),
    request: async () => `__LH_ENTITY_001__${between}__LH_ENTITY_002__`,
  });
  assert.equal(adjacent, `@沈砚${between}@阿璃`, 'known adjacent placeholders or placeholders touching ordinary English remain separate tokens');
}
await assert.rejects(translateVideoPromptToEnglish({
  sourcePrompt: '@沈砚 和 @阿璃',
  clean: (value) => value.trim(),
  request: async () => '__LH_ENTITY_001__translated__LH_ENTITY_999____LH_ENTITY_002__',
}), /英文翻译增加了未知的内部占位符/u, 'an actual unknown token between adjacent known tokens still fails');

const kissSoundSource = [
  'integrated_multimodal_description: [Shot 1] @叶清碧 轻吻 @无名主角 的左脸；声音：动作层-[第1.2s短促轻吻声，细微但清楚可辨] 环境层-[无]。',
  '[Shot 2] At 00:04.000, @叶清碧 只是靠近，没有再次亲吻；声音：动作层-[无] 环境层-[无]。',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const translateKissSound = (value: string): string => value
  .replace('轻吻', 'briefly kisses')
  .replace('的左脸', 'on the left cheek')
  .replace('只是靠近，没有再次亲吻', 'only moves closer, without another kiss')
  .replace('第1.2s短促轻吻声，细微但清楚可辨', 'at 1.2s a brief soft kiss sound, subtle but clearly audible')
  .replaceAll('声音：', 'Sound: ')
  .replaceAll('动作层-', 'action-')
  .replaceAll('环境层-', 'background-')
  .replaceAll('[无]', '[none]')
  .replaceAll('；', '; ')
  .replaceAll('。', '.');
let kissTranslationCalls = 0;
const translatedKissSound = await translateVideoPromptToEnglish({
  sourcePrompt: kissSoundSource,
  clean: (value) => value.trim(),
  request: async (_system, user) => { kissTranslationCalls += 1; return translateKissSound(user); },
});
assert.equal(kissTranslationCalls, 1, 'the sound contract does not create another English pass');
assert.equal(translatedKissSound, translateKissSound(kissSoundSource));
assert.match(translatedKissSound, /at 1\.2s a brief soft kiss sound, subtle but clearly audible/u);
assert.match(translatedKissSound, /\[Shot 2\] At 00:04\.000,[^\n]*without another kiss; Sound: action-\[none\]/u);
assert.doesNotMatch(translatedKissSound, /generic faint contact|silent audio|ASMR|gasp|breathing/u);
assert.match(translatedKissSound, /non_diegetic_music: N\/A/u, 'no music does not remove the actual timed kiss event');

for (const [sourceCue, englishCue] of [
  ['第1.2s中景轻吻非常轻，几乎听不见', 'at 1.2s the medium-shot kiss is very soft, barely audible'],
  ['不单列吻声', 'no separate kiss sound'],
]) {
  const naturalKissSource = kissSoundSource.replace('第1.2s短促轻吻声，细微但清楚可辨', sourceCue);
  const translateNaturalKiss = (value: string): string => translateKissSound(value).replace(sourceCue, englishCue);
  let naturalKissCalls = 0;
  const naturalKissEnglish = await translateVideoPromptToEnglish({
    sourcePrompt: naturalKissSource,
    clean: (value) => value.trim(),
    request: async (system, user) => {
      naturalKissCalls += 1;
      assert.match(system, /距离、力度、可听程度和原相对时间/u);
      assert.match(system, /不得一律追加 clearly audible、loud kiss/u);
      return translateNaturalKiss(user);
    },
  });
  assert.equal(naturalKissCalls, 1);
  assert.equal(naturalKissEnglish, translateNaturalKiss(naturalKissSource));
  assert.ok(naturalKissEnglish.includes(englishCue));
  assert.doesNotMatch(naturalKissEnglish, /clearly audible|loud kiss|lip smack|close-miked/u,
    'translation must accept natural near-silence without strengthening or synthesizing foley');
}

// Live AI mode must send the actual full source and make a second real request.
// Literal name counts, romanization, quote style and timestamps do not become
// a new local acceptance gate after the configured model has reviewed them.
const aiSource = [
  'subject_definitions:',
  '<Subject 1> is 林沐 referenced from <Picture 1>: 男性剑客。',
  '<Subject 2> is 小师姐 referenced from <Picture 2>: 青衣修士。',
  'summary: 林沐与小师姐在演武场切磋。',
  'retention_analysis: <Subject 1> and <Subject 2> fully_preserved.',
  'detailed_description:',
  '[Shot 1] <Subject 1> 挡住 <Subject 2> 的剑。第1s 林沐说：“师姐，接招。”',
  '[Shot 2] At 00:05.000, <Subject 2> 收剑，第1s 小师姐说：“再来一次。”',
  'overall_soundscape: 剑身短促相击。',
  'non_diegetic_music: N/A',
  `完整原稿尾段：${'末段动作与原稿对白继续保留。'.repeat(2200)}TAIL_OF_COMPLETE_SOURCE`,
].join('\n');
const aiCandidate = [
  'subject_definitions:',
  '<Subject 1> is Lin Mu referenced from <Picture 1>: a swordsman.',
  'detailed_description: [Shot 1] The swordsman blocks a sword.',
  'The initial draft omitted the second shot and incorrectly translated the spoken words.',
  `全文候选尾段：${'UNTOUCHED_ENGLISH_DRAFT '.repeat(1200)}TAIL_OF_COMPLETE_DRAFT`,
].join('\n');
for (const reviewedName of ['林沐', 'Lin Mu']) {
  const reviewedEnglish = [
    'subject_definitions:',
    `<Subject 1> is ${reviewedName} referenced from <Picture 1>: a male swordsman.`,
    '<Subject 2> is 小师姐 referenced from <Picture 2>: a cultivator in cyan robes.',
    'summary: A sparring exchange on the practice ground.',
    'retention_analysis: <Subject 1> and <Subject 2> fully_preserved.',
    'detailed_description:',
    `[Shot 1] <Subject 1> blocks <Subject 2>'s blade. At 1 second, ${reviewedName} says 「师姐，接招。」`,
    '[Shot 2] At 00:05.000, <Subject 2> lowers her sword, then 小师姐 says 「再来一次。」 at 1 second.',
    'overall_soundscape: A brief clash of blades.',
    'non_diegetic_music: N/A',
  ].join('\n');
  const aiRequests: Array<{ system: string; user: string }> = [];
  const progressCalls: number[] = [];
  const aiResult = await translateVideoPromptToEnglish({
    sourcePrompt: aiSource,
    reviewWithAi: true,
    isCurrent: () => true,
    onReview: () => progressCalls.push(aiRequests.length),
    clean: () => { throw new Error('AI-reviewed text must not pass through a local content cleaner'); },
    request: async (system, user) => {
      aiRequests.push({ system, user });
      return aiRequests.length === 1 ? aiCandidate : reviewedEnglish;
    },
  });
  assert.equal(aiRequests.length, 2, 'the model, not a regex, must receive a separate review/repair call');
  assert.deepEqual(progressCalls, [1], 'review progress is reported between translation and actual review');
  assert.equal(aiRequests[0].system, `${VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT}\n\n${H3_CLIP_TIME_RULE}\n本次只返回完整提示词正文，不返回JSON。\n\n${h3DescriptionLanguageRule('英文')}`);
  assertH3DescriptionLanguage(aiRequests[0].system, '英文');
  assert.equal(aiRequests[0].user, aiSource, 'translation must receive every original character, name and dialogue');
  assert.match(aiRequests[0].user, /林沐说：“师姐，接招。”/u);
  assert.doesNotMatch(aiRequests[0].user, /__LH_/u, 'live requests must not hide names or dialogue in placeholders');
  assert.equal(aiRequests[1].system, `${VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT}\n本次只返回完整提示词正文，不返回JSON。\n\n${h3DescriptionLanguageRule('英文')}`);
  assertH3DescriptionLanguage(aiRequests[1].system, '英文');
  assert.ok(aiRequests[1].system.includes(H3_FINAL_BODY_FORMAT_RULE), 'H3 English review receives the final-body format contract');
  const reviewData = JSON.parse(aiRequests[1].user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
  assert.deepEqual(reviewData, { sourcePrompt: aiSource, candidateEnglishPrompt: aiCandidate },
    'the second API request must contain the full unmasked source and untouched first AI result, without a character cap');
  assert.match(reviewData.sourcePrompt, /TAIL_OF_COMPLETE_SOURCE$/u);
  assert.match(reviewData.candidateEnglishPrompt, /TAIL_OF_COMPLETE_DRAFT$/u);
  assert.match(aiRequests[1].system, /主体与姓名、身份与指代、动作及因果、摄影与运镜、时间戳与切点、字段顺序、镜头数量/u);
  assert.match(aiRequests[1].system, /逐句核对全部对白的原字、原语言、说话人、顺序、所属镜头与相对时刻/u);
  assert.match(aiRequests[1].system, /在本次回复中自行修复并再次对照完整原稿校验/u);
  assert.ok(aiRequests.every((call) => call.system.includes(AUDIO_TRANSLATION_SCOPE_RULE)));
  assert.ok(aiRequests.every((call) => !call.system.includes(AUDIO_PROMPT_RULE)));
  assert.equal(aiResult, reviewedEnglish, 'the AI-authored reviewed body is accepted exactly, even if name counts or transliteration differ');
  assert.match(aiResult, /「师姐，接招。」/u, 'dialogue is authored by the reviewing API, not restored from local tokens');
}

// Identity metadata is not permission to speak. These mocked regressions
// exercise the existing two-call translation/review boundary, not a local
// speech classifier or name-removal pass.
const silentIdentitySource = [
  'integrated_multimodal_description:',
  '[Shot 1] 第10段，15秒。<Picture 1>决定尾帧构图，<Picture 2>为林沐，<Picture 3>为祈凌霜，<Picture 4>为叶清碧；后三张只锁定人物身份。三人安静地互相看一眼，保留自然微笑。台词：无；从0秒到15秒结束均无讲话、无旁白、无说话口型。',
  'overall_soundscape: 无。',
  'non_diegetic_music: N/A',
].join('\n');
const silentIdentityFinal = [
  'integrated_multimodal_description:',
  '[Shot 1] Segment 10 lasts 15 seconds. <Picture 1> fixes the tail-frame composition; <Picture 2> identifies 林沐, <Picture 3> identifies 祈凌霜, and <Picture 4> identifies 叶清碧. The latter three images fix visual identities only, not spoken words. All three exchange a quiet glance and smile naturally. From 0s through the end at 15s, no one speaks, calls names, murmurs or narrates; there is no speech articulation, including in the final seconds.',
  'overall_soundscape: None.',
  'non_diegetic_music: N/A',
].join('\n');
const silentIdentityCandidate = silentIdentityFinal.replace(
  'From 0s through the end at 15s, no one speaks, calls names, murmurs or narrates; there is no speech articulation, including in the final seconds.',
  'Dialogue: none. At 13s a voice calls <d>[Chinese] 林沐，祈凌霜，叶清碧。</d> as all three move their lips.',
);
const authoredNameSource = [
  'subject_definitions:',
  '<Subject 1> is 林沐 referenced from <Picture 1>: 男性同伴。',
  '<Subject 2> is 祈凌霜 referenced from <Picture 2>: 女性同伴。',
  'summary: 祈凌霜叫住林沐。',
  'retention_analysis: <Subject 1> and <Subject 2> fully_preserved.',
  'detailed_description:',
  '[Shot 1] 15秒。第2s祈凌霜(S1)喊<d>[Chinese] 林沐！</d>，林沐停步听她，不代说；此句之后两人不再说话。',
  'overall_soundscape: 只有这句原话和原定停步声。',
  'non_diegetic_music: N/A',
].join('\n');
const authoredNameFinal = [
  'subject_definitions:',
  '<Subject 1> is 林沐 referenced from <Picture 1>: a male companion.',
  '<Subject 2> is 祈凌霜 referenced from <Picture 2>: a female companion.',
  'summary: 祈凌霜 calls 林沐 to stop.',
  'retention_analysis: <Subject 1> and <Subject 2> fully_preserved.',
  'detailed_description:',
  '[Shot 1] The shot lasts 15 seconds. At 2s 祈凌霜 (S1) calls <d>[Chinese] 林沐！</d>; 林沐 stops and listens without speaking or mouthing her words. Neither speaks again after this authored line.',
  'overall_soundscape: Only the authored call and the planned stopping footstep.',
  'non_diegetic_music: N/A',
].join('\n');
const nonverbalSource = [
  'integrated_multimodal_description:',
  '[Shot 1] 15秒。林沐听见叶清碧在第2s短促轻笑；祈凌霜在第4s轻咳一声，三人随后自然微笑。台词：无，0到15秒无说话、无旁白；保留笑与咳嗽的非说话口部动作，不冻结表情。',
  'overall_soundscape: 第2s轻笑，第4s轻咳，除此之外无声。',
  'non_diegetic_music: N/A',
].join('\n');
const nonverbalFinal = [
  'integrated_multimodal_description:',
  '[Shot 1] The shot lasts 15 seconds. 林沐 hears 叶清碧 give a brief soft laugh at 2s; 祈凌霜 gives a light cough at 4s, and all three then smile naturally. There is no speech or narration from 0s through 15s. Keep the natural non-speaking mouth movements of the laugh, cough and smiles; expressions are not frozen.',
  'overall_soundscape: The brief laugh at 2s and cough at 4s only; no speech.',
  'non_diegetic_music: N/A',
].join('\n');
const mixedSpeechSource = [
  'integrated_multimodal_description:',
  '[Shot 1] 第1s祈凌霜(S1)说<d>[Chinese] 等我一下。</d>，林沐只点头倾听。',
  '[Shot 2] At 00:07.000, 林沐与祈凌霜站定，叶清碧自然微笑；本镜台词：无，从7秒切入到15秒结束三人均不说话、无旁白、无说话口型。',
  'overall_soundscape: 只保留首镜第1s原话，第二镜无声。',
  'non_diegetic_music: N/A',
].join('\n');
const mixedSpeechFinal = [
  'integrated_multimodal_description:',
  '[Shot 1] At 1s 祈凌霜 (S1) says <d>[Chinese] 等我一下。</d>; 林沐 only nods and listens.',
  '[Shot 2] At 00:07.000, 林沐 and 祈凌霜 stand still as 叶清碧 smiles naturally. This shot has no dialogue: from its start at 7s through the segment end at 15s, no one speaks or narrates and no one articulates speech.',
  'overall_soundscape: Only the authored line at 1s in the first shot; no sound in the second shot.',
  'non_diegetic_music: N/A',
].join('\n');
for (const scenario of [
  { label: 'three silent visual identities are not spoken at the end', source: silentIdentitySource, candidate: silentIdentityCandidate, final: silentIdentityFinal },
  { label: 'authored name-calling remains verbatim with its original speaker', source: authoredNameSource, candidate: authoredNameFinal.replace('<d>[Chinese] 林沐！</d>', '<d>[English] Lin Mu!</d>'), final: authoredNameFinal },
  { label: 'no-dialogue does not mute nonverbal sounds or freeze faces', source: nonverbalSource, candidate: nonverbalFinal.replace('The brief laugh at 2s and cough at 4s only; no speech.', 'Mute the entire audio track and keep every mouth permanently shut.'), final: nonverbalFinal },
  { label: 'a silent later shot does not erase the first shot dialogue', source: mixedSpeechSource, candidate: mixedSpeechFinal.replace('<d>[Chinese] 等我一下。</d>', 'nothing; all shots are silent'), final: mixedSpeechFinal },
]) {
  const calls: Array<{ system: string; user: string }> = [];
  const stagingContext = {
    characterProfiles: [
      { name: '林沐', role: '仅作为人物资料；不是可说词句' },
      { name: '祈凌霜', role: '仅作为人物资料；不是可说词句' },
      { name: '叶清碧', role: '仅作为人物资料；不是可说词句' },
    ],
  };
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: scenario.source, reviewWithAi: true, stagingContext,
    clean: () => { throw new Error('speech-scope repair must remain AI-authored, without name deletion or local cleanup'); },
    request: async (system, user) => {
      calls.push({ system, user });
      assert.equal(system.split(DIALOGUE_DELIVERY_RULE).length - 1, 1,
        'existing translation and review each carry the shared contract once');
      assert.ok(system.includes(VISUAL_IDENTITY_SPEECH_SCOPE_RULE));
      assert.ok(system.includes(NO_DIALOGUE_PERFORMANCE_RULE));
      assert.match(system, /不弱化成murmur\/chatter、含混交谈或自由说话/u);
      if (calls.length === 1) {
        assert.equal(user, scenario.source, 'the complete unmasked source is sent to AI');
        return scenario.candidate;
      }
      assert.equal(calls.length, 2, 'there is no newly added review or retry for speech semantics');
      const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
      assert.equal(data.sourcePrompt, scenario.source);
      assert.equal(data.candidateEnglishPrompt, scenario.candidate,
        'even a mistaken spoken-name list is delivered intact to the existing AI reviewer');
      assert.deepEqual(data.stagingContext, stagingContext, 'identity metadata remains available without becoming dialogue');
      return scenario.final;
    },
  });
  assert.equal(calls.length, 2, scenario.label);
  assert.equal(result, scenario.final, 'only the complete AI-reviewed output is returned; no local semantic edits');
  assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(scenario.source),
    'both H3 structures preserve sections, reference tags, shot count and cut points');
}
assert.ok(silentIdentityFinal.includes('林沐') && silentIdentityFinal.includes('祈凌霜') && silentIdentityFinal.includes('叶清碧'));
assert.doesNotMatch(silentIdentityFinal, /<d>/u, 'silent identity metadata does not need a dialogue tag');
assert.ok(authoredNameFinal.includes('祈凌霜 (S1) calls <d>[Chinese] 林沐！</d>'));
assert.ok(nonverbalFinal.includes('brief laugh at 2s and cough at 4s'));
assert.ok(mixedSpeechFinal.includes('<d>[Chinese] 等我一下。</d>'));
for (const system of [VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT, VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT, VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT]) {
  assert.ok(system.includes(VISUAL_IDENTITY_SPEECH_SCOPE_RULE));
  assert.ok(system.includes(NO_DIALOGUE_PERFORMANCE_RULE));
}

// Ordinary six-field prompts still use the generic review contract; the H3
// final-body rule is scoped to sources that already carry official H3 syntax.
{
  const systems: string[] = [];
  const ordinary = '【0s-1s】主体：林沐。动作：抬手。';
  const reviewed = await translateVideoPromptToEnglish({
    sourcePrompt: ordinary,
    reviewWithAi: true,
    clean: (value) => value,
    request: async (system) => {
      systems.push(system);
      return systems.length === 1 ? 'Lin Mu raises his hand.' : 'Lin Mu raises his hand.';
    },
  });
  assert.equal(reviewed, 'Lin Mu raises his hand.');
  assert.equal(systems.length, 2);
  assert.equal(systems[1].includes(H3_FINAL_BODY_FORMAT_RULE), false,
    'ordinary six-field review does not receive the H3 section-writing contract');
}

// Direct translation callers receive the same wardrobe-scope contract as
// singleSegmentPrompt, including a same-API H3 protocol-repair request.
{
  const wardrobeSource = [
    'integrated_multimodal_description: [Shot 1] 两位成年同伴已按剧情换上绿色外套，在门口短暂亲吻；林舟隔着外套扶住林澜手臂，衣着与遮挡保持。',
    'overall_soundscape: N/A',
    'non_diegetic_music: N/A',
  ].join('\n');
  const stagingContext = {
    segmentScope: { segmentIndex: 3, savedSegmentSourceStoryContent: '两人已经换上绿色外套后走到门口。' },
    savedContinuityEvidence: { entryState: '绿色外套，衣扣系好', exitState: '绿色外套仍完整' },
    ordinaryOutfitBaseline: '更早的人物资料记载蓝色外套；不覆盖已发生的换装',
  };
  const delivered = [
    'integrated_multimodal_description: [Shot 1] The two adults, already wearing the green coats from the story, briefly kiss at the doorway. Lin Zhou holds Lin Lan by the arm over the coat; both coats stay closed.',
    'overall_soundscape: N/A',
    'non_diegetic_music: N/A',
  ].join('\n');
  let requests = 0;
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: wardrobeSource, stagingContext, reviewWithAi: true,
    clean: () => { throw new Error('wardrobe repair must remain AI-authored'); },
    request: async (system, user) => {
      requests += 1;
      assert.equal(system.split(VIDEO_WARDROBE_SCOPE_RULE).length - 1, 1, 'every translation/review/format repair carries the scope contract once');
      if (requests === 1) {
        assert.equal(user, wardrobeSource);
        assert.match(system, /原文明示的换装也不能被人物资料的旧 outfit 覆盖/u);
        return 'A candidate with the wrong coat color.';
      }
      if (requests === 2) {
        const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
        assert.equal(data.sourcePrompt, wardrobeSource);
        assert.deepEqual(data.stagingContext, stagingContext);
        return 'The two adults remain in their green coats, but this reply accidentally omitted the H3 scaffold.';
      }
      const data = JSON.parse(user.match(/<h3_format_repair_data>\n([\s\S]+)\n<\/h3_format_repair_data>/u)![1]);
      assert.equal(data.sourceContext.sourcePrompt, wardrobeSource);
      assert.deepEqual(data.sourceContext.stagingContext, stagingContext);
      return delivered;
    },
  });
  assert.equal(requests, 3);
  assert.equal(result, delivered, 'the same AI provides the final wardrobe wording and H3 structure without local edits');
  for (const system of [VIDEO_PROMPT_ENGLISH_TRANSLATION_SYSTEM_PROMPT, VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT, VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT]) {
    assert.ok(system.includes(VIDEO_WARDROBE_SCOPE_RULE), 'legacy and live entry points keep the same wardrobe fidelity rule');
  }
}

// A direct caller's H3 repair must retain the confirmed spatial mapping too;
// it does not have generateSingleSegmentPrompt's request wrapper to add it.
{
  const spatialSource = [
    'subject_definitions:',
    '<Subject 1> is 沈衡 referenced from <Picture 1>: 成年同伴，灰外套。',
    '<Subject 2> is 陆青 referenced from <Picture 2>: 成年同伴，绿外套。',
    '<Subject 3> is 顾白 referenced from <Picture 3>: 成年同伴，白外套。',
    'summary: 三人坐在北墙前，陆青把木盒递给沈衡。',
    'retention_analysis: <Subject 1>, <Subject 2>, <Subject 3> fully_preserved.',
    'detailed_description:',
    '[Shot 1] 三人面朝南；摄影机在南侧朝北，顾白在画面左，沈衡在画面中，陆青在画面右。陆青在沈衡自身左侧，用陆青右手将木盒递向沈衡左手；沈衡(S1)说<d>[Chinese] 谢谢。</d>，另两人安静倾听。',
    '[Shot 2] At 00:07.000, 同一南侧机位收紧到沈衡与陆青；沈衡在画面左，陆青在画面右。顾白仍在原西侧座位，位于画外左侧，没有进入这幅近景；沈衡左手接稳木盒。',
    'overall_soundscape: N/A',
    'non_diegetic_music: N/A',
  ].join('\n');
  const finalEnglish = [
    'subject_definitions:',
    '<Subject 1> is 沈衡 referenced from <Picture 1>: an adult companion in a grey coat.',
    '<Subject 2> is 陆青 referenced from <Picture 2>: an adult companion in a green coat.',
    '<Subject 3> is 顾白 referenced from <Picture 3>: an adult companion in a white coat.',
    'summary: Three companions sit before the north wall as 陆青 passes a wooden box to 沈衡.',
    'retention_analysis: <Subject 1>, <Subject 2>, <Subject 3> fully_preserved.',
    'detailed_description:',
    '[Shot 1] All three face south; the camera looks north from the south side. 顾白 is screen-left, 沈衡 center and 陆青 screen-right. 陆青 sits on 沈衡\'s own left and extends the box with 陆青\'s right hand toward 沈衡\'s left hand. 沈衡 (S1) says <d>[Chinese] 谢谢。</d> while the other two listen silently.',
    '[Shot 2] At 00:07.000, The same south-side viewpoint tightens onto 沈衡 at screen-left and 陆青 at screen-right. 顾白 remains in the original western seat, off-screen left, and is not added to this close view. 沈衡 receives the box with 沈衡\'s left hand.',
    'overall_soundscape: N/A',
    'non_diegetic_music: N/A',
  ].join('\n');
  const mistakenCandidate = finalEnglish
    .replace('on 沈衡\'s own left', 'at screen-left')
    .replace('off-screen left, and is not added to this close view', 'visible at the left edge of this close view');
  const proseOnlyReview = finalEnglish.slice(finalEnglish.indexOf('[Shot 1]'), finalEnglish.indexOf('overall_soundscape:')).trim();
  let requests = 0;
  const translated = await translateVideoPromptToEnglish({
    sourcePrompt: spatialSource, reviewWithAi: true,
    stagingContext: { originalPlan: '旧草稿把陆青写在画面左，顾白写在近景边缘；只作旧证据。' },
    clean: () => { throw new Error('spatial repair must remain AI-authored'); },
    request: async (system, user) => {
      requests += 1;
      assertH3DescriptionLanguage(system, '英文');
      assert.equal(system.split(VIDEO_ACTING_CAMERA_TRANSLATION_RULE).length - 1, 1);
      assert.equal(system.split(SPATIAL_TRANSLATION_RULE).length - 1, 1,
        'translation, review and standalone format retry all carry complete spatial fidelity');
      assert.equal(system.includes(SPATIAL_COORDINATE_RULE), false,
        'English stages cannot independently select positions or cameras');
      if (requests === 1) {
        assert.equal(user, spatialSource);
        return mistakenCandidate;
      }
      if (requests === 2) {
        const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
        assert.equal(data.sourcePrompt, spatialSource);
        assert.equal(data.candidateEnglishPrompt, mistakenCandidate,
          'ambiguous own-side wording and an extra visible person reach AI unmodified');
        return proseOnlyReview;
      }
      assert.equal(requests, 3, 'only the existing H3 format retry is needed');
      const data = JSON.parse(user.match(/<h3_format_repair_data>\n([\s\S]+)\n<\/h3_format_repair_data>/u)![1]);
      assert.equal(data.sourceContext.sourcePrompt, spatialSource);
      assert.equal(data.candidatePrompt, proseOnlyReview);
      return finalEnglish;
    },
  });
  assert.equal(requests, 3);
  assert.equal(translated, finalEnglish, 'the repaired model body is delivered without local side replacement');
  assert.deepEqual(readH3PromptProtocol(translated), readH3PromptProtocol(spatialSource),
    'sections, Subject/Picture identities, Shot markers and At cuts remain unchanged');
  assert.ok(translated.includes("on 沈衡's own left"));
  assert.ok(translated.includes('陆青 screen-right'));
  assert.ok(translated.includes('off-screen left'));
  assert.ok(translated.includes('<d>[Chinese] 谢谢。</d>'));
}

let emptyDraftCalls = 0;
assert.equal(await translateVideoPromptToEnglish({
  sourcePrompt: '林沐抬手。', reviewWithAi: true, clean: (value) => value,
  request: async (_system, user) => {
    emptyDraftCalls += 1;
    if (emptyDraftCalls === 1) return '';
    const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
    assert.equal(data.candidateEnglishPrompt, '');
    assert.equal(data.sourcePrompt, '林沐抬手。');
    return 'Lin Mu raises his hand.';
  },
}), 'Lin Mu raises his hand.', 'an empty candidate can be repaired by the AI from the source, never by local synthesis');
assert.equal(emptyDraftCalls, 2);

for (const finalResponse of ['', ' \n\t ']) {
  let aiCalls = 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: '林沐抬手。', reviewWithAi: true, clean: (value) => value,
    request: async () => ++aiCalls === 1 ? 'Lin Mu raises his hand.' : finalResponse,
  }), /AI 校验与修复返回空内容/u, 'a final empty transport result must not overwrite saved output');
  assert.equal(aiCalls, 2);
}

for (const failAt of [1, 2]) {
  for (const failure of [new Error('text API network failed'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    let aiCalls = 0;
    await assert.rejects(translateVideoPromptToEnglish({
      sourcePrompt: aiSource, reviewWithAi: true, clean: (value) => value,
      request: async () => { aiCalls += 1; if (aiCalls === failAt) throw failure; return aiCandidate; },
    }), (error: unknown) => error === failure, 'API failures must propagate, never fallback to unreviewed text');
    assert.equal(aiCalls, failAt, 'API errors and cancellation cannot trigger extra paid calls');
  }
}

for (const staleAt of ['initial', 'translation', 'review-callback', 'review-response'] as const) {
  let current = staleAt !== 'initial';
  let aiCalls = 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: aiSource, reviewWithAi: true, clean: (value) => value,
    isCurrent: () => current,
    onReview: () => { if (staleAt === 'review-callback') current = false; },
    request: async () => {
      aiCalls += 1;
      if (staleAt === 'translation' || (staleAt === 'review-response' && aiCalls === 2)) current = false;
      return aiCandidate;
    },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(aiCalls, staleAt === 'initial' ? 0 : staleAt === 'review-response' ? 2 : 1,
    'a changed project, reference or segment stops before another request or accepting stale output');
}

let sourceTokenCalls = 0;
assert.equal(await translateVideoPromptToEnglish({
  sourcePrompt: '林沐抬手。旧稿：__LH_ENTITY_001__', reviewWithAi: true, clean: (value) => value,
  request: async (_system, user) => {
    sourceTokenCalls += 1;
    if (sourceTokenCalls === 1) assert.match(user, /__LH_ENTITY_001__/u);
    return 'Lin Mu raises his hand.';
  },
}), 'Lin Mu raises his hand.', 'even legacy-source defects are left visible for AI repair, not intercepted locally');
assert.equal(sourceTokenCalls, 2);

// Exercise the real configured transport boundary, not only a helper stub.
// No external network or user credentials are used by this integration check.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const transportCalls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
const transportConfig: TextApiConfig = {
  enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://configured-text-model.example.test/v1/chat/completions',
  apiKey: 'test-translation-only-key', model: 'configured-translation-model',
  temperature: 0.2, maxTokens: 32000, vision: false,
};
const transportCandidate = 'Lin Mu raises his hand and says, “Try again.”';
const transportFinal = '林沐 raises his hand and says, “再来一次。”';
try {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, writable: true,
    value: { lianhuaDesktop: {
      request: async (payload: { url: string; headers?: Record<string, string>; body?: string }) => {
        transportCalls.push(payload);
        const body = JSON.parse(payload.body || '{}');
        assert.equal(payload.url, transportConfig.baseUrl);
        assert.equal(payload.headers?.Authorization, `Bearer ${transportConfig.apiKey}`);
        assert.equal(body.model, transportConfig.model);
        assert.equal(body.max_tokens, transportConfig.maxTokens);
        assert.equal(body.temperature, transportConfig.temperature);
        const user = body.messages.find((message: { role: string }) => message.role === 'user').content;
        if (transportCalls.length === 1) assert.equal(user, '林沐抬手说：“再来一次。”');
        else {
          const data = JSON.parse(user.match(/<review_data>\n([\s\S]+)\n<\/review_data>/u)![1]);
          assert.equal(data.sourcePrompt, '林沐抬手说：“再来一次。”');
          assert.equal(data.candidateEnglishPrompt, transportCandidate);
        }
        return { status: 200, body: JSON.stringify({ choices: [{ message: {
          content: transportCalls.length === 1 ? transportCandidate : transportFinal,
        } }] }) };
      },
    } },
  });
  const result = await translateVideoPromptToEnglish({
    sourcePrompt: '林沐抬手说：“再来一次。”', reviewWithAi: true, clean: (value) => value,
    request: (system, user) => requestTextModel(transportConfig, system, user),
  });
  assert.equal(transportCalls.length, 2, 'translation and repair both traverse the configured API transport');
  assert.equal(result, transportFinal, 'only the reviewing API output is accepted');
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

console.log('prompt translation and same-API review/repair tests passed');
