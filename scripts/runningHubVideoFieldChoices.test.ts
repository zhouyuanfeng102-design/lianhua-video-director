import assert from 'node:assert/strict';
import {
  classifyRunningHubVideoField, selectRunningHubVideoFieldChoices,
} from '../src/runningHubVideoFieldChoices';
import { listRunningHubVideoNodes } from '../src/runningHubVideoNodes';
import type {
  RunningHubVideoInputBinding, RunningHubVideoNodeCatalogEntry, RunningHubVideoNodeInfo,
} from '../src/runningHubVideoTypes';

let groups = 0;
const check = (name: string, run: () => void) => { run(); groups += 1; console.log(`PASS ${name}`); };
const field = (fieldName: string, fieldValue: unknown = '', description?: string, nodeId = '1'): RunningHubVideoNodeInfo => ({
  nodeId, fieldName, fieldValue, ...(description === undefined ? {} : { description }),
});
const ids = (nodes: RunningHubVideoNodeInfo[]) => nodes.map((node) => `${node.nodeId}.${node.fieldName}`);
const binding = (node: RunningHubVideoNodeInfo): RunningHubVideoInputBinding => ({ nodeId: node.nodeId, inputName: node.fieldName });

check('explicit text input names are prompt candidates without reading their content', () => {
  for (const name of ['prompt', 'text', 'caption', 'positive_prompt', 'prompt_text', 'input_text', 'prompt1', 'prompt_2', 'text_g', 'positivePrompt', '提示词']) {
    assert.equal(classifyRunningHubVideoField(field(name, '')), 'prompt', name);
  }
  for (const description of ['正向提示词', '云端文本输入', 'Positive Prompt', 'CLIPTextEncode']) {
    assert.equal(classifyRunningHubVideoField(field('value', '', description)), 'prompt', description);
  }
  assert.equal(classifyRunningHubVideoField(field('value', 'a beautiful scene')), 'other');
  assert.equal(classifyRunningHubVideoField(field('custom_field', 'prompt', '提示词相关内部配置')), 'other');
});

check('image slots are separated from text input suggestions', () => {
  for (const name of ['image', 'images', 'image1', 'image_1', 'first_image', 'reference_image', 'reference_image_2', 'first_frame', 'last_frame_image', 'imagePath', 'image_url', '参考图像', '尾帧']) {
    assert.equal(classifyRunningHubVideoField(field(name)), 'images', name);
  }
  for (const description of ['LoadImage', '参考图片', '图片路径', 'image input', 'first frame']) {
    assert.equal(classifyRunningHubVideoField(field('value', '', description)), 'images', description);
  }
  assert.equal(classifyRunningHubVideoField(field('value', '', '图片提示词')), 'prompt');
  assert.equal(classifyRunningHubVideoField(field('value', '', '图生视频工作流')), 'other');
});

check('negative prompts remain advanced suggestions, not default positive prompt choices', () => {
  for (const name of ['negative_prompt', 'negativePrompt', 'negative_text', 'neg_prompt', '负向提示词', '反向提示词']) {
    assert.equal(classifyRunningHubVideoField(field(name, '', '正向文本输入')), 'other', name);
  }
  for (const description of ['Negative Prompt', 'negative', '负向 CLIPTextEncode', '反向提示词']) {
    assert.equal(classifyRunningHubVideoField(field('text', '', description)), 'other', description);
  }
  const negative = field('text', '', 'Negative Prompt');
  assert.deepEqual(selectRunningHubVideoFieldChoices([negative], 'prompt'), []);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices([negative], 'prompt', { showAll: true })), ['1.text']);
});

