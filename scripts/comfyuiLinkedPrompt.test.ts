import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildComfyUIWorkflow, importComfyUIApiWorkflow } from '../src/comfyui';

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;
const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
// Neutral strings, with the same 46-node, three-sampler wiring as the reported
// cloud API graph. No private model instructions or user prompts are copied.
const fixture = (): Graph => ({
  '2': node('ModelSamplingAuraFlow', { shift: 3, sampling: 'distilled', model: ['108', 0] }),
  '4': node('VAEDecode', { samples: ['13', 0], vae: ['105', 0] }),
  '5': node('CLIPTextEncode', { text: ['114', 0], clip: ['106', 0] }),
  '7': node('CLIPTextEncode', { text: 'synthetic original negative', clip: ['106', 0] }),
  '10': node('EmptyLatentImage', { width: ['95', 0], height: ['96', 0], batch_size: 1 }),
  '12': node('KSamplerAdvanced', { add_noise: 'enable', noise_seed: 529001788019138, steps: ['17', 0], cfg: 2,
    sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: ['18', 0], return_with_leftover_noise: 'enable',
    model: ['2', 0], positive: ['5', 0], negative: ['7', 0], latent_image: ['10', 0] }),
  '13': node('KSamplerAdvanced', { add_noise: 'disable', noise_seed: 583518668123968, steps: ['17', 0], cfg: 1,
    sampler_name: 'euler', scheduler: 'simple', start_at_step: ['18', 0], end_at_step: 10000, return_with_leftover_noise: 'disable',
    model: ['19', 0], positive: ['5', 0], negative: ['16', 0], latent_image: ['12', 0] }),
  '16': node('ConditioningZeroOut', { conditioning: ['7', 0] }),
  '17': node('Int', { value: 12 }), '18': node('Int', { value: 4 }),
  '19': node('ModelSamplingAuraFlow', { shift: 3, sampling: 'distilled', model: ['107', 0] }),
  '35': node('SaveImage', { filename_prefix: 'fixture', images: ['4', 0] }),
  '46': node('PreviewImage', { images: ['65', 0] }),
  '47': node('KSamplerSelect', { sampler_name: 'euler' }),
  '48': node('SamplerCustomAdvanced', { noise: ['50', 0], guider: ['52', 0], sampler: ['47', 0], sigmas: ['53', 0], latent_image: ['59', 0] }),
  '49': node('VAEDecode', { samples: ['48', 0], vae: ['51', 0] }),
  '50': node('RandomNoise', { noise_seed: 604930210791702 }),
  '51': node('VAELoader', { vae_name: 'synthetic-refiner-vae' }),
  '52': node('CFGGuider', { cfg: 1, model: ['63', 0], positive: ['60', 0], negative: ['61', 0] }),
  '53': node('Flux2Scheduler', { steps: 4, width: ['58', 0], height: ['58', 1] }),
  '54': node('CLIPTextEncode', { text: '4k，高清', clip: ['62', 0] }),
  '55': node('ConditioningZeroOut', { conditioning: ['54', 0] }),
  '56': node('ImageScaleToTotalPixels', { upscale_method: 'lanczos', megapixels: 4, resolution_steps: 1, image: ['69', 0] }),
  '57': node('VAEEncode', { pixels: ['56', 0], vae: ['51', 0] }),
  '58': node('GetImageSize', { image: ['56', 0] }),
  '59': node('EmptyFlux2LatentImage', { width: ['58', 0], height: ['58', 1], batch_size: 1 }),
  '60': node('ReferenceLatent', { conditioning: ['54', 0], latent: ['57', 0] }),
  '61': node('ReferenceLatent', { conditioning: ['55', 0], latent: ['57', 0] }),
  '62': node('CLIPLoader', { clip_name: 'synthetic-refiner-clip', type: 'flux2', device: 'default' }),
  '63': node('UNETLoader', { unet_name: 'synthetic-refiner-model', weight_dtype: 'default' }),
  '64': node('ColorMatch', { method: 'mkl', strength: 1, multithread: true, image_ref: ['4', 0], image_target: ['49', 0] }),
  '65': node('ImageSharpen', { sharpen_radius: 1, sigma: 0.35, alpha: 0.35, image: ['64', 0] }),
  '69': node('LayerUtility: PurgeVRAM V2', { purge_cache: true, purge_models: true, anything: ['4', 0] }),
  '78': node('SaveImage', { filename_prefix: 'fixture', images: ['65', 0] }),
  '95': node('INTConstant', { value: 1920 }), '96': node('INTConstant', { value: 1280 }),
  '105': node('VAELoader', { vae_name: 'synthetic-primary-vae' }),
  '106': node('CLIPLoader', { clip_name: 'synthetic-primary-clip', type: 'flux', device: 'default' }),
  '107': node('UNETLoader', { unet_name: 'synthetic-second-model', weight_dtype: 'default' }),
  '108': node('UNETLoader', { unet_name: 'synthetic-first-model', weight_dtype: 'default' }),
  '109': node('CR Prompt Text', { prompt: 'SYSTEM_ONLY: preserve these synthetic model instructions.' }),
  '114': node('PreviewAny', { preview: 'preview widget is not the business text', source: ['118', 0] }),
  '115': node('CR Prompt Text', { prompt: 'synthetic business text' }),
  '116': node('llama_cpp_model_loader', { model: 'synthetic-llama-model', mmproj: 'synthetic-mmproj', chat_handler: 'fixture',
    n_ctx: 8192, vram_limit: -1, image_min_tokens: 0, image_max_tokens: 0, load_mtp: false }),
  '117': node('llama_cpp_parameters', { max_tokens: 1024, top_k: 30, top_p: 0.9, min_p: 0.05, typical_p: 1,
    temperature: 0.8, repeat_penalty: 1, frequency_penalty: 0, present_penalty: 0, mirostat_mode: 0, mirostat_eta: 0.1, mirostat_tau: 5, state_uid: -1 }),
  '118': node('llama_cpp_instruct_adv', { preset_prompt: 'Normal - Describe', custom_prompt: ['115', 0], system_prompt: ['109', 0],
    inference_mode: 'one by one', max_frames: 24, max_size: 256, seed: 844371135361186, force_offload: true, save_states: false,
    llama_model: ['116', 0], parameters: ['117', 0] }),
});
const input = { prompt: 'current business prompt', negativePrompt: 'current negative', width: 1024, height: 1024, seed: 10 };
const expectedGraph = (graph: Graph, positive: string, negative: string): Graph => {
  const expected = structuredClone(graph);
  expected['115'].inputs.prompt = positive;
  expected['7'].inputs.text = negative;
  return expected;
};
let checks = 0;
const test = (name: string, run: () => void) => { run(); checks += 1; console.log(`PASS ${name}`); };

