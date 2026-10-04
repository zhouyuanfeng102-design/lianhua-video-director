import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Staged helpers for the persistent Playwright Interactive REPL. This module
// never launches a browser/server and never opens a production data directory.
export const directorLookRequirementQaInventory = [
  '空白/纯空格要求沿用原请求，不附加 customRequirement；清空后可以返回原分析',
  '专用要求完整传递、与下方额外要求独立；AI 回填导演分类/风格/说明/视觉',
  '分析不改变时长、镜数或通用额外要求',
  '项目 A/B 分别保存专用要求，切换及重载不串写',
  '请求中改要求、手动改风格、A→B→A、离开导演页，迟到结果不回填',
  '1120×720/1280×800，100%/130% 字号，标题/输入框/按钮可见且可命中',
];

const runs = new WeakMap();
const custom = (page) => page.locator('textarea[aria-label="导演与视觉自定义要求"]');
const general = (page) => page.locator('.director-motion-pane textarea.director-requirement');
const fillButton = (page) => page.locator('#director-setup-style').getByRole('button', { name: 'AI 分析填写', exact: true });
const styleInputs = (page) => page.locator('#director-setup-style .director-style-pane input');
const sourceScenes = [
  { title: '庭院启程', content: '旅人甲提起行囊，推开庭院木门，准备与旅人乙同行。' },
  { title: '廊桥同行', content: '旅人甲与旅人乙沿廊桥缓步前行，一起停下观赏河面。' },
  { title: '山亭休息', content: '两人走到山亭，放下行囊，安静眺望远处的山谷。' },
];
const fullStory = sourceScenes.map((scene, index) => `【场景${index + 1}：${scene.title}】\n${scene.content}`).join('\n\n');
const resultDefault = {
  directorCategory: '旅行叙事',
  directorStyle: '自然留白与稳定跟随的舒缓调度',
  directorStyleSummary: '以稳定跟随建立同行关系，远景保留环境，近景呈现平静交流和自然停顿。',
  visualStyle: '柔和自然光的清透电影写实',
  reason: '原来的剧情分析模式。',
};
const resultCustom = {
  directorCategory: '水墨奇幻',
  directorStyle: '淡彩留白与缓慢推进的诗意调度',
  directorStyleSummary: '遵循水墨要求组织镜头，以长镜头和前后景留白保持舒缓节奏与人物空间关系。',
  visualStyle: '淡彩水墨与柔和纸张肌理',
  reason: '根据专用要求分析四项风格。',
};
const staleResult = {
  directorCategory: '过期结果',
  directorStyle: '迟到请求不应覆盖当前设置',
  directorStyleSummary: '这一段来自已失效请求，界面不得填写。',
  visualStyle: '过期请求的测试视觉',
  reason: '隔离测试迟到响应。',
};

