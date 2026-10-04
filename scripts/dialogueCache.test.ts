import assert from 'node:assert/strict';
import {
  buildOfficialH3SourceFingerprint,
  getOfficialH3SubmissionIssue,
  hasCurrentOfficialH3EnglishPrompt,
  hasCurrentOfficialH3Prompt,
  type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import type { Storyboard } from '../src/types';

const context: OfficialH3ProjectContext = { assets: [] };

// Model a saved, current official artifact directly: these checks concern the
// English cache, not conversion, network translation or project persistence.
const makeSavedBoard = (sourcePrompt: string, englishPrompt: string): Storyboard => {
  const board: Storyboard = {
    id: 'dialogue-cache-board',
    sceneId: 'dialogue-cache-scene',
    workflow: 'drama',
    inputMode: 'text',
    durationSec: 5,
    durationPreset: '5s',
    shotMode: 'exact',
    shotCount: 1,
    pace: 'standard',
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'stereo',
    stylePresetId: 'style-cinema',
    ruleSetId: 'rule-default',
    converterPresetId: 'converter-default',
    globalLock: '',
    shots: [],
    finalPrompt: sourcePrompt,
    targetModelId: 'minimax-h3',
    targetOutput: {
      targetId: 'minimax-h3',
      prompt: sourcePrompt,
      parameters: {},
      referenceManifest: [],
      warnings: [],
      generatedAt: 1,
    },
    officialPromptZh: sourcePrompt,
    officialPromptEn: englishPrompt,
    officialPromptEnSource: sourcePrompt,
    createdAt: 1,
    updatedAt: 1,
  };
  board.officialPromptSource = buildOfficialH3SourceFingerprint(board, context);
  return board;
};

const originalDialogue = '……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！';
const secondDialogue = '全速前进！';
const sourcePrompt = [
  'integrated_multimodal_description:',
  `[Shot 1] 人物将对讲机贴近嘴边；声音：环境层-[无] 动作层-[第1.3秒起边缘划水原对白：“${originalDialogue}”]；镜头：近景。`,
  `[Shot 2] At 00:03.000, 车队向前加速；声音：环境层-[无] 动作层-[第1秒起原对白：“${secondDialogue}”]；镜头：中景。`,
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n\n');
const preservedEnglish = [
  'integrated_multimodal_description:',
  `[Shot 1] The character brings the radio close to the mouth; Sound: ambience-[none] action-[from 1.3s 边缘划水 original dialogue in Mandarin Chinese: "${originalDialogue}"]; Shot: close-up.`,
  `[Shot 2] At 00:03.000, The convoy accelerates forward; Sound: ambience-[none] action-[from 1s original dialogue in Mandarin Chinese: "${secondDialogue}"]; Shot: medium shot.`,
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n\n');
const translatedEnglish = preservedEnglish
  .replace(originalDialogue, 'The Storm Corps is under attack by the tide, and our spring water buddy has been cornered by the slime mold!')
  .replace(secondDialogue, 'Full speed ahead!')
  .replaceAll('in Mandarin Chinese', 'in English');

const modelEnglish = makeSavedBoard(sourcePrompt, translatedEnglish);
const savedSnapshot = JSON.stringify(modelEnglish);
assert.equal(hasCurrentOfficialH3EnglishPrompt(modelEnglish, context), true,
  'a current nonempty AI-authored English result must not be excluded by local dialogue-language interpretation');
assert.equal(hasCurrentOfficialH3EnglishPrompt(modelEnglish), true,
  'the lightweight cache check also relies on source identity rather than semantic quality');
assert.equal(hasCurrentOfficialH3Prompt(modelEnglish, context), true,
  'English wording does not change the current Chinese artifact');
assert.equal(getOfficialH3SubmissionIssue({ model: 'minimax-h3', prompt: sourcePrompt }, modelEnglish, context), undefined,
  'Chinese video submission remains independently available');
assert.equal(JSON.stringify(modelEnglish), savedSnapshot,
  'cache validation must not rewrite the persisted board, source fingerprint, or Chinese prompt');
assert.match(modelEnglish.officialPromptSource || '', /^official-h3-v7:/u,
  'removing semantic validation does not invalidate every existing Chinese fingerprint');

const correctEnglish = makeSavedBoard(sourcePrompt, preservedEnglish);
assert.equal(hasCurrentOfficialH3EnglishPrompt(correctEnglish, context), true,
  'English scene and camera prose with intact Chinese dialogue is a valid English derivative');
assert.equal(hasCurrentOfficialH3Prompt(correctEnglish, context), true);
const renamedSpeaker = makeSavedBoard(sourcePrompt, preservedEnglish.replace('边缘划水', 'Edge Drifter'));
assert.equal(hasCurrentOfficialH3EnglishPrompt(renamedSpeaker, context), true,
  'speaker wording in a saved AI result is not a local semantic cache gate');
for (const candidate of [
  sourcePrompt,
  preservedEnglish.replace(/"([^"\n]*)"/gu, '「$1」'),
  preservedEnglish.replace('from 1.3s', 'from 1.4s'),
]) {
  const board = makeSavedBoard(sourcePrompt, candidate);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(board, context), true,
    'mixed-language text, quote style and readable timing prose do not turn a current source into a stale cache');
  assert.equal(board.officialPromptEn, candidate, 'cache checks do not rewrite accepted model text');
}
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...correctEnglish, officialPromptEnSource: 'an older source' }, context), false,
  'dialogue preservation must not bypass the existing source identity check');
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...correctEnglish, officialPromptSource: 'old-compiler' }, context), false,
  'dialogue preservation must not bypass current Chinese validation');

const integrated = (body: string): string => `integrated_multimodal_description: [Shot 1] ${body}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`;
const sourceEnglishDialogue = integrated('队长抬起手，用英语说：“Hold your fire!”；镜头：中景。');
const englishDialogueBoard = makeSavedBoard(sourceEnglishDialogue,
  integrated('The captain raises a hand and says in English: "Hold your fire!"; Shot: medium shot.'));
assert.equal(hasCurrentOfficialH3EnglishPrompt(englishDialogueBoard, context), true,
  'dialogue that was already explicitly English must remain English');

const noDialogueBoard = makeSavedBoard(
  integrated('车队驶过大桥；声音：环境层-[无] 动作层-[第0.5秒引擎加速声]；台词：无；镜头：远景。'),
  integrated('The convoy crosses the bridge; Sound: ambience-[none] action-[at 0.5s engine acceleration]; Dialogue: none; Shot: wide shot.'),
);
assert.equal(hasCurrentOfficialH3EnglishPrompt(noDialogueBoard, context), true,
  'a scene without spoken dialogue must retain ordinary English cache behavior');
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...noDialogueBoard, officialPromptEn: '  ' }, context), false,
  'empty English remains invalid');

const longDescription = 'The convoy crosses the ruined bridge while debris falls behind it. '.repeat(1000);
const oversizedEnglish = preservedEnglish.replace('[Shot 1] ', `[Shot 1] ${longDescription}\n`);
assert.ok(oversizedEnglish.length > 25000);
const oversizedBoard = makeSavedBoard(sourcePrompt, oversizedEnglish);
assert.equal(hasCurrentOfficialH3EnglishPrompt(oversizedBoard, context), true,
  'dialogue-language validation must not reintroduce any local English character limit');
assert.equal(oversizedBoard.officialPromptEn, oversizedEnglish,
  'cache checks must preserve complete oversized English output');

console.log('dialogue-language cache checks passed');
