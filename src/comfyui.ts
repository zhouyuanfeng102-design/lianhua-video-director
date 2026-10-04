import type { ComfyUIWorkflowPreset, ImageApiConfig } from './types';

export type ComfyUIWorkflowEntry = ComfyUIWorkflowPreset;

export interface ComfyUIImageConfigFields {
  comfyuiWorkflows: ComfyUIWorkflowEntry[];
  activeComfyuiWorkflowId: string | null;
  comfyuiPathMode: 'preset' | 'custom';
  comfyuiPromptPath: string;
}

export interface ComfyUIWorkflowImportResult {
  workflowJson: string;
  positiveCount: number;
  negativeCount: number;
  widthCount: number;
  heightCount: number;
  targetWidthCount: number;
  targetHeightCount: number;
  /** Standard LoadImage inputs that can carry a real uploaded reference image to an output. */
  referenceImageCount: number;
}

export interface ComfyUIWorkflowInput {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  sizeOverride?: boolean;
  seed?: number;
  steps?: number;
  cfg?: number;
  cfgRescale?: number;
  sampler?: string;
  scheduler?: string;
  smea?: boolean;
  smeaDynamic?: boolean;
}

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isCanvasWorkflow = (value: JsonObject): boolean => (
  Array.isArray(value.nodes) || Array.isArray(value.links)
);

