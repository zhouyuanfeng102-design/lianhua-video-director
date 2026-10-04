import { IMAGE_OUTPUT_ASPECTS, imageOutputAspectLocked, type ImageOutputSizePreference, type ResolvedImageOutputSize } from '../imageOutputSize';
import type { ImageVariant } from '../types';
import '../imageOutputSize.css';

export function ImageOutputSizeControls({ lane, value, resolved, variant, disabled, capabilityNote, onChange }: {
  lane: 'ordinary' | 'private'; value: ImageOutputSizePreference; resolved: ResolvedImageOutputSize;
  variant: ImageVariant; disabled: boolean; capabilityNote: string;
  onChange: (value: ImageOutputSizePreference) => void;
}) {
  const label = lane === 'private' ? '私密' : '普通';
  const custom = value.mode === 'custom';
  const locked = imageOutputAspectLocked(variant);
  return <div className="image-output-size-controls" role="group" aria-label={`${label}生图像素设置`}>
    <div className="image-output-size-row">
      <label><span>像素</span><select aria-label={`${label}生图像素规格`} value={value.mode} disabled={disabled} onChange={(event) => onChange({ ...value, mode: event.target.value as ImageOutputSizePreference['mode'] })}>
        <option value="default">规格默认</option><option value="1x">1X · 标准像素</option><option value="2x">2X · 高清像素</option><option value="custom">自定义宽高</option>
      </select></label>
      {custom ? <>
        <label className="image-output-size-number"><span>宽</span><input aria-label={`${label}生图宽度像素`} type="number" min={64} max={4096} step={64} value={value.width || ''} disabled={disabled} onChange={(event) => onChange({ ...value, width: Number(event.target.value) })} /></label>
        <label className="image-output-size-number"><span>高</span><input aria-label={`${label}生图高度像素`} type="number" min={64} max={4096} step={64} value={value.height || ''} disabled={disabled} onChange={(event) => onChange({ ...value, height: Number(event.target.value) })} /></label>
      </> : <label><span>比例</span><select aria-label={`${label}生图画面比例`} value={locked || value.mode === 'default' ? 'variant' : value.aspect} disabled={disabled || locked || value.mode === 'default'} onChange={(event) => onChange({ ...value, aspect: event.target.value as ImageOutputSizePreference['aspect'] })}>
        {IMAGE_OUTPUT_ASPECTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>}
    </div>
    <div className="image-output-size-summary"><span>{resolved.issue ? '请检查像素参数' : `请求 ${resolved.width} × ${resolved.height} px`}{resolved.layoutNote ? ` · ${resolved.layoutNote}` : ''}</span>
      <details><summary>尺寸说明</summary><p>{capabilityNote} 2X的总像素为同一比例1X的4倍，费用、速度和显存需求取决于后端。实际图片像素以返回结果为准。</p></details>
    </div>
    {resolved.issue && <p className="image-output-size-error" role="alert">{resolved.issue}</p>}
  </div>;
}
