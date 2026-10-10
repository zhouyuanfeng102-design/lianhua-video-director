import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ReferenceAsset } from '../types';
import { assetPreviewUrl } from '../media';
import { releaseVideoElement, videoPlaybackSourceUrl } from '../videoAssetPreview';
import '../assetVideoPreview.css';

export function AssetVideoPlayerDialog({ asset, onClose, onMetadata }: {
  asset: ReferenceAsset; onClose: () => void; onMetadata: (metadata: { durationSec?: number; width?: number; height?: number }) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, onMetadata }); callbacks.current = { onClose, onMetadata };
  const [error, setError] = useState('');
  const sourceActive = useRef(false);
  const loadedSource = useRef('');
  const previewUrl = assetPreviewUrl(asset);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    sourceActive.current = true;
    setError('');
    if (previewUrl) { loadedSource.current = videoPlaybackSourceUrl(previewUrl); video.src = loadedSource.current; video.load(); }
    else setError('没有可播放的视频文件，请重新定位素材。');
    return () => {
      // Closing and StrictMode cleanup cancel the old load. Those cancellation
      // events must not become a playback failure for the next open.
      sourceActive.current = false;
      releaseVideoElement(video);
    };
  }, [previewUrl]);
  useEffect(() => {
    const previous = document.activeElement;
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
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <div className="asset-video-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="asset-video-dialog" role="dialog" aria-modal="true" aria-label={`播放视频：${asset.name}`}>
      <header><div><h3>{asset.name}</h3><p>仅加载当前视频；关闭即停止播放并释放播放器。</p></div><button ref={closeRef} type="button" className="btn small" aria-label="关闭视频播放" onClick={onClose}><X size={15} />关闭</button></header>
      <video ref={videoRef} controls autoPlay preload="metadata" playsInline
        onError={(event) => {
          const video = event.currentTarget;
          if (!sourceActive.current || video.getAttribute('src') !== loadedSource.current || !video.error || video.error.code === 1) return;
          setError(video.error.code === 2 ? '视频文件读取中断，请重新加载后播放。'
            : video.error.code === 3 ? '视频解码失败，请重新加载；若仍失败，当前视频编码可能不受播放器支持。'
              : '播放器无法读取此视频，请检查文件是否完整或编码是否受支持。');
        }}
        onLoadStart={() => { if (sourceActive.current) setError(''); }}
        onCanPlay={() => { if (sourceActive.current) setError(''); }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (!sourceActive.current) return;
          setError('');
          callbacks.current.onMetadata({ durationSec: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 100) / 100 : undefined,
            width: video.videoWidth || undefined, height: video.videoHeight || undefined });
        }} />
      {error && <div className="asset-video-error" role="alert"><p>{error}</p>{previewUrl && <button type="button" className="btn small" onClick={() => {
        const video = videoRef.current;
        if (!video || !sourceActive.current) return;
        setError(''); releaseVideoElement(video); loadedSource.current = videoPlaybackSourceUrl(previewUrl); video.src = loadedSource.current; video.load();
        void video.play().catch(() => { /* native controls remain available if autoplay is declined */ });
      }}>重新加载视频</button>}</div>}
    </div>
  </div>;
}
