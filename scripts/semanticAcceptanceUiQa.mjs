import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Import this helper from Playwright Interactive's persistent node_repl.
// It never launches a browser/server, reads real project data or calls paid APIs.
// Example:
//   var qa = await createSemanticAcceptanceUiQa({ page, baseUrl, outputDirectory });
//   await qa.setup(); await qa.analyzeCultivators(); await qa.reviewVariants();
//   await qa.technicalFailures(); await qa.finish();
// setup(page, baseUrl) + run(page, outputDirectory) are also provided.
const assert = {
  ok: nodeAssert.ok,
  equal: nodeAssert.equal,
  match: nodeAssert.match,
  doesNotMatch: nodeAssert.doesNotMatch,
  deepEqual: (actual, expected, message) => nodeAssert.equal(JSON.stringify(actual), JSON.stringify(expected), message),
};

export const QA_INVENTORY = [
  { claim: '人族修仙者的年龄与人形结构原样接收', controls: '剧情解析 → 解析并补全', states: '解析/人物补齐/地点补齐/成功', evidence: '精确3次同源请求；3人物15字段、1地点、1场原样落库；无年龄返修或语义日志' },
  { claim: '已有AI资料在图像工作台正确展示', controls: '图像工作台、人物选择', states: '依次选择3个人物', evidence: 'human-like、身体结构、外观约二十岁、实际约三百岁等字段与截图' },
  { claim: '不再按措辞、格式或语言给AI结果语义判错', controls: 'AI剧情优化、对照预览、核对提示', states: 'Markdown标题/英文自然段，两种结果均为0提示', evidence: '完整原文单次请求、返回原样只读展示、“本地语义校验已关闭”提示' },
  { claim: '审阅结果采用与还原可逆，不擅自保存', controls: '采用到编辑区、还原处理前文本', states: '预览前/采用后/还原后', evidence: '原文编辑区精确比对；已保存项目内容不变' },
  { claim: '真正的接口和结构错误仍报告且保留已有结果', controls: '解析并补全、报错日志、关闭日志', states: 'HTTP503、无效JSON（两个离开正常路径的场景）', evidence: '分别仅1请求、清楚的中文技术错误；人物/场景/已保存原文不变' },
  { claim: '相关控件清楚可见且不被覆盖', controls: '解析、审阅标签、采用、还原、人物形态与年龄', states: '调用者指定的真实窗口尺寸，初始/成功/审阅/错误', evidence: '逐状态截图、区域边界与命中检查；需主代理独立目检截图' },
];

