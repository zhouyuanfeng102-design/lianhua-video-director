import assert from 'node:assert/strict';
import { createH3IdentityDeliveryReader, getH3IdentityBindingIssues, h3IdentityAnchorIssue, h3IdentityBindingRetentionIssue, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { SequencePromptHandoffContext } from '../src/sequencePromptHandoff';
import type { Character, H3IdentityBindings, Storyboard } from '../src/types';

// Synthetic offline fixtures. No project files, real character data or API.
const anchor = 'Identity: 成年甲 (S1), 蓝外套。';
const englishAnchor = 'Identity: 成年甲 (S1), blue coat.';
const prompt = (identity = anchor): string => `integrated_multimodal_description:\n[Shot 1] ${identity} 成年甲在桌旁。成年甲 (S1)说 <d>[Chinese] 请收好地图。</d>。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const bindings = (identity = anchor): H3IdentityBindings => ({ version: 1, characters: [{
  characterId: 'adult-a', name: '成年甲', speakerToken: '(S1)', referenceAnchor: identity,
}] });
const people = [{ id: 'adult-a', name: '成年甲' }];
const codes = (body: string, metadata = bindings()) => getH3IdentityBindingIssues(body, metadata).map((issue) => issue.code);
const envelope = (body: string, metadata: H3IdentityBindings | undefined = bindings()) => JSON.stringify({ h3Prompt: body, ...(metadata ? { identityBindings: metadata } : {}) });
let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); count += 1; console.log(`PASS ${name}`); };

await test('legacy missing metadata stays compatible; declared malformed metadata is never dropped', () => {
  assert.deepEqual(getH3IdentityBindingIssues(prompt(), undefined), []);
  assert.equal(readH3DeliveryEnvelope(prompt()).identityBindings, undefined);
  for (const invalid of [null, {}, { version: 2, characters: [] }, { version: 1, characters: [{ characterId: 'adult-a' }] }]) {
    assert.throws(() => readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: prompt(), identityBindings: invalid })), /identityBindings格式无效/u);
  }
});

await test('a failed new delivery cannot evade validation by dropping or emptying its declared metadata', () => {
  const read = createH3IdentityDeliveryReader();
  assert.throws(() => read(envelope(prompt(englishAnchor))), /anchor-missing/u);
  assert.throws(() => read(prompt(englishAnchor)), /不能遗漏/u);
  assert.throws(() => read(envelope(prompt(englishAnchor), { version: 1, characters: [] })), /不能清空/u);
  assert.deepEqual(read(envelope(prompt(englishAnchor), bindings(englishAnchor))).identityBindings, bindings(englishAnchor));
});

await test('missing, translated and duplicate anchors report exact reasons per person', () => {
  assert.deepEqual(getH3IdentityBindingIssues(prompt(), bindings(), people), []);
  assert.ok(codes(prompt(englishAnchor)).includes('anchor-missing'));
  assert.throws(() => readH3DeliveryEnvelope(envelope(prompt(englishAnchor))), /anchor-missing/u);
  assert.ok(codes(prompt(`${anchor} ${anchor}`)).includes('anchor-ambiguous'));
  assert.equal(getH3IdentityBindingIssues(prompt(), bindings(), [])[0].code, 'unknown-character');
  assert.equal(getH3IdentityBindingIssues(prompt(), bindings(), [{ id: 'adult-a', name: '其他原名' }])[0].code, 'character-name-mismatch');
});

await test('payload, section and substring anchors are rejected; later-shot first appearances are accepted', () => {
  for (const tag of ['d', 'sound']) assert.ok(codes(prompt(`<${tag}>${anchor}</${tag}>`)).includes('anchor-payload'));
  assert.ok(codes(`integrated_multimodal_description:\n[Shot 1] 甲在桌旁。\noverall_soundscape: ${anchor}\nnon_diegetic_music: N/A`).includes('anchor-section'));
  assert.deepEqual(codes(prompt(`甲在桌旁。\n[Shot 2] At 00:07.500 ${anchor}`)), []);
  assert.ok(codes(prompt(`前文${anchor}`)).includes('anchor-boundary'));
  for (const suffix of [' <Picture 1>', ' [Shot 1]', ' At 00:01.000', ' 1–3秒', ' 2 seconds']) {
    const bad = `${anchor}${suffix}`;
    assert.ok(codes(prompt(bad), bindings(bad)).includes('anchor-protocol-content'));
  }
  assert.equal(h3IdentityAnchorIssue(prompt(), anchor), undefined);
});

await test('speaker and subject declarations agree with the paired anchor or definition line', () => {
  assert.ok(codes(prompt(), { ...bindings(), characters: [{ ...bindings().characters[0], speakerToken: '(S2)' }] }).includes('speaker-token-mismatch'));
  assert.ok(codes(prompt(), { ...bindings(), characters: [{ ...bindings().characters[0], speakerToken: undefined }] }).includes('speaker-token-mismatch'));
  const subjectBindings = { ...bindings(), characters: [{ ...bindings().characters[0], subjectToken: '<Subject 2>' }] };
  assert.ok(codes(prompt(), subjectBindings).includes('subject-token-mismatch'));
  assert.deepEqual(getH3IdentityBindingIssues(`subject_definitions:\n<Subject 2> is 成年甲: ${anchor}\nsummary: 桌旁\nretention_analysis: N/A\ndetailed_description: [Shot 1] 桌旁。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`, subjectBindings), []);
});

await test('duplicate IDs, anchors and tokens report all involved records, never only the second', () => {
  const duplicated: H3IdentityBindings = { version: 1, characters: [bindings().characters[0], { ...bindings().characters[0], characterId: 'adult-b', name: '成年乙' }] };
  const issues = getH3IdentityBindingIssues(prompt(), duplicated);
  assert.deepEqual(issues.filter((issue) => issue.code === 'duplicate-speaker').map((issue) => issue.characterId), ['adult-a', 'adult-b']);
  assert.deepEqual(issues.filter((issue) => issue.code === 'duplicate-anchor').map((issue) => issue.characterId), ['adult-a', 'adult-b']);
  duplicated.characters[1].characterId = 'adult-a';
  assert.equal(getH3IdentityBindingIssues(prompt(), duplicated).filter((issue) => issue.code === 'duplicate-character').length, 2);
  assert.match(h3IdentityBindingRetentionIssue(bindings(), { version: 1, characters: [] })!, /不能清空/u);
});

await test('translation repairs a Chinese metadata / English body mismatch through the existing request', async () => {
  let requests = 0; let saved: H3IdentityBindings | undefined;
  const translated = await translateVideoPromptToEnglish({ sourcePrompt: prompt(), identityBindings: bindings(), clean: (value) => value,
    onIdentityBindings: (value) => { saved = value; },
    request: async (_system, user, transport) => {
      requests += 1;
      if (requests === 1) return envelope(prompt(englishAnchor));
      assert.equal(transport?.serializationRepair, true); assert.match(user, /anchor-missing/u);
      return envelope(prompt(englishAnchor), bindings(englishAnchor));
    } });
  assert.equal(requests, 2); assert.equal(translated, prompt(englishAnchor)); assert.deepEqual(saved, bindings(englishAnchor));
});

await test('translation cannot discard or empty metadata to evade the shared three-retry budget', async () => {
  for (const response of [prompt(englishAnchor), envelope(prompt(englishAnchor), { version: 1, characters: [] })]) {
    let requests = 0; let saved = false;
    await assert.rejects(translateVideoPromptToEnglish({ sourcePrompt: prompt(), identityBindings: bindings(), clean: (value) => value,
      onIdentityBindings: () => { saved = true; }, request: async () => { requests += 1; return response; } }), /3次/u);
    assert.equal(requests, 4); assert.equal(saved, false);
  }
});

await test('protocol repair saves its new final anchor with its final body, using no additional review', async () => {
  const revisedAnchor = 'Identity: 成年甲 (S1), blue coat and dark hair.';
  let requests = 0; let saved: H3IdentityBindings | undefined;
  const body = await repairH3PromptProtocolWithAi({ formatReferencePrompt: prompt(englishAnchor),
    candidatePrompt: prompt(englishAnchor).replace('non_diegetic_music:', 'invalid_music:'), language: '英文',
    identityDelivery: { bindings: bindings(englishAnchor), onBindings: (value) => { saved = value; } },
    request: async (system, user) => {
      requests += 1; assert.match(system, /identityBindings/u); assert.match(user, /h3_format_repair_data/u);
      return envelope(prompt(revisedAnchor), bindings(revisedAnchor));
    } });
  assert.equal(requests, 1); assert.equal(body, prompt(revisedAnchor)); assert.deepEqual(saved, bindings(revisedAnchor));
});

await test('a protocol repair that omits tokens or returns a bare body cannot overwrite the pair', async () => {
  for (const response of [prompt(englishAnchor), envelope(prompt(englishAnchor.replace(' (S1)', '')), bindings(englishAnchor.replace(' (S1)', '')))]) {
    let requests = 0; let saved = false;
    await assert.rejects(repairH3PromptProtocolWithAi({ formatReferencePrompt: prompt(), candidatePrompt: prompt().replace('non_diegetic_music:', 'bad_music:'), language: '中文',
      identityDelivery: { bindings: bindings(), onBindings: () => { saved = true; } },
      request: async () => { requests += 1; return response; } }), /3次/u);
    assert.equal(requests, 3); assert.equal(saved, false);
  }
});

const character: Character = { ...people[0], gender: '', apparentAge: '成年人', race: '人类', appearance: '黑发', outfit: '蓝外套',
  anchor: '', signatureProps: '', personality: '', motionHabits: '', negativeContinuity: '', assetIds: [] };
const context = { characters: [character], assets: [] };
const canonical = '【0s-15s】主体：@成年甲 正在 [站在桌旁]；空间：房间；光影：日光；镜头：中景；台词：无；音效：无';
const board: Storyboard = {
  id: 'identity-delivery-fixture', sceneId: 'scene', sourceStoryContent: '成年甲站在桌旁。', workflow: 'drama', inputMode: 'text',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: canonical,
  shots: [{ id: 's1', index: 1, startSec: 0, endSec: 15, subject: '成年甲', action: '站在桌旁', purpose: '', camera: '中景', lighting: '日光', sound: '无', result: '', transition: '', referenceAssetIds: [], locked: false, prompt: canonical }],
  createdAt: 1, updatedAt: 1,
};
const quietAnchor = '身份：成年甲，黑发，蓝外套。';
const quietBindings = (value = quietAnchor): H3IdentityBindings => ({ version: 1, characters: [{ characterId: character.id, name: character.name, referenceAnchor: value }] });
const official = applyOfficialH3Prompt(board, context);
const zh = official.officialPromptZh!.replace('[Shot 1]', `[Shot 1] ${quietAnchor}`);
const quietEnglishAnchor = 'Identity: 成年甲, dark hair, blue coat.';
const en = zh.replace(quietAnchor, quietEnglishAnchor);

await test('missing Chinese identity sentence escalates from a locked metadata patch to paired repair', async () => {
  let reviews = 0; let translations = 0;
  const result = await generateSingleSegmentPrompt({ board: official, context, purpose: 'dialogue-repair', clean: (value) => value,
    request: async (_system, _user, stage) => {
      if (stage === 'review') {
        reviews += 1;
        return JSON.stringify({ canonicalPrompt: canonical, h3Prompt: reviews === 1 ? official.officialPromptZh : zh, identityBindings: quietBindings(),
          characterParticipation: { version: 1, characters: [{ characterId: character.id, name: character.name,
            presence: 'visible', shotIndex: 1, evidence: '成年甲', speaking: false }] }, shotSourceIds: [['s1']] });
      }
      translations += 1; return envelope(en, quietBindings(quietEnglishAnchor));
    } });
  assert.equal(reviews, 3); assert.equal(translations, 2);
  assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en);
  assert.deepEqual(result.h3IdentityBindings, quietBindings()); assert.deepEqual(result.h3IdentityBindingsEn, quietBindings(quietEnglishAnchor));
});

await test('continuity updates repair stale saved metadata within the existing final-delivery stage', async () => {
  const sequence = { ...official, sequencePlanId: 'plan', segmentId: 'segment-2', segmentIndex: 2, officialPromptZh: zh,
    h3IdentityBindings: quietBindings('身份：成年甲，过期旧句。'), targetOutput: { ...official.targetOutput!, prompt: zh } };
  const evidence = {
    version: 'sequence-prompt-handoff-v1', projectId: 'project', planId: 'plan', segmentId: 'segment-2', segmentIndex: 2, durationSec: 15,
    segmentContent: board.sourceStoryContent!, previousSegmentId: 'segment-1', previousSegmentIndex: 1, previousStoryboardId: 'previous-board',
    previousDurationSec: 15, previousSegmentContent: '成年甲来到桌旁。', previousPromptKind: 'official-h3', previousFinalPrompt: zh,
    previousTailWindow: { startSec: 14.5, endSec: 15 }, previousEntryState: '', previousExitState: '', previousContinuityPack: '',
    entryState: '', exitState: '', continuityPack: '', transitionHint: '', openingOverlapSec: 0.5,
    openingTiming: { contractVersion: 'sequence-prompt-opening-window-v2' }, previousPromptFingerprint: sourceContentHash(zh),
  };
  const handoff = { ...evidence, sourceFingerprint: sourceContentHash(JSON.stringify(evidence)) } as SequencePromptHandoffContext;
  let reviews = 0;
  const result = await generateSingleSegmentPrompt({ board: sequence, context, purpose: 'continuity-repair', sequenceHandoff: handoff, clean: (value) => value,
    request: async (system, user, stage) => {
      if (stage === 'review') {
        reviews += 1; assert.match(`${system}\n${user}`, /candidateIdentityBindings/u);
        if (reviews === 2) assert.match(user, /anchor-missing/u);
        return envelope(zh, reviews === 1 ? sequence.h3IdentityBindings : quietBindings());
      }
      return envelope(en, quietBindings(quietEnglishAnchor));
    } });
  assert.equal(reviews, 2); assert.equal(result.officialPromptZh, zh); assert.deepEqual(result.h3IdentityBindings, quietBindings());
  assert.equal(sequence.h3IdentityBindings.characters[0].referenceAnchor, '身份：成年甲，过期旧句。');
  assert.ok(result.sequencePromptHandoff);
});

await test('reference refresh returns a synchronized identity envelope instead of inheriting its old metadata', async () => {
  const saved = { ...official, officialPromptZh: zh, h3IdentityBindings: quietBindings('身份：成年甲，旧参考定位句。') };
  let conversions = 0; let reviews = 0;
  const result = await generateSingleSegmentPrompt({ board: saved, context, purpose: 'reference-refresh', reviewWithAi: true, clean: (value) => value,
    converter: { id: 'converter', name: '测试', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true, version: '1', systemPrompt: '整理六字段', outputRules: '保留格式', updatedAt: 1 },
    request: async (system, user, stage) => {
      if (stage === 'convert') { conversions += 1; return canonical; }
      if (stage === 'review') {
        reviews += 1;
        if (reviews === 1) assert.match(system, /参考图更新/u);
        assert.match(`${system}\n${user}`, /candidateIdentityBindings/u);
        return envelope(zh, reviews === 1 ? saved.h3IdentityBindings : quietBindings());
      }
      return envelope(en, quietBindings(quietEnglishAnchor));
    } });
  assert.equal(conversions, 1); assert.equal(reviews, 2);
  assert.equal(result.officialPromptZh, zh); assert.deepEqual(result.h3IdentityBindings, quietBindings());
  assert.deepEqual(result.h3IdentityBindingsEn, quietBindings(quietEnglishAnchor));
});

console.log(`H3 identity delivery: ${count} synthetic offline cases passed`);
