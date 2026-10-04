import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  setupDirectorLookRequirementQa,
  finishDirectorLookRequirementQa,
  runDirectorLookRequirementStaleQa,
} from './directorLookRequirementUiQa.mjs';
import { run as runDirectorLookTypingQa } from './directorLookTypingUiQa.mjs';

// Real App in a fresh browser context. The reused setup installs synthetic
// projects, mocks the look-analysis endpoint, and blocks every external write
// and external URL. Never attach to a desktop profile or production project.
export const directorLookDraftQaInventory = [
  '未确认或生成时，手填导演分类、导演风格及视觉风格即自动保存；刷新恢复原值',
  '项目A/B来回切换保留各自风格，不把刚离开的项目草稿串入当前项目',
  '清空三个可编辑字段后刷新仍为空，不回退默认预设',
  'AI分析一次回填四项结果且持久化，刷新不丢自定义名称/摘要',
  '导演预设选择和视觉预设选择使用同一持久化入口',
];

const inputs = (page) => page.locator('#director-setup-style .director-style-pane input');
const requirement = (page) => page.locator('textarea[aria-label="导演与视觉自定义要求"]');
const section = (page) => page.locator('#director-setup-style');
const readLook = async (page) => ({
  directorCategory: await inputs(page).nth(0).inputValue(),
  directorStyleName: await inputs(page).nth(1).inputValue(),
  visualStyle: await inputs(page).nth(2).inputValue(),
});
const enterDirector = async (page) => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await requirement(page).waitFor();
};
const switchProject = async (page, name) => {
  await page.locator('.top-actions .top-action-library').click();
  await page.getByRole('dialog', { name: '项目库', exact: true })
    .locator('.project-library-select').filter({ hasText: name }).click();
  await page.waitForFunction((title) => document.querySelector('.sidebar-project-name')?.textContent?.trim() === title, name);
  await enterDirector(page);
};
const readSaved = (page) => page.evaluate(async () => {
  const { STORAGE_KEY } = await import('/src/storage.ts');
  const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!['look-qa-a', 'look-qa-b'].includes(state?.project?.id)) throw new Error('A fresh isolated look fixture is required');
  return state;
});
const waitSaved = async (page, owner, expected) => {
  const key = await page.evaluate(async () => (await import('/src/storage.ts')).STORAGE_KEY);
  await page.waitForFunction(({ key, owner, expected }) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    if (state?.project?.id !== owner || state.activeProjectId !== owner) return false;
    const project = state?.project?.id === owner ? state.project : state?.projects?.find((item) => item.id === owner);
    return project?.directorLookDraft && Object.entries(expected).every(([key, value]) => project.directorLookDraft[key] === value);
  }, { key, owner, expected });
};
const fillLook = async (page, values) => {
  await inputs(page).nth(0).fill(values.directorCategory);
  await inputs(page).nth(1).fill(values.directorStyleName);
  await inputs(page).nth(2).fill(values.visualStyle);
  assert.deepEqual(await readLook(page), values);
};

