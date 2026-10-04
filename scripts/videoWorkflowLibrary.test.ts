import assert from 'node:assert/strict';
import { bindComfyVideoWorkflow, parseComfyVideoWorkflow } from '../src/comfyuiVideo';
import {
  activateVideoWorkflowPreset, assertSafeVideoWorkflowJson, copyVideoWorkflowPreset, createVideoWorkflowDraft,
  deleteVideoWorkflowPreset, exportVideoWorkflowJson, formatVideoWorkflowJson, importVideoWorkflowPreset, inspectVideoWorkflowWarnings,
  isVideoWorkflowConnection, isVideoWorkflowReady, readVideoWorkflowInput, saveVideoWorkflowPreset,
  uniqueVideoWorkflowName, updateVideoWorkflowInput, validateVideoWorkflowPreset, videoWorkflowDeletionFallback,
} from '../src/videoWorkflowLibrary';
import { defaultComfyVideoConfig, type ComfyVideoConfig, type ComfyVideoWorkflowPreset } from '../src/videoGenerationTypes';

const graph = {
  '12': { class_type: 'PrimitiveStringMultiline', inputs: { value: '原文对白不变' }, _meta: { title: 'Prompt 输入文本' } },
  '20': { class_type: 'LoadImage', inputs: { image: 'first.png' } },
  '21': { class_type: 'LoadImage', inputs: { image: 'last.png' } },
  '30': { class_type: 'CustomVideoSampler', inputs: { prompt: ['12', 0], first_image: ['20', 0], last_image: ['21', 0], seed: 123456789, steps: 28, cfg: 4.5, width: 1024, height: 576, enabled: true, label: '001', api_key: '', metadata: { preserve: 'yes' } } },
  '40': { class_type: 'AudioDecode', inputs: { audio: ['30', 1] } },
  '50': { class_type: 'VHS_VideoCombine', inputs: { images: ['30', 0], audio: ['40', 0], frame_rate: 24, format: 'video/h264-mp4' } },
};
const source = JSON.stringify({ prompt: graph, client_id: 'public-client', extra_data: { note: '保留封套' } });
const originalSource = source;
const imported = importVideoWorkflowPreset(source, '测试工作流.json', [], 100);
assert.equal(imported.name, '测试工作流');
assert.equal(imported.createdAt, 100);
assert.equal(imported.updatedAt, 100);
assert.equal(imported.workflowJson, source);
assert.deepEqual(imported.mapping.prompt, [{ nodeId: '12', inputName: 'value' }]);
assert.deepEqual(imported.mapping.images, [{ nodeId: '20', inputName: 'image' }, { nodeId: '21', inputName: 'image' }]);
assert.deepEqual(imported.mapping.parameters?.seed, { nodeId: '30', inputName: 'seed' });
assert.equal(imported.mapping.outputNodeId, '50');
assert.deepEqual(validateVideoWorkflowPreset(imported), []);
assert.equal(isVideoWorkflowReady(imported), true);

const draft = createVideoWorkflowDraft([imported], 200);
assert.notEqual(draft.id, imported.id);
assert.equal(draft.workflowJson, '{}');
assert.equal(isVideoWorkflowReady(draft), false);
assert.match(validateVideoWorkflowPreset(draft).join(' '), /工作流为空/u);
assert.equal(uniqueVideoWorkflowName('测试工作流', [imported]), '测试工作流 (2)');
assert.equal(uniqueVideoWorkflowName('测试工作流', [imported, { ...imported, id: 'other', name: '测试工作流 (2)' }]), '测试工作流 (3)');
const config: ComfyVideoConfig = { ...defaultComfyVideoConfig, enabled: false, baseUrl: 'http://127.0.0.1:8188', apiKey: 'fixture-secret-not-exported', promptPath: '/custom/prompt', activeWorkflowId: imported.id, workflows: [imported] };
const originalConfig = structuredClone(config);
const withDraft = saveVideoWorkflowPreset(config, draft, 210);
assert.equal(withDraft.workflows.length, 2);
assert.equal(withDraft.activeWorkflowId, imported.id, 'saving a new draft does not activate it');
assert.equal(withDraft.enabled, false, 'saving does not authorize network access');
assert.equal(withDraft.promptPath, config.promptPath);
assert.throws(() => activateVideoWorkflowPreset(withDraft, draft.id), /尚不能启用/u);
assert.throws(() => activateVideoWorkflowPreset(withDraft, 'not-saved'), /先保存/u);
assert.deepEqual(config, originalConfig, 'all library helpers are immutable');