const parseWorkflowJson = (text: string): JsonObject => {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('ComfyUI 缺少 API workflow JSON。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '格式错误';
    throw new Error(`ComfyUI API workflow JSON 解析失败：${detail}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('ComfyUI API workflow 必须是 JSON 对象。');
  }
  if (isCanvasWorkflow(parsed)) {
    throw new Error('该文件是 ComfyUI 画布 workflow，不是可执行的 API workflow。请从 ComfyUI 导出 API 格式。');
  }

  const workflow = isPlainObject(parsed.prompt) ? parsed.prompt : parsed;
  if (isCanvasWorkflow(workflow)) {
    throw new Error('该文件是 ComfyUI 画布 workflow，不是可执行的 API workflow。请从 ComfyUI 导出 API 格式。');
  }
  return workflow;
};

const cloneJsonObject = (value: JsonObject): JsonObject => (
  JSON.parse(JSON.stringify(value)) as JsonObject
);

const readConnectionNodeId = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const nodeId = value[0];
  return typeof nodeId === 'string' || typeof nodeId === 'number'
    ? String(nodeId)
    : '';
};

const nodeInputs = (node: unknown): JsonObject | null => {
  if (!isPlainObject(node) || !isPlainObject(node.inputs)) return null;
  return node.inputs;
};

const hasDirectScalarInput = (inputs: JsonObject, inputName: string): boolean => {
  if (!Object.prototype.hasOwnProperty.call(inputs, inputName)) return false;
  const valueType = typeof inputs[inputName];
  return valueType === 'string' || valueType === 'number' || valueType === 'boolean';
};

const isPromptTextNode = (node: unknown): boolean => {
  const inputs = nodeInputs(node);
  if (!inputs || typeof inputs.text !== 'string' || !isPlainObject(node)) return false;
  const classType = String(node.class_type || '').toLowerCase();
  return classType.includes('cliptextencode') || classType.includes('t5gemmatextencoder');
};

const nodeTitle = (node: unknown): string => {
  if (!isPlainObject(node)) return '';
  const meta = isPlainObject(node._meta) ? node._meta : null;
  return String(meta?.title ?? node.title ?? node.name ?? '').toLowerCase();
};

const normalizedClassType = (node: unknown): string => (
  isPlainObject(node) ? String(node.class_type || '').toLowerCase().replace(/[\s_-]+/gu, '') : ''
);

const isStandardLoadImageNode = (node: unknown): boolean => {
  const inputs = nodeInputs(node);
  return Boolean(
    inputs
    && typeof inputs.image === 'string'
    && normalizedClassType(node) === 'loadimage',
  );
};

const isImageOutputNode = (node: unknown): boolean => (
  /(?:save.*image|image.*save|preview.*image|image.*preview|saveanimated|videocombine)/u.test(normalizedClassType(node))
);

const isReferenceInfluenceNode = (node: unknown): boolean => (
  /(?:sampler|ipadapter|controlnet|vaeencode|latent(?:composite|blend|upscale)|reactor|faceswap|faceid|instantid|pulid|photomaker|stylemodel|applystyle|referenceattention|inpaint|outpaint|img2img|imageblend|imagecomposite|compositeimage)/u
    .test(normalizedClassType(node))
);

const collectConnectionNodeIds = (value: unknown, found: Set<string>): void => {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number'
  ) {
    found.add(String(value[0]));
    return;
  }
  value.forEach((item) => collectConnectionNodeIds(item, found));
};

const downstreamNodeIds = (workflow: JsonObject): Map<string, Set<string>> => {
  const downstream = new Map<string, Set<string>>();
  Object.entries(workflow).forEach(([consumerId, node]) => {
    const inputs = nodeInputs(node);
    if (!inputs) return;
    const upstreamIds = new Set<string>();
    Object.values(inputs).forEach((value) => collectConnectionNodeIds(value, upstreamIds));
    upstreamIds.forEach((upstreamId) => {
      const consumers = downstream.get(upstreamId) || new Set<string>();
      consumers.add(consumerId);
      downstream.set(upstreamId, consumers);
    });
  });
  return downstream;
};

const reachesGeneratedImageOutput = (
  workflow: JsonObject,
  downstream: ReadonlyMap<string, ReadonlySet<string>>,
  sourceId: string,
): boolean => {
  const visited = new Set<string>();
  const sourceInfluencesGeneration = isReferenceInfluenceNode(workflow[sourceId]);
  const pending = [...(downstream.get(sourceId) || [])].map((nodeId) => ({
    nodeId,
    influenced: sourceInfluencesGeneration,
  }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current?.nodeId) continue;
    const influenced = current.influenced || isReferenceInfluenceNode(workflow[current.nodeId]);
    const visitKey = `${current.nodeId}:${influenced ? 1 : 0}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (influenced && isImageOutputNode(workflow[current.nodeId])) return true;
    downstream.get(current.nodeId)?.forEach((consumerId) => pending.push({
      nodeId: consumerId,
      influenced,
    }));
  }
  return false;
};

const connectedReferenceImageNodeIds = (workflow: JsonObject): string[] => {
  const downstream = downstreamNodeIds(workflow);
  return Object.entries(workflow)
    .filter(([nodeId, node]) => (
      isStandardLoadImageNode(node)
      && reachesGeneratedImageOutput(workflow, downstream, nodeId)
    ))
    .map(([nodeId]) => nodeId)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
};

const titleIncludes = (node: unknown, keywords: string[]): boolean => {
  const title = nodeTitle(node);
  return keywords.some((keyword) => title.includes(keyword));
};

const collectUpstreamTextNodes = (
  workflow: JsonObject,
  rootId: string,
  textNodeIds: Set<string>,
): Set<string> => {
  const found = new Set<string>();
  const visited = new Set<string>();
  const pending = [rootId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    if (textNodeIds.has(currentId)) {
      found.add(currentId);
      continue;
    }

    const inputs = nodeInputs(workflow[currentId]);
    if (!inputs) continue;
    Object.values(inputs).forEach((value) => {
      const upstreamId = readConnectionNodeId(value);
      if (upstreamId && !visited.has(upstreamId)) pending.push(upstreamId);
    });
  }

  return found;
};

/**
 * Imports a ComfyUI API workflow and converts its runtime inputs to placeholders.
 * Both a raw API node map and the `{ prompt: nodeMap }` request shape are accepted.
 */
export const importComfyUIApiWorkflow = (
  text: string,
  options: { preserveImageSize?: boolean } = {},
): ComfyUIWorkflowImportResult => {
  const workflow = cloneJsonObject(parseWorkflowJson(text));
  const textNodeIds = new Set(
    Object.entries(workflow)
      .filter(([, node]) => isPromptTextNode(node))
      .map(([nodeId]) => String(nodeId)),
  );
  const positiveNodeIds = new Set<string>();
  const negativeNodeIds = new Set<string>();

  Object.values(workflow).forEach((node) => {
    const inputs = nodeInputs(node);
    if (!inputs) return;

    const positiveRoot = readConnectionNodeId(inputs.positive);
    const negativeRoot = readConnectionNodeId(inputs.negative);
    if (positiveRoot) {
      collectUpstreamTextNodes(workflow, positiveRoot, textNodeIds)
        .forEach((nodeId) => positiveNodeIds.add(nodeId));
    }
    if (negativeRoot) {
      collectUpstreamTextNodes(workflow, negativeRoot, textNodeIds)
        .forEach((nodeId) => negativeNodeIds.add(nodeId));
    }
  });

  textNodeIds.forEach((nodeId) => {
    const node = workflow[nodeId];
    if (titleIncludes(node, ['negative', '负面', '负向', '反向'])) {
      negativeNodeIds.add(nodeId);
      return;
    }
    if (titleIncludes(node, ['positive', '正面', '正向', 'prompt', '提示词'])) {
      positiveNodeIds.add(nodeId);
    }
  });

  if (positiveNodeIds.size === 0) {
    const fallbackId = [...textNodeIds].find((nodeId) => !negativeNodeIds.has(nodeId))
      ?? [...textNodeIds][0];
    if (fallbackId) positiveNodeIds.add(fallbackId);
  }

  let positiveCount = 0;
  let negativeCount = 0;
  let widthCount = 0;
  let heightCount = 0;
  let targetWidthCount = 0;
  let targetHeightCount = 0;

  Object.entries(workflow).forEach(([nodeId, node]) => {
    const inputs = nodeInputs(node);
    if (!inputs) return;

    if (typeof inputs.text === 'string') {
      if (negativeNodeIds.has(nodeId)) {
        inputs.text = '__NEGATIVE_PROMPT__';
        negativeCount += 1;
      } else if (positiveNodeIds.has(nodeId)) {
        inputs.text = '__PROMPT__';
        positiveCount += 1;
      }
    }

    if (!options.preserveImageSize && hasDirectScalarInput(inputs, 'width')) {
      inputs.width = '__WIDTH__';
      widthCount += 1;
    }
    if (!options.preserveImageSize && hasDirectScalarInput(inputs, 'height')) {
      inputs.height = '__HEIGHT__';
      heightCount += 1;
    }
    if (!options.preserveImageSize && hasDirectScalarInput(inputs, 'target_width')) {
      inputs.target_width = '__TARGET_WIDTH__';
      targetWidthCount += 1;
    }
    if (!options.preserveImageSize && hasDirectScalarInput(inputs, 'target_height')) {
      inputs.target_height = '__TARGET_HEIGHT__';
      targetHeightCount += 1;
    }
  });

  if (positiveCount === 0) {
    throw new Error('没有识别到正面提示词节点，请确认文件是 ComfyUI 导出的 API workflow JSON。');
  }

  return {
    workflowJson: JSON.stringify(workflow, null, 2),
    positiveCount,
    negativeCount,
    widthCount,
    heightCount,
    targetWidthCount,
    targetHeightCount,
    referenceImageCount: connectedReferenceImageNodeIds(workflow).length,
  };
};

const appendInlineNegativePrompt = (prompt: string, negativePrompt: string): string => {
  const positive = (prompt || '').trim();
  const negative = (negativePrompt || '').trim();
  if (!negative) return positive;
  if (!positive) return `Negative prompt: ${negative}`;
  if (/negative\s*prompt\s*:/iu.test(positive) || /--negative\b/iu.test(positive)) return positive;
  return `${positive}\nNegative prompt: ${negative}`;
};

const randomSeed = (): number => Math.floor(Math.random() * 2_147_483_647);

const injectWorkflowValues = (
  value: unknown,
  replacements: Readonly<Record<string, string | number | boolean>>,
): unknown => {
  if (typeof value === 'string') {
    if (Object.prototype.hasOwnProperty.call(replacements, value)) {
      return replacements[value];
    }
    return Object.entries(replacements).reduce(
      (result, [token, replacement]) => result.split(token).join(String(replacement)),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => injectWorkflowValues(item, replacements));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        injectWorkflowValues(child, replacements),
      ]),
    );
  }
  return value;
};

