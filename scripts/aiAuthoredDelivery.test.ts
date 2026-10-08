import assert from 'node:assert/strict';
import { createH3IdentityDeliveryReader, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import type { H3IdentityBindings, PromptCharacterParticipation } from '../src/types';

// Offline fixtures: no user project data and no external API requests.
const body = 'integrated_multimodal_description: [Shot5] 甲走近乙，抬手。\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
const bindings: H3IdentityBindings = { version: 1, characters: [{
  characterId: 'a', name: '甲', referenceAnchor: 'Identity: 甲穿着蓝衣。', speakerToken: '(S1)',
}] };
const participation: PromptCharacterParticipation = { version: 1, characters: [{
  characterId: 'a', name: '甲', presence: 'visible', shotIndex: 5, evidence: '甲走近乙, 抬手。',
}] };
const options = { acceptAiAuthoredContent: true };
let passed = 0;
const test = async (name: string, run: () => unknown | Promise<unknown>) => {
  await run(); passed += 1; console.log(`PASS ${name}`);
};

await test('AI text and typed metadata survive evidence/anchor differences and compact shot markers', () => {
  const read = createH3IdentityDeliveryReader(bindings, [{ id: 'a', name: '甲' }], { ...options, requireParticipation: true });
  const delivery = read(JSON.stringify({ h3Prompt: body, identityBindings: bindings, characterParticipation: participation }));
  assert.equal(delivery.h3Prompt, body);
  assert.deepEqual(delivery.identityBindings, bindings);
  assert.deepEqual(delivery.characterParticipation, participation);
  assert.equal(delivery.deliveryWarnings, undefined);
  assert.throws(() => readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: body, identityBindings: bindings })), /anchor-missing/u);
});

await test('missing auxiliary data is a warning and does not retain stale anchors', () => {
  const read = createH3IdentityDeliveryReader(bindings, undefined, { ...options, requireParticipation: true });
  const delivery = read(body);
  assert.equal(delivery.h3Prompt, body);
  assert.equal(delivery.identityBindings, undefined);
  assert.equal(delivery.characterParticipation, undefined);
  assert.equal(delivery.deliveryWarnings?.length, 2);
});

await test('unreadable individual auxiliary records do not discard other readable records', () => {
  const delivery = readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: body, canonicalPrompt: {},
    identityBindings: { version: 1, characters: [bindings.characters[0], { characterId: 'b' }] },
    characterParticipation: { version: 1, characters: [null, participation.characters[0]] },
    shotSourceIds: [['s1', 12], 'bad', ['s3']], shotMetadata: [null, { sourceBeatIds: [] }],
  }), options);
  assert.equal(delivery.h3Prompt, body);
  assert.deepEqual(delivery.identityBindings, bindings);
  assert.deepEqual(delivery.characterParticipation, participation);
  assert.deepEqual(delivery.shotSourceIds, [['s1'], [], ['s3']]);
  assert.deepEqual(delivery.shotMetadata, [null, null]);
  assert.equal(delivery.canonicalPrompt, undefined);
  assert.equal(delivery.deliveryWarnings?.length, 6);
});

await test('all unreadable participation is not misrepresented as a confirmed empty cast', () => {
  const delivery = readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: body,
    characterParticipation: { version: 1, characters: [null] }, identityBindings: null,
  }), options);
  assert.equal(delivery.characterParticipation, undefined);
  assert.equal(delivery.identityBindings, undefined);
  assert.equal(delivery.deliveryWarnings?.length, 2);
});

await test('empty bodies and unreadable JSON still require technical repair', () => {
  for (const invalid of ['', '  ', '{bad', '{"h3Prompt":""}', '{"h3Prompt":42}']) {
    assert.throws(() => readH3DeliveryEnvelope(invalid, options));
  }
});

