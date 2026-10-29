import assert from 'node:assert/strict';
import { importRunningHubImageWorkflow } from '../src/runningHubImage';
import { runningHubImageSizeMode, runningHubImageTierParameters } from '../src/runningHubImageSize';
import { IMAGE_V3_CURL } from './fixtures/runningHubImageV3';

const workflow = () => {
  const value = importRunningHubImageWorkflow(IMAGE_V3_CURL).workflow;
  value.mapping.parameters = { resolution: { nodeId: '189', inputName: 'value' }, aspect_ratio: { nodeId: '194', inputName: 'aspect_ratio' } };
  return value;
};
const resolutionValue = (value: ReturnType<typeof workflow>, original: unknown) => {
  const body = JSON.parse(value.requestTemplate);
  body.nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '189').fieldValue = original;
  value.requestTemplate = JSON.stringify(body);
};
let groups = 0;
const check = (name: string, run: () => void) => { run(); groups += 1; console.log(`PASS ${name}`); };

check('only explicit real bindings select a size mode, and complete pixel fields take precedence', () => {
  assert.equal(runningHubImageSizeMode(), 'default');
  const value = workflow();
  assert.equal(runningHubImageSizeMode(value), 'tier');
  value.mapping.parameters = {};
  assert.equal(runningHubImageSizeMode(value), 'default');
  const body = JSON.parse(value.requestTemplate);
  body.nodeInfoList.push({ nodeId: 'w', fieldName: 'width', fieldValue: '' }, { nodeId: 'h', fieldName: 'height', fieldValue: '' });
  value.requestTemplate = JSON.stringify(body);
  value.mapping.parameters = { resolution: { nodeId: '189', inputName: 'value' }, width: { nodeId: 'w', inputName: 'width' }, height: { nodeId: 'h', inputName: 'height' } };
  assert.equal(runningHubImageSizeMode(value), 'pixels', 'empty string defaults remain valid explicit pixel override inputs');
  delete value.mapping.parameters.height;
  assert.equal(runningHubImageSizeMode(value), 'tier');
  value.mapping.parameters.resolution.nodeId = 'missing';
  assert.equal(runningHubImageSizeMode(value), 'default');
});

check('numeric edges retain number or string wire types and never mutate cloud defaults', () => {
  for (const original of ['2048', 2048]) {
    const value = workflow(); resolutionValue(value, original);
    const before = JSON.stringify(value);
    for (const [tier, edge] of [['1K', 1024], ['2K', 2048], ['4K', 4096]] as const) {
      assert.deepEqual(runningHubImageTierParameters(value, tier, '3:4'), { resolution: typeof original === 'string' ? String(edge) : edge, aspect_ratio: '3:4' });
    }
    assert.equal(JSON.stringify(value), before);
  }
});

check('K spelling and full declared resolution options are retained', () => {
  const value = workflow(); resolutionValue(value, '2k');
  assert.equal(runningHubImageTierParameters(value, '4K').resolution, '4k');
  resolutionValue(value, '2K');
  assert.equal(runningHubImageTierParameters(value, '1K').resolution, '1K');
  value.fieldControls = { '["189","value"]': { kind: 'select', options: ['1K (Small)', '2K (Medium)', '4K (Large)'] } };
  assert.equal(runningHubImageTierParameters(value, '2K').resolution, '2K (Medium)');
  value.fieldControls['["189","value"]'].options = ['1024 (1K)', '2048 (2K)'];
  assert.equal(runningHubImageTierParameters(value, '2K').resolution, '2048 (2K)');
  assert.throws(() => runningHubImageTierParameters(value, '4K'), /没有唯一.*4K.*不会自动改档/u);
});

check('MP, P presets and linked fields cannot be guessed as K tiers', () => {
  for (const original of ['0.8', 0.8, '2.0000000000000004', '1080P', '2048x2048', ['source', 0], false]) {
    const value = workflow(); resolutionValue(value, original);
    const megapixel = original === '0.8' || original === 0.8 || original === '2.0000000000000004';
    assert.equal(runningHubImageSizeMode(value), megapixel ? 'megapixels' : 'default', String(original));
    assert.throws(() => runningHubImageTierParameters(value, '2K'), /未绑定可识别.*MP.*P/u);
  }
  const value = workflow();
  value.fieldControls = { '["189","value"]': { kind: 'number', unit: 'MP' } };
  assert.equal(runningHubImageSizeMode(value), 'megapixels');
  assert.throws(() => runningHubImageTierParameters(value, '2K'), /MP/u);
});

check('aspect overrides match complete option ratios and never invent an unbound parameter', () => {
  const value = workflow();
  value.fieldControls = { '["194","aspect_ratio"]': { kind: 'select', options: ['1:1 (Square)', '3:4 (Portrait)'] } };
  assert.deepEqual(runningHubImageTierParameters(value, '2K', '6:8'), { resolution: '2048', aspect_ratio: '3:4 (Portrait)' });
  assert.throws(() => runningHubImageTierParameters(value, '2K', '16:9'), /比例.*没有唯一.*不会忽略/u);
  value.mapping.parameters!.aspect_ratio.nodeId = 'missing';
  assert.throws(() => runningHubImageTierParameters(value, '2K', '3:4'), /真实文本字段映射/u);
  delete value.mapping.parameters!.aspect_ratio;
  assert.deepEqual(runningHubImageTierParameters(value, '2K', '3:4'), { resolution: '2048' });
});

check('ambiguous or absent resolution bindings fail explicitly', () => {
  const value = workflow();
  value.fieldControls = { '["189","value"]': { kind: 'select', options: ['2K', '2048'] } };
  assert.throws(() => runningHubImageTierParameters(value, '2K'), /没有唯一/u);
  const body = JSON.parse(value.requestTemplate);
  body.nodeInfoList.push({ ...body.nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '189') });
  value.requestTemplate = JSON.stringify(body);
  assert.equal(runningHubImageSizeMode(value), 'default');
  assert.throws(() => runningHubImageTierParameters(value, '2K'), /未绑定可识别/u);
});

console.log(`RunningHub image size helpers: ${groups} groups passed; pure local parameters only.`);
