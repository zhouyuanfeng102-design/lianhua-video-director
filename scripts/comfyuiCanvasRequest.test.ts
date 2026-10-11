import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
};

type CanvasInput = {
  name: string;
  type: string;
  link: number | null;
  widget?: { name: string };
};

const scalarInput = (name: string, type: string): CanvasInput => ({
  name, type, link: null, widget: { name },
});
const linkedInput = (name: string, type: string, link: number): CanvasInput => ({
  name, type, link,
});
const loadImage = (id: number, mode: number) => ({
  id,
  type: 'LoadImage',
  mode,
  inputs: [scalarInput('image', 'COMBO'), scalarInput('upload', 'IMAGEUPLOAD')],
  outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [id + 6] }],
  widgets_values: [`old-reference-${id}.png`, 'image'],
});

const workbenchValues = {
  风格库: '无',
  风格: '',
  图片数据: '[]',
  提示词文本: 'OLD_WORKBENCH_PROMPT',
  起始索引: 0,
  最大行数: 1,
  去除空行: true,
};
const generationValues = {
  种子: 123456789,
  Krea步数: 20,
  KreaCFG: 1.2,
  Krea采样器: 'euler',
  Krea调度器: 'simple',
  宽度: 1536,
  高度: 1024,
  Qwen步数: 8,
  QwenCFG: 1,
  Qwen采样器: 'euler',
  Qwen调度器: 'simple',
  随机种子: false,
};
const scalarType = (value: unknown) => typeof value === 'boolean'
  ? 'BOOLEAN'
  : typeof value === 'number' ? 'FLOAT' : 'STRING';
const canvas = JSON.stringify({
  version: 0.4,
  nodes: [
    loadImage(21, 0),
    loadImage(19, 0),
    loadImage(22, 2),
    loadImage(20, 0),
    {
      id: 29,
      type: 'easy stringJoinLines',
      mode: 0,
      inputs: [scalarInput('string', 'STRING'), scalarInput('delimiter', 'STRING')],
      outputs: [{ name: 'STRING', type: 'STRING', links: [33] }],
      widgets_values: ['OLD_JOINED_PROMPT', ', '],
      widgets_values_named: { string: 'OLD_JOINED_PROMPT', delimiter: ', ' },
    },
    {
      id: 18,
      type: 'LazyMergeWorkbench',
      mode: 0,
      inputs: [
        linkedInput('图像1', 'IMAGE', 25),
        linkedInput('图像2', 'IMAGE', 26),
        linkedInput('图像3', 'IMAGE', 27),
        linkedInput('图像4', 'IMAGE', 28),
        linkedInput('提示词', 'STRING', 33),
        ...Object.entries(workbenchValues).map(([name, value]) => scalarInput(name, scalarType(value))),
      ],
      outputs: [{ name: '工作台包', type: '*', links: [23] }],
      widgets_values: Object.values(workbenchValues),
      widgets_values_named: workbenchValues,
    },
    {
      id: 12,
      type: 'LazyMergeGenerate',
      mode: 0,
      inputs: [
        linkedInput('工作台包', '*', 23),
        ...Object.entries(generationValues).map(([name, value]) => scalarInput(name, scalarType(value))),
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [21] }],
      widgets_values: Object.values(generationValues),
      widgets_values_named: generationValues,
    },
    {
      id: 10,
      type: 'SaveImage',
      mode: 0,
      inputs: [linkedInput('images', 'IMAGE', 21), scalarInput('filename_prefix', 'STRING')],
      widgets_values: ['canvas-result'],
    },
  ],
  links: [
    [25, 19, 0, 18, 0, 'IMAGE'],
    [26, 20, 0, 18, 1, 'IMAGE'],
    [27, 21, 0, 18, 2, 'IMAGE'],
    [28, 22, 0, 18, 3, 'IMAGE'],
    [33, 29, 0, 18, 4, 'STRING'],
    [23, 18, 0, 12, 0, '*'],
    [21, 12, 0, 10, 0, 'IMAGE'],
  ],
});

