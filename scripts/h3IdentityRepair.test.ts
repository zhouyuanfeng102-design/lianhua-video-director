import assert from 'node:assert/strict';
import { getH3IdentityBindingIssues } from '../src/h3IdentityBindings';
import { getExistingH3PromptProtocolIssue, getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
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
  const saved = prompt.replace('At 00:03.000 ', 'Continue from the previous shot. From 12.20 to 12.90 seconds, ');
  assert.equal(readH3PromptProtocol(saved), undefined, 'the compatibility read does not relax new-delivery validation');
  const result = await repairH3IdentityBindings(input({ prompt: saved }));
  assert.equal(result.prompt, saved, 'untimed saved H3 metadata repair preserves every source character');
  assert.equal(result.promptChanged, false);
  assert.equal(result.attempts, 1);
  assert.equal(getExistingH3PromptProtocolIssue(result.prompt, saved), undefined);
});

await group(async () => {
  for (const header of ['[Shot 2] ', '[Shot 2]\r\nAt 00:03.000 ']) {
    const evidence = "Tifa's dark hair frames her face as she walks into the corridor.";
    const source = `integrated_multimodal_description: [Shot 1] An empty corridor.\r\n${header}${evidence} From 12.20 to 12.90 seconds she pauses.\r\n[Shot 3] Continue from the pause. Tifa watches the door.\r\noverall_soundscape: N/A\r\nnon_diegetic_music: N/A`;
    const declaration = 'Identity: 蒂法.';
    const result = await repairH3IdentityBindings(input({ prompt: source, characters: [{ id: 'tifa', name: '蒂法' }],
      bindings: { version: 1, characters: [{ characterId: 'tifa', name: '蒂法', referenceAnchor: 'Old portrait.' }] },
      request: async () => reply([{ characterId: 'tifa', name: '蒂法', referenceAnchor: declaration,
        insertIdentitySentence: declaration, inPromptEvidence: evidence }]),
    }));
    assert.equal(undoEdits(result), source, 'late-shot insertion preserves all prose, dialogue, timing text, cuts and CRLF bytes');
    assert.equal(getExistingH3PromptProtocolIssue(result.prompt, source), undefined);
    assert.ok(result.prompt.indexOf(declaration) > result.prompt.indexOf('[Shot 2]'));
    if (header.includes('At')) assert.match(result.prompt, /\[Shot 2\]\r\nAt 00:03.000\r\nIdentity: 蒂法\./u,
      'identity insertion stays after an actual cut header even when its whitespace includes a newline');
  }
  let calls = 0;
  const saved = prompt.replace('At 00:03.000', 'At 00:03.0');
  const result = await repairH3IdentityBindings(input({ prompt: saved,
    request: async () => { calls++; return reply([repairedAlice]); },
  }));
  assert.equal(result.prompt, saved, 'metadata repair does not audit or rewrite a saved cut format');
  assert.equal(calls, 1);
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
  const declaration = '身份：爱丽丝 <Subject 1>。';
  const result = await repairH3IdentityBindings(input({ prompt: source, language: '中文', bindings: { version: 1, characters: [{
    ...stale.characters[0], subjectToken: '<Subject 1>',
  }] }, request: async () => reply([{ characterId: 'alice', name: '爱丽丝', referenceAnchor: declaration,
    insertIdentitySentence: declaration, inPromptEvidence: 'Alice (S1), with black hair, opens the door.' }]) }));
  assert.match(result.prompt, /^subject_definitions:\n身份：爱丽丝 <Subject 1>。\n/u);
  assert.equal(result.identityBindings.characters[0].speakerToken, '(S1)', 'voice metadata stays separate from the visual declaration');
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
    { ...repairedAlice, referenceAnchor: 'Identity: Alice (S2), a woman with short black hair.' },
  ]) {
    let requests = 0;
    await assert.rejects(repairH3IdentityBindings(input({ request: async () => { requests += 1; return reply([invalid]); } })),
      (error: unknown) => error instanceof H3IdentityRepairError && error.attempts === 1);
    assert.equal(requests, 1, 'an unknown target or unreadable location ends the explicit request without retry');
  }
  const result = await repairH3IdentityBindings(input({ request: async () => reply([
    { ...repairedAlice, name: '返回的别名', speakerToken: '(S2)', subjectToken: '<Subject 9>' },
  ]) }));
  assert.equal(result.identityBindings.characters[0].name, '爱丽丝', 'the supplied ID resolves the known name without reviewing prose');
  assert.equal(result.identityBindings.characters[0].speakerToken, '(S1)', 'response voice fields cannot replace the saved mapping');
  assert.equal(result.identityBindings.characters[0].subjectToken, undefined);
});

