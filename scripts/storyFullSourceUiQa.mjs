import nodeAssert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Playwright handles may live in node_repl's host realm while this imported
// module has its own realm. Compare serializable QA data, not realm prototypes.
const assert = {
  ok: nodeAssert.ok, equal: nodeAssert.equal, match: nodeAssert.match,
  deepEqual: (actual, expected, message) => nodeAssert.equal(JSON.stringify(actual), JSON.stringify(expected), message),
};

/** Run ONLY through Playwright Interactive's persistent node_repl:
 * const qa = await createStoryFullSourceUiQa({ page, baseUrl });
 * await qa.setup(); await qa.optimizeReview(); await qa.staleReview();
 * await qa.analyzeFullSource(); await qa.failureAndNoApi(); await qa.finish();
 * This module never launches a browser/server and never uses a paid endpoint.
 */
export const QA_INVENTORY = [
  { claim: '优化只发送一次完整原文，不发送本地预抽清单', controls: 'AI剧情优化、稍后查看、查看优化结果', state: '待请求/预览/隐藏/重开', evidence: '捕获请求与对照预览截图' },
  { claim: '所有结果先预览，采用不自动保存；可保留原文和还原', controls: '对照预览、核对提示、复制、分页、不采用、采用、还原', state: '零提示/多提示/采用后/还原后', evidence: '原文及持久项目逐字段比对、预览与提示截图' },
  { claim: '旧结果不覆盖后续编辑或其它项目', controls: '稍后查看、编辑原文、切换项目、旧结果采用', state: '已返回后过期/请求中编辑/请求中换项目', evidence: '采用禁用、编辑区与持久数据不串写' },
  { claim: 'AI全局场景和名字落库；三类补全每次拿全文', controls: '解析并补全、实体资料、场景管理', state: '全局分析/人物补全/地点补全/道具补全/完成', evidence: '四类请求全文精确匹配、场景边界与实体由mock AI决定' },
  { claim: '失败或无API时不产生本地替代数据', controls: '解析并补全、API设置提示', state: 'HTTP失败/未启用API', evidence: '请求次数与已有项目内容严格不变' },
  { claim: '关键预览和警告按钮不被遮挡', controls: '预览页/核对提示页/采用与保留按钮', state: '1280x800、1120x720', evidence: '区域边界/命中检查及独立截图目检' },
];

const STORAGE_KEY = 'lianhua_video_director_state_v22';
const SIMPLE_SOURCE = '\n  叶清碧牵着我走到灯下。叶清碧说：“莫要走散。”祈凌霜说：“我在这里。”三人走进青灯坊市。\n';
const OTHER_SOURCE = '另一项目：信使独自守在江边，不属于青灯坊市剧情。';
const GOOD_RESULT = '【场景1：青灯坊市灯下】\n出场人物：叶清碧、祈凌霜、我\n剧情：叶清碧牵着我走到灯下，三人走进青灯坊市。\n对白：叶清碧：“莫要走散。”\n祈凌霜：“我在这里。”';
const WARNING_RESULT = '# AI 场景草稿\n剧情：叶清碧牵着我走到灯下，三人走进青灯坊市。\n对白：只：“莫要走散。”\n祈凌霜：“我在这里。”';
const LONG_SOURCE = '师傅叶清碧牵着我。师姐祈凌霜笑盈盈道：“跟紧。”她们一起走过青灯坊市。\n'
  + '灯火映在长街上，三人继续沿着原来的路线前行，没有改变彼此的关系。\n'.repeat(900)
  + '夜深后仍在青灯坊市。祈凌霜把青玉杯放在石阶旁，叶清碧招手让我靠近。全文最后一句也必须交给AI。';
