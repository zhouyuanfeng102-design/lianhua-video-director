import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listRunningHubVideoNodes, mergeRunningHubVideoNodeCatalog, normalizeRunningHubVideoNodeCatalog,
  parseRunningHubVideoNodes,
} from '../src/runningHubVideoNodes';
import {
  createRunningHubVideoWorkflow, defaultRunningHubVideoConfig, exportRunningHubVideoWorkflow,
  importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig, saveRunningHubVideoWorkflow,
} from '../src/runningHubVideo';

const modelId = 'lora-test';
const sourceId = 'slider-source';
const binding = { nodeId: sourceId, inputName: '值' };
const graph = () => ({
  [modelId]: { class_type: 'LoraLoader', inputs: {
    lora_name: 'fixture.safetensors', strength_model: [sourceId, 0], strength_clip: [sourceId, 0],
  } },
  [sourceId]: { class_type: 'GoohaiUniversalSlider', inputs: { '值': 3, output_type: 'int', ghs_dom: '3' } },
});
const model = (source: unknown) => parseRunningHubVideoNodes(JSON.stringify(source)).nodes
  .find((node) => node.nodeId === modelId && node.fieldName === 'lora_name')!;

test('API links bind the known slider value, keeping connection arrays out of editable fields', () => {
  const source = graph();
  const result = parseRunningHubVideoNodes(JSON.stringify({ code: 0, data: { prompt: JSON.stringify(source) } }));
  const entry = result.nodes.find((node) => node.nodeId === modelId)!;
  assert.deepEqual(entry.loraStrengthBindings, { strength: binding, clipStrength: binding });
  assert.ok(!result.nodes.some((node) => node.nodeId === modelId && node.fieldName !== 'lora_name'));
  assert.equal(result.nodes.find((node) => node.nodeId === sourceId && node.fieldName === '值')?.fieldValue, 3);
  source[sourceId].inputs['值'] = 0;
  assert.deepEqual(model(source).loraStrengthBindings, { strength: binding, clipStrength: binding });
});

test('unsupported sources and output slots never guess strength from nearby numeric or DOM fields', () => {
  const sources = [
    { class_type: 'UnknownSlider', inputs: { '值': 3, output_type: 'int', ghs_dom: '3' } },
    { class_type: 'GoohaiUniversalSlider', inputs: { '值': '3', output_type: 'int', ghs_dom: '3' } },
    { class_type: 'GoohaiUniversalSlider', inputs: { output_type: 'int', ghs_dom: '3' } },
  ];
  for (const source of sources) {
    assert.deepEqual(model({ ...graph(), [sourceId]: source }).loraStrengthBindings, {});
  }
  for (const link of [[sourceId, 1], [sourceId, '0'], ['missing-source', 0], [sourceId, 0, 'extra']]) {
    const source = graph();
    source[modelId].inputs.strength_model = link;
    source[modelId].inputs.strength_clip = link;
    assert.deepEqual(model(source).loraStrengthBindings, {});
  }
});

test('fresh graph evidence replaces old links without replacing saved values', () => {
  const previous = model(graph());
  const source = graph();
  source[modelId].inputs.strength_model = ['missing-source', 0];
  source[modelId].inputs.strength_clip = ['missing-source', 0];
  source[modelId].inputs.lora_name = 'updated-cloud.safetensors';
  const incoming = model(source);
  assert.deepEqual(incoming.loraStrengthBindings, {});
  const merged = mergeRunningHubVideoNodeCatalog([previous], [incoming]);
  assert.equal(merged[0].fieldValue, 'fixture.safetensors');
  assert.deepEqual(merged[0].loraStrengthBindings, {});
  const request = JSON.stringify({ nodeInfoList: [{ ...previous, fieldValue: 'request-choice.safetensors' }] });
  const listed = listRunningHubVideoNodes(request, merged);
  assert.equal(listed[0].fieldValue, 'request-choice.safetensors');
  assert.deepEqual(listed[0].loraStrengthBindings, {}, 'catalog evidence supersedes stale request metadata');
  assert.deepEqual(previous.loraStrengthBindings, { strength: binding, clipStrength: binding });
});

test('normalization, save and backup retain only local binding identities', () => {
  const entry = model(graph());
  const normalized = normalizeRunningHubVideoNodeCatalog([{ ...entry, loraStrengthBindings: {
    strength: { ...binding, unrelated: 'discard' }, clipStrength: { nodeId: sourceId, inputName: 'api_key' }, unrelated: 'discard',
  } }]);
  assert.deepEqual(normalized[0].loraStrengthBindings, { strength: binding });
  const workflow = { ...createRunningHubVideoWorkflow('LoRA evidence fixture'), remoteId: '12345', nodeCatalog: normalized };
  const saved = saveRunningHubVideoWorkflow({ ...defaultRunningHubVideoConfig }, workflow).workflows[0];
  const restored = normalizeRunningHubVideoConfig({ ...defaultRunningHubVideoConfig, workflows: [saved] }).workflows[0];
  const imported = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(restored)).workflow;
  assert.deepEqual(imported.nodeCatalog, normalized);
  assert.deepEqual(JSON.parse(imported.requestTemplate).nodeInfoList, []);
  assert.doesNotMatch(JSON.stringify(imported.nodeCatalog), /unrelated|discard|api_key/u);
});