const root = 'http://127.0.0.1:8188';
const promptId = 'canvas-request-test';
const currentPrompt = '一朵莲花静立在平静水面上。';
const imageSamples = JSON.parse(readFileSync(
  new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8',
)) as Record<string, string>;
const referenceImages = ['png', 'jpeg', 'webp'].map((format) => (
  `data:image/${format};base64,${imageSamples[format]}`
));
const uploadedNames = ['slot-1.png', 'slot-2.png', 'slot-3.png'];
const config: ImageApiConfig = {
  enabled: true,
  backend: 'comfyui',
  baseUrl: root,
  apiKey: '',
  model: '',
  workflowJson: canvas,
  comfyuiPathMode: 'preset',
  comfyuiPromptPath: '/prompt',
};
const requests: DesktopRequestPayload[] = [];
const downloads: Array<string | { url: string; headers?: Record<string, string> }> = [];
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: DesktopRequestPayload) => {
        requests.push(payload);
        if (payload.url === `${root}/upload/image`) {
          const file = payload.multipart?.files[0];
          const referenceIndex = referenceImages.indexOf(file?.dataUrl || '');
          assert.ok(referenceIndex >= 0, '上传的必须是本次选中的真实参考图像素');
          assert.equal(file?.name, 'image');
          return {
            status: 200,
            body: JSON.stringify({
              name: uploadedNames[referenceIndex],
              subfolder: 'lianhua-references',
              type: 'input',
            }),
          };
        }
        if (payload.url === `${root}/prompt`) {
          return { status: 200, body: JSON.stringify({ prompt_id: promptId }) };
        }
        if (payload.url === `${root}/history/${promptId}`) {
          return {
            status: 200,
            body: JSON.stringify({
              [promptId]: {
                status: { completed: true, status_str: 'success' },
                outputs: {
                  10: { images: [{ filename: 'canvas-result.png', subfolder: 'test-output', type: 'output' }] },
                },
              },
            }),
          };
        }
        throw new Error(`测试收到未预期的 ComfyUI 请求：${payload.method} ${payload.url}`);
      },
      downloadImage: async (remote: string | { url: string; headers?: Record<string, string> }) => {
        downloads.push(remote);
        return 'data:image/png;base64,AA==';
      },
    },
  },
});

let result: Awaited<ReturnType<typeof requestImageModel>> | undefined;
try {
  result = await requestImageModel(config, {
    prompt: currentPrompt,
    promptMode: 'verbatim',
    width: 1536,
    height: 1024,
    referenceImages,
    primaryReferenceImageCount: 3,
    preserveReferenceImageOrder: true,
  });
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const uploadRequests = requests.filter((request) => request.url === `${root}/upload/image`);
assert.equal(uploadRequests.length, 3, '仅上传三个实际选中的参考图，静音槽位不应增加上传');
assert.deepEqual(uploadRequests.map((request) => request.multipart?.files[0]?.dataUrl), referenceImages);
const promptRequests = requests.filter((request) => request.url === `${root}/prompt`);
assert.equal(promptRequests.length, 1, '画布转换后只提交一次生成请求');
assert.equal(promptRequests[0]?.method, 'POST');
const submitted = JSON.parse(promptRequests[0]?.body || '{}') as Record<string, any>;
assert.equal(submitted.client_id, 'lianhua-video-director');
const graph = submitted.prompt as Record<string, any>;
assert.ok(graph, '提交给 ComfyUI 的必须是 API 节点图');
assert.equal(graph.nodes, undefined);
assert.equal(graph.links, undefined);
assert.equal(graph['19']?.class_type, 'LoadImage');
assert.equal(graph['20']?.class_type, 'LoadImage');
assert.equal(graph['21']?.class_type, 'LoadImage');
assert.equal(graph['22'], undefined, 'mode=2 的 LoadImage 不得提交');
assert.equal(graph['19']?.inputs?.image, 'lianhua-references/slot-1.png');
assert.equal(graph['20']?.inputs?.image, 'lianhua-references/slot-2.png');
assert.equal(graph['21']?.inputs?.image, 'lianhua-references/slot-3.png');
assert.equal(graph['19']?.inputs?.upload, undefined, '前端上传控件不得混入节点 API 参数');
assert.deepEqual(graph['18']?.inputs?.['图像1'], ['19', 0]);
assert.deepEqual(graph['18']?.inputs?.['图像2'], ['20', 0]);
assert.deepEqual(graph['18']?.inputs?.['图像3'], ['21', 0]);
assert.equal(graph['18']?.inputs?.['图像4'], undefined, '静音节点的连线必须一并排除');
assert.equal(graph['29']?.inputs?.string, currentPrompt);
assert.equal(graph['29']?.inputs?.delimiter, ', ');
assert.equal(graph['18']?.inputs?.['提示词文本'], currentPrompt);
assert.deepEqual(graph['18']?.inputs?.['提示词'], ['29', 0]);
assert.deepEqual(graph['12']?.inputs?.['工作台包'], ['18', 0]);
assert.deepEqual(graph['10']?.inputs?.images, ['12', 0]);
assert.equal(graph['10']?.inputs?.filename_prefix, 'canvas-result');
Object.entries(generationValues).forEach(([name, value]) => {
  assert.equal(graph['12']?.inputs?.[name], value, `自定义生成节点的 ${name} 参数必须保留`);
});
assert.doesNotMatch(JSON.stringify(graph), /OLD_JOINED_PROMPT|OLD_WORKBENCH_PROMPT|__PROMPT__/u);
assert.equal(requests.filter((request) => request.url === `${root}/history/${promptId}`).length, 1);
const expectedViewUrl = `${root}/view?${new URLSearchParams({
  filename: 'canvas-result.png', subfolder: 'test-output', type: 'output',
}).toString()}`;
assert.deepEqual(downloads, [expectedViewUrl]);
assert.equal(result?.url, expectedViewUrl);
assert.equal(result?.dataUrl, 'data:image/png;base64,AA==');
console.log('ComfyUI canvas request: 3 reference uploads, API conversion, Lazy prompt binding, muted slots, and sampling preservation passed.');
