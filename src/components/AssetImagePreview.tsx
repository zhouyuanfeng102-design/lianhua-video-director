import { useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';

export const IMAGE_PREVIEW_MIN_ZOOM = 25;
export const IMAGE_PREVIEW_MAX_ZOOM = 400;
const ZOOM_STEP = 25;
interface ImageSize { width: number; height: number }

export function clampImagePreviewZoom(value: number): number {
  return Number.isFinite(value) ? Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, value)) : 100;
}

/** 100% means contain the entire original image in the available viewport. */
export function getImagePreviewSize(image: ImageSize, viewport: ImageSize, zoom: number): ImageSize {
  if (![image.width, image.height, viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 };
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height) * clampImagePreviewZoom(zoom) / 100;
  return { width: image.width * scale, height: image.height * scale };
}

/** Display-only zoom. The source URL and the asset's export data are never changed. */
export function AssetImagePreview({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(100);
  const [imageSize, setImageSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef({ x: .5, y: .5 });
  const rendered = getImagePreviewSize(imageSize, viewportSize, zoom);
  const ready = !failed && rendered.width > 0 && rendered.height > 0;

  const rememberCenter = () => {
    const pane = paneRef.current;
    if (pane?.scrollWidth && pane.scrollHeight) centerRef.current = {
      x: (pane.scrollLeft + pane.clientWidth / 2) / pane.scrollWidth,
      y: (pane.scrollTop + pane.clientHeight / 2) / pane.scrollHeight,
    };
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      rememberCenter();
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      setViewportSize((previous) => previous.width === next.width && previous.height === next.height ? previous : next);
    };
    measure();
    // Observe the outer viewport, not its scroller: scrollbar appearance must
    // not change the fit size and trigger a resize/zoom feedback loop.
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    pane.scrollLeft = centerRef.current.x * pane.scrollWidth - pane.clientWidth / 2;
    pane.scrollTop = centerRef.current.y * pane.scrollHeight - pane.clientHeight / 2;
  }, [rendered.width, rendered.height]);

  const changeZoom = (difference: number) => {
    rememberCenter();
    setZoom((current) => clampImagePreviewZoom(current + difference));
  };
  const resetZoom = () => {
    centerRef.current = { x: .5, y: .5 };
    setZoom(100);
  };

  return <div className="asset-image-viewer">
    <div className="asset-preview-zoom-toolbar" role="group" aria-label="图片缩放">
      <button type="button" className="btn small" aria-label="缩小图片" disabled={!ready || zoom <= IMAGE_PREVIEW_MIN_ZOOM} onClick={() => changeZoom(-ZOOM_STEP)}><ZoomOut size={15} aria-hidden="true" />缩小</button>
      <output className="asset-preview-zoom-value" aria-label="图片缩放比例" aria-live="polite" title="相对于适应窗口的大小">{zoom}%</output>
      <button type="button" className="btn small" aria-label="放大图片" disabled={!ready || zoom >= IMAGE_PREVIEW_MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)}><ZoomIn size={15} aria-hidden="true" />放大</button>
      <button type="button" className="btn small ghost" aria-label="还原图片缩放" title="还原为适应窗口大小" disabled={!ready} onClick={resetZoom}><RotateCcw size={14} aria-hidden="true" />还原</button>
      <span className="asset-preview-zoom-hint">100% 为适应窗口；放大后可滚动查看。</span>
    </div>
    <div ref={viewportRef} className="asset-preview-viewport">
      <div ref={paneRef} className="asset-preview-pane" role="region" aria-label="图片预览，可滚动查看细节" tabIndex={0}>
        <div className="asset-preview-stage" style={{ width: ready ? rendered.width : '100%', height: ready ? rendered.height : '100%' }}>
          <img src={src} alt={alt} draggable={false} style={{ width: rendered.width || 1, height: rendered.height || 1, visibility: ready ? 'visible' : 'hidden' }}
            onLoad={(event) => { setFailed(false); setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
            onError={() => setFailed(true)} />
        </div>
      </div>
      {!ready && <div className="asset-preview-image-status" role="status">{failed ? '图片加载失败，请关闭后重试。' : '正在加载图片…'}</div>}
    </div>
  </div>;
}