const workflowContainsAnyToken = (
  value: unknown,
  tokens: readonly string[],
): boolean => {
  if (typeof value === 'string') return tokens.some((token) => value.includes(token));
  if (Array.isArray(value)) return value.some((item) => workflowContainsAnyToken(item, tokens));
  if (isPlainObject(value)) {
    return Object.values(value).some((child) => workflowContainsAnyToken(child, tokens));
  }
  return false;
};

const WIDTH_MARKERS = ['__WIDTH__', '{{width}}', '__TARGET_WIDTH__', '{{target_width}}'];
const HEIGHT_MARKERS = ['__HEIGHT__', '{{height}}', '__TARGET_HEIGHT__', '{{target_height}}'];
const SIZE_MARKERS = ['__SIZE__', '{{size}}'];
const IMAGE_CANVAS_CLASSES = new Set(['emptylatentimage', 'emptysd3latentimage', 'emptyflux2latentimage']);

const hasExactSizePair = (inputs: JsonObject): boolean => {
  const values = Object.values(inputs).filter((value): value is string => typeof value === 'string');
  return values.some((value) => SIZE_MARKERS.includes(value))
    || (values.some((value) => WIDTH_MARKERS.includes(value)) && values.some((value) => HEIGHT_MARKERS.includes(value)));
};