const custom: ComfyVideoWorkflowPreset = {
  ...imported,
  mapping: {
    ...imported.mapping,
    images: [{ nodeId: '21', inputName: 'image', role: 'last-frame' }, { nodeId: '20', inputName: 'image', role: 'first-frame' }],
    parameters: { ...imported.mapping.parameters, enabled: { nodeId: '30', inputName: 'enabled' }, label: { nodeId: '30', inputName: 'label' } },
  },
};
const copy = copyVideoWorkflowPreset(custom, [custom], 300);
assert.notEqual(copy.id, custom.id);
assert.match(copy.name, /副本/u);
assert.deepEqual(copy.mapping, custom.mapping);
assert.equal(copy.workflowJson, custom.workflowJson);
copy.mapping.images[0].role = 'general';
copy.mapping.parameters!.seed.nodeId = 'changed-in-copy';
assert.equal(custom.mapping.images[0].role, 'last-frame');
assert.equal(custom.mapping.parameters!.seed.nodeId, '30', 'parameter bindings are deeply cloned');
const secondImport = importVideoWorkflowPreset(source, '测试工作流.json', [imported], 400);
assert.notEqual(secondImport.id, imported.id);
assert.equal(secondImport.name, '测试工作流 (2)');

const numberBinding = { nodeId: '30', inputName: 'seed' };
let modified = updateVideoWorkflowInput(source, numberBinding, '987654321');
let parsedDocument = JSON.parse(modified);
assert.equal(parsedDocument.prompt['30'].inputs.seed, 987654321);
assert.equal(typeof parsedDocument.prompt['30'].inputs.seed, 'number');
assert.equal(parsedDocument.client_id, 'public-client');
assert.deepEqual(parsedDocument.extra_data, { note: '保留封套' });
assert.deepEqual(parsedDocument.prompt['40'], graph['40']);
assert.deepEqual(parsedDocument.prompt['50'], graph['50'], 'audio/output graph remains byte-equivalent as objects');
modified = updateVideoWorkflowInput(modified, { nodeId: '30', inputName: 'cfg' }, '6.25');
assert.equal(readVideoWorkflowInput(modified, { nodeId: '30', inputName: 'cfg' }), 6.25);
modified = updateVideoWorkflowInput(modified, { nodeId: '30', inputName: 'enabled' }, 'false');
assert.equal(readVideoWorkflowInput(modified, { nodeId: '30', inputName: 'enabled' }), false);
modified = updateVideoWorkflowInput(modified, { nodeId: '30', inputName: 'label' }, '002');
assert.equal(readVideoWorkflowInput(modified, { nodeId: '30', inputName: 'label' }), '002', 'numeric-looking strings remain strings');
assert.equal(source, originalSource);
assert.equal(updateVideoWorkflowInput(source, numberBinding, '987654321'), source.replace('123456789', '987654321'), 'editing a literal preserves all other source bytes');
const largeSeedSource = source.replace('123456789', '18446744073709551615');
assert.equal(updateVideoWorkflowInput(largeSeedSource, { nodeId: '30', inputName: 'steps' }, '40'), largeSeedSource.replace('"steps":28', '"steps":40'), 'unrelated 64-bit seed text must not get rounded');
assert.equal(exportVideoWorkflowJson({ ...custom, workflowJson: largeSeedSource }), largeSeedSource, 'export preserves unsafe-integer source text');
assert.throws(() => formatVideoWorkflowJson(largeSeedSource), /超出安全精度/u);
assert.deepEqual(JSON.parse(formatVideoWorkflowJson(source)), JSON.parse(source));
const duplicateSource = '{"1":{"class_type":"Prompt","inputs":{"text":"first","text":"last"}}}';
assert.equal(updateVideoWorkflowInput(duplicateSource, { nodeId: '1', inputName: 'text' }, 'updated'), duplicateSource.replace('"last"', '"updated"'), 'duplicate-key behavior matches JSON.parse');
const escapedSource = '{"1":{"class_type":"Prompt","inputs":{"te\\u0078t":"escaped \\\"value\\\"","keep":[{"x":true},null]}}}';
assert.equal(updateVideoWorkflowInput(escapedSource, { nodeId: '1', inputName: 'text' }, '你好\n"new"'), escapedSource.replace('"escaped \\\"value\\\""', JSON.stringify('你好\n"new"')));
assert.equal(graph['30'].inputs.seed, 123456789);
assert.throws(() => updateVideoWorkflowInput(source, numberBinding, ''), /不能为空/u);
assert.throws(() => updateVideoWorkflowInput(source, numberBinding, 'NaN'), /有效的有限数字/u);
assert.throws(() => updateVideoWorkflowInput(source, numberBinding, 'Infinity'), /有效的有限数字/u);
assert.throws(() => updateVideoWorkflowInput(source, numberBinding, '99999999999999999999'), /安全整数/u);
assert.throws(() => updateVideoWorkflowInput(source, { nodeId: '30', inputName: 'enabled' }, '1'), /只能选择/u);
assert.throws(() => updateVideoWorkflowInput(source, { nodeId: '30', inputName: 'metadata' }, '7'), /不是文字、数字或布尔/u);
assert.throws(() => updateVideoWorkflowInput(source, { nodeId: '30', inputName: 'prompt' }, 'replacement'), /节点连线/u);
assert.throws(() => readVideoWorkflowInput(source, { nodeId: '__proto__', inputName: 'value' }), /找不到输入/u);
assert.throws(() => readVideoWorkflowInput(source, { nodeId: '30', inputName: 'constructor' }), /找不到输入/u);
assert.equal(isVideoWorkflowConnection(['30', 0]), true);
assert.equal(isVideoWorkflowConnection([30, 0]), true);
assert.equal(isVideoWorkflowConnection('30'), false);

