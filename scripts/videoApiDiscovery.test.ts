import assert from 'node:assert/strict';
import { discoverGenericVideoApi } from '../src/videoApiDiscovery';
import type { VideoTaskApiConfig } from '../src/types';

const config: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', baseUrl: 'https://first.invalid', apiKey: 'mock-secret', model: '用户自己选择的模型',
  endpoint: 'https://api.minimaxi.com/v1/video_generation', statusEndpointTemplate: 'https://api.minimaxi.com/v1/query/video_generation?task_id={id}',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'task_id', statusPath: 'status', resultUrlPath: 'output.url',
  fileIdPath: 'file_id', fileEndpointTemplate: 'https://api.minimaxi.com/v1/files/retrieve?file_id={id}', fileUrlPath: 'file.download_url',
  requestTemplate: '{"old":"{{prompt}}"}', cancelEndpointTemplate: 'https://old.invalid/cancel/{id}', imageUploadEndpoint: 'https://old.invalid/upload', imageUploadField: 'file', imageUploadUrlPath: 'file.url',
};
type Request = { requestId: string; url: string; method: string; headers: Record<string, string>; redirect: string };
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const requests: Request[] = [];
const originalWindow = globalThis.window;
let handler: (payload: Request) => Promise<{ status: number; body: string }> = async () => response({}, 404);
const cancelled: string[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (payload: Request) => { requests.push(payload); return handler(payload); },
  cancelModelRequest: async (id: string) => { cancelled.push(id); return true; },
} } });
const modelBody = { data: [{ id: 'video' }, { id: '图片模型' }, { id: '文字模型' }, { id: '暂停模型' }, { id: 'video' }] };
const allModels = ['video', '图片模型', '文字模型', '暂停模型'].sort((a, b) => a.localeCompare(b));
const taskSchema = { type: 'object', properties: { task_id: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' }, download_url: { type: 'string' }, progress: { type: 'number' } } };
const jsonSchema = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const standardSpec = {
  openapi: '3.1.0', security: [{ Bearer: [] }], components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Task: taskSchema } },
  paths: {
    '/v1/videos': { post: { operationId: 'createVideo', responses: { '200': jsonSchema({ $ref: '#/components/schemas/Task' }) } } },
    '/v1/videos/{task_id}': { get: { operationId: 'getVideo', responses: { '200': jsonSchema({ $ref: '#/components/schemas/Task' }), '400': jsonSchema({ type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' } } } } }) } } },
  },
};
try {
  // Current address always wins over old explicit endpoints; complete model IDs and chosen model survive.
  for (const baseUrl of ['https://first.invalid', 'https://second.invalid/prefix/v1']) {
    requests.length = 0;
    handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response({}, 404);
    const discovered = await discoverGenericVideoApi({ ...config, baseUrl });
    const versioned = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    assert.deepEqual(discovered.models, allModels);
    assert.equal(discovered.source, 'standard');
    assert.equal(discovered.patch.endpoint, `${versioned}/videos`);
    assert.equal(discovered.patch.statusEndpointTemplate, `${versioned}/videos/{id}`);
    assert.equal(discovered.patch.authHeader, 'Authorization');
    assert.equal(discovered.patch.authScheme, 'Bearer');
    for (const field of ['fileIdPath', 'fileEndpointTemplate', 'fileUrlPath', 'requestTemplate', 'imageUploadEndpoint', 'imageUploadField', 'imageUploadUrlPath', 'cancelEndpointTemplate'] as const) assert.equal(discovered.patch[field], '', `${field} must not leak the previous service`);
    for (const field of ['baseUrl', 'apiKey', 'model'] as const) assert.equal(Object.hasOwn(discovered.patch, field), false);
    assert.equal({ ...config, ...discovered.patch }.model, config.model);
    assert.ok(discovered.message.includes('标准兼容配置'));
    assert.ok(requests.every((payload) => payload.method === 'GET' && payload.redirect === 'error' && new URL(payload.url).origin === new URL(baseUrl).origin));
    assert.ok(requests.every((payload) => payload.headers.Authorization === 'Bearer mock-secret'));
    assert.equal(requests.length <= 5, true, 'document discovery has a small finite candidate set');
  }

  // Legacy connections without baseUrl derive the current site from their explicit endpoint.
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response({}, 404);
  const legacy = await discoverGenericVideoApi({ ...config, baseUrl: undefined });
  assert.equal(legacy.patch.endpoint, 'https://api.minimaxi.com/v1/videos');

  // The confirmed tutorial path is discoverable for any website, without a provider-name button.
  requests.length = 0;
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : url.endsWith('/docs/video-api/openapi.json') ? response({ ...standardSpec, servers: [{ url: 'https://first.invalid' }] }) : response({}, 404);
  const standard = await discoverGenericVideoApi(config);
  assert.equal(standard.source, 'openapi');
  assert.equal(standard.patch.endpoint, 'https://first.invalid/v1/videos');
  assert.equal(standard.patch.statusEndpointTemplate, 'https://first.invalid/v1/videos/{id}');
  assert.equal(standard.patch.taskIdPath, 'task_id');
  assert.equal(standard.patch.resultUrlPath, 'download_url');
  assert.equal(standard.patch.errorPath, 'error.message');
  assert.deepEqual(standard.warnings, []);

  // A second provider can declare a different server prefix, field envelope, auth header and file lookup.
  const nonstandard = {
    openapi: '3.0.3', servers: [{ url: '/prefix' }], security: [{ Token: [] }],
    components: { securitySchemes: { Token: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }, schemas: {
      Task: { type: 'object', properties: { data: { type: 'object', properties: { job_id: { type: 'string' }, state: { type: 'string' }, percentage: { type: 'number' }, file_id: { type: 'string' }, results: { type: 'array', items: { type: 'object', properties: { downloadUrl: { type: 'string' } } } } } } } },
    } },
    paths: {
      '/render/create': { post: { operationId: 'generateVideo', responses: { '202': jsonSchema({ $ref: '#/components/schemas/Task' }) } } },
      '/render/jobs/{job_id}': { get: { operationId: 'queryVideo', responses: { '200': jsonSchema({ $ref: '#/components/schemas/Task' }) } }, delete: { operationId: 'cancelVideo' } },
      '/files/{file_id}': { get: { responses: { '200': jsonSchema({ type: 'object', properties: { file: { type: 'object', properties: { download_url: { type: 'string' } } } } }) } } },
    },
  };
  requests.length = 0;
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : url === 'https://second.invalid/prefix/openapi.json' ? response(nonstandard) : response({}, 404);
  const custom = await discoverGenericVideoApi({ ...config, baseUrl: 'https://second.invalid/prefix/v1', authHeader: 'X-API-Key', authScheme: '' });
  assert.equal(custom.source, 'openapi');
  assert.equal(custom.patch.endpoint, 'https://second.invalid/prefix/render/create');
  assert.equal(custom.patch.statusEndpointTemplate, 'https://second.invalid/prefix/render/jobs/{id}');
  assert.equal(custom.patch.taskIdPath, 'data.job_id');
  assert.equal(custom.patch.statusPath, 'data.state');
  assert.equal(custom.patch.progressPath, 'data.percentage');
  assert.equal(custom.patch.resultUrlPath, 'data.results.0.downloadUrl');
  assert.equal(custom.patch.fileIdPath, 'data.file_id');
  assert.equal(custom.patch.fileEndpointTemplate, 'https://second.invalid/prefix/files/{id}');
  assert.equal(custom.patch.fileUrlPath, 'file.download_url');
  assert.equal(custom.patch.cancelEndpointTemplate, 'https://second.invalid/prefix/render/jobs/{id}');
  assert.equal(custom.patch.cancelMethod, 'DELETE');
  assert.equal(custom.patch.authHeader, 'X-API-Key');
  assert.equal(custom.patch.authScheme, '');
  assert.ok(requests.every((payload) => payload.headers['X-API-Key'] === 'mock-secret'));

  // Some services express task/file IDs as query parameters rather than route parameters.
  const querySpec = { ...nonstandard, paths: {
    '/render/create': nonstandard.paths['/render/create'],
    '/render/status': { get: { operationId: 'getVideoStatus', parameters: [{ in: 'query', name: 'job_id', required: true }], responses: nonstandard.paths['/render/jobs/{job_id}'].get.responses } },
    '/files/retrieve': { get: { parameters: [{ in: 'query', name: 'file_id', required: true }], responses: nonstandard.paths['/files/{file_id}'].get.responses } },
  } };
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : url.endsWith('/prefix/openapi.json') ? response(querySpec) : response({}, 404);
  const queryMapping = await discoverGenericVideoApi({ ...config, baseUrl: 'https://second.invalid/prefix/v1' });
  assert.equal(queryMapping.patch.statusEndpointTemplate, 'https://second.invalid/prefix/render/status?job_id={id}');
  assert.equal(queryMapping.patch.fileEndpointTemplate, 'https://second.invalid/prefix/files/retrieve?file_id={id}');

  // Missing server metadata still preserves a custom deployment prefix without repeating /v1.
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : url.endsWith('/prefix/openapi.json') ? response(standardSpec) : response({}, 404);
  const prefixed = await discoverGenericVideoApi({ ...config, baseUrl: 'https://second.invalid/prefix/v1' });
  assert.equal(prefixed.patch.endpoint, 'https://second.invalid/prefix/v1/videos');
  assert.equal(prefixed.patch.statusEndpointTemplate, 'https://second.invalid/prefix/v1/videos/{id}');

  // Remote server declarations and remote $refs never cause a GET or expose the current site's key.
  requests.length = 0;
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response({ ...standardSpec, servers: [{ url: 'https://attacker.invalid' }], components: { schemas: { Task: { $ref: 'https://attacker.invalid/secret.json' } } } });
  const foreign = await discoverGenericVideoApi(config);
  assert.equal(foreign.source, 'standard');
  assert.equal(foreign.patch.endpoint, 'https://first.invalid/v1/videos');
  assert.ok(requests.every(({ url }) => new URL(url).origin === 'https://first.invalid'));
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response({ ...standardSpec, components: { schemas: { Task: { $ref: 'https://attacker.invalid/task.json' } } } });
  const remoteRef = await discoverGenericVideoApi(config);
  assert.equal(remoteRef.patch.taskIdPath, '');
  assert.ok(remoteRef.warnings.some((warning) => warning.includes('结果字段')));

  // Equal candidates and equal nested field names are reported, never silently guessed.
  const ambiguousSpec = { openapi: '3.1.0', paths: {
    '/one/create': { post: { operationId: 'createVideo', responses: { '200': jsonSchema(taskSchema) } } },
    '/two/create': { post: { operationId: 'generateVideo', responses: { '200': jsonSchema(taskSchema) } } },
  } };
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response(ambiguousSpec);
  const ambiguous = await discoverGenericVideoApi(config);
  assert.equal(ambiguous.source, 'standard');
  assert.ok(ambiguous.message.includes('不能唯一识别'));
  const nestedAmbiguous = { ...standardSpec, components: { schemas: { Task: { type: 'object', properties: { a: taskSchema, b: taskSchema } } } } };
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : response(nestedAmbiguous);
  const ambiguousFields = await discoverGenericVideoApi(config);
  assert.equal(ambiguousFields.patch.taskIdPath, '');
  assert.equal(ambiguousFields.patch.statusPath, '');
  assert.equal(ambiguousFields.patch.resultUrlPath, '');
  assert.ok(ambiguousFields.warnings.length > 0);

  // Broken or overlarge optional specs do not erase successful model discovery.
  handler = async ({ url }) => url.endsWith('/models') ? response(modelBody) : ({ status: 200, body: 'x'.repeat(513 * 1024) });
  assert.equal((await discoverGenericVideoApi(config)).source, 'standard');
  handler = async ({ url }) => { if (url.endsWith('/models')) return response(modelBody); throw new Error('mock optional document offline'); };
  assert.deepEqual((await discoverGenericVideoApi(config)).models, allModels);

  // Model failures are surfaced without sending partial patches or printing the API key.
  handler = async () => response({ error: { message: 'invalid mock-secret', code: 'KEY_INVALID' } }, 403);
  await assert.rejects(discoverGenericVideoApi(config), (error: Error) => error.message.includes('KEY_INVALID') && !error.message.includes(config.apiKey));
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(discoverGenericVideoApi(config, { signal: preAborted.signal }), { name: 'AbortError' });
  const pending = new Promise<never>(() => undefined);
  handler = async () => pending;
  const modelAbort = new AbortController();
  const interruptedModel = discoverGenericVideoApi(config, { signal: modelAbort.signal }); modelAbort.abort();
  await assert.rejects(interruptedModel, { name: 'AbortError' });
  assert.ok(cancelled.some((id) => id.startsWith('video-models-')));
  let beganDocument: () => void = () => undefined;
  const documentStarted = new Promise<void>((resolve) => { beganDocument = resolve; });
  handler = async ({ url }) => { if (url.endsWith('/models')) return response(modelBody); beganDocument(); return pending; };
  const documentAbort = new AbortController();
  const interruptedDocument = discoverGenericVideoApi(config, { signal: documentAbort.signal });
  await documentStarted; documentAbort.abort();
  await assert.rejects(interruptedDocument, { name: 'AbortError' });
  assert.ok(cancelled.some((id) => id.startsWith('video-discovery-')));
  console.log('videoApiDiscovery: complete models, multi-site mapping, legacy cleanup, read-only same-origin discovery and cancellation passed');
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }
