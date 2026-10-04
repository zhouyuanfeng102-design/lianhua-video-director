import type { RunningHubVideoFieldControl, RunningHubVideoInputBinding, RunningHubVideoNodeCatalogEntry, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const keyOf = (node: { nodeId: string; fieldName: string }) => JSON.stringify([node.nodeId, node.fieldName]);
const scalar = (value: unknown): value is string | number | boolean => typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));

export const isRunningHubMegapixelsField = (name: string): boolean => /^(?:megapixels?|百万像素)$/u.test(name.toLowerCase().replace(/[\s_-]+/gu, ''));

/** Normalize only control metadata. This does not accept/reject task values. */
export const normalizeRunningHubVideoFieldControl = (value: unknown): RunningHubVideoFieldControl | undefined => {
  if (!record(value) || !['number', 'select', 'text'].includes(String(value.kind))) return undefined;
  const control: RunningHubVideoFieldControl = { kind: value.kind as RunningHubVideoFieldControl['kind'], ...(value.unit === 'MP' ? { unit: 'MP' as const } : {}) };
  if (control.kind === 'select') {
    if (!Array.isArray(value.options)) return undefined;
    const options = [...new Set(value.options.filter(scalar).map(String))];
    if (!options.length) return undefined;
    control.options = options;
    if (record(value.optionLabels)) {
      const labels = Object.fromEntries(options.flatMap((option) => {
        const label = value.optionLabels as Record<string, unknown>;
        return own(label, option) && typeof label[option] === 'string' && (label[option] as string).trim()
          ? [[option, label[option] as string]] : [];
      }));
      if (Object.keys(labels).length) control.optionLabels = labels;
    }
    if (typeof value.optionLabelAspectRatio === 'string' && value.optionLabelAspectRatio.trim()) control.optionLabelAspectRatio = value.optionLabelAspectRatio.trim();
  }
  if (control.kind === 'number' || control.kind === 'select') {
    for (const key of ['min', 'max', 'step'] as const) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && (key !== 'step' || candidate > 0)) control[key] = candidate;
    }
    if (control.min !== undefined && control.max !== undefined && control.min > control.max) { delete control.min; delete control.max; }
  }
  return control;
};

/** RunningHub publishes fieldData as JSON text such as ["FLOAT", {min,max,step}]. */
export const parseRunningHubVideoFieldData = (value: unknown): RunningHubVideoFieldControl | undefined => {
  let data = value;
  for (let attempt = 0; typeof data === 'string' && attempt < 3; attempt += 1) {
    try { data = JSON.parse(data); } catch { return undefined; }
  }
  if (!Array.isArray(data) || !data.length) return undefined;
  const details = record(data[1]) ? data[1] : {};
  const type = typeof data[0] === 'string' ? data[0].toUpperCase() : '';
  if (type === 'COMBO' || Array.isArray(data[0])) return normalizeRunningHubVideoFieldControl({ kind: 'select', options: Array.isArray(data[0]) ? data[0] : details.options });
  if (['FLOAT', 'NUMBER', 'INT', 'INTEGER'].includes(type)) {
    const bounds: Record<string, number> = {};
    for (const key of ['min', 'max', 'step'] as const) {
      const candidate = details[key];
      if (typeof candidate === 'number') bounds[key] = candidate;
      else if (typeof candidate === 'string' && /^\s*-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/iu.test(candidate)) bounds[key] = Number(candidate);
    }
    return normalizeRunningHubVideoFieldControl({ kind: 'number', ...bounds });
  }
  return type === 'STRING' || type === 'TEXT' ? { kind: 'text' } : undefined;
};

export const normalizeRunningHubVideoFieldControls = (value: unknown): Record<string, RunningHubVideoFieldControl> => {
  if (!record(value)) return {};
  const result: Record<string, RunningHubVideoFieldControl> = {};
  for (const [key, raw] of Object.entries(value)) {
    let identity: unknown;
    try { identity = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 2 || !identity.every((part) => typeof part === 'string' && part.trim()) || isRunningHubVideoSecretField(identity[1])) continue;
    const control = normalizeRunningHubVideoFieldControl(raw);
    if (control) result[JSON.stringify(identity)] = control;
  }
  return result;
};

