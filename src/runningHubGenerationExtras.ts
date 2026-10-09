import { ensureRunningHubVideoRequestNode } from './runningHubVideo';
import { resolveRunningHubVideoImageProtocol } from './runningHubImageProtocol';
import { isRunningHubVideoSecretField, listRunningHubVideoNodes } from './runningHubVideoNodes';
import type { RunningHubGenerationExtras, RunningHubLoraSlot, RunningHubVideoInputBinding, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';

const record = (raw: unknown): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
const keyOf = (binding: RunningHubVideoInputBinding) => JSON.stringify([binding.nodeId, binding.inputName]);
const same = (left: RunningHubVideoInputBinding, right: RunningHubVideoInputBinding) => keyOf(left) === keyOf(right);
const bindingOf = (node: RunningHubVideoNodeInfo): RunningHubVideoInputBinding => ({ nodeId: node.nodeId, inputName: node.fieldName });
const safeScalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const compact = (name: string) => name.toLowerCase().replace(/[\s_-]+/gu, '');
const loraModelName = /^(?:lora|loraname|loramodel|loramodelname|lorafile|lorafilename|lora模型|lora名称|lora文件|lora文件名)$/u;
const commonParameters = new Set(['duration', 'aspect_ratio', 'resolution', 'steps', 'width', 'height']);

const normalizeBinding = (raw: unknown): RunningHubVideoInputBinding | undefined => {
  if (!record(raw)) return undefined;
  const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : Number.isSafeInteger(raw.nodeId) ? String(raw.nodeId) : '';
  const inputName = typeof raw.inputName === 'string' ? raw.inputName : typeof raw.fieldName === 'string' ? raw.fieldName : '';
  if (!nodeId.trim() || !inputName.trim() || isRunningHubVideoSecretField(inputName)) return undefined;
  return { nodeId, inputName };
};
const uniqueBindings = (raw: unknown): RunningHubVideoInputBinding[] => {
  const seen = new Set<string>();
  return Array.isArray(raw) ? raw.flatMap((item) => {
    const binding = normalizeBinding(item);
    if (!binding || seen.has(keyOf(binding))) return [];
    seen.add(keyOf(binding)); return [binding];
  }) : [];
};

/** Normalize local metadata without rewriting the request or inferring node identities. */
export const normalizeRunningHubGenerationExtras = (raw: unknown): RunningHubGenerationExtras => {
  if (!record(raw)) return {};
  const seen = new Set<string>();
  const loraSlots: RunningHubLoraSlot[] = Array.isArray(raw.loraSlots) ? raw.loraSlots.flatMap((item) => {
    if (!record(item)) return [];
    const model = normalizeBinding(item.model);
    if (!model || seen.has(keyOf(model))) return [];
    seen.add(keyOf(model));
    const strength = normalizeBinding(item.strength);
    const clipStrength = normalizeBinding(item.clipStrength);
    return [{ model,
      ...(strength && !same(model, strength) ? { strength } : {}),
      ...(clipStrength && !same(model, clipStrength) && (!strength || !same(strength, clipStrength)) ? { clipStrength } : {}),
      ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim() } : {}) }];
  }) : [];
  return {
    ...(Array.isArray(raw.loraSlots) ? { loraSlots } : {}),
    ...(Array.isArray(raw.otherFields) ? { otherFields: uniqueBindings(raw.otherFields) } : {}),
    ...(Array.isArray(raw.hiddenLoras) ? { hiddenLoras: uniqueBindings(raw.hiddenLoras) } : {}),
  };
};

const requestNodes = (workflow: RunningHubVideoWorkflow): RunningHubVideoNodeInfo[] => {
  const nodes = listRunningHubVideoNodes(workflow.requestTemplate, undefined);
  const counts = new Map<string, number>();
  nodes.forEach((node) => counts.set(keyOf(bindingOf(node)), (counts.get(keyOf(bindingOf(node))) || 0) + 1));
  return nodes.filter((node) => counts.get(keyOf(bindingOf(node))) === 1 && Boolean(normalizeBinding(bindingOf(node))) && safeScalar(node.fieldValue));
};
const reservedConflict = (workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding): string => {
  if (workflow.mapping.prompt.some((item) => same(item, binding))) return '提示词输入';
  if (workflow.mapping.images.some((item) => same(item, binding))) return '参考图片槽';
  const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
  if (imageCount && same(imageCount, binding)) return '实际图片数量';
  const common = Object.entries(workflow.mapping.parameters || {}).find(([name, item]) => commonParameters.has(name) && same(item, binding));
  return common ? `常用参数 ${common[0]}` : '';
};
const slotBindings = (slot: RunningHubLoraSlot): RunningHubVideoInputBinding[] => [slot.model, ...(slot.strength ? [slot.strength] : []), ...(slot.clipStrength ? [slot.clipStrength] : [])];

