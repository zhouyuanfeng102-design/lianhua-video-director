import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.tmp', `custom-video-tab-ui-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import { createServer } from 'vite'; const server = await createServer({ server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}, plugins:[{name:'custom-video-tab-qa',configureServer(server){server.middlewares.use('/custom-video-tab-qa',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');});}}] });await server.listen();console.log('Custom video tab QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'custom video tab UI', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
const errors = [];
const checks = [];

const run = async () => {
  await waitForCondition({ label: 'custom-video Vite', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(`${base}/custom-video-tab-qa`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== base, async (route) => {
    errors.push(`Unexpected external request: ${route.request().url()}`); await route.abort('blockedbyclient');
  });
  await page.goto(`${base}/custom-video-tab-qa`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const reactDomModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = reactDomModule.default || reactDomModule;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { createInitialState } = await import('/src/storage.ts');
    const { withChapterWorkspace } = await import('/src/chapters.ts');
    await import('/src/styles.css');
    await import('/src/mobile.css');

    const initial = createInitialState();
    const now = Date.now();
    const project = { ...initial.project, id: 'qa-custom-video-project', name: '自定义视频隔离检查',
      sourceDocuments: ['chapter-a', 'chapter-b'].map((id, index) => ({ id, name: `测试章节 ${index + 1}`, content: `测试章节 ${index + 1} 内容`, createdAt: now, updatedAt: now })),
      activeChapterId: 'chapter-a', characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], chapterWorkspaces: {},
      assets: ['image-a', 'image-b'].map((id, index) => {
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = index ? '#4d8d77' : '#ba6880'; drawing.fillRect(0, 0, 96, 64);
        return { id, name: `自定义参考图 ${index + 1}`, fileName: `${id}.png`, type: 'reference', role: 'composition', referenceRole: 'general',
          mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 96, height: 64,
          source: 'upload', tags: ['QA隔离'], createdAt: now, updatedAt: now };
      }), updatedAt: now };
    const rhWorkflow = { id: 'qa-rh-workflow', name: 'QA RunningHub 工作流', runKind: 'workflow', remoteId: '1234567890123456789',
      requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: '' }, { nodeId: '2', fieldName: 'image', fieldValue: '' }] }),
      mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [{ nodeId: '2', inputName: 'image' }] }, createdAt: now, updatedAt: now };
    const rhWebApp = { id: 'qa-rh-web-app', name: 'QA RH 网页应用', remoteId: '1234567890', site: 'cn', url: 'https://www.runninghub.cn/zh-cn/ai-detail/1234567890',
      accountId: 'qa-account', instance: 'Plus', ready: true, updatedAt: now,
      fields: [{ key: 'prompt', label: '完整提示词', kind: 'text', value: '', bind: 'prompt' }, { key: 'image', label: '图片', kind: 'image', value: '', bind: 'image' }] };
    const comfyWorkflow = { id: 'qa-comfy-workflow', name: 'QA ComfyUI 工作流', workflowJson: '{}', createdAt: now, updatedAt: now,
      mapping: { prompt: [{ nodeId: 'p', inputName: 'text' }], images: [{ nodeId: 'i', inputName: 'image' }] } };
    const genericApi = { enabled: true, provider: 'generic', model: 'qa-generic-model', baseUrl: 'https://api.test', endpoint: 'https://api.test/video',
      statusEndpointTemplate: 'https://api.test/video/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
    const h3Api = { enabled: true, provider: 'minimax_h3', model: 'MiniMax-H3', endpoint: 'https://api.minimax.io/v2/video_generation',
      statusEndpointTemplate: 'https://api.minimax.io/v2/query/video_generation/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
      taskIdPath: 'task_id', statusPath: 'task.status', resultUrlPath: 'task.content.url' };
    const settings = { ...initial.settings, videoBackend: 'api', videoSource: 'api', videoTaskApi: genericApi,
      videoApiProfiles: [{ ...h3Api, id: 'qa-h3-api', name: 'QA MiniMax H3 v2', createdAt: now, updatedAt: now }], activeVideoApiProfileId: null,
      runningHubVideo: { ...initial.settings.runningHubVideo, enabled: true, workflows: [rhWorkflow], activeWorkflowId: rhWorkflow.id },
      runningHubWeb: { enabled: true, accounts: [{ id: 'qa-account', name: 'QA', site: 'cn' }], activeAccountId: 'qa-account', apps: [rhWebApp], activeAppId: rhWebApp.id },
      comfyuiVideo: { ...initial.settings.comfyuiVideo, enabled: true, baseUrl: 'http://127.0.0.1:8188', workflows: [comfyWorkflow], activeWorkflowId: comfyWorkflow.id } };
    const calls = [];
    const controller = { start: async (draft) => { calls.push(structuredClone(draft)); return `synthetic-${calls.length}`; },
      startBatch: async () => ({ batchId: '', taskIds: [], skipped: [] }), retryDownload: async () => {}, resume: async () => {}, cancel: async () => {},
      cancelBatch: async () => ({ batchId: '', cancelledTaskIds: [], retainedTaskIds: [] }), runtimeById: {} };
    const initialCustomVideoDraft = { version: 1, draft: { name: '', prompt: '', origin: 'custom', promptMode: 'raw', backend: 'api', references: [],
      referenceSlotRoles: [], audioReferences: [], audioSelectionMode: 'none', videoReferences: [], parameters: {} }, parameterText: '{}', parameterDrafts: [] };
    window.customVideoTabQa = { calls, controller, project, settings, customDraft: initialCustomVideoDraft, singleDrafts: {}, chapter: 'chapter-a', phone: false, epoch: 0 };
    const element = React.createElement;
    function Harness() {
      const [currentProject, setCurrentProject] = React.useState(project);
      const [chapter, setChapter] = React.useState('chapter-a');
      const [customDraft, setCustomDraft] = React.useState(initialCustomVideoDraft);
      const [phone, setPhone] = React.useState(false);
      const [epoch, setEpoch] = React.useState(0);
      window.customVideoTabQa.project = currentProject;
      window.customVideoTabQa.chapter = chapter;
      window.customVideoTabQa.customDraft = customDraft;
      window.customVideoTabQa.phone = phone;
      window.customVideoTabQa.switchChapter = (next) => setChapter(next);
      window.customVideoTabQa.setPhone = (next) => setPhone(next);
      window.customVideoTabQa.remount = () => setEpoch((value) => value + 1);
      React.useLayoutEffect(() => {
        document.documentElement.dataset.mobileLayout = String(phone);
        document.documentElement.style.setProperty('--mobile-viewport-height', `${innerHeight}px`);
      }, [phone]);
      return element('div', { className: `app-shell${phone ? ' mobile-shell' : ''}` },
        element('main', { className: 'main' },
          element('nav', {}, ['chapter-a', 'chapter-b'].map((id) => element('button', { key: id, onClick: () => window.customVideoTabQa.switchChapter(id) }, `切换 ${id}`))),
          element('button', { onClick: () => window.customVideoTabQa.setPhone(!phone) }, phone ? '桌面视图' : '手机视图'),
          element('div', { className: 'workspace view-video' },
            element(VideoDirectorView, { key: `${chapter}:${epoch}`, project: { ...currentProject, activeChapterId: chapter }, chapterId: chapter, settings, controller,
              customVideoDraft: customDraft, phoneLayout: phone,
              onChapterDraftChange: (projectId, chapterId, draft) => setCurrentProject((value) => value.id === projectId
                ? withChapterWorkspace(value, { videoDirector: structuredClone(draft) }, chapterId) : value),
              onCustomVideoDraftChange: (draft) => setCustomDraft(structuredClone(draft)),
              onImportCustomVideoImages: async () => [],
              onOpenSettings: () => {}, onOpenJobs: () => {}, onOpenVideoAssets: () => {}, onVideoApiParametersChange: () => {} }))));
    }
    createRoot(document.getElementById('root')).render(element(Harness));
  });
  await page.locator('.video-director-view').waitFor();
  const tabs = page.getByRole('tablist', { name: '视频生成模式' });
  const tabNames = await tabs.getByRole('tab').allTextContents();
  assert.deepEqual(tabNames.map((text) => text.trim()), ['单段生成', '长剧情批量', '自定义生成']);
  checks.push('custom mode is the third tab immediately after the two existing modes');

  const singlePrompt = page.getByRole('textbox', { name: '本次生成使用的完整提示词' });
  await singlePrompt.fill('章节 A 的原导演稿草稿');
  await page.getByRole('tab', { name: '自定义生成', exact: true }).click();
  const customPrompt = page.getByRole('textbox', { name: '自定义视频提示词', exact: true });
  const rawPrompt = '  纯手写中文提示词 | 保留空格与标点。  ';
  await customPrompt.fill(rawPrompt);
  await page.getByRole('button', { name: '选图片', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择视频图片', exact: true });
  await picker.getByRole('button', { name: /自定义参考图 1/u }).click();
  await picker.getByRole('button', { name: /自定义参考图 2/u }).click();
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await page.locator('.custom-video-image-item').count(), 2);
  await page.locator('.custom-video-settings > summary').click();
  assert.deepEqual(await page.locator('.custom-video-image-item select[aria-label*="输入槽"]').evaluateAll((items) => items.map((item) => item.value)), ['0', '1']);
  await page.locator('.custom-video-settings > summary').click();
  assert.equal(await page.getByRole('textbox', { name: '本次生成使用的完整提示词' }).count(), 0, 'custom panel does not share the single-segment editor');
  checks.push('two independently selected images occupy explicit ordered slots and raw prompt is separate');

  const source = page.locator('.custom-video-source-controls select').first();
  const channelCases = [
    ['runninghub', 'QA RunningHub 工作流'],
    ['runninghub-web', 'QA RH 网页应用'],
    ['comfyui', 'QA ComfyUI 工作流'],
    ['api', 'qa-generic-model'],
  ];
  const submits = [];
  for (const [value, displayName] of channelCases) {
    await source.selectOption(value);
    assert.equal(await source.inputValue(), value);
    const connection = page.locator('.custom-video-source-controls select').nth(1);
    assert.ok((await connection.locator('option').allTextContents()).some((text) => text.includes(displayName)), `${value} exposes the configured connection`);
    await page.getByRole('button', { name: '生成视频', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已提交自定义视频任务' }).waitFor();
    const call = await page.evaluate(() => window.customVideoTabQa.calls.at(-1));
    assert.equal(call.origin, 'custom'); assert.equal(call.promptMode, 'raw'); assert.equal(call.prompt, rawPrompt);
    assert.equal(call.references.length, 2); assert.equal(call.source, undefined);
    submits.push({ source: value, backend: call.backend, workflowId: call.workflowId, runningHubWorkflowId: call.runningHubWorkflowId,
      runningHubWebAppId: call.runningHubWebAppId, apiProfileId: call.apiProfileId });
  }
  assert.deepEqual(submits.map((entry) => entry.source), ['runninghub', 'runninghub-web', 'comfyui', 'api']);
  checks.push('all four configured channels submit through the mocked controller as raw custom tasks with both images');

  await source.selectOption('api');
  const apiConnection = page.locator('.custom-video-source-controls select').nth(1);
  await apiConnection.selectOption('qa-h3-api');
  await page.locator('.custom-video-settings > summary').click();
  await page.getByLabel('自定义 H3 输入模式', { exact: true }).waitFor();
  await page.locator('.custom-video-settings > summary').click();
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  await singlePrompt.fill('章节 A 的更新后导演稿草稿');
  await page.getByRole('tab', { name: '自定义生成', exact: true }).click();
  assert.equal(await customPrompt.inputValue(), rawPrompt, 'single tab edits never overwrite the independent custom draft');
  await page.getByRole('button', { name: '切换 chapter-b', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '自定义生成', exact: true }).getAttribute('aria-selected'), 'true', 'custom mode stays selected across chapter change');
  assert.equal(await customPrompt.inputValue(), rawPrompt, 'custom prompt survives chapter-keyed director remount');
  await page.getByRole('button', { name: '切换 chapter-a', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '自定义生成', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  assert.equal(await singlePrompt.inputValue(), '章节 A 的更新后导演稿草稿', 'single draft remains independent of custom changes');
  await page.getByRole('tab', { name: '自定义生成', exact: true }).click();
  await page.evaluate(() => window.customVideoTabQa.remount());
  assert.equal(await customPrompt.inputValue(), rawPrompt, 'project-owned custom draft survives component remount');
  checks.push('custom and single drafts persist independently across tab changes, chapter changes, and remount');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '手机视图', exact: true }).click();
  const mobileFit = await page.locator('.custom-video-panel').evaluate((panel) => ({
    left: panel.getBoundingClientRect().left, right: panel.getBoundingClientRect().right,
    viewport: innerWidth, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
    submitTop: panel.querySelector('.custom-video-submit').getBoundingClientRect().top,
    submitBottom: panel.querySelector('.custom-video-submit').getBoundingClientRect().bottom,
    viewportHeight: innerHeight,
  }));
  assert.ok(mobileFit.left >= -1 && mobileFit.right <= mobileFit.viewport + 1, JSON.stringify(mobileFit));
  assert.ok(mobileFit.scrollWidth <= mobileFit.clientWidth + 2, JSON.stringify(mobileFit));
  assert.ok(mobileFit.submitTop >= 0 && mobileFit.submitBottom <= mobileFit.viewportHeight + 1, JSON.stringify(mobileFit));
  assert.equal(await page.getByRole('button', { name: '生成视频', exact: true }).isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'custom-video-mobile.png'), fullPage: true });
  checks.push('mobile custom composer fits 390px viewport and keeps submit accessible');

  const details = { ok: true, productionDataRead: false, paidRequests: 0, externalRequestsBlocked: true, checks, mockedSubmissions: submits };
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(details, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output, checks }));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify({ ok: false, checks, error: error.stack || error.message }, null, 2)}\n`);
  process.exitCode = 1;
  throw error;
} finally {
  await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
}
