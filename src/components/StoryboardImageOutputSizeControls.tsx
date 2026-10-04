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
  return <div className="image-output-size-controls storyboard-image-output-size-controls" role="group" aria-label="分镜图分辨率">
    <div className="image-output-size-row">
      <label className="storyboard-image-output-size-mode"><span>分辨率</span><select aria-label="分镜图分辨率" value={value.mode} disabled={disabled} onChange={(event) => onChange({ ...value, mode: event.target.value as StoryboardImageOutputSizePreference['mode'] })}>
        <option value="default">规格默认</option>
        <option value="1k">1K · 长边1024</option>
        <option value="2k">2K · 长边2048</option>
        <option value="4k">4K · 长边4096</option>
        <option value="custom">自定义宽高</option>
      </select></label>
      {custom ? <>
        <label className="image-output-size-number"><span>宽</span><input aria-label="分镜图宽度像素" type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={Number.isFinite(value.width) ? value.width || '' : ''} disabled={disabled} onChange={(event) => onChange({ ...value, width: Number(event.target.value) })} /></label>
        <label className="image-output-size-number"><span>高</span><input aria-label="分镜图高度像素" type="number" min={64} max={IMAGE_OUTPUT_MAX_SIDE} step={1} value={Number.isFinite(value.height) ? value.height || '' : ''} disabled={disabled} onChange={(event) => onChange({ ...value, height: Number(event.target.value) })} /></label>
      </> : <span className="storyboard-image-output-size-aspect">分镜比例 {aspectRatio || '未设置'}</span>}
    </div>
    <div className="image-output-size-summary">
      <span>{resolved.issue ? '请检查像素参数' : `请求 ${resolved.width} × ${resolved.height} px`}{resolved.layoutNote ? ` · ${resolved.layoutNote}` : ''}</span>
      <details><summary>尺寸说明</summary><p>{capabilityNote ? `${capabilityNote} ` : ''}1K、2K、4K分别指定长边1024、2048、4096像素；短边跟随分镜比例，必要的像素对齐会在此显示。自定义宽高原样提交，不自动降档或本地放大。费用、速度及实际返回尺寸取决于模型与工作流。</p></details>
    </div>
    <p className="storyboard-image-output-size-note">提示词导演台的分镜图和首尾帧图片同步使用；已排队任务不追溯改变。</p>
    {resolved.issue && <p className="image-output-size-error" role="alert">{resolved.issue}</p>}
  </div>;
}
