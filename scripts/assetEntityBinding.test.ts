import assert from 'node:assert/strict';
import {
  assetReferenceCharacterOwners, assetReferenceEntityOwners, assetReferenceLocationOwners, assetReferencePropOwners,
  bindAssetCharacter, bindAssetEntity,
} from '../src/assetCharacterBinding';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { videoImageRole } from '../src/videoDirectorDraft';
import { videoReferenceLocationOwners, videoReferenceSceneReplacement } from '../src/videoH3ReferenceBinding';
import { buildStoryboardImagePromptWithReferences, storyboardImageReferenceRole, storyboardReferenceCharacters } from '../src/storyboardImageReferences';
import { directStoryboardImageSourceFingerprint } from '../src/storyboardImageToImage';
import { buildVideoSceneContext } from '../src/videoSceneContext';
import { createImageReferenceAssetSnapshot, imageReferenceSnapshotAssets } from '../src/imageGeneration';
import type { Character, Location, Project, Prop, ReferenceAsset } from '../src/types';

let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const character = (id: string, name: string, assetIds: string[] = []): Character => ({ id, name, assetIds,
  gender: '', race: '人类', apparentAge: '成年', appearance: '黑发', outfit: '蓝衣', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const location = (id: string, name: string, assetIds: string[] = []): Location => ({ id, name, assetIds,
  description: '石质廊桥', timeWeather: '晴天', lighting: '自然光', palette: '灰色', fixedProps: '石栏杆', anchor: '桥头石阶' });
const prop = (id: string, name: string, assetIds: string[] = []): Prop => ({ id, name, assetIds,
  category: '道具', material: '金属', appearance: '银色', effect: '无', stateRules: '外观固定' });
const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({ id, name: id,
  type: 'reference', role: 'character', referenceRole: 'character', mediaType: 'image', dataUrl: 'data:image/png;base64,AAAA',
  tags: ['合成测试图片'], createdAt: 1, updatedAt: 1, ...patch });
const fixture = (): Project => {
  const project = createInitialState().project;
  project.id = 'entity-binding-offline';
  project.characters = [character('person-a', '旅人甲', ['legacy-person']), character('person-b', '旅人乙')];
  project.locations = [location('location-a', '廊桥', ['legacy-location']), location('location-b', '庭院')];
  project.props = [prop('prop-a', '银色魔棒', ['legacy-prop']), prop('prop-b', '红色徽章')];
  project.assets = [image('free'), image('legacy-person', { sourceEntityKind: 'character', sourceEntityId: 'person-a' }),
    image('legacy-location', { type: 'location', role: 'scene', referenceRole: 'scene', sourceEntityKind: 'location', sourceEntityId: 'location-a' }),
    image('legacy-prop', { type: 'prop', role: 'prop', referenceRole: 'prop', sourceEntityKind: 'prop', sourceEntityId: 'prop-a' })];
  project.storyboards = [{ id: 'saved-board', shots: [], finalPrompt: '已保存分镜', officialPromptZh: '已保存的中文原稿', officialPromptEn: 'Saved English prompt',
    createdAt: 1, updatedAt: 1 } as Project['storyboards'][number]];
  project.generationTasks = []; project.scenes = []; project.sequencePlans = [];
  return project;
};
const owners = (project: Project, id = 'free') => assetReferenceEntityOwners(project, project.assets.find((asset) => asset.id === id)!)
  .map(({ kind, entity }) => ({ kind, id: entity.id }));

test('人物、场景、物品可跨类型改绑和明确解绑，仅改变图片绑定元数据', () => {
  const original = fixture(); const before = structuredClone(original);
  let project = original;
  for (const binding of [{ kind: 'location', entityId: 'location-b' }, { kind: 'prop', entityId: 'prop-a' },
    { kind: 'character', entityId: 'person-b' }] as const) {
    project = bindAssetEntity(project, 'legacy-person', binding, 2);
    assert.deepEqual(owners(project, 'legacy-person'), [{ kind: binding.kind, id: binding.entityId }]);
    assert.equal(project.characters, original.characters); assert.equal(project.locations, original.locations); assert.equal(project.props, original.props);
    assert.equal(project.storyboards, original.storyboards); assert.equal(project.assets[0], original.assets[0]);
    const { referenceEntityBinding, characterReferenceId, updatedAt, ...preserved } = project.assets[1];
    const { updatedAt: oldUpdatedAt, ...previous } = original.assets[1];
    assert.deepEqual(preserved, previous, 'generation provenance, role, bytes and tags stay unchanged');
    assert.deepEqual(referenceEntityBinding, binding);
    assert.equal(bindAssetEntity(project, 'legacy-person', binding, 3), project, 'saving unchanged binding is a no-op');
  }
  project = bindAssetEntity(project, 'legacy-person', null, 4);
  assert.equal(project.assets[1].referenceEntityBinding, null); assert.deepEqual(owners(project, 'legacy-person'), []);
  assert.equal(bindAssetEntity(project, 'legacy-person', null, 5), project);
  assert.deepEqual(original, before);
});

test('旧项目来源和assetIds继续识别；明确绑定覆盖旧来源和旧人物选择', () => {
  const project = fixture();
  assert.deepEqual(owners(project, 'legacy-person'), [{ kind: 'character', id: 'person-a' }]);
  assert.deepEqual(owners(project, 'legacy-location'), [{ kind: 'location', id: 'location-a' }]);
  assert.deepEqual(owners(project, 'legacy-prop'), [{ kind: 'prop', id: 'prop-a' }]);
  project.assets[0].characterReferenceId = 'person-a';
  const rebound = bindAssetEntity(project, 'free', { kind: 'location', entityId: 'location-b' });
  assert.deepEqual(owners(rebound), [{ kind: 'location', id: 'location-b' }]);
  assert.deepEqual(assetReferenceCharacterOwners(rebound, rebound.assets[0]), []);
  const characterAgain = bindAssetCharacter(rebound, 'free', 'person-b');
  assert.deepEqual(owners(characterAgain), [{ kind: 'character', id: 'person-b' }]);
  assert.deepEqual(owners(bindAssetCharacter(characterAgain, 'free', null)), []);
});

test('场景与物品绑定决定视频参考用途，跨类型改绑不会保留旧场景归属', () => {
  let project = bindAssetEntity(fixture(), 'legacy-location', { kind: 'location', entityId: 'location-b' });
  assert.equal(videoImageRole(project.assets[2]), 'scene');
  assert.deepEqual(videoReferenceLocationOwners(project, project.assets[2]).map((entry) => entry.id), ['location-b']);
  assert.deepEqual(assetReferenceLocationOwners(project, project.assets[2]).map((entry) => entry.id), ['location-b']);
  const sceneContext = buildVideoSceneContext({ assets: project.assets, locations: project.locations, selectedAssetIds: ['legacy-location'] });
  assert.equal(sceneContext.locationSelection, 'linked-locations');
  assert.deepEqual(sceneContext.locations.map((entry) => entry.id), ['location-b'], 'old location assetIds cannot revive the old association');
  assert.equal(sceneContext.references[0].locationId, 'location-b');
  const sameLocation = bindAssetEntity(project, 'free', { kind: 'location', entityId: 'location-b' });
  assert.deepEqual(videoReferenceSceneReplacement(sameLocation, sameLocation.assets[2], [{ assetId: 'free', role: 'scene' }]),
    { scene: true, referenceIndex: 0, preventTailFallback: true }, 'new generic location binding maps to the selected scene despite mirrored character null');
  const staleLocation = { ...project.assets[2], referenceEntityBinding: { kind: 'location' as const, entityId: 'missing-location' } };
  assert.deepEqual(videoReferenceSceneReplacement(project, staleLocation, []), { scene: true, preventTailFallback: true },
    'stale explicit location cannot silently borrow the continuity tail');
  const request = { shotId: 'saved-shot', referenceAssetIds: ['legacy-location'] };
  const fingerprint = directStoryboardImageSourceFingerprint(project.storyboards[0], request, { assets: project.assets });
  project = bindAssetEntity(project, 'legacy-location', { kind: 'prop', entityId: 'prop-b' });
  assert.equal(videoImageRole(project.assets[2]), 'prop');
  assert.deepEqual(assetReferencePropOwners(project, project.assets[2]).map((entry) => entry.id), ['prop-b']);
  assert.deepEqual(videoReferenceLocationOwners(project, project.assets[2]), []);
  assert.equal(videoReferenceSceneReplacement(project, project.assets[2], []).scene, false, 'prop rebind overrides old location category');
  assert.notEqual(directStoryboardImageSourceFingerprint(project.storyboards[0], request, { assets: project.assets }), fingerprint,
    'a changed binding invalidates a frozen image prompt even when source pixels and provenance stay unchanged');
  const propContext = buildVideoSceneContext({ assets: project.assets, locations: project.locations, selectedAssetIds: ['legacy-location'] });
  assert.equal(propContext.locationSelection, 'project-candidates');
  assert.equal(propContext.references[0].locationId, undefined);
  project = bindAssetEntity(project, 'legacy-location', null);
  assert.deepEqual(videoReferenceLocationOwners(project, project.assets[2]), []);
  assert.equal(videoReferenceSceneReplacement(project, project.assets[2], []).scene, false, 'clear overrides old location category');
});

test('失效和重复实体不回落旧绑定；重复图片与非图片不接受绑定', () => {
  for (const kind of ['character', 'location', 'prop'] as const) {
    const project = fixture(); const collection = kind === 'character' ? project.characters : kind === 'location' ? project.locations : project.props;
    const id = collection[0].id;
    assert.throws(() => bindAssetEntity(project, 'free', { kind, entityId: 'missing' }));
    const bound = bindAssetEntity(project, 'legacy-person', { kind, entityId: id });
    collection.push(collection[0] as never);
    assert.deepEqual(owners(bound, 'legacy-person'), []);
    assert.throws(() => bindAssetEntity(project, 'free', { kind, entityId: id }));
    collection.pop(); collection.splice(0, 1);
    assert.deepEqual(owners(bound, 'legacy-person'), [], 'deleted explicit owner cannot fall back to legacy source');
  }
  const project = fixture();
  project.characters[0].dossier = { archivedIntoCharacterId: 'person-b' };
  assert.throws(() => bindAssetEntity(project, 'free', { kind: 'character', entityId: 'person-a' }));
  assert.throws(() => bindAssetEntity({ ...project, assets: [project.assets[0], project.assets[0]] }, 'free', null));
  assert.throws(() => bindAssetEntity({ ...project, assets: [image('video', { type: 'video', mediaType: 'video' })] }, 'video', null));
});

test('保存重载保留明确绑定、解绑与旧来源语义，中文英文原稿不变', () => {
  const state = createInitialState();
  state.project = bindAssetEntity(bindAssetEntity(bindAssetEntity(fixture(), 'free', { kind: 'location', entityId: 'location-b' }, 2), 'legacy-person', null, 3),
    'legacy-prop', { kind: 'prop', entityId: 'prop-b' }, 4);
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const restored = normalizeState(JSON.parse(serializeStateForStorage(normalizeState(state)).serialized));
  assert.deepEqual(owners(restored.project), [{ kind: 'location', id: 'location-b' }]);
  assert.deepEqual(owners(restored.project, 'legacy-person'), []);
  assert.deepEqual(owners(restored.project, 'legacy-prop'), [{ kind: 'prop', id: 'prop-b' }]);
  assert.equal(restored.project.assets[1].referenceEntityBinding, null);
  assert.equal(restored.project.assets[2].referenceEntityBinding, undefined);
  assert.equal(restored.project.storyboards[0].officialPromptZh, '已保存的中文原稿');
  assert.equal(restored.project.storyboards[0].officialPromptEn, 'Saved English prompt');
  assert.deepEqual(normalizeState(restored), restored);
  const snapshots = [restored.project.assets[0], restored.project.assets[1], restored.project.assets[3]].map((asset, index) =>
    createImageReferenceAssetSnapshot(asset, { relativePath: `assets/binding-${index}.png`, checksum: 'a'.repeat(64) }));
  assert.deepEqual(snapshots.map((entry) => entry.referenceEntityBinding), [{ kind: 'location', entityId: 'location-b' }, null, { kind: 'prop', entityId: 'prop-b' }]);
  assert.deepEqual(imageReferenceSnapshotAssets(snapshots).map((entry) => entry.referenceEntityBinding), snapshots.map((entry) => entry.referenceEntityBinding));
});

test('无效存储绑定规范化为明确解绑，不重新关联旧生成来源', () => {
  for (const value of [{ kind: 'scene', entityId: 'location-a' }, { kind: 'location', entityId: '' }, { kind: 'prop' }, 'prop-a', 42, false]) {
    const state = createInitialState(); state.project = fixture();
    (state.project.assets[1] as unknown as Record<string, unknown>).referenceEntityBinding = value;
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    const restored = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.project.assets[1].referenceEntityBinding, null);
    assert.deepEqual(owners(restored.project, 'legacy-person'), []);
  }
});

test('分镜图参考说明使用当前绑定的场景和物品名称，不保留旧人物归属', () => {
  const original = fixture();
  const project = bindAssetEntity(bindAssetEntity(original, 'legacy-person', { kind: 'location', entityId: 'location-b' }), 'free', { kind: 'prop', entityId: 'prop-b' });
  const context = { characters: project.characters, locations: project.locations, props: project.props };
  assert.deepEqual(storyboardReferenceCharacters(project.assets[1], context), []);
  assert.match(storyboardImageReferenceRole(project.assets[1], context), /庭院/u);
  assert.match(storyboardImageReferenceRole(project.assets[0], context), /红色徽章/u);
  const body = '旅人在庭院举起徽章。';
  const prompt = buildStoryboardImagePromptWithReferences(body, [project.assets[1], project.assets[0]], context);
  assert.ok(prompt.startsWith(body)); assert.match(prompt, /庭院/u); assert.match(prompt, /红色徽章/u); assert.doesNotMatch(prompt, /旅人甲/u);
  assert.deepEqual(project.storyboards, original.storyboards);
});

console.log(`PASS ${groups} asset entity binding groups; synthetic data and no provider calls`);
