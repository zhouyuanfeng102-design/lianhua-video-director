type JsonObject = Record<string, unknown>;

interface CanvasInput extends JsonObject {
  name: string;
}

interface CanvasNode extends JsonObject {
  id: string | number;
  type: string;
  inputs?: unknown[];
  outputs?: unknown[];
}

interface CanvasLink {
  id: string;
  originId: string;
  originSlot: number;
  targetId: string;
  targetSlot: number;
}

type ResolvedInput = { connection: [string, number] } | { value: unknown } | undefined;

const isObject = (value: unknown): value is JsonObject => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const identifier = (value: unknown): string => (
  typeof value === 'string' && value.trim() ? value
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
);
const slotNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
);
const normalizedType = (value: unknown): string => String(value || '').toLowerCase().replace(/[\s_-]+/gu, '');
const cloneValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const widgetValue = (value: unknown): unknown => (
  Array.isArray(value) ? { __value__: cloneValue(value) } : cloneValue(value)
);
const nodeError = (node: CanvasNode, detail: string): Error => new Error(
  `ComfyUI 画布节点 ${node.id}（${node.type}）${detail}。请从 ComfyUI 导出 API 格式 JSON 后导入。`,
);

const FRONTEND_ONLY_TYPES = new Set([
  'note', 'markdownnote', 'fastgroupsmuter(rgthree)', 'fastgroupsbypasser(rgthree)',
  'fastmuter(rgthree)', 'fastbypasser(rgthree)',
]);
const CONTROL_MODES = new Set(['fixed', 'increment', 'decrement', 'randomize']);
const FRONTEND_WIDGET_NAMES = new Set(['upload', 'control_after_generate']);

/** Only known stock layouts may use positional values. Custom-node widgets can
 * contain extra buttons or value controls at arbitrary positions; their
 * widgets_values_named plus input.widget declarations are authoritative. */
