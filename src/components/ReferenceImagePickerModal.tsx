import {
  useEffect,
  useId,
  useMemo,
  useState,
  type MouseEvent,
} from 'react';

import { assetPreviewUrl } from '../media';
import { ReferenceImageName } from './ReferenceImageName';
import type {
  AssetRole,
  AssetType,
  ReferenceAsset,
  ReferenceRole,
} from '../types';

export interface ReferenceImagePickerModalProps {
  open: boolean;
  assets: ReferenceAsset[];
  selectedAssetId: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (asset: ReferenceAsset) => void;
}

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  character: '角色图',
  location: '场景图',
  prop: '物品图',
  grid: '九宫格',
  reference: '参考图',
  'first-frame': '首帧图',
  'last-frame': '尾帧图',
  video: '视频',
  audio: '音频',
  'clay-render': 'Clay Render',
};

const ASSET_ROLE_LABELS: Record<AssetRole, string> = {
  character: '角色身份',
  scene: '场景空间',
  prop: '道具状态',
  grid: '九宫格',
  style: '视觉风格',
  'first-frame': '首帧',
  'last-frame': '尾帧',
  motion: '动作运动',
  audio: '声音参考',
  composition: '构图镜位',
};

const REFERENCE_ROLE_LABELS: Record<ReferenceRole, string> = {
  subject: '主体身份',
  character: '角色身份',
  scene: '场景空间',
  prop: '道具状态',
  style: '视觉风格',
  motion: '动作运动',
  composition: '构图镜位',
  camera: '摄影机',
  'first-frame': '首帧',
  'last-frame': '尾帧',
  audio: '声音参考',
  dialogue: '对白参考',
  'clay-render': 'Clay Render',
  creative: '创意参考',
  general: '通用参考',
  unknown: '未分类',
};

const assetTypeLabel = (asset: ReferenceAsset): string => (
  ASSET_TYPE_LABELS[asset.type]
);

const assetRoleLabel = (asset: ReferenceAsset): string => (
  asset.referenceRole
    ? REFERENCE_ROLE_LABELS[asset.referenceRole]
    : ASSET_ROLE_LABELS[asset.role]
);

const assetDimensions = (asset: ReferenceAsset): string => (
  asset.width && asset.height
    ? `${asset.width} × ${asset.height}`
    : '尺寸未记录'
);

const searchableAssetText = (asset: ReferenceAsset): string => [
  asset.name,
  asset.fileName,
  assetTypeLabel(asset),
  assetRoleLabel(asset),
  ...asset.tags,
]
  .filter(Boolean)
  .join(' ')
  .toLocaleLowerCase('zh-CN');

export function ReferenceImagePickerModal({
  open,
  assets,
  selectedAssetId,
  busy = false,
  onClose,
  onConfirm,
}: ReferenceImagePickerModalProps) {
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [draftAssetId, setDraftAssetId] = useState(selectedAssetId);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDraftAssetId(selectedAssetId);
  }, [open, selectedAssetId]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleAssets = useMemo(
    () => normalizedQuery
      ? assets.filter((asset) => searchableAssetText(asset).includes(normalizedQuery))
      : assets,
    [assets, normalizedQuery],
  );
  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === draftAssetId),
    [assets, draftAssetId],
  );

  if (!open) return null;

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="modal-backdrop reference-image-picker-backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="modal reference-image-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
      >
        <div className="modal-head reference-image-picker-head">
          <div>
            <h3 id={titleId}>从资产库选择参考图</h3>
            <div className="field-hint">选择当前项目中任意一张可用图片。</div>
          </div>
          <button
            className="btn small ghost"
            type="button"
            onClick={onClose}
            aria-label="关闭资产图片选择器"
          >
            <span>关闭</span>
          </button>
        </div>

        <div className="reference-image-picker-search">
          <label htmlFor={searchId}>搜索资产图片</label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、类型、职责或标签"
            autoFocus
          />
        </div>

        <div className="reference-image-picker-list">
          {visibleAssets.length > 0 ? visibleAssets.map((asset) => {
            const previewUrl = assetPreviewUrl(asset);
            const selected = asset.id === draftAssetId;
            return (
              <button
                key={asset.id}
                className={`reference-image-picker-item ${selected ? 'selected' : ''}`}
                type="button"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => setDraftAssetId(asset.id)}
              >
                <span className="reference-image-picker-thumb">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span className="reference-image-picker-no-preview">无预览</span>
                  )}
                </span>
                <span className="reference-image-picker-info">
                  <ReferenceImageName name={asset.name} />
                  <span>{assetTypeLabel(asset)} · {assetRoleLabel(asset)}</span>
                  <span>{assetDimensions(asset)}</span>
                </span>
                <span className="reference-image-picker-selection" aria-hidden="true">
                  {selected ? '✓ 已选' : '选择'}
                </span>
              </button>
            );
          }) : (
            <div className="empty reference-image-picker-empty">
              <strong>没有匹配的资产图片</strong>
              <div className="small-text">请更换搜索词，或先在资产库添加图片。</div>
            </div>
          )}
        </div>

        <div className="reference-image-picker-footer">
          <span className="field-hint">
            {selectedAsset ? <ReferenceImageName name={`已选：${selectedAsset.name}`} /> : '尚未选择图片'}
          </span>
          <div className="row">
            <button className="btn ghost" type="button" onClick={onClose}>
              <span>取消</span>
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={!selectedAsset || busy}
              onClick={() => {
                if (selectedAsset) onConfirm(selectedAsset);
              }}
            >
              <span>使用所选图片</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