const FAILURE_SOURCE = `${LONG_SOURCE}\n用户在现有已解析项目上追加了新原文；请求失败时这段草稿不能覆盖已保存原文。`;
const CHARACTER_NAMES = ['无名主角', '叶清碧', '祈凌霜'];
const LOCATION_NAMES = ['青灯坊市'];
const PROP_NAMES = ['青玉杯'];
const character = (name) => ({ name, gender: name === '无名主角' ? '男' : '女', apparentAge: '约二十五岁', actualAge: '约二十五岁', height: '约一米七', race: '人类', morphology: 'human-like', bodyPlan: '人类头部躯干，双臂双腿', appearance: '黑发，五官清晰，身形匀称', outfit: '深色长袍', signatureProps: '腰间布袋', personality: '平静谨慎', motionHabits: '自然步行', anchor: `${name}保持黑发长袍外貌`, negativeContinuity: '保持相同外貌与服装' });
const location = (name) => ({ name, description: '连续石板长街，两侧木楼与灯笼', timeWeather: '夜间，晴朗', lighting: '暖色灯笼光', palette: '青灰石板与暖黄色灯火', fixedProps: '长街石阶和灯柱', anchor: '同一青灯坊市长街' });
const prop = (name) => ({ name, category: '杯具', material: '青玉', appearance: '小型青玉圆杯，表面光滑', effect: '盛放茶水', stateRules: '保持杯口和杯身完整' });
const ANALYSIS = {
  characters: CHARACTER_NAMES.map(character), locations: LOCATION_NAMES.map(location), props: PROP_NAMES.map(prop),
  scenes: [
    { title: 'AI全局边界甲：连续长街', content: LONG_SOURCE.slice(0, Math.floor(LONG_SOURCE.length / 2)), summary: 'AI把前半篇划为同一连续场景', characters: CHARACTER_NAMES, location: LOCATION_NAMES[0], props: PROP_NAMES },
    { title: 'AI全局边界乙：同人归拢', content: LONG_SOURCE.slice(Math.floor(LONG_SOURCE.length / 2)), summary: 'AI把后半篇和结尾作为第二场', characters: CHARACTER_NAMES, location: LOCATION_NAMES[0], props: PROP_NAMES },
  ],
};
const projectFields = ['id', 'sourceDocuments', 'scenes', 'characters', 'locations', 'props', 'storyboards', 'sequencePlans', 'assets', 'generationTasks'];
const projectSnapshot = (project) => Object.fromEntries(projectFields.map((key) => [key, project[key]]));

