import assert from 'node:assert/strict';
import { addVideoReference, assertVideoReferenceSlots, changeVideoReferenceRole, moveVideoReference, removeVideoReference, videoReferenceDisplaySlots, videoReferenceSelection, videoReferenceSlotIndex, videoReferenceSlotSpan } from '../src/videoReferenceSlots';
import { videoReferenceSlotCapacity, videoReferenceSlotLabels, videoReferenceUsage } from '../src/videoReferenceUsage';
import type { ComfyVideoWorkflowPreset, VideoImageReference } from '../src/videoGenerationTypes';

const refs: VideoImageReference[] = [
  { assetId: 'opening', role: 'composition' }, { assetId: 'a', role: 'character' },
  { assetId: 'b', role: 'character' }, { assetId: 'c', role: 'character' },
];
const context = { backend: 'api' as const, api: { provider: 'runninghub' as const, runningHubImageRoles: ['first-frame', 'character', 'character', 'character'] as const } };
const mapped = { ...context, api: { ...context.api, runningHubImageRoles: [...context.api.runningHubImageRoles] } };
const before = JSON.stringify(refs);
let selection = videoReferenceSelection(refs);
selection = removeVideoReference(selection, 'opening', 'first-frame');
assert.deepEqual(selection.references.map(videoReferenceSlotIndex), [1, 2, 3]);
assert.deepEqual(videoReferenceSlotLabels(selection.references, mapped, 0, selection.referenceSlotRoles), ['人物1（槽2）', '人物2（槽3）', '人物3（槽4）']);
assert.deepEqual(videoReferenceUsage(selection.references, mapped).map((ref) => ref.role), ['character', 'character', 'character']);
selection = JSON.parse(JSON.stringify(selection));
selection = addVideoReference(selection, { assetId: 'new', role: 'scene' });
assert.deepEqual(selection.references, [{ assetId: 'new', role: 'first-frame' }, ...refs.slice(1)]);
selection = removeVideoReference(selection, 'b');
selection = removeVideoReference(selection, 'new');
selection = addVideoReference(selection, { assetId: 'first-replacement', role: 'style' });
selection = addVideoReference(selection, { assetId: 'second-replacement', role: 'scene' });
assert.deepEqual(selection.references.map((ref) => [ref.assetId, ref.role]), [
  ['first-replacement', 'first-frame'], ['a', 'character'], ['second-replacement', 'character'], ['c', 'character'],
]);
selection = changeVideoReferenceRole(selection, 'a', 'prop');
selection = removeVideoReference(selection, 'a');
selection = addVideoReference(JSON.parse(JSON.stringify(selection)), { assetId: 'prop-replacement', role: 'character' });
assert.equal(selection.references[1].role, 'prop');
assert.equal(JSON.stringify(refs), before);

const sparse = removeVideoReference(videoReferenceSelection(refs), 'a');
const moved = moveVideoReference(sparse.references, 1, 1);
assert.deepEqual(moved.map((ref, index) => [ref.assetId, videoReferenceSlotIndex(ref, index)]), [['opening', 0], ['c', 2], ['b', 3]]);
assert.equal(videoReferenceSlotSpan(sparse.references), 4);
assert.doesNotThrow(() => assertVideoReferenceSlots(sparse.references, 4));
assert.throws(() => assertVideoReferenceSlots(sparse.references, 3), /图片槽 4/);
assert.throws(() => assertVideoReferenceSlots([{ ...refs[0], slotIndex: -1 }]), /槽号无效/);
assert.throws(() => assertVideoReferenceSlots([{ ...refs[0], slotIndex: 1.1 }]), /槽号无效/);
assert.throws(() => assertVideoReferenceSlots([{ ...refs[0], slotIndex: 0 }, { ...refs[1], slotIndex: 0 }]), /重复绑定/);

let flexible = videoReferenceSelection(refs.slice(1));
flexible = removeVideoReference(flexible, 'a');
const flexibleContext = { backend: 'api' as const };
assert.deepEqual(videoReferenceSlotLabels(flexible.references, flexibleContext, 0, flexible.referenceSlotRoles), ['人物2（槽2）', '人物3（槽3）']);
assert.deepEqual(videoReferenceSlotLabels(flexible.references, mapped, 1, flexible.referenceSlotRoles), ['人物2（槽3）', '人物3（槽4）']);
flexible = removeVideoReference(removeVideoReference(flexible, 'b'), 'c');
assert.equal(flexible.references.length, 0);
assert.deepEqual(addVideoReference(flexible, { assetId: 'd', role: 'scene' }).references, [{ assetId: 'd', role: 'character' }]);