const eventually = async (condition, label, timeoutMs = 10000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Director look QA timed out: ${label}`);
};
const settleLayout = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const enterDirector = async (page) => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await custom(page).waitFor();
};
const readLook = (page) => page.locator('#director-setup-style').evaluate((section) => {
  const inputs = [...section.querySelectorAll('.director-style-pane input')];
  return {
    directorCategory: inputs[0].value,
    directorStyle: inputs[1].value,
    visualStyle: inputs[2].value,
    directorStyleSummary: section.querySelectorAll('.director-style-pane > .field')[1].querySelector('.field-hint').textContent,
  };
});
const expectedLook = (result) => ({
  directorCategory: result.directorCategory,
  directorStyle: result.directorStyle,
  visualStyle: result.visualStyle,
  directorStyleSummary: result.directorStyleSummary,
});
const waitForLook = async (page, result) => eventually(
  async () => JSON.stringify(await readLook(page)) === JSON.stringify(expectedLook(result)),
  'AI result fills all four look fields',
);
const waitSavedRequirement = async (page, id, requirement) => {
  const qa = runs.get(page);
  await page.waitForFunction(({ key, id, requirement }) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    return state?.project?.id === id && state.project.directorLookRequirement === requirement;
  }, { key: qa.storageKey, id, requirement }, { timeout: 12000 });
};
const switchProject = async (page, name) => {
  await page.locator('.top-actions .top-action-library').click();
  await page.getByRole('dialog', { name: '项目库', exact: true })
    .locator('.project-library-select').filter({ hasText: name }).click();
  await enterDirector(page);
};
const readUnrelatedControls = async (page) => ({
  duration: await page.locator('.director-timing-fields .seconds-card input').inputValue(),
  shotCount: await page.locator('.director-timing-fields .count-card input').inputValue(),
  generalRequirement: await general(page).inputValue(),
});
const requestAnalysis = async (page, result) => {
  const qa = runs.get(page); const before = qa.requests.length;
  await fillButton(page).click();
  await eventually(() => qa.requests.length === before + 1, 'one local AI request');
  await waitForLook(page, result);
  await fillButton(page).waitFor();
  return qa.requests[before];
};
const holdAnalysis = async (page, tag) => {
  const qa = runs.get(page);
  assert.equal(qa.holdNext, '', 'only one held request may be arranged at a time');
  qa.holdNext = tag;
  await fillButton(page).click();
  await eventually(() => qa.pending.has(tag), `held request ${tag}`);
};
const releaseAnalysis = async (page, tag) => {
  const qa = runs.get(page); const request = qa.pending.get(tag);
  assert.ok(request, `held request ${tag} exists`);
  request.resolve();
  await eventually(() => request.finished, `released request ${tag}`);
  await settleLayout(page);
};

export async function setupDirectorLookRequirementQa(browser, baseUrl) {
  assert.ok(browser?.newContext, 'pass an existing Playwright browser from the persistent REPL');
  const origin = new URL(baseUrl).origin;
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'QA requires a loopback development server');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const qa = { context, page, origin, storageKey: '', requests: [], errors: [], expectedDevDiagnostics: [], expectedAbortDiagnostics: [], blocked: [], screenshots: [], stages: [], layouts: [], pending: new Map(), holdNext: '' };
  runs.set(page, qa);
  page.on('pageerror', (error) => qa.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // We intentionally close development HMR sockets below. Keep this exact
    // Vite diagnostic visible in the report without classifying it as an app
    // failure; no other Vite or console error is suppressed.
    if (message.text().startsWith('[vite] failed to connect to websocket.')) {
      qa.expectedDevDiagnostics.push(message.text());
      return;
    }
    const expectedHeldAbort = /ERR_ABORTED|ERR_FAILED|ERR_CANCELED/iu.test(message.text())
      && message.location().url?.includes('/qa-director-look/')
      && [...qa.pending.values()].some((request) => !request.finished);
    if (expectedHeldAbort) qa.expectedAbortDiagnostics.push(message.text());
    else qa.errors.push(message.text());
  });
  await page.routeWebSocket(/.*/u, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) {
      qa.blocked.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    if (url.origin === origin && url.pathname === '/__qa_director_look_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>导演风格隔离资料</title><body>仅初始化隔离浏览器数据</body></html>' });
      return;
    }
    if (url.origin === origin && url.pathname === '/qa-director-look/v1/chat/completions') {
      const tag = qa.holdNext; qa.holdNext = ''; let held;
      try {
        assert.equal(request.method(), 'POST');
        const body = request.postDataJSON();
        const content = (role) => body.messages.filter((message) => message.role === role)
          .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
        const system = content('system'); const user = content('user');
        const match = user.match(/<director_look_data>\s*([\s\S]*?)\s*<\/director_look_data>/u);
        assert.ok(match, 'director look requests must use their JSON data boundary');
        const data = JSON.parse(match[1]);
        qa.requests.push({ data, system, user, tag });
        if (tag) await new Promise((resolve) => {
          held = { resolve, finished: false }; qa.pending.set(tag, held);
        });
        const result = tag ? staleResult : data.customRequirement ? resultCustom : resultDefault;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
      } catch (error) {
        const expectedAbort = tag && held && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error));
        if (!expectedAbort) {
          qa.errors.push(error instanceof Error ? error.message : String(error));
          await route.fulfill({ status: 500, body: 'Isolated look fixture rejected a request' }).catch(() => {});
        }
      } finally { if (held) held.finished = true; }
      return;
    }
    if (url.origin === origin && !['GET', 'HEAD'].includes(request.method())) {
      qa.blocked.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.goto(`${origin}/__qa_director_look_fixture.html`, { waitUntil: 'domcontentloaded' });
  qa.storageKey = await page.evaluate(async ({ origin, scenes, story }) => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const makeProject = (id, name, content, projectScenes) => ({
      ...state.project, id, name, description: '仅用于导演与视觉自定义要求隔离测试',
      directorLookRequirement: '',
      sourceDocuments: [{ id: `${id}-source`, name: '同行完整剧情', content, createdAt: now, updatedAt: now }],
      scenes: projectScenes.map((scene, index) => ({
        id: `${id}-scene-${index}`, ...scene, summary: scene.content,
        characterIds: [], propIds: [], locationIds: [], storyboardIds: [], createdAt: now + index, updatedAt: now + index,
      })),
      characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
      createdAt: now, updatedAt: now,
    });
    const a = makeProject('look-qa-a', '风格要求测试A', story, scenes);
    const otherStory = '另一位旅人在灯塔前停下，远处船只慢慢驶入海湾。';
    const b = makeProject('look-qa-b', '风格要求测试B', otherStory, [{ title: '灯塔海湾', content: otherStory }]);
    state.project = a; state.projects = [a, b]; state.activeProjectId = a.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/qa-director-look/v1`, apiKey: '', model: 'isolated-director-look' };
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    for (const name of ['imageApi', 'visionApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name].enabled = false;
    state.settings.uiFontScalePercent = 100;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return STORAGE_KEY;
  }, { origin, scenes: sourceScenes, story: fullStory });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await enterDirector(page);
  return { page, context, inventory: directorLookRequirementQaInventory, fixtureProjects: ['look-qa-a', 'look-qa-b'], scopeCoverage: 'Single-mode UI uses three real source scenes. Full-film/segment source routing is covered by the directorLookSource unit tests.' };
}