export async function createStoryFullSourceUiQa({ page, baseUrl = 'http://127.0.0.1:5187/', outputDirectory } = {}) {
  assert.ok(page, 'provide a page owned by a Playwright Interactive session');
  const root = path.resolve(import.meta.dirname, '..');
  const outputBase = path.join(root, 'output', 'playwright');
  const output = path.resolve(outputDirectory || path.join(outputBase, 'story-full-source-0.5.121-agent'));
  const relative = path.relative(outputBase, output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'QA output remains below output/playwright');
  fs.mkdirSync(output, { recursive: true });
  const origin = new URL(baseUrl).origin;
  const requests = []; const errors = []; const stages = []; const screenshots = [];
  let nextOptimization = GOOD_RESULT; let holdNext = ''; let failAnalysis = false;
  let storedBefore; let afterAnalysis; const held = new Map();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource.*503/iu.test(message.text())) errors.push(message.text());
  });
  const userText = (body) => body.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
  const getProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, STORAGE_KEY);
  const snapshot = async () => projectSnapshot(await getProject());
  const input = () => page.locator('.story-source-textarea');
  const optimize = () => page.locator('.story-input-actions').getByRole('button', { name: /^AI\s*剧情优化$/u });
  const analyze = () => page.locator('.story-input-actions').getByRole('button', { name: /^解析并补全$/u });
  const dialog = () => page.getByRole('dialog', { name: 'AI 剧情优化 · 结果审阅', exact: true });
  const story = async () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const waitRequests = async (count) => {
    const start = Date.now();
    while (requests.length < count && Date.now() - start < 6000) await page.waitForTimeout(30);
    assert.equal(requests.length, count, `request count ${count}; errors=${errors.join(';')}`);
  };
  const release = async (tag) => { assert.ok(held.has(tag), `held request ${tag}`); held.get(tag)(); };
  const capture = async (name) => {
    await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css', fullPage: false });
    screenshots.push(`${name}.png`);
  };
  const fit = async (selectors) => {
    const problems = await page.evaluate((items) => items.flatMap((selector) => [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length).flatMap((element) => {
      const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || !hit || !(element === hit || element.contains(hit))
        ? [{ selector, text: element.textContent?.slice(0, 60), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hit: hit?.className }] : [];
    })), selectors);
    assert.deepEqual(problems, [], 'required controls are visible, within the viewport and not covered');
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__agentQaClipboard = value; } } });
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    errors.push(`Blocked external request: ${route.request().url()}`); await route.abort('blockedbyclient');
  });
  await page.route('**/qa-story-full-source/v1/chat/completions', async (route) => {
    let tag = '';
    try {
      const payload = route.request().postDataJSON(); const user = userText(payload);
      const preparation = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u);
      const analysis = user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u);
      let kind; let content; let sourceLength = LONG_SOURCE.length;
      if (preparation) {
        const data = JSON.parse(preparation[1]); assert.equal(data.mode, 'optimize');
        assert.deepEqual(Object.keys(data).sort(), ['dialogueMode', 'mode', 'sourceTextOrRequirement']);
        assert.equal(data.dialogueMode, 'ai-read-full-source');
        assert.equal(data.sourceTextOrRequirement, SIMPLE_SOURCE, 'boundary whitespace and the complete source reach the AI');
        kind = 'optimize'; content = nextOptimization; sourceLength = SIMPLE_SOURCE.length;
      } else if (analysis) {
        const expectedSource = failAnalysis ? FAILURE_SOURCE : LONG_SOURCE;
        assert.deepEqual(JSON.parse(analysis[1]), { sourceStory: expectedSource }); kind = 'analysis'; content = JSON.stringify(ANALYSIS); sourceLength = expectedSource.length;
      } else {
        const match = user.match(/^需要补全的(人物|地点|道具)名称：([^\n]+)/u); assert.ok(match, 'only AI-derived supplement requests are expected');
        const names = JSON.parse(match[2]);
        const expected = match[1] === '人物' ? CHARACTER_NAMES : match[1] === '地点' ? LOCATION_NAMES : PROP_NAMES;
        assert.deepEqual(names, expected, 'supplement names must be exactly those returned by the AI');
        assert.ok(user.endsWith(`完整剧情原文：${LONG_SOURCE}`), 'each supplement retains every source character');
        kind = match[1] === '人物' ? 'characters' : match[1] === '地点' ? 'locations' : 'props';
        const build = kind === 'characters' ? character : kind === 'locations' ? location : prop;
        content = JSON.stringify({ items: names.map(build) });
      }
      tag = kind === 'optimize' ? holdNext : ''; if (tag) holdNext = '';
      requests.push({ kind, tag, sourceLength });
      if (kind === 'analysis' && failAnalysis) {
        failAnalysis = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA analysis unavailable' } }) }); return;
      }
      if (tag) await new Promise((resolve) => held.set(tag, resolve));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
    } catch (error) {
      if (!(tag && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error)))) {
        errors.push(String(error)); await route.fulfill({ status: 500, body: 'Isolated QA mock rejected its input' }).catch(() => {});
      }
    }
  });

  return {
    page, requests, errors, stages, output,
    async setup() {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), STORAGE_KEY);
      await page.evaluate(({ key, base, source, other }) => {
        const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
        const make = (id, name, content) => ({ ...state.project, id, name, sourceDocuments: [{ id: `source-${id}`, name: '隔离QA原文', content, createdAt: now, updatedAt: now }], scenes: [], storyboards: [], sequencePlans: [], assets: [], characters: [], locations: [], props: [], generationTasks: [], updatedAt: now });
        const a = make('agent-full-source-a', '全文验收A', source); const b = make('agent-full-source-b', '全文验收B', other);
        state.project = a; state.projects = [a, b]; state.activeProjectId = a.id;
        state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${base}qa-story-full-source/v1`, apiKey: '', model: 'agent-full-source-mock' };
        state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
        for (const name of ['visionApi', 'imageApi', 'videoTaskApi']) if (state.settings[name]) state.settings[name].enabled = false;
        localStorage.setItem(key, JSON.stringify(state));
      }, { key: STORAGE_KEY, base: baseUrl, source: SIMPLE_SOURCE, other: OTHER_SOURCE });
      await page.reload({ waitUntil: 'networkidle' }); await story();
      assert.equal(await input().inputValue(), SIMPLE_SOURCE); storedBefore = await snapshot();
      await fit(['.story-input-actions button']); await capture('01-initial-story');
      stages.push('isolated synthetic projects and mock-only API configured');
    },
    async optimizeReview() {
      await optimize().click(); await waitRequests(1); await dialog().waitFor();
      assert.equal(await dialog().getByRole('textbox', { name: '处理前原文', exact: true }).inputValue(), SIMPLE_SOURCE);
      assert.equal(await dialog().getByRole('textbox', { name: 'AI 返回结果', exact: true }).inputValue(), GOOD_RESULT);
      assert.equal(await input().inputValue(), SIMPLE_SOURCE); assert.deepEqual(await snapshot(), storedBefore);
      await dialog().getByRole('button', { name: '复制原文', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__agentQaClipboard), SIMPLE_SOURCE);
      await dialog().getByRole('tab', { name: '对照预览', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await dialog().getByRole('tab', { name: /^核对提示/u }).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await dialog().getByRole('tab', { name: '对照预览', exact: true }).getAttribute('aria-selected'), 'true');
      await fit(['.sr-review-tabs', '.sr-review-actions button', '.sr-review-later', '.sr-review-text-pane textarea']);
      await capture('02-clean-preview');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '查看优化结果', exact: true }).click(); await dialog().waitFor(); assert.equal(requests.length, 1);
      await dialog().getByRole('button', { name: '稍后查看', exact: true }).click(); await optimize().click(); await dialog().waitFor(); assert.equal(requests.length, 1, 'optimize reopens the existing review without another model call');
      await dialog().getByRole('button', { name: '不采用，保留原文', exact: true }).click();
      assert.equal(await input().inputValue(), SIMPLE_SOURCE); assert.deepEqual(await snapshot(), storedBefore);
      nextOptimization = WARNING_RESULT; await optimize().click(); await waitRequests(2); await dialog().waitFor();
      await dialog().getByRole('button', { name: '复制AI结果', exact: true }).click(); assert.equal(await page.evaluate(() => window.__agentQaClipboard), WARNING_RESULT);
      await dialog().getByRole('tab', { name: /^核对提示/u }).click(); await capture('03-warning-review');
      assert.match(await dialog().innerText(), /只|疑点|可能/u);
      const next = dialog().getByRole('button', { name: '下一页', exact: true });
      if (await next.isEnabled()) {
        await next.click(); await capture('03b-warning-dialogue-details');
        await fit(['.sr-review-warning-details', '.sr-review-actions button', '.sr-review-pagination button']);
        await dialog().getByRole('button', { name: '上一页', exact: true }).click();
      }
      await fit(['.sr-review-tabs', '.sr-review-actions button', '.sr-review-later', '.sr-review-pagination button']);
      await page.setViewportSize({ width: 1120, height: 720 }); await capture('04-warning-small');
      await fit(['.sr-review-tabs', '.sr-review-actions button', '.sr-review-later', '.sr-review-pagination button']);
      await dialog().getByRole('tab', { name: '对照预览', exact: true }).click(); await capture('05-comparison-small');
      await fit(['.sr-review-text-pane textarea', '.sr-review-actions button']);
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog().getByRole('button', { name: '采用到编辑区', exact: true }).click();
      assert.equal(await input().inputValue(), WARNING_RESULT, 'actual AI body is adopted without local rewrites');
      assert.deepEqual(await snapshot(), storedBefore, 'adopt does not save or parse');
      await page.getByRole('button', { name: '还原处理前文本', exact: true }).click();
      assert.equal(await input().inputValue(), SIMPLE_SOURCE); assert.deepEqual(await snapshot(), storedBefore); assert.equal(requests.length, 2);
      stages.push('clean and questionable responses both preview; later/reopen/keep/adopt/copy/warning pages/undo work with exactly two requests and no automatic save');
    },
    async staleReview() {
      nextOptimization = GOOD_RESULT; await optimize().click(); await waitRequests(3); await dialog().waitFor();
      await dialog().getByRole('button', { name: '稍后查看', exact: true }).click(); const changed = `${SIMPLE_SOURCE}用户后来补写的内容。`;
      await input().fill(changed); await page.getByRole('button', { name: '查看优化结果', exact: true }).click();
      assert.equal(await dialog().getByRole('button', { name: '采用到编辑区', exact: true }).isDisabled(), true);
      await capture('06-stale-review-disabled'); await dialog().getByRole('button', { name: '不采用，保留原文', exact: true }).click();
      assert.equal(await input().inputValue(), changed); assert.equal(requests.length, 3);
      await input().fill(SIMPLE_SOURCE); holdNext = 'stale-text'; await optimize().click(); await waitRequests(4);
      assert.equal(await optimize().isDisabled(), true); await input().fill(changed); await release('stale-text');
      await optimize().waitFor({ state: 'visible' }); await page.waitForFunction(() => ![...document.querySelectorAll('.story-input-actions button')].find((button) => /AI\s*剧情优化/u.test(button.textContent || ''))?.disabled);
      assert.equal(await input().inputValue(), changed); assert.equal(await dialog().count(), 0); assert.deepEqual(await snapshot(), storedBefore);
      await input().fill(SIMPLE_SOURCE); holdNext = 'stale-project'; await optimize().click(); await waitRequests(5);
      await page.locator('.top-actions .top-action-library').click();
      await page.getByRole('dialog', { name: '项目库', exact: true }).locator('.project-library-select').filter({ hasText: '全文验收B' }).click();
      await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.id === 'agent-full-source-b', STORAGE_KEY);
      await release('stale-project'); await story();
      await page.waitForFunction((value) => document.querySelector('.story-source-textarea')?.value === value, OTHER_SOURCE);
      assert.equal(await input().inputValue(), OTHER_SOURCE);
      assert.equal((await getProject()).sourceDocuments[0].content, OTHER_SOURCE); assert.equal(await dialog().count(), 0);
      await page.locator('.top-actions .top-action-library').click();
      await page.getByRole('dialog', { name: '项目库', exact: true }).locator('.project-library-select').filter({ hasText: '全文验收A' }).click();
      await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.id === 'agent-full-source-a', STORAGE_KEY);
      await story(); await page.waitForFunction((value) => document.querySelector('.story-source-textarea')?.value === value, SIMPLE_SOURCE);
      assert.equal(await input().inputValue(), SIMPLE_SOURCE); assert.deepEqual(await snapshot(), storedBefore);
      stages.push('saved review becomes read-only stale; in-flight editing and project switching cannot overwrite either project or the newer draft');
    },
    async analyzeFullSource() {
      assert.ok(LONG_SOURCE.length > 24000); await input().fill(LONG_SOURCE); const before = requests.length;
      await analyze().click(); await waitRequests(before + 4);
      await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.scenes?.length === 2, STORAGE_KEY);
      const project = await getProject();
      assert.deepEqual(project.scenes.map((scene) => scene.title), ANALYSIS.scenes.map((scene) => scene.title));
      assert.deepEqual(project.scenes.map((scene) => scene.content), ANALYSIS.scenes.map((scene) => scene.content));
      assert.deepEqual(project.characters.map((item) => item.name), CHARACTER_NAMES);
      assert.deepEqual(project.locations.map((item) => item.name), LOCATION_NAMES);
      assert.deepEqual(project.props.map((item) => item.name), PROP_NAMES);
      assert.equal(project.sourceDocuments[0].content, LONG_SOURCE); assert.deepEqual(requests.slice(before).map((item) => item.kind), ['analysis', 'characters', 'locations', 'props']);
      await page.getByRole('button', { name: /^场景管理/u }).click();
      await page.getByRole('button', { name: `1. ${ANALYSIS.scenes[0].title}`, exact: true }).waitFor(); await capture('07-ai-scene-boundaries');
      await page.getByRole('button', { name: /^实体资料/u }).click(); await page.getByText('叶清碧', { exact: true }).first().waitFor(); await capture('08-ai-entity-records');
      await page.getByRole('button', { name: '原文与解析', exact: true }).click(); afterAnalysis = await snapshot();
      stages.push('full 24k+ source reaches global analysis and all three supplement requests; precisely AI-authored names and two AI-authored scene boundaries are saved');
    },
    async failureAndNoApi() {
      failAnalysis = true; const before = requests.length; await input().fill(FAILURE_SOURCE); await analyze().click(); await waitRequests(before + 1);
      await page.waitForFunction(() => ![...document.querySelectorAll('.story-input-actions button')].find((button) => /解析并补全/u.test(button.textContent || ''))?.disabled);
      assert.deepEqual(await snapshot(), afterAnalysis, 'failed analysis cannot substitute local names/scenes or overwrite saved source');
      assert.equal(requests.length, before + 1, 'failed analysis does not launch any supplement stage');
      assert.match(await page.locator('.sidebar-notice').innerText(), /失败|错误|error|服务/u); await capture('09-analysis-failure-preserved');
      await page.evaluate((key) => { const state = JSON.parse(localStorage.getItem(key)); state.settings.textApi.enabled = false; localStorage.setItem(key, JSON.stringify(state)); }, STORAGE_KEY);
      await page.reload({ waitUntil: 'networkidle' }); await story(); const beforeNoApi = requests.length;
      await analyze().click(); await page.getByText(/不会使用本地抽词生成人物或场景/u).first().waitFor();
      assert.deepEqual(await snapshot(), afterAnalysis); assert.equal(requests.length, beforeNoApi); await capture('10-no-api-preserved');
      stages.push('analysis HTTP failure and disabled API both preserve all existing project content; neither starts a local substitute or hidden request');
    },
    async finish() {
      assert.deepEqual(errors, [], 'no unexpected page errors or non-local requests');
      const report = { mockOnly: true, noProductionDataRead: true, inventory: QA_INVENTORY, requests, stages, screenshots, errors };
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(output, 'last-view.yml'), await page.locator('body').ariaSnapshot());
      return report;
    },
  };
}