const modifiedPreset = { ...custom, workflowJson: modified };
const saved = saveVideoWorkflowPreset({ ...config, workflows: [custom] }, modifiedPreset, 500);
assert.equal(saved.workflows.length, 1);
assert.equal(saved.workflows[0].createdAt, custom.createdAt);
assert.equal(saved.workflows[0].updatedAt, 500);
assert.deepEqual(saved.workflows[0].mapping, custom.mapping, 'saving JSON does not re-detect or reset manual mappings');
assert.deepEqual(JSON.parse(saved.workflows[0].workflowJson).prompt['50'].inputs.audio, ['40', 0]);
const taskSnapshot = structuredClone(custom);
const replacement = saveVideoWorkflowPreset(saved, { ...modifiedPreset, name: ' renamed ' }, 510);
assert.equal(replacement.workflows[0].name, 'renamed');
assert.equal(taskSnapshot.workflowJson, source, 'historical frozen workflow copies are untouched');
assert.deepEqual(taskSnapshot.mapping, custom.mapping);

const withoutOutput = { ...custom, mapping: { ...custom.mapping, outputNodeId: undefined } };
assert.equal(isVideoWorkflowReady(withoutOutput), true, 'legacy automatic output collection remains supported');
const optionalUnmapped = { ...custom, mapping: { ...custom.mapping, images: [{ nodeId: '', inputName: 'image' }], parameters: { pending: { nodeId: '', inputName: 'steps' } } } };
assert.equal(isVideoWorkflowReady(optionalUnmapped), true, 'unused optional mappings do not block activation');
assert.equal(inspectVideoWorkflowWarnings(optionalUnmapped).length, 2);
assert.doesNotThrow(() => saveVideoWorkflowPreset({ ...config, workflows: [optionalUnmapped] }, { ...optionalUnmapped, name: 'only rename' }));
assert.doesNotThrow(() => bindComfyVideoWorkflow(optionalUnmapped, 'test prompt', []));
assert.throws(() => bindComfyVideoWorkflow(optionalUnmapped, 'test prompt', ['actual.png']), /映射不存在/u);
const linkedPrompt = { ...custom, mapping: { ...custom.mapping, prompt: [{ nodeId: '30', inputName: 'prompt' }] } };
assert.equal(isVideoWorkflowReady(linkedPrompt), false);
assert.match(validateVideoWorkflowPreset(linkedPrompt).join(''), /节点连线/u);
assert.equal(isVideoWorkflowReady({ ...custom, mapping: { ...custom.mapping, outputNodeId: 'missing' } }), false);
assert.throws(() => saveVideoWorkflowPreset(config, { ...draft, id: imported.id }), /当前正在使用/u);

