import assert from 'node:assert/strict';
import { buildShots, extractSourceDialogues, renderFinalPrompt } from '../src/promptEngine';
import { defaultConverterPresets, defaultRuleSets, defaultStylePresets } from '../src/storage';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import type { Character, Scene, Storyboard } from '../src/types';

const character = (name: string): Character => ({ id: name, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] });
const make = (story: string, action: string, subject: string, names: string[] = ['西娅'], modelDialogue?: string) => {
  const characters = names.map(character);
  const scene: Scene = { id: 'speaker-regression', title: '回应', content: story, summary: '', characterIds: names, locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
  const sourceExcerpt = story.includes(action) ? action : '';
  // Existing cases exercise the legacy/local dialogue parser. buildShots is
  // only a convenient complete fixture factory here; new AI shots instead
  // declare their own speaker/time in dialogue and bypass that local parser.
  const shots = buildShots({ scene, characters, locations: [], props: [], assets: [], workflow: 'drama', durationSec: 5, shotMode: 'exact', shotCount: 1, pace: 'standard', camera: '', lighting: '', style: defaultStylePresets[0], extra: '', aiPlan: { shots: [{ startSec: 0, endSec: 5, sourceExcerpt, purpose: '回应', subject, action, camera: '中景', lighting: '柔光', transition: '', sound: '无配乐', result: '回应结束', ...(modelDialogue !== undefined ? { dialogue: modelDialogue } : {}) }] } })
    .map((shot) => modelDialogue === undefined ? { ...shot, authoredBy: undefined } : shot);
  const finalPrompt = renderFinalPrompt({ scene, characters, locations: [], props: [], durationSec: 5, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'drama', inputMode: 'text', globalLock: '', shots, assets: [], style: defaultStylePresets[0], ruleSet: defaultRuleSets[0], converter: defaultConverterPresets[0], extra: '' });
  const board: Storyboard = { id: 'speaker-board', sceneId: scene.id, sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: defaultStylePresets[0].id, ruleSetId: defaultRuleSets[0].id, converterPresetId: defaultConverterPresets[0].id, globalLock: '', shots, finalPrompt, createdAt: 1, updatedAt: 1 };
  return { shots, finalPrompt, official: applyOfficialH3Prompt(board, { assets: [], characters, locations: [], props: [], sceneContent: story }) };
};
const speaker = (prompt: string) => prompt.match(/台词：第[\d.]+s @([^：]+)：/)?.[1];
const reply = '不必惊慌，我已经向你的方向派出了增援，他们伤不到你。';
const action = `祂短暂的思索后，用和蔼的声音回答道。“${reply}”`;
const story = `西娅朝市中心的母巢呼唤：“我需要您的帮助。”市中心的母巢看向她。${action}`;

for (const names of [[], ['西娅'], ['西娅', '母巢']]) {
  const result = make(story, action, '母巢', names);
  assert.equal(result.shots[0].subject, '母巢');
  assert.equal(speaker(result.finalPrompt), '母巢', 'speaker attribution cannot depend on whether the established mother entity has a character-library entry');
  assert.ok(result.finalPrompt.includes(`@母巢："${reply}"`));
  assert.ok(result.official.officialPromptZh!.includes(`@母巢："${reply}"`), 'the correct speaker and original words reach final H3');
  assert.doesNotMatch(result.official.officialPromptZh!, /@西娅："不必惊慌/u);
  assert.equal(result.shots[0].startSec, 0); assert.equal(result.shots[0].endSec, 5);
}

for (const manner of ['用和蔼的声音', '以温柔的口吻', '用平静的语气', '低声']) {
  const implicit = extractSourceDialogues(`${manner}回答道：“别怕。”`);
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].speakerCandidate, '', 'delivery instructions are not actor names');
  const explicit = extractSourceDialogues(`母巢${manner}回答道：“别怕。”`);
  assert.equal(explicit[0].speakerCandidate, '母巢');
  assert.equal(explicit[0].text, '别怕。');
}

// A reaction shot can focus on the listener while an established off-screen speaker answers.
const reaction = make(story, action, '西娅');
assert.match(reaction.finalPrompt, /主体：@西娅/u);
assert.equal(speaker(reaction.finalPrompt), '母巢', 'a pronoun antecedent may differ from the visible shot subject');
const explicitOffscreenAction = '西娅望向通讯器。母巢（画外）：“Keep  still.”';
const explicitOffscreen = make(explicitOffscreenAction, explicitOffscreenAction, '西娅');
assert.equal(explicitOffscreen.shots[0].subject, '西娅');
assert.equal(speaker(explicitOffscreen.finalPrompt), '母巢');
assert.ok(explicitOffscreen.finalPrompt.includes('"Keep  still."'), 'explicit off-screen English wording and its internal spaces are preserved');

// Mentioning the mother as an object must not steal the following “她” from 西娅.
const childAction = '她低声回答道：“我会等着。”';
const childStory = `西娅看向母巢。${childAction}`;
const child = make(childStory, childAction, '母巢');
assert.equal(speaker(child.finalPrompt), '西娅', 'the previous narrative actor, not the nearest object or visual subject, owns the pronoun reply');
const explicitDifferent = make('阿青说道：“别回头。”西娅抬眼望向窗外。', '阿青说道：“别回头。”', '西娅', ['西娅']);
assert.equal(speaker(explicitDifferent.finalPrompt), '阿青', 'an explicit speaker absent from the library still outranks the shot subject');

// Model-authored shots are not silently reparsed through the legacy tests
// above: the AI's explicit off-screen speaker and timing pass through intact.
const modelDialogue = `第1.7s @母巢："${reply}"`;
const modelAuthored = make(story, action, '西娅', [], modelDialogue);
assert.equal(modelAuthored.shots[0].authoredBy, 'text-api');
assert.equal(modelAuthored.shots[0].action, action);
assert.equal(modelAuthored.shots[0].dialogue, modelDialogue);
assert.equal(speaker(modelAuthored.finalPrompt), '母巢');
assert.ok(modelAuthored.finalPrompt.includes(`台词：${modelDialogue}`), 'AI timing cannot be replaced by a local estimated speaking window');
assert.ok(modelAuthored.official.officialPromptZh!.includes(modelDialogue), 'model-owned speaker and time reach H3 unchanged');

console.log('dialogue speaker ownership: missing library, source manners, pronouns, reaction/off-screen voices, original wording/language and H3 propagation passed');
