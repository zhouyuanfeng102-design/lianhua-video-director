import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One focused built-renderer pass. The only model is a loopback HTTP fixture;
// all state belongs to a new isolated profile, including desktop persistence.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
assert.ok(electronOption === -1 || process.argv[electronOption + 1], '--electron requires an executable path');
const executable = electronOption === -1 ? null : path.resolve(process.argv[electronOption + 1]);
const output = path.join(root, 'output', 'playwright', `story-visual-action-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow symbolic links: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = { pass: false, version, packagedElectron: Boolean(executable), model: 'local deterministic fixture',
  realModelQualityEvaluated: false, noProductionDataRead: true, stages: [], requests: [], layouts: [], screenshots: [],
  pageErrors: [], consoleErrors: [], blockedRequests: [], fixtureErrors: [] };
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'qa-action-chapter';
const sourceParagraphs = [
  '绝死绝命将森林精灵王的尸体踢向少女。尸体飞过门廊，少女轻松避开。尸体撞上少女身后的墙壁，发出巨响，血花在墙上绽开。',
  '少女拾起地上的铜灯，把它放到窗台上，再松开灯柄。',
  '少女说：“我不会后退。”绝死绝命怀疑少女可能还有同伴，但没有看到其他人。',
];
const source = sourceParagraphs.join('\n\n');
const visualParagraphs = (generation) => [
  { id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['e1', 'e2'],
    text: generation === 1
      ? '绝死绝命抬腿发力，脚面接触尸体后将其踢向少女。尸体沿门廊向前疾飞；少女看清来向，侧身让开飞行路径。尸体从她身旁掠过，撞上后方墙壁，巨响随撞击传开，血花留在墙面上。'
      : '绝死绝命脚下发力，将尸体踢离地面。尸体顺着门廊朝少女飞去；少女侧身移出它的路径，尸体擦身而过，继续撞向她身后的墙壁。撞击声在门廊中回响，血花在墙上绽开，少女重新稳住站姿。',
    stagingAdditions: ['少女用侧身让开的方式完成原文中的避开；具体闪避方式为编排补充。'] },
  { id: 'v2', sourceParagraphIds: ['p2'], eventIds: ['e3'],
    text: '少女俯身握住铜灯的灯柄，提灯离开地面。她把铜灯移到窗台上，另一只手扶住灯底，待灯底贴稳台面后松开灯柄，铜灯停在窗台上。',
    stagingAdditions: ['另一只手扶住灯底是对放灯过程的编排补充。'] },
  { id: 'v3', sourceParagraphIds: ['p3'], eventIds: ['e4'],
    text: '少女说：“我不会后退。”绝死绝命目光越过少女，观察门廊周围，怀疑她可能还有同伴；视野中没有其他人出现。',
    stagingAdditions: ['目光观察门廊是对怀疑状态的可见编排，不表示同伴已出现。'] },
];
const visualBody = (paragraphs) => paragraphs.map((paragraph) => paragraph.text).join('\n\n');
let understandingCount = 0;
let generationCount = 0;
let rewriteCount = 0;
let expectedSource = source;
let heldUnderstanding;
let heldRewrite;
let releaseUnderstanding;
let releaseRewrite;
let releaseCancelledRegeneration;
let cancelledRegenerationReleased = false;
const waitUnderstanding = new Promise((resolve) => { releaseUnderstanding = resolve; });
const waitRewrite = new Promise((resolve) => { releaseRewrite = resolve; });
const waitCancelledRegeneration = new Promise((resolve) => { releaseCancelledRegeneration = resolve; });
const mock = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/qa-story-visual/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const user = payload.messages.filter((message) => message.role === 'user')
      .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
    const match = user.match(/<story_visual_data>\s*([\s\S]*?)\s*<\/story_visual_data>/u);
    assert.ok(match, 'two-stage action transport uses the story_visual_data envelope');
    const data = JSON.parse(match[1]);
    assert.equal(data.mode, 'optimize');
    assert.equal(data.sourceTextOrRequirement, expectedSource, 'every request retains the complete current source');
    assert.ok(['understanding', 'visualizing', 'rewriting'].includes(data.stage));
    assert.ok(['faithful', 'detailed'].includes(data.detailMode));
    report.requests.push({ stage: data.stage, detailMode: data.detailMode, sourceCharacters: data.sourceTextOrRequirement.length,
      focusParagraphIds: data.focusParagraphIds, paragraphId: data.paragraphId });
    let result;
    if (data.stage === 'understanding') {
      understandingCount++;
      assert.deepEqual(data.sourceParagraphs.map((paragraph) => paragraph.id), ['p1', 'p2', 'p3']);
      if (understandingCount === 1) { heldUnderstanding = true; await waitUnderstanding; }
      if (understandingCount === 2) {
        await waitCancelledRegeneration; cancelledRegenerationReleased = true;
        if (response.destroyed) return;
      }
      result = { version: 1, summary: '尸体被踢向少女，少女避开后尸体撞墙；随后放灯并交谈，是否有同伴仍不确定。',
        events: [
          { id: 'e1', sourceParagraphIds: ['p1'], evidence: data.sourceParagraphs[0].text.split('。')[0] + '。', actor: '绝死绝命', target: '少女',
            action: '将尸体踢向少女', phases: ['脚部发力接触尸体', '尸体沿门廊飞向少女'], result: '尸体飞向少女', uncertainties: [] },
          { id: 'e2', sourceParagraphIds: ['p1'], evidence: data.sourceParagraphs[0].text, actor: '少女', target: '飞来的尸体',
            action: '避开尸体', phases: ['移出飞行路径', '尸体继续前冲并撞墙'], result: '少女避开；尸体撞墙并留下血花', uncertainties: ['原文未明示具体闪避方向'] },
          { id: 'e3', sourceParagraphIds: ['p2'], evidence: data.sourceParagraphs[1].text, actor: '少女', target: '铜灯',
            action: '拾起并放下铜灯', phases: ['铜灯离地', '铜灯在窗台放稳', '松开灯柄'], result: '铜灯在窗台上', uncertainties: ['原文未明示使用哪只手'] },
          { id: 'e4', sourceParagraphIds: ['p3'], evidence: data.sourceParagraphs[2].text, actor: '少女与绝死绝命', target: '对方',
            action: '交谈与观察', result: '没有其他人出现', uncertainties: ['可能有同伴仅为绝死绝命的猜测'] },
        ] };
    } else if (data.stage === 'visualizing') {
      generationCount++;
      assert.equal(data.actionPlan.events.length, 4, 'second stage receives the understood events');
      assert.equal(data.sourceParagraphs.length, 3, 'second stage receives the complete paragraph source for this batch');
      assert.equal(data.focusEvents.length, 4, 'second stage retains exact source evidence for focused events');
      result = { paragraphs: visualParagraphs(generationCount) };
    } else {
      rewriteCount++;
      assert.equal(data.paragraphId, 'v1');
      assert.equal(data.previousParagraph.id, 'v1');
      assert.equal(data.actionPlan.events.length, 4);
      assert.ok(data.neighboringParagraphs.some((paragraph) => paragraph.id === 'v2'), 'paragraph rewrite receives neighboring context');
      heldRewrite = true;
      await waitRewrite;
      result = { paragraph: { ...data.previousParagraph,
        text: '绝死绝命脚部接触尸体并向前发力，尸体离地飞向少女。少女侧身让开路径，尸体从她身旁掠过，撞上后墙。撞击声和墙上的血花同时显现，少女稳住身体，继续面对绝死绝命。',
        stagingAdditions: ['侧身与稳住身体是对原文闪避过程的编排补充。'] } };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    report.fixtureErrors.push(error.stack || error.message);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic fixture contract failed' } }));
  }
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const { createInitialState, normalizeState } = await tsImport('../src/storage.ts', import.meta.url);
const initial = createInitialState();
const now = Date.now();
const project = { ...initial.project, id: 'qa-story-visual-action', name: '动作转化隔离测试', activeChapterId: chapterId,
  sourceDocuments: [{ id: chapterId, name: '踢击与放灯', content: source, createdAt: now, updatedAt: now }], chapterWorkspaces: {},
  storyDraft: undefined, storyVisualConversions: [], characters: [], locations: [], props: [], scenes: [], assets: [],
  storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
const state = normalizeState({ ...initial, project, projects: [project], activeProjectId: project.id,
  settings: { ...initial.settings, textApi: { ...initial.settings.textApi, enabled: true, provider: 'openai_compatible',
    baseUrl: `${mockOrigin}/qa-story-visual/v1`, model: 'qa-action-fixture', apiKey: '' },
    activeTextApiProfileId: null, textApiProfiles: [], apiCredentialBook: [],
    visionApi: { ...initial.settings.visionApi, enabled: false, apiKey: '' },
    imageApi: { ...initial.settings.imageApi, enabled: false, apiKey: '' },
    videoTaskApi: { ...initial.settings.videoTaskApi, enabled: false, apiKey: '' } } });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
let child;
let harness;
let browser;
let context;
let page;
let dataRoot;
const storedProject = async () => page.evaluate(async (key) => {
  const raw = window.lianhuaDesktop?.loadState ? await window.lianhuaDesktop.loadState() : localStorage.getItem(key);
  return JSON.parse(raw).project;
}, storageKey);
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 80, check: async () => predicate(await storedProject()) });
const waitCount = (stage, count) => waitForCondition({ label: `${stage} request ${count}`, timeoutMs: 15_000, intervalMs: 40,
  check: () => report.requests.filter((request) => request.stage === stage).length === count });
const screenshot = async (name) => {
  const destination = path.join(output, `${name}.png`); await page.screenshot({ path: destination, scale: 'css' }); report.screenshots.push(destination);
};
async function checkReviewBounds(name) {
  const layout = await page.locator('.sr-review-dialog').evaluate((dialog) => {
    const rect = (element) => { const value = element.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }; };
    return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(dialog), footer: rect(dialog.querySelector('.sr-review-footer')),
      horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1 };
  });
  report.layouts.push({ name, ...layout });
  assert.ok(layout.dialog.left >= -1 && layout.dialog.right <= layout.viewport.width + 1
    && layout.dialog.top >= -1 && layout.dialog.bottom <= layout.viewport.height + 1, `${name}: review stays inside viewport`);
  assert.ok(layout.footer.top >= layout.dialog.top - 1 && layout.footer.bottom <= layout.viewport.height + 1, `${name}: adoption controls remain visible`);
  assert.equal(layout.horizontalOverflow, false, `${name}: no dialog horizontal overflow`);
}
try {
  if (executable) {
    await fs.access(executable);
    dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
    await fs.writeFile(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic action conversion profile; no production state imported.\n');
    await fs.writeFile(path.join(dataRoot, 'project-state.json'), JSON.stringify(state));
    const env = { ...process.env, LIANHUA_DATA_DIR: dataRoot, LIANHUA_QA_MODE: '1', LIANHUA_ALLOW_PRIVATE_NETWORK: '1' };
    delete env.ELECTRON_START_URL; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [`--remote-debugging-port=${port}`, '--no-first-run'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    assert.match(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), /assets\/index-[^"\s]+\.js/u);
    const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  harness = createQaProcessHarness({ electron: child, qaLabel: 'story visual action', runTimeoutMs: 210_000, closeTimeoutMs: 10_000 });
  async function run() {
    await waitForCondition({ label: 'built action renderer startup', timeoutMs: 40_000, intervalMs: 100,
      check: async () => { try { return (await fetch(executable ? `${origin}/json/version` : origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = executable ? await chromium.connectOverCDP(origin) : await chromium.launch({ headless: true });
    context = executable ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    assert.ok(context, 'isolated context exists');
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const allowedHttp = url.origin === mockOrigin || (!executable && url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/src/'));
      if (/^https?:$/u.test(url.protocol) && !allowedHttp) {
        report.blockedRequests.push({ method: request.method(), pathname: url.pathname }); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    if (!executable) await context.addInitScript(({ key, state }) => {
      if (!sessionStorage.getItem('__story_action_qa__')) { localStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); sessionStorage.setItem('__story_action_qa__', '1'); }
    }, { key: storageKey, state });
    page = executable ? context.pages().find((entry) => entry.url().startsWith('file:')) : await context.newPage();
    assert.ok(page, 'renderer page exists'); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    if (executable) {
      const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
      assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase(), 'desktop data root must be the isolated synthetic profile');
      await page.reload({ waitUntil: 'networkidle' });
    } else await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('.app-shell').waitFor();
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`));
    await page.setViewportSize({ width: 1280, height: 800 });
    const navStory = () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
    await navStory();
    const input = page.locator('.story-source-textarea');
    assert.equal(await input.inputValue(), source);
    const optimize = page.locator('.story-input-actions').getByRole('button', { name: 'AI画面描述转化', exact: true });
    const optimizeHandle = await optimize.elementHandle(); await optimizeHandle.click();
    await waitCount('understanding', 1); assert.equal(heldUnderstanding, true);
    assert.equal(await optimizeHandle.isDisabled(), true, 'busy conversion cannot double-submit');
    assert.equal(await input.inputValue(), source, 'understanding does not alter the source draft');
    releaseUnderstanding();
    let review = page.getByRole('dialog', { name: 'AI 画面描述转化 · 结果审阅', exact: true });
    await review.waitFor(); await waitCount('visualizing', 1);
    assert.equal(await review.locator('[data-review-paragraph]').count(), 3);
    assert.equal(await review.locator('[data-review-tab="actions"]').getAttribute('aria-selected'), 'true');
    assert.ok((await review.getByLabel('本段原文依据', { exact: true }).innerText()).includes('尸体踢向少女'));
    assert.ok((await review.getByLabel('本段编排补充', { exact: true }).innerText()).includes('侧身'));
    assert.ok((await review.locator('.sr-review-event-facts').innerText()).includes('原文未明示具体闪避方向'));
    await checkReviewBounds('actions-1280x800'); await screenshot('actions-1280x800');
    await page.setViewportSize({ width: 1120, height: 720 });
    await checkReviewBounds('actions-1120x720'); await screenshot('actions-1120x720');
    await page.setViewportSize({ width: 1280, height: 800 });
    await review.locator('[data-review-tab="comparison"]').click();
    assert.equal(await review.getByLabel('处理前原文', { exact: true }).inputValue(), source);
    assert.equal(await review.getByLabel('AI 返回结果', { exact: true }).inputValue(), visualBody(visualParagraphs(1)));
    assert.equal(await input.inputValue(), source, 'review waits for adoption');
    report.stages.push('two-stage source-preserving conversion and three-paragraph facts/staging review at 1280x800 and 1120x720');

    await review.locator('[data-review-tab="actions"]').click();
    await review.locator('[data-review-rewrite="v1"]').click(); await waitCount('rewriting', 1);
    assert.equal(heldRewrite, true);
    assert.equal(await review.getByRole('button', { name: '采用到编辑区', exact: true }).isDisabled(), true);
    assert.equal(await review.locator('[data-review-regenerate]').isDisabled(), true);
    releaseRewrite();
    await waitForCondition({ label: 'selected paragraph replaced', timeoutMs: 15_000, intervalMs: 70,
      check: async () => (await review.getByLabel('本段画面描述', { exact: true }).innerText()).includes('脚部接触尸体') });
    await review.locator('[data-review-paragraph="v2"]').click();
    assert.equal(await review.getByLabel('本段画面描述', { exact: true }).innerText(), visualParagraphs(1)[1].text);
    await review.locator('[data-review-tab="comparison"]').click();
    const rewritten = await review.getByLabel('AI 返回结果', { exact: true }).inputValue();
    assert.equal(rewritten.split('\n\n')[1], visualParagraphs(1)[1].text, 'unselected paragraph is retained exactly');
    assert.equal(rewritten.split('\n\n')[2], visualParagraphs(1)[2].text, 'dialogue and uncertainty paragraph is retained exactly');
    assert.equal(await input.inputValue(), source);
    report.stages.push('one contextual paragraph rewrite preserves other paragraphs and disables conflicting actions while busy');

    await review.locator('[data-review-regenerate]').click();
    await waitCount('understanding', 2);
    await review.getByRole('button', { name: '不采用，保留原文', exact: true }).click();
    releaseCancelledRegeneration();
    await waitForCondition({ label: 'cancelled regeneration response released', timeoutMs: 15_000, intervalMs: 70,
      check: () => cancelledRegenerationReleased });
    await waitForCondition({ label: 'conversion cancellation settled', timeoutMs: 15_000, intervalMs: 70,
      check: async () => optimize.isEnabled() });
    assert.equal(await review.count(), 0, 'discarding an in-flight regeneration cannot revive a pending review');
    assert.equal(generationCount, 1, 'cancelled understanding never starts visual generation');
    assert.equal(await input.inputValue(), source);
    report.stages.push('discarding a held regeneration aborts it without reviving preview or changing source');
    await optimize.click();
    await waitCount('understanding', 3); await waitCount('visualizing', 2);
    await waitForCondition({ label: 'regenerated result shown', timeoutMs: 15_000, intervalMs: 70,
      check: async () => { const result = review.getByLabel('本段画面描述', { exact: true }); return await result.count() === 1 && (await result.innerText()).includes('脚下发力'); } });
    assert.equal(await input.inputValue(), source);
    await review.locator('[data-review-regenerate]').click();
    await waitCount('understanding', 4); await waitCount('visualizing', 3);
    await waitForCondition({ label: 'explicit full regeneration completed', timeoutMs: 15_000, intervalMs: 70,
      check: async () => review.getByRole('button', { name: '采用到编辑区', exact: true }).isEnabled() });
    await review.getByRole('button', { name: '采用到编辑区', exact: true }).click();
    const adoptedBody = visualBody(visualParagraphs(3));
    await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, adoptedBody);
    await waitStored((project) => project.storyVisualConversions?.length === 1, 'adopted provenance persisted');
    const adopted = (await storedProject()).storyVisualConversions[0];
    assert.equal(adopted.sourceText, source); assert.equal(adopted.resultText, adoptedBody);
    assert.equal(adopted.actionPlan.events.length, 4); assert.equal(adopted.paragraphs.length, 3);
    assert.ok(adopted.engineVersion); assert.equal(adopted.detailMode, 'detailed');
    assert.equal((await storedProject()).sourceDocuments[0].content, source, 'adoption updates editor draft and preserves saved original');
    await page.getByRole('button', { name: '查看转化来源', exact: true }).click();
    const provenance = page.getByRole('dialog', { name: '画面描述 · 转化来源', exact: true }); await provenance.waitFor();
    assert.equal(await provenance.getByLabel('处理前原文', { exact: true }).inputValue(), source);
    await provenance.locator('[data-review-tab="actions"]').click();
    assert.equal(await provenance.locator('[data-review-paragraph]').count(), 3);
    assert.equal(await provenance.locator('[data-review-regenerate]').count(), 0);
    await screenshot('adopted-source-actions'); await provenance.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' }); await navStory();
    assert.equal(await input.inputValue(), adoptedBody, 'adopted draft restores after reload');
    assert.deepEqual((await storedProject()).storyVisualConversions[0], adopted, 'stored facts and staging survive actual desktop save/reload');
    report.stages.push('explicit full regeneration, adoption, immutable source metadata and draft survive save/reload');

    expectedSource = adoptedBody;
    await page.locator('.story-input-actions').getByRole('button', { name: 'AI画面描述转化', exact: true }).click();
    await review.waitFor(); await waitCount('understanding', 5); await waitCount('visualizing', 4);
    await review.getByRole('combobox', { name: '转化细节', exact: true }).selectOption('faithful');
    assert.equal(await review.getByRole('button', { name: '采用到编辑区', exact: true }).isDisabled(), true, 'changed conversion settings invalidate pending review');
    assert.equal(await review.locator('[data-review-rewrite="v1"]').isDisabled(), true);
    assert.equal(await review.locator('[data-review-regenerate]').isDisabled(), false, 'stale result can be regenerated');
    await review.getByRole('button', { name: '稍后查看', exact: true }).click();
    const edited = `${adoptedBody}\n\n人工编辑：铜灯保持熄灭。`;
    await input.fill(edited);
    await page.getByRole('button', { name: '查看转化结果', exact: true }).click(); await review.waitFor();
    assert.equal(await review.getByRole('button', { name: '采用到编辑区', exact: true }).isDisabled(), true, 'changed draft cannot be overwritten by old result');
    await screenshot('stale-settings-and-draft');
    await review.getByRole('button', { name: '不采用，保留原文', exact: true }).click();
    assert.equal(await input.inputValue(), edited);
    await waitStored((project) => project.storyDraft?.content === edited, 'user edit persisted');
    assert.deepEqual((await storedProject()).storyVisualConversions[0], adopted, 'pending review discard leaves historical provenance immutable');
    assert.equal(rewriteCount, 1); assert.equal(understandingCount, 5); assert.equal(generationCount, 4);
    report.stages.push('settings and draft changes prevent old-result adoption; keeping source retains edits and immutable conversion history');
    assert.deepEqual(report.fixtureErrors, []); assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.blockedRequests, []);
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) {
    report.runtimeErrors = await page.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]')).catch(() => []);
    await screenshot('failure').catch(() => {});
  }
} finally {
  releaseUnderstanding(); releaseRewrite(); releaseCancelledRegeneration();
  if (!executable) await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  harness?.markElectronStopping();
  await harness?.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  if (harness) await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, packagedElectron: report.packagedElectron, stages: report.stages,
  requestStages: report.requests.map((request) => request.stage), failure: report.failure?.message,
  report: path.join(output, 'report.json') }, null, 2));
