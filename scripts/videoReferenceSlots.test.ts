import assert from 'node:assert/strict';
import { addVideoReference, assertVideoReferenceSlots, changeVideoReferenceRole, moveVideoReference, removeVideoReference, videoReferenceSelection, videoReferenceSlotIndex, videoReferenceSlotSpan } from '../src/videoReferenceSlots';
import { videoReferenceSlotLabels, videoReferenceUsage } from '../src/videoReferenceUsage';
import type { VideoImageReference } from '../src/videoGenerationTypes';

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
console.log('videoReferenceSlots: stable holes, refill order, remembered/custom roles, round-trip, immutable sources, labels and technical validation passed');
