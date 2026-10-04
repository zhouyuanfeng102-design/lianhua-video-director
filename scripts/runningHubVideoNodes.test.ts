import assert from 'node:assert/strict';
import {
  listRunningHubVideoNodes, mergeRunningHubVideoNodeCatalog, normalizeRunningHubVideoNodeCatalog,
  parseRunningHubVideoNodes, normalizeRunningHubVideoFieldControl, parseRunningHubVideoFieldData,
} from '../src/runningHubVideoNodes';
import {
  compileRunningHubVideoApi, copyRunningHubVideoWorkflow, createRunningHubTutorialVideoWorkflow,
  createRunningHubVideoWorkflow, defaultRunningHubVideoConfig, ensureRunningHubVideoRequestNode,
  exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig,
  readRunningHubVideoRequest, saveRunningHubVideoWorkflow, updateRunningHubVideoNodeValue,
} from '../src/runningHubVideo';
import type { RunningHubVideoNodeCatalogEntry, RunningHubVideoNodeInfo } from '../src/runningHubVideoTypes';

let groups = 0;
const check = (name: string, run: () => void) => { run(); groups += 1; console.log(`PASS ${name}`); };
const field = (nodeId = '41', fieldName = 'text', fieldValue: string | number | boolean = 'cloud default'): RunningHubVideoNodeCatalogEntry => ({ nodeId, fieldName, fieldValue });
const info = (node: RunningHubVideoNodeCatalogEntry): RunningHubVideoNodeInfo => ({ ...node });
const graph = {
  '41': { class_type: 'CLIPTextEncode', _meta: { title: '实际正向提示词' }, inputs: { text: 'cloud prompt', clip: ['40', 0] } },
  '42': { class_type: 'LoadImage', inputs: { image: 'default.png' } },
  '43': { class_type: 'Sampler', inputs: { steps: 20, enabled: false, cfg: 3.5, complex: { untouched: true }, missing: null, api_key: 'private-key-do-not-copy', token: 'private-token' } },
};

check('empty list is not invented into tutorial nodes', () => {
  const result = parseRunningHubVideoNodes('{"addMetadata":true,"nodeInfoList":[]}');
  assert.deepEqual(result.nodes, []); assert.ok(result.warnings.some((warning) => warning.includes('空 nodeInfoList')));
});

check('API graph keeps actual scalar names/types/titles, excludes links, objects and credentials', () => {
  const result = parseRunningHubVideoNodes(JSON.stringify(graph));
  assert.deepEqual(result.nodes.map((node) => `${node.nodeId}.${node.fieldName}`), ['41.text', '42.image', '43.steps', '43.enabled', '43.cfg']);
  assert.equal(result.nodes[0].description, '实际正向提示词');
  assert.equal(result.nodes[1].description, 'LoadImage');
  assert.equal(result.nodes[2].fieldValue, 20); assert.equal(result.nodes[3].fieldValue, false);
  assert.equal(result.nodes[4].fieldValue, 3.5);
  assert.doesNotMatch(JSON.stringify(result), /private-key|private-token/u);
  assert.ok(result.warnings.some((warning) => warning.includes('连线')));
});

check('official workflow envelopes support JSON-string and object prompt graphs', () => {
  for (const prompt of [graph, JSON.stringify(graph)]) {
    assert.deepEqual(parseRunningHubVideoNodes(JSON.stringify({ code: 0, data: { prompt } })).nodes,
      parseRunningHubVideoNodes(JSON.stringify(graph)).nodes);
  }
  assert.equal(parseRunningHubVideoNodes('```json\n' + JSON.stringify(graph) + '\n```').nodes.length, 5);
});

check('official AI app nodes use description or nodeName and never retain curl/fieldData', () => {
  const result = parseRunningHubVideoNodes(JSON.stringify({ code: 0, data: { curl: 'untrusted command is data only', nodeInfoList: [
    { ...field(), nodeName: '云端文本输入', description: null, fieldData: { apiKey: 'hidden-secret' } },
    { ...field('42', 'image', ''), nodeName: '图像', description: '自定义图片说明' },
  ] } }));
  assert.equal(result.nodes[0].description, '云端文本输入'); assert.equal(result.nodes[1].description, '自定义图片说明');
  assert.doesNotMatch(JSON.stringify(result.nodes), /hidden-secret|fieldData|curl/u);
});

