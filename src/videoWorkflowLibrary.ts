import { importComfyVideoWorkflow, parseComfyVideoWorkflow } from './comfyuiVideo';
import { assertNoEmbeddedVideoCredentials } from './videoGenerationApi';
import type { ComfyVideoConfig, ComfyVideoInputBinding, ComfyVideoWorkflowPreset } from './videoGenerationTypes';

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const clone = <T,>(value: T): T => structuredClone(value);
const newId = () => `video-workflow-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Match the executor: a linked input must never become an editable literal. */
export const isVideoWorkflowConnection = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && typeof value[1] === 'number';

export const assertSafeVideoWorkflowJson = (text: string): void => {
  // Check the complete document, including a possible API request envelope.
  let document: unknown;
  try { document = JSON.parse(text); } catch { throw new Error('视频工作流不是有效 JSON。'); }
  assertNoEmbeddedVideoCredentials(document, '视频工作流');
  parseComfyVideoWorkflow(text);
};

export const readVideoWorkflowInput = (text: string, binding: ComfyVideoInputBinding): unknown => {
  const nodes = parseComfyVideoWorkflow(text);
  const node = own(nodes, binding.nodeId) ? nodes[binding.nodeId] : undefined;
  if (!node || !own(node.inputs, binding.inputName)) throw new Error(`找不到输入 ${binding.nodeId || '未选节点'}.${binding.inputName || '未选字段'}。`);
  const value = node.inputs[binding.inputName];
  if (isVideoWorkflowConnection(value)) throw new Error(`${binding.nodeId}.${binding.inputName} 是节点连线，不能覆盖；请选择上游节点的实际值字段。`);
  return value;
};

/** Locate a known JSON property without round-tripping unrelated 64-bit seeds. */
const jsonPropertyValueSpan = (text: string, path: string[]): [number, number] | undefined => {
  let cursor = 0;
  const whitespace = () => { while (/\s/u.test(text[cursor] || '') && cursor < text.length) cursor += 1; };
  const stringToken = (): string => {
    const start = cursor; cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor++] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const skip = () => {
    whitespace();
    if (text[cursor] === '"') { stringToken(); return; }
    if (text[cursor] === '{' || text[cursor] === '[') {
      const end = text[cursor++] === '{' ? '}' : ']';
      whitespace();
      while (text[cursor] !== end && cursor < text.length) {
        if (end === '}') { stringToken(); whitespace(); cursor += 1; }
        skip(); whitespace();
        if (text[cursor] === ',') { cursor += 1; whitespace(); }
      }
      cursor += 1; return;
    }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor])) cursor += 1;
  };
  const locate = (depth: number): [number, number] | undefined => {
    whitespace();
    if (depth === path.length) { const start = cursor; skip(); return [start, cursor]; }
    if (text[cursor] !== '{') { skip(); return undefined; }
    cursor += 1; whitespace();
    let found: [number, number] | undefined;
    while (text[cursor] !== '}' && cursor < text.length) {
      const key = stringToken(); whitespace(); cursor += 1;
      // JSON.parse uses the final occurrence when a document has duplicate keys.
      if (key === path[depth]) found = locate(depth + 1); else skip();
      whitespace(); if (text[cursor] === ',') { cursor += 1; whitespace(); }
    }
    cursor += 1; return found;
  };
  return locate(0);
};

/** Edit one graph literal, not a task override. Preserve its actual JSON type. */
export const updateVideoWorkflowInput = (text: string, binding: ComfyVideoInputBinding, nextText: string): string => {
  assertSafeVideoWorkflowJson(text);
  const previous = readVideoWorkflowInput(text, binding);
  let value: string | number | boolean;
  if (typeof previous === 'string') value = nextText;
  else if (typeof previous === 'number') {
    if (!nextText.trim()) throw new Error('数字参数不能为空；如需撤销修改，请恢复原值。');
    value = Number(nextText);
    if (!Number.isFinite(value)) throw new Error('请输入有效的有限数字。');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('数字超出安全整数范围，请在 ComfyUI 中核对原值，避免种子精度丢失。');
  } else if (typeof previous === 'boolean') {
    if (nextText !== 'true' && nextText !== 'false') throw new Error('布尔参数只能选择 true 或 false。');
    value = nextText === 'true';
  } else throw new Error('此字段不是文字、数字或布尔值；请在 JSON 页编辑，不能当作普通参数覆盖。');
  const document: Record<string, unknown> = JSON.parse(text);
  const path = [...(isRecord(document.prompt) ? ['prompt'] : []), binding.nodeId, 'inputs', binding.inputName];
  const span = jsonPropertyValueSpan(text, path);
  if (!span) throw new Error('无法定位实际输入字段；原 JSON 未改动。');
  const next = text.slice(0, span[0]) + JSON.stringify(value) + text.slice(span[1]);
  assertSafeVideoWorkflowJson(next);
  return next;
};

/** Invalid/incomplete mappings may be kept as an inactive draft, never activated. */
export const validateVideoWorkflowPreset = (workflow: ComfyVideoWorkflowPreset): string[] => {
  const issues: string[] = [];
  if (!workflow.name.trim()) issues.push('请填写工作流名称。');
  let nodes: ReturnType<typeof parseComfyVideoWorkflow>;
  try { assertSafeVideoWorkflowJson(workflow.workflowJson); nodes = parseComfyVideoWorkflow(workflow.workflowJson); }
  catch (cause) { return [...issues, cause instanceof Error ? cause.message : '工作流 JSON 无效。']; }
  if (!Object.keys(nodes).length) issues.push('工作流为空，请导入 ComfyUI API JSON。');
  if (!workflow.mapping.prompt.length) issues.push('请至少绑定一个提示词输入。');
  const check = (binding: ComfyVideoInputBinding, label: string) => {
    try {
      readVideoWorkflowInput(workflow.workflowJson, binding);
    } catch (cause) { issues.push(`${label}：${cause instanceof Error ? cause.message : '无效映射。'}`); }
  };
  workflow.mapping.prompt.forEach((binding, index) => check(binding, `提示词 ${index + 1}`));
  // An omitted output ID keeps the executor's supported automatic-output mode.
  if (workflow.mapping.outputNodeId && !own(nodes, workflow.mapping.outputNodeId)) issues.push(`找不到最终输出节点 ${workflow.mapping.outputNodeId}。`);
  return issues;
};

export const isVideoWorkflowReady = (workflow: ComfyVideoWorkflowPreset | undefined): boolean => Boolean(workflow && !validateVideoWorkflowPreset(workflow).length);

/** Optional slots are checked when actually used; don't block legacy rename/save. */
export const inspectVideoWorkflowWarnings = (workflow: ComfyVideoWorkflowPreset): string[] => {
  const warnings: string[] = [];
  const destinations = new Set(workflow.mapping.prompt.map((binding) => JSON.stringify([binding.nodeId, binding.inputName])));
  const check = (binding: ComfyVideoInputBinding, label: string) => {
    try {
      readVideoWorkflowInput(workflow.workflowJson, binding);
      const destination = JSON.stringify([binding.nodeId, binding.inputName]);
      if (destinations.has(destination)) warnings.push(`${label}：与其他映射使用同一字段，请核对是否会互相覆盖。`);
      destinations.add(destination);
    } catch (cause) { warnings.push(`${label}：${cause instanceof Error ? cause.message : '无效映射。'}`); }
  };
  workflow.mapping.images.forEach((binding, index) => check(binding, `可选图片槽 ${index + 1}`));
  Object.entries(workflow.mapping.parameters || {}).forEach(([name, binding]) => check(binding, `可选参数 ${name}`));
  return warnings;
};

export const uniqueVideoWorkflowName = (name: string, workflows: readonly ComfyVideoWorkflowPreset[]): string => {
  const base = name.trim() || '未命名视频工作流';
  const names = new Set(workflows.map((item) => item.name));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
};

export const createVideoWorkflowDraft = (workflows: readonly ComfyVideoWorkflowPreset[], now = Date.now()): ComfyVideoWorkflowPreset => ({
  id: newId(), name: uniqueVideoWorkflowName('新视频工作流', workflows), workflowJson: '{}',
  mapping: { prompt: [], images: [], parameters: {} }, createdAt: now, updatedAt: now,
});

export const importVideoWorkflowPreset = (source: string, name: string, workflows: readonly ComfyVideoWorkflowPreset[], now = Date.now()): ComfyVideoWorkflowPreset => {
  assertSafeVideoWorkflowJson(source);
  const imported = importComfyVideoWorkflow(source);
  return { ...imported, id: newId(), name: uniqueVideoWorkflowName(name.replace(/\.json$/iu, ''), workflows), createdAt: now, updatedAt: now };
};

export const copyVideoWorkflowPreset = (source: ComfyVideoWorkflowPreset, workflows: readonly ComfyVideoWorkflowPreset[], now = Date.now()): ComfyVideoWorkflowPreset => ({
  ...clone(source), id: newId(), name: uniqueVideoWorkflowName(`${source.name} · 副本`, workflows), createdAt: now, updatedAt: now,
});

export const saveVideoWorkflowPreset = (config: ComfyVideoConfig, draft: ComfyVideoWorkflowPreset, now = Date.now()): ComfyVideoConfig => {
  if (!draft.name.trim()) throw new Error('请填写工作流名称后再保存。');
  assertSafeVideoWorkflowJson(draft.workflowJson);
  const saved = { ...clone(draft), name: draft.name.trim(), updatedAt: now };
  const existing = config.workflows.find((item) => item.id === draft.id);
  if (existing && config.activeWorkflowId === draft.id && !isVideoWorkflowReady(saved)) {
    throw new Error('当前正在使用的工作流不能保存为未配置状态。请补全映射，或复制为新的草稿；原工作流未改动。');
  }
  return { ...config, workflows: existing ? config.workflows.map((item) => item.id === saved.id ? saved : item) : [...config.workflows, saved] };
};

export const activateVideoWorkflowPreset = (config: ComfyVideoConfig, id: string): ComfyVideoConfig => {
  const workflow = config.workflows.find((item) => item.id === id);
  if (!workflow) throw new Error('请先保存工作流，再设为当前。');
  const issues = validateVideoWorkflowPreset(workflow);
  if (issues.length) throw new Error(`工作流尚不能启用：${issues[0]}`);
  // Activation selects a workflow; it does not authorize network requests.
  return { ...config, activeWorkflowId: id };
};

export const videoWorkflowDeletionFallback = (config: ComfyVideoConfig, id: string): ComfyVideoWorkflowPreset | undefined => config.workflows.find((item) => item.id !== id && isVideoWorkflowReady(item));

export const deleteVideoWorkflowPreset = (config: ComfyVideoConfig, id: string): ComfyVideoConfig => {
  if (!config.workflows.some((item) => item.id === id)) return config;
  const workflows = config.workflows.filter((item) => item.id !== id);
  if (config.activeWorkflowId !== id) return { ...config, workflows };
  const fallback = videoWorkflowDeletionFallback(config, id);
  return { ...config, workflows, activeWorkflowId: fallback?.id || null, ...(fallback ? {} : { enabled: false }) };
};

/** Export only the API document, never the connection object or its key. */
export const exportVideoWorkflowJson = (workflow: ComfyVideoWorkflowPreset): string => {
  assertSafeVideoWorkflowJson(workflow.workflowJson);
  return workflow.workflowJson;
};

export const formatVideoWorkflowJson = (text: string): string => {
  assertSafeVideoWorkflowJson(text);
  const value: unknown = JSON.parse(text);
  const check = (part: unknown): void => {
    if (typeof part === 'number' && (!Number.isFinite(part) || (Number.isInteger(part) && !Number.isSafeInteger(part)))) {
      throw new Error('原文含超出安全精度的数字；为保留种子等原值，本次不格式化。仍可保存、导出原文或单独编辑参数。');
    }
    if (Array.isArray(part)) part.forEach(check);
    else if (isRecord(part)) Object.values(part).forEach(check);
  };
  check(value);
  return JSON.stringify(value, null, 2);
};
