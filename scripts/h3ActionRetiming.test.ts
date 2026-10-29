import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt, renderDeliveredH3Performance, savedH3TranslationFacts } from '../src/singleSegmentPrompt';
import { applyAiAuthoredOfficialH3Prompt } from '../src/officialPrompt';
import { serializeAuthoredH3Prompt } from '../src/h3DeliverySections';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { H3IdentityBindings, H3PerformancePlan, Storyboard, VideoShot } from '../src/types';

// Synthetic offline responses only. No application state or external API.
const actions = ['甲颔首回礼并抬手起势。', '甲虚晃同时横移，乙跟随转身。', '甲连续三拳、低扫两次，乙逐次格挡避让并持续按肩至甲下沉后脱开。'];
const englishActions = ['甲 nods and raises the hands into a ready position.', '甲 feints while moving sideways; 乙 turns to follow.', '甲 throws three punches and sweeps low twice; 乙 blocks and evades each attack, then maintains shoulder pressure until 甲 lowers and breaks free.'];
const soundscape = '脚步、格挡与衣料声随对应动作发生和结束，间隙安静。';
const canonical = (cuts: number[]) => actions.map((action, index) => `【${cuts[index]}s-${cuts[index + 1]}s】主体：@甲与乙，正在 [${action}]；空间：石台；光影：日光；镜头：侧面中景；台词：无；音效：脚步与格挡同期声。`).join('\n');
const beforeCanonical = canonical([0, 5, 10, 15]);
const afterCanonical = canonical([0, 1.5, 4, 15]);
const baseline: Storyboard = {
  id: 'retiming-board', sceneId: 'scene', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s',
  shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: 'style', ruleSetId: 'rule', converterPresetId: 'converter', globalLock: '', globalReferenceAssetIds: [],
  sourceStoryTitle: '动作测试', sourceStoryContent: actions.join(''), finalPrompt: beforeCanonical,
  shots: actions.map((action, index) => ({ id: `shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
    action, subject: '甲与乙', purpose: '原动作', camera: '侧面中景', transition: '', lighting: '日光', sound: '同期声', result: '',
    referenceAssetIds: [], sourceBeatIds: [`event-${index + 1}`], sourceExcerpt: action, prompt: beforeCanonical.split('\n')[index], locked: false })),
  promptPlan: { canonicalPrompt: beforeCanonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    workflow: 'drama', inputMode: 'text', shotIds: ['shot-1', 'shot-2', 'shot-3'], referenceAssetIds: [], constraints: [], trace: {} },
  promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(beforeCanonical), generatedAt: 1 },
  createdAt: 1, updatedAt: 1,
} as Storyboard;
const context = { assets: [], characters: [] };
const knownBindings: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'a', name: '甲', referenceAnchor: '人物身份：甲，黑衣。' },
  { characterId: 'b', name: '乙', referenceAnchor: '人物身份：乙，白衣。' },
] };
const performance: H3PerformancePlan = { version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
  characters: [{ characterId: 'a', visualDescription: '黑衣。' }, { characterId: 'b', visualDescription: '白衣。' }],
  shots: [0, 1.5, 4].map((startSec, index) => ({ shotIndex: index + 1, startSec, visualDescription: '石台上的侧面中景。',
    events: [{ eventId: `event-${index + 1}`, kind: 'visual', description: actions[index], startSec: [0, 1.5, 4][index],
      endSec: [1.1, 3.6, 14.8][index], silentCharacterIds: ['a', 'b'] }] })),
  overallSoundscape: soundscape, nonDiegeticMusic: 'N/A',
};
const legacy = `[Shot 1] ${knownBindings.characters.map((entry) => entry.referenceAnchor).join(' ')} ${actions.join('')} 甲说<d>[Chinese] 请继续。</d>`;

const authoredDoorDialogue = '第1.1s–2.1s @玉小刚（成年男性，低而稳，画外，隔门，听者：小舞）：“进来。”';
const canonicalDialogueShot: VideoShot = { ...baseline.shots[0], subject: '玉小刚', dialogue: authoredDoorDialogue,
  prompt: `【0s-5s】主体：@玉小刚，正在 [站在门后]；空间：门内；光影：昏暗；镜头：固定中景；台词：${authoredDoorDialogue}；音效：门外轻敲。` };
const dialogueFallback = renderDeliveredH3Performance({ h3Prompt: 'integrated_multimodal_description:\n[Shot 1] 玉小刚的声音从门后传来。\n\noverall_soundscape:\n门外敲门声。\n\nnon_diegetic_music:\nN/A', envelope: true },
  'integrated', {}, [canonicalDialogueShot]);
assert.ok(dialogueFallback.h3Prompt.includes('<d>[Chinese] 进来。</d>'), 'canonical six-field dialogue is serialized when performance is absent');
assert.match(dialogueFallback.h3Prompt, /From 1\.10 to 2\.10 seconds of this clip, 玉小刚 \(S1\).*成年男性，低而稳，画外，隔门，听者：小舞.*says: <d>\[Chinese\] 进来。<\/d>/u);
assert.deepEqual(savedH3TranslationFacts(undefined, [canonicalDialogueShot]).sourceDialogues.map((entry) => entry.text), ['进来。'],
  'English translation receives the exact original-language words from canonical shots');
const sidecarDialogueFallback = renderDeliveredH3Performance({ h3Prompt: 'integrated_multimodal_description:\n[Shot 1] 玉小刚站在门后。\n\noverall_soundscape:\n门外敲门声。\n\nnon_diegetic_music:\nN/A',
  envelope: true, identityBindings: { ...knownBindings, performance: { version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'door-speaker', name: '玉小刚', visualDescription: '成年男性。' }],
    shots: [{ shotIndex: 1, startSec: 0, visualDescription: '玉小刚站在门后。', events: [
      { eventId: 'door-action', kind: 'visual', description: '门外有人敲门。', startSec: 0, endSec: 1 },
    ] }], overallSoundscape: '门外敲门声。', nonDiegeticMusic: 'N/A' } } },
  'integrated', {}, [canonicalDialogueShot]);
assert.match(sidecarDialogueFallback.h3Prompt, /玉小刚 \(S1\).*成年男性，低而稳，画外，隔门，听者：小舞.*says: <d>\[Chinese\] 进来。<\/d>/u,
  'canonical dialogue is retained when an existing performance sidecar omits the speech event');
const repeatedDialogueShot: VideoShot = { ...canonicalDialogueShot, startSec: 5,
  dialogue: '第1.1s–2.1s @玉小刚（成年男性，低而稳，画外，隔门，听者：小舞）：“进来。”；第3.1s–4.1s @玉小刚（成年男性，低而稳，画外，隔门，听者：小舞）：“进来。”' };
const repeatedDialogueBindings: H3IdentityBindings = { version: 1,
  characters: [{ characterId: 'door-speaker', name: '玉小刚', referenceAnchor: '声音身份：玉小刚。' }],
  performance: { version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'door-speaker', name: '玉小刚', visualDescription: '成年男性。' }],
    shots: [{ shotIndex: 1, startSec: 5, visualDescription: '玉小刚站在门后。', events: [
      { eventId: 'door-speech-1', dialogueId: 'door-dialogue-1', kind: 'speech', text: '进来。', language: 'Chinese',
        speakerCharacterIds: ['door-speaker'], channel: 'off-screen', startSec: 1.1, endSec: 2.1 },
    ] }], overallSoundscape: '门外敲门声。', nonDiegeticMusic: 'N/A' } };
const repeatedDialogueFacts = savedH3TranslationFacts(repeatedDialogueBindings, [repeatedDialogueShot]);
assert.deepEqual(repeatedDialogueFacts.sourceDialogues.map((entry) => entry.text), ['进来。', '进来。'],
  'translation facts retain repeated source speech that the performance sidecar omitted');
const repeatedDialogueDelivery = renderDeliveredH3Performance({ h3Prompt: '', envelope: true,
  identityBindings: repeatedDialogueBindings }, 'integrated', {}, [repeatedDialogueShot]);
assert.equal([...repeatedDialogueDelivery.h3Prompt.matchAll(/<d>\[Chinese\] 进来。<\/d>/gu)].length, 2,
  'H3 backfill retains the second occurrence of identical dialogue');
assert.match(repeatedDialogueDelivery.h3Prompt, /From 8\.10 to 9\.10 seconds of this clip/u,
  'shot-relative dialogue timing is converted to clip time from the canonical shot start');
const punctuationBindings = structuredClone(repeatedDialogueBindings);
punctuationBindings.performance!.shots[0].events = [{ eventId: 'door-speech-question', dialogueId: 'door-dialogue-question', kind: 'speech',
  text: '进来？', language: 'Chinese', speakerCharacterIds: ['door-speaker'], channel: 'off-screen', startSec: 6.1, endSec: 7.1 }];
assert.deepEqual(savedH3TranslationFacts(punctuationBindings, [{ ...repeatedDialogueShot,
  dialogue: '第1.1s–2.1s @玉小刚（成年男性，低而稳，画外，隔门，听者：小舞）：“进来！”' }]).sourceDialogues.map((entry) => entry.text),
['进来？', '进来！'], 'punctuation-distinct canonical dialogue is retained in translation facts');
const legacySubjectBindings: H3IdentityBindings = { version: 1,
  characters: [{ characterId: 'door-speaker', name: '玉小刚', referenceAnchor: '声音身份：玉小刚。' }],
  performance: { version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
    characters: [{ characterId: 'door-speaker', name: '玉小刚', visualDescription: '成年男性。' }],
    shots: [{ shotIndex: 1, startSec: 5, visualDescription: '玉小刚站在门后。', events: [
      { eventId: 'door-speech-legacy', dialogueId: 'door-dialogue-legacy', kind: 'speech', text: '进来。', language: 'Chinese',
        speakerCharacterIds: ['door-speaker'], channel: 'off-screen', startSec: 6.1, endSec: 7.1 },
    ] }], overallSoundscape: '门外敲门声。', nonDiegeticMusic: 'N/A' } };
assert.deepEqual(savedH3TranslationFacts(legacySubjectBindings, [{ ...repeatedDialogueShot, dialogue: '玉小刚：“进来。”' }])
  .sourceDialogues.map((entry) => entry.text), ['进来。'], 'legacy speaker fallback matches the shot subject against the performance sidecar');

const wrapped = renderDeliveredH3Performance({ h3Prompt: legacy, envelope: true, identityBindings: knownBindings }, 'integrated');
assert.ok(wrapped.h3Prompt.includes(legacy), 'a missing sidecar must preserve the entire authored body');
assert.equal(wrapped.identityBindings, knownBindings, 'formatting never reassigns character identities');
assert.match(wrapped.h3Prompt, /^integrated_multimodal_description:/u);
assert.match(wrapped.h3Prompt, /overall_soundscape:\n仅呈现上述镜头/u);
assert.match(wrapped.h3Prompt, /non_diegetic_music:\nN\/A$/u);
const referencedLegacy = renderDeliveredH3Performance({ h3Prompt: legacy, envelope: true, identityBindings: knownBindings }, 'full-reference');
assert.match(referencedLegacy.h3Prompt, /^subject_definitions:/u);
assert.ok(referencedLegacy.h3Prompt.includes(legacy));
assert.equal(referencedLegacy.identityBindings, knownBindings, 'an explicit full-reference source retains the same legacy identities');
const silent = serializeAuthoredH3Prompt(legacy, { audioMode: 'none' });
assert.match(silent, /overall_soundscape:\nN\/A/u);
const partialFull = `subject_definitions:\n<Subject 1>是甲，参考<Picture 1>。\ndetailed_description:\n${legacy}`;
const full = serializeAuthoredH3Prompt(partialFull, { mode: 'full-reference', preservedAudioPrompt: 'overall_soundscape: 风声仅在末镜出现\nnon_diegetic_music: 已确认的笛声，仅末镜' });
assert.ok(full.includes('<Subject 1>是甲，参考<Picture 1>。'));
assert.ok(full.includes(legacy));
assert.match(full, /non_diegetic_music:\n已确认的笛声，仅末镜$/u);
assert.equal(serializeAuthoredH3Prompt(full), full, 'complete saved fields are kept verbatim');

let legacyTranslationCalls = 0;
const translatedLegacy = await translateVideoPromptToEnglish({ promptFormat: 'h3', sourcePrompt: legacy, identityBindings: knownBindings,
  clean: (value) => value, request: async (_system, user) => { legacyTranslationCalls += 1; const data = JSON.parse(user);
    return JSON.stringify({ slots: data.slots.map((slot: { id: string; sourceText: string }) => ({ id: slot.id, text: slot.sourceText })) }); } });
assert.equal(legacyTranslationCalls, 1);
assert.match(translatedLegacy, /^integrated_multimodal_description:/u);
assert.match(translatedLegacy, /non_diegetic_music:\nN\/A$/u);
assert.ok(translatedLegacy.includes('<d>[Chinese] 请继续。</d>'));

for (const sequence of [false, true]) {
  const source = applyAiAuthoredOfficialH3Prompt({ ...structuredClone(baseline), ...(sequence ? {
    sequencePlanId: 'plan', segmentId: 'segment-2', segmentIndex: 2, segmentCount: 6, globalStartSec: 15, globalEndSec: 30,
  } : {}) }, serializeAuthoredH3Prompt(legacy), context, 2);
  source.h3IdentityBindings = structuredClone(knownBindings);
  const snapshot = JSON.stringify(source);
  const calls: string[] = [];
  const result = await generateSingleSegmentPrompt({ board: source, context, purpose: 'action-retiming', skipConversion: true,
    reviewWithAi: true, clean: (value) => value, request: async (system, user, stage) => {
      calls.push(stage);
      if (stage === 'review') {
        const data = JSON.parse(user.match(/<video_staging_review_data>\s*([\s\S]*?)\s*<\/video_staging_review_data>/u)![1]);
        assert.equal(data.revisionScope, 'current-segment-action-retiming');
        assert.equal(data.durationSec, 15);
        assert.deepEqual(data.retainedShotIds, ['shot-1', 'shot-2', 'shot-3']);
        assert.match(system, /允许既有镜界随动作节拍调整/u);
        assert.match(system, /不通过减少动作/u);
        return JSON.stringify({ canonicalPrompt: afterCanonical, h3Prompt: legacy,
          shotSourceIds: source.shots.map((shot) => [shot.id]), shotMetadata: [null, null, null],
          identityBindings: { ...knownBindings, performance } });
      }
      assert.equal(stage, 'translate', 'no converter or extra reviewer is called');
      const data = JSON.parse(user);
      return JSON.stringify({ slots: data.slots.map((slot: { id: string; sourceText: string }) => ({ id: slot.id,
        text: /\.events\.0\.description$/u.test(slot.id) ? englishActions[Number(slot.id.match(/shots\.(\d+)/u)![1])]
          : slot.id === 'performance.overallSoundscape' ? 'Only the existing synchronized footsteps, blocks and clothing sounds; quiet gaps.'
            : slot.sourceText === '黑衣。' ? 'Black clothes.' : slot.sourceText === '白衣。' ? 'White clothes.' : 'A side medium shot on the stone platform.',
      })) });
    } });
  assert.deepEqual(calls, ['review', 'translate'], 'exactly the two existing delivery calls');
  assert.equal(JSON.stringify(source), snapshot, 'saved input is not mutated');
  assert.equal(result.durationSec, 15);
  assert.equal(result.finalPrompt, afterCanonical);
  assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), [['shot-1', 0, 1.5], ['shot-2', 1.5, 4], ['shot-3', 4, 15]]);
  assert.deepEqual(result.shots.map((shot) => shot.sourceBeatIds), source.shots.map((shot) => shot.sourceBeatIds));
  actions.forEach((action) => assert.ok(result.officialPromptZh!.includes(action), `all actions remain: ${action}`));
  assert.match(result.officialPromptEn!, /three punches and sweeps low twice/u);
  assert.match(result.officialPromptZh!, /\[Shot 2\] At 00:01\.500/u);
  assert.match(result.officialPromptEn!, /\[Shot 2\] At 00:01\.500/u);
  assert.match(result.officialPromptZh!, /non_diegetic_music:\nN\/A$/u);
  assert.match(result.officialPromptEn!, /non_diegetic_music:\nN\/A$/u);
  assert.equal(result.sequencePlanId, source.sequencePlanId);
  assert.equal(result.globalStartSec, source.globalStartSec);
  let failures = 0;
  await assert.rejects(generateSingleSegmentPrompt({ board: source, context, purpose: 'action-retiming', skipConversion: true,
    reviewWithAi: true, clean: (value) => value, request: async () => { failures += 1; throw new Error('synthetic transport failure'); } }), /synthetic transport failure/u);
  assert.equal(failures, 1);
  assert.equal(JSON.stringify(source), snapshot, 'a failed retiming does not overwrite the saved input');
}
console.log('PASS H3 sections, legacy translation, standalone/sequence action retiming, preserved actions, nonuniform cuts and failure retention');
