import assert from 'node:assert/strict';
import { requestImageModel } from '../src/services/llm';
import type { ImageApiConfig } from '../src/types';

type DesktopRequestPayload = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  multipart?: {
    fields: Array<{ name: string; value: string }>;
    files: Array<{ name: string; fileName: string; dataUrl: string }>;
  };
  timeoutMs?: number;
};

type DownloadTarget = string | {
  url: string;
  headers?: Record<string, string>;
};

const promptId = 'prompt-current';
const root = 'http://127.0.0.1:8188';
const workflowA = JSON.stringify({
  1: {
    inputs: { text: 'WORKFLOW_A::__PROMPT__' },
    class_type: 'CLIPTextEncode',
  },
  9: {
    inputs: { filename_prefix: 'WORKFLOW_A' },
    class_type: 'SaveImage',
  },
});
const workflowB = JSON.stringify({
  1: {
    inputs: { text: 'WORKFLOW_B::__PROMPT__' },
    class_type: 'CLIPTextEncode',
  },
  2: {
    inputs: { text: '__NEGATIVE_PROMPT__' },
    class_type: 'CLIPTextEncode',
  },
  3: {
    inputs: { width: '__WIDTH__', height: '__HEIGHT__', batch_size: 1 },
    class_type: 'EmptyLatentImage',
  },
  4: {
    inputs: {
      model: ['6', 0],
      positive: ['1', 0],
      negative: ['2', 0],
      latent_image: ['3', 0],
      seed: '__SEED__',
    },
    class_type: 'KSampler',
  },
  5: {
    inputs: { image: 'old-reference.png', upload: 'image' },
    class_type: 'LoadImage',
    _meta: { title: 'IPAdapter 角色与画风参考图' },
  },
  6: {
    inputs: { image: ['5', 0] },
    class_type: 'IPAdapterAdvanced',
  },
  7: {
    inputs: { images: ['5', 0] },
    class_type: 'PreviewImage',
  },
  9: {
    inputs: { images: ['4', 0], filename_prefix: 'WORKFLOW_B' },
    class_type: 'SaveImage',
  },
});

const config: ImageApiConfig = {
  enabled: true,
  backend: 'comfyui',
  baseUrl: `${root}/`,
  apiKey: '',
  model: '',
  workflowJson: workflowA,
  comfyuiPathMode: 'preset',
  comfyuiPromptPath: '/prompt',
  comfyuiWorkflows: [
    {
      id: 'workflow-a',
      name: '工作流 A',
      workflowJson: workflowA,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'workflow-b',
      name: '工作流 B',
      workflowJson: workflowB,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  activeComfyuiWorkflowId: 'workflow-b',
};

const requests: DesktopRequestPayload[] = [];
const downloads: DownloadTarget[] = [];
let historyRequestCount = 0;
const originalWindow = globalThis.window;

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        requests.push(payload);
        if (payload.url === `${root}/upload/image`) {
          return {
            status: 200,
            body: JSON.stringify({
              name: 'shot-10-reference.png',
              subfolder: 'lianhua-references',
              type: 'input',
            }),
          };
        }
        if (payload.url === `${root}/prompt`) {
          return { status: 200, body: JSON.stringify({ prompt_id: promptId }) };
        }
        if (payload.url === `${root}/history/${promptId}`) {
          historyRequestCount += 1;
          if (historyRequestCount === 1) {
            return { status: 200, body: '{}' };
          }
          return {
            status: 200,
            body: JSON.stringify({
              [promptId]: {
                status: { completed: true, status_str: 'success' },
                outputs: {
                  7: {
                    images: [{
                      filename: 'raw-reference-preview.png',
                      subfolder: 'input-preview',
                      type: 'temp',
                    }],
                  },
                  9: {
                    images: [{
                      filename: '莲华 result.png',
                      subfolder: 'finals/chapter-1',
                      type: 'output',
                    }],
                  },
                },
              },
            }),
          };
        }
        throw new Error(`测试收到未预期的 ComfyUI 请求：${payload.method} ${payload.url}`);
      },
      downloadImage: async (remote: DownloadTarget) => {
        downloads.push(remote);
        return 'data:image/png;base64,AA==';
      },
    },
  },
});

