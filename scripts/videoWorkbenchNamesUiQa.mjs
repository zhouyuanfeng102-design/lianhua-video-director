import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { installWorkbenchBatchFixture, workbenchLayoutCheck } from './videoWorkbenchBatchUiQa.mjs';

// Persistent-Playwright helpers only: this module never launches a browser,
// starts a server, reads production state, or calls a generation API.
// Inventory: full mixed-script names, no clipped glyphs/buttons, every item on
// exactly one page, cross-page selection/append, search/reset/empty results,
// same-count rename in both directions, and stable resize/font-scale changes.
export const workbenchNameSamples = Object.freeze([
  '光影拉长影子与温馨收束 · 第 4 段 · English',
  '灵果摊前的红玉果与继续同行 · 第 3 段 · English',
  '长名称边界测试：夕阳透过竹帘落在青石街面，三位旅人走过热闹的灵果摊位，在灯笼逐渐亮起的长街尽头停下脚步，回望来时的山门与远处云海，保留完整人物关系和连续动作，随后携手同行进入下一段剧情',
  'ContinuousStorySceneBoundaryReferenceWithoutWhitespace'.repeat(3) + 'FinalVideoVariantNumber000001',
  '🌄 山门晨光 → 🧑‍🤝‍🧑 同行 · 家庭👨‍👩‍👧‍👦与灯火🏮 · 第 6 段 · 中文完整名称',
  '短名',
  '重新相逢与远方的灯火 · 第 7 段 · 中文',
  'The Lantern Market — Last Scene · 第 8 段',
]);

const sourceArticles = '.vwb-source-list > .vwb-source';
const sourceTitle = `${sourceArticles} .vwb-source-copy strong`;
const sourcePager = (page) => page.getByLabel('视频素材页码', { exact: true });
// A persistent REPL may supply values from another VM realm. Compare their
// serialized data, not Array/Object prototypes from different globals.
const assertJsonEqual = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

export async function ensureWorkbenchNamesStyles(page) {
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/videoWorkbench.css');
    // Let the stylesheet apply and request the actual Chinese/Latin glyphs
    // before accepting document.fonts.ready or measuring line wrapping.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const rootFamily = getComputedStyle(document.documentElement).fontFamily;
    if (!rootFamily.includes('Segoe UI') || !rootFamily.includes('Microsoft YaHei')) {
      throw new Error(`Production styles.css font family is not active: ${rootFamily}`);
    }
    const title = document.querySelector('.vwb-source-list > .vwb-source .vwb-source-copy strong');
    const style = getComputedStyle(title || document.documentElement);
    await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, '视频素材完整名称 English 🌄');
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/** Reuses the production component/engine fixture and optionally reserves the
 * real application's sidebar/topbar footprint. This is not native-window QA. */
export async function installWorkbenchNamesFixture(page, baseUrl, sampleFile, options = {}) {
  await installWorkbenchBatchFixture(page, baseUrl, sampleFile);
  await ensureWorkbenchNamesStyles(page);
  const chrome = {
    reserved: options.reserveAppChrome !== false,
    sidebarWidth: Math.max(0, options.sidebarWidth ?? 190),
    headerHeight: Math.max(0, options.headerHeight ?? 80),
    fontScale: options.fontScale ?? 1,
  };
  await page.evaluate(({ names, chrome, includeMissing }) => {
    const qa = window.__workbenchBatchQa;
    if (!qa?.mutate) throw new Error('Workbench batch fixture is not installed');
    qa.mutate((current) => ({ ...current, project: { ...current.project,
      assets: current.project.assets.filter((asset) => includeMissing || asset.id !== 'qa-missing')
        .map((asset) => /^qa-video-\d+$/u.test(asset.id)
          ? { ...asset, name: names[Number(asset.id.slice('qa-video-'.length)) - 1] } : asset),
    } }));
    qa.namesFixture = { chrome, installedAt: Date.now() };
    const main = document.querySelector('.qa-workbench-shell');
    main.style.setProperty('--ui-font-scale', String(chrome.fontScale));
    main.setAttribute('data-ui-font-scale', String(chrome.fontScale));
    main.style.setProperty('padding', chrome.reserved
      ? `${chrome.headerHeight + 12}px 12px 12px ${chrome.sidebarWidth + 12}px` : '12px', 'important');
    main.style.setProperty('min-width', '0', 'important');
    main.style.setProperty('overflow', 'hidden', 'important');
  }, { names: workbenchNameSamples, chrome, includeMissing: options.includeMissing !== false });
  await page.locator(sourceTitle).first().waitFor();
  await settleWorkbenchNames(page);
  return { samples: [...workbenchNameSamples], chrome, expected: await expectedWorkbenchSources(page) };
}

