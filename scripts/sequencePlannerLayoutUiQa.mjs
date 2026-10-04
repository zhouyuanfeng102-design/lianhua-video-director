import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Ordinary Playwright regression, using an isolated browser profile and a
// deterministic persisted AI plan. No production project or API is accessed.
const root = path.resolve(import.meta.dirname, '..');
const phase = process.env.QA_EXPECT_BROKEN === '1' ? 'before' : 'after';
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'sequence-planner-layout', phase));
const relative = path.relative(outputBase, outputDirectory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Planner QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Planner QA output cannot traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'sequence planner layout QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let page;
const errors = [];
const records = [];
const steps = [];
const mockApiCalls = [];
const snapshot = () => page.locator('.sequence-planner-panel').ariaSnapshot();

const measure = (label) => page.evaluate((name) => {
  const rect = (element) => {
    if (!element || !element.getClientRects().length) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const editor = document.querySelector('.sequence-segment-editor');
  const grid = document.querySelector('.sequence-editor-grid');
  const fields = [...(grid?.querySelectorAll('.field') || [])].map((field) => {
    const control = field.querySelector('input, textarea');
    return { name: control?.getAttribute('aria-label'), rect: rect(field), label: rect(field.querySelector('label')), control: rect(control) };
  });
  const overlaps = [];
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i + 1; j < fields.length; j += 1) {
      const a = fields[i].control; const b = fields[j].rect;
      if (a && b && a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1) overlaps.push([fields[i].name, fields[j].name]);
    }
  }
  const footer = document.querySelector('.sequence-plan-footer');
  const confirm = footer?.querySelector('button:last-child');
  const target = rect(confirm);
  const hit = target && document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2);
  return {
    label: name, viewport: { width: innerWidth, height: innerHeight }, scale: document.querySelector('.app-shell')?.dataset.uiFontScale,
    planner: rect(document.querySelector('.sequence-planner-panel')), source: rect(document.querySelector('.director-source-card')),
    editor: rect(editor), editorClientHeight: editor?.clientHeight, editorScrollHeight: editor?.scrollHeight,
    editorOverflow: editor && getComputedStyle(editor).overflowY, gridRows: grid && getComputedStyle(grid).gridTemplateRows,
    footer: rect(footer), confirm: target, confirmHit: Boolean(hit && (hit === confirm || confirm.contains(hit))),
    master: rect(document.querySelector('.sequence-master-review')), fields, overlaps,
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
  };
}, label);

