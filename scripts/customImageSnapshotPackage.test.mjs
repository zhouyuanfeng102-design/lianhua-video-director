import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { collectImageReferenceSnapshotsForExport } = require('../electron/imageReferenceSnapshots.cjs');
const reference = { id: 'custom-original', relativePath: 'image/custom-original.png', checksum: 'a'.repeat(64) };

test('custom task and result-owned originals remain in export after source cards or task deletion', () => {
  const task = { id: 'custom-task', kind: 'image', assetKind: 'custom', referenceAssetSnapshots: [reference] };
  const asset = { id: 'custom-result', imageRegenerationSnapshot: { version: 1, sourceKind: 'custom', referenceAssetSnapshots: [reference] } };
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task], assets: [] } }), [reference]);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [], assets: [asset] } }), [reference]);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task], assets: [asset] } }), [reference]);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [], assets: [] },
    projects: [{ id: 'background-project', assets: [asset] }] }), [reference]);
});

test('custom pure-text requests export without inventing a reference; conflicting originals still fail', () => {
  const task = { id: 'custom-task', kind: 'image', assetKind: 'custom', referenceAssetSnapshots: [] };
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task] } }), []);
  assert.throws(() => collectImageReferenceSnapshotsForExport({ project: { generationTasks: [
    { ...task, referenceAssetSnapshots: [reference] },
    { ...task, id: 'other-task', referenceAssetSnapshots: [{ ...reference, checksum: 'b'.repeat(64) }] },
  ] } }), /快照存在冲突/u);
});
