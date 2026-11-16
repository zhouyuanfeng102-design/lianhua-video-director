import assert from 'node:assert/strict';
import { bindComfyVideoWorkflow, importComfyVideoWorkflow, normalizeComfyVideoWorkflowJson, parseComfyVideoWorkflow } from '../src/comfyuiVideo';
import { defaultComfyVideoConfig } from '../src/videoGenerationTypes';
import { exportVideoWorkflowJson, importVideoWorkflowPreset, readVideoWorkflowInput, saveVideoWorkflowPreset, updateVideoWorkflowInput } from '../src/videoWorkflowLibrary';

const widget = (name: string, type = 'STRING', link: number | null = null) => ({ name, type, widget: { name }, link });
const input = (name: string, type: string, link: number | null) => ({ name, type, link });
const output = (type: string) => [{ name: type, type }];
const canvas = {
  nodes: [
    { id: 80, type: 'LoadImage', inputs: [widget('image'), widget('upload')], outputs: output('IMAGE'), widgets_values: ['first.png', 'image'] },
    { id: 10, type: 'LoadImage', inputs: [widget('image')], outputs: output('IMAGE'), widgets_values: ['second.png'] },
    { id: 11, type: 'LoadImage', mode: 4, inputs: [widget('image')], outputs: output('IMAGE'), widgets_values: ['bypassed.png'] },
    { id: 81, type: 'SetNode', inputs: [input('IMAGE', 'IMAGE', 1)], outputs: output('IMAGE'), widgets_values_named: { Constant: '参考一' }, widgets_values: ['参考一'] },
    { id: 82, type: 'GetNode', inputs: [], outputs: output('IMAGE'), widgets_values_named: { Constant: '参考一' }, widgets_values: ['参考一'] },
    { id: 83, type: 'SetNode', mode: 4, inputs: [input('IMAGE', 'IMAGE', 2)], outputs: output('IMAGE'), widgets_values: ['旁路图'] },
    { id: 84, type: 'GetNode', inputs: [], outputs: output('IMAGE'), widgets_values: ['旁路图'] },
    { id: 85, type: 'Reroute', inputs: [input('', '*', 3)], outputs: output('*') },
    { id: 86, type: 'CustomFilter', mode: 4, inputs: [input('image', 'IMAGE', 4)], outputs: output('IMAGE'), widgets_values: ['frontend-unused'] },
    { id: 90, type: 'Text', inputs: [widget('text')], outputs: output('STRING'), widgets_values_named: { text: 'original prompt' }, widgets_values: ['wrong positional text'] },
    { id: 91, type: 'MiniMaxH3ReferenceToVideo', inputs: [
      input('ref_images.ref_image_0', 'IMAGE', 5), input('ref_images.ref_image_1', 'IMAGE', 6),
      input('ref_images.ref_image_2', 'IMAGE', 7), widget('prompt', 'STRING', 8), widget('length', 'INT'),
    ], outputs: output('CONDITIONING'), widgets_values_named: { prompt: 'fallback prompt', length: 97, insert_picture: 'UI button' } },
    { id: 92, type: 'SelfLiftH3Sampler', inputs: [input('positive', 'CONDITIONING', 9), widget('seed', 'INT'), widget('cfg', 'FLOAT')],
      outputs: output('IMAGE'), widgets_values_named: { seed: 123456789, control_after_generate: 'randomize', cfg: 4.5 }, widgets_values: [123456789, 'randomize', 4.5] },
    { id: 93, type: 'LoadAudio', inputs: [widget('audio'), widget('audioUI', 'AUDIO_UI'), widget('upload', 'AUDIOUPLOAD')],
      outputs: output('AUDIO'), widgets_values_named: { audio: 'voice.wav', upload: 'audio' } },
    { id: 94, type: 'ResolutionSelector', inputs: [widget('aspect_ratio'), widget('megapixels', 'FLOAT'), widget('multiple', 'INT'), widget('preview', 'RESOLUTION_PREVIEW')],
      outputs: [{ name: 'width', type: 'INT' }, { name: 'height', type: 'INT' }],
      widgets_values_named: { aspect_ratio: '16:9', megapixels: 1, multiple: 16 } },
    { id: 95, type: 'VHS_VideoCombine', inputs: [input('images', 'IMAGE', 10), input('audio', 'AUDIO', 11), widget('frame_rate', 'FLOAT'), widget('format')],
      widgets_values: { frame_rate: 24, format: 'video/h264-mp4', videopreview: { hidden: false } } },
    { id: 96, type: '忽略多组孤海', inputs: [], outputs: [], widgets_values_named: { guhai_ig: 'frontend state' } },
    { id: 97, type: 'Note', widgets_values: ['annotation'] },
  ],
  links: [
    [1, 80, 0, 81, 0, 'IMAGE'], [2, 11, 0, 83, 0, 'IMAGE'], [3, 82, 0, 85, 0, 'IMAGE'],
    [4, 85, 0, 86, 0, 'IMAGE'], [5, 86, 0, 91, 0, 'IMAGE'], [6, 10, 0, 91, 1, 'IMAGE'],
    [7, 84, 0, 91, 2, 'IMAGE'], [8, 90, 0, 91, 3, 'STRING'], [9, 91, 0, 92, 0, 'CONDITIONING'],
    [10, 92, 0, 95, 0, 'IMAGE'], [11, 93, 0, 95, 1, 'AUDIO'],
  ],
};

