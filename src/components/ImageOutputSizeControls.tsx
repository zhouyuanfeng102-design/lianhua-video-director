import { IMAGE_OUTPUT_ASPECTS, IMAGE_OUTPUT_MAX_SIDE, type ImageOutputSizePreference, type ResolvedImageOutputSize } from '../imageOutputSize';
import type { ImageVariant } from '../types';
import '../imageOutputSize.css';

export function ImageOutputSizeControls({ lane, value, resolved, disabled, capabilityNote, onChange }: {
  lane: 'ordinary' | 'private'; value: ImageOutputSizePreference; resolved: ResolvedImageOutputSize;
  variant: ImageVariant; disabled: boolean; capabilityNote: string;
  onChange: (value: ImageOutputSizePreference) => void;
}) {
  const label = lane === 'private' ? '私密' : '普通';
  const custom = value.mode === 'custom';
  const legacy = value.mode === 'default' || value.mode === '1x' || value.mode === '2x';
  const namedResolution = resolved.resolutionPlan?.encoding.kind === 'tier';
  const sizeLabel = namedResolution ? resolved.resolutionPlan?.verified ? '原生预期' : '档位估算（以返回为准）' : '请求';
  return <div className="image-output-size-controls" role="group" aria-label={`${label}生图分辨率设置`}>
    <div className="image-output-size-row">
      <label><span>生图分辨率</span><select aria-label={`${label}生图分辨率`} value={value.mode} disabled={disabled} onChange={(event) => onChange({ ...value, mode: event.target.value as ImageOutputSizePreference['mode'], resolutionVersion: 1 })}>
        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option><option value="custom">自定义宽高</option>
        {legacy && <option value={value.mode}>旧规格 · {resolved.width}×{resolved.height}</option>}
      </select></label>
      {custom ? <>
        <label className="image-output-size-number"><span>宽</span><input aria-label={`${label}生图宽度像素`} type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={value.width || ''} disabled={disabled} onChange={(event) => onChange({ ...value, width: Number(event.target.value), resolutionVersion: 1 })} /></label>
        <label className="image-output-size-number"><span>高</span><input aria-label={`${label}生图高度像素`} type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={value.height || ''} disabled={disabled} onChange={(event) => onChange({ ...value, height: Number(event.target.value), resolutionVersion: 1 })} /></label>
      </> : <label><span>比例</span><select aria-label={`${label}生图画面比例`} value={value.mode === 'default' ? 'variant' : value.aspect} disabled={disabled || value.mode === 'default'} onChange={(event) => onChange({ ...value, aspect: event.target.value as ImageOutputSizePreference['aspect'], resolutionVersion: 1 })}>
        {IMAGE_OUTPUT_ASPECTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>}
    </div>
    <div className="image-output-size-summary"><span>{`${sizeLabel} ${resolved.width} × ${resolved.height} px`}{resolved.layoutNote ? ` · ${resolved.layoutNote}` : ''}</span>
      <details><summary>尺寸说明</summary><p>{capabilityNote} 1K、2K、4K是生图分辨率档位；原生模型按其规格提交，自由像素后端按本机档位映射。实际请求宽高和必要的对齐显示于此。各视图数量与位置保持所选版式，画幅按当前请求尺寸生成；模型能力和版式提醒不阻止提交。旧规格保留原尺寸；自定义宽高按输入提交。</p></details>
    </div>
    {resolved.warning && <p className="field-hint image-output-size-warning" role="status" style={{ margin: '4px 0 0' }}>{resolved.warning}</p>}
    {resolved.issue && <p className="image-output-size-error" role="alert">{resolved.issue}</p>}
  </div>;
}
