import assert from 'node:assert/strict';
import { missingCanonicalDialogues, missingStoryDialogues, normalizeCanonicalDialogueQuotes } from '../src/dialogueCoverage';
import { canonicalDialogueFieldRange, canonicalDialogueField } from '../src/masterTimeline';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { getPromptDialogues, isDialogueLanguagePreserved } from '../src/promptDialogueLanguage';
import type { Storyboard, VideoShot } from '../src/types';

const help = '我需要您的帮助。';
const reply = '不必惊慌，我已经向你的方向派出了增援，他们伤不到你。';
const source = `西娅：“${help}”母巢：“${reply}”`;
const shot = (dialogue: string, index = 0) => `【${index * 5}s-${(index + 1) * 5}s】 主体：@西娅（紧张）[朝向：通讯器] 正在 [握住通讯器→停步回应]（推进求助）；空间：墙上写着“台词：不是对白；音效：不是节点” 中景-西娅；光影：自然光；镜头：中景固定；台词：${dialogue}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
const bare = [shot(`第1s @西娅：${help}`), shot(`第0.3s @母巢：${reply}`, 1)].join('\n');
const quoted = [shot(`第1s @西娅：“${help}”`), shot(`第0.3s @母巢：“${reply}”`, 1)].join('\n');
assert.equal(normalizeCanonicalDialogueQuotes(bare), quoted);
assert.equal(normalizeCanonicalDialogueQuotes(quoted), quoted, 'already quoted speech must remain byte-for-byte unchanged');
assert.equal(normalizeCanonicalDialogueQuotes(shot('无（本镜只有脚步声）')), shot('无（本镜只有脚步声）'), 'an absence note must not be wrapped as newly spoken dialogue');
assert.equal(normalizeCanonicalDialogueQuotes(shot('第1s @西娅：无。')), shot('第1s @西娅：“无。”'), 'the literal authored word none remains spoken when a speaker is supplied');
assert.equal(normalizeCanonicalDialogueQuotes(normalizeCanonicalDialogueQuotes(bare)), quoted, 'quote protection is idempotent');
const mixed = shot(`第1s @西娅：“${help}” | 第2.2s @母巢（以“安抚”语气）：${reply}`);
assert.equal(normalizeCanonicalDialogueQuotes(mixed), shot(`第1s @西娅：“${help}” | 第2.2s @母巢（以“安抚”语气）：“${reply}”`), 'speaker notes and pipe separator stay outside the newly quoted utterance');
const adjacentPipe = shot(`第1s @西娅：${help}|第2s @母巢：${reply}`);
assert.equal(normalizeCanonicalDialogueQuotes(adjacentPipe), shot(`第1s @西娅：“${help}”|第2s @母巢：“${reply}”`));
const widePipe = shot(`第1s @西娅：${help}｜第2s @母巢：${reply}`);
assert.equal(normalizeCanonicalDialogueQuotes(widePipe), shot(`第1s @西娅：“${help}”｜第2s @母巢：“${reply}”`));
const firstAnnotated = normalizeCanonicalDialogueQuotes(shot(`第1s @母巢（以‘安抚’语气）：${reply}`));
assert.deepEqual(getPromptDialogues(firstAnnotated).map((line) => line.content), [reply], 'even the first cue’s quoted note is not itself dialogue');
const explicitlyEnglish = normalizeCanonicalDialogueQuotes(shot('第1s @母巢（用英语说，以“安抚”语气）：欢迎回来。'));
assert.equal(getPromptDialogues(explicitlyEnglish)[0]?.translateToEnglish, true);
const explicitlyNotEnglish = normalizeCanonicalDialogueQuotes(shot(`第1s @母巢（不要英文对白，以“安抚”语气）：${reply}`));
assert.equal(getPromptDialogues(explicitlyNotEnglish)[0]?.translateToEnglish, false);
const fieldRange = canonicalDialogueFieldRange(bare.split('\n')[0])!;
const quotedRange = canonicalDialogueFieldRange(quoted.split('\n')[0])!;
assert.equal(bare.split('\n')[0].slice(0, fieldRange.start), quoted.split('\n')[0].slice(0, quotedRange.start));
assert.equal(bare.split('\n')[0].slice(fieldRange.end), quoted.split('\n')[0].slice(quotedRange.end), 'literal fake field names in a sign cannot redirect the replacement');
assert.equal(normalizeCanonicalDialogueQuotes(shot('无')), shot('无'), 'no speech must not create an utterance');
const authoredNone = shot('第1s @西娅：“无。”');
assert.deepEqual(missingStoryDialogues('西娅：“无。”', authoredNone), [], 'the actually spoken word 无 is not a silence marker');
const nestedBare = shot('第1s @西娅：母巢说“请回来”，我记住了。');
const nestedQuoted = normalizeCanonicalDialogueQuotes(nestedBare);
assert.equal(canonicalDialogueField(nestedQuoted), '第1s @西娅：「母巢说“请回来”，我记住了。」', 'a fresh outer quote pair protects all authored words without escaping nested quotations');
assert.deepEqual(missingCanonicalDialogues(bare, quoted), []);
assert.deepEqual(missingStoryDialogues(source, quoted), []);

// Exercise the normal canonical → official H3 → English description pipeline.
// The mock translates every unprotected Chinese character it receives. The
// two original Chinese utterances must never be offered to it as descriptions.
const shots: VideoShot[] = [0, 1].map((index) => ({ id: `bare-speech-${index}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5, subject: '西娅', action: '握住通讯器并停步回应', purpose: '推进求助', camera: '中景固定', transition: '自然承接', lighting: '自然光', sound: '', result: '保持联系', referenceAssetIds: [], prompt: quoted.split('\n')[index], locked: false }));
const board: Storyboard = { id: 'bare-speech-board', sceneId: 'scene', sourceStoryContent: source, workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots, finalPrompt: normalizeCanonicalDialogueQuotes(bare), targetModelId: 'minimax-h3', createdAt: 1, updatedAt: 1 };
const official = applyOfficialH3Prompt(board, { assets: [], characters: [] });
assert.ok(official.officialPromptZh?.includes(help));
assert.ok(official.officialPromptZh?.includes(reply));
let calls = 0;
const english = await translateVideoPromptToEnglish({ sourcePrompt: official.officialPromptZh!, clean: (text) => text.trim(), request: async (_system, text) => {
  calls += 1;
  assert.ok(text.includes('__LH_DIALOGUE_'), 'ordinary translation must receive dialogue protection tokens');
  assert.ok(!text.includes(help) && !text.includes(reply), 'bare Chinese speech is protected before the English request');
  return text.replace(/[\p{Script=Han}]+/gu, ' translated ');
} });
assert.equal(calls, 1);
assert.ok(english.includes(help) && english.includes(reply));
assert.equal(isDialogueLanguagePreserved(official.officialPromptZh!, english), true);
const normalizedMixed = normalizeCanonicalDialogueQuotes(mixed);
const annotationOfficial = applyOfficialH3Prompt({ ...board, durationSec: 5, durationPreset: '5s', shotCount: 1, shots: [{ ...shots[0], prompt: normalizedMixed }], finalPrompt: normalizedMixed }, { assets: [], characters: [] });
assert.deepEqual(getPromptDialogues(annotationOfficial.officialPromptZh!).map((line) => line.content), [help, reply], 'a quote inside the current speaker annotation must not hide that speaker’s actual utterance');
let annotationCalls = 0;
const annotatedEnglish = await translateVideoPromptToEnglish({ sourcePrompt: annotationOfficial.officialPromptZh!, clean: (text) => text.trim(), request: async (_system, text) => {
  annotationCalls += 1;
  assert.ok(!text.includes(help) && !text.includes(reply), 'both original utterances must be protected despite a quoted delivery note');
  return text.replace(/[\p{Script=Han}]+/gu, ' translated ');
} });
assert.equal(annotationCalls, 1);
assert.ok(annotatedEnglish.includes(help) && annotatedEnglish.includes(reply));
assert.ok(!annotatedEnglish.includes('安抚'), 'delivery annotations remain translatable descriptions, not protected spoken words');
assert.equal(isDialogueLanguagePreserved(annotationOfficial.officialPromptZh!, annotatedEnglish), true);
console.log('dialogueQuoteProtection: add-only canonical quoting, mixed/pipe/notes preservation and normal H3→English original Chinese dialogue protection passed');