/** Do not expose embedded service credentials as ordinary configurable inputs. */
export const isRunningHubVideoSecretField = (name: string): boolean => {
  const compact = name.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return /(?:apikey|authorization|accesstoken|authtoken|bearertoken|apitoken|clientsecret|password|secret)$/u.test(compact)
    || compact === 'token' || compact === 'credentials';
};

export const normalizeRunningHubVideoNodeCatalog = (value: unknown): RunningHubVideoNodeCatalogEntry[] => {
  if (!Array.isArray(value)) return [];
  const result: RunningHubVideoNodeCatalogEntry[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.nodeId !== 'string' || !item.nodeId.trim()
      || typeof item.fieldName !== 'string' || !item.fieldName.trim() || isRunningHubVideoSecretField(item.fieldName)
      || !scalar(item.fieldValue)) continue;
    const key = keyOf(item as unknown as RunningHubVideoNodeCatalogEntry);
    if (keys.has(key)) continue;
    keys.add(key);
    const control = normalizeRunningHubVideoFieldControl(item.control) ?? parseRunningHubVideoFieldData(item.fieldData);
    result.push({ nodeId: item.nodeId, fieldName: item.fieldName, fieldValue: item.fieldValue,
      ...(control ? { control } : {}),
      ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}) });
  }
  return result;
};

/** Existing defaults win: a refresh/import never rewrites a user's saved value. */
export const mergeRunningHubVideoNodeCatalog = (
  existing: RunningHubVideoNodeCatalogEntry[] | undefined,
  incoming: RunningHubVideoNodeCatalogEntry[],
): RunningHubVideoNodeCatalogEntry[] => {
  const result = normalizeRunningHubVideoNodeCatalog(existing || []);
  for (const node of normalizeRunningHubVideoNodeCatalog(incoming)) {
    const index = result.findIndex((entry) => keyOf(entry) === keyOf(node));
    if (index < 0) result.push(node);
    else result[index] = { ...result[index], ...(node.control ? { control: node.control } : {}),
      ...(!result[index].description && node.description ? { description: node.description } : {}) };
  }
  return result;
};

/** Request fields take precedence, including inspectable legacy complex values. */
export const listRunningHubVideoNodes = (
  requestTemplate: string,
  catalog: RunningHubVideoNodeCatalogEntry[] | undefined,
): RunningHubVideoNodeInfo[] => {
  let raw: unknown;
  try { raw = JSON.parse(requestTemplate); } catch { /* A damaged draft must not hide the separately saved catalogue. */ }
  const nodes = record(raw) && Array.isArray(raw.nodeInfoList) ? raw.nodeInfoList : [];
  const result: RunningHubVideoNodeInfo[] = [];
  const normalizedCatalog = normalizeRunningHubVideoNodeCatalog(catalog);
  const catalogByKey = new Map(normalizedCatalog.map((node) => [keyOf(node), node]));
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!record(node) || typeof node.nodeId !== 'string' || typeof node.fieldName !== 'string' || !own(node, 'fieldValue')) continue;
    const control = catalogByKey.get(keyOf(node as RunningHubVideoNodeInfo))?.control
      ?? normalizeRunningHubVideoFieldControl(node.control) ?? parseRunningHubVideoFieldData(node.fieldData);
    result.push({ ...node, ...(control ? { control } : {}) } as RunningHubVideoNodeInfo);
    seen.add(keyOf(node as RunningHubVideoNodeInfo));
  }
  for (const node of normalizedCatalog) {
    if (!seen.has(keyOf(node))) result.push({ ...node });
  }
  return result;
};

