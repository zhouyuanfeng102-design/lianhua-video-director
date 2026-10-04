import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Isolated production component + production workbench engine; media probe and
// render I/O are mocked. No production storage, generation API or user files.
export async function installWorkbenchBatchFixture(page, baseUrl, sampleFile) {
  const origin = new URL(baseUrl).origin;
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort());
  await page.route('**/__workbench_batch_qa.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__workbench_batch_qa.html`);
  const mediaDataUrl = `data:video/mp4;base64,${(await fs.readFile(sampleFile)).toString('base64')}`;
  await page.evaluate(async ({ mediaDataUrl }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { VideoWorkbenchView } = await import('/src/components/VideoWorkbenchView.tsx');
    const { VideoWorkbenchEngine } = await import('/src/useVideoWorkbenchController.ts');
    const { createInitialState } = await import('/src/storage.ts');
    const { emptyVideoWorkbenchDraft } = await import('/src/videoWorkbench.ts');
    await import('/src/styles.css');
    let current = createInitialState(); current.project.id = 'workbench-qa'; current.project.name = '工作台隔离测试';
    const now = Date.now();
    const videos = Array.from({ length: 8 }, (_, offset) => ({ id: `qa-video-${offset + 1}`, name: `第 ${offset + 1} 段 · 连续剧情视频素材`, type: 'video', mediaType: 'video', mimeType: 'video/mp4',
      source: 'generated', referenceRole: 'motion', role: 'motion', relativePath: `video/qa-${offset + 1}.mp4`, checksum: `hash-${offset + 1}`, dataUrl: mediaDataUrl,
      width: 160, height: 96, durationSec: 2, tags: [], createdAt: now - offset, updatedAt: now }));
    current.project.assets = [...videos, { ...videos[0], id: 'qa-missing', name: '缺失视频（不应选入）', missing: true, createdAt: now - 20 },
      { id: 'qa-audio', name: '剧情背景音乐', type: 'audio', mediaType: 'audio', mimeType: 'audio/wav', role: 'general', source: 'upload', relativePath: 'audio/qa.wav', checksum: 'hash-audio', tags: [], createdAt: now, updatedAt: now }];
    current.project.videoWorkbench = { draft: { ...emptyVideoWorkbenchDraft('workbench-qa'), clips: [{ id: 'existing-clip', sourceAssetId: videos[0].id, sourceChecksum: videos[0].checksum, inSec: 0, outSec: 2, volume: 1, transitionAfter: { type: 'cut', durationSec: 0.3 } }] }, jobs: [] };
    const qa = window.__workbenchBatchQa = { probes: [], addCalls: [], renderCalls: 0, fail: [], hold: false, pending: [] };
    let publish = () => {}; let rerender = () => {};
    const update = (updater) => { current = updater(current); qa.state = current; publish(current); };
    const engine = new VideoWorkbenchEngine({ getState: () => current, setState: update, persist: async () => {}, onChange: () => rerender(), desktop: {
      videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: '隔离媒体服务' }),
      onWorkbenchProgress: () => () => {}, cancelWorkbenchJob: async () => true,
      probeWorkbenchVideo: async (source) => { qa.probes.push(source.assetId); if (qa.hold) await new Promise((resolve) => qa.pending.push(resolve)); if (qa.fail.includes(source.assetId)) throw new Error(`测试解析失败：${source.assetId}`); return { durationSec: 2, width: 160, height: 96, fps: 10, hasAudio: false, videoCodec: 'h264' }; },
      importMedia: async () => { throw new Error('QA禁止导入正式文件'); }, extractWorkbenchFrames: async () => { throw new Error('本场景不执行抽帧'); },
      renderWorkbenchTimeline: async () => { throw new Error('本场景不执行编码'); },
    } });
    qa.engine = engine; qa.state = current; qa.mutate = (updater) => update(updater); qa.release = () => qa.pending.splice(0).forEach((resolve) => resolve());
    function Harness() {
      const [state, setState] = React.useState(current); const [, refresh] = React.useState(0); publish = setState; rerender = () => refresh((value) => value + 1);
      React.useEffect(() => { void engine.refreshStatus(); return () => engine.dispose(); }, []);
      const projectId = state.project.id;
      const controller = { draft: engine.draft(projectId), jobs: [], status: engine.status, busy: engine.busy, error: engine.error, progress: engine.progress, probes: engine.probesFor(projectId),
        refreshStatus: () => engine.refreshStatus(), updateDraft: (updater) => engine.updateDraft(projectId, updater), probeAsset: (id) => engine.probeAsset(projectId, id),
        addAssets: async (ids) => { qa.addCalls.push(ids); return engine.addAssets(projectId, ids); }, importFiles: async () => {}, loadSequence: async () => {},
        renderTimeline: async () => { qa.renderCalls += 1; return undefined; }, cancel: () => engine.cancel(), extractFrames: async () => [], extractBoundaries: async () => [], retryJob: async () => {} };
      return React.createElement('main', { className: 'app-shell qa-workbench-shell', style: { display: 'block', height: '100dvh', minHeight: 0, padding: 12, boxSizing: 'border-box', '--ui-font-scale': 1.3 } },
        React.createElement(VideoWorkbenchView, { project: state.project, controller, onOpenVideoDirector: () => {}, onOpenAssets: () => {} }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  }, { mediaDataUrl });
  await page.getByRole('tab', { name: '剪辑拼接', exact: true }).waitFor();
}

export async function workbenchLayoutCheck(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const elements = [...main.querySelectorAll('button,input,select,video')].filter((element) => element.getClientRects().length);
    const clipped = elements.flatMap((element) => {
      const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && hit && (hit === element || element.contains(hit)) ? [] : [element.getAttribute('aria-label') || element.textContent || element.tagName];
    });
    const panels = [...main.querySelectorAll('.vwb-panel,.vwb-clip-editor,.vwb-inline-output,.vwb-clips-browser')].map((element) => ({ cls: element.className, width: element.clientWidth, height: element.clientHeight, sx: element.scrollWidth > element.clientWidth + 1, sy: element.scrollHeight > element.clientHeight + 1 }));
    return { width: innerWidth, height: innerHeight, clipped, panels, documentScroll: document.documentElement.scrollHeight > innerHeight + 1 };
  });
}

