import assert from 'node:assert/strict';
import { mapManagedAssetDisplayUrl } from '../src/platform/assetUrl';
import { assetPreviewUrl } from '../src/media';
import type { ReferenceAsset } from '../src/types';

const source = 'lianhua-asset://local/projects/项目 A/视频 1.mp4?playback=42&signature=a%2Bb%2F%3D#t=1';
const expected = 'https://localhost/_lianhua_asset/projects/%E9%A1%B9%E7%9B%AE%20A/%E8%A7%86%E9%A2%91%201.mp4?playback=42&signature=a%2Bb%2F%3D#t=1';
assert.equal(mapManagedAssetDisplayUrl(source, true), expected);
assert.equal(mapManagedAssetDisplayUrl(source, false), source, 'desktop and browser URLs must remain byte-for-byte unchanged');
const encoded = 'lianhua-asset://local/video/%E4%B8%AD%E6%96%87%20%26%20%25.mov?playback=7';
assert.equal(mapManagedAssetDisplayUrl(encoded, true), 'https://localhost/_lianhua_asset/video/%E4%B8%AD%E6%96%87%20%26%20%25.mov?playback=7', 'an already-encoded path must not be double encoded');
for (const other of [
  'https://example.test/a.mp4?signature=a%2Bb', 'data:image/png;base64,AAAA',
  'blob:https://localhost/id', 'https://localhost/_lianhua_asset/a.mp4?playback=5',
  'lianhua-asset://other/a.mp4', '',
]) assert.equal(mapManagedAssetDisplayUrl(other, true), other, 'only the canonical local-asset display protocol is mapped');

const asset = Object.freeze({ id: 'asset-a', name: '视频', type: 'video', mediaType: 'video', role: 'motion', source: 'upload',
  tags: Object.freeze([]), url: source, relativePath: 'projects/项目 A/视频 1.mp4', checksum: 'same-content', createdAt: 1, updatedAt: 1 }) as unknown as ReferenceAsset;
const saved = JSON.stringify({ asset, frame: { url: source, relativePath: asset.relativePath } });
const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaPlatform: 'android' } });
  assert.equal(assetPreviewUrl(asset), expected, 'the actual image/audio/video preview entry maps Android display URLs');
  assert.equal(assetPreviewUrl({ ...asset, dataUrl: 'data:image/png;base64,AAAA' }), 'data:image/png;base64,AAAA');
  assert.equal(JSON.stringify({ asset, frame: { url: source, relativePath: asset.relativePath } }), saved, 'previewing must not rewrite any saved object or canonical frame URL');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaPlatform: 'desktop' } });
  assert.equal(assetPreviewUrl(asset), source);
} finally {
  if (previous) Object.defineProperty(globalThis, 'window', previous);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log('Android asset display URL: platform isolation, encoded paths, queries and persisted objects passed');
