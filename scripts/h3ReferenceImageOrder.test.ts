import assert from 'node:assert/strict';
import { compileH3ReferenceImageOrders, readH3ReferenceImageOrders, resolveComfyH3PictureNumbers, resolveH3PictureNumbers } from '../src/h3ReferenceImageOrder';
import { compileRunningHubH3ReferenceImages, resolveRunningHubH3PictureNumbers } from '../src/runningHubH3ReferenceImages';
import { mergeRunningHubVideoNodeCatalog, parseRunningHubVideoNodes } from '../src/runningHubVideoNodes';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow, defaultRunningHubVideoConfig,
  exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, saveRunningHubVideoWorkflow } from '../src/runningHubVideo';
import type { RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

let groups = 0;
const check = (name: string, fn: () => void) => { fn(); groups += 1; console.log(`PASS ${name}`); };
// Reduced from the supplied MOV's execution graph. Numeric node enumeration is
// 19,23,43,49,50,51; H3 consumes 51,49,50,43,19,23 instead.
const imageIds = ['19', '23', '43', '49', '50', '51'];
const mapping = { prompt: [{ nodeId: '263', inputName: 'text' }], images: imageIds.map((nodeId) => ({ nodeId, inputName: 'image' })) };
const graph = () => ({
  ...Object.fromEntries(imageIds.map((id) => [id, { class_type: 'LoadImage', inputs: { image: `${id}.png` } }])),
  '263': { class_type: 'Text', inputs: { text: 'original action sequence' } },
  '265': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
    'ref_images.ref_image_0': ['51', 0], 'ref_images.ref_image_1': ['49', 0], length: 181,
    'ref_images.ref_image_2': ['50', 0], ref_image_size: 'match',
    'ref_images.ref_image_3': ['43', 0], 'ref_images.ref_image_4': ['19', 0],
    'ref_images.ref_image_5': ['23', 0], prompt: ['263', 0],
  } },
});
const workflow = (): RunningHubVideoWorkflow => {
  const nodes = parseRunningHubVideoNodes(JSON.stringify(graph())).nodes;
  return { ...createRunningHubVideoWorkflow('H3 execution order fixture'), runKind: 'workflow', remoteId: '2112208448657412098',
    mapping: structuredClone(mapping), nodeCatalog: nodes,
    requestTemplate: JSON.stringify({ nodeInfoList: nodes.map(({ nodeId, fieldName, fieldValue }) => ({ nodeId, fieldName, fieldValue })) }) };
};
const compile = (value: RunningHubVideoWorkflow) => compileRunningHubVideoApi({ ...defaultRunningHubVideoConfig,
  enabled: true, workflows: [value], activeWorkflowId: value.id });

check('six reference numbers follow H3 input links rather than numeric LoadImage IDs', () => {
  const api = compile(workflow());
  assert.deepEqual(resolveRunningHubH3PictureNumbers(api, [0, 1, 2, 3, 4, 5]), [5, 6, 4, 2, 3, 1]);
  const local = { workflowJson: JSON.stringify(graph()), mapping };
  assert.deepEqual(resolveComfyH3PictureNumbers(local, [0, 1, 2, 3, 4, 5]), [5, 6, 4, 2, 3, 1]);
  assert.deepEqual(resolveComfyH3PictureNumbers({ ...local, workflowJson: JSON.stringify({ prompt: graph() }) }, [0]), [5]);
});

check('cloud empty slots compress numbers; local retained defaults still consume pictures', () => {
  const api = compile(workflow());
  assert.deepEqual(resolveRunningHubH3PictureNumbers(api, [0, 2, 5]), [3, 2, 1]);
  assert.deepEqual(resolveRunningHubH3PictureNumbers(api, [5, 0]), [1, 2]);
  assert.deepEqual(resolveComfyH3PictureNumbers({ workflowJson: JSON.stringify(graph()), mapping }, [0, 2, 5]), [5, 4, 1]);
  const localGraph = graph();
  (localGraph as Record<string, { inputs: Record<string, unknown> }>)['49'].inputs.image = 'None';
  assert.deepEqual(resolveComfyH3PictureNumbers({ workflowJson: JSON.stringify(localGraph), mapping }, [0, 2, 5]), [4, 3, 1]);
});

