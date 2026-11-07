import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Isolated synthetic project. No production profile or external model request.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', 'mobile-layout-3.9.5');
fs.mkdirSync(output, { recursive: true });
const server = await createServer({ cacheDir: path.join(root, '.tmp', 'mobile-ui-vite'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = []; const blockedRequests = []; const layouts = [];
const directorOnly = process.env.MOBILE_QA_SCOPE === 'director';
const focused = directorOnly || process.env.MOBILE_QA_SCOPE === 'affected';
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15_000);
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== base) { blockedRequests.push(url.origin + url.pathname); await route.abort(); return; }
  if (url.pathname === '/__mobile_fixture.html') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Mobile QA synthetic fixture</title>' }); return; }
  await route.continue();
});

async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function audit(label, screenshot = false) {
  await settle();
  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const workspace = document.querySelector('.workspace');
    const bounds = shell.getBoundingClientRect();
    const overflow = [...document.querySelectorAll('.workspace *')].filter(el => {
      const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.position !== 'fixed' && (rect.right > innerWidth + 2 || rect.left < -2);
    }).slice(0, 18).map(el => ({ tag: el.tagName, class: el.className?.baseVal ?? el.className, text: el.textContent?.trim().slice(0, 65), width: Math.round(el.getBoundingClientRect().width), right: Math.round(el.getBoundingClientRect().right) }));
    const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
    return { mobile: shell.classList.contains('mobile-shell'), zoom: getComputedStyle(shell).zoom, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      workspaceOverflow: workspace.scrollWidth > workspace.clientWidth + 2, width: innerWidth, height: innerHeight, shell: { width: bounds.width, height: bounds.height },
      navigationFits: !nav || nav.bottom <= innerHeight + 1, overflow };
  });
  layouts.push({ label, ...layout });
  if (screenshot) await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: false });
  return layout;
}
async function navigate(label) {
  await page.getByRole('button', { name: '全部功能', exact: true }).click();
  await page.getByRole('navigation', { name: '全部工作区' }).getByRole('button', { name: label, exact: true }).click();
}