export async function runDirectorLookDraftUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  const allowed = path.resolve(import.meta.dirname, '../output/playwright');
  const output = path.resolve(outputDirectory); const relative = path.relative(allowed, output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.mkdir(output, { recursive: true });
  const capture = async (name) => {
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  };
  const a = { directorCategory: '最终幻想CG电影', directorStyleName: '最终幻想7克制电影调度', visualStyle: '最终幻想7重制版的自然CG质感' };
  const b = { directorCategory: '淡彩水墨', directorStyleName: '项目B长镜头与留白', visualStyle: '低饱和手绘水墨质感' };
  await requirement(page).fill('项目A：保留人物原始关系与服装。');
  await fillLook(page, a);
  await waitSaved(page, 'look-qa-a', a);
  let saved = await readSaved(page);
  assert.equal(saved.project.directorSettingsConfirmedFingerprint, undefined, 'typing must not silently confirm settings');
  assert.equal(saved.project.storyboards.length, 0, 'typing must not generate prompts');
  assert.equal(saved.project.sequencePlans.length, 0, 'typing must not create a plan');
  assert.match(saved.project.directorLookDraft.directorStyleId, /^custom_director_/u);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.deepEqual(await readLook(page), a);
  assert.equal(await requirement(page).inputValue(), '项目A：保留人物原始关系与服装。');
  await capture('manual-unconfirmed-reloaded');
  stages.push('unconfirmed-manual-draft-survives-reload');

  await switchProject(page, '风格要求测试B');
  assert.notDeepEqual(await readLook(page), a, 'a project without a draft does not inherit project A');
  await fillLook(page, b);
  // Do not wait for the debounce before switching: the input event must have
  // already changed its owning project, not rely on a later page effect.
  await switchProject(page, '风格要求测试A');
  assert.deepEqual(await readLook(page), a);
  await switchProject(page, '风格要求测试B');
  assert.deepEqual(await readLook(page), b);
  await waitSaved(page, 'look-qa-b', b);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.deepEqual(await readLook(page), b);
  await switchProject(page, '风格要求测试A');
  assert.deepEqual(await readLook(page), a);
  stages.push('immediate-project-switch-and-roundtrip-keep-distinct-drafts');

  const empty = { directorCategory: '', directorStyleName: '', visualStyle: '' };
  await fillLook(page, empty);
  await waitSaved(page, 'look-qa-a', empty);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.deepEqual(await readLook(page), empty);
  await capture('explicit-empty-values-reloaded');
  stages.push('explicit-clearing-is-persisted-without-default-fallback');

  await requirement(page).fill('以水墨风格组织自然、舒缓的同行镜头。');
  await section(page).getByRole('button', { name: 'AI 分析填写', exact: true }).click();
  const ai = { directorCategory: '水墨奇幻', directorStyleName: '淡彩留白与缓慢推进的诗意调度', visualStyle: '淡彩水墨与柔和纸张肌理' };
  await waitSaved(page, 'look-qa-a', ai);
  assert.deepEqual(await readLook(page), ai);
  saved = await readSaved(page);
  const summary = '遵循水墨要求组织镜头，以长镜头和前后景留白保持舒缓节奏与人物空间关系。';
  assert.equal(saved.project.directorLookDraft.directorStyleSummary, summary);
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.deepEqual(await readLook(page), ai);
  assert.equal(await section(page).locator('.director-style-pane > .field').nth(1).locator('.field-hint').innerText(), summary);
  await capture('ai-custom-result-reloaded');
  stages.push('atomic-ai-result-and-summary-survive-reload');

  await section(page).getByRole('combobox', { name: '选择导演风格', exact: true }).selectOption('standard_cinema');
  await section(page).getByRole('combobox', { name: '选择视觉风格', exact: true }).selectOption({ label: '国风武侠' });
  const selected = await readLook(page);
  assert.equal(selected.directorStyleName, '标准电影感');
  assert.equal(selected.visualStyle, '国风武侠');
  await waitSaved(page, 'look-qa-a', selected);
  saved = await readSaved(page);
  assert.equal(saved.project.directorLookDraft.directorStyleId, 'standard_cinema');
  assert.equal(saved.project.directorLookDraft.styleId, 'style_wuxia');
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterDirector(page);
  assert.deepEqual(await readLook(page), selected);
  stages.push('preset-director-and-visual-selection-survive-reload');
  await switchProject(page, '风格要求测试B');
  assert.deepEqual(await readLook(page), b, 'all edits and autofill remain isolated from B');
  return { passed: true, inventory: directorLookDraftQaInventory, stages, screenshots };
}

export async function runStandaloneDirectorLookDraftUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..');
  const output = path.join(root, 'output', 'playwright', 'director-look-draft');
  await fs.mkdir(output, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  let browser; let page;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true });
    ({ page } = await setupDirectorLookRequirementQa(browser, `http://127.0.0.1:${address.port}`));
    const result = await runDirectorLookDraftUiAssertions(page, output);
    const isolation = await finishDirectorLookRequirementQa(page);
    assert.equal(isolation.requests, 1, 'only the explicitly clicked mocked analysis request is sent');
    // Reuse established late-response and real keyboard scenarios in their
    // own contexts. A context is never shared with the draft/reload cases.
    ({ page } = await setupDirectorLookRequirementQa(browser, `http://127.0.0.1:${address.port}`));
    const stale = await runDirectorLookRequirementStaleQa(page);
    await waitSaved(page, 'look-qa-a', await readLook(page));
    assert.doesNotMatch(JSON.stringify((await readSaved(page)).project.directorLookDraft), /过期结果|迟到请求不应覆盖/u);
    const staleIsolation = await finishDirectorLookRequirementQa(page);
    const typingFixture = await setupDirectorLookRequirementQa(browser, `http://127.0.0.1:${address.port}`);
    page = typingFixture.page;
    const externalRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && url.origin !== `http://127.0.0.1:${address.port}`) externalRequests.push(request.url());
    });
    const typing = await runDirectorLookTypingQa(page, path.join(output, 'typing'));
    await waitSaved(page, 'look-qa-a', await readLook(page));
    assert.doesNotMatch(JSON.stringify((await readSaved(page)).project.directorLookDraft), /不得回填的旧分类|不得回填的旧风格/u);
    assert.deepEqual(externalRequests, []);
    // Typing deliberately returns HTTP503 once and tracks it itself. Its
    // error inventory excludes only that intentional failure and cancellation;
    // the simpler setup fixture's finish helper does not know about HTTP503.
    await typingFixture.context.close();
    const report = { ...result, isolation, stale, staleIsolation, typing, externalRequests };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } catch (cause) {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause) }, null, 2));
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png') });
      await fs.writeFile(path.join(output, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`);
    }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneDirectorLookDraftUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
