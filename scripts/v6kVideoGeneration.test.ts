import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import { getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import type { AppState, ReferenceRole, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoDesktopRequest, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const require = createRequire(import.meta.url);
const { createVideoTransport } = require('../electron/videoTransport.cjs');
const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const crc32 = (bytes: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};
const pngChunk = (name: string, content: Buffer): Buffer => {
  const typeAndContent = Buffer.concat([Buffer.from(name, 'ascii'), content]);
  const size = Buffer.alloc(4); size.writeUInt32BE(content.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeAndContent));
  return Buffer.concat([size, typeAndContent, crc]);
};
const coloredPng = (red: number, green: number, blue: number, noteBytes = 0): Buffer => {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    ...(noteBytes ? [pngChunk('tEXt', Buffer.concat([Buffer.from('fixture\0', 'ascii'), Buffer.alloc(noteBytes, 0x61)]))] : []),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
};
const jpegWithComment = (comment: string): Buffer => {
  const original = Buffer.from(samples.jpeg, 'base64');
  const text = Buffer.from(comment, 'utf8');
  const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xfe; marker.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([original.subarray(0, 2), marker, text, original.subarray(2)]);
};
const fixtures = [
  { mime: 'image/png', bytes: coloredPng(220, 20, 20, 1024 * 1024 + 12000) },
  { mime: 'image/jpeg', bytes: Buffer.from(samples.jpeg, 'base64') },
  { mime: 'image/webp', bytes: Buffer.from(samples.webp, 'base64') },
  { mime: 'image/png', bytes: coloredPng(20, 220, 20) },
  { mime: 'image/jpeg', bytes: jpegWithComment('人物服装参考') },
  { mime: 'image/png', bytes: coloredPng(20, 20, 220) },
  { mime: 'image/jpeg', bytes: jpegWithComment('最后一帧参考') },
].map((fixture) => ({ ...fixture, dataUrl: `data:${fixture.mime};base64,${fixture.bytes.toString('base64')}` }));
assert.equal(new Set(fixtures.map((fixture) => hash(fixture.bytes))).size, 7, 'all seven reference files have distinct bytes');
const roles: ReferenceRole[] = ['first-frame', 'middle-frame', 'scene', 'character', 'middle-frame', 'composition', 'last-frame'];
const config: VideoTaskApiConfig = { ...createInitialState().settings.videoTaskApi, enabled: true, provider: 'generic',
  endpoint: 'https://www.v6k.top/v1/videos', baseUrl: 'https://www.v6k.top', model: 'LLseadanco2.5X',
  apiKey: 'test-v6k-secret-sensitive-value', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', statusEndpointTemplate: 'https://www.v6k.top/v1/videos/{id}',
  imageUploadEndpoint: '', requestTemplate: '' };
const draft: VideoGenerationDraft = { name: '七图首中尾传输', backend: 'api', prompt: '镜头缓慢推进。角色说：“保持这句对白和全部原始参考图片。”',
  references: fixtures.map((_, index) => ({ assetId: `v6k-image-${index + 1}`, role: roles[index], slotIndex: index })),
  referenceSlotRoles: roles, parameters: { duration: '12', seconds: 12, resolution: '4K', ratio: '16:9', aspect_ratio: '16:9',
    watermark: false, seed: 0, metadata: { chapter: '第一章', labels: ['中文', '原文'], count: 7, optional: null } } };
type WireRequest = { url: string; method: string; headers: Record<string, string>; body: Buffer | string };
type ResponseSpec = { status: number; text: string; contentType?: string };
type TransportReport = Awaited<ReturnType<VideoGenerationDesktop['videoRequest']>>;
const queued: ResponseSpec = { status: 200, text: JSON.stringify({ id: 'v6k-local-mock-task', status: 'queued' }), contentType: 'application/json' };

const harness = (reply: ResponseSpec | Error = queued, customConfig: VideoTaskApiConfig = config, browser = false) => {
  let state = createInitialState(); state.settings.videoTaskApi = customConfig;
  state.project.assets = fixtures.map((fixture, index) => ({ id: `v6k-image-${index + 1}`, name: `参考图片 ${index + 1}`,
    type: 'reference', role: 'composition', dataUrl: fixture.dataUrl, tags: [], createdAt: 1, updatedAt: 1 }));
  const wire: WireRequest[] = [];
  const reports: TransportReport[] = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const events: string[] = [];
  const notifications: string[] = [];
  const transport = createVideoTransport({
    fetchWithLimit: async (url: string, options: { method: string; headers: Record<string, string>; body: Buffer | string }) => {
      assert.equal(url, customConfig.endpoint, 'every transport call stays within the mocked submission; no uploads or live network');
      assert.equal(options.method, 'POST');
      const current = state.project.generationTasks[0] as VideoGenerationTask;
      assert.equal(current.videoJob?.preparation?.phase, 'post-started');
      assert.equal(checkpoints.get(current.id)?.videoJob?.preparation?.phase, 'post-started', 'durable checkpoint finishes before the only POST');
      events.push('wire:POST');
      wire.push({ url, ...options });
      if (reply instanceof Error) throw reply;
      return { response: { status: reply.status, headers: new Headers({ 'content-type': reply.contentType || 'text/plain' }) }, bytes: Buffer.from(reply.text) };
    },
    encodeResponse: (bytes: Buffer, _responseType: string, contentType: string) => ({ body: bytes.toString('utf8'), bodyEncoding: 'text', contentType }),
  });
  const vault = new Map<string, string>();
  const desktop = {
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { vault.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => vault.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task: VideoGenerationTask) => {
      // A real asynchronous save makes an unawaited POST boundary observable.
      if (task.videoJob?.preparation?.phase === 'post-started') await turn();
      checkpoints.set(task.id, structuredClone(task)); events.push(`saved:${task.videoJob?.preparation?.phase}`);
      return { persisted: true };
    },
    ...(!browser ? { videoRequest: async (payload: VideoDesktopRequest) => {
      const response = await transport.request(payload);
      reports.push(response); return response;
    } } : {}),
  } as unknown as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (update: (current: AppState) => AppState) => { state = update(state); },
    desktop, onRuntime: () => undefined, persistState: async () => { events.push('project:saved'); },
    notify: (message: string) => { notifications.push(message); }, pollIntervalMs: 60_000 };
  const engine = new VideoGenerationEngine(options);
  return { engine, options, wire, reports, events, notifications, checkpoints,
    task: (taskId: string) => state.project.generationTasks.find((task) => task.id === taskId) as VideoGenerationTask,
    close: () => { engine.dispose(); transport.close(); } };
};

