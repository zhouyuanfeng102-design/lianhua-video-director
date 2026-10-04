import { createRequire } from 'node:module';
const { referencePlan } = createRequire(import.meta.url)('../electron/rhtvBridge/contracts.cjs');
export const model = { modelCode: 'h3-reference', code: 'h3-reference', modelName: 'Minimax H3 RH Enhanced', skuId: 'h3-sku', config: [
  { type: 'prompt', paramName: 'prompt' }, { type: 'INT', paramName: 'duration' },
  { type: 'LIST', paramName: 'resolution' }, { type: 'aspectRatio', paramName: 'aspectRatio' },
] };
export const request = (client_id = 'auto-one') => ({ protocol_version: 1, client_id, model_key: 'minimax-h3-rh-enhanced', mode: 'text',
  prompt: 'A red cube turns on a white table.', cost_policy: 'free_only',
  parameters: { duration: 5, resolution: '768p', aspect_ratio: '16:9' }, references: [] });
export function canvasBody(job) {
  const plan = referencePlan(job.request);
  const types = { text: 'text-video', first: 'start-video', first_last: 'start-end-video', reference: 'multimodal-video' };
  return { canvasId: 'canvas-one', targetType: 'NODE', targetId: 'video-one', canvas: {
    nodes: [...plan.map((ref, index) => ({ id: `image-${index}`, type: 'rh-image', data: { title: ref.name, sourceObjects: [`https://cdn.runninghub.ai/${ref.name}`] } })),
      { id: 'video-one', type: 'rh-video', data: { modelCode: model.code, subType: types[job.request.mode], params: {
        rhModel: model.code, prompt: job.request.prompt.trim(), duration: job.request.parameters.duration,
        resolution: job.request.parameters.resolution, aspectRatio: job.request.parameters.aspect_ratio === '自适应' ? 'auto' : job.request.parameters.aspect_ratio,
      } } }], edges: plan.map((_, index) => ({ source: `image-${index}`, target: 'video-one' })),
  } };
}
