import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Real App, one isolated synthetic project and neutral color-block images.
// Every bridge method is mocked; no real project, media file or model service.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `private-reference-library-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output cannot traverse links'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(output, { recursive: true });

const fixturePath = '/__private_reference_library_qa__.html';
const stateKey = 'lianhua_video_director_state_v22';
const ordinaryIds = ['qa-reference-character', 'qa-reference-first', 'qa-reference-last', 'qa-reference-managed'];
const names = { 'qa-reference-character': '普通角色色块', 'qa-reference-first': '首帧色块', 'qa-reference-last': '尾帧色块',
  'qa-reference-managed': '普通托管色块', 'qa-private-a-body': '甲人物同部位私密色块', 'qa-private-a-other': '甲人物另一部位私密色块',
  'qa-private-b-body': '乙人物私密色块', 'qa-reference-missing': '缺失色块', 'qa-reference-audio': '合成音频', 'qa-reference-video': '合成视频' };
const errors = []; const expectedDiagnostics = []; const blockedRequests = []; const stages = [];
const server = await createServer({ root, configFile: false, plugins: [react()], optimizeDeps: { entries: ['src/main.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
const fixtureHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Private reference-library real App QA</title>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="root"></div><script type="module">
    import { createInitialState, normalizeState, STORAGE_KEY } from '/src/storage.ts';
    const state = createInitialState(); const now = Date.now();
    const pixel = (color) => { const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 64; const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 80, 64); paint.fillStyle = '#fff'; paint.fillRect(24, 20, 32, 24); return canvas.toDataURL('image/png'); };
    const pixels = { character: pixel('#426a9f'), first: pixel('#377a65'), last: pixel('#927a3b'), managed: pixel('#815b93'), private: pixel('#58818c') };
    const image = (id, name, type, dataUrl, extra = {}) => ({ id, name, type, role: type === 'reference' ? 'composition' : type,
      referenceRole: type === 'reference' ? 'general' : type, referenceScope: 'general', source: 'upload', mediaType: 'image', mimeType: 'image/png',
      dataUrl, width: 80, height: 64, tags: ['isolated-qa'], createdAt: now, updatedAt: now, ...extra });
    const managed = image('qa-reference-managed', '普通托管色块', 'reference', '', { managed: true, missing: false,
      fileName: 'qa-managed-reference.png', relativePath: 'qa/reference-managed.png', checksum: 'a'.repeat(64), sizeBytes: 256,
      url: pixels.managed, sourceEntityId: 'qa-reference-character-b', sourceEntityKind: 'character' });
    const assets = [
      image('qa-reference-character', '普通角色色块', 'character', pixels.character, { sourceEntityId: 'qa-reference-character-a', sourceEntityKind: 'character' }),
      image('qa-reference-first', '首帧色块', 'first-frame', pixels.first, { tags: ['qa-frame'] }),
      image('qa-reference-last', '尾帧色块', 'last-frame', pixels.last, { tags: ['qa-frame'] }), managed,
      image('qa-private-a-body', '甲人物同部位私密色块', 'character', pixels.private, { sourceEntityId: 'qa-reference-character-a', sourceEntityKind: 'character', referenceScope: 'nsfw-private-profile', imageVariant: 'private-full-body', nsfwPrivatePart: 'full-body' }),
      image('qa-private-a-other', '甲人物另一部位私密色块', 'character', pixels.private, { sourceEntityId: 'qa-reference-character-a', sourceEntityKind: 'character', referenceScope: 'nsfw-private-profile', imageVariant: 'private-close-up', nsfwPrivatePart: 'breasts' }),
      image('qa-private-b-body', '乙人物私密色块', 'character', pixels.private, { sourceEntityId: 'qa-reference-character-b', sourceEntityKind: 'character', referenceScope: 'nsfw-private-profile', imageVariant: 'private-full-body', nsfwPrivatePart: 'full-body' }),
      image('qa-reference-missing', '缺失色块', 'character', pixels.character, { missing: true }),
      { id: 'qa-reference-audio', name: '合成音频', type: 'audio', role: 'audio', referenceRole: 'audio', mediaType: 'audio', source: 'upload', tags: [], createdAt: now, updatedAt: now },
      { id: 'qa-reference-video', name: '合成视频', type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', source: 'upload', tags: [], createdAt: now, updatedAt: now },
    ];
    const character = (id, name) => ({ ...state.project.characters[0], id, name, gender: '女', apparentAge: '30岁', actualAge: '30岁',
      appearance: '中性色块测试资料', outfit: '普通蓝色外套', assetIds: [], nsfwProfile: { fullBody: '中性色块测试资料', provenance: 'manual' } });
    const project = { ...state.project, id: 'qa-private-reference-project', name: '私密参考图库隔离验证',
      characters: [character('qa-reference-character-a', '甲测试人物'), character('qa-reference-character-b', '乙测试人物')],
      assets, locations: [], props: [], sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [] };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.settings.uiFontScalePercent = 100;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
    state.settings.imageApi.backend = 'openai'; state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.visionApiProfiles = []; state.settings.videoApiProfiles = []; state.settings.apiCredentialBook = [];
    const normalized = normalizeState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    window.__privateReferenceQa.pixels = pixels;
    window.__privateReferenceQa.baseline = structuredClone(normalized.project.assets);
    window.__privateReferenceQa.media = { relativePath: managed.relativePath, expectedChecksum: managed.checksum, dataUrl: pixels.managed };
    await import('/src/main.tsx');
    </script></body></html>`;

let browser; let context; let page; let origin; let deadline;
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const picker = () => page.getByRole('dialog', { name: '从资产库选择参考图', exact: true });
const openPicker = async () => { await page.getByRole('button', { name: '从资产库选择', exact: true }).click(); await picker().waitFor(); };
const rows = () => picker().locator('.reference-image-picker-item');
const assertInventory = async (expected) => {
  const texts = await rows().allTextContents();
  assert.equal(texts.length, expected.length, `expected only: ${expected.map(id => names[id]).join(', ')}`);
  for (const id of expected) assert.ok(texts.some(text => text.includes(names[id])), `${names[id]} is visible`);
};
const confirm = async (id, lane, pixelName) => {
  await rows().filter({ hasText: names[id] }).click();
  await picker().getByRole('button', { name: '使用所选图片', exact: true }).click();
  await picker().waitFor({ state: 'hidden' });
  const preview = page.getByAltText(`${lane}参考图缩略图`, { exact: true }); await preview.waitFor();
  const expected = await page.evaluate(key => window.__privateReferenceQa.pixels[key], pixelName);
  assert.equal(await preview.getAttribute('src'), expected, 'the selected asset supplies its actual pixels');
  await page.waitForFunction(name => document.querySelector(`input[name="use-reference-image-${name}"]`)?.checked === true, lane === '私密' ? 'private' : 'ordinary');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await preview.getAttribute('src'), expected, 'reference validation effects retain the chosen image');
  assert.equal(await page.locator(`input[name="use-reference-image-${lane === '私密' ? 'private' : 'ordinary'}"]`).isChecked(), true);
};
const sourceMetadata = (assets) => assets.filter(asset => ordinaryIds.includes(asset.id)).map(asset => ({ id: asset.id, sourceEntityId: asset.sourceEntityId,
  sourceEntityKind: asset.sourceEntityKind, referenceScope: asset.referenceScope, imageVariant: asset.imageVariant, nsfwPrivatePart: asset.nsfwPrivatePart }));

async function run() {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  await context.routeWebSocket(/.*/u, socket => socket.close());
  await context.addInitScript(() => {
    const qa = window.__privateReferenceQa = { reads: [], requests: [], media: null, pixels: {}, baseline: [] };
    const recovery = { allowPrivateNetwork: false, backupDirectory: '', backupOnSave: false, keepCount: 20 };
    window.lianhuaDesktop = {
      storagePaths: async () => ({ dataRoot: 'QA-only', sessionData: 'QA-only/session', cache: 'QA-only/cache', temp: 'QA-only/temp', logs: 'QA-only/logs', recovery }),
      recoveryStatus: async () => new Promise(() => {}),
      getImageThumbnail: async payload => {
        if (payload.relativePath !== qa.media.relativePath || payload.expectedChecksum !== qa.media.expectedChecksum) throw new Error('Unexpected synthetic thumbnail');
        return { dataUrl: qa.media.dataUrl, mimeType: 'image/png', width: 80, height: 64, sizeBytes: 256 };
      },
      readManagedImageDataUrl: async payload => {
        qa.reads.push({ ...payload });
        if (payload.relativePath !== qa.media.relativePath || payload.expectedChecksum !== qa.media.expectedChecksum) throw new Error('Unexpected synthetic managed image');
        return { dataUrl: qa.media.dataUrl, mimeType: 'image/png', checksum: qa.media.expectedChecksum, sizeBytes: 256 };
      },
      request: async payload => { qa.requests.push(payload.url); throw new Error('Real API is forbidden in this fixture'); },
      videoRequest: async payload => { qa.requests.push(payload.url); throw new Error('Real video API is forbidden in this fixture'); },
      onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin && url.pathname === fixturePath && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html', body: fixtureHtml }); return;
    }
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push({ url: request.url(), method: request.method() }); await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith('[vite] failed to connect to websocket.') || /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:/u.test(text)) expectedDiagnostics.push(text);
    else errors.push(text);
  });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await nav('资产库'); await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
  for (const id of ordinaryIds) {
    const preview = page.locator(`#asset-card-${id}`).getByAltText(names[id], { exact: true });
    await preview.waitFor();
    assert.equal(await preview.evaluate(image => image.complete && image.naturalWidth === 80 && image.naturalHeight === 64), true, `${names[id]} previews in the asset library`);
  }
  stages.push({ name: 'ordinary-character-frame-and-managed-images-preview-in-library', passed: true });

  await nav('图像工作台');
  assert.equal(await page.getByLabel('调用项目实体', { exact: true }).inputValue(), '', 'the new manual form has no saved character binding');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  await openPicker(); await assertInventory(ordinaryIds);
  await picker().getByLabel('搜索资产图片', { exact: true }).fill('qa-frame'); await assertInventory(['qa-reference-first', 'qa-reference-last']);
  await picker().getByLabel('搜索资产图片', { exact: true }).fill('没有这个合成素材'); assert.equal(await rows().count(), 0);
  await picker().getByLabel('搜索资产图片', { exact: true }).fill(''); await assertInventory(ordinaryIds);
  stages.push({ name: 'unbound-private-picker-shows-ordinary-images-and-searches-without-missing-or-media', passed: true });
  await confirm('qa-reference-character', '私密', 'character');
  assert.deepEqual(await page.evaluate(() => window.__privateReferenceQa.reads), [], 'inline images do not trigger managed file reads');
  await openPicker(); await confirm('qa-reference-managed', '私密', 'managed');
  assert.deepEqual(await page.evaluate(() => window.__privateReferenceQa.reads), [{ relativePath: 'qa/reference-managed.png', expectedChecksum: 'a'.repeat(64) }]);
  await page.screenshot({ path: path.join(output, 'private-reference-selected.png'), fullPage: false });
  stages.push({ name: 'inline-and-managed-references-confirm-with-preview-and-use-reference-selected', passed: true });

  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(await page.getByAltText('普通参考图缩略图', { exact: true }).count(), 0, 'private reference does not enter the ordinary lane');
  assert.equal(await page.locator('input[name="use-reference-image-ordinary"]').isChecked(), false);
  await openPicker(); await assertInventory(ordinaryIds); await confirm('qa-reference-first', '普通', 'first');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await page.getByAltText('私密参考图缩略图', { exact: true }).getAttribute('src'), await page.evaluate(() => window.__privateReferenceQa.pixels.managed));
  assert.equal(await page.locator('input[name="use-reference-image-private"]').isChecked(), true);
  stages.push({ name: 'ordinary-and-private-lanes-retain-independent-references', passed: true });

  await page.getByLabel('调用项目实体', { exact: true }).selectOption('qa-reference-character-a');
  await openPicker(); await assertInventory([...ordinaryIds, 'qa-private-a-body']);
  await picker().getByRole('button', { name: '关闭资产图片选择器', exact: true }).click();
  stages.push({ name: 'bound-private-images-still-require-same-character-and-part', passed: true });

  const baseline = await page.evaluate(() => window.__privateReferenceQa.baseline);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).project.assets, stateKey);
  assert.deepEqual(sourceMetadata(saved), sourceMetadata(baseline), 'using ordinary assets privately never changes their provenance or reference scope');
  const bridge = await page.evaluate(() => ({ reads: window.__privateReferenceQa.reads, requests: window.__privateReferenceQa.requests }));
  assert.deepEqual(bridge.requests, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  stages.push({ name: 'ordinary-source-metadata-retained-with-no-model-or-external-requests', passed: true });
  return bridge;
}

try {
  const bridge = await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Private reference-library UI QA exceeded 120 seconds')), 120_000); })]);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, mockOnly: true, syntheticPixelsOnly: true, stages, bridge, errors, expectedDiagnostics, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, groups: stages.length, output, managedReads: bridge.reads.length }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, failure: String(error), stages, errors, expectedDiagnostics, blockedRequests }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline); await context?.close(); await browser?.close(); await server.close();
}
