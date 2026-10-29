import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRunningHubImageRequest, importRunningHubImageWorkflow, isRunningHubImageWorkflowReady,
  normalizeRunningHubImageConfig, selectedRunningHubImageWorkflow, validateRunningHubImageConfig } from '../src/runningHubImage';
import { requestRunningHubImage } from '../src/services/runningHubImage';
import { createImageGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { ImageApiConfig, ImageGenerationTask } from '../src/types';
import { requestImageModel } from '../src/services/llm';
import { captureImageApiSnapshot, resolveImageApiForRegeneration } from '../src/imageApiSelection';
import { exportRunningHubVideoWorkflow, normalizeRunningHubVideoConfig } from '../src/runningHubVideo';
import { removeRunningHubImageSlot, syncRunningHubImageSlots } from '../src/runningHubImageSlots';
import { IMAGE_V3_BODY, IMAGE_V3_CURL } from './fixtures/runningHubImageV3';

const body = { nodeInfoList: [
  { nodeId: '95', fieldName: 'value', fieldValue: '1464', description: '宽度' },
  { nodeId: '96', fieldName: 'value', fieldValue: 1016, description: '高度' },
  { nodeId: '115', fieldName: 'prompt', fieldValue: 'original business prompt' },
], instanceType: 'default', usePersonalQueue: false };
const curl = `curl --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/2070152175753453569' --header 'Authorization: Bearer EXAMPLE_NOT_REAL' --header 'Content-Type: application/json' --data '${JSON.stringify(body)}'`;
const config = (): ImageApiConfig => {
  const imported = importRunningHubImageWorkflow(curl, 'Krea AI image');
  return { ...createInitialState().settings.imageApi, enabled: true, backend: 'runninghub', baseUrl: imported.baseUrl!, apiKey: 'LOCAL_FAKE_KEY',
    runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id };
};
const response = (payload: unknown, status = 200) => ({ status, body: JSON.stringify(payload) });

test('official AI-app import safely binds only business prompt and documented width/height, preserving original request', () => {
  const imported = importRunningHubImageWorkflow(curl, 'Krea AI image');
  assert.equal(imported.workflow.remoteId, '2070152175753453569');
  assert.equal(imported.workflow.runKind, 'ai-app');
  assert.deepEqual(imported.workflow.mapping.prompt, [{ nodeId: '115', inputName: 'prompt' }]);
  assert.deepEqual(imported.workflow.mapping.parameters, { width: { nodeId: '95', inputName: 'value' }, height: { nodeId: '96', inputName: 'value' } });
  assert.deepEqual(JSON.parse(imported.workflow.requestTemplate), body);
  assert.equal(isRunningHubImageWorkflowReady(imported.workflow), true);
  assert.ok(!JSON.stringify(imported).includes('EXAMPLE_NOT_REAL'));
  assert.equal(curl.includes('EXAMPLE_NOT_REAL'), true, 'original input remains unchanged');
});

test('V3 API import binds labelled prompt and references immediately; direct requests submit zero to three references', () => {
  const imported = importRunningHubImageWorkflow(IMAGE_V3_CURL, 'V3 三参考图');
  assert.equal(imported.workflow.remoteId, '2079381758411587586');
  assert.deepEqual(imported.workflow.mapping.prompt, [{ nodeId: '107', inputName: 'text' }]);
  assert.deepEqual(imported.workflow.mapping.images, ['181', '182', '183'].map(nodeId => ({ nodeId, inputName: 'image', role: 'general' })),
    'the direct-import path must accept selected references without opening the workflow editor');
  const original = JSON.stringify(imported.workflow);
  const prepared = syncRunningHubImageSlots(imported.workflow);
  assert.equal(prepared, imported.workflow, 'opening the editor does not add more inputs to a freshly imported workflow');
  assert.equal(prepared.mapping.imageCount, undefined, 'Quantity/Piece is not an inferred reference-count input');
  assert.equal(JSON.stringify(imported.workflow), original, 'editor preparation must not mutate the saved input');
  const current: ImageApiConfig = { ...createInitialState().settings.imageApi, enabled: true, backend: 'runninghub',
    baseUrl: imported.baseUrl!, apiKey: 'LOCAL_FAKE_KEY', runningHubWorkflows: [prepared], activeRunningHubWorkflowId: prepared.id };
  const unchanged = JSON.stringify(current);
  for (const count of [0, 1, 2, 3]) {
    const uploadedImages = Array.from({ length: count }, (_, index) => `uploaded-v3-${index + 1}.png`);
    const request = buildRunningHubImageRequest(current, { prompt: '本次图像正文', uploadedImages });
    assert.equal(request.endpoint, 'https://www.runninghub.ai/openapi/v2/run/ai-app/2079381758411587586');
    assert.deepEqual(request.body, { ...IMAGE_V3_BODY, usePersonalQueue: false, nodeInfoList: IMAGE_V3_BODY.nodeInfoList.map(node =>
      node.nodeId === '107' ? { ...node, fieldValue: '本次图像正文' }
        : ['181', '182', '183'].includes(node.nodeId)
          ? { ...node, fieldValue: Number(node.nodeId) - 181 < count ? uploadedImages[Number(node.nodeId) - 181] : 'None' }
          : node.nodeId === '195' && count === 0 ? { ...node, fieldValue: 'true' } : node) });
    assert.equal(JSON.stringify(current), unchanged);
  }
});

test('V3 hand-mapped second image receives the reference and clears all unselected examples', () => {
  const imported = importRunningHubImageWorkflow(IMAGE_V3_CURL);
  imported.workflow.mapping.images = [{ nodeId: '182', inputName: 'image', role: 'character' }];
  const current: ImageApiConfig = { ...createInitialState().settings.imageApi, enabled: true, backend: 'runninghub',
    baseUrl: imported.baseUrl!, apiKey: 'LOCAL_FAKE_KEY', runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id };
  const snapshot = JSON.stringify(current);
  const fields = (input: Parameters<typeof buildRunningHubImageRequest>[1]) => buildRunningHubImageRequest(current, input).body.nodeInfoList as typeof IMAGE_V3_BODY.nodeInfoList;
  const read = (nodes: ReturnType<typeof fields>, id: string) => nodes.find(node => node.nodeId === id)!.fieldValue;
  const one = fields({ prompt: '手动第二图槽', uploadedImages: ['uploaded-second-slot.png'], sizeOverride: false });
  assert.deepEqual(['181', '182', '183'].map(id => read(one, id)), ['None', 'uploaded-second-slot.png', 'None']);
  assert.equal(read(one, '195'), 'false', 'reference generation preserves the cloud switch when no output size is overridden');
  const zero = fields({ prompt: '无参考图', uploadedImages: [], sizeOverride: false });
  assert.deepEqual(['181', '182', '183'].map(id => read(zero, id)), ['None', 'None', 'None']);
  assert.equal(read(zero, '195'), 'true', 'text-to-image requires the proportions switch even at the cloud default size');
  assert.equal(JSON.stringify(current), snapshot, 'submitted empty-slot and switch values never rewrite the saved template');
});

test('V3 legacy empty mappings recover retained request slots without expanding static templates or restoring deletions', () => {
  const imported = importRunningHubImageWorkflow(IMAGE_V3_CURL).workflow;
  const normalize = (workflow: typeof imported) => normalizeRunningHubImageConfig({ runningHubWorkflows: [workflow], activeRunningHubWorkflowId: workflow.id }).runningHubWorkflows[0];
  const legacy = { ...imported, mapping: { ...imported.mapping, images: [] } };
  const snapshot = JSON.stringify(legacy);
  assert.deepEqual(normalize(legacy).mapping.images, imported.mapping.images);
  assert.equal(JSON.stringify(legacy), snapshot, 'legacy repair must not mutate saved settings');
  assert.deepEqual(normalize({ ...legacy, remoteId: 'other-app' }).mapping.images, []);
  assert.deepEqual(normalize({ ...legacy, runKind: 'workflow' }).mapping.images, []);
  assert.deepEqual(normalize({ ...legacy, mapping: { ...legacy.mapping, prompt: [] } }).mapping.images, []);
  const manual = { ...imported, mapping: { ...imported.mapping, images: [{ nodeId: '182', inputName: 'image', role: 'character' as const }] } };
  assert.deepEqual(normalize(manual).mapping.images, manual.mapping.images, 'an existing manual selection stays authoritative');
  let deleted = imported;
  for (const binding of imported.mapping.images) deleted = removeRunningHubImageSlot(deleted, binding);
  assert.deepEqual(normalize(deleted).mapping.images, [], 'deleted request fields must not be recovered from the catalogue');
  const partial = removeRunningHubImageSlot(imported, imported.mapping.images[0]);
  partial.mapping = { ...partial.mapping, images: [] };
  assert.deepEqual(normalize(partial).mapping.images.map(binding => binding.nodeId), ['182', '183']);
  const duplicate = JSON.parse(legacy.requestTemplate); duplicate.nodeInfoList.push({ ...duplicate.nodeInfoList[0] });
  assert.deepEqual(normalize({ ...legacy, requestTemplate: JSON.stringify(duplicate) }).mapping.images, [], 'ambiguous request slots stay invalid');
});

test('explicit image-workflow backups retain hand mappings and omitted size mappings during import', () => {
  const workflow = importRunningHubImageWorkflow(IMAGE_V3_CURL).workflow;
  workflow.mapping.images = [{ nodeId: '182', inputName: 'image', role: 'character' }];
  workflow.mapping.parameters = {};
  const backup = exportRunningHubVideoWorkflow(workflow);
  const savedMapping = JSON.parse(backup).workflow.mapping;
  const restored = importRunningHubImageWorkflow(backup).workflow;
  assert.deepEqual(restored.mapping, savedMapping, 'backup mappings are explicit and must not be expanded by API auto-binding');
  assert.equal(restored.requestTemplate, workflow.requestTemplate);
  const fenced = importRunningHubImageWorkflow('```json\n' + backup + '\n```').workflow;
  assert.deepEqual(fenced.mapping, savedMapping, 'the backup marker survives fenced input as well');
  const noPrompt = { ...workflow, mapping: { ...workflow.mapping, prompt: [] } };
  assert.deepEqual(importRunningHubImageWorkflow(exportRunningHubVideoWorkflow(noPrompt)).workflow.mapping.prompt, [], 'a disabled prompt mapping must stay disabled');
});

test('text prompt auto-binding requires an explicit Prompt label and a unique candidate', () => {
  const endpoint = 'https://www.runninghub.ai/openapi/v2/run/ai-app/2079381758411587586';
  const imported = (nodeInfoList: unknown[]) => importRunningHubImageWorkflow(JSON.stringify({ endpoint, nodeInfoList })).workflow;
  assert.deepEqual(imported([{ nodeId: '107', fieldName: 'text', fieldValue: '内部文本' }]).mapping.prompt, []);
  assert.deepEqual(imported([{ nodeId: '107', fieldName: 'text', fieldValue: '内部文本', description: 'Text-to-image switch' }]).mapping.prompt, []);
  const duplicate = [...IMAGE_V3_BODY.nodeInfoList, { nodeId: '108', fieldName: 'prompt', fieldValue: '另一个正文' }];
  assert.deepEqual(imported(duplicate).mapping.prompt, []);
  const literal = imported([{ nodeId: '107', fieldName: 'text', fieldValue: 'false', description: 'Prompt' }]);
  assert.deepEqual(literal.mapping.prompt, [{ nodeId: '107', inputName: 'text' }]);
});

test('normalization preserves independent image library and null/deleted selections without fallback', () => {
  const current = config();
  assert.equal(normalizeRunningHubImageConfig(current).runningHubWorkflows.length, 1);
  assert.equal(normalizeRunningHubImageConfig({ ...current, activeRunningHubWorkflowId: null }).activeRunningHubWorkflowId, null);
  assert.equal(selectedRunningHubImageWorkflow({ ...current, activeRunningHubWorkflowId: 'deleted' }), undefined);
  assert.match(validateRunningHubImageConfig({ ...current, activeRunningHubWorkflowId: 'deleted' })!, /不会改用其他/u);
});

test('only mapped business fields change; dimensions stay at cloud defaults unless explicitly overridden', () => {
  const current = config();
  const before = JSON.stringify(current);
  const request = buildRunningHubImageRequest(current, { prompt: '中文 business prompt\nEnglish', width: 1024, height: 1024 });
  assert.equal(request.endpoint, 'https://www.runninghub.ai/openapi/v2/run/ai-app/2070152175753453569');
  assert.equal(request.queryEndpoint, 'https://www.runninghub.ai/openapi/v2/query');
  assert.equal(request.headers.Authorization, 'Bearer LOCAL_FAKE_KEY');
  assert.deepEqual(request.body, { ...body, nodeInfoList: body.nodeInfoList.map(node => node.nodeId === '115' ? { ...node, fieldValue: '中文 business prompt\nEnglish' } : node) });
  const sized = buildRunningHubImageRequest(current, { prompt: 'authored', width: 1536, height: 1024, sizeOverride: true });
  const fields = sized.body.nodeInfoList as typeof body.nodeInfoList;
  assert.equal(fields[0].fieldValue, '1536'); assert.equal(fields[1].fieldValue, 1024);
  assert.equal(JSON.stringify(current), before);
});

test('unmapped/ambiguous prompt, secrets, unsupported references and explicit unmapped sizes fail before submission', () => {
  const current = config();
  assert.match(validateRunningHubImageConfig(current, 1)!, /不会忽略已选图片/u);
  assert.match(validateRunningHubImageConfig({ ...current, apiKey: '' })!, /密钥/u);
  const workflow = importRunningHubImageWorkflow(JSON.stringify({ endpoint: 'https://www.runninghub.ai/openapi/v2/run/ai-app/123',
    nodeInfoList: [...body.nodeInfoList, { nodeId: '109', fieldName: 'system', fieldValue: 'do not rewrite' },
      { nodeId: '201', fieldName: 'prompt', fieldValue: 'ambiguous' }] }));
  assert.deepEqual(workflow.workflow.mapping.prompt, []);
  assert.equal(isRunningHubImageWorkflowReady(workflow.workflow), false);
  const missing = structuredClone(current); missing.runningHubWorkflows![0].mapping.parameters = {};
  assert.throws(() => buildRunningHubImageRequest(missing, { prompt: 'safe', width: 1024, height: 1024, sizeOverride: true }), /尚未绑定/u);
});

test('one paid submission followed by original-task polling selects image output and downloads via existing image transport', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  let starts = 0, waits = 0; const downloads: string[] = [];
  const result = await requestRunningHubImage(config(), { prompt: 'authored' }, {
    request: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body!) });
      return response(calls.length === 1 ? { taskId: 'cloud-original', status: 'QUEUED' }
        : calls.length === 2 ? { taskId: 'cloud-original', status: 'RUNNING' }
          : { taskId: 'cloud-original', status: 'SUCCESS', results: [
            { outputType: 'mp4', url: 'https://cdn.example.test/video.mp4' },
            { outputType: 'png', nodeId: '12', url: 'https://cdn.example.test/final.png' },
          ] });
    }, wait: async () => { waits += 1; }, downloadImage: async url => { downloads.push(url); return 'data:image/png;base64,QQ=='; },
  }, () => { starts += 1; });
  assert.equal(starts, 1); assert.equal(waits, 2);
  assert.equal(calls.filter(call => call.url.includes('/run/')).length, 1);
  assert.deepEqual(calls.slice(1).map(call => call.body), [{ taskId: 'cloud-original' }, { taskId: 'cloud-original' }]);
  assert.deepEqual(downloads, ['https://cdn.example.test/final.png']);
  assert.equal(result.dataUrl, 'data:image/png;base64,QQ==');
});

