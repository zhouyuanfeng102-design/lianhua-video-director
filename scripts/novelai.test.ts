import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

type NovelAIModule = {
  checkNovelAIReferenceImagePreflight?: (
    backend: string,
    referenceAssetIds: readonly string[],
  ) => { allowed: true } | { allowed: false; message: string };
  resolveNovelAIEndpoint?: (baseUrl: string, endpoint?: string) => string;
  buildNovelAIImageRequest?: (
    config: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  };
  parseNovelAIImageResponse?: (
    body: string,
    options?: {
      inflateRaw?: (compressed: Uint8Array) => Promise<Uint8Array>;
    },
  ) => Promise<string>;
  parseNovelAIHttpResponse?: (
    response: {
      status: number;
      statusText?: string;
      body: string;
    },
    options?: {
      inflateRaw?: (compressed: Uint8Array) => Promise<Uint8Array>;
    },
  ) => Promise<string>;
};

const modulePath = '../src/' + 'novelai';
const novelai = await import(modulePath).catch(() => ({})) as NovelAIModule;

assert.equal(
  typeof novelai.checkNovelAIReferenceImagePreflight,
  'function',
  'NovelAI storyboard batches need a preflight decision before any task or converter work starts',
);
assert.deepEqual(
  novelai.checkNovelAIReferenceImagePreflight?.('novelai', ['asset-reference-10']),
  {
    allowed: false,
    message: 'NovelAI 当前不接收参考图像素。请取消勾选参考图，或切换到支持参考图的图像后端后再生成；本次未创建任务，也未调用文本转换或图像模型。',
  },
  'NovelAI must explicitly reject a batch containing any effective readable reference image',
);
assert.deepEqual(
  novelai.checkNovelAIReferenceImagePreflight?.('novelai', []),
  { allowed: true },
  'NovelAI text-to-image batches without reference pixels must remain available',
);
assert.deepEqual(
  novelai.checkNovelAIReferenceImagePreflight?.('openai', ['asset-reference-10']),
  { allowed: true },
  'reference-capable backends must not be blocked by the NovelAI preflight',
);

assert.equal(
  typeof novelai.resolveNovelAIEndpoint,
  'function',
  'NovelAI needs a dedicated endpoint resolver instead of reusing the OpenAI image route',
);
assert.equal(
  typeof novelai.buildNovelAIImageRequest,
  'function',
  'NovelAI needs a dedicated V4 request builder',
);
assert.equal(
  typeof novelai.parseNovelAIImageResponse,
  'function',
  'NovelAI needs to decode its JSON, image and ZIP response formats',
);
assert.equal(
  typeof novelai.parseNovelAIHttpResponse,
  'function',
  'NovelAI HTTP failures must be reported before response payload decoding',
);

assert.equal(
  novelai.resolveNovelAIEndpoint?.('https://image.novelai.net/'),
  'https://image.novelai.net/ai/generate-image',
);
assert.equal(
  novelai.resolveNovelAIEndpoint?.('https://proxy.example.test/v1/ai/generate-image?channel=video'),
  'https://proxy.example.test/v1/ai/generate-image?channel=video',
);
assert.equal(
  novelai.resolveNovelAIEndpoint?.(
    'https://proxy.example.test/v1/',
    '/custom/nai-generate?channel=video',
  ),
  'https://proxy.example.test/v1/custom/nai-generate?channel=video',
);
assert.equal(
  novelai.resolveNovelAIEndpoint?.(
    'https://proxy.example.test/v1',
    'https://images.example.test/ai/generate-image',
  ),
  'https://images.example.test/ai/generate-image',
);

const request = novelai.buildNovelAIImageRequest?.({
  baseUrl: 'https://image.novelai.net',
  apiKey: 'persistent-token',
  model: 'nai-diffusion-4-5-full',
}, {
  prompt: '1girl, silver hair, rain-soaked street',
  negativePrompt: 'text, watermark, bad hands',
  width: 1216,
  height: 832,
  steps: 31,
  scale: 5.5,
  sampler: 'k_dpmpp_2m',
  seed: 123456789,
  noiseSchedule: 'karras',
  qualityToggle: false,
  characterPrompts: [
    {
      prompt: '1girl, silver hair, amber eyes',
      negativePrompt: 'blue hair',
      positions: [{ x: 0.25, y: 0.6 }],
    },
    {
      prompt: '1man, black coat',
      positions: [{ x: 0.75, y: 0.55 }],
    },
  ],
});