check('technical field names are common parameters even under image or prompt node titles', () => {
  for (const name of ['width', 'height', 'fps', 'frame_rate', 'duration', 'seed', 'noise_seed', 'steps', 'cfg', 'cfg_scale', 'aspect_ratio', 'resolution', 'num_frames', 'guidanceScale', '分辨率', 'megapixels', 'mega_pixels', 'megaPixel', '百万像素']) {
    assert.equal(classifyRunningHubVideoField(field(name, 'cloud default', '提示词 · 图片输入')), 'parameters', name);
  }
  assert.equal(classifyRunningHubVideoField(field('seed', '9223372036854775807')), 'parameters');
  assert.equal(classifyRunningHubVideoField(field('value', '1024', 'Image width')), 'other');
  assert.equal(classifyRunningHubVideoField(field('value', '1024', '图片尺寸')), 'other');
});

check('model and internal options are never promoted by a misleading node title', () => {
  for (const name of ['model', 'model_name', 'checkpoint', 'ckpt_name', 'lora_name', 'vae_name', 'sampler_name', 'scheduler', 'filename_prefix', 'filePrefix', 'output_path', 'image_upload', 'upload', 'resize_method', 'image_mode', 'format', 'system_prompt', 'prompt_template']) {
    for (const description of ['正向提示词', 'LoadImage', '参考图片']) {
      assert.equal(classifyRunningHubVideoField(field(name, 'model-file.safetensors', description)), 'other', `${name}: ${description}`);
    }
  }
});

check('only actual string fields enter prompt and image suggestions; values are not semantically judged', () => {
  for (const value of [false, true, 17, null, undefined, ['5', 0], { value: 'text' }]) {
    assert.equal(classifyRunningHubVideoField({ ...field('prompt'), fieldValue: value }), 'other');
    assert.equal(classifyRunningHubVideoField({ ...field('image'), fieldValue: value }), 'other');
  }
  for (const value of ['', 'human', 'nonhuman', 'seed=42', 'image.png', 'negative prompt', 'a completely custom requirement']) {
    assert.equal(classifyRunningHubVideoField(field('text', value)), 'prompt');
    assert.equal(classifyRunningHubVideoField(field('value', value)), 'other');
  }
});

check('the 74-field workflow yields role-specific common choices and preserves the complete advanced view', () => {
  const nodes = [field('text', '', '正向提示词', '11'), field('image', '', '参考图片', '12'),
    ...['seed', 'steps', 'width', 'height'].map((name, index) => field(name, 10, '采样设置', String(20 + index))),
    ...Array.from({ length: 68 }, (_, index) => field(`custom_field_${index}`, 'unchanged', '内部字段 · CustomNode', String(100 + index)))];
  assert.equal(nodes.length, 74);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt')), ['11.text']);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'images')), ['12.image']);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'parameters')), ['20.seed', '21.steps', '22.width', '23.height']);
  assert.deepEqual(selectRunningHubVideoFieldChoices(nodes, 'prompt', { showAll: true }), nodes);
});

check('137 catalog descriptions enrich only the view after a request row loses its description', () => {
  const catalog: RunningHubVideoNodeCatalogEntry[] = [{ nodeId: '138', fieldName: 'value', fieldValue: 'cloud old value', description: '正向提示词' }];
  const request = '{"nodeInfoList":[{"nodeId":"138","fieldName":"value","fieldValue":"user request wins"}]}';
  const nodes = listRunningHubVideoNodes(request, catalog);
  assert.equal(nodes[0].description, undefined);
  const beforeNodes = JSON.stringify(nodes); const beforeCatalog = JSON.stringify(catalog);
  const choices = selectRunningHubVideoFieldChoices(nodes, 'prompt', { catalog });
  assert.equal(choices.length, 1); assert.equal(choices[0].description, '正向提示词');
  assert.equal(choices[0].fieldValue, 'user request wins'); assert.notEqual(choices[0], nodes[0]);
  assert.equal(JSON.stringify(nodes), beforeNodes); assert.equal(JSON.stringify(catalog), beforeCatalog);
  assert.equal(request, '{"nodeInfoList":[{"nodeId":"138","fieldName":"value","fieldValue":"user request wins"}]}');
  choices[0].description = 'view changed'; assert.equal(nodes[0].description, undefined); assert.equal(catalog[0].description, '正向提示词');
});

