import type { VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';

/** Stable IPC routing identity, never a network destination. */
export const RHTV_ORIGIN = 'http://rhtv.localhost';
export const rhtvModes = { text: '文生视频', first: '首帧', first_last: '首尾帧', reference: '全能参考' } as const;
export type RhTvMode = keyof typeof rhtvModes;
export const defaultRhTvApi: VideoTaskApiConfig = {
  enabled: true, provider: 'rhtv_web', model: 'Minimax H3 RH Enhanced',
  endpoint: `${RHTV_ORIGIN}/v1/videos`, statusEndpointTemplate: `${RHTV_ORIGIN}/v1/videos/{id}`,
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result_url', errorPath: 'message',
  imageUploadEndpoint: `${RHTV_ORIGIN}/v1/assets`, imageUploadUrlPath: 'upload_id',
  cancelEndpointTemplate: `${RHTV_ORIGIN}/v1/videos/{id}/cancel`, cancelMethod: 'POST',
  rhtvMode: 'reference', rhtvDuration: 5, rhtvResolution: '768p', rhtvAspectRatio: '自适应',
};

export interface RhTvBridgeJob {
  id: string; client_id: string; status: string; message: string; created_at: number;
  mode: RhTvMode; reference_count: number; handed_off: boolean;
  automatic?: boolean; submission_started?: boolean; upstream_task_id?: string; page_url?: string;
  quote?: { total: number; currency: string; checked_at: number };
  references: Array<{ slot_index: number; role: string; asset_id: string; character_ids?: string[] }>;
}
export interface RhTvBridgeStatus {
  running: boolean; endpoint?: string; browser: string; automatic_submission: boolean;
  automation_supported?: boolean; live_site_verified?: boolean;
  message: string; jobs: RhTvBridgeJob[];
}
export interface RhTvControlRequest {
  action: 'status' | 'start' | 'stop' | 'login' | 'prepare' | 'handoff' | 'import-result' | 'cancel' | 'materials' | 'confirm-not-submitted' | 'confirm-ended' | 'automation' | 'retry';
  jobId?: string;
  enabled?: boolean;
}

export function buildRhTvBody(config: Omit<VideoTaskApiConfig, 'apiKey'>, draft: VideoGenerationDraft, uploads: string[]) {
  const mode = String(draft.parameters.rhtv_mode || config.rhtvMode || 'reference');
  if (!Object.prototype.hasOwnProperty.call(rhtvModes, mode)) throw new Error('rhTV 生成模式无效。');
  const refs = draft.references;
  if (refs.length !== uploads.length || uploads.some((value) => !value)) throw new Error('rhTV 参考图上传清单不完整。');
  const first = refs.filter((item) => item.role === 'first-frame').length;
  const last = refs.filter((item) => item.role === 'last-frame').length;
  if (mode === 'text' && refs.length) throw new Error('rhTV 文生视频不能携带参考图，请切换生成模式。');
  if (mode === 'first' && (refs.length !== 1 || first !== 1)) throw new Error('rhTV 首帧模式需要一张明确标为首帧的图片。');
  if (mode === 'first_last' && (refs.length !== 2 || first !== 1 || last !== 1)) throw new Error('rhTV 首尾帧模式需要首帧、尾帧各一张。');
  if (mode === 'reference' && (refs.length < 1 || refs.length > 9)) throw new Error('rhTV 全能参考需要 1-9 张图片，不会自动丢图。');
  const duration = Number(draft.parameters.duration ?? config.rhtvDuration ?? 5);
  const resolution = String(draft.parameters.resolution ?? config.rhtvResolution ?? '768p');
  const aspect = String(draft.parameters.aspect_ratio ?? config.rhtvAspectRatio ?? '自适应');
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('rhTV 时长必须为 4-15 的整数秒。');
  if (!['480p', '768p', '1080p'].includes(resolution)) throw new Error('rhTV 分辨率必须为 480p、768p 或 1080p。');
  if (!['自适应', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(aspect)) throw new Error('rhTV 画面比例无效。');
  const unsupported = Object.keys(draft.parameters).filter((key) => !['rhtv_mode', 'duration', 'resolution', 'aspect_ratio'].includes(key));
  if (unsupported.length) throw new Error(`rhTV 尚不支持这些参数：${unsupported.join('、')}；未静默忽略。`);
  return { protocol_version: 1, model_key: 'minimax-h3-rh-enhanced', mode, prompt: draft.prompt,
    parameters: { duration, resolution, aspect_ratio: aspect }, cost_policy: 'free_only',
    references: refs.map((ref, index) => ({ upload_id: uploads[index], asset_id: ref.assetId, slot_index: ref.slotIndex ?? index,
      ...(/^[a-f0-9]{64}_(?:png|jpeg|webp)$/u.test(uploads[index]) ? { checksum: uploads[index].split('_')[0] } : {}),
      role: ref.role, ...(ref.characterIds !== undefined ? { character_ids: [...ref.characterIds] } : {}) })),
    ...(draft.h3ReferenceBinding ? { reference_binding: draft.h3ReferenceBinding } : {}),
  };
}