test('preferred output node cannot fall back to another image or a non-image output', async () => {
  const current = config(); current.runningHubWorkflows![0].outputNodeId = 'final';
  let downloaded = false;
  await assert.rejects(requestRunningHubImage(current, { prompt: 'authored' }, {
    request: async () => response({ taskId: 'original', status: 'SUCCESS', results: [{ nodeId: 'preview', outputType: 'png', url: 'https://cdn.example.test/preview.png' }] }),
    downloadImage: async () => { downloaded = true; return ''; },
  }), /所选输出节点没有/u);
  assert.equal(downloaded, false);
});

test('failed/uncertain submission and remote failures never replay POST and redact key from errors', async () => {
  for (const failure of ['network', 'auth', 'remote']) {
    let creates = 0;
    await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored' }, {
      request: async () => {
        creates += 1;
        if (failure === 'network') throw new Error('network lost Authorization=LOCAL_FAKE_KEY');
        return failure === 'auth' ? response({ errorMessage: 'Bearer LOCAL_FAKE_KEY rejected' }, 401)
          : response({ taskId: 'original', status: 'FAILED', errorMessage: 'LOCAL_FAKE_KEY error' });
      },
    }), error => error instanceof Error && !error.message.includes('LOCAL_FAKE_KEY'));
    assert.equal(creates, 1);
  }
});