export async function runDirectorLookRequirementBasicQa(page) {
  const qa = runs.get(page); assert.ok(qa);
  await custom(page).fill('');
  const generalText = '通用要求保持人物服装、对白和场景连续；原有风格偏好电影写实。';
  await general(page).fill(generalText);
  await page.getByRole('button', { name: '精确指定', exact: true }).click();
  await page.locator('.director-timing-fields .count-card input').fill('4');
  await page.locator('.director-timing-fields .seconds-card input').fill('12');
  const untouched = await readUnrelatedControls(page);
  const first = await requestAnalysis(page, resultDefault);
  assert.equal(Object.hasOwn(first.data, 'customRequirement'), false);
  assert.doesNotMatch(first.system, /customRequirement/u);
  assert.equal(first.data.extraRequirement, generalText);
  assert.match(first.data.story, /庭院启程[\s\S]*廊桥同行[\s\S]*山亭休息/u);
  await custom(page).fill(' \t\n　 ');
  const whitespace = await requestAnalysis(page, resultDefault);
  assert.equal(Object.hasOwn(whitespace.data, 'customRequirement'), false);
  assert.equal(whitespace.system, first.system);
  const longRequirement = `  使用淡彩水墨、舒缓长镜头和大量留白。\n${'参考河岸的安静气氛，保持人物关系与自然调度。'.repeat(240)}\n尾部要求：纸张肌理、低饱和暖光。  `;
  await custom(page).fill(longRequirement);
  const filled = await requestAnalysis(page, resultCustom);
  assert.equal(filled.data.customRequirement, longRequirement.trim());
  assert.ok(filled.data.customRequirement.length > 4000);
  assert.equal(filled.data.extraRequirement, generalText);
  assert.match(filled.system, /优先于 current 和通用 extraRequirement 中的风格偏好/u);
  assert.equal(JSON.stringify(await readUnrelatedControls(page)), JSON.stringify(untouched));
  await custom(page).fill('');
  const cleared = await requestAnalysis(page, resultDefault);
  assert.equal(Object.hasOwn(cleared.data, 'customRequirement'), false);
  assert.equal(JSON.stringify(await readUnrelatedControls(page)), JSON.stringify(untouched));
  qa.stages.push('blank-whitespace-custom-fulltext-fill-clear-unrelated-controls');
  return { requests: 4, customCharacters: filled.data.customRequirement.length, originalRequirementsPreserved: true, fourFieldsFilled: true };
}

