// Recovery belongs to the main process: a crashed renderer cannot render an
// error boundary or acknowledge a UI button. Never reload without a user choice.
const createRendererCrashRecovery = ({ window, showMessage, loadRenderer, isClosing = () => false, log = () => {} }) => {
  let disposed = false;
  let pending;
  const unavailable = () => disposed || window.isDestroyed() || window.webContents.isDestroyed() || isClosing();
  const report = (message) => { try { log(message); } catch { /* logging must not prevent recovery */ } };
  const onGone = (_event, details = {}) => {
    if (details.reason === 'normal-exit' || details.reason === 'killed' || unavailable() || pending) return;
    pending = Promise.resolve().then(async () => {
      if (unavailable()) return;
      const choice = await showMessage({
        type: 'error', title: '界面意外停止',
        message: details.reason === 'oom'
          ? '软件界面因内存不足而停止，主程序仍在运行。'
          : '软件界面进程意外停止，主程序仍在运行。',
        detail: '已保存的项目仍保留在本地。重新打开界面会读取最近一次保存；尚未保存的修改可能无法恢复。\n\n视频任务可能仍在服务端运行，恢复后请查看任务状态；本提示不代表任务已取消。',
        buttons: ['重新打开界面', '暂不恢复'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (choice?.response !== 0 || unavailable()) return;
      report('renderer-recovery user requested trusted entry reload');
      // The caller supplies the original trusted entry, never the last URL or
      // arbitrary navigation state left behind by the stopped renderer.
      try {
        await loadRenderer();
      } catch (error) {
        report(`renderer-recovery reload failed: ${String(error?.message || error).slice(0, 1000)}`);
        if (!unavailable()) await showMessage({
          type: 'error', title: '界面恢复未完成', message: '界面重新打开失败，请重新启动软件。',
          detail: '已保存的项目仍保留在本地。可在数据目录 logs/renderer.log 查看本次错误记录。',
          buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true,
        });
      }
    }).catch((error) => {
      report(`renderer-recovery failed: ${String(error?.message || error).slice(0, 1000)}`);
    }).finally(() => { pending = undefined; });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.webContents.removeListener('render-process-gone', onGone);
    window.webContents.removeListener('destroyed', dispose);
    window.removeListener('closed', dispose);
  };
  window.webContents.on('render-process-gone', onGone);
  window.webContents.once('destroyed', dispose);
  window.once('closed', dispose);
  return { dispose, get pending() { return pending; } };
};

module.exports = { createRendererCrashRecovery };
