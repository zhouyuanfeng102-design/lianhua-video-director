import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supplementStoryboardImageCharacterReferences } from '../src/storyboardImageCharacterReferences';
import { buildStoryboardImagePromptWithReferences } from '../src/storyboardImageReferences';
import { completeStoryboardImageReferenceInputs } from '../src/storyboardImageReferenceCompletion';
import { mergeStoryboardReferenceInputs, resolveStoryboardReferenceInputs } from '../src/storyboardImages';
import { createImageReferenceAssetSnapshot, imageReferenceSnapshotAssets } from '../src/imageGeneration';
import type { Character, ReferenceAsset } from '../src/types';

const character = (id: string, name = id, patch: Partial<Character> = {}): Character => ({
  id, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '', personality: '',
  motionHabits: '', signatureProps: '', anchor: '', negativeContinuity: '', assetIds: [], ...patch,
});
const image = (id: string, owner?: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'character', mediaType: 'image', tags: [],
  dataUrl: 'data:image/png;base64,AAAA', createdAt: 1, updatedAt: 1,
  ...(owner ? { sourceEntityKind: 'character', sourceEntityId: owner } : {}), ...patch,
});

test('final storyboard, first-frame and last-frame prose supplies omitted supporting character references', () => {
  const actors = [character('king', '贝里洛'), character('shalltear', '夏提雅'), character('aura', '亚乌拉')];
  const assets = [image('king-image', 'king'), image('scene', undefined, { role: 'scene' }),
    image('shalltear-image', 'shalltear'), image('aura-image', 'aura')];
  for (const prose of ['分镜：贝里洛前景背影，远处的夏提雅与亚乌拉站在军阵前。',
    '首帧：夏提雅和亚乌拉出现在背景，贝里洛右侧背影在前景。',
    '尾帧：贝里洛回头，夏提雅举枪，亚乌拉仍在她身旁。']) {
    assert.deepEqual(supplementStoryboardImageCharacterReferences(prose, ['king-image', 'scene'], { characters: actors, assets }),
      ['king-image', 'scene', 'shalltear-image', 'aura-image']);
  }
});

test('program upload metadata does not turn absent characters into reference candidates or alter prose', () => {
  const actors = [character('visible', '夏提雅'), character('metadata-only', '亚乌拉')];
  const assets = [image('visible-image', 'visible'), image('metadata-image', 'metadata-only')];
  const prompt = buildStoryboardImagePromptWithReferences('夏提雅侧身站立。', [assets[1]], { characters: actors });
  const original = prompt;
  assert.deepEqual(supplementStoryboardImageCharacterReferences(prompt, [], { characters: actors, assets }), ['visible-image']);
  assert.equal(prompt, original);
});

test('unique saved aliases and case-insensitive English aliases match while word substrings do not', () => {
  const actors = [character('shalltear', '夏提雅', { aliases: ['Shalltear'], dossier: { aliases: ['鲜血帝后'] } }),
    character('ann', 'Ann'), character('al', 'Al')];
  const assets = actors.map((actor) => image(`${actor.id}-image`, actor.id));
  assert.deepEqual(supplementStoryboardImageCharacterReferences('SHALLTEAR stands behind Ann. Alfred is nearby.', [], { characters: actors, assets }),
    ['shalltear-image', 'ann-image']);
  assert.deepEqual(supplementStoryboardImageCharacterReferences('鲜血帝后站在前景。', [], { characters: actors, assets }), ['shalltear-image']);
  assert.deepEqual(supplementStoryboardImageCharacterReferences('annual tall Shalltearish', [], { characters: actors, assets }), []);
});

test('longest known names block contained short names and shared aliases stay ambiguous', () => {
  const actors = [character('short', '小白'), character('long', '小白龙'),
    character('one', '甲', { aliases: ['师父'] }), character('two', '乙', { aliases: ['师父'] })];
  const assets = actors.map((actor) => image(`${actor.id}-image`, actor.id));
  assert.deepEqual(supplementStoryboardImageCharacterReferences('小白龙站在师父身前。', [], { characters: actors, assets }), ['long-image']);
  assert.deepEqual(supplementStoryboardImageCharacterReferences('小白龙与小白并肩站立。', [], { characters: actors, assets }), ['short-image', 'long-image']);
});

test('explicit offscreen and mention-only occurrences are excluded, but visible occurrences elsewhere survive', () => {
  const actors = [character('hero', '夏提雅', { aliases: ['Shalltear'] }), character('other', '亚乌拉')];
  const assets = actors.map((actor) => image(`${actor.id}-image`, actor.id));
  for (const prose of ['画外的夏提雅发出声音。', '夏提雅未入镜，镜头只拍石壁。',
    '夏提雅不在画面中。', '夏提雅明确位于画外。', '仅提及夏提雅。', '夏提雅仅被提及。',
    'Shalltear is offscreen.', 'Off-screen Shalltear speaks.', 'Shalltear, outside the frame.']) {
    assert.deepEqual(supplementStoryboardImageCharacterReferences(prose, [], { characters: actors, assets }), [], prose);
  }
  assert.deepEqual(supplementStoryboardImageCharacterReferences('夏提雅看向画外的亚乌拉。', [], { characters: actors, assets }), ['hero-image']);
  assert.deepEqual(supplementStoryboardImageCharacterReferences('画外的夏提雅说话。下一画面夏提雅侧背影清楚可见。', [], { characters: actors, assets }), ['hero-image']);
});

