import type { Character, Project, ReferenceAsset, Scene, SemanticSequenceCharacter, Storyboard } from './types';

/** Explicit allowlist: identity, form metadata and private dossiers are never copied as ordinary fields. */
export const CHARACTER_DOSSIER_FIELDS = [
  { key: 'gender', label: '性别' }, { key: 'apparentAge', label: '外观年龄' },
  { key: 'actualAge', label: '实际年龄' }, { key: 'height', label: '身高／高度' },
  { key: 'race', label: '种族／族裔' }, { key: 'morphology', label: '外貌形态' },
  { key: 'bodyPlan', label: '身体结构说明' }, { key: 'appearance', label: '详细外观' },
  { key: 'outfit', label: '常驻服装' }, { key: 'signatureProps', label: '关键道具' },
  { key: 'personality', label: '性格气质' }, { key: 'motionHabits', label: '动作习惯' },
  { key: 'anchor', label: '连续性锚点' }, { key: 'negativeContinuity', label: '连续性限制' },
] as const;
export type CharacterDossierField = typeof CHARACTER_DOSSIER_FIELDS[number]['key'];
export interface CharacterDossierApplicationOptions {
  sourceCharacterId: string;
  targetCharacterId: string;
  mode: 'copy' | 'transfer';
  fields?: CharacterDossierField[];
  clearEmpty?: boolean;
  applyReferenceImages?: boolean;
  now?: number;
}
export interface CharacterDossierApplicationPreview {
  source: Character;
  target: Character;
  changes: Array<{ field: CharacterDossierField; label: string; before: string; after: string }>;
  affectedSceneIds: string[];
  affectedStoryboardIds: string[];
  affectedSegmentIds: string[];
  referenceAssetIds: string[];
  warnings: string[];
}

const unique = (values: string[]): string[] => [...new Set(values)];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const dossierKey = (key: CharacterDossierField): string => ({ apparentAge: 'age', signatureProps: 'props', motionHabits: 'motion' } as Partial<Record<CharacterDossierField, string>>)[key] || key;
const fieldsFor = (options: CharacterDossierApplicationOptions): CharacterDossierField[] => {
  const fields = options.fields ?? CHARACTER_DOSSIER_FIELDS.map((field) => field.key);
  if (!Array.isArray(fields) || fields.some((key) => !CHARACTER_DOSSIER_FIELDS.some((field) => field.key === key))) {
    throw new Error('仅支持应用列出的普通人物资料字段。');
  }
  return [...new Set(fields)];
};
const ordinaryReference = (asset: ReferenceAsset): boolean => asset.referenceScope !== 'nsfw-private-profile'
  && !asset.nsfwPrivatePart && !asset.imageVariant?.startsWith('private-')
  && (!asset.mediaType || asset.mediaType === 'image') && ['character', 'reference'].includes(asset.type);
const characterReferences = (project: Project, character: Character): ReferenceAsset[] => project.assets.filter((asset) =>
  character.assetIds.includes(asset.id) && ordinaryReference(asset));
const sceneUses = (scene: Scene, ids: Set<string>): boolean => scene.characterIds.some((id) => ids.has(id));
const sourceHasStoryBindings = (project: Project, source: Character): boolean => project.scenes.some((scene) => scene.characterIds.includes(source.id)
  || source.name.trim() && [scene.content, scene.summary].some((value) => value.includes(source.name)))
  || project.sequencePlans.some((plan) => plan.semanticPlanningSnapshot?.characterContinuity.some((item) => item.id === source.id || item.name === source.name))
  || project.storyboards.some((board) => board.sourceSceneSnapshots?.some((scene) => scene.characterIds.includes(source.id))
    || [board.h3IdentityBindings, board.h3IdentityBindingsEn].some((binding) => binding?.characters.some((item) => item.characterId === source.id))
    || [board.finalPrompt, board.officialPromptZh, board.officialPromptEn, ...board.shots.map((shot) => shot.subject)]
      .some((value) => source.name.trim() && value?.includes(source.name)));