const scalarCanvasDimension = (value: unknown, markers: readonly string[]): boolean => (
  typeof value === 'number' ? Number.isFinite(value) && value >= 64
    : typeof value === 'string' && (markers.includes(value) || /^\d+$/u.test(value) && Number(value) >= 64)
);

/** This is deliberately not the broad legacy importer: changing a reference
 * preprocessor, disconnected preview, or a linked width would not select the
 * generated canvas. Explicit markers are the workflow author's opt-in. */
const imageSizeOverridePlan = (workflow: JsonObject): { canvasNodeIds: string[]; message: string } => {
  const downstream = downstreamNodeIds(workflow);
  const connected = Object.entries(workflow).filter(([nodeId, node]) => (
    nodeInputs(node) && !isPromptTextNode(node) && reachesGeneratedImageOutput(workflow, downstream, nodeId)
  ));
  const marked = connected.filter(([, node]) => hasExactSizePair(nodeInputs(node)!));
  const canvases = connected.filter(([, node]) => {
    const inputs = nodeInputs(node)!;
    return IMAGE_CANVAS_CLASSES.has(normalizedClassType(node))
      && scalarCanvasDimension(inputs.width, WIDTH_MARKERS)
      && scalarCanvasDimension(inputs.height, HEIGHT_MARKERS);
  });
  if (canvases.length > 1 && canvases.some(([, node]) => !hasExactSizePair(nodeInputs(node)!))) {
    throw new Error('该 ComfyUI 工作流有多个生成画布，无法确定应修改哪一个。请在目标画布明确绑定 __WIDTH__ 与 __HEIGHT__，或选择“默认尺寸”并在工作流中设置像素。');
  }
  if (canvases.length === 0 && marked.length === 0) {
    throw new Error('该 ComfyUI 工作流没有可确认的生成尺寸入口，像素由工作流或参考图决定。请在生成画布绑定 __WIDTH__ 与 __HEIGHT__，或选择“默认尺寸”；不会静默忽略所选像素。');
  }
  return {
    canvasNodeIds: canvases.map(([nodeId]) => nodeId),
    message: '所选像素会写入已连接的生成画布或明确尺寸标记；后续缩放和实际输出仍由工作流决定。',
  };
};

/** The UI and transport share one capability check; an unsupported selection
 * fails before uploading reference images or submitting a paid generation. */
export const getComfyImageSizeOverrideSupport = (workflowJson: string): { supported: boolean; message: string } => {
  try {
    return { supported: true, message: imageSizeOverridePlan(parseWorkflowJson(workflowJson)).message };
  } catch (error) {
    return { supported: false, message: error instanceof Error ? error.message : '无法检查 ComfyUI 图片尺寸入口。' };
  }
};

