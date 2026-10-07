import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated browser state only. Exercise actual asset-library deletion and the
// video director, with every generation request blocked and clipboard mocked.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
fs.mkdirSync(outputBase, { recursive: true });
const output = fs.mkdtempSync(path.join(outputBase, 'asset-deletion-'));
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'asset deletion browser QA', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const errors = []; const requests = []; const stages = [];
let browser; let context; let page; let failure;
const screenshot = async (name) => page.screenshot({ path: path.join(output, name), fullPage: false });
const run = async () => {
  await waitForCondition({ label: 'isolated Vite startup', timeoutMs: 30_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__assetDeletionCopied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__assetDeletionCopied = text; },
    } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol) || (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/__no-api'))) {
      await route.continue(); return;
    }
    requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
    await route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar .nav-item').first().waitFor();
  const fixture = await page.evaluate(async (key) => {
    const { createInitialState, serializeStateForStorage } = await import('/src/storage.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceContentHash.ts');
    const { videoPromptChoices } = await import('/src/videoDirectorDraft.ts');
    const state = createInitialState(); const now = Date.now();
    const chapterId = state.project.activeChapterId;
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#725fa8'; paint.fillRect(0, 0, 160, 90);
    const image = (id, name, extra = {}) => ({ id, name, type: 'reference', role: 'composition', referenceRole: 'composition',
      mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 160, height: 90,
      source: 'upload', tags: ['隔离测试'], createdAt: now, updatedAt: now, ...extra });
    const assets = [image('qa-generated', '本段自动生成分镜图', { source: 'generated', sourceStoryboardId: 'qa-board-1' }),
      image('qa-input', '明确作为视频输入的原图')];
    const project = { ...state.project, id: 'qa-delete-project', name: '资产删除隔离验证',
      characters: [], locations: [], props: [], storyboards: [], assets, sequencePlans: [], generationTasks: [] };
    const sourceContext = { assets, characters: [], locations: [], props: [] };
    const segments = [1, 2].map((index) => ({ id: `qa-segment-${index}`, index, title: index === 1 ? '自动图片产物' : '真实图片输入',
      globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10, content: '李云听雨，随后走近门口。',
      summary: '听雨', sourceSceneIds: ['qa-scene'], sourceBeatIds: [], narrativePurpose: '观察',
      entryState: '', exitState: '', transitionHint: '', storyboardId: `qa-board-${index}`, status: 'ready' }));
    for (const segment of segments) {
      const id = segment.storyboardId; const assetId = segment.index === 1 ? 'qa-generated' : 'qa-input';
      const prompts = [
        '【0s-5s】主体：李云；动作：李云听雨；空间：客栈；光影：烛光；镜头：中景；台词：无；音效：雨声。',
        '【5s-10s】主体：李云；动作：李云走近门口；空间：客栈；光影：烛光；镜头：跟拍；台词：无；音效：雨声。',
      ];
      const canonical = prompts.join('\n\n');
      const board = { id, chapterId, sceneId: 'qa-scene', sourceStoryTitle: segment.title,
        sourceStoryContent: segment.content, workflow: 'drama', inputMode: 'text', durationSec: 10,
        durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
        stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId,
        converterPresetId: state.converterPresets.find((item) => item.enabled)?.id, globalLock: '', finalPrompt: canonical,
        ...(segment.index === 2 ? { globalReferenceAssetIds: [assetId] } : {}),
        shots: prompts.map((prompt, index) => ({ id: `${id}-shot-${index}`, index: index + 1, startSec: index * 5,
          endSec: (index + 1) * 5, purpose: '观察', subject: '李云', action: '李云听雨并走近门口', camera: '跟拍', lighting: '烛光',
          transition: '连续', sound: '雨声', result: '靠近门口', referenceAssetIds: index ? [] : [assetId], prompt, locked: false })),
        promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'qa-converter', sourceDocumentIds: [],
          referenceAssetIds: segment.index === 2 ? [assetId] : [], generatedAt: now, mode: 'text-api', shotPlanMode: 'ai-complete',
          convertedPromptFingerprint: sourceContentHash(canonical) },
        sequencePlanId: 'qa-plan', segmentId: segment.id, segmentIndex: segment.index, segmentCount: 2,
        createdAt: now, updatedAt: now };
      const official = applyOfficialH3Prompt(board, sourceContext);
      const en = official.officialPromptZh.replaceAll('李云', 'Li Yun');
      official.officialPromptEn = en; official.officialPromptEnSource = official.officialPromptZh;
      official.englishPrompt = en; official.englishPromptSource = official.officialPromptZh;
      if (!hasCurrentOfficialH3EnglishPrompt(official, sourceContext)) throw new Error('Fixture must start with a real current bilingual H3 artifact');
      project.storyboards.push(official);
    }
    project.scenes = [{ id: 'qa-scene', chapterId, title: '听雨', content: segments[0].content, summary: '听雨',
      characterIds: [], propIds: [], storyboardIds: project.storyboards.map((board) => board.id), createdAt: now, updatedAt: now }];
    project.sequencePlans = [{ id: 'qa-plan', chapterId, title: '删除图片验证计划', sourceStoryTitle: '听雨', sourceStoryContent: segments[0].content,
      durationMode: 'fixed', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural',
      planningMode: 'semantic-segments', planningStage: 'segmented', fitStatus: 'balanced', segments, createdAt: now, updatedAt: now }];
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi.enabled = false; state.settings.imageApi.enabled = false;
    state.settings.textApiProfiles = []; state.settings.imageApiProfiles = [];
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api'; state.settings.videoApiProfiles = [];
    state.settings.activeVideoApiProfileId = null;
    state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: false, endpoint: `${location.origin}/__no-api/video`, apiKey: '' };
    state.settings.uiFontScalePercent = 100;
    const choices = videoPromptChoices(project);
    if (choices.length !== 4) throw new Error(`Expected four valid initial language choices; got ${choices.length}`);
    localStorage.setItem(key, serializeStateForStorage(state).serialized);
    return { boards: project.storyboards.map((board) => ({ id: board.id, canonical: board.finalPrompt, zh: board.officialPromptZh, en: board.officialPromptEn })) };
  }, storageKey);
  await page.reload({ waitUntil: 'networkidle' });
  const sidebar = page.locator('.sidebar');
  await sidebar.getByRole('button', { name: '资产库', exact: true }).click();
  await page.locator('#asset-card-qa-generated').getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('#asset-card-qa-generated').waitFor({ state: 'detached' });
  await sidebar.getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const panel = page.locator('.vd-batch-panel');
  const first = panel.locator('.vd-batch-row').nth(0);
  assert.equal(await first.getByRole('button', { name: '中文', exact: true }).isEnabled(), true);
  assert.equal(await first.getByRole('button', { name: '英文', exact: true }).isEnabled(), true);
  assert.equal(await first.getByRole('checkbox').isEnabled(), true);
  for (const [language, body] of [['中文', fixture.boards[0].zh], ['英文', fixture.boards[0].en]]) {
    await first.getByRole('button', { name: language, exact: true }).click();
    await first.getByRole('button', { name: '预览', exact: true }).click();
    assert.equal(await panel.locator('.vd-batch-preview .vd-prompt-preview').textContent(), body);
  }
  await screenshot('01-generated-image-deleted-bilingual-ready.png');
  stages.push('Actual generated image deletion preserves both preview bodies and selectable video candidate');

  await sidebar.getByRole('button', { name: '资产库', exact: true }).click();
  await page.locator('#asset-card-qa-input').getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('#asset-card-qa-input').waitFor({ state: 'detached' });
  await sidebar.getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const second = panel.locator('.vd-batch-row').nth(1);
  assert.equal(await second.getByRole('checkbox').isDisabled(), true);
  const preview = panel.locator('.vd-batch-preview');
  for (const [language, body] of [['中文', fixture.boards[1].zh], ['英文', fixture.boards[1].en]]) {
    await second.getByRole('button', { name: language, exact: true }).click();
    await second.getByRole('button', { name: '预览', exact: true }).click();
    await preview.getByRole('button', { name: '复制原稿', exact: true }).waitFor();
    assert.equal(await preview.locator('.vd-prompt-preview').textContent(), body);
    assert.match(await preview.innerText(), /参考图待更新/u);
    await preview.getByRole('button', { name: '复制原稿', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__assetDeletionCopied), body);
  }
  await screenshot('02-real-input-deleted-readonly-preview.png');
  await preview.getByRole('button', { name: '回提示词导演台更新参考图', exact: true }).click();
  await page.locator('.prompt-source-saved-text').waitFor();
  assert.equal(await page.locator('.prompt-source-saved-text').textContent(), fixture.boards[1].canonical);
  assert.match(await page.locator('.sidebar .nav-item.active').innerText(), /提示词导演台/u);
  await screenshot('03-return-to-prompt-source.png');
  stages.push('Deleted real input shows exact Chinese/English read-only preview, copied bytes, and working source navigation');
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    return state.project?.id === 'qa-delete-project' && state.project.assets.length === 0;
  }, storageKey);
  const saved = await page.evaluate((key) => {
    const project = JSON.parse(localStorage.getItem(key)).project;
    return { boards: project.storyboards.map((board) => ({ id: board.id, canonical: board.finalPrompt, zh: board.officialPromptZh, en: board.officialPromptEn })), tasks: project.generationTasks.length };
  }, storageKey);
  assert.deepEqual(saved.boards, fixture.boards);
  assert.equal(saved.tasks, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {}); }
finally {
  harness.markElectronStopping();
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  const report = { passed: !failure, output, isolatedBrowserStorage: true, productionDataRead: false, noGenerationSubmitted: true,
    stages, requests, errors, ...(failure ? { failure: String(failure.stack || failure) } : {}) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