const boardUses = (board: Storyboard, sceneIds: Set<string>, characterIds: Set<string>, referenceIds: Set<string>, names: string[]): boolean =>
  sceneIds.has(board.sceneId) || board.sourceSceneIds?.some((id) => sceneIds.has(id)) === true
  || board.sourceSceneSnapshots?.some((scene) => sceneUses(scene, characterIds)) === true
  || [board.h3IdentityBindings, board.h3IdentityBindingsEn].some((binding) => binding?.characters.some((item) => characterIds.has(item.characterId)))
  || [board.finalPrompt, board.officialPromptZh, board.officialPromptEn, ...board.shots.map((shot) => shot.subject)]
    .some((value) => names.some((name) => name.trim() && value?.includes(name)))
  || [...(board.globalReferenceAssetIds || []), ...(board.imageToImage?.referenceAssetIds || []),
    ...(board.promptPlan?.referenceAssetIds || []), ...(board.promptTrace?.referenceAssetIds || []), board.firstFrameAssetId || '', board.lastFrameAssetId || '',
    ...Object.values(board.imageToImage?.referenceAssetIdsByShotId || {}).flat(), ...board.shots.flatMap((shot) => shot.referenceAssetIds)]
    .some((id) => referenceIds.has(id));

export const previewCharacterDossierApplication = (
  project: Project, options: CharacterDossierApplicationOptions,
): CharacterDossierApplicationPreview => {
  if (!['copy', 'transfer'].includes(options.mode)) throw new Error('未知的人物资料应用方式。');
  if (options.sourceCharacterId === options.targetCharacterId) throw new Error('请选择另一个剧情人物作为目标。');
  const exact = (id: string): Character => {
    const matches = project.characters.filter((character) => character.id === id);
    if (matches.length !== 1) throw new Error('人物不存在或编号重复，请重新选择人物。');
    if (matches[0].dossier?.archivedIntoCharacterId) throw new Error('该人物已转移绑定，请选择当前使用的人物。');
    return matches[0];
  };
  const source = exact(options.sourceCharacterId), target = exact(options.targetCharacterId);
  if (options.mode === 'transfer' && sourceHasStoryBindings(project, source)) {
    throw new Error('该自建人物已经独立绑定剧情或分镜，不能同时接管另一个人物身份；请使用“覆盖资料，保留原绑定”，或选择尚未绑定剧情的自建人物。');
  }
  const changedFields = fieldsFor(options).filter((key) => (options.clearEmpty || text(source[key]).trim())
    && text(source[key]) !== text(target[key]));
  const changes = changedFields.map((field) => ({ field,
    label: CHARACTER_DOSSIER_FIELDS.find((item) => item.key === field)!.label,
    before: text(target[field]), after: text(source[field]),
  }));
  const characterIds = new Set(options.mode === 'transfer' ? [target.id, source.id] : [target.id]);
  const affectedSceneIds = project.scenes.filter((scene) => sceneUses(scene, characterIds)).map((scene) => scene.id);
  const sceneIds = new Set(affectedSceneIds);
  const referenceIds = new Set([...characterReferences(project, target), ...(options.mode === 'transfer' ? characterReferences(project, source) : [])].map((asset) => asset.id));
  const affectedStoryboardIds = project.storyboards.filter((board) => boardUses(board, sceneIds, characterIds, referenceIds,
    options.mode === 'transfer' ? [target.name, source.name] : [target.name])).map((board) => board.id);
  const affectedBoards = new Set(affectedStoryboardIds);
  const affectedSegmentIds: string[] = [];
  for (const plan of project.sequencePlans) {
    const usesSnapshot = plan.semanticPlanningSnapshot?.characterContinuity.some((item) =>
      item.id ? characterIds.has(item.id) : item.name === target.name || (options.mode === 'transfer' && item.name === source.name));
    for (const segment of plan.segments) {
      if (usesSnapshot || segment.sourceSceneIds.some((id) => sceneIds.has(id)) || segment.storyboardId && affectedBoards.has(segment.storyboardId)) {
        affectedSegmentIds.push(segment.id);
        if (segment.storyboardId) affectedBoards.add(segment.storyboardId);
      }
    }
    if (usesSnapshot && plan.masterStoryboardId) affectedBoards.add(plan.masterStoryboardId);
  }
  return { source, target, changes, affectedSceneIds, affectedStoryboardIds: [...affectedBoards],
    affectedSegmentIds: unique(affectedSegmentIds), referenceAssetIds: characterReferences(project, options.applyReferenceImages ? source : target).map((asset) => asset.id),
    warnings: [
      ...(options.mode === 'transfer' ? ['自建人物接管目标的剧情名称和形态，原自建名称保留为别名；旧人物保留为历史记录。'] : []),
      ...(options.applyReferenceImages && !characterReferences(project, source).length ? ['自建人物没有普通参考图；应用后将取消目标普通参考图的默认使用，旧图仍保留在资产库。'] : []),
      ...(affectedBoards.size ? ['已有提示词保留原文并标记待刷新，已有生成任务和成片不变。'] : []),
    ],
  };
};

