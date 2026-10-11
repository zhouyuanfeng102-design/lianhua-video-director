import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// One focused pass against the real App in a fresh, disposable browser context.
// All AI responses and images are synthetic; all non-local requests are blocked.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', 'director-look-reference-190');
const textResult = {
  directorCategory: '旅行叙事', directorStyle: '自然留白与稳定跟随的舒缓调度',
  directorStyleSummary: '稳定跟随建立同行关系，远景保留环境，近景呈现平静交流和自然停顿。',
  visualStyle: '柔和自然光的清透电影写实', reason: '旧文本流程的隔离响应。',
};
const imageResult = {
  directorCategory: '奇幻动作CG', directorStyle: '克制电影调度与自然空间层次',
  directorStyleSummary: '结合画面气质组织稳定镜头和前后景关系，以自然空间层次保持人物调度清楚。',
  visualStyle: '电影级真实三维渲染，细腻材质与柔和暖光，青灰背景、自然景深和克制颗粒质感',
  baseVisualStyle: '电影写实', reason: '识别合成参考图风格。',
};
const customResult = {
  directorCategory: '低饱和奇幻', directorStyle: '自然留白与克制推进的电影调度',
  directorStyleSummary: '遵循低饱和要求组织镜头，保持参考图的材质与自然空间关系，不添加图中人物或动作。',
  visualStyle: '保留细腻三维材质与真实皮肤纹理，改为低饱和青灰调色、柔和暖光和自然电影景深',
  baseVisualStyle: '电影写实', reason: '结合参考图和专用要求。',
};
const staleResult = {
  directorCategory: '过期结果', directorStyle: '迟到请求不得覆盖当前设置',
  directorStyleSummary: '这项来自已失效请求，界面与持久化资料都不得填写。',
  visualStyle: '过期参考图的错误视觉描述', baseVisualStyle: '纪录片', reason: '迟到测试响应。',
};
const section = (page) => page.locator('#director-setup-style');
const custom = (page) => page.getByRole('textbox', { name: '导演与视觉自定义要求', exact: true });
const general = (page) => page.locator('.director-motion-pane textarea.director-requirement');
const fileInput = (page) => page.getByLabel('选择风格参考图文件', { exact: true });
const analyze = (page) => section(page).getByRole('button', { name: 'AI 分析填写', exact: true });
const previewButton = (page) => section(page).getByRole('button', { name: '查看风格参考图', exact: true });
const dialog = (page) => page.getByRole('dialog', { name: '风格参考图', exact: true });
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const eventually = async (condition, label, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Director reference QA timed out: ${label}`);
};
const readLook = (page) => section(page).evaluate((element) => {
  const inputs = [...element.querySelectorAll('.director-style-pane input')];
  return {
    directorCategory: inputs[0].value, directorStyle: inputs[1].value, visualStyle: inputs[2].value,
    directorStyleSummary: element.querySelectorAll('.director-style-pane > .field')[1].querySelector('.field-hint').textContent,
  };
});
const expectedLook = ({ directorCategory, directorStyle, visualStyle, directorStyleSummary }) => ({ directorCategory, directorStyle, visualStyle, directorStyleSummary });

export async function runStandaloneDirectorLookReferenceUiQa() {
  const pureOnly = process.env.QA_PURE_IMAGE_ONLY === '1';
  const reportName = pureOnly ? 'pure-image-report.json' : 'report.json';
  await fs.mkdir(output, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  let browser; let context; let page; let storageKey = '';
  const requests = []; const errors = []; const blocked = []; const expectedDiagnostics = [];
  const stages = []; const screenshots = []; const layouts = []; const pending = new Map();
  let holdNext = '';
  const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
  const waitProject = (predicate, label) => eventually(async () => predicate(await readProject()), label);
  const enterDirector = async () => {
    await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
    await custom(page).waitFor();
  };
  const capture = async (name) => {
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' });
    screenshots.push(file);
  };
  const switchChapter = async (id) => {
    await page.getByRole('combobox', { name: '当前章节', exact: true }).selectOption(id);
    await waitProject((project) => project.activeChapterId === id, `active chapter ${id}`);
    await custom(page).waitFor();
  };
  const upload = async (image, name) => {
    const before = requests.length;
    await fileInput(page).setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await previewButton(page).waitFor();
    await waitProject((project) => project.assets.find((asset) => asset.id === project.directorLookReferenceAssetId)?.fileName === name, `uploaded ${name}`);
    await eventually(() => analyze(page).isEnabled(), 'upload releases analysis button');
    assert.equal(requests.length, before, 'upload never invokes an AI endpoint');
  };
  const remove = async () => {
    const before = requests.length;
    await previewButton(page).click();
    await dialog(page).getByRole('button', { name: '移除', exact: true }).click();
    await section(page).getByRole('button', { name: '上传风格参考图', exact: true }).waitFor();
    await waitProject((project) => !project.directorLookReferenceAssetId, 'reference removed');
    assert.equal(requests.length, before, 'removal never invokes an AI endpoint');
  };
  const requestAnalysis = async (expected) => {
    const index = requests.length;
    await analyze(page).click();
    await eventually(() => requests.length === index + 1, 'one mocked look request');
    await eventually(async () => JSON.stringify(await readLook(page)) === JSON.stringify(expectedLook(expected)), 'atomic four-field fill');
    await eventually(() => analyze(page).isEnabled(), 'analysis completes');
    return requests[index];
  };
  const hold = async (tag) => {
    assert.equal(holdNext, ''); holdNext = tag;
    await analyze(page).click();
    await eventually(() => pending.has(tag), `held ${tag}`);
  };
  const release = async (tag) => {
    const request = pending.get(tag); assert.ok(request);
    request.resolve();
    await eventually(() => request.finished, `released ${tag}`);
    await settle(page);
  };

  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const expected = message.text().startsWith('[vite] failed to connect to websocket.')
        || (/ERR_ABORTED|ERR_FAILED|ERR_CANCELED/iu.test(message.text())
          && message.location().url.includes('/qa-look-reference/')
          && [...pending.values()].some((request) => !request.finished));
      if (expected) expectedDiagnostics.push(message.text()); else errors.push(message.text());
    });
    await page.routeWebSocket(/.*/u, (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && url.origin !== origin) {
        blocked.push(request.url()); await route.abort('blockedbyclient'); return;
      }
      if (url.pathname === '/__qa_look_reference_fixture.html') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>隔离风格参考图测试</title><body>仅初始化合成测试资料</body></html>' }); return;
      }
      if (/^\/qa-look-reference\/(?:text|vision)\/v1\/chat\/completions$/u.test(url.pathname)) {
        const tag = holdNext; holdNext = ''; let held;
        try {
          assert.equal(request.method(), 'POST');
          const body = request.postDataJSON();
          const roleText = (role) => body.messages.filter((message) => message.role === role)
            .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
          const system = roleText('system'); const user = roleText('user');
          const match = user.match(/<director_look_data>\s*([\s\S]*?)\s*<\/director_look_data>/u);
          assert.ok(match, 'look request retains its untrusted data boundary');
          const data = JSON.parse(match[1]);
          const images = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
          const vision = url.pathname.includes('/vision/');
          assert.equal(images.length, vision ? 1 : 0);
          assert.equal(body.model, vision ? 'isolated-look-vision' : 'isolated-look-text');
          if (vision) assert.match(images[0].image_url.url, /^data:image\/png;base64,/u);
          requests.push({ endpoint: vision ? 'vision' : 'text', imageCount: images.length, model: body.model, data, system, tag });
          if (tag) await new Promise((resolve) => { held = { resolve, finished: false }; pending.set(tag, held); });
          const result = tag ? staleResult : !vision ? textResult : data.customRequirement ? customResult : imageResult;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
        } catch (error) {
          if (!(tag && held && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error)))) {
            errors.push(String(error));
            await route.fulfill({ status: 500, body: 'Isolated style-reference fixture rejected the request' }).catch(() => {});
          }
        } finally { if (held) held.finished = true; }
        return;
      }
      if (url.origin === origin && !['GET', 'HEAD'].includes(request.method())) {
        blocked.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    await page.goto(`${origin}/__qa_look_reference_fixture.html`, { waitUntil: 'domcontentloaded' });
    storageKey = await page.evaluate(async ({ origin, pureOnly }) => {
      const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
      const state = createInitialState(); const now = Date.now();
      const sourceDocuments = [
        { id: 'look-chapter-a', name: '第一章', content: '旅人甲与旅人乙沿廊桥缓步前行，一起停下观赏河面。', createdAt: now, updatedAt: now },
        { id: 'look-chapter-b', name: '第二章', content: '', createdAt: now, updatedAt: now },
      ];
      const project = {
        ...state.project, id: 'look-reference-ui-qa', name: '风格参考图隔离测试', sourceDocuments,
        activeChapterId: 'look-chapter-a', chapterWorkspaces: {}, directorLookRequirement: '',
        directorLookReferenceAssetId: undefined, directorLookDraft: undefined, storyDraft: undefined,
        scenes: [{ id: 'look-scene-a', chapterId: 'look-chapter-a', title: '廊桥同行', content: sourceDocuments[0].content, summary: sourceDocuments[0].content,
          characterIds: [], propIds: [], locationIds: [], storyboardIds: [], createdAt: now, updatedAt: now }],
        characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
        createdAt: now, updatedAt: now,
      };
      state.project = project; state.projects = [project]; state.activeProjectId = project.id;
      state.settings.textApi = { ...state.settings.textApi, enabled: !pureOnly, provider: 'openai_compatible', baseUrl: `${origin}/qa-look-reference/text/v1`, model: 'isolated-look-text', apiKey: '' };
      state.settings.visionApi = { ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible', baseUrl: `${origin}/qa-look-reference/vision/v1`, model: 'isolated-look-vision', apiKey: '' };
      state.settings.textApiProfiles = []; state.settings.visionApiProfiles = [];
      state.settings.activeTextApiProfileId = null; state.settings.activeVisionApiProfileId = null;
      for (const name of ['imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name].enabled = false;
      state.settings.uiFontScalePercent = 100;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return STORAGE_KEY;
    }, { origin, pureOnly });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await enterDirector();
    const images = await page.evaluate(() => [0, 1, 2].map((index) => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 112;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = ['#dbc6ab', '#bad4cb', '#c5c7df'][index]; ctx.fillRect(0, 0, 160, 112);
      ctx.fillStyle = ['#755b48', '#426c62', '#515578'][index]; ctx.fillRect(36, 18, 74, 76);
      return canvas.toDataURL('image/png').split(',')[1];
    }));
    if (pureOnly) {
      await switchChapter('look-chapter-b');
      assert.equal(await custom(page).inputValue(), '');
      assert.equal(await page.locator('.director-timing-fields').count(), 0, 'empty-story entry exposes only style controls');
      assert.equal(await page.locator('.director-generate-bar').count(), 0, 'empty-story entry does not expose generation actions');
      await page.setViewportSize({ width: 1120, height: 720 });
      await page.getByRole('button', { name: '界面与字体设置', exact: true }).click();
      await page.getByRole('spinbutton', { name: '自定义字体大小百分比', exact: true }).fill('130');
      await page.getByRole('button', { name: '关闭界面设置', exact: true }).click();
      const verifyEmptyLayout = async (hasReference) => {
        await settle(page);
        const layout = await section(page).evaluate((element) => {
          const rect = (target) => { const r = target.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          const targets = [...element.querySelectorAll('input,textarea,select,button')].filter((target) => getComputedStyle(target).display !== 'none');
          const checks = targets.map((target) => {
            const r = rect(target); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const clippedBy = [];
            for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              const style = getComputedStyle(parent); const b = parent.getBoundingClientRect();
              if ((/(hidden|clip)/u.test(style.overflowX) && (r.x < b.x - 1 || r.right > b.right + 1))
                || (/(hidden|clip)/u.test(style.overflowY) && (r.y < b.y - 1 || r.bottom > b.bottom + 1))) clippedBy.push(parent.className);
            }
            return { name: target.getAttribute('aria-label') || target.textContent || target.tagName, rect: r,
              hit: target === hit || target.contains(hit), clippedBy,
              fits: r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
          });
          const row = element.querySelector('.director-look-analysis-row');
          const items = [row.querySelector(':scope > span'), row.querySelector('textarea'), ...row.querySelectorAll('button')].map(rect);
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
          return { width: innerWidth, height: innerHeight, scale: document.querySelector('.app-shell').dataset.uiFontScale,
            hasReference: row.querySelector('.director-look-reference-button').classList.contains('has-reference'), checks,
            headerOverlap: items.some((a, index) => items.slice(index + 1).some((b) => overlap(a, b))),
            fieldsOverlapHeader: rect(element.querySelector('.director-style-pane')).y < Math.max(...items.map((r) => r.bottom)) - 1,
            documentScrollX: document.documentElement.scrollWidth > innerWidth + 1, documentScrollY: document.documentElement.scrollHeight > innerHeight + 1 };
        });
        assert.equal(layout.hasReference, hasReference); assert.equal(layout.headerOverlap, false); assert.equal(layout.fieldsOverlapHeader, false);
        assert.equal(layout.documentScrollX, false); assert.equal(layout.documentScrollY, false);
        assert.deepEqual(layout.checks.filter((check) => !check.hit || !check.fits || check.clippedBy.length), []);
        layouts.push(layout); await capture(`pure-image-1120x720-130-${hasReference ? 'reference' : 'empty'}`);
      };
      await verifyEmptyLayout(false);
      await upload(images[1], '第二张合成风格参考图.png');
      const imageOnly = await requestAnalysis(imageResult);
      assert.equal(imageOnly.endpoint, 'vision'); assert.equal(imageOnly.imageCount, 1);
      assert.equal(imageOnly.data.story, ''); assert.equal(imageOnly.data.extraRequirement, '无');
      assert.equal(Object.hasOwn(imageOnly.data, 'customRequirement'), false);
      await waitProject((project) => project.directorLookDraft?.styleId === 'style_cinema' && project.directorLookDraft.visualStyle === imageResult.visualStyle, 'pure-image details and base saved');
      await custom(page).fill('保留参考图的三维材质，降低饱和度，不添加图中人物。');
      const combined = await requestAnalysis(customResult);
      assert.equal(combined.endpoint, 'vision'); assert.equal(combined.imageCount, 1); assert.equal(combined.data.story, '');
      assert.equal(combined.data.customRequirement, '保留参考图的三维材质，降低饱和度，不添加图中人物。');
      await verifyEmptyLayout(true);
      assert.equal(requests.length, 2); assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
      stages.push('empty-story-image-only-and-image-plus-custom-fill-four-fields-with-text-api-disabled');
      stages.push('empty-story-style-only-entry-at-1120x720-130-percent-before-and-after-upload');
      const report = { passed: true, mockOnly: true, isolatedStorage: true, syntheticImagesOnly: true, textApiDisabled: true, requests, stages, errors, blocked, expectedDiagnostics, screenshots, layouts };
      await fs.writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
      return { passed: true, requestCount: 2, layoutCases: layouts.length, stages, screenshots, report: path.join(output, reportName) };
    }
    await custom(page).fill(''); await general(page).fill('人物服装与剧情关系保持连续。');
    const untouched = {
      duration: await page.locator('.director-timing-fields .seconds-card input').inputValue(),
      shotCount: await page.locator('.director-timing-fields .count-card input').inputValue(),
      extra: await general(page).inputValue(),
    };
    const old = await requestAnalysis(textResult);
    assert.equal(old.endpoint, 'text'); assert.equal(old.imageCount, 0); assert.equal(Object.hasOwn(old.data, 'customRequirement'), false);
    stages.push('no-image-retains-original-text-analysis-and-four-field-fill');

    assert.equal(await fileInput(page).getAttribute('multiple'), null);
    await upload(images[0], '第一张合成风格参考图.png');
    const firstId = (await readProject()).directorLookReferenceAssetId;
    await previewButton(page).click(); await dialog(page).waitFor();
    await eventually(() => dialog(page).locator('img').evaluate((image) => image.complete && image.naturalWidth === 160), 'synthetic preview pixels loaded');
    await capture('reference-preview');
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'hidden' });
    assert.ok(await previewButton(page).evaluate((button) => document.activeElement === button));
    const imageOnly = await requestAnalysis(imageResult);
    assert.equal(imageOnly.endpoint, 'vision'); assert.equal(Object.hasOwn(imageOnly.data, 'customRequirement'), false);
    await waitProject((project) => project.directorLookDraft?.styleId === 'style_cinema' && project.directorLookDraft.visualStyle === imageResult.visualStyle, 'visual details plus matched preset base saved');
    assert.deepEqual({
      duration: await page.locator('.director-timing-fields .seconds-card input').inputValue(),
      shotCount: await page.locator('.director-timing-fields .count-card input').inputValue(), extra: await general(page).inputValue(),
    }, untouched);
    stages.push('upload-is-local-preview-accessible-image-analysis-retains-details-and-preset-base');

    const requirement = '保留参考图的三维材质，降低饱和度，不添加图中人物。';
    await custom(page).fill(requirement);
    const combined = await requestAnalysis(customResult);
    assert.equal(combined.endpoint, 'vision'); assert.equal(combined.data.customRequirement, requirement);
    assert.match(combined.system, /明确的 customRequirement 优先/u);
    stages.push('image-plus-custom-requirement-use-vision-and-fill-all-four-fields');
    await previewButton(page).click();
    const chooser = page.waitForEvent('filechooser');
    await dialog(page).getByRole('button', { name: '替换参考图', exact: true }).click();
    await (await chooser).setFiles({ name: '第二张合成风格参考图.png', mimeType: 'image/png', buffer: Buffer.from(images[1], 'base64') });
    await waitProject((project) => project.assets.find((asset) => asset.id === project.directorLookReferenceAssetId)?.fileName === '第二张合成风格参考图.png', 'replacement completes');
    await dialog(page).waitFor({ state: 'hidden' });
    assert.notEqual((await readProject()).directorLookReferenceAssetId, firstId);
    assert.equal(requests.length, 3, 'preview and replace send no AI requests');
    stages.push('modal-replacement-retains-old-asset-and-never-starts-analysis');

    const stable = await readLook(page);
    await hold('stale-image');
    assert.ok(await previewButton(page).isEnabled(), 'analysis does not disable reference preview');
    await upload(images[2], '第三张合成风格参考图.png');
    await release('stale-image'); assert.deepEqual(await readLook(page), stable);
    await hold('stale-requirement');
    await custom(page).fill('已改要求：保留柔和暖光，旧结果不得填写。');
    await release('stale-requirement'); assert.deepEqual(await readLook(page), stable);
    await hold('stale-chapter-roundtrip');
    await switchChapter('look-chapter-b');
    await section(page).getByRole('button', { name: '上传风格参考图', exact: true }).waitFor();
    assert.equal(await custom(page).inputValue(), '');
    await switchChapter('look-chapter-a');
    await previewButton(page).waitFor();
    await release('stale-chapter-roundtrip'); assert.deepEqual(await readLook(page), stable);
    const returnedProject = await readProject();
    assert.equal(returnedProject.assets.find((asset) => asset.id === returnedProject.directorLookReferenceAssetId)?.fileName, '第三张合成风格参考图.png');
    stages.push('changed-reference-requirement-and-chapter-roundtrip-reject-three-stale-responses');

    await switchChapter('look-chapter-b'); await general(page).fill('');
    await upload(images[1], '第二张合成风格参考图.png');
    const pureImage = await requestAnalysis(imageResult);
    assert.equal(pureImage.endpoint, 'vision'); assert.equal(pureImage.data.story, ''); assert.equal(pureImage.data.extraRequirement, '无');
    assert.equal(Object.hasOwn(pureImage.data, 'customRequirement'), false);
    await switchChapter('look-chapter-a'); await previewButton(page).waitFor();
    assert.equal(await custom(page).inputValue(), '已改要求：保留柔和暖光，旧结果不得填写。');
    await remove();
    assert.deepEqual(await readLook(page), stable, 'removal retains already authored style choices');
    await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector();
    await section(page).getByRole('button', { name: '上传风格参考图', exact: true }).waitFor();
    await switchChapter('look-chapter-b'); await previewButton(page).waitFor();
    await switchChapter('look-chapter-a');
    await section(page).getByRole('button', { name: '上传风格参考图', exact: true }).waitFor();
    stages.push('empty-chapter-image-only-analysis-and-chapter-reference-removal-survive-reload');

    await custom(page).fill('保留细腻三维材质、柔和暖光与低饱和调色；镜头关系自然清楚。');
    const requestCountBeforeLayouts = requests.length;
    for (const [width, height] of [[1280, 800], [1120, 720]]) {
      await page.setViewportSize({ width, height });
      for (const scale of [100, 130]) {
        await page.getByRole('button', { name: '界面与字体设置', exact: true }).click();
        await page.getByRole('spinbutton', { name: '自定义字体大小百分比', exact: true }).fill(String(scale));
        await page.getByRole('button', { name: '关闭界面设置', exact: true }).click();
        for (const hasReference of [false, true]) {
          if (hasReference) await upload(images[0], '第一张合成风格参考图.png');
          await settle(page);
          const layout = await section(page).evaluate((element) => {
            const rect = (target) => { const r = target.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
            const row = element.querySelector('.director-look-analysis-row');
            const title = row.querySelector(':scope > span'); const input = row.querySelector('textarea');
            const reference = row.querySelector('.director-look-reference-button'); const ai = row.querySelector('button[aria-label="AI 分析填写"]');
            const card = element.closest('.director-control-card');
            const visible = [title, ...card.querySelectorAll('input,textarea,select,button')].filter((target) => {
              const style = getComputedStyle(target); return target.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden';
            });
            const checks = visible.map((target) => {
              const r = rect(target); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const clippedBy = [];
              for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                const style = getComputedStyle(parent); const b = parent.getBoundingClientRect();
                if ((/(hidden|clip)/u.test(style.overflowX) && (r.x < b.x - 1 || r.right > b.right + 1))
                  || (/(hidden|clip)/u.test(style.overflowY) && (r.y < b.y - 1 || r.bottom > b.bottom + 1))) clippedBy.push(parent.className);
              }
              return { name: target.getAttribute('aria-label') || target.textContent || target.tagName,
                group: target.closest('.director-generate-bar') ? 'generation' : target.closest('.director-motion-pane') ? 'motion' : 'parameters',
                rect: r, hit: target === hit || target.contains(hit), clippedBy,
                fits: r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
            });
            const headerRects = [title, input, reference, ai].map(rect);
            const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
            const headerOverlap = headerRects.some((a, index) => headerRects.slice(index + 1).some((b) => overlap(a, b)));
            return { width: innerWidth, height: innerHeight, scale: document.querySelector('.app-shell').dataset.uiFontScale,
              hasReference: reference.classList.contains('has-reference'), input: rect(input), reference: rect(reference), ai: rect(ai), checks, headerOverlap,
              fieldsOverlapHeader: rect(element.querySelector('.director-style-pane')).y < Math.max(...headerRects.map((r) => r.bottom)) - 1,
              documentScrollX: document.documentElement.scrollWidth > innerWidth + 1, documentScrollY: document.documentElement.scrollHeight > innerHeight + 1 };
          });
          layouts.push(layout); assert.equal(layout.hasReference, hasReference);
          assert.equal(layout.headerOverlap, false); assert.equal(layout.fieldsOverlapHeader, false);
          assert.equal(layout.documentScrollX, false); assert.equal(layout.documentScrollY, false);
          assert.ok(layout.input.width >= 140, `requirements retain useful width: ${JSON.stringify(layout.input)}`);
          assert.equal(layout.reference.height, 26);
          assert.ok(layout.checks.some((check) => check.group === 'motion')); assert.ok(layout.checks.some((check) => check.group === 'generation'));
          assert.deepEqual(layout.checks.filter((check) => !check.hit || !check.fits || check.clippedBy.length), []);
          await custom(page).click(); assert.ok(await custom(page).evaluate((input) => document.activeElement === input));
          await capture(`style-${width}x${height}-${scale}-${hasReference ? 'reference' : 'empty'}`);
          if (hasReference) await remove();
        }
      }
    }
    assert.equal(requests.length, requestCountBeforeLayouts, 'layout checks and reference actions invoke no AI');
    stages.push('eight-empty-and-uploaded-layouts-at-two-window-sizes-and-two-font-scales');
    assert.equal(requests.length, 7); assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    assert.doesNotMatch(JSON.stringify((await readProject()).directorLookDraft), /过期結果|过期结果|迟到请求/u);
    const report = { passed: true, mockOnly: true, isolatedStorage: true, syntheticImagesOnly: true, requests, stages, errors, blocked, expectedDiagnostics, screenshots, layouts };
    await fs.writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
    return { passed: true, requestCount: requests.length, layoutCases: layouts.length, staleResponsesRejected: pending.size, stages, screenshots, report: path.join(output, reportName) };
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      await fs.writeFile(path.join(output, 'failure.txt'), `${String(error)}\n\n${await page.locator('body').innerText().catch(() => '')}`);
    }
    await fs.writeFile(path.join(output, reportName), JSON.stringify({ passed: false, error: String(error), requests, stages, errors, blocked, expectedDiagnostics, screenshots, layouts }, null, 2));
    throw error;
  } finally {
    pending.forEach((request) => request.resolve());
    await context?.close(); await browser?.close(); await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneDirectorLookReferenceUiQa(), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