const source = JSON.stringify(canvas);
const imported = importComfyVideoWorkflow(source);
const graph = parseComfyVideoWorkflow(imported.workflowJson);
assert.equal(JSON.stringify(canvas), source, 'conversion must leave the caller canvas intact');
assert.equal(Array.isArray(JSON.parse(imported.workflowJson).nodes), false, 'new canvas imports persist an executable graph');
assert.deepEqual(imported.mapping.prompt, [{ nodeId: '90', inputName: 'text' }]);
assert.deepEqual(imported.mapping.images, [{ nodeId: '80', inputName: 'image' }, { nodeId: '10', inputName: 'image' }],
  'H3 image order follows its real links rather than numeric LoadImage IDs');
assert.equal(imported.mapping.outputNodeId, '95');
assert.deepEqual(graph['91'].inputs['ref_images.ref_image_0'], ['80', 0]);
assert.deepEqual(graph['91'].inputs['ref_images.ref_image_1'], ['10', 0]);
assert.equal('ref_images.ref_image_2' in graph['91'].inputs, false);
assert.equal(graph['91'].inputs.length, 97);
assert.deepEqual(graph['93'].inputs, { audio: 'voice.wav' });
assert.deepEqual(graph['94'].inputs, { aspect_ratio: '16:9', megapixels: 1, multiple: 16 });
assert.deepEqual(graph['96'].inputs, {}, 'known empty-schema group controls do not serialize their DOM widget');
assert.deepEqual(graph['92'].inputs, { seed: 123456789, cfg: 4.5, positive: ['91', 0] });
for (const id of ['11', '81', '82', '83', '84', '85', '86', '97']) assert.equal(id in graph, false);
const bound = bindComfyVideoWorkflow(imported, 'new prompt', ['uploaded-first.png', 'uploaded-second.png']);
assert.equal(bound['80'].inputs.image, 'uploaded-first.png');
assert.equal(bound['10'].inputs.image, 'uploaded-second.png');
assert.equal(bound['90'].inputs.text, 'new prompt');
assert.equal(bound['91'].inputs.length, 97);
assert.equal(bound['92'].inputs.seed, 123456789);
assert.deepEqual(importComfyVideoWorkflow(imported.workflowJson).mapping.images, imported.mapping.images,
  'new API imports use the same authoritative H3 ordering');

const preset = importVideoWorkflowPreset(source, 'canvas video.json', [], 1);
const legacyCanvasDraft = { ...preset, workflowJson: source };
const edited = updateVideoWorkflowInput(source, { nodeId: '92', inputName: 'cfg' }, '5.25');
assert.equal(readVideoWorkflowInput(edited, { nodeId: '92', inputName: 'cfg' }), 5.25);
assert.equal(Array.isArray(JSON.parse(edited).nodes), false, 'parameter editing first normalizes a canvas');
const saved = saveVideoWorkflowPreset({ ...defaultComfyVideoConfig, workflows: [], activeWorkflowId: null }, legacyCanvasDraft, 2);
assert.equal(Array.isArray(JSON.parse(saved.workflows[0].workflowJson).nodes), false);
assert.equal(exportVideoWorkflowJson(legacyCanvasDraft), normalizeComfyVideoWorkflowJson(source));

const unsafeSeedApi = '{ "1":{"class_type":"CustomSampler","inputs":{"seed":18446744073709551615,"cfg":4.5}} }';
assert.equal(normalizeComfyVideoWorkflowJson(unsafeSeedApi), unsafeSeedApi);
assert.match(updateVideoWorkflowInput(unsafeSeedApi, { nodeId: '1', inputName: 'cfg' }, '6'), /"seed":18446744073709551615/);
assert.equal(importComfyVideoWorkflow(unsafeSeedApi).workflowJson, unsafeSeedApi);
console.log('ComfyUI video canvas import, H3 physical slots and editing checks passed.');
