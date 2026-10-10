const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAssetProtocolHandler } = require('../../electron/assetProtocol.cjs');
const testRoot = process.env.LIANHUA_PLAYBACK_QA_ROOT;
app.setPath('userData', path.join(testRoot, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'lianhua-asset', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
const assetRoot = path.join(testRoot, 'assets');
const original = process.env.LIANHUA_PLAYBACK_QA_VIDEO;
global.qaProtocolRequests = [];
const resolve = (relative) => {
  if (original && relative === 'video/user.mov') return original;
  const target = path.resolve(assetRoot, relative); const escaped = path.relative(assetRoot, target);
  if (!escaped || escaped.startsWith('..') || path.isAbsolute(escaped)) throw new Error('Outside fixture assets');
  return target;
};
app.whenReady().then(async () => {
  const handle = createAssetProtocolHandler({ assetPathFromRelative: resolve });
  protocol.handle('lianhua-asset', async (request) => {
    const response = await handle(request);
    global.qaProtocolRequests.push({ url: request.url, method: request.method, range: request.headers.get('range'), status: response.status, length: response.headers.get('content-length'), contentRange: response.headers.get('content-range'), type: response.headers.get('content-type') });
    return response;
  });
  global.qaFetch = async (url, options) => {
    const response = await net.fetch(url, options); const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), bytes: [...bytes] };
  };
  const { createServer } = await import('vite');
  const server = await createServer({ cacheDir: path.join(testRoot, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const file = path.join(testRoot, 'playback.html');
  fs.writeFileSync(file, '<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/AssetVideoPlaybackHarness.tsx"></script></body></html>');
  const relative = path.relative(path.resolve(__dirname, '../..'), file).split(path.sep).join('/');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/${relative}`);
  app.on('before-quit', () => { void server.close(); });
}).catch((error) => { console.error(error); app.exit(1); });
