import { sourceContentHash } from './sourceIntegrity';
import type { Project, ReferenceAsset, Scene } from './types';

const semanticScene = (scene: Scene) => ({
  id: scene.id, title: scene.title, content: scene.content, summary: scene.summary,
  characterIds: scene.characterIds, locationId: scene.locationId,
  locationIds: scene.locationIds, propIds: scene.propIds,
});

const referenceInput = (asset: ReferenceAsset) => ({
  id: asset.id, name: asset.name, type: asset.type, role: asset.role,
  dataUrl: asset.dataUrl, url: asset.url, relativePath: asset.relativePath,
  checksum: asset.checksum, missing: asset.missing, mimeType: asset.mimeType,
  sourceEntityId: asset.sourceEntityId, sourceEntityKind: asset.sourceEntityKind,
  prompt: asset.prompt, visualAnchor: asset.visualAnchor, negativePrompt: asset.negativePrompt,
  gridStates: asset.gridStates, mediaType: asset.mediaType, referenceRole: asset.referenceRole,
  referenceScope: asset.referenceScope, nsfwPrivatePart: asset.nsfwPrivatePart,
  durationSec: asset.durationSec, width: asset.width, height: asset.height,
  sampleRate: asset.sampleRate, channelCount: asset.channelCount,
  firstFrameAssetId: asset.firstFrameAssetId, lastFrameAssetId: asset.lastFrameAssetId,
});

/** Request identity follows actual creative inputs, never task/accounting
 * timestamps or unrelated generated media. It is not a semantic validator. */
export const storyboardRequestSourceIdentity = (input: {
  project: Pick<Project, 'id' | 'characters' | 'locations' | 'props' | 'assets' | 'sourceDocuments'>;
  story: string;
  title: string;
  scenes: readonly Scene[];
  scene?: Scene;
  selectedAssetIds: readonly string[];
  extraRequirement?: string;
}): string => {
  const scenes = input.scene ? [...input.scenes, input.scene] : input.scenes;
  const text = [input.story, input.extraRequirement, ...scenes.flatMap((scene) => [scene.content, scene.summary])].join('\n');
  const selectedIds = new Set(input.selectedAssetIds);
  const assetsById = new Map(input.project.assets.map((asset) => [asset.id, asset]));
  const references = input.selectedAssetIds.map((id) => {
    const asset = assetsById.get(id);
    return asset ? referenceInput(asset) : { id, missing: true };
  });
  const entityIds = new Set([
    ...scenes.flatMap((scene) => [...scene.characterIds, ...(scene.locationIds || []), scene.locationId || '', ...scene.propIds]),
    ...input.selectedAssetIds.map((id) => assetsById.get(id)?.sourceEntityId || ''),
  ]);
  const entities = <T extends { id: string; name: string; assetIds: string[] }>(items: T[]) => items
    .filter((item) => entityIds.has(item.id) || Boolean(item.name.trim() && text.includes(item.name.trim())))
    .map((item) => {
      const { assetIds, ...fields } = item;
      const semantic = { ...fields } as Record<string, unknown>;
      // Legacy/imported entities may contain bookkeeping fields outside the
      // current schema. Those must not turn image completion into cancellation.
      delete semantic.updatedAt;
      delete semantic.createdAt;
      delete semantic.referenceAssetIds;
      return { ...semantic, assetIds: assetIds.filter((id) => selectedIds.has(id)) };
    });
  return JSON.stringify([
    input.project.id, input.title, input.story, input.extraRequirement || '',
    input.project.sourceDocuments.map((source) => [source.id, source.name, source.content]),
    input.scenes.map(semanticScene), input.scene ? semanticScene(input.scene) : null,
    entities(input.project.characters), entities(input.project.locations), entities(input.project.props),
    references,
  ]);
};

/** Keep credentials/settings sensitive to changes but out of identity text. */
export const storyboardRequestApiIdentity = (config: unknown): string => sourceContentHash(JSON.stringify(config));
