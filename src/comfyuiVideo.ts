import type { ComfyVideoInputBinding, ComfyVideoMapping, ComfyVideoWorkflowPreset, VideoGenerationRuntime, VideoImageReference } from './videoGenerationTypes';
import type { VideoGenerationTask } from './types';
import { assertVideoReferenceSlots, videoReferenceSlotIndex } from './videoReferenceSlots';
import { convertComfyUICanvasWorkflow, isComfyUICanvasWorkflow } from './comfyuiCanvas';
import { compileComfyH3ReferenceImageOrders, readH3ReferenceImageOrders } from './h3ReferenceImageOrder';
import { inferComfyVideoDurationBinding, mergeComfyVideoDurationBinding } from './comfyuiVideoDuration';

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ComfyVideoNodeMap = Record<string, Node>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const connection = (value: unknown): string | undefined => Array.isArray(value) && value.length === 2 && typeof value[1] === 'number' ? String(value[0]) : undefined;

const comfyTimestampMilliseconds = (value: unknown): number | undefined => {
  const timestamp = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  // ComfyUI currently records epoch milliseconds, while some compatible
  // servers expose epoch seconds. Keep both forms without treating queue time
  // as an execution start.
  return Math.round(timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp);
};

/** Reads the authoritative execution_start event retained in ComfyUI history. */
export const comfyVideoExecutionStartedAt = (historyEntry: unknown, promptId = ''): number | undefined => {
  const status = record(historyEntry) && record(historyEntry.status) ? historyEntry.status : undefined;
  const messages = status && Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_start' || !record(message[1])) continue;
    const data = message[1];
    if (promptId && data.prompt_id != null && String(data.prompt_id) !== promptId) continue;
    const startedAt = comfyTimestampMilliseconds(data.timestamp);
    if (startedAt) return startedAt;
  }
  return undefined;
};

export const parseComfyVideoWorkflow = (text: string): ComfyVideoNodeMap => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('视频工作流不是有效 JSON。'); }
  if (!record(parsed)) throw new Error('视频工作流必须是 API 节点对象。');
  const document = record(parsed.prompt) ? parsed.prompt : parsed;
  const raw = isComfyUICanvasWorkflow(document) ? convertComfyUICanvasWorkflow(document) : document;
  if (!Object.values(raw).every((item) => record(item) && typeof item.class_type === 'string' && record(item.inputs))) {
    throw new Error('视频工作流包含无效的 API 节点。');
  }
  return raw as ComfyVideoNodeMap;
};

/** Import/save boundary only: executable API documents retain their original
 * text so unrelated large integer literals and formatting are not rewritten. */
export const normalizeComfyVideoWorkflowJson = (text: string): string => {
  const parsed: unknown = JSON.parse(text);
  const document = record(parsed) && record(parsed.prompt) ? parsed.prompt : parsed;
  return isComfyUICanvasWorkflow(document) ? JSON.stringify(convertComfyUICanvasWorkflow(document), null, 2) : text;
};

const ancestors = (nodes: ComfyVideoNodeMap, outputId: string): Set<string> => {
  const found = new Set<string>();
  const pending = [outputId];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    Object.values(nodes[id]?.inputs || {}).forEach((value) => eachConnection(value, (parent) => pending.push(parent)));
  }
  return found;
};

const isPreviewOutputNode = (node: Node): boolean => /saveanimated(?:webp|png)/iu.test(node.class_type)
  || /videocombine/iu.test(node.class_type) && /^(?:image\/|gif$|webp$|apng$)/iu.test(String(node.inputs.format || ''));
const isVideoOutputNode = (node: Node): boolean => /(?:videocombine|savevideo|videosave)/iu.test(node.class_type) && !isPreviewOutputNode(node);

const preferredVideoOutput = (nodes: ComfyVideoNodeMap): [string, Node] | undefined => {
  const outputs = Object.entries(nodes).filter(([, node]) => isVideoOutputNode(node));
  const audioOutputs = outputs.filter(([, node]) => connection(node.inputs.audio));
  return outputs.find(([id, node]) => id === '328' && /videocombine/iu.test(node.class_type))
    || (audioOutputs.length === 1 ? audioOutputs[0] : undefined)
    || (outputs.length === 1 ? outputs[0] : undefined);
};

