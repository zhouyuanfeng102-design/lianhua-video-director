import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGeneratedImageData } from '../src/generatedImageData';
import { requestImageModel } from '../src/services/llm';
import type { ImageApiConfig } from '../src/types';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8')) as Record<'png' | 'jpeg' | 'webp' | 'webpLossless' | 'webpExtended', string>;
const originalWindow = globalThis.window;
const config: ImageApiConfig = { enabled: true, backend: 'openai', baseUrl: 'https://mock-images.invalid', apiKey: '', model: 'mock-image-model' };
const decode = (value: string) => Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
let requestCount = 0;
try {
  for (const [variant, encoded] of Object.entries(samples).filter(([name]) => name !== 'description')) {
    const format = variant.startsWith('webp') ? 'webp' : variant;
    const expected = `data:image/${format};base64,${encoded}`;
    for (const value of [encoded, encoded.replace(/=+$/u, ''), encoded.replace(/\+/gu, '-').replace(/\//gu, '_'), `data:image/png;base64,${encoded}`, `data:IMAGE/JPEG;charset=utf-8;base64,${encoded}`, `data:application/octet-stream;base64,${encoded}`]) {
      const result = normalizeGeneratedImageData(value);
      assert.equal(result, expected);
      assert.deepEqual(decode(result), Buffer.from(encoded, 'base64'), 'normalization must preserve original encoded bytes');
    }
    for (const backend of ['openai', 'sd_webui'] as const) for (const labeled of [false, true]) {
      let submitted: Record<string, unknown> | undefined;
      const value = labeled ? `data:image/png;base64,${encoded}` : encoded;
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { body?: string }) => {
        requestCount += 1; submitted = JSON.parse(payload.body || '{}');
        return { status: 200, body: JSON.stringify(backend === 'sd_webui' ? { images: [value] } : { data: [{ b64_json: value }] }) };
      } } } });
      const result = await requestImageModel({ ...config, backend }, { prompt: 'unchanged local test prompt', width: 640, height: 384 });
      assert.equal(result.dataUrl, expected, `${backend} must recognize actual ${format} bytes`);
      assert.equal(submitted?.prompt, 'unchanged local test prompt');
      if (backend === 'sd_webui') { assert.equal(submitted?.width, 640); assert.equal(submitted?.height, 384); }
      else assert.equal(submitted?.size, '640x384');
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
      request: async () => { requestCount += 1; return { status: 200, body: JSON.stringify({ data: [{ url: 'https://mock-cdn.invalid/file' }] }) }; },
      downloadImage: async () => `data:image/png;base64,${encoded}`,
    } } });
    assert.equal((await requestImageModel(config, 'local mock download')).dataUrl, expected, 'a wrong downloaded Content-Type label is corrected from bytes');
  }
  for (const value of ['AA==', '%%%', 'A', 'data:image/png;base64,', Buffer.from('{"error":"mock failure"}').toString('base64'), Buffer.from('<html>mock error</html>').toString('base64'), Buffer.from([0x89, 0x50]).toString('base64')]) {
    assert.throws(() => normalizeGeneratedImageData(value), /图片|Base64/u);
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async () => {
      requestCount += 1; return { status: 200, body: JSON.stringify({ data: [{ b64_json: value }] }) };
    } } } });
    await assert.rejects(() => requestImageModel(config, 'local bad response mock'), /图片|Base64/u);
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async () => ({ status: 200, body: JSON.stringify({ data: [{ url: 'https://mock-cdn.invalid/error' }] }) }),
    downloadImage: async () => { throw new Error('生成图片内容已损坏或截断，无法解码为有效图片'); },
  } } });
  await assert.rejects(() => requestImageModel(config, 'local invalid downloaded image'), /损坏|截断/u, 'invalid download bytes cannot silently fall back to a successful remote image');
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }
console.log(`generated image byte format checks passed (${requestCount} mock requests, zero real API calls): PNG/JPEG/WebP, bare/dataURL/download labels, unchanged bytes/parameters, and error-body rejection`);
