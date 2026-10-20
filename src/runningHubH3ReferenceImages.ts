import type { VideoTaskApiConfig } from './types';
import type { RunningHubVideoWorkflow } from './runningHubVideoTypes';
import {
  compileH3ReferenceImageOrders, h3ImageValuePresent, normalizeH3ReferenceImageOrders, resolveH3PictureNumbers,
  type H3CompiledReferenceImageOrder, type H3ReferenceImageOrder,
} from './h3ReferenceImageOrder';

/** Recover the one legacy topology confirmed by this app's saved execution graph.
 * Older catalogues dropped all links. The cloud ID alone is insufficient: another
 * saved workflow uses that ID with entirely different prompt/image bindings.
 */
const verifiedLegacyOrder = (workflow: RunningHubVideoWorkflow): H3ReferenceImageOrder[] => {
  if (workflow.runKind !== 'workflow' || workflow.remoteId !== '2112208448657412098'
    || workflow.mapping.prompt.length !== 1 || workflow.mapping.prompt[0].nodeId !== '263'
    || workflow.mapping.prompt[0].inputName !== 'text' || workflow.mapping.images.length !== 6) return [];
  const imageIds = new Set(['19', '23', '43', '49', '50', '51']);
  if (workflow.mapping.images.some((field) => field.inputName !== 'image' || !imageIds.delete(field.nodeId)) || imageIds.size) return [];
  const catalog = workflow.nodeCatalog || [];
  if (!catalog.some((field) => field.nodeId === '265' && field.classType === 'MiniMaxH3ReferenceToVideo')
    || !catalog.some((field) => field.nodeId === '263' && field.fieldName === 'text' && field.classType === 'Text')
    || workflow.mapping.images.some((image) => !catalog.some((field) => field.nodeId === image.nodeId
      && field.fieldName === image.inputName && field.classType === 'LoadImage'))) return [];
  return [{ consumerNodeId: '265', prompt: [{ nodeId: '263', inputName: 'text' }],
    images: ['51', '49', '50', '43', '19', '23'].map((nodeId, index) => ({
      inputName: `ref_images.ref_image_${index}`, source: { nodeId, inputName: 'image' }, present: true,
    })) }];
};

export const compileRunningHubH3ReferenceImages = (
  workflow: RunningHubVideoWorkflow, emptyValues: readonly (string | undefined)[],
): H3CompiledReferenceImageOrder[] | undefined => {
  const metadata = (workflow.nodeCatalog || []).filter((field) => field.h3ReferenceImages !== undefined);
  const imported = metadata.flatMap((field) => normalizeH3ReferenceImageOrders(field.h3ReferenceImages));
  // Explicit imported evidence supersedes the legacy mapping, including an empty graph result.
  const orders = metadata.length ? [...new Map(imported.map((order) => [order.consumerNodeId, order])).values()] : verifiedLegacyOrder(workflow);
  let values: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = [];
  try { values = JSON.parse(workflow.requestTemplate).nodeInfoList || []; } catch { /* Existing request parser reports malformed templates. */ }
  const compiled = compileH3ReferenceImageOrders(orders, workflow.mapping, (source, slotIndex, present) => {
    // RunningHub's existing binder clears unselected mapped images. Other fields
    // retain their request override, or the imported graph's original default.
    if (slotIndex !== undefined) return h3ImageValuePresent(emptyValues[slotIndex]);
    const value = values.find((field) => field.nodeId === source.nodeId && field.fieldName === source.inputName);
    return value ? h3ImageValuePresent(value.fieldValue) : present;
  });
  return compiled.length ? compiled : undefined;
};

export const resolveRunningHubH3PictureNumbers = (
  api: Pick<VideoTaskApiConfig, 'runningHubH3ReferenceImages'>, selectedSlots: readonly number[],
): number[] | undefined => resolveH3PictureNumbers(api.runningHubH3ReferenceImages, selectedSlots);
