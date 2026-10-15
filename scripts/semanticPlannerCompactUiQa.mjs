import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Isolated real-App layout fixture. It never uses a production profile or API.
const root = path.resolve(import.meta.dirname, '..');
const phase = process.env.QA_PHASE || 'after';
const output = path.join(root, 'output', 'playwright', `semantic-planner-compact-${phase}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = await createServer({ root, plugins: [{ name: 'compact-planner-no-watch', configResolved(config) { config.server.watch = null; } }],
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.watcher.close(); await server.listen();
const origin = server.resolvedUrls.local[0]; const key = 'lianhua_video_director_state_v22';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(15_000);
const errors = []; const records = []; const steps = [];
let releaseHeldRequest; let localMockRequests = 0;
page.on('pageerror', (error) => errors.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(); const url = new URL(request.url());
  if (url.origin === new URL(origin).origin && url.pathname === '/__compact_planner_mock/v1/chat/completions' && request.method() === 'POST') {
    localMockRequests += 1;
    await new Promise((resolve) => { releaseHeldRequest = resolve; });
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Isolated request cancelled by layout QA.' } }) }).catch(() => {});
    return;
  }
  if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(origin).origin || !['GET', 'HEAD'].includes(request.method()))) {
    errors.push(`Blocked unauthorized request: ${request.method()} ${url.pathname}`); await route.abort(); return;
  }
  if (url.pathname === '/__compact_planner_fixture.html') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated fixture</body></html>' }); return; }
  await route.continue();
});
const seed = async (fontScale) => {
  await page.goto(`${origin}__compact_planner_fixture.html`);
  await page.evaluate(async ({ key, fontScale, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const actions = ['军阵让路与初次相见', '识别与数量优势的自我说服', '身份揭示与支配命令', '情报试探与拒绝投降', '来客抬手并收拢队形', '众人转身走入洞穴', '守军回望余下队伍'];
    const story = actions.map((action) => `林舟与苏禾${action}，保持原有位置与身份。`).join('\n');
    state.project = { ...state.project, id: 'compact-planner-project', name: '规划布局隔离验证', scenes: [], storyboards: [], sequencePlans: [],
      sourceDocuments: [{ id: 'compact-source', name: '雾中军阵与来者', content: story, createdAt: now, updatedAt: now }],
      characters: [], locations: [], props: [], assets: [], generationTasks: [] };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    state.settings.uiFontScalePercent = fontScale;
    for (const field of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi', 'runningHubVideo', 'comfyuiVideo']) if (state.settings[field]) state.settings[field].enabled = false;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: `${origin}__compact_planner_mock/v1`, apiKey: '', model: 'isolated-layout-mock', provider: 'openai_compatible' };
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key, fontScale, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.getByRole('button', { name: /确认全片导演参数，进入①/u }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.directorSettingsConfirmedFingerprint, key);
  await page.evaluate(async (key) => {
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const source = project.sourceDocuments[0];
    const parts = source.content.split('\n');
    const plan = materializeSemanticSequencePlan({ title: source.name, story: source.content, segmentDurationSec: 30,
      directorSettingsFingerprint: project.directorSettingsConfirmedFingerprint, creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' } },
      { segmentCount: parts.length, fitStatus: 'balanced', reason: 'Isolated layout fixture', segments: parts.map((content, index) => ({
        title: content.slice(5, -12), content, summary: content, narrativePurpose: '推进原剧情', entryState: '原位置', exitState: '原身份', transitionHint: '动作连续', boundaryReason: '动作完成', continuityPack: '人物位置身份不变',
        semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: `event-${index}`, description: content, phase: '推进中' }], dialogues: [] },
      })) }, { planId: 'compact-semantic-plan' });
    plan.segments[3].status = 'failed'; plan.segments[3].failureReason = '上游返回 HTTP 413：参考图片总大小超过限制，保留完整失败原因供查看。';
    project.sequencePlans = [plan]; state.projects = [project]; localStorage.setItem(key, JSON.stringify(state));
  }, key);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.sequence-planner-panel[data-planning-mode="semantic-segments"]').waitFor();
  if (await page.getByRole('button', { name: '展开规划参数', exact: true }).count()) await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
};
const measure = () => page.locator('.sequence-planner-panel').evaluate((panel) => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const selectors = ['.sequence-planner-head', '.sequence-planning-options', '.sequence-planning-options-head', '.sequence-director-settings-summary', '.sequence-planner-controls', '.sequence-semantic-actions', '.sequence-filmstrip', '.sequence-segment-editor'];
  const boxes = Object.fromEntries(selectors.map((selector) => [selector.slice(1), rect(panel.querySelector(selector))]));
  const controls = [...panel.querySelectorAll('.sequence-planning-options button, .sequence-planning-options input, .sequence-semantic-actions button')].filter((element) => element.offsetWidth > 0).map((element) => {
    const box = rect(element); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { name: element.getAttribute('aria-label') || element.textContent.trim(), rect: box, font: getComputedStyle(element).fontSize, reachable: hit === element || element.contains(hit), clipped: element.scrollWidth > element.clientWidth + 1 };
  });
  return { boxes, controls, topHeight: boxes['sequence-filmstrip'].bottom - boxes['sequence-planning-options'].y,
    panelWidth: panel.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    cardHeights: [...panel.querySelectorAll('.sequence-control-card')].map((el) => rect(el).height),
    chipHeight: rect(panel.querySelector('.sequence-segment-chip')).height,
    chipFont: getComputedStyle(panel.querySelector('.sequence-segment-chip > strong')).fontSize };
});
let failure;
try {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(viewport); await seed(130);
    const name = `${viewport.width}x${viewport.height}-130`;
    const measured = await measure(); records.push({ name, ...measured });
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    assert.equal(measured.pageOverflow, false, `${name}: horizontal page overflow`);
    assert.ok(measured.controls.every((control) => control.reachable), `${name}: covered planning action`);
    assert.ok(measured.controls.every((control) => !control.clipped), `${name}: planning label clipped`);
    assert.ok(measured.boxes['sequence-segment-editor'].height >= 140, `${name}: unusably short segment editor`);
    if (phase === 'after') assert.ok(measured.topHeight <= 160, `${name}: compact planning block must stay within 160px`);
    await page.getByRole('group', { name: '单段生成时长预设', exact: true }).getByRole('button', { name: '自定义', exact: true }).click();
    await page.getByLabel('自定义单段秒数', { exact: true }).fill('30');
    // The existing presentation effect collapses options when edited duration
    // once again matches the saved plan. Reopen it to check the custom input.
    if (await page.getByRole('button', { name: '展开规划参数', exact: true }).count()) await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
    await page.getByRole('button', { name: '自定义总时长', exact: true }).click();
    await page.getByLabel('全片总秒数', { exact: true }).fill('240'); await page.getByLabel('全片总秒数', { exact: true }).blur();
    assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '240');
    const fixed = await measure(); records.push({ name: `${name}-fixed`, ...fixed });
    await page.screenshot({ path: path.join(output, `${name}-fixed.png`), animations: 'disabled' });
    assert.ok(fixed.controls.every((control) => control.reachable), `${name}: covered fixed-mode control`);
    assert.ok(fixed.controls.every((control) => !control.clipped), `${name}: fixed-mode planning label clipped`);
    const chips = page.locator('.sequence-plan-workspace .sequence-segment-chip'); await chips.nth(3).click();
    await page.getByLabel('段标题', { exact: true }).waitFor();
    assert.match(await page.locator('.sequence-segment-editor').innerText(), /失败|413/u);
    await page.getByRole('button', { name: '收起规划参数', exact: true }).click();
    assert.equal(await page.locator('#sequence-planning-options-body').isVisible(), false);
    await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
    await page.getByRole('button', { name: 'AI适配', exact: true }).click();
    assert.equal(await page.getByLabel('全片总秒数', { exact: true }).count(), 0);
    if (await page.getByRole('button', { name: '展开规划参数', exact: true }).count()) await page.getByRole('button', { name: '展开规划参数', exact: true }).click();
    await page.getByTestId('semantic-sequence-plan').click();
    await page.getByRole('button', { name: '停止分段', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.sequence-semantic-actions button:last-child')?.disabled);
    const pending = await measure(); records.push({ name: `${name}-pending`, ...pending });
    assert.ok(pending.controls.every((control) => control.reachable), `${name}: pending/stop action covered`);
    await page.screenshot({ path: path.join(output, `${name}-pending.png`), animations: 'disabled' });
    await page.getByRole('button', { name: '停止分段', exact: true }).click(); releaseHeldRequest?.(); releaseHeldRequest = undefined;
    await page.waitForFunction(() => !document.querySelector('[data-testid="semantic-sequence-plan"]')?.disabled);
    steps.push(`${name}: source mode, custom segment/total duration, failed segment, collapse and isolated pending/stop actions remain operable`);
  }
  assert.deepEqual(errors, []);
} catch (error) { failure = error; await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally {
  releaseHeldRequest?.();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ phase, records, errors, steps, localMockRequests, failure: failure?.stack }, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ output, phase, measurements: records.map(({ name, topHeight, chipFont }) => ({ name, topHeight, chipFont })), failure: failure?.message }, null, 2));
if (failure) throw failure;
