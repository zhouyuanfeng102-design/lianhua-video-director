import assert from 'node:assert/strict';
import { requestImageModel, requestImagePromptConverter } from '../src/services/llm';
import { requestCustomImagePrompt } from '../src/customImagePrompt';
import { importRunningHubImageWorkflow } from '../src/runningHubImage';
import type { ImageApiConfig, TextApiConfig } from '../src/types';

type Reply = { status: number; body: string };
type Request = { requestId: string; url: string; method: string; body?: string; multipart?: unknown };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const image = `data:image/png;base64,${png}`;
const response = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) });
const success = () => response({ data: [{ b64_json: png }] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async <T>(pending: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cancellation did not release the image worker within 3 seconds')), 3000);
  })]); } finally { clearTimeout(timer!); }
};
const dispatched = <T>(start: Promise<void>, pending: Promise<T>) => bounded(Promise.race([
  start, pending.then(() => { throw new Error('Expected a suspended operation'); }),
]));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const base: ImageApiConfig = { enabled: true, backend: 'openai', baseUrl: 'https://image.invalid', apiKey: 'fixture', model: 'fixture-image' };
const nextApi = { ...base, baseUrl: 'https://next.invalid' };
const workflowJson = JSON.stringify({
  1: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
  2: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
  3: { class_type: 'IPAdapterAdvanced', inputs: { image: ['2', 0] } },
  9: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
});
const comfy: ImageApiConfig = { ...base, backend: 'comfyui', model: '', workflowJson };
const cloudBody = { nodeInfoList: [{ nodeId: '1', fieldName: 'prompt', fieldValue: 'fixture prompt' }], usePersonalQueue: false };
const imported = importRunningHubImageWorkflow(`curl --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/2070152175753453569' --header 'Authorization: Bearer FIXTURE' --header 'Content-Type: application/json' --data '${JSON.stringify(cloudBody)}'`);
const runningHub: ImageApiConfig = { ...base, backend: 'runninghub', baseUrl: imported.baseUrl!, model: '',
  runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id };
const variants: Array<{ name: string; api: ImageApiConfig; referenceImages?: string[] }> = [
  { name: 'OpenAI generation', api: base },
  { name: 'OpenAI multipart edit', api: base, referenceImages: [image] },
  { name: 'SD text-to-image', api: { ...base, backend: 'sd_webui' } },
  { name: 'SD image-to-image', api: { ...base, backend: 'sd_webui' }, referenceImages: [image] },
  { name: 'xAI', api: { ...base, imageProtocol: 'xai' } },
  { name: 'Gemini native', api: { ...base, imageProtocol: 'gemini' } },
  { name: 'Gemini chat', api: { ...base, imageProtocol: 'openai-chat' } },
  { name: 'NovelAI', api: { ...base, backend: 'novelai', model: 'nai-diffusion-4-5-full' } },
  { name: 'ComfyUI submission', api: comfy },
  { name: 'ComfyUI reference upload', api: comfy, referenceImages: [image] },
  { name: 'RunningHub submission', api: runningHub },
];
const oldWindow = globalThis.window;
let checks = 0;
const install = (request: (payload: Request) => Promise<Reply>, downloadImage?: () => Promise<string>, cancelled: string[] = []) => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request, downloadImage,
    cancelModelRequest: (id: string) => {
      cancelled.push(id);
      return new Promise<boolean>(() => {}); // A broken/older bridge must not prevent local cancellation.
    },
  } } });
};
const nextCompletes = async () => {
  const result = await bounded(requestImageModel(nextApi, { prompt: 'following independent image' }));
  assert.equal(result.dataUrl, image, 'the next image must run without restarting the app');
};

try {
  for (const variant of variants) {
    const stopped = new AbortController(); stopped.abort();
    const requests: Request[] = [];
    const cancelled: string[] = [];
    const started = deferred<void>();
    const held = deferred<Reply>();
    let downloads = 0;
    install(async (payload) => {
      requests.push(payload);
      if (payload.url.startsWith(nextApi.baseUrl)) return success();
      started.resolve(); return held.promise;
    }, async () => { downloads++; return image; }, cancelled);
    await assert.rejects(requestImageModel(variant.api, { prompt: 'already stopped', signal: stopped.signal }), isAbort);
    assert.equal(requests.length, 0, `${variant.name}: a previously stopped task cannot submit`);
    const controller = new AbortController();
    const pending = requestImageModel(variant.api, { prompt: 'suspended image', signal: controller.signal,
      ...(variant.referenceImages ? { referenceImages: variant.referenceImages } : {}) });
    await dispatched(started.promise, pending);
    controller.abort();
    await bounded(assert.rejects(pending, isAbort));
    assert.deepEqual(cancelled, [requests[0].requestId], `${variant.name}: cancel exactly the in-flight HTTP request`);
    await nextCompletes();
    held.resolve(response({ data: [{ url: 'https://late.invalid/image.png' }] }));
    await tick();
    assert.equal(downloads, 0, `${variant.name}: a late HTTP reply cannot begin downloading`);
    assert.equal(requests.length, 2, `${variant.name}: no resubmission, global interrupt or later poll`);
    checks++;
  }

  // Cancellation during task observation must release the same queue without
  // reposting generation or globally interrupting another user's cloud/GPU job.
  for (const api of [comfy, runningHub]) {
    const started = deferred<void>();
    const cancelled: string[] = [];
    const requests: Request[] = [];
    install(async (payload) => {
      requests.push(payload);
      if (payload.url.startsWith(nextApi.baseUrl)) return success();
      if (payload.url.endsWith('/prompt')) return response({ prompt_id: 'held-job' });
      if (payload.url.includes('/run/')) return response({ taskId: 'held-job', status: 'RUNNING' });
      started.resolve(); return new Promise<Reply>(() => {});
    }, undefined, cancelled);
    const controller = new AbortController();
    const pending = requestImageModel(api, { prompt: 'held status query', signal: controller.signal });
    await dispatched(started.promise, pending);
    const queryId = requests.at(-1)!.requestId;
    controller.abort();
    await bounded(assert.rejects(pending, isAbort));
    await nextCompletes();
    assert.deepEqual(cancelled, [queryId]);
    assert.equal(requests.filter((request) => request.url.endsWith('/prompt') || request.url.includes('/run/')).length, 1);
    assert.equal(requests.length, 3);
    checks++;
  }

  for (const protocol of ['openai-compatible', 'openai-chat'] as const) {
    const started = deferred<void>(); const held = deferred<string>();
    const requests: Request[] = []; let downloads = 0;
    install(async (payload) => {
      requests.push(payload);
      if (payload.url.startsWith(nextApi.baseUrl)) return success();
      const url = 'https://output.invalid/image.png';
      return response(protocol === 'openai-chat' ? { choices: [{ message: { images: [{ image_url: { url } }] } }] } : { data: [{ url }] });
    }, () => { downloads++; started.resolve(); return held.promise; });
    const controller = new AbortController();
    const pending = requestImageModel({ ...base, imageProtocol: protocol }, { prompt: 'held output download', signal: controller.signal });
    await dispatched(started.promise, pending);
    controller.abort();
    await bounded(assert.rejects(pending, isAbort));
    await nextCompletes();
    held.resolve(image); await tick();
    assert.equal(requests.length, 2); assert.equal(downloads, 1);
    checks++;
  }

  // A callback or legacy non-cancellable operation may never settle. Cancel
  // the running worker itself, and make queued cancellations skip submission.
  {
    const entered = deferred<void>(); const held = deferred<void>();
    const requests: Request[] = [];
    install(async (payload) => { requests.push(payload); return success(); });
    const controller = new AbortController();
    const pending = requestImageModel(base, { prompt: 'held start', signal: controller.signal }, () => { entered.resolve(); return held.promise; });
    await dispatched(entered.promise, pending);
    const queuedController = new AbortController(); let queuedStarts = 0;
    const queued = requestImageModel(base, { prompt: 'queued then stopped', signal: queuedController.signal }, () => { queuedStarts++; });
    queuedController.abort();
    await bounded(assert.rejects(queued, isAbort));
    controller.abort(); await bounded(assert.rejects(pending, isAbort));
    await nextCompletes(); held.resolve(); await tick();
    assert.equal(queuedStarts, 0); assert.equal(requests.length, 1);
    checks++;
  }

  const textApi: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://text.invalid',
    apiKey: 'fixture', model: 'fixture-text', maxTokens: 1024, temperature: 0.2 };
  for (const custom of [false, true]) {
    const started = deferred<void>(); const held = deferred<Reply>();
    const requests: Request[] = []; const cancelled: string[] = [];
    install(async (payload) => { requests.push(payload); started.resolve(); return held.promise; }, undefined, cancelled);
    const controller = new AbortController();
    const pending = custom ? requestCustomImagePrompt(textApi, { userPrompt: 'A room at dawn', width: 1024, height: 1024,
      rule: { version: 1, id: 'fixture', name: 'Fixture', ruleVersion: '1.0', format: 'natural-language', systemPrompt: 'Describe the requested image.', outputRules: '' }, signal: controller.signal })
      : requestImagePromptConverter(textApi, 'location', 'A room at dawn', 'natural-language', 'Describe this room.', '', undefined, controller.signal);
    await dispatched(started.promise, pending);
    controller.abort(); await bounded(assert.rejects(pending, isAbort));
    held.resolve(response({ choices: [{ message: { content: '' } }] })); await tick();
    assert.deepEqual(cancelled, [requests[0].requestId]);
    assert.equal(requests.length, 1, 'cancelled conversion cannot launch an existing format repair');
    checks++;
  }
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: oldWindow });
}
console.log(`${checks} image transport cancellation scenarios passed: every backend, stalled HTTP/cancel/download, polling, FIFO release, queued skip, late response and prompt conversion.`);
