// Isolated harness for Playwright Interactive file:// worker QA. Never uses
// the real application's main process, data directory or paid API bridge.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const profile = process.env.LIANHUA_WORKER_QA_PROFILE;
const entry = process.env.LIANHUA_WORKER_QA_HTML;
if (!profile || !entry) throw new Error('Explicit isolated worker QA profile and HTML are required');
app.setPath('userData', path.resolve(profile));
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1120, height: 720, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.loadFile(path.resolve(entry));
});
app.on('window-all-closed', () => app.quit());
