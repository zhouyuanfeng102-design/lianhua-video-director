import type { VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';

type AudioApi = VideoTaskApiConfig | Omit<VideoTaskApiConfig, 'apiKey'> | undefined;
export interface VideoAudioCapability {
  status: 'supported' | 'unsupported' | 'unknown';
  capacity: number;
  reason: string;
}

/** Report the implemented transport for this connection, never infer support from a model's name. */
export const videoAudioCapability = (api: AudioApi, backend: VideoGenerationDraft['backend'] = 'api'): VideoAudioCapability => {
  if (backend !== 'api') return { status: 'unsupported', capacity: 0, reason: '当前视频连接尚未实现参考音频传输；可以继续使用文字声线描述。' };
  if (!api) return { status: 'unknown', capacity: 0, reason: '尚未选择视频连接，参考音频能力未确定。' };
  if (api.provider === 'runninghub') {
    const fields = (Array.isArray(api.runningHubMappedFields) ? api.runningHubMappedFields : []).filter((field) => field?.kind === 'audio'
      && typeof field.nodeId === 'string' && field.nodeId.trim() && typeof field.fieldName === 'string' && field.fieldName.trim()
      && Number.isSafeInteger(field.audioIndex) && field.audioIndex! >= 0);
    return fields.length ? { status: 'supported', capacity: Math.max(...fields.map((field) => field.audioIndex! + 1)),
      reason: '当前 RunningHub 工作流已配置音频输入；生成时将按选择上传，效果由该工作流决定。' }
      : { status: 'unsupported', capacity: 0, reason: '当前 RunningHub 工作流没有明确的音频输入映射；可以继续使用文字声线描述。' };
  }
  return { status: 'unsupported', capacity: 0,
    reason: '当前连接尚未实现参考音频传输；本次只能使用提示词中的文字声线描述。' };
};

export const videoAudioTextConstraintState = (prompt: string): 'present' | 'missing' =>
  /声线|声龄|音色|声音年龄|音高|\b(?:voice\s+(?:age|timbre|profile|quality)|vocal\s+(?:age|timbre|quality)|timbre|pitch)\b/iu.test(prompt) ? 'present' : 'missing';