let result: Awaited<ReturnType<typeof requestImageModel>> | undefined;
try {
  result = await requestImageModel(config, {
    prompt: '莲花剑客站在雨中',
    negativePrompt: '文字，水印',
    width: 1280,
    height: 720,
    referenceImages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'],
  });
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

assert.ok(result, 'ComfyUI 不填写 model 时仍应完成真实工作流请求');
assert.equal(requests.length, 4);
assert.equal(requests[0]?.method, 'POST');
assert.equal(requests[0]?.url, `${root}/upload/image`);
assert.deepEqual(requests[0]?.multipart?.fields, [
  { name: 'type', value: 'input' },
  { name: 'overwrite', value: 'true' },
  { name: 'subfolder', value: 'lianhua-references' },
]);
assert.equal(requests[0]?.multipart?.files?.length, 1);
assert.equal(requests[0]?.multipart?.files?.[0]?.name, 'image');
assert.match(
  requests[0]?.multipart?.files?.[0]?.fileName || '',
  /^lianhua-reference-(?:[a-f0-9]{64}|[a-f0-9]{16})\.png$/u,
  'content-addressed filenames prevent one copy per storyboard frame from accumulating in ComfyUI input',
);
assert.equal(
  requests[0]?.multipart?.files?.[0]?.dataUrl,
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  'the real selected image pixels must be uploaded instead of only adding prompt text',
);
assert.equal(requests[1]?.method, 'POST');
assert.equal(requests[1]?.url, `${root}/prompt`);

const submitted = JSON.parse(requests[1]?.body || '{}') as Record<string, any>;
assert.equal(submitted.client_id, 'lianhua-video-director');
assert.equal(submitted.prompt?.['1']?.inputs?.text, 'WORKFLOW_B::莲花剑客站在雨中');
assert.equal(submitted.prompt?.['2']?.inputs?.text, '文字，水印');
assert.equal(submitted.prompt?.['3']?.inputs?.width, 1280);
assert.equal(submitted.prompt?.['3']?.inputs?.height, 720);
assert.equal(submitted.prompt?.['9']?.inputs?.filename_prefix, 'WORKFLOW_B');
assert.equal(
  submitted.prompt?.['5']?.inputs?.image,
  'lianhua-references/shot-10-reference.png',
  'the uploaded reference filename must be injected into the connected LoadImage node',
);
assert.equal(typeof submitted.prompt?.['4']?.inputs?.seed, 'number');
assert.doesNotMatch(JSON.stringify(submitted.prompt), /WORKFLOW_A|__(?:PROMPT|NEGATIVE_PROMPT|WIDTH|HEIGHT|SEED)__/u);

assert.equal(requests[2]?.method, 'GET');
assert.equal(requests[3]?.method, 'GET');
assert.equal(requests[2]?.url, `${root}/history/${promptId}`);
assert.equal(requests[3]?.url, `${root}/history/${promptId}`);
assert.equal(historyRequestCount, 2, '首次 history 为空时必须继续轮询当前 prompt_id');

const viewQuery = new URLSearchParams({
  filename: '莲华 result.png',
  subfolder: 'finals/chapter-1',
  type: 'output',
});
const expectedViewUrl = `${root}/view?${viewQuery.toString()}`;
assert.deepEqual(downloads, [expectedViewUrl]);
assert.equal(result.url, expectedViewUrl);
assert.equal(result.dataUrl, 'data:image/png;base64,AA==');
assert.doesNotMatch(result.url || '', /raw-reference-preview/u, 'generated SaveImage output must win over a reference PreviewImage side output');

const supplementalRequests: DesktopRequestPayload[] = [];
let supplementalUploadCount = 0;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        supplementalRequests.push(payload);
        if (payload.url === `${root}/upload/image`) {
          supplementalUploadCount += 1;
          return {
            status: 200,
            body: JSON.stringify({
              name: supplementalUploadCount === 1 ? 'global-shot-10.png' : 'inferred-character.webp',
              subfolder: 'lianhua-references',
              type: 'input',
            }),
          };
        }
        if (payload.url === `${root}/prompt`) {
          return { status: 200, body: JSON.stringify({ prompt_id: 'prompt-supplemental' }) };
        }
        if (payload.url === `${root}/history/prompt-supplemental`) {
          return {
            status: 200,
            body: JSON.stringify({
              'prompt-supplemental': {
                status: { completed: true, status_str: 'success' },
                outputs: { 9: { images: [{ filename: 'supplemental-result.png', type: 'output' }] } },
              },
            }),
          };
        }
        throw new Error(`未预期请求：${payload.method} ${payload.url}`);
      },
      downloadImage: async () => 'data:image/png;base64,AA==',
    },
  },
});
try {
  await requestImageModel(config, {
    prompt: '第十镜必须作为主参考',
    referenceImages: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      'data:image/webp;base64,UklGRgAAAABXRUJQ',
    ],
    primaryReferenceImageCount: 1,
  });
  const supplementalPromptRequest = supplementalRequests.find((request) => request.url === `${root}/prompt`);
  const supplementalPrompt = JSON.parse(supplementalPromptRequest?.body || '{}') as Record<string, any>;
  assert.equal(
    supplementalPrompt.prompt?.['5']?.inputs?.image,
    'lianhua-references/global-shot-10.png',
    'inferred entity images must not displace or block the explicitly checked global reference in a single-slot workflow',
  );
  assert.equal(
    supplementalRequests.filter((request) => request.url === `${root}/upload/image`).length,
    2,
  );
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const textOnlyRequests: DesktopRequestPayload[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        textOnlyRequests.push(payload);
        if (payload.url === `${root}/prompt`) {
          return { status: 200, body: JSON.stringify({ prompt_id: 'prompt-text-only-supplemental' }) };
        }
        if (payload.url === `${root}/history/prompt-text-only-supplemental`) {
          return {
            status: 200,
            body: JSON.stringify({
              'prompt-text-only-supplemental': {
                status: { completed: true, status_str: 'success' },
                outputs: { 9: { images: [{ filename: 'text-only-result.png', type: 'output' }] } },
              },
            }),
          };
        }
        throw new Error(`纯文生图工作流收到未预期请求：${payload.method} ${payload.url}`);
      },
      downloadImage: async () => 'data:image/png;base64,AA==',
    },
  },
});
try {
  const textOnlyResult = await requestImageModel({
    ...config,
    activeComfyuiWorkflowId: 'workflow-a',
  }, {
    prompt: '分镜画面 lianhua-reference-probe-1.png',
    referenceImages: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      'data:image/webp;base64,UklGRgAAAABXRUJQ',
    ],
    primaryReferenceImageCount: 0,
  });
  assert.equal(textOnlyResult.dataUrl, 'data:image/png;base64,AA==');
  assert.equal(
    textOnlyRequests.some((request) => request.url === `${root}/upload/image`),
    false,
    'inferred supplemental images must not be uploaded when a text-only workflow has no reference input',
  );
  const textOnlyPromptRequest = textOnlyRequests.find((request) => request.url === `${root}/prompt`);
  assert.ok(textOnlyPromptRequest, 'the text-only ComfyUI workflow must still be submitted');
  const textOnlyPrompt = JSON.parse(textOnlyPromptRequest.body || '{}') as Record<string, any>;
  assert.equal(
    textOnlyPrompt.prompt?.['1']?.inputs?.text,
    'WORKFLOW_A::分镜画面 lianhua-reference-probe-1.png',
    'a probe-like filename in prompt text must not be mistaken for a connected reference-image input',
  );
  const requestCountBeforePrimaryFailure = textOnlyRequests.length;
  await assert.rejects(
    requestImageModel({
      ...config,
      activeComfyuiWorkflowId: 'workflow-a',
    }, {
      prompt: '主动选择主参考图的分镜画面',
      referenceImages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'],
      primaryReferenceImageCount: 1,
    }),
    /没有连接到输出的 LoadImage/u,
    'a text-only workflow must still reject an explicitly selected primary reference',
  );
  assert.equal(
    textOnlyRequests.length,
    requestCountBeforePrimaryFailure,
    'explicit primary-reference incompatibility must fail before upload or prompt submission',
  );
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const malformedUploadRequests: DesktopRequestPayload[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        malformedUploadRequests.push(payload);
        if (payload.url === `${root}/upload/image`) {
          return { status: 200, body: JSON.stringify({ type: 'input' }) };
        }
        throw new Error('上传响应无文件名时不应提交工作流');
      },
    },
  },
});
try {
  await assert.rejects(
    requestImageModel(config, {
      prompt: '不能接受伪成功上传',
      referenceImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    }),
    /没有返回有效的 input 图片名称/u,
  );
  assert.equal(
    malformedUploadRequests.some((request) => request.url === `${root}/prompt`),
    false,
  );
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const requestsWithoutReferenceInput: DesktopRequestPayload[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        requestsWithoutReferenceInput.push(payload);
        throw new Error('缺少参考图节点时不应上传或提交');
      },
    },
  },
});
try {
  await assert.rejects(
    requestImageModel({
      ...config,
      comfyuiWorkflows: config.comfyuiWorkflows?.map((workflow) => (
        workflow.id === 'workflow-a' ? workflow : { ...workflow, workflowJson: workflowA }
      )),
      activeComfyuiWorkflowId: 'workflow-a',
      workflowJson: workflowA,
    }, {
      prompt: '不能伪装已参考',
      referenceImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    }),
    /没有连接到输出的 LoadImage/u,
  );
  assert.equal(requestsWithoutReferenceInput.length, 0);
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const requestsForAbsoluteCustomPath: DesktopRequestPayload[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        requestsForAbsoluteCustomPath.push(payload);
        throw new Error('绝对自定义路径不应发出网络请求');
      },
    },
  },
});
try {
  await assert.rejects(
    requestImageModel({
      ...config,
      comfyuiPathMode: 'custom',
      comfyuiPromptPath: 'https://other-comfy.example.com/prompt',
    }, {
      prompt: '不会提交的提示词',
      width: 1024,
      height: 1024,
    }),
    /自定义提交路径.*相对路径/u,
    '绝对提交地址无法可靠推导 history/view 根地址，必须在发请求前明确拒绝',
  );
  assert.equal(requestsForAbsoluteCustomPath.length, 0);
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

type ComfyReply = { status: number; body: string };
type ComfyPollingFixture = {
  requests: DesktopRequestPayload[];
  historyCount: number;
  downloadCount: number;
  nowMs: number;
  advanceByMs: number;
  delays: number[];
  cancelledTimers: number;
  history: (count: number) => ComfyReply | Promise<ComfyReply>;
  download: () => string | Promise<string>;
  beforeTimer?: () => void;
};

const successfulComfyHistory = (): ComfyReply => ({
  status: 200,
  body: JSON.stringify({
    [promptId]: {
      status: { completed: true, status_str: 'success' },
      outputs: { 9: { images: [{ filename: 'long-running-result.png', type: 'output' }] } },
    },
  }),
});

/** Advance a fake clock instead of waiting for long inference or retry timers. */
const withComfyPollingFixture = async (run: (fixture: ComfyPollingFixture) => Promise<void>): Promise<void> => {
  const savedWindow = globalThis.window;
  const savedNow = Date.now;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  const timers = new Set<number>();
  let timerId = 0;
  const fixture: ComfyPollingFixture = {
    requests: [], historyCount: 0, downloadCount: 0, nowMs: 0, advanceByMs: 750,
    delays: [], cancelledTimers: 0,
    history: () => successfulComfyHistory(),
    download: () => 'data:image/png;base64,AA==',
  };
  Date.now = () => fixture.nowMs;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = ++timerId;
    timers.add(id);
    fixture.delays.push(Number(delay));
    queueMicrotask(() => {
      if (!timers.has(id)) return;
      fixture.nowMs += Math.max(Number(delay), fixture.advanceByMs);
      fixture.beforeTimer?.();
      if (timers.delete(id)) handler(...args);
    });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    if (timers.delete(Number(id))) fixture.cancelledTimers += 1;
  }) as unknown as typeof globalThis.clearTimeout;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      lianhuaDesktop: {
        request: async (payload: DesktopRequestPayload) => {
          fixture.requests.push(payload);
          if (payload.url === `${root}/prompt`) return { status: 200, body: JSON.stringify({ prompt_id: promptId }) };
          if (payload.url === `${root}/history/${promptId}`) return fixture.history(++fixture.historyCount);
          throw new Error(`unexpected fake ComfyUI request: ${payload.method} ${payload.url}`);
        },
        downloadImage: async () => {
          fixture.downloadCount += 1;
          return fixture.download();
        },
      },
    },
  });
  try {
    await run(fixture);
  } finally {
    Date.now = savedNow;
    globalThis.setTimeout = savedSetTimeout;
    globalThis.clearTimeout = savedClearTimeout;
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  }
};