test('linked LLM business source imports once while all 46 nodes and system/refinement controls remain intact', () => {
  const graph = fixture();
  assert.equal(Object.keys(graph).length, 46);
  const original = structuredClone(graph);
  const imported = importComfyUIApiWorkflow(JSON.stringify(graph));
  assert.equal(imported.positiveCount, 1);
  assert.equal(imported.negativeCount, 1);
  assert.deepEqual(JSON.parse(imported.workflowJson), expectedGraph(graph, '__PROMPT__', '__NEGATIVE_PROMPT__'));
  assert.deepEqual(graph, original);
  assert.equal(importComfyUIApiWorkflow(imported.workflowJson).workflowJson, imported.workflowJson, 'a second import does not bind the fixed refiner');
});

test('raw paste and imported template generate the same graph without changing preprocessing, connections or sampler choices', () => {
  const graph = fixture();
  const raw = JSON.stringify(graph);
  const imported = importComfyUIApiWorkflow(raw);
  const expected = expectedGraph(graph, input.prompt, input.negativePrompt);
  assert.deepEqual(buildComfyUIWorkflow(raw, input), expected);
  assert.deepEqual(buildComfyUIWorkflow(imported.workflowJson, input), expected);
  assert.deepEqual(buildComfyUIWorkflow(imported.workflowJson, { ...input, promptMode: 'verbatim' }), expectedGraph(graph, input.prompt, ''));
  assert.equal(graph['54'].inputs.text, '4k，高清');
});

test('explicit business placeholders preserve their authored text and never expand binding to other encoders', () => {
  const graph = fixture();
  graph['115'].inputs.prompt = 'authored prefix {{prompt}} authored suffix';
  const imported = importComfyUIApiWorkflow(JSON.stringify(graph));
  assert.equal(imported.positiveCount, 1);
  assert.equal(imported.negativeCount, 1);
  assert.deepEqual(JSON.parse(imported.workflowJson), expectedGraph(graph, graph['115'].inputs.prompt as string, '__NEGATIVE_PROMPT__'));
  assert.deepEqual(buildComfyUIWorkflow(imported.workflowJson, input), expectedGraph(graph,
    `authored prefix ${input.prompt} authored suffix`, input.negativePrompt));
});

