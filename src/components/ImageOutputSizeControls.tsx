import { IMAGE_OUTPUT_ASPECTS, IMAGE_OUTPUT_MAX_SIDE, type ImageOutputSizePreference, type ResolvedImageOutputSize } from '../imageOutputSize';
import type { ImageVariant } from '../types';
import '../imageOutputSize.css';

export function ImageOutputSizeControls({ lane, value, resolved, disabled, capabilityNote, onChange }: {
  lane: 'ordinary' | 'private' | 'custom'; value: ImageOutputSizePreference; resolved: ResolvedImageOutputSize;
  variant: ImageVariant; disabled: boolean; capabilityNote: string;
  onChange: (value: ImageOutputSizePreference) => void;
}) {
  const label = lane === 'custom' ? '自定义' : lane === 'private' ? '私密' : '普通';
  const custom = value.mode === 'custom';
  const workflowSize = Boolean(resolved.workflowSizeMode);
  const workflowDefault = workflowSize && value.mode === 'default';
  const workflowAspect = resolved.workflowAspect || workflowDefault;
  const legacy = value.mode === 'default' && !workflowSize || value.mode === '1x' || value.mode === '2x';
  const namedResolution = resolved.resolutionPlan?.encoding.kind === 'tier';
  const cloudEstimate = resolved.workflowSizeMode === 'tier' || resolved.workflowSizeMode === 'megapixels' || resolved.resolutionPlan?.encoding.kind === 'megapixels';
  const sizeLabel = cloudEstimate ? '档位估算（以返回为准）' : namedResolution ? resolved.resolutionPlan?.verified ? '原生预期' : '档位估算（以返回为准）' : '请求';
  const sizeSummary = workflowDefault ? '工作流默认尺寸' : `${sizeLabel} ${resolved.width} × ${resolved.height} px${resolved.layoutNote ? ` · ${resolved.layoutNote}` : ''}`;
  return <div className="image-output-size-controls" role="group" aria-label={`${label}生图分辨率设置`}>
    <div className="image-output-size-row">
      <label><span>生图分辨率</span><select aria-label={`${label}生图分辨率`} value={value.mode} disabled={disabled} onChange={(event) => onChange({ ...value, mode: event.target.value as ImageOutputSizePreference['mode'], resolutionVersion: 1 })}>
        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option><option value="custom">自定义宽高</option>
        {workflowSize && <option value="default">工作流默认尺寸</option>}
        {legacy && <option value={value.mode}>旧规格 · {resolved.width}×{resolved.height}</option>}
      </select></label>
      {custom ? <>
        <label className="image-output-size-number"><span>宽</span><input aria-label={`${label}生图宽度像素`} type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={value.width || ''} disabled={disabled} onChange={(event) => onChange({ ...value, width: Number(event.target.value), resolutionVersion: 1 })} /></label>
        <label className="image-output-size-number"><span>高</span><input aria-label={`${label}生图高度像素`} type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={value.height || ''} disabled={disabled} onChange={(event) => onChange({ ...value, height: Number(event.target.value), resolutionVersion: 1 })} /></label>
      </> : <label><span>比例</span><select aria-label={`${label}生图画面比例`} value={value.mode === 'default' ? 'variant' : value.aspect} disabled={disabled || value.mode === 'default'} onChange={(event) => onChange({ ...value, aspect: event.target.value as ImageOutputSizePreference['aspect'], resolutionVersion: 1 })}>
        {workflowAspect ? <>
          <option value="variant">工作流比例</option>
          {value.aspect !== 'variant' && <option value={value.aspect} disabled>{IMAGE_OUTPUT_ASPECTS.find((item) => item.value === value.aspect)?.label || value.aspect} · 需绑定比例字段</option>}
        </> : IMAGE_OUTPUT_ASPECTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>}
    </div>
    {resolved.workflowAspect && <p className="field-hint" style={{ margin: '4px 0 0' }}>比例由云端工作流决定；指定比例需先绑定真实比例字段，并确认工作流的条件开关。</p>}
    {workflowSize && !resolved.workflowAspect && <p className="field-hint" style={{ margin: '4px 0 0' }}>{resolved.workflowAspectGate
      ? 'V3 应用指定比例时同步启用“其他比例”；未选参考图时使用文生图。'
      : '涉及比例条件开关时，请在工作流中明确配置，不会自动开启。'}</p>}
    <div className="image-output-size-summary">
      <details><summary>尺寸说明</summary><p>{sizeSummary}。{capabilityNote} 1K、2K、4K是生图分辨率档位；原生模型按其规格提交，自由像素后端按本机档位映射。实际请求宽高和必要的对齐在本说明中。各视图数量与位置保持所选版式，画幅按当前请求尺寸生成；模型能力和版式提醒不阻止提交。旧规格保留原尺寸；自定义宽高按输入提交。</p></details>
    </div>
    {resolved.warning && <p className="field-hint image-output-size-warning" role="status" style={{ margin: '4px 0 0' }}>{resolved.warning}</p>}
    {resolved.issue && <p className="image-output-size-error" role="alert">{resolved.issue}</p>}
  </div>;
}
