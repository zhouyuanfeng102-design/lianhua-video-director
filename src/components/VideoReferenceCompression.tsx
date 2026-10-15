import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ReferenceAsset } from '../types';
import type { VideoTransportImage } from '../videoGenerationTypes';
import { videoImageRole } from '../videoDirectorDraft';
import { addVideoReference, type VideoReferenceSelection } from '../videoReferenceSlots';
import { normalizeVideoTransportImage, videoTransportReferenceAsset } from '../videoTransportImage';
import { createVideoCompressionCandidate, disposeVideoCompressionCandidate, formatVideoImageSize, saveVideoCompressionCandidate, videoImageDataSize, type VideoCompressionCandidate } from '../videoReferenceCompression';
import { formatUserFacingError } from '../userFacingError';

const sameOriginal = (left: ReferenceAsset, right?: ReferenceAsset) => Boolean(right && left.id === right.id && left.checksum === right.checksum && left.relativePath === right.relativePath && left.dataUrl === right.dataUrl && left.url === right.url);

function CompressionPreviews({ candidate }: { candidate: VideoCompressionCandidate }) {
  const [fullSize, setFullSize] = useState(false);
  const original = useRef<HTMLDivElement>(null), output = useRef<HTMLDivElement>(null);
  const sync = (source: HTMLDivElement, target?: HTMLDivElement | null) => {
    if (target && (target.scrollLeft !== source.scrollLeft || target.scrollTop !== source.scrollTop)) { target.scrollLeft = source.scrollLeft; target.scrollTop = source.scrollTop; }
  };
  return <>
    <label className="check-row"><input type="checkbox" checked={fullSize} onChange={(event) => setFullSize(event.target.checked)} />原尺寸查看（左右滚动位置同步）</label>
    <div className={`vd-compression-previews${fullSize ? ' is-full-size' : ''}`}>
      <div><strong>资产库原图 · {formatVideoImageSize(candidate.image.originalSizeBytes)}</strong><div ref={original} onScroll={(event) => sync(event.currentTarget, output.current)}><img src={candidate.originalUrl} alt="压缩前原图" style={fullSize ? { width: candidate.image.originalWidth, maxWidth: 'none' } : undefined} /></div></div>
      <div><strong>视频候选副本 · {formatVideoImageSize(candidate.image.sizeBytes)}</strong><div ref={output} onScroll={(event) => sync(event.currentTarget, original.current)}><img src={candidate.previewUrl} alt="压缩后候选副本" style={fullSize ? { width: candidate.image.width, maxWidth: 'none' } : undefined} /></div></div>
    </div>
  </>;
}

