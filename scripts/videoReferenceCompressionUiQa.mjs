import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

export async function runVideoReferenceCompressionUiAssertions(page, outputDirectory, options = {}) {
  const screenshots = []; const stages = [];
  const capture = async (name) => {
    const file = path.join(outputDirectory, `${name}.png`);
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  };
  let codec;
  if (!options.applicationsOnly) {
  codec = await page.evaluate(async () => {
    const api = await import('/src/videoReferenceCompression.ts'); const qa = window.__videoReferenceUsageQa;
    const before = JSON.stringify(qa.project.assets); const results = {};
    const digest = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const opaque = qa.project.assets.find((entry) => entry.id === 'ruq-composition');
    const largeCanvas = document.createElement('canvas'); largeCanvas.width = 3840; largeCanvas.height = 2160;
    const largeContext = largeCanvas.getContext('2d'); largeContext.imageSmoothingEnabled = false;
    const bitmap = await createImageBitmap(await (await fetch(opaque.dataUrl)).blob());
    largeContext.drawImage(bitmap, 0, 0, 3840, 2160); bitmap.close();
    const large = { id: 'qa-4k-original', name: '4K原尺寸测试', type: 'reference', role: 'composition',
      dataUrl: largeCanvas.toDataURL('image/png'), width: 3840, height: 2160, tags: [], createdAt: 1, updatedAt: 1 };
    const cases = [['opaque', opaque, 0.95], ['transparent', qa.project.assets.find((entry) => entry.id === 'ruq-style'), 0.95],
      ['jpeg', qa.project.assets.find((entry) => entry.id === 'ruq-a-alt'), 0.95], ['tiny', qa.project.assets.find((entry) => entry.id === 'ruq-tiny-png'), 0.95],
      ['large', large, 0.95], ['higherQuality', opaque, 0.98]];
    for (const [name, asset, quality] of cases) {
      const originalBlob = await (await fetch(asset.dataUrl)).blob();
      const candidate = await api.createVideoCompressionCandidate(asset, quality);
      try {
        const outputBlob = await (await fetch(candidate.dataUrl)).blob();
        const originalHash = await digest(await originalBlob.arrayBuffer()); const outputHash = await digest(await outputBlob.arrayBuffer());
        const output = await createImageBitmap(outputBlob); const original = await createImageBitmap(originalBlob);
        let alphaMatches = true;
        try {
          if (name === 'transparent') {
            const alphas = (bitmap) => {
              const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
              const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
              const pixels = context.getImageData(0, 0, 32, 2).data;
              return Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4 + 3]);
            };
            alphaMatches = JSON.stringify(alphas(output)) === JSON.stringify(alphas(original));
          }
          results[name] = { smaller: candidate.smaller, transparent: candidate.hasTransparency, requestedQuality: quality, image: candidate.image,
            originalBytes: originalBlob.size, outputBytes: outputBlob.size, actualMime: outputBlob.type, originalHash, outputHash,
            originalWidth: original.width, originalHeight: original.height, width: output.width, height: output.height, alphaMatches };
        } finally { output.close(); original.close(); }
        if (name === 'tiny') {
          const stores = qa.compressionStoreRequests.length;
          try { await api.saveVideoCompressionCandidate(candidate); throw new Error('An enlarged tiny PNG must not be saved'); }
          catch (error) { if (!String(error).includes('未变小')) throw error; }
          results.tiny.saved = qa.compressionStoreRequests.length !== stores;
        }
      } finally { api.disposeVideoCompressionCandidate(candidate); }
    }
    return { results, originalsUnchanged: JSON.stringify(qa.project.assets) === before, thumbnails: qa.compressionThumbnailRequests };
  });
  assert.equal(codec.originalsUnchanged, true); assert.equal(codec.thumbnails, 0);
  for (const result of Object.values(codec.results)) {
    assert.equal(result.image.originalSizeBytes, result.originalBytes); assert.equal(result.image.sizeBytes, result.outputBytes);
    assert.equal(result.image.sourceChecksum, result.originalHash); assert.equal(result.image.checksum, result.outputHash);
    assert.equal(result.image.mimeType, result.actualMime); assert.equal(result.image.quality, result.requestedQuality);
    assert.deepEqual([result.width, result.height], [result.originalWidth, result.originalHeight]);
    assert.equal(result.smaller, result.outputBytes < result.originalBytes);
  }
  assert.equal(codec.results.opaque.smaller, true); assert.equal(codec.results.opaque.actualMime, 'image/jpeg');
  assert.deepEqual([codec.results.opaque.width, codec.results.opaque.height], [512, 288]);
  assert.equal(codec.results.transparent.transparent, true); assert.equal(codec.results.transparent.actualMime, 'image/webp');
  assert.equal(codec.results.transparent.alphaMatches, true); assert.equal(codec.results.tiny.smaller, false); assert.equal(codec.results.tiny.saved, false);
  assert.deepEqual([codec.results.large.width, codec.results.large.height], [3840, 2160]);
  assert.equal(codec.results.higherQuality.originalHash, codec.results.opaque.originalHash, 'quality 98 starts from the same original as quality 95');
  stages.push('real Canvas: PNG to smaller JPEG at original 512×288 and preserved 3840×2160; WebP retains alpha; Blob sizes and hashes; enlarged tiny PNG is not saved; quality 95/98 both read original');
  }

  const ids = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-c', 'ruq-scene', 'ruq-style'];
  const roles = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame'];
  const snapshot = (mode) => page.evaluate((mode) => {
    const qa = window.__videoReferenceUsageQa;
    const saved = qa.savedVideoDrafts.filter((entry) => entry.projectId === qa.project.id).at(-1)?.draft;
    return mode === 'single' ? saved?.draft.references : saved?.batch?.referenceOverrides['ruq-segment-1'];
  }, mode);
  const waitForCopies = (mode, count) => page.waitForFunction(({ mode, count }) => {
    const qa = window.__videoReferenceUsageQa;
    const saved = qa.savedVideoDrafts.filter((entry) => entry.projectId === qa.project.id).at(-1)?.draft;
    const refs = mode === 'single' ? saved?.draft.references : saved?.batch?.referenceOverrides['ruq-segment-1'];
    return refs && refs.filter((reference) => reference.transportImage).length === count;
  }, { mode, count });
  const identity = (refs) => refs.map(({ transportImage, ...reference }) => reference);
  const integrity = async () => assert.deepEqual(await page.evaluate(() => {
    const qa = window.__videoReferenceUsageQa;
    return { project: JSON.stringify(qa.project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings,
      submissions: qa.submissions.length, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls, thumbnails: qa.compressionThumbnailRequests };
  }), { project: true, settings: true, submissions: 0, aiCalls: 0, extractionCalls: 0, thumbnails: 0 });

  for (const mode of ['single', 'batch']) {
    const single = mode === 'single'; const row = page.locator('[data-segment-id="ruq-segment-1"]');
    const projectId = await page.evaluate((single) => {
      const qa = window.__videoReferenceUsageQa; qa.reset({ source: 'api', classicModel: '特价2.5-轻压缩隔离测试', single });
      return JSON.parse(qa.originalProject).id;
    }, single);
    await page.waitForFunction((id) => window.__videoReferenceUsageQa.project.id === id, projectId);
    await page.getByRole('tab', { name: single ? '单段生成' : '长剧情批量', exact: true }).click();
    const parameters = JSON.stringify({ duration: 30, resolution: '720p', aspect_ratio: '16:9' });
    if (single) {
      await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
      await page.getByLabel('本次额外参数 JSON', { exact: true }).fill(parameters);
    } else {
      await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
      await page.locator('.vd-batch-advanced > summary').click();
      await page.getByLabel('批量公共参数 JSON', { exact: true }).fill(parameters);
      await row.getByLabel('选择第 1 段', { exact: true }).check();
    }
    const open = async () => {
      if (single) await page.locator('.vd-reference-card').getByRole('button', { name: '从图片资产库选择', exact: true }).click();
      else await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
      const picker = page.getByRole('dialog', { name: single ? '从图片资产库选择生成参考图' : '第 1 段 · 选择参考图', exact: true });
      await picker.waitFor(); await assertVideoReferencePickerStartsWithImages(picker); return picker;
    };
    const applyPicker = async (picker) => {
      await picker.getByRole('button', { name: single ? '使用所选图片' : '使用本段图片', exact: true }).click();
      await picker.waitFor({ state: 'hidden' });
    };
    const review = () => page.getByRole('dialog', { name: '轻压缩参考图', exact: true });
    let picker = await open();
    let purposes = await showVideoReferencePickerPane(picker, '槽位用途');
    for (const [index, role] of roles.entries()) await purposes.getByLabel(`${single ? '本段' : '第 1 段'}图片槽 ${index + 1} 用途`, { exact: true }).selectOption(role);
    const personSlot = purposes.locator('.vd-slot-usage-row').nth(1);
    await personSlot.locator('details > summary').click();
    const person = personSlot.getByRole('checkbox', { name: '甲人物', exact: true }); await person.uncheck(); await person.check();
    await applyPicker(picker); await waitForCopies(mode, 0);
    const baseline = await snapshot(mode);
    assert.deepEqual(baseline.map((reference) => reference.assetId), ids);
    assert.deepEqual(baseline.map((reference) => reference.role), roles); assert.deepEqual(baseline[1].characterIds, ['ruq-person-a']);

    picker = await open();
    const beforeTinyStores = await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length);
    if (!options.applicationsOnly) {
    // A real codec result larger than its original is previewed, never applied.
    await picker.getByRole('button', { name: '轻压缩图片 极小PNG参考', exact: true }).click();
    await review().waitFor(); assert.match(await review().innerText(), /本次未减小，继续使用原图/u);
    assert.equal(await review().getByRole('button', { name: '使用压缩副本', exact: true }).isDisabled(), true);
    await review().getByRole('button', { name: '保留当前选图', exact: true }).click(); await review().waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length), beforeTinyStores);
    assert.equal(await picker.getByRole('button', { name: '恢复原图 极小PNG参考', exact: true }).count(), 0);
    }

    if (single) {
      if (!options.applicationsOnly) {
      await picker.getByRole('button', { name: '轻压缩图片 甲人物参考', exact: true }).click(); await review().waitFor();
      assert.equal(await review().getByAltText('压缩前原图', { exact: true }).count(), 1);
      assert.equal(await review().getByAltText('压缩后候选副本', { exact: true }).count(), 1);
      await capture('single-cancel-preview');
      await review().getByRole('button', { name: '保留当前选图', exact: true }).click();
      assert.equal(await picker.getByRole('button', { name: '恢复原图 甲人物参考', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length), beforeTinyStores);
      }
      if (options.applicationsOnly) {
        // Newly added product receipt guard: an invalid managed path must be
        // rejected before installing a transport copy onto the chosen image.
        await picker.getByRole('button', { name: '轻压缩图片 甲人物参考', exact: true }).click(); await review().waitFor();
        await page.evaluate(() => { window.__videoReferenceUsageQa.invalidCompressionReceipt = true; });
        await review().getByRole('button', { name: '使用压缩副本', exact: true }).click();
        await review().getByRole('alert').waitFor();
        assert.match(await review().getByRole('alert').innerText(), /副本|保存|不一致/u);
        assert.equal(await picker.getByRole('button', { name: '恢复原图 甲人物参考', exact: true }).count(), 0);
        await page.evaluate(() => { window.__videoReferenceUsageQa.invalidCompressionReceipt = false; });
        await review().getByRole('button', { name: '保留当前选图', exact: true }).click();
      }
      await picker.getByRole('button', { name: '轻压缩图片 甲人物参考', exact: true }).click(); await review().waitFor();
      assert.match(await review().innerText(), /512×288 → 512×288/u); await capture('single-comparison-before-apply');
      await review().getByRole('button', { name: '使用压缩副本', exact: true }).click(); await review().waitFor({ state: 'hidden' });
      assert.equal(await picker.getByRole('button', { name: '恢复原图 甲人物参考', exact: true }).count(), 1);
    } else {
      if (!options.applicationsOnly) {
      // Hold the true-original reader, close the picker, then finish its IPC.
      // A result arriving after close must not save or change the new scope.
      await page.evaluate(() => { window.__videoReferenceUsageQa.holdCompressionReads = true; });
      await picker.getByRole('button', { name: '轻压缩图片 甲人物参考', exact: true }).click();
      await page.waitForFunction(() => window.__videoReferenceUsageQa.compressionInFlight > 0);
      await picker.getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(() => window.__videoReferenceUsageQa.releaseCompressionReads());
      await page.waitForFunction(() => window.__videoReferenceUsageQa.compressionInFlight === 0);
      assert.equal(await review().count(), 0); assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length), beforeTinyStores);
      assert.deepEqual(identity(await snapshot(mode)), identity(baseline));
      picker = await open();
      }
      await picker.getByRole('button', { name: '压缩已选图片', exact: true }).click(); await review().waitFor();
      assert.equal(await review().locator('.vd-compression-result').count(), 6);
      assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length), 0, 'batch compression waits for explicit apply');
      await capture('batch-comparison-before-apply');
      await review().getByRole('button', { name: '使用 6 张压缩副本', exact: true }).click(); await review().waitFor({ state: 'hidden' });
      assert.equal(await picker.getByRole('button', { name: /^恢复原图 /u }).count(), 6);
    }
    const summary = await picker.getByLabel('视频参考图大小对比', { exact: true }).innerText();
    const summaryBytes = summary.match(/原图 ([\d.]+) MiB → 本次图片文件 ([\d.]+) MiB/u);
    assert.ok(summaryBytes, 'applied summary exposes before and after sizes');
    assert.ok(Number(summaryBytes[2]) < Number(summaryBytes[1]), 'applied UI summary must show a real decrease');
    assert.equal(await picker.getByText(/压缩副本记录异常/u).count(), 0, 'no card reports an invalid saved transport');
    assert.equal(await picker.locator('.vd-image-choice.selected img').count(), 6);
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.vd-reference-picker-dialog .vd-image-choice.selected img, .vd-batch-image-dialog .vd-image-choice.selected img')];
      return images.length === 6 && images.every((image) => image.complete && image.naturalWidth === 512 && image.naturalHeight === 288);
    });
    await capture(`${mode}-applied-size-summary`); await applyPicker(picker); await waitForCopies(mode, single ? 1 : 6);
    const applied = await snapshot(mode); assert.deepEqual(identity(applied), identity(baseline), 'compressed transport keeps IDs, physical slots, roles and explicit people');
    for (const reference of applied.filter((reference) => reference.transportImage)) {
      const asset = await page.evaluate((id) => window.__videoReferenceUsageQa.project.assets.find((entry) => entry.id === id), reference.assetId);
      const image = reference.transportImage;
      assert.equal(image.sourceChecksum, asset.checksum); assert.equal(image.originalSizeBytes, asset.sizeBytes);
      assert.ok(image.sizeBytes < image.originalSizeBytes); assert.equal(image.width, asset.width); assert.equal(image.height, asset.height);
      const checked = await page.evaluate(async (image) => {
        const { normalizeVideoTransportImage, assertVideoTransportImageData } = await import('/src/videoTransportImage.ts');
        const normalized = normalizeVideoTransportImage(image);
        if (!normalized) return { valid: false };
        const loaded = await window.lianhuaDesktop.readVideoReferenceImage({ relativePath: normalized.relativePath, expectedChecksum: normalized.checksum });
        await assertVideoTransportImageData(normalized, loaded.dataUrl);
        const served = await (await fetch(`${location.origin}/__video_compression_asset/${normalized.relativePath}`)).blob();
        const servedHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await served.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return { valid: true, loadedBytes: loaded.sizeBytes, servedBytes: served.size, servedHash, servedMime: served.type };
      }, image);
      assert.equal(checked.valid, true, 'every saved transport passes the production normalizer');
      assert.equal(checked.loadedBytes, image.sizeBytes); assert.equal(checked.servedBytes, image.sizeBytes);
      assert.equal(checked.servedHash, image.checksum); assert.equal(checked.servedMime, image.mimeType);
    }
    await integrity();
    picker = await open();
    if (single && !options.applicationsOnly) {
      const count = await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length);
      await picker.getByRole('button', { name: '轻压缩图片 甲人物参考', exact: true }).click(); await review().waitFor();
      assert.match(await review().innerText(), new RegExp(`${(baseline[1] && applied[1].transportImage.originalSizeBytes / 1024 / 1024).toFixed(2)} MiB`, 'u'));
      assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionReadRequests.at(-1)), 'image/qa-original-ruq-a.png', 'recompression reads the asset original, not the previously saved copy');
      await review().getByRole('button', { name: '保留当前选图', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.compressionStoreRequests.length), count);
    }
    const restoreNames = single ? ['甲人物参考'] : ['分镜构图原图', '甲人物参考', '乙人物参考', '丙人物参考', '普通场景照片', '普通风格照片'];
    for (const name of restoreNames) await picker.getByRole('button', { name: `恢复原图 ${name}`, exact: true }).click();
    assert.equal(await picker.getByRole('button', { name: /^恢复原图 /u }).count(), 0);
    await applyPicker(picker); await waitForCopies(mode, 0);
    assert.deepEqual(await snapshot(mode), baseline); await integrity();
    const originalPrompt = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
    if (single) assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), originalPrompt);
    else { await row.getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '本次实际提示词', exact: true }).click(); assert.equal(await page.locator('.vd-prompt-preview').innerText(), originalPrompt); }
    stages.push(options.applicationsOnly ? `${mode}: applied summary decreased; all saved transport normalizers and real served bytes valid; cards have no invalid-copy notice; apply/restore preserves roles/slots/person bindings and original text/project; zero submissions${single ? '; invalid save receipt rejected' : ''}`
      : `${mode}: explicit preview/apply/restore; larger result kept original; roles/slots/person bindings and original project/text unchanged; no submission${single ? '; recompression reads original' : '; close during original read discards late result'}`);
  }
  return { passed: true, screenshots, stages, codec: codec?.results, applicationsOnly: Boolean(options.applicationsOnly) };
}

export async function runStandaloneVideoReferenceCompressionUiQa(options = {}) {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `video-reference-compression-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true }); const port = await findAvailableTcpPort();
  const server = await createServer({ root,
    plugins: [{ name: 'disable-compression-qa-watch', configResolved(config) { config.server.watch = null; } }],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  let browser; let page; const errors = []; let blockedRequests = [];
  try {
    await server.watcher.close(); await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`, { fontScale: 1, compressionImages: true }));
    const report = await runVideoReferenceCompressionUiAssertions(page, outputDirectory, options);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no external or paid request');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, outputDirectory, errors, blockedRequests }, null, 2));
    return { ...report, outputDirectory };
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), errors, blockedRequests }, null, 2));
    if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoReferenceCompressionUiQa({ applicationsOnly: process.argv.includes('--applications-only') }), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
