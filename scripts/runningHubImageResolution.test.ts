import assert from 'node:assert/strict';
import { importRunningHubImageWorkflow, buildRunningHubImageRequest, validateRunningHubImageConfig } from '../src/runningHubImage';
import { assertImageResolutionPlanForConfig, resolveImageResolution, resolveImageResolutionCapabilities } from '../src/imageResolution';
import { defaultImageOutputSize, resolveImageOutputSize } from '../src/imageOutputSize';
import type { ImageApiConfig } from '../src/types';

// Synthetic cloud request templates only; no credentials, files or network.
const body = { instanceType: 'default', usePersonalQueue: false, nodeInfoList: [
  { nodeId: '95', fieldName: 'width', fieldValue: '1920', description: '宽度 width' },
  { nodeId: '96', fieldName: 'height', fieldValue: 1280, description: '高度 height' },
  { nodeId: '115', fieldName: 'prompt', fieldValue: 'synthetic business input' },
] };
const config = (): ImageApiConfig => {
  const imported = importRunningHubImageWorkflow(JSON.stringify({ ...body,
    endpoint: 'https://www.runninghub.ai/openapi/v2/run/ai-app/2070152175753453569' }), 'Synthetic Krea2');
  return { enabled: true, backend: 'runninghub', baseUrl: 'https://www.runninghub.ai', apiKey: 'SYNTHETIC_KEY', model: 'Krea2',
    runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id };
};
const defaults = { mode: 'default' as const, aspect: 'variant' as const, width: 1024, height: 1024 };
let checks = 0;
const test = (label: string, check: () => void) => { check(); checks += 1; console.log(`PASS ${label}`); };

test('selected mapped workflow uses pixel dimensions, default eight-pixel steps and explicit workflow step settings', () => {
  const current = { ...config(), imageResolutionProfile: 'gemini-k' as const, imageProtocol: 'gemini' as const, imagePixelStep: 16 };
  const capabilities = resolveImageResolutionCapabilities(current);
  assert.equal(capabilities.profile, 'pixel-long-edge');
  assert.equal(capabilities.protocol, 'openai-compatible');
  assert.equal(resolveImageResolutionCapabilities(config()).pixelStep, 8);
  assert.equal(capabilities.pixelStep, 16);
  assert.deepEqual(capabilities.supportedTiers, ['1K']);
  assert.equal(capabilities.verified, false);
  const size = resolveImageResolution({ tier: '2K', logicalAspectRatio: '16:9', config: current });
  assert.equal(size.issue, '');
  assert.deepEqual([size.width, size.height], [2048, 1152]);
  assert.deepEqual(size.resolutionPlan?.encoding, { kind: 'width-height', width: 2048, height: 1152 });
  assertImageResolutionPlanForConfig(size.resolutionPlan!, current);
});

test('workflow-default mode reports mapped cloud defaults and never overrides their original values or types', () => {
  const current = config();
  const frozen = structuredClone(current);
  const size = resolveImageOutputSize(defaults, { width: 1024, height: 1024 }, current, 'reference');
  assert.deepEqual([size.width, size.height, size.sizeOverride, size.issue], [1920, 1280, false, '']);
  assert.match(size.layoutNote, /云端工作流默认尺寸.*不覆盖/u);
  const request = buildRunningHubImageRequest(current, { prompt: 'current authored input', ...size });
  const nodes = request.body.nodeInfoList as typeof body.nodeInfoList;
  assert.equal(nodes[0].fieldValue, '1920');
  assert.equal(nodes[1].fieldValue, 1280);
  assert.equal(nodes[2].fieldValue, 'current authored input');
  assert.deepEqual(current, frozen);
});