// Repeated UI renders use the same graph text. Cache only the inferred input,
// not whole graphs or mutable presets; editing text/output invalidates the key.
const durationBindings = new Map<string, Map<string, ComfyVideoInputBinding | undefined>>();
export const effectiveComfyVideoParameterBindings = (
  workflow: Pick<ComfyVideoWorkflowPreset, 'mapping'> & Partial<Pick<ComfyVideoWorkflowPreset, 'workflowJson'>>,
): Record<string, ComfyVideoInputBinding> => {
  const explicit = workflow.mapping.parameters;
  if (explicit?.duration || !workflow.workflowJson) return explicit || {};
  const text = workflow.workflowJson;
  const outputId = workflow.mapping.outputNodeId || '';
  let byOutput = durationBindings.get(text);
  if (!byOutput) {
    if (durationBindings.size >= 8) durationBindings.delete(durationBindings.keys().next().value!);
    byOutput = new Map(); durationBindings.set(text, byOutput);
  }
  if (!byOutput.has(outputId)) {
    let inferred: ComfyVideoInputBinding | undefined;
    try {
      const nodes = parseComfyVideoWorkflow(text);
      const output = outputId || preferredVideoOutput(nodes)?.[0];
      inferred = inferComfyVideoDurationBinding(nodes, output ? ancestors(nodes, output) : undefined);
    } catch { /* Incomplete editor drafts keep their explicit mappings. */ }
    byOutput.set(outputId, inferred);
  }
  return mergeComfyVideoDurationBinding(explicit, byOutput.get(outputId));
};

/** Record the policy on new snapshots. Restoring an older snapshot retains its
 * original image defaults and numbering without rewriting the saved task. */
export const freezeComfyVideoWorkflow = (
  workflow: ComfyVideoWorkflowPreset,
  legacySnapshot = false,
): ComfyVideoWorkflowPreset => {
  const copy = structuredClone(workflow);
  copy.mapping.h3ReferenceSelection ??= legacySnapshot ? 'workflow-defaults' : 'selected';
  return copy;
};

type ConditioningRole = 'positive' | 'negative';
const conditioningRole = (input: string): ConditioningRole | undefined => {
  const name = input.replace(/[_\s-]/gu, '').toLowerCase();
  if (/^(?:negative|negativeprompt|negativeconditioning|conditioningnegative|negativecond)$/u.test(name)) return 'negative';
  if (/^(?:positive|positiveprompt|positiveconditioning|conditioningpositive|positivecond)$/u.test(name)) return 'positive';
  return undefined;
};

/** Follow text/conditioning dependencies rather than just the sampler's direct
 * neighbour. A zeroed condition retains shape, not negative text semantics.
 * Nodes genuinely feeding both roles remain manual-only. */
const conditioningUses = (nodes: ComfyVideoNodeMap): Map<string, Set<ConditioningRole>> => {
  const uses = new Map<string, Set<ConditioningRole>>();
  const pending: Array<{ id: string; slot: number; role: ConditioningRole }> = [];
  const enqueue = (value: unknown, role: ConditioningRole) => {
    const id = connection(value);
    if (id) pending.push({ id, slot: (value as [unknown, number])[1], role });
  };
  for (const [id, node] of Object.entries(nodes)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      const role = conditioningRole(input);
      if (role) enqueue(value, role);
    }
    if (/(?:negative|负面)/iu.test(node._meta?.title || '')) pending.push({ id, slot: 0, role: 'negative' });
  }
  const visited = new Set<string>();
  while (pending.length) {
    const { id, slot, role } = pending.pop()!;
    const node = nodes[id];
    const key = JSON.stringify([id, slot, role]);
    if (!node || visited.has(key)) continue;
    visited.add(key);
    const roles = uses.get(id) || new Set<ConditioningRole>();
    roles.add(role); uses.set(id, roles);
    if (/^ConditioningZeroOut$/iu.test(node.class_type)) continue;
    // Advanced ControlNet exposes separate positive/negative conditioning
    // outputs. Following both inputs would falsely mark both texts negative.
    if (/^(?:ControlNetApplyAdvanced|ControlNetApplySD3)$/iu.test(node.class_type) && (slot === 0 || slot === 1)) {
      enqueue(node.inputs[slot === 0 ? 'positive' : 'negative'], role);
      continue;
    }
    for (const [input, value] of Object.entries(node.inputs)) {
      // Shared models, pixels and latent data are not prompt dependencies.
      if (/^(?:clip|model|vae|control_net|image|images|pixels|mask|latent_image|samples|audio|noise|seed|noise_seed|sigmas)$/iu.test(input)) continue;
      enqueue(value, role);
    }
  }
  return uses;
};