test('zero-out negative conditioning never rewrites the shared positive source', () => {
  const graph: Graph = {
    p: node('CLIPTextEncode', { text: 'positive business text' }),
    zero: node('ConditioningZeroOut', { conditioning: ['p', 0] }),
    sampler: node('KSampler', { positive: ['p', 0], negative: ['zero', 0] }),
  };
  const imported = importComfyUIApiWorkflow(JSON.stringify(graph));
  assert.equal(imported.positiveCount, 1);
  assert.equal(imported.negativeCount, 0);
  assert.equal(JSON.parse(imported.workflowJson).p.inputs.text, '__PROMPT__');
  assert.deepEqual(JSON.parse(imported.workflowJson).zero, graph.zero);
});

test('safe primitive strings and direct LLM custom text bind only the actual encoder text route', () => {
  for (const [type, field] of [['PrimitiveString', 'value'], ['PrimitiveStringMultiline', 'value'], ['String', 'string'], ['CR Prompt Text', 'prompt']]) {
    const graph: Graph = {
      source: node(type, { [field]: 'business string' }),
      encoder: node('CLIPTextEncode', { text: ['source', 0], clip: ['model', 0] }),
      model: node('CLIPLoader', { clip_name: 'MODEL_ONLY' }),
      sampler: node('KSampler', { positive: ['encoder', 0] }),
    };
    const imported = JSON.parse(importComfyUIApiWorkflow(JSON.stringify(graph)).workflowJson);
    assert.equal(imported.source.inputs[field], '__PROMPT__');
    assert.deepEqual(imported.model, graph.model);
    assert.deepEqual(imported.encoder, graph.encoder);
  }
  const graph = fixture();
  graph['118'].inputs.custom_prompt = 'direct business string';
  const imported = JSON.parse(importComfyUIApiWorkflow(JSON.stringify(graph)).workflowJson);
  assert.equal(imported['118'].inputs.custom_prompt, '__PROMPT__');
  assert.deepEqual(imported['109'], graph['109']);
  assert.deepEqual(imported['115'], graph['115'], 'a disconnected string widget is left alone');
});

test('unknown string routes, system-only LLM inputs and wrong output ports fail closed instead of binding model/system text', () => {
  for (const change of [
    (graph: Graph) => { graph['115'].class_type = 'UnrecognizedStringNode'; },
    (graph: Graph) => { delete graph['118'].inputs.custom_prompt; },
    (graph: Graph) => { graph['114'].inputs.source = ['118', 1]; },
  ]) {
    const graph = fixture(); change(graph);
    const before = structuredClone(graph);
    assert.throws(() => importComfyUIApiWorkflow(JSON.stringify(graph)), /正面编码器.*文字来源.*__PROMPT__/u);
    assert.deepEqual(graph, before);
  }
});

// Optional real-file verification prints only boolean/count metadata. The
// original stays read-only, including on failure; no provider is contacted.
const suppliedPath = process.argv[2];
if (suppliedPath) test('supplied real API graph changes exactly business/negative text while its original file stays byte-identical', () => {
  const originalBytes = fs.readFileSync(suppliedPath);
  const graph = JSON.parse(originalBytes.toString('utf8')) as Graph;
  const imported = importComfyUIApiWorkflow(originalBytes.toString('utf8'));
  assert.equal(imported.positiveCount, 1);
  assert.equal(imported.negativeCount, 1);
  const importedGraph = JSON.parse(imported.workflowJson) as Graph;
  const built = buildComfyUIWorkflow(imported.workflowJson, input) as Graph;
  const rawBuilt = buildComfyUIWorkflow(originalBytes.toString('utf8'), input) as Graph;
  const expectedImport = expectedGraph(graph, '__PROMPT__', '__NEGATIVE_PROMPT__');
  const expectedBuilt = expectedGraph(graph, input.prompt, input.negativePrompt);
  assert.equal(Object.keys(importedGraph).length, Object.keys(graph).length);
  for (const id of Object.keys(graph)) {
    assert.equal(JSON.stringify(importedGraph[id]) === JSON.stringify(expectedImport[id]), true, `import preserves node ${id} except its authorized input`);
    assert.equal(JSON.stringify(built[id]) === JSON.stringify(expectedBuilt[id]), true, `template build preserves node ${id}`);
    assert.equal(JSON.stringify(rawBuilt[id]) === JSON.stringify(expectedBuilt[id]), true, `raw build preserves node ${id}`);
  }
  assert.equal(createHash('sha256').update(fs.readFileSync(suppliedPath)).digest('hex'), createHash('sha256').update(originalBytes).digest('hex'));
});
console.log(`ComfyUI linked prompt: ${checks} targeted offline checks passed; no provider requests.`);
