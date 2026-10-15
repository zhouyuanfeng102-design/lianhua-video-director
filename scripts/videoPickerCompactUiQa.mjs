import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { imageCapacityQaResponses } from './videoApiImageCapacityUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

async function checkCompactCards(page, dialog, mode, outputDirectory, layouts, screenshots, previous, baseline) {
  const card = dialog.locator('.vd-image-choice').first();
  const name = await card.locator('.reference-image-name-text').innerText();
  const capture = async (state) => {
    for (const [width, height] of [[1280, 800], [960, 720]]) {
      await page.setViewportSize({ width, height });
      await dialog.locator('.vd-batch-dialog-body:visible').evaluate((element) => { element.scrollTop = 0; });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await card.evaluate((element, args) => {
        const box = element.getBoundingClientRect();
        const read = (node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: parseFloat(getComputedStyle(node).fontSize),
            scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, text: node.textContent, title: node.getAttribute('title') };
        };
        const title = element.querySelector('.reference-image-name-text');
        const selection = element.querySelector('.vd-image-pick > span:not(.reference-image-name):not(.vd-image-slot-badge)');
        const titleRect = title.getBoundingClientRect();
        return { ...args, lowerHeight: box.bottom - titleRect.top, card: read(element), name: read(title),
          selection: read(selection), badge: read(element.querySelector('.vd-image-slot-badge')),
          compression: read(element.querySelector('.vd-compression-card')),
          comparison: read(element.querySelector('.vd-compression-card > small')),
          buttons: [...element.querySelectorAll('.vd-image-choice-tools .btn, :scope > .btn, .vd-compression-card .btn')].map(read),
          previewHeight: element.querySelector('img').getBoundingClientRect().height,
          secondCard: (() => { const next = element.nextElementSibling; const name = next.querySelector('.reference-image-name-text');
            const box = next.getBoundingClientRect(); return { name: read(name), height: box.height, lowerHeight: box.bottom - name.getBoundingClientRect().top }; })() };
      }, { key: `${mode}-${width}x${height}-1.5-${state}`, mode, width, height, scale: 1.5, state });
      assert.equal(metrics.name.title, name, 'full long image name remains available through its native tooltip');
      assert.equal(metrics.name.text, name, 'name is never rewritten or shortened in data');
      assert.ok(metrics.card.scrollWidth <= metrics.card.clientWidth + 1, 'card has no horizontal overflow');
      assert.ok(metrics.comparison.scrollWidth <= metrics.comparison.clientWidth + 1, 'size comparison has no horizontal overflow');
      for (const button of metrics.buttons) {
        assert.ok(button.x >= metrics.card.x - 1 && button.x + button.width <= metrics.card.x + metrics.card.width + 1, 'each card action stays inside its card');
        assert.ok(button.y >= metrics.card.y - 1 && button.y + button.height <= metrics.card.y + metrics.card.height + 1, 'each action stays within its card vertically');
      }
      for (let index = 0; index < metrics.buttons.length; index += 1) for (const other of metrics.buttons.slice(index + 1)) {
        const button = metrics.buttons[index];
        const overlapX = Math.min(button.x + button.width, other.x + other.width) - Math.max(button.x, other.x);
        const overlapY = Math.min(button.y + button.height, other.y + other.height) - Math.max(button.y, other.y);
        assert.ok(overlapX <= 1 || overlapY <= 1, 'card action buttons never overlap each other');
      }
      if (!baseline) {
        assert.ok(Math.abs(metrics.selection.y - metrics.badge.y) <= 2, 'selection and slot purpose share one aligned row');
        assert.ok(metrics.name.y + metrics.name.height <= metrics.selection.y + 1, 'long title never overlaps selection metadata');
      }
      const before = previous?.layouts.find((entry) => entry.key === metrics.key);
      if (before) {
        metrics.lowerBaseline = before.lowerHeight; metrics.lowerRatio = Number((metrics.lowerHeight / before.lowerHeight).toFixed(3));
        assert.ok(metrics.lowerHeight < before.lowerHeight, 'card information is shorter than its baseline');
        assert.equal(metrics.previewHeight, before.previewHeight, 'image preview height is unchanged');
      }
      if (state === 'compressed') assert.match(metrics.comparison.text, /→.*减少[\s\S]*512×288\s*→\s*512×288/u);
      layouts.push(metrics);
      const shot = path.join(outputDirectory, `${metrics.key}.png`); await page.screenshot({ path: shot, scale: 'css', animations: 'disabled' }); screenshots.push(shot);
      await card.getByRole('button', { name: '放大预览', exact: true }).click();
      const preview = page.getByRole('dialog', { name: `图片预览 · ${name}`, exact: true }); await preview.waitFor();
      await preview.getByRole('img', { name, exact: true }).waitFor();
      await preview.getByRole('button', { name: '关闭', exact: true }).click(); await preview.waitFor({ state: 'hidden' });
      await card.getByRole('button', { name: `轻压缩图片 ${name}`, exact: true }).click();
      const review = page.getByRole('dialog', { name: '轻压缩参考图', exact: true }); await review.waitFor();
      await review.getByAltText('压缩前原图', { exact: true }).waitFor(); await review.getByAltText('压缩后候选副本', { exact: true }).waitFor();
      await review.getByRole('button', { name: '保留当前选图', exact: true }).click(); await review.waitFor({ state: 'hidden' });
      if (state === 'compressed') await card.getByRole('button', { name: `恢复原图 ${name}`, exact: true }).click({ trial: true });
    }
  };
  await capture('original');
  await card.getByRole('button', { name: `轻压缩图片 ${name}`, exact: true }).click();
  const review = page.getByRole('dialog', { name: '轻压缩参考图', exact: true }); await review.waitFor();
  await review.getByRole('button', { name: '使用压缩副本', exact: true }).click(); await review.waitFor({ state: 'hidden' });
  await card.getByRole('button', { name: `恢复原图 ${name}`, exact: true }).waitFor();
  await capture('compressed');
  await card.getByRole('button', { name: `恢复原图 ${name}`, exact: true }).click();
  assert.equal(await card.getByRole('button', { name: `恢复原图 ${name}`, exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
}

// Isolated real VideoDirectorView. Assets, original-file bridge and read-only
// upstream schema are synthetic. Never mounts App or saved user projects.
export async function runVideoPickerCompactUiQa({ baseline = false, compare, cardsOnly = false } = {}) {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..');
  const outputDirectory = path.join(root, 'output', 'playwright', `video-picker-${cardsOnly ? 'cards' : 'compact'}-${baseline ? 'baseline' : 'after'}-${Date.now()}`);
  await fs.mkdir(outputDirectory, { recursive: true });
  const previous = compare ? JSON.parse(await fs.readFile(compare, 'utf8')) : undefined;
  const port = await findAvailableTcpPort();
  const server = await createServer({ root,
    plugins: [{ name: 'disable-picker-compact-qa-watch', configResolved(config) { config.server.watch = null; } }],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  let browser; let page; const errors = []; const layouts = []; const screenshots = [];
  let blockedRequests = []; let capabilityRequests = [];
  try {
    await server.watcher.close(); await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (error) => errors.push(error.message));
    ({ blockedRequests, capabilityRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`,
      { fontScale: 1.5, compressionImages: true, capabilityResponses: imageCapacityQaResponses,
        ...(cardsOnly ? { assetNames: { 'ruq-composition': '夏提雅动作 · 方案 4KCHIY · 第 1 章 · 第 2 段 · 第 1 镜分镜图片（人物身份与构图参考原图）' } } : {}) }));
    for (const mode of ['single', 'batch']) {
      const single = mode === 'single';
      const id = await page.evaluate((single) => {
        const qa = window.__videoReferenceUsageQa;
        qa.reset({ source: 'api', classicModel: '特价2.5-合成接口返回30图', single });
        return JSON.parse(qa.originalProject).id;
      }, single);
      await page.waitForFunction((id) => window.__videoReferenceUsageQa.project.id === id, id);
      // Prepare synthetic staging text before measuring any interaction. The
      // stock fixture's classic prose only mentions one person; explicit
      // visible actions exercise the real 3/6-person hint renderer instead.
      await page.evaluate(async (single) => {
        const qa = window.__videoReferenceUsageQa;
        if (!single) for (const [index, name] of ['丁人物', '戊人物', '己人物'].entries()) {
          qa.project.characters.push({ ...structuredClone(qa.project.characters[index]), id: `layout-person-${index}`, name, assetIds: [] });
        }
        const names = qa.project.characters.map((entry) => entry.name);
        const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
        for (const board of qa.project.storyboards) {
          const text = names.map((name) => `画面中${name}站在山路上。`).join('') + '镜头沿山路跟拍，脚步与风声自然。';
          board.finalPrompt = text; board.officialPromptZh = text; board.officialPromptSource = text;
          board.targetOutput = { prompt: text }; board.promptTrace.convertedPromptFingerprint = sourceContentHash(text); board.shots[0].prompt = text;
        }
        qa.setModel('特价2.5-合成接口返回30图');
        qa.appendFrame({ id: `layout-marker-${single}`, name: '隔离布局标记', type: 'video', mediaType: 'video', mimeType: 'video/mp4', tags: [], createdAt: 1, updatedAt: 1, missing: true });
      }, single);
      await page.waitForFunction((single) => window.__videoReferenceUsageQa.project.assets.some((asset) => asset.id === `layout-marker-${single}`), single);
      await page.evaluate(() => { const qa = window.__videoReferenceUsageQa; qa.originalProject = JSON.stringify(qa.project); });
      await page.getByRole('tab', { name: single ? '单段生成' : '长剧情批量', exact: true }).click();
      const row = page.locator('[data-segment-id="ruq-segment-1"]');
      if (single) {
        const text = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
        await page.getByLabel('本次生成使用的完整提示词', { exact: true }).fill(text);
      } else {
        await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
        await row.getByLabel('选择第 1 段', { exact: true }).check();
      }
      const open = async () => {
        if (single) await page.locator('.vd-reference-card').getByRole('button', { name: '从图片资产库选择', exact: true }).click();
        else await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: single ? '从图片资产库选择生成参考图' : '第 1 段 · 选择参考图', exact: true });
        await dialog.waitFor();
        await dialog.getByLabel('接口图片容量', { exact: true }).filter({ hasText: '接口已返回 30 个图片槽' }).waitFor();
        await dialog.getByLabel('视频参考图大小对比', { exact: true }).waitFor();
        return dialog;
      };
      let dialog = await open();
      if (cardsOnly) {
        await checkCompactCards(page, dialog, mode, outputDirectory, layouts, screenshots, previous, baseline);
        assert.deepEqual(await page.evaluate(() => {
          const qa = window.__videoReferenceUsageQa;
          return { originals: JSON.stringify(qa.project) === qa.originalProject, submissions: qa.submissions.length, aiCalls: qa.aiCalls };
        }), { originals: true, submissions: 0, aiCalls: 0 });
        continue;
      }
      for (const [width, height, scale] of [[1920, 1080, 1.5], [1280, 800, 1.5], [1280, 800, 1], ...(!baseline ? [[960, 720, 1.5]] : [])]) {
        await page.setViewportSize({ width, height });
        await page.locator('main').evaluate((element, scale) => element.style.setProperty('--ui-font-scale', String(scale)), scale);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metrics = await dialog.evaluate((element, args) => {
          const rect = (selector) => {
            const node = element.querySelector(selector); if (!node) return null;
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height,
              fontSize: parseFloat(getComputedStyle(node).fontSize), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
          };
          const modal = element.getBoundingClientRect(); const grid = rect('.vd-image-picker-grid'); const compression = rect('.vd-compression-summary');
          const hint = element.querySelector('.vd-segment-character-hint')?.getBoundingClientRect();
          return { ...args, modal: { x: modal.x, y: modal.y, width: modal.width, height: modal.height },
            topHeight: grid.y - modal.y, topInfoHeight: compression.y + compression.height - modal.y,
            header: rect('.vd-modal-header'), heading: rect('.vd-modal-header h2'), characters: rect('.vd-segment-character-hint'),
            reader: rect('.vop-model-reader'), capacity: rect('[aria-label="接口图片容量"]'),
            compression, tabs: rect('.vd-reference-picker-tabs'),
            search: rect('input[type="search"]'), grid, body: rect('.vd-batch-dialog-body'), footer: rect('.vd-modal-footer'),
            chips: element.querySelectorAll('.vd-segment-character-chip').length,
            characterCardsFit: [...element.querySelectorAll('.vd-segment-character-chip')].every((node) => {
              const box = node.getBoundingClientRect();
              return hint && box.x >= hint.x && box.right <= hint.right + 1 && box.y >= hint.y && box.bottom <= hint.bottom + 1;
            }),
            horizontalOverflow: element.scrollWidth - element.clientWidth,
          };
        }, { key: `${mode}-${width}x${height}-${scale}`, mode, width, height, scale });
        assert.equal(metrics.horizontalOverflow, 0, 'modal must not overflow horizontally');
        assert.ok(metrics.footer.y + metrics.footer.height <= height + 1, 'footer remains in viewport');
        assert.ok(metrics.grid.width > 100 && metrics.body.height > 60, 'image area stays visible');
        assert.equal(metrics.chips, single ? 3 : 6, 'real character hint is present');
        if (!baseline) assert.equal(metrics.characterCardsFit, true, 'all character cards remain visible');
        for (const selector of ['.vd-modal-header', '.vop-model-reader', '.vd-compression-summary', '.vd-reference-picker-tabs']) {
          const item = dialog.locator(selector); if (await item.count()) {
            assert.equal(await item.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${selector} horizontal contents fit`);
          }
        }
        await dialog.getByRole('button', { name: '关闭', exact: true }).click({ trial: true });
        await dialog.getByRole('button', { name: '读取模型参数', exact: true }).click({ trial: true });
        await dialog.getByRole('link', { name: 'OpenAPI 来源', exact: true }).click({ trial: true });
        await dialog.getByRole('button', { name: single ? '使用所选图片' : '使用本段图片', exact: true }).click({ trial: true });
        await dialog.getByRole('button', { name: '压缩已选图片', exact: true }).click({ trial: true });
        if (previous && width >= 1280) {
          const before = previous.layouts.find((entry) => entry.key === metrics.key);
          assert.ok(before, `baseline exists for ${metrics.key}`);
          metrics.topRatio = Number((metrics.topHeight / before.topHeight).toFixed(3));
          metrics.topInfoBaseline = before.topInfoHeight ?? before.compression.y + before.compression.height - before.modal.y;
          metrics.topInfoRatio = Number((metrics.topInfoHeight / metrics.topInfoBaseline).toFixed(3));
          metrics.imageAreaGain = metrics.body.height - before.body.height;
          assert.ok(metrics.topHeight < before.topHeight, 'top is shorter than same-size baseline');
          assert.ok(metrics.imageAreaGain > 0, 'image area gained height');
        }
        layouts.push(metrics);
        const shot = path.join(outputDirectory, `${metrics.key}.png`); await page.screenshot({ path: shot, scale: 'css', animations: 'disabled' }); screenshots.push(shot);
      }
      const search = dialog.locator('input[type="search"]');
      await search.fill('甲人物参考'); assert.equal(await dialog.locator('.vd-image-choice').count(), 1);
      await search.fill(''); assert.equal(await dialog.locator('.vd-image-choice').count(), 8);
      const purpose = await showVideoReferencePickerPane(dialog, '槽位用途');
      assert.equal(await purpose.locator('.vd-slot-usage-row').count(), 30);
      await purpose.getByLabel(`${single ? '本段' : '第 1 段'}图片槽 30 用途`, { exact: true }).selectOption('middle-frame');
      await showVideoReferencePickerPane(dialog, '图片选择');
      await dialog.getByRole('button', { name: single ? '使用所选图片' : '使用本段图片', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' }); dialog = await open();
      await showVideoReferencePickerPane(dialog, '槽位用途');
      assert.equal(await dialog.getByLabel(`${single ? '本段' : '第 1 段'}图片槽 30 用途`, { exact: true }).inputValue(), 'middle-frame');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => {
        const qa = window.__videoReferenceUsageQa;
        return { originals: JSON.stringify(qa.project) === qa.originalProject, submissions: qa.submissions.length, aiCalls: qa.aiCalls };
      }), { originals: true, submissions: 0, aiCalls: 0 });
    }
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
    assert.ok(capabilityRequests.every((request) => request.method === 'GET'));
    const report = { passed: true, baseline, cardsOnly, layouts, screenshots, outputDirectory, errors, blockedRequests,
      checks: cardsOnly ? 'single/batch card original/compressed states; 1280/960 at font150; long original title intact; real image preview and compression comparison open/cancel; explicit compression copy apply/restore; comparison/restoration controls fit; originals unchanged; zero paid submissions'
        : 'real single/batch picker; upstream mock 30 slots; compression totals; 3/6 people; search; image/purpose tabs; slot30 edit/apply/reopen; close/apply/compress hit testing; fonts100/150; originals unchanged; zero paid submissions' };
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2)); return report;
  } catch (cause) {
    if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png') });
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), layouts, errors, outputDirectory }, null, 2));
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const compareIndex = process.argv.indexOf('--compare');
    console.log(JSON.stringify(await runVideoPickerCompactUiQa({ baseline: process.argv.includes('--baseline'), cardsOnly: process.argv.includes('--cards-only'), compare: compareIndex >= 0 ? process.argv[compareIndex + 1] : undefined }), null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
