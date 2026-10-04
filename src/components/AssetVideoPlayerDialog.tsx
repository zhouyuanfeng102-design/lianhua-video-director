import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ReferenceAsset } from '../types';
import { assetPreviewUrl } from '../media';
import { releaseVideoElement } from '../videoAssetPreview';
import '../assetVideoPreview.css';

export function AssetVideoPlayerDialog({ asset, onClose, onMetadata }: {
  asset: ReferenceAsset; onClose: () => void; onMetadata: (metadata: { durationSec?: number; width?: number; height?: number }) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, onMetadata }); callbacks.current = { onClose, onMetadata };
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement;
    const video = videoRef.current;
    // React StrictMode re-runs setup after its simulated cleanup on the same
    // element. Restore the source there without retaining a decoder on close.
    if (video && video.getAttribute('src') !== assetPreviewUrl(asset)) {
      video.src = assetPreviewUrl(asset); video.load();
    }
    closeRef.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); callbacks.current.onClose(); }
      if (event.key === 'Tab' && dialogRef.current) {
        const elements = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),video[controls]')];
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      if (video) releaseVideoElement(video);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <div className="asset-video-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="asset-video-dialog" role="dialog" aria-modal="true" aria-label={`播放视频：${asset.name}`}>
      <header><div><h3>{asset.name}</h3><p>仅加载当前视频；关闭即停止播放并释放播放器。</p></div><button ref={closeRef} type="button" className="btn small" aria-label="关闭视频播放" onClick={onClose}><X size={15} />关闭</button></header>
      <video ref={videoRef} src={assetPreviewUrl(asset)} controls autoPlay preload="metadata" playsInline
        onError={() => setError('此视频无法播放，请检查文件是否完整或编码是否受支持。原视频未修改。')}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          callbacks.current.onMetadata({ durationSec: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 100) / 100 : undefined,
            width: video.videoWidth || undefined, height: video.videoHeight || undefined });
        }} />
      {error && <p className="asset-video-error" role="alert">{error}</p>}
    </div>
  </div>;
}
