import type { ImageApiConfig } from './types';
import type { RunningHubVideoImportResult, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, importRunningHubVideoWorkflow,
  normalizeRunningHubVideoConfig, readRunningHubVideoRequest, validateRunningHubVideoWorkflow } from './runningHubVideo';

export const RUNNINGHUB_IMAGE_APP_ID = '2070152175753453569';
export interface RunningHubImageConfigFields {
  runningHubWorkflows: RunningHubVideoWorkflow[];
  activeRunningHubWorkflowId: string | null;
}

export const normalizeRunningHubImageConfig = (raw: unknown): RunningHubImageConfigFields => {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const normalized = normalizeRunningHubVideoConfig({ workflows: value.runningHubWorkflows,
    activeWorkflowId: value.activeRunningHubWorkflowId });
  return { runningHubWorkflows: normalized.workflows, activeRunningHubWorkflowId: normalized.activeWorkflowId ?? null };
};

export const selectedRunningHubImageWorkflow = (config: ImageApiConfig): RunningHubVideoWorkflow | undefined => {
  const fields = normalizeRunningHubImageConfig(config);
  return fields.runningHubWorkflows.find(workflow => workflow.id === fields.activeRunningHubWorkflowId);
};

/** Only a unique API prompt field is a business prompt; system instructions and
 * arbitrary local ComfyUI graph strings are never inferred as prompt inputs. */
export const importRunningHubImageWorkflow = (text: string, name?: string): RunningHubVideoImportResult => {
  const imported = importRunningHubVideoWorkflow(text, name);
  const workflow = imported.workflow;
  if (!name && workflow.remoteId === RUNNINGHUB_IMAGE_APP_ID && workflow.name === '导入的云端工作流') workflow.name = 'Krea2';
  const nodes = readRunningHubVideoRequest(workflow.requestTemplate).nodeInfoList;
  if (!workflow.mapping.prompt.length) {
    const prompts = nodes.filter(node => node.fieldName === 'prompt' && typeof node.fieldValue === 'string');
    if (prompts.length === 1) workflow.mapping.prompt = [{ nodeId: prompts[0].nodeId, inputName: prompts[0].fieldName }];
  }
  const parameters = { ...workflow.mapping.parameters };
  for (const dimension of ['width', 'height'] as const) {
    if (parameters[dimension]) continue;
    const candidates = nodes.filter(node => {
      if (!['string', 'number'].includes(typeof node.fieldValue)) return false;
      const description = typeof node.description === 'string' ? node.description : '';
      const documentedAppField = workflow.runKind === 'ai-app' && workflow.remoteId === RUNNINGHUB_IMAGE_APP_ID
        && node.fieldName === 'value' && node.nodeId === (dimension === 'width' ? '95' : '96');
      return documentedAppField || (dimension === 'width' ? /(?:宽度|\bwidth\b)/iu : /(?:高度|\bheight\b)/iu).test(description);
    });
    if (candidates.length === 1) parameters[dimension] = { nodeId: candidates[0].nodeId, inputName: candidates[0].fieldName };
  }
  workflow.mapping.parameters = parameters;
  return { ...imported, workflow, warnings: imported.warnings.filter(warning =>
    !workflow.mapping.prompt.length || !warning.includes('导入没有自动猜测提示词')) };
};

export const validateRunningHubImageWorkflow = (workflow: RunningHubVideoWorkflow): string[] => {
  const issues = validateRunningHubVideoWorkflow(workflow);
  if (workflow.mapping.audios?.length) issues.push('此图像连接不支持参考音频，请删除音频输入映射。');
  return issues;
};
export const isRunningHubImageWorkflowReady = (workflow: RunningHubVideoWorkflow | undefined): boolean =>
  Boolean(workflow && !validateRunningHubImageWorkflow(workflow).length);