check('compound IDs and API graph nodes named data/prompt remain real nodes', () => {
  const value = Object.fromEntries(['data', 'prompt', 'node:17/subgraph'].map((id) => [id, { class_type: 'Primitive', inputs: { value: 'x' } }]));
  assert.deepEqual(parseRunningHubVideoNodes(JSON.stringify(value)).nodes.map((node) => node.nodeId), ['data', 'prompt', 'node:17/subgraph']);
});

check('large numeric node IDs and seed literals retain every source digit in every envelope', () => {
  const list = '[{"nodeId":2093983063180054529,"fieldName":"seed","fieldValue":9223372036854775807}]';
  for (const source of [list, `{"nodeInfoList":${list}}`, `{"code":0,"data":{"nodeInfoList":${list}}}`]) {
    const result = parseRunningHubVideoNodes(source);
    assert.equal(result.nodes[0].nodeId, '2093983063180054529'); assert.equal(result.nodes[0].fieldValue, '9223372036854775807');
    assert.ok(result.warnings.some((warning) => warning.includes('超出安全范围')));
  }
  const api = '{"9":{"class_type":"Sampler","inputs":{"seed":9007199254740993,"steps":20}}}';
  const nested = parseRunningHubVideoNodes(JSON.stringify({ code: 0, data: { prompt: api } }));
  assert.equal(nested.nodes[0].fieldValue, '9007199254740993'); assert.equal(nested.nodes[1].fieldValue, 20);
});

check('duplicate keys/fields, malformed JSON and widget-only canvases cannot invent mappings', () => {
  for (const source of ['{', '{"nodes":[{"id":1,"widgets_values":["guess"]}],"links":[]}', '{"arbitrary":"not a graph"}',
    '{"nodeInfoList":[],"nodeInfoList":[]}', JSON.stringify([field(), field()])]) assert.throws(() => parseRunningHubVideoNodes(source));
  assert.throws(() => parseRunningHubVideoNodes('[{"nodeId":"","fieldName":"text","fieldValue":"x"}]'), /空 nodeId/u);
});

check('catalog normalization strips extras, secrets, unsafe values and duplicate entries', () => {
  const raw = [{ ...field(), extraSecret: 'discard-me' }, field(), field('2', 'password', 'discard-password'),
    { ...field('3', 'seed'), fieldValue: 9007199254740992 }, { ...field('4', 'value'), fieldValue: { arbitrary: true } }, field('5', 'enabled', true)];
  const result = normalizeRunningHubVideoNodeCatalog(raw);
  assert.deepEqual(result, [field(), field('5', 'enabled', true)]);
  assert.doesNotMatch(JSON.stringify(result), /discard/u);
});

check('merge preserves user defaults, adds only missing fields, and is immutable', () => {
  const existing = [field()]; const incoming = [field('41', 'text', 'changed remotely'), field('42', 'image', 'new.png')];
  const merged = mergeRunningHubVideoNodeCatalog(existing, incoming);
  assert.deepEqual(merged, [field(), field('42', 'image', 'new.png')]); assert.notEqual(merged[0], existing[0]);
  assert.equal(existing.length, 1); assert.equal(incoming[0].fieldValue, 'changed remotely');
});

check('request fields override catalog, malformed rows do not crash, legacy complex fields stay inspectable', () => {
  const template = JSON.stringify({ nodeInfoList: [null, 17, {}, { ...field(), fieldValue: 'request wins' }, { nodeId: '9', fieldName: 'complex', fieldValue: ['8', 0] }] });
  const result = listRunningHubVideoNodes(template, [field(), field('42', 'image', '')]);
  assert.equal(result.length, 3); assert.equal(result[0].fieldValue, 'request wins'); assert.deepEqual(result[1].fieldValue, ['8', 0]);
  assert.deepEqual(listRunningHubVideoNodes('{broken', [field()]), [field()]);
});

