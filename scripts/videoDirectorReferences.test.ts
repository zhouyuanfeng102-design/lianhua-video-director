import assert from 'node:assert/strict';
import type { ReferenceAsset } from '../src/types';
import type { VideoGenerationDraft, VideoGenerationSnapshot } from '../src/videoGenerationTypes';
import { assetPreviewUrl } from '../src/media';
import { useCurrentVideoDraftImages, videoDraftReferenceAsset } from '../src/videoDirectorReferences';

const originalPixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const currentPixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAAC';
const current: ReferenceAsset = { id: 'same-image-id', name: '后来替换的图片BBBB', type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', dataUrl: currentPixels, tags: [], createdAt: 2, updatedAt: 2 };
const privateLibraryImage: ReferenceAsset = {
  ...current,
  id: 'private-profile-image',
  name: '人物私密资料图',
  type: 'character',
  role: 'character',
  referenceRole: 'character',
  referenceScope: 'nsfw-private-profile',
  imageVariant: 'private-full-body',
  nsfwPrivatePart: 'full-body',
};
const draft: VideoGenerationDraft = { name: 'reuse', prompt: '原对白：“别走。”', backend: 'api', reuseTaskId: 'original-task', references: [{ assetId: current.id, role: 'composition' }], parameters: { seed: 424242, steps: 30 } };
const snapshot: VideoGenerationSnapshot = {
  projectId: 'project', clientId: 'client', draft,
  connection: { backend: 'api', api: { enabled: true, endpoint: 'http://fixture.invalid', statusEndpointTemplate: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' } },
  images: [{ assetId: current.id, name: '原始图片AAAA', role: 'composition', dataUrl: originalPixels, freezeState: 'frozen', frozenAt: 1 }],
};
const originalState = JSON.stringify({ current, snapshot, draft });
assert.equal(assetPreviewUrl(videoDraftReferenceAsset({ assets: [current] }, draft.references[0], snapshot)!), originalPixels, 'same-ID replacement must not appear in the frozen draft');
assert.equal(videoDraftReferenceAsset({ assets: [current] }, draft.references[0], snapshot)?.name, '原始图片AAAA');
const deleted = videoDraftReferenceAsset({ assets: [] }, draft.references[0], snapshot)!;
assert.equal(assetPreviewUrl(deleted), originalPixels, 'deleting the live asset does not make captured pixels disappear');
assert.equal(deleted.missing, false);
const managedSnapshot = { ...snapshot, images: [{ ...snapshot.images[0], dataUrl: undefined, relativePath: 'image/old source.png', checksum: 'frozen-checksum' }] };
assert.equal(assetPreviewUrl(videoDraftReferenceAsset({ assets: [] }, draft.references[0], managedSnapshot)!), 'lianhua-asset://local/image/old%20source.png', 'managed frozen references preview their original local bytes');
assert.equal(videoDraftReferenceAsset({ assets: [] }, draft.references[0], managedSnapshot)?.missing, false);
const absentSnapshot = { ...snapshot, images: [{ assetId: current.id, name: '未保存字节的旧图', role: 'composition' as const }] };
assert.equal(videoDraftReferenceAsset({ assets: [current] }, draft.references[0], absentSnapshot)?.missing, true, 'unavailable old bytes cannot silently fall back to current BBBB');
assert.equal(assetPreviewUrl(videoDraftReferenceAsset({ assets: [current] }, draft.references[0])!), currentPixels, 'the explicit current-library path still uses current pictures');
const changed = useCurrentVideoDraftImages(draft, [current.id, 'deleted-not-in-library'], [current]);
assert.equal(changed.reuseTaskId, undefined, 'confirming new pictures unbinds old per-task pixels');
assert.equal(changed.prompt, draft.prompt);
assert.deepEqual(changed.parameters, draft.parameters, 'switching pictures cannot reset seeds or sampling');
assert.deepEqual(changed.references, draft.references, 'hidden deleted IDs are not retained by the current-library picker');
const selectedPrivate = useCurrentVideoDraftImages({ ...draft, references: [] }, [privateLibraryImage.id], [privateLibraryImage]);
assert.deepEqual(
  selectedPrivate.references,
  [{ assetId: privateLibraryImage.id, role: 'character' }],
  'the current-library picker can use every selected image asset, including private-profile images',
);
assert.equal(JSON.stringify({ current, snapshot, draft }), originalState, 'source assets, task snapshots and prior draft remain immutable');
console.log('videoDirectorReferences: frozen previews, deleted live image, no fallback, explicit new selection and seed retention passed');