/** Builds a fresh executable node map without mutating the stored workflow template. */
export const buildComfyUIWorkflow = (
  workflowJson: string,
  input: ComfyUIWorkflowInput,
): Record<string, unknown> => {
  const parsedWorkflow = parseWorkflowJson(workflowJson);
  const sizePlan = input.sizeOverride ? imageSizeOverridePlan(parsedWorkflow) : undefined;
  const hasPromptPlaceholder = workflowContainsAnyToken(
    parsedWorkflow,
    ['__PROMPT__', '{{prompt}}'],
  );
  const workflow = hasPromptPlaceholder
    ? parsedWorkflow
    : parseWorkflowJson(importComfyUIApiWorkflow(workflowJson, { preserveImageSize: input.sizeOverride }).workflowJson);
  sizePlan?.canvasNodeIds.forEach((nodeId) => {
    const inputs = nodeInputs(workflow[nodeId])!;
    inputs.width = '__WIDTH__';
    inputs.height = '__HEIGHT__';
  });
  const hasNegativePlaceholder = workflowContainsAnyToken(
    workflow,
    ['__NEGATIVE_PROMPT__', '{{negative_prompt}}', '{{negativePrompt}}'],
  );
  const prompt = hasNegativePlaceholder
    ? input.prompt
    : appendInlineNegativePrompt(input.prompt, input.negativePrompt);
  const seed = Number.isFinite(input.seed)
    ? Math.max(0, Math.floor(input.seed as number))
    : randomSeed();
  const steps = Number.isFinite(input.steps) ? Math.max(1, Math.floor(input.steps as number)) : 28;
  const cfg = Number.isFinite(input.cfg) ? Number(input.cfg) : 7;
  const cfgRescale = Number.isFinite(input.cfgRescale) ? Number(input.cfgRescale) : 0;
  const sampler = input.sampler?.trim() || 'euler';
  const scheduler = input.scheduler?.trim() || 'normal';
  const replacements: Record<string, string | number | boolean> = {
    __PROMPT__: prompt,
    '{{prompt}}': prompt,
    __NEGATIVE_PROMPT__: input.negativePrompt,
    '{{negative_prompt}}': input.negativePrompt,
    '{{negativePrompt}}': input.negativePrompt,
    __WIDTH__: input.width,
    '{{width}}': input.width,
    __HEIGHT__: input.height,
    '{{height}}': input.height,
    __TARGET_WIDTH__: input.width,
    '{{target_width}}': input.width,
    __TARGET_HEIGHT__: input.height,
    '{{target_height}}': input.height,
    __SIZE__: `${input.width}x${input.height}`,
    '{{size}}': `${input.width}x${input.height}`,
    __STEPS__: steps,
    '{{steps}}': steps,
    __CFG__: cfg,
    '{{cfg}}': cfg,
    __CFG_RESCALE__: cfgRescale,
    '{{cfg_rescale}}': cfgRescale,
    __SAMPLER__: sampler,
    '{{sampler}}': sampler,
    __SCHEDULER__: scheduler,
    '{{scheduler}}': scheduler,
    __SEED__: seed,
    '{{seed}}': seed,
    __SMEA__: input.smea === true,
    '{{smea}}': input.smea === true,
    __SMEA_DYN__: input.smeaDynamic === true,
    '{{smea_dyn}}': input.smeaDynamic === true,
  };

  return injectWorkflowValues(workflow, replacements) as Record<string, unknown>;
};

const REFERENCE_IMAGE_MARKER_PATTERN = /参考|reference|ref\b|ip[ -]?adapter|identity|character|person|face|style|subject/iu;
const GENERIC_REFERENCE_IMAGE_TOKENS = ['__REFERENCE_IMAGE__', '{{reference_image}}'] as const;
const REFERENCE_IMAGE_INPUT_NAME_PATTERN = /(?:^|_)(?:image|images|file|filename|path|reference|ref)(?:$|_)/iu;

export interface ComfyUIReferenceBindingOptions {
  /** Leading filenames explicitly selected by the user and therefore mandatory. */
  primaryReferenceImageCount?: number;
  /** Direct image-to-image keeps every explicit slot, including equal pixels. */
  preserveReferenceImageOrder?: boolean;
}

export interface ComfyUIReferenceBindingResult {
  workflow: Record<string, unknown>;
  /** Number of supplied reference slots actually wired into the generation graph. */
  boundReferenceImageCount: number;
}

