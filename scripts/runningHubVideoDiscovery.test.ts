import assert from 'node:assert/strict';
import { discoverRunningHubVideoNodes, RUNNING_HUB_VIDEO_DISCOVERY_TIMEOUT_MS } from '../src/services/runningHubVideoDiscovery';

type BridgePayload = { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string; redirect: string; responseType: string };
type BridgeResult = { status: number; body: string };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
const originalTimer = globalThis.setTimeout;
const secret = 'discovery-only-fixture-key-never-persist';
const identity = { baseUrl: 'https://www.runninghub.ai', apiKey: secret, runKind: 'workflow' as const, remoteId: '2093983063180054529' };
const graph = {
  '24': { class_type: 'CLIPTextEncode', inputs: { text: 'a quiet market', clip: ['25', 0] }, _meta: { title: '正向提示词' } },
  '25': { class_type: 'LoadImage', inputs: { image: 'source.png' } },
};
const response = (data: unknown): BridgeResult => ({ status: 200, body: JSON.stringify({ code: 0, msg: 'SUCCESS', data }) });
const workflowResponse = () => response({ prompt: JSON.stringify(graph) });
let groups = 0;
const check = async (name: string, run: () => Promise<void>) => { await run(); groups += 1; console.log(`PASS ${name}`); };
const desktop = (request: (payload: BridgePayload) => Promise<BridgeResult>, cancelModelRequest?: (id: string) => Promise<boolean>) => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: { request, cancelModelRequest } } });
};
const browser = () => { Object.defineProperty(globalThis, 'window', { configurable: true, value: {} }); };
const rejectsSafely = async (pending: Promise<unknown>, expected: RegExp) => {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.ok(!error.message.includes(secret), 'never show connection key in errors');
    assert.ok(!error.message.includes('raw-secret-echo'), 'never show cloud/raw transport messages');
    return true;
  });
};

