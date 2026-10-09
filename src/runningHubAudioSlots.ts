import type { RunningHubVideoInputBinding, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { ensureRunningHubVideoRequestNode, readRunningHubVideoRequest } from './runningHubVideo';
import { listRunningHubVideoNodes } from './runningHubVideoNodes';
import { selectRunningHubVideoFieldChoices } from './runningHubVideoFieldChoices';
import { resolveRunningHubVideoImageProtocol } from './runningHubImageProtocol';

export const runningHubAudioBindingId = (binding: RunningHubVideoInputBinding): string => JSON.stringify([binding.nodeId, binding.inputName]);

/** Editor-only discovery. Saving a draft is required before these slots are used.
 * No audio value is replaced until a generation explicitly selects that slot. */
export const syncRunningHubAudioSlots = (workflow: RunningHubVideoWorkflow): RunningHubVideoWorkflow => {
  try {
    readRunningHubVideoRequest(workflow.requestTemplate);
    const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog);
    const audios = [...(workflow.mapping.audios || [])];
    const keys = new Set(audios.map(runningHubAudioBindingId));
    const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
    const occupied = new Set([...workflow.mapping.prompt, ...workflow.mapping.images,
      ...Object.values(workflow.mapping.parameters || {}), ...(imageCount ? [imageCount] : [])].map(runningHubAudioBindingId));
    for (const node of selectRunningHubVideoFieldChoices(nodes, 'audios', { catalog: workflow.nodeCatalog })) {
      const binding = { nodeId: node.nodeId, inputName: node.fieldName };
      const key = runningHubAudioBindingId(binding);
      if (keys.has(key) || occupied.has(key)) continue;
      audios.push(binding); keys.add(key);
    }
    let requestTemplate = workflow.requestTemplate;
    for (const binding of audios) {
      const node = nodes.find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
      if (node) requestTemplate = ensureRunningHubVideoRequestNode(requestTemplate, node);
    }
    if (JSON.stringify(audios) === JSON.stringify(workflow.mapping.audios || []) && requestTemplate === workflow.requestTemplate) return workflow;
    return { ...workflow, requestTemplate, mapping: { ...workflow.mapping, audios } };
  } catch { return workflow; }
};
