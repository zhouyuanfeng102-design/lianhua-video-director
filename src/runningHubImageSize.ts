import type { ImageResolutionTier } from './imageResolution';
import type { RunningHubVideoFieldControl, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import { coerceRunningHubVideoNodeValue, readRunningHubVideoRequest } from './runningHubVideo';
import { isRunningHubMegapixelsField, listRunningHubVideoNodes, resolveRunningHubVideoFieldControl } from './runningHubVideoNodes';

const edges: Record<ImageResolutionTier, number> = { '1K': 1024, '2K': 2048, '4K': 4096 };
interface BoundField { node: RunningHubVideoNodeInfo; control?: RunningHubVideoFieldControl }

/** Only a uniquely present, explicitly mapped request field supplies size intent. */
const boundField = (workflow: RunningHubVideoWorkflow, key: string): BoundField | undefined => {
  const binding = workflow.mapping.parameters?.[key];
  if (!binding) return undefined;
  try {
    const matches = readRunningHubVideoRequest(workflow.requestTemplate).nodeInfoList
      .filter(node => node.nodeId === binding.nodeId && node.fieldName === binding.inputName);
    if (matches.length !== 1) return undefined;
    const node = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
      .find(item => item.nodeId === binding.nodeId && item.fieldName === binding.inputName)!;
    return { node, control: resolveRunningHubVideoFieldControl(workflow, binding)?.control };
  } catch { return undefined; }
};
const megapixels = ({ node, control }: BoundField): boolean => isRunningHubMegapixelsField(node.fieldName) || control?.unit === 'MP';
const pixelField = ({ node }: BoundField): boolean => typeof node.fieldValue === 'string'
  || typeof node.fieldValue === 'number' && Number.isFinite(node.fieldValue);
const numericEdge = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 64 ? parsed : undefined;
};
const optionTier = (value: string): ImageResolutionTier | undefined => {
  const k = value.trim().match(/^([124])k(?=\s|\(|$)/iu);
  if (k) return `${k[1]}K` as ImageResolutionTier;
  const pixels = value.trim().match(/^(1024|2048|4096)(?=\s|\(|$)/u);
  return pixels ? ({ '1024': '1K', '2048': '2K', '4096': '4K' } as const)[pixels[1] as '1024' | '2048' | '4096'] : undefined;
};
const optionsOf = ({ control }: BoundField): string[] | undefined => control?.kind === 'select' && control.options?.length
  ? [...new Set(control.options)] : undefined;
const compatibleOption = ({ node }: BoundField, option: string): boolean => typeof node.fieldValue === 'string'
  || typeof node.fieldValue === 'number' && numericEdge(option) !== undefined;
const tierField = (field: BoundField | undefined): field is BoundField => Boolean(field && !megapixels(field)
  && (optionsOf(field)?.some(option => optionTier(option) && compatibleOption(field, option))
    ?? (numericEdge(field.node.fieldValue) !== undefined || typeof field.node.fieldValue === 'string' && /^[124]k$/iu.test(field.node.fieldValue.trim()))));

export const runningHubImageSizeMode = (workflow?: RunningHubVideoWorkflow): 'pixels' | 'tier' | 'default' => {
  if (!workflow) return 'default';
  const width = boundField(workflow, 'width'); const height = boundField(workflow, 'height');
  if (width && height && !megapixels(width) && !megapixels(height)
    && pixelField(width) && pixelField(height)
    && (width.node.nodeId !== height.node.nodeId || width.node.fieldName !== height.node.fieldName)) return 'pixels';
  return tierField(boundField(workflow, 'resolution')) ? 'tier' : 'default';
};

const ratio = (value: string): number | undefined => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)(?=\s|\(|$)/u);
  if (!match) return undefined;
  const result = Number(match[1]) / Number(match[2]);
  return Number.isFinite(result) && result > 0 ? result : undefined;
};

/** Tier and ratio overrides preserve the cloud field's wire type and option spelling. */
export const runningHubImageTierParameters = (
  workflow: RunningHubVideoWorkflow, tier: ImageResolutionTier, aspect?: string,
): Record<string, unknown> => {
  if (!Object.prototype.hasOwnProperty.call(edges, tier)) throw new Error('RunningHub 生图档位请选择 1K、2K 或 4K。');
  const resolution = boundField(workflow, 'resolution');
  if (!tierField(resolution)) throw new Error('当前 RunningHub 工作流未绑定可识别的分辨率档位字段；请使用工作流默认尺寸或绑定真实字段，MP 与 P 档位不会自动换算为 K 档。');
  let value: string | number;
  const options = optionsOf(resolution);
  if (options) {
    const matched = options.filter(option => optionTier(option) === tier && compatibleOption(resolution, option));
    if (matched.length !== 1) throw new Error(`RunningHub 分辨率字段没有唯一的 ${tier} 选项；请核对云端可选值，不会自动改档。`);
    value = matched[0];
  } else if (numericEdge(resolution.node.fieldValue) !== undefined) value = edges[tier];
  else value = /k$/u.test(String(resolution.node.fieldValue).trim()) ? tier.toLowerCase() : tier;
  const parameters: Record<string, unknown> = { resolution: coerceRunningHubVideoNodeValue(resolution.node.fieldValue, value, '生图分辨率') };
  if (aspect !== undefined && workflow.mapping.parameters?.aspect_ratio) {
    const field = boundField(workflow, 'aspect_ratio');
    const requested = ratio(aspect);
    if (!field || typeof field.node.fieldValue !== 'string' || requested === undefined) throw new Error('RunningHub 画面比例需要有效的比例和真实文本字段映射。');
    const ratioOptions = optionsOf(field);
    if (ratioOptions) {
      const matched = ratioOptions.filter(option => { const candidate = ratio(option); return candidate !== undefined && Math.abs(candidate - requested) < 1e-8; });
      if (matched.length !== 1) throw new Error(`RunningHub 画面比例字段没有唯一的 ${aspect} 选项；不会忽略所选比例。`);
      parameters.aspect_ratio = matched[0];
    } else parameters.aspect_ratio = aspect;
  }
  return parameters;
};