check('request description wins; absent or blank descriptions may use the catalog without changing values', () => {
  const catalog: RunningHubVideoNodeCatalogEntry[] = [{ nodeId: '1', fieldName: 'value', fieldValue: '', description: '正向提示词' }];
  assert.deepEqual(selectRunningHubVideoFieldChoices([field('value', 'actual', '参考图片')], 'prompt', { catalog }), []);
  const images = selectRunningHubVideoFieldChoices([field('value', 'actual', '参考图片')], 'images', { catalog });
  assert.equal(images[0].description, '参考图片'); assert.equal(images[0].fieldValue, 'actual');
  assert.equal(selectRunningHubVideoFieldChoices([field('value', 'actual', '  ')], 'prompt', { catalog }).length, 1);
});

check('search matches only IDs, names and display descriptions, including catalog metadata', () => {
  const nodes = [field('text', 'do-not-search-this-body', 'Primary Prompt', '11'), field('value', '', undefined, '12'), field('seed', 42, '种子', '13')];
  const catalog: RunningHubVideoNodeCatalogEntry[] = [{ nodeId: '12', fieldName: 'value', fieldValue: '', description: '中文提示词' }];
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt', { search: ' PRIMARY ', catalog })), ['11.text']);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt', { search: '12.value', catalog })), ['12.value']);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt', { search: '中文', catalog })), ['12.value']);
  assert.deepEqual(selectRunningHubVideoFieldChoices(nodes, 'prompt', { search: 'do-not-search-this-body', catalog }), []);
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt', { showAll: true, search: '种子', catalog })), ['13.seed']);
});

check('selected unknown or advanced fields survive both classification and search without reordering', () => {
  const nodes = [field('seed', 42, undefined, '90'), field('text', '', undefined, '3'), field('value', '', undefined, '7'), field('legacy_link', ['8', 0], undefined, '2')];
  const keepBindings = [binding(nodes[3]), binding(nodes[0]), binding(nodes[2])];
  const choices = selectRunningHubVideoFieldChoices(nodes, 'images', { search: 'nothing matches', keepBindings });
  assert.deepEqual(ids(choices), ['90.seed', '7.value', '2.legacy_link']);
  assert.equal(choices[0].fieldValue, 42); assert.deepEqual(choices[2].fieldValue, ['8', 0]);
  assert.deepEqual(selectRunningHubVideoFieldChoices([], 'prompt', { keepBindings }), [], 'a missing binding never invents a cloud field');
});

check('compound identifiers and long IDs are matched exactly, without key collisions or precision loss', () => {
  const nodes = [field('b.c', '', undefined, 'a'), field('c', '', undefined, 'a.b'), field('value', '', undefined, '2093983063180054529')];
  assert.deepEqual(ids(selectRunningHubVideoFieldChoices(nodes, 'prompt', { keepBindings: [binding(nodes[0]), binding(nodes[2])] })), ['a.b.c', '2093983063180054529.value']);
  assert.equal(selectRunningHubVideoFieldChoices(nodes, 'prompt', { keepBindings: [binding(nodes[0])] })[0].nodeId, 'a');
});

check('repeated scope and search changes are pure and leave all source data untouched', () => {
  const nodes = [field('value', 'request default', undefined, '1'), field('image', 'request.png', undefined, '2')];
  const catalog: RunningHubVideoNodeCatalogEntry[] = [{ nodeId: '1', fieldName: 'value', fieldValue: 'cloud default', description: '提示词' }];
  nodes.forEach(Object.freeze); catalog.forEach(Object.freeze); Object.freeze(nodes); Object.freeze(catalog);
  const before = JSON.stringify({ nodes, catalog });
  for (const purpose of ['prompt', 'images', 'parameters'] as const) {
    for (const showAll of [false, true]) {
      selectRunningHubVideoFieldChoices(nodes, purpose, { showAll, catalog, search: 'input', keepBindings: [binding(nodes[0])] });
    }
  }
  assert.equal(JSON.stringify({ nodes, catalog }), before);
});

console.log(`RunningHub field choices: ${groups} groups passed, display filtering only; no network requests.`);