const CHARACTER_KEYS = ['name', 'gender', 'apparentAge', 'actualAge', 'height', 'race', 'morphology', 'bodyPlan', 'appearance', 'outfit', 'signatureProps', 'personality', 'motionHabits', 'anchor', 'negativeContinuity'];
const CHARACTER_NAMES = ['林沐', '叶清碧', '祈凌霜'];
const BODY_PLAN = '标准人形躯干，双臂双腿';
const STORY = '林沐、叶清碧、祈凌霜都是人族修仙者，虽然实际约三百岁，外观仍约二十岁。三人保持普通人类外貌与标准人形躯干，双臂双腿。\n清晨，他们并肩走过青石坊市。叶清碧说：“前面就是书铺。”祈凌霜点头，林沐说：“我们一起过去。”三人沿原来的长街继续步行。';
const makeCharacter = (name, index) => ({
  name,
  gender: index === 0 ? '男' : '女',
  apparentAge: '约二十岁',
  actualAge: '约三百岁',
  height: index === 0 ? '约178cm' : '约168cm',
  race: '人族修仙者',
  morphology: 'human-like',
  bodyPlan: BODY_PLAN,
  appearance: '黑色长发，正常人类五官，清晰眉眼，肤色自然，体态匀称',
  outfit: index === 0 ? '深蓝色棉麻长袍' : '浅青色棉麻长袍',
  signatureProps: '腰间固定佩戴一枚青玉饰物',
  personality: '平静温和',
  motionHabits: '自然直立步行，抬手指路',
  anchor: `${name}，人族修仙者，外观约二十岁，${BODY_PLAN}，保持黑色长发与原有长袍`,
  negativeContinuity: '保持人类五官、双臂双腿、黑色长发与相同长袍',
});
const CHARACTERS = CHARACTER_NAMES.map(makeCharacter);
const LOCATION = {
  name: '青石坊市', description: '青石长街，两侧为木制商铺，街道前后连通',
  timeWeather: '清晨，晴朗', lighting: '东侧柔和晨光', palette: '青灰石板、棕色木材',
  fixedProps: '街旁灯柱与书铺木门', anchor: '同一条青石坊市长街，木制商铺与灯柱位置保持一致',
};
const ANALYSIS = {
  characters: CHARACTERS, locations: [LOCATION], props: [],
  scenes: [{ title: '三位人族修仙者同行', content: STORY, summary: '三位保持人类外貌的修仙者在青石坊市前往书铺。', characters: CHARACTER_NAMES, location: LOCATION.name, props: [] }],
};
const OPTIMIZATIONS = [
  { id: 'markdown', text: '# AI整理\n林沐、叶清碧和祈凌霜都是人族修仙者，外观约二十岁，实际约三百岁，保持正常人类形态。他们在清晨的青石坊市并肩走向书铺。\n叶清碧说：“前面就是书铺。”祈凌霜点头，林沐回应：“我们一起过去。”' },
  { id: 'english', text: 'Three human cultivators, Lin Mu, Ye Qingbi and Qi Lingshuang, walk together through the morning market. They look about twenty despite having lived for roughly three hundred years. Their ordinary human faces, two arms and two legs remain unchanged as they continue toward the bookshop.' },
];
const PROJECT_FIELDS = ['id', 'sourceDocuments', 'characters', 'locations', 'props', 'scenes', 'storyboards', 'sequencePlans', 'assets', 'generationTasks'];
const pickProject = (project) => Object.fromEntries(PROJECT_FIELDS.map((key) => [key, project[key]]));
const pickCharacter = (character) => Object.fromEntries(CHARACTER_KEYS.map((key) => [key, character[key]]));
const runs = new WeakMap();

