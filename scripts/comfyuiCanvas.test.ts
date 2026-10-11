import assert from 'node:assert/strict';
import { convertComfyUICanvasWorkflow, isComfyUICanvasWorkflow } from '../src/comfyuiCanvas';

type Node = Record<string, unknown>;
type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };
const output = (type: string) => [{ name: type, type }];
const widget = (name: string, type = 'STRING', link: number | null = null) => ({ name, type, widget: { name }, link });
const input = (name: string, type: string, link: number | null) => ({ name, type, link });
const convert = (nodes: Node[], links: unknown[] = []) => convertComfyUICanvasWorkflow({ nodes, links }) as Record<string, ApiNode>;

assert.equal(isComfyUICanvasWorkflow({ nodes: [] }), true);
assert.equal(isComfyUICanvasWorkflow({ links: [] }), true);
assert.equal(isComfyUICanvasWorkflow({ prompt: {} }), false);
assert.equal(isComfyUICanvasWorkflow(null), false);

const customCanvas = {
  nodes: [
    { id: 1, type: 'LoadImage', outputs: output('IMAGE'), inputs: [widget('image'), widget('upload')], widgets_values: ['reference.png', 'image'] },
    { id: 2, type: 'LoadImage', mode: 2, outputs: output('IMAGE'), inputs: [widget('image')], widgets_values: ['disabled.png'] },
    { id: 3, type: 'LazyMergeWorkbench', outputs: output('MERGE_PACK'), title: '工作台',
      inputs: [input('图像1', 'IMAGE', 1), input('图像2', 'IMAGE', 2), widget('提示词文本'), widget('最大行数', 'INT'), widget('去除空行', 'BOOLEAN')],
      // A button at the beginning makes guessing positional order unsafe.
      widgets_values: ['button', 'incorrect positional value', 99, true],
      widgets_values_named: { 提示词文本: 'workflow prompt', 最大行数: 1, 去除空行: false, lazy_merge_wb: 'frontend button' } },
    { id: 4, type: 'LazyMergeGenerate', outputs: output('IMAGE'), inputs: [input('工作台包', 'MERGE_PACK', 3), widget('种子', 'INT')],
      widgets_values_named: { 种子: 1234, control_after_generate: 'randomize' }, widgets_values: [1234, 'randomize'] },
    { id: 5, type: 'SaveImage', inputs: [input('images', 'IMAGE', 4)], widgets_values: ['output'] },
    { id: 6, type: 'Note', widgets_values_named: { text: 'annotation' }, widgets_values: ['annotation'] },
    { id: 7, type: 'Fast Groups Muter (rgthree)', widgets_values: ['frontend'] },
  ],
  links: [[1, 1, 0, 3, 0, 'IMAGE'], [2, 2, 0, 3, 1, 'IMAGE'], [3, 3, 0, 4, 0, 'MERGE_PACK'], [4, 4, 0, 5, 0, 'IMAGE']],
};
const unchanged = JSON.stringify(customCanvas);
const custom = convertComfyUICanvasWorkflow(customCanvas) as Record<string, ApiNode>;
assert.equal(JSON.stringify(customCanvas), unchanged, 'conversion must not change the persisted canvas');
assert.deepEqual(Object.keys(custom), ['1', '3', '4', '5']);
assert.deepEqual(custom['1'].inputs, { image: 'reference.png' });
assert.deepEqual(custom['3'].inputs, { 提示词文本: 'workflow prompt', 最大行数: 1, 去除空行: false, 图像1: ['1', 0] });
assert.equal(custom['3']._meta.title, '工作台');
assert.deepEqual(custom['4'].inputs, { 种子: 1234, 工作台包: ['3', 0] });
assert.deepEqual(custom['5'].inputs, { filename_prefix: 'output', images: ['4', 0] });

const sampler = convert([
  { id: 1, type: 'KSampler', widgets_values: [123, 'randomize', 24, 6.5, 'euler', 'normal', 0.75] },
  { id: 2, type: 'CLIPLoader', widgets_values: ['clip.safetensors', 'stable_diffusion'] },
  { id: 3, type: 'CLIPTextEncode', widgets_values: ['prompt'] },
  { id: 4, type: 'CLIPLoader', widgets_values_named: { clip_name: 'clip.safetensors', type: 'stable_diffusion' } },
]);
assert.deepEqual(sampler['1'].inputs, { seed: 123, steps: 24, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 0.75 });
assert.deepEqual(sampler['2'].inputs, { clip_name: 'clip.safetensors', type: 'stable_diffusion' });
assert.equal(sampler['3'].inputs.text, 'prompt');
assert.deepEqual(sampler['4'].inputs, sampler['2'].inputs);

