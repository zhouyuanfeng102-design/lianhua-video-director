import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Use new browser storage and synthetic content; never read the user's project
// or call generation services. Exercise the real timeline transaction and undo.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
fs.mkdirSync(outputBase, { recursive: true });
const output = fs.mkdtempSync(path.join(outputBase, 'sequence-plan-deletion-'));
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'sequence plan deletion browser QA', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const errors = []; const requests = []; const stages = [];
let browser; let context; let page; let failure;
const screenshot = async (name) => page.screenshot({ path: path.join(output, name), fullPage: false });
const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const waitForPlanCount = (count) => page.waitForFunction(({ key, count }) => {
  const project = JSON.parse(localStorage.getItem(key) || '{}').project;
  return project?.id === 'qa-sequence-delete-project' && project.sequencePlans.length === count;
}, { key: storageKey, count });
const group = (id) => page.locator(`.storyboard-sequence-group[data-plan-id="${id}"]`);
const deletePlan = async (id, accept) => {
  const handled = page.waitForEvent('dialog').then(async (dialog) => {
    assert.equal(dialog.type(), 'confirm');
    assert.match(dialog.message(), /删除/u);
    if (accept) await dialog.accept(); else await dialog.dismiss();
  });
  await Promise.all([handled, group(id).locator('.storyboard-sequence-delete').click()]);
};
const run = async () => {
  await waitForCondition({ label: 'isolated Vite startup', timeoutMs: 30_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
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
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceContentHash.ts');
    const state = createInitialState(); const now = Date.now();
    const chapterId = state.project.activeChapterId;
    const source = '李云听雨，随后走近门口。';
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#725fa8'; paint.fillRect(0, 0, 160, 90);
    const asset = { id: 'qa-retained-image', name: '删除方案后仍保留的图片', type: 'reference', role: 'composition', referenceRole: 'composition',
      mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 160, height: 90,
      source: 'generated', sourceStoryboardId: 'qa-board-delete', chapterId, tags: ['隔离测试'], createdAt: now, updatedAt: now };
    const task = { id: 'qa-retained-task', kind: 'video', storyboardId: 'qa-board-delete', sequencePlanId: 'qa-plan-delete',
      segmentId: 'qa-plan-delete-segment-1', targetId: 'minimax-h3', status: 'succeeded', requestBody: { prompt: '历史任务快照必须保留' }, createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'qa-sequence-delete-project', name: '分段方案删除隔离验证',
      characters: [], locations: [], props: [], storyboards: [], assets: [asset], sequencePlans: [], generationTasks: [task] };
    const sourceContext = { assets: [asset], characters: [], locations: [], props: [] };
    for (const [planId, boardId] of [['qa-plan-delete', 'qa-board-delete'], ['qa-plan-keep', 'qa-board-keep']]) {
      const segments = [1, 2].map((index) => ({ id: `${planId}-segment-${index}`, index, title: index === 1 ? '听雨' : '待生成后续',
        globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10, content: source,
        summary: '听雨', sourceSceneIds: ['qa-scene'], sourceBeatIds: [], narrativePurpose: '观察',
        entryState: '', exitState: '', transitionHint: '', ...(index === 1 ? { storyboardId: boardId } : {}), status: index === 1 ? 'ready' : 'pending' }));
      const prompts = ['【0s-5s】主体：李云；动作：李云听雨；空间：客栈；光影：烛光；镜头：中景；台词：无；音效：雨声。',
        '【5s-10s】主体：李云；动作：李云走近门口；空间：客栈；光影：烛光；镜头：跟拍；台词：无；音效：雨声。'];
      const canonical = prompts.join('\n\n');
      const board = { id: boardId, chapterId, sceneId: 'qa-scene', sourceStoryTitle: '同名方案', sourceStoryContent: source,
        workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2,
        pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
        ruleSetId: state.settings.defaultRuleSetId, converterPresetId: state.converterPresets.find((item) => item.enabled)?.id,
        globalLock: '', finalPrompt: canonical,
        shots: prompts.map((prompt, index) => ({ id: `${boardId}-shot-${index}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
          purpose: '观察', subject: '李云', action: '李云听雨并走近门口', camera: '跟拍', lighting: '烛光', transition: '连续', sound: '雨声',
          result: '靠近门口', referenceAssetIds: [], prompt, locked: false })),
        promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'qa-converter', sourceDocumentIds: [], referenceAssetIds: [],
          generatedAt: now, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical) },
        sequencePlanId: planId, segmentId: segments[0].id, segmentIndex: 1, segmentCount: 2, createdAt: now, updatedAt: now };
      const official = applyOfficialH3Prompt(board, sourceContext);
      official.officialPromptEn = official.officialPromptZh.replaceAll('李云', 'Li Yun'); official.officialPromptEnSource = official.officialPromptZh;
      official.englishPrompt = official.officialPromptEn; official.englishPromptSource = official.officialPromptZh;
      project.storyboards.push(official);
      project.sequencePlans.push({ id: planId, chapterId, title: '同名方案', sourceStoryTitle: '同名方案', sourceStoryContent: source,
        durationMode: 'fixed', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural',
        planningMode: 'semantic-segments', planningStage: 'segmented', fitStatus: 'balanced', segments, createdAt: now, updatedAt: now });
    }
    project.scenes = [{ id: 'qa-scene', chapterId, title: '听雨', content: source, summary: '听雨',
      characterIds: [], propIds: [], storyboardIds: project.storyboards.map((board) => board.id), createdAt: now, updatedAt: now }];
    project.chapterWorkspaces = { ...project.chapterWorkspaces, [chapterId]: { ...project.chapterWorkspaces?.[chapterId],
      directorControls: { activePlanId: 'qa-plan-delete', activeSegmentId: 'qa-plan-delete-segment-1', activeStoryboardId: 'qa-board-delete', productionMode: 'sequence' } } };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi.enabled = false; state.settings.imageApi.enabled = false;
    state.settings.textApiProfiles = []; state.settings.imageApiProfiles = [];
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api'; state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
    state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: false, endpoint: `${location.origin}/__no-api/video`, apiKey: '' };
    state.settings.uiFontScalePercent = 100;
    localStorage.setItem(key, serializeStateForStorage(state).serialized);
    return { chapterId, asset, task, keepBoard: project.storyboards[1] };
  }, storageKey);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '分镜时间线', exact: true }).click();
  await group('qa-plan-delete').waitFor(); await group('qa-plan-keep').waitFor();
  // Explicitly select the source to ensure the transaction exercises fallback.
  await group('qa-plan-delete').getByRole('button', { name: /第 1 段/u }).click();
  await screenshot('01-two-same-title-plans.png');
  const before = await readProject();
  await deletePlan('qa-plan-delete', false);
  assert.equal(await page.locator('.storyboard-sequence-group').count(), 2);
  assert.deepEqual((await readProject()).storyboards, before.storyboards);
  stages.push('Cancel leaves both same-title plans and prompts unchanged');

  await deletePlan('qa-plan-delete', true);
  await group('qa-plan-delete').waitFor({ state: 'detached' });
  await waitForPlanCount(1);
  const deleted = await readProject();
  assert.deepEqual(deleted.sequencePlans.map((plan) => plan.id), ['qa-plan-keep']);
  assert.deepEqual(deleted.storyboards.map((board) => board.id), ['qa-board-keep']);
  assert.deepEqual(deleted.storyboards[0], before.storyboards.find((board) => board.id === 'qa-board-keep'));
  assert.deepEqual(deleted.assets, before.assets);
  assert.deepEqual(deleted.generationTasks, before.generationTasks);
  assert.ok(!deleted.scenes[0].storyboardIds.includes('qa-board-delete'));
  assert.equal(await group('qa-plan-keep').locator('button.active').count(), 1);
  await screenshot('02-deleted-one-plan-fallback.png');
  stages.push('Confirm removes only the selected plan and owned storyboard, preserves media/tasks and other prompt, selects remaining plan');

  await page.getByTitle('撤销（Ctrl+Z）', { exact: true }).click();
  await group('qa-plan-delete').waitFor();
  await waitForPlanCount(2);
  const undone = await readProject();
  assert.deepEqual(undone.storyboards, before.storyboards);
  assert.deepEqual(undone.assets, before.assets); assert.deepEqual(undone.generationTasks, before.generationTasks);
  await screenshot('03-undo-restores-plan.png');
  stages.push('Toolbar undo restores deleted plan and exact prompts');

  await deletePlan('qa-plan-delete', true); await waitForPlanCount(1);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '分镜时间线', exact: true }).click();
  await group('qa-plan-keep').waitFor();
  assert.equal(await group('qa-plan-delete').count(), 0);
  const reloaded = await readProject();
  assert.deepEqual(reloaded.storyboards, deleted.storyboards);
  assert.deepEqual(reloaded.assets, deleted.assets); assert.deepEqual(reloaded.generationTasks, deleted.generationTasks);
  stages.push('Saved state reload does not resurrect the deleted plan');

  await page.setViewportSize({ width: 1100, height: 850 });
  const geometry = await group('qa-plan-keep').evaluate((element) => {
    const deletion = element.querySelector('.storyboard-sequence-delete').getBoundingClientRect();
    const segments = [...element.querySelectorAll('button')].filter((button) => !button.classList.contains('storyboard-sequence-delete')).map((button) => button.getBoundingClientRect());
    return { right: deletion.right, width: innerWidth, overlaps: segments.some((rect) => rect.width > 0 && deletion.left < rect.right && deletion.right > rect.left && deletion.top < rect.bottom && deletion.bottom > rect.top), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.equal(geometry.overlaps, false); assert.equal(geometry.overflow, false); assert.ok(geometry.right <= geometry.width);
  await screenshot('04-compact-no-overlap.png');
  stages.push('Compact viewport delete button remains visible without segment overlap or page overflow');
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {}); }
finally {
  harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  const report = { passed: !failure, output, isolatedBrowserStorage: true, productionDataRead: false, noGenerationSubmitted: true,
    stages, requests, errors, ...(failure ? { failure: String(failure.stack || failure) } : {}) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