try {
  await page.goto(`${base}/__mobile_fixture.html`);
  await page.evaluate(async () => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState();
    state.project.id = 'qa-mobile-layout'; state.project.name = '手机布局隔离项目'; state.project.description = '合成数据，未调用生成接口';
    const now = Date.now(); const content = '林青站在雨后的巷口，缓缓回头，望向从街角走来的沈川。两人在屋檐下停下脚步。';
    const chapter = { id: 'qa-mobile-chapter', name: '第一章 · 雨巷重逢', content, createdAt: now, updatedAt: now };
    state.project.sourceDocuments = [chapter]; state.project.activeChapterId = chapter.id; state.project.chapterWorkspaces = {};
    state.project.scenes = [{ id: 'qa-mobile-scene', title: '雨巷', summary: content, content, chapterId: chapter.id, characterIds: [], locationIds: [], propIds: [], createdAt: now, updatedAt: now }];
    state.project.storyboards = []; state.project.sequencePlans = []; state.project.generationTasks = [];
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 180;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#9dabb5'; paint.fillRect(0, 0, 120, 180); paint.fillStyle = '#d7d1bf'; paint.fillRect(25, 25, 70, 130);
    state.project.assets = [{ id: 'qa-mobile-asset', name: '本次合成参考图', type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), source: 'upload', tags: ['合成素材'], width: 120, height: 180, createdAt: now, updatedAt: now }];
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    for (const kind of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[kind] = { ...state.settings[kind], enabled: false, apiKey: '' };
    for (const kind of ['text', 'vision', 'image', 'video']) state.settings[`${kind}ApiProfiles`] = [];
    state.settings.apiCredentialBook = []; state.settings.theme = 'light'; state.settings.themeColor = 'classic'; state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('.mobile-shell').waitFor();
  await audit('390-projects', true);
  await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '创作', exact: true }).click();
  await page.locator('.story-source-textarea').waitFor();
  const story = page.locator('.story-source-textarea');
  await story.fill('定向手机输入检查：林青回头看向沈川。');
  assert.equal(await story.inputValue(), '定向手机输入检查：林青回头看向沈川。');
  for (const width of focused ? [] : [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await audit(`${width}-story`, true);
    await navigate('提示词导演台'); await audit(`${width}-director`, true);
    await navigate('分镜时间线'); await audit(`${width}-storyboard`, true);
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '素材', exact: true }).click(); await audit(`${width}-assets`, true);
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '任务', exact: true }).click(); await audit(`${width}-jobs`, true);
    await page.getByRole('button', { name: '打开 API 设置', exact: true }).click(); await audit(`${width}-settings`, true);
    for (const panel of ['text', 'video', 'credentials']) {
      await page.locator(`[data-settings-panel="${panel}"]`).click(); await audit(`${width}-settings-${panel}`, width === 390);
    }
    await navigate('视频导演台'); await audit(`${width}-video`, true);
    await navigate('剧情解析');
  }
  if (focused) {
    await audit('390-story-revised', true);
    await navigate('提示词导演台'); await audit('390-director-revised', true);
    await page.locator('.workspace').evaluate(element => { element.scrollTop = element.scrollHeight; }); await audit('390-director-bottom', true);
    await page.locator('.director-view').evaluate(async element => {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      let fiber = element[key];
      while (fiber && !(fiber.memoizedProps?.state && typeof fiber.memoizedProps?.setBackgroundState === 'function')) fiber = fiber.return;
      if (!fiber) throw new Error('Cannot locate synthetic DirectorView state');
      const ctx = fiber.memoizedProps;
      const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
      const { officialH3ContextForStoryboard } = await import('/src/officialH3Context.ts');
      const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
      ctx.setBackgroundState(current => {
        if (current.project.id !== 'qa-mobile-layout') throw new Error('Synthetic project required');
        const project = current.project; const chapter = project.sourceDocuments[0]; const scene = project.scenes[0]; const now = Date.now();
        const canonical = '【0s-10s】主体：林青；空间：雨后巷口；光影：自然光；镜头：小幅慢速向下转动；动作：林青站立，缓缓转头望向街角；台词：无；音效：环境雨滴声。';
        const source = { id: 'qa-mobile-board', chapterId: chapter.id, sceneId: scene.id, sourceSceneIds: [scene.id], sourceStoryTitle: chapter.name, sourceStoryContent: scene.content, sourceContentHash: sourceContentHash(scene.content), workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'auto', pace: 'standard', aspectRatio: '9:16', resolution: '1080p', audioMode: 'stereo', stylePresetId: current.settings.defaultStylePresetId, ruleSetId: current.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '', globalReferenceAssetIds: [], extraRequirement: '', finalPrompt: canonical,
          shots: [{ id: 'qa-mobile-shot', index: 1, startSec: 0, endSec: 10, subject: '林青', action: scene.content, purpose: '动作展示', camera: '固定中景', lighting: '自然光', sound: '雨滴声', transition: '顺接', result: scene.content, referenceAssetIds: [], prompt: canonical, locked: false, authoredBy: 'text-api' }],
          promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: current.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [chapter.id], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
        const board = applyOfficialH3Prompt(source, officialH3ContextForStoryboard(project, source));
        board.officialPromptEn = board.officialPromptZh.replace(/[\p{Script=Han}]+/gu, ' scene description '); board.officialPromptEnSource = board.officialPromptZh;
        const next = { ...project, storyboards: [board] };
        return { ...current, project: next, projects: current.projects.map(item => item.id === next.id ? next : item) };
      });
    });
    await page.locator('.director-result-copy').waitFor();
    await page.locator('.director-side-panel').scrollIntoViewIfNeeded();
    await audit('390-director-saved-result', true);
    for (const [label, route] of directorOnly ? [] : [['图像工作台', 'image'], ['规则中心', 'rules'], ['视频工作台', 'video-workbench']]) {
      await navigate(label); await audit(`390-${route}`, true);
      await page.locator('.workspace').evaluate(element => { element.scrollTop = element.scrollHeight; }); await audit(`390-${route}-bottom`, true);
    }
    await navigate('剧情解析');
    await page.locator('.story-source-textarea').focus();
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForFunction(() => document.documentElement.dataset.mobileKeyboard === 'true');
    assert.equal(await page.locator('.mobile-bottom-nav').isVisible(), false);
    await audit('390-keyboard-resize', true);
    await page.locator('.story-source-textarea').blur();
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /当前项目：.*打开项目库/ }).click();
  await page.getByRole('dialog', { name: '项目库', exact: true }).waitFor();
  await audit('390-project-dialog', true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lianhua:backbutton', { detail: { handled: false }, cancelable: true })));
  assert.equal(await page.getByRole('dialog', { name: '项目库', exact: true }).count(), 0);
  await page.locator('.mobile-chapter-actions > summary').click();
  await page.getByRole('button', { name: '章节管理', exact: true }).click(); await page.locator('.chapter-dialog').waitFor(); await audit('390-chapter-dialog', true);
  await page.locator('.chapter-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 }); await audit('landscape-story', true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !document.querySelector('.app-shell')?.classList.contains('mobile-shell'));
  await audit('desktop-1280', true);
  const report = { mockOnly: true, layouts, errors, blockedRequests, input: 'passed', backClosesProjectDialog: true };
  fs.writeFileSync(path.join(output, directorOnly ? 'report-director.json' : focused ? 'report-affected.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.MOBILE_QA_STRICT === '1') {
    assert.deepEqual(errors, []);
    assert.ok(layouts.every(row => !row.documentOverflow && !row.workspaceOverflow && row.navigationFits), 'Mobile layouts fit their viewports');
  }
} finally { await browser.close(); await server.close(); }