test('current bindings override generation provenance, including cleared and stale bindings', () => {
  const actors = [character('old', '原人物', { assetIds: ['rebound', 'cleared', 'stale'] }), character('new', '当前人物')];
  const assets = [image('rebound', 'old', { characterReferenceId: 'new' }),
    image('cleared', 'old', { characterReferenceId: null }), image('stale', 'old', { characterReferenceId: 'missing' })];
  assert.deepEqual(supplementStoryboardImageCharacterReferences('原人物和当前人物站立。', [], { characters: actors, assets }), ['rebound']);
  assert.deepEqual(supplementStoryboardImageCharacterReferences('当前人物站立。', ['rebound', 'rebound'], { characters: actors, assets }), ['rebound', 'rebound']);
});

test('current bound-image order wins over creation time; provenance fallback picks only the newest ordinary usable image', () => {
  const actors = [character('bound', '绑定人物', { assetIds: ['preferred', 'newer'] }), character('unbound', '来源人物')];
  const assets = [image('preferred', 'bound', { createdAt: 1 }), image('newer', 'bound', { createdAt: 100 }),
    image('old', 'unbound'), image('latest', 'unbound', { createdAt: 20 }),
    image('missing', 'unbound', { createdAt: 30, missing: true }),
    image('empty', 'unbound', { createdAt: 40, dataUrl: undefined }),
    image('private', 'unbound', { createdAt: 50, imageVariant: 'private-four-in-one', referenceScope: 'nsfw-private-profile' })];
  assert.deepEqual(supplementStoryboardImageCharacterReferences('绑定人物和来源人物站立。', ['scene'], { characters: actors, assets }),
    ['scene', 'preferred', 'latest']);
});

test('archived records and unbound historical compositions never supply an automatic identity image', () => {
  const actors = [character('active', '夏提雅'), character('archived', '亚乌拉', { dossier: { archivedIntoCharacterId: 'active' } })];
  const assets = [image('history', undefined, { name: '夏提雅分镜图', role: 'composition',
    source: 'generated', sourceStoryboardId: 'board', sourceShotId: 'shot' }),
  image('archived-image', 'archived'), image('audio', 'active', { mediaType: 'audio', type: 'audio' })];
  assert.deepEqual(supplementStoryboardImageCharacterReferences('夏提雅和亚乌拉站在背景。', ['chosen'], { characters: actors, assets }), ['chosen']);
});

test('an explicitly bound historical composition remains a valid current character reference', () => {
  const actor = character('active', '夏提雅', { assetIds: ['bound-history'] });
  const asset = image('bound-history', undefined, { role: 'composition', source: 'generated', sourceStoryboardId: 'board' });
  assert.deepEqual(supplementStoryboardImageCharacterReferences('夏提雅站在背景。', [], { characters: [actor], assets: [asset] }), ['bound-history']);
});

test('completed references load supporting-character pixels in metadata order and retain the original primary count', async () => {
  const actors = [character('king', '贝里洛'), character('shalltear', '夏提雅'), character('aura', '亚乌拉')];
  const assets = [image('king-image', 'king'), image('scene', undefined, { role: 'scene' }),
    image('shalltear-image', 'shalltear'), image('aura-image', 'aura')]
    .map((asset) => ({ ...asset, dataUrl: undefined, relativePath: `${asset.id}.png` }));
  const pixels: Record<string, string> = {
    'king-image.png': 'data:image/png;base64,S0lORw==', 'scene.png': 'data:image/png;base64,U0NFTkU=',
    'shalltear-image.png': 'data:image/png;base64,U0hBTExURUFS', 'aura-image.png': 'data:image/png;base64,QVVSQQ==',
  };
  const reads: string[] = [];
  const loader = { readManagedImageDataUrl: async ({ relativePath }: { relativePath: string }) => {
    reads.push(relativePath);
    return pixels[relativePath];
  } };
  const references = mergeStoryboardReferenceInputs(
    await resolveStoryboardReferenceInputs(['king-image'], assets, loader),
    await resolveStoryboardReferenceInputs(['scene'], assets, loader),
  );
  const before = structuredClone(references);
  const prompt = '贝里洛前景背影，夏提雅和亚乌拉站在远处洞窟中。';
  const completed = await completeStoryboardImageReferenceInputs(prompt, references, { characters: actors, assets }, loader);
  assert.deepEqual(reads, ['king-image.png', 'scene.png', 'shalltear-image.png', 'aura-image.png']);
  assert.deepEqual(completed.referenceAssets.map((asset) => asset.id), ['king-image', 'scene', 'shalltear-image', 'aura-image']);
  assert.deepEqual(completed.referenceImages, Object.values(pixels));
  assert.equal(completed.primaryReferenceImageCount, 1);
  const finalPrompt = buildStoryboardImagePromptWithReferences(prompt, completed.referenceAssets, { characters: actors });
  assert.match(finalPrompt, /1\. 人物 "贝里洛"[^\n]*\n2\. "scene"[^\n]*\n3\. 人物 "夏提雅"[^\n]*\n4\. 人物 "亚乌拉"/u);
  assert.deepEqual(references, before, 'completion must not mutate the already loaded input arrays');
  assert.equal(prompt, '贝里洛前景背影，夏提雅和亚乌拉站在远处洞窟中。');
});