const verifyForm = async (form: FormData, expected = fixtures) => {
  assert.equal(form.get('model'), config.model);
  assert.equal(form.get('prompt'), draft.prompt);
  for (const [name, value] of Object.entries(draft.parameters)) {
    assert.equal(form.get(name), typeof value === 'string' ? value : JSON.stringify(value), name);
  }
  for (const name of ['first_frame_image', 'last_frame_image', 'input_reference', 'first_image', 'last_image']) assert.equal(form.has(name), false, name);
  const images = form.getAll('images');
  assert.equal(images.length, expected.length, 'each selected image occupies one file part');
  for (const [index, image] of images.entries()) {
    assert.equal(typeof image, 'object', `reference ${index + 1} is a binary File`);
    const file = image as File;
    assert.equal(file.type, expected[index].mime);
    assert.equal(hash(new Uint8Array(await file.arrayBuffer())), hash(expected[index].bytes), `reference ${index + 1} retains original bytes and order`);
  }
};

// Run the full renderer engine -> desktop bridge -> actual multipart encoder.
// Its only network dependency is an injected local function above.
{
  const h = harness();
  try {
    const id = await h.engine.start(draft); h.engine.dispose();
    const task = h.task(id);
    assert.equal(task.status, 'submitted', task.error);
    assert.equal(task.videoJob?.preparation?.phase, 'acknowledged');
    assert.equal(task.remoteTaskId, 'v6k-local-mock-task');
    assert.equal(h.wire.length, 1);
    assert.ok(h.events.indexOf('saved:post-started') < h.events.indexOf('wire:POST'));
    const sent = h.wire[0];
    assert.ok(Buffer.isBuffer(sent.body));
    assert.match(sent.headers['Content-Type'], /^multipart\/form-data; boundary=/u);
    assert.equal(sent.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.equal(sent.headers['Content-Length'], String(sent.body.length));
    assert.equal(h.reports[0].requestBytes, sent.body.length, 'size diagnostic comes from the encoded bytes actually sent');
    assert.equal(h.reports[0].requestContentType, sent.headers['Content-Type']);
    const text = sent.body.toString('latin1');
    assert.equal(text.includes('base64,'), false);
    assert.equal((text.match(/name="images";/gu) || []).length, fixtures.length);
    await verifyForm(await new Request(sent.url, { method: 'POST', headers: sent.headers, body: sent.body }).formData());
    assert.equal(task.videoJob?.snapshot.draft.prompt, draft.prompt);
    assert.deepEqual(task.videoJob?.snapshot.draft.parameters, draft.parameters);
    assert.deepEqual(task.videoJob?.snapshot.draft.references, draft.references);
    assert.equal(JSON.stringify(task).includes(config.apiKey), false);
  } finally { h.close(); }
}

// Provider 413 responses preserve readable HTML/plain text and actual MiB,
// redact reflected secrets/prompt, and cannot cause a second generation POST.
for (const errorReply of [
  { status: 413, contentType: 'text/html', text: `<html><head><style>hidden-style</style></head><body><h1>413 Request Entity Too Large</h1><p>gateway body limit &amp; upstream</p><p>${config.apiKey}</p><script>hidden-script</script></body></html>` },
  { status: 413, contentType: 'text/plain', text: `Payload too large: gateway rejected body; key=${config.apiKey}; prompt=${draft.prompt}` },
]) {
  const h = harness(errorReply);
  try {
    const id = await h.engine.start(draft); h.engine.dispose();
    const task = h.task(id);
    assert.equal(task.status, 'failed');
    assert.equal(task.videoJob?.stage, 'failed');
    assert.equal(h.wire.length, 1);
    const exactBytes = Buffer.byteLength(h.wire[0].body);
    assert.equal(h.reports[0].requestBytes, exactBytes);
    assert.ok(task.error?.includes(`${(exactBytes / 1024 / 1024).toFixed(2)} MiB`), task.error);
    assert.match(task.error || '', /HTTP 413/u);
    assert.match(task.error || '', /multipart\/form-data/u);
    assert.match(task.error || '', /gateway/u);
    const displayed = getSafeErrorDiagnostics(task.error).message;
    assert.ok(displayed.includes(`${(exactBytes / 1024 / 1024).toFixed(2)} MiB`), displayed);
    assert.match(displayed, /gateway/u, 'the error-detail display keeps the provider explanation after its own sanitization');
    const diagnostics = JSON.stringify({ task, notifications: h.notifications });
    assert.equal(diagnostics.includes(config.apiKey), false, 'saved diagnostics and notification redact actual configured secret');
    assert.equal(task.error?.includes(draft.prompt), false, 'provider-reflected authored prompt is not copied into the error');
    assert.equal(task.error?.includes('hidden-script'), false);
    assert.equal(task.error?.includes('hidden-style'), false);
    const recovered = new VideoGenerationEngine(h.options);
    try { recovered.reconcile(); await turn(); await turn(); assert.equal(h.wire.length, 1, 'reconciliation never reposts a rejected request'); }
    finally { recovered.dispose(); }
  } finally { h.close(); }
}

// An acknowledgement lost after the durable POST boundary is kept unknown.
{
  const h = harness(new Error('mock connection reset after request body'));
  try {
    const id = await h.engine.start(draft); h.engine.dispose();
    assert.equal(h.task(id).status, 'unknown');
    assert.equal(h.task(id).videoJob?.stage, 'submission-unknown');
    assert.equal(h.task(id).videoJob?.preparation?.phase, 'post-started');
    const recovered = new VideoGenerationEngine(h.options);
    try { recovered.reconcile(); await turn(); await turn(); assert.equal(h.wire.length, 1, 'unknown submission is never auto-replayed'); }
    finally { recovered.dispose(); }
  } finally { h.close(); }
}

// An explicit user template keeps its own JSON transport and image binding.
{
  const custom = { ...config, requestTemplate: JSON.stringify({ model: '{{model}}', prompt: '{{prompt}}', pictures: '{{images}}', parameters: '{{parameters}}' }) };
  const h = harness(queued, custom);
  try {
    const id = await h.engine.start(draft); h.engine.dispose();
    assert.equal(h.task(id).status, 'submitted', h.task(id).error);
    assert.equal(h.wire.length, 1);
    assert.equal(typeof h.wire[0].body, 'string');
    assert.equal(h.wire[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(h.wire[0].body as string), { model: config.model, prompt: draft.prompt,
      pictures: fixtures.map((fixture) => fixture.dataUrl), parameters: draft.parameters });
  } finally { h.close(); }
}

// The browser fallback builds Files locally. Blocking data: fetch emulates
// connect-src restrictions and proves it only fetches the HTTPS API once.
{
  const h = harness(queued, config, true);
  const originalFetch = globalThis.fetch;
  let browserCalls = 0;
  let submittedForm: FormData | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    browserCalls += 1;
    assert.equal(String(input), config.endpoint, 'data: URL fetch is forbidden; image decoding must remain local');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData);
    assert.equal([...new Headers(init?.headers).keys()].includes('content-type'), false, 'browser supplies its own multipart boundary');
    submittedForm = init!.body as FormData;
    return new Response(queued.text, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const id = await h.engine.start(draft); h.engine.dispose();
    assert.equal(h.task(id).status, 'submitted', h.task(id).error);
    assert.equal(browserCalls, 1);
    assert.ok(submittedForm);
    await verifyForm(submittedForm);
  } finally { globalThis.fetch = originalFetch; h.close(); }
}

console.log('v6k engine/desktop/browser checks passed: seven original binary images in order, durable one-POST boundary, actual request MiB, HTML/plain 413 redaction, no replay after rejection/reset, and custom JSON template isolation; all network calls mocked.');
