import type { RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { coerceRunningHubVideoNodeValue, readRunningHubVideoRequest } from './runningHubVideo';

export const RUNNINGHUB_IMAGE_V3_APP_ID = '2079381758411587586';
const imageIds = new Set(['181', '182', '183']);
export const runningHubImageV3OptionalImage = (nodeId: string, inputName: string): boolean =>
  inputName === 'image' && imageIds.has(nodeId);

/** Exact public app contract, checked on 2026-10-13:
 * https://www.runninghub.ai/ai-detail/2079381758411587586
 * All three optional LoadImage inputs declare None. 195.value enables the
 * selected 194.aspect_ratio and is required when all references are removed.
 * Do not infer this behavior from labels on other applications. */
export const isRunningHubImageV3Workflow = (workflow?: RunningHubVideoWorkflow): boolean => {
  if (!workflow || workflow.runKind !== 'ai-app' || workflow.remoteId.trim() !== RUNNINGHUB_IMAGE_V3_APP_ID) return false;
  try {
    const nodes = readRunningHubVideoRequest(workflow.requestTemplate).nodeInfoList;
    const unique = (id: string, name: string) => {
      const matches = nodes.filter(node => node.nodeId === id && node.fieldName === name);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const prompt = unique('107', 'text'); const resolution = unique('189', 'value');
    const aspect = unique('194', 'aspect_ratio'); const gate = unique('195', 'value');
    if (typeof prompt?.fieldValue !== 'string' || !resolution || !['string', 'number'].includes(typeof resolution.fieldValue)
      || !Number.isSafeInteger(Number(resolution.fieldValue)) || Number(resolution.fieldValue) < 64
      || typeof aspect?.fieldValue !== 'string' || !/^\d+\s*:\s*\d+$/u.test(aspect.fieldValue.trim())
      || !gate || ![true, false, 'true', 'false'].includes(gate.fieldValue as boolean | string)) return false;
    return nodes.filter(node => runningHubImageV3OptionalImage(node.nodeId, node.fieldName))
      .every(node => typeof node.fieldValue === 'string' && unique(node.nodeId, node.fieldName) === node);
  } catch { return false; }
};

/** Explicit new size intent activates its dependency in a request copy.
 * With references and workflow-default sizing the original switch survives. */
export const applyRunningHubImageV3AspectGate = (
  workflow: RunningHubVideoWorkflow, nodes: RunningHubVideoNodeInfo[], referenceCount: number, aspectOverride: boolean,
): void => {
  if (!isRunningHubImageV3Workflow(workflow) || referenceCount > 0 && !aspectOverride) return;
  const gate = nodes.find(node => node.nodeId === '195' && node.fieldName === 'value')!;
  gate.fieldValue = coerceRunningHubVideoNodeValue(gate.fieldValue, true, '其他比例');
};
