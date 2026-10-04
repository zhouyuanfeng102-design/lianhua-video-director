import assert from 'node:assert/strict';
import { clampImagePreviewZoom, getImagePreviewSize, IMAGE_PREVIEW_MIN_ZOOM, IMAGE_PREVIEW_MAX_ZOOM } from '../src/components/AssetImagePreview';

assert.equal(clampImagePreviewZoom(0), IMAGE_PREVIEW_MIN_ZOOM);
assert.equal(clampImagePreviewZoom(800), IMAGE_PREVIEW_MAX_ZOOM);
assert.equal(clampImagePreviewZoom(125), 125);
assert.equal(clampImagePreviewZoom(NaN), 100);
assert.equal(clampImagePreviewZoom(Infinity), 100);
const viewport = { width: 900, height: 600 };
const portrait = { width: 1024, height: 1536 };
const landscape = { width: 1536, height: 1024 };
assert.deepEqual(getImagePreviewSize(portrait, viewport, 100), { width: 400, height: 600 });
assert.deepEqual(getImagePreviewSize(portrait, viewport, 25), { width: 100, height: 150 });
assert.deepEqual(getImagePreviewSize(portrait, viewport, 400), { width: 1600, height: 2400 });
assert.deepEqual(getImagePreviewSize(landscape, viewport, 100), { width: 900, height: 600 });
assert.deepEqual(getImagePreviewSize(landscape, { width: 600, height: 900 }, 100), { width: 600, height: 400 });
assert.deepEqual(getImagePreviewSize(portrait, { width: 300, height: 300 }, 100), { width: 200, height: 300 });
for (const image of [{ width: 0, height: 100 }, { width: 100, height: NaN }, { width: -1, height: 100 }]) {
  assert.deepEqual(getImagePreviewSize(image, viewport, 100), { width: 0, height: 0 });
}
assert.deepEqual(getImagePreviewSize(portrait, { width: 0, height: 0 }, 100), { width: 0, height: 0 });
assert.deepEqual(portrait, { width: 1024, height: 1536 }, 'preview sizing never mutates source metadata');
console.log('Image preview zoom: fit, aspect ratio, resizing, limits and unloaded geometry passed');
