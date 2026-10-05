import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated, single-storyboard smoke test for the Seedance bilingual delivery
// card. It uses an in-memory persisted fixture, a fresh browser context, and a
// mocked text endpoint; no production project or real credential is opened.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `seedance-ui-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const fixturePage = '/__seedance_ui_fixture.html';
const bootstrap = `import {createServer} from 'vite'; const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await s.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'Seedance UI smoke', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure;
const errors = []; const blockedRequests = []; const apiRequests = [];

const fixture = async () => page.evaluate(async ({ key, origin }) => {
  const { createInitialState } = await import('/src/storage.ts');
  const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
  const state = createInitialState(); const now = Date.now();
  const scene = { ...state.project.scenes[0], id: 'seedance-qa-scene', title: '山道交接', content: '师傅把药草递给徒弟，二人沿山道继续前行。', summary: '单段连续动作', characterIds: [], storyboardIds: [] };
  const story = scene.content;
  const shot = { id: 'seedance-qa-shot', index: 1, startSec: 0, endSec: 30, subject: '师傅与徒弟', action: '师傅把药草递给徒弟，二人沿山道继续前行。', purpose: '连续交接', camera: '稳定中景侧拍', lighting: '清晨柔和侧光', sound: '药草摩擦声与山道环境声', transition: '自然承接', result: story, sourceExcerpt: story, sourceStart: 0, sourceEnd: story.length, sourceBeatIds: [], referenceAssetIds: [], prompt: '【0s-30s】主体：师傅与徒弟；动作：师傅把药草递给徒弟，二人沿山道继续前行；空间：山道；光影：清晨柔和侧光；镜头：稳定中景侧拍；台词：无；音效：药草摩擦声。', locked: false, authoredBy: 'text-api' };
  const baseBoard = { id: 'seedance-qa-board', sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: 30, durationPreset: '30s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: 'converter_unified_video', globalLock: '保持师傅在左、徒弟在右，服装和清晨光线连续。', shots: [shot], finalPrompt: shot.prompt, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now };
  const board = applyOfficialH3Prompt(baseBoard, { assets: [], characters: [], locations: [], props: [], sceneContent: story });
  scene.storyboardIds = [board.id];
  const project = { ...state.project, id: 'seedance-qa-project', name: 'Seedance 双语隔离验收', scenes: [scene], storyboards: [board], characters: [], locations: [], props: [], assets: [], sequencePlans: [], generationTasks: [], sourceDocuments: [{ id: 'seedance-qa-source', name: scene.title, content: story, createdAt: now, updatedAt: now },], createdAt: now, updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: `${origin}/mock`, apiKey: '', model: 'qa-seedance-model', provider: 'openai-compatible' };
  state.settings.imageApi.enabled = false; state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
  state.settings.uiFontScalePercent = 100;
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
}, { key: storageKey, origin });

const run = async () => {
  await waitForCondition({ label: 'Seedance UI Vite startup', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__seedanceQa = { clipboard: '', requests: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__seedanceQa.clipboard = value; }, readText: async () => window.__seedanceQa.clipboard } });
  });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol) || url.origin === origin) {
      if (url.origin === origin && request.method() === 'POST' && url.pathname === '/mock/v1/chat/completions') {
        const body = JSON.parse(request.postData() || '{}'); apiRequests.push(body);
        if (apiRequests.length === 1) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unexpected: true }) }); return; }
        const user = body.messages?.at(-1)?.content; const source = typeof user === 'string' ? user : '';
        const english = source.replace(/[\p{Script=Han}]+/gu, 'English');
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: english } }] }) }); return;
      }
      await route.continue(); return;
    }
    blockedRequests.push(request.url()); await route.abort('blockedbyclient');
  });
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await fixture();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-result-pane').waitFor();
  const header = page.locator('.director-result-head');
  assert.match(await header.innerText(), /MiniMax H3 官方格式/u, 'H3 remains the default format');
  assert.equal(await page.getByRole('button', { name: 'Seedance 2.5', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(output, 'default-h3.png') });

  await page.getByRole('button', { name: 'Seedance 2.5', exact: true }).click();
  assert.equal(apiRequests.length, 0, 'switching format must not call the text API');
  assert.match(await header.innerText(), /Seedance 2\.5 官方格式/u);
  const generate = page.getByRole('button', { name: '生成 Seedance 2.5 官方稿', exact: true });
  await generate.click();
  await page.getByText(/中文稿已保存，英文版待重试/u).waitFor();
  assert.equal(apiRequests.length, 1, 'generation performs the requested translation call');
  assert.equal(await page.getByRole('button', { name: '仅重试英文', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'English', exact: true }).isDisabled(), true, 'English stays disabled until the derivative succeeds');
  const zh = await page.locator('.director-result-copy pre').innerText();
  assert.match(zh, /视频规格/u);
  await page.screenshot({ path: path.join(output, 'seedance-chinese-after-english-failure.png') });

  await page.getByRole('button', { name: '仅重试英文', exact: true }).click();
  await page.getByRole('button', { name: '仅重试英文', exact: true }).waitFor({ state: 'detached' });
  assert.equal(apiRequests.length, 2, 'retry only calls the English derivative');
  assert.equal(await page.getByRole('button', { name: 'English', exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  const en = await page.locator('.director-result-copy pre').innerText();
  assert.notEqual(en, zh, 'English pane displays a distinct saved derivative');
  await page.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__seedanceQa.clipboard), en, 'copy uses the selected Seedance language payload');
  await page.screenshot({ path: path.join(output, 'seedance-english-and-copy.png') });
  assert.deepEqual(blockedRequests, [], 'no external network request is permitted');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  const report = { passed: true, isolatedBrowserStorage: true, mockedTextApi: true, apiCalls: apiRequests.length, screenshots: fs.readdirSync(output).filter((name) => name.endsWith('.png')), blockedRequests, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Seedance UI smoke passed: ${path.join(output, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack, apiCalls: apiRequests.length, blockedRequests, errors }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); }
if (failure) throw failure;
