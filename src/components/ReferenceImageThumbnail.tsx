import { memo, useEffect, useRef, useState } from 'react';

import { assetPreviewUrl } from '../media';
import type { ReferenceAsset } from '../types';

const THUMBNAIL_CACHE_LIMIT = 128;
const THUMBNAIL_MAX_DIMENSION = 160;
const THUMBNAIL_MAX_BYTES = 256 * 1024;
const thumbnailCache = new Map<string, string>();
const pendingThumbnails = new Map<string, Promise<string>>();

const managedImagePath = (asset: ReferenceAsset): string => {
  if (asset.relativePath?.trim()) return asset.relativePath.trim();
  if (!asset.url?.startsWith('lianhua-asset://')) return '';
  try {
    return new URL(asset.url).pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
};

type ThumbnailLoader = NonNullable<NonNullable<Window['lianhuaDesktop']>['getImageThumbnail']>;

const loadThumbnail = (
  key: string,
  loader: ThumbnailLoader,
  relativePath: string,
  expectedChecksum: string | undefined,
): Promise<string> => {
  const cached = thumbnailCache.get(key);
  if (cached) {
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const existing = pendingThumbnails.get(key);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => loader({ relativePath, expectedChecksum }))
    .then(({ dataUrl, mimeType, width, height, sizeBytes }) => {
      if (mimeType !== 'image/png' || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')
        || dataUrl.length > Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 + 'data:image/png;base64,'.length
        || ![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= THUMBNAIL_MAX_DIMENSION)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > THUMBNAIL_MAX_BYTES) {
        throw new Error('图片缩略图不可用');
      }
      thumbnailCache.set(key, dataUrl);
      while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
        thumbnailCache.delete(thumbnailCache.keys().next().value!);
      }
      return dataUrl;
    })
    .finally(() => {
      if (pendingThumbnails.get(key) === request) pendingThumbnails.delete(key);
    });
  pendingThumbnails.set(key, request);
  return request;
};

interface ThumbnailState {
  source: string;
  url: string;
  loaded: boolean;
  failed: boolean;
}

/** Only visible picker cards request pixels; desktop cards never fall back after a thumbnail error. */
export const ReferenceImageThumbnail = memo(function ReferenceImageThumbnail({ asset }: { asset: ReferenceAsset }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const relativePath = managedImagePath(asset);
  const desktop = typeof window === 'undefined' ? undefined : window.lianhuaDesktop;
  const managed = Boolean(relativePath && desktop);
  const loader = desktop?.getImageThumbnail;
  const previewUrl = managed ? '' : assetPreviewUrl(asset);
  const source = managed
    ? `managed:${relativePath}\0${asset.checksum || ''}\0${asset.updatedAt || asset.createdAt || 0}\0${asset.sizeBytes || 0}`
    : previewUrl;
  const [visibleSource, setVisibleSource] = useState('');
  const [image, setImage] = useState<ThumbnailState>({ source: '', url: '', loaded: false, failed: false });
  const visible = Boolean(source && visibleSource === source);
  const currentImage = image.source === source ? image : undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !source) return;
    const root = host.closest('.reference-image-picker-list');
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleSource(source);
        observer.disconnect();
      }, { root, rootMargin: '0px', threshold: 0 });
      observer.observe(host);
      return () => observer.disconnect();
    }
    // Keep the same visible-only behavior in browsers without IntersectionObserver.
    const revealIfVisible = () => {
      const box = host.getBoundingClientRect();
      const viewport = root?.getBoundingClientRect() || { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      if (box.width > 0 && box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom
        && box.right > viewport.left && box.left < viewport.right) setVisibleSource(source);
    };
    revealIfVisible();
    root?.addEventListener('scroll', revealIfVisible, { passive: true });
    window.addEventListener('resize', revealIfVisible);
    return () => {
      root?.removeEventListener('scroll', revealIfVisible);
      window.removeEventListener('resize', revealIfVisible);
    };
  }, [source]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const request = managed
      ? loader ? loadThumbnail(source, loader, relativePath, asset.checksum) : Promise.reject(new Error('图片缩略图不可用'))
      : Promise.resolve(previewUrl);
    request.then((url) => {
      if (!cancelled) setImage({ source, url, loaded: false, failed: false });
    }, () => {
      if (!cancelled) setImage({ source, url: '', loaded: false, failed: true });
    });
    return () => { cancelled = true; };
  }, [asset.checksum, loader, managed, previewUrl, relativePath, source, visible]);

  const ready = Boolean(currentImage?.loaded && !currentImage.failed);
  return <span className="reference-image-picker-thumb" ref={hostRef}>
    {currentImage?.url && !currentImage.failed && <img src={currentImage.url} alt="" decoding="async" draggable={false}
      style={{ visibility: ready ? 'visible' : 'hidden' }}
      onLoad={() => setImage((current) => current.source === source ? { ...current, loaded: true } : current)}
      onError={() => setImage((current) => current.source === source ? { ...current, failed: true } : current)} />}
    {!ready && <span className="reference-image-picker-no-preview reference-image-picker-thumbnail-status">
      {currentImage?.failed ? '预览失败' : source ? '加载中…' : '无预览'}
    </span>}
  </span>;
});
