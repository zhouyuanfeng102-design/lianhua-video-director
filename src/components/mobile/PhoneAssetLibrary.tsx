import type { ChangeEvent } from "react";
import { assetPreviewUrl } from "../../media";
import type { ReferenceAsset } from "../../types";

export function PhoneAssetLibrary({ section, assets, uploadKind, onSection, onUploadKind, onUpload, onSearch, search, onUseImage, onReuseVideo, onBind }: {
  section: "image" | "video" | "audio";
  assets: ReferenceAsset[];
  uploadKind: string;
  onSection: (section: "image" | "video" | "audio") => void;
  onUploadKind: (kind: string) => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSearch: (value: string) => void;
  search: string;
  onUseImage: (assetId: string) => void;
  onReuseVideo: (taskId: string) => void;
  onBind: (asset: ReferenceAsset) => void;
}) {
  return (
    <div className="phone-assets">
      <div className="phone-chip-row" role="tablist">
        {([["image", "图片"], ["video", "视频"], ["audio", "音频"]] as const).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={section === key} onClick={() => onSection(key)}>{label}</button>
        ))}
      </div>
      <input aria-label="搜索素材" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索名称" />
      <div className="phone-secondary-row">
        <select aria-label="上传资产类型" value={uploadKind} onChange={(event) => onUploadKind(event.target.value)}>
          {section === "image" && <>
            <option value="character">角色图</option>
            <option value="location">场景图</option>
            <option value="prop">物品图</option>
            <option value="grid">九宫格</option>
          </>}
          {section === "video" && <option value="video">视频参考</option>}
          {section === "audio" && <option value="audio">音频参考</option>}
        </select>
        <label className="phone-primary phone-upload">上传<input className="file-input" type="file" multiple accept={section === "audio" ? "audio/*" : section === "video" ? "video/*" : "image/*"} onChange={onUpload} /></label>
      </div>
      <div className="phone-asset-grid">
        {assets.map((asset) => {
          const url = assetPreviewUrl(asset);
          return <article key={asset.id} className="phone-asset-card">
            <div className="phone-asset-thumb">{url && asset.mediaType !== "audio" ? <img src={url} alt={asset.name} /> : <span>{asset.mediaType === "audio" ? "音频" : "无预览"}</span>}</div>
            <strong>{asset.name}</strong>
            <div className="phone-secondary-row">
              {section === "image" && <button type="button" onClick={() => onUseImage(asset.id)}>用此图生成视频</button>}
              {section === "video" && asset.sourceVideoTaskId && <button type="button" onClick={() => onReuseVideo(asset.sourceVideoTaskId!)}>载入相同设置再次生成</button>}
              {section === "image" && <button type="button" onClick={() => onBind(asset)}>绑定</button>}
            </div>
          </article>;
        })}
      </div>
    </div>
  );
}