export async function expectedWorkbenchSources(page) {
  return page.evaluate(() => window.__workbenchBatchQa.state.project.assets
    .filter((asset) => asset.type === 'video' || asset.mediaType === 'video')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((asset) => ({ id: asset.id, name: asset.name, selectable: !asset.missing && Boolean(asset.relativePath?.trim()) })));
}

/** Observe multiple painted frames instead of accepting one fortunate layout.
 * The first frames may legitimately repaginate after a resize; the last six
 * must agree. Measurements ignore the hidden source-sizing DOM. */
export async function settleWorkbenchNames(page, frameCount = 14) {
  const frames = await page.evaluate(async ({ selector, frameCount }) => {
    await document.fonts.ready;
    const snapshots = [];
    const rounded = (value) => Math.round(value * 100) / 100;
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const list = document.querySelector('.vwb-source-list');
      const pager = document.querySelector('select[aria-label="视频素材页码"]');
      snapshots.push({ page: pager?.value, pageCount: pager?.options.length,
        list: list ? [list.clientWidth, list.clientHeight, list.scrollWidth, list.scrollHeight] : [],
        rows: [...document.querySelectorAll(selector)].map((row) => {
          const rect = row.getBoundingClientRect();
          return { name: row.querySelector('.vwb-source-copy strong')?.textContent,
            rect: [rect.x, rect.y, rect.width, rect.height].map(rounded) };
        }),
      });
    }
    return snapshots;
  }, { selector: sourceArticles, frameCount: Math.max(8, frameCount) });
  const tail = frames.slice(-6).map((entry) => JSON.stringify(entry));
  assert.equal(new Set(tail).size, 1, `Material cards/pagination keep changing after layout settled:\n${JSON.stringify(frames, null, 2)}`);
  return frames.at(-1);
}

/** Inspect the rendered text, not just textContent: ellipsised textContent can
 * still contain the whole name while its last glyphs remain invisible. */
export async function inspectWorkbenchNames(page) {
  return page.evaluate(({ selector }) => {
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const inside = (inner, outer, tolerance = 1.5) => inner.left >= outer.left - tolerance
      && inner.top >= outer.top - tolerance && inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5;
    const list = document.querySelector('.vwb-source-list');
    const listRect = rect(list);
    const rows = [...document.querySelectorAll(selector)].map((article) => {
      const issues = [];
      const title = article.querySelector('.vwb-source-copy strong');
      const copy = article.querySelector('.vwb-source-copy');
      const metadata = article.querySelector('.vwb-source-extra-meta') || article.querySelector('.vwb-source-copy small');
      const style = getComputedStyle(title);
      const cardRect = rect(article), titleRect = rect(title), metadataRect = metadata && rect(metadata);
      const range = document.createRange(); range.selectNodeContents(title);
      const glyphs = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0)
        .map((box) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }));
      if (title.textContent !== copy.getAttribute('title')) issues.push('visible-name-does-not-equal-complete-source-name');
      if (style.textOverflow === 'ellipsis') issues.push('name-still-uses-ellipsis');
      if (style.webkitLineClamp && !['none', '0'].includes(style.webkitLineClamp)) issues.push('name-line-clamped');
      if (!glyphs.length && title.textContent) issues.push('name-has-no-rendered-glyphs');
      if (glyphs.some((box) => !inside(box, titleRect))) issues.push('glyphs-outside-title-box');
      if (glyphs.some((box) => !inside(box, cardRect))) issues.push('glyphs-outside-material-card');
      if (glyphs.some((box) => !inside(box, listRect))) issues.push('glyphs-outside-visible-material-list');
      if (!inside(cardRect, listRect)) issues.push('card-outside-visible-list');
      if (metadataRect && glyphs.some((box) => overlap(box, metadataRect))) issues.push('name-overlaps-duration-or-resolution');
      const controls = ['.vwb-source-check', '.vwb-source-cover', '.vwb-source-add'].map((query) => {
        const node = article.querySelector(query); const box = rect(node);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const minimum = query === '.vwb-source-check' ? 12 : 22;
        if (box.width < minimum || box.height < minimum) issues.push(`${query}-hitbox-shrunk`);
        if (!inside(box, cardRect)) issues.push(`${query}-outside-card`);
        if (!hit || (hit !== node && !node.contains(hit))) issues.push(`${query}-obscured`);
        if (glyphs.some((glyph) => overlap(glyph, box))) issues.push(`${query}-overlaps-name`);
        return { query, disabled: node.disabled, ...box };
      });
      if (title.scrollWidth > title.clientWidth + 1.5 || title.scrollHeight > title.clientHeight + 1.5) issues.push('name-scroll-overflow');
      return { name: title.textContent, fontSize: Number.parseFloat(style.fontSize), lineCount: new Set(glyphs.map((box) => Math.round(box.top))).size,
        card: cardRect, title: titleRect, metadata: metadataRect, controls, issues };
    });
    for (let index = 1; index < rows.length; index += 1) {
      if (overlap(rows[index - 1].card, rows[index].card)) rows[index].issues.push('overlaps-previous-material-card');
    }
    const pager = document.querySelector('select[aria-label="视频素材页码"]');
    return { page: Number(pager.value), pageCount: pager.options.length, list: listRect, rows,
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      documentOverflowY: document.documentElement.scrollHeight > innerHeight + 1 };
  }, { selector: sourceArticles });
}

