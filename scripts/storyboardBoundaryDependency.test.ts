import assert from 'node:assert/strict';
import { GenerationTaskCancelledError } from '../src/generationTaskCancellation';
import { runStoryboardImageBatch, withStoryboardFirstFrameContinuity, type StoryboardImageRequest } from '../src/storyboardImages';
import type { ReferenceAsset } from '../src/types';

const request = (purpose: 'first-frame' | 'last-frame', storyboardId = 'board'): StoryboardImageRequest => ({
  purpose, name: purpose, storyboardId, shotId: `${storyboardId}-${purpose}`, shotIndex: 1,
  assetKind: 'storyboard', assetType: purpose, assetRole: purpose, referenceRole: purpose,
  imageVariant: purpose, referenceAssetIds: ['teacher', 'sister'], primaryReferenceAssetIds: ['teacher', 'sister'],
  conversionSource: '保持本镜原定取景、时间、动作与人物位置。', width: 1536, height: 1024,
});
const firstAsset: ReferenceAsset = {
  id: 'fresh-first', name: '本批首图', type: 'first-frame', role: 'first-frame', referenceRole: 'first-frame',
  sourceStoryboardId: 'board', imageVariant: 'first-frame', mediaType: 'image', source: 'generated',
  dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1,
};
const first = request('first-frame');
const tail = request('last-frame');

// The production queue has one slot: a tail-first request must not hold it while waiting.
const order: string[] = [];
const paired = await runStoryboardImageBatch([tail, first], async (item, _index, prior?: ReferenceAsset) => {
  order.push(item.purpose);
  if (item.purpose === 'last-frame') assert.equal(prior, firstAsset);
  else assert.equal(prior, undefined);
  return item.purpose === 'first-frame' ? firstAsset : { ...firstAsset, id: 'saved-tail' };
});
assert.deepEqual(order, ['first-frame', 'last-frame']);
assert.deepEqual(paired.map((result) => result.status), ['succeeded', 'succeeded']);
assert.equal(paired[0].value?.id, 'saved-tail');

// A normal first-frame failure leaves the authored tail runnable, without retries.
for (const failure of ['HTTP 502', '首图保存失败', '首图提示词转换失败']) {
  const failureCalls: string[] = [];
  const independent = request('last-frame', 'other-board');
  const originalTail = JSON.stringify(tail);
  const failed = await runStoryboardImageBatch([tail, first, independent], async (item, _index, prior) => {
    failureCalls.push(`${item.storyboardId}:${item.purpose}`);
    assert.equal(prior, undefined, 'a failed first result cannot substitute an older first frame');
    if (item === first) throw new Error(failure);
    return 'saved';
  });
  assert.deepEqual([...failureCalls].sort(), ['board:first-frame', 'board:last-frame', 'other-board:last-frame']);
  assert.ok(failureCalls.indexOf('board:first-frame') < failureCalls.indexOf('board:last-frame'));
  assert.deepEqual(failed.map((result) => result.status), ['succeeded', 'failed', 'succeeded']);
  assert.equal(failed[0].blockedBy, undefined);
  assert.equal(failed[1].error, failure);
  assert.equal(JSON.stringify(tail), originalTail, 'tail retains its own source and chosen references');
}

for (const cancelledBeforeStart of [true, false]) {
  let tailCalls = 0;
  let firstCalls = 0;
  const results = await runStoryboardImageBatch([tail, first], async (item) => {
    if (item === tail) tailCalls += 1;
    else firstCalls += 1;
    throw new GenerationTaskCancelledError();
  }, (item) => !(cancelledBeforeStart && item === first));
  assert.equal(firstCalls, cancelledBeforeStart ? 0 : 1);
  assert.equal(tailCalls, 0);
  assert.deepEqual(results.map((result) => result.status), ['cancelled', 'cancelled']);
  assert.equal(results[0].blockedBy, 1);
  assert.match(results[0].error || '', /首帧已取消或停止/u);
}

let soloCalls = 0;
const solo = await runStoryboardImageBatch([tail], async (_item, _index, prior) => {
  soloCalls += 1;
  assert.equal(prior, undefined);
  return 'tail-only';
});
assert.equal(soloCalls, 1);
assert.equal(solo[0].status, 'succeeded');
assert.equal(withStoryboardFirstFrameContinuity(tail, undefined), tail);

const original = JSON.stringify(tail);
const augmented = withStoryboardFirstFrameContinuity(tail, firstAsset);
assert.deepEqual(augmented.referenceAssetIds, ['teacher', 'sister', 'fresh-first']);
assert.deepEqual(augmented.primaryReferenceAssetIds, tail.primaryReferenceAssetIds);
assert.equal(augmented.continuityAssetId, 'fresh-first');
assert.ok(augmented.conversionSource.startsWith(tail.conversionSource));
assert.match(augmented.conversionSource, /不从首图继承姓名、画面左右、人物位置、机位、景别、朝向、动作或持物/u);
assert.equal(JSON.stringify(tail), original);
assert.equal(withStoryboardFirstFrameContinuity(first, firstAsset), first);
assert.equal(withStoryboardFirstFrameContinuity(tail, { ...firstAsset, sourceStoryboardId: 'other-board' }), tail);

// Ambiguous multi-first sets have no implicit pairing.
const repeated = await runStoryboardImageBatch([first, { ...first, shotId: 'another-first' }, tail], async (_item, _index, prior) => {
  assert.equal(prior, undefined);
  return 'saved';
});
assert.ok(repeated.every((result) => result.status === 'succeeded'));
console.log('storyboard boundary dependency: success continuity, three independent failure stages, cancellation and standalone cases passed; no API calls.');