export const validateRunningHubImageConfig = (config: ImageApiConfig, referenceCount = 0): string | undefined => {
  const workflow = selectedRunningHubImageWorkflow(config);
  if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) return '参考图数量无效。';
  if (referenceCount > (workflow?.mapping.images.length ?? 0)) return `此 RunningHub 工作流只有 ${workflow?.mapping.images.length ?? 0} 个图片输入槽，不能接收 ${referenceCount} 张参考图；不会忽略已选图片。`;
  if (!config.enabled) return '图像生成接口未启用。';
  if (!config.apiKey.trim()) return '请填写 RunningHub API 密钥。';
  if (!workflow) return '请明确选择当前 RunningHub 图像工作流；已删除的选择不会改用其他工作流。';
  const issues = validateRunningHubImageWorkflow(workflow);
  if (issues.length) return issues.join('\n');
  try {
    const root = new URL(config.baseUrl.trim());
    if (!/^https?:$/u.test(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error();
  } catch { return '请填写无内嵌凭据的 RunningHub HTTP(S) 基础地址。'; }
  return undefined;
};

export interface RunningHubImageInput { prompt: string; width?: number; height?: number; sizeOverride?: boolean; referenceCount?: number; uploadedImages?: string[] }
export const buildRunningHubImageRequest = (config: ImageApiConfig, input: RunningHubImageInput): {
  endpoint: string; queryEndpoint: string; uploadEndpoint: string; headers: Record<string, string>; body: Record<string, unknown>; outputNodeId?: string;
} => {
  const referenceCount = input.referenceCount ?? input.uploadedImages?.length ?? 0;
  const issue = validateRunningHubImageConfig(config, referenceCount);
  if (issue) throw new Error(issue);
  if (!input.prompt.trim()) throw new Error('请先填写图像提示词。');
  const fields = normalizeRunningHubImageConfig(config);
  const workflow = fields.runningHubWorkflows.find(item => item.id === fields.activeRunningHubWorkflowId)!;
  if ((input.uploadedImages?.length ?? 0) !== referenceCount) throw new Error('参考图上传结果数量与所选图片不一致，尚未提交图像任务。');
  const parameters: Record<string, unknown> = {};
  if (input.sizeOverride) for (const dimension of ['width', 'height'] as const) {
    if (!workflow.mapping.parameters?.[dimension]) throw new Error(`RunningHub ${dimension} 尚未绑定云端尺寸字段，不能忽略所选像素。`);
    if (!Number.isSafeInteger(input[dimension]) || (input[dimension] ?? 0) < 64) throw new Error('图片宽和高必须是至少 64 的整数。');
    parameters[dimension] = input[dimension];
  }
  const compiled = compileRunningHubVideoApi({ enabled: config.enabled, baseUrl: config.baseUrl, apiKey: config.apiKey,
    workflows: fields.runningHubWorkflows, activeWorkflowId: fields.activeRunningHubWorkflowId }, workflow.id, parameters);
  const body = bindRunningHubVideoRequest(compiled.requestTemplate!, compiled.runningHubMappedFields!,
    { prompt: input.prompt, parameters }, input.uploadedImages ?? []);
  const original = readRunningHubVideoRequest(workflow.requestTemplate);
  const bound = body.nodeInfoList as typeof original.nodeInfoList;
  workflow.mapping.images.slice(referenceCount).forEach(binding => {
    const source = original.nodeInfoList.find(node => node.nodeId === binding.nodeId && node.fieldName === binding.inputName)!;
    const target = bound.find(node => node.nodeId === binding.nodeId && node.fieldName === binding.inputName)!;
    target.fieldValue = source.fieldValue;
  });
  // Import metadata identifies a configuration; it is not part of the cloud request.
  for (const key of ['endpoint', 'remoteId', 'runKind', 'workflowId', 'webappId', 'appId']) delete body[key];
  return { endpoint: compiled.endpoint, queryEndpoint: compiled.statusEndpointTemplate!, uploadEndpoint: compiled.imageUploadEndpoint!,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey.trim()}` }, body,
    ...(workflow.outputNodeId ? { outputNodeId: workflow.outputNodeId } : {}) };
};