const normalizedReferenceImageNames = (values: readonly string[], preserveOrder = false): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const name = String(value || '').trim().replace(/\\/gu, '/');
    if (!name || (!preserveOrder && seen.has(name))) return;
    if (/^(?:[a-z]:|\/)|(?:^|\/)\.\.(?:\/|$)|[\0\r\n]/iu.test(name)) {
      throw new Error('ComfyUI 返回了无效的参考图文件名。');
    }
    seen.add(name);
    result.push(name);
  });
  return result;
};

const referencePlaceholderIndexes = (value: string): Set<number> => {
  const indexes = new Set<number>();
  if (GENERIC_REFERENCE_IMAGE_TOKENS.some((token) => value.includes(token))) indexes.add(0);
  for (const match of value.matchAll(/__REFERENCE_IMAGE_(\d+)__|\{\{reference_image_(\d+)\}\}/gu)) {
    const index = Number(match[1] || match[2]) - 1;
    if (Number.isInteger(index) && index >= 0) indexes.add(index);
  }
  return indexes;
};

const workflowReferencePlaceholderNodes = (workflow: JsonObject): Map<string, Set<number>> => {
  const nodes = new Map<string, Set<number>>();
  Object.entries(workflow).forEach(([nodeId, node]) => {
    const inputs = nodeInputs(node);
    if (!inputs) return;
    const indexes = new Set<number>();
    Object.entries(inputs).forEach(([inputName, value]) => {
      if (typeof value !== 'string' || !REFERENCE_IMAGE_INPUT_NAME_PATTERN.test(inputName)) return;
      referencePlaceholderIndexes(value).forEach((index) => indexes.add(index));
    });
    if (indexes.size) nodes.set(nodeId, indexes);
  });
  return nodes;
};

/**
 * Injects uploaded ComfyUI filenames into a workflow without mutating the stored template.
 * Explicit `__REFERENCE_IMAGE_N__` placeholders win. Otherwise connected standard
 * LoadImage nodes are used, so an unrelated/disconnected image node cannot fake a reference.
 */
