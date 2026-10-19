import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addRunningHubLoraSlot, listRunningHubLoraSlots, listRunningHubOtherFields, removeRunningHubLoraSlot, syncRunningHubLoraSlots,
} from '../src/runningHubGenerationExtras';
import {
  createRunningHubVideoWorkflow, defaultRunningHubVideoConfig, exportRunningHubVideoWorkflow,
  importRunningHubVideoWorkflow, readRunningHubVideoRequest, saveRunningHubVideoWorkflow,
  updateRunningHubVideoNodeValue,
} from '../src/runningHubVideo';
import { mergeRunningHubVideoNodeCatalog, parseRunningHubVideoNodes } from '../src/runningHubVideoNodes';
import { discoverRunningHubVideoNodes } from '../src/services/runningHubVideoDiscovery';
import type { RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

// Minimal structural fixture only: no user prompts, media paths or credentials.
const graph = {
  '53': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'base.safetensors', strength_model: 0.8 } },
  '400': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'style.safetensors', strength_model: 0.35, model: ['53', 0] } },
  '342': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'combat.safetensors', strength_model: 0.65, model: ['400', 0] } },
  '344': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'repair.safetensors', strength_model: 0.35, model: ['342', 0] } },
  '345': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'flow.safetensors', strength_model: 0.35, model: ['344', 0] } },
  '343': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'speed.safetensors', strength_model: ['366', 0], model: ['345', 0] } },
  '366': { class_type: 'GoohaiUniversalSlider', inputs: { '值': 3, output_type: 'int', ghs_dom: '3' } },
  '363': { class_type: '忽略多组孤海', inputs: {} },
  '100': { class_type: 'CLIPTextEncode', inputs: { text: 'fixture prompt' } },
  '900': { class_type: 'UNETLoader', inputs: { unet_name: 'base-model.safetensors', weight_dtype: 'default' } },
};
const binding = (nodeId: string, inputName: string) => ({ nodeId, inputName });
const fresh = (): RunningHubVideoWorkflow => ({ ...createRunningHubVideoWorkflow('auto LoRA fixture'), remoteId: '12345' });
const imported = () => ({ ...fresh(), nodeCatalog: parseRunningHubVideoNodes(JSON.stringify(graph)).nodes });
const values = (workflow: RunningHubVideoWorkflow) => new Map(readRunningHubVideoRequest(workflow.requestTemplate).nodeInfoList
  .map((node) => [`${node.nodeId}.${node.fieldName}`, node.fieldValue]));

test('import materializes all actual LoRAs, binds the external slider and omits unrelated fields', () => {
  const original = imported(); const requestBefore = original.requestTemplate;
  const result = syncRunningHubLoraSlots(original);
  const slots = listRunningHubLoraSlots(result);
  assert.deepEqual(slots.map((slot) => slot.model.nodeId).sort(), ['342', '343', '344', '345', '400', '53']);
  assert.ok(slots.every((slot) => slot.automatic));
  assert.deepEqual(slots.find((slot) => slot.model.nodeId === '343')?.strength, binding('366', '值'));
  assert.equal(values(result).get('366.值'), 3);
  assert.equal(values(result).size, 12);
  assert.ok(![...values(result).keys()].some((key) => /^(?:100|363|900)\.|ghs_dom|output_type|343\.strength_model/u.test(key)));
  assert.doesNotMatch(result.requestTemplate, /loraStrengthBindings|classType|\["366",0\]/u);
  assert.equal(original.requestTemplate, requestBefore);
  assert.equal(syncRunningHubLoraSlots(result), result, 'reopening/refreshing creates no duplicate fields');
});

test('cloud discovery follows the same automatic path using its one existing read-only request', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 0, data: { prompt: JSON.stringify(graph) } }), { status: 200 });
    };
    const result = await discoverRunningHubVideoNodes({ baseUrl: 'https://runninghub.example.test', apiKey: 'local-fixture-key', runKind: 'workflow', remoteId: '12345' });
    const workflow = syncRunningHubLoraSlots({ ...fresh(), nodeCatalog: result.nodes });
    assert.equal(listRunningHubLoraSlots(workflow).length, 6);
    assert.deepEqual(listRunningHubLoraSlots(workflow).find((slot) => slot.model.nodeId === '343')?.strength, binding('366', '值'));
    assert.deepEqual(calls, ['https://runninghub.example.test/api/openapi/getJsonApiFormat']);
  } finally { globalThis.fetch = originalFetch; }
});

