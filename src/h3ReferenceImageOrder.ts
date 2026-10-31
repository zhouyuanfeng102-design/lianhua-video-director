/** Minimal API-graph evidence for H3's per-type, one-based Picture numbering. */
export interface H3ImageFieldBinding { nodeId: string; inputName: string }
export interface H3ReferenceImageInput {
  inputName: string;
  source?: H3ImageFieldBinding;
  present: boolean;
  /** An image-producing path whose multiplicity/source is not known locally. */
  unresolved?: true;
}
export interface H3ReferenceImageOrder {
  consumerNodeId: string;
  prompt: H3ImageFieldBinding[];
  images: H3ReferenceImageInput[];
}
export interface H3CompiledReferenceImageOrder {
  consumerNodeId: string;
  images: Array<H3ReferenceImageInput & { slotIndex?: number; presentWhenUnselected: boolean }>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const binding = (value: unknown): H3ImageFieldBinding | undefined => record(value)
  && typeof value.nodeId === 'string' && value.nodeId.trim() && typeof value.inputName === 'string' && value.inputName.trim()
  ? { nodeId: value.nodeId, inputName: value.inputName } : undefined;
const key = (value: H3ImageFieldBinding) => JSON.stringify([value.nodeId, value.inputName]);
const link = (value: unknown): [string, number] | undefined => Array.isArray(value) && value.length === 2
  && (typeof value[0] === 'string' || Number.isSafeInteger(value[0])) && Number.isInteger(value[1])
  ? [String(value[0]), value[1] as number] : undefined;
export const h3ImageValuePresent = (value: unknown): boolean => typeof value === 'string'
  && Boolean(value.trim()) && !/^(?:none|null)$/iu.test(value.trim());

/** Saved metadata only: never contains image bytes, filenames, prompts, or credentials. */
export const normalizeH3ReferenceImageOrders = (value: unknown): H3ReferenceImageOrder[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): H3ReferenceImageOrder[] => {
    if (!record(item) || typeof item.consumerNodeId !== 'string' || !item.consumerNodeId.trim()
      || !Array.isArray(item.prompt) || !Array.isArray(item.images)) return [];
    const prompt = item.prompt.flatMap((part) => { const field = binding(part); return field ? [field] : []; });
    const images: H3ReferenceImageInput[] = [];
    for (const image of item.images) {
      if (!record(image) || typeof image.inputName !== 'string' || typeof image.present !== 'boolean') return [];
      const source = binding(image.source);
      images.push({ inputName: image.inputName, present: image.present, ...(source ? { source } : {}),
        ...(image.unresolved === true ? { unresolved: true as const } : {}) });
    }
    return [{ consumerNodeId: item.consumerNodeId, prompt, images }];
  });
};

/** Follow only known single-image operations; switches/batches may change order or count. */
const singleImageInputs: Record<string, string> = {
  ImageScale: 'image', ImageScaleBy: 'image', ImageCrop: 'image', ImagePadForOutpaint: 'image',
  ImageInvert: 'image', ImageFlip: 'image', Reroute: '',
};

export const readH3ReferenceImageOrders = (graph: unknown): H3ReferenceImageOrder[] => {
  if (!record(graph)) return [];
  const nodeAt = (nodeId: string) => {
    const node = graph[nodeId];
    return record(node) && typeof node.class_type === 'string' && record(node.inputs)
      ? { classType: node.class_type, inputs: node.inputs } : undefined;
  };
  const imageSource = (value: unknown, visited = new Set<string>()): Pick<H3ReferenceImageInput, 'source' | 'present' | 'unresolved'> => {
    if (value == null || value === '') return { present: false };
    const edge = link(value);
    if (!edge || edge[1] !== 0 || visited.has(edge[0])) return { present: true, unresolved: true };
    const node = nodeAt(edge[0]);
    if (!node) return { present: true, unresolved: true };
    if (node.classType === 'LoadImage' && typeof node.inputs.image === 'string') {
      return { source: { nodeId: edge[0], inputName: 'image' }, present: h3ImageValuePresent(node.inputs.image) };
    }
    const inputName = singleImageInputs[node.classType];
    if (inputName === undefined) return { present: true, unresolved: true };
    visited.add(edge[0]);
    return imageSource(inputName ? node.inputs[inputName] : Object.values(node.inputs)[0], visited);
  };
  const promptSources = (nodeId: string, inputName: string, visited = new Set<string>()): H3ImageFieldBinding[] => {
    const node = nodeAt(nodeId); if (!node) return [];
    const value = node.inputs[inputName];
    if (typeof value === 'string') return [{ nodeId, inputName }];
    const edge = link(value); if (!edge || visited.has(edge[0])) return [];
    const source = nodeAt(edge[0]); if (!source) return [];
    visited.add(edge[0]);
    return Object.keys(source.inputs).flatMap((name) => promptSources(edge[0], name, new Set(visited)));
  };
  return Object.keys(graph).flatMap((consumerNodeId): H3ReferenceImageOrder[] => {
    const node = nodeAt(consumerNodeId);
    if (!node) return [];
    let entries: Array<[string, unknown]>;
    if (node.classType === 'MiniMaxH3ImageToVideo') {
      entries = (['first_frame', 'last_frame'] as const)
        .filter((inputName) => inputName in node.inputs)
        .map((inputName): [string, unknown] => [inputName, node.inputs[inputName]]);
    } else if (node.classType === 'MiniMaxH3ReferenceToVideo') {
      // DynamicCombo's flattened inputs retain insertion order, as does execute(ref_images).values().
      entries = Object.entries(node.inputs).flatMap(([inputName, value]): Array<[string, unknown]> => {
        if (/^ref_images\.ref_image_\d+$/u.test(inputName)) return [[inputName, value]];
        if (inputName === 'ref_images' && record(value)) return Object.entries(value).map(([name, image]) => [`ref_images.${name}`, image]);
        return [];
      });
    } else return [];
    return [{ consumerNodeId, prompt: promptSources(consumerNodeId, 'prompt'),
      images: entries.map(([inputName, value]) => ({ inputName, ...imageSource(value) })) }];
  });
};