export async function runWorkbenchBatchUiAssertions(page, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true }); const stages = [];
  assert.equal(await page.getByRole('tab', { name: '输出声音', exact: true }).count(), 0);
  await page.getByLabel('全选筛选结果（跨全部分页）', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: '添加已选（8）', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '视频素材下一页', exact: true }).click();
  assert.ok((await page.locator('.vwb-source-check').isChecked().catch(() => false)) || (await page.locator('.vwb-source-check:checked').count()) > 0);
  await page.getByRole('button', { name: '添加已选（8）', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchBatchQa.state.project.videoWorkbench.draft.clips.length === 9);
  const sequence = await page.evaluate(() => window.__workbenchBatchQa.state.project.videoWorkbench.draft.clips.map((clip) => clip.sourceAssetId).join(','));
  assert.equal(sequence, 'qa-video-1,qa-video-1,qa-video-2,qa-video-3,qa-video-4,qa-video-5,qa-video-6,qa-video-7,qa-video-8');
  assert.equal(await page.getByRole('button', { name: '添加已选（0）', exact: true }).isDisabled(), true); stages.push('select-all-pages-and-ordered-append-preserving-existing-clip');
  await page.getByLabel('搜索视频素材', { exact: true }).fill('第 3 段');
  await page.getByLabel('全选筛选结果（跨全部分页）', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: '添加已选（1）', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await page.getByLabel('搜索视频素材', { exact: true }).fill(''); stages.push('filter-select-and-clear-cycle');
  await page.getByLabel('输出文件名', { exact: true }).fill('多选剪辑成片');
  await page.getByLabel('输出尺寸').selectOption('1280x720');
  await page.getByLabel('帧率').selectOption('25');
  await page.getByLabel('背景音乐').selectOption('qa-audio');
  await page.getByLabel('BGM 音量（原始音量的 %）', { exact: true }).fill('9');
  const options = await page.evaluate(() => window.__workbenchBatchQa.state.project.videoWorkbench.draft);
  assert.equal(options.output.fileName, '多选剪辑成片'); assert.equal(options.output.width, 1280); assert.equal(options.output.fps, 25); assert.equal(options.audio.bgmVolume, 0.09);
  await page.getByLabel('剪辑片段页码', { exact: true }).selectOption('0');
  await page.locator('.vwb-clip-select').first().click();
  await page.getByLabel('片段 1 转场', { exact: true }).selectOption('crossfade');
  await page.getByLabel('片段 1 入点', { exact: true }).fill('0.1');
  await page.getByLabel('片段 1 转场秒数', { exact: true }).fill('0.2'); stages.push('inline-output-audio-and-clip-controls-work-on-same-page');
  const layouts = [];
  for (const viewport of [{ width: 1120, height: 720 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [1, 1.3]) {
      await page.evaluate((value) => document.querySelector('main').style.setProperty('--ui-font-scale', String(value)), scale);
      await page.screenshot({ path: path.join(outputDirectory, `workbench-${viewport.width}x${viewport.height}-${scale}.png`), scale: 'css' });
      const layout = await workbenchLayoutCheck(page);
      assert.equal(layout.clipped.length, 0, JSON.stringify(layout)); assert.equal(layout.documentScroll, false);
      assert.ok(layout.panels.every((panel) => !panel.sx && !panel.sy), JSON.stringify(layout)); layouts.push(layout);
    }
  }
  await page.getByRole('button', { name: '导出成片', exact: true }).click(); assert.equal(await page.evaluate(() => window.__workbenchBatchQa.renderCalls), 1);
  return { stages, layouts };
}
