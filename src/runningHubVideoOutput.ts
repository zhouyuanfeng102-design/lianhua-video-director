import type { RunningHubVideoFieldControl, RunningHubVideoInputBinding, RunningHubVideoNodeCatalogEntry, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { ensureRunningHubVideoRequestNode } from './runningHubVideo';
import { isRunningHubMegapixelsField, listRunningHubVideoNodes, normalizeRunningHubVideoFieldControl, normalizeRunningHubVideoFieldControls, resolveRunningHubVideoFieldControl } from './runningHubVideoNodes';
import { selectRunningHubVideoFieldChoices } from './runningHubVideoFieldChoices';
import { resolveRunningHubVideoImageProtocol } from './runningHubImageProtocol';

export type RunningHubVideoOutputKey = 'duration' | 'aspect_ratio' | 'resolution' | 'steps' | 'width' | 'height';
export const runningHubVideoOutputFields: ReadonlyArray<{ key: RunningHubVideoOutputKey; label: string; hint: string }> = [
  { key: 'duration', label: '视频时长', hint: '单位秒，不是帧数或实例保留时间。' },
  { key: 'aspect_ratio', label: '画面比例', hint: '按云端字段的完整选项值提交，例如 9:16 (Portrait Widescreen)。' },
  { key: 'resolution', label: '分辨率', hint: '按云端原格式填写，如 720P / 1080P；megapixels 使用百万像素（MP），不自动换算宽高。' },
  { key: 'steps', label: '采样步数', hint: '绑定实际采样步数字段；生成时留空使用工作流默认值，不自动改动其他采样参数。' },
  { key: 'width', label: '像素宽度', hint: '像素宽度，不自动计算宽高比。' },
  { key: 'height', label: '像素高度', hint: '像素高度；采用档位时可不绑定。' },
];
const same = (left: RunningHubVideoInputBinding, right: RunningHubVideoInputBinding) => left.nodeId === right.nodeId && left.inputName === right.inputName;
const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase().replace(/[\s_-]+/gu, '');
const names: Record<RunningHubVideoOutputKey, RegExp> = {
  duration: /^(?:duration|durationsec|durationseconds|videoduration|seconds|时长|视频时长|秒数)$/u,
  aspect_ratio: /^(?:aspectratio|ratio|画面比例|宽高比|纵横比)$/u,
  resolution: /^(?:resolution|imageresolution|videoresolution|outputresolution|megapixels?|百万像素|分辨率|清晰度)$/u,
  steps: /^(?:steps|samplingsteps|samplersteps|numsteps|numinferencesteps|inferencesteps|采样步数|采样次数|步数)$/u,
  width: /^(?:(?:image|video|output|target|frame)?width|宽度|像素宽度|画面宽度)$/u,
  height: /^(?:(?:image|video|output|target|frame)?height|高度|像素高度|画面高度)$/u,
};
const descriptions: Record<RunningHubVideoOutputKey, RegExp> = {
  duration: /duration|seconds|时长|秒数/u,
  aspect_ratio: /aspect.?ratio|ratio|画面比例|宽高比|纵横比/u,
  resolution: /resolution|megapixels?|百万像素|分辨率|清晰度/u,
  steps: /sampling.?steps|sampler.?steps|inference.?steps|采样步数|采样次数|步数/u,
  width: /width|宽度|像素宽/u,
  height: /height|高度|像素高/u,
};
const generics = /^(?:value|int|integer|float|number|string|input|数值|值)$/u;

/** An explicit unit or field name establishes MP; decimal values alone do not. */
export const isRunningHubVideoMegapixelsBinding = (workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding): boolean => {
  const node = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
    .find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
  return Boolean(node && (isRunningHubMegapixelsField(node.fieldName)
    || normalizeRunningHubVideoFieldControl(workflow.fieldControls?.[JSON.stringify([node.nodeId, node.fieldName])])?.unit === 'MP'
    || normalizeRunningHubVideoFieldControl(node.control)?.unit === 'MP'));
};

/** Prepare a correction for the editor only. Saving it remains an explicit UI action. */
export const runningHubVideoOutputDraft = (workflow: RunningHubVideoWorkflow): {
  workflow: RunningHubVideoWorkflow; movedFrom?: 'width' | 'height'; issue: string;
} => {
  const misplaced = (['width', 'height'] as const).filter((key) => {
    const binding = workflow.mapping.parameters?.[key];
    return binding && isRunningHubVideoMegapixelsBinding(workflow, binding);
  });
  if (!misplaced.length) return { workflow, issue: '' };
  if (misplaced.length > 1) return { workflow, issue: '宽度和高度都绑定了 MP 字段，请明确保留的像素输入；原映射均已保留。' };
  const movedFrom = misplaced[0];
  const binding = workflow.mapping.parameters![movedFrom];
  if (workflow.mapping.parameters?.resolution) return { workflow, issue: '分辨率已有绑定，MP 字段仍保留在原映射；请先明确使用哪个像素输入。' };
  const conflict = runningHubVideoOutputConflict(workflow, movedFrom, binding);
  if (conflict) return { workflow, issue: `MP 字段还用于${conflict}，原映射已保留；请先明确字段用途。` };
  const parameters: Record<string, RunningHubVideoInputBinding> = { ...workflow.mapping.parameters, resolution: { ...binding } };
  delete parameters[movedFrom];
  return { workflow: { ...workflow, mapping: { ...workflow.mapping, parameters } }, movedFrom, issue: '' };
};

export const runningHubVideoOutputControl = (workflow: RunningHubVideoWorkflow, key: RunningHubVideoOutputKey) => {
  const binding = workflow.mapping.parameters?.[key];
  if (!binding) return undefined;
  const resolved = resolveRunningHubVideoFieldControl(workflow, binding);
  if (key !== 'steps' || !resolved) return resolved;
  const node = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
    .find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
  // A count can use a numeric editor even when the request serializes it as text.
  // Keep cloud/user controls and the original request value; infer no bounds.
  return node?.control || workflow.fieldControls?.[JSON.stringify([binding.nodeId, binding.inputName])]
    ? resolved : { ...resolved, control: { kind: 'number' as const } };
};

/** Editing a display control never changes the node default, mapping or request. */
export const setRunningHubVideoFieldControl = (
  workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding, control: RunningHubVideoFieldControl | undefined,
): RunningHubVideoWorkflow => {
  const key = JSON.stringify([binding.nodeId, binding.inputName]);
  const fieldControls = normalizeRunningHubVideoFieldControls(workflow.fieldControls);
  const normalized = normalizeRunningHubVideoFieldControl(control);
  if (normalized) fieldControls[key] = normalized;
  else delete fieldControls[key];
  return { ...workflow, fieldControls };
};

/** Suggestions help find real fields; never infer IDs, rewrite mappings or values. */
export const runningHubVideoOutputCandidates = (
  nodes: RunningHubVideoNodeInfo[], key: RunningHubVideoOutputKey,
  options: { showAll?: boolean; search?: string; binding?: RunningHubVideoInputBinding; catalog?: RunningHubVideoNodeCatalogEntry[]; fieldControls?: Record<string, RunningHubVideoFieldControl> } = {},
): RunningHubVideoNodeInfo[] => {
  const query = (options.search || '').trim().toLowerCase();
  return selectRunningHubVideoFieldChoices(nodes, 'parameters', { showAll: true, catalog: options.catalog }).filter((node) => {
    const controlKey = JSON.stringify([node.nodeId, node.fieldName]);
    const catalogControl = options.catalog?.find((entry) => entry.nodeId === node.nodeId && entry.fieldName === node.fieldName)?.control;
    const megapixels = isRunningHubMegapixelsField(node.fieldName) || normalizeRunningHubVideoFieldControl(options.fieldControls?.[controlKey])?.unit === 'MP'
      || normalizeRunningHubVideoFieldControl(node.control)?.unit === 'MP' || catalogControl?.unit === 'MP';
    if ((key === 'width' || key === 'height') && megapixels) return false;
    if (options.binding && same(options.binding, { nodeId: node.nodeId, inputName: node.fieldName })) return true;
    if (typeof node.fieldValue !== 'string' && typeof node.fieldValue !== 'number') return false;
    const name = normalize(node.fieldName);
    const description = typeof node.description === 'string' ? normalize(node.description) : '';
    const wrongDurationUnit = key === 'duration' && /frames|帧数|milliseconds?|毫秒|retain|retention|keepalive|timeout|保留|超时|等待/u.test(description);
    const suggested = !wrongDurationUnit && (names[key].test(name) || generics.test(name) && descriptions[key].test(description));
    const displayDescription = typeof node.description === 'string' ? node.description : '';
    return (options.showAll || suggested) && (!query || `${node.nodeId}.${node.fieldName} ${displayDescription}`.toLowerCase().includes(query));
  });
};

export const runningHubVideoOutputConflict = (workflow: RunningHubVideoWorkflow, key: RunningHubVideoOutputKey, binding: RunningHubVideoInputBinding): string => {
  const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
  if (imageCount && same(imageCount, binding)) return '每段实际图片数量';
  if (workflow.mapping.prompt.some((entry) => same(entry, binding))) return '提示词输入';
  if (workflow.mapping.images.some((entry) => same(entry, binding))) return '参考图片槽';
  const other = Object.entries(workflow.mapping.parameters || {}).find(([name, entry]) => name !== key && same(entry, binding));
  return other ? `参数 ${other[0]}` : '';
};

/** Only an explicit selection creates one request override. Unbinding retains original JSON. */
export const bindRunningHubVideoOutput = (workflow: RunningHubVideoWorkflow, key: RunningHubVideoOutputKey, binding?: RunningHubVideoInputBinding): RunningHubVideoWorkflow => {
  const parameters = { ...workflow.mapping.parameters };
  if (!binding || (!binding.nodeId && !binding.inputName)) {
    delete parameters[key];
    return { ...workflow, mapping: { ...workflow.mapping, parameters } };
  }
  const conflict = runningHubVideoOutputConflict(workflow, key, binding);
  if (conflict) throw new Error(`${binding.nodeId}.${binding.inputName} 已绑定为${conflict}，请先在原位置解除绑定；不会覆盖或重命名已有映射。`);
  const node = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog).find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
  if (!node || !['string', 'number'].includes(typeof node.fieldValue)) throw new Error('请选择真实的文本或数值节点字段；布尔值、数组和连线不能作为生成参数输入。');
  if ((key === 'width' || key === 'height') && isRunningHubVideoMegapixelsBinding(workflow, binding)) throw new Error('MP 是总像素档位，请绑定到分辨率（像素 MP），不能作为像素宽度或高度。');
  const requestTemplate = ensureRunningHubVideoRequestNode(workflow.requestTemplate, node);
  parameters[key] = { ...binding };
  return { ...workflow, requestTemplate, mapping: { ...workflow.mapping, parameters } };
};
