import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

const apiOrigin = 'https://video.laoliimage2.win';
const largeModel = '特价2.5-合成接口返回30图';
const smallModel = '特价2.5-合成接口返回7图';
const unknownModel = '特价2.5-合成接口未声明图片容量';
const content = (schema) => ({ content: { 'application/json': { schema } } });
const taskSchema = { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, download_url: { type: 'string' } } };

// Capacity is supplied through read-only responses, never injected into a
// saved cache or inferred from the model name. Unknown has an images schema
// without maxItems: its classic name cannot manufacture a limit.
export const imageCapacityQaResponses = {
  origin: apiOrigin, openapiPath: '/docs/video-api/openapi.json',
  models: { data: [largeModel, smallModel, unknownModel].map((id) => ({ id })) },
  openapi: { openapi: '3.1.0', servers: [{ url: apiOrigin }], paths: {
    '/v1/videos': { post: { requestBody: content({ oneOf: [[largeModel, 30], [smallModel, 7], [unknownModel, undefined]].map(([model, maxItems]) => ({
      type: 'object', properties: { model: { const: model }, prompt: { type: 'string' },
        duration: { type: 'integer', minimum: 16, maximum: 30 }, resolution: { const: '720p' }, ratio: { type: 'string' },
        images: { type: 'array', items: { type: 'string' }, ...(maxItems === undefined ? {} : { maxItems }) } },
    })) }), responses: { '200': content(taskSchema) } } },
    '/v1/videos/{id}': { get: { responses: { '200': content(taskSchema) } } },
  } },
};

