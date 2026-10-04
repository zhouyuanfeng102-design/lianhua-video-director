import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Fresh browser storage only. All model traffic is intercepted on a private
// loopback route; this script never loads desktop profiles or production state.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'sequence-duration-0.5.151'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Duration QA output must stay below output/playwright');
for (let candidate = outputDirectory; candidate !== root; candidate = path.dirname(candidate)) {
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Duration QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const apiPath = '/qa-duration-only/v1/chat/completions';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated duration QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'sequence duration 151 UI QA', runTimeoutMs: 120000, closeTimeoutMs: 10000 });
let browser; let context; let page;
const requests = []; const errors = []; const blockedRequests = [];
const sourceStory = '林澜提起行囊，推开庭院的木门。她沿着河岸向前走，走到廊桥旁停下欣赏水面。随后她穿过廊桥，在山亭里放下行囊，平静地眺望远处山谷。';
const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  if (!match) return undefined;
  return JSON.parse(match[1]);
};

const run = async () => {
  await waitForCondition({ label: 'duration fixture Vite ready', timeoutMs: 40000, intervalMs: 100,
    check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin) {
      blockedRequests.push(url.href); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname !== apiPath) {
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        errors.push(`Unexpected mutating request: ${request.method()} ${url.pathname}`);
        await route.abort('blockedbyclient'); return;
      }
      await route.continue(); return;
    }
    try {
      assert.equal(request.method(), 'POST');
      const payload = request.postDataJSON();
      const user = (payload.messages || []).filter((message) => message.role === 'user').map((message) => textContent(message.content)).join('\n');
      const repair = tagged(user, 'story_duration_repair_data');
      const review = tagged(user, 'story_duration_review_data');
      const initial = tagged(user, 'story_data');
      const original = repair?.originalData || review?.originalData || initial;
      assert.ok(original, 'only the actual duration API contract is permitted');
      assert.equal(original.story, sourceStory);
      assert.ok(original.segmentDurationSec === 15 || original.segmentDurationSec === 30);
      const stage = repair ? 'repair' : review ? 'review' : 'estimate';
      const segment = original.segmentDurationSec;
      const recommendedSec = segment === 15 ? stage === 'repair' ? 90 : 80 : stage === 'review' ? 120 : 90;
      const response = { minSec: 60, recommendedSec, maxSec: segment === 15 ? 120 : 180,
        fitStatus: 'balanced', reason: segment === 15 && stage === 'repair'
          ? '阅读全文后由AI修复为90秒：6段，每段15秒。保留全部行动和原场景，按自然动作与停顿组织节奏。'
          : segment === 30 ? '已按用户30秒每段重新估时，复核后为120秒，共4段。' : '隔离故障样本：首轮和复核仍返回80秒，等待同一API修复。' };
      requests.push({ segmentDurationSec: segment, stage, recommendedSec, method: request.method(), pathname: url.pathname });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: `duration-mock-${requests.length}`, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(response) }, finish_reason: 'stop' }],
      }) });
    } catch (error) {
      errors.push(String(error)); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'isolated QA fixture rejected unexpected request' }) });
    }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ story, apiBase }) => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const scene = { id: 'duration-qa-scene', title: '河岸启程', content: story, summary: '启程、过桥、到山亭休息',
      characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'duration-qa-project', name: '每段足额估时 · 隔离验收',
      sourceDocuments: [{ id: 'duration-qa-source', name: '河岸启程', content: story, createdAt: now, updatedAt: now }],
      scenes: [scene], characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
      directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined,
      storyDraft: undefined, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBase, apiKey: '', model: 'mock-duration-151' };
    state.settings.imageApi.enabled = false; state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.uiFontScalePercent = 100;
    localStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, { story: sourceStory, apiBase: new URL('qa-duration-only/v1', baseUrl).toString() });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  const timing = page.locator('#sequence-director-settings-panel #director-setup-timing');
  await timing.getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.locator('.sequence-planner-panel').waitFor();
  await page.getByRole('button', { name: '估算全片时长', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sequence-estimate-copy strong')?.textContent.includes('估时建议 90 秒'));
  assert.deepEqual(requests.map(({ segmentDurationSec, stage, recommendedSec }) => ({ segmentDurationSec, stage, recommendedSec })), [
    { segmentDurationSec: 15, stage: 'estimate', recommendedSec: 80 },
    { segmentDurationSec: 15, stage: 'review', recommendedSec: 80 },
    { segmentDurationSec: 15, stage: 'repair', recommendedSec: 90 },
  ]);
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '90');
  assert.match(await page.locator('.sequence-planner-controls').textContent(), /全片 90 秒 = 6 段 × 15 秒/u);
  await page.screenshot({ path: path.join(outputDirectory, 'ai-repaired-90s-six-15s-segments.png'), fullPage: true });
  await page.getByRole('button', { name: '采用建议', exact: true }).click();
  assert.equal(requests.length, 3, 'accepting a reviewed estimate cannot submit another API call');
  const durationChoice = page.getByRole('group', { name: '单段生成时长预设', exact: true });
  await durationChoice.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('自定义单段秒数', { exact: true }).fill('30');
  await page.waitForFunction(() => document.querySelector('.sequence-estimate-copy strong')?.textContent.trim() === '尚未估时');
  assert.equal(requests.length, 3, 'changing selected seconds invalidates only the cache and does not auto-charge');
  await page.getByRole('button', { name: '估算全片时长', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sequence-estimate-copy strong')?.textContent.includes('估时建议 120 秒'));
  assert.deepEqual(requests.slice(3).map(({ segmentDurationSec, stage, recommendedSec }) => ({ segmentDurationSec, stage, recommendedSec })), [
    { segmentDurationSec: 30, stage: 'estimate', recommendedSec: 90 },
    { segmentDurationSec: 30, stage: 'review', recommendedSec: 120 },
  ]);
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '120');
  assert.match(await page.locator('.sequence-planner-controls').textContent(), /全片 120 秒 = 4 段 × 30 秒/u);
  await page.screenshot({ path: path.join(outputDirectory, 'new-30s-choice-new-ai-estimate-120s.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const fixtureState = await page.evaluate(async () => {
    const { STORAGE_KEY } = await import('/src/storage.ts');
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { projectId: state.project.id, boards: state.project.storyboards.length, plans: state.project.sequencePlans.length,
      media: state.project.assets.length, tasks: state.project.generationTasks.length };
  });
  assert.deepEqual(fixtureState, { projectId: 'duration-qa-project', boards: 0, plans: 0, media: 0, tasks: 0 });
  const report = { passed: true, isolatedBrowserStorage: true, productionDataRead: false, paidApiCalls: 0,
    requests, errors, blockedRequests, fixtureState,
    screenshots: ['ai-repaired-90s-six-15s-segments.png', 'new-30s-choice-new-ai-estimate-120s.png'] };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), requests, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