/** Resolve the bound field, without changing its value or guessing a numeric range. */
export const resolveRunningHubVideoFieldControl = (
  workflow: RunningHubVideoWorkflow, binding: RunningHubVideoInputBinding,
): { control: RunningHubVideoFieldControl; defaultValue: string | number | boolean } | undefined => {
  const nodes = listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog);
  const node = nodes.find((item) => item.nodeId === binding.nodeId && item.fieldName === binding.inputName);
  if (!node || !scalar(node.fieldValue)) return undefined;
  const explicit = normalizeRunningHubVideoFieldControl(workflow.fieldControls?.[keyOf(node)]);
  const cloud = normalizeRunningHubVideoFieldControl(node.control);
  const control: RunningHubVideoFieldControl = explicit ?? cloud ?? { kind: isRunningHubMegapixelsField(node.fieldName) || typeof node.fieldValue === 'number' ? 'number' : 'text' };
  const resolved = { ...control, ...(!explicit && isRunningHubMegapixelsField(node.fieldName) ? { unit: 'MP' as const } : {}) };
  if (resolved.optionLabels && resolved.optionLabelAspectRatio) {
    // A label is only factual for its configured ratio on the same cloud node.
    // Accept the provider's optional display suffix, never derive another size.
    const ratio = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const match = value.trim().match(/^(\d+)\s*:\s*(\d+)(?=\s|\(|$)/u);
      return match ? `${match[1]}:${match[2]}` : undefined;
    };
    const aspect = nodes.find((item) => item.nodeId === node.nodeId && item.fieldName.toLowerCase().replace(/[\s_-]+/gu, '') === 'aspectratio');
    const expected = ratio(resolved.optionLabelAspectRatio);
    if (!expected || ratio(aspect?.fieldValue) !== expected) delete resolved.optionLabels;
  }
  return { control: resolved, defaultValue: node.fieldValue };
};

type Path = Array<string | number>;
interface Token { start: number; end: number; kind: 'string' | 'number' | 'other' }

/** Scan the validated source instead of losing 64-bit IDs/seeds through JSON.parse. */
const sourceTokens = (source: string): Map<string, Token> => {
  const tokens = new Map<string, Token>();
  let cursor = 0;
  const ws = () => { while (/\s/u.test(source[cursor] || '') && cursor < source.length) cursor += 1; };
  const readString = () => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === '\\') cursor += 2;
      else if (source[cursor++] === '"') break;
    }
    return JSON.parse(source.slice(start, cursor)) as string;
  };
  const visit = (path: Path) => {
    ws();
    const start = cursor;
    const pathKey = JSON.stringify(path);
    if (tokens.has(pathKey)) throw new Error(`节点 JSON 的字段 ${path.join('.')} 重复，无法确定真实值，请先消除重复字段。`);
    const token: Token = { start, end: start, kind: 'other' };
    tokens.set(pathKey, token);
    if (source[cursor] === '"') { token.kind = 'string'; readString(); }
    else if (source[cursor] === '{' || source[cursor] === '[') {
      const object = source[cursor++] === '{';
      const close = object ? '}' : ']';
      let index = 0;
      ws();
      while (source[cursor] !== close && cursor < source.length) {
        const key = object ? readString() : index++;
        ws(); if (object) { cursor += 1; ws(); }
        visit([...path, key]); ws();
        if (source[cursor] !== ',') break;
        cursor += 1; ws();
      }
      cursor += 1;
    } else {
      token.kind = /[-0-9]/u.test(source[cursor]) ? 'number' : 'other';
      while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1;
    }
    token.end = cursor;
  };
  visit([]);
  return tokens;
};

export interface RunningHubVideoNodesResult { nodes: RunningHubVideoNodeCatalogEntry[]; warnings: string[] }

