import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Mount the production video editor with neutral, in-memory chapter fixtures.
// No application storage, credentials, real projects or network APIs are read.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `chapter-video-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import { createServer } from 'vite'; const server = await createServer({ server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}, plugins:[{name:'chapter-video-qa',configureServer(server){server.middlewares.use('/chapter-video-qa',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');});}}] });await server.listen();console.log('Chapter video QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'chapter video editor', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
const errors = [];
const checks = [];

const run = async () => {
  await waitForCondition({ label: 'chapter video Vite', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(`${base}/chapter-video-qa`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== base, async (route) => { errors.push('Blocked external request'); await route.abort(); });
  await page.goto(`${base}/chapter-video-qa`);
  await page.evaluate(async () => {
    // Production React modules use the same Vite dependency URL as this fixture.
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const reactDomModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = reactDomModule.default || reactDomModule;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { createInitialState } = await import('/src/storage.ts');
    const { withChapterWorkspace } = await import('/src/chapters.ts');
    const { videoPromptChoices, chapterIdForVideoLaunch } = await import('/src/videoDirectorDraft.ts');
    const { resolveVideoPromptNavigation } = await import('/src/videoPromptNavigation.ts');
    await import('/src/styles.css');
    const state = createInitialState();
    const project = { ...state.project, id: 'chapter-video-only', sourceDocuments: ['a', 'b', 'empty'].map((id, index) => ({
      id, name: `第 ${index + 1} 章 · ${id}`, content: `${id} 章中性场景`, createdAt: 1, updatedAt: 1,
    })), activeChapterId: 'a', storyboards: [], sequencePlans: [], scenes: [], characters: [], locations: [], props: [], assets: [], generationTasks: [] };
    for (const id of ['a', 'b']) {
      const prompt = `${id} 章：旅人沿石桥走向山城。`;
      project.storyboards.push({ id: `board-${id}`, chapterId: id, sceneId: `scene-${id}`, sourceStoryTitle: `${id} 章分镜`, workflow: 'drama', inputMode: 'text_reference',
        durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
        stylePresetId: '', ruleSetId: '', converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', finalPrompt: prompt, officialPromptZh: prompt,
        sequencePlanId: `plan-${id}`, segmentId: `segment-${id}`, segmentIndex: 1, segmentCount: 1,
        shots: [{ id: `shot-${id}`, index: 1, startSec: 0, endSec: 15, purpose: '', subject: '旅人', action: '沿桥步行', camera: '全景', transition: '', lighting: '日光', sound: '', result: '', referenceAssetIds: [], prompt, locked: false }],
        createdAt: 1, updatedAt: 1 });
      project.sequencePlans.push({ id: `plan-${id}`, chapterId: id, title: `${id} 章计划`, sourceStoryTitle: `${id} 章`, sourceStoryContent: `${id} 章中性场景`,
        totalDurationSec: 15, segmentDurationSec: 15, segments: [{ id: `segment-${id}`, index: 1, title: `${id} 章分段`, startSec: 0, endSec: 15, durationSec: 15, status: 'ready', storyboardId: `board-${id}`, sourceText: `${id} 章中性场景` }], createdAt: 1, updatedAt: 1 });
    }
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#786390'; paint.fillRect(0, 0, 24, 24);
    project.assets.push({ id: 'shared-b-image', name: '第二章共享风景图', sourceStoryboardId: 'board-b', chapterId: 'b', type: 'location', role: 'scene', mediaType: 'image', dataUrl: canvas.toDataURL(), tags: [], createdAt: 1, updatedAt: 1 });
    const settings = { ...state.settings, videoSource: 'api', videoBackend: 'api' };
    const calls = [];
    const controller = { start: (draft) => { calls.push(structuredClone(draft)); return new Promise((resolve) => { window.chapterVideoQa.finish = () => resolve('synthetic-task'); }); }, startBatch: async () => ({ batchId: '', taskIds: [], skipped: [] }), retryDownload: async () => {}, resume: async () => {}, cancel: async () => {}, cancelBatch: async () => ({ batchId: '', cancelledTaskIds: [], retainedTaskIds: [] }), runtimeById: {} };
    window.chapterVideoQa = { project, calls, backgroundToken: controller, pureChecks: {
      emptyChoices: videoPromptChoices(project, 'empty').length,
      aChoices: videoPromptChoices(project, 'a').map((choice) => choice.storyboardId),
      navigation: resolveVideoPromptNavigation(project, 'board-b')?.chapterId,
      launch: chapterIdForVideoLaunch(project, { id: 'launch', storyboardId: 'board-b' }),
      staleChoices: videoPromptChoices({ ...project, storyboards: project.storyboards.map((board) => ({ ...board, sourceStale: true })) }, 'a').length,
    } };
    const element = React.createElement;
    function Harness() {
      const [current, setCurrent] = React.useState(project);
      const [epoch, setEpoch] = React.useState(0);
      window.chapterVideoQa.switch = (id) => setCurrent((value) => ({ ...value, activeChapterId: id }));
      window.chapterVideoQa.remount = () => setEpoch((value) => value + 1);
      return element(React.Fragment, {}, element('div', { style: { padding: 12 } }, ['a', 'b', 'empty'].map((id) => element('button', { key: id, onClick: () => window.chapterVideoQa.switch(id) }, `切换 ${id}`))),
        element(VideoDirectorView, { key: epoch, project: current, settings, controller,
          onChapterDraftChange: (projectId, chapterId, draft) => setCurrent((value) => {
            if (value.id !== projectId) throw new Error('Wrong project persistence');
            const next = withChapterWorkspace(value, { videoDirector: structuredClone(draft) }, chapterId);
            window.chapterVideoQa.project = next; return next;
          }) }));
    }
    createRoot(document.getElementById('root')).render(element(Harness));
  });
  const result = await page.evaluate(() => window.chapterVideoQa.pureChecks);
  assert.deepEqual(result, { emptyChoices: 0, aChoices: ['board-a'], navigation: 'b', launch: 'b', staleChoices: 0 });
  checks.push('chapter choices and source navigation');
  const editor = page.getByRole('textbox', { name: '本次生成使用的完整提示词' });
  await editor.fill('A 章独立手工草稿');
  await page.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
  await page.getByRole('button', { name: '选择图片 第二章共享风景图', exact: true }).click();
  await page.getByRole('button', { name: '使用所选图片', exact: true }).click();
  await page.getByRole('button', { name: '切换 b', exact: true }).click();
  assert.equal(await editor.inputValue(), '');
  await editor.fill('B 章独立手工草稿');
  await page.getByRole('button', { name: '切换 a', exact: true }).click();
  assert.equal(await editor.inputValue(), 'A 章独立手工草稿');
  assert.equal(await page.locator('.vd-reference-row').count(), 1);
  checks.push('single draft and cross-chapter image selection restore');
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  assert.deepEqual(await page.locator('select[aria-label="批量全片计划"] option').evaluateAll((options) => options.map((option) => option.value)), ['plan-a']);
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  await page.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  await page.getByRole('button', { name: '选择图片 第二章共享风景图', exact: true }).click();
  await page.getByRole('button', { name: '使用本段图片', exact: true }).click();
  await page.getByRole('button', { name: '切换 b', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  assert.deepEqual(await page.locator('select[aria-label="批量全片计划"] option').evaluateAll((options) => options.map((option) => option.value)), ['plan-b']);
  assert.equal(await page.getByRole('checkbox', { name: '选择第 1 段', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '切换 a', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '选择第 1 段', exact: true }).isChecked(), true);
  await page.evaluate(() => window.chapterVideoQa.remount());
  assert.equal(await page.getByRole('checkbox', { name: '选择第 1 段', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '取消选择图片 第二章共享风景图', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('dialog', { name: '第 1 段 · 选择参考图', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('batch plan and selections persist across chapter switches and remount');
  await page.getByRole('button', { name: '切换 empty', exact: true }).click();
  assert.equal(await editor.inputValue(), '');
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  assert.equal(await page.locator('select[aria-label="批量全片计划"]').inputValue(), '');
  assert.equal(await page.getByRole('checkbox', { name: '选择第 1 段', exact: true }).count(), 0);
  checks.push('empty chapter never borrows another chapter');
  await page.getByRole('button', { name: '切换 a', exact: true }).click();
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.chapterVideoQa.calls.length === 1);
  await page.getByRole('button', { name: '切换 b', exact: true }).click();
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  await page.evaluate(() => window.chapterVideoQa.finish());
  assert.equal(await editor.inputValue(), 'B 章独立手工草稿');
  assert.equal(await page.evaluate(() => window.chapterVideoQa.calls[0].source.chapterId), 'a');
  assert.equal(await page.getByText('任务已建立。请到“生成任务”查看进度；切换页面或章节不会停止后台追踪，完成后自动存入视频资产库。', { exact: true }).count(), 0);
  checks.push('pending old-chapter submission retains captured chapter and cannot update current draft');
  await page.screenshot({ path: path.join(output, 'chapter-video.png'), fullPage: true });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, errors, productionDataRead: false, paidRequests: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks }));
};
try { await Promise.race([run(), harness.qaFailure]); }
finally { await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); }
