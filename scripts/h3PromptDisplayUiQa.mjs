import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated component QA: only Vite, a fresh browser context, and an in-memory
// H3 fixture are used. No project state, desktop bridge, or external API is
// opened. This checks the display contract without interpreting or rewriting
// the prompt in the application.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `h3-prompt-display-${Date.now()}`));
const relativeOutput = path.relative(outputBase, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('H3 display QA output must remain below output/playwright');
fs.mkdirSync(output, { recursive: true });

const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'H3 prompt display UI QA', runTimeoutMs: 60_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure;
const errors = []; const blockedRequests = [];

const prompt = [
  '首尾帧参考对齐：第一个参考图只锁定首帧画面，后续图片锁定人物。',
  'subject_definitions:',
  '<Subject 1> 师傅，<Picture 1> 人物参考。',
  '',
  'retention_analysis:',
  '这里提到 [Shot 2] 作为上段末镜依据，不是本段的新镜头。',
  '',
  'integrated_multimodal_description:',
  '[Shot 1] At 00:00.000 主体：师傅；台词：无；声音：递药草的动作声。',
  '[Shot 2] At 00:05.000 主体：徒弟；台词：师傅说“对白内的 [Shot 9] 不能拆镜”；声音：无。',
  '',
  'overall_soundscape:',
  '仅保留剧情内的递交动作声。',
  '',
  'non_diegetic_music: N/A',
].join('\n');

const run = async () => {
  await waitForCondition({ label: 'H3 display Vite startup', timeoutMs: 30_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 900, height: 600 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol) || url.origin === origin) { await route.continue(); return; }
    blockedRequests.push({ origin: url.origin, path: url.pathname }); await route.abort('blockedbyclient');
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ prompt }) => {
    const css = await (await fetch('/src/styles.css')).text();
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    document.body.innerHTML = '<main style="padding:12px;background:#f5f6fa"><div id="host" class="prompt-copy director-result-copy h3-prompt-copy" role="region" aria-label="视频提示词正文" tabindex="0" style="width:680px;height:360px;min-height:160px;max-height:360px"></div></main>';
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { H3PromptDisplay } = await import('/src/components/H3PromptDisplay.tsx');
    ReactDOM.createRoot(document.querySelector('#host')).render(React.createElement(H3PromptDisplay, { prompt, language: 'zh' }));
  }, { prompt });
  await page.locator('.h3-prompt-original').waitFor();
  const report = await page.evaluate(() => {
    const host = document.querySelector('#host'); const body = document.querySelector('.h3-prompt-display-body');
    const original = document.querySelector('.h3-prompt-original');
    return {
      hostHeight: host?.getBoundingClientRect().height,
      hostOverflow: getComputedStyle(host).overflowY,
      bodyPresent: Boolean(body),
      originalText: original?.textContent || '',
      originalOverflow: original && getComputedStyle(original).whiteSpace,
      partitionControls: document.querySelectorAll('.h3-prompt-display-toolbar, [data-h3-section], button').length,
    };
  });
  assert.equal(report.hostHeight, 360, 'display host keeps the fixed 360px prompt viewport');
  assert.ok(['auto', 'scroll'].includes(report.hostOverflow), 'the exact H3 text is the only scrolling region');
  assert.equal(report.bodyPresent, false, 'no presentation-only partition body is inserted');
  assert.equal(report.originalText, prompt, 'the displayed body is the exact submitted H3 string');
  assert.equal(report.originalOverflow, 'pre-wrap', 'long H3 text wraps without rewriting the string');
  assert.equal(report.partitionControls, 0, 'no section viewer, raw toggle, or presentation labels are added');
  await page.screenshot({ path: path.join(output, 'h3-prompt-display.png'), fullPage: false });
  assert.deepEqual(blockedRequests, [], 'component QA must not make external requests');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  return report;
};

try { const report = await Promise.race([run(), harness.qaFailure]); console.log(JSON.stringify({ passed: true, output, report })); }
catch (error) { failure = error; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); }
finally {
  harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, isolatedBrowserStorage: true, productionDataRead: false, blockedRequests, errors, failure: failure?.stack }, null, 2));
}
if (failure) throw failure;
