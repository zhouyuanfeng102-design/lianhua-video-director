import assert from 'node:assert/strict';
import { createRunningHubVideoWorkflow, normalizeRunningHubVideoConfig, removeRunningHubVideoRequestNode } from '../src/runningHubVideo';
import { removeRunningHubImageSlot, syncRunningHubImageSlots } from '../src/runningHubImageSlots';
import { parseRunningHubVideoNodes } from '../src/runningHubVideoNodes';

let groups = 0;
const check = (name: string, run: () => void) => { run(); groups++; console.log(`PASS ${name}`); };
const binding = { nodeId: 'manual', inputName: 'image' };
const node = { nodeId: binding.nodeId, fieldName: binding.inputName, fieldValue: 'manual.png' };
check('exact request deletion handles first, middle, last, only and duplicate rows', () => {
  const other = { nodeId: 'manual', fieldName: 'other', fieldValue: 'keep' };
  for (const nodeInfoList of [[node, other], [other, node, other], [other, node], [node], [node, node, other, node]]) {
    const text = JSON.stringify({ nodeInfoList, usePersonalQueue: false });
    assert.deepEqual(JSON.parse(removeRunningHubVideoRequestNode(text, binding)),
      { nodeInfoList: nodeInfoList.filter(entry => entry !== node), usePersonalQueue: false });
  }
});
check('deletion preserves every unrelated source byte including long numbers and nested JSON', () => {
  const retained = JSON.stringify({ nodeId: 'keep', fieldName: 'text', fieldValue: 'comma, } "quoted" ' + String.fromCharCode(92) });
  const before = '{ "nodeInfoList": [ ' + retained + ', '
    + JSON.stringify(node) + ' ], "seed" : 9223372036854775807, "opaque" : {"text":"manual.image"} }';
  const after = removeRunningHubVideoRequestNode(before, binding);
  assert.equal(after, before.replace(', ' + JSON.stringify(node), ''));
  assert.equal(removeRunningHubVideoRequestNode(after, binding), after);
});
const fixture = () => {
  const workflow = createRunningHubVideoWorkflow('本地手动槽删除');
  workflow.remoteId = 'fixture';
  workflow.requestTemplate = JSON.stringify({ nodeInfoList: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: '原稿' }, node,
    { nodeId: 'kept', fieldName: 'image', fieldValue: 'kept.png' },
    { nodeId: 'steps', fieldName: 'steps', fieldValue: 15 },
  ], usePersonalQueue: false });
  workflow.nodeCatalog = parseRunningHubVideoNodes(workflow.requestTemplate).nodes;
  workflow.mapping = { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: [
    { ...binding, role: 'first-frame' }, { nodeId: 'kept', inputName: 'image', role: 'character' },
  ], parameters: { steps: { nodeId: 'steps', inputName: 'steps' } } };
  workflow.fieldControls = { '["manual","image"]': { kind: 'text' }, '["steps","steps"]': { kind: 'number', step: 1 } };
  return workflow;
};
check('saved manual image deletes mapping, request and catalogue; sync and normalization cannot restore it', () => {
  const original = fixture(); const snapshot = structuredClone(original);
  const removed = removeRunningHubImageSlot(original, binding);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(removed.mapping.images, [snapshot.mapping.images[1]]);
  assert.ok(!removed.nodeCatalog!.some(entry => entry.nodeId === 'manual'));
  assert.ok(!JSON.parse(removed.requestTemplate).nodeInfoList.some((entry: any) => entry.nodeId === 'manual'));
  assert.deepEqual(removed.fieldControls, { '["steps","steps"]': snapshot.fieldControls!['["steps","steps"]'] });
  assert.deepEqual(removed.mapping.parameters, snapshot.mapping.parameters);
  assert.deepEqual(syncRunningHubImageSlots(removed), removed);
  const normalized = normalizeRunningHubVideoConfig({ workflows: [removed], activeWorkflowId: removed.id }).workflows[0];
  assert.deepEqual(syncRunningHubImageSlots(normalized).mapping.images, removed.mapping.images);
});
check('explicit custom-name and missing legacy slots can be deleted without changing other fields', () => {
  const original = fixture(); original.mapping.images[0].inputName = 'custom_reference';
  const body = JSON.parse(original.requestTemplate); body.nodeInfoList[1].fieldName = 'custom_reference';
  original.requestTemplate = JSON.stringify(body); original.nodeCatalog![1].fieldName = 'custom_reference';
  const removed = removeRunningHubImageSlot(original, { ...binding, inputName: 'custom_reference' });
  assert.equal(removed.mapping.images.length, 1);
  const missing = { nodeId: 'missing', inputName: 'unknown' };
  const legacy = { ...removed, mapping: { ...removed.mapping, images: [missing, ...removed.mapping.images] } };
  assert.deepEqual(removeRunningHubImageSlot(legacy, missing).mapping.images, removed.mapping.images);
  assert.equal(removeRunningHubImageSlot(legacy, missing).requestTemplate, removed.requestTemplate);
});
check('a shared parameter field survives image unbinding and is not resynchronized', () => {
  const original = fixture(); original.mapping.parameters!.shared = binding;
  const removed = removeRunningHubImageSlot(original, binding);
  assert.equal(removed.requestTemplate, original.requestTemplate);
  assert.deepEqual(removed.nodeCatalog, original.nodeCatalog);
  assert.deepEqual(removed.mapping.parameters, original.mapping.parameters);
  assert.equal(syncRunningHubImageSlots(removed).mapping.images.length, 1);
});
check('invalid or ambiguous request deletion fails atomically; nonexistent slots are unchanged', () => {
  for (const text of ['{', '{"nodeInfoList":[],"nodeInfoList":[]}']) {
    const original = { ...fixture(), requestTemplate: text }; const snapshot = structuredClone(original);
    assert.throws(() => removeRunningHubImageSlot(original, binding));
    assert.deepEqual(original, snapshot);
  }
  const original = fixture(); assert.equal(removeRunningHubImageSlot(original, { nodeId: 'other', inputName: 'image' }), original);
});
console.log(`RunningHub image slot removal: ${groups} groups passed; no network or user data.`);