/** Video-only importer: never substitutes image generation seeds, frame counts or dimensions. */
export const importComfyVideoWorkflow = (text: string): { workflowJson: string; mapping: ComfyVideoMapping } => {
  const nodes = parseComfyVideoWorkflow(text);
  const preferred = preferredVideoOutput(nodes);
  const included = preferred ? ancestors(nodes, preferred[0]) : new Set(Object.keys(nodes));
  const uses = conditioningUses(nodes);
  const prompt: ComfyVideoInputBinding[] = [];
  const pushText = (id: string, inputName: string) => {
    if (uses.get(id)?.has('negative') || /(?:negative|负面)/iu.test(nodes[id]?._meta?.title || '')) return;
    if (!prompt.some((binding) => binding.nodeId === id && binding.inputName === inputName)) prompt.push({ nodeId: id, inputName });
  };
  Object.entries(nodes).filter(([id]) => included.has(id)).forEach(([id, node]) => {
    if (uses.get(id)?.has('negative') || /(?:negative|负面)/iu.test(node._meta?.title || '')) return;
    // H3 condition.prompt may point at PrimitiveStringMultiline.value.
    if ('prompt' in node.inputs) {
      const parent = connection(node.inputs.prompt);
      const source = parent ? nodes[parent] : undefined;
      if (source && typeof source.inputs.value === 'string') pushText(parent!, 'value');
      else if (source && typeof source.inputs.text === 'string') pushText(parent!, 'text');
      else if (typeof node.inputs.prompt === 'string') pushText(id, 'prompt');
    }
    if (/cliptextencode/iu.test(node.class_type) && typeof node.inputs.text === 'string') {
      pushText(id, 'text');
    }
  });
  if (!prompt.length) Object.entries(nodes).filter(([id]) => included.has(id)).forEach(([id, node]) => {
    if (/prompt|提示词|输入文本/iu.test(node._meta?.title || '') && typeof node.inputs.value === 'string') pushText(id, 'value');
  });
  const imageInputs = Object.entries(nodes).filter(([id, node]) => included.has(id) && /^LoadImage$/iu.test(node.class_type) && typeof node.inputs.image === 'string')
    .map(([nodeId]) => ({ nodeId, inputName: 'image' }));
  // H3 dynamic inputs have an explicit physical order independent of node IDs.
  // Reuse the same graph evidence as Picture numbering; never rename existing
  // task mappings or saved presets as a side effect of this new import.
  const promptFields = new Set(prompt.map((binding) => JSON.stringify(binding)));
  const orderedImages = readH3ReferenceImageOrders(nodes)
    .filter((order) => included.has(order.consumerNodeId)
      && order.prompt.some((binding) => promptFields.has(JSON.stringify(binding))))
    .flatMap((order) => order.images.flatMap((image) => image.source ? [image.source] : []));
  const imageByField = new Map(imageInputs.map((binding) => [JSON.stringify(binding), binding]));
  const seenImages = new Set<string>();
  const images = [...orderedImages, ...imageInputs].flatMap((binding) => {
    const key = JSON.stringify(binding);
    if (seenImages.has(key) || !imageByField.has(key)) return [];
    seenImages.add(key); return [imageByField.get(key)!];
  });
  const parameters: Record<string, ComfyVideoInputBinding> = {};
  const candidates: Record<string, string[]> = { seed: ['noise_seed', 'seed'], steps: ['steps'], cfg: ['cfg'], width: ['width'], height: ['height'], fps: ['frame_rate', 'fps'] };
  for (const [name, fields] of Object.entries(candidates)) {
    for (const [nodeId, node] of Object.entries(nodes).filter(([id]) => included.has(id))) {
      const inputName = fields.find((field) => typeof node.inputs[field] === 'number');
      if (inputName) { parameters[name] = { nodeId, inputName }; break; }
    }
  }
  const duration = inferComfyVideoDurationBinding(nodes, included);
  if (duration) parameters.duration = duration;
  const document: unknown = JSON.parse(text);
  const raw = record(document) && record(document.prompt) ? document.prompt : document;
  // Store the converted executable graph once. Existing API JSON stays byte
  // for byte intact, including literals not bound by this importer.
  const workflowJson = isComfyUICanvasWorkflow(raw) ? JSON.stringify(nodes, null, 2) : text;
  return { workflowJson, mapping: { prompt, images, parameters, outputNodeId: preferred?.[0] } };
};