assert.ok(request);
assert.equal(request.url, 'https://image.novelai.net/ai/generate-image');
assert.equal(request.method, 'POST');
assert.deepEqual(request.headers, {
  Authorization: 'Bearer persistent-token',
  'Content-Type': 'application/json',
  Accept: 'application/zip, application/json, image/png, image/jpeg, image/webp',
});

const requestBody = JSON.parse(request.body);
assert.equal(requestBody.input, '1girl, silver hair, rain-soaked street');
assert.equal(requestBody.model, 'nai-diffusion-4-5-full');
assert.equal(requestBody.action, 'generate');
assert.deepEqual(
  {
    params_version: requestBody.parameters.params_version,
    width: requestBody.parameters.width,
    height: requestBody.parameters.height,
    scale: requestBody.parameters.scale,
    sampler: requestBody.parameters.sampler,
    steps: requestBody.parameters.steps,
    n_samples: requestBody.parameters.n_samples,
    qualityToggle: requestBody.parameters.qualityToggle,
    ucPreset: requestBody.parameters.ucPreset,
    sm: requestBody.parameters.sm,
    sm_dyn: requestBody.parameters.sm_dyn,
    dynamic_thresholding: requestBody.parameters.dynamic_thresholding,
    controlnet_strength: requestBody.parameters.controlnet_strength,
    legacy: requestBody.parameters.legacy,
    add_original_image: requestBody.parameters.add_original_image,
    legacy_v3_extend: requestBody.parameters.legacy_v3_extend,
    seed: requestBody.parameters.seed,
    noise_schedule: requestBody.parameters.noise_schedule,
    negative_prompt: requestBody.parameters.negative_prompt,
  },
  {
    params_version: 3,
    width: 1216,
    height: 832,
    scale: 5.5,
    sampler: 'k_dpmpp_2m',
    steps: 31,
    n_samples: 1,
    qualityToggle: false,
    ucPreset: 4,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: false,
    legacy_v3_extend: false,
    seed: 123456789,
    noise_schedule: 'karras',
    negative_prompt: 'text, watermark, bad hands',
  },
);
assert.deepEqual(requestBody.parameters.v4_prompt, {
  use_coords: true,
  use_order: true,
  caption: {
    base_caption: '1girl, silver hair, rain-soaked street',
    char_captions: [
      {
        char_caption: '1girl, silver hair, amber eyes',
        centers: [{ x: 0.25, y: 0.6 }],
      },
      {
        char_caption: '1man, black coat',
        centers: [{ x: 0.75, y: 0.55 }],
      },
    ],
  },
  legacy_uc: false,
});
assert.deepEqual(requestBody.parameters.v4_negative_prompt, {
  use_coords: true,
  use_order: true,
  caption: {
    base_caption: 'text, watermark, bad hands',
    char_captions: [
      {
        char_caption: 'blue hair',
        centers: [{ x: 0.25, y: 0.6 }],
      },
      {
        char_caption: '',
        centers: [{ x: 0.75, y: 0.55 }],
      },
    ],
  },
  legacy_uc: false,
});

const defaultRequest = novelai.buildNovelAIImageRequest?.({
  baseUrl: 'https://proxy.example.test/nai',
  apiKey: 'token',
  model: 'nai-diffusion-4-full',
}, {
  prompt: 'cinematic portrait',
});
assert.ok(defaultRequest);
const defaultBody = JSON.parse(defaultRequest.body);
assert.equal(defaultBody.parameters.width, 1024);
assert.equal(defaultBody.parameters.height, 1024);
assert.equal(defaultBody.parameters.steps, 28);
assert.equal(defaultBody.parameters.scale, 5);
assert.equal(defaultBody.parameters.sampler, 'k_euler_ancestral');
assert.equal(defaultBody.parameters.noise_schedule, 'karras');
assert.equal(defaultBody.parameters.qualityToggle, true);
assert.equal(defaultBody.parameters.negative_prompt, '');

const legacyRequest = novelai.buildNovelAIImageRequest?.({
  baseUrl: 'https://image.novelai.net',
  apiKey: 'token',
  model: 'nai-diffusion-3',
}, {
  prompt: 'landscape',
});
assert.ok(legacyRequest);
const legacyParameters = JSON.parse(legacyRequest.body).parameters;
assert.equal('v4_prompt' in legacyParameters, false);
assert.equal('v4_negative_prompt' in legacyParameters, false);

const assertBuildThrows = (
  config: Record<string, unknown>,
  input: Record<string, unknown>,
  message: RegExp,
) => {
  assert.throws(
    () => novelai.buildNovelAIImageRequest?.(config, input),
    message,
  );
};

