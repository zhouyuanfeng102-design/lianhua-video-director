const { randomUUID } = require('node:crypto');

const createStateCloseGuard = ({ window, flush, showMessage, timeoutMs = 30_000 }) => {
  let allowed = false;
  let attempt;
  let waiting;
  let destroyed = false;
  let resolveDestroyed;
  const destroyedSignal = new Promise((resolve) => { resolveDestroyed = resolve; });
  const waitForRenderer = (requestId) => new Promise((resolve) => {
    waiting = { requestId, resolve };
    try { window.webContents.send('lianhua:before-close', { requestId }); }
    catch (error) { waiting = undefined; resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
  const awaitWithNotice = async (promise) => {
    while (!destroyed) {
      let timer;
      const result = await Promise.race([
        promise.then((value) => ({ done: true, value })),
        destroyedSignal.then(() => ({ done: true, value: { ok: false, cancelled: true } })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) return result.value;
      const choice = await showMessage({
        type: 'warning', title: '正在等待本地保存',
        message: '关闭前的保存尚未完成，软件暂未退出。',
        detail: '大型项目或备份磁盘响应慢时可能需要更久。可以继续等待，或返回软件查看保存状态；不会自动丢弃未保存内容。',
        buttons: ['返回软件', '继续等待'], defaultId: 0, cancelId: 0,
      });
      if (choice.response !== 1) return { ok: false, cancelled: true };
    }
    return { ok: false, cancelled: true };
  };
  const finish = async (requestId) => {
    const reply = await awaitWithNotice(waitForRenderer(requestId));
    waiting = undefined;
    if (!reply?.ok || destroyed) {
      if (!reply?.cancelled && !destroyed) await showMessage({
        type: 'error', title: '项目尚未保存，已取消关闭',
        message: '本地保存未成功，窗口和当前内容已保留。',
        detail: String(reply?.error || '没有收到成功保存确认，请重试。').slice(0, 2000),
        buttons: ['返回软件'], defaultId: 0, cancelId: 0,
      });
      return;
    }
    const durable = await awaitWithNotice(flush().then(() => ({ ok: true }), (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })));
    if (!durable?.ok || destroyed) {
      if (!durable?.cancelled && !destroyed) await showMessage({
        type: 'error', title: '项目尚未保存，已取消关闭', message: '保存未确认，窗口和当前内容已保留。',
        detail: String(durable?.error || '').slice(0, 2000), buttons: ['返回软件'], defaultId: 0, cancelId: 0,
      });
      return;
    }
    allowed = true;
    try { window.close(); }
    catch (error) { allowed = false; throw error; }
  };
  window.on('close', (event) => {
    if (allowed || destroyed) return;
    event.preventDefault();
    if (attempt) return;
    const requestId = randomUUID();
    attempt = finish(requestId).catch(async (error) => {
      if (!destroyed) {
        try { await showMessage({ type: 'error', title: '已取消关闭', message: '保存确认失败，窗口已保留。', detail: String(error?.message || error).slice(0, 2000), buttons: ['返回软件'] }); }
        catch { /* dialog failure still cancels this attempt and unlocks the renderer below */ }
      }
    }).finally(() => {
      attempt = undefined;
      waiting = undefined;
      if (!allowed && !destroyed) {
        // ACK confirms that renderer's latest save completed, not that the
        // main worker flush/close has finished. Renderer stays read-only
        // until destruction or this matching cancellation event arrives.
        try { window.webContents.send('lianhua:close-cancelled', { requestId }); }
        catch { /* a vanished renderer cannot be unlocked and must not be closed again */ }
      }
    });
  });
  window.once('closed', () => {
    destroyed = true;
    resolveDestroyed();
    waiting?.resolve({ ok: false, cancelled: true });
    waiting = undefined;
  });
  return {
    acknowledge: (payload) => {
      if (!waiting || payload?.requestId !== waiting.requestId || typeof payload?.ok !== 'boolean') return false;
      const pending = waiting;
      waiting = undefined;
      pending.resolve({ ok: payload.ok, error: typeof payload.error === 'string' ? payload.error.slice(0, 2000) : '' });
      return true;
    },
    get allowed() { return allowed; },
    get pending() { return Boolean(attempt); },
  };
};

module.exports = { createStateCloseGuard };
