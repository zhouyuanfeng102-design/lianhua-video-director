import { useId, useMemo, useRef, useState } from 'react';
import { assetPreviewUrl } from '../media';
import { isUsableStoryboardReferenceAsset } from '../storyboardImages';
import type { ReferenceAsset, Storyboard, StoryboardImageToImageSettings } from '../types';
import { ReferenceImageName } from './ReferenceImageName';
import '../storyboardImageToImage.css';

export interface StoryboardImageToImagePanelProps {
  storyboard: Storyboard;
  assets: readonly ReferenceAsset[];
  settings: StoryboardImageToImageSettings;
  onChange: (settings: StoryboardImageToImageSettings) => void;
  onUpload: (file: File) => void | Promise<void>;
  busy?: boolean;
}

const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)];

/** An image-only selection surface. It never writes H3 fields or legacy video bindings. */
export function StoryboardImageToImagePanel({
  storyboard,
  assets,
  settings,
  onChange,
  onUpload,
  busy = false,
}: StoryboardImageToImagePanelProps) {
  const id = useId();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const usableAssets = useMemo(() => assets.filter(isUsableStoryboardReferenceAsset), [assets]);
  const usableAssetsById = useMemo(() => new Map(usableAssets.map((asset) => [asset.id, asset])), [usableAssets]);
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const visibleAssets = useMemo(() => query
    ? usableAssets.filter((asset) => [asset.name, asset.fileName, ...asset.tags].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(query))
    : usableAssets, [usableAssets, query]);
  const draftIds = uniqueIds(settings.referenceAssetIds);
  const draftSet = new Set(draftIds);
  const unavailableDraftCount = draftIds.filter((assetId) => !usableAssetsById.has(assetId)).length;
  const uploadDisabled = busy || uploading;
  const segmentLabel = storyboard.segmentIndex == null ? '当前段' : `第 ${storyboard.segmentIndex} 段`;

  const toggleReference = (assetId: string) => onChange({
    ...settings,
    referenceAssetIds: draftSet.has(assetId) ? draftIds.filter((current) => current !== assetId) : [...draftIds, assetId],
  });

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadError('');
    setUploading(true);
    try {
      for (const file of files) await onUpload(file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  return <section className="storyboard-i2i-panel" aria-label="本段分镜参考图" aria-busy={uploading}>
    <header className="storyboard-i2i-header">
      <h4 id={`${id}-references`}>本段参考图 <span>{segmentLabel} · 已选 {draftIds.length} 张</span></h4>
      <div className="storyboard-i2i-tools">
        <button type="button" className="btn small ghost" disabled={!draftIds.length} onClick={() => onChange({ ...settings, referenceAssetIds: [] })}>清空选图</button>
        <button type="button" className="btn small" disabled={uploadDisabled} onClick={() => uploadRef.current?.click()}>{uploading ? '上传中…' : '本地上传'}</button>
      </div>
    </header>
    <input ref={uploadRef} className="storyboard-i2i-file" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="上传分镜图生图参考图" disabled={uploadDisabled} onChange={(event) => {
      const files = Array.from(event.currentTarget.files || []);
      event.currentTarget.value = '';
      void uploadFiles(files);
    }} />
    <label className="storyboard-i2i-search" htmlFor={`${id}-search`}>
      <span className="storyboard-i2i-sr-only">搜索分镜参考图</span>
      <input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、文件名或标签" />
    </label>
    {uploadError && <div className="storyboard-i2i-error" role="alert">上传失败：{uploadError}</div>}
    {unavailableDraftCount > 0 && <div className="storyboard-i2i-warning" role="status"><span>已选图片中有 {unavailableDraftCount} 张不可用。</span><button type="button" className="btn small ghost" onClick={() => onChange({ ...settings, referenceAssetIds: draftIds.filter((assetId) => usableAssetsById.has(assetId)) })}>取消不可用图片</button></div>}
    <div className="storyboard-i2i-asset-list" role="group" aria-labelledby={`${id}-references`} tabIndex={0}>
      {visibleAssets.map((asset) => {
        const previewUrl = assetPreviewUrl(asset);
        const selected = draftSet.has(asset.id);
        return <label className={`storyboard-i2i-asset ${selected ? 'is-selected' : ''}`} key={asset.id}>
          <input type="checkbox" checked={selected} onChange={() => toggleReference(asset.id)} aria-label={`选择参考图：${asset.name}`} />
          <span className="storyboard-i2i-thumb">{previewUrl ? <img src={previewUrl} alt="" loading="lazy" draggable={false} /> : <span>原图</span>}</span>
          <span className="storyboard-i2i-asset-info"><ReferenceImageName name={asset.name} /><span>{asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ''}{selected ? '已选 · 点击取消' : '点击选择'}</span></span>
        </label>;
      })}
      {!visibleAssets.length && <div className="storyboard-i2i-empty">{query ? '没有匹配图片，请更换搜索词。' : '暂无可用参考图，请从本地上传。'}</div>}
    </div>
    <p className="storyboard-i2i-hint">支持多张，不必选满。在“提示词结果”使用原来的生图按钮；默认或自定义数量的每张图片都使用当前所选原图，不影响 H3 提示词及视频槽位。</p>
  </section>;
}
