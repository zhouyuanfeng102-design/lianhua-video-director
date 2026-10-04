const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { decodeReferenceImageDataUrl } = require('./imageReferenceTransport.cjs');

const abortError = () => Object.assign(new Error('视频请求已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
const validId = (value) => {
  const id = String(value || '').trim();
  if (!id || id.length > 200 || /[\r\n\u0000]/u.test(id)) throw new Error('视频请求标识无效');
  return id;
};

const videoRequestOptions = (payload, signal) => {
  const method = String(payload.method || 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error('不支持的视频接口请求方法');
  if (payload.body != null && typeof payload.body !== 'string') throw new Error('视频接口正文必须是字符串');
  if (payload.body != null && payload.multipart != null) throw new Error('视频接口不能同时发送 JSON 和文件表单');
  if (['GET', 'HEAD'].includes(method) && (payload.body != null || payload.multipart != null)) throw new Error('GET/HEAD 视频接口不能发送正文');
  const headers = { ...(payload.headers || {}) };
  let body = payload.body;
  if (body && Buffer.byteLength(body, 'utf8') > 128 * 1024 * 1024) throw new Error('视频接口请求数据超过 128 MB 传输上限');
  if (payload.multipart != null) {
    const fields = Array.isArray(payload.multipart.fields) ? payload.multipart.fields : Object.entries(payload.multipart.fields || {}).map(([name, value]) => ({ name, value }));
    const files = payload.multipart.files;
    if (!Array.isArray(files) || !files.length) throw new Error('视频素材上传缺少图片');
    const boundary = `----lianhua-video-${randomBytes(18).toString('hex')}`;
    const chunks = [];
    let total = 0;
    const append = (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
      total += chunk.length;
      if (total > 128 * 1024 * 1024) throw new Error('视频素材上传超过 128 MB 传输上限');
      chunks.push(chunk);
    };
    const fieldName = (name) => {
      if (!/^[A-Za-z0-9_[\].-]{1,64}$/u.test(String(name || ''))) throw new Error('视频素材上传字段名无效');
      return String(name);
    };
    for (const field of fields) {
      append(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName(field.name)}"\r\n\r\n${String(field.value ?? '')}\r\n`);
    }
    for (const [index, file] of files.entries()) {
      const decoded = decodeReferenceImageDataUrl(file.dataUrl);
      const requested = path.basename(String(file.fileName || `reference-${index + 1}`)).replace(/[\r\n"\\/]/gu, '_').slice(0, 160);
      const name = `${path.basename(requested, path.extname(requested)) || 'reference'}${decoded.extension}`;
      append(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName(file.fieldName || file.name)}"; filename="${name}"\r\nContent-Type: ${decoded.mimeType}\r\n\r\n`);
      append(decoded.bytes);
      append('\r\n');
    }
    append(`--${boundary}--\r\n`);
    body = Buffer.concat(chunks);
    for (const name of Object.keys(headers)) if (['content-type', 'content-length'].includes(name.toLowerCase())) delete headers[name];
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    headers['Content-Length'] = String(body.length);
  }
  return { method, headers, body, signal, noTimeout: true };
};

const createVideoTransport = ({
  fetchWithLimit, encodeResponse, downloadIntoAssetStore, assertRemoteResolution,
  isPrivateIpAddress, resolveProxy, resolveSystemProxy, createProxyTunnelAgent,
  WebSocketClass,
}) => {
  const requests = new Map();
  const watches = new Map();
  const send = (owner, payload) => {
    if (!owner?.isDestroyed?.()) owner?.send?.('lianhua:video-progress', payload);
  };
  const run = async (requestId, owner, action) => {
    const id = validId(requestId);
    if (requests.has(id)) throw new Error('相同的视频请求仍在运行，请勿重复提交');
    const controller = new AbortController();
    const onDestroyed = () => controller.abort();
    owner?.once?.('destroyed', onDestroyed);
    requests.set(id, { owner, controller });
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (controller.signal.aborted) throw abortError(); return action(controller.signal); }),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(abortError());
          controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      requests.delete(id);
      owner?.removeListener?.('destroyed', onDestroyed);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
  const stopWatch = (watchId, owner) => {
    const entry = watches.get(watchId);
    if (!entry || (owner && entry.owner !== owner)) return false;
    entry.stopped = true;
    clearTimeout(entry.retryTimer);
    entry.controller?.abort();
    entry.socket?.terminate();
    entry.agent?.destroy();
    entry.owner?.removeListener?.('destroyed', entry.onDestroyed);
    watches.delete(watchId);
    return true;
  };
  return {
    request(payload, owner) {
      return run(payload?.requestId, owner, async (signal) => {
        if (typeof payload.url !== 'string') throw new Error('视频接口地址为空');
        const fetched = await fetchWithLimit(payload.url, videoRequestOptions(payload, signal));
        const contentType = fetched.response.headers.get('content-type') || '';
        const responseType = payload.responseType === 'auto'
          ? (/^(?:text\/|application\/(?:json|[\w.+-]*\+json))/iu.test(contentType) ? 'text' : 'base64')
          : payload.responseType || 'text';
        return { status: fetched.response.status, ...encodeResponse(fetched.bytes, responseType, contentType) };
      });
    },
    cancel(requestId, owner) {
      const entry = requests.get(String(requestId));
      if (!entry || (owner && entry.owner !== owner)) return false;
      entry.controller.abort();
      return true;
    },
    download(payload, owner) {
      return run(payload?.requestId || `download-${randomBytes(12).toString('hex')}`, owner, (signal) => downloadIntoAssetStore(payload.url, payload.headers || {}, {
        noTimeout: true, signal, fileName: payload.fileName,
        allowVideoArchive: payload.allowVideoArchive === true, archiveHint: payload.archiveHint === true,
        onProgress: (data) => send(owner, { watchId: payload.requestId, type: 'message', data: { type: 'download_progress', data } }),
      }));
    },
    async watch(payload, owner) {
      const watchId = validId(payload?.watchId);
      const parsed = new URL(String(payload?.url || ''));
      if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('ComfyUI 进度地址必须是 ws(s) 且不能包含用户名或密码');
      const oldEntry = watches.get(watchId);
      if (oldEntry && oldEntry.owner !== owner) throw new Error('视频进度订阅标识已被使用');
      if (oldEntry) stopWatch(watchId, owner);
      // Reserve before the first await so cancellation, replacement and owner
      // destruction can invalidate this registration while DNS is pending.
      const entry = {
        owner, stopped: false, attempts: 0, controller: new AbortController(),
        onDestroyed: () => { if (watches.get(watchId) === entry) stopWatch(watchId, owner); },
      };
      watches.set(watchId, entry);
      owner?.once?.('destroyed', entry.onDestroyed);
      const active = () => {
        if (entry.stopped || watches.get(watchId) !== entry) return false;
        if (owner?.isDestroyed?.()) { stopWatch(watchId, owner); return false; }
        return true;
      };
      if (!active()) return;
      // Registration alone grants no network access: the HTTP(S) equivalent
      // must still pass private-network consent and DNS validation before use.
      const httpUrl = new URL(parsed);
      httpUrl.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      const registrationSignal = entry.controller.signal;
      let onRegistrationStopped;
      try {
        await Promise.race([
          Promise.resolve().then(() => active() ? assertRemoteResolution(httpUrl.toString()) : undefined),
          new Promise((resolve) => {
            onRegistrationStopped = resolve;
            registrationSignal.addEventListener('abort', onRegistrationStopped, { once: true });
          }),
        ]);
      } catch (error) {
        // A stale registration must neither remove a newer same-ID watch nor
        // report an obsolete resolution failure to its caller.
        if (!active()) return;
        stopWatch(watchId, owner);
        throw error;
      } finally {
        registrationSignal.removeEventListener('abort', onRegistrationStopped);
      }
      if (!active()) return;
      const connect = async () => {
        if (!active()) return;
        entry.controller = new AbortController();
        let reconnectScheduled = false;
        const retry = () => {
          if (!active() || reconnectScheduled) return;
          reconnectScheduled = true;
          entry.agent?.destroy();
          entry.agent = undefined;
          send(owner, { watchId, type: 'disconnected', message: '进度连接中断，正在恢复；原生成任务继续运行' });
          const delay = Math.min(15_000, 1000 * (2 ** Math.min(entry.attempts++, 4)));
          entry.retryTimer = setTimeout(() => { void connect(); }, delay);
          entry.retryTimer.unref?.();
        };
        try {
          const target = await assertRemoteResolution(httpUrl.toString());
          if (!active()) return;
          const proxyUrl = await resolveSystemProxy(target.url, {
            resolveProxy: !isPrivateIpAddress(target.address) ? resolveProxy : undefined,
            signal: entry.controller.signal, noTimeout: true,
          });
          if (!active()) return;
          if (proxyUrl) entry.agent = await createProxyTunnelAgent(target, { proxyUrl, signal: entry.controller.signal, noTimeout: true });
          if (!active()) { entry.agent?.destroy(); return; }
          const WebSocket = WebSocketClass || require('ws');
          const headers = { ...(payload.headers || {}) };
          for (const name of Object.keys(headers)) if (['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(name.toLowerCase())) delete headers[name];
          const socket = new WebSocket(parsed.toString(), {
            headers, agent: entry.agent || false, followRedirects: false,
            perMessageDeflate: false, maxPayload: 32 * 1024 * 1024,
            // No handshakeTimeout: even queue/proxy handshakes have no app deadline.
            lookup: (_hostname, options, callback) => options?.all
              ? callback(null, [{ address: target.address, family: target.family }])
              : callback(null, target.address, target.family),
          });
          entry.socket = socket;
          socket.on('open', () => {
            if (!active()) { socket.terminate(); return; }
            entry.attempts = 0;
            socket._socket?.setTimeout?.(0);
            send(owner, { watchId, type: 'connected' });
          });
          socket.on('message', (data, isBinary) => {
            if (!active() || isBinary) return; // Comfy preview images are not progress.
            try { send(owner, { watchId, type: 'message', data: JSON.parse(data.toString('utf8')) }); } catch { /* non-JSON server notices are not Comfy progress */ }
          });
          socket.on('error', (error) => {
            if (active()) send(owner, { watchId, type: 'error', message: `进度连接暂不可用（${error.code || 'NETWORK_ERROR'}），正在恢复` });
          });
          socket.once('close', retry);
        } catch (error) {
          if (active()) {
            send(owner, { watchId, type: 'error', message: error.message || '进度连接暂不可用' });
            retry();
          }
        }
      };
      void connect();
    },
    unwatch: stopWatch,
    close() {
      for (const entry of requests.values()) entry.controller.abort();
      for (const watchId of watches.keys()) stopWatch(watchId);
    },
  };
};

module.exports = { createVideoTransport, videoRequestOptions };