export const bindComfyUIReferenceImagesWithResult = (
  workflowInput: Record<string, unknown>,
  referenceImageNames: readonly string[],
  options: ComfyUIReferenceBindingOptions = {},
): ComfyUIReferenceBindingResult => {
  const names = normalizedReferenceImageNames(referenceImageNames, options.preserveReferenceImageOrder);
  const workflow = cloneJsonObject(workflowInput);
  if (!names.length) return { workflow, boundReferenceImageCount: 0 };
  const configuredPrimaryCount = Number(options.primaryReferenceImageCount);
  const primaryReferenceImageCount = Number.isFinite(configuredPrimaryCount)
    ? Math.floor(configuredPrimaryCount)
    : names.length;
  if (primaryReferenceImageCount < 0 || primaryReferenceImageCount > names.length) {
    throw new Error('ComfyUI 主参考图数量与实际图片数量不一致。');
  }

  const placeholderNodes = workflowReferencePlaceholderNodes(workflow);
  if (placeholderNodes.size > 0) {
    const downstream = downstreamNodeIds(workflow);
    const disconnectedNodeIds = [...placeholderNodes.keys()].filter((nodeId) => (
      !reachesGeneratedImageOutput(workflow, downstream, nodeId)
    ));
    if (disconnectedNodeIds.length > 0) {
      throw new Error(`ComfyUI 参考图占位节点未接入实际生成链：${disconnectedNodeIds.join('、')}。`);
    }
    const placeholderIndexes = new Set<number>();
    placeholderNodes.forEach((indexes) => indexes.forEach((index) => placeholderIndexes.add(index)));
    const unavailableIndex = [...placeholderIndexes].find((index) => index >= names.length);
    if (unavailableIndex !== undefined) {
      throw new Error(`当前 ComfyUI Workflow 需要第 ${unavailableIndex + 1} 张参考图，但本次只选择了 ${names.length} 张。`);
    }
    const missingPrimaryIndex = Array.from(
      { length: primaryReferenceImageCount },
      (_, index) => index,
    ).find((index) => !placeholderIndexes.has(index));
    if (missingPrimaryIndex !== undefined) {
      throw new Error(`当前 ComfyUI Workflow 没有接入第 ${missingPrimaryIndex + 1} 张主参考图。`);
    }
    const replacements: Record<string, string> = {};
    GENERIC_REFERENCE_IMAGE_TOKENS.forEach((token) => { replacements[token] = names[0]; });
    names.forEach((name, index) => {
      replacements[`__REFERENCE_IMAGE_${index + 1}__`] = name;
      replacements[`{{reference_image_${index + 1}}}`] = name;
    });
    placeholderNodes.forEach((_, nodeId) => {
      const inputs = nodeInputs(workflow[nodeId]);
      if (!inputs) return;
      Object.entries(inputs).forEach(([inputName, value]) => {
        if (typeof value !== 'string' || !REFERENCE_IMAGE_INPUT_NAME_PATTERN.test(inputName)) return;
        inputs[inputName] = injectWorkflowValues(value, replacements);
      });
    });
    return { workflow, boundReferenceImageCount: placeholderIndexes.size };
  }

  const connectedIds = connectedReferenceImageNodeIds(workflow);
  const markedIds = connectedIds.filter((nodeId) => (
    REFERENCE_IMAGE_MARKER_PATTERN.test(nodeTitle(workflow[nodeId]))
  ));
  const markedIdSet = new Set(markedIds);
  const targetIds = [
    ...markedIds,
    ...connectedIds.filter((nodeId) => !markedIdSet.has(nodeId)),
  ];
  if (!targetIds.length) {
    // Storyboard generation can add inferred character/location images as
    // optional continuity aids. A pure text-to-image workflow must remain
    // usable when none of those inferred images were explicitly selected by
    // the user. Explicit primary references still fail below instead of being
    // silently ignored.
    if (primaryReferenceImageCount === 0) return { workflow, boundReferenceImageCount: 0 };
    throw new Error('当前 ComfyUI Workflow 没有连接到输出的 LoadImage 参考图节点。请导入带 LoadImage/IPAdapter 或图生图链路的 API Workflow。');
  }
  if (primaryReferenceImageCount > targetIds.length) {
    throw new Error(`当前 ComfyUI Workflow 只有 ${targetIds.length} 个可用参考图节点，无法接入本次 ${primaryReferenceImageCount} 张主参考图。`);
  }

  targetIds.forEach((nodeId, index) => {
    const inputs = nodeInputs(workflow[nodeId]);
    if (inputs) inputs.image = names[index] || names[0];
  });
  return {
    workflow,
    boundReferenceImageCount: Math.min(names.length, targetIds.length),
  };
};

export const bindComfyUIReferenceImages = (
  workflowInput: Record<string, unknown>,
  referenceImageNames: readonly string[],
  options: ComfyUIReferenceBindingOptions = {},
): Record<string, unknown> => bindComfyUIReferenceImagesWithResult(
  workflowInput,
  referenceImageNames,
  options,
).workflow;

export interface ComfyUIReferenceWorkflowCapability {
  /** Number of distinct reference inputs that can affect a generated image output. */
  referenceImageCount: number;
  /** Leading user-selected references that the caller required the workflow to accept. */
  requiredPrimaryReferenceImageCount: number;
}

/**
 * Fail-closed capability check for flows that must preserve user-selected
 * reference images (for example a 3x3 storyboard master). This performs the
 * same graph/connectivity validation as the real filename binding, without
 * uploading pixels or mutating the stored workflow.
 */