await test('protocol acceptance does not spend another AI request or change the authored body', async () => {
  let calls = 0;
  assert.equal(await repairH3PromptProtocolWithAi({ ...options, candidatePrompt: body,
    formatReferencePrompt: 'a different structure', language: '中文', request: async () => { calls += 1; return ''; },
  }), body);
  assert.equal(calls, 0);
  await assert.rejects(repairH3PromptProtocolWithAi({ ...options, candidatePrompt: '',
    formatReferencePrompt: body, language: '中文', request: async () => '',
  }), /空/u);
});

await test('translation keeps the existing AI review without local content repair requests', async () => {
  const translated = 'integrated_multimodal_description: [Shot5] A approaches B.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  let calls = 0;
  let warnings: string[] = [];
  let receivedBindings: H3IdentityBindings | undefined;
  const result = await translateVideoPromptToEnglish({ ...options, sourcePrompt: body, identityBindings: bindings,
    reviewWithAi: true, clean: () => { throw new Error('Must not rewrite AI content'); },
    request: async () => { calls += 1; return JSON.stringify({ h3Prompt: translated, identityBindings: { version: 1, characters: [null] } }); },
    onIdentityBindings: (value) => { receivedBindings = value; }, onDeliveryWarnings: (value) => { warnings = value; },
  });
  assert.equal(result, translated);
  assert.equal(calls, 2);
  assert.equal(receivedBindings, undefined);
  assert.ok(warnings.some((warning) => warning.includes('待完善')));
});

await test('a failed AI review preserves an already obtained English body and reports its status', async () => {
  let calls = 0;
  let warnings: string[] = [];
  const result = await translateVideoPromptToEnglish({ ...options, sourcePrompt: body, reviewWithAi: true,
    clean: (value) => value, request: async () => { if (++calls === 1) return 'English body from the AI.'; throw new Error('API failed'); },
    onDeliveryWarnings: (value) => { warnings = value; },
  });
  assert.equal(result, 'English body from the AI.');
  assert.equal(calls, 2);
  assert.ok(warnings.some((warning) => warning.includes('复核未完成')));
});

await test('cancelled or stale requests never fall back to saving an earlier translation', async () => {
  let calls = 0;
  await assert.rejects(translateVideoPromptToEnglish({ ...options, sourcePrompt: body, reviewWithAi: true,
    clean: (value) => value, request: async () => {
      if (++calls === 1) return 'English body.';
      const error = new Error('cancelled'); error.name = 'AbortError'; throw error;
    },
  }), { name: 'AbortError' });
  let current = true;
  calls = 0;
  await assert.rejects(translateVideoPromptToEnglish({ ...options, sourcePrompt: body, reviewWithAi: true,
    clean: (value) => value, isCurrent: () => current, request: async () => {
      if (++calls === 2) current = false;
      return 'English body.';
    },
  }), { name: 'AbortError' });
});

await test('technical JSON repairs are bounded and review failure retains the readable candidate', async () => {
  let calls = 0;
  let warnings: string[] = [];
  const result = await translateVideoPromptToEnglish({ ...options, sourcePrompt: body, reviewWithAi: true,
    clean: (value) => value, request: async () => ++calls === 1 ? 'Readable English.' : '{broken',
    onDeliveryWarnings: (value) => { warnings = value; },
  });
  assert.equal(result, 'Readable English.');
  assert.equal(calls, 5); // initial + existing review + three technical serialization repairs
  assert.ok(warnings.some((warning) => warning.includes('复核未完成')));
});

await test('unreviewed opted-in translation does not use legacy local text protection', async () => {
  let calls = 0;
  const result = await translateVideoPromptToEnglish({ ...options, sourcePrompt: '【0s-3s】甲开门。',
    clean: () => { throw new Error('Must not clean'); }, request: async () => { calls += 1; return 'A opens the door.'; },
  });
  assert.equal(result, 'A opens the door.');
  assert.equal(calls, 1);
});

console.log(`AI-authored delivery: ${passed} tests passed.`);
