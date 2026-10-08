import assert from 'node:assert/strict';
import { characterParticipationIssues, inspectCharacterParticipation, normalizeCharacterParticipationSnapshot,
  resolveCharacterAlias, resolvePromptCharacterParticipation, resolveStoryboardCharacterParticipation, stampCharacterParticipation } from '../src/characterParticipation';
import { createH3IdentityDeliveryReader, h3IdentityAnchorIssue } from '../src/h3IdentityBindings';
import { repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import type { Character, H3IdentityBindings, PromptCharacterParticipation, Storyboard } from '../src/types';

const character = (id: string, name: string, patch: Partial<Character> = {}): Character => ({
  id, name, aliases: [], gender: '女', apparentAge: '成年', race: '人类', appearance: '银色长发', outfit: '红色铠甲',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [], ...patch,
});
const hero = character('hero', '夏提雅·布拉德弗伦');
const companion = character('companion', '亚乌菈·贝拉·菲欧拉');
const king = character('king', '贝·里尤洛');
const people = [hero, companion, king];
const shotPrompt = (body: string) => `integrated_multimodal_description: ${body}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
// Exact failing narrative examples, with no guessed aliases added to dossiers.
const sceneOne = '远景处王都通道口阴影中，身披猩红重铠的夏提雅与身着白红贵族礼服的暗精灵亚乌菈并肩走出，停在洞窟开阔地边缘静止注视。';
const sceneFive = '在00:28.000至00:30.000期间，镜头越过高台掠向远方战场：狂化的掘土兽人战士疯狂践踏同伴碎尸持续扑向红铠夏提雅，被其怪异长枪凌空成片抹去，漫天碎尸残骸堆积如山，大军阵线已被硬生生抹去半数。';
const first = resolvePromptCharacterParticipation(shotPrompt(`[Shot 1] ${sceneOne}`), people);
assert.deepEqual(first.characters.map((entry) => [entry.characterId, entry.presence]), [['hero', 'visible'], ['companion', 'visible']]);
assert.equal(resolvePromptCharacterParticipation(shotPrompt(`[Shot 5] ${sceneFive}`), people).characters[0].presence, 'visible');
assert.equal(resolveCharacterAlias('夏提雅', people)?.id, hero.id);
assert.equal(resolveCharacterAlias('贝', people), undefined, 'single Han components are not invented aliases');
assert.equal(resolveCharacterAlias('夏提雅', [...people, character('other', '夏提雅·另一人')]), undefined);
assert.equal(resolveCharacterAlias('夏提雅', [...people, character('form', '夏提雅·战斗形态', { baseName: '夏提雅', formLabel: '战斗形态' })]), undefined);
assert.equal(resolveCharacterAlias('夏提雅', [...people, character('other', '其他人', { aliases: ['夏提雅'] })]), undefined);
const quoted = resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 贝·里尤洛说：<d>[Chinese] 夏提雅站在门外吗？</d>。'), people);
assert.equal(quoted.characters.find((entry) => entry.characterId === 'hero')?.presence, 'mentioned');
assert.equal(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 夏提雅在画外挥枪。'), people).characters[0].presence, 'offscreen');
assert.equal(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 敌人从远处冲向夏提雅。'), people).characters[0].presence, 'offscreen');
assert.equal(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 敌人向夏提雅冲锋。'), people).characters[0].presence, 'offscreen');
const two = resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 有人提到夏提雅。\n[Shot 3] At 00:20.000, 夏提雅站在门口。'), people);
assert.deepEqual(two.characters[0].visibleShotIndexes, [3]);
assert.deepEqual(two.characters[0].shotIndexes, [1, 3]);
const compactShots = resolvePromptCharacterParticipation(shotPrompt('[Shot1] 空旷石台。\n[Shot5] At 00:20.000, 夏提雅站在门口。'), people);
assert.deepEqual(compactShots.characters[0].visibleShotIndexes, [5], 'compact legacy markers retain the actual displayed shot number');
const quotedShotMarkers = resolvePromptCharacterParticipation(shotPrompt(
  '[Shot1] <d>[Chinese] 我说的是[Shot5]这个标记。</d> 夏提雅站在门口。字幕牌写着“[Shot8]”。夏提雅挥枪。\n[Shot2] At 00:15.000, 亚乌菈走入门口。',
), people);
assert.deepEqual(quotedShotMarkers.characters.find((entry) => entry.characterId === hero.id)?.shotIndexes, [1], 'dialogue and quoted marker text cannot split the current shot');
assert.deepEqual(quotedShotMarkers.characters.find((entry) => entry.characterId === companion.id)?.visibleShotIndexes, [2]);
const englishHero = { ...hero, aliases: ['Shalltear'] };
const english = resolvePromptCharacterParticipation(shotPrompt('[Shot 1] Identity: Someone, a king. Shalltear thrusts her spear at the charging orcs.'), [englishHero]);
assert.deepEqual(english.characters[0].visibleShotIndexes, [1]);
assert.equal(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 假的夏提雅站在门口。'), people).characters.some((entry) => entry.presence === 'visible'), false);
assert.equal(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] 夏提雅姐姐站在门口。'), people).characters.some((entry) => entry.presence === 'visible'), false);
const commonNames = [character('ann', 'Ann'), character('anna', 'Anna')];
assert.deepEqual(resolvePromptCharacterParticipation(shotPrompt('[Shot 1] Anna stands beside the gate.'), commonNames).characters.map((entry) => entry.characterId), ['anna']);

const anchor = 'Identity: 夏提雅·布拉德弗伦，银色长发与红色铠甲。';
const zh = shotPrompt(`[Shot 1] 镜头展示空旷石台。\n[Shot 2] At 00:15.000, ${anchor} 夏提雅站在石台上。`);
const bindings: H3IdentityBindings = { version: 1, characters: [{ characterId: hero.id, name: hero.name, referenceAnchor: anchor }] };
const participation: PromptCharacterParticipation = { version: 1, characters: [{ characterId: hero.id, name: hero.name,
  presence: 'visible', shotIndex: 2, evidence: '夏提雅站在石台上。', speaking: false }] };
assert.equal(h3IdentityAnchorIssue(zh, anchor), undefined, 'first appearance in a later shot is a legal anchor');
assert.ok(h3IdentityAnchorIssue(`integrated_multimodal_description: ${anchor}\n[Shot 1] 空旷石台。`, anchor));
assert.deepEqual(characterParticipationIssues(zh, participation, people, bindings), []);
assert.match(characterParticipationIssues(zh, participation, people, { version: 1, characters: [] }).join(' '), /缺少唯一identityBindings/u);
assert.ok(characterParticipationIssues(zh, { ...participation, characters: [{ ...participation.characters[0], shotIndex: 1 }] }, people, bindings).length);
assert.equal(inspectCharacterParticipation({ version: 1, characters: [{ ...participation.characters[0], presence: 'main-character' }] }).value, undefined);
const snapshot = stampCharacterParticipation(zh, participation);
assert.deepEqual(normalizeCharacterParticipationSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
assert.equal(resolvePromptCharacterParticipation(zh, people, { participation: snapshot }).usedFallback, false);
assert.equal(resolvePromptCharacterParticipation(`${zh}\nchanged`, people, { participation: snapshot }).usedFallback, true);
const pairedEnglish = 'integrated_multimodal_description: [Shot 1] Empty platform.\n[Shot 2] At 00:15.000, Shalltear stands on the platform.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
assert.deepEqual(resolveStoryboardCharacterParticipation({ officialPromptZh: zh, officialPromptEn: pairedEnglish,
  officialPromptEnSource: zh, h3CharacterParticipation: snapshot }, people, pairedEnglish).characters[0].visibleShotIndexes, [2]);
const legacyReader = createH3IdentityDeliveryReader(undefined, people);
assert.equal(legacyReader(JSON.stringify({ h3Prompt: zh, identityBindings: bindings })).characterParticipation, undefined);
const newReader = createH3IdentityDeliveryReader(undefined, people, { requireParticipation: true });
assert.throws(() => newReader(JSON.stringify({ h3Prompt: zh, identityBindings: bindings })), /characterParticipation/u);
assert.throws(() => createH3IdentityDeliveryReader(undefined, people, { requireParticipation: true })(JSON.stringify({
  h3Prompt: zh, identityBindings: { version: 1, characters: [] }, characterParticipation: participation,
})), /identityBindings/u);
assert.deepEqual(newReader(JSON.stringify({ h3Prompt: zh, identityBindings: bindings, characterParticipation: participation })).characterParticipation, participation);
assert.throws(() => createH3IdentityDeliveryReader(undefined, people, { requireParticipation: true })(JSON.stringify({
  h3Prompt: shotPrompt(`[Shot 1] ${sceneOne}`), characterParticipation: { version: 1, characters: [] },
})), /characterParticipation缺少该人物记录/u, 'an empty sidecar cannot hide known names in the final shots');
const mentionedPrompt = shotPrompt('[Shot 1] 贝·里尤洛说：<d>[Chinese] 夏提雅在城门外吗？</d>。');
const mentionedOnly: PromptCharacterParticipation = { version: 1, characters: [king, hero].map((person) => ({
  characterId: person.id, name: person.name, presence: person.id === king.id ? 'offscreen' : 'mentioned',
  shotIndex: 1, evidence: person.id === king.id ? '贝·里尤洛说' : '夏提雅在城门外吗？',
})) };
assert.deepEqual(createH3IdentityDeliveryReader(undefined, people, { requireParticipation: true })(JSON.stringify({
  h3Prompt: mentionedPrompt, characterParticipation: mentionedOnly,
})).characterParticipation, mentionedOnly, 'name coverage never forces a quoted character into the image');
assert.equal(createH3IdentityDeliveryReader(undefined, people)(JSON.stringify({
  h3Prompt: shotPrompt(`[Shot 1] ${sceneOne}`), characterParticipation: { version: 1, characters: [] },
})).h3Prompt, shotPrompt(`[Shot 1] ${sceneOne}`), 'legacy readers do not introduce a new coverage block');
let protocolRequests = 0;
let repairedParticipation: PromptCharacterParticipation | undefined;
const changedZh = zh.replace('夏提雅站在石台上。', '夏提雅静立于石台。');
const changedParticipation: PromptCharacterParticipation = { version: 1, characters: [{
  ...participation.characters[0], evidence: '夏提雅静立于石台。',
}] };
assert.equal(await repairH3PromptProtocolWithAi({
  candidatePrompt: zh.replace('overall_soundscape:', 'invalid_soundscape:'), formatReferencePrompt: zh, language: '中文',
  identityDelivery: { bindings, characters: people, onBindings: () => {} },
  participationDelivery: { participation, characters: people, onParticipation: (value) => { repairedParticipation = value; } },
  request: async (system) => {
    protocolRequests += 1;
    assert.match(system, /characterParticipation/u);
    return JSON.stringify({ h3Prompt: changedZh, identityBindings: bindings, characterParticipation: changedParticipation });
  },
}), changedZh);
assert.equal(protocolRequests, 1, 'protocol and participation repair share the one existing request');
assert.deepEqual(repairedParticipation, changedParticipation);
await assert.rejects(repairH3PromptProtocolWithAi({
  candidatePrompt: zh.replace('overall_soundscape:', 'invalid_soundscape:'), formatReferencePrompt: zh, language: '中文', maxAttempts: 1,
  identityDelivery: { bindings, characters: people, onBindings: () => assert.fail('failed metadata cannot be accepted') },
  participationDelivery: { participation, characters: people, onParticipation: () => assert.fail('failed metadata cannot be accepted') },
  request: async () => JSON.stringify({ h3Prompt: zh, identityBindings: bindings }),
}), /缺少characterParticipation/u);

const canonical = '【0s-15s】主体：@石台 正在 [空旷的石台静止]；空间：洞窟；光影：冷光；镜头：远景固定；台词：无；音效：无\n【15s-30s】主体：@夏提雅 正在 [站在石台上]；空间：洞窟；光影：冷光；镜头：中景固定；台词：无；音效：无';
const board: Storyboard = {
  id: 'board', sceneId: 'scene', sourceStoryContent: '空旷石台。夏提雅站在石台上。', workflow: 'drama', inputMode: 'text',
  durationSec: 30, durationPreset: 'custom', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  shots: canonical.split('\n').map((prompt, index) => ({ id: `shot-${index + 1}`, index: index + 1,
    startSec: index * 15, endSec: (index + 1) * 15, prompt, subject: index ? '夏提雅' : '石台',
    action: index ? '夏提雅站在石台上' : '空旷的石台静止', purpose: '', camera: '固定', lighting: '冷光', sound: '无',
    result: '', transition: '', referenceAssetIds: [], locked: false,
  })),
};
const context = { characters: people, assets: [] };
const official = applyOfficialH3Prompt(board, context);
let reviews = 0; let translations = 0;
const result = await generateSingleSegmentPrompt({ board: official, context, purpose: 'dialogue-repair', clean: (value) => value,
  request: async (system, _user, stage) => {
    if (stage === 'review') {
      reviews += 1;
      assert.match(system, /characterParticipation/u);
      return JSON.stringify({ canonicalPrompt: canonical, h3Prompt: zh, identityBindings: bindings,
        characterParticipation: participation, shotSourceIds: [['shot-1'], ['shot-2']] });
    }
    translations += 1;
    throw new Error('Synthetic offline English failure');
  },
});
assert.equal(reviews, 1, 'valid participation rides the existing delivery call without another review');
assert.equal(translations, 1);
assert.deepEqual(result.h3CharacterParticipation, snapshot);
assert.equal(result.officialPromptZh, zh);
assert.equal(board.officialPromptZh, undefined, 'the caller retains its immutable saved board');

let pairedReviews = 0;
const missingIdentityZh = zh.replace(`${anchor} `, '');
const repaired = await generateSingleSegmentPrompt({ board: official, context, purpose: 'dialogue-repair', clean: (value) => value,
  request: async (_system, _user, stage) => {
    if (stage === 'translate') throw new Error('Synthetic offline English failure');
    pairedReviews += 1;
    return JSON.stringify({ canonicalPrompt: canonical, h3Prompt: missingIdentityZh,
      characterParticipation: participation, shotSourceIds: [['shot-1'], ['shot-2']] });
  },
});
assert.equal(pairedReviews, 1, 'missing auxiliary identities do not trigger automatic content-repair requests');
assert.equal(repaired.officialPromptZh, missingIdentityZh, 'the AI-authored body is preserved without adding a local identity sentence');
assert.equal(repaired.h3IdentityBindings, undefined, 'missing associations are not invented');
assert.deepEqual(repaired.h3CharacterParticipation, stampCharacterParticipation(missingIdentityZh, participation));
assert.match((repaired.h3DeliveryWarnings || []).join(' '), /身份绑定.*正文.*关联待完善/u);
console.log('Character participation tests passed (actual legacy excerpts, unambiguous aliases, screen scope, later-shot identities and single delivery persistence).');
