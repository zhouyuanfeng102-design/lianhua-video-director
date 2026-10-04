import assert from 'node:assert/strict';
import type { ImageApiConfig } from '../src/types';

type ComfyModule = {
  buildComfyUIWorkflow?: (
    workflowJson: string,
    input: {
      prompt: string;
      negativePrompt: string;
      width: number;
      height: number;
      seed?: number;
    },
  ) => Record<string, unknown>;
  bindComfyUIReferenceImages?: (
    workflow: Record<string, unknown>,
    referenceImageNames: readonly string[],
    options?: { primaryReferenceImageCount?: number },
  ) => Record<string, unknown>;
  assertComfyUIWorkflowCanBindReferenceImages?: (
    workflowJson: string,
    requiredPrimaryReferenceImageCount?: number,
  ) => {
    referenceImageCount: number;
    requiredPrimaryReferenceImageCount: number;
  };
  importComfyUIApiWorkflow?: (text: string) => {
    workflowJson: string;
    positiveCount: number;
    negativeCount: number;
    widthCount: number;
    heightCount: number;
    referenceImageCount: number;
  };
  normalizeComfyUIImageConfig?: <T extends ImageApiConfig>(config: T, now?: number) => T;
  synchronizeComfyUIWorkflows?: (
    workflows: Array<{
      id: string;
      name: string;
      workflowJson: string;
      createdAt: number;
      updatedAt: number;
    }>,
    activeId?: string,
  ) => {
    comfyuiWorkflows: Array<{
      id: string;
      name: string;
      workflowJson: string;
      createdAt: number;
      updatedAt: number;
    }>;
    activeComfyuiWorkflowId: string;
    workflowJson: string;
  };
};

const modulePath = '../src/' + 'comfyui';
const comfy = await import(modulePath).catch(() => ({})) as ComfyModule;

assert.equal(
  typeof comfy.importComfyUIApiWorkflow,
  'function',
  'ComfyUI needs a real API-workflow importer instead of a dormant workflowJson field',
);
assert.equal(typeof comfy.buildComfyUIWorkflow, 'function');
assert.equal(typeof comfy.bindComfyUIReferenceImages, 'function');
assert.equal(typeof comfy.assertComfyUIWorkflowCanBindReferenceImages, 'function');
assert.equal(typeof comfy.normalizeComfyUIImageConfig, 'function');
assert.equal(typeof comfy.synchronizeComfyUIWorkflows, 'function');