const second = { ...custom, id: 'second-ready', name: '另一份可用工作流' };
const deletionConfig: ComfyVideoConfig = { ...config, enabled: true, workflows: [custom, draft, second] };
const fallback = videoWorkflowDeletionFallback(deletionConfig, custom.id);
assert.equal(fallback?.id, second.id, 'fallback skips an empty draft');
const deleted = deleteVideoWorkflowPreset(deletionConfig, custom.id);
assert.equal(deleted.activeWorkflowId, second.id);
assert.equal(deleted.enabled, true);
assert.deepEqual(deleted.workflows, [draft, second]);
assert.equal(deleted.apiKey, config.apiKey);
const deletedInactive = deleteVideoWorkflowPreset(deletionConfig, second.id);
assert.equal(deletedInactive.activeWorkflowId, custom.id);
assert.equal(deletedInactive.enabled, true);
const deletedLastReady = deleteVideoWorkflowPreset({ ...deletionConfig, workflows: [custom, draft] }, custom.id);
assert.equal(deletedLastReady.activeWorkflowId, null);
assert.equal(deletedLastReady.enabled, false, 'no ready fallback disables ComfyUI instead of implicitly using an empty draft');
assert.deepEqual(deletedLastReady.workflows, [draft]);
assert.equal(deleteVideoWorkflowPreset(config, 'missing'), config);
const activated = activateVideoWorkflowPreset({ ...config, workflows: [custom, second] }, second.id);
assert.equal(activated.activeWorkflowId, second.id);
assert.equal(activated.enabled, false, 'selecting a workflow never switches on disabled API access');

assert.throws(() => importVideoWorkflowPreset('{"nodes":[],"links":[]}', 'canvas.json', []), /API 格式/u);
assert.throws(() => importVideoWorkflowPreset('not JSON', 'bad.json', []), /有效 JSON/u);
assert.throws(() => importVideoWorkflowPreset('{"prompt":{},"headers":{"Authorization":"secret"}}', 'unsafe.json', []), /内嵌凭据/u);
assert.throws(() => importVideoWorkflowPreset(JSON.stringify({ '1': { class_type: 'Custom', inputs: { api_key: 'secret' } } }), 'unsafe.json', []), /密钥只能/u);
assert.throws(() => updateVideoWorkflowInput(source, { nodeId: '30', inputName: 'api_key' }, 'new-secret'), /内嵌凭据/u);
assert.doesNotThrow(() => assertSafeVideoWorkflowJson(source));
const exported = exportVideoWorkflowJson(custom);
assert.deepEqual(JSON.parse(exported), JSON.parse(source));
assert.equal(exported.includes(config.apiKey), false);
assert.equal(exported.includes(config.baseUrl), false);
assert.deepEqual(parseComfyVideoWorkflow(exported), graph);
assert.throws(() => exportVideoWorkflowJson({ ...custom, workflowJson: '{"prompt":{},"apiKey":"secret"}' }), /内嵌凭据/u);
assert.deepEqual(config, originalConfig);

console.log('videoWorkflowLibrary: draft/library isolation, activation/deletion, typed literals, custom mappings, safety and export regressions passed');
