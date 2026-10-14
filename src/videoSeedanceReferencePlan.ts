import type { VideoTaskApiConfig } from './types';
import type { VideoImageReference } from './videoGenerationTypes';
import type { VideoReferenceUsageContext } from './videoReferenceUsage';
import { videoReferenceSlotIndex } from './videoReferenceSlots';
import { isLaoliVideoBuiltinProtocol } from './genericVideoApi';

export interface VideoSeedanceReferencePlan {
  numbers?: number[];
  warning?: string;
  imageTokenStyle?: 'english' | 'chinese';
}

type SeedanceReferenceContext = Omit<VideoReferenceUsageContext, 'api'> & {
  api?: VideoReferenceUsageContext['api'] & Partial<Pick<VideoTaskApiConfig, 'requestTemplate' | 'baseUrl' | 'endpoint'>>;
};

/** Seedance ordinals describe the final media array, not a workflow's node IDs. */
export const videoSeedanceReferencePlan = (
  references: readonly VideoImageReference[], context: SeedanceReferenceContext,
): VideoSeedanceReferencePlan => {
  const slots = references.map(videoReferenceSlotIndex);
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot < 0) || new Set(slots).size !== slots.length) {
    return { warning: '参考图槽号无效，未猜测 Seedance 图片编号；请核对实际输入槽。' };
  }
  if (!references.length) return { numbers: [] };
  if (context.backend === 'comfyui' || context.api?.provider === 'runninghub') {
    return { warning: '当前工作流未声明 Seedance 最终图片顺序；图片按既有槽位提交，人物关联待确认。' };
  }
  const api = context.api;
  if (!api) return { warning: '尚未确定本次视频接口，Seedance 图片关联将在明确输入顺序后同步。' };
  if (api.provider === 'minimax' || api.provider === 'rhtv_web') {
    return { warning: '当前连接未声明 Seedance 多图引用协议，已保留正文，请核对模型与素材输入。' };
  }
  const template = api.requestTemplate?.trim();
  if (template && (!/\{\{(?:images|references)\}\}/u.test(template)
    || /\{\{(?:image_\d+|first_image|last_image)\}\}/u.test(template))) {
    return { warning: '此自定义接口未声明 Seedance 图片引用顺序；图片仍按现有模板提交，人物关联待确认。' };
  }
  return {
    numbers: references.map((_, index) => index + 1),
    imageTokenStyle: isLaoliVideoBuiltinProtocol({ ...api, endpoint: api.endpoint || '' }) ? 'chinese' : 'english',
  };
};