test('pre-submit durability failure and reference-image rejection perform zero requests', async () => {
  let requests = 0;
  const transport = { request: async () => { requests += 1; return response({}); } };
  await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored' }, transport, async () => { throw new Error('save barrier failed'); }), /save barrier failed/u);
  await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored', referenceCount: 1 }, transport), /不会忽略已选图片/u);
  assert.equal(requests, 0);
});

test('cancellation and bounded timeout stop observation without replaying original submission', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored', signal: controller.signal }, {
    request: async () => { requests += 1; return response({ taskId: 'original', status: 'QUEUED' }); },
    wait: async () => { controller.abort(); },
  }), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(requests, 1);
  let clock = 0; requests = 0;
  await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored' }, {
    request: async () => { requests += 1; return response({ taskId: 'original', status: 'RUNNING' }); },
    now: () => clock, timeoutMs: 20, wait: async () => { clock = 21; },
  }), /等待超时/u);
  assert.equal(requests, 1);
});

test('a status-query disconnect keeps the accepted task and queries it again without another paid POST', async () => {
  const order: string[] = [];
  let queries = 0;
  const result = await requestRunningHubImage(config(), {
    prompt: 'authored',
    onRemoteTaskId: async (taskId) => { order.push(`save:${taskId}`); },
  }, {
    request: async (url) => {
      if (url.includes('/query')) {
        queries += 1;
        order.push('query');
        if (queries === 1) throw new Error('Client network socket disconnected before secure TLS connection was established（错误码：ECONNRESET；阶段：TLS 握手；接口：https://www.runninghub.ai；路由：系统代理；未取得 HTTP 响应）');
        return response({ taskId: 'cloud-original', status: 'SUCCESS', results: [{ outputType: 'png', url: 'https://cdn.example.test/final.png' }] });
      }
      order.push('post');
      return response({ taskId: 'cloud-original', status: 'QUEUED' });
    },
    wait: async () => {},
  });
  assert.deepEqual(order, ['post', 'save:cloud-original', 'query', 'query']);
  assert.equal(result.url, 'https://cdn.example.test/final.png');
});