export async function runVideoApiImageCapacityUiAssertions(page, outputDirectory, capabilityRequests) {
  const screenshots = []; const stages = [];
  const overrides = JSON.stringify({ duration: 30, resolution: '720p', aspect_ratio: '16:9' });
  const readCount = (model) => page.evaluate((id) => window.__videoReferenceUsageQa.capabilityReads.filter((entry) => entry.model === id).length, model);
  const waitForRead = (model, before) => page.waitForFunction(({ model, before }) =>
    window.__videoReferenceUsageQa.capabilityReads.filter((entry) => entry.model === model).length > before, { model, before });
  const capture = async (name) => {
    if (!outputDirectory) return;
    const file = path.join(outputDirectory, `${name}.png`);
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  };
  const integrity = async () => assert.deepEqual(await page.evaluate(() => {
    const qa = window.__videoReferenceUsageQa;
    const baseline = JSON.parse(qa.originalSettings); const current = structuredClone(qa.settings);
    for (const settings of [baseline, current]) { delete settings.videoTaskApi.parameterCapabilities; delete settings.videoTaskApi.model; }
    return { project: JSON.stringify(qa.project) === qa.originalProject, connection: JSON.stringify(current) === JSON.stringify(baseline),
      submissions: qa.submissions.length, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls };
  }), { project: true, connection: true, submissions: 0, aiCalls: 0, extractionCalls: 0 });

  for (const mode of ['single', 'batch']) {
    const single = mode === 'single'; const row = page.locator('[data-segment-id="ruq-segment-1"]');
    const prepare = async (model) => {
      const resetProjectId = await page.evaluate((options) => {
        const qa = window.__videoReferenceUsageQa;
        qa.reset(options);
        const original = JSON.parse(qa.originalSettings);
        if (original.videoTaskApi.parameterCapabilities !== undefined) throw new Error('Fresh capacity fixture must start without a capability cache');
        return JSON.parse(qa.originalProject).id;
      }, { source: 'api', classicModel: model, single });
      // React publishes the new rendered value after reset. Await that value
      // before inspecting qa.settings, which otherwise may still be the last
      // model's already-read cache for one browser event loop turn.
      await page.waitForFunction((expected) => window.__videoReferenceUsageQa.project.id === expected, resetProjectId);
      assert.equal(await page.evaluate(() => window.__videoReferenceUsageQa.settings.videoTaskApi.parameterCapabilities), undefined, 'fixture starts without an injected capability cache');
      await page.getByRole('tab', { name: single ? '单段生成' : '长剧情批量', exact: true }).click();
      if (single) {
        await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
        await page.getByLabel('本次额外参数 JSON', { exact: true }).fill(overrides);
        const original = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
        assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), original);
      } else {
        await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
        await page.locator('.vd-batch-advanced > summary').click();
        await page.getByLabel('批量公共参数 JSON', { exact: true }).fill(overrides);
        await row.getByLabel('选择第 1 段', { exact: true }).check();
      }
    };
    const open = async () => {
      const before = await readCount(largeModel);
      if (single) await page.locator('.vd-reference-card').getByRole('button', { name: '从图片资产库选择', exact: true }).click();
      else await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
      const picker = page.getByRole('dialog', { name: single ? '从图片资产库选择生成参考图' : '第 1 段 · 选择参考图', exact: true });
      await picker.waitFor(); await assertVideoReferencePickerStartsWithImages(picker);
      return { picker, before };
    };
    const apply = async (picker) => {
      await picker.getByRole('button', { name: single ? '使用所选图片' : '使用本段图片', exact: true }).click();
      await picker.waitFor({ state: 'hidden' });
    };
    const usageName = (slot) => `${single ? '本段' : '第 1 段'}图片槽 ${slot} 用途`;
    await prepare(largeModel);
    let { picker, before } = await open();
    await waitForRead(largeModel, before);
    assert.match(await picker.getByLabel('接口图片容量', { exact: true }).innerText(), /接口已返回 30 个图片槽/u);
    assert.equal(await picker.getByRole('link', { name: 'OpenAPI 来源', exact: true }).getAttribute('href'), `${apiOrigin}/docs/video-api/openapi.json`);
    let purposes = await showVideoReferencePickerPane(picker, '槽位用途');
    assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 30);
    assert.equal(await purposes.locator('.vd-slot-empty').count(), 24, 'six selected pictures do not hide the remaining declared empty slots');
    await purposes.getByLabel(usageName(30), { exact: true }).selectOption('middle-frame');
    assert.match(await purposes.locator('.vd-slot-usage-row').nth(29).innerText(), /图片槽 30（未选择）/u);
    await capture(`${mode}-openapi-30-slots`);
    await apply(picker); await integrity();
    ({ picker, before } = await open());
    await waitForRead(largeModel, before);
    purposes = await showVideoReferencePickerPane(picker, '槽位用途');
    assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 30);
    assert.equal(await purposes.getByLabel(usageName(30), { exact: true }).inputValue(), 'middle-frame', 'empty slot 30 purpose survives applying and reopening');
    const smallerReadCount = await readCount(smallModel);
    await page.evaluate((model) => window.__videoReferenceUsageQa.setModel(model), smallModel);
    await waitForRead(smallModel, smallerReadCount);
    assert.match(await picker.getByLabel('接口图片容量', { exact: true }).innerText(), /接口已返回 7 个图片槽/u);
    assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 7, 'remembered empty slot 30 must not enlarge current model capacity');
    assert.equal(await purposes.locator('.vd-slot-empty').count(), 1);
    assert.equal(await purposes.getByLabel(usageName(30), { exact: true }).count(), 0);
    await capture(`${mode}-openapi-7-slots`);
    await picker.getByRole('button', { name: '关闭', exact: true }).click(); await integrity();
    if (single) {
      const original = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
      assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), original);
    } else {
      await row.getByRole('button', { name: '预览', exact: true }).click();
      await page.getByRole('tab', { name: '本次实际提示词', exact: true }).click();
      const original = await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].finalPrompt);
      assert.equal(await page.locator('.vd-prompt-preview').innerText(), original);
    }
    await prepare(unknownModel);
    ({ picker } = await open()); await waitForRead(unknownModel, 0);
    assert.match(await picker.getByLabel('接口图片容量', { exact: true }).innerText(), /未读取到当前接口、当前模型的图片容量/u);
    assert.equal(await picker.getByRole('link', { name: 'OpenAPI 来源', exact: true }).count(), 0);
    purposes = await showVideoReferencePickerPane(picker, '槽位用途');
    assert.equal(await purposes.locator('.vd-slot-usage-row').count(), 6, 'unknown classic model has only its six selected slots; no guessed 30-slot capacity');
    assert.equal(await purposes.locator('.vd-slot-empty').count(), 0);
    await capture(`${mode}-unknown-capacity-no-guessed-slots`);
    await picker.getByRole('button', { name: '关闭', exact: true }).click(); await integrity();
    stages.push(`${mode}: GET schema 30 slots, empty slot 30 purpose saved, changed model GET schema 7 slots, unknown capacity explicit and not guessed`);
  }
  assert.ok(capabilityRequests.some((request) => request.path === '/v1/models'), 'UI actually reads synthetic model metadata');
  assert.ok(capabilityRequests.some((request) => request.path === '/docs/video-api/openapi.json'), 'UI actually reads synthetic OpenAPI metadata');
  assert.ok(capabilityRequests.every((request) => request.method === 'GET' && new URL(request.url).origin === apiOrigin), 'capability reads are GETs to the current configured API origin only');
  return { passed: true, screenshots, stages, capabilityRequests };
}

export async function runStandaloneVideoApiImageCapacityUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `video-api-image-capacity-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  const port = await findAvailableTcpPort();
  const server = await createServer({ root,
    plugins: [{ name: 'disable-capacity-qa-watch', configResolved(config) { config.server.watch = null; } }],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  let browser; let page; const errors = []; let blockedRequests = []; let capabilityRequests = [];
  try {
    await server.watcher.close(); await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests, capabilityRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`,
      { fontScale: 1, capabilityResponses: imageCapacityQaResponses }));
    const report = await runVideoApiImageCapacityUiAssertions(page, outputDirectory, capabilityRequests);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no attempted paid or other external request');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, outputDirectory, errors, blockedRequests }, null, 2));
    return { ...report, outputDirectory };
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), errors, blockedRequests, capabilityRequests }, null, 2));
    if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoApiImageCapacityUiQa(), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