const apiWorkflow = {
  1: {
    inputs: { text: 'original positive' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Positive Prompt' },
  },
  2: {
    inputs: { text: 'original negative' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Negative Prompt' },
  },
  3: {
    inputs: { width: 512, height: 768, batch_size: 1 },
    class_type: 'EmptyLatentImage',
  },
  4: {
    inputs: {
      positive: ['1', 0],
      negative: ['2', 0],
      latent_image: ['3', 0],
      seed: 9,
      steps: 20,
      cfg: 5.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
    },
    class_type: 'KSampler',
  },
  5: {
    inputs: {
      sampler: ['sampler-provider', 0],
      scheduler: ['scheduler-provider', 0],
      seed: ['seed-provider', 0],
      width: ['width-provider', 0],
      height: ['height-provider', 0],
    },
    class_type: 'SamplerCustomAdvanced',
  },
};

const imported = comfy.importComfyUIApiWorkflow!(JSON.stringify({ prompt: apiWorkflow }));
const importedWorkflow = JSON.parse(imported.workflowJson) as Record<string, any>;
assert.equal(imported.positiveCount, 1);
assert.equal(imported.negativeCount, 1);
assert.equal(imported.widthCount, 1);
assert.equal(imported.heightCount, 1);
assert.equal(imported.referenceImageCount, 0);
assert.equal(importedWorkflow['1'].inputs.text, '__PROMPT__');
assert.equal(importedWorkflow['2'].inputs.text, '__NEGATIVE_PROMPT__');
assert.equal(importedWorkflow['3'].inputs.width, '__WIDTH__');
assert.equal(importedWorkflow['3'].inputs.height, '__HEIGHT__');
assert.equal(importedWorkflow['4'].inputs.seed, 9);
assert.equal(importedWorkflow['4'].inputs.steps, 20);
assert.equal(importedWorkflow['4'].inputs.cfg, 5.5);
assert.equal(importedWorkflow['4'].inputs.sampler_name, 'dpmpp_2m');
assert.equal(
  importedWorkflow['4'].inputs.scheduler,
  'karras',
  '自动导入不能覆盖用户工作流原有的精调采样参数；只有显式占位符才允许运行时替换',
);
assert.deepEqual(
  importedWorkflow['5'].inputs.width,
  ['width-provider', 0],
  '连接到其他节点的尺寸输入不能被自动占位符覆盖',
);
assert.deepEqual(importedWorkflow['5'].inputs.height, ['height-provider', 0]);
assert.deepEqual(
  importedWorkflow['5'].inputs.sampler,
  ['sampler-provider', 0],
  '连接到其他节点的采样器输入不能被自动占位符覆盖',
);
assert.deepEqual(importedWorkflow['5'].inputs.scheduler, ['scheduler-provider', 0]);
assert.deepEqual(importedWorkflow['5'].inputs.seed, ['seed-provider', 0]);

assert.throws(
  () => comfy.importComfyUIApiWorkflow!(JSON.stringify({ nodes: [{ id: 1, type: 'CLIPTextEncode' }] })),
  /API workflow|正面提示词/u,
  'the regular canvas workflow format must not be accepted as an executable API workflow',
);

const built = comfy.buildComfyUIWorkflow!(imported.workflowJson, {
  prompt: '莲花剑客站在雨中',
  negativePrompt: '文字，水印',
  width: 1280,
  height: 720,
  seed: 12345,
}) as Record<string, any>;
assert.equal(built['1'].inputs.text, '莲花剑客站在雨中');
assert.equal(built['2'].inputs.text, '文字，水印');
assert.equal(built['3'].inputs.width, 1280);
assert.equal(built['3'].inputs.height, 720);

const builtFromRawPaste = comfy.buildComfyUIWorkflow!(JSON.stringify(apiWorkflow), {
  prompt: '当前莲华任务提示词',
  negativePrompt: '当前负面提示词',
  width: 960,
  height: 544,
  seed: 6789,
}) as Record<string, any>;
assert.equal(
  builtFromRawPaste['1'].inputs.text,
  '当前莲华任务提示词',
  '直接粘贴原始 API workflow 时，生成前也必须自动替换旧正面提示词',
);
assert.equal(builtFromRawPaste['2'].inputs.text, '当前负面提示词');
assert.equal(builtFromRawPaste['3'].inputs.width, 960);
assert.equal(builtFromRawPaste['3'].inputs.height, 544);
assert.equal(builtFromRawPaste['4'].inputs.seed, 9);
assert.equal(builtFromRawPaste['4'].inputs.steps, 20);
assert.equal(builtFromRawPaste['4'].inputs.cfg, 5.5);
assert.equal(builtFromRawPaste['4'].inputs.sampler_name, 'dpmpp_2m');
assert.equal(builtFromRawPaste['4'].inputs.scheduler, 'karras');

const customPlaceholderWorkflow = JSON.stringify({
  custom: {
    inputs: {
      prompt: '自定义节点::__PROMPT__',
      negative_prompt: '__NEGATIVE_PROMPT__',
      sampler: ['sampler-provider', 0],
    },
    class_type: 'CustomConditioningNode',
  },
});
const builtFromCustomPlaceholders = comfy.buildComfyUIWorkflow!(customPlaceholderWorkflow, {
  prompt: '保留自定义节点的当前提示词',
  negativePrompt: '只注入一次的负面词',
  width: 1024,
  height: 576,
}) as Record<string, any>;
assert.equal(
  builtFromCustomPlaceholders.custom.inputs.prompt,
  '自定义节点::保留自定义节点的当前提示词',
  '非 inputs.text 字段中的既有提示词占位符也必须继续可用',
);
assert.equal(builtFromCustomPlaceholders.custom.inputs.negative_prompt, '只注入一次的负面词');
assert.doesNotMatch(builtFromCustomPlaceholders.custom.inputs.prompt, /Negative prompt:/u);
assert.deepEqual(builtFromCustomPlaceholders.custom.inputs.sampler, ['sampler-provider', 0]);

const referenceWorkflow = {
  load: {
    inputs: { image: 'old-input.png', upload: 'image' },
    class_type: 'LoadImage',
    _meta: { title: 'IPAdapter 角色与画风参考图' },
  },
  adapter: {
    inputs: { image: ['load', 0] },
    class_type: 'IPAdapterAdvanced',
  },
  output: {
    inputs: { images: ['adapter', 0] },
    class_type: 'SaveImage',
  },
  unused: {
    inputs: { image: 'unrelated.png', upload: 'image' },
    class_type: 'LoadImage',
  },
};
const importedReferenceWorkflow = comfy.importComfyUIApiWorkflow!(JSON.stringify({
  ...referenceWorkflow,
  positive: {
    inputs: { text: '正面提示词' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Positive Prompt' },
  },
}));
assert.equal(importedReferenceWorkflow.referenceImageCount, 1);
const boundReferenceWorkflow = comfy.bindComfyUIReferenceImages!(
  referenceWorkflow,
  ['lianhua/input/shot-10.png'],
) as Record<string, any>;
assert.equal(boundReferenceWorkflow.load.inputs.image, 'lianhua/input/shot-10.png');
assert.equal(
  boundReferenceWorkflow.unused.inputs.image,
  'unrelated.png',
  'disconnected LoadImage nodes must not be treated as effective reference inputs',
);
assert.equal(referenceWorkflow.load.inputs.image, 'old-input.png', 'stored workflow must remain immutable');
assert.deepEqual(
  comfy.assertComfyUIWorkflowCanBindReferenceImages!(JSON.stringify(referenceWorkflow), 1),
  { referenceImageCount: 1, requiredPrimaryReferenceImageCount: 1 },
  'grid storyboard preflight must recognize a connected LoadImage before any upload or task creation',
);

const explicitReferenceWorkflow = {
  first: {
    inputs: { image: '__REFERENCE_IMAGE_1__' },
    class_type: 'CustomReferenceLoader',
  },
  second: {
    inputs: { image: '{{reference_image_2}}' },
    class_type: 'CustomReferenceLoader',
  },
  firstAdapter: {
    inputs: { image: ['first', 0] },
    class_type: 'IPAdapterAdvanced',
  },
  secondAdapter: {
    inputs: { image: ['second', 0], model: ['firstAdapter', 0] },
    class_type: 'IPAdapterAdvanced',
  },
  sampler: {
    inputs: { model: ['secondAdapter', 0] },
    class_type: 'KSampler',
  },
  output: {
    inputs: { images: ['sampler', 0] },
    class_type: 'SaveImage',
  },
};
const boundExplicitReferences = comfy.bindComfyUIReferenceImages!(
  explicitReferenceWorkflow,
  ['first.png', 'second.webp'],
) as Record<string, any>;
assert.equal(boundExplicitReferences.first.inputs.image, 'first.png');
assert.equal(boundExplicitReferences.second.inputs.image, 'second.webp');
assert.deepEqual(
  comfy.assertComfyUIWorkflowCanBindReferenceImages!(JSON.stringify(explicitReferenceWorkflow), 1),
  { referenceImageCount: 2, requiredPrimaryReferenceImageCount: 1 },
  'numbered custom reference placeholders must pass preflight when their first slot reaches generation output',
);
const primaryWithSupplemental = comfy.bindComfyUIReferenceImages!(
  referenceWorkflow,
  ['global-shot-10.png', 'inferred-character.png'],
  { primaryReferenceImageCount: 1 },
) as Record<string, any>;
assert.equal(
  primaryWithSupplemental.load.inputs.image,
  'global-shot-10.png',
  'a single-slot workflow must keep the explicit global reference and may omit inferred supplemental images',
);
assert.throws(
  () => comfy.bindComfyUIReferenceImages!(referenceWorkflow, ['one.png', 'two.png']),
  /只有 1 个可用参考图节点/u,
  'a workflow must never silently drop selected reference images',
);
assert.throws(
  () => comfy.bindComfyUIReferenceImages!({
    load: { inputs: { image: 'unused.png' }, class_type: 'LoadImage' },
  }, ['shot-10.png']),
  /没有连接到输出的 LoadImage/u,
  'a disconnected LoadImage cannot claim that the selected image affects generation',
);
const textOnlyWorkflow = {
  positive: { inputs: { text: '__PROMPT__' }, class_type: 'CLIPTextEncode' },
  sampler: { inputs: { positive: ['positive', 0] }, class_type: 'KSampler' },
  output: { inputs: { images: ['sampler', 0] }, class_type: 'SaveImage' },
};
const textOnlyWithSupplementalReferences = comfy.bindComfyUIReferenceImages!(
  textOnlyWorkflow,
  ['inferred-character.png', 'inferred-location.png'],
  { primaryReferenceImageCount: 0 },
);
assert.deepEqual(
  textOnlyWithSupplementalReferences,
  textOnlyWorkflow,
  'a text-only workflow may omit inferred supplemental references and continue as text-to-image',
);
assert.throws(
  () => comfy.bindComfyUIReferenceImages!(
    textOnlyWorkflow,
    ['explicit-global-reference.png'],
    { primaryReferenceImageCount: 1 },
  ),
  /没有连接到输出的 LoadImage/u,
  'an explicitly selected primary reference must still fail when the workflow cannot consume it',
);
assert.throws(
  () => comfy.assertComfyUIWorkflowCanBindReferenceImages!(JSON.stringify(textOnlyWorkflow), 1),
  /没有连接到输出的 LoadImage/u,
  'grid storyboard preflight must reject a text-only workflow before any reference upload',
);
assert.throws(
  () => comfy.assertComfyUIWorkflowCanBindReferenceImages!(JSON.stringify({
    load: { inputs: { image: 'unused-grid.png' }, class_type: 'LoadImage' },
    output: { inputs: { images: ['load', 0] }, class_type: 'PreviewImage' },
  }), 1),
  /没有连接到输出的 LoadImage/u,
  'a preview-only LoadImage must not make the nine-grid preflight look ready',
);
assert.throws(
  () => comfy.bindComfyUIReferenceImages!({
    load: { inputs: { image: '__REFERENCE_IMAGE_1__' }, class_type: 'CustomReferenceLoader' },
    note: { inputs: { text: 'not connected' }, class_type: 'Note' },
  }, ['shot-10.png']),
  /占位节点未接入实际生成链/u,
  'an explicit placeholder cannot bypass graph connectivity validation',
);
assert.throws(
  () => comfy.bindComfyUIReferenceImages!({
    load: { inputs: { image: 'preview-only.png' }, class_type: 'LoadImage' },
    preview: { inputs: { images: ['load', 0] }, class_type: 'PreviewImage' },
  }, ['shot-10.png']),
  /没有连接到输出的 LoadImage/u,
  'LoadImage routed only to PreviewImage must not pretend to influence generation',
);

const threeReferenceSlots = {
  load1: { inputs: { image: 'old-1.png' }, class_type: 'LoadImage', _meta: { title: '参考图 1' } },
  load2: { inputs: { image: 'old-2.png' }, class_type: 'LoadImage', _meta: { title: '参考图 2' } },
  load3: { inputs: { image: 'old-3.png' }, class_type: 'LoadImage', _meta: { title: '参考图 3' } },
  adapter1: { inputs: { image: ['load1', 0] }, class_type: 'IPAdapterAdvanced' },
  adapter2: { inputs: { image: ['load2', 0] }, class_type: 'IPAdapterAdvanced' },
  adapter3: { inputs: { image: ['load3', 0] }, class_type: 'IPAdapterAdvanced' },
  sampler: {
    inputs: { model_1: ['adapter1', 0], model_2: ['adapter2', 0], model_3: ['adapter3', 0] },
    class_type: 'KSampler',
  },
  output: { inputs: { images: ['sampler', 0] }, class_type: 'SaveImage' },
};
const filledReferenceSlots = comfy.bindComfyUIReferenceImages!(
  threeReferenceSlots,
  ['global.png', 'supplemental.png'],
  { primaryReferenceImageCount: 1 },
) as Record<string, any>;
assert.deepEqual(
  [
    filledReferenceSlots.load1.inputs.image,
    filledReferenceSlots.load2.inputs.image,
    filledReferenceSlots.load3.inputs.image,
  ],
  ['global.png', 'supplemental.png', 'global.png'],
  'every selected reference slot must be overwritten so no stale workflow image leaks into generation',
);

const metadataTokenWorkflow = JSON.parse(JSON.stringify(referenceWorkflow)) as Record<string, any>;
metadataTokenWorkflow.unused._meta = { title: '__REFERENCE_IMAGE_1__ documentation only' };
const metadataTokenBound = comfy.bindComfyUIReferenceImages!(metadataTokenWorkflow, ['global.png']) as Record<string, any>;
assert.equal(metadataTokenBound.load.inputs.image, 'global.png');
assert.equal(metadataTokenBound.unused.inputs.image, 'unrelated.png');

const legacyConfig = comfy.normalizeComfyUIImageConfig!({
  enabled: true,
  backend: 'comfyui',
  baseUrl: 'http://127.0.0.1:8188',
  apiKey: '',
  model: '',
  workflowJson: imported.workflowJson,
} as ImageApiConfig, 100);
assert.equal(legacyConfig.comfyuiWorkflows?.length, 1);
assert.equal(legacyConfig.comfyuiWorkflows?.[0]?.workflowJson, imported.workflowJson);
assert.equal(legacyConfig.activeComfyuiWorkflowId, legacyConfig.comfyuiWorkflows?.[0]?.id);
assert.equal(legacyConfig.comfyuiPathMode, 'preset');
assert.equal(legacyConfig.comfyuiPromptPath, '/prompt');

const switched = comfy.synchronizeComfyUIWorkflows!([
  { id: 'wf-a', name: '角色图', workflowJson: '{"a":1}', createdAt: 1, updatedAt: 1 },
  { id: 'wf-b', name: '场景图', workflowJson: '{"b":2}', createdAt: 2, updatedAt: 2 },
], 'wf-b');
assert.equal(switched.activeComfyuiWorkflowId, 'wf-b');
assert.equal(switched.workflowJson, '{"b":2}');

console.log('ComfyUI workflow import, migration, switching, and placeholder checks passed');
