const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { isIP } = require('node:net');

const MODEL_CONNECT_TIMEOUT_MS = 30_000;
const abortError = () => Object.assign(new Error('网络请求已取消'), { name: 'AbortError', code: 'ABORT_ERR' });

const resolveSystemProxy = async (url, { resolveProxy, signal, timeoutMs = MODEL_CONNECT_TIMEOUT_MS, noTimeout = false } = {}) => {
  if (signal?.aborted) throw abortError();
  if (typeof resolveProxy !== 'function') return null;
  const route = await new Promise((resolve, reject) => {
    const onAbort = () => finish(abortError());
    let settled = false;
    const timer = noTimeout ? undefined : setTimeout(() => finish(Object.assign(new Error('读取系统代理超时'), { code: 'ETIMEDOUT' })), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => resolveProxy(url)).then(
      (value) => finish(null, value),
      (error) => finish(Object.assign(new Error('读取系统代理失败，请检查系统代理设置'), { code: error?.code || 'PROXY_RESOLUTION_FAILED' })),
    );
  });
  const first = String(route || '').split(';')[0].trim();
  if (first.toUpperCase() === 'DIRECT') return null;
  const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/iu.exec(first);
  if (!match) throw new Error('不支持当前系统代理类型，请在代理客户端启用 HTTP/HTTPS 或混合代理端口');
  let proxy;
  try { proxy = new URL(`${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`); }
  catch { throw new Error('系统代理地址格式无效'); }
  if (!proxy.hostname || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('系统代理地址格式无效');
  }
  return proxy.toString();
};

/** The system proxy is trusted routing configuration, but the origin is not:
 * CONNECT uses the previously validated numeric IP. Host and TLS SNI still
 * identify the original origin. No API headers/body are sent in CONNECT. */
const createProxyTunnelAgent = (target, { proxyUrl, signal, connectTimeoutMs = MODEL_CONNECT_TIMEOUT_MS, noTimeout = false } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const origin = new URL(target.url);
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(proxy.protocol) || !isIP(target.address)) {
    reject(new Error('代理请求必须使用已校验的 HTTP(S) 目标地址'));
    return;
  }
  const authority = `${isIP(target.address) === 6 ? `[${target.address}]` : target.address}:${origin.port || (origin.protocol === 'https:' ? '443' : '80')}`;
  const transport = proxy.protocol === 'https:' ? https : http;
  let request;
  let completed = false;
  const onAbort = () => finish(abortError());
  const timer = noTimeout ? undefined : setTimeout(() => finish(Object.assign(new Error(`系统代理连接超时（${Math.max(1, Math.round(connectTimeoutMs / 1000))} 秒）`), { code: 'ETIMEDOUT' })), connectTimeoutMs);
  const finish = (error, agent) => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (error) { request?.destroy(); reject(error); } else resolve(agent);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    request = transport.request({
      hostname: proxy.hostname.replace(/^\[|\]$/gu, ''),
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: authority, headers: { Host: authority }, agent: false,
      ...(proxy.protocol === 'https:' && !isIP(proxy.hostname) ? { servername: proxy.hostname } : {}),
    });
    request.once('error', (error) => {
      const code = /^[A-Z0-9_]{1,80}$/u.test(String(error?.code || '')) ? String(error.code) : 'NETWORK_ERROR';
      finish(Object.assign(new Error(`系统代理连接失败：${code}`), { code }));
    });
    request.once('connect', (response, socket, head) => {
      if (completed) { socket.destroy(); return; }
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`系统代理隧道建立失败（HTTP ${response.statusCode || 0}），请检查代理连接或认证设置`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = origin.protocol === 'https:';
      const agent = secure ? new https.Agent({ keepAlive: false, maxSockets: 1 }) : new http.Agent({ keepAlive: false, maxSockets: 1 });
      let used = false;
      agent.createConnection = (options) => {
        if (used) throw new Error('代理隧道不能重放请求');
        used = true;
        if (!secure) return socket;
        const hostname = origin.hostname.replace(/^\[|\]$/gu, '');
        return tls.connect({ ...options, socket, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true });
      };
      const destroy = agent.destroy.bind(agent);
      agent.destroy = () => { socket.destroy(); destroy(); };
      // Prevent unhandled tunnel errors between CONNECT and agent attachment.
      socket.on('error', () => {});
      finish(null, agent);
    });
    request.once('response', (response) => {
      response.destroy();
      finish(new Error(`系统代理拒绝建立隧道（HTTP ${response.statusCode || 0}）`));
    });
    request.end();
  } catch (error) {
    finish(error);
  }
});

module.exports = { resolveSystemProxy, createProxyTunnelAgent, MODEL_CONNECT_TIMEOUT_MS };