export async function runDirectorLookRequirementPersistenceQa(page) {
  const qa = runs.get(page); assert.ok(qa);
  const requirementA = '项目A：水墨远景，舒缓推进，人物调度保持自然。';
  const requirementB = '项目B：明亮海湾，清透电影感与稳定跟随。';
  await custom(page).fill(requirementA);
  await waitSavedRequirement(page, 'look-qa-a', requirementA);
  await switchProject(page, '风格要求测试B');
  assert.equal(await custom(page).inputValue(), '');
  await custom(page).fill(requirementB);
  await waitSavedRequirement(page, 'look-qa-b', requirementB);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.equal(await custom(page).inputValue(), requirementB);
  await switchProject(page, '风格要求测试A');
  assert.equal(await custom(page).inputValue(), requirementA);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.equal(await custom(page).inputValue(), requirementA);
  await switchProject(page, '风格要求测试B');
  assert.equal(await custom(page).inputValue(), requirementB);
  await switchProject(page, '风格要求测试A');
  qa.stages.push('per-project-requirement-switch-and-reload');
  return { projects: 2, reloads: 2, isolatedRequirements: true };
}

export async function runDirectorLookRequirementStaleQa(page) {
  const qa = runs.get(page); assert.ok(qa);
  await custom(page).fill('水墨与舒缓调度。');
  await requestAnalysis(page, resultCustom);
  const stable = await readLook(page);
  await holdAnalysis(page, 'stale-requirement');
  await custom(page).fill('已改为清透电影感，旧请求不得回填。');
  await releaseAnalysis(page, 'stale-requirement');
  assert.equal(JSON.stringify(await readLook(page)), JSON.stringify(stable));
  await fillButton(page).waitFor();

  await holdAnalysis(page, 'stale-manual-style');
  await styleInputs(page).nth(1).fill('用户手动设置的导演风格');
  const manual = await readLook(page);
  await releaseAnalysis(page, 'stale-manual-style');
  assert.equal(JSON.stringify(await readLook(page)), JSON.stringify(manual));
  await fillButton(page).waitFor();

  await holdAnalysis(page, 'stale-project-roundtrip');
  await switchProject(page, '风格要求测试B');
  await switchProject(page, '风格要求测试A');
  const returned = await readLook(page);
  await releaseAnalysis(page, 'stale-project-roundtrip');
  assert.equal(JSON.stringify(await readLook(page)), JSON.stringify(returned));
  await fillButton(page).waitFor();

  await holdAnalysis(page, 'stale-leave-director');
  const beforeLeaving = await readLook(page);
  await page.locator('.sidebar').getByRole('button', { name: '项目总览', exact: true }).click();
  await releaseAnalysis(page, 'stale-leave-director');
  await enterDirector(page);
  assert.equal(JSON.stringify(await readLook(page)), JSON.stringify(beforeLeaving));
  await requestAnalysis(page, resultCustom);
  assert.equal(qa.pending.size, 4);
  assert.ok([...qa.pending.values()].every((request) => request.finished));
  qa.stages.push('stale-requirement-manual-style-project-roundtrip-unmount');
  return { rejectedStaleResponses: 4, validNextRequestWorks: true, expectedCancellationAllowed: true };
}

