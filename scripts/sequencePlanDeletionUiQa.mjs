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
// Serve the already built renderer; bundle only the isolated synthetic fixture helpers.
const bootstrap = `import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import {build} from 'esbuild';
const fixture=await build({stdin:{contents:"export { createInitialState, serializeStateForStorage } from './src/storage'; export { applyOfficialH3Prompt } from './src/officialPrompt'; export { sourceContentHash } from './src/sourceContentHash';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const base=path.resolve('dist'); const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer((request,response)=>{const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);if(pathname==='/__qa_fixture.mjs'){response.writeHead(200,{'content-type':'text/javascript'});response.end(fixture.outputFiles[0].text);return;} const target=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));if(!target.startsWith(base+path.sep)){response.writeHead(403);response.end();return;}try{const body=fs.readFileSync(target);response.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream'});response.end(body);}catch{response.writeHead(404);response.end();}});server.listen(${port},'127.0.0.1');`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'sequence plan deletion browser QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
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
const planFilter = () => page.locator('.storyboard-plan-filter select[aria-label="筛选分镜方案"]');
const assertVisiblePlan = async (id) => {
  await group(id).waitFor();
  assert.equal(await page.locator('.storyboard-sequence-group').count(), 1);
  assert.equal(await planFilter().inputValue(), id);
};
const assertBoard = async (board) => {
  await page.waitForFunction((prompt) => document.querySelector('.prompt-preview .prompt-copy')?.textContent === prompt, board.finalPrompt);
};
const selectPlan = async (id, board) => {
  await planFilter().selectOption(id);
  await assertVisiblePlan(id);
  assert.equal(await group(id).locator('button.active').count(), 1);
  assert.match(await group(id).locator('button.active').getAttribute('aria-label') || await group(id).locator('button.active').innerText(), /第 1 段/u);
  if (board) await assertBoard(board);
};
const deletePlan = async (id, accept) => {
  await assertVisiblePlan(id);
  const handled = page.waitForEvent('dialog').then(async (dialog) => {
    assert.equal(dialog.type(), 'confirm');
    assert.match(dialog.message(), /删除/u);
    if (accept) await dialog.accept(); else await dialog.dismiss();
  });
  await Promise.all([handled, page.locator('.storyboard-plan-filter .storyboard-sequence-delete').click()]);
};
const run = async () => {
  await waitForCondition({ label: 'isolated static renderer startup', timeoutMs: 30_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol) || (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/__no-api'))) {
      await route.continue(); return;
    }
    requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
    await route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar .nav-item').first().waitFor();
  const fixture = await page.evaluate(async (key) => {
    const { createInitialState, serializeStateForStorage, applyOfficialH3Prompt, sourceContentHash } = await import('/__qa_fixture.mjs');
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
    for (const [planId, boardId, segmentCount, createdAt, actor] of [
      ['qa-plan-delete', 'qa-board-delete', 12, Date.parse('2026-10-15T05:32:15.000Z'), '李云'],
      ['qa-plan-keep', 'qa-board-keep', 7, Date.parse('2026-10-14T01:11:30.000Z'), '周明'],
    ]) {
      const segments = Array.from({ length: segmentCount }, (_, offset) => offset + 1).map((index) => ({ id: `${planId}-segment-${index}`, index, title: index === 1 ? '听雨' : '待生成后续',
        globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10, content: source,
        summary: '听雨', sourceSceneIds: ['qa-scene'], sourceBeatIds: [], narrativePurpose: '观察',
        entryState: '', exitState: '', transitionHint: '', ...(index === 1 ? { storyboardId: boardId } : {}), status: index === 1 ? 'ready' : 'pending' }));
      const prompts = [`【0s-5s】主体：${actor}；动作：${actor}听雨；空间：客栈；光影：烛光；镜头：中景；台词：无；音效：雨声。`,
        `【5s-10s】主体：${actor}；动作：${actor}走近门口；空间：客栈；光影：烛光；镜头：跟拍；台词：无；音效：雨声。`];
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
        sequencePlanId: planId, segmentId: segments[0].id, segmentIndex: 1, segmentCount, createdAt, updatedAt: createdAt };
      const official = applyOfficialH3Prompt(board, sourceContext);
      official.officialPromptEn = official.officialPromptZh.replaceAll('李云', 'Li Yun'); official.officialPromptEnSource = official.officialPromptZh;
      official.englishPrompt = official.officialPromptEn; official.englishPromptSource = official.officialPromptZh;
      project.storyboards.push(official);
      project.sequencePlans.push({ id: planId, chapterId, title: '同名方案', sourceStoryTitle: '同名方案', sourceStoryContent: source,
        durationMode: 'fixed', totalDurationSec: segmentCount * 10, segmentDurationSec: 10, segmentationMode: 'natural',
        planningMode: 'semantic-segments', planningStage: 'segmented', fitStatus: 'balanced', segments, createdAt, updatedAt: createdAt });
    }
    for (const [id, actor, unlinked] of [['qa-board-standalone', '陈青', false], ['qa-board-unlinked', '赵河', true]]) {
      const extra = structuredClone(project.storyboards[0]);
      extra.id = id; extra.sourceStoryTitle = unlinked ? '未关联分镜' : '独立分镜';
      extra.finalPrompt = extra.finalPrompt.replaceAll('李云', actor);
      extra.shots = extra.shots.map((shot, index) => ({ ...shot, id: `${id}-shot-${index}`, prompt: shot.prompt.replaceAll('李云', actor) }));
      delete extra.sequencePlanId; delete extra.segmentId; delete extra.segmentIndex; delete extra.segmentCount;
      if (unlinked) { extra.sequencePlanId = 'qa-missing-plan'; extra.segmentId = 'qa-missing-segment'; extra.segmentIndex = 3; }
      extra.promptTrace.convertedPromptFingerprint = sourceContentHash(extra.finalPrompt);
      project.storyboards.push(extra);
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
    return { chapterId, asset, task, boards: project.storyboards };
  }, storageKey);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '分镜时间线', exact: true }).click();
  await assertVisiblePlan('qa-plan-delete');
  const options = await planFilter().locator('option').evaluateAll((items) => items.map((item) => ({ value: item.value, label: item.label })));
  assert.deepEqual(options.slice(0, 2).map((item) => item.value), ['qa-plan-delete', 'qa-plan-keep']);
  assert.match(options.find((item) => item.value === 'qa-plan-delete').label, /第 2 版方案.*12 段.*120s.*2026\/10\/15.*13:32:15/u);
  assert.match(options.find((item) => item.value === 'qa-plan-keep').label, /第 1 版方案.*7 段.*70s.*2026\/10\/14.*09:11:30/u);
  assert.ok(options.some((item) => item.value === '__standalone__' && /独立分镜/u.test(item.label)));
  assert.ok(options.some((item) => item.value === '__unlinked__' && /未关联/u.test(item.label)));
  const before = await readProject();
  const deleteBoard = before.storyboards.find((item) => item.id === 'qa-board-delete');
  const keepBoard = before.storyboards.find((item) => item.id === 'qa-board-keep');
  await assertBoard(deleteBoard);
  assert.equal(await group('qa-plan-delete').locator('button.segment').count(), 12);

  // Switching never edits plan contents or prompts, including ungenerated segments.
  await group('qa-plan-delete').getByRole('button', { name: /第 2 段/u }).click();
  assert.equal(await group('qa-plan-delete').locator('button.active').count(), 1);
  assert.match(await group('qa-plan-delete').locator('button.active').getAttribute('aria-label') || '', /第 2 段/u);
  await page.locator('.prompt-preview .prompt-copy').waitFor({ state: 'detached' });
  await selectPlan('qa-plan-keep', keepBoard);
  await selectPlan('qa-plan-delete', deleteBoard);
  for (const [filterId, boardId] of [['__standalone__', 'qa-board-standalone'], ['__unlinked__', 'qa-board-unlinked']]) {
    await planFilter().selectOption(filterId);
    assert.equal(await planFilter().inputValue(), filterId);
    assert.equal(await page.locator('.storyboard-sequence-group').count(), 0);
    await assertBoard(before.storyboards.find((item) => item.id === boardId));
  }
  await selectPlan('qa-plan-delete', deleteBoard);
  const filtered = await readProject();
  assert.deepEqual(filtered.sequencePlans, before.sequencePlans);
  assert.deepEqual(filtered.storyboards, before.storyboards);
  assert.deepEqual(filtered.assets, before.assets); assert.deepEqual(filtered.generationTasks, before.generationTasks);
  stages.push('Version options show creation time, segment count and duration; one plan is visible; switching selects the correct first board, pending segments clear old prompts, independent/unlinked filters preserve contents');

  for (const [width, height] of [[1440, 1000], [1100, 850]]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator('.storyboard-switcher').evaluate((element) => {
      const deletion = element.querySelector('.storyboard-sequence-delete').getBoundingClientRect();
      const select = element.querySelector('.storyboard-plan-filter select').getBoundingClientRect();
      const segments = [...element.querySelectorAll('button.segment')].map((button) => button.getBoundingClientRect());
      const overlaps = (left, right) => left.width > 0 && right.width > 0 && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      return { right: deletion.right, width: innerWidth, filterOverlap: overlaps(deletion, select),
        overlap: segments.some((rect) => overlaps(deletion, rect) || overlaps(select, rect)),
        segmentOverlap: segments.some((rect, index) => segments.slice(index + 1).some((other) => overlaps(rect, other))),
        segmentOutside: segments.some((rect) => rect.left < 0 || rect.right > innerWidth + 1),
        maxSegmentHeight: Math.max(...segments.map((rect) => rect.height)),
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(geometry.filterOverlap, false); assert.equal(geometry.overlap, false); assert.equal(geometry.segmentOverlap, false);
    assert.equal(geometry.segmentOutside, false); assert.equal(geometry.overflow, false); assert.ok(geometry.right <= geometry.width);
    assert.ok(geometry.maxSegmentHeight <= 86, `Segment cards should stay compact: ${JSON.stringify(geometry)}`);
    await screenshot(`01-filter-twelve-segments-${width}.png`);
    await page.locator('.storyboard-switcher').screenshot({ path: path.join(output, `01-filter-card-${width}.png`) });
  }
  stages.push('12-segment grid at 1440px and 1100px stays compact, with no filter/delete/segment overlap or horizontal overflow');

  await deletePlan('qa-plan-delete', false);
  await assertVisiblePlan('qa-plan-delete');
  assert.deepEqual((await readProject()).sequencePlans, before.sequencePlans);
  assert.deepEqual((await readProject()).storyboards, before.storyboards);
  stages.push('Cancel keeps the selected filter, both same-title plans and prompts unchanged');

  await deletePlan('qa-plan-delete', true);
  await group('qa-plan-delete').waitFor({ state: 'detached' });
  await waitForPlanCount(1);
  const deleted = await readProject();
  assert.deepEqual(deleted.sequencePlans.map((plan) => plan.id), ['qa-plan-keep']);
  assert.deepEqual(deleted.storyboards.map((board) => board.id), ['qa-board-keep', 'qa-board-standalone', 'qa-board-unlinked']);
  assert.deepEqual(deleted.storyboards[0], before.storyboards.find((board) => board.id === 'qa-board-keep'));
  assert.deepEqual(deleted.assets, before.assets);
  assert.deepEqual(deleted.generationTasks, before.generationTasks);
  assert.ok(!deleted.scenes[0].storyboardIds.includes('qa-board-delete'));
  await assertVisiblePlan('qa-plan-keep');
  assert.equal(await group('qa-plan-keep').locator('button.active').count(), 1);
  await assertBoard(keepBoard);
  await screenshot('02-deleted-one-plan-fallback.png');
  stages.push('Confirm removes only the selected plan and owned storyboard, preserves media/tasks and other prompt, selects remaining plan');

  await page.getByTitle('撤销（Ctrl+Z）', { exact: true }).click();
  await waitForPlanCount(2);
  assert.equal(await planFilter().locator('option[value="qa-plan-delete"]').count(), 1);
  const afterUndoSelection = await planFilter().inputValue();
  assert.ok(['qa-plan-delete', 'qa-plan-keep'].includes(afterUndoSelection));
  await assertVisiblePlan(afterUndoSelection);
  const undone = await readProject();
  assert.deepEqual(undone.sequencePlans, before.sequencePlans);
  assert.deepEqual(undone.storyboards, before.storyboards);
  assert.deepEqual(undone.assets, before.assets); assert.deepEqual(undone.generationTasks, before.generationTasks);
  await selectPlan('qa-plan-delete', deleteBoard);
  await screenshot('03-undo-restores-plan.png');
  stages.push('Toolbar undo restores deleted plan and exact prompts');

  await deletePlan('qa-plan-delete', true); await waitForPlanCount(1);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '分镜时间线', exact: true }).click();
  await assertVisiblePlan('qa-plan-keep');
  assert.equal(await group('qa-plan-delete').count(), 0);
  assert.equal(await planFilter().locator('option[value="qa-plan-delete"]').count(), 0);
  await assertBoard(keepBoard);
  const reloaded = await readProject();
  assert.deepEqual(reloaded.storyboards, deleted.storyboards);
  assert.deepEqual(reloaded.assets, deleted.assets); assert.deepEqual(reloaded.generationTasks, deleted.generationTasks);
  await screenshot('04-reloaded-filter-fallback.png');
  stages.push('Saved state reload keeps the remaining plan selected and does not resurrect the deleted option');
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {}); }
finally {
  harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  const report = { passed: !failure, output, isolatedBrowserStorage: true, productionDataRead: false, noGenerationSubmitted: true,
    stages, requests, errors, ...(failure ? { failure: String(failure.stack || failure), startupLog: harness.readElectronLog() } : {}) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
