import assert from 'node:assert/strict';
import {
  cleanSeedancePrompt,
  compileOfficialSeedancePrompt,
  isSeedanceOutputSaveIdentityCurrent,
  SEEDANCE_ENGLISH_TRANSLATION_RULE,
  translateSeedancePromptToEnglish,
} from '../src/seedancePrompt';

const base = {
  canonicalPrompt: '【0s-8s】主体：林霜；动作：从石桥走向河岸；镜头：摄影机缓慢后退。\n【8s-30s】主体：林霜；动作：停下并看向河面；声音：保留原对白。',
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'seedance-2.5',
  references: [
    { id: 'char-1', name: '林霜', mediaType: 'image', referenceRole: 'character', responsibility: '人物外观、服装和发型' },
    { id: 'scene-1', name: '石桥', mediaType: 'image', referenceRole: 'scene', responsibility: '桥面、河岸和清晨薄雾空间' },
    { id: 'audio-1', name: '环境声', mediaType: 'audio', referenceRole: 'audio', responsibility: '河水与远处风声' },
  ],
  constraints: ['保持人物服装和场景光线连续。'],
} as const;

const saveIdentity = {
  projectId: 'project-a',
  workspaceEpoch: 4,
  chapterId: 'chapter-a',
  storyboardId: 'storyboard-a',
  storyboardUpdatedAt: 123,
};
assert.equal(
  isSeedanceOutputSaveIdentityCurrent(saveIdentity, { ...saveIdentity }),
  true,
  'an unchanged project/chapter/workspace/storyboard accepts an async result',
);
for (const [field, value] of Object.entries({
  projectId: 'project-b',
  workspaceEpoch: 5,
  chapterId: 'chapter-b',
  storyboardId: 'storyboard-b',
  storyboardUpdatedAt: 124,
} as const)) {
  assert.equal(
    isSeedanceOutputSaveIdentityCurrent(saveIdentity, { ...saveIdentity, [field]: value }),
    false,
    `${field} changes must reject a stale async result`,
  );
}

const defaultResult = compileOfficialSeedancePrompt({ ...base, durationSec: 30 });
assert.equal(defaultResult.targetId, 'seedance-2.5');
assert.equal(defaultResult.durationSec, 30);
assert.equal(defaultResult.prompt, defaultResult.promptZh);
assert.match(defaultResult.promptZh, /@Image 1/u);
assert.match(defaultResult.promptZh, /@Audio 1/u);
assert.match(defaultResult.promptZh, /连续时间轴/u);
assert.doesNotMatch(defaultResult.promptZh, /integrated_multimodal_description|\[Shot\s+\d+\]|<Picture\s+\d+>/iu);

const customResult = compileOfficialSeedancePrompt({ ...base, durationSec: 120 });
assert.equal(customResult.durationSec, 120);
assert.match(customResult.promptZh, /0–120 秒/u);
assert.ok(customResult.warnings.some((warning) => warning.includes('不截断')));
assert.notEqual(defaultResult.sourceFingerprint, customResult.sourceFingerprint);

const h3InputResult = compileOfficialSeedancePrompt({
  ...base,
  durationSec: 60,
  canonicalPrompt: 'integrated_multimodal_description: [Shot 1] <Picture 1> 林霜走过石桥。',
});
assert.doesNotMatch(h3InputResult.promptZh, /integrated_multimodal_description|\[Shot\s+\d+\]|<Picture\s+\d+>/iu);
assert.ok(h3InputResult.warnings.some((warning) => warning.includes('H3')));