check('ensuring one field appends without rewriting unrelated bytes or long literals', () => {
  const template = '{ "kept":9223372036854775807, "nodeInfoList": [\n ], "addMetadata":true, "custom":"line\\nend" }';
  const end = template.indexOf(']');
  const result = ensureRunningHubVideoRequestNode(template, info(field()));
  assert.equal(result, template.slice(0, end) + '\n    ' + JSON.stringify(field()) + '\n  ' + template.slice(end));
  assert.equal(ensureRunningHubVideoRequestNode(result, info(field('41', 'text', 'must not replace'))), result);
  const updated = updateRunningHubVideoNodeValue(result, { nodeId: '41', inputName: 'text' }, 'explicit edit');
  assert.match(updated, /9223372036854775807/u); assert.equal(readRunningHubVideoRequest(updated).nodeInfoList[0].fieldValue, 'explicit edit');
});

check('new fields reject complex/secret values and ambiguous request arrays', () => {
  const template = '{"nodeInfoList":[]}';
  assert.throws(() => ensureRunningHubVideoRequestNode(template, { nodeId: '1', fieldName: 'link', fieldValue: ['4', 0] }));
  assert.throws(() => ensureRunningHubVideoRequestNode(template, info(field('1', 'api_key', 'private'))));
  assert.throws(() => ensureRunningHubVideoRequestNode('{"nodeInfoList":[],"nodeInfoList":[]}', info(field())), /不唯一/u);
  assert.throws(() => ensureRunningHubVideoRequestNode(JSON.stringify({ nodeInfoList: [field(), field()] }), info(field())), /重复/u);
  const legacy = '{"nodeInfoList":[{"nodeId":"41","fieldName":"text","fieldValue":["9",0]}]}';
  assert.equal(ensureRunningHubVideoRequestNode(legacy, info(field())), legacy);
});

check('save, normalize, copy and backup retain independent sanitized catalogs without creating overrides', () => {
  const workflow = createRunningHubVideoWorkflow('节点资料'); workflow.remoteId = '2093983063180054529';
  workflow.nodeCatalog = [{ ...field(), extraSecret: 'must-strip' }, field('8', 'token', 'must-strip'), field('9', 'seed', '9223372036854775807')] as RunningHubVideoNodeCatalogEntry[];
  const saved = saveRunningHubVideoWorkflow({ ...defaultRunningHubVideoConfig }, workflow).workflows[0];
  assert.equal(saved.nodeCatalog?.length, 2); assert.doesNotMatch(JSON.stringify(saved.nodeCatalog), /must-strip/u);
  assert.equal(readRunningHubVideoRequest(saved.requestTemplate).nodeInfoList.length, 0);
  const restored = normalizeRunningHubVideoConfig({ ...defaultRunningHubVideoConfig, workflows: [saved] }).workflows[0];
  assert.deepEqual(restored.nodeCatalog, saved.nodeCatalog);
  const copy = copyRunningHubVideoWorkflow(restored); copy.nodeCatalog![0].fieldValue = 'copy only';
  assert.equal(restored.nodeCatalog![0].fieldValue, 'cloud default');
  const imported = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(restored)).workflow;
  assert.notEqual(imported.id, restored.id); assert.equal(imported.remoteId, '2093983063180054529');
  assert.deepEqual(imported.nodeCatalog, restored.nodeCatalog); assert.equal(imported.requestTemplate, restored.requestTemplate);
});

check('node catalog never enters compiled task request or changes existing template/mappings', () => {
  const workflow = createRunningHubTutorialVideoWorkflow();
  const config = { ...defaultRunningHubVideoConfig, workflows: [workflow], activeWorkflowId: workflow.id };
  const before = compileRunningHubVideoApi(config);
  workflow.nodeCatalog = [field('999', 'extra', 'do-not-submit')];
  assert.deepEqual(compileRunningHubVideoApi(config), before);
});