test('an HTTP rejection of the original task query stops without another submission', async () => {
  let posts = 0;
  let queries = 0;
  await assert.rejects(requestRunningHubImage(config(), { prompt: 'authored' }, {
    request: async (url) => {
      if (url.includes('/query')) {
        queries += 1;
        return response({ message: 'rejected' }, 401);
      }
      posts += 1;
      return response({ taskId: 'cloud-original', status: 'RUNNING' });
    },
    wait: async () => {},
  }), /请求失败（HTTP 401）/u);
  assert.equal(posts, 1);
  assert.equal(queries, 1);
});

test('reload keeps an accepted RunningHub image task runnable and still stops an unaccepted one', () => {
  const initial = createInitialState();
  const fields = { name: '合成人物', assetKind: 'character' as const, imageVariant: 'reference' as const, prompt: 'kept', width: 1024, height: 1024, backend: 'runninghub' as const, model: 'Qwen' };
  const accepted = createImageGenerationTask({ id: 'accepted', ...fields, remoteTaskId: '2115846555894636546' }, 10, 'running');
  const unaccepted = createImageGenerationTask({ id: 'unaccepted', ...fields }, 11, 'running');
  const project = { ...initial.project, generationTasks: [accepted, unaccepted] };
  const restored = normalizeState(JSON.parse(serializeStateForStorage({ ...initial, project, projects: [project], activeProjectId: project.id }).serialized));
  const tasks = restored.project.generationTasks as ImageGenerationTask[];
  assert.equal(tasks.find((task) => task.id === 'accepted')?.status, 'running');
  assert.equal(tasks.find((task) => task.id === 'accepted')?.remoteTaskId, '2115846555894636546');
  assert.equal(tasks.find((task) => task.id === 'accepted')?.error, undefined);
  assert.equal(tasks.find((task) => task.id === 'unaccepted')?.status, 'failed');
  assert.match(tasks.find((task) => task.id === 'unaccepted')?.error || '', /重新生成/u);
  assert.equal(tasks.find((task) => task.id === 'unaccepted')?.remoteTaskId, undefined);
});

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z6k9WQAAAABJRU5ErkJggg==';
const imageConfig = () => {
  const current = config();
  const workflow = current.runningHubWorkflows![0];
  const template = JSON.parse(workflow.requestTemplate);
  template.nodeInfoList.push({ nodeId: '201', fieldName: 'image', fieldValue: 'keep-default-a.png' },
    { nodeId: '202', fieldName: 'image', fieldValue: 'keep-default-b.png' });
  workflow.requestTemplate = JSON.stringify(template);
  workflow.mapping.images = [{ nodeId: '201', inputName: 'image' }, { nodeId: '202', inputName: 'image' }];
  return current;
};

