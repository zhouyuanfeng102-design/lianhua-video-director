import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ReferenceAsset } from '../src/types';
import { matchesVideoSelection, releaseVideoElement, selectVideoAsset, videoAssetPoster, videoPlaybackSourceUrl } from '../src/videoAssetPreview';
import { IMAGE_VARIANT_OPTIONS, getImageVariantGenerationSpec } from '../src/imageGeneration';
const video: ReferenceAsset = { id: 'video', name: '视频', type: 'video', mediaType: 'video', role: 'motion', source: 'generated', tags: [],
  url: 'https://example.test/video.mp4', relativePath: 'video/a.mp4', checksum: 'hash-a', createdAt: 1, updatedAt: 1 };
const selection = selectVideoAsset('project-a', video);
assert.ok(matchesVideoSelection(selection, 'project-a', video));
assert.ok(matchesVideoSelection(selection, 'project-a', { ...video, durationSec: 10, name: '新名称' }), 'metadata does not restart the decoder');
for (const [projectId, asset] of [
  ['project-b', video], ['project-a', { ...video, missing: true }], ['project-a', { ...video, checksum: 'hash-b' }],
  ['project-a', { ...video, relativePath: 'video/b.mp4' }], ['project-a', { ...video, url: 'https://example.test/b.mp4' }],
] as const) assert.equal(matchesVideoSelection(selection, projectId, asset), false);
const poster: ReferenceAsset = { ...video, id: 'poster', type: 'reference', mediaType: 'image', mimeType: 'image/png', url: 'https://example.test/poster.png', relativePath: undefined, sourceVideoChecksum: video.checksum };
assert.equal(videoAssetPoster({ ...video, thumbnailAssetId: poster.id }, [poster]), poster.url);
assert.equal(videoAssetPoster({ ...video, thumbnailAssetId: 'gone', firstFrameAssetId: poster.id }, [poster]), poster.url);
assert.equal(videoAssetPoster({ ...video, thumbnailAssetId: poster.id }, [{ ...poster, sourceVideoChecksum: 'other-version' }]), '');
assert.equal(videoAssetPoster({ ...video, thumbnailAssetId: poster.id }, [{ ...poster, missing: true }]), '');
assert.equal(videoAssetPoster(video, [poster]), '', 'unlinked generation reference is never presented as a real video frame');
const operations: string[] = [];
releaseVideoElement({ pause: () => operations.push('pause'), removeAttribute: (name: string) => operations.push(`remove:${name}`), load: () => operations.push('load') });
assert.deepEqual(operations, ['pause', 'remove:src', 'load']);
const localUrl = 'lianhua-asset://local/video/%E4%B8%AD%E6%96%87%20%26%20%25.mov';
const firstPlayback = videoPlaybackSourceUrl(localUrl); const reopenedPlayback = videoPlaybackSourceUrl(localUrl);
assert.notEqual(firstPlayback, reopenedPlayback, 'new local attempts must not reuse failed decoder resources');
assert.equal(new URL(firstPlayback).pathname, new URL(localUrl).pathname, 'the same original local media file is used');
assert.equal(videoPlaybackSourceUrl('https://example.test/video.mp4?signature=unchanged'), 'https://example.test/video.mp4?signature=unchanged', 'do not alter remote signed video URLs');
assert.equal(videoPlaybackSourceUrl('data:video/mp4;base64,AAAA'), 'data:video/mp4;base64,AAAA');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const assets = app.slice(app.indexOf('function AssetsView('), app.indexOf('function', app.indexOf('function AssetsView(') + 25));
assert.match(app, /<AssetVideoThumbnail projectId=/u);
assert.match(app, /playingVideoAsset && videoPreviewSelection && <AssetVideoPlayerDialog/u);
assert.doesNotMatch(assets, /<video\b/u, 'the entire asset library must not mount card video elements');
const thumb = readFileSync(new URL('../src/components/AssetVideoThumbnail.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(thumb, /<video\b|createElement\(['"]video/u);
assert.match(thumb, /IntersectionObserver/u); assert.match(thumb, /thumbnails\.size > 128/u);
assert.equal(IMAGE_VARIANT_OPTIONS.character.includes('reference'), false);
assert.equal(getImageVariantGenerationSpec('reference').id, 'reference', 'old task snapshots keep their original generation meaning');
console.log('Video asset preview: no eager card players, guarded selection, true poster linkage, resource release and removed framing shortcut checks passed.');