const STOCK_WIDGET_LAYOUTS: Record<string, readonly (readonly string[])[]> = {
  CheckpointLoaderSimple: [['ckpt_name']],
  VAELoader: [['vae_name']],
  UNETLoader: [['unet_name', 'weight_dtype']],
  CLIPLoader: [['clip_name', 'type'], ['clip_name', 'type', 'device']],
  DualCLIPLoader: [['clip_name1', 'clip_name2', 'type'], ['clip_name1', 'clip_name2', 'type', 'device']],
  CLIPTextEncode: [['text']],
  CLIPTextEncodeSDXL: [['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l']],
  CLIPTextEncodeSDXLRefiner: [['ascore', 'width', 'height', 'text']],
  EmptyLatentImage: [['width', 'height', 'batch_size']],
  EmptySD3LatentImage: [['width', 'height', 'batch_size']],
  EmptyFlux2LatentImage: [['width', 'height', 'batch_size']],
  KSampler: [
    ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  ],
  KSamplerAdvanced: [
    ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
    ['add_noise', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  ],
  LoraLoader: [['lora_name', 'strength_model', 'strength_clip']],
  LoraLoaderModelOnly: [['lora_name', 'strength_model']],
  LoadImage: [['image'], ['image', 'upload']],
  SaveImage: [['filename_prefix']],
  PreviewImage: [[]],
  VAEEncode: [[]],
  VAEDecode: [[]],
};

const inputEntries = (node: CanvasNode): CanvasInput[] => {
  if (node.inputs !== undefined && !Array.isArray(node.inputs)) throw nodeError(node, '的 inputs 不是数组');
  return (node.inputs || []).map((input) => {
    if (!isObject(input) || typeof input.name !== 'string' || !input.name && normalizedType(node.type) !== 'reroute') {
      throw nodeError(node, '含有无法识别名称的输入');
    }
    return input as CanvasInput;
  });
};

const widgetInputName = (input: CanvasInput, node: CanvasNode): string => {
  if (input.widget === undefined || input.widget === null) return '';
  if (!isObject(input.widget) || typeof input.widget.name !== 'string' || !input.widget.name) {
    throw nodeError(node, `的输入「${input.name}」缺少可靠的 widget 名称`);
  }
  if (input.widget.name !== input.name) {
    throw nodeError(node, `的输入「${input.name}」与 widget 名称不一致`);
  }
  return input.widget.name;
};

const isFrontendWidget = (input: CanvasInput): boolean => (
  FRONTEND_WIDGET_NAMES.has(input.name)
  || normalizedType(input.type) === 'button'
  || isObject(input.widget) && normalizedType(input.widget.type) === 'button'
);

const apiWidgetInputs = (node: CanvasNode, inputs: CanvasInput[]): JsonObject => {
  const layouts = own(STOCK_WIDGET_LAYOUTS, node.type) ? STOCK_WIDGET_LAYOUTS[node.type] : undefined;
  const declared = inputs.filter((input) => !isFrontendWidget(input))
    .map((input) => widgetInputName(input, node)).filter(Boolean);
  const stockNames = layouts ? [...new Set(layouts.flat())] : [];
  const names = [...new Set([...declared, ...stockNames])].filter((name) => !FRONTEND_WIDGET_NAMES.has(name));
  const values = node.widgets_values;
  const named = isObject(node.widgets_values_named) ? node.widgets_values_named : null;
  if (node.widgets_values_named !== undefined && !named) throw nodeError(node, '的 widgets_values_named 不是对象');
  if (!layouts && !declared.length && (named && Object.keys(named).length || Array.isArray(values) && values.length)) {
    throw nodeError(node, '缺少能确认参数名称的 input.widget 映射');
  }
  const linkedNames = new Set(inputs.filter((input) => input.link !== null && input.link !== undefined).map((input) => input.name));
  const requiredNames = names.filter((name) => !linkedNames.has(name)
    && (declared.includes(name) || !layouts || layouts.every((layout) => layout.includes(name))));
  let positional: JsonObject | null = null;
  if (requiredNames.some((name) => !named || !own(named, name))) {
    if (!layouts || !Array.isArray(values)) {
      throw nodeError(node, '缺少命名参数，无法安全按位置还原 widgets_values');
    }
    const layout = layouts.find((candidate) => candidate.length === values.length);
    if (!layout || declared.some((name) => !layout.includes(name))) {
      throw nodeError(node, '的 widgets_values 与已知标准参数布局不匹配');
    }
    positional = Object.fromEntries(layout.map((name, index) => [name, values[index]]));
    if (own(positional, 'control_after_generate') && !CONTROL_MODES.has(String(positional.control_after_generate))) {
      throw nodeError(node, '的 Seed 控制字段不符合标准布局');
    }
  }
  const result: JsonObject = Object.create(null) as JsonObject;
  for (const name of names) {
    if (linkedNames.has(name)) continue;
    const source = named && own(named, name) ? named : positional;
    if (!source || !own(source, name)) {
      // Stock node versions may have added an optional widget such as device.
      if (!declared.includes(name) && layouts?.some((layout) => !layout.includes(name))) continue;
      throw nodeError(node, `缺少参数「${name}」的可靠值`);
    }
    const value = source[name];
    if (value === null || value === undefined) throw nodeError(node, `的参数「${name}」为空，无法确认其执行值`);
    result[name] = widgetValue(value);
  }
  return result;
};

export const isComfyUICanvasWorkflow = (value: unknown): value is JsonObject => (
  isObject(value) && (Array.isArray(value.nodes) || Array.isArray(value.links))
);

/** Converts persisted canvas data, never executing custom frontend code or
 * submitting the workflow. Unknown positional widget layouts fail explicitly. */
export const convertComfyUICanvasWorkflow = (canvas: JsonObject): JsonObject => {
  if (!Array.isArray(canvas.nodes)) throw new Error('ComfyUI 画布 JSON 缺少 nodes 数组。');
  if (canvas.links !== undefined && !Array.isArray(canvas.links)) throw new Error('ComfyUI 画布 JSON 的 links 必须是数组。');
  const nodes = new Map<string, CanvasNode>();
  for (const raw of canvas.nodes) {
    if (!isObject(raw) || !identifier(raw.id) || typeof raw.type !== 'string' || !raw.type.trim()) {
      throw new Error('ComfyUI 画布 JSON 含有缺少 id 或 type 的节点。');
    }
    const node = raw as CanvasNode;
    const id = identifier(node.id);
    if (nodes.has(id)) throw nodeError(node, '的 id 重复');
    if (node.mode !== undefined && ![0, 2, 4].includes(Number(node.mode))) {
      throw nodeError(node, `使用了不能安全转换的运行模式 ${String(node.mode)}`);
    }
    nodes.set(id, node);
  }
  const subgraphs = isObject(canvas.definitions) && Array.isArray(canvas.definitions.subgraphs)
    ? canvas.definitions.subgraphs : [];
  const subgraphIds = new Set(subgraphs.filter(isObject).map((graph) => identifier(graph.id)));
  for (const node of nodes.values()) {
    if (subgraphIds.has(node.type) && Number(node.mode || 0) === 0) throw nodeError(node, '包含需要 ComfyUI 前端展开的子图');
  }
  const links = new Map<string, CanvasLink>();
  for (const raw of canvas.links || []) {
    const fields = Array.isArray(raw) ? raw : isObject(raw)
      ? [raw.id, raw.origin_id, raw.origin_slot, raw.target_id, raw.target_slot] : [];
    const [rawId, rawOrigin, originSlot, rawTarget, targetSlot] = fields;
    const id = identifier(rawId);
    const originId = identifier(rawOrigin);
    const targetId = identifier(rawTarget);
    if (!id || !originId || !targetId || !slotNumber(originSlot) || !slotNumber(targetSlot)) {
      throw new Error(`ComfyUI 画布链接 ${id || '未知'} 的节点或插槽信息无效。`);
    }
    if (links.has(id)) throw new Error(`ComfyUI 画布链接 ${id} 重复。`);
    links.set(id, { id, originId, originSlot, targetId, targetSlot });
  }
  const getLink = (node: CanvasNode, input: CanvasInput, index: number): CanvasLink | undefined => {
    if (input.link === null || input.link === undefined) return undefined;
    const link = links.get(identifier(input.link));
    if (!link || link.targetId !== identifier(node.id) || link.targetSlot !== index) {
      throw nodeError(node, `的输入「${input.name}」引用了缺失或不匹配的链接 ${String(input.link)}`);
    }
    return link;
  };
  const resolve = (sourceId: string, sourceSlot: number, visited: Set<string>): ResolvedInput => {
    const node = nodes.get(sourceId);
    if (!node) throw new Error(`ComfyUI 画布链接引用了不存在的节点 ${sourceId}。`);
    if (Number(node.mode || 0) === 2) return undefined;
    const type = normalizedType(node.type);
    if (FRONTEND_ONLY_TYPES.has(type)) return undefined;
    const key = `${sourceId}:${sourceSlot}`;
    if (visited.has(key)) throw nodeError(node, '的旁路或转接链接存在循环');
    const nextVisited = new Set(visited).add(key);
    if (type === 'primitivenode') {
      const values = node.widgets_values;
      if (sourceSlot !== 0 || !Array.isArray(values) || ![1, 2].includes(values.length)
        || values[0] === null || values[0] === undefined
        || values.length === 2 && !CONTROL_MODES.has(String(values[1]))) {
        throw nodeError(node, '的 Primitive 值无法可靠还原');
      }
      return { value: widgetValue(values[0]) };
    }
    if (!Array.isArray(node.outputs) || !isObject(node.outputs[sourceSlot])) {
      throw nodeError(node, `缺少输出插槽 ${sourceSlot}`);
    }
    if (type === 'reroute' || Number(node.mode || 0) === 4) {
      const inputs = inputEntries(node);
      const outputType = node.outputs[sourceSlot].type;
      const candidates = inputs.flatMap((input, index) => {
        const link = getLink(node, input, index);
        return link && (type === 'reroute' || input.type === outputType) ? [{ link, index }] : [];
      });
      const candidate = candidates.find(({ index }) => index === sourceSlot)
        || (candidates.length === 1 ? candidates[0] : undefined);
      if (!candidate && candidates.length > 1) throw nodeError(node, `的输出插槽 ${sourceSlot} 存在多个同类型旁路输入`);
      return candidate ? resolve(candidate.link.originId, candidate.link.originSlot, nextVisited) : undefined;
    }
    return { connection: [sourceId, sourceSlot] };
  };

  const result: JsonObject = Object.create(null) as JsonObject;
  for (const [id, node] of nodes) {
    const type = normalizedType(node.type);
    if (Number(node.mode || 0) !== 0 || FRONTEND_ONLY_TYPES.has(type) || ['reroute', 'primitivenode'].includes(type)) continue;
    const inputs = inputEntries(node);
    const apiInputs = apiWidgetInputs(node, inputs);
    inputs.forEach((input, index) => {
      if (isFrontendWidget(input)) return;
      const link = getLink(node, input, index);
      if (!link) return;
      const resolved = resolve(link.originId, link.originSlot, new Set());
      if (resolved && 'connection' in resolved) apiInputs[input.name] = resolved.connection;
      else if (resolved && 'value' in resolved) apiInputs[input.name] = resolved.value;
    });
    result[id] = { class_type: node.type, inputs: apiInputs, _meta: { title: typeof node.title === 'string' ? node.title : node.type } };
  }
  if (!Object.keys(result).length) throw new Error('ComfyUI 画布 JSON 没有可执行节点。');
  // Return ordinary JSON objects while retaining special input names as own
  // data properties. Construction above never invokes object-prototype setters.
  return JSON.parse(JSON.stringify(result)) as JsonObject;
};