test('image-to-image uploads each selected file once and binds returned fileName, retaining unused slots and cloud settings', async () => {
  for (const count of [1, 2]) {
    const current = imageConfig(); let uploads = 0, creates = 0, starts = 0;
    await requestRunningHubImage(current, { prompt: 'authored', referenceImages: Array(count).fill(image), referenceCount: count }, {
      request: async (url, init) => {
        if (url.endsWith('/media/upload/binary')) {
          uploads += 1;
          assert.equal(init.headers.Authorization, 'Bearer LOCAL_FAKE_KEY');
          assert.equal(init.headers['Content-Type'], undefined, 'multipart transport supplies its own boundary');
          assert.equal(init.multipart!.files.length, 1);
          assert.equal(init.multipart!.files[0].name, 'file');
          assert.equal(init.multipart!.files[0].dataUrl, image);
          return response({ code: 0, data: { fileName: `uploaded-${uploads}.png`, download_url: `https://cdn.example.test/uploaded-${uploads}.png` } });
        }
        creates += 1;
        const sent = JSON.parse(init.body!);
        assert.equal(sent.instanceType, 'default'); assert.equal(sent.usePersonalQueue, false);
        assert.deepEqual(sent.nodeInfoList.slice(0, 2), body.nodeInfoList.slice(0, 2));
        assert.equal(sent.nodeInfoList[3].fieldValue, 'uploaded-1.png');
        assert.equal(sent.nodeInfoList[4].fieldValue, count === 2 ? 'uploaded-2.png' : 'keep-default-b.png');
        return response({ taskId: 'image-task', status: 'SUCCESS', results: [{ outputType: 'png', url: 'https://cdn.example.test/final.png' }] });
      },
    }, () => { starts += 1; });
    assert.equal(uploads, count); assert.equal(creates, 1); assert.equal(starts, 1);
  }
});

