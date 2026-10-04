import type { AppSettings, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft, VideoGenerationSource } from './videoGenerationTypes';
import { resolveConfiguredVideoApi } from './runningHubVideo';

export const videoDraftSource = (draft: Pick<VideoGenerationDraft, 'backend' | 'runningHubWorkflowId'>): VideoGenerationSource =>
  draft.backend === 'api' && draft.runningHubWorkflowId !== undefined ? 'runninghub' : draft.backend;

/** Separate UI parameter drafts by their actual destination and frozen task. */
export const videoParameterConnectionKey = (draft: Pick<VideoGenerationDraft, 'backend' | 'runningHubWorkflowId' | 'workflowId' | 'apiProfileId' | 'reuseTaskId'>): string => {
  const source = videoDraftSource(draft);
  return JSON.stringify([source, source === 'runninghub' ? draft.runningHubWorkflowId
    : source === 'comfyui' ? draft.workflowId || '' : draft.apiProfileId || '', draft.reuseTaskId || '']);
};

export const videoSourceDraftPatch = (source: VideoGenerationSource, settings: AppSettings): Partial<VideoGenerationDraft> => ({
  backend: source === 'comfyui' ? 'comfyui' : 'api',
  runningHubWorkflowId: source === 'runninghub' ? settings.runningHubVideo?.activeWorkflowId || '__runninghub_unselected__' : undefined,
  apiProfileId: source === 'api' ? settings.activeVideoApiProfileId || undefined : undefined,
  workflowId: source === 'comfyui' ? settings.comfyuiVideo?.activeWorkflowId || undefined : undefined,
  reuseTaskId: undefined,
});

/** Rendering an incomplete cloud draft must show its error, never fall back to another paid API. */
export const videoConfiguredApiState = (
  settings: AppSettings,
  draft: Pick<VideoGenerationDraft, 'backend' | 'apiProfileId' | 'runningHubWorkflowId' | 'parameters'>,
  frozen?: Omit<VideoTaskApiConfig, 'apiKey'>,
): { api?: Omit<VideoTaskApiConfig, 'apiKey'>; issue: string } => {
  if (frozen) return { api: frozen, issue: '' };
  if (draft.backend !== 'api') return { issue: '' };
  try { return { api: resolveConfiguredVideoApi(settings, draft), issue: '' }; }
  catch (error) { return { issue: error instanceof Error ? error.message : '视频连接配置不完整，请检查设置。' }; }
};