const dialogue = '别急，我在这里。';
const bilingualResult = compileOfficialSeedancePrompt({
  ...base,
  durationSec: 30,
  canonicalPrompt: `【0s-8s】主体：@林霜；动作：从石桥走向河岸；镜头：摄影机缓慢后退。\n【8s-30s】主体：@林霜；动作：停下并看向河面；原对白：“${dialogue}”`,
  references: [
    ...base.references,
    { id: 'video-1', name: '运镜参考', mediaType: 'video', responsibility: '缓慢后退的镜头速度' },
    { id: 'clay-1', name: '布局参考', mediaType: 'clay-render', responsibility: '石桥和河岸的空间关系' },
  ],
});
const originalChinese = bilingualResult.promptZh;
const englishFixture = [
  'Video specification: duration 30 seconds; aspect ratio 16:9; resolution 2K; audio mode stereo.',
  '',
  'References and responsibilities:',
  '@Image 1: 林霜 (character appearance, clothing and hairstyle)',
  '@Image 2: Stone bridge (bridge deck, riverbank and morning mist)',
  '@Audio 1: Ambient sound (river water and distant wind)',
  '@Video 1: Camera reference (the speed of the slow backward camera movement)',
  '@Clay Render 1: Layout reference (the spatial relationship between the stone bridge and the riverbank)',
  '',
  'One-sentence summary:',
  '【0s-8s】Subject: @林霜; Action: walks from the stone bridge toward the riverbank; Camera: slowly tracks backward.',
  '',
  'Continuous timeline (covering 0–30 seconds):',
  '【0s-8s】Subject: @林霜; Action: walks from the stone bridge toward the riverbank; Camera: slowly tracks backward.',
  `【8s-30s】Subject: @林霜; Action: stops and looks toward the river; Original dialogue: “${dialogue}”`,
  '',
  'Global constraints:',
  '- Keep the character clothing and scene lighting continuous.',
].join('\n');

let translationCalls = 0;
const promptEn = await translateSeedancePromptToEnglish({
  sourcePrompt: originalChinese,
  request: async (system, user) => {
    translationCalls += 1;
    assert.ok(system.includes(SEEDANCE_ENGLISH_TRANSLATION_RULE));
    assert.match(system, /章节标题翻译为英文，不删除开头内容/u);
    assert.match(system, /对白.*原语言/u);
    assert.match(user, /视频规格：时长 30 秒/u, 'the full specification must reach translation before the first timeline row');
    assert.match(user, /参考素材与职责/u);
    assert.match(user, /__LH_DIALOGUE_001__/u);
    assert.ok(!user.includes(dialogue), 'the existing dialogue protection must also apply to Seedance');
    return `\`\`\`text\n${englishFixture}\n\`\`\``;
  },
});
assert.equal(translationCalls, 1, 'on-demand English requires one translation request');
assert.equal(promptEn, englishFixture, 'cleaning must retain the specification and references before the timeline');
assert.match(promptEn, /^Video specification:/u);
assert.match(promptEn, /References and responsibilities:/u);
assert.deepEqual(promptEn.match(/@(?:Image|Audio|Video|Clay Render) \d+/gu), [
  '@Image 1', '@Image 2', '@Audio 1', '@Video 1', '@Clay Render 1',
]);
assert.ok(promptEn.includes(`“${dialogue}”`), 'English descriptions must preserve the actual Chinese dialogue');
assert.equal(bilingualResult.promptZh, originalChinese, 'English generation must leave the stored Chinese source untouched');
assert.equal(bilingualResult.prompt, originalChinese);
assert.equal(bilingualResult.promptEn, undefined, 'the compiler must not replace Chinese with the separately returned English');
assert.notEqual(promptEn, bilingualResult.promptZh);
assert.doesNotMatch(promptEn, /__LH_|integrated_multimodal_description|\[Shot\s+\d+\]/u);
assert.equal(cleanSeedancePrompt(`\uFEFF\`\`\`markdown\n${englishFixture}\n\`\`\``), englishFixture);

for (const [originalToken, changedToken] of [
  ['@Image 1', '@Image 99'],
  ['@Audio 1', '@Audio 2'],
  ['@Video 1', '@Video 5'],
  ['@Clay Render 1', '@Clay Render 4'],
]) {
  await assert.rejects(translateSeedancePromptToEnglish({
    sourcePrompt: originalChinese,
    request: async () => englishFixture.replace(originalToken, changedToken),
  }), /Seedance.*参考素材编号/u, `${originalToken} must not silently change during English translation`);
}
await assert.rejects(translateSeedancePromptToEnglish({
  sourcePrompt: originalChinese,
  request: async () => englishFixture.replace(dialogue, 'Do not worry, I am here.'),
}), /原语言对白/u, 'translating descriptions must not translate dialogue without authorization');
assert.equal(bilingualResult.promptZh, originalChinese, 'translation failure must preserve the Chinese result for retry');

console.log('seedance prompt checks passed');
