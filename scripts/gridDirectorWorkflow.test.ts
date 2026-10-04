import assert from 'node:assert/strict';
import {
  normalizeGridDirectorInputMode,
  resolveGridDirectorPreflight,
} from '../src/gridDirectorWorkflow';
import type { ReferenceAsset } from '../src/types';

const asset = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id,
  name: id,
  type: 'reference',
  role: 'composition',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const ordinaryAsset = asset('ordinary', {
  dataUrl: 'data:image/png;base64,AA==',
});

assert.equal(
  normalizeGridDirectorInputMode('grid', 'text'),
  'text_reference',
  'legacy grid + text state is upgraded to a story-and-image input',
);
assert.equal(normalizeGridDirectorInputMode('grid', 'reference'), 'reference');
assert.equal(normalizeGridDirectorInputMode('drama', 'text'), 'text');

const ordinaryOnly = resolveGridDirectorPreflight({
  workflow: 'grid',
  inputMode: 'text',
  selectedAssetIds: [ordinaryAsset.id],
  assets: [ordinaryAsset],
});
assert.equal(ordinaryOnly.normalizedInputMode, 'text_reference');
assert.equal(ordinaryOnly.ready, false, 'an ordinary picture cannot stand in for a grid master');
assert.equal(ordinaryOnly.selectedGridAsset, undefined);
assert.match(ordinaryOnly.reason || '', /九宫格母版/u);

const emptyGrid = asset('empty-grid', { type: 'grid', role: 'grid' });
const missingPixels = resolveGridDirectorPreflight({
  workflow: 'grid',
  inputMode: 'text_reference',
  selectedAssetIds: [emptyGrid.id],
  assets: [emptyGrid],
});
assert.equal(missingPixels.ready, false);
assert.equal(missingPixels.selectedGridAsset, emptyGrid);
assert.match(missingPixels.reason || '', /没有可用图像/u);

const usableGridSources: ReferenceAsset[] = [
  asset('inline-grid', {
    type: 'grid',
    role: 'grid',
    dataUrl: 'data:image/png;base64,AA==',
  }),
  asset('remote-grid', {
    type: 'grid',
    role: 'grid',
    url: 'https://images.example.test/grid.png',
  }),
  asset('managed-url-grid', {
    type: 'grid',
    role: 'grid',
    managed: true,
    url: 'lianhua-asset://local/image/grid.png',
  }),
  asset('managed-path-grid', {
    type: 'grid',
    role: 'grid',
    managed: true,
    relativePath: 'images/grid-master.png',
  }),
];

for (const gridAsset of usableGridSources) {
  const result = resolveGridDirectorPreflight({
    workflow: 'grid',
    inputMode: 'text_reference',
    selectedAssetIds: [gridAsset.id],
    assets: usableGridSources,
  });
  assert.equal(result.ready, true, `${gridAsset.id} should contain usable image pixels`);
  assert.equal(result.selectedGridAsset, gridAsset);
  assert.equal(result.reason, undefined);
}

const laterUsableGrid = resolveGridDirectorPreflight({
  workflow: 'grid',
  inputMode: 'reference',
  selectedAssetIds: [emptyGrid.id, usableGridSources[0].id],
  assets: [emptyGrid, ...usableGridSources],
});
assert.equal(laterUsableGrid.ready, true, 'a later valid selected grid is accepted');
assert.equal(laterUsableGrid.selectedGridAsset, usableGridSources[0]);

const nonGrid = resolveGridDirectorPreflight({
  workflow: 'drama',
  inputMode: 'text',
  selectedAssetIds: [],
  assets: [],
});
assert.deepEqual(nonGrid, {
  normalizedInputMode: 'text',
  ready: true,
}, 'non-grid workflows are never blocked by the grid preflight');

console.log('gridDirectorWorkflow: input normalization and grid-master preflight tests passed');
