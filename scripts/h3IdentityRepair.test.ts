import assert from 'node:assert/strict';
import { getH3IdentityBindingIssues } from '../src/h3IdentityBindings';
import { getH3PromptProtocolIssue } from '../src/h3PromptProtocol';
import {
  H3IdentityRepairCancelledError, H3IdentityRepairError, repairH3IdentityBindings,
  type H3IdentityRepairResult, type RepairH3IdentityBindingsInput,
} from '../src/h3IdentityRepair';
import type { H3IdentityBindings } from '../src/types';

const characters = [{ id: 'alice', name: '爱丽丝' }, { id: 'bob', name: '鲍勃' }, { id: 'absent', name: '未出镜者' }];
const anchor = 'Identity: Alice (S1), a woman with short black hair.';
const otherAnchor = 'Identity: Bob, a man with a grey jacket.';
const prompt = `integrated_multimodal_description: [Shot 1] ${anchor} ${otherAnchor} Alice (S1) opens the door from 0 to 2 seconds. Alice (S1) says <d>[Chinese] 等等，别走。</d> from 2 to 3 seconds. Bob remains silent.\n[Shot 2] At 00:03.000 Alice steps back; Bob closes the door.\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const stale: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'alice', name: '爱丽丝', speakerToken: '(S1)', referenceAnchor: 'Old identity sentence.' },
  { characterId: 'bob', name: '鲍勃', referenceAnchor: otherAnchor },
] };
const reply = (entries: unknown[]): string => JSON.stringify({ characters: entries });
const repairedAlice = { characterId: 'alice', name: '爱丽丝', referenceAnchor: anchor };
const input = (overrides: Partial<RepairH3IdentityBindingsInput> = {}): RepairH3IdentityBindingsInput => ({
  prompt, bindings: stale, characters, language: '英文', request: async () => reply([repairedAlice]), ...overrides,
});
const undoEdits = (result: H3IdentityRepairResult): string => {
  let text = result.prompt;
  for (const edit of [...result.edits].sort((left, right) => right.start - left.start)) {
    assert.equal(text.slice(edit.start, edit.start + edit.text.length), edit.text);
    text = text.slice(0, edit.start) + text.slice(edit.start + edit.text.length);
  }
  return text;
};
let groups = 0;
const group = async (run: () => Promise<void>): Promise<void> => { await run(); groups += 1; };

await group(async () => {
  const original = JSON.stringify(stale);
  const result = await repairH3IdentityBindings(input({ request: async (system, user) => {
    assert.match(system, /绝不重新导演/u);
    assert.match(system, /不按同名、序号/u);
    assert.match(system, /不能删metadata/u);
    assert.match(user, /sourcePrompt/u);
    return reply([repairedAlice]);
  } }));
  assert.equal(result.prompt, prompt, 'metadata repair must not touch one source character');
  assert.equal(result.promptChanged, false);
  assert.equal(result.changed, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.insertedSentences, []);
  assert.deepEqual(result.repairedCharacterIds, ['alice']);
  assert.equal(result.identityBindings.characters[0].speakerToken, '(S1)', 'omitted response token is retained, not removed');
  assert.deepEqual(result.identityBindings.characters[1], stale.characters[1]);
  assert.equal(JSON.stringify(stale), original);
  assert.deepEqual(getH3IdentityBindingIssues(result.prompt, result.identityBindings, characters), []);
});

await group(async () => {
  const result = await repairH3IdentityBindings(input({ bindings: { version: 1, characters: [
    { ...stale.characters[0], referenceAnchor: anchor }, stale.characters[1],
  ] }, request: async () => { throw new Error('Already-current bindings must not call the model.'); } }));
  assert.equal(result.changed, false);
  assert.equal(result.attempts, 0);
});

await group(async () => {
  const source = `\r\nintegrated_multimodal_description: [Shot 1]  Tifa's dark hair frames her face as she walks into the corridor.\r\n[Shot 2] At 00:03.000 Tifa stops by the door.\r\noverall_soundscape: N/A\r\nnon_diegetic_music: N/A\r\n`;
  const declaration = 'Identity: 蒂法.';
  const result = await repairH3IdentityBindings(input({ prompt: source, characters: [{ id: 'tifa', name: '蒂法' }],
    bindings: { version: 1, characters: [{ characterId: 'tifa', name: '蒂法', referenceAnchor: 'Old portrait.' }] },
    request: async () => reply([{ characterId: 'tifa', name: '蒂法', referenceAnchor: declaration,
      insertIdentitySentence: declaration, inPromptEvidence: "Tifa's dark hair frames her face as she walks into the corridor." }]),
  }));
  assert.equal(result.promptChanged, true);
  assert.deepEqual(result.insertedSentences, [declaration]);
  assert.equal(undoEdits(result), source, 'all story, dialogue, timing and CRLF bytes survive verbatim');
  assert.match(result.prompt, /\[Shot 1\]\r\nIdentity: 蒂法\.\r\n  Tifa/u);
  assert.equal(getH3PromptProtocolIssue(result.prompt, source), undefined);
});

