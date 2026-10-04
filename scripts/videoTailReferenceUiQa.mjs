import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated component fixture: no project storage, actual media, credentials,
// generation endpoint or user files are touched. The native bridge is tested
// separately with real FFmpeg; this fixture controls asynchronous completions.
export const tailReferenceQaInventory = [
  '每段入口、首段禁用、未完成上段明确说明',
  '一键选择准确前段最新成片、本地抽帧进度、无需二次确认或弹窗',
  '仅本段覆盖，中文英文共享图片，原分镜/提示词/素材不变',
  '多槽合法追加保留其他图片、普通参考不承诺强首帧',
  '取消、失败重试、迟到完成不应用、源文件变化失效',
  '连接/项目变化取消旧操作，本地抽帧期间禁止生成与模式切换',
  '1120×720和1280×800的一键配置无弹窗，最终视频费用确认保留',
];

export async function installTailReferenceFixture(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort('blockedbyclient'));
  await page.route('**/__video_tail_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>` }));
  await page.goto(`${origin}/__video_tail_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    await import('/src/styles.css');
    const e = React.createElement; const state = createInitialState(); const now = Date.now();
    const makeImage = (id, name, color = '#526b88') => {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
      const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 480, 270); paint.fillStyle = '#fff'; paint.font = '25px sans-serif'; paint.fillText(name, 22, 145);
      return { id, name, type: 'reference', role: 'general', referenceRole: 'general', source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 480, height: 270, relativePath: `assets/${id}.png`, checksum: `checksum-${id}`, tags: [], createdAt: now, updatedAt: now };
    };
    const image = makeImage('tail-qa-original-image', '本段原参考图');
    const segments = Array.from({ length: 3 }, (_, offset) => ({
      id: `tail-qa-segment-${offset + 1}`, index: offset + 1, title: `剧情第 ${offset + 1} 段`, globalStartSec: offset * 10, globalEndSec: (offset + 1) * 10, durationSec: 10,
      content: '隔离测试剧情', summary: '隔离测试', sourceSceneIds: ['tail-qa-scene'], sourceBeatIds: [], narrativePurpose: '连续动作', entryState: '', exitState: '', transitionHint: '', storyboardId: `tail-qa-board-${offset + 1}`, status: 'ready',
    }));
    const plan = { id: 'tail-qa-plan', title: '上一段尾帧隔离验证', sourceStoryTitle: '上一段尾帧隔离验证', sourceStoryContent: '隔离测试剧情', durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const boards = segments.map((segment) => {
      const zh = `【0s-10s】主体：第${segment.index}段人物；动作：沿道路继续前行；镜头：自然跟拍；声音：脚步与风声。`;
      const en = `【0s-10s】 Subject: segment ${segment.index}; action: continue along the road; camera: tracking; sound: footsteps and wind.`;
      return { id: segment.storyboardId, sceneId: 'tail-qa-scene', sourceStoryTitle: segment.title, workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [image.id], finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh, officialPromptEn: en, officialPromptEnSource: zh, englishPrompt: en, englishPromptSource: zh, promptMigrationPending: false,
        promptTrace: { sourceDocumentIds: [], referenceAssetIds: [image.id], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete' },
        shots: [{ id: `tail-qa-shot-${segment.index}`, index: 1, startSec: 0, endSec: 10, subject: '人物', action: '前行', camera: '跟拍', lighting: '自然光', sound: '风声', referenceAssetIds: [image.id], prompt: zh, locked: false }],
        sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, createdAt: now, updatedAt: now };
    });
    const makeVideo = (id, time) => ({ id, name: '第一段成片', type: 'video', mediaType: 'video', mimeType: 'video/mp4', role: 'motion', referenceRole: 'motion', source: 'generated', sourceStoryboardId: boards[0].id, relativePath: `assets/${id}.mp4`, checksum: `checksum-${id}`, durationSec: 10, width: 480, height: 270, tags: [], createdAt: time, updatedAt: time });
    const project = { ...state.project, id: 'tail-qa-project', name: '尾帧隔离测试', sourceDocuments: [], characters: [], locations: [], props: [], scenes: [{ id: 'tail-qa-scene', title: '隔离测试', content: '隔离测试剧情', summary: '', characterIds: [], propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }], sequencePlans: [plan], storyboards: boards, assets: [image, makeVideo('tail-qa-video-old', now - 2000), makeVideo('tail-qa-video-new', now - 1000)], generationTasks: [{ id: 'tail-qa-pending-2', kind: 'video', storyboardId: boards[1].id, sequencePlanId: plan.id, segmentId: segments[1].id, segmentIndex: 2, status: 'running', targetId: 'qa', requestBody: {}, createdAt: now, updatedAt: now }] };
    const settings = { ...state.settings, videoBackend: 'comfyui', comfyuiVideo: { enabled: true, baseUrl: `${location.origin}/unused-comfy`, apiKey: '', activeWorkflowId: 'tail-qa-workflow', workflows: [{ id: 'tail-qa-workflow', name: '一个普通参考槽', workflowJson: '{}', mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [{ nodeId: '2', inputName: 'image', role: 'general' }] }, createdAt: now, updatedAt: now }] } };
    const qa = window.__tailReferenceQa = { requests: [], cancels: 0, submissions: [], holdCancel: false, frameCount: 0, originalBoards: JSON.stringify(boards), originalVideos: JSON.stringify(project.assets.filter((asset) => asset.type === 'video')) };
    const controller = { runtimes: {}, start: async (draft) => { qa.submissions.push(draft); return 'mock-task'; }, startBatch: async (input) => { qa.submissions.push(input); return { taskIds: [], skipped: [] }; }, cancel: async () => {}, resume: async () => {}, retryDownload: async () => {} };
    function Harness() {
      const [currentProject, setProject] = React.useState(project); const [currentSettings, setSettings] = React.useState(settings); const [busy, setBusy] = React.useState(false); const [epoch, setEpoch] = React.useState(0);
      qa.project = currentProject; qa.settings = currentSettings;
      qa.mutateProject = (mutation) => setProject((current) => mutation(structuredClone(current)));
      qa.mutateSettings = (mutation) => setSettings((current) => mutation(structuredClone(current)));
      qa.reset = (multipleSlots = false) => { qa.pending = undefined; qa.holdCancel = false; setBusy(false); setProject(structuredClone(project)); const next = structuredClone(settings); if (multipleSlots) next.comfyuiVideo.workflows[0].mapping.images.push({ nodeId: '3', inputName: 'image', role: 'first-frame' }); setSettings(next); setEpoch((value) => value + 1); };
      const tools = {
        available: true, busy, progress: busy ? { jobId: 'mock-extract', projectId: currentProject.id, kind: 'extract', stage: 'processing', percent: 57, message: '正在解码尾帧（隔离测试）' } : undefined,
        selectFrame: async () => { throw new Error('new UI must never request visual AI'); },
        extract: async (source) => {
          if (qa.pending) throw new Error('mock extraction already active');
          const ownerId = currentProject.id; qa.requests.push(structuredClone(source)); qa.localAbort = new AbortController(); qa.signal = qa.localAbort.signal; setBusy(true);
          try { return await new Promise((resolve, reject) => { qa.pending = { source, ownerId, resolve: () => {
            const frame = { ...makeImage(`tail-qa-frame-${++qa.frameCount}`, `第1段尾帧 ${qa.frameCount}`, '#375e40'), referenceRole: 'last-frame', role: 'last-frame', source: 'derived', sourceVideoAssetId: source.assetId, sourceVideoChecksum: source.expectedChecksum, sourceTimeSec: 9.96, sourceFrameIndex: 249 };
            setProject((current) => current.id === ownerId ? { ...current, assets: [frame, ...current.assets] } : current); resolve(frame);
          }, reject }; }); }
          finally { qa.pending = undefined; setBusy(false); }
        },
        cancel: async () => { qa.cancels += 1; qa.localAbort?.abort(); if (!qa.holdCancel) qa.pending?.reject(new DOMException('已取消抽帧', 'AbortError')); },
      };
      return e('main', { style: { height: '100dvh', padding: 12, boxSizing: 'border-box', '--ui-font-scale': 1.5 } }, e(VideoDirectorView, { key: epoch, project: currentProject, settings: currentSettings, controller, tailFrameTools: tools }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).waitFor();
}

export async function runTailReferenceUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  const row = (index) => page.locator(`[data-segment-id="tail-qa-segment-${index}"]`);
  const start = async () => {
    await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__tailReferenceQa.pending));
    assert.equal(await page.getByRole('dialog').count(), 0);
  };
  const finish = async () => {
    await page.evaluate(() => window.__tailReferenceQa.pending.resolve());
    await page.waitForFunction(() => !window.__tailReferenceQa.pending);
    await page.getByRole('button', { name: '取消末帧提取', exact: true }).waitFor({ state: 'hidden' });
  };
  const reset = async (multi = false) => { await page.evaluate((value) => window.__tailReferenceQa.reset(value), multi); await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); };
  const capture = async (name) => { if (!outputDirectory) return; const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); screenshots.push(file); };
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  assert.equal(await row(1).getByRole('button', { name: '第 1 段用上段尾帧', exact: true }).isDisabled(), true);
  await row(3).getByRole('button', { name: '第 3 段用上段尾帧', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await row(3).innerText(), /同时选择第 2 段/u);
  stages.push('first-disabled-and-exact-predecessor-required');
  await start(); assert.equal(await page.evaluate(() => window.__tailReferenceQa.requests.at(-1).assetId), 'tail-qa-video-new');
  assert.equal(await page.evaluate(() => window.__tailReferenceQa.requests.at(-1).context), undefined);
  assert.equal(await page.getByRole('tab', { name: '单段生成', exact: true }).isDisabled(), true);
  await capture('inline-local-progress');
  await page.getByRole('button', { name: '取消末帧提取', exact: true }).click();
  await page.waitForFunction(() => !window.__tailReferenceQa.pending);
  assert.match(await row(2).innerText(), /参考图 1 张/u);
  await start(); await finish(); assert.match(await page.locator('.vd-batch-panel').innerText(), /已使用第 1 段的本地真实末帧/u);
  await row(2).getByRole('button', { name: '英文', exact: true }).click();
  await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await confirm.getByLabel('确认批量生成费用', { exact: true }).check(); await confirm.getByRole('button', { name: '确认生成 1 段', exact: true }).click();
  await page.waitForFunction(() => window.__tailReferenceQa.submissions.length === 1);
  const applied = await page.evaluate(() => ({ submission: window.__tailReferenceQa.submissions[0], boards: JSON.stringify(window.__tailReferenceQa.project.storyboards), original: window.__tailReferenceQa.originalBoards, videos: JSON.stringify(window.__tailReferenceQa.project.assets.filter((asset) => asset.type === 'video')), originalVideos: window.__tailReferenceQa.originalVideos }));
  assert.equal(applied.submission.items.length, 1); assert.equal(applied.submission.items[0].draft.source.language, 'en');
  assert.match(applied.submission.items[0].draft.references[0].assetId, /^tail-qa-frame-/u); assert.equal(applied.submission.items[0].draft.references[0].role, 'general');
  assert.equal(applied.boards, applied.original); assert.equal(applied.videos, applied.originalVideos);
  stages.push('one-click-local-applies-bilingual-reference-without-editing-originals');
  await reset(true); await start(); await finish(); assert.match(await row(2).innerText(), /参考图 2 张/u);
  stages.push('supported-first-frame-append-preserves-original');
  await reset(); await start(); await page.evaluate(() => window.__tailReferenceQa.pending.reject(new Error('隔离测试：本地抽帧不可用')));
  await page.waitForFunction(() => !window.__tailReferenceQa.pending);
  assert.match(await page.locator('.vd-batch-panel').innerText(), /本地抽帧不可用/u); await capture('inline-local-error');
  await start(); await finish(); stages.push('inline-error-retry-without-raw-fallback');
  await reset(); await page.evaluate(() => { window.__tailReferenceQa.holdCancel = true; }); await start();
  await page.getByRole('button', { name: '取消末帧提取', exact: true }).click(); await finish();
  assert.match(await page.locator('.vd-batch-panel').innerText(), /已取消本地末帧提取/u); stages.push('late-cancelled-result-discarded');
  for (const change of ['source', 'reference', 'connection']) {
    await reset(); await page.evaluate(() => { window.__tailReferenceQa.holdCancel = true; }); await start();
    await page.evaluate((kind) => {
      const qa = window.__tailReferenceQa;
      if (kind === 'connection') qa.mutateSettings((settings) => { settings.comfyuiVideo.baseUrl += '-changed'; return settings; });
      else qa.mutateProject((project) => { project.assets.find((asset) => asset.id === (kind === 'source' ? 'tail-qa-video-new' : 'tail-qa-original-image')).checksum = 'changed'; return project; });
    }, change);
    await page.waitForFunction(() => window.__tailReferenceQa.signal.aborted);
    await finish(); assert.match(await page.locator('.vd-batch-panel').innerText(), /已取消|未应用/u); stages.push(`${change}-invalidates-late-result`);
  }
  await reset(); await page.getByRole('button', { name: '全选中文', exact: true }).click();
  await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).click();
  for (const viewport of [{ width: 1120, height: 720 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).isVisible(), true);
    await capture(`one-click-layout-${viewport.width}x${viewport.height}`);
  }
  stages.push('responsive-one-click-configuration');
  return { passed: true, inventory: tailReferenceQaInventory, stages, screenshots };
}

export async function runStandaloneTailReferenceUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputDirectory = path.join(root, 'output', 'playwright', 'video-tail-reference');
  await fs.mkdir(outputDirectory, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  let browser;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1120, height: 720 } }); const errors = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    await installTailReferenceFixture(page, `http://127.0.0.1:${address.port}`); const report = await runTailReferenceUiAssertions(page, outputDirectory); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, errors }, null, 2)); return report;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneTailReferenceUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