const eachConnection = (value: unknown, visit: (nodeId: string) => void): void => {
  const parent = connection(value);
  if (parent) { visit(parent); return; }
  if (record(value)) Object.values(value).forEach((part) => eachConnection(part, visit));
};

const omitUnusedH3ReferenceInputs = (
  nodes: ComfyVideoNodeMap,
  mapping: ComfyVideoMapping,
  selectedSlots: readonly number[],
): void => {
  const selected = new Set(selectedSlots);
  const detached = new Set<string>();
  for (const order of compileComfyH3ReferenceImageOrders(nodes, mapping)) {
    const inputs = nodes[order.consumerNodeId].inputs;
    for (const image of order.images) {
      if (image.slotIndex === undefined || selected.has(image.slotIndex) || image.presentWhenUnselected) continue;
      // Only the proven optional ReferenceToVideo fields are shortened. I2V
      // frames with an empty default also have presentWhenUnselected=false.
      if (nodes[order.consumerNodeId].class_type !== 'MiniMaxH3ReferenceToVideo'
        || mapping.h3ReferenceSelection === 'workflow-defaults'
        || inputs.ref_images !== undefined && !record(inputs.ref_images)) continue;
      if (Object.prototype.hasOwnProperty.call(inputs, image.inputName)) {
        eachConnection(inputs[image.inputName], (id) => detached.add(id));
        delete inputs[image.inputName];
      } else if (record(inputs.ref_images)) {
        const field = image.inputName.slice('ref_images.'.length);
        eachConnection(inputs.ref_images[field], (id) => detached.add(id));
        delete inputs.ref_images[field];
      }
    }
  }
  // A workflow can contain optional audio placeholders without any user audio
  // mapping. "None" is not an audio file: omit only these explicit empty
  // sources, while retaining every nonempty fixed reference and unknown path.
  if (mapping.h3ReferenceSelection !== 'workflow-defaults') {
    for (const node of Object.values(nodes)) {
      if (node.class_type !== 'MiniMaxH3ReferenceToVideo'
        || node.inputs.ref_audios !== undefined && !record(node.inputs.ref_audios)) continue;
      const fields: Array<[Record<string, unknown>, string]> = Object.keys(node.inputs)
        .filter((name) => /^ref_audios\.ref_audio_\d+$/u.test(name))
        .map((name): [Record<string, unknown>, string] => [node.inputs, name]);
      if (record(node.inputs.ref_audios)) {
        fields.push(...Object.keys(node.inputs.ref_audios).filter((name) => /^ref_audio_\d+$/u.test(name))
          .map((name): [Record<string, unknown>, string] => [node.inputs.ref_audios as Record<string, unknown>, name]));
      }
      for (const [inputs, name] of fields) {
        const value = inputs[name];
        const sourceId = connection(value);
        const source = sourceId ? nodes[sourceId] : undefined;
        if (!sourceId || !Array.isArray(value) || value[1] !== 0 || source?.class_type !== 'LoadAudio'
          || typeof source.inputs.audio !== 'string' || !/^(?:none|null)?$/iu.test(source.inputs.audio.trim())) continue;
        delete inputs[name]; detached.add(sourceId);
      }
    }
  }
  // Remove only newly detached media operations. Count consumers across the
  // whole graph so MASK users and additional outputs keep their dependencies.
  const detachableOperations = new Set(['LoadImage', 'LoadAudio', 'ImageScale', 'ImageScaleBy', 'ImageCrop', 'ImagePadForOutpaint',
    'ImageInvert', 'ImageFlip', 'Reroute']);
  const consumers = new Map<string, number>();
  Object.values(nodes).forEach((node) => Object.values(node.inputs).forEach((value) =>
    eachConnection(value, (id) => consumers.set(id, (consumers.get(id) || 0) + 1))));
  const pending = [...detached];
  while (pending.length) {
    const nodeId = pending.pop()!;
    const node = nodes[nodeId];
    if (!node || consumers.get(nodeId) || !detachableOperations.has(node.class_type)) continue;
    delete nodes[nodeId];
    Object.values(node.inputs).forEach((value) => eachConnection(value, (parent) => {
      consumers.set(parent, (consumers.get(parent) || 0) - 1);
      pending.push(parent);
    }));
  }
};