export async function assertWorkbenchNamePage(page, options = {}) {
  await settleWorkbenchNames(page);
  const report = await inspectWorkbenchNames(page);
  const issues = report.rows.flatMap((row) => row.issues.map((issue) => ({ name: row.name, issue })));
  assert.equal(issues.length, 0, `Incomplete/overlapping material names:\n${JSON.stringify(report, null, 2)}`);
  assert.ok(report.rows.every((row) => row.fontSize >= (options.minimumFontSize ?? 8)), `Names became unreadably small:\n${JSON.stringify(report, null, 2)}`);
  assert.equal(report.documentOverflowX, false, JSON.stringify(report));
  assert.equal(report.documentOverflowY, false, JSON.stringify(report));
  const layout = await workbenchLayoutCheck(page);
  assert.equal(layout.clipped.length, 0, `Workbench controls are obscured:\n${JSON.stringify(layout, null, 2)}`);
  assert.ok(layout.panels.every((panel) => !panel.sx && !panel.sy), `Workbench panel overflow:\n${JSON.stringify(layout, null, 2)}`);
  return { ...report, layout };
}

/** All pages are inspected: a hidden long-name item cannot pass via a short
 * first page. The expected collection follows the production source ordering. */
export async function visitWorkbenchNamePages(page, expected, options = {}) {
  const pager = sourcePager(page);
  if (await pager.isEnabled()) await pager.selectOption('0');
  await settleWorkbenchNames(page);
  const count = await pager.locator('option').count();
  assert.ok(count > 0 && count <= expected.length + 1, `Unexpected material page count ${count}`);
  const pages = [];
  for (let index = 0; index < count; index += 1) {
    if (await pager.isEnabled()) await pager.selectOption(String(index));
    const report = await assertWorkbenchNamePage(page, options);
    assert.equal(report.page, index, 'repagination must not redirect a manual page choice');
    assert.equal(report.pageCount, count, 'page count must not oscillate according to the currently visible names');
    assert.ok(report.rows.length > 0 || !expected.length, `Empty material page ${index + 1}`);
    if (options.outputDirectory) {
      await fs.mkdir(options.outputDirectory, { recursive: true });
      const fileName = `${options.prefix || 'workbench-names'}-page-${index + 1}.png`;
      report.screenshot = path.join(options.outputDirectory, fileName);
      await page.screenshot({ path: report.screenshot, scale: 'css', animations: 'disabled' });
    }
    pages.push(report);
  }
  const found = pages.flatMap((entry) => entry.rows.map((row) => row.name));
  assertJsonEqual(found, expected.map((entry) => typeof entry === 'string' ? entry : entry.name), 'Every source must appear once, in order, without skipped/duplicated page boundaries');
  return pages;
}

