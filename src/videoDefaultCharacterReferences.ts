import { assetReferenceCharacterOwners } from './assetCharacterBinding';
import { isNsfwPrivateProfileAsset } from './nsfwPrivateAssets';
import { hasUsableStoryboardReferencePixels } from './storyboardImages';
import { videoReferenceCharacterOwners } from './videoReferenceCharacters';
import { videoReferenceSlotIndex, videoReferenceSlotSpan } from './videoReferenceSlots';
import { videoSegmentCharacterHints } from './videoSegmentCharacters';
import type { Project, ReferenceAsset } from './types';
import type { VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';

const usablePixels = (asset: ReferenceAsset): boolean => hasUsableStoryboardReferencePixels(asset)
  && !/^(?:video|audio)\//iu.test(asset.mimeType || '');

/** Only current, ordinary identity bindings are defaults. An explicit user
 * binding can make an ordinary composition a character reference; a shot's
 * filename/provenance alone never promotes its historical pixels. */
const ordinaryIdentityImage = (asset: ReferenceAsset): boolean => {
  if (!usablePixels(asset) || isNsfwPrivateProfileAsset(asset)
    || ['first-frame', 'last-frame'].includes(asset.type)
    || ['first-frame', 'last-frame'].includes(asset.role)
    || ['first-frame', 'last-frame'].includes(asset.referenceRole || '')
    || ['first-frame', 'last-frame', 'grid'].includes(asset.imageVariant || '')) return false;
  if (typeof asset.characterReferenceId === 'string' && asset.characterReferenceId.trim()) return true;
  return !asset.sourceStoryboardId && !asset.sourceShotId && !asset.sourceVideoTaskId
    && !asset.sourceVideoAssetId && !asset.sourceVideoEditId && !asset.sourceClipId
    && !['storyboard-frame', 'snapshot'].includes(asset.imageVariant || '');
};

const authoredPrompt = (draft: VideoGenerationDraft): string => {
  const binding = draft.source?.promptFormat === 'seedance' ? draft.seedanceReferenceBinding : draft.h3ReferenceBinding;
  return binding && (draft.prompt === binding.basePrompt || draft.prompt === binding.renderedPrompt)
    ? binding.basePrompt : draft.prompt;
};

/** Called only when selecting a new saved prompt. Manual reference overrides
 * are applied later, including an intentionally empty selection. This pure
 * default selection never rewrites H3, changes source records or submits work. */
export const addDefaultVideoCharacterReferences = (
  project: Project,
  draft: VideoGenerationDraft,
): VideoGenerationDraft => {
  if (draft.reuseTaskId || !draft.prompt.trim()) return draft;
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  if (draft.source?.storyboardId && !board) return draft;
  const plan = project.sequencePlans.find((entry) => entry.id === (draft.source?.sequencePlanId || board?.sequencePlanId));
  const segment = plan?.segments.find((entry) => entry.id === (draft.source?.segmentId || board?.segmentId));
  const visibleIds = new Set(videoSegmentCharacterHints(project, plan, segment, board, authoredPrompt(draft)).characters
    .filter((entry) => entry.presence === 'visible').map((entry) => entry.id));
  if (!visibleIds.size) return draft;
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const covered = new Set(draft.references.flatMap((reference) => {
    if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) return [];
    const asset = assetsById.get(reference.assetId);
    return asset && usablePixels(asset)
      ? videoReferenceCharacterOwners(project, asset, reference).map((owner) => owner.id) : [];
  }));
  const selectedIds = new Set(draft.references.map((reference) => reference.assetId));
  let selection = { references: draft.references, referenceSlotRoles: draft.referenceSlotRoles };
  let changed = false;
  for (const character of project.characters) {
    if (character.dossier?.archivedIntoCharacterId || !visibleIds.has(character.id) || covered.has(character.id)) continue;
    const explicitFallbacks = project.assets.filter((asset) => asset.characterReferenceId === character.id)
      .sort((left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt));
    const candidateIds = [...new Set([...(character.assetIds || []), ...explicitFallbacks.map((asset) => asset.id)])];
    const asset = candidateIds.map((id) => assetsById.get(id)).find((candidate): candidate is ReferenceAsset => Boolean(
      candidate && !selectedIds.has(candidate.id) && ordinaryIdentityImage(candidate)
      && assetReferenceCharacterOwners(project, candidate).some((owner) => owner.id === character.id),
    ));
    if (!asset) continue;
    const ownerIds = assetReferenceCharacterOwners(project, asset).map((owner) => owner.id);
    const roles = [...(selection.referenceSlotRoles || [])];
    const occupied = new Set(selection.references.map(videoReferenceSlotIndex));
    const span = Math.max(videoReferenceSlotSpan(selection.references), roles.length);
    let slotIndex = 0;
    while (slotIndex < span && (occupied.has(slotIndex)
      || roles[slotIndex] && !['character', 'subject'].includes(roles[slotIndex]))) slotIndex += 1;
    // A remembered scene/tail/style vacancy is a user choice, not a free
    // identity slot. Fill an unclaimed/identity vacancy or append after it.
    roles[slotIndex] = 'character';
    const reference: VideoImageReference = { assetId: asset.id, role: 'character', characterIds: ownerIds, slotIndex };
    selection = { references: [...selection.references, reference], referenceSlotRoles: roles };
    selectedIds.add(asset.id);
    ownerIds.forEach((id) => covered.add(id));
    changed = true;
  }
  return changed ? { ...draft, ...selection } : draft;
};