try {
  await check('workflow uses only documented read endpoint, exact string ID, redirect rejection and dual authentication', async () => {
    const calls: BridgePayload[] = [];
    desktop(async (payload) => { calls.push(payload); return workflowResponse(); });
    const result = await discoverRunningHubVideoNodes(identity);
    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.equal(request.url, 'https://www.runninghub.ai/api/openapi/getJsonApiFormat');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body!), { apiKey: secret, workflowId: '2093983063180054529' });
    assert.equal(request.headers.Authorization, `Bearer ${secret}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.responseType, 'text');
    assert.match(request.requestId, /^runninghub-discovery-/u);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.nodes[0].nodeId, '24');
    assert.equal(result.nodes[0].fieldName, 'text');
    assert.equal(result.nodes[1].fieldValue, 'source.png');
    assert.ok(!JSON.stringify(result).includes(secret));
  });

  await check('AI app uses documented GET demo endpoint, never workflow endpoint or returned run cURL', async () => {
    const calls: BridgePayload[] = [];
    desktop(async (payload) => {
      calls.push(payload);
      return response({ curl: "curl -X POST 'https://elsewhere.invalid/openapi/v2/run/ai-app/123'", accessEncrypted: false,
        nodeInfoList: [{ nodeId: '39', nodeName: 'LoadImage', fieldName: 'image', fieldValue: 'demo.png', fieldType: 'IMAGE', description: '上传图像' }] });
    });
    const result = await discoverRunningHubVideoNodes({ ...identity, runKind: 'ai-app', baseUrl: 'https://www.runninghub.cn' });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin, 'https://www.runninghub.cn');
    assert.equal(url.pathname, '/api/webapp/apiCallDemo');
    assert.equal(url.searchParams.get('webappId'), identity.remoteId);
    assert.equal(url.searchParams.get('apiKey'), secret);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
    assert.equal(result.nodes[0].description, '上传图像');
    assert.ok(!JSON.stringify(result).includes('curl'));
  });

  await check('browser workflow and AI app preserve configured prefix without cookies, cache, referrer or redirect', async () => {
    browser();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(workflowResponse().body, { status: 200 }); };
    await discoverRunningHubVideoNodes({ ...identity, baseUrl: 'https://configured.example/proxy/' });
    assert.equal(calls[0].url, 'https://configured.example/proxy/api/openapi/getJsonApiFormat');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[0].init?.credentials, 'omit');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(calls[0].init?.referrerPolicy, 'no-referrer');
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(response({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: 'a' }] }).body, { status: 200 }); };
    await discoverRunningHubVideoNodes({ ...identity, runKind: 'ai-app' });
    assert.equal(calls[1].init?.method, 'GET');
    assert.equal(calls[1].init?.body, undefined);
    assert.equal(new URL(calls[1].url).pathname, '/api/webapp/apiCallDemo');
  });

  await check('invalid identity fails before any request', async () => {
    let calls = 0;
    desktop(async () => { calls += 1; return workflowResponse(); });
    for (const baseUrl of ['not-a-url', 'file:///C:/data', 'https://user:password@runninghub.ai', 'https://www.runninghub.ai?x=1', 'https://www.runninghub.ai/#token']) {
      await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, baseUrl }), /地址/u);
    }
    for (const remoteId of ['', '123abc', '2093983063180054500e0', '/run/workflow/1']) {
      await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, remoteId }), /ID/u);
    }
    await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, apiKey: '' }), /密钥/u);
    await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, apiKey: 'a\nb' }), /密钥/u);
    await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, runKind: 'unknown' as 'workflow' }), /类型/u);
    assert.equal(calls, 0);
  });

  await check('aborted-before-start does not contact cloud or cancel unrelated work', async () => {
    let calls = 0; let cancellations = 0;
    desktop(async () => { calls += 1; return workflowResponse(); }, async () => { cancellations += 1; return true; });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(discoverRunningHubVideoNodes(identity, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 0); assert.equal(cancellations, 0);
  });

  await check('desktop cancellation unlocks even when request and cancellation never resolve; late result is ignored', async () => {
    const calls: BridgePayload[] = []; const cancelled: string[] = [];
    let lateResult: ((value: BridgeResult) => void) | undefined;
    desktop((payload) => { calls.push(payload); return new Promise((resolve) => { lateResult = resolve; }); }, (id) => { cancelled.push(id); return new Promise(() => undefined); });
    const controller = new AbortController();
    const pending = discoverRunningHubVideoNodes(identity, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(cancelled, [calls[0].requestId]);
    lateResult?.(workflowResponse());
    await Promise.resolve();
    assert.equal(calls.length, 1);
  });

  await check('local timeout unlocks old unresponsive bridge and cancels exactly its request ID', async () => {
    const calls: BridgePayload[] = []; const cancelled: string[] = [];
    desktop((payload) => { calls.push(payload); return new Promise(() => undefined); }, async (id) => { cancelled.push(id); return true; });
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => originalTimer(callback, delay === RUNNING_HUB_VIDEO_DISCOVERY_TIMEOUT_MS ? 0 : delay, ...args)) as typeof globalThis.setTimeout;
    try { await rejectsSafely(discoverRunningHubVideoNodes(identity), /超时/u); }
    finally { globalThis.setTimeout = originalTimer; }
    assert.deepEqual(cancelled, [calls[0].requestId]);
    assert.equal(calls.length, 1);
  });

  await check('browser cancellation settles even with a fetch ignoring its signal', async () => {
    browser();
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => { receivedSignal = init?.signal; return new Promise(() => undefined); };
    const controller = new AbortController();
    const pending = discoverRunningHubVideoNodes(identity, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(receivedSignal?.aborted, true);
  });

  await check('raw network errors and remote errors are redacted, no host fallback or retries', async () => {
    let calls = 0;
    desktop(async () => { calls += 1; throw new Error(`raw-secret-echo ${secret}`); });
    await rejectsSafely(discoverRunningHubVideoNodes(identity), /读取云端节点失败/u);
    assert.equal(calls, 1);
    for (const status of [301, 307, 401, 403, 404, 500]) {
      desktop(async () => { calls += 1; return { status, body: `raw-secret-echo ${secret}` }; });
      await rejectsSafely(discoverRunningHubVideoNodes(identity), /读取节点|拒绝读取/u);
    }
    desktop(async () => ({ status: 200, body: JSON.stringify({ code: 999, msg: `raw-secret-echo ${secret}`, data: null }) }));
    await rejectsSafely(discoverRunningHubVideoNodes(identity), /未提供节点资料/u);
    assert.equal(calls, 7);
  });

  await check('malformed, non-JSON, wrong-envelope and unexposed fields fail descriptively', async () => {
    for (const body of ['<html>raw-secret-echo</html>', '{}', '{"code":0,"data":null}', '{"code":0,"data":{}}', workflowResponse().body.replace('"code":0', '"code":"FAIL"')]) {
      desktop(async () => ({ status: 200, body }));
      await rejectsSafely(discoverRunningHubVideoNodes(identity), /JSON|未提供|未公开/u);
    }
    desktop(async () => response({ accessEncrypted: true, nodeInfoList: [] }));
    await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, runKind: 'ai-app' }), /没有可编辑/u);
    desktop(async () => response({ prompt: '{"nodes":[]}' }));
    await rejectsSafely(discoverRunningHubVideoNodes(identity), /无法识别|没有可编辑/u);
    desktop(async () => ({ status: 200, body: ' '.repeat(8 * 1024 * 1024 + 1) }));
    await rejectsSafely(discoverRunningHubVideoNodes(identity), /过大/u);
  });

  await check('original JSON reaches parser with long numeric IDs and seed tokens intact', async () => {
    desktop(async () => ({ status: 200, body: '{"code":0,"data":{"nodeInfoList":[{"nodeId":2093983063180054529,"fieldName":"seed","fieldValue":9007199254740993}]}}' }));
    const result = await discoverRunningHubVideoNodes({ ...identity, runKind: 'ai-app' });
    assert.equal(result.nodes[0].nodeId, '2093983063180054529');
    assert.equal(result.nodes[0].fieldValue, '9007199254740993');
    assert.ok(result.warnings.length > 0);
  });

  await check('connection key echoed under arbitrary text or description cannot enter saved catalog', async () => {
    for (const node of [
      { nodeId: '1', fieldName: 'text', fieldValue: secret },
      { nodeId: '1', fieldName: 'text', fieldValue: 'okay', description: `raw-secret-echo ${secret}` },
    ]) {
      desktop(async () => response({ nodeInfoList: [node] }));
      await rejectsSafely(discoverRunningHubVideoNodes({ ...identity, runKind: 'ai-app' }), /包含当前连接密钥/u);
    }
  });

  await check('parallel discoveries use distinct cancellation identities', async () => {
    const calls: BridgePayload[] = [];
    desktop(async (payload) => { calls.push(payload); return workflowResponse(); });
    await Promise.all([discoverRunningHubVideoNodes(identity), discoverRunningHubVideoNodes(identity)]);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].requestId, calls[1].requestId);
    assert.ok(calls.every((item) => new URL(item.url).pathname === '/api/openapi/getJsonApiFormat'));
  });
  console.log(`PASS RunningHub node discovery: ${groups} groups, no live API requests`);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimer;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
