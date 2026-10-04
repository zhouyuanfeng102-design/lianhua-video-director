import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Full App and production controller/engine. All state, remote tasks and media
// are synthetic; the desktop bridge is memory-only and external HTTP is denied.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `project-background-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project background QA output must stay below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const baseUrl = `http://127.0.0.1:${port}/`;
const projectAName = '后台项目甲 · 长篇剧情分镜与连续视频生成验证项目';
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'project background UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const blockedRequests = []; const checks = []; const layouts = []; const screenshots = [];
const projectCard = (id) => page.locator(`.project-library-item[data-project-id="${id}"]`);
const openLibrary = async () => {
  await page.locator('.topbar .top-action-library').click();
  await page.getByRole('dialog', { name: '项目库', exact: true }).waitFor();
};
const saved = () => page.evaluate(() => {
  const qa = window.__backgroundQa; const state = qa.saved;
  const projects = (state.projects?.length ? state.projects : [state.project]).map((project) => project.__activeProjectReference ? state.project : project);
  return { activeProjectId: state.activeProjectId, projects: projects.map((project) => ({ id: project.id, backgroundSuspended: project.backgroundSuspended,
    storyDraft: project.storyDraft, tasks: project.generationTasks.map((task) => ({ id: task.id, status: task.status, remoteTaskId: task.remoteTaskId,
      resultAssetId: task.resultAssetId, stopped: task.videoJob?.trackingStopped, stage: task.videoJob?.stage })),
    assets: project.assets.map((asset) => ({ id: asset.id, sourceVideoTaskId: asset.sourceVideoTaskId, relativePath: asset.relativePath })) })) };
});
const waitSaved = async (predicate, label) => waitForCondition({ label, timeoutMs: 35_000, intervalMs: 100, check: async () => predicate(await saved()) });

