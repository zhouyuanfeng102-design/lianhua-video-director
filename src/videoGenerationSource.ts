import type { AppSettings, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft, VideoGenerationSource } from './videoGenerationTypes';
import { resolveConfiguredVideoApi } from './runningHubVideo';
import { compileRunningHubWebApi } from './runningHubWeb';

export const videoDraftSource = (draft: Pick<VideoGenerationDraft, 'backend' | 'runningHubWorkflowId' | 'runningHubWebAppId'>): VideoGenerationSource =>
  draft.backend === 'api' && draft.runningHubWebAppId !== undefined ? 'runninghub-web'
    : draft.backend === 'api' && draft.runningHubWorkflowId !== undefined ? 'runninghub' : draft.backend;

/** Separate UI parameter drafts by their actual destination and frozen task. */
export const videoParameterConnectionKey = (draft: Pick<VideoGenerationDraft, 'backend' | 'runningHubWorkflowId' | 'runningHubWebAppId' | 'workflowId' | 'apiProfileId' | 'reuseTaskId'>): string => {
  const source = videoDraftSource(draft);
  return JSON.stringify([source, source === 'runninghub-web' ? draft.runningHubWebAppId
    : source === 'runninghub' ? draft.runningHubWorkflowId
    : source === 'comfyui' ? draft.workflowId || '' : draft.apiProfileId || '', draft.reuseTaskId || '']);
};

export const videoSourceDraftPatch = (source: VideoGenerationSource, settings: AppSettings): Partial<VideoGenerationDraft> => ({
  backend: source === 'comfyui' ? 'comfyui' : 'api',
  runningHubWorkflowId: source === 'runninghub' ? settings.runningHubVideo?.activeWorkflowId || '__runninghub_unselected__' : undefined,
  runningHubWebAppId: source === 'runninghub-web' ? settings.runningHubWeb?.activeAppId || '__runninghub_web_unselected__' : undefined,
  apiProfileId: source === 'api' ? settings.activeVideoApiProfileId || undefined : undefined,
  workflowId: source === 'comfyui' ? settings.comfyuiVideo?.activeWorkflowId || undefined : undefined,
  reuseTaskId: undefined,
});

/** Rendering an incomplete cloud draft must show its error, never fall back to another paid API. */
export const videoConfiguredApiState = (
  settings: AppSettings,
  draft: Pick<VideoGenerationDraft, 'backend' | 'apiProfileId' | 'runningHubWorkflowId' | 'runningHubWebAppId' | 'parameters'>,
  frozen?: Omit<VideoTaskApiConfig, 'apiKey'>,
): { api?: Omit<VideoTaskApiConfig, 'apiKey'>; issue: string } => {
  if (frozen) return { api: frozen, issue: '' };
  if (draft.backend !== 'api') return { issue: '' };
  try {
    if (draft.runningHubWebAppId !== undefined) return { api: compileRunningHubWebApi(settings.runningHubWeb || { enabled: false, accounts: [], apps: [] }, draft.runningHubWebAppId), issue: '' };
    return { api: resolveConfiguredVideoApi(settings, draft), issue: '' };
  }
  catch (error) { return { issue: error instanceof Error ? error.message : '视频连接配置不完整，请检查设置。' }; }
};