const semanticCharacter = (character: Character): SemanticSequenceCharacter => ({
  id: character.id, name: character.name, baseName: character.baseName, formLabel: character.formLabel,
  variantOf: character.variantOf, transformationType: character.transformationType,
  ...Object.fromEntries(CHARACTER_DOSSIER_FIELDS.map(({ key }) => [key, character[key]])),
});

/** Immutable editor transaction; the App's existing history owns undo. No historical delivery is rewritten. */
export const applyCharacterDossierApplication = (project: Project, options: CharacterDossierApplicationOptions): Project => {
  const preview = previewCharacterDossierApplication(project, options);
  const { source, target } = preview;
  const now = options.now ?? Date.now();
  const transfer = options.mode === 'transfer';
  const finalId = transfer ? source.id : target.id;
  const fields = fieldsFor(options).filter((key) => options.clearEmpty || text(source[key]).trim());
  const values = Object.fromEntries(fields.map((key) => [key, text(source[key])]));
  const fieldSources = { ...target.dossier?.fieldSources };
  for (const field of fields) fieldSources[dossierKey(field)] = source.dossier?.fieldSources?.[dossierKey(field)] || 'manual';
  const selectedReferences = characterReferences(project, options.applyReferenceImages ? source : target);
  const addedAssets: ReferenceAsset[] = [];
  const occupiedIds = new Set(project.assets.map((asset) => asset.id));
  const attach = (asset: ReferenceAsset): string => {
    if (asset.sourceEntityId === finalId && asset.sourceEntityKind === 'character') return asset.id;
    const existing = project.assets.find((item) => item.linkedFromAssetId === asset.id
      && item.sourceEntityId === finalId && ordinaryReference(item)
      && item.relativePath === asset.relativePath && item.checksum === asset.checksum && item.dataUrl === asset.dataUrl && item.url === asset.url);
    if (existing) return existing.id;
    const base = `dossier_reference_${finalId}_${asset.id}`;
    let id = base, suffix = 1;
    while (occupiedIds.has(id)) id = `${base}_${suffix++}`;
    occupiedIds.add(id);
    // This is an association to existing pixels, not a second generation or a rewritten provenance record.
    addedAssets.push({ id, name: asset.name, type: 'character', role: 'character', sourceEntityKind: 'character',
      sourceEntityId: finalId, linkedFromAssetId: asset.id, source: 'derived', mediaType: 'image', referenceRole: 'character',
      referenceScope: 'general', fileName: asset.fileName, dataUrl: asset.dataUrl, url: asset.url, relativePath: asset.relativePath,
      checksum: asset.checksum, sizeBytes: asset.sizeBytes, managed: asset.managed, missing: asset.missing,
      mimeType: asset.mimeType, width: asset.width, height: asset.height, imageVariant: asset.imageVariant,
      visualAnchor: asset.visualAnchor, tags: [...asset.tags], createdAt: now, updatedAt: now });
    return id;
  };
  const changeReferences = transfer || options.applyReferenceImages === true;
  const finalReferenceIds = changeReferences ? selectedReferences.map(attach) : selectedReferences.map((asset) => asset.id);
  const finalBase = transfer ? source : target;
  const privateOrOtherIds = finalBase.assetIds.filter((id) => !project.assets.some((asset) => asset.id === id && ordinaryReference(asset)));
  const applied: Character = {
    ...finalBase,
    ...(transfer ? { ...Object.fromEntries(CHARACTER_DOSSIER_FIELDS.map(({ key }) => [key, target[key]])),
      name: target.name, baseName: target.baseName, formLabel: target.formLabel,
      variantOf: target.variantOf, transformationType: target.transformationType } : {}),
    ...values,
    assetIds: changeReferences ? unique([...privateOrOtherIds, ...finalReferenceIds]) : target.assetIds,
    dossier: { ...(transfer ? source.dossier : target.dossier),
      confirmedFields: unique([...(target.dossier?.confirmedFields || []), ...fields.map(dossierKey)]), fieldSources,
      aliases: unique([...(finalBase.dossier?.aliases || []), ...(transfer ? [source.name, ...(target.dossier?.aliases || [])] : [])]).filter((name) => name !== target.name),
      updatedAt: now },
  };
  const affectedBoards = new Set(preview.affectedStoryboardIds), affectedSegments = new Set(preview.affectedSegmentIds);
  const affectedScenes = new Set(preview.affectedSceneIds);
  const replaceId = (id: string): string => transfer && id === target.id ? source.id : id;
  const migrateScene = (scene: Scene): Scene => transfer && scene.characterIds.includes(target.id)
    ? { ...scene, characterIds: unique(scene.characterIds.map(replaceId)), updatedAt: now } : scene;
  const oldReferenceIds = new Set(characterReferences(project, target).map((asset) => asset.id));
  if (transfer) for (const asset of characterReferences(project, source)) oldReferenceIds.add(asset.id);
  const migrateRefs = (ids: string[]): string[] => changeReferences && ids.some((id) => oldReferenceIds.has(id))
    ? unique([...ids.filter((id) => !oldReferenceIds.has(id)), ...finalReferenceIds]) : ids;
  const migrateBoundary = (id: string | undefined): string | undefined => id && changeReferences && oldReferenceIds.has(id) ? finalReferenceIds[0] : id;
  const mappedCharacters = project.characters.map((character) => character.id === finalId ? applied
    : transfer && character.id === target.id ? { ...character, dossier: { ...character.dossier, archivedIntoCharacterId: finalId, updatedAt: now } } : character);
  const characters = transfer ? [...mappedCharacters.filter((character) => !character.dossier?.archivedIntoCharacterId),
    ...mappedCharacters.filter((character) => character.dossier?.archivedIntoCharacterId)] : mappedCharacters;
  const storyboards = project.storyboards.map((board): Storyboard => {
    if (!affectedBoards.has(board.id)) return board;
    const migrateBindings = (bindings: Storyboard['h3IdentityBindings']) => bindings && transfer ? { ...bindings,
      characters: bindings.characters.map((item) => item.characterId === target.id ? { ...item, characterId: finalId } : item) } : bindings;
    return { ...board, updatedAt: now,
      characterDossierDirty: { characterIds: unique([...(board.characterDossierDirty?.characterIds || []).map(replaceId), finalId]), updatedAt: now },
      sourceSceneSnapshots: board.sourceSceneSnapshots?.map(migrateScene),
      h3IdentityBindings: migrateBindings(board.h3IdentityBindings), h3IdentityBindingsEn: migrateBindings(board.h3IdentityBindingsEn),
      globalReferenceAssetIds: board.globalReferenceAssetIds && migrateRefs(board.globalReferenceAssetIds),
      firstFrameAssetId: migrateBoundary(board.firstFrameAssetId), lastFrameAssetId: migrateBoundary(board.lastFrameAssetId),
      promptPlan: board.promptPlan && { ...board.promptPlan, referenceAssetIds: migrateRefs(board.promptPlan.referenceAssetIds) },
      promptTrace: board.promptTrace && { ...board.promptTrace, referenceAssetIds: migrateRefs(board.promptTrace.referenceAssetIds) },
      imageToImage: board.imageToImage && { ...board.imageToImage, referenceAssetIds: migrateRefs(board.imageToImage.referenceAssetIds),
        referenceAssetIdsByShotId: Object.fromEntries(Object.entries(board.imageToImage.referenceAssetIdsByShotId).map(([id, ids]) => [id, migrateRefs(ids)])) },
      shots: board.shots.map((shot) => ({ ...shot, referenceAssetIds: migrateRefs(shot.referenceAssetIds) })),
    };
  });
  const sequencePlans = project.sequencePlans.map((plan) => {
    if (!plan.segments.some((segment) => affectedSegments.has(segment.id)) && !affectedBoards.has(plan.masterStoryboardId || '')) return plan;
    const replaceSemantic = (item: SemanticSequenceCharacter): SemanticSequenceCharacter =>
      item.id === target.id || transfer && item.id === source.id || !item.id && item.name === target.name ? semanticCharacter(applied) : item;
    const cached = plan.semanticPlanningSnapshot?.characterContinuity.map(replaceSemantic);
    return { ...plan, updatedAt: now, reviewConfirmedFingerprint: undefined, reviewConfirmedAt: undefined,
      semanticPlanningSnapshot: plan.semanticPlanningSnapshot && { ...plan.semanticPlanningSnapshot,
        characterContinuity: cached!.filter((item, index) => !item.id || cached!.findIndex((other) => other.id === item.id) === index) },
      segments: plan.segments.map((segment) => affectedSegments.has(segment.id) && segment.status !== 'generating'
        ? { ...segment, status: 'stale' as const, failureReason: '人物资料已更新，提示词待刷新。' } : segment),
    };
  });
  return { ...project, characters, scenes: project.scenes.map((scene) => affectedScenes.has(scene.id) ? migrateScene(scene) : scene),
    storyboards, sequencePlans, assets: addedAssets.length ? [...project.assets, ...addedAssets] : project.assets, updatedAt: now };
};
