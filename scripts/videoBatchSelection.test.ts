import assert from 'node:assert/strict';
import { buildVideoBatchSubmissionItems, videoBatchCandidateWillSubmit, videoBatchConfirmationItemStatus, videoBatchConfirmationPendingCount } from '../src/videoBatchSelection';
import type { VideoBatchChoiceCandidate } from '../src/videoBatch';
import type { VideoBatchItemInput } from '../src/videoGenerationTypes';

const candidate = (index: number, kind?: 'succeeded' | 'in-flight'): VideoBatchChoiceCandidate => ({
  key: `board-${index}:zh`, storyboardId: `board-${index}`, sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index,
  language: 'zh', choice: { id: `board-${index}:zh`, storyboardId: `board-${index}`, language: 'zh', label: `第 ${index} 段`,
    prompt: `第 ${index} 段对白不变`, durationSec: 15, updatedAt: 1, version: 'v1' },
  draft: { name: `第 ${index} 段`, prompt: `第 ${index} 段对白不变`, backend: 'api', references: [{ assetId: `image-${index}`, role: 'subject' }], parameters: { seed: 14 } },
  promptFingerprint: `prompt-${index}`, referenceFingerprint: `reference-${index}`, requestFingerprint: `request-${index}`,
  duplicate: kind ? { kind, taskId: `previous-${index}`, status: kind === 'succeeded' ? 'succeeded' : 'unknown' } : undefined,
});
let count = 0;
const test = (name: string, run: () => void) => { run(); count += 1; console.log(`ok ${count} - ${name}`); };

test('default batch retains duplicate protection without authorizing paid regeneration', () => {
  const selected = [candidate(1, 'succeeded'), candidate(2), candidate(3, 'in-flight')];
  const items = buildVideoBatchSubmissionItems(selected, false, () => undefined);
  assert.equal(items.length, 3, 'all selected locators reach the authoritative engine duplicate check');
  assert.deepEqual(items.map((item) => item.force), [undefined, undefined, undefined]);
  assert.deepEqual(selected.map((item) => videoBatchCandidateWillSubmit(item, false)), [false, true, false]);
});

test('explicit regeneration is forwarded even when the UI did not recognize an archived completed result', () => {
  const selected = [candidate(1, 'succeeded'), candidate(2), candidate(3, 'in-flight')];
  const items = buildVideoBatchSubmissionItems(selected, true, () => undefined);
  assert.deepEqual(items.map((item) => item.force), [true, true, true]);
  assert.deepEqual(selected.map((item) => videoBatchCandidateWillSubmit(item, true)), [true, true, false],
    'a running/unknown item stays excluded from the UI pending count; engine must still enforce this after confirmation');
});

test('all successful choices become actionable only after explicit regeneration', () => {
  const selected = [candidate(1, 'succeeded'), candidate(2, 'succeeded')];
  assert.equal(selected.filter((item) => videoBatchCandidateWillSubmit(item, false)).length, 0);
  assert.equal(selected.filter((item) => videoBatchCandidateWillSubmit(item, true)).length, 2);
});

test('confirmation counts only the regenerated completed item when another selected task is running or uncertain', () => {
  for (const status of ['running', 'unknown'] as const) {
    const selected = [candidate(1, 'succeeded'), candidate(2, 'in-flight')]; selected[1].duplicate!.status = status;
    const items = buildVideoBatchSubmissionItems(selected, true, () => undefined);
    assert.deepEqual(items.map((item) => item.force), [true, true], 'keep full authorization for authoritative engine checks');
    assert.equal(videoBatchConfirmationPendingCount(selected, items), 1);
    assert.match(videoBatchConfirmationItemStatus(selected[0], items[0], false), /允许重新生成/u);
    const activeLabel = videoBatchConfirmationItemStatus(selected[1], items[1], false);
    assert.match(activeLabel, /进行中或结果待确认，将跳过/u); assert.doesNotMatch(activeLabel, /允许重新生成/u);
  }
});

test('chain confirmation flags an active task for whole-chain checking instead of suggesting a skipped link', () => {
  const selected = [candidate(1, 'in-flight'), candidate(2)];
  const items = buildVideoBatchSubmissionItems(selected, true, () => undefined);
  const label = videoBatchConfirmationItemStatus(selected[0], items[0], true);
  assert.match(label, /整链待核对/u); assert.doesNotMatch(label, /将跳过|允许重新生成/u);
});

test('confirmation count follows each frozen item authorization rather than the current UI switch', () => {
  const selected = [candidate(1, 'succeeded'), candidate(2, 'succeeded'), candidate(3)];
  const items = buildVideoBatchSubmissionItems(selected, false, () => undefined); items[1].force = true;
  assert.equal(videoBatchConfirmationPendingCount(selected, items), 2);
  assert.match(videoBatchConfirmationItemStatus(selected[0], items[0], false), /已生成，将跳过/u);
});

test('chain and independent items receive the same explicit intent without mutating selection or references', () => {
  const selected = [candidate(1), candidate(2)]; const before = JSON.stringify(selected);
  const previousTail: VideoBatchItemInput['previousTail'] = {
    predecessorItemKey: selected[0].key, placement: { mode: 'replace', index: 0, role: 'first-frame', replacedAssetId: 'image-2' },
  };
  const items = buildVideoBatchSubmissionItems(selected, true, (item) => item.segmentIndex === 2 ? previousTail : undefined);
  assert.deepEqual(items.map((item) => item.itemKey), ['board-1:zh', 'board-2:zh']);
  assert.equal(items[0].previousTail, undefined); assert.deepEqual(items[1].previousTail, previousTail);
  assert.deepEqual(items.map((item) => item.force), [true, true]);
  items[1].draft.references[0].role = 'first-frame'; items[1].draft.parameters.seed = 99;
  assert.equal(JSON.stringify(selected), before);
});

console.log(`videoBatchSelection: ${count} regression checks passed`);