test('a supporting reference load failure stops submission rather than silently dropping that identity image', async () => {
  const actor = character('shalltear', '夏提雅');
  const assets = [image('scene', undefined, { role: 'scene' }),
    image('shalltear-image', actor.id, { dataUrl: undefined, relativePath: 'unreadable.png' })];
  const references = { referenceImages: [assets[0].dataUrl!], referenceAssets: [assets[0]], primaryReferenceImageCount: 1 };
  const before = structuredClone(references);
  await assert.rejects(() => completeStoryboardImageReferenceInputs('夏提雅侧身站立。', references,
    { characters: [actor], assets }, { readManagedImageDataUrl: async () => { throw new Error('reference disk read failed'); } }),
  /reference disk read failed/u);
  assert.deepEqual(references, before);
});

test('duplicate supporting pixels and their metadata coalesce together within additions and against primary images', async () => {
  const actors = [character('king', '贝里洛'), character('shalltear', '夏提雅'), character('aura', '亚乌拉')];
  const primaryPixels = 'data:image/png;base64,S0lORw==';
  const scenePixels = 'data:image/png;base64,U0NFTkU=';
  const supportPixels = 'data:image/png;base64,U1VQUE9SVA==';
  for (const [firstPixels, secondPixels, retainedId] of [
    [primaryPixels, supportPixels, 'aura-image'], [supportPixels, supportPixels, 'shalltear-image'],
  ]) {
    const assets = [image('king-image', 'king', { dataUrl: primaryPixels }),
      image('scene', undefined, { role: 'scene', dataUrl: scenePixels }),
      image('shalltear-image', 'shalltear', { dataUrl: undefined, relativePath: 'shalltear.png' }),
      image('aura-image', 'aura', { dataUrl: undefined, relativePath: 'aura.png' })];
    const references = { referenceImages: [primaryPixels, scenePixels], referenceAssets: assets.slice(0, 2), primaryReferenceImageCount: 1 };
    const before = structuredClone(references);
    const completed = await completeStoryboardImageReferenceInputs('贝里洛、夏提雅和亚乌拉同框。', references,
      { characters: actors, assets }, { readManagedImageDataUrl: async ({ relativePath }) => relativePath === 'shalltear.png' ? firstPixels : secondPixels });
    assert.deepEqual(completed.referenceImages, [primaryPixels, scenePixels, supportPixels]);
    assert.deepEqual(completed.referenceAssets.map((asset) => asset.id), ['king-image', 'scene', retainedId]);
    assert.equal(completed.referenceImages.length, completed.referenceAssets.length);
    assert.equal(completed.primaryReferenceImageCount, 1);
    assert.deepEqual(references, before);
  }
});

test('reference snapshots retain explicit string and cleared bindings instead of restoring old provenance ownership', () => {
  const actors = [character('old', '原人物', { assetIds: ['rebound', 'cleared', 'old-current'] }),
    character('new', '当前人物', { assetIds: ['new-current'] })];
  const reboundSnapshot = createImageReferenceAssetSnapshot(image('rebound', 'old', { characterReferenceId: 'new' }),
    { relativePath: 'references/rebound.png', checksum: 'a'.repeat(64) });
  const clearedSnapshot = createImageReferenceAssetSnapshot(image('cleared', 'old', { characterReferenceId: null }),
    { relativePath: 'references/cleared.png', checksum: 'b'.repeat(64) });
  assert.equal(reboundSnapshot.characterReferenceId, 'new');
  assert.equal(clearedSnapshot.characterReferenceId, null);
  const restored = imageReferenceSnapshotAssets([reboundSnapshot, clearedSnapshot]);
  assert.equal(restored[0].characterReferenceId, 'new');
  assert.equal(restored[1].characterReferenceId, null);
  const assets = [...restored, image('old-current', 'old'), image('new-current', 'new')];
  assert.deepEqual(supplementStoryboardImageCharacterReferences('当前人物站在前景。', ['rebound'], { characters: actors, assets }), ['rebound'],
    'the rebound snapshot already covers the current owner without adding their other image');
  assert.deepEqual(supplementStoryboardImageCharacterReferences('原人物站在前景。', ['cleared'], { characters: actors, assets }), ['cleared', 'old-current'],
    'cleared ownership cannot count as identity coverage or supply the historical source character');
  assert.deepEqual(supplementStoryboardImageCharacterReferences('原人物站在前景。', [], { characters: actors, assets: restored }), [],
    'neither a rebound nor a cleared snapshot reclaims its historical source entity');
});