export async function createSemanticAcceptanceUiQa({ page, baseUrl, outputDirectory } = {}) {
  assert.ok(page, 'provide a page owned by Playwright Interactive');
  const target = new URL(baseUrl || 'http://127.0.0.1:5213/');
  assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'QA must use an explicitly local HTTP dev server');
  const origin = target.origin;
  const outputBase = path.resolve(import.meta.dirname, '../output/playwright');
  let output = path.resolve(outputDirectory || path.join(outputBase, 'semantic-acceptance-0.5.133'));
  const guardOutput = (directory) => {
    const relative = path.relative(outputBase, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'QA evidence must stay below output/playwright');
  };
  guardOutput(output);
  const requests = []; const errors = []; const expectedFailures = []; const stages = []; const screenshots = []; const layout = [];
  let storageKey; let runtimeErrorKey; let initialized = false; let afterAnalysis;
  let analysisMode = 'success'; let expectedSource = STORY; let nextOptimization = OPTIMIZATIONS[0].text;
  let routesInstalled = false;
  page.setDefaultTimeout(8000);
  const input = () => page.locator('.story-source-textarea');
  const analyze = () => page.locator('.story-input-actions').getByRole('button', { name: /^解析并补全$/u });
  const optimize = () => page.locator('.story-input-actions').getByRole('button', { name: /^AI\s*剧情优化$/u });
  const review = () => page.getByRole('dialog', { name: 'AI 剧情优化 · 结果审阅', exact: true });
  const storyView = () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const getProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
  const snapshot = async () => pickProject(await getProject());
  const readLogs = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), runtimeErrorKey);
  const assertReady = () => assert.ok(initialized, 'call setup() before user-flow QA');
  const waitIdle = () => page.waitForFunction(() => ![...document.querySelectorAll('.story-input-actions button')].find((button) => /^解析并补全$/u.test(button.textContent?.trim() || ''))?.disabled);
  const waitRequestCount = async (count) => {
    const deadline = Date.now() + 10000;
    while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(40);
    assert.equal(requests.length, count, `expected exactly ${count} mock requests; unexpected errors=${errors.join('; ')}`);
  };
  const inspectFit = async (name, selectors) => {
    const result = await page.evaluate((selected) => {
      const problems = selected.flatMap((selector) => [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const hidden = !hit || !(hit === element || element.contains(hit));
        return rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || hidden
          ? [{ selector, text: element.textContent?.slice(0, 60), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hidden }] : [];
      }));
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, problems };
    }, selectors);
    layout.push({ name, ...result });
    assert.deepEqual(result.problems, [], `${name}: required controls stay visible and unobscured`);
  };
  const capture = async (name) => {
    await fs.mkdir(output, { recursive: true });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshotPath = path.join(output, `${name}.png`);
    await page.screenshot({ path: screenshotPath, scale: 'css', fullPage: false });
    screenshots.push({ name, path: screenshotPath });
  };
  const assertSavedCultivators = async () => {
    const project = await getProject();
    assert.equal(project.characters.length, 3);
    assert.deepEqual(project.characters.map(pickCharacter), CHARACTERS.map(pickCharacter), 'all 15 AI character fields must survive unchanged, not just the morphology label');
    assert.equal(project.locations.length, 1);
    assert.deepEqual(Object.fromEntries(Object.keys(LOCATION).map((key) => [key, project.locations[0][key]])), LOCATION);
    assert.equal(project.props.length, 0);
    assert.equal(project.scenes.length, 1);
    assert.equal(project.scenes[0].title, ANALYSIS.scenes[0].title);
    assert.equal(project.scenes[0].content, STORY);
    assert.equal(project.sourceDocuments[0].content, STORY);
    assert.equal(project.characters.some((character) => character.nsfwProfile), false, 'fixture uses ordinary character fields only');
    return project;
  };
  const installRoutes = async () => {
    if (routesInstalled) return;
    routesInstalled = true;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/Failed to load resource:.*503/iu.test(message.text())) errors.push(message.text());
    });
    await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
      errors.push(`Blocked external request: ${route.request().url()}`);
      await route.abort('blockedbyclient');
    });
    await page.route('**/qa-semantic/v1/chat/completions', async (route) => {
      try {
        assert.equal(new URL(route.request().url()).origin, origin);
        assert.equal(route.request().method(), 'POST');
        const payload = route.request().postDataJSON();
        const user = payload.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
        const analysis = user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u);
        const preparation = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u);
        let kind; let content;
        if (analysis) {
          assert.deepEqual(JSON.parse(analysis[1]), { sourceStory: expectedSource }, 'the analysis gets the complete untouched source');
          kind = 'analysis'; content = analysisMode === 'invalid-json' ? 'QA_NOT_JSON' : JSON.stringify(ANALYSIS);
        } else if (preparation) {
          const data = JSON.parse(preparation[1]);
          assert.deepEqual(data, { mode: 'optimize', sourceTextOrRequirement: STORY, dialogueMode: 'ai-read-full-source' }, 'optimization gets the complete source with no local pre-extracted semantic list');
          kind = 'optimize'; content = nextOptimization;
        } else {
          const supplement = user.match(/^需要补全的(人物|地点|道具)名称：([^\n]+)/u);
          assert.ok(supplement, 'unexpected semantic repair or unknown request');
          const names = JSON.parse(supplement[2]);
          assert.ok(user.endsWith(`完整剧情原文：${STORY}`), 'enrichment receives the same full source');
          assert.ok(supplement[1] !== '道具', 'empty props must not schedule enrichment');
          kind = supplement[1] === '人物' ? 'characters' : 'locations';
          assert.deepEqual(names, kind === 'characters' ? CHARACTER_NAMES : [LOCATION.name]);
          content = JSON.stringify({ items: kind === 'characters' ? CHARACTERS : [LOCATION] });
        }
        const status = kind === 'analysis' && analysisMode === 'http503' ? 503 : 200;
        requests.push({ number: requests.length + 1, kind, status, analysisMode, url: route.request().url(), payload, responseContent: status === 503 ? '隔离验收：上游服务暂不可用（HTTP 503）' : content });
        await route.fulfill({ status, contentType: 'application/json', body: status === 503
          ? JSON.stringify({ error: { message: '隔离验收：上游服务暂不可用（HTTP 503）' } })
          : JSON.stringify({ choices: [{ message: { content } }] }) });
      } catch (error) {
        errors.push(`Mock protocol mismatch: ${String(error)}`);
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '隔离验收请求不符合预期；未调用真实API。' } }) }).catch(() => {});
      }
    });
  };

  const qa = {
    page, requests, errors, stages,
    get output() { return output; },
    async setOutputDirectory(directory) { output = path.resolve(directory); guardOutput(output); },
    async setup() {
      await installRoutes();
      await page.goto(target.href, { waitUntil: 'networkidle', timeout: 20000 });
      const keys = await page.evaluate(async ({ origin: localOrigin, story }) => {
        if (window.lianhuaDesktop) throw new Error('Run this browser-localStorage fixture in an isolated web context, not a desktop process with a data bridge.');
        const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
        const { RUNTIME_ERROR_LOG_STORAGE_KEY } = await import('/src/runtimeErrorLog.ts');
        const state = createInitialState(); const now = Date.now();
        const project = { ...state.project, id: 'qa-semantic-human-cultivators', name: '修仙者语义验收（隔离）', sourceDocuments: [{ id: 'qa-semantic-source', name: '修仙者验收原文', content: story, createdAt: now, updatedAt: now }], characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [], createdAt: now, updatedAt: now };
        state.project = project; state.projects = [project]; state.activeProjectId = project.id;
        state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${localOrigin}/qa-semantic/v1`, apiKey: '', model: 'qa-semantic-only', temperature: 0.2, maxTokens: 8192 };
        state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
        for (const key of ['imageApi', 'visionApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) if (state.settings[key]) state.settings[key].enabled = false;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        localStorage.removeItem(RUNTIME_ERROR_LOG_STORAGE_KEY);
        return { storageKey: STORAGE_KEY, runtimeErrorKey: RUNTIME_ERROR_LOG_STORAGE_KEY, schemaVersion: state.schemaVersion };
      }, { origin, story: STORY });
      storageKey = keys.storageKey; runtimeErrorKey = keys.runtimeErrorKey;
      await page.reload({ waitUntil: 'networkidle' });
      await storyView();
      assert.equal(await input().inputValue(), STORY);
      assert.equal((await getProject()).id, 'qa-semantic-human-cultivators');
      assert.equal(requests.length, 0, 'loading the fixture must not submit an API request');
      await inspectFit('initial-story', ['.story-input-actions button', '.story-source-textarea']);
      await capture('01-initial-story');
      initialized = true;
      stages.push({ name: 'setup', schemaVersion: keys.schemaVersion, dynamicallyResolvedStorageKey: true, noDesktopBridge: true, noProductionDataRead: true });
      return { inventory: QA_INVENTORY, schemaVersion: keys.schemaVersion, output };
    },
    async analyzeCultivators() {
      assertReady();
      const before = requests.length;
      await analyze().click();
      await waitRequestCount(before + 3);
      await waitIdle();
      await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.characters.length === 3, storageKey);
      const project = await assertSavedCultivators();
      assert.deepEqual(requests.slice(before).map((request) => request.kind), ['analysis', 'characters', 'locations']);
      assert.equal(requests.length, before + 3, 'no fourth age/morphology semantic-repair request');
      assert.deepEqual(await readLogs(), [], 'successful human cultivators must not create semantic error logs');
      await capture('02-cultivators-parsed');
      afterAnalysis = await snapshot();
      await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
      for (const character of project.characters) {
        await page.locator('.image-entity-controls select').selectOption(character.id);
        assert.equal(await page.getByRole('textbox', { name: '角色名称', exact: true }).inputValue(), character.name);
        assert.equal(await page.getByRole('combobox', { name: '外貌形态', exact: true }).inputValue(), 'human-like');
        assert.equal(await page.getByRole('textbox', { name: '身体结构说明', exact: true }).inputValue(), BODY_PLAN);
        assert.equal(await page.getByRole('textbox', { name: '外观年龄', exact: true }).inputValue(), '约二十岁');
        assert.equal(await page.getByRole('textbox', { name: '实际年龄', exact: true }).inputValue(), '约三百岁');
        assert.equal(await page.getByRole('textbox', { name: '种族 / 族裔', exact: true }).inputValue(), '人族修仙者');
      }
      await inspectFit('image-cultivator-fields', ['.image-entity-controls select', '[aria-label="外貌形态"]', '[aria-label="身体结构说明"]', '[aria-label="外观年龄"]', '[aria-label="实际年龄"]']);
      await capture('03-image-workbench-human-age');
      assert.deepEqual(await snapshot(), afterAnalysis, 'viewing each character must not rewrite the AI data');
      await storyView();
      stages.push({ name: 'human-cultivators', requests: 3, characters: 3, characterFieldsChecked: CHARACTER_KEYS, locations: 1, scenes: 1, semanticRepairs: 0 });
      return stages.at(-1);
    },
    async reviewVariants() {
      assertReady(); assert.ok(afterAnalysis, 'analyzeCultivators must complete first');
      for (const variant of OPTIMIZATIONS) {
        const before = requests.length; nextOptimization = variant.text;
        assert.equal(await input().inputValue(), STORY);
        await optimize().click(); await waitRequestCount(before + 1); await review().waitFor();
        assert.equal(await review().getByRole('textbox', { name: '处理前原文', exact: true }).inputValue(), STORY);
        assert.equal(await review().getByRole('textbox', { name: 'AI 返回结果', exact: true }).inputValue(), variant.text);
        assert.equal(await input().inputValue(), STORY, 'the visible original stays unchanged before adoption');
        assert.deepEqual(await snapshot(), afterAnalysis, 'preview does not save or reparse');
        assert.match(await review().innerText(), /本地语义校验已关闭/u);
        assert.equal(await review().getByRole('tab', { name: '核对提示（0）', exact: true }).count(), 1);
        await inspectFit(`${variant.id}-comparison`, ['.sr-review-tabs', '.sr-review-text-pane textarea', '.sr-review-actions button']);
        await capture(`04-${variant.id}-comparison`);
        await review().getByRole('tab', { name: '核对提示（0）', exact: true }).click();
        assert.match(await review().getByRole('tabpanel').innerText(), /本地不再判断剧情语义/u);
        await inspectFit(`${variant.id}-zero-warnings`, ['.sr-review-tabs', '.sr-review-empty', '.sr-review-actions button']);
        await capture(`05-${variant.id}-zero-warnings`);
        await review().getByRole('button', { name: '采用到编辑区', exact: true }).click();
        assert.equal(await input().inputValue(), variant.text, 'adoption retains the exact AI response, including its authored format/language');
        assert.deepEqual(await snapshot(), afterAnalysis, 'adoption only changes the editor draft');
        await page.getByRole('button', { name: '还原处理前文本', exact: true }).click();
        assert.equal(await input().inputValue(), STORY);
        assert.deepEqual(await snapshot(), afterAnalysis);
        assert.equal(requests.length, before + 1, 'review, adoption and restore never add a semantic repair request');
      }
      assert.deepEqual(await readLogs(), [], 'valid text in either format causes no local semantic error log');
      await capture('06-optimization-restored');
      stages.push({ name: 'optimization-review', variants: OPTIMIZATIONS.map((variant) => variant.id), requests: OPTIMIZATIONS.length, warnings: 0, exactResultAdoption: true, restored: true, savedDataUnchanged: true });
      return stages.at(-1);
    },
    async technicalFailures() {
      assertReady(); assert.ok(afterAnalysis, 'analyzeCultivators must complete first');
      for (const failure of ['http503', 'invalid-json']) {
        analysisMode = failure; expectedSource = `${STORY}\n隔离验收新草稿：${failure}，解析失败时不要覆盖原有成果。`;
        await input().fill(expectedSource);
        const before = requests.length;
        await analyze().click(); await waitRequestCount(before + 1); await waitIdle();
        assert.equal(requests.length, before + 1, `${failure} must not advance to enrichment or a semantic retry`);
        assert.deepEqual(await snapshot(), afterAnalysis, `${failure} preserves saved people, scenes and source`);
        assert.equal(await input().inputValue(), expectedSource, 'failure preserves the user draft too');
        await page.locator('.runtime-error-log-trigger').click();
        const logs = page.getByRole('dialog', { name: '报错日志', exact: true }); await logs.waitFor();
        const entry = logs.locator('.runtime-error-log-entry').first();
        const message = await entry.innerText();
        assert.match(message, failure === 'http503' ? /HTTP\s*503|上游服务暂不可用/u : /不是有效\s*JSON|无效\s*JSON|JSON.*(?:结构|读取|解析|格式)/u, 'technical failure remains explicit and understandable');
        assert.doesNotMatch(message, /非人类角色年龄|人类化年龄|年龄模板|未识别的错误|无法识别具体原因/u);
        await inspectFit(`${failure}-error`, ['.runtime-error-log-head', '.runtime-error-log-actions button']);
        await capture(`07-${failure}-technical-error`);
        expectedFailures.push({ kind: failure, message });
        await logs.getByRole('button', { name: '关闭', exact: true }).click();
        await input().fill(STORY);
      }
      analysisMode = 'success'; expectedSource = STORY;
      assert.deepEqual(await snapshot(), afterAnalysis);
      await assertSavedCultivators();
      stages.push({ name: 'technical-failures', cases: expectedFailures.map((failure) => failure.kind), savedDataUnchanged: true, noSemanticRetry: true });
      return stages.at(-1);
    },
    async finish() {
      assertReady();
      assert.deepEqual(errors, [], 'no unexpected browser errors, protocol mismatch or external requests');
      const report = { mockOnly: true, browserLocalStorageOnly: true, noProductionDataRead: true, noPaidApi: true, inventory: QA_INVENTORY, requests, stages, expectedFailures, screenshots, layout, errors, visualReviewRequired: 'Screenshots are evidence for independent review by the calling agent, not an automatic visual signoff.' };
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      await fs.writeFile(path.join(output, 'last-view.yml'), await page.locator('body').ariaSnapshot());
      return report;
    },
  };
  runs.set(page, qa);
  return qa;
}

export async function setup(page, baseUrl, outputDirectory) {
  const qa = await createSemanticAcceptanceUiQa({ page, baseUrl, outputDirectory });
  await qa.setup();
  return qa;
}

export async function run(page, outputDirectory) {
  const qa = runs.get(page);
  assert.ok(qa, 'call setup(page, baseUrl) first');
  if (outputDirectory) await qa.setOutputDirectory(outputDirectory);
  await qa.analyzeCultivators();
  await qa.reviewVariants();
  await qa.technicalFailures();
  return qa.finish();
}
