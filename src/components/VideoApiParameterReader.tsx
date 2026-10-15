import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { refreshGenericVideoParameterCapabilities } from '../videoApiDiscovery';
import { videoApiParameterReadIdentity } from '../videoApiParameterSettings';
import { getVideoApiModelParameterCapabilities } from '../videoApiCapabilities';
import { getVideoApiImageCapacity } from '../videoImageCapacity';
import { formatUserFacingError } from '../userFacingError';
import type { AppSettings, VideoTaskApiConfig } from '../types';
import type { VideoApiParameterCapabilities } from '../videoApiCapabilityTypes';

export interface VideoApiParameterReaderProps {
  settings: AppSettings;
  profileId?: string;
  frozen?: boolean;
  /** Read once on opening a picker and again if its connection/model changes. */
  autoRead?: boolean;
  onChange?: (profileId: string | undefined, expected: VideoTaskApiConfig, capabilities: VideoApiParameterCapabilities) => void;
}

export function VideoApiParameterReader(props: VideoApiParameterReaderProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const config = props.profileId ? props.settings.videoApiProfiles?.find((profile) => profile.id === props.profileId) : props.settings.videoTaskApi;
  const identity = config ? videoApiParameterReadIdentity(config) : '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => { pending.current?.abort(); pending.current = null; setLoading(false); setMessage(''); }, [identity, props.profileId, props.frozen]);
  const read = async () => {
    if (pending.current || !config?.model?.trim() || props.frozen || !props.onChange) return;
    const expected = structuredClone(config), profileId = props.profileId;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setMessage(''); setError(false);
    const isCurrent = () => {
      const current = latest.current;
      const target = current.profileId ? current.settings.videoApiProfiles?.find((profile) => profile.id === current.profileId) : current.settings.videoTaskApi;
      return mounted.current && !controller.signal.aborted && current.profileId === profileId && !current.frozen
        && target && videoApiParameterReadIdentity(target) === videoApiParameterReadIdentity(expected);
    };
    try {
      const capabilities = await refreshGenericVideoParameterCapabilities(expected, { signal: controller.signal });
      if (!isCurrent()) return;
      latest.current.onChange?.(profileId, expected, capabilities);
      const selected = getVideoApiModelParameterCapabilities({ ...expected, parameterCapabilities: capabilities });
      const count = Object.keys(selected?.controls || {}).length;
      const capacity = getVideoApiImageCapacity({ ...expected, parameterCapabilities: capabilities });
      setMessage(`${capacity ? `已读取图片容量：${capacity.maxCount} 槽。` : '未读取到此模型的图片容量。'}${count ? '已读取上游模型参数；未提供限制的项可选常用值或自定义。' : '上游未提供其它参数限制，可选常用值或自定义。'}`);
    } catch (cause) { if (isCurrent()) { setError(true); setMessage(formatUserFacingError(cause)); } }
    finally { if (pending.current === controller) { pending.current = null; if (mounted.current) setLoading(false); } }
  };
  useEffect(() => {
    if (!props.autoRead || props.frozen || !props.onChange || !config?.model?.trim()) return;
    const timer = setTimeout(() => { void read(); }, 0);
    return () => clearTimeout(timer);
  }, [identity, props.profileId, props.frozen, props.autoRead, Boolean(props.onChange)]);
  return <div className="vop-model-reader">
    <button type="button" className="btn small" disabled={loading || props.frozen || !config?.model?.trim() || !props.onChange} onClick={() => { void read(); }}><RefreshCw size={12} />{loading ? '正在读取参数…' : '读取模型参数'}</button>
    {props.frozen ? <span>原任务沿用冻结的参数资料</span> : <span className={error ? 'vd-error' : undefined} aria-live="polite">{message || '读取所选模型的图片容量、时长、比例和分辨率限制'}</span>}
  </div>;
}