await group(async () => {
  const source = 'subject_definitions: <Subject 1> Alice.\nsummary: A quiet doorway.\nretention_analysis: N/A\ndetailed_description: [Shot 1] Alice (S1), with black hair, opens the door. Alice (S1) says <d>[Chinese] 等等。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const declaration = '身份：爱丽丝 <Subject 1> (S1)。';
  const result = await repairH3IdentityBindings(input({ prompt: source, language: '中文', bindings: { version: 1, characters: [{
    ...stale.characters[0], subjectToken: '<Subject 1>',
  }] }, request: async () => reply([{ characterId: 'alice', name: '爱丽丝', referenceAnchor: declaration,
    insertIdentitySentence: declaration, inPromptEvidence: 'Alice (S1), with black hair, opens the door.' }]) }));
  assert.match(result.prompt, /^subject_definitions:\n身份：爱丽丝 <Subject 1> \(S1\)。\n/u);
  assert.equal(undoEdits(result), source);
  assert.equal(getH3PromptProtocolIssue(result.prompt, source), undefined);
});

await group(async () => {
  const bindings: H3IdentityBindings = { version: 1, characters: [stale.characters[0], {
    characterId: 'absent', name: '未出镜者', referenceAnchor: 'Missing identity of an offscreen character.',
  }, { characterId: 'deleted', name: '已删除资料人物', referenceAnchor: 'A stale unknown identity.' }] };
  const result = await repairH3IdentityBindings(input({ bindings, targetCharacterIds: ['alice'] }));
  assert.deepEqual(result.identityBindings.characters.slice(1), bindings.characters.slice(1), 'unselected stale and unknown records remain byte-for-byte');
  assert.equal(getH3IdentityBindingIssues(result.prompt, result.identityBindings, characters).some((issue) => issue.characterId === 'alice'), false);
  assert.equal(getH3IdentityBindingIssues(result.prompt, result.identityBindings, characters).some((issue) => issue.characterId === 'absent'), true);
});

await group(async () => {
  await assert.rejects(repairH3IdentityBindings(input({ bindings: undefined })), /明确选择/u);
  const result = await repairH3IdentityBindings(input({ bindings: undefined, targetCharacterIds: ['bob'], request: async () => reply([
    { characterId: 'bob', name: '鲍勃', referenceAnchor: otherAnchor },
  ]) }));
  assert.deepEqual(result.identityBindings.characters.map((binding) => binding.characterId), ['bob']);
  assert.equal(result.prompt, prompt);
});

await group(async () => {
  for (const invalid of [
    { ...repairedAlice, characterId: 'bob' },
    { ...repairedAlice, name: '鲍勃' },
    { ...repairedAlice, speakerToken: '(S2)' },
    { ...repairedAlice, subjectToken: '<Subject 1>' },
    { ...repairedAlice, referenceAnchor: 'Identity: Alice (S2), a woman with short black hair.' },
  ]) {
    let requests = 0;
    await assert.rejects(repairH3IdentityBindings(input({ request: async () => { requests += 1; return reply([invalid]); } })),
      (error: unknown) => error instanceof H3IdentityRepairError && error.attempts === 3);
    assert.equal(requests, 3, 'ID/name/token mismatch consumes the one bounded budget');
  }
});

await group(async () => {
  const responses = [reply([]), 'invalid JSON', reply([repairedAlice])];
  const result = await repairH3IdentityBindings(input({ request: async (_system, user) => {
    if (responses.length < 3) assert.match(user, /previousResponse/u);
    return responses.shift()!;
  } }));
  assert.equal(result.attempts, 3);
  assert.equal(result.identityBindings.characters.length, 2);
});

await group(async () => {
  for (const malicious of [
    reply([]),
    JSON.stringify({ h3Prompt: prompt.replace('等 等', '别说话'), characters: [repairedAlice] }),
    reply([repairedAlice, { characterId: 'absent', name: '未出镜者', referenceAnchor: 'Absent.' }]),
  ]) {
    await assert.rejects(repairH3IdentityBindings(input({ maxAttempts: 1, request: async () => malicious })), H3IdentityRepairError);
  }
});

await group(async () => {
  const declaration = 'Identity: 爱丽丝 (S1).';
  for (const [sentence, evidence] of [
    ['Identity: 爱丽丝 (S1), who suddenly closes the door.', 'Alice (S1) opens the door from 0 to 2 seconds.'],
    [declaration, 'A fabricated scene of Alice.'],
    [declaration, '等等，别走。'],
    [declaration, 'N/A'],
  ]) {
    await assert.rejects(repairH3IdentityBindings(input({ maxAttempts: 1, request: async () => reply([{
      characterId: 'alice', name: '爱丽丝', referenceAnchor: sentence,
      insertIdentitySentence: sentence, inPromptEvidence: evidence,
    }]) })), H3IdentityRepairError);
  }
});

