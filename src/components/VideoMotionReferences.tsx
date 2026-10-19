import type { Project, VideoTaskApiConfig } from '../types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDraft } from '../videoGenerationTypes';
import type { FrozenVideoMotionReference } from '../videoMotionTypes';
import { isVideoDirectorMotionVideo, videoMotionCapability } from '../videoMotionReferences';

export function VideoMotionReferenceEditor({ project, draft, api, workflow, scope, disabled, frozenVideos, onChange }: {
  project: Project; draft: VideoGenerationDraft; api?: Omit<VideoTaskApiConfig, 'apiKey'>;
  workflow?: ComfyVideoWorkflowPreset; scope: string; disabled?: boolean;
  frozenVideos?: FrozenVideoMotionReference[]; onChange: (patch: Partial<VideoGenerationDraft>) => void;
}) {
  const capability = videoMotionCapability({ backend: draft.backend, api, workflow });
  const references = draft.videoReferences || [];
  if (!capability.supported && !references.length) return null;
  const assets = project.assets.filter(isVideoDirectorMotionVideo);
  const slots = [...new Set([...capability.slots.map((slot) => slot.slotIndex), ...references.map((reference) => reference.slotIndex)])].sort((a, b) => a - b);
  return <div className="vd-motion-references" role="group" aria-label={`${scope}动作视频参考`}>
    <p className="field-hint">动作视频提供运动、速度和接触过程；人物图片继续提供外貌。未选择时按当前剧情生成。</p>
    {slots.map((slotIndex) => {
      const slot = capability.slots.find((entry) => entry.slotIndex === slotIndex);
      const reference = references.find((entry) => entry.slotIndex === slotIndex);
      const asset = assets.find((entry) => entry.id === reference?.assetId);
      const frozen = draft.reuseTaskId && frozenVideos?.find((entry) => entry.assetId === reference?.assetId && entry.slotIndex === slotIndex);
      const media = frozen || asset;
      const url = media?.dataUrl || media?.url || (media?.relativePath ? `lianhua-asset://local/${media.relativePath.replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')}` : '');
      const patch = (next: NonNullable<VideoGenerationDraft['videoReferences']>) => onChange({ videoReferences: next, reuseTaskId: undefined });
      return <div key={slotIndex} className="vd-motion-reference">
        <label className="field"><span>动作视频 {slotIndex + 1}</span><select aria-label={`${scope}动作视频 ${slotIndex + 1}`} value={reference?.assetId || ''} disabled={disabled}
          onChange={(event) => {
            const assetId = event.target.value;
            const next = references.filter((entry) => entry.slotIndex !== slotIndex);
            if (assetId && slot) next.push({ assetId, slotIndex, bindingId: slot.bindingId, notes: reference?.notes });
            patch(next.sort((a, b) => a.slotIndex - b.slotIndex));
          }}>
          <option value="">不使用动作视频</option>
          {reference && !asset && <option value={reference.assetId}>{frozen ? `${frozen.name} · 原任务参考` : '原参考视频'}</option>}
          {assets.map((entry) => <option key={entry.id} value={entry.id} disabled={!slot || Boolean(entry.missing)}>{entry.name}</option>)}
        </select></label>
        {!slot && reference && <p className="field-hint">当前连接没有对应视频输入，保留原选择供切回使用，本次不传入。</p>}
        {reference && <label className="field"><span>参考的动作与人物对应</span><input aria-label={`${scope}动作视频 ${slotIndex + 1} 用途`} value={reference.notes || ''} disabled={disabled}
          placeholder="例如：黑衣人物对应甲，白衣人物对应乙；参考交手速度与接触过程"
          onChange={(event) => patch(references.map((entry) => entry.slotIndex === slotIndex ? { ...entry, notes: event.target.value } : entry))} /></label>}
        {url && <video controls muted preload="none" src={url} aria-label={`${scope}动作视频 ${slotIndex + 1} 预览`} style={{ width: '100%', maxHeight: 180 }} />}
      </div>;
    })}
  </div>;
}
