import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt, renderDeliveredH3Performance, savedH3TranslationFacts } from '../src/singleSegmentPrompt';
import { readH3DeliveryEnvelope, normalizeH3IdentityBindings } from '../src/h3IdentityBindings';
import { hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } from '../src/officialPrompt';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import type { Character, ConverterPreset, H3IdentityBindings, H3PerformancePlan, Storyboard } from '../src/types';

// Offline synthetic fixtures. No user library, video provider or real model call.
const characters: Character[] = [['wolf', '贝里尤洛'], ['vampire', '夏提雅'], ['elf', '亚乌拉']].map(([id, name]) => ({
  id, name, gender: id === 'wolf' ? '男' : '女', apparentAge: '成年', race: '原有身份', appearance: '原有外貌',
  outfit: '原有服装', signatureProps: '', personality: '', motionHabits: '', anchor: name, negativeContinuity: '', assetIds: [],
}));
const narrative = '确认与龙僵持不下的矮人和戴着骷髅头盔的家伙不在';
const spoken = '是喔，你谁啊？';
const performance: H3PerformancePlan = { version: 1, timeBase: 'shot', descriptionLanguage: 'zh',
  characters: characters.map((person) => ({ characterId: person.id, visualDescription: person.outfit })),
  shots: [{ shotIndex: 1, startSec: 0, visualDescription: '三人在城门前对面站立，中景，日光。', events: [
    { kind: 'speech', eventId: 'e1', dialogueId: 'd1', speakerCharacterIds: ['wolf'], listenerCharacterIds: ['vampire', 'elf'],
      channel: 'on-screen', startSec: 3, endSec: 4.6, text: '让你们久等了。', language: 'Chinese' },
  ] }, { shotIndex: 2, startSec: 6.5, visualDescription: '中近景，沿用三人站位和日光。', events: [
    { kind: 'visual', eventId: 'observe', sourceFact: narrative, description: '贝里尤洛环视场地，随后看回红铠，眉头微锁。', silentCharacterIds: ['wolf'], soundDescription: '原定脚步声。' },
    { kind: 'speech', eventId: 'e2', dialogueId: 'd2', speakerCharacterIds: ['elf'], listenerCharacterIds: ['wolf'],
      channel: 'on-screen', startSec: 5, endSec: 6.6, text: spoken, language: 'Chinese',
      reactions: [{ characterId: 'wolf', description: '注视亚乌拉。', presence: 'visible' }, { characterId: 'vampire', description: '在旁观察。', presence: 'visible' }] },
  ] }], overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A' };
const identityBindings: H3IdentityBindings = { version: 1, characters: characters.map((person, index) => ({
  characterId: person.id, name: person.name, referenceAnchor: `Identity: ${person.name}, 原有服装。`,
  speakerToken: `(S${index + 1})`,
})), performance };
const oldBody = `integrated_multimodal_description: [Shot 1] Identity: 贝里尤洛, 原有服装。\n[Shot 2] At 00:06.500 ${narrative}。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const envelope = { h3Prompt: oldBody, identityBindings, characterParticipation: { version: 1, characters: [
  { characterId: 'wolf', name: '贝里尤洛', presence: 'visible', shotIndex: 2, evidence: narrative, speaking: false },
] } };
const delivery = readH3DeliveryEnvelope(JSON.stringify(envelope), { acceptAiAuthoredContent: true });
const rendered = renderDeliveredH3Performance(delivery, 'integrated');
assert.ok(!rendered.h3Prompt.includes(narrative), 'source-only cognition never becomes executable prose');
assert.ok(rendered.h3Prompt.includes('贝里尤洛环视场地'));
assert.ok(rendered.h3Prompt.includes('原定脚步声'));
assert.ok(rendered.h3Prompt.includes('11.50'));
assert.ok(rendered.h3Prompt.includes('13.10'));
assert.equal(rendered.identityBindings?.characters.find((person) => person.characterId === 'vampire')?.speakerToken, undefined);
assert.equal(rendered.identityBindings?.characters.find((person) => person.characterId === 'elf')?.speakerToken, '(S2)');
assert.equal(rendered.identityBindings?.performance?.shots[1].events[0].sourceFact, narrative);
assert.ok(rendered.h3Prompt.includes(rendered.characterParticipation!.characters[0].evidence));
assert.ok(!rendered.characterParticipation!.characters[0].evidence.includes(narrative));
assert.deepEqual(normalizeH3IdentityBindings(rendered.identityBindings), rendered.identityBindings);
assert.deepEqual(renderDeliveredH3Performance(rendered, 'integrated').identityBindings?.performance,
  rendered.identityBindings?.performance, 'normalization does not add the shot offset twice');
const legacy = readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: oldBody, identityBindings: { version: 1, characters: [] } }), { acceptAiAuthoredContent: true });
assert.equal(renderDeliveredH3Performance(legacy, 'integrated').h3Prompt, oldBody);
const malformedSidecar = readH3DeliveryEnvelope(JSON.stringify({ ...envelope, identityBindings: { version: 1, characters: [], performance: { old: true } } }), { acceptAiAuthoredContent: true });
assert.equal(renderDeliveredH3Performance(malformedSidecar, 'integrated').h3Prompt, oldBody, 'unreadable optional sidecar does not block old prose');
const referenceBindings: H3IdentityBindings = { ...identityBindings, characters: identityBindings.characters.map((entry, index) => ({
  ...entry, subjectToken: `<Subject ${index + 1}>`, referenceAnchor: `<Subject ${index + 1}> ${entry.name} ${entry.speakerToken}, <Picture ${index + 3}>${index === 0 ? ', <Audio 1>' : ''}, 原有服装。`,
})) };
const referenceDelivery = renderDeliveredH3Performance(readH3DeliveryEnvelope(JSON.stringify({
  h3Prompt: `subject_definitions:\n${referenceBindings.characters.map((entry) => entry.referenceAnchor).join('\n')}\n<Subject 9> is the gate, referenced from <Picture 1>.\nsummary: 三人在城门前交谈。\nretention_analysis: 保留城门与原有服装。\ndetailed_description: [Shot 1] 旧执行句。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`,
  identityBindings: referenceBindings,
}), { acceptAiAuthoredContent: true }), 'full-reference');
assert.ok(referenceDelivery.h3Prompt.includes('<Subject 9> is the gate, referenced from <Picture 1>.'));
assert.ok(referenceDelivery.h3Prompt.includes('<Audio 1>'));
assert.ok(referenceDelivery.identityBindings?.characters[2].referenceAnchor.includes('<Picture 5>'));
assert.ok(!referenceDelivery.h3Prompt.includes('夏提雅 (S2)'));
const narratorPlan: H3PerformancePlan = { ...structuredClone(performance),
  characters: [...performance.characters!, { characterId: 'narration-event', name: '原定旁白', presence: 'offscreen', visualDescription: '' }],
};
narratorPlan.shots[1].events.push({ kind: 'speech', eventId: 'narration-event', dialogueId: 'narration-dialogue',
  channel: 'voiceover', speakerCharacterIds: ['narration-event'], text: '原有旁白内容。', language: 'Chinese' });
const narratorEnvelope = readH3DeliveryEnvelope(JSON.stringify({
  h3Prompt: 'subject_definitions:\nVoice identity: 原定旁白 (S8), referenced from <Audio 2>.\n<Subject 9> is the gate, referenced from <Picture 1>.\nsummary: 保留原表演。\nretention_analysis: 保留场地。\ndetailed_description: [Shot 1] 原表演。\noverall_soundscape: N/A\nnon_diegetic_music: N/A',
  identityBindings: { ...identityBindings, performance: narratorPlan },
}), { acceptAiAuthoredContent: true });
const narratorDelivery = renderDeliveredH3Performance(narratorEnvelope, 'full-reference');
const narratorDefinitions = narratorDelivery.h3Prompt.split('\n\nsummary:')[0];
assert.equal((narratorDefinitions.match(/(?:Voice identity|声音身份): 原定旁白/gu) || []).length, 1,
  'the same declared voice-only source receives exactly one fresh definition');
assert.ok(narratorDefinitions.includes('<Audio 2>'), 'the declared voice reference survives fresh rendering');
assert.ok(!narratorDefinitions.includes('(S8)'), 'old voice token cannot survive in an extra definition');
const narratorRerendered = renderDeliveredH3Performance(narratorDelivery, 'full-reference');
assert.equal((narratorRerendered.h3Prompt.split('\n\nsummary:')[0].match(/(?:Voice identity|声音身份): 原定旁白/gu) || []).length, 1,
  'the Chinese generated voice-definition form is also replaced without duplication');
assert.ok(narratorRerendered.h3Prompt.includes('<Audio 2>'));

const canonical = '【0s-6.5s】主体：贝里尤洛；空间：城门；光影：日光；镜头：中景；台词：让你们久等了。；音效：脚步。\n'
  + '【6.5s-15s】主体：三人；空间：城门；光影：日光；镜头：中近景；台词：亚乌拉：是喔，你谁啊？；音效：脚步。';
const board: Storyboard = { id: 'performance-offline', sceneId: 'scene', workflow: 'drama', inputMode: 'text',
  sourceStoryContent: narrative, durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
  converterPresetId: 'converter', globalLock: '', globalReferenceAssetIds: [], finalPrompt: canonical,
  shots: [0, 1].map((index) => ({ id: `shot-${index}`, index: index + 1, startSec: index ? 6.5 : 0, endSec: index ? 15 : 6.5,
    subject: '三人', action: '交谈', camera: '中景', lighting: '日光', sound: '脚步', referenceAssetIds: [], locked: false,
    sourceExcerpt: narrative, prompt: canonical.split('\n')[index] })), createdAt: 1, updatedAt: 1 };
const converter: ConverterPreset = { id: 'converter', name: '测试', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true,
  version: 'test', systemPrompt: '保持源排程', outputRules: '普通六字段', updatedAt: 1 };
const calls: string[] = [];
const generated = await generateSingleSegmentPrompt({ board, context: { characters, assets: [] }, converter,
  reviewWithAi: true, clean: (text) => text,
  request: async (system, user, stage) => {
    calls.push(stage);
    if (stage === 'convert') { assert.ok(system.includes('原文依据、实际可见表演、真实声音')); return canonical; }
    if (stage === 'review') { assert.ok(system.includes('identityBindings内同时返回performance')); return JSON.stringify(envelope); }
    const data = JSON.parse(user);
    return JSON.stringify({ slots: data.slots.map((slot: { id: string; sourceText: string }) => ({ id: slot.id, text: slot.sourceText })) });
  },
});
assert.deepEqual(calls, ['convert', 'review', 'translate'], 'one existing call at each stage, no added audit or retry');
assert.equal(generated.officialPromptZh, rendered.h3Prompt);
assert.equal(hasCurrentOfficialH3Prompt(generated, { characters, assets: [] }), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(generated), true);
assert.ok(generated.h3IdentityBindingsEn?.performance);

const savedFacts = savedH3TranslationFacts(generated.h3IdentityBindings);
assert.equal(savedFacts.sourceDialogues.find((entry) => entry.id === 'd2')?.speakerCharacterId, 'elf');
assert.equal(savedFacts.sourceEvents.find((entry) => entry.id === 'observe')?.description, narrative);
let refreshCalls = 0;
const refreshed = await generateSingleSegmentPrompt({ board: generated, mode: 'translate-english', reviewWithAi: true,
  context: { characters: [{ ...characters[0], name: '不应读取的当前项目新姓名' }], assets: [] }, clean: (text) => text,
  request: async (_system, user, stage) => {
    refreshCalls++;
    assert.equal(stage, 'translate');
    assert.ok(!user.includes('不应读取的当前项目新姓名'));
    const data = JSON.parse(user);
    assert.ok(data.characters.some((person: { name: string }) => person.name === '亚乌拉'));
    assert.equal(data.performanceContext.shots[1].events[1].speakerCharacterIds[0], 'elf');
    return JSON.stringify({ slots: data.slots.map((slot: { id: string; sourceText: string }) => ({ id: slot.id, text: slot.sourceText })) });
  },
});
assert.equal(refreshCalls, 1);
assert.equal(refreshed.officialPromptZh, generated.officialPromptZh);
assert.equal(refreshed.officialPromptEnError, '');

const revision = createStoryboardRevision(refreshed, [], { id: 'performance-snapshot' });
const restored = restoreStoryboardRevisionSnapshot(refreshed, revision);
const state = createInitialState();
state.project = { ...state.project, id: 'offline-performance-project', storyboards: [restored] };
state.projects = [state.project]; state.activeProjectId = state.project.id;
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized)).project.storyboards[0];
assert.deepEqual(reloaded.h3IdentityBindings?.performance, refreshed.h3IdentityBindings?.performance);
assert.deepEqual(reloaded.h3IdentityBindingsEn?.performance, refreshed.h3IdentityBindingsEn?.performance);
assert.equal(reloaded.officialPromptZh, refreshed.officialPromptZh);
console.log('PASS H3 authored performance generation, old-body compatibility, saved-only refresh and storage/revision round trip');
