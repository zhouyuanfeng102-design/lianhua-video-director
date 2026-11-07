import { useState, type ReactNode } from "react";
import { assetPreviewUrl } from "../../media";
import type { ReferenceAsset } from "../../types";
import type { VideoImageReference } from "../../videoGenerationTypes";

export function PhoneVideoComposer({
  taskLabel, onOpenJobs, onChoosePrompt, sourceLabel, onOpenSource, onClearSource,
  formatValue, languageValue, formatDisabled, languageDisabled, onFormat, onLanguage,
  references, assets, onRemoveReference, onPickImages,
  summary, prompt, onPrompt, more, generateDisabled, submitting, onGenerate, notice, error,
}: {
  taskLabel?: string;
  onOpenJobs?: () => void;
  onChoosePrompt: () => void;
  sourceLabel?: string;
  onOpenSource?: () => void;
  onClearSource?: () => void;
  formatValue: string;
  languageValue: string;
  formatDisabled: boolean;
  languageDisabled: boolean;
  onFormat: (value: string) => void;
  onLanguage: (value: string) => void;
  references: VideoImageReference[];
  assets: ReferenceAsset[];
  onRemoveReference: (reference: VideoImageReference, index: number) => void;
  onPickImages: () => void;
  summary: string;
  prompt: string;
  onPrompt: (value: string) => void;
  more: ReactNode;
  generateDisabled: boolean;
  submitting: boolean;
  onGenerate: () => void;
  notice?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="phone-video">
      {taskLabel && <button type="button" className="phone-task-banner" onClick={onOpenJobs}>{taskLabel}</button>}
      <div className="phone-video-scroll">
        <button type="button" className="phone-secondary" onClick={onChoosePrompt}>从提示词导演台选择</button>
        {sourceLabel && <p className="phone-source-line">{sourceLabel}{onOpenSource && <button type="button" onClick={onOpenSource}>查看原稿</button>}{onClearSource && <button type="button" onClick={onClearSource}>解除来源关联</button>}</p>}
        <div className="phone-source-selects">
          <label>格式<select aria-label="本次提示词格式" value={formatValue} disabled={formatDisabled} onChange={(event) => onFormat(event.target.value)}><option value="legacy" disabled>历史稿（保留正文）</option><option value="h3">H3</option><option value="seedance">Seedance</option><option value="ordinary">普通稿</option></select></label>
          <label>语言<select aria-label="本次稿件语言" value={languageValue} disabled={languageDisabled} onChange={(event) => onLanguage(event.target.value)}><option value="zh">中文</option><option value="en">英文描述</option></select></label>
        </div>
        <div className="phone-reference-strip">
          {references.map((reference, index) => {
            const asset = assets.find((item) => item.id === reference.assetId);
            const url = asset ? assetPreviewUrl(asset) : "";
            return <figure key={`${reference.assetId}-${index}`}><span>{url ? <img src={url} alt={asset?.name || ""} /> : "缺图"}</span><button type="button" onClick={() => onRemoveReference(reference, index)}>移除</button></figure>;
          })}
          <button type="button" onClick={onPickImages}>选图</button>
        </div>
        <p className="phone-summary">{summary}</p>
        <textarea className="vd-prompt-editor phone-prompt-editor" aria-label="本次生成使用的完整提示词" value={prompt} placeholder="选择已有中文 / 英文描述，或在这里填写完整提示词。不会重新扩写、翻译对白或裁剪字数。" onChange={(event) => onPrompt(event.target.value)} />
        <button type="button" className="phone-secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>更多设置</button>
        {open && <div className="phone-more-panel">{more}</div>}
        {error && <p className="vd-error" role="alert">{error}</p>}
        {notice && <p className="vd-success" role="status">{notice}</p>}
      </div>
      <div className="phone-generate-bar">
        <button type="button" className="phone-primary" disabled={generateDisabled} onClick={onGenerate}>{submitting ? "正在建立任务…" : "生成视频"}</button>
        <p>点击才会提交生成，API 可能产生费用；不会自动重复提交结果不明的任务。</p>
      </div>
    </div>
  );
}
