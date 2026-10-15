import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Mount the real director alone with synthetic canvas assets, in-memory
// state, blocked network and a record-only controller. No production data.
export async function runVideoMiddleFramesUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  const names = ['分镜构图原图', '甲人物参考', '乙人物参考', '丙人物参考', '普通场景照片'];
  const roles = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame'];
  const labels = ['首帧（槽1）', '中间帧1（槽2）', '中间帧2（槽3）', '中间帧3（槽4）', '尾帧（槽5）'];
  const selected = (dialog, name) => dialog.getByRole('button', { name: `取消选择图片 ${name}`, exact: true });
  const assertLabel = async (dialog, name, label) => assert.equal((await selected(dialog, name).locator('.vd-image-slot-badge').innerText()).split(' · ')[0], label);
  for (const source of ['runninghub', 'comfyui']) {
    const single = source === 'comfyui';
    await page.evaluate((options) => window.__videoReferenceUsageQa.reset(options), { source, workflow: 'keyframes', single });
    // This UI fixture's historical H3 lacks a current official provenance
    // checkpoint and has no English draft. Slot editing does not depend on
    // H3 delivery: choose the available Chinese ordinary text explicitly.
    // H3/Seedance responsibility serialization is covered by the unit file.
    if (single) {
      await page.getByRole('tab', { name: '单段生成', exact: true }).click();
      await page.getByLabel('ComfyUI 视频工作流', { exact: true }).selectOption('ruq-comfy-keyframes');
      await page.getByRole('button', { name: '从提示词导演台选择', exact: true }).click();
      const prompts = page.getByRole('dialog', { name: '从提示词导演台选择提示词', exact: true });
      await prompts.waitFor();
      await prompts.getByLabel('选择提示词格式', { exact: true }).selectOption('ordinary');
      await prompts.getByLabel('描述语言', { exact: true }).selectOption('zh');
      await prompts.locator('.vd-choice').first().click();
      await prompts.getByLabel('一并带入该提示词已有的图片参考（保留当前选图）', { exact: true }).check();
      await prompts.getByRole('button', { name: '使用这段提示词', exact: true }).click();
      await prompts.waitFor({ state: 'hidden' });
    } else {
      await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
      await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
      await page.getByRole('button', { name: '全选中文', exact: true }).click();
      await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('ruq-cloud-keyframes');
    }
    const open = async () => {
      if (single) await page.locator('.vd-reference-card').getByRole('button', { name: '从图片资产库选择', exact: true }).click();
      else await page.locator('[data-segment-id="ruq-segment-1"]').getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: single ? '从图片资产库选择生成参考图' : '第 1 段 · 选择参考图', exact: true });
      await dialog.waitFor(); await assertVideoReferencePickerStartsWithImages(dialog); return dialog;
    };
    const usageName = (slot) => `${single ? '本段' : '第 1 段'}图片槽 ${slot} 用途`;
    const apply = async (dialog) => { await dialog.getByRole('button', { name: single ? '使用所选图片' : '使用本段图片', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
    let dialog = await open();
    await dialog.getByRole('button', { name: '选择图片 普通场景照片', exact: true }).click();
    let purposes = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 5);
    for (const [index, role] of roles.entries()) await purposes.getByLabel(usageName(index + 1), { exact: true }).selectOption(role);
    for (const slot of [2, 3, 4]) {
      const choice = purposes.getByLabel(usageName(slot), { exact: true }).locator('option[value="middle-frame"]');
      assert.match(await choice.innerText(), new RegExp(`^中间帧\\s*${slot - 1}$`, 'u'));
    }
    await showVideoReferencePickerPane(dialog, '图片选择');
    for (const [index, name] of names.entries()) await assertLabel(dialog, name, labels[index]);
    await selected(dialog, '乙人物参考').click();
    await assertLabel(dialog, '丙人物参考', '中间帧3（槽4）');
    await apply(dialog);
    dialog = await open();
    purposes = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposes.getByLabel(usageName(3), { exact: true }).inputValue(), 'middle-frame');
    assert.match(await purposes.getByLabel(usageName(3), { exact: true }).locator('option:checked').innerText(), /^中间帧\s*2$/u, 'empty frame slot keeps the second middle ordinal');
    await showVideoReferencePickerPane(dialog, '图片选择');
    await dialog.getByRole('button', { name: '选择图片 普通风格照片', exact: true }).click();
    await assertLabel(dialog, '普通风格照片', '中间帧2（槽3）');
    await assertLabel(dialog, '丙人物参考', '中间帧3（槽4）');
    await assertLabel(dialog, '普通场景照片', '尾帧（槽5）');
    if (outputDirectory) { const file = path.join(outputDirectory, `${source}-three-middle-frames.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file); }
    await apply(dialog);
    dialog = await open();
    await assertLabel(dialog, '普通风格照片', '中间帧2（槽3）');
    await assertLabel(dialog, '丙人物参考', '中间帧3（槽4）');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => {
      const qa = window.__videoReferenceUsageQa;
      return { project: JSON.stringify(qa.project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings,
        submissions: qa.submissions.length, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls };
    }), { project: true, settings: true, submissions: 0, aiCalls: 0, extractionCalls: 0 });
    stages.push(`${source}/${single ? 'single' : 'batch'}: three middle frames, numbered purposes, saved vacancy and refill`);
  }
  return { passed: true, stages, screenshots };
}

export async function runStandaloneVideoMiddleFramesUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `video-middle-frames-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  const port = await findAvailableTcpPort();
  const server = await createServer({ root,
    plugins: [{ name: 'disable-middle-frame-qa-watch', configResolved(config) { config.server.watch = null; } }],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  let browser; let page; const errors = []; let blockedRequests = [];
  try {
    // Resolved config may re-enable a watcher; stop it before packaging can
    // touch output folders to avoid holding Windows build-file handles.
    await server.watcher.close();
    await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`, { fontScale: 1 }));
    const report = await runVideoMiddleFramesUiAssertions(page, outputDirectory);
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
  try { console.log(JSON.stringify(await runStandaloneVideoMiddleFramesUiQa(), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