const run = async () => {
  await waitForCondition({ label: 'project background QA Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('crash', () => errors.push('renderer crashed'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.addInitScript(({ origin }) => {
    const raw = sessionStorage.getItem('__project_background_saved__');
    const journal = JSON.parse(sessionStorage.getItem('__project_background_journal__') || '{}');
    const counts = JSON.parse(sessionStorage.getItem('__project_background_counts__') || '{}');
    const qa = window.__backgroundQa = { input: raw, saved: raw ? JSON.parse(raw) : null, loads: [], checkpoints: journal,
      requests: [], posts: 0, downloads: [], cancelledRequests: 0, saveCalls: 0, releaseFirst: false, releaseSecond: false, ...counts };
    const recordCounts = () => sessionStorage.setItem('__project_background_counts__', JSON.stringify({ requests: qa.requests, posts: qa.posts,
      downloads: qa.downloads, cancelledRequests: qa.cancelledRequests, saveCalls: qa.saveCalls, releaseFirst: qa.releaseFirst, releaseSecond: qa.releaseSecond }));
    const response = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      loadState: async () => qa.input || new Promise((resolve) => qa.loads.push(resolve)),
      saveState: async (serialized) => { qa.saved = JSON.parse(serialized); qa.saveCalls++; sessionStorage.setItem('__project_background_saved__', serialized); recordCounts(); return { ok: true, checksum: `qa-${qa.saveCalls}` }; },
      videoRequest: async (request) => {
        if (!request.url.startsWith(origin)) throw new Error('Background QA rejected external video URL');
        qa.requests.push({ method: request.method || 'GET', url: request.url });
        if ((request.method || 'GET') === 'POST') {
          qa.posts++; recordCounts();
          if (qa.posts !== 1 || request.url !== `${origin}/qa/generate`) throw new Error('Background QA detected a duplicate or unexpected POST');
          return response({ id: 'remote-second', status: 'running' });
        }
        const id = request.url.split('/').at(-1); const finished = id === 'remote-first' ? qa.releaseFirst : id === 'remote-second' ? qa.releaseSecond : false;
        recordCounts(); return response({ id, status: finished ? 'succeeded' : 'running', progress: finished ? 100 : 20,
          ...(finished ? { url: `${origin}/qa/media/${id}.mp4` } : {}) });
      },
      downloadGeneratedMedia: async (request) => {
        const id = request.url.includes('remote-first') ? 'remote-first' : 'remote-second';
        qa.downloads.push(id); recordCounts();
        return { fileName: `${id}.mp4`, relativePath: `video/${id}.mp4`, checksum: `checksum-${id}`, sizeBytes: 8,
          mediaType: 'video', mimeType: 'video/mp4', managed: true, missing: false, width: 640, height: 360, durationSec: 5 };
      },
      cancelVideoRequest: async () => { qa.cancelledRequests++; recordCounts(); return true; },
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints[task.id] = structuredClone(task); sessionStorage.setItem('__project_background_journal__', JSON.stringify(qa.checkpoints)); return { persisted: true }; },
      getVideoTaskCheckpoint: async (id) => structuredClone(qa.checkpoints[id] || null),
      deleteVideoTaskCheckpoint: async (id) => { delete qa.checkpoints[id]; sessionStorage.setItem('__project_background_journal__', JSON.stringify(qa.checkpoints)); return { deleted: true }; },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin: new URL(baseUrl).origin });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.evaluate(async ({ base, projectAName }) => {
    const { createInitialState } = await import('/src/storage.ts'); const state = createInitialState(); const now = Date.now();
    const api = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', apiKey: '', model: 'background-qa',
      endpoint: `${base}qa/generate`, statusEndpointTemplate: `${base}qa/tasks/{id}`, taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', requestTemplate: '{"prompt":"{{prompt}}"}' };
    Object.assign(state.settings, { videoTaskApi: api, videoExecutionMode: 'queue', videoExecutionConcurrency: 1 });
    const a = { ...state.project, id: 'background-a', name: projectAName, assets: [], generationTasks: [], storyDraft: { name: '甲原文', content: '甲的既有剧情', updatedAt: now } };
    const b = { ...structuredClone(state.project), id: 'creative-b', name: '创作项目乙', assets: [], generationTasks: [], storyDraft: { name: '乙原文', content: '乙的既有剧情', updatedAt: now } };
    const task = (id, running) => ({ id, kind: 'video', storyboardId: '', targetId: 'background-qa', status: running ? 'running' : 'draft',
      ...(running ? { remoteTaskId: 'remote-first' } : {}), requestBody: {}, createdAt: now - 1000, updatedAt: now,
      videoJob: { stage: running ? 'running' : 'queued', startedAt: running ? now - 1000 : undefined,
        preparation: { version: 1, phase: running ? 'acknowledged' : 'preparing', uploadedImages: [] },
        snapshot: { projectId: a.id, clientId: `client-${id}`, images: [], connection: { backend: 'api', api },
          draft: { name: id, backend: 'api', prompt: `合成后台测试 ${id}`, references: [], parameters: {} } } } });
    a.generationTasks = [task('a-running', true), task('a-queued', false)];
    state.project = a; state.projects = [a, b]; state.activeProjectId = a.id;
    const qa = window.__backgroundQa; for (const entry of a.generationTasks) qa.checkpoints[entry.id] = structuredClone(entry);
    sessionStorage.setItem('__project_background_journal__', JSON.stringify(qa.checkpoints)); qa.input = JSON.stringify(state); qa.saved = state;
  }, { base: baseUrl, projectAName });
  await page.evaluate(() => { const qa = window.__backgroundQa; qa.loads.splice(0).forEach((resolve) => resolve(qa.input)); });
  await page.locator('.sidebar').waitFor();
  await page.waitForFunction(() => window.__backgroundQa.requests.some((entry) => entry.url.endsWith('/remote-first')));
  assert.equal(await page.evaluate(() => window.__backgroundQa.posts), 0, 'queued task waits behind the running task');
  await openLibrary();
  const background = projectCard('background-a').getByRole('button', { name: `后台挂起项目“${projectAName}”`, exact: true });
  const layout = await background.evaluate((button) => {
    const deletion = button.closest('.project-library-item').querySelector('.project-library-delete'); const target = button.getBoundingClientRect(); const above = deletion.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
      button: { left: target.left, right: target.right, top: target.top, bottom: target.bottom }, deleteBottom: above.bottom };
  });
  assert.ok(layout.button.top >= layout.deleteBottom, 'background control appears below project deletion');
  assert.ok(layout.button.right <= 1280 && layout.scrollWidth <= 1280); layouts.push(layout);
  await background.click();
  assert.equal(await page.getByRole('dialog', { name: '项目库', exact: true }).isVisible(), true, 'background action keeps the library open for another choice');
  await projectCard('background-a').getByRole('button', { name: `返回项目“${projectAName}”`, exact: true }).waitFor();
  assert.equal(await projectCard('background-a').locator('.project-library-title-row').getByText('后台挂起中', { exact: true }).count(), 1);
  await waitSaved((state) => state.projects.find((project) => project.id === 'background-a')?.backgroundSuspended === true, 'background marker persisted');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const metrics = await projectCard('background-a').evaluate((card) => {
      const buttons = [...card.querySelectorAll('button')].map((element) => { const b = element.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; });
      const badge = [...card.querySelectorAll('.project-library-title-row *')].find((element) => element.textContent === '后台挂起中');
      const box = badge.getBoundingClientRect(); const title = card.querySelector('.project-library-title-row strong').getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, buttons,
        badge: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }, titleRight: title.right,
        badgeVisible: box.width > 10 && box.height > 10 && Boolean(hit && (hit === badge || badge.contains(hit) || hit.contains(badge))) };
    });
    assert.ok(metrics.scrollWidth <= viewport.width); assert.equal(metrics.badgeVisible, true);
    assert.ok(metrics.badge.left >= metrics.titleRight - 1, 'status badge follows the long title without overlap');
    for (const box of metrics.buttons) assert.ok(box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height, 'project actions stay within the viewport');
    for (let left = 0; left < metrics.buttons.length; left++) for (let right = left + 1; right < metrics.buttons.length; right++) {
      const a = metrics.buttons[left]; const b = metrics.buttons[right];
      assert.ok(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1, 'project controls do not overlap');
    }
    layouts.push(metrics); const name = `project-background-library-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
  }
  checks.push('Background action sits below deletion, keeps library open and adds persisted badge beside the project title');
  await projectCard('creative-b').locator('.project-library-select').click();
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const editor = page.locator('.story-source-textarea'); await editor.fill('乙的新剧情：等待甲的视频时继续创作。');
  await waitSaved((state) => state.activeProjectId === 'creative-b' && state.projects.find((project) => project.id === 'creative-b')?.storyDraft?.content === '乙的新剧情：等待甲的视频时继续创作。', 'second project draft persisted while first project runs');
  assert.equal(await page.evaluate(() => window.__backgroundQa.posts), 0); assert.equal(await page.evaluate(() => window.__backgroundQa.cancelledRequests), 0);
  checks.push('Open project B and edit/persist its draft while A keeps running and its second video waits; no cancellation or duplicate POST');
  await page.reload({ waitUntil: 'networkidle' }); await openLibrary();
  assert.equal(await projectCard('background-a').locator('.project-library-title-row').getByText('后台挂起中', { exact: true }).count(), 1);
  assert.equal(await projectCard('creative-b').locator('.project-library-title-row').getByText('当前项目', { exact: true }).count(), 1);
  await page.getByRole('dialog', { name: '项目库', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  assert.equal(await editor.inputValue(), '乙的新剧情：等待甲的视频时继续创作。');
  const queriesBeforeCompletion = await page.evaluate(() => window.__backgroundQa.requests.length);
  await page.evaluate(() => { window.__backgroundQa.releaseFirst = true; });
  await waitSaved((state) => state.projects.find((project) => project.id === 'background-a')?.tasks.find((task) => task.id === 'a-running')?.resultAssetId, 'first background video saved to original project');
  await page.waitForFunction(() => window.__backgroundQa.posts === 1);
  await editor.fill('乙继续写第二版；甲的队列已在后台续跑。');
  await waitSaved((state) => state.projects.find((project) => project.id === 'creative-b')?.storyDraft?.content === '乙继续写第二版；甲的队列已在后台续跑。', 'draft remains editable during next queued background video');
  await page.evaluate(() => { window.__backgroundQa.releaseSecond = true; });
  await waitSaved((state) => state.projects.find((project) => project.id === 'background-a')?.tasks.every((task) => task.status === 'succeeded' && task.resultAssetId), 'both background videos complete in their owning project');
  const result = await saved(); const a = result.projects.find((project) => project.id === 'background-a'); const b = result.projects.find((project) => project.id === 'creative-b');
  assert.equal(result.activeProjectId, 'creative-b'); assert.equal(a.backgroundSuspended, true);
  assert.deepEqual(a.assets.map((asset) => asset.sourceVideoTaskId).sort(), ['a-queued', 'a-running']);
  assert.equal(b.assets.length, 0); assert.equal(b.tasks.length, 0); assert.equal(b.storyDraft.content, '乙继续写第二版；甲的队列已在后台续跑。');
  assert.equal(a.storyDraft.content, '甲的既有剧情');
  assert.ok(await page.evaluate((before) => window.__backgroundQa.requests.length > before, queriesBeforeCompletion));
  checks.push('After reload A continues polling, completes its first video, submits queued second video exactly once, and owns both results while B stays editable');
  await openLibrary(); await projectCard('background-a').getByRole('button', { name: `返回项目“${projectAName}”`, exact: true }).click();
  await waitSaved((state) => state.activeProjectId === 'background-a' && !state.projects.find((project) => project.id === 'background-a')?.backgroundSuspended, 'return clears background marker without changing completed tasks');
  const returned = await saved();
  assert.equal(returned.projects.find((project) => project.id === 'creative-b').storyDraft.content, '乙继续写第二版；甲的队列已在后台续跑。');
  assert.equal(returned.projects.find((project) => project.id === 'background-a').assets.length, 2);
  assert.ok(returned.projects.find((project) => project.id === 'background-a').tasks.every((task) => task.status === 'succeeded' && task.resultAssetId));
  await openLibrary(); assert.equal(await projectCard('background-a').locator('.project-library-title-row').getByText('后台挂起中', { exact: true }).count(), 0);
  assert.equal(await projectCard('background-a').locator('.project-library-title-row').getByText('当前项目', { exact: true }).count(), 1);
  checks.push('Return-project action opens A and durably clears only its background marker; completed tasks and B draft remain');
  const evidence = await page.evaluate(() => { const qa = window.__backgroundQa; return { posts: qa.posts, downloads: qa.downloads, cancelledRequests: qa.cancelledRequests, queries: qa.requests.filter((entry) => entry.method === 'GET').length, saveCalls: qa.saveCalls }; });
  assert.equal(evidence.posts, 1); assert.deepEqual(evidence.downloads.sort(), ['remote-first', 'remote-second']); assert.equal(evidence.cancelledRequests, 0);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'project-returned.png'), fullPage: false }); screenshots.push('project-returned.png');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, layouts, screenshots, evidence, errors, blockedRequests }, null, 2));
  console.log(`Project background UI QA passed. Report: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blockedRequests, state: page ? await saved().catch(() => null) : null, error: String(error), stack: error?.stack }, null, 2)); throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