await withComfyPollingFixture(async (fixture) => {
  fixture.advanceByMs = 11 * 60_000;
  fixture.history = (count) => count < 3 ? { status: 200, body: '{}' } : successfulComfyHistory();
  const generated = await requestImageModel(config, { prompt: '允许慢工作流继续等待' });
  assert.equal(fixture.historyCount, 3, 'history must keep polling after the former ten-minute total deadline');
  assert.ok(fixture.nowMs > 20 * 60_000, 'the fake inference must exceed ten minutes without real waiting');
  assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 1, 'long inference must not resubmit generation');
  assert.ok(fixture.requests.every((request) => !('timeoutMs' in request)), 'ComfyUI HTTP requests must not create an elapsed-time deadline');
  assert.equal(fixture.downloadCount, 1);
  assert.match(generated.url || '', /long-running-result\.png/u);
});

await withComfyPollingFixture(async (fixture) => {
  fixture.history = (count) => {
    if (count === 1) throw new Error('模型接口请求超时（60 秒）');
    if (count === 2) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    if (count === 3) return { status: 503, body: 'temporarily unavailable' };
    if (count === 4) return { status: 429, body: 'please retry the status query' };
    return successfulComfyHistory();
  };
  await requestImageModel(config, { prompt: '轮询网络暂时中断后继续' });
  assert.equal(fixture.historyCount, 5, 'temporary network timeouts and status-query failures must retry the same job');
  assert.deepEqual(fixture.delays, [1500, 3000, 6000, 10000], 'repeated query failures use bounded, cancelable backoff');
  assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 1);
  assert.ok(fixture.requests.filter((request) => request.method === 'GET').every((request) => request.url === `${root}/history/${promptId}`));
});