export interface RunningHubDetectedLoraSlot extends RunningHubLoraSlot { automatic: boolean }

/** Only fields already exposed in the submitted template become automatic slots. */
export const listRunningHubLoraSlots = (workflow: RunningHubVideoWorkflow): RunningHubDetectedLoraSlot[] => {
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  const nodes = requestNodes(workflow);
  const byKey = new Map(nodes.map((node) => [keyOf(bindingOf(node)), node]));
  const hidden = new Set((extras.hiddenLoras || []).map(keyOf));
  const slots: RunningHubDetectedLoraSlot[] = [];
  const seen = new Set<string>();
  for (const slot of extras.loraSlots || []) {
    if (hidden.has(keyOf(slot.model)) || !byKey.has(keyOf(slot.model)) || reservedConflict(workflow, slot.model)) continue;
    const strength = slot.strength && byKey.has(keyOf(slot.strength)) && !reservedConflict(workflow, slot.strength) ? slot.strength : undefined;
    const clipStrength = slot.clipStrength && byKey.has(keyOf(slot.clipStrength)) && !reservedConflict(workflow, slot.clipStrength) ? slot.clipStrength : undefined;
    slots.push({ model: slot.model, ...(strength ? { strength } : {}), ...(clipStrength ? { clipStrength } : {}), ...(slot.label ? { label: slot.label } : {}), automatic: false });
    seen.add(keyOf(slot.model));
  }
  for (const node of nodes) {
    const model = bindingOf(node);
    if (!loraModelName.test(compact(node.fieldName)) || seen.has(keyOf(model)) || hidden.has(keyOf(model)) || reservedConflict(workflow, model)) continue;
    const findStrength = (name: string) => {
      const matches = nodes.filter((item) => item.nodeId === node.nodeId && compact(item.fieldName) === name);
      const binding = matches.length === 1 ? bindingOf(matches[0]) : undefined;
      return binding && !reservedConflict(workflow, binding) ? binding : undefined;
    };
    const strength = findStrength('strengthmodel');
    const clipStrength = findStrength('strengthclip');
    slots.push({ model, ...(strength ? { strength } : {}), ...(clipStrength ? { clipStrength } : {}),
      ...(typeof node.description === 'string' && node.description.trim() ? { label: node.description.trim() } : {}), automatic: true });
    seen.add(keyOf(model));
  }
  return slots;
};

const loraFields = (workflow: RunningHubVideoWorkflow): Set<string> => {
  // A hidden automatic slot still owns its LoRA fields; removing its panel never
  // changes the request's model/strength or reclassifies those fields as generic.
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  const keys = new Set((extras.loraSlots || []).flatMap(slotBindings).map(keyOf));
  const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
    .filter((node) => Boolean(normalizeBinding(bindingOf(node))) && safeScalar(node.fieldValue));
  for (const model of nodes.filter((node) => loraModelName.test(compact(node.fieldName)))) {
    keys.add(keyOf(bindingOf(model)));
    for (const node of nodes) {
      if (node.nodeId === model.nodeId && ['strengthmodel', 'strengthclip'].includes(compact(node.fieldName))) keys.add(keyOf(bindingOf(node)));
    }
  }
  return keys;
};

export const listRunningHubOtherFields = (workflow: RunningHubVideoWorkflow): RunningHubVideoInputBinding[] => {
  const available = new Set(requestNodes(workflow).map((node) => keyOf(bindingOf(node))));
  const loras = loraFields(workflow);
  return (normalizeRunningHubGenerationExtras(workflow.generationExtras).otherFields || [])
    .filter((binding) => available.has(keyOf(binding)) && !reservedConflict(workflow, binding) && !loras.has(keyOf(binding)));
};