assert.throws(
  () => novelai.resolveNovelAIEndpoint?.('file:///tmp/nai'),
  /HTTP\(S\)/,
);
assert.throws(
  () => novelai.resolveNovelAIEndpoint?.(''),
  /不能为空/,
);
assertBuildThrows(
  { baseUrl: 'https://image.novelai.net', apiKey: '', model: 'nai-diffusion-4-full' },
  { prompt: 'portrait' },
  /Token|密钥/,
);
assertBuildThrows(
  { baseUrl: 'https://image.novelai.net', apiKey: 'token', model: '' },
  { prompt: 'portrait' },
  /模型/,
);
assertBuildThrows(
  { baseUrl: 'https://image.novelai.net', apiKey: 'token', model: 'nai-diffusion-4-full' },
  { prompt: '   ' },
  /提示词/,
);
for (const [field, invalidValue] of [
  ['width', 0],
  ['height', 1024.5],
  ['steps', 51],
  ['scale', -1],
  ['seed', -1],
] as const) {
  assertBuildThrows(
    { baseUrl: 'https://image.novelai.net', apiKey: 'token', model: 'nai-diffusion-4-full' },
    { prompt: 'portrait', [field]: invalidValue },
    new RegExp(field, 'i'),
  );
}
assertBuildThrows(
  { baseUrl: 'https://image.novelai.net', apiKey: 'token', model: 'nai-diffusion-4-full' },
  {
    prompt: 'portrait',
    characterPrompts: [{ prompt: 'hero', positions: [{ x: 1.1, y: 0.5 }] }],
  },
  /坐标/,
);

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(pngBase64, 'base64');

const createZip = (filename: string, content: Uint8Array, method: 0 | 8): Uint8Array => {
  const filenameBytes = Buffer.from(filename, 'utf8');
  const rawContent = Buffer.from(content);
  const compressed = method === 8 ? deflateRawSync(rawContent) : rawContent;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(rawContent.length, 22);
  localHeader.writeUInt16LE(filenameBytes.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(rawContent.length, 24);
  centralHeader.writeUInt16LE(filenameBytes.length, 28);

  const localRecord = Buffer.concat([localHeader, filenameBytes, compressed]);
  const centralRecord = Buffer.concat([centralHeader, filenameBytes]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralRecord.length, 12);
  endRecord.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, endRecord]);
};

assert.equal(
  await novelai.parseNovelAIImageResponse?.(`data:image/png;base64,${pngBase64}`),
  `data:image/png;base64,${pngBase64}`,
);
assert.equal(
  await novelai.parseNovelAIImageResponse?.(pngBase64),
  `data:image/png;base64,${pngBase64}`,
);
assert.equal(
  await novelai.parseNovelAIImageResponse?.(JSON.stringify({
    data: [{ b64_json: pngBase64 }],
  })),
  `data:image/png;base64,${pngBase64}`,
);
assert.equal(
  await novelai.parseNovelAIImageResponse?.(pngBytes.toString('latin1')),
  `data:image/png;base64,${pngBase64}`,
);

const storedZip = createZip('result.png', pngBytes, 0);
assert.equal(
  await novelai.parseNovelAIImageResponse?.(Buffer.from(storedZip).toString('base64')),
  `data:image/png;base64,${pngBase64}`,
);

let inflateCalls = 0;
const deflatedZip = createZip('result.png', pngBytes, 8);
assert.equal(
  await novelai.parseNovelAIImageResponse?.(Buffer.from(deflatedZip).toString('latin1'), {
    inflateRaw: async (compressed) => {
      inflateCalls += 1;
      return inflateRawSync(Buffer.from(compressed));
    },
  }),
  `data:image/png;base64,${pngBase64}`,
);
assert.equal(inflateCalls, 1);

await assert.rejects(
  () => novelai.parseNovelAIImageResponse?.('{"error":"fail"}') ?? Promise.resolve(''),
  /fail|图片|响应/,
);
await assert.rejects(
  () => novelai.parseNovelAIImageResponse?.('PK\u0003\u0004\ufffd') ?? Promise.resolve(''),
  /UTF-8|base64|代理|损坏/,
);
await assert.rejects(
  () => novelai.parseNovelAIHttpResponse?.({
    status: 401,
    statusText: 'Unauthorized',
    body: '{"message":"token expired"}',
  }) ?? Promise.resolve(''),
  /401.*token expired/i,
);
assert.equal(
  await novelai.parseNovelAIHttpResponse?.({ status: 200, body: pngBase64 }),
  `data:image/png;base64,${pngBase64}`,
);

console.log('NovelAI request and response adapter checks passed');
