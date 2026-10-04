import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real task-card UI with synthetic callbacks. Engine credential recovery and
// dependent-segment scheduling are covered separately by engine tests. This
// suite verifies that errors remain visible and clicks retain the original ID.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-resume-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'RunningHub resume isolated UI', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const externalRequests = []; const steps = [];
const screenshot = async (name) => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false });

async function run() {
  await waitForCondition({ label: 'isolated Vite startup', timeoutMs: 30_000, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin) return route.continue();
    externalRequests.push({ method: request.method(), origin: new URL(request.url()).origin });
    return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const domModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = domModule.default || domModule;
    const { VideoTaskCard } = await import('/src/components/VideoDirectorView.tsx');
    document.getElementById('root').style.display = 'none';
    const mount = document.createElement('main'); mount.id = 'resume-ui-qa';
    mount.style.cssText = 'max-width: 1300px; margin: 30px auto; padding: 24px';
    document.body.appendChild(mount);
    const qa = { mode: 'reject', calls: [], release: null, setTask: null };
    window.__resumeUiQa = qa;
    const base = {
      id: 'original-preparation-task', kind: 'video', storyboardId: 'synthetic-board', targetId: 'synthetic-workflow',
      status: 'failed', requestBody: {}, batchId: 'original-six-segment-batch', batchIndex: 1, batchTotal: 6,
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
      error: 'RunningHub 图片上传失败：HEADER_API_KEY_NOT_FOUND；尚未提交视频生成。',
      videoJob: { stage: 'failed', batchQueueState: 'done', trackingStopped: false,
        preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
        snapshot: { projectId: 'synthetic-project', clientId: 'synthetic-client', batchCompletionOrder: true, images: [],
          connection: { backend: 'api', api: { provider: 'runninghub', model: '隔离验证工作流' } },
          draft: { name: '原批次 · 第 1 段', backend: 'api', prompt: 'Synthetic landscape only', references: [], parameters: {} } } },
    };
    qa.base = base;
    function CardFixture() {
      const [task, setTask] = React.useState(base); qa.setTask = setTask;
      return React.createElement(VideoTaskCard, {
        task, assets: [], knownSecrets: ['synthetic-secret-do-not-display'],
        onResume: async (id) => {
          qa.calls.push({ action: 'resume', id });
          if (qa.mode === 'reject') throw new Error('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。');
          if (qa.mode === 'wait') await new Promise((resolve) => { qa.release = resolve; });
          if (qa.mode === 'persisted-error') {
            setTask((previous) => ({ ...previous, error: 'RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。' }));
            return;
          }
          setTask((previous) => ({ ...previous, status: 'running', error: undefined,
            videoJob: { ...previous.videoJob, stage: 'preparing', batchQueueState: 'active', message: '正在准备原任务的参考图' } }));
        },
        onReuse: (value) => qa.calls.push({ action: 'reuse', id: value.id }),
        onCancel: (id) => qa.calls.push({ action: 'cancel', id }),
      });
    }
    createRoot(mount).render(React.createElement(CardFixture));
  });
  const card = page.locator('#resume-ui-qa [data-video-task-id="original-preparation-task"]');
  const resume = card.getByRole('button', { name: '继续准备原任务', exact: true });
  await resume.waitFor();
  assert.equal(await card.getByRole('button', { name: '载入相同设置再次生成', exact: true }).count(), 0);
  await resume.click();
  await card.getByRole('alert').getByText('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。', { exact: true }).waitFor();
  assert.equal(await resume.isEnabled(), true);
  assert.equal(await card.isVisible(), true);
  await screenshot('01-missing-credential-is-visible');
  steps.push('Rejected resume is caught, readable action error is visible, original task card and retry button remain usable.');

  await page.evaluate(() => { window.__resumeUiQa.mode = 'persisted-error'; });
  await resume.click();
  await card.getByText('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。', { exact: true }).waitFor();
  assert.equal(await card.getByRole('alert').count(), 0);
  assert.equal(await resume.isEnabled(), true);
  steps.push('A resolved callback with persisted task failure shows the new missing-key reason without a blank screen.');

  await page.evaluate(() => { window.__resumeUiQa.mode = 'wait'; });
  await resume.click();
  const waiting = card.getByRole('button', { name: '恢复中…', exact: true });
  await waiting.waitFor(); assert.equal(await waiting.isDisabled(), true);
  assert.equal(await card.getByRole('button', { name: '取消尚未提交任务', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__resumeUiQa.release());
  await card.getByRole('status').getByText('正在准备原任务的参考图', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: '继续准备原任务', exact: true }).count(), 0);
  assert.equal(await card.locator('.vd-error').count(), 0);
  await screenshot('02-original-task-resuming');
  steps.push('Pending resume disables repeat clicks; completing the callback clears the prior error and updates the same task card.');

  const calls = await page.evaluate(() => window.__resumeUiQa.calls);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ action: 'resume', id: 'original-preparation-task' })));
  assert.equal(await page.locator('#resume-ui-qa [data-video-task-id]').count(), 1);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: true, realProductionCard: true, syntheticCallbacksOnly: true, noUserProfileRead: true,
    originalTaskId: 'original-preparation-task', calls, steps, errors, externalRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`RunningHub resume UI passed: ${path.join(output, 'report.json')}`);
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), steps, errors, externalRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