await group(async () => {
  let current = false;
  let requests = 0;
  const request = async (): Promise<string> => { requests += 1; current = false; return reply([repairedAlice]); };
  await assert.rejects(repairH3IdentityBindings(input({ isCurrent: () => current, request })), H3IdentityRepairCancelledError);
  assert.equal(requests, 0);
  current = true;
  await assert.rejects(repairH3IdentityBindings(input({ isCurrent: () => current, request })), H3IdentityRepairCancelledError);
  assert.equal(requests, 1, 'late model response is never returned for committing');
});

await group(async () => {
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  let requests = 0;
  await assert.rejects(repairH3IdentityBindings(input({ request: async () => { requests += 1; throw abort; } })),
    (error: unknown) => error === abort);
  assert.equal(requests, 1);
  const network = new Error('offline');
  await assert.rejects(repairH3IdentityBindings(input({ request: async () => { throw network; } })),
    (error: unknown) => error instanceof H3IdentityRepairError && error.attempts === 1 && error.originalError === network);
});

await group(async () => {
  let calls = 0;
  for (const maxAttempts of [0, -1, NaN]) await assert.rejects(repairH3IdentityBindings(input({
    maxAttempts, request: async () => { calls += 1; return ''; },
  })), (error: unknown) => error instanceof H3IdentityRepairError && error.attempts === 0);
  assert.equal(calls, 0);
  await assert.rejects(repairH3IdentityBindings(input({ maxAttempts: 99, request: async () => { calls += 1; return ''; } })), H3IdentityRepairError);
  assert.equal(calls, 3);
});

await group(async () => {
  const bindings: H3IdentityBindings = { version: 1, characters: [stale.characters[0], {
    ...stale.characters[1], speakerToken: '(S1)',
  }] };
  await assert.rejects(repairH3IdentityBindings(input({ bindings, targetCharacterIds: ['alice'], maxAttempts: 1 })), H3IdentityRepairError);
  assert.equal(bindings.characters[1].speakerToken, '(S1)', 'cannot fix token conflicts by deleting unrelated metadata');
});

await group(async () => {
  const mutableCharacters = structuredClone(characters);
  const mutableBindings = structuredClone(stale);
  const result = await repairH3IdentityBindings(input({ characters: mutableCharacters, bindings: mutableBindings, request: async () => {
    mutableCharacters[0].name = 'late edit';
    mutableBindings.characters[0].speakerToken = '(S9)';
    return reply([repairedAlice]);
  } }));
  assert.equal(result.identityBindings.characters[0].name, '爱丽丝');
  assert.equal(result.identityBindings.characters[0].speakerToken, '(S1)', 'the operation uses its frozen snapshot, never mutable caller data');
});

await group(async () => {
  const source = 'integrated_multimodal_description: [Shot 1] Tifa walks into the corridor, her black hair framing her face.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const bindings: H3IdentityBindings = { version: 1, characters: [{ characterId: 'tifa', name: '蒂法',
    referenceAnchor: 'Old absent sentence.', speakerToken: '(S1)', subjectToken: '<Subject 2>' }] };
  const declaration = 'Identity: 蒂法.';
  const result = await repairH3IdentityBindings(input({ prompt: source, bindings, characters: [{ id: 'tifa', name: '蒂法' }],
    request: async (_system, user) => {
      const payload = JSON.parse(user.slice(user.indexOf('\n') + 1, user.lastIndexOf('\n')));
      assert.equal(payload.identityBindings.characters[0].speakerToken, '(S1)', 'original metadata remains visible as evidence');
      assert.equal(payload.retainedIdentityBindings[0].speakerToken, undefined, 'tokens never declared in this body are dangling fields');
      return reply([{ characterId: 'tifa', name: '蒂法', referenceAnchor: declaration, insertIdentitySentence: declaration,
        inPromptEvidence: 'Tifa walks into the corridor, her black hair framing her face.' }]);
    },
  }));
  assert.equal(result.identityBindings.characters.length, 1, 'the identity record is never dropped');
  assert.equal(result.identityBindings.characters[0].speakerToken, undefined);
  assert.equal(result.identityBindings.characters[0].subjectToken, undefined);
  assert.equal(undoEdits(result), source);
  assert.doesNotMatch(result.prompt, /\(S1\)|<Subject/u, 'dangling metadata never introduces a new speaker or subject');
  assert.equal(bindings.characters[0].speakerToken, '(S1)', 'original metadata is retained for before-history');
  await assert.rejects(repairH3IdentityBindings(input({ prompt: source, bindings, characters: [{ id: 'tifa', name: '蒂法' }],
    maxAttempts: 1, request: async () => reply([{ characterId: 'tifa', name: '蒂法', referenceAnchor: declaration,
      speakerToken: '(S1)', insertIdentitySentence: declaration, inPromptEvidence: 'Tifa walks into the corridor, her black hair framing her face.' }]),
  })), H3IdentityRepairError, 'a model still cannot reintroduce the absent old token');
});

console.log(`h3IdentityRepair: ${groups} groups passed`);
