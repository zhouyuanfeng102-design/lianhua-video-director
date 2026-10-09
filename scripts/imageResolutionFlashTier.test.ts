import assert from 'node:assert/strict';
import { assertImageResolutionPlanForConfig, normalizeImageResolutionPlan, resolveImageResolution } from '../src/imageResolution';
import type { ImageApiConfig } from '../src/types';

const config: ImageApiConfig = {
  enabled: true, backend: 'openai', model: 'gemini-2.5-flash-image',
  imageProtocol: 'gemini', baseUrl: '', apiKey: '',
};
const oneK = resolveImageResolution({ tier: '1K', logicalAspectRatio: '3:2', config });
assert.equal(oneK.warning, undefined);
assert.equal(oneK.resolutionPlan?.verified, true);
assert.deepEqual(oneK.resolutionPlan?.encoding, { kind: 'tier', value: '1K' });

for (const [tier, scale] of [['2K', 2], ['4K', 4]] as const) {
  const result = resolveImageResolution({ tier, logicalAspectRatio: '3:2', config });
  assert.equal(result.issue, '', 'an undeclared tier must remain submit-able');
  assert.deepEqual([result.width, result.height], [1248 * scale, 832 * scale]);
  assert.match(result.warning || '', /未声明/u);
  assert.match(result.warning || '', /高档像素.*估算.*实际像素以服务返回为准/u);
  assert.deepEqual(result.resolutionPlan?.encoding, { kind: 'tier', value: tier }, 'native transport must receive the selected imageSize tier');
  assert.equal(result.resolutionPlan?.verified, false, 'estimated native sizes must not be reported as verified');
  const saved = normalizeImageResolutionPlan(JSON.parse(JSON.stringify(result.resolutionPlan)));
  assert.ok(saved);
  assert.equal(saved.tier, tier);
  assert.deepEqual(saved.encoding, { kind: 'tier', value: tier });
  assert.doesNotThrow(() => assertImageResolutionPlanForConfig(saved, config), 'frozen high-tier requests must remain retry-able');
}

console.log('Gemini Flash high-tier resolution tests passed (23 checks)');