/** Read real API fields only; canvas widget positions and semantic roles are never guessed. */
export const parseRunningHubVideoNodes = (source: string): RunningHubVideoNodesResult => {
  const nodes: RunningHubVideoNodeCatalogEntry[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();
  let skippedComplex = 0;
  let skippedSecrets = 0;
  const parseDocument = (input: string, depth = 0): void => {
    if (depth > 6) throw new Error('节点 JSON 嵌套过深，请导出实际 API 节点图或 nodeInfoList。');
    let text = input.trim().replace(/^\uFEFF/u, '');
    const fence = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/iu);
    if (fence) text = fence[1].trim();
    let document: unknown;
    try { document = JSON.parse(text); } catch { throw new Error('节点内容不是有效 JSON；请导入 API 格式工作流或包含 nodeInfoList 的节点列表。'); }
    const tokens = sourceTokens(text);
    const rawToken = (path: Path) => { const token = tokens.get(JSON.stringify(path)); return token ? text.slice(token.start, token.end) : ''; };
    const exactId = (value: unknown, path: Path): string => typeof value === 'string' ? value
      : typeof value === 'number' && /^\d+$/u.test(rawToken(path)) ? rawToken(path) : '';
    const add = (nodeId: string, fieldName: string, value: unknown, path: Path, description?: unknown, control?: RunningHubVideoFieldControl) => {
      if (!nodeId.trim() || !fieldName.trim()) throw new Error('节点列表包含空 nodeId 或 fieldName，请核对真实节点定义。');
      if (isRunningHubVideoSecretField(fieldName)) { skippedSecrets += 1; return; }
      let fieldValue = value;
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        // Preserve the exact literal in a string; never silently publish its rounded JS value.
        fieldValue = rawToken(path);
        warnings.push(`节点 ${nodeId}.${fieldName} 的数字超出安全范围，已按原始数字文本保存；绑定前请核对云端字段类型。`);
      }
      if (!scalar(fieldValue)) { skippedComplex += 1; return; }
      const key = keyOf({ nodeId, fieldName });
      if (keys.has(key)) throw new Error(`节点字段 ${nodeId}.${fieldName} 重复，请保留唯一的真实字段。`);
      keys.add(key);
      nodes.push({ nodeId, fieldName, fieldValue, ...(control ? { control } : {}), ...(typeof description === 'string' && description ? { description } : {}) });
    };
    const visit = (value: unknown, path: Path): void => {
      if (typeof value === 'string') { parseDocument(value, depth + 1); return; }
      if (record(value) && Array.isArray(value.nodeInfoList)) { visit(value.nodeInfoList, [...path, 'nodeInfoList']); return; }
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (!record(item) || typeof item.fieldName !== 'string' || !own(item, 'fieldValue')) throw new Error(`节点列表第 ${index + 1} 项缺少 nodeId、fieldName 或 fieldValue。`);
          add(exactId(item.nodeId, [...path, index, 'nodeId']), item.fieldName, item.fieldValue, [...path, index, 'fieldValue'],
            typeof item.description === 'string' && item.description ? item.description : item.nodeName,
            normalizeRunningHubVideoFieldControl(item.control) ?? parseRunningHubVideoFieldData(item.fieldData));
        });
        return;
      }
      if (!record(value)) throw new Error('未找到 API 工作流或 RunningHub 节点列表。');
      // Node IDs may themselves be `data` or `prompt`; recognize a real API graph before envelopes.
      const entries = Object.entries(value);
      const graph = entries.length > 0 && entries.every(([, node]) => record(node) && typeof node.class_type === 'string' && record(node.inputs));
      if (graph) {
        for (const [nodeId, rawNode] of entries) {
          const node = rawNode as { class_type: string; inputs: Record<string, unknown>; _meta?: unknown };
          const description = record(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : node.class_type;
          for (const [fieldName, value] of Object.entries(node.inputs)) add(nodeId, fieldName, value, [...path, nodeId, 'inputs', fieldName], description);
        }
        return;
      }
      if (own(value, 'data') && (record(value.data) || typeof value.data === 'string' || Array.isArray(value.data))) { visit(value.data, [...path, 'data']); return; }
      if (own(value, 'prompt') && (record(value.prompt) || typeof value.prompt === 'string')) { visit(value.prompt, [...path, 'prompt']); return; }
      if (Array.isArray(value.nodes) || Array.isArray(value.links)) throw new Error('这是普通 ComfyUI 画布，无法可靠判断 widgets 的字段名；请导出 API 格式工作流，或手动添加已知 nodeId 与 fieldName。');
      throw new Error('未找到真实 API 节点的 class_type / inputs 或 nodeInfoList，不能猜测节点参数。');
    };
    visit(document, []);
  };
  parseDocument(source);
  if (skippedComplex) warnings.push(`已跳过 ${skippedComplex} 个节点连线、数组、对象或空值；只读取有实际默认值的文本、数字与布尔输入。`);
  if (skippedSecrets) warnings.push(`已排除 ${skippedSecrets} 个密钥 / 认证字段，不会将凭据保存进节点目录。`);
  if (!nodes.length) warnings.push('没有可绑定的标量节点字段；空 nodeInfoList 不包含节点定义，请读取云端节点、导入 API 工作流或手动添加真实字段。');
  return { nodes, warnings: [...new Set(warnings)] };
};
