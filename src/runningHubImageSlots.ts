import type { RunningHubVideoInputBinding, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { ensureRunningHubVideoRequestNode, readRunningHubVideoRequest } from './runningHubVideo';
import { listRunningHubVideoNodes } from './runningHubVideoNodes';
import { selectRunningHubVideoFieldChoices } from './runningHubVideoFieldChoices';
import { resolveRunningHubVideoImageProtocol } from './runningHubImageProtocol';

const keyOf = (nodeId: string, inputName: string) => JSON.stringify([nodeId, inputName]);

export const isRunningHubImageCountField = (node: RunningHubVideoNodeInfo): boolean =>
  typeof node.fieldValue === 'number' ? Number.isSafeInteger(node.fieldValue) && node.fieldValue >= 0
    : typeof node.fieldValue === 'string' && /^\d+$/u.test(node.fieldValue.trim()) && Number.isSafeInteger(Number(node.fieldValue));

export const runningHubImageCountConflict = (workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding): string => {
  const key = keyOf(binding.nodeId, binding.inputName);
  const matches = (entry: RunningHubVideoInputBinding) => keyOf(entry.nodeId, entry.inputName) === key;
  if (workflow.mapping.prompt.some(matches)) return '提示词输入';
  if (workflow.mapping.images.some(matches)) return '参考图片槽';
  if ((workflow.mapping.audios || []).some(matches)) return '参考音频槽';
  const parameter = Object.entries(workflow.mapping.parameters || {}).find(([, entry]) => matches(entry));
  return parameter ? `参数 ${parameter[0]}` : '';
};

/** Bind once per workflow; generation supplies each segment's effective image count. */
export const bindRunningHubImageCount = (
  workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding | null | undefined,
): RunningHubVideoWorkflow => {
  const mapping = { ...workflow.mapping };
  if (binding === undefined) delete mapping.imageCount;
  else mapping.imageCount = binding === null ? null : { ...binding };
  if (!binding) return { ...workflow, mapping };
  const conflict = runningHubImageCountConflict(workflow, binding);
  if (conflict) throw new Error(`${binding.nodeId}.${binding.inputName} 已绑定为${conflict}，请先解除原绑定。`);
  const node = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
    .find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
  if (!node || !isRunningHubImageCountField(node)) throw new Error('图片数量请绑定实际的非负整数字段或整数字符串字段。');
  return { ...workflow, mapping, requestTemplate: ensureRunningHubVideoRequestNode(workflow.requestTemplate, node) };
};

/** Editor-only synchronization. Loading the application or compiling a saved
 * workflow must not turn static image inputs into dynamic mappings. Opening a
 * draft exposes its real image inputs; only an explicit save persists them. */
export const syncRunningHubImageSlots = (workflow: RunningHubVideoWorkflow): RunningHubVideoWorkflow => {
  try {
    readRunningHubVideoRequest(workflow.requestTemplate);
    const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog);
    const images = workflow.mapping.images.filter((binding) => binding.nodeId.trim() || binding.inputName.trim());
    const keys = new Set(images.map((binding) => keyOf(binding.nodeId, binding.inputName)));
    const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
    const occupied = new Set([...workflow.mapping.prompt, ...(workflow.mapping.audios || []), ...Object.values(workflow.mapping.parameters || {}), ...(imageCount ? [imageCount] : [])]
      .map((binding) => keyOf(binding.nodeId, binding.inputName)));
    for (const node of selectRunningHubVideoFieldChoices(nodes, 'images', { catalog: workflow.nodeCatalog })) {
      const key = keyOf(node.nodeId, node.fieldName);
      if (keys.has(key) || occupied.has(key)) continue;
      images.push({ nodeId: node.nodeId, inputName: node.fieldName, role: 'general' });
      keys.add(key);
    }
    let requestTemplate = workflow.requestTemplate;
    for (const binding of images) {
      const node = nodes.find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
      if (node) requestTemplate = ensureRunningHubVideoRequestNode(requestTemplate, node);
    }
    return JSON.stringify(images) === JSON.stringify(workflow.mapping.images) && requestTemplate === workflow.requestTemplate ? workflow
      : { ...workflow, requestTemplate, mapping: { ...workflow.mapping, images } };
  } catch { return workflow; } // Keep malformed/duplicated rows editable without partial synchronization.
};