const bypass = convert([
  { id: 1, type: 'VAELoader', outputs: output('VAE'), widgets_values: ['vae.safetensors'] },
  { id: 2, type: 'CustomFilter', mode: 4, inputs: [input('vae', 'VAE', 1)], outputs: output('VAE'), widgets_values: ['unmapped but not executed'] },
  { id: 3, type: 'Reroute', inputs: [input('', '*', 2)], outputs: output('*') },
  { id: 4, type: 'VAEDecode', inputs: [input('vae', 'VAE', 3)], outputs: output('IMAGE') },
], [[1, 1, 0, 2, 0, 'VAE'], [2, 2, 0, 3, 0, 'VAE'], [3, 3, 0, 4, 0, 'VAE']]);
assert.deepEqual(Object.keys(bypass), ['1', '4']);
assert.deepEqual(bypass['4'].inputs.vae, ['1', 0]);

const primitive = convert([
  { id: 1, type: 'PrimitiveNode', outputs: output('STRING'), widgets_values: ['primitive prompt'] },
  { id: 2, type: 'CLIPTextEncode', inputs: [widget('text', 'STRING', 1)], widgets_values: ['old prompt'] },
], [{ id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'STRING' }]);
assert.deepEqual(primitive['2'].inputs, { text: 'primitive prompt' });

const arrayWidget = convert([
  { id: 1, type: 'CustomList', inputs: [widget('items', 'CUSTOM')], widgets_values_named: { items: ['1', 0] } },
]);
assert.deepEqual(arrayWidget['1'].inputs.items, { __value__: ['1', 0] }, 'array widgets must not masquerade as connections');

const button = convert([
  { id: 1, type: 'CustomNode', inputs: [widget('text'), widget('do_action', 'BUTTON')], widgets_values_named: { text: 'input' } },
]);
assert.deepEqual(button['1'].inputs, { text: 'input' });

assert.throws(() => convert([
  { id: 9, type: 'UnknownCustomNode', inputs: [widget('seed'), widget('text')], widgets_values: [1, 'randomize', 'prompt'] },
]), /节点 9（UnknownCustomNode）.*缺少命名参数.*API/u);
assert.throws(() => convert([
  { id: 9, type: 'UnknownCustomNode', inputs: [widget('text')], widgets_values_named: { another: 'prompt' } },
]), /节点 9.*缺少命名参数/u);
assert.throws(() => convert([
  { id: 9, type: 'UnknownCustomNode', widgets_values_named: { text: 'prompt' } },
]), /节点 9.*input.widget/u);
assert.throws(() => convert([
  { id: 9, type: 'KSampler', widgets_values: [123, 'wrong_control', 24, 6.5, 'euler', 'normal', 0.75] },
]), /节点 9.*Seed 控制字段/u);
assert.throws(() => convert([
  { id: 9, type: 'CLIPTextEncode', widgets_values: ['prompt', 'unexpected'] },
]), /节点 9.*标准参数布局/u);
assert.throws(() => convert([
  { id: 9, type: 'CLIPTextEncode', inputs: [widget('text', 'STRING', 88)], widgets_values: ['prompt'] },
]), /节点 9.*链接 88/u);
assert.throws(() => convert([
  { id: 9, type: 'CustomNode', mode: 1 },
]), /节点 9.*运行模式/u);
assert.throws(() => convertComfyUICanvasWorkflow({
  nodes: [{ id: 9, type: 'subgraph-id' }], links: [], definitions: { subgraphs: [{ id: 'subgraph-id' }] },
}), /节点 9.*子图/u);
assert.throws(() => convert([
  { id: 1, type: 'Reroute', inputs: [input('value', '*', 1)], outputs: output('*') },
  { id: 2, type: 'CLIPTextEncode', inputs: [widget('text', 'STRING', 2)], widgets_values: ['prompt'] },
], [[1, 1, 0, 1, 0, '*'], [2, 1, 0, 2, 0, '*']]), /节点 1.*循环/u);

const specialInput = convert([
  { id: 1, type: 'CustomNode', inputs: [widget('__proto__')], widgets_values_named: JSON.parse('{"__proto__":"kept as data"}') },
]);
assert.equal(Object.getPrototypeOf(specialInput['1'].inputs), Object.prototype);
assert.equal(Object.prototype.hasOwnProperty.call(specialInput['1'].inputs, '__proto__'), true);
assert.equal(specialInput['1'].inputs.__proto__, 'kept as data');

console.log('ComfyUI canvas conversion checks passed.');