/** This hook is mounted only by the video reference pickers. No project asset is edited. */
export function useVideoReferenceCompression({ assets, selection, onChange, active, scope, byteLimit }: {
  assets: ReferenceAsset[]; selection: VideoReferenceSelection;
  onChange: Dispatch<SetStateAction<VideoReferenceSelection>>; active: boolean; scope: string;
  byteLimit?: number;
}) {
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [candidates, setCandidates] = useState<VideoCompressionCandidate[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState('');
  const [work, setWork] = useState('');
  const [error, setError] = useState('');
  const latest = useRef({ assets, selection, onChange, active, scope }); latest.current = { assets, selection, onChange, active, scope };
  const pending = useRef<AbortController>();
  const resources = useRef<VideoCompressionCandidate[]>([]);
  const dispose = () => { resources.current.forEach(disposeVideoCompressionCandidate); resources.current = []; };
  const closeReview = () => { pending.current?.abort(); pending.current = undefined; dispose(); setCandidates([]); setChosen([]); setWork(''); };
  useEffect(() => {
    setSizes({}); setError(''); setCandidates([]); setChosen([]); setWork('');
    return () => { pending.current?.abort(); pending.current = undefined; dispose(); };
  }, [scope, active]);
  const selectedKey = selection.references.map((reference) => {
    const asset = assets.find((entry) => entry.id === reference.assetId);
    return `${reference.assetId}:${asset?.checksum || ''}:${asset?.relativePath || ''}`;
  }).join('|');
  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      for (const reference of selection.references) {
        const asset = assets.find((entry) => entry.id === reference.assetId);
        if (!asset) continue;
        let size = videoImageDataSize(asset.dataUrl) ?? asset.sizeBytes;
        if (asset.relativePath && window.lianhuaDesktop?.assetStatus) {
          try {
            const info = await window.lianhuaDesktop.assetStatus(asset.relativePath);
            if (!info.exists || asset.checksum && info.checksum !== asset.checksum) continue;
            size = info.sizeBytes;
          } catch { /* Unknown sizes remain explicitly unknown. */ }
        }
        if (current && size && Number.isSafeInteger(size)) setSizes((previous) => ({ ...previous, [asset.id]: size! }));
      }
    })();
    return () => { current = false; };
  }, [active, scope, selectedKey]);

  const run = async (originals: ReferenceAsset[], quality = 0.95) => {
    if (!originals.length || !latest.current.active) return;
    closeReview(); setError('');
    const controller = new AbortController(); pending.current = controller;
    const expectedScope = latest.current.scope;
    const isCurrent = () => !controller.signal.aborted && latest.current.active && latest.current.scope === expectedScope;
    const results: VideoCompressionCandidate[] = [];
    const issues: string[] = [];
    try {
      for (const [index, asset] of originals.entries()) {
        if (!isCurrent()) return;
        setWork(`正在轻压缩 ${index + 1}/${originals.length} 张`);
        try {
          const candidate = await createVideoCompressionCandidate(asset, quality, controller.signal);
          if (!isCurrent() || !sameOriginal(asset, latest.current.assets.find((entry) => entry.id === asset.id))) { disposeVideoCompressionCandidate(candidate); return; }
          results.push(candidate); resources.current.push(candidate);
          setSizes((previous) => ({ ...previous, [asset.id]: candidate.image.originalSizeBytes }));
        } catch (cause) { if (!isCurrent()) return; issues.push(`${asset.name}：${formatUserFacingError(cause)}`); }
      }
      if (!isCurrent()) return;
      setCandidates(results); setChosen(results.filter((candidate) => candidate.smaller).map((candidate) => candidate.asset.id));
      setPreviewId(results[0]?.asset.id || ''); setError(issues.join(' '));
    } finally { if (pending.current === controller) { pending.current = undefined; if (isCurrent()) setWork(''); } }
  };
  const apply = async () => {
    if (pending.current || !latest.current.active) return;
    const items = candidates.filter((candidate) => candidate.smaller && chosen.includes(candidate.asset.id));
    if (!items.length) return;
    const controller = new AbortController(); pending.current = controller;
    const expectedScope = scope;
    const isCurrent = () => !controller.signal.aborted && latest.current.active && latest.current.scope === expectedScope;
    try {
      const stored: Array<{ candidate: VideoCompressionCandidate; image: VideoTransportImage }> = [];
      for (const [index, candidate] of items.entries()) {
        if (!isCurrent()) return;
        if (!sameOriginal(candidate.asset, latest.current.assets.find((asset) => asset.id === candidate.asset.id))) throw new Error('原图已变化，请关闭预览后重新轻压缩。');
        setWork(`正在保存视频副本 ${index + 1}/${items.length} 张`);
        stored.push({ candidate, image: await saveVideoCompressionCandidate(candidate) });
      }
      if (!isCurrent()) return;
      if (stored.some(({ candidate }) => !sameOriginal(candidate.asset, latest.current.assets.find((asset) => asset.id === candidate.asset.id)))) throw new Error('原图在保存期间发生变化，请重新轻压缩；当前选图未改变。');
      latest.current.onChange((previous) => {
        let next = previous;
        for (const { candidate, image } of stored) {
          if (!next.references.some((reference) => reference.assetId === candidate.asset.id)) next = addVideoReference(next, { assetId: candidate.asset.id, role: videoImageRole(candidate.asset) });
          next = { ...next, references: next.references.map((reference) => reference.assetId === candidate.asset.id ? { ...reference, transportImage: image } : reference) };
        }
        return next;
      });
      closeReview();
    } catch (cause) { if (isCurrent()) setError(formatUserFacingError(cause)); }
    finally { if (pending.current === controller) { pending.current = undefined; if (isCurrent()) setWork(''); } }
  };
  const displayAsset = (asset: ReferenceAsset) => {
    const reference = selection.references.find((entry) => entry.assetId === asset.id);
    try { return reference ? videoTransportReferenceAsset(reference, asset) : asset; } catch { return asset; }
  };
  const restore = (id: string) => onChange((previous) => ({ ...previous, references: previous.references.map((reference) => {
    if (reference.assetId !== id) return reference;
    const { transportImage: _copy, ...original } = reference; return original;
  }) }));
  const cardControls = (asset: ReferenceAsset) => {
    const reference = selection.references.find((entry) => entry.assetId === asset.id);
    const copy = normalizeVideoTransportImage(reference?.transportImage);
    const size = sizes[asset.id] ?? videoImageDataSize(asset.dataUrl) ?? asset.sizeBytes;
    return <div className="vd-compression-card">
      {copy ? <small>{formatVideoImageSize(copy.originalSizeBytes)} → {formatVideoImageSize(copy.sizeBytes)} · 减少 {(100 * (1 - copy.sizeBytes / copy.originalSizeBytes)).toFixed(1)}%<br />{copy.originalWidth}×{copy.originalHeight} → {copy.width}×{copy.height}</small> : <small>{reference?.transportImage ? '压缩副本记录异常，请恢复原图' : size ? `原图 ${formatVideoImageSize(size)}` : '原图大小将在轻压缩时读取'}</small>}
      <div><button type="button" className="btn small" aria-label={`轻压缩图片 ${asset.name}`} disabled={Boolean(work) || asset.missing} onClick={() => { void run([asset]); }}>轻压缩</button>{reference?.transportImage && <button type="button" className="btn small ghost" aria-label={`恢复原图 ${asset.name}`} disabled={Boolean(work)} onClick={() => restore(asset.id)}>恢复原图</button>}</div>
    </div>;
  };
  let before = 0, after = 0, unknown = 0;
  for (const reference of selection.references) {
    const asset = assets.find((entry) => entry.id === reference.assetId);
    const copy = normalizeVideoTransportImage(reference.transportImage);
    const size = copy?.originalSizeBytes ?? sizes[reference.assetId] ?? videoImageDataSize(asset?.dataUrl) ?? asset?.sizeBytes;
    if (size === undefined) unknown += 1; else { before += size; after += copy?.sizeBytes ?? size; }
  }
  const summary = <div className="vd-compression-summary" aria-label="视频参考图大小对比">
    <span>已选 {selection.references.length} 张 · {unknown ? '已知大小合计' : '合计'}：原图 {formatVideoImageSize(before)} → 本次图片文件 {formatVideoImageSize(after)}{unknown > 0 && ` · ${unknown} 张大小未读取`}</span>
    {byteLimit !== undefined && <span className={!unknown && after > byteLimit ? 'vd-error' : undefined}>上次接口返回的图片合计上限：{formatVideoImageSize(byteLimit)}{!unknown && after > byteLimit ? ' · 当前仍超限，请调整选图或压缩副本' : ''}</span>}
    <button type="button" className="btn small" disabled={Boolean(work) || !selection.references.length} onClick={() => { void run(selection.references.map((reference) => assets.find((asset) => asset.id === reference.assetId)).filter((asset): asset is ReferenceAsset => Boolean(asset))); }}>压缩已选图片</button>
    {work && <><span role="status">{work}</span><button type="button" className="btn small" onClick={closeReview}>取消压缩</button></>}
    {error && <span className="vd-error" role="alert">{error}</span>}
  </div>;
  const preview = candidates.find((candidate) => candidate.asset.id === previewId) || candidates[0];
  const review = preview ? { title: '轻压缩参考图', onClose: closeReview, content: <div className="vd-compression-review">
    <p>只生成当前视频使用的副本，资产库原图不变。保持分辨率，不裁剪、不自动降低质量。</p>
    <label className="field"><span>编码质量</span><select aria-label="轻压缩编码质量" disabled={Boolean(work)} value={preview.image.quality} onChange={(event) => { void run(candidates.map((candidate) => candidate.asset), Number(event.target.value)); }}><option value="0.95">高质量 95（默认）</option><option value="0.98">更高质量 98</option></select></label>
    {candidates.map((candidate) => <div key={candidate.asset.id} className="vd-compression-result">
      <label className="check-row"><input type="checkbox" aria-label={`使用 ${candidate.asset.name} 压缩副本`} disabled={!candidate.smaller || Boolean(work)} checked={chosen.includes(candidate.asset.id)} onChange={(event) => setChosen((previous) => event.target.checked ? [...previous, candidate.asset.id] : previous.filter((id) => id !== candidate.asset.id))} />{candidate.asset.name}</label>
      <span>{formatVideoImageSize(candidate.image.originalSizeBytes)} → {formatVideoImageSize(candidate.image.sizeBytes)} · {candidate.image.originalWidth}×{candidate.image.originalHeight} → {candidate.image.width}×{candidate.image.height} · {candidate.image.mimeType.replace('image/', '').toUpperCase()}{candidate.hasTransparency ? '（保留透明）' : ''}</span>
      <span>{candidate.smaller ? `减少 ${(100 * (1 - candidate.image.sizeBytes / candidate.image.originalSizeBytes)).toFixed(1)}%` : '本次未减小，继续使用原图'}</span>
      <button type="button" className="btn small" onClick={() => setPreviewId(candidate.asset.id)}>对比预览</button>
    </div>)}
    <CompressionPreviews key={preview.asset.id} candidate={preview} />
    {error && <p className="vd-error" role="alert">{error}</p>}{work && <p role="status">{work}</p>}
    <div className="vd-modal-footer"><button type="button" className="btn" onClick={closeReview}>保留当前选图</button><button type="button" className="btn primary" disabled={Boolean(work) || !chosen.length} onClick={() => { void apply(); }}>{candidates.length === 1 ? '使用压缩副本' : `使用 ${chosen.length} 张压缩副本`}</button></div>
  </div> } : undefined;
  return { cardControls, summary, review, displayAsset, busy: Boolean(work) };
}