test('explicit custom pixels remain exact with an alignment advisory and change only mapped dimension fields', () => {
  const current = config();
  const size = resolveImageOutputSize({ ...defaultImageOutputSize(), mode: 'custom', width: 1025, height: 1023 },
    { width: 1024, height: 1024 }, current, 'reference');
  assert.deepEqual([size.width, size.height, size.sizeOverride, size.issue], [1025, 1023, true, '']);
  assert.match(size.warning || '', /8的倍数/u);
  const request = buildRunningHubImageRequest(current, { prompt: 'current authored input', ...size });
  const nodes = request.body.nodeInfoList as typeof body.nodeInfoList;
  assert.equal(nodes[0].fieldValue, '1025');
  assert.equal(nodes[1].fieldValue, 1023);
  assert.equal(request.body.instanceType, body.instanceType);
  assert.equal(request.body.usePersonalQueue, body.usePersonalQueue);
  assertImageResolutionPlanForConfig(size.resolutionPlan!, current);
  const legacy = resolveImageOutputSize({ ...defaults, mode: 'custom', width: 1025, height: 1023 }, { width: 1024, height: 1024 }, current, 'reference');
  assert.deepEqual([legacy.width, legacy.height, legacy.issue], [1025, 1023, '']);
  assert.match(legacy.warning || '', /8的倍数/u);
});

test('missing or deleted cloud dimension bindings block explicit size choices while default requests retain the template', () => {
  for (const mutate of [
    (current: ImageApiConfig) => { current.runningHubWorkflows![0].mapping.parameters = {}; },
    (current: ImageApiConfig) => { delete current.runningHubWorkflows![0].mapping.parameters!.height; },
    (current: ImageApiConfig) => { current.activeRunningHubWorkflowId = 'deleted-workflow'; },
  ]) {
    const current = config(); mutate(current);
    assert.deepEqual(resolveImageResolutionCapabilities(current).supportedTiers, []);
    const size = resolveImageOutputSize(defaultImageOutputSize(), { width: 1024, height: 1024 }, current, 'reference');
    assert.match(size.issue, /选择.*工作流|绑定.*宽度.*高度/u);
    const legacySize = resolveImageOutputSize({ ...defaults, mode: '2x' }, { width: 1024, height: 1024 }, current, 'reference');
    assert.ok(legacySize.issue);
    if (current.activeRunningHubWorkflowId !== 'deleted-workflow') {
      const cloudDefault = resolveImageOutputSize(defaults, { width: 1024, height: 1024 }, current, 'reference');
      assert.equal(cloudDefault.issue, '');
      assert.equal(cloudDefault.sizeOverride, false);
      assert.match(cloudDefault.warning || '', /版式估算.*不覆盖/u);
      const request = buildRunningHubImageRequest(current, { prompt: 'keep default', ...cloudDefault });
      const nodes = request.body.nodeInfoList as typeof body.nodeInfoList;
      assert.equal(nodes[0].fieldValue, '1920');
      assert.equal(nodes[1].fieldValue, 1280);
    }
  }
});

test('reference capacity validation rejects Krea2 selections and permits declared image slots without resizing defaults', () => {
  const current = config();
  assert.match(validateRunningHubImageConfig(current, 1) || '', /0.*图片输入槽.*不会忽略/u);
  const workflow = current.runningHubWorkflows![0];
  const template = JSON.parse(workflow.requestTemplate);
  template.nodeInfoList.push({ nodeId: 'image-input', fieldName: 'image', fieldValue: '', description: 'image upload input' });
  workflow.requestTemplate = JSON.stringify(template);
  workflow.mapping.images = [{ nodeId: 'image-input', inputName: 'image', role: 'general' }];
  assert.equal(validateRunningHubImageConfig(current, 1), undefined);
  assert.match(validateRunningHubImageConfig(current, 2) || '', /1.*图片输入槽.*不能接收 2/u);
  const size = resolveImageOutputSize(defaults, { width: 1024, height: 1024 }, current, 'reference');
  assert.deepEqual([size.width, size.height, size.sizeOverride], [1920, 1280, false]);
});

console.log(`RunningHub image resolution and gates: ${checks} targeted offline checks passed.`);