export const compileH3ReferenceImageOrders = (
  orders: readonly H3ReferenceImageOrder[],
  mapping: { prompt: readonly H3ImageFieldBinding[]; images: readonly H3ImageFieldBinding[] },
  unselectedPresent: (source: H3ImageFieldBinding, slotIndex: number | undefined, defaultPresent: boolean) => boolean,
): H3CompiledReferenceImageOrder[] => {
  const promptKeys = new Set(mapping.prompt.map(key));
  const slots = new Map(mapping.images.map((field, index) => [key(field), index]));
  return orders.filter((order) => order.prompt.some((field) => promptKeys.has(key(field)))).map((order) => ({
    consumerNodeId: order.consumerNodeId,
    images: order.images.map((image) => {
      const slotIndex = image.source ? slots.get(key(image.source)) : undefined;
      return { ...image, ...(slotIndex !== undefined ? { slotIndex } : {}),
        presentWhenUnselected: image.source ? unselectedPresent(image.source, slotIndex, image.present) : image.present };
    }),
  }));
};

export const resolveH3PictureNumbers = (orders: readonly H3CompiledReferenceImageOrder[] | undefined, selectedSlots: readonly number[]): number[] | undefined => {
  if (!selectedSlots.length) return [];
  if (!orders?.length || selectedSlots.some((slot) => !Number.isInteger(slot) || slot < 0)
    || new Set(selectedSlots).size !== selectedSlots.length) return undefined;
  const selected = new Set(selectedSlots);
  let result: number[] | undefined;
  for (const order of orders) {
    if (order.images.some((image) => image.unresolved)) return undefined;
    let picture = 0;
    const numbers = new Map<number, number>();
    for (const image of order.images) {
      const chosen = image.slotIndex !== undefined && selected.has(image.slotIndex);
      if (!chosen && !image.presentWhenUnselected) continue;
      picture += 1;
      if (chosen) {
        // A single source consumed twice cannot have one unambiguous Picture label.
        if (numbers.has(image.slotIndex!)) return undefined;
        numbers.set(image.slotIndex!, picture);
      }
    }
    if (selectedSlots.some((slot) => !numbers.has(slot))) return undefined;
    const current = selectedSlots.map((slot) => numbers.get(slot)!);
    if (result && current.some((number, index) => number !== result![index])) return undefined;
    result = current;
  }
  return result;
};

export const resolveComfyH3PictureNumbers = (
  workflow: { workflowJson: string; mapping: { prompt: readonly H3ImageFieldBinding[]; images: readonly H3ImageFieldBinding[] } },
  selectedSlots: readonly number[],
): number[] | undefined => {
  let graph: unknown; try { graph = JSON.parse(workflow.workflowJson); } catch { return undefined; }
  if (record(graph) && record(graph.prompt)) graph = graph.prompt;
  const orders = readH3ReferenceImageOrders(graph);
  // Local Comfy binding preserves defaults in unselected inputs.
  return resolveH3PictureNumbers(compileH3ReferenceImageOrders(orders, workflow.mapping,
    (_source, _slotIndex, present) => present), selectedSlots);
};