test('upload failure or over-capacity references never start a paid image task', async () => {
  let calls = 0, starts = 0;
  const current = imageConfig();
  const transport = { request: async () => { calls += 1; return response({ code: 401, message: 'invalid LOCAL_FAKE_KEY' }); } };
  await assert.rejects(requestRunningHubImage(current, { prompt: 'authored', referenceImages: [image] }, transport, () => { starts += 1; }), /请求失败/u);
  assert.equal(calls, 1); assert.equal(starts, 0);
  calls = 0;
  await assert.rejects(requestRunningHubImage(current, { prompt: 'authored', referenceImages: [image, image, image] }, transport), /不能接收 3 张/u);
  assert.equal(calls, 0);
});

test('llm dispatch routes RunningHub image generation through existing serial HTTP/download transport', async () => {
  const previous = globalThis.window;
  let requests = 0, downloads = 0, starts = 0;
  Object.assign(globalThis, { window: { lianhuaDesktop: {
    request: async (payload: any) => {
      requests += 1;
      assert.match(payload.url, /\/run\/ai-app\/2070152175753453569$/u);
      assert.equal(JSON.parse(payload.body).nodeInfoList[2].fieldValue, 'verbatim Chinese 中文');
      return response({ taskId: 'llm-image-task', status: 'SUCCESS', results: [{ outputType: 'png', url: 'https://cdn.example.test/final.png' }] });
    }, downloadImage: async () => { downloads += 1; return image; },
  } } });
  try {
    const result = await requestImageModel(config(), { prompt: 'verbatim Chinese 中文', promptMode: 'verbatim' }, () => { starts += 1; });
    assert.equal(result.dataUrl, image); assert.equal(requests, 1); assert.equal(downloads, 1); assert.equal(starts, 1);
  } finally { if (previous === undefined) delete (globalThis as any).window; else Object.assign(globalThis, { window: previous }); }
});