check('cloud FLOAT/COMBO fieldData becomes display metadata without retaining arbitrary schema fields', () => {
  const result = parseRunningHubVideoNodes(JSON.stringify({ nodeInfoList: [
    { ...field('pixels', 'megapixels', '0.5'), fieldData: JSON.stringify(['FLOAT', { min: 0.2, max: 1, step: 0.01, default: 1, privateExtra: 'discard-me' }]) },
    { ...field('ratio', 'aspect_ratio', '16:9'), fieldData: ['COMBO', { options: ['1:1', '16:9', '1:1'] }] },
    { ...field('unknown', 'value', '0.5'), fieldData: 'not JSON' },
  ] }));
  assert.deepEqual(result.nodes[0].control, { kind: 'number', min: 0.2, max: 1, step: 0.01 });
  assert.equal(result.nodes[0].fieldValue, '0.5', 'schema default never replaces saved cloud request value');
  assert.deepEqual(result.nodes[1].control, { kind: 'select', options: ['1:1', '16:9'] });
  assert.equal(result.nodes[2].control, undefined);
  assert.doesNotMatch(JSON.stringify(result), /privateExtra|discard-me|fieldData/u);
  assert.deepEqual(parseRunningHubVideoFieldData(['INT', { min: '1', max: '20', step: '1' }]), { kind: 'number', min: 1, max: 20, step: 1 });
  assert.deepEqual(normalizeRunningHubVideoFieldControl({ kind: 'number', min: 2, max: 1, step: 0 }), { kind: 'number' });
  assert.deepEqual(normalizeRunningHubVideoFieldControl({ kind: 'select', unit: 'MP', options: ['0.2', '0.5', '1.0'], min: 0.2, max: 1, step: 0.1 }),
    { kind: 'select', unit: 'MP', options: ['0.2', '0.5', '1.0'], min: 0.2, max: 1, step: 0.1 }, 'explicit range metadata survives without inventing additional dropdown choices');
  assert.deepEqual(normalizeRunningHubVideoFieldControl({ kind: 'select', options: ['0.2', '1.0'], optionLabels: { '0.2': '608 × 352', '1.0': '1376 × 768', '0.98': 'not an option' }, optionLabelAspectRatio: '16:9' }),
    { kind: 'select', options: ['0.2', '1.0'], optionLabels: { '0.2': '608 × 352', '1.0': '1376 × 768' }, optionLabelAspectRatio: '16:9' });
});

check('cloud metadata refresh enriches old catalogs while preserving saved defaults and request bytes', () => {
  const existing = [{ ...field('pixels', 'megapixels', '0.5'), description: 'saved title' }];
  const incoming = [{ ...field('pixels', 'megapixels', '0.8'), control: { kind: 'number' as const, min: 0.2, max: 1, step: 0.01 } }];
  const merged = mergeRunningHubVideoNodeCatalog(existing, incoming);
  assert.equal(merged[0].fieldValue, '0.5'); assert.equal(merged[0].description, 'saved title');
  assert.deepEqual(merged[0].control, incoming[0].control);
  const request = JSON.stringify({ nodeInfoList: [{ ...field('pixels', 'megapixels', '0.6') }] });
  const listed = listRunningHubVideoNodes(request, merged);
  assert.equal(listed[0].fieldValue, '0.6'); assert.deepEqual(listed[0].control, incoming[0].control);
  assert.equal(existing[0].fieldValue, '0.5'); assert.equal('control' in existing[0], false);
  const appended = ensureRunningHubVideoRequestNode('{"nodeInfoList":[]}', info(merged[0]));
  assert.equal(readRunningHubVideoRequest(appended).nodeInfoList[0].fieldValue, '0.5');
  assert.doesNotMatch(appended, /control|options|step|"min"|"max"/u, 'local control metadata is never sent as a cloud node field');
});

console.log(`RunningHub node catalog: ${groups} groups passed, no network requests.`);