const installFixture = async (scale, stage = 'segmented') => {
  await page.evaluate(({ key, fontScale, apiBaseUrl, planningStage }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const actions = ['推开木门', '走上廊桥', '停在扶栏边', '望向远方', '拿出信封', '打开信封', '展开信纸', '读完信件', '抬头看天', '收起信纸', '转身回望', '走回木门', '关上木门', '沿台阶下行', '走入庭院'];
    const source = actions.map((action) => `林澜${action}，衣摆随着身体动作轻轻摆动，视线保持朝向动作目标，画面可以看清完整动作与结束姿态。廊桥扶栏的木纹在柔光下清晰可见，桥面微微反射庭院的绿色，远方树影在风中轻轻移动。林澜站稳后调整呼吸，视线沿着桥面缓慢移动，手指自然地扶在身旁，肩膀与身体的朝向保持连续。`).join('\n\n');
    const scene = { id: 'planner-layout-scene', title: '廊桥来信', content: source, summary: '林澜在廊桥读信后走入庭院', characterIds: [], propIds: [], locationIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    state.project = { ...state.project, id: 'planner-layout-project', name: '全片规划隔离验收', sourceDocuments: [{ id: 'planner-layout-source', name: '廊桥来信', content: source, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [], sequencePlans: [], assets: [], characters: [], locations: [], props: [], generationTasks: [], directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined, updatedAt: now };
    state.projects = [state.project]; state.activeProjectId = state.project.id; state.settings.uiFontScalePercent = fontScale;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[name].enabled = false;
    if (planningStage === 'master-draft') state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBaseUrl, apiKey: '', model: 'planner-layout-mock' };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, fontScale: scale, apiBaseUrl: new URL('planner-layout/v1', baseUrl).toString(), planningStage: stage });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key))?.project?.directorSettingsConfirmedFingerprint, storageKey);
  await page.evaluate(async ({ key, planningStage }) => {
    const { buildLocalSequencePlan, extractStoryBeats, validateSequencePlan } = await import('/src/storySegmentation.ts');
    const { masterPromptConfirmationFingerprint } = await import('/src/masterTimeline.ts');
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const now = Date.now();
    const source = project.sourceDocuments[0];
    const plan = buildLocalSequencePlan({ title: source.name, story: source.content, totalDurationSec: 225, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [project.scenes[0].id] });
    const beats = extractStoryBeats(source.content);
    const masterId = 'planner-layout-master';
    const shots = plan.segments.map((segment, index) => {
      const owned = beats.filter((beat) => segment.sourceBeatIds.includes(beat.id));
      const prompt = `【${index * 15}s-${(index + 1) * 15}s】主体：@林澜（平静专注）[朝向：廊桥前方] 正在 [${segment.content}]（推进廊桥来信事件）；空间：前景木质扶栏，中景林澜，背景廊桥和庭院；光影：柔和自然侧光照亮脸部和衣摆；镜头：稳定中景缓慢跟随；台词：无；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
      return { id: `planner-layout-shot-${index}`, index: index + 1, startSec: index * 15, endSec: (index + 1) * 15, subject: '林澜', action: segment.content, purpose: '推进廊桥来信事件', camera: '稳定中景缓慢跟随', lighting: '柔和自然侧光', sound: '', transition: '自然承接', result: segment.exitState, sourceBeatIds: segment.sourceBeatIds, sourceStart: owned[0].sourceStart, sourceEnd: owned.at(-1).sourceEnd, referenceAssetIds: [], prompt, locked: false };
    });
    const board = { id: masterId, sceneId: project.scenes[0].id, sequencePlanId: plan.id, sourceStoryTitle: source.name, sourceStoryContent: source.content, workflow: 'drama', inputMode: 'text', durationSec: 225, durationPreset: 'custom', shotMode: 'auto', shotCount: shots.length, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', shots, finalPrompt: shots.map((shot) => shot.prompt).join('\n'), targetModelId: 'minimax-h3', promptTrace: { shotPlanMode: 'ai-complete', mode: 'text-api', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [source.id], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    plan.masterStoryboardId = masterId; plan.planningStage = 'segmented'; plan.segmentationSource = 'ai'; plan.segmentationReason = '隔离夹具：完整镜头与剧情边界'; plan.fitStatus = 'balanced';
    plan.masterPromptDirectorSettingsFingerprint = project.directorSettingsConfirmedFingerprint; plan.masterPromptDirectorSettingsConfirmedAt = now;
    plan.segments.forEach((segment, index) => { segment.title = `第${index + 1}段 · 廊桥来信`; segment.sourceShotIds = [shots[index].id]; segment.boundaryReason = '在完整动作结束后切段'; segment.continuityPack = '保持人物姿态、衣着、位置与光线连续'; });
    plan.masterPromptConfirmedAt = now; plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, board);
    if (planningStage === 'master-draft') { plan.planningStage = planningStage; plan.segments = []; delete plan.masterPromptConfirmedFingerprint; delete plan.masterPromptConfirmedAt; }
    const issues = validateSequencePlan(plan, { requireMasterStoryboard: true, storyboards: [board] });
    if (issues.length) throw new Error(`Invalid isolated planner fixture: ${issues.join('; ')}`);
    project.storyboards = [board]; project.sequencePlans = [plan]; state.projects = [project]; localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, planningStage: stage });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator(stage === 'segmented' ? '.sequence-plan-workspace' : '.sequence-master-review').waitFor();
  await page.evaluate(() => document.fonts.ready);
};

const run = async () => {
  await waitForCondition({ label: 'planner Vite ready', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 }); page = await context.newPage(); page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push(`Unexpected external request ${route.request().url()}`); await route.abort('blockedbyclient'); });
  await page.route((url) => url.origin === new URL(baseUrl).origin, async (route) => {
    if (route.request().url().endsWith('/planner-layout/v1/chat/completions')) {
      try {
        const payload = route.request().postDataJSON();
        const prompt = payload.messages.filter((message) => message.role === 'user').map((message) => message.content).filter((content) => typeof content === 'string').join('\n');
        const match = prompt.match(/<ai_segmentation_data>\s*([\s\S]*?)\s*<\/ai_segmentation_data>/u);
        assert.ok(match, 'only the real AI segmentation protocol is mocked by this layout regression');
        const data = JSON.parse(match[1]);
        const segments = data.masterShots.map((shot, index) => ({
          title: `第${index + 1}段 · API确认分段`, summary: `按第${index + 1}镜推进当前剧情`, sourceShotIds: [shot.id], sourceBeatIds: shot.sourceBeatIds,
          boundaryAfterShotId: shot.id, durationSec: shot.endSec - shot.startSec, globalStartSec: shot.startSec, globalEndSec: shot.endSec,
          narrativePurpose: '推进廊桥来信事件', entryState: index ? `承接第${index}段结束时人物、道具和光线状态` : '保持廊桥开场状态', exitState: `完成第${index + 1}镜动作后的可见状态`,
          transitionHint: '完整动作结束后切换，保持空间与视线连续', boundaryReason: '完整镜头和动作边界', continuityPack: '保持人物、服装、光线与空间连续',
        }));
        mockApiCalls.push({ kind: 'segmentation', segments: segments.length });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reason: '隔离API依据完整母镜头边界分段', segments }) } }] }) });
      } catch (error) { errors.push(error.message); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Planner layout mock failed' } }) }); }
    } else if (!['GET', 'HEAD'].includes(route.request().method())) { errors.push('Unexpected API request'); await route.abort('blockedbyclient'); } else await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  for (const scale of [100, 150]) {
    await installFixture(scale);
    for (const viewport of [{ width: 1120, height: 720 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const label = `${phase}-${viewport.width}x${viewport.height}-${scale}`;
      const result = await measure(label); records.push(result);
      fs.writeFileSync(path.join(outputDirectory, `${label}.aria.txt`), await snapshot());
      await page.screenshot({ path: path.join(outputDirectory, `${label}.png`), fullPage: false });
      if (phase === 'before') continue;
      assert.equal(result.overlaps.length, 0, `${label}: fields overlap`);
      assert.equal(result.fields.length, 7, `${label}: seven editable fields must remain available`);
      assert.ok(result.fields.every((field) => field.label.bottom <= field.control.y && field.control.height >= 28 && field.control.bottom <= field.rect.bottom + 1), `${label}: field label/control clipped`);
      assert.ok(result.confirmHit && result.confirm.bottom <= viewport.height, `${label}: confirmation action not visible/clickable`);
      assert.equal(result.documentOverflow, false, `${label}: document overflow`);
      if (result.editorScrollHeight > result.editorClientHeight + 1) assert.equal(result.editorOverflow, 'auto', `${label}: overflowing editor must scroll, not clip`);
      for (const field of result.fields) {
        const control = page.getByLabel(field.name, { exact: true }); await control.scrollIntoViewIfNeeded();
        const reachable = await control.evaluate((element) => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === element || element.contains(hit); });
        assert.ok(reachable, `${label}: ${field.name} cannot be reached by scrolling`);
      }
      await page.locator('.sequence-segment-editor').evaluate((element) => { element.scrollTop = 0; });
      await page.getByRole('tab', { name: '全片总提示词', exact: true }).click();
      const master = page.getByLabel('全片总视频提示词'); await master.waitFor();
      assert.ok((await master.boundingBox()).height >= 160, `${label}: master editor must have useful review height`);
      await page.screenshot({ path: path.join(outputDirectory, `${label}-master.png`), fullPage: false });
      await page.getByRole('tab', { name: '分段编辑（15）', exact: true }).click();
    }
  }
  if (phase === 'before') {
    assert.ok(records.some((record) => record.overlaps.length || record.fields.some((field) => field.control.bottom > field.rect.bottom + 1)), 'Before mode must reproduce real field overlap/clipping');
    return;
  }
  await page.getByLabel('段标题', { exact: true }).fill('已保存的第一段标题');
  await page.getByLabel('可拍摄摘要', { exact: true }).fill('验证摘要保存且不串段');
  await page.locator('.sequence-plan-workspace .sequence-segment-chip').nth(1).click();
  assert.notEqual(await page.getByLabel('段标题', { exact: true }).inputValue(), '已保存的第一段标题');
  await page.locator('.sequence-plan-workspace .sequence-segment-chip').first().click();
  assert.equal(await page.getByLabel('段标题', { exact: true }).inputValue(), '已保存的第一段标题');
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.sequencePlans[0].segments[0].summary === '验证摘要保存且不串段', storageKey);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  assert.equal(await page.getByLabel('段标题', { exact: true }).inputValue(), '已保存的第一段标题');
  assert.equal(await page.getByLabel('可拍摄摘要', { exact: true }).inputValue(), '验证摘要保存且不串段');
  steps.push('title/summary edits persist across segment changes and real reload');
  await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
  await page.getByLabel('全片总秒数', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '225');
  await page.getByRole('button', { name: '收起规划参数', exact: true }).click();
  await page.getByRole('button', { name: '确认分段，进入③单段导演', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '③ 单段导演', exact: true }).getAttribute('aria-selected'), 'true');
  steps.push('planning settings remain accessible and confirmation enters single-segment director');
  await page.setViewportSize({ width: 1120, height: 720 });
  await installFixture(150, 'master-draft');
  const masterText = await page.getByLabel('全片总视频提示词', { exact: true }).inputValue();
  await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
  const expandedReview = await page.locator('.sequence-master-review').evaluate((element) => {
    const body = element.querySelector('.sequence-master-review-body').getBoundingClientRect();
    const editor = element.querySelector('textarea').getBoundingClientRect();
    const actions = element.querySelector('.sequence-master-review-actions').getBoundingClientRect();
    return { bodyBottom: body.bottom, editorBottom: editor.bottom, actionsTop: actions.top };
  });
  assert.ok(expandedReview.editorBottom <= expandedReview.bodyBottom + 1 && expandedReview.bodyBottom <= expandedReview.actionsTop + 1, 'expanded options must not make the master editor overlap its actions');
  await page.getByRole('button', { name: '收起规划参数', exact: true }).click();
  await page.getByRole('button', { name: '确认总提示词', exact: true }).click();
  await page.getByRole('button', { name: '② AI 按剧情边界分段', exact: true }).click();
  await page.locator('.sequence-plan-workspace:not([hidden])').waitFor();
  assert.equal(await page.locator('.sequence-plan-workspace .sequence-segment-chip').count(), 15);
  assert.equal(await page.getByRole('tab', { name: '分段编辑（15）', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '全片总提示词', exact: true }).click();
  assert.equal(await page.getByLabel('全片总视频提示词', { exact: true }).inputValue(), masterText);
  await page.getByRole('tab', { name: '分段编辑（15）', exact: true }).click();
  await page.getByRole('button', { name: '确认分段，进入③单段导演', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '③ 单段导演', exact: true }).getAttribute('aria-selected'), 'true');
  steps.push('master review → confirmation → isolated API split automatically opens 15 editable segments without changing master text');
  assert.deepEqual(mockApiCalls, [{ kind: 'segmentation', segments: 15 }]);
  assert.deepEqual(errors, []);
};

let failure;
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(outputDirectory, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); } }
finally {
  harness.markElectronStopping();
  await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify({ phase, errors, records, steps, mockApiCalls, failure: failure?.stack }, null, 2));
  fs.writeFileSync(path.join(outputDirectory, 'vite.log'), harness.readElectronLog());
}
if (failure) throw failure;
console.log(`Sequence planner layout QA passed (${phase}): ${records.length} viewport/font cases; ${steps.join('; ')}`);
