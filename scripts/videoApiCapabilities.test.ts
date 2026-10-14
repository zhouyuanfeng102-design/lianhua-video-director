import assert from 'node:assert/strict';
import { getVideoApiModelParameterCapabilities, parseVideoApiModelMetadata, parseVideoApiOpenApiCapabilities, parseVideoApiRequestSchemaCapabilities, videoApiCapabilityScope } from '../src/videoApiCapabilities';
import { discoverGenericVideoApi, refreshGenericVideoParameterCapabilities } from '../src/videoApiDiscovery';
import type { VideoTaskApiConfig } from '../src/types';

const makeSchema = (model: unknown, duration: unknown, resolution: unknown) => ({ type: 'object', required: ['model', 'duration'], properties: { model, duration, resolution, ratio: { type: 'string', minLength: 1, description: '按原值提交，不限定枚举。' } } });
const schema = { oneOf: [
  { $ref: '#/$defs/Short' }, { $ref: '#/$defs/Long' }, { $ref: '#/$defs/H3' },
], $defs: {
  Short: makeSchema({ const: '特价2.0-需要过人脸技术-可参考过人脸素材库' }, { type: 'integer', enum: [5, 10, 15] }, { const: '720p', default: '720p' }),
  Long: makeSchema({ const: '特价2.5需要过人脸技术-可参考过人脸素材库' }, { type: 'integer', minimum: 16, maximum: 30 }, { const: '720p', default: '720p' }),
  H3: makeSchema({ enum: ['H3-KS', 'minimax-h3-1080p'] }, { type: 'integer', minimum: 5, maximum: 15 }, { enum: ['1080p'] }),
  Historical: makeSchema({ const: '历史模型' }, { type: 'integer', enum: [999] }, { enum: ['8K'] }),
} };
const parsed = parseVideoApiRequestSchemaCapabilities(schema, schema, ['图片模型', '文字模型']);
const long = parsed.models['特价2.5需要过人脸技术-可参考过人脸素材库'];
assert.equal(long.controls.duration?.kind, 'number');
assert.equal(long.controls.duration?.min, 16);
assert.equal(long.controls.duration?.max, 30);
assert.equal(long.controls.duration?.step, 1);
assert.equal(long.controls.duration?.required, true);
assert.deepEqual(long.controls.resolution?.options, ['720p']);
assert.equal(long.controls.resolution?.restricted, true);
assert.equal(long.defaults.resolution, '720p');
assert.equal(long.controls.aspect_ratio?.kind, 'text');
assert.equal(long.controls.aspect_ratio?.restricted, false);
assert.equal(long.controls.aspect_ratio?.options, undefined);
assert.deepEqual(parsed.models['特价2.0-需要过人脸技术-可参考过人脸素材库'].controls.duration?.options, ['5', '10', '15']);
assert.equal(parsed.models['H3-KS'].controls.duration?.max, 15);
assert.deepEqual(parsed.models['minimax-h3-1080p'].controls, parsed.models['H3-KS'].controls);
assert.equal(parsed.models['历史模型'], undefined, 'unused historical definitions are not active capabilities');
assert.equal(parsed.models['图片模型'], undefined, 'unknown IDs are never inferred from a model-name whitelist');

// Model-conditioned bounds intersect a base request schema. Non-model conditions cannot be guessed.
const conditional = { properties: { model: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 60 }, resolution: { type: 'string' } }, allOf: [
  { if: { properties: { model: { const: 'bounded' } } }, then: { properties: { duration: { minimum: 5, maximum: 10 }, resolution: { enum: ['720p'] } } } },
  { if: { properties: { use_audio: { const: true } } }, then: { properties: { duration: { maximum: 2 } } } },
] };
const conditions = parseVideoApiRequestSchemaCapabilities(conditional, conditional, ['other', 'bounded']);
assert.equal(conditions.models.bounded.controls.duration?.min, 5);
assert.equal(conditions.models.bounded.controls.duration?.max, 10);
assert.deepEqual(conditions.models.bounded.controls.resolution?.options, ['720p']);
assert.equal(conditions.models.other.controls.duration?.max, 60);
assert.equal(conditions.models.other.controls.resolution?.kind, 'text');

// oneOf/anyOf alternatives may union reliable options, but cannot manufacture constraints from examples.
const union = { properties: { model: { const: 'union' }, duration: { anyOf: [{ type: 'integer', enum: [5] }, { type: 'integer', enum: [10] }] }, resolution: { type: 'string', examples: ['720p', '1080p'] }, aspect_ratio: { type: 'string', default: '16:9', examples: ['16:9', '9:16'] } } };
const unions = parseVideoApiRequestSchemaCapabilities(union, union).models.union;
assert.deepEqual(unions.controls.duration?.options, ['5', '10']);
assert.equal(unions.controls.resolution?.options, undefined);
assert.equal(unions.controls.aspect_ratio?.restricted, false);
assert.equal(unions.defaults.aspect_ratio, '16:9');
const remote = { properties: { model: { const: 'remote' }, duration: { $ref: 'https://foreign.invalid/limits.json' }, resolution: { type: 'string' } } };
assert.equal(parseVideoApiRequestSchemaCapabilities(remote, remote).models.remote.controls.duration, undefined);
const unknownAlternative = { oneOf: [makeSchema({ const: 'unknown-alternative' }, { type: 'integer', enum: [5] }, { enum: ['720p'] }), { $ref: 'https://foreign.invalid/request.json' }] };
assert.equal(parseVideoApiRequestSchemaCapabilities(unknownAlternative, unknownAlternative).models['unknown-alternative'], undefined, 'unresolved union alternatives cannot create false restrictions');
const cyclic = { properties: { model: { const: 'cycle' }, duration: { $ref: '#/properties/duration' }, resolution: { type: 'string' } } };
assert.equal(parseVideoApiRequestSchemaCapabilities(cyclic, cyclic).models.cycle.controls.duration, undefined);

