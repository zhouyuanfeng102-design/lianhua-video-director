import { useEffect, useRef, useState } from 'react';
import { Film, Play } from 'lucide-react';
import type { ReferenceAsset } from '../types';
import { assetPreviewUrl } from '../media';
import { videoAssetPoster } from '../videoAssetPreview';
import '../assetVideoPreview.css';

// Small native PNGs only. Video bytes are never loaded by a card, even when
// FFmpeg is unavailable. Both memory and native disk caches are bounded.
const thumbnails = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const remember = (key: string, url: string) => {
  thumbnails.delete(key); thumbnails.set(key, url);
  while (thumbnails.size > 128) thumbnails.delete(thumbnails.keys().next().value!);
};

export function AssetVideoThumbnail({ projectId, asset, assets, onPlay }: {
  projectId: string; asset: ReferenceAsset; assets: ReferenceAsset[]; onPlay: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const key = JSON.stringify([projectId, asset.id, asset.relativePath, asset.checksum]);
  const [loaded, setLoaded] = useState<{ key: string; url: string }>({ key: '', url: '' });
  const [failedPoster, setFailedPoster] = useState('');
  const poster = videoAssetPoster(asset, assets);
  const staticPoster = poster && poster !== failedPoster ? poster : '';
  const thumbnail = staticPoster || thumbnails.get(key) || (loaded.key === key ? loaded.url : '');
  const playable = !asset.missing && Boolean(assetPreviewUrl(asset));
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '80px' });
    observer.observe(button); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const getThumbnail = window.lianhuaDesktop?.getVideoThumbnail;
    if (!visible || !playable || staticPoster || thumbnails.has(key) || !asset.relativePath || !getThumbnail) return;
    let active = true;
    let request = pending.get(key);
    if (!request) {
      request = getThumbnail({ projectId, assetId: asset.id, relativePath: asset.relativePath, expectedChecksum: asset.checksum }).then((result) => {
        if (result.mimeType !== 'image/png' || !result.dataUrl.startsWith('data:image/png;base64,') || result.sizeBytes > 1024 * 1024) throw new Error('视频缩略图格式无效');
        remember(key, result.dataUrl); return result.dataUrl;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    void request.then((url) => { if (active) setLoaded({ key, url }); }).catch(() => { /* Static icon fallback; clicking play remains available. */ });
    return () => { active = false; };
  }, [key, visible, playable, staticPoster, projectId, asset.id, asset.relativePath, asset.checksum]);
  return <button ref={buttonRef} type="button" className="asset-video-thumbnail" aria-label={`播放视频：${asset.name}`} disabled={!playable}
    title={playable ? '点击才加载并播放此视频；列表不加载播放器' : '视频文件缺失，请先重连'} onClick={onPlay}>
    {thumbnail ? <img src={thumbnail} alt={`${asset.name} · 视频缩略图`} loading="lazy" decoding="async" onError={() => { if (thumbnail === poster) setFailedPoster(poster); else { thumbnails.delete(key); setLoaded({ key, url: '' }); } }} /> : <span className="asset-video-placeholder"><Film size={34} /><small>{asset.missing ? '原视频缺失' : '视频预览'}</small></span>}
    <span className="asset-video-play"><Play size={19} fill="currentColor" /><span>点击播放</span></span>
    {typeof asset.durationSec === 'number' && asset.durationSec > 0 && <span className="asset-video-duration">{Math.floor(asset.durationSec / 60)}:{Math.floor(asset.durationSec % 60).toString().padStart(2, '0')}</span>}
  </button>;
}
