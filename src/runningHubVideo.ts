import type { AppSettings, ReferenceRole, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import type {
  RunningHubVideoConfig, RunningHubVideoImportResult, RunningHubVideoInputBinding,
  RunningHubVideoMapping, RunningHubVideoNodeInfo, RunningHubVideoRequest, RunningHubVideoWorkflow,
} from './runningHubVideoTypes';
import { normalizeRunningHubVideoFieldControls, normalizeRunningHubVideoNodeCatalog, resolveRunningHubVideoFieldControl } from './runningHubVideoNodes';
import { assertVideoReferenceSlots, videoReferenceSlotIndex } from './videoReferenceSlots';
import { resolveRunningHubVideoImageProtocol } from './runningHubImageProtocol';
import { assertRunningHubPromptPictureSlots, isRunningHubH3AutoPromptInput, runningHubH3AutoPromptInput } from './runningHubPromptPictures';
import { normalizeRunningHubGenerationExtras } from './runningHubGenerationExtras';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const clone = <T,>(value: T): T => structuredClone(value);
const makeId = (): string => `runninghub-video-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const secretName = /^(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|api[_-]?token|client[_-]?secret|secret|password)$/iu;
const roles = new Set<ReferenceRole>(['subject', 'character', 'scene', 'prop', 'style', 'motion', 'composition', 'camera', 'first-frame', 'last-frame', 'audio', 'dialogue', 'clay-render', 'creative', 'general', 'unknown']);
const emptyRequest = '{\n  "nodeInfoList": [],\n  "instanceType": "default",\n  "usePersonalQueue": false\n}';

export const defaultRunningHubVideoConfig: RunningHubVideoConfig = {
  enabled: false, baseUrl: 'https://www.runninghub.ai', apiKey: '', workflows: [], activeWorkflowId: null,
};

type JsonPath = Array<string | number>;
interface JsonSpan { path: JsonPath; start: number; end: number; keyStart?: number; delimiterBefore?: number; delimiterAfter?: number; kind: 'string' | 'number' | 'object' | 'array' | 'literal' }

/** Scan already-validated JSON, retaining exact source spans for one-field edits. */
const jsonSpans = (text: string): JsonSpan[] => {
  try { JSON.parse(text); } catch { throw new Error('RunningHub 请求不是有效 JSON。'); }
  const spans: JsonSpan[] = [];
  let cursor = 0;
  const ws = () => { while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) { if (text[cursor] === '\\') cursor += 2; else if (text[cursor++] === '"') break; }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const visit = (path: JsonPath, keyStart?: number, delimiterBefore?: number): JsonSpan => {
    ws(); const start = cursor;
    const span: JsonSpan = { path, start, end: start, keyStart, delimiterBefore, kind: 'literal' };
    spans.push(span);
    if (text[cursor] === '"') { span.kind = 'string'; string(); }
    else if (text[cursor] === '{' || text[cursor] === '[') {
      const object = text[cursor++] === '{'; span.kind = object ? 'object' : 'array';
      const closing = object ? '}' : ']'; let index = 0; let preceding: number | undefined;
      ws();
      while (text[cursor] !== closing) {
        ws(); const propertyStart = cursor;
        const key = object ? string() : index++; ws(); if (object) { cursor += 1; ws(); }
        const child = visit([...path, key], object ? propertyStart : undefined, preceding); ws();
        if (text[cursor] === ',') { child.delimiterAfter = cursor; preceding = cursor++; ws(); }
        else break;
      }
      cursor += 1;
    } else {
      span.kind = /[-0-9]/u.test(text[cursor]) ? 'number' : 'literal';
      while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor])) cursor += 1;
    }
    span.end = cursor; return span;
  };
  visit([]); return spans;
};
const atPath = (text: string, path: JsonPath): JsonSpan | undefined => jsonSpans(text).filter((span) => JSON.stringify(span.path) === JSON.stringify(path)).pop();
const replaceSpans = (text: string, replacements: Array<{ start: number; end: number; text: string }>): string => {
  // Callers replace leaf values only. Descending offsets preserve every unrelated byte.
  return [...replacements].sort((a, b) => b.start - a.start).reduce((current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end), text);
};
const replacePath = (text: string, path: JsonPath, value: unknown): string => {
  const span = atPath(text, path); if (!span) throw new Error(`找不到请求字段 ${path.join('.')}。`);
  return replaceSpans(text, [{ ...span, text: JSON.stringify(value) }]);
};

/** A JS number cannot represent a 64-bit integer. Never silently round a cloud ID/seed. */
const assertSafeNumbers = (text: string): void => {
  for (const span of jsonSpans(text).filter((item) => item.kind === 'number')) {
    const value = Number(text.slice(span.start, span.end));
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`请求字段 ${span.path.join('.')} 的裸数字超出安全范围；请按该工作流文档将长 ID / 种子写成带引号的字符串，原值未修改。`);
    }
  }
};

export const readRunningHubVideoRequest = (text: string): RunningHubVideoRequest => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('RunningHub 请求不是有效 JSON。'); }
  if (!isRecord(raw) || !Array.isArray(raw.nodeInfoList)) throw new Error('RunningHub v2 请求必须是包含 nodeInfoList 数组的 JSON 对象，不是本地 ComfyUI 的 API 节点图。');
  return raw as RunningHubVideoRequest;
};

const redactRequest = (text: string): { text: string; warnings: string[] } => {
  const raw = readRunningHubVideoRequest(text);
  const spans = jsonSpans(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const warnings: string[] = [];
  const sensitivePaths: JsonPath[] = [];
  const visit = (value: unknown, path: JsonPath) => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...path, index])); return; }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (secretName.test(key) && child != null && child !== '' && child !== false) sensitivePaths.push([...path, key]);
      else visit(child, [...path, key]);
    }
  };
  visit(raw, []);
  // JSON.parse keeps only the final duplicate property. Inspect raw properties
  // too so an earlier credential cannot hide behind a later empty duplicate.
  spans.forEach((span) => {
    if (typeof span.path[span.path.length - 1] !== 'string' || !secretName.test(String(span.path[span.path.length - 1]))) return;
    const value: unknown = JSON.parse(text.slice(span.start, span.end));
    if (value != null && value !== '' && value !== false) sensitivePaths.push(span.path);
  });
  raw.nodeInfoList.forEach((node, index) => {
    if (isRecord(node) && typeof node.fieldName === 'string' && secretName.test(node.fieldName) && node.fieldValue != null && node.fieldValue !== '') {
      sensitivePaths.push(['nodeInfoList', index, 'fieldValue']);
    }
  });
  spans.filter((span) => span.path[span.path.length - 1] === 'fieldName' && span.kind === 'string').forEach((span) => {
    const fieldName: string = JSON.parse(text.slice(span.start, span.end));
    if (secretName.test(fieldName)) sensitivePaths.push([...span.path.slice(0, -1), 'fieldValue']);
  });
  const unique = new Set<string>();
  for (const path of sensitivePaths) {
    const key = JSON.stringify(path); if (unique.has(key)) continue; unique.add(key);
    const matches = spans.filter((item) => JSON.stringify(item.path) === key);
    if (!sensitivePaths.some((ancestor) => ancestor.length < path.length && ancestor.every((part, index) => part === path[index]))) matches.forEach((span) => edits.push({ ...span, text: '""' }));
  }
  if (edits.length) warnings.push('已剥离请求内的密钥 / 认证值；请只在连接设置的 API 密钥栏填写，模板和导出文件不会保存这些凭据。');
  return { text: replaceSpans(text, edits), warnings };
};

const normalizeRequestOptions = (text: string): string => {
  const raw = readRunningHubVideoRequest(text);
  if (raw.usePersonalQueue === 'false' || raw.usePersonalQueue === 'true') text = replacePath(text, ['usePersonalQueue'], raw.usePersonalQueue === 'true');
  return text;
};
const normalizeBinding = (raw: unknown): RunningHubVideoInputBinding | undefined => {
  if (!isRecord(raw)) return undefined;
  return { nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : Number.isSafeInteger(raw.nodeId) ? String(raw.nodeId) : '', inputName: typeof raw.inputName === 'string' ? raw.inputName : typeof raw.fieldName === 'string' ? raw.fieldName : '' };
};
const normalizeMapping = (raw: unknown): RunningHubVideoMapping => {
  const value = isRecord(raw) ? raw : {};
  const prompt = Array.isArray(value.prompt) ? value.prompt.map(normalizeBinding).filter((item): item is RunningHubVideoInputBinding => Boolean(item)) : [];
  const images = Array.isArray(value.images) ? value.images.flatMap((item) => {
    const binding = normalizeBinding(item); if (!binding) return [];
    const role = isRecord(item) && typeof item.role === 'string' && roles.has(item.role as ReferenceRole) ? item.role as ReferenceRole : undefined;
    return [{ ...binding, ...(role ? { role } : {}) }];
  }) : [];
  const audios = Array.isArray(value.audios) ? value.audios.flatMap((item) => {
    const binding = normalizeBinding(item); if (!binding) return [];
    const label = isRecord(item) && typeof item.label === 'string' ? item.label.trim() : '';
    return [{ ...binding, ...(label ? { label } : {}) }];
  }) : undefined;
  const parameters: Record<string, RunningHubVideoInputBinding> = {};
  if (isRecord(value.parameters)) for (const [key, item] of Object.entries(value.parameters)) {
    const binding = normalizeBinding(item); if (binding) Object.defineProperty(parameters, key, { value: binding, enumerable: true, configurable: true, writable: true });
  }
  const imageCount = value.imageCount === null ? null : normalizeBinding(value.imageCount);
  return { prompt, images, ...(audios !== undefined ? { audios } : {}), ...(imageCount !== undefined ? { imageCount } : {}), ...(Object.keys(parameters).length ? { parameters } : {}) };
};

export const createRunningHubVideoWorkflow = (name = '新建云端工作流'): RunningHubVideoWorkflow => {
  const now = Date.now();
  return { id: makeId(), name, runKind: 'ai-app', remoteId: '', requestTemplate: emptyRequest, mapping: { prompt: [], images: [] }, createdAt: now, updatedAt: now };
};
const normalizeWorkflow = (raw: unknown): RunningHubVideoWorkflow | undefined => {
  if (!isRecord(raw)) return undefined;
  const fresh = createRunningHubVideoWorkflow();
  let requestTemplate = typeof raw.requestTemplate === 'string' ? raw.requestTemplate : emptyRequest;
  try { requestTemplate = normalizeRequestOptions(redactRequest(requestTemplate).text); } catch { /* Keep damaged legacy drafts inspectable, but never activate/compile/export them. */ }
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : fresh.id,
    name: typeof raw.name === 'string' ? raw.name : fresh.name,
    runKind: raw.runKind === 'workflow' ? 'workflow' : 'ai-app',
    remoteId: typeof raw.remoteId === 'string' ? raw.remoteId : Number.isSafeInteger(raw.remoteId) ? String(raw.remoteId) : '',
    requestTemplate, mapping: normalizeMapping(raw.mapping),
    ...(Array.isArray(raw.nodeCatalog) ? { nodeCatalog: normalizeRunningHubVideoNodeCatalog(raw.nodeCatalog) } : {}),
    ...(isRecord(raw.fieldControls) ? { fieldControls: normalizeRunningHubVideoFieldControls(raw.fieldControls) } : {}),
    ...(isRecord(raw.generationExtras) ? { generationExtras: normalizeRunningHubGenerationExtras(raw.generationExtras) } : {}),
    ...(typeof raw.outputNodeId === 'string' && raw.outputNodeId.trim() ? { outputNodeId: raw.outputNodeId.trim() } : {}),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : fresh.createdAt,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : fresh.updatedAt,
  };
};
export const normalizeRunningHubVideoConfig = (raw: unknown): RunningHubVideoConfig => {
  if (!isRecord(raw)) return clone(defaultRunningHubVideoConfig);
  const seen = new Set<string>();
  const workflows = Array.isArray(raw.workflows) ? raw.workflows.flatMap((item) => {
    const workflow = normalizeWorkflow(item); if (!workflow) return [];
    if (seen.has(workflow.id)) workflow.id = makeId(); seen.add(workflow.id); return [workflow];
  }) : [];
  const activeWorkflowId = typeof raw.activeWorkflowId === 'string' && workflows.some((item) => item.id === raw.activeWorkflowId) ? raw.activeWorkflowId : null;
  return {
    enabled: raw.enabled === true, baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : defaultRunningHubVideoConfig.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '', workflows, activeWorkflowId,
  };
};

const nodeIndex = (text: string, binding: RunningHubVideoInputBinding): number => {
  const nodes = readRunningHubVideoRequest(text).nodeInfoList;
  const matches = nodes.flatMap((node, index) => isRecord(node) && node.nodeId === binding.nodeId && node.fieldName === binding.inputName ? [index] : []);
  if (!binding.nodeId.trim() || !binding.inputName.trim() || matches.length !== 1) throw new Error(matches.length > 1 ? `节点字段 ${binding.nodeId}.${binding.inputName} 在 nodeInfoList 中重复，请先消除歧义。` : `nodeInfoList 中找不到 ${binding.nodeId || '未选节点'}.${binding.inputName || '未选字段'}。`);
  if (!own(nodes[matches[0]], 'fieldValue')) throw new Error(`节点字段 ${binding.nodeId}.${binding.inputName} 缺少 fieldValue。`);
  return matches[0];
};

/** Add only an explicitly selected scalar input; existing request values remain authoritative. */
export const ensureRunningHubVideoRequestNode = (text: string, node: RunningHubVideoNodeInfo): string => {
  const request = readRunningHubVideoRequest(text);
  if (typeof node.nodeId !== 'string' || !node.nodeId.trim() || typeof node.fieldName !== 'string' || !node.fieldName.trim()) {
    throw new Error('请填写真实的 nodeId 与 fieldName，不能添加空节点字段。');
  }
  const matches = request.nodeInfoList.filter((item) => isRecord(item) && item.nodeId === node.nodeId && item.fieldName === node.fieldName);
  if (matches.length > 1) throw new Error(`节点字段 ${node.nodeId}.${node.fieldName} 在请求中重复，请先消除歧义。`);
  if (matches.length === 1) return text;
  const safe = normalizeRunningHubVideoNodeCatalog([node])[0];
  if (!safe) throw new Error(`不能新增 ${node.nodeId}.${node.fieldName}：只接受文本、有限安全数字或布尔字段，不接收连线、复杂值或密钥字段。`);
  const spans = jsonSpans(text).filter((span) => span.path.length === 1 && span.path[0] === 'nodeInfoList');
  if (spans.length !== 1 || spans[0].kind !== 'array') throw new Error('请求中的 nodeInfoList 不唯一或不是数组，请先修复 JSON 结构。');
  const at = spans[0].end - 1;
  const { control: _control, fieldType: _fieldType, classType: _classType, audioUpload: _audioUpload, ...requestNode } = safe;
  return text.slice(0, at) + `${request.nodeInfoList.length ? ',' : ''}\n    ${JSON.stringify(requestNode)}\n  ` + text.slice(at);
};

export const updateRunningHubVideoRequestField = (text: string, name: string, value: unknown | undefined): string => {
  const allowed = ['instanceType', 'usePersonalQueue', 'retainSeconds', 'webhookUrl'];
  if (!allowed.includes(name)) throw new Error('此快捷编辑只支持云端运行参数；请在请求 JSON 中编辑其他字段。');
  const request = readRunningHubVideoRequest(text);
  const span = atPath(text, [name]);
  if (value === undefined) {
    if (!span) return text;
    const start = span.delimiterAfter !== undefined ? span.keyStart! : span.delimiterBefore ?? span.keyStart!;
    const end = span.delimiterAfter !== undefined ? span.delimiterAfter + 1 : span.end;
    return text.slice(0, start) + text.slice(end);
  }
  if (name === 'usePersonalQueue' && typeof value !== 'boolean') throw new Error('个人队列必须使用 true / false 布尔值。');
  if (name === 'retainSeconds' && (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 180)) throw new Error('实例保留时长必须是 10–180 秒的整数；不设置可避免额外保留费用。');
  if (name === 'instanceType' && (typeof value !== 'string' || !['default', 'plus', 'ultra'].includes(value))) throw new Error('实例规格请选择 default、plus 或 ultra。');
  if (name === 'webhookUrl' && typeof value !== 'string') throw new Error('Webhook 地址必须是字符串。');
  if (span) return replacePath(text, [name], value);
  const root = atPath(text, []); if (!root) throw new Error('无法定位请求 JSON 对象。');
  const at = root.end - 1;
  return text.slice(0, at) + `${Object.keys(request).length ? ',' : ''}\n  ${JSON.stringify(name)}: ${JSON.stringify(value)}\n` + text.slice(at);
};

export const coerceRunningHubVideoNodeValue = (original: unknown, next: unknown, label: string): string | number | boolean => {
  if (typeof next === 'number' && (!Number.isFinite(next) || (Number.isInteger(next) && !Number.isSafeInteger(next)))) throw new Error(`${label} 数字无效或超出安全整数范围；长数请按接口文档使用字符串。`);
  if (typeof original === 'string') {
    if (typeof next === 'string' || typeof next === 'boolean' || (typeof next === 'number' && Number.isFinite(next))) return String(next);
    throw new Error(`${label} 是字符串参数，请输入文本或简单数值。`);
  }
  if (typeof original === 'boolean') {
    if (next === true || next === 'true') return true;
    if (next === false || next === 'false') return false;
    throw new Error(`${label} 是布尔参数，只接受 true / false。`);
  }
  if (typeof original === 'number') {
    if ((typeof next !== 'number' && typeof next !== 'string') || (typeof next === 'string' && !next.trim())) throw new Error(`${label} 需要有效数字。`);
    const number = Number(next);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) throw new Error(`${label} 数字无效或超出安全整数范围，原值未修改。`);
    return number;
  }
  throw new Error(`${label} 不是字符串、数字或布尔常量；不覆盖数组、对象或节点连线。`);
};
export const updateRunningHubVideoNodeValue = (text: string, binding: RunningHubVideoInputBinding, nextText: string): string => {
  const index = nodeIndex(text, binding);
  const original = readRunningHubVideoRequest(text).nodeInfoList[index].fieldValue;
  const value = coerceRunningHubVideoNodeValue(original, nextText, `${binding.nodeId}.${binding.inputName}`);
  return replacePath(text, ['nodeInfoList', index, 'fieldValue'], value);
};

export const validateRunningHubVideoWorkflow = (workflow: RunningHubVideoWorkflow): string[] => {
  const issues: string[] = [];
  if (!workflow.name.trim()) issues.push('请填写工作流名称。');
  if (workflow.runKind !== 'ai-app' && workflow.runKind !== 'workflow') issues.push('请选择 AI 应用或 ComfyUI 工作流。');
  if (!/^\d+$/u.test(workflow.remoteId.trim())) issues.push('请填写 RunningHub 文档中的完整数字 ID（按文本保存，不要填写任务 ID）。');
  let raw: RunningHubVideoRequest;
  try {
    raw = readRunningHubVideoRequest(workflow.requestTemplate);
    assertSafeNumbers(workflow.requestTemplate);
    if (redactRequest(workflow.requestTemplate).warnings.length) issues.push('请求中含有内嵌凭据；请删除，并只在连接的密钥栏填写。');
    const paths = new Set<string>();
    for (const span of jsonSpans(workflow.requestTemplate)) {
      const path = JSON.stringify(span.path);
      if (paths.has(path)) issues.push(`请求 JSON 字段 ${span.path.join('.')} 重复，需消除歧义后使用。`);
      paths.add(path);
    }
  } catch (cause) { return [...issues, cause instanceof Error ? cause.message : '请求 JSON 无效。']; }
  if (!raw.nodeInfoList.length) issues.push('nodeInfoList 为空：请读取云端节点、导入节点 JSON 或手动添加真实字段，再绑定提示词；空请求示例不含节点定义。');
  const seenNodes = new Set<string>();
  raw.nodeInfoList.forEach((node, index) => {
    if (!isRecord(node) || typeof node.nodeId !== 'string' || !node.nodeId.trim() || typeof node.fieldName !== 'string' || !node.fieldName.trim() || !own(node, 'fieldValue')) { issues.push(`nodeInfoList 第 ${index + 1} 项需要文本 nodeId、fieldName 和 fieldValue。`); return; }
    const key = JSON.stringify([node.nodeId, node.fieldName]);
    if (seenNodes.has(key)) issues.push(`nodeInfoList 节点字段 ${node.nodeId}.${node.fieldName} 重复。`); seenNodes.add(key);
  });
  if (!workflow.mapping.prompt.length) issues.push('请明确绑定至少一个提示词节点；导入不会擅自猜测节点用途。');
  const assigned = new Set<string>();
  const check = (binding: RunningHubVideoInputBinding, kind: 'prompt' | 'image' | 'audio' | 'image-count' | 'parameter', label: string) => {
    try {
      const index = nodeIndex(workflow.requestTemplate, binding); const value = raw.nodeInfoList[index].fieldValue;
      const key = JSON.stringify([binding.nodeId, binding.inputName]);
      if (assigned.has(key)) issues.push(`${label} 与其他用途绑定了同一个节点字段，请明确唯一用途。`); assigned.add(key);
      if ((kind === 'prompt' || kind === 'image' || kind === 'audio') && typeof value !== 'string') issues.push(`${label} 必须映射文本字段，不能覆盖数值、数组或节点连线。`);
      if (kind === 'parameter' && !['string', 'number', 'boolean'].includes(typeof value)) issues.push(`${label} 不是可覆盖的简单常量。`);
      if (kind === 'image-count' && !((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && /^\d+$/u.test(value.trim()) && Number.isSafeInteger(Number(value))))) issues.push(`${label} 必须绑定非负整数或整数字符串字段。`);
    } catch (cause) { issues.push(`${label}：${cause instanceof Error ? cause.message : '无效映射。'}`); }
  };
  workflow.mapping.prompt.forEach((binding, index) => check(binding, 'prompt', `提示词 ${index + 1}`));
  workflow.mapping.images.forEach((binding, index) => check(binding, 'image', `参考图 ${index + 1}`));
  (workflow.mapping.audios || []).forEach((binding, index) => check(binding, 'audio', `参考音频 ${index + 1}`));
  for (const [name, binding] of Object.entries(workflow.mapping.parameters || {})) {
    if (!name.trim() || ['prompt', 'images', 'audios', 'audioReferences', 'references', 'first_image', 'last_image', 'model', 'parameters'].includes(name) || /^(?:image|audio)_\d+$/u.test(name)) issues.push(`参数名称 ${name || '（空）'} 与系统字段冲突。`);
    check(binding, 'parameter', `参数 ${name}`);
  }
  const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
  if (imageCount) check(imageCount, 'image-count', '实际图片数量');
  if (raw.usePersonalQueue !== undefined && typeof raw.usePersonalQueue !== 'boolean') issues.push('usePersonalQueue 必须是布尔值 true / false，不能是字符串。');
  if (raw.instanceType !== undefined && (typeof raw.instanceType !== 'string' || !['default', 'plus', 'ultra'].includes(raw.instanceType))) issues.push('instanceType 应为 default、plus 或 ultra。');
  if (raw.retainSeconds !== undefined && (!Number.isInteger(raw.retainSeconds) || Number(raw.retainSeconds) < 10 || Number(raw.retainSeconds) > 180)) issues.push('retainSeconds 必须是 10–180 的整数；不使用时请删除该字段。');
  if (raw.webhookUrl !== undefined && raw.webhookUrl !== '') {
    try { const url = new URL(String(raw.webhookUrl)); if (!/^https?:$/u.test(url.protocol) || url.username || url.password) throw new Error(); }
    catch { issues.push('Webhook 需要有效的 HTTP(S) 地址，不能内嵌账户密码。'); }
  }
  return [...new Set(issues)];
};
export const isRunningHubVideoWorkflowReady = (workflow: RunningHubVideoWorkflow | undefined): boolean => Boolean(workflow && validateRunningHubVideoWorkflow(workflow).length === 0);

export const copyRunningHubVideoWorkflow = (workflow: RunningHubVideoWorkflow, name = `${workflow.name} 副本`): RunningHubVideoWorkflow => {
  const now = Date.now(); return { ...clone(workflow), id: makeId(), name, createdAt: now, updatedAt: now };
};
export const saveRunningHubVideoWorkflow = (config: RunningHubVideoConfig, workflow: RunningHubVideoWorkflow): RunningHubVideoConfig => {
  // Inactive drafts may lack IDs/mappings, but credentials/invalid JSON are not a saved template format.
  readRunningHubVideoRequest(workflow.requestTemplate);
  const clean = redactRequest(workflow.requestTemplate);
  if (clean.warnings.length) throw new Error('请求 JSON 含有内嵌密钥；请删除，并仅填写在连接密钥栏。');
  const saved = { ...clone(workflow), requestTemplate: normalizeRequestOptions(workflow.requestTemplate),
    ...(workflow.nodeCatalog !== undefined ? { nodeCatalog: normalizeRunningHubVideoNodeCatalog(workflow.nodeCatalog) } : {}),
    ...(workflow.fieldControls !== undefined ? { fieldControls: normalizeRunningHubVideoFieldControls(workflow.fieldControls) } : {}),
    ...(workflow.generationExtras !== undefined ? { generationExtras: normalizeRunningHubGenerationExtras(workflow.generationExtras) } : {}), updatedAt: Date.now() };
  if (config.activeWorkflowId === workflow.id && !isRunningHubVideoWorkflowReady(saved)) throw new Error('当前正在使用的工作流不能保存为无效配置；请先修正映射，或复制为未启用草稿。');
  const exists = config.workflows.some((item) => item.id === workflow.id);
  return { ...config, workflows: exists ? config.workflows.map((item) => item.id === workflow.id ? saved : item) : [...config.workflows, saved] };
};
export const deleteRunningHubVideoWorkflow = (config: RunningHubVideoConfig, workflowId: string): RunningHubVideoConfig => {
  const workflows = config.workflows.filter((item) => item.id !== workflowId);
  if (config.activeWorkflowId !== workflowId) return { ...config, workflows };
  const next = workflows.find(isRunningHubVideoWorkflowReady);
  return { ...config, workflows, activeWorkflowId: next?.id || null, enabled: next ? config.enabled : false };
};
export const setActiveRunningHubVideoWorkflow = (config: RunningHubVideoConfig, workflowId: string | null): RunningHubVideoConfig => {
  if (workflowId === null) return { ...config, activeWorkflowId: null, enabled: false };
  const workflow = config.workflows.find((item) => item.id === workflowId);
  if (!workflow) throw new Error('该 RunningHub 工作流已不存在，请重新选择。');
  const issues = validateRunningHubVideoWorkflow(workflow); if (issues.length) throw new Error(issues.join('\n'));
  return { ...config, activeWorkflowId: workflowId };
};

/** Tokenize a copied cURL command as data. Nothing here evaluates or executes shell syntax. */
const curlTokens = (source: string): string[] => {
  const text = source.replace(/\\\r?\n/gu, '').replace(/`\r?\n/gu, '').replace(/\^\r?\n/gu, '');
  const tokens: string[] = []; let current = ''; let quote: "'" | '"' | undefined; let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (quote === '"' && char === '\\' && /["\\$`]/u.test(text[index + 1] || '')) { current += text[++index]; continue; }
      current += char; continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/u.test(char)) { if (started) { tokens.push(current); current = ''; started = false; } continue; }
    if (/[;|&<>`]/u.test(char)) throw new Error('只支持单条 cURL 请求示例；不会执行命令、管道、重定向或脚本。');
    if (char === '\\' && index + 1 < text.length) { current += text[++index]; started = true; continue; }
    current += char; started = true;
  }
  if (quote) throw new Error('cURL 示例引号没有闭合，请完整复制 --data-raw JSON。');
  if (started) tokens.push(current); return tokens;
};
const readCurl = (text: string): { body: string; url: string; warnings: string[] } => {
  const tokens = curlTokens(text); if (!/^curl(?:\.exe)?$/iu.test(tokens[0] || '')) throw new Error('请粘贴请求 JSON 或单条 curl 请求示例。');
  let body = ''; let url = ''; const warnings: string[] = []; let method = 'POST';
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['--location', '-L', '--silent', '-s', '--show-error', '-S', '--compressed'].includes(token)) continue;
    if (['--request', '-X'].includes(token)) { method = tokens[++index] || ''; continue; }
    if (['--header', '-H'].includes(token)) {
      const header = tokens[++index] || '';
      if (/^(?:authorization|x-api-key|api-key)\s*:/iu.test(header)) warnings.push('已忽略 cURL 的认证头；密钥请单独填写，不会导入或导出。');
      continue;
    }
    if (['--data-raw', '--data', '--data-binary', '-d'].includes(token)) {
      if (body) throw new Error('cURL 示例包含多个请求体，请只保留一次 JSON 数据。');
      body = tokens[++index] || ''; if (body.trim().startsWith('@')) throw new Error('不会读取 cURL 引用的本地文件；请直接粘贴 JSON 内容。'); continue;
    }
    if (token === '--url') { if (url) throw new Error('只允许一条 RunningHub 提交地址。'); url = tokens[++index] || ''; continue; }
    if (/^https?:\/\//iu.test(token)) { if (url) throw new Error('只允许一条 RunningHub 提交地址。'); url = token; continue; }
    throw new Error('cURL 包含不支持的参数或附加内容；请只复制 URL、认证头和 JSON 请求体，不会执行脚本。');
  }
  if (method.toUpperCase() !== 'POST' || !body || !url) throw new Error('需要包含 POST 提交地址与 JSON 请求体的 RunningHub cURL 示例。');
  return { body, url, warnings };
};
const readRunUrl = (urlText: string): { runKind: 'ai-app' | 'workflow'; remoteId: string; baseUrl: string } => {
  let url: URL; try { url = new URL(urlText); } catch { throw new Error('RunningHub 提交地址不是有效 URL。'); }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('提交地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) URL。');
  const match = url.pathname.match(/^(.*)\/openapi\/v2\/run\/(ai-app|workflow)\/(\d+)\/?$/u);
  if (!match) throw new Error('请复制 RunningHub v2 的 /run/ai-app/ID 或 /run/workflow/ID 提交示例，不是查询 / 上传接口。');
  return { runKind: match[2] as 'ai-app' | 'workflow', remoteId: match[3], baseUrl: url.origin + match[1] };
};
const exactId = (text: string, path: JsonPath, value: unknown): string => {
  if (typeof value === 'string') return value;
  const span = atPath(text, path); const token = span ? text.slice(span.start, span.end) : '';
  return /^\d+$/u.test(token) ? token : '';
};

export const importRunningHubVideoWorkflow = (input: string, name?: string): RunningHubVideoImportResult => {
  let text = input.trim().replace(/^\uFEFF/u, '');
  const fence = text.match(/```(?:curl|bash|shell|json)?\s*\r?\n([\s\S]*?)```/iu); if (fence) text = fence[1].trim();
  const warnings: string[] = []; let endpoint: ReturnType<typeof readRunUrl> | undefined;
  if (/^curl(?:\.exe)?\s/iu.test(text)) { const curl = readCurl(text); endpoint = readRunUrl(curl.url); warnings.push(...curl.warnings); text = curl.body; }
  let document: unknown; try { document = JSON.parse(text); } catch { throw new Error('无法读取 RunningHub 请求 JSON；请完整复制 nodeInfoList 请求体或 cURL。'); }
  let workflow = createRunningHubVideoWorkflow(name || '导入的云端工作流');
  if (isRecord(document) && document.format === 'lianhua-runninghub-video-workflow') {
    if (document.version !== 1 || !isRecord(document.workflow)) throw new Error('不支持此 RunningHub 工作流备份版本。');
    const imported = normalizeWorkflow(document.workflow); if (!imported) throw new Error('工作流备份内容无效。');
    workflow = { ...imported, id: workflow.id, name: name || imported.name, createdAt: workflow.createdAt, updatedAt: workflow.updatedAt };
    workflow.remoteId = exactId(text, ['workflow', 'remoteId'], document.workflow.remoteId);
    text = typeof document.workflow.requestTemplate === 'string' ? document.workflow.requestTemplate : emptyRequest;
  } else if (Array.isArray(document)) text = `{\n  "nodeInfoList": ${text}\n}`;
  else if (isRecord(document)) {
    if (!Array.isArray(document.nodeInfoList)) throw new Error('请导入云端 API 文档的 nodeInfoList 请求体；普通 ComfyUI API 节点图不是 RunningHub 请求配置。');
    if (!endpoint) {
      if (typeof document.endpoint === 'string' && /\/openapi\/v2\/run\//u.test(document.endpoint)) endpoint = readRunUrl(document.endpoint);
      else if (typeof document.remoteId === 'string' || typeof document.remoteId === 'number') {
        workflow.remoteId = exactId(text, ['remoteId'], document.remoteId); workflow.runKind = document.runKind === 'workflow' ? 'workflow' : 'ai-app';
      } else if (own(document, 'workflowId')) { workflow.remoteId = exactId(text, ['workflowId'], document.workflowId); workflow.runKind = 'workflow'; }
      else if (own(document, 'webappId') || own(document, 'appId')) { const key = own(document, 'webappId') ? 'webappId' : 'appId'; workflow.remoteId = exactId(text, [key], document[key]); }
    }
  } else throw new Error('请导入 JSON 对象或 nodeInfoList 数组。');
  const sanitized = redactRequest(text); text = normalizeRequestOptions(sanitized.text); warnings.push(...sanitized.warnings);
  // Node IDs are identifiers, not arithmetic values. Convert only their exact source token.
  const request = readRunningHubVideoRequest(text);
  const idEdits: Array<{ start: number; end: number; text: string }> = [];
  for (const key of ['remoteId', 'workflowId', 'webappId', 'appId']) {
    if (typeof request[key] !== 'number') continue;
    const span = atPath(text, [key]); const rawId = span ? text.slice(span.start, span.end) : '';
    if (span && /^\d+$/u.test(rawId)) idEdits.push({ ...span, text: JSON.stringify(rawId) });
  }
  request.nodeInfoList.forEach((node, index) => {
    if (!isRecord(node) || typeof node.nodeId !== 'number') return;
    const span = atPath(text, ['nodeInfoList', index, 'nodeId']);
    const rawId = span ? text.slice(span.start, span.end) : '';
    if (span && /^\d+$/u.test(rawId)) idEdits.push({ ...span, text: JSON.stringify(rawId) });
  });
  text = replaceSpans(text, idEdits);
  workflow = { ...workflow, requestTemplate: text, ...(endpoint ? { runKind: endpoint.runKind, remoteId: endpoint.remoteId } : {}) };
  if (!workflow.remoteId.trim()) warnings.push('请求体没有提交地址 / 云端 ID，已保存为待配置草稿；请从该工作流 API 文档填写 ID。');
  if (!workflow.mapping.prompt.length) warnings.push('导入没有自动猜测提示词或参考图节点；请在映射页明确选择后再启用。');
  try { assertSafeNumbers(text); } catch (cause) { warnings.push(cause instanceof Error ? cause.message : '请求含有非安全数字，需核对后使用。'); }
  return { workflow, warnings: [...new Set(warnings)], ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}) };
};

export const exportRunningHubVideoWorkflow = (workflow: RunningHubVideoWorkflow): string => {
  const sanitized = redactRequest(workflow.requestTemplate);
  const safeWorkflow = normalizeWorkflow(workflow)!;
  return JSON.stringify({ format: 'lianhua-runninghub-video-workflow', version: 1, workflow: { ...safeWorkflow, requestTemplate: normalizeRequestOptions(sanitized.text) } }, null, 2);
};

export const createRunningHubTutorialVideoWorkflow = (): RunningHubVideoWorkflow => {
  const workflow = createRunningHubVideoWorkflow('教程示例 · MiniMax H3 云端工作流（可修改）');
  return {
    ...workflow, remoteId: '2084261333662810113',
    requestTemplate: JSON.stringify({ nodeInfoList: [
      { nodeId: '137', fieldName: 'image', fieldValue: '{{image_1}}', description: null },
      { nodeId: '160', fieldName: 'value', fieldValue: 'false', description: null },
      { nodeId: '164', fieldName: 'audio', fieldValue: 'None', description: null },
      { nodeId: '115', fieldName: 'aspect_ratio', fieldValue: '9:16 (Portrait Widescreen)', description: null },
      { nodeId: '132', fieldName: 'value', fieldValue: '12', description: null },
      { nodeId: '115', fieldName: 'megapixels', fieldValue: '0.6000000000000001', description: null },
      { nodeId: '156', fieldName: 'lora_name', fieldValue: 'MysticXXX_MMH3-V1.safetensors', description: null },
      { nodeId: '168', fieldName: 'audio', fieldValue: 'None', description: null },
      { nodeId: '156', fieldName: 'strength_model', fieldValue: '0', description: null },
      { nodeId: '138', fieldName: 'value', fieldValue: '{{prompt}}', description: null },
    ], instanceType: 'default', usePersonalQueue: false }, null, 2),
    mapping: { prompt: [{ nodeId: '138', inputName: 'value' }], images: [{ nodeId: '137', inputName: 'image', role: 'general' }], parameters: { duration: { nodeId: '132', inputName: 'value' } } },
  };
};

export const compileRunningHubVideoApi = (config: RunningHubVideoConfig, workflowId?: string, parameters: Record<string, unknown> = {}): VideoTaskApiConfig => {
  const id = workflowId ?? config.activeWorkflowId;
  if (!id) throw new Error('请先选择当前 RunningHub 云端工作流。');
  const workflow = config.workflows.find((item) => item.id === id);
  if (!workflow) throw new Error('已选 RunningHub 工作流不存在；不会改用另一个工作流，请重新选择。');
  const issues = validateRunningHubVideoWorkflow(workflow); if (issues.length) throw new Error(issues.join('\n'));
  const unmapped = Object.keys(parameters).filter((name) => parameters[name] !== undefined && !own(workflow.mapping.parameters || {}, name));
  if (unmapped.length) throw new Error(`RunningHub 参数 ${unmapped.join('、')} 尚未绑定节点字段；请在工作流参数映射中绑定，或清空这些覆盖值，不会默默忽略。`);
  let base: URL; try { base = new URL(config.baseUrl.trim()); } catch { throw new Error('请填写有效的 RunningHub 云端 API 地址。'); }
  if (!/^https?:$/u.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('RunningHub 地址必须是无内嵌凭据的 HTTP(S) 基础地址。');
  const baseUrl = base.toString().replace(/\/+$/u, '');
  let requestTemplate = workflow.requestTemplate;
  const imageProtocol = resolveRunningHubVideoImageProtocol(workflow);
  const runningHubMappedFields: NonNullable<VideoTaskApiConfig['runningHubMappedFields']> = [
    ...workflow.mapping.prompt.map((binding) => ({ nodeId: binding.nodeId, fieldName: binding.inputName, kind: 'prompt' as const })),
    ...workflow.mapping.images.map((binding, imageIndex) => ({ nodeId: binding.nodeId, fieldName: binding.inputName, kind: 'image' as const, imageIndex, emptyValue: imageProtocol.emptyImageValues[imageIndex] })),
    ...(workflow.mapping.audios || []).map((binding, audioIndex) => ({ nodeId: binding.nodeId, fieldName: binding.inputName, kind: 'audio' as const, audioIndex,
      originalValue: clone(readRunningHubVideoRequest(requestTemplate).nodeInfoList[nodeIndex(requestTemplate, binding)].fieldValue) })),
    ...(imageProtocol.imageCount ? [{ nodeId: imageProtocol.imageCount.nodeId, fieldName: imageProtocol.imageCount.inputName, kind: 'image-count' as const,
      imageCountSource: imageProtocol.imageCountSource,
      ...(imageProtocol.imageCountMode ? { imageCountMode: imageProtocol.imageCountMode } : {}),
      originalValue: clone(readRunningHubVideoRequest(requestTemplate).nodeInfoList[nodeIndex(requestTemplate, imageProtocol.imageCount)].fieldValue) }] : []),
    ...Object.entries(workflow.mapping.parameters || {}).map(([parameter, binding]) => ({
      nodeId: binding.nodeId, fieldName: binding.inputName, kind: 'parameter' as const, parameter,
      originalValue: clone(readRunningHubVideoRequest(requestTemplate).nodeInfoList[nodeIndex(requestTemplate, binding)].fieldValue),
    })),
  ];
  const replaceBinding = (binding: RunningHubVideoInputBinding, value: unknown) => { const index = nodeIndex(requestTemplate, binding); requestTemplate = replacePath(requestTemplate, ['nodeInfoList', index, 'fieldValue'], value); };
  workflow.mapping.prompt.forEach((binding) => replaceBinding(binding, '{{prompt}}'));
  workflow.mapping.images.forEach((binding, index) => replaceBinding(binding, `{{image_${index + 1}}}`));
  for (const [name, binding] of Object.entries(workflow.mapping.parameters || {})) {
    if (!own(parameters, name) || parameters[name] === undefined) continue;
    const index = nodeIndex(requestTemplate, binding);
    const original = readRunningHubVideoRequest(requestTemplate).nodeInfoList[index].fieldValue;
    replaceBinding(binding, coerceRunningHubVideoNodeValue(original, parameters[name], `参数 ${name}`));
  }
  // Resolve contextual labels after explicit task overrides (including ratio).
  // Controls remain local snapshot metadata and never enter requestTemplate.
  const runningHubParameterControls = Object.fromEntries(Object.entries(workflow.mapping.parameters || {}).flatMap(([parameter, binding]) => {
    const resolved = resolveRunningHubVideoFieldControl({ ...workflow, requestTemplate }, binding);
    return resolved ? [[parameter, resolved.control]] : [];
  }));
  return {
    enabled: config.enabled, provider: 'runninghub', model: workflow.name,
    endpoint: `${baseUrl}/openapi/v2/run/${workflow.runKind}/${workflow.remoteId.trim()}`,
    runningHubAppId: workflow.remoteId.trim(), runningHubOutputNodeIds: workflow.outputNodeId?.trim() ? [workflow.outputNodeId.trim()] : [],
    runningHubImageRoles: workflow.mapping.images.map((binding) => binding.role || 'general'), runningHubMappedFields,
    ...(Object.keys(runningHubParameterControls).length ? { runningHubParameterControls } : {}),
    statusEndpointTemplate: `${baseUrl}/openapi/v2/query`, apiKey: config.apiKey,
    authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url', errorPath: 'errorMessage',
    imageUploadEndpoint: `${baseUrl}/openapi/v2/media/upload/binary`, imageUploadField: 'file', imageUploadUrlPath: 'data.fileName', requestTemplate,
  };
};

/** Execute only mappings frozen during compilation. Other strings/values are opaque. */
export const bindRunningHubVideoRequest = (
  template: string,
  mappedFields: NonNullable<VideoTaskApiConfig['runningHubMappedFields']>,
  draft: Pick<VideoGenerationDraft, 'prompt' | 'parameters'> & Partial<Pick<VideoGenerationDraft, 'references' | 'audioReferences'>>,
  images: string[],
  submitContext?: Pick<VideoTaskApiConfig, 'provider' | 'runningHubAppId' | 'endpoint'>,
  audios: string[] = [],
): Record<string, unknown> => {
  assertSafeNumbers(template);
  if (draft.references) {
    if (draft.references.length !== images.length) throw new Error('参考图数量与 RunningHub 上传结果数量不一致；不会丢图或改变槽位。');
    assertVideoReferenceSlots(draft.references);
  }
  const uploadBySlot = new Map<number, { image: string; index: number }>();
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (typeof image !== 'string' || !image.trim()) throw new Error(`RunningHub 第 ${index + 1} 张已选参考图未取得可用上传结果，请重试该图片上传。`);
    uploadBySlot.set(draft.references ? videoReferenceSlotIndex(draft.references[index], index) : index, { image, index });
  }
  const audioReferences = draft.audioReferences || [];
  if (audioReferences.length !== audios.length) throw new Error('参考音频数量与 RunningHub 上传结果数量不一致；不会丢弃音频或改变槽位。');
  const audioBySlot = new Map<number, { audio: string; index: number; bindingId: string }>();
  audioReferences.forEach((reference, index) => {
    if (!Number.isSafeInteger(reference.slotIndex) || reference.slotIndex < 0 || audioBySlot.has(reference.slotIndex)) throw new Error('参考音频槽位无效或重复，请重新选择。');
    const audio = audios[index];
    if (typeof audio !== 'string' || !audio.trim()) throw new Error(`RunningHub 第 ${index + 1} 条已选参考音频未取得可用上传结果，请重试该音频上传。`);
    audioBySlot.set(reference.slotIndex, { audio, index, bindingId: reference.bindingId });
  });
  const request = readRunningHubVideoRequest(template);
  const submittedPrompt = submitContext && isRunningHubH3AutoPromptInput({ ...submitContext, runningHubMappedFields: mappedFields })
    ? runningHubH3AutoPromptInput(draft.prompt, uploadBySlot.size) : draft.prompt;
  const parameterNames = new Set(mappedFields.filter((field) => field.kind === 'parameter' && field.parameter).map((field) => field.parameter!));
  const unmapped = Object.keys(draft.parameters).filter((name) => draft.parameters[name] !== undefined && !parameterNames.has(name));
  if (unmapped.length) throw new Error(`RunningHub 参数 ${unmapped.join('、')} 尚未绑定节点字段；请配置明确映射或清空这些覆盖值。`);
  const assigned = new Set<string>(); let prompts = 0;
  const consumedImages = new Set<number>();
  const consumedAudios = new Set<number>();
  const imageIndices = new Set<number>();
  const audioIndices = new Set<number>();
  let imageCounts = 0;
  for (const field of mappedFields) {
    const binding = { nodeId: field.nodeId, inputName: field.fieldName };
    const index = nodeIndex(template, binding);
    const key = JSON.stringify([field.nodeId, field.fieldName]);
    if (assigned.has(key)) throw new Error(`RunningHub 字段 ${field.nodeId}.${field.fieldName} 被重复绑定。`); assigned.add(key);
    const node = request.nodeInfoList[index];
    if (field.kind === 'prompt') {
      if (typeof node.fieldValue !== 'string') throw new Error('RunningHub 提示词映射只能替换文本字段。');
      node.fieldValue = submittedPrompt; prompts += 1;
    } else if (field.kind === 'image') {
      const imageIndex = field.imageIndex;
      if (typeof node.fieldValue !== 'string' || !Number.isSafeInteger(imageIndex) || imageIndex! < 0) throw new Error(`RunningHub 图片字段 ${field.nodeId}.${field.fieldName} 的槽位映射无效，请核对工作流配置。`);
      if (imageIndices.has(imageIndex!)) throw new Error(`RunningHub 第 ${imageIndex! + 1} 个图片槽索引重复绑定了不同字段，请核对工作流映射；不会重复补图。`);
      imageIndices.add(imageIndex!);
      const uploaded = uploadBySlot.get(imageIndex!);
      if (uploaded) {
        node.fieldValue = uploaded.image; consumedImages.add(uploaded.index);
      } else {
        // Keep the node in the request. Verified RunningHub AI apps restore
        // their declared placeholder (example.png) when the web UI cancels a
        // slot; literal None/'' can reach BatchImagesNode as a None tensor.
        // Only known safe sentinels from compiled metadata are accepted; old
        // or hand-edited snapshots fall back to the legacy empty string.
        node.fieldValue = field.emptyValue === 'None' || field.emptyValue === 'example.png' ? field.emptyValue : '';
      }
    } else if (field.kind === 'audio') {
      const audioIndex = field.audioIndex;
      if (typeof node.fieldValue !== 'string' || !Number.isSafeInteger(audioIndex) || audioIndex! < 0) throw new Error(`RunningHub 音频字段 ${field.nodeId}.${field.fieldName} 的槽位映射无效，请核对工作流配置。`);
      if (audioIndices.has(audioIndex!)) throw new Error(`RunningHub 第 ${audioIndex! + 1} 个音频槽索引重复绑定，请核对工作流映射。`);
      audioIndices.add(audioIndex!);
      const uploaded = audioBySlot.get(audioIndex!);
      if (uploaded) {
        if (uploaded.bindingId !== key) throw new Error(`参考音频槽 ${audioIndex! + 1} 的节点字段已变化，请重新选择；不会把声音填入其他节点。`);
        node.fieldValue = uploaded.audio; consumedAudios.add(uploaded.index);
      }
      // No selected audio: keep the original compiled value, including "None"
      // and empty strings. Audio slots do not use the image empty-slot protocol.
    } else if (field.kind === 'image-count') {
      if (++imageCounts > 1) throw new Error('RunningHub 实际图片数量只能绑定一个字段，请核对工作流映射。');
      if (field.imageCountMode === 'prefix' && [...uploadBySlot.keys()].some((slot) => slot >= images.length)) {
        throw new Error(`为保证该 RunningHub 应用按图片数量读取到全部参考图，请从图片槽 1 起连续选择 ${images.length} 个槽位，中间不要留空；不会自动移动图片或改变提示词中的图片编号。`);
      }
      const original = field.originalValue;
      if (!((typeof original === 'number' && Number.isSafeInteger(original) && original >= 0)
        || (typeof original === 'string' && /^\d+$/u.test(original.trim()) && Number.isSafeInteger(Number(original))))) throw new Error('RunningHub 实际图片数量映射缺少有效的整数原值，请重新选择工作流。');
      node.fieldValue = coerceRunningHubVideoNodeValue(original, images.length, '实际图片数量');
    } else if (field.kind === 'parameter') {
      if (!field.parameter) throw new Error('RunningHub 参数映射缺少参数名称。');
      const value = own(draft.parameters, field.parameter) && draft.parameters[field.parameter] !== undefined ? draft.parameters[field.parameter] : field.originalValue;
      node.fieldValue = coerceRunningHubVideoNodeValue(field.originalValue, value, `参数 ${field.parameter}`);
    } else throw new Error('RunningHub 映射用途无法识别，请重新选择工作流。');
  }
  if (!prompts) throw new Error('RunningHub 工作流未明确绑定提示词字段。');
  if (consumedImages.size !== images.length) throw new Error('参考图数量与 RunningHub 工作流的明确图槽不一致；不会静默丢弃图片。');
  if (consumedAudios.size !== audios.length) throw new Error('参考音频与 RunningHub 工作流的明确音频槽不一致；不会静默丢弃音频。');
  assertRunningHubPromptPictureSlots(mappedFields, submittedPrompt, [...uploadBySlot.keys()]);
  return request;
};

/** Both independent libraries retain their identity; a deleted selection must never silently fall back. */
export const resolveConfiguredVideoApi = (settings: AppSettings, draft: Pick<VideoGenerationDraft, 'runningHubWorkflowId' | 'apiProfileId' | 'parameters'>): VideoTaskApiConfig => {
  if (draft.runningHubWorkflowId !== undefined) return compileRunningHubVideoApi(settings.runningHubVideo || clone(defaultRunningHubVideoConfig), draft.runningHubWorkflowId, draft.parameters);
  if (draft.apiProfileId) {
    const profile = settings.videoApiProfiles?.find((item) => item.id === draft.apiProfileId);
    if (!profile) throw new Error('已选视频 API 连接不存在，请重新选择；不会改用其他连接。');
    return clone(profile);
  }
  return clone(settings.videoTaskApi);
};
