import type { ReferenceAsset } from './types';
import { assetPreviewUrl } from './media';

export interface VideoAssetSelection {
  projectId: string;
  assetId: string;
  relativePath?: string;
  checksum?: string;
  sourceUrl: string;
}

let playbackAttempt = 0;
/** A fresh local request avoids Chromium reusing a prior failed media resource. */
export const videoPlaybackSourceUrl = (sourceUrl: string): string => {
  if (!sourceUrl.startsWith('lianhua-asset://local/')) return sourceUrl;
  const url = new URL(sourceUrl);
  url.searchParams.set('playback', `${Date.now()}-${++playbackAttempt}`);
  return url.toString();
};

export const selectVideoAsset = (projectId: string, asset: ReferenceAsset): VideoAssetSelection => ({
  projectId, assetId: asset.id, relativePath: asset.relativePath, checksum: asset.checksum, sourceUrl: assetPreviewUrl(asset),
});
export const matchesVideoSelection = (selection: VideoAssetSelection, projectId: string, asset: ReferenceAsset): boolean => (
  selection.projectId === projectId && selection.assetId === asset.id && !asset.missing
  && selection.relativePath === asset.relativePath && selection.checksum === asset.checksum
  && selection.sourceUrl === assetPreviewUrl(asset)
);

/** Only real linked thumbnail/first-frame assets, never the generation input. */
export const videoAssetPoster = (video: ReferenceAsset, assets: ReferenceAsset[]): string => {
  const ids = [video.thumbnailAssetId, video.firstFrameAssetId];
  const image = ids.map((id) => id && assets.find((asset) => asset.id === id)).find((asset) => asset && !asset.missing
    && (asset.mediaType === 'image' || asset.mimeType?.startsWith('image/'))
    && (!asset.sourceVideoChecksum || asset.sourceVideoChecksum === video.checksum));
  return image ? assetPreviewUrl(image) : '';
};

export const releaseVideoElement = (video: Pick<HTMLVideoElement, 'pause' | 'removeAttribute' | 'load'>): void => {
  video.pause();
  video.removeAttribute('src');
  video.load();
};
