import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Real director component only, synthetic pictures and ordinary Chinese text.
// Stop before fee confirmation; record-only controller and blocked external
// requests keep both video and language-model submissions unreachable.
export async function runClassicVideoFramePreflightUiAssertions(page, outputDirectory) {
  const roles = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame'];
  const names = ['分镜构图原图', '甲人物参考', '乙人物参考', '丙人物参考', '普通场景照片', '普通风格照片'];
  const screenshots = [];
  await page.evaluate(() => window.__videoReferenceUsageQa.reset({ source: 'api', classicModel: '特价2.5-需过人脸技术' }));
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
  await page.locator('.vd-batch-advanced > summary').click();
  await page.getByLabel('批量公共参数 JSON', { exact: true }).fill(JSON.stringify({ duration: 30, resolution: '720p', aspect_ratio: '16:9' }));
  const row = page.locator('[data-segment-id="ruq-segment-1"]');
  await row.getByLabel('选择第 1 段', { exact: true }).check();
  await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '第 1 段 · 选择参考图', exact: true });
  await picker.waitFor(); await assertVideoReferencePickerStartsWithImages(picker);
  for (const name of names) assert.equal(await picker.getByRole('button', { name: `取消选择图片 ${name}`, exact: true }).count(), 1);
  const purposes = await showVideoReferencePickerPane(picker, '槽位用途');
  assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 6);
  for (const [index, role] of roles.entries()) await purposes.getByLabel(`第 1 段图片槽 ${index + 1} 用途`, { exact: true }).selectOption(role);
  for (const index of [1, 2, 3, 4]) {
    assert.match(await purposes.getByLabel(`第 1 段图片槽 ${index + 1} 用途`, { exact: true }).locator('option:checked').innerText(),
      new RegExp(`^中间帧\\s*${index}$`, 'u'));
  }
  if (outputDirectory) {
    const file = path.join(outputDirectory, 'classic-six-frame-purposes.png');
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  }
  await picker.getByRole('button', { name: '使用本段图片', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  await row.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('tab', { name: '本次实际提示词', exact: true }).click();
  const originalPrompt = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
  assert.equal(await page.locator('.vd-prompt-preview').innerText(), originalPrompt, 'role editing keeps ordinary Chinese prompt byte-for-byte');
  await page.getByRole('tab', { name: '参考图与用途', exact: true }).click();
  const referenceRows = await page.locator('.vd-batch-reference-preview > div').allInnerTexts();
  assert.equal(referenceRows.length, 6);
  for (const [index, name] of names.entries()) assert.ok(referenceRows[index].includes(name), 'preview keeps all six images in the selected order');
  for (const index of [1, 2, 3, 4]) assert.match(referenceRows[index], new RegExp(`中间帧\\s*·\\s*槽\\s*${index + 1}`, 'u'),
    'reference preview reports the middle-frame role and its physical slot; picker options carry the middle ordinal');
  const listTab = page.getByRole('tab', { name: '分段清单', exact: true });
  if (await listTab.isVisible()) await listTab.click();
  const check = page.getByRole('button', { name: '检查并生成 1 段视频', exact: true });
  assert.equal(await check.isDisabled(), false, 'classic images protocol must not block user-labelled first/middle/last references');
  assert.doesNotMatch(await page.locator('.vd-batch-footer').innerText(), /不支持首尾帧|需要一张首帧/u);
  await check.click();
  const confirmation = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /6 张图/u);
  assert.match(await confirmation.locator('.vop-request-summary').innerText(), /30 秒/u);
  assert.match(await confirmation.locator('.vop-request-summary').innerText(), /720p/u);
  assert.equal(await confirmation.getByLabel('确认批量生成费用', { exact: true }).isChecked(), false);
  assert.equal(await confirmation.getByRole('button', { name: '确认生成 1 段', exact: true }).isDisabled(), true);
  if (outputDirectory) {
    const file = path.join(outputDirectory, 'classic-fee-confirmation-no-submit.png');
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  }
  assert.deepEqual(await page.evaluate(() => {
    const qa = window.__videoReferenceUsageQa;
    return { project: JSON.stringify(qa.project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings,
      submissions: qa.submissions.length, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls };
  }), { project: true, settings: true, submissions: 0, aiCalls: 0, extractionCalls: 0 });
  await confirmation.getByRole('button', { name: '关闭', exact: true }).click();
  return { passed: true, screenshots, stages: ['classic 2.5: six first/middle/last references retained; ordinary Chinese text unchanged; fee confirmation reached with zero submissions'] };
}

export async function runStandaloneClassicVideoFramePreflightUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `classic-video-frame-preflight-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  const port = await findAvailableTcpPort();
  const server = await createServer({ root,
    plugins: [{ name: 'disable-classic-frame-qa-watch', configResolved(config) { config.server.watch = null; } }],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  let browser; let page; const errors = []; let blockedRequests = [];
  try {
    await server.watcher.close();
    await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`, { fontScale: 1 }));
    const report = await runClassicVideoFramePreflightUiAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no attempted external or paid request');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, outputDirectory, errors, blockedRequests }, null, 2));
    return { ...report, outputDirectory };
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), errors, blockedRequests }, null, 2));
    if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneClassicVideoFramePreflightUiQa(), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
