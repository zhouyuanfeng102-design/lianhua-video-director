import type { ReferenceRole } from './types';
import type { VideoImageReference } from './videoGenerationTypes';

export interface VideoReferenceSelection {
  references: VideoImageReference[];
  referenceSlotRoles?: ReferenceRole[];
}

export const videoReferenceSlotIndex = (reference: VideoImageReference, index: number): number => reference.slotIndex ?? index;

export const assertVideoReferenceSlots = (references: readonly VideoImageReference[], capacity?: number): void => {
  const used = new Set<number>();
  references.forEach((reference, index) => {
    const slot = videoReferenceSlotIndex(reference, index);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('参考图片槽号无效，请重新选择图片。');
    if (used.has(slot)) throw new Error(`图片槽 ${slot + 1} 重复绑定，请重新选择图片。`);
    if (capacity !== undefined && slot >= capacity) throw new Error(`参考图占用了图片槽 ${slot + 1}，当前工作流只有 ${capacity} 个图片槽。`);
    used.add(slot);
  });
};

export const videoReferenceSlotSpan = (references: readonly VideoImageReference[]): number => references.reduce(
  (span, reference, index) => Math.max(span, videoReferenceSlotIndex(reference, index) + 1), 0,
);

// Only occupied slots travel to the engine. Removing a picture must materialize
// its neighbours' original positions before filtering the dense upload list.
const positioned = (references: readonly VideoImageReference[]): VideoImageReference[] => references.map(
  (reference, index) => ({ ...reference, slotIndex: videoReferenceSlotIndex(reference, index) }),
);
const canonical = (references: VideoImageReference[]): VideoImageReference[] => references
  .sort((left, right) => left.slotIndex! - right.slotIndex!)
  .map((reference, index) => {
    if (reference.slotIndex !== index) return reference;
    const { slotIndex: _slotIndex, ...dense } = reference;
    return dense;
  });

export const videoReferenceSelection = (
  references: readonly VideoImageReference[], remembered: readonly ReferenceRole[] = [],
): VideoReferenceSelection => {
  const roles = [...remembered];
  references.forEach((reference, index) => { roles[videoReferenceSlotIndex(reference, index)] = reference.role; });
  return { references: references.map((reference) => ({ ...reference })), referenceSlotRoles: roles };
};

export const removeVideoReference = (selection: VideoReferenceSelection, assetId: string, usage?: ReferenceRole): VideoReferenceSelection => {
  const next = videoReferenceSelection(selection.references, selection.referenceSlotRoles);
  const index = selection.references.findIndex((reference) => reference.assetId === assetId);
  if (index >= 0 && usage) next.referenceSlotRoles![videoReferenceSlotIndex(selection.references[index], index)] = usage;
  return { ...next, references: canonical(positioned(selection.references).filter((reference) => reference.assetId !== assetId)) };
};

export const addVideoReference = (selection: VideoReferenceSelection, reference: VideoImageReference): VideoReferenceSelection => {
  if (selection.references.some((entry) => entry.assetId === reference.assetId)) return selection;
  const next = videoReferenceSelection(selection.references, selection.referenceSlotRoles);
  const entries = positioned(next.references);
  const occupied = new Set(entries.map((entry) => entry.slotIndex));
  let slot = 0;
  while (occupied.has(slot)) slot += 1;
  const role = next.referenceSlotRoles?.[slot] || reference.role;
  entries.push({ ...reference, slotIndex: slot, role });
  return videoReferenceSelection(canonical(entries), next.referenceSlotRoles);
};

export const changeVideoReferenceRole = (selection: VideoReferenceSelection, assetId: string, role: ReferenceRole): VideoReferenceSelection => (
  videoReferenceSelection(selection.references.map((reference) => reference.assetId === assetId ? { ...reference, role } : reference), selection.referenceSlotRoles)
);

export const moveVideoReference = (references: readonly VideoImageReference[], index: number, delta: number): VideoImageReference[] => {
  const destination = index + delta;
  if (index < 0 || index >= references.length || destination < 0 || destination >= references.length) return references as VideoImageReference[];
  const next = positioned(references);
  [next[index].slotIndex, next[destination].slotIndex] = [next[destination].slotIndex, next[index].slotIndex];
  return canonical(next);
};