export const bindComfyVideoWorkflow = (
  preset: Pick<ComfyVideoWorkflowPreset, 'workflowJson' | 'mapping'>,
  prompt: string,
  uploadedImages: string[],
  parameters: Record<string, unknown> = {},
  references?: readonly VideoImageReference[],
  uploadedVideos: string[] = [],
  videoReferences?: readonly import('./videoMotionTypes').VideoMotionReference[],
): ComfyVideoNodeMap => {
  const nodes = structuredClone(parseComfyVideoWorkflow(preset.workflowJson));
  if (!preset.mapping.prompt.length) throw new Error('请绑定视频工作流的提示词输入节点。');
  if (uploadedImages.length > preset.mapping.images.length) throw new Error(`工作流只有 ${preset.mapping.images.length} 个图片输入，已选择 ${uploadedImages.length} 张；请调整选图或映射，不会丢弃图片。`);
  if (references) {
    if (references.length !== uploadedImages.length) throw new Error('参考图数量与已上传图片数量不一致；不会丢弃图片或改变槽位。');
    assertVideoReferenceSlots(references, preset.mapping.images.length);
  }
  const set = (binding: ComfyVideoInputBinding, value: unknown) => {
    const node = nodes[binding.nodeId];
    if (!node || !(binding.inputName in node.inputs)) throw new Error(`工作流映射不存在：${binding.nodeId}.${binding.inputName}`);
    if (connection(node.inputs[binding.inputName])) throw new Error(`映射 ${binding.nodeId}.${binding.inputName} 是节点连线，请绑定实际输入节点，避免破坏工作流。`);
    node.inputs[binding.inputName] = value;
  };
  preset.mapping.prompt.forEach((binding) => set(binding, prompt));
  // Uploads remain dense for resumable task journals. Only this boundary maps
  // each uploaded value to its stable physical workflow slot.
  uploadedImages.forEach((name, index) => set(preset.mapping.images[references ? videoReferenceSlotIndex(references[index], index) : index], name));
  uploadedVideos.forEach((name, index) => {
    const binding = preset.mapping.videos?.[videoReferences?.[index]?.slotIndex ?? index];
    if (binding) set(binding, name);
  });
  const parameterBindings = effectiveComfyVideoParameterBindings(preset);
  Object.entries(parameters).forEach(([name, value]) => {
    if (value === undefined || value === null || value === '') return;
    const binding = parameterBindings[name];
    if (!binding) throw new Error(`参数“${name}”尚未绑定工作流输入；没有自动改变工作流参数。`);
    set(binding, value);
  });
  omitUnusedH3ReferenceInputs(nodes, preset.mapping,
    uploadedImages.map((_, index) => references ? videoReferenceSlotIndex(references[index], index) : index));
  return nodes;
};

export interface ComfyVideoOutput { nodeId: string; filename: string; subfolder: string; type: string; format?: string; url: string }
export const collectComfyVideoOutputs = (historyEntry: unknown, baseUrl: string, outputNodeId?: string): ComfyVideoOutput[] => {
  const outputs = record(historyEntry) && record(historyEntry.outputs) ? historyEntry.outputs : {};
  const result: ComfyVideoOutput[] = [];
  for (const [nodeId, raw] of Object.entries(outputs)) {
    if (!record(raw) || (outputNodeId && nodeId !== outputNodeId)) continue;
    // VHS calls its MP4 list "gifs"; images occasionally carries video outputs too.
    for (const field of ['videos', 'gifs', 'images']) {
      const files = raw[field];
      if (!Array.isArray(files)) continue;
      for (const item of files) {
        if (!record(item) || typeof item.filename !== 'string') continue;
        if (/\.(?:webp|gif|png|jpe?g|avif)$/iu.test(item.filename)) continue;
        if (!/\.(?:mp4|webm|mov|mkv|m4v|avi)$/iu.test(item.filename) && !/^video\//iu.test(String(item.format || ''))) continue;
        const file = { nodeId, filename: item.filename, subfolder: String(item.subfolder || ''), type: String(item.type || 'output'), format: typeof item.format === 'string' ? item.format : undefined };
        const url = new URL(`${baseUrl.replace(/\/+$/u, '')}/view`);
        url.search = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type }).toString();
        if (!result.some((existing) => existing.url === url.href)) result.push({ ...file, url: url.href });
      }
    }
  }
  return result.sort((a, b) => Number(/-audio\./iu.test(b.filename)) - Number(/-audio\./iu.test(a.filename)));
};

/** A saved video binding is authoritative. Only an unambiguously identified
 * image-preview binding from older imports may recover to one video node. */
