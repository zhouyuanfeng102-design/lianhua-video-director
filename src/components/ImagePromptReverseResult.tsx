import { useEffect, useState } from 'react';
import type { ImagePromptReverseResult, ReferenceAsset } from '../types';
import type { StoryboardReferenceImageLoader } from '../storyboardImages';
import { assetPreviewUrl } from '../media';
import { normalizeReferenceImageDataUrl } from '../imageReferenceData';
import './ImagePromptReverseResult.css';

const sections = (result: ImagePromptReverseResult) => [
  { title: '1、可直接复用的反推提示词', text: result.prompt,
    details: [['关键还原点', result.keyPoints], ['避免项', result.avoid], ['调整建议', result.adjustmentSuggestions]] },
  { title: '2、人物详细信息', text: result.characters, details: [] },
  { title: '3、物品详细信息', text: result.objects, details: [['图中文字', result.readableText]] },
  { title: '4、场景详细信息', text: result.scene, details: [['构图与视角', result.composition]] },
  { title: '5、具体风格详细信息', text: result.style,
    details: [['光线', result.lighting], ['配色', result.colors], ['不确定的细节', result.uncertainties]] },
];

/** One formatting source for the chat, task details and full-text clipboard. */
export const formatImagePromptReverseResult = (result: ImagePromptReverseResult): string => sections(result)
  .map(section => [section.title, section.text,
    ...section.details.filter(([, value]) => value?.trim()).map(([label, value]) => `${label}：${value}`),
  ].join('\n\n')).join('\n\n');

export function ImagePromptReverseResultView({ result }: { result: ImagePromptReverseResult }) {
  return <div className="image-prompt-reverse-analysis">
    {sections(result).map(section => <section className="image-prompt-reverse-section" key={section.title}>
      <h4>{section.title}</h4><div className="image-prompt-reverse-text">{section.text}</div>
      {section.details.filter(([, value]) => value?.trim()).map(([label, value]) => <div className="image-prompt-reverse-detail" key={label}>
        <strong>{label}：</strong><span>{value}</span>
      </div>)}
    </section>)}
  </div>;
}

interface ReferencePreviewProps {
  asset?: ReferenceAsset;
  readManagedImageDataUrl?: StoryboardReferenceImageLoader['readManagedImageDataUrl'];
  className?: string;
  onPreview?: (asset: ReferenceAsset) => void;
}

/** Reads the frozen original locator, independently of later asset-library edits. */
export function ImagePromptReverseReferencePreview({ asset, readManagedImageDataUrl, className = '', onPreview }: ReferencePreviewProps) {
  const identity = asset ? JSON.stringify([asset.id, asset.relativePath, asset.checksum, asset.dataUrl, asset.url, asset.missing]) : '';
  const [loaded, setLoaded] = useState({ identity: '', url: '', failed: false });
  const matches = loaded.identity === identity;
  const url = matches ? loaded.url : '';
  useEffect(() => {
    let cancelled = false;
    if (!asset) { setLoaded({ identity, url: '', failed: true }); return; }
    const load = async () => {
      try {
        if (asset.missing) throw new Error('Original missing');
        let preview = '';
        if (asset.relativePath && asset.checksum && readManagedImageDataUrl) {
          const original = await readManagedImageDataUrl({ relativePath: asset.relativePath, expectedChecksum: asset.checksum });
          preview = normalizeReferenceImageDataUrl(typeof original === 'string' ? original : original?.dataUrl || '');
        } else preview = assetPreviewUrl(asset);
        if (!preview) throw new Error('Original preview unavailable');
        if (!cancelled) setLoaded({ identity, url: preview, failed: false });
      } catch { if (!cancelled) setLoaded({ identity, url: '', failed: true }); }
    };
    void load();
    return () => { cancelled = true; };
  }, [identity, readManagedImageDataUrl]);
  const image = url ? <img className={className} src={url} alt={`${asset?.name || '图片反推'} 原图`} loading="lazy" />
    : <span className={`${className} image-prompt-reverse-original-placeholder`}>{matches && loaded.failed ? '原图暂不可预览' : '读取原图…'}</span>;
  return onPreview ? <button type="button" className="custom-image-reference-preview" disabled={!url || !asset}
    onClick={() => { if (url && asset) onPreview({ ...asset, dataUrl: url }); }} aria-label={`预览反推原图${asset?.name || ''}`}>
    {image}<span>{asset?.name || '反推原图'}</span>
  </button> : image;
}