for (const failure of [
  { reply: { status: 403, body: JSON.stringify({ error: { message: 'forbidden' } }) }, expected: /查询任务失败.*forbidden/u },
  { reply: { status: 200, body: JSON.stringify({ [promptId]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } }) }, expected: /工作流执行失败.*CUDA out of memory/u },
  { reply: { status: 200, body: JSON.stringify({ [promptId]: { status: { status_str: 'running', messages: [['execution_interrupted', {}]] } } }) }, expected: /工作流执行失败.*中断/u },
  ...['cancelled', 'canceled', 'interrupted'].map((status) => ({
    reply: { status: 200, body: JSON.stringify({ [promptId]: { status: { status_str: status } } }) },
    expected: /工作流执行失败/u,
  })),
  { reply: { status: 200, body: JSON.stringify({ [promptId]: { status: { completed: true, status_str: 'success' }, outputs: {} } }) }, expected: /已完成.*没有输出可用图片/u },
]) {
  await withComfyPollingFixture(async (fixture) => {
    fixture.history = () => failure.reply;
    await assert.rejects(requestImageModel(config, { prompt: '明确失败必须终止' }), failure.expected);
    assert.equal(fixture.historyCount, 1);
    assert.equal(fixture.downloadCount, 0);
    assert.deepEqual(fixture.delays, [], 'terminal failure must not be mistaken for an indefinitely running job');
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 1);
  });
}

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
await withComfyPollingFixture(async (fixture) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestImageModel(config, { prompt: '取消前不提交', signal: controller.signal }), isAbortError);
  assert.equal(fixture.requests.length, 0);
});
await withComfyPollingFixture(async (fixture) => {
  const controller = new AbortController();
  fixture.history = () => {
    queueMicrotask(() => controller.abort());
    return new Promise<ComfyReply>(() => {});
  };
  await assert.rejects(requestImageModel(config, { prompt: '取消正在查询的任务', signal: controller.signal }), isAbortError);
  assert.equal(fixture.historyCount, 1);
  assert.equal(fixture.downloadCount, 0);
  assert.deepEqual(fixture.delays, [], 'a user abort must not be treated as a retryable HTTP timeout');
});
await withComfyPollingFixture(async (fixture) => {
  const controller = new AbortController();
  fixture.history = () => ({ status: 200, body: '{}' });
  fixture.beforeTimer = () => controller.abort();
  await assert.rejects(requestImageModel(config, { prompt: '取消轮询间隔', signal: controller.signal }), isAbortError);
  assert.equal(fixture.historyCount, 1);
  assert.equal(fixture.cancelledTimers, 1, 'canceling during the poll interval must clear its timer immediately');
  assert.equal(fixture.downloadCount, 0);
});
await withComfyPollingFixture(async (fixture) => {
  const controller = new AbortController();
  fixture.download = () => {
    queueMicrotask(() => controller.abort());
    return new Promise<string>(() => {});
  };
  await assert.rejects(requestImageModel(config, { prompt: '取消结果读取', signal: controller.signal }), isAbortError);
  assert.equal(fixture.historyCount, 1);
  assert.equal(fixture.downloadCount, 1);
});

console.log('ComfyUI workflow, unbounded generation polling, transient retry, cancellation and image download checks passed');