test('refresh preserves saved values, explicit positions and hidden LoRAs without recreating them', () => {
  let workflow = syncRunningHubLoraSlots(imported());
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, binding('342', 'strength_model'), '0.12');
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, binding('366', '值'), '0');
  workflow = addRunningHubLoraSlot(workflow, { model: binding('343', 'lora_name'), label: 'keep intentionally unbound' });
  workflow = removeRunningHubLoraSlot(workflow, binding('344', 'lora_name'));
  const before = workflow.requestTemplate;
  workflow.nodeCatalog = mergeRunningHubVideoNodeCatalog(workflow.nodeCatalog, parseRunningHubVideoNodes(JSON.stringify(graph)).nodes);
  const result = syncRunningHubLoraSlots(workflow);
  assert.equal(result.requestTemplate, before);
  assert.equal(values(result).get('342.strength_model'), 0.12);
  assert.equal(values(result).get('366.值'), 0);
  assert.equal(listRunningHubLoraSlots(result).some((slot) => slot.model.nodeId === '344'), false);
  const manual = listRunningHubLoraSlots(result).find((slot) => slot.model.nodeId === '343')!;
  assert.equal(manual.strength, undefined);
  assert.equal(manual.label, 'keep intentionally unbound');
  const hiddenBeforeImport = removeRunningHubLoraSlot(imported(), binding('342', 'lora_name'));
  assert.equal(values(syncRunningHubLoraSlots(hiddenBeforeImport)).has('342.lora_name'), false);
});

test('existing other-field and input mappings stay owned by their original panels', () => {
  const workflow = imported();
  workflow.mapping.prompt = [binding('342', 'lora_name')];
  workflow.generationExtras = { otherFields: [binding('366', '值')] };
  workflow.requestTemplate = JSON.stringify({ nodeInfoList: [{ nodeId: '366', fieldName: '值', fieldValue: 2 }] });
  const result = syncRunningHubLoraSlots(workflow);
  assert.equal(values(result).has('342.lora_name'), false);
  assert.equal(values(result).get('366.值'), 2);
  assert.equal(listRunningHubLoraSlots(result).find((slot) => slot.model.nodeId === '343')?.strength, undefined);
  assert.deepEqual(listRunningHubOtherFields(result), [binding('366', '值')]);
  assert.deepEqual(result.mapping, workflow.mapping);
  assert.deepEqual(result.generationExtras, workflow.generationExtras);
});

test('saved/exported configuration retains auto positions and cross-node edits without graph metadata in requests', () => {
  const workflow = syncRunningHubLoraSlots(imported());
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, binding('366', '值'), '5');
  const config = { ...defaultRunningHubVideoConfig, workflows: [workflow] };
  const saved = saveRunningHubVideoWorkflow(config, workflow).workflows[0];
  const restored = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(saved)).workflow;
  assert.deepEqual(listRunningHubLoraSlots(restored), listRunningHubLoraSlots(workflow));
  assert.equal(values(restored).get('366.值'), 5);
  assert.doesNotMatch(restored.requestTemplate, /loraStrengthBindings|classType/u);
  assert.equal(syncRunningHubLoraSlots(restored), restored);
});

// Optional local attachment check. The original files are never copied into the repository.
const attachment = process.argv[2];
if (attachment) test('the supplied enabled workflow imports six LoRAs with 343 → 366 strength binding', () => {
  const nodes = parseRunningHubVideoNodes(readFileSync(attachment, 'utf8')).nodes;
  const workflow = syncRunningHubLoraSlots({ ...fresh(), nodeCatalog: nodes });
  assert.equal(listRunningHubLoraSlots(workflow).length, 6);
  assert.deepEqual(listRunningHubLoraSlots(workflow).find((slot) => slot.model.nodeId === '343')?.strength, binding('366', '值'));
  assert.equal(values(workflow).size, 12);
  assert.equal(values(workflow).get('366.值'), 3);
});
