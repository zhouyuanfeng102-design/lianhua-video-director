import type { RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { ensureRunningHubVideoRequestNode, readRunningHubVideoRequest } from './runningHubVideo';
import { listRunningHubVideoNodes } from './runningHubVideoNodes';
import { selectRunningHubVideoFieldChoices } from './runningHubVideoFieldChoices';

const keyOf = (nodeId: string, inputName: string) => JSON.stringify([nodeId, inputName]);

/** Editor-only synchronization. Loading the application or compiling a saved
 * workflow must not turn static image inputs into dynamic mappings. Opening a
 * draft exposes its real image inputs; only an explicit save persists them. */
export const syncRunningHubImageSlots = (workflow: RunningHubVideoWorkflow): RunningHubVideoWorkflow => {
  try {
    readRunningHubVideoRequest(workflow.requestTemplate);
    const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog);
    const images = workflow.mapping.images.filter((binding) => binding.nodeId.trim() || binding.inputName.trim());
    const keys = new Set(images.map((binding) => keyOf(binding.nodeId, binding.inputName)));
    const occupied = new Set([...workflow.mapping.prompt, ...Object.values(workflow.mapping.parameters || {})]
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
