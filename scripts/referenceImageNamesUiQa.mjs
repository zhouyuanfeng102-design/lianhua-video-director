import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Real director component, synthetic in-memory assets, no production App,
// desktop bridge, project storage or generation engine. The inherited fixture
// blocks all external/provider-shaped requests before they reach the network.
const names = {
  'ruq-composition': '51321 · 方案 O9JET1 · 暮色山门与城镇集市之间三人沿桥继续前行的完整衔接参考图 · 第 4 段 · 第 2/9 张分镜图片',
  'ruq-a': '51321 · Plan REFERENCE · Moonlit mountain gateway and market bridge with three travellers continuing their journey · Segment 12 · Shot 7 of 9',
  'ruq-b': '51321_ProjectLongUnbrokenEnglishReferenceAssetName_MountainGatewayAndTownMarketContinuity_ThreeTravellersWalkingAlongTheBridge_Segment24_Shot08of09.png',
  'ruq-c': `51321 · 超长中文参考图名称 · ${'保留山门方向人物身份与完整剧情衔接画面描述'.repeat(7)} · 第 38 段 · 第 9/9 镜`,
  'ruq-scene': '短名',
  'ruq-style': '51321 · 方案 Q8CPK5 · 临近城镇集市的自然光线与远景街道参考 · 第 26 段 · 第 6/9 镜',
  'ruq-a-alt': 'Long alternative character reference showing consistent ordinary clothing and natural facial expression · Segment 99 · Shot 09',
};
const ids = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-c'];
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `reference-image-names-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
const stages = []; const layouts = []; const screenshots = []; const errors = []; const blockedRequests = [];
let browser; let page;

async function inspectName(locator, expected, context, cardSelector) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((element, { expected, cardSelector }) => {
    const rect = (node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
    const box = rect(element); const style = getComputedStyle(element);
    const card = element.closest(cardSelector); const cardBox = card ? rect(card) : null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const textRects = []; let lastRect; let node;
    while ((node = walker.nextNode())) {
      for (let index = 0; index < node.textContent.length; index += 1) {
        if (!node.textContent[index].trim()) continue;
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
        for (const textRect of range.getClientRects()) {
          if (textRect.width <= 0 || textRect.height <= 0) continue;
          const value = { left: textRect.left, right: textRect.right, top: textRect.top, bottom: textRect.bottom };
          textRects.push(value); lastRect = value;
        }
      }
    }
    const within = (inner, outer) => inner.left >= outer.left - 1.5 && inner.right <= outer.right + 1.5 && inner.top >= outer.top - 1.5 && inner.bottom <= outer.bottom + 1.5;
    const overflow = textRects.filter((value) => !within(value, box));
    const clippedBy = []; let ancestor = element;
    while (ancestor && ancestor !== card?.parentElement) {
      const computed = getComputedStyle(ancestor);
      if ([computed.overflowX, computed.overflowY].some((value) => /^(?:hidden|clip)$/u.test(value))) {
        const ancestorBox = rect(ancestor);
        if (textRects.some((value) => !within(value, ancestorBox))) clippedBy.push(ancestor.className || ancestor.tagName);
      }
      ancestor = ancestor.parentElement;
    }
    let lastCharacterVisible = false;
    if (lastRect) {
      const x = (lastRect.left + lastRect.right) / 2; const y = (lastRect.top + lastRect.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      lastCharacterVisible = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !!hit && (element === hit || element.contains(hit));
    }
    const overlaps = [];
    if (card?.classList.contains('vd-image-choice')) {
      const image = card.querySelector('.vd-image-pick img'); const pick = card.querySelector('.vd-image-pick'); const preview = card.querySelector(':scope > button:not(.vd-image-pick)');
      const next = (element.closest('.reference-image-name') || element).nextElementSibling;
      if (image && rect(image).bottom > box.top + 1) overlaps.push('image/title');
      if (next && box.bottom > rect(next).top + 1) overlaps.push('title/metadata');
      if (pick && preview && rect(pick).bottom > rect(preview).top + 1) overlaps.push('picker/preview-button');
    }
    if (card?.classList.contains('vd-reference-row')) {
      const actions = card.querySelector('.vd-reference-actions'); const select = card.querySelector('select');
      if (actions && box.right > rect(actions).left + 1) overlaps.push('title/actions');
      if (select && box.bottom > rect(select).top + 1) overlaps.push('title/usage-select');
    }
    if (card?.classList.contains('reference-image-picker-item')) {
      const thumb = card.querySelector('.reference-image-picker-thumb'); const selection = card.querySelector('.reference-image-picker-selection');
      if (thumb && rect(thumb).right > box.left + 1) overlaps.push('thumbnail/title');
      if (selection && box.bottom > rect(selection).top + 1) overlaps.push('title/selection');
    }
    return { text: element.textContent, expected, box, cardBox, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, renderedCharacters: textRects.length, overflowingCharacters: overflow.length, clippedBy, lastCharacterVisible, overlaps, insideCard: !cardBox || within(box, cardBox) };
  }, { expected, cardSelector });
  assert.equal(result.text, expected, `${context}: stored name must be rendered verbatim`);
  assert.notEqual(result.textOverflow, 'ellipsis', `${context}: no ellipsis`);
  assert.equal(result.overflowingCharacters, 0, `${context}: every name character fits inside the name element: ${JSON.stringify(result)}`);
  assert.deepEqual(result.clippedBy, [], `${context}: no ancestor clips the title`);
  assert.ok(result.scrollWidth <= result.clientWidth + 2, `${context}: name has no hidden horizontal scroll`);
  assert.ok(result.scrollHeight <= result.clientHeight + 2, `${context}: name has no hidden vertical scroll`);
  assert.ok(result.fontSize >= 9, `${context}: font keeps a readable floor`);
  assert.ok(result.insideCard, `${context}: title stays inside its card`);
  assert.ok(result.lastCharacterVisible, `${context}: the final segment/shot suffix is visibly hit-testable, not merely in the DOM`);
  assert.deepEqual(result.overlaps, [], `${context}: title, thumbnail, metadata and controls do not overlap`);
  return { context, ...result };
}

async function inspectDialog(dialog) {
  return dialog.evaluate((element) => {
    const box = element.getBoundingClientRect(); const footer = element.querySelector('.vd-modal-footer, .reference-image-picker-footer'); const footerBox = footer.getBoundingClientRect();
    const hit = (target) => { const rect = target.getBoundingClientRect(); const found = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2); return !!found && (target === found || target.contains(found)); };
    const tabs = element.querySelector('.vd-reference-picker-tabs');
    const panel = element.querySelector('.vd-reference-picker-panel:not([hidden])');
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, scrollWidth: element.scrollWidth, footerTop: footerBox.top, footerBottom: footerBox.bottom, footerActionVisible: hit(footer.querySelector('button')), viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth,
      ...(tabs && panel ? { tabsBottom: tabs.getBoundingClientRect().bottom, tabsVisible: [...tabs.querySelectorAll('[role="tab"]')].every(hit), panelTop: panel.getBoundingClientRect().top, panelBottom: panel.getBoundingClientRect().bottom } : {}) };
  });
}

async function inspectSlotBadge(locator, expectedText, fontScale, context) {
  const value = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement('i');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--violet)';
    element.append(probe);
    const expectedColor = getComputedStyle(probe).color;
    probe.remove();
    return { text: element.textContent, color: style.color, expectedColor, violet: style.getPropertyValue('--violet').trim(), fontSize: parseFloat(style.fontSize) };
  });
  assert.equal(value.text.split(' · ')[0], expectedText, `${context}: slot text retains its actual assignment, with any category mismatch left as an advisory suffix`);
  assert.ok(value.violet, `${context}: violet theme token is defined`);
  assert.equal(value.color, value.expectedColor, `${context}: slot badge keeps its violet emphasis, not muted metadata color`);
  assert.ok(Math.abs(value.fontSize - 11 * fontScale) <= 0.05, `${context}: slot badge retains 11px × user font scale, not metadata sizing: ${JSON.stringify(value)}`);
  return { context, fontScale, ...value };
}

async function assertDialogFits(dialog, context) {
  const value = await inspectDialog(dialog);
  assert.ok(value.left >= 0 && value.right <= value.viewportWidth + 1 && value.top >= 0 && value.bottom <= value.viewportHeight + 1, `${context}: modal stays in viewport`);
  assert.ok(value.documentWidth <= value.viewportWidth + 1 && value.scrollWidth <= value.width + 2, `${context}: no horizontal overflow`);
  assert.ok(value.footerBottom <= value.viewportHeight + 1, `${context}: confirm action remains visible`);
  assert.equal(value.footerActionVisible, true, `${context}: confirm action is actually hit-testable, not covered by scrolling content`);
  if (value.tabsBottom !== undefined) {
    assert.equal(value.tabsVisible, true, `${context}: both separate columns remain visible and clickable`);
    assert.ok(value.tabsBottom <= value.panelTop + 1, `${context}: active content never overlaps column controls`);
    assert.ok(value.panelBottom <= value.footerTop + 1, `${context}: active content never overlaps shared footer`);
  }
  return value;
}

async function capture(name) {
  const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file);
}

async function assertIntegrity() {
  assert.deepEqual(await page.evaluate(() => { const qa = window.__videoReferenceUsageQa; return { project: JSON.stringify(qa.project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings, submissions: qa.submissions.length, aiCalls: qa.aiCalls }; }), { project: true, settings: true, submissions: 0, aiCalls: 0 }, 'reading, selecting and reordering references never changes source project/H3/settings or calls an API');
}

try {
  await server.listen(); const address = server.httpServer.address(); browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1120, height: 720 }]) {
    for (const fontScale of [1, 1.3]) {
      page = await browser.newPage({ viewport }); page.setDefaultTimeout(25_000); page.on('pageerror', (cause) => errors.push(cause.message));
      const fixture = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${address.port}`, { assetNames: names, fontScale });
      const label = `${viewport.width}x${viewport.height}-${Math.round(fontScale * 100)}percent`;
      const measuredNames = []; const slotStyles = [];
      const row = () => page.locator('[data-segment-id="ruq-segment-1"]');
      const showList = async () => { const tab = page.getByRole('tab', { name: '分段清单', exact: true }); if (await tab.isVisible()) await tab.click(); };
      await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); await showList();
      await row().getByLabel('选择第 1 段', { exact: true }).check();
      await row().getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '第 1 段 · 选择参考图', exact: true }); await dialog.waitFor();
      await assertVideoReferencePickerStartsWithImages(dialog);
      const card = (assetId, selected = true) => dialog.getByRole('button', { name: `${selected ? '取消选择' : '选择'}图片 ${names[assetId]}`, exact: true });
      slotStyles.push(await inspectSlotBadge(card('ruq-composition').locator('.vd-image-slot-badge'), '构图1（槽1）', fontScale, `${label}/batch-library/composition`));
      slotStyles.push(await inspectSlotBadge(card('ruq-a').locator('.vd-image-slot-badge'), '人物1（槽2）', fontScale, `${label}/batch-library/character`));
      for (const [assetId, expected] of Object.entries(names)) measuredNames.push(await inspectName(card(assetId, ids.includes(assetId)).locator('.reference-image-name-text'), expected, `${label}/batch-library/${assetId}`, '.vd-image-choice'));
      const shortFont = measuredNames.find((item) => item.context.endsWith('/ruq-scene')).fontSize;
      const longFont = measuredNames.find((item) => item.context.endsWith('/ruq-c')).fontSize;
      assert.ok(longFont < shortFont, `${label}: long reference titles automatically shrink relative to short ones`);
      await card('ruq-a').click(); assert.equal(await card('ruq-b').locator('.vd-image-slot-badge').innerText(), '人物2（槽3）');
      await card('ruq-a', false).click(); assert.equal(await card('ruq-a').locator('.vd-image-slot-badge').innerText(), '人物1（槽2）');
      await dialog.getByRole('tabpanel', { name: '图片选择', exact: true }).locator('.vd-batch-dialog-body').evaluate((element) => { element.scrollTop = 0; });
      const batchFit = await assertDialogFits(dialog, `${label}/batch-library`); await capture(`batch-library-${label}`);
      await showVideoReferencePickerPane(dialog, '槽位用途');
      slotStyles.push(await inspectSlotBadge(dialog.locator('.vd-reference-info .vd-image-slot-badge').nth(0), '构图1（槽1）', fontScale, `${label}/batch-bindings/composition`));
      slotStyles.push(await inspectSlotBadge(dialog.locator('.vd-reference-info .vd-image-slot-badge').nth(1), '人物1（槽2）', fontScale, `${label}/batch-bindings/character`));
      let selectedIds = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-c'];
      for (const [index, assetId] of selectedIds.entries()) measuredNames.push(await inspectName(dialog.locator('.vd-reference-info .reference-image-name-text').nth(index), names[assetId], `${label}/batch-bindings/${assetId}`, '.vd-reference-row'));
      await dialog.getByLabel('第 1 段图片槽 1 用途', { exact: true }).selectOption('first-frame');
      assert.equal(await dialog.getByLabel('第 1 段图片槽 1 用途', { exact: true }).isEnabled(), true);
      await showVideoReferencePickerPane(dialog, '图片选择');
      slotStyles.push(await inspectSlotBadge(card('ruq-composition').locator('.vd-image-slot-badge'), '首帧（槽1）', fontScale, `${label}/batch-library/edited-first-frame`));
      await card('ruq-c').click(); await card('ruq-a-alt', false).click(); selectedIds = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-a-alt'];
      await showVideoReferencePickerPane(dialog, '槽位用途');
      assert.deepEqual(await dialog.locator('.vd-reference-info .reference-image-name-text').allTextContents(), selectedIds.map((id) => names[id]), 'replacement keeps exact full names and physical slot order');
      measuredNames.push(await inspectName(dialog.locator('.vd-reference-info .reference-image-name-text').nth(3), names['ruq-a-alt'], `${label}/batch-bindings/replacement`, '.vd-reference-row'));
      await dialog.getByRole('tabpanel', { name: '槽位用途', exact: true }).locator('.vd-batch-dialog-body').evaluate((element) => { element.scrollTop = 0; });
      const bindingsFit = await assertDialogFits(dialog, `${label}/batch-bindings`); await capture(`batch-bindings-${label}`);
      await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
      await showList(); await row().getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '参考图与用途', exact: true }).click();
      for (const [index, assetId] of selectedIds.entries()) {
        const previewRow = page.locator('.vd-batch-reference-preview > div').nth(index);
        assert.ok((await previewRow.innerText()).includes(names[assetId]), 'batch preview retains the full title');
        const name = previewRow.locator('.reference-image-name-text');
        measuredNames.push(await inspectName(name, `${index + 1}. ${names[assetId]}`, `${label}/batch-preview/${assetId}`, '.vd-batch-reference-preview > div'));
      }
      await assertIntegrity(); stages.push(`${label}: separate batch library/purpose columns, preview, replacement and live slot labels`);
      await page.evaluate(() => window.__videoReferenceUsageQa.reset({ single: true }));
      const section = page.locator('.vd-reference-card'); await section.locator('.vd-reference-row').first().waitFor();
      assert.equal(await section.locator('select').count(), 0, 'single-page selected summary has no duplicate purpose editor');
      slotStyles.push(await inspectSlotBadge(section.locator('.vd-image-slot-badge').nth(0), '构图1（槽1）', fontScale, `${label}/single-selected/composition`));
      slotStyles.push(await inspectSlotBadge(section.locator('.vd-image-slot-badge').nth(1), '人物1（槽2）', fontScale, `${label}/single-selected/character`));
      for (const [index, assetId] of ids.entries()) measuredNames.push(await inspectName(section.locator('.vd-reference-info .reference-image-name-text').nth(index), names[assetId], `${label}/single-selected/${assetId}`, '.vd-reference-row'));
      await section.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '从图片资产库选择生成参考图', exact: true }); await dialog.waitFor();
      await assertVideoReferencePickerStartsWithImages(dialog);
      slotStyles.push(await inspectSlotBadge(card('ruq-composition').locator('.vd-image-slot-badge'), '构图1（槽1）', fontScale, `${label}/single-library/composition`));
      slotStyles.push(await inspectSlotBadge(card('ruq-a').locator('.vd-image-slot-badge'), '人物1（槽2）', fontScale, `${label}/single-library/character`));
      for (const [assetId, expected] of Object.entries(names)) measuredNames.push(await inspectName(card(assetId, ids.includes(assetId)).locator('.reference-image-name-text'), expected, `${label}/single-library/${assetId}`, '.vd-image-choice'));
      await card('ruq-c').click(); await card('ruq-a-alt', false).click();
      assert.equal(await card('ruq-a-alt').locator('.vd-image-slot-badge').innerText(), '人物3（槽4）');
      await dialog.getByRole('tabpanel', { name: '图片选择', exact: true }).locator('.vd-batch-dialog-body').evaluate((element) => { element.scrollTop = 0; });
      const singleFit = await assertDialogFits(dialog, `${label}/single-library`); await capture(`single-library-${label}`);
      await showVideoReferencePickerPane(dialog, '槽位用途');
      await dialog.getByLabel('本段图片槽 1 用途', { exact: true }).selectOption('first-frame');
      for (const [index, assetId] of ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-a-alt'].entries()) measuredNames.push(await inspectName(dialog.locator('.vd-reference-info .reference-image-name-text').nth(index), names[assetId], `${label}/single-purposes/${assetId}`, '.vd-reference-row'));
      const singlePurposeFit = await assertDialogFits(dialog, `${label}/single-purposes`); await capture(`single-purposes-${label}`);
      await dialog.getByRole('button', { name: '使用所选图片', exact: true }).click();
      assert.deepEqual(await section.locator('.vd-reference-info .reference-image-name-text').allTextContents(), ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-a-alt'].map((id) => names[id]), 'applying selection preserves all selected names');
      assert.equal(await section.locator('.vd-image-slot-badge').nth(0).innerText(), '首帧（槽1）');
      assert.equal(await section.locator('.vd-image-slot-badge').nth(1).innerText(), '人物1（槽2）');
      await assertIntegrity();
      stages.push(`${label}: single library, selected list, selection and slot labels`);
      await page.evaluate(async () => {
        const { ReferenceImagePickerModal } = await import('/src/components/ReferenceImagePickerModal.tsx');
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
        const host = document.createElement('div'); document.querySelector('main').append(host);
        const qa = window.__referenceNameGenericQa = { confirmedId: '', closed: false };
        const assets = structuredClone(window.__videoReferenceUsageQa.project.assets);
        ReactDOM.createRoot(host).render(React.createElement(ReferenceImagePickerModal, { open: true, assets, selectedAssetId: 'ruq-composition', onClose: () => { qa.closed = true; }, onConfirm: (asset) => { qa.confirmedId = asset.id; } }));
      });
      const generic = page.getByRole('dialog', { name: '从资产库选择参考图', exact: true }); await generic.waitFor();
      for (const [assetId, expected] of Object.entries(names)) {
        const item = generic.locator('.reference-image-picker-item').filter({ has: page.locator('.reference-image-name-text', { hasText: expected }) });
        measuredNames.push(await inspectName(item.locator('.reference-image-name-text'), expected, `${label}/generic-library/${assetId}`, '.reference-image-picker-item'));
      }
      const genericFit = await assertDialogFits(generic, `${label}/generic-library`);
      measuredNames.push(await inspectName(generic.locator('.reference-image-picker-footer .reference-image-name-text'), `已选：${names['ruq-composition']}`, `${label}/generic-footer`, '.reference-image-picker-footer'));
      await generic.locator('.reference-image-picker-list').evaluate((element) => { element.scrollTop = 0; }); await capture(`generic-library-${label}`);
      const search = generic.getByRole('searchbox'); await search.fill('Segment 99');
      assert.equal(await generic.locator('.reference-image-picker-item').count(), 1, 'full suffix remains searchable');
      await generic.locator('.reference-image-picker-item').click();
      measuredNames.push(await inspectName(generic.locator('.reference-image-picker-footer .reference-image-name-text'), `已选：${names['ruq-a-alt']}`, `${label}/generic-selected-footer`, '.reference-image-picker-footer'));
      await generic.getByRole('button', { name: '使用所选图片', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__referenceNameGenericQa.confirmedId), 'ruq-a-alt', 'generic picker confirms the exact selected long-name asset');
      await assertIntegrity(); assert.deepEqual(fixture.blockedRequests, [], 'no external/provider request was attempted'); blockedRequests.push(...fixture.blockedRequests);
      stages.push(`${label}: shared reference picker, full-name search and confirmation`);
      layouts.push({ viewport, fontScale, batchFit, bindingsFit, singleFit, singlePurposeFit, genericFit, shortFont, longFont, measuredNames, slotStyles });
      await page.close(); page = undefined;
    }
  }
  assert.deepEqual(errors, [], 'no runtime errors'); assert.deepEqual(blockedRequests, []);
  const report = { passed: true, stages, layouts, screenshots, errors, blockedRequests, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, stages: stages.length, layouts: layouts.length, screenshots, errors, blockedRequests, report: path.join(output, 'report.json') }, null, 2));
} catch (cause) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); await fs.writeFile(path.join(output, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stages, layouts, errors, blockedRequests, output }, null, 2));
  console.error(cause); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