const metadata = parseVideoApiModelMetadata({ data: [{ id: 'metadata', capabilities: { supported_resolutions: ['480p', '720p'], supported_durations: [4, 8], aspect_ratio: { type: 'string' } }, aliases: ['alias'] }, { id: 'unlimited' }, { id: 'unknown', description: '1080p five seconds' }] });
assert.deepEqual(metadata.models.metadata.controls.resolution?.options, ['480p', '720p']);
assert.deepEqual(metadata.models.metadata.controls.duration?.options, ['4', '8']);
assert.equal(metadata.models.unlimited, undefined);
assert.equal(metadata.models.unknown, undefined);

const config: VideoTaskApiConfig = { enabled: true, provider: 'generic', baseUrl: 'https://first.invalid', endpoint: '', statusEndpointTemplate: '', apiKey: 'mock-secret', authHeader: 'Authorization', authScheme: 'Bearer', model: 'metadata', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'download_url' };
const caps = { ...metadata, source: 'models' as const, scope: videoApiCapabilityScope(config), fetchedAt: Date.now() };
assert.deepEqual(getVideoApiModelParameterCapabilities({ ...config, parameterCapabilities: caps }), metadata.models.metadata);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, baseUrl: 'https://second.invalid', parameterCapabilities: caps }), undefined);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, endpoint: 'https://first.invalid/custom', parameterCapabilities: caps }), undefined);
assert.deepEqual(getVideoApiModelParameterCapabilities({ ...config, model: 'alias', parameterCapabilities: caps }), metadata.models.metadata);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, parameterCapabilities: { ...caps, models: null } as never }), undefined);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, parameterCapabilities: { ...caps, models: { metadata: { controls: { duration: { kind: 'select', options: 'not-an-array' }, resolution: { kind: 'number', min: 'wrong' } }, defaults: {} } } } as never }), undefined);
const multiple = { properties: { model: { const: 'multiple' }, duration: { type: 'integer', minimum: 4, maximum: 10, multipleOf: 3 } } };
const stepped = parseVideoApiRequestSchemaCapabilities(multiple, multiple).models.multiple.controls.duration;
assert.equal(stepped?.min, 6, 'HTML step base aligns to a legal zero-based schema multiple');
assert.equal(stepped?.max, 9);
assert.equal(stepped?.step, 3);

const task = { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, download_url: { type: 'string' } } };
const content = (value: unknown) => ({ content: { 'application/json': { schema: value } } });
const spec = { openapi: '3.1.0', servers: [{ url: 'https://first.invalid' }], paths: { '/v1/videos': { post: { requestBody: content(schema), responses: { '200': content(task) } } }, '/v1/videos/{id}': { get: { responses: { '200': content(task) } } } } };
// The request's local refs live under its embedded schema, so use an ordinary spec component ref here.
const embedded = { ...spec, $defs: schema.$defs };
assert.equal(parseVideoApiOpenApiCapabilities(embedded).models['H3-KS'].controls.duration?.min, 5);
const originalWindow = globalThis.window;
const requests: Array<{ url: string; method: string; headers: Record<string, string>; redirect?: string }> = [];
let modelsFail = false;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { url: string; method: string; headers: Record<string, string>; redirect?: string }) => {
  requests.push(payload);
  if (payload.url.endsWith('/models')) return { status: modelsFail ? 503 : 200, body: JSON.stringify(modelsFail ? { error: { message: 'offline' } } : { data: [{ id: 'metadata', capabilities: { supported_resolutions: ['480p'] } }, { id: '图片模型' }, { id: 'H3-KS' }] }) };
  return { status: payload.url.endsWith('/docs/video-api/openapi.json') ? 200 : 404, body: JSON.stringify(payload.url.endsWith('/docs/video-api/openapi.json') ? embedded : {}) };
} } } });
try {
  const discovered = await discoverGenericVideoApi(config);
  assert.ok(discovered.models.includes('图片模型'), 'model discovery never filters image/text/paused IDs');
  assert.equal(requests.filter((request) => request.url.endsWith('/models')).length, 1, 'metadata reuses one models GET');
  assert.equal(discovered.patch.parameterCapabilities?.scope, videoApiCapabilityScope({ ...config, ...discovered.patch }));
  assert.deepEqual(getVideoApiModelParameterCapabilities({ ...config, ...discovered.patch, model: 'H3-KS' })?.controls.resolution?.options, ['1080p']);
  assert.equal(discovered.patch.model, undefined, 'discovery leaves selected model untouched');
  assert.equal(discovered.patch.apiKey, undefined);
  assert.equal(JSON.stringify(discovered.patch.parameterCapabilities).includes(config.apiKey), false, 'metadata contains no secret');
  modelsFail = true;
  const refreshed = await refreshGenericVideoParameterCapabilities({ ...config, model: 'H3-KS' });
  assert.equal(refreshed.models['H3-KS'].controls.duration?.min, 5, 'OpenAPI works even when model listing is temporarily offline');
  assert.equal(refreshed.scope, videoApiCapabilityScope(config));
  assert.ok(requests.every((request) => request.method === 'GET' && new URL(request.url).origin === 'https://first.invalid' && request.redirect === 'error'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(refreshGenericVideoParameterCapabilities(config, { signal: aborted.signal }), { name: 'AbortError' });
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }
console.log('videoApiCapabilities: schema, model metadata, scope isolation and read-only discovery passed');