const selectedNode = (workflow: RunningHubVideoWorkflow, raw: RunningHubVideoInputBinding): RunningHubVideoNodeInfo => {
  const binding = normalizeBinding(raw);
  if (!binding) throw new Error('请选择真实的节点字段；不能添加空位置或密钥字段。');
  const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog)
    .filter((node) => node.nodeId === binding.nodeId && node.fieldName === binding.inputName);
  if (nodes.length !== 1 || !safeScalar(nodes[0].fieldValue)) throw new Error(`${binding.nodeId}.${binding.inputName} 不是唯一的真实文本、数字或布尔节点字段；请先在节点参数中读取或添加实际字段。`);
  const conflict = reservedConflict(workflow, binding);
  if (conflict) throw new Error(`${binding.nodeId}.${binding.inputName} 已用于${conflict}，请先解除原用途再添加。`);
  return nodes[0];
};

/** Explicit selection adds only the selected real inputs, preserving default types. */
export const addRunningHubLoraSlot = (workflow: RunningHubVideoWorkflow, raw: RunningHubLoraSlot): RunningHubVideoWorkflow => {
  const requested = [raw.model, ...(raw.strength ? [raw.strength] : []), ...(raw.clipStrength ? [raw.clipStrength] : [])];
  const nodes = requested.map((binding) => selectedNode(workflow, binding));
  if (new Set(requested.map(keyOf)).size !== requested.length) throw new Error('LoRA 模型、模型强度和 CLIP 强度需要选择不同的真实字段。');
  const slot = normalizeRunningHubGenerationExtras({ loraSlots: [raw] }).loraSlots?.[0];
  if (!slot) throw new Error('LoRA 模型位置无效，请选择真实节点字段。');
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  const other = (extras.otherFields || []).find((binding) => requested.some((item) => same(item, binding)));
  if (other) throw new Error(`${other.nodeId}.${other.inputName} 已加入其它参数，请先移除该展示位置。`);
  const owner = listRunningHubLoraSlots({ ...workflow, generationExtras: { ...extras, hiddenLoras: [] } })
    .find((existing) => !same(existing.model, slot.model) && slotBindings(existing).some((binding) => requested.some((item) => same(item, binding))));
  if (owner) throw new Error('所选字段已用于另一个 LoRA 槽位，请为各槽位选择独立字段。');
  let requestTemplate = workflow.requestTemplate;
  for (const node of nodes) requestTemplate = ensureRunningHubVideoRequestNode(requestTemplate, node);
  const slots = extras.loraSlots || [];
  const index = slots.findIndex((existing) => same(existing.model, slot.model));
  const loraSlots = index < 0 ? [...slots, slot] : slots.map((existing, at) => at === index ? slot : existing);
  return { ...workflow, requestTemplate, generationExtras: { ...extras, loraSlots,
    hiddenLoras: (extras.hiddenLoras || []).filter((binding) => !same(binding, slot.model)) } };
};

/** Remove a panel position only; the request and all previous mappings survive. */
export const removeRunningHubLoraSlot = (workflow: RunningHubVideoWorkflow, model: RunningHubVideoInputBinding): RunningHubVideoWorkflow => {
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  const binding = normalizeBinding(model);
  if (!binding) return workflow;
  const hiddenLoras = uniqueBindings([...(extras.hiddenLoras || []), binding]);
  return { ...workflow, generationExtras: { ...extras, hiddenLoras } };
};

export const addRunningHubOtherField = (workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding): RunningHubVideoWorkflow => {
  const node = selectedNode(workflow, binding);
  const loras = loraFields(workflow);
  if (loras.has(keyOf(binding))) throw new Error(`${binding.nodeId}.${binding.inputName} 属于 LoRA 槽位，请在 LoRA 栏编辑。`);
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  const otherFields = uniqueBindings([...(extras.otherFields || []), binding]);
  return { ...workflow, requestTemplate: ensureRunningHubVideoRequestNode(workflow.requestTemplate, node), generationExtras: { ...extras, otherFields } };
};

export const removeRunningHubOtherField = (workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding): RunningHubVideoWorkflow => {
  const extras = normalizeRunningHubGenerationExtras(workflow.generationExtras);
  return { ...workflow, generationExtras: { ...extras, otherFields: (extras.otherFields || []).filter((item) => !same(item, binding)) } };
};