// A six-slot workflow may retain nine purposes from an earlier connection.
// Display only current empty slots, without erasing memory or moving images.
const rememberedNine = Array.from({ length: 9 }, () => 'character' as const);
const sixReferences = Array.from({ length: 6 }, (_, index) => ({ assetId: `person-${index}`, role: 'character' as const }));
const full = videoReferenceSelection(sixReferences, rememberedNine);
const fullBefore = JSON.stringify(full);
const nineSlotWorkflow: ComfyVideoWorkflowPreset = {
  id: 'old-nine', name: 'Old nine-slot workflow', createdAt: 1, updatedAt: 1, workflowJson: '{}',
  mapping: { prompt: [], images: rememberedNine.map((role, index) => ({ nodeId: String(index), inputName: 'image', role })), outputNodeId: 'out' },
};
const sixSlotContext = { backend: 'api' as const, workflow: nineSlotWorkflow,
  api: { provider: 'runninghub' as const, runningHubImageRoles: rememberedNine.slice(0, 6) }, slotRoles: rememberedNine };
const capacity = videoReferenceSlotCapacity(sixSlotContext);
assert.equal(capacity, 6, 'RunningHub capacity does not borrow a stale ComfyUI workflow or remembered purposes');
assert.deepEqual(videoReferenceDisplaySlots(full, capacity), [0, 1, 2, 3, 4, 5]);
const withHole = removeVideoReference(full, 'person-2');
assert.deepEqual(videoReferenceDisplaySlots(withHole, capacity), [0, 1, 2, 3, 4, 5], 'the real third-slot vacancy remains visible');
assert.deepEqual(withHole.references.map(videoReferenceSlotIndex), [0, 1, 3, 4, 5]);
assert.deepEqual(videoReferenceDisplaySlots(full, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'switching back to nine slots reveals the retained purposes');
assert.equal(JSON.stringify(full), fullBefore, 'display derivation never modifies saved roles or selected slots');
const overflow = videoReferenceSelection([{ assetId: 'overflow', role: 'character', slotIndex: 8 }], rememberedNine);
assert.deepEqual(videoReferenceDisplaySlots(overflow, 6), [0, 1, 2, 3, 4, 5, 8], 'keep an occupied ninth slot visible without inventing empty seventh/eighth slots');

// Composite mode reserves physical slot 1; its five editable slots still fit
// the same six-slot connection. An actual extra image keeps its true slot.
const composite = videoReferenceSelection(sixReferences.slice(0, 5), rememberedNine);
assert.deepEqual(videoReferenceDisplaySlots(composite, capacity, 1), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(videoReferenceDisplaySlots(full, capacity, 1), [0, 1, 2, 3, 4, 5, 6]);
const compositeHole = removeVideoReference(composite, 'person-1');
assert.deepEqual(videoReferenceDisplaySlots(compositeHole, capacity, 1), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(compositeHole.references.map((reference, index) => videoReferenceSlotIndex(reference, index) + 1), [1, 3, 4, 5]);

assert.equal(videoReferenceSlotCapacity({ ...sixSlotContext, backend: 'comfyui' }), 9);
assert.equal(videoReferenceSlotCapacity({ backend: 'api', workflow: nineSlotWorkflow }), undefined);
assert.deepEqual(videoReferenceDisplaySlots(full), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'unknown capacity preserves existing editable memory');
assert.equal(videoReferenceSlotCapacity({ backend: 'api', api: { provider: 'runninghub', runningHubImageRoles: [] } }), 0);
assert.deepEqual(videoReferenceDisplaySlots(videoReferenceSelection([], rememberedNine), 0), [], 'known zero capacity differs from undeclared capacity');
console.log('videoReferenceSlots: stable holes, refill order, remembered/custom roles, immutable sources, capacity-bound display, reserved offsets, labels and technical validation passed');
