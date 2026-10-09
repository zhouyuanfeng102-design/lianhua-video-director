import { IMAGE_OUTPUT_MAX_SIDE, type ResolvedImageOutputSize } from '../imageOutputSize';
import type { StoryboardImageOutputSizePreference } from '../storyboardImageOutputSize';
import '../imageOutputSize.css';
import '../storyboardImageOutputSize.css';

export function StoryboardImageOutputSizeControls({ value, resolved, aspectRatio, disabled = false, capabilityNote = '', onChange }: {
  value: StoryboardImageOutputSizePreference;
  resolved: ResolvedImageOutputSize;
  aspectRatio: string;
  disabled?: boolean;
  capabilityNote?: string;
  onChange: (value: StoryboardImageOutputSizePreference) => void;
}) {
  const custom = value.mode === 'custom';
  const legacy = value.mode === 'default' || !custom && value.resolutionVersion !== 1;
  const namedResolution = resolved.resolutionPlan?.encoding.kind === 'tier';
  const sizeLabel = namedResolution ? resolved.resolutionPlan?.verified ? '原生预期' : '档位估算（以返回为准）' : '请求';
  return <div className="image-output-size-controls storyboard-image-output-size-controls" role="group" aria-label="分镜生图分辨率">
    <div className="image-output-size-row">
      <label className="storyboard-image-output-size-mode"><span>生图分辨率</span><select aria-label="分镜图分辨率" value={legacy ? `legacy-${value.mode}` : value.mode} disabled={disabled} onChange={(event) => onChange({ ...value, mode: event.target.value.replace(/^legacy-/u, '') as StoryboardImageOutputSizePreference['mode'], resolutionVersion: 1 })}>
        <option value="1k">1K</option>
        <option value="2k">2K</option>
        <option value="4k">4K</option>
        {legacy && <option value={`legacy-${value.mode}`}>旧规格 · {resolved.width}×{resolved.height}</option>}
        <option value="custom">自定义宽高</option>
      </select></label>
      {custom ? <>
        <label className="image-output-size-number"><span>宽</span><input aria-label="分镜图宽度像素" type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={Number.isFinite(value.width) ? value.width || '' : ''} disabled={disabled} onChange={(event) => onChange({ ...value, width: Number(event.target.value), resolutionVersion: 1 })} /></label>
        <label className="image-output-size-number"><span>高</span><input aria-label="分镜图高度像素" type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={Number.isFinite(value.height) ? value.height || '' : ''} disabled={disabled} onChange={(event) => onChange({ ...value, height: Number(event.target.value), resolutionVersion: 1 })} /></label>
      </> : <span className="storyboard-image-output-size-aspect">分镜比例 {aspectRatio || '未设置'}</span>}
    </div>
    <div className="image-output-size-summary">
      <span>{`${sizeLabel} ${resolved.width} × ${resolved.height} px`}{resolved.layoutNote ? ` · ${resolved.layoutNote}` : ''}</span>
      <details><summary>尺寸说明</summary><p>{capabilityNote ? `${capabilityNote} ` : ''}1K、2K、4K是生图分辨率档位；原生模型按自身规格提交，自由像素后端按本机档位映射。实际请求宽高及比例对齐显示于此，不同模型的同名档位可有不同像素。模型能力和画幅提醒不阻止提交；生图分辨率独立于视频分辨率，自定义宽高按输入提交。</p></details>
    </div>
    <p className="storyboard-image-output-size-note">提示词导演台的分镜图和首尾帧图片同步使用；已排队任务不追溯改变。</p>
    {resolved.warning && <p className="storyboard-image-output-size-note image-output-size-warning" role="status">{resolved.warning}</p>}
    {resolved.issue && <p className="image-output-size-error" role="alert">{resolved.issue}</p>}
  </div>;
}
