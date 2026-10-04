import { parseRunningHubVideoNodes, type RunningHubVideoNodesResult } from '../runningHubVideoNodes';

export interface RunningHubVideoDiscoveryIdentity {
  baseUrl: string;
  apiKey: string;
  runKind: 'workflow' | 'ai-app';
  remoteId: string;
}

interface DiscoveryResponse { status: number; body: string }
interface DiscoveryBridge {
  request?: (payload: unknown) => Promise<DiscoveryResponse>;
  cancelModelRequest?: (requestId: string) => Promise<boolean>;
}

export const RUNNING_HUB_VIDEO_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARACTERS = 8 * 1024 * 1024;
let sequence = 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const abortError = (): Error => Object.assign(new Error('已取消读取云端节点。'), { name: 'AbortError' });
const safeError = (message: string): Error => Object.assign(new Error(message), { name: 'RunningHubDiscoveryError' });

/**
 * Read-only endpoints, verified against official documentation (not generation APIs):
 * https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014
 * POST /api/openapi/getJsonApiFormat -> {code:0,data:{prompt: JSON-string}}
 * https://www.runninghub.cn/runninghub-api-doc-cn/api-425749011
 * GET /api/webapp/apiCallDemo -> {code:0,data:{nodeInfoList:[...]}}
 * The latter officially requires apiKey + webappId query parameters. Never log its URL.
 * Use only the configured host, never follow redirects or execute the returned cURL.
 */
export async function discoverRunningHubVideoNodes(
  identity: RunningHubVideoDiscoveryIdentity,
  signal?: AbortSignal,
): Promise<RunningHubVideoNodesResult> {
  if (signal?.aborted) throw abortError();
  let base: URL;
  try { base = new URL(identity.baseUrl.trim()); }
  catch { throw safeError('请先填写有效的 RunningHub 云端 API 地址。'); }
  if (!/^https?:$/u.test(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw safeError('RunningHub 地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) 基础地址。');
  }
  const apiKey = identity.apiKey.trim();
  if (!apiKey || /[\r\n]/u.test(apiKey)) throw safeError('请先在 RunningHub 连接设置中填写有效 API 密钥。');
  const remoteId = identity.remoteId.trim();
  if (!/^\d+$/u.test(remoteId)) throw safeError('请先填写完整的云端工作流 / AI 应用 ID（数字文本）。');
  if (identity.runKind !== 'workflow' && identity.runKind !== 'ai-app') throw safeError('请选择工作流或 AI 应用类型后再读取节点。');

  const prefix = base.toString().replace(/\/+$/u, '');
  const isWorkflow = identity.runKind === 'workflow';
  const url = new URL(`${prefix}${isWorkflow ? '/api/openapi/getJsonApiFormat' : '/api/webapp/apiCallDemo'}`);
  if (!isWorkflow) { url.searchParams.set('apiKey', apiKey); url.searchParams.set('webappId', remoteId); }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const body = isWorkflow ? JSON.stringify({ apiKey, workflowId: remoteId }) : undefined;
  if (isWorkflow) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const desktop = typeof window !== 'undefined' ? (window as Window & { lianhuaDesktop?: DiscoveryBridge }).lianhuaDesktop : undefined;
  const requestId = `runninghub-discovery-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++sequence}`}`;

  // Race both the bridge and fetch against local cancellation: old desktop bridges
  // may never settle their Promise, but the manager must still unlock immediately.
  const response = await new Promise<DiscoveryResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const cancelTransport = () => {
      controller.abort();
      try { void desktop?.cancelModelRequest?.(requestId).catch(() => undefined); } catch { /* Local settlement is independent. */ }
    };
    const onAbort = () => {
      finish(() => { cancelTransport(); reject(abortError()); });
    };
    const timer = setTimeout(() => finish(() => {
      cancelTransport();
      reject(safeError('读取云端节点超时，请检查连接后重试；没有提交生成任务。'));
    }), RUNNING_HUB_VIDEO_DISCOVERY_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const perform = async (): Promise<DiscoveryResponse> => {
      if (desktop?.request) return desktop.request({ requestId, url: url.toString(), method: isWorkflow ? 'POST' : 'GET', headers, body, redirect: 'error', responseType: 'text' });
      const fetched = await fetch(url.toString(), {
        method: isWorkflow ? 'POST' : 'GET', headers, body, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      return { status: fetched.status, body: await fetched.text() };
    };
    void perform().then(
      (result) => finish(() => resolve(result)),
      // Do not propagate transport messages: they may include the key-bearing URL
      // or a remote echo of the request body.
      () => finish(() => reject(safeError('读取云端节点失败，请检查网络、API 地址及密钥；重定向不会自动跟随。没有提交生成任务。'))),
    );
  });
  if (signal?.aborted) throw abortError();
  if (response.status === 401 || response.status === 403) throw safeError('RunningHub 拒绝读取节点（无访问权限或密钥无效）。请确认此账号可访问该工作流，或导入真实 API 节点 JSON。');
  if (response.status < 200 || response.status >= 300) throw safeError(`RunningHub 读取节点失败（HTTP ${Number.isSafeInteger(response.status) ? response.status : '异常'}）。没有提交生成任务，请稍后重试或导入真实 API 节点 JSON。`);
  if (typeof response.body !== 'string' || response.body.length > MAX_RESPONSE_CHARACTERS) throw safeError('云端节点响应为空或过大，请改为导入真实 API 节点 JSON。');
  let envelope: unknown;
  try { envelope = JSON.parse(response.body); }
  catch { throw safeError('RunningHub 节点接口未返回有效 JSON，请检查 API 基础地址或改为导入节点 JSON。'); }
  if (!record(envelope) || (envelope.code !== 0 && envelope.code !== '0') || !record(envelope.data)) {
    throw safeError('RunningHub 未提供节点资料，请确认云端 ID、接口类型和访问权限；可改为导入真实 API 节点 JSON。没有提交生成任务。');
  }
  if (isWorkflow ? typeof envelope.data.prompt !== 'string' && !record(envelope.data.prompt) : !Array.isArray(envelope.data.nodeInfoList)) {
    throw safeError('云端未公开可读取的参数节点，可能是权限或加密限制。请导入有权限访问的 API 节点 JSON，或手动填写已知节点与字段。');
  }
  // Pass original JSON text to preserve 64-bit IDs / seeds without JS-number rounding.
  // Parser errors/warnings are local; still redact the connection key defensively.
  try {
    const result = parseRunningHubVideoNodes(response.body);
    if (!result.nodes.length) throw safeError('云端资料没有可编辑的参数节点；请导入真实 API 节点 JSON，或手动填写已知节点与字段。');
    const serialized = JSON.stringify(result);
    if (serialized.includes(apiKey)) throw safeError('云端节点资料包含当前连接密钥，已停止导入以免将密钥保存到工作流；请使用已脱敏的节点 JSON。');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'RunningHubDiscoveryError') throw error;
    throw safeError('云端节点资料无法识别。请导入 ComfyUI API 格式的节点图，或手动填写已知节点与字段；普通画布 JSON 不能据此猜测参数。');
  }
}