export const resolveComfyVideoOutputs = (
  historyEntry: unknown,
  baseUrl: string,
  workflow?: Pick<ComfyVideoWorkflowPreset, 'workflowJson' | 'mapping'>,
): { outputs: ComfyVideoOutput[]; warning?: string; issue?: string } => {
  const outputNodeId = workflow?.mapping.outputNodeId;
  const boundOutputs = collectComfyVideoOutputs(historyEntry, baseUrl, outputNodeId);
  if (outputNodeId && boundOutputs.length) return { outputs: boundOutputs };
  const outputs = outputNodeId ? collectComfyVideoOutputs(historyEntry, baseUrl) : boundOutputs;
  // Pending jobs normally have no outputs. Do not repeatedly parse a possibly
  // large frozen workflow on every progress poll just to rediscover that fact.
  if (!outputs.length) return { outputs: [] };
  let previewBinding = false;
  if (outputNodeId) {
    try {
      const node = workflow && parseComfyVideoWorkflow(workflow.workflowJson)[outputNodeId];
      previewBinding = Boolean(node && isPreviewOutputNode(node));
    } catch { /* An unreadable old snapshot cannot authorize another output. */ }
    if (!previewBinding) return { outputs: [] };
  }
  const videoNodes = [...new Set(outputs.map((file) => file.nodeId))];
  if (videoNodes.length > 1) return {
    outputs: [],
    issue: `工作流已完成，但${previewBinding ? `原绑定节点 ${outputNodeId} 是图片/动图预览，且` : ''}有多个视频输出节点（${videoNodes.join('、')}）；未擅自选择。请检查 ComfyUI 中的原任务输出并明确最终节点；不会自动重新生成。`,
  };
  if (previewBinding && outputs.length) return {
    outputs,
    warning: `原绑定节点 ${outputNodeId} 是图片/动图预览；已接收唯一视频输出节点 ${videoNodes[0]}，没有重新生成或修改工作流。`,
  };
  return { outputs };
};

/** Expose query-only recovery for the old preview-node failure, not arbitrary
 * failed submissions. The engine still rechecks the original remote history. */
export const canRecoverComfyPreviewResult = (task: VideoGenerationTask): boolean => {
  const job = task.videoJob;
  const source = job?.snapshot.connection;
  if (!job || source?.backend !== 'comfyui' || !source.workflow || !source.comfyui?.baseUrl || !task.remoteTaskId?.trim()
    || task.resultUrl || task.resultAssetId || job.resultAssetIds?.length
    || task.status !== 'failed' && job.stage !== 'failed'
    || job.cancellationPending || job.batchQueueState === 'cancelled' || job.tailPreparation?.phase === 'cancelled') return false;
  const status = record(task.response) && record(task.response.status) ? task.response.status : undefined;
  if (status?.completed !== true || status.status_str !== 'success') return false;
  try {
    const resolved = resolveComfyVideoOutputs(task.response, source.comfyui.baseUrl, source.workflow);
    return Boolean(resolved.warning && resolved.outputs.length);
  } catch { return false; }
};

export const mapComfyVideoProgress = (message: unknown, promptId: string, nodeNames: Record<string, string> = {}): Partial<VideoGenerationRuntime> | null => {
  if (!record(message) || !record(message.data)) return null;
  const data = message.data;
  // Old progress events without prompt_id are safe only on our unique client WS; caller owns that socket.
  if (data.prompt_id && String(data.prompt_id) !== promptId) return null;
  if (message.type === 'progress' && Number(data.max) > 0) return { stage: 'running', step: Number(data.value), totalSteps: Number(data.max), progress: undefined, message: `当前节点采样 ${data.value}/${data.max} 步` };
  if (message.type === 'executing' && data.node != null) {
    const nodeId = String(data.node);
    return { stage: 'running', nodeId, step: undefined, totalSteps: undefined, progress: undefined, message: `正在执行：${nodeNames[nodeId] || nodeId}` };
  }
  if (message.type === 'execution_start') return {
    stage: 'running',
    message: '工作流开始执行',
    ...(() => {
      const startedAt = comfyTimestampMilliseconds(data.timestamp);
      return startedAt ? { startedAt } : {};
    })(),
  };
  if (message.type === 'execution_error') return { stage: 'failed', message: String(data.exception_message || 'ComfyUI 执行失败') };
  if (message.type === 'execution_interrupted') return { stage: 'failed', message: 'ComfyUI 服务端已停止此任务' };
  return null;
};
