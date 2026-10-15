import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV6kVideoApiBody, buildV6kVideoApiRequest, isV6kVideoBuiltinProtocol } from '../src/v6kVideoApi';
import type { ReferenceRole } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const png = `data:image/png;base64,${samples.png}`;
const jpeg = `data:image/jpeg;base64,${samples.jpeg}`;
const webp = `data:image/webp;base64,${samples.webp}`;
const config = { provider: 'generic' as const, endpoint: 'https://www.v6k.top/v1/videos', model: 'LLseadance2.5X' };
const draft: VideoGenerationDraft = { name: 'v6k 图像传输', backend: 'api', prompt: '保持所有参考图顺序，保留这段原文。', references: [],
  parameters: { duration: '12', seconds: 12, aspect_ratio: '16:9', ratio: '16:9', resolution: '4K', seed: 0,
    watermark: false, metadata: { title: '原文', labels: ['一', '二'], nullable: null } } };
const withImages = (count: number): VideoGenerationDraft => ({ ...draft,
  references: Array.from({ length: count }, (_, index) => ({ assetId: `ref-${index}`, role: (index === 0 ? 'first-frame' : index === count - 1 ? 'last-frame' : 'middle-frame') as ReferenceRole })) });

for (const endpoint of ['https://www.v6k.top/v1/videos', 'https://v6k.top/v1/videos/']) {
  assert.equal(isV6kVideoBuiltinProtocol({ ...config, endpoint }), true);
  assert.equal(isV6kVideoBuiltinProtocol({ ...config, provider: undefined, endpoint }), true);
}
assert.equal(isV6kVideoBuiltinProtocol({ ...config, endpoint: '', baseUrl: 'https://v6k.top' }), true);
for (const endpoint of ['https://evil.v6k.top/v1/videos', 'https://v6k.top.evil.invalid/v1/videos', 'https://other.invalid/v1/videos',
  'https://www.v6k.top/v1/generations', 'https://www.v6k.top/v1/videos/custom', 'not-a-url']) {
  assert.equal(isV6kVideoBuiltinProtocol({ ...config, endpoint }), false, endpoint);
}
assert.equal(isV6kVideoBuiltinProtocol({ ...config, provider: 'minimax' }), false);
assert.equal(isV6kVideoBuiltinProtocol({ ...config, requestTemplate: '{"images":"{{images}}"}' }), false);
assert.equal(isV6kVideoBuiltinProtocol({ ...config, requestTemplate: '  ' }), true);

const headers = { Authorization: 'Bearer mocked-token', 'cOnTeNt-TyPe': 'application/json', 'Idempotency-Key': 'task-1' };
for (const count of [5, 6, 7]) {
  const input = withImages(count);
  const before = structuredClone(input);
  const images = Array.from({ length: count }, (_, index) => [png, jpeg, webp][index % 3]);
  const body = buildV6kVideoApiBody(config, input, images);
  assert.deepEqual(body, { model: config.model, ...draft.parameters, prompt: draft.prompt, images });
  assert.equal(Object.hasOwn(body, 'first_frame_image'), false);
  assert.equal(Object.hasOwn(body, 'last_frame_image'), false);
  assert.equal(Object.hasOwn(body, 'input_reference'), false);
  const request = buildV6kVideoApiRequest(config, input, images, headers);
  assert.equal(request.url, config.endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.body, undefined);
  assert.equal(request.headers?.Authorization, headers.Authorization);
  assert.equal(request.headers?.['Idempotency-Key'], headers['Idempotency-Key']);
  assert.equal(Object.keys(request.headers!).some((name) => name.toLowerCase() === 'content-type'), false, 'native encoder supplies multipart boundary');
  assert.deepEqual(request.multipart?.files.map((file) => file.fieldName), images.map(() => 'images'));
  assert.deepEqual(request.multipart?.files.map((file) => file.dataUrl), images, 'each selected slot, including identical images, is sent exactly once in order');
  assert.deepEqual(request.multipart?.files.map((file) => file.fileName), images.map((_, index) => `reference-${index + 1}.${['png', 'jpg', 'webp'][index % 3]}`));
  const fields = Object.fromEntries((request.multipart?.fields as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]));
  assert.equal(fields.prompt, draft.prompt);
  assert.equal(fields.duration, '12');
  assert.equal(fields.seconds, '12');
  assert.equal(fields.aspect_ratio, '16:9');
  assert.equal(fields.ratio, '16:9');
  assert.equal(fields.resolution, '4K');
  assert.equal(fields.watermark, 'false');
  assert.equal(fields.seed, '0');
  assert.deepEqual(JSON.parse(fields.metadata), draft.parameters.metadata);
  assert.equal(fields.images, undefined);
  assert.deepEqual(input, before, 'draft, parameters and role metadata are unchanged');
}
assert.equal(headers['cOnTeNt-TyPe'], 'application/json', 'request preparation does not mutate shared headers');

const urls = ['https://assets.invalid/first.png?signature=a', 'http://assets.invalid/last.jpg'];
const jsonRequest = buildV6kVideoApiRequest(config, withImages(2), urls, headers);
assert.equal(jsonRequest.multipart, undefined);
assert.equal(jsonRequest.headers?.['Content-Type'], 'application/json');
assert.deepEqual(JSON.parse(jsonRequest.body!), { model: config.model, ...draft.parameters, prompt: draft.prompt, images: urls });
assert.deepEqual(JSON.parse(buildV6kVideoApiRequest(config, draft, [], headers).body!), { model: config.model, ...draft.parameters, prompt: draft.prompt });
assert.throws(() => buildV6kVideoApiRequest(config, withImages(2), [png, urls[1]], headers), /同时包含.*无法保证图片顺序/u);
assert.throws(() => buildV6kVideoApiRequest(config, withImages(2), [urls[0], png], headers), /同时包含.*无法保证图片顺序/u);
assert.throws(() => buildV6kVideoApiRequest(config, withImages(2), [png], headers), /数量不一致/u);
for (const invalid of ['', ' ', 'file:///private/image.png', 'https://user:password@assets.invalid/image.png',
  'data:image/png;base64,', 'data:image/png;base64,bm90YW5pbWFnZQ==', 'data:image/png;base64,!!!!']) {
  assert.throws(() => buildV6kVideoApiRequest(config, withImages(1), [invalid], headers), /为空|有效/u, invalid);
}
const correctedMime = buildV6kVideoApiRequest(config, withImages(1), [png.replace('image/png', 'image/jpeg')], headers);
assert.equal(correctedMime.multipart?.files[0].dataUrl, png, 'format metadata is corrected without changing bytes');
assert.equal(correctedMime.multipart?.files[0].fileName, 'reference-1.png');

console.log('v6k video protocol checks passed: scoped endpoint detection, ordered 5–7 binary references, no generated frame duplicates, preserved parameters, URL JSON and invalid/mixed-reference rejection; no network requests.');
