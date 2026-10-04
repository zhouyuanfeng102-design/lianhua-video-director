import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createImageApiRequestError } from '../src/imageApiError';
import { requestImageModel } from '../src/services/llm';
import { formatUserFacingError } from '../src/userFacingError';
import { createRuntimeErrorLogEntry } from '../src/runtimeErrorLog';
import type { ImageApiConfig } from '../src/types';

const config: ImageApiConfig = { enabled: true, backend: 'openai', baseUrl: 'https://images.example.test/v1', apiKey: 'qa-image-secret', model: 'qa-image-model' };
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let calls = 0;
let response = { status: 503, body: '' };
let multipartCount = 0;
const { buildImageEditMultipart } = createRequire(import.meta.url)('../electron/imageReferenceTransport.cjs');
globalThis.fetch = async () => { throw new Error('Live network forbidden in image API error tests'); };
Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: { request: async (payload: { multipart?: { files: unknown[] } }) => {
  calls += 1;
  if (payload.multipart) {
    const encoded = buildImageEditMultipart(payload.multipart);
    multipartCount = (encoded.body.toString('latin1').match(/name="image\[\]"/gu) || []).length;
  }
  return response;
} } } });
try {
  for (const [status, message, code, localized] of [
    [429, 'No available image quota. Please try again later.', 'image_quota_unavailable', '上游当前没有可用的图像生成额度'],
    [503, 'System is overloaded. Please try again later.', 'overloaded', '上游服务当前负载过高'],
  ] as const) {
    response = { status, body: JSON.stringify({ error: { message, code } }) };
    const previousCalls = calls;
    await assert.rejects(() => requestImageModel(config, '隔离请求'), (value: unknown) => {
      const error = value as Error & { status: number; code: string };
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.ok(error.message.includes(message));
      assert.ok(error.message.includes(`HTTP ${status}`));
      const visible = formatUserFacingError(error);
      assert.ok(visible.includes(localized), visible);
      assert.ok(visible.includes(String(status)), visible);
      assert.equal(formatUserFacingError(visible), visible, 'stored task messages must not gain duplicate HTTP explanations');
      const diagnostic = createRuntimeErrorLogEntry({ stage: 'image-generation', error });
      assert.equal(diagnostic?.status, status);
      assert.equal(diagnostic?.code, code);
      return true;
    });
    assert.equal(calls, previousCalls + 1, 'failure must not silently re-submit a paid image request');
  }
  const simple = createImageApiRequestError(400, '', { message: 'Invalid parameters', code: 'invalid_request' });
  assert.equal(simple.code, 'invalid_request');
  assert.match(simple.message, /Invalid parameters/u);
  const plain = createImageApiRequestError(502, 'Bad gateway', null);
  assert.match(plain.message, /HTTP 502.*Bad gateway/u);
  const blank = createImageApiRequestError(500, '', null);
  assert.match(blank.message, /HTTP 500.*未提供错误说明/u);
  const privatePrompt = '私有剧情完整内容，不应被回显';
  const privatePixels = 'data:image/png;base64,aGVsbG8=';
  const redacted = createImageApiRequestError(400, '', { error: {
    message: `Rejected qa-image-secret ${privatePrompt} ${privatePixels} authorization: Bearer server-secret`,
    code: 'qa-image-secret',
  } }, [config.apiKey, privatePrompt, privatePixels]);
  for (const secret of [config.apiKey, privatePrompt, privatePixels, 'server-secret']) assert.ok(!JSON.stringify({ message: redacted.message, code: redacted.code }).includes(secret));
  assert.match(redacted.message, /已脱敏/u);
  const objectOnly = createImageApiRequestError(400, '', { error: { requestBody: { prompt: privatePrompt, apiKey: config.apiKey } } });
  assert.ok(!objectOnly.message.includes(privatePrompt));
  assert.ok(!objectOnly.message.includes(config.apiKey));
  const pngFixture = Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8')).png, 'base64');
  // Valid PNGs with distinct legal trailing padding keep the thirteen-input
  // coverage without relying on truncated signature-only pseudo-images.
  const references = Array.from({ length: 13 }, (_, index) => `data:image/png;base64,${Buffer.concat([pngFixture, Buffer.alloc(index)]).toString('base64')}`);
  const referenceSnapshot = [...references];
  response = { status: 503, body: JSON.stringify({ error: { message: 'System is overloaded. Please try again later.' } }) };
  const beforeReferences = calls;
  await assert.rejects(() => requestImageModel(config, { prompt: '十三张参考图隔离验证', referenceImages: references }), /HTTP 503.*overloaded/u);
  assert.equal(multipartCount, 13, 'all13 actual task references must reach the desktop multipart encoder');
  assert.equal(calls, beforeReferences + 1, 'sending13 references must not fan out into extra requests');
  assert.deepEqual(references, referenceSnapshot, 'no reference may be silently discarded or reordered');
  console.log('Image API error status/code, quota/overload, redaction and no automatic retry checks passed');
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