await group(async () => {
  for (const response of [reply([]), 'invalid JSON', '']) {
    let requests = 0;
    await assert.rejects(repairH3IdentityBindings(input({ request: async (_system, user) => {
      requests++;
      assert.doesNotMatch(user, /previousResponse|validationIssue/u);
      return response;
    } })), (error: unknown) => error instanceof H3IdentityRepairError && error.attempts === 1);
    assert.equal(requests, 1, 'unreadable data never causes another model request');
  }
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
  const declaration = '爱丽丝保持原稿中的人物外观。';
  const accepted = await repairH3IdentityBindings(input({ request: async () => reply([{
    characterId: 'alice', referenceAnchor: declaration, insertIdentitySentence: declaration,
    inPromptEvidence: 'Alice (S1) opens the door from 0 to 2 seconds.',
  }]) }));
  assert.equal(undoEdits(accepted), prompt, 'AI-authored identity prose is applied without a fixed local sentence template');
  assert.equal(accepted.identityBindings.characters[0].speakerToken, '(S1)');
  for (const evidence of ['A fabricated scene of Alice.', 'N/A']) {
    await assert.rejects(repairH3IdentityBindings(input({ maxAttempts: 1, request: async () => reply([{
      characterId: 'alice', name: '爱丽丝', referenceAnchor: declaration,
      insertIdentitySentence: declaration, inPromptEvidence: evidence,
    }]) })), H3IdentityRepairError);
  }
  const source = '已有稿：爱丽丝位于走廊里，摄影机保持原位。';
  const inserted = await repairH3IdentityBindings(input({ prompt: source, targetCharacterIds: ['alice'],
    request: async () => reply([{ characterId: 'alice', referenceAnchor: declaration,
      insertIdentitySentence: declaration, inPromptEvidence: '爱丽丝位于走廊里' }]),
  }));
  assert.equal(undoEdits(inserted), source, 'unique source evidence supplies an insertion offset without an H3 protocol gate');
  assert.equal(inserted.edits[0].start, source.indexOf('爱丽丝位于走廊里'));
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
  assert.equal(calls, 1, 'even a legacy large retry budget permits only one model request');
});

await group(async () => {
  const bindings: H3IdentityBindings = { version: 1, characters: [stale.characters[0], {
    ...stale.characters[1], speakerToken: '(S1)',
  }] };
  const result = await repairH3IdentityBindings(input({ bindings, targetCharacterIds: ['alice'], maxAttempts: 1 }));
  assert.deepEqual(result.identityBindings.characters.map((binding) => binding.speakerToken), ['(S1)', '(S1)'],
    'repair preserves existing voice metadata instead of auditing or reallocating speakers');
  assert.equal(bindings.characters[1].speakerToken, '(S1)');
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
      assert.equal(payload.retainedIdentityBindings[0].speakerToken, '(S1)', 'voice metadata is not deleted based on a local body scan');
      assert.doesNotMatch(payload.insertionIdentityDeclarations[0].sentence, /\(S1\)/u);
      return reply([{ characterId: 'tifa', name: '蒂法', referenceAnchor: declaration, insertIdentitySentence: declaration,
        speakerToken: '(S9)', inPromptEvidence: 'Tifa walks into the corridor, her black hair framing her face.' }]);
    },
  }));
  assert.equal(result.identityBindings.characters.length, 1, 'the identity record is never dropped');
  assert.equal(result.identityBindings.characters[0].speakerToken, '(S1)');
  assert.equal(result.identityBindings.characters[0].subjectToken, '<Subject 2>');
  assert.equal(undoEdits(result), source);
  assert.doesNotMatch(result.prompt, /\(S1\)|<Subject/u, 'retaining metadata does not insert its tokens into authored visual prose');
  assert.equal(bindings.characters[0].speakerToken, '(S1)', 'original metadata is retained for before-history');
});

await group(async () => {
  const visual = '亚当通体苍白，头部保持原有形态。';
  const source = `integrated_multimodal_description: [Shot 1] ${visual}\n[Shot 2] At 00:03.0 亚当停在原处。\n[Shot 3] (S1)发出非语言悲鸣。<sound>短促悲鸣</sound>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const bindings: H3IdentityBindings = { version: 1, characters: [{ characterId: 'adam', name: '亚当',
    referenceAnchor: visual, speakerToken: '(S1)' }] };
  const result = await repairH3IdentityBindings(input({ prompt: source, bindings, characters: [{ id: 'adam', name: '亚当' }],
    request: async () => { throw new Error('Exact visual anchor and matching ID require no model call.'); },
  }));
  assert.equal(result.attempts, 0);
  assert.equal(result.changed, false);
  assert.equal(result.prompt, source);
  assert.deepEqual(result.identityBindings, bindings, 'nonverbal voice metadata stays at its original mapping without entering the visual anchor');
});

await group(async () => {
  for (const language of ['中文', '英文'] as const) {
    const identities = language === '中文'
      ? ['身份定义：新奥特曼为银红相间光之巨人。', '身份定义：二号机为猩红色仿生重装机甲。']
      : ['Identity: Shin Ultraman is a silver-and-red Giant of Light.', 'Identity: No. 2 Unit is a crimson bionic mecha.'];
    const source = `integrated_multimodal_description:\n[Shot 1] ${identities.join('\n')}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
    const bindings: H3IdentityBindings = { version: 1, characters: identities.map((referenceAnchor, index) => ({
      characterId: characters[index].id, name: `已保存的人物展示名${index}`, referenceAnchor,
      subjectToken: `<Subject ${index + 1}>`, speakerToken: '(S1)',
    })) };
    assert.deepEqual(getH3IdentityBindingIssues(source, bindings, characters), [],
      'saved IDs and literal locations do not depend on display name or absent Subject/S prose');
    const result = await repairH3IdentityBindings(input({ prompt: source, bindings, language,
      targetCharacterIds: characters.slice(0, 2).map(({ id }) => id),
      request: async () => { throw new Error('Usable saved locations must not call the model.'); },
    }));
    assert.equal(result.attempts, 0);
    assert.equal(result.changed, false);
    assert.equal(result.prompt, source);
    assert.deepEqual(result.identityBindings, bindings);
    assert.deepEqual(getH3IdentityBindingIssues(result.prompt, result.identityBindings, characters), [],
      'a no-op repair and image preparation agree for both languages');
  }
});

console.log(`h3IdentityRepair: ${groups} groups passed`);