check('upload slot identities stay fixed while prompt picture numbers follow the consumer', () => {
  const api = compile(workflow());
  const result = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, {
    prompt: 'Picture 3 advances; Picture 1 counters.', parameters: {},
    references: [{ slotIndex: 0 }, { slotIndex: 2 }, { slotIndex: 5 }] as never,
  }, ['opening.png', 'shoulder.png', 'short-identity.png']);
  const raw = typeof result === 'string' ? JSON.parse(result) : result;
  const image = (id: string) => raw.nodeInfoList.find((node: { nodeId: string; fieldName: string }) => node.nodeId === id && node.fieldName === 'image')?.fieldValue;
  assert.equal(image('19'), 'opening.png'); assert.equal(image('43'), 'shoulder.png'); assert.equal(image('51'), 'short-identity.png');
  assert.equal(image('23'), ''); assert.equal(image('49'), ''); assert.equal(image('50'), '');
  assert.ok(!JSON.stringify(raw).includes('h3ReferenceImages'));
});

check('graph evidence survives merge, normalization, save, export and reimport', () => {
  const source = workflow();
  source.nodeCatalog = mergeRunningHubVideoNodeCatalog(source.nodeCatalog, parseRunningHubVideoNodes(JSON.stringify(graph())).nodes);
  const saved = saveRunningHubVideoWorkflow({ ...defaultRunningHubVideoConfig, workflows: [source] }, source).workflows[0];
  const restored = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(saved)).workflow;
  assert.deepEqual(resolveRunningHubH3PictureNumbers(compile(restored), [0, 1, 2, 3, 4, 5]), [5, 6, 4, 2, 3, 1]);
  const metadata = restored.nodeCatalog?.flatMap((node) => node.h3ReferenceImages || []);
  assert.ok(metadata?.length); assert.ok(!JSON.stringify(metadata).includes('original action sequence'));
  assert.ok(!JSON.stringify(metadata).includes('.png'));
});

check('only the verified legacy topology is recovered, and imported links take precedence', () => {
  const old = workflow();
  old.nodeCatalog = old.nodeCatalog!.map(({ h3ReferenceImages: _order, ...node }) => node);
  assert.deepEqual(resolveRunningHubH3PictureNumbers(compile(old), [0, 1, 2, 3, 4, 5]), [5, 6, 4, 2, 3, 1]);
  assert.equal(compileRunningHubH3ReferenceImages({ ...old, remoteId: 'different-app' }, []), undefined);
  assert.equal(compileRunningHubH3ReferenceImages({ ...old, mapping: { ...old.mapping, prompt: [{ nodeId: '59', inputName: 'prompt' }] } }, []), undefined);
  const updated = graph();
  updated['265'].inputs['ref_images.ref_image_0'] = ['19', 0];
  updated['265'].inputs['ref_images.ref_image_4'] = ['51', 0];
  old.nodeCatalog = mergeRunningHubVideoNodeCatalog(old.nodeCatalog, parseRunningHubVideoNodes(JSON.stringify(updated)).nodes);
  assert.deepEqual(resolveRunningHubH3PictureNumbers(compile(old), [0, 1, 2, 3, 4, 5]), [1, 6, 4, 2, 3, 5]);
  const noH3 = graph(); noH3['265'].class_type = 'UnrelatedReferenceNode';
  delete (noH3 as Record<string, unknown>)['263'];
  old.nodeCatalog = mergeRunningHubVideoNodeCatalog(old.nodeCatalog, parseRunningHubVideoNodes(JSON.stringify(noH3)).nodes);
  assert.equal(compile(old).runningHubH3ReferenceImages, undefined);
});

check('empty dynamic inputs are omitted, but unmapped static images retain a number', () => {
  const value = graph() as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  value['265'].inputs['ref_images.ref_image_2'] = null;
  const partialMapping = { ...mapping, images: [mapping.images[0], mapping.images[5]] };
  const compiled = compileH3ReferenceImageOrders(readH3ReferenceImageOrders(value), partialMapping,
    (_source, slotIndex, present) => slotIndex === undefined && present);
  assert.deepEqual(resolveH3PictureNumbers(compiled, [0, 1]), [4, 1]);
  value['265'].inputs['ref_images.ref_image_0'] = ['unknown-batch', 0];
  assert.equal(resolveH3PictureNumbers(compileH3ReferenceImageOrders(readH3ReferenceImageOrders(value), partialMapping,
    (_source, _slotIndex, present) => present), [0, 1]), undefined);
});

console.log(`H3 reference input order: ${groups} groups passed.`);