export const assertComfyUIWorkflowCanBindReferenceImages = (
  workflowJson: string,
  requiredPrimaryReferenceImageCount = 1,
): ComfyUIReferenceWorkflowCapability => {
  if (
    !Number.isInteger(requiredPrimaryReferenceImageCount)
    || requiredPrimaryReferenceImageCount < 1
  ) {
    throw new Error('ComfyUI 参考图能力检查数量必须是大于 0 的整数。');
  }

  const workflow = parseWorkflowJson(workflowJson);
  const placeholderNodes = workflowReferencePlaceholderNodes(workflow);
  let largestPlaceholderIndex = -1;
  placeholderNodes.forEach((indexes) => indexes.forEach((index) => {
    largestPlaceholderIndex = Math.max(largestPlaceholderIndex, index);
  }));
  // Supply probes for every explicit numbered placeholder so a valid
  // multi-reference workflow is not rejected merely because this preflight
  // only requires its first N primary slots.
  const probeCount = Math.max(
    requiredPrimaryReferenceImageCount,
    largestPlaceholderIndex + 1,
  );
  const probeNames = Array.from(
    { length: probeCount },
    (_, index) => `lianhua-reference-capability-${index + 1}.png`,
  );
  const result = bindComfyUIReferenceImagesWithResult(
    workflow,
    probeNames,
    { primaryReferenceImageCount: requiredPrimaryReferenceImageCount },
  );
  if (result.boundReferenceImageCount < requiredPrimaryReferenceImageCount) {
    throw new Error(
      `当前 ComfyUI Workflow 只能接入 ${result.boundReferenceImageCount} 张参考图，无法接入本次 ${requiredPrimaryReferenceImageCount} 张主参考图。`,
    );
  }
  return {
    referenceImageCount: result.boundReferenceImageCount,
    requiredPrimaryReferenceImageCount,
  };
};

const normalizeWorkflowEntries = (
  workflows: unknown,
  fallbackTime: number,
): ComfyUIWorkflowEntry[] => {
  if (!Array.isArray(workflows)) return [];
  const seenIds = new Set<string>();
  const normalized: ComfyUIWorkflowEntry[] = [];

  workflows.forEach((rawEntry, index) => {
    if (!isPlainObject(rawEntry)) return;
    const id = typeof rawEntry.id === 'string' ? rawEntry.id.trim() : '';
    const workflowJson = typeof rawEntry.workflowJson === 'string' ? rawEntry.workflowJson : '';
    if (!id || !workflowJson.trim() || seenIds.has(id)) return;
    seenIds.add(id);

    const createdAt = typeof rawEntry.createdAt === 'number' && Number.isFinite(rawEntry.createdAt)
      ? rawEntry.createdAt
      : fallbackTime;
    const updatedAt = typeof rawEntry.updatedAt === 'number' && Number.isFinite(rawEntry.updatedAt)
      ? rawEntry.updatedAt
      : createdAt;
    normalized.push({
      id,
      name: typeof rawEntry.name === 'string' && rawEntry.name.trim()
        ? rawEntry.name.trim()
        : `工作流 ${index + 1}`,
      workflowJson,
      createdAt,
      updatedAt,
    });
  });

  return normalized;
};

/** Keeps the selected workflow and the legacy top-level JSON in lockstep. */
export const synchronizeComfyUIWorkflows = (
  workflows: ComfyUIWorkflowEntry[],
  activeId?: string | null,
): Pick<ComfyUIImageConfigFields, 'comfyuiWorkflows' | 'activeComfyuiWorkflowId'> & {
  workflowJson: string;
} => {
  const normalized = normalizeWorkflowEntries(workflows, Date.now());
  const selected = normalized.find((entry) => entry.id === activeId) ?? normalized[0];
  return {
    comfyuiWorkflows: normalized,
    activeComfyuiWorkflowId: selected?.id ?? null,
    workflowJson: selected?.workflowJson ?? '',
  };
};

/** Migrates the old single-workflow config while preserving every unrelated field. */
export const normalizeComfyUIImageConfig = <T extends ImageApiConfig>(
  config: T,
  now = Date.now(),
): T & ComfyUIImageConfigFields => {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const source = config as T & Partial<ComfyUIImageConfigFields>;
  let workflows = normalizeWorkflowEntries(source.comfyuiWorkflows, timestamp);
  if (workflows.length === 0 && typeof config.workflowJson === 'string' && config.workflowJson.trim()) {
    workflows = [{
      id: `comfy-workflow-${timestamp}`,
      name: '默认工作流',
      workflowJson: config.workflowJson,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }

  const synchronized = synchronizeComfyUIWorkflows(
    workflows,
    source.activeComfyuiWorkflowId,
  );
  const promptPath = typeof source.comfyuiPromptPath === 'string' && source.comfyuiPromptPath.trim()
    ? source.comfyuiPromptPath.trim()
    : '/prompt';

  return {
    ...config,
    ...synchronized,
    comfyuiPathMode: source.comfyuiPathMode === 'custom' ? 'custom' : 'preset',
    comfyuiPromptPath: promptPath,
  };
};
