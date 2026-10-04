import { useEffect, useId, useState } from 'react';
import type { AppSettings } from '../types';
import { resolveVideoExecutionLimit, VIDEO_EXECUTION_CONCURRENCY_MAX } from '../videoGenerationQueue';

export type VideoExecutionPreferences = Pick<AppSettings, 'videoExecutionMode' | 'videoExecutionConcurrency'>;
export interface VideoExecutionControlsProps {
  settings: VideoExecutionPreferences;
  onChange: (patch: VideoExecutionPreferences) => void;
  className?: string;
}

/** Persisted per-connection limit shared across projects; these controls never create a task. */
export function VideoExecutionControls({ settings, onChange, className = '' }: VideoExecutionControlsProps) {
  const mode = settings.videoExecutionMode === 'concurrent' ? 'concurrent' : 'queue';
  const count = Number.isInteger(settings.videoExecutionConcurrency) && settings.videoExecutionConcurrency! >= 1
    && settings.videoExecutionConcurrency! <= VIDEO_EXECUTION_CONCURRENCY_MAX ? settings.videoExecutionConcurrency! : 1;
  const [text, setText] = useState(String(count));
  const helpId = useId();
  useEffect(() => { setText(String(count)); }, [count]);
  const value = Number(text);
  const invalid = mode === 'concurrent' && (!text.trim() || !Number.isInteger(value) || value < 1 || value > VIDEO_EXECUTION_CONCURRENCY_MAX);
  return <div className={`video-execution-controls ${className}`}>
    <div className="video-execution-fields">
      <label><span>视频执行方式</span><select aria-label="视频执行方式" value={mode} onChange={(event) => {
        const next = event.target.value === 'concurrent' ? 'concurrent' : 'queue';
        setText(String(count)); onChange({ videoExecutionMode: next });
      }}><option value="queue">排队生成（一次 1 个）</option><option value="concurrent">并发生成</option></select></label>
      <label><span>并发数量</span><input aria-label="视频并发数量" aria-describedby={helpId} aria-invalid={invalid}
        type="number" inputMode="numeric" min={1} max={VIDEO_EXECUTION_CONCURRENCY_MAX} step={1}
        disabled={mode === 'queue'} value={text} onChange={(event) => {
          setText(event.target.value); const next = Number(event.target.value);
          if (event.target.value.trim() && Number.isInteger(next) && next >= 1 && next <= VIDEO_EXECUTION_CONCURRENCY_MAX) {
            onChange({ videoExecutionConcurrency: next });
          }
        }} /></label>
      <span className="video-execution-limit" role="status">{mode === 'queue' ? '同一连接内等待当前视频结束，再提交下一项' : `每个连接最多同时生成 ${resolveVideoExecutionLimit(settings)} 个视频`}</span>
    </div>
    <p id={helpId} className={invalid ? 'video-execution-warning' : 'field-hint'}>{invalid
      ? `请输入 1–${VIDEO_EXECUTION_CONCURRENCY_MAX} 的整数；当前输入未保存，仍使用已保存的限制。`
      : '同一连接跨项目共用；不同连接分别执行。适用于单条、批量和继续任务。调低不会取消已提交任务；实际并发仍受服务商额度限制。'}</p>
  </div>;
}