async function selectMaterialAcrossPages(page, name) {
  const pager = sourcePager(page);
  const count = await pager.locator('option').count();
  for (let index = 0; index < count; index += 1) {
    if (await pager.isEnabled()) await pager.selectOption(String(index));
    await settleWorkbenchNames(page);
    const checkbox = page.getByLabel(`选择素材 ${name}`, { exact: true });
    if (await checkbox.count()) { await checkbox.check(); return index; }
  }
  assert.fail(`Material not reachable through any page: ${name}`);
}

export async function runWorkbenchNamesUiAssertions(page, outputDirectory, options = {}) {
  await ensureWorkbenchNamesStyles(page);
  const report = { stages: [], layouts: [], screenshots: [] };
  if (outputDirectory) await fs.mkdir(outputDirectory, { recursive: true });
  const expected = await expectedWorkbenchSources(page);
  const firstPass = await visitWorkbenchNamePages(page, expected, { outputDirectory, prefix: 'initial', ...options });
  report.initialPages = firstPass;
  report.stages.push('full-mixed-script-names-on-every-page-with-complete-glyphs-and-hitboxes');
  const selectable = expected.filter((item) => item.selectable);
  assert.ok(selectable.length >= 2, 'Fixture must include at least two selectable videos');
  const choices = [selectable[0], selectable.at(-1)];
  const chosenPages = [];
  for (const item of choices) chosenPages.push(await selectMaterialAcrossPages(page, item.name));
  assert.ok(new Set(chosenPages).size > 1, 'Cross-page selection scenario did not actually span pages');
  const beforeClips = await page.evaluate(() => structuredClone(window.__workbenchBatchQa.state.project.videoWorkbench.draft.clips));
  await page.getByRole('button', { name: '添加已选（2）', exact: true }).click();
  await page.waitForFunction((count) => window.__workbenchBatchQa.state.project.videoWorkbench.draft.clips.length === count, beforeClips.length + 2);
  const afterClips = await page.evaluate(() => window.__workbenchBatchQa.state.project.videoWorkbench.draft.clips);
  assertJsonEqual(afterClips.slice(0, beforeClips.length), beforeClips, 'Adding selected videos must preserve existing clips');
  assertJsonEqual(afterClips.slice(beforeClips.length).map((clip) => clip.sourceAssetId), choices.map((item) => item.id));
  assert.equal(await page.getByRole('button', { name: '添加已选（0）', exact: true }).isDisabled(), true);
  report.stages.push('cross-page-selection-and-ordered-append-preserve-existing-timeline');

  const search = page.getByLabel('搜索视频素材', { exact: true });
  await search.fill('灵果摊前');
  await settleWorkbenchNames(page);
  assert.equal(await sourcePager(page).inputValue(), '0');
  const filtered = expected.filter((item) => item.name.includes('灵果摊前'));
  await visitWorkbenchNamePages(page, filtered);
  await page.getByLabel('全选筛选结果（跨全部分页）', { exact: true }).check();
  await search.fill('');
  await settleWorkbenchNames(page);
  assert.equal(await page.getByRole('button', { name: '添加已选（1）', exact: true }).isEnabled(), true, 'Clearing search must retain checked items');
  await selectMaterialAcrossPages(page, filtered[0].name);
  assert.equal(await page.getByLabel(`选择素材 ${filtered[0].name}`, { exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await search.fill('__QA_no_matching_material__');
  await settleWorkbenchNames(page);
  assert.equal(await page.locator(sourceArticles).count(), 0);
  assert.equal(await page.getByLabel('全选筛选结果（跨全部分页）', { exact: true }).isDisabled(), true);
  await search.fill('');
  report.stages.push('search-reset-empty-state-and-filter-selection-retention');

  // No item-count change: this catches measurement caches keyed only by length.
  const renamed = `原位更名验证：${workbenchNameSamples[2]}`;
  if (await sourcePager(page).isEnabled()) await sourcePager(page).selectOption('0');
  await page.evaluate(({ id, name }) => window.__workbenchBatchQa.mutate((current) => ({ ...current, project: { ...current.project,
    assets: current.project.assets.map((asset) => asset.id === id ? { ...asset, name } : asset),
  } })), { id: selectable[0].id, name: renamed });
  await page.getByLabel(`选择素材 ${renamed}`, { exact: true }).waitFor();
  await visitWorkbenchNamePages(page, await expectedWorkbenchSources(page));
  await page.evaluate(({ id, name }) => window.__workbenchBatchQa.mutate((current) => ({ ...current, project: { ...current.project,
    assets: current.project.assets.map((asset) => asset.id === id ? { ...asset, name } : asset),
  } })), { id: selectable[0].id, name: selectable[0].name });
  await visitWorkbenchNamePages(page, expected);
  report.stages.push('same-count-rename-longer-and-shorter-remeasures-without-data-loss');

  await page.setViewportSize({ width: 1120, height: 720 });
  await page.evaluate(() => document.querySelector('.qa-workbench-shell').style.setProperty('--ui-font-scale', '1.3'));
  for (const length of [200, 300]) {
    await page.getByLabel('搜索视频素材', { exact: true }).fill('');
    if (await sourcePager(page).isEnabled()) await sourcePager(page).selectOption('0');
    const name = '长名称边界验证完整显示不省略'.repeat(22).slice(0, length);
    await page.evaluate(({ id, name }) => window.__workbenchBatchQa.mutate((current) => ({ ...current, project: { ...current.project,
      assets: current.project.assets.map((asset) => asset.id === id ? { ...asset, name } : asset),
    } })), { id: selectable[0].id, name });
    const compact = await assertWorkbenchNamePage(page);
    assert.equal(compact.rows[0].name, name);
    assert.ok(await page.locator('.vwb-source--full-width-name').count() > 0);
    await page.getByLabel(`选择素材 ${name}`, { exact: true }).check();
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    if (outputDirectory) await page.screenshot({ path: path.join(outputDirectory, `extreme-name-${length}.png`), scale: 'css' });
  }
  await page.evaluate(({ id, name }) => window.__workbenchBatchQa.mutate((current) => ({ ...current, project: { ...current.project,
    assets: current.project.assets.map((asset) => asset.id === id ? { ...asset, name } : asset),
  } })), { id: selectable[0].id, name: selectable[0].name });
  report.stages.push('200-and-300-character-names-use-full-card-width-without-hiding-text-or-controls');

  for (const viewport of options.viewports || [{ width: 1120, height: 720 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const scale of options.fontScales || [1, 1.3]) {
      await page.evaluate((value) => {
        const shell = document.querySelector('.qa-workbench-shell');
        shell.style.setProperty('--ui-font-scale', String(value));
        shell.setAttribute('data-ui-font-scale', String(value));
      }, scale);
      const prefix = `${viewport.width}x${viewport.height}-font-${scale}`;
      const pages = await visitWorkbenchNamePages(page, expected, { outputDirectory, prefix, ...options });
      report.layouts.push({ viewport, scale, pages });
      report.screenshots.push(...pages.flatMap((entry) => entry.screenshot ? [entry.screenshot] : []));
    }
  }
  // Crossing both source-width breakpoints repeatedly must settle on the same
  // page layout when the original viewport is restored (no ResizeObserver loop).
  const finalViewport = options.finalViewport || { width: 1120, height: 720 };
  await page.setViewportSize(finalViewport);
  if (await sourcePager(page).isEnabled()) await sourcePager(page).selectOption('0');
  const baseline = await settleWorkbenchNames(page);
  for (const width of [1121, 1279, 1281, finalViewport.width]) {
    await page.setViewportSize({ width, height: finalViewport.height });
    await settleWorkbenchNames(page);
  }
  const returned = await settleWorkbenchNames(page);
  assertJsonEqual(returned, baseline, 'Returning to the same size must restore a stable material layout');
  report.stages.push('small-window-font-scaling-and-resize-boundaries-remain-stable-without-scrolling');
  if (outputDirectory) await fs.writeFile(path.join(outputDirectory, 'workbench-names-report.json'), JSON.stringify(report, null, 2));
  return report;
}