export async function runDirectorLookRequirementLayoutQa(page, outputDirectory) {
  const qa = runs.get(page); assert.ok(qa);
  const allowed = path.resolve(import.meta.dirname, '../output/playwright');
  const directory = path.resolve(outputDirectory); const relative = path.relative(allowed, directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'QA evidence stays below output/playwright');
  await fs.mkdir(directory, { recursive: true });
  await custom(page).fill('水墨电影感，柔和暖光；慢节奏长镜头，保留人物自然关系。\n第二行自定义要求：适度留白，不使用夸张快速剪辑。');
  const layouts = [];
  for (const [width, height] of [[1280, 800], [1120, 720]]) {
    await page.setViewportSize({ width, height });
    for (const scale of [100, 130]) {
      await page.getByRole('button', { name: '界面与字体设置', exact: true }).click();
      await page.getByRole('spinbutton', { name: '自定义字体大小百分比', exact: true }).fill(String(scale));
      await page.getByRole('button', { name: '关闭界面设置', exact: true }).click();
      await settleLayout(page);
      const layout = await page.locator('#director-setup-style').evaluate((section) => {
        const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const row = section.querySelector('.director-look-analysis-row');
        const title = row.querySelector('span'); const textarea = row.querySelector('textarea'); const button = row.querySelector('button');
        const controlCard = section.closest('.director-control-card');
        if (!controlCard) throw new Error('Director control card missing from layout fixture');
        const targets = [title, ...controlCard.querySelectorAll('input,textarea,select,button')].filter((element) => {
          const style = getComputedStyle(element);
          return element.getClientRects().length > 0 && style.display !== 'none'
            && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        });
        const checks = targets.map((element) => {
          const r = rect(element); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const clippedBy = [];
          for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            const style = getComputedStyle(parent); const bounds = parent.getBoundingClientRect();
            if ((/(hidden|clip)/u.test(style.overflowX) && (r.x < bounds.x - 1 || r.right > bounds.right + 1))
              || (/(hidden|clip)/u.test(style.overflowY) && (r.y < bounds.y - 1 || r.bottom > bounds.bottom + 1))) clippedBy.push(parent.className);
          }
          return {
            name: element.getAttribute('aria-label') || element.textContent || element.tagName,
            group: element.closest('.director-generate-bar') ? 'generation-action'
              : element.closest('.director-motion-pane') ? 'motion-and-requirements'
                : element.closest('.director-setup-section')?.id || 'director-control-card',
            rect: r, hit: hit === element || element.contains(hit),
            fitsViewport: r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
            clippedBy,
          };
        });
        const titleRect = rect(title); const textRect = rect(textarea); const buttonRect = rect(button); const paneRect = rect(section.querySelector('.director-style-pane'));
        const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
        return {
          width: innerWidth, height: innerHeight, scale: document.querySelector('.app-shell').dataset.uiFontScale,
          section: rect(section), header: rect(row), textRect, buttonRect, paneRect, checks,
          headerOverlap: overlap(titleRect, textRect) || overlap(textRect, buttonRect) || overlap(titleRect, buttonRect),
          fieldsOverlapHeader: paneRect.y < Math.max(titleRect.bottom, textRect.bottom, buttonRect.bottom) - 1,
          documentScrollX: document.documentElement.scrollWidth > innerWidth + 1,
          documentScrollY: document.documentElement.scrollHeight > innerHeight + 1,
        };
      });
      const file = path.join(directory, `director-look-requirement-${width}x${height}-${scale}.png`);
      await page.screenshot({ path: file, scale: 'css', fullPage: false });
      qa.screenshots.push(file); layouts.push(layout); qa.layouts.push(layout);
      assert.equal(layout.headerOverlap, false, JSON.stringify(layout));
      assert.equal(layout.fieldsOverlapHeader, false, JSON.stringify(layout));
      assert.equal(layout.documentScrollX, false, JSON.stringify(layout));
      assert.equal(layout.documentScrollY, false, JSON.stringify(layout));
      assert.ok(layout.checks.some((item) => item.group === 'motion-and-requirements'), 'motion controls must be covered');
      assert.ok(layout.checks.some((item) => item.group === 'generation-action'), 'bottom generation action must be covered');
      assert.equal(layout.checks.filter((item) => !item.hit || !item.fitsViewport || item.clippedBy.length).length, 0, JSON.stringify(layout));
      await custom(page).click();
      assert.equal(await custom(page).evaluate((element) => document.activeElement === element), true);
      await requestAnalysis(page, resultCustom);
    }
  }
  qa.stages.push('four-viewport-font-cases-with-clickable-header-and-real-analysis');
  return { layouts, screenshots: [...qa.screenshots], visualReviewRequired: true };
}

export async function finishDirectorLookRequirementQa(page, { close = true } = {}) {
  const qa = runs.get(page); assert.ok(qa);
  qa.pending.forEach((request) => request.resolve());
  const report = {
    inventory: directorLookRequirementQaInventory,
    stages: [...qa.stages], requests: qa.requests.length,
    customRequests: qa.requests.filter((request) => Boolean(request.data.customRequirement)).length,
    heldRequests: qa.requests.filter((request) => Boolean(request.tag)).length,
    errors: [...qa.errors], expectedDevDiagnostics: [...qa.expectedDevDiagnostics], expectedAbortDiagnostics: [...qa.expectedAbortDiagnostics],
    blockedNetwork: [...qa.blocked], screenshots: [...qa.screenshots], layouts: [...qa.layouts],
    scopeCoverage: 'Full-film/segment source selection is verified by pure unit tests, not by forging a confirmed sequence plan in the UI.',
  };
  if (close) await qa.context.close();
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.equal(report.blockedNetwork.length, 0, JSON.stringify(report.blockedNetwork));
  return report;
}
