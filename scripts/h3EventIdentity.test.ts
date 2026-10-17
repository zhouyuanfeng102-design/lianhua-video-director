import assert from 'node:assert/strict';
import { inspectH3IdentityBindings } from '../src/h3DeliverySchema';
import { normalizeH3IdentityBindings, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { buildPromptTranslationDocument, renderPromptTranslationDocument } from '../src/promptTranslationDocument';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { createInitialState, normalizeState } from '../src/storage';
import type { H3IdentityBindings, Storyboard } from '../src/types';

const characters = [{ id: 'lin', name: '林沐' }, { id: 'ye', name: '叶清碧' }, { id: 'qi', name: '祈凌霜' }];
const action = '0.50—1.50秒，叶清碧从林沐自身左侧伸手，擦去他的左颊糖汁。';
const speech = '1.50—2.50秒，祈凌霜 (S3) 对叶清碧说：<d>[Chinese]师傅，擦得真仔细。</d>';
const sourcePrompt = [
  'integrated_multimodal_description:',
  '[Shot 1] Identity: 林沐 (S1), 青年男性。Identity: 叶清碧 (S2), 青年女性。Identity: 祈凌霜 (S3), 青年女性。',
  action, speech, 'overall_soundscape: N/A', 'non_diegetic_music: N/A',
].join('\n');
const identities: H3IdentityBindings = {
  version: 1,
  characters: characters.map((character, index) => ({ characterId: character.id, name: character.name,
    speakerToken: `(S${index + 1})`, referenceAnchor: `Identity: ${character.name} (S${index + 1}), 青年${index === 0 ? '男性' : '女性'}。` })),
  events: [
    { eventId: 'wipe', kind: 'action', referenceAnchor: action, actorCharacterId: 'ye', targetCharacterIds: ['lin'] },
    { eventId: 'tease', kind: 'dialogue', dialogueId: 'line-1', referenceAnchor: speech,
      speakerCharacterId: 'qi', listenerCharacterIds: ['ye'], addressedCharacterIds: ['ye'] },
  ],
};
const sourceSnapshot = JSON.stringify(identities);
const normalized = normalizeH3IdentityBindings(identities)!;
assert.deepEqual(normalized, identities);
assert.notEqual(normalized.events![0].targetCharacterIds, identities.events![0].targetCharacterIds);
assert.deepEqual(readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: sourcePrompt, identityBindings: identities }),
  { acceptAiAuthoredContent: true }).identityBindings, identities);
const unreadable = inspectH3IdentityBindings({ ...identities, events: [{ eventId: 'readable', actorCharacterId: 42,
  targetCharacterIds: [false], listenerCharacterIds: [] }, null, { speakerCharacterId: 'qi' }] });
assert.deepEqual(unreadable.issues, [], 'optional event fields add no new rejection condition');
assert.deepEqual(unreadable.value!.events, [{ eventId: 'readable', listenerCharacterIds: [] }]);
assert.equal(normalizeH3IdentityBindings({ ...identities, events: undefined })!.events, undefined, 'legacy absence stays absent');

const document = buildPromptTranslationDocument({ sourcePrompt, identityBindings: identities, sourceCharacters: characters });
assert.equal(document.events[0].actorCharacterId, 'ye');
assert.equal(document.utterances[0].speakerCharacterId, 'qi');
assert.deepEqual(document.utterances[0].listenerCharacterIds, ['ye']);
assert.deepEqual(document.utterances[0].addressedCharacterIds, ['ye']);
assert.ok(document.slots.some((slot) => slot.eventIds?.includes('wipe')));
assert.equal(document.events[0].speakerCharacterId, undefined, 'a visible actor is not assigned a voice');
assert.equal(document.events[1].actorCharacterId, undefined, 'the speaker does not become the action actor');
const translations = document.slots.map((slot) => ({ id: slot.id, text: slot.sourceText
  .replaceAll('从', 'from').replaceAll('自身左侧伸手，擦去他的左颊糖汁。', 'reaches from his left and wipes syrup from his left cheek.')
  .replaceAll('对', 'speaks to').replaceAll('说：', 'says:') }));
const translated = renderPromptTranslationDocument(document, { slots: translations,
  events: [{ eventId: 'wipe', actorCharacterId: 'qi', targetCharacterIds: ['ye'] }] });
for (const [index, binding] of translated.identityBindings!.events!.entries()) {
  const { referenceAnchor: _sourceAnchor, ...sourceRoles } = identities.events![index];
  const { referenceAnchor, ...resultRoles } = binding;
  assert.deepEqual(resultRoles, sourceRoles, 'model output cannot replace source role metadata');
  assert.ok(translated.prompt.includes(referenceAnchor!));
}
assert.ok(translated.prompt.includes('<d>[Chinese]师傅，擦得真仔细。</d>'));
assert.ok(translated.prompt.includes('0.50—1.50'));
assert.equal(JSON.stringify(identities), sourceSnapshot);

const unknownRoles = buildPromptTranslationDocument({ sourcePrompt: '[Shot 1] 他擦了擦她的脸。', identityBindings: {
  version: 1, characters: [], events: [{ eventId: 'unknown', referenceAnchor: '他擦了擦她的脸。' }],
} });
assert.equal(unknownRoles.events[0].actorCharacterId, undefined);
assert.equal(unknownRoles.events[0].targetCharacterIds, undefined, 'pronouns do not fabricate event identities');
const repeated = buildPromptTranslationDocument({ sourcePrompt: '[Shot 1] 他点头。他点头。', identityBindings: {
  version: 1, characters: [], events: [{ eventId: 'repeated', referenceAnchor: '他点头。', actorCharacterId: 'lin' }],
} });
assert.deepEqual(repeated.eventAnchors, [], 'repeated event excerpts are not guessed from proximity');

let calls = 0;
let delivered: H3IdentityBindings | undefined;
const result = await translateVideoPromptToEnglish({ sourcePrompt, identityBindings: identities, sourceCharacters: characters,
  acceptAiAuthoredContent: true, reviewWithAi: true,
  onIdentityBindings: (value) => { delivered = value; }, clean: () => { throw new Error('No whole-body cleanup'); },
  request: async (_system, user) => {
    calls += 1;
    const request = JSON.parse(user);
    assert.deepEqual(request.events, identities.events);
    assert.equal(request.utterances[0].speakerCharacterId, 'qi');
    return JSON.stringify({ slots: request.slots.map((slot: { id: string; sourceText: string }) => ({ id: slot.id, text: slot.sourceText })) });
  },
});
assert.equal(calls, 1, 'event-aware translation uses the same one request without review or retry');
assert.equal(result, sourcePrompt);
assert.deepEqual(delivered, identities);

const state = createInitialState();
const board: Storyboard = { id: 'events-board', sceneId: '', workflow: 'drama', inputMode: 'text', durationSec: 3,
  durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: sourcePrompt, shots: [],
  h3IdentityBindings: identities, h3IdentityBindingsEn: translated.identityBindings, createdAt: 1, updatedAt: 1,
};
state.project.storyboards = [board];
const restored = normalizeState(JSON.parse(JSON.stringify(state))).project.storyboards[0];
assert.deepEqual(restored.h3IdentityBindings, identities);
assert.deepEqual(restored.h3IdentityBindingsEn, translated.identityBindings);

console.log('h3EventIdentity: source action/speech roles, non-blocking metadata, slot translation and storage round trip passed.');