test('save/reload retains image workflow, profile and request options while keeping video library independent', () => {
  const state = createInitialState(); const current = config();
  state.settings.imageApi = current;
  state.settings.imageApiProfiles = [{ ...structuredClone(current), id: 'image-rh-profile', name: 'RH profile', createdAt: 1, updatedAt: 1 }];
  state.settings.activeImageApiProfileId = 'image-rh-profile';
  state.settings.runningHubVideo = normalizeRunningHubVideoConfig({ enabled: false, baseUrl: 'https://www.runninghub.ai', apiKey: 'VIDEO_FAKE',
    workflows: [{ ...structuredClone(current.runningHubWorkflows![0]), id: 'video-independent', name: 'Independent video' }], activeWorkflowId: null });
  const videoBefore = structuredClone(state.settings.runningHubVideo);
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(reloaded.settings.imageApi.backend, 'runninghub');
  assert.equal(reloaded.settings.imageApi.activeRunningHubWorkflowId, current.activeRunningHubWorkflowId);
  assert.deepEqual(reloaded.settings.imageApi.runningHubWorkflows, normalizeRunningHubImageConfig(current).runningHubWorkflows);
  assert.equal(reloaded.settings.imageApiProfiles[0].backend, 'runninghub');
  assert.equal(reloaded.settings.imageApiProfiles[0].activeRunningHubWorkflowId, current.activeRunningHubWorkflowId);
  assert.deepEqual(reloaded.settings.runningHubVideo, videoBefore);
  assert.deepEqual(normalizeRunningHubImageConfig({ ...current, runningHubWorkflows: [] }), { runningHubWorkflows: [], activeRunningHubWorkflowId: null });
});

test('regeneration snapshots retain RunningHub identity and refuse later workflow edits or profile deletion', async () => {
  const state = createInitialState(); const current = config(); state.settings.imageApi = current;
  const snapshot = await captureImageApiSnapshot(current, null);
  assert.equal(snapshot.config.backend, 'runninghub');
  assert.deepEqual((await resolveImageApiForRegeneration(state.settings, snapshot)).runningHubWorkflows, current.runningHubWorkflows);
  const changed = structuredClone(state.settings);
  changed.imageApi.runningHubWorkflows![0].requestTemplate = JSON.stringify({ ...body, instanceType: 'plus' });
  await assert.rejects(resolveImageApiForRegeneration(changed, snapshot), /工作流已改变/u);
  const profileSnapshot = await captureImageApiSnapshot(current, 'deleted-profile');
  await assert.rejects(resolveImageApiForRegeneration(state.settings, profileSnapshot), /配置已删除/u);
});
