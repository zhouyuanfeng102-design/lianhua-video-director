import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { installImageOutputSizeFixture } from './imageOutputSizeUiQa.mjs';

// Staged functions run only in the persistent Playwright Interactive REPL.
// A fresh browser context + blocked external network + neutral color fixtures.
export const imageBatchQaInventory = [
  '人物甲3张未完成可提交人物乙4张；人物乙私密全身3张未完成可提交另一部位4张',
  '入队后生图按钮、人物选择和部位切换不被图像任务锁定',
  '普通/私密数量独立；所有任务独立保存、归属人物/部位/像素不串写',
  '旧批结果不覆盖最新人物/部位；任务页可查看每张图片及其提示词',
  '一张失败不阻断其余；排队取消/删除不提交；重启不自动重新收费',
  '1280×800和1120×720，100%/130%字号，控件可滚动访问且无重复结果区',
];
const key = 'lianhua_video_director_state_v22';
const runs = new WeakMap();
const generate = (page) => page.locator('.image-generate-actions button.primary');
const select = (page, id) => page.locator('.image-entity-controls select').selectOption(id);
const count = (page, lane = '普通') => page.getByRole('combobox', { name: `${lane}生图数量`, exact: true });
const read = (page) => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), key);
const waitForTasks = (page, amount, settled = false) => page.waitForFunction(({ storageKey, amount, settled }) => {
  const tasks = JSON.parse(localStorage.getItem(storageKey)).project.generationTasks;
  return tasks.length === amount && (!settled || tasks.every((task) => task.status === 'failed' || task.status === 'succeeded'));
}, { storageKey: key, amount, settled }, { timeout: 15000 });
const eventually = async (condition) => {
  for (let index = 0; index < 100 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition());
};

export async function installImageBatchQa(page, baseUrl) {
  // Root/other agents may edit unrelated App code while this isolated fixture runs.
  // Freeze this browser session against dev-only HMR; explicit reloads still work.
  await page.routeWebSocket(/.*/u, (socket) => socket.close());
  await installImageOutputSizeFixture(page, baseUrl);
  const qa = { requests: [], paused: [], hold: true, failImage: -1, errors: [], screenshots: [] };
  runs.set(page, qa);
  page.on('pageerror', (error) => qa.errors.push(error.message));
  await page.evaluate((storageKey) => {
    const state = JSON.parse(localStorage.getItem(storageKey));
    const source = state.project.characters[0];
    const profile = { fullBody: '中性蓝色展示模型，成人假人，完整光滑不透明外壳，仅用于程序测试。', breasts: '中性蓝色展示模型局部，不透明外壳，仅用于程序测试。', provenance: 'manual' };
    state.project.characters = [
      { ...source, id: 'batch-person-a', name: '测试假人甲', gender: '女', nsfwProfile: profile },
      { ...source, id: 'batch-person-b', name: '测试假人乙', gender: '女', nsfwProfile: profile },
    ];
    state.projects = [state.project];
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, key);
  await page.route('**/__qa_image_size__/**', async (route) => {
    const url = route.request().url();
    const body = JSON.parse(route.request().postData() || '{}');
    const image = url.includes('/images/');
    const request = { url, body, image };
    qa.requests.push(request);
    if (image) {
      const imageIndex = qa.requests.filter((entry) => entry.image).length;
      if (qa.hold) await new Promise((resolve) => qa.paused.push(resolve));
      if (imageIndex === qa.failImage) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '隔离测试：单张失败' } }) });
        return;
      }
      const png = await page.evaluate((index) => {
        const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
        const paint = canvas.getContext('2d'); paint.fillStyle = `hsl(${index * 43},60%,60%)`; paint.fillRect(0, 0, 48, 48);
        return canvas.toDataURL().split(',')[1];
      }, imageIndex);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png }] }) });
    } else {
      const source = JSON.stringify(body);
      const person = source.includes('测试假人乙') ? 'Beta' : 'Alpha';
      const part = source.includes('B-part') ? 'part' : source.includes('B-private') ? 'body' : 'ordinary';
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `A neutral ${person} ${part} display mannequin centered in a studio, opaque smooth surface, clean silhouette, even soft light and a plain background.` } }] }) });
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  await select(page, 'batch-person-a');
  return { inventory: imageBatchQaInventory };
}

export async function submitImageBatchConcurrentQa(page) {
  const qa = runs.get(page);
  await count(page).selectOption('3');
  await page.getByRole('group', { name: '选择普通生图画面规格', exact: true }).getByRole('button', { name: '全身', exact: true }).click();
  await page.getByRole('textbox', { name: '普通生图自定义要求', exact: true }).fill('A-ordinary');
  await generate(page).click();
  await eventually(() => qa.paused.length === 1);
  assert.equal(await generate(page).isEnabled(), true, 'first active image cannot lock generation');
  await select(page, 'batch-person-b');
  await count(page).selectOption('4');
  await page.getByRole('textbox', { name: '普通生图自定义要求', exact: true }).fill('B-ordinary');
  await generate(page).click();
  assert.equal(await generate(page).isEnabled(), true);
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await count(page, '私密').inputValue(), '1');
  await count(page, '私密').selectOption('3');
  await page.getByRole('textbox', { name: '私密生图自定义要求', exact: true }).fill('B-private');
  await generate(page).click();
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '胸部', exact: true }).click();
  await count(page, '私密').selectOption('4');
  await page.getByRole('textbox', { name: '私密生图自定义要求', exact: true }).fill('B-part');
  await generate(page).click();
  await waitForTasks(page, 14);
  const state = await read(page);
  assert.equal(state.project.generationTasks.filter((task) => task.status === 'queued').length, 13);
  assert.equal(qa.requests.filter((request) => request.image).length, 1);
  assert.equal(await generate(page).isEnabled(), true);
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(await count(page).inputValue(), '4');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await count(page, '私密').inputValue(), '4');
  return { tasks: 14, queued: 13, firstImageHeld: true, generationStillEnabled: true };
}

export async function finishImageBatchConcurrentQa(page) {
  const qa = runs.get(page);
  qa.failImage = 2;
  qa.hold = false; qa.paused.splice(0).forEach((resolve) => resolve());
  await waitForTasks(page, 14, true);
  const state = await read(page);
  const tasks = state.project.generationTasks;
  assert.equal(tasks.filter((task) => task.status === 'failed').length, 1);
  assert.equal(tasks.filter((task) => task.status === 'succeeded').length, 13);
  assert.equal(qa.requests.filter((request) => !request.image).length, 4, 'four batches share one conversion each');
  assert.equal(qa.requests.filter((request) => request.image).length, 14);
  for (const task of tasks.filter((task) => task.status === 'succeeded')) {
    const asset = state.project.assets.find((item) => item.id === task.resultAssetId);
    assert.equal(asset.sourceEntityId, task.sourceEntityId);
    assert.equal(asset.nsfwPrivatePart, task.nsfwPrivatePart);
    assert.equal(asset.imageVariant, task.imageVariant);
    assert.equal(state.project.characters.find((person) => person.id === task.sourceEntityId).assetIds.includes(asset.id), true);
  }
  assert.equal(await page.locator('.image-results-container').count(), 0, 'workbench omits duplicate results');
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.getByRole('tab', { name: /图片任务/u }).click();
  for (const task of tasks) {
    const card = page.locator(`[id="image-task-${task.id}"]`);
    await card.waitFor();
    assert.equal(await card.locator('.job-prompt').getAttribute('title'), task.prompt, 'each task retains its exact prompt');
    assert.equal(await card.getByRole('button', { name: `复制「${task.name}」的最终提示词`, exact: true }).isEnabled(), true);
    if (task.status === 'succeeded') {
      assert.equal(await card.locator('.image-job-preview').count(), 1);
      assert.equal(await card.getByRole('button', { name: '查看资产', exact: true }).isEnabled(), true);
    }
  }
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  return { succeeded: 13, failed: 1, converterRequests: 4, imageRequests: 14, taskResultsReadable: 14, errors: qa.errors };
}

export async function imageBatchLayoutQa(page, outputDirectory) {
  const qa = runs.get(page);
  const allowed = path.resolve(import.meta.dirname, '../output/playwright');
  const resolved = path.resolve(outputDirectory);
  assert.ok(resolved.startsWith(`${allowed}${path.sep}`));
  await fs.mkdir(resolved, { recursive: true });
  const reports = [];
  for (const [width, height, scale] of [[1280, 800, 100], [1120, 720, 100], [1120, 720, 130], [1280, 800, 130]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((fontScale) => document.querySelector('.app-shell').style.setProperty('--ui-font-scale', String(fontScale / 100)), scale);
    await page.locator('.image-generate-actions').scrollIntoViewIfNeeded();
    const report = await page.evaluate(() => {
      const selectors = ['.image-generation-controls', '.image-generate-actions'];
      const boxes = selectors.map((selector) => {
        const element = document.querySelector(selector); const rect = element.getBoundingClientRect();
        return { selector, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
      });
      const controls = document.querySelector('.image-generation-controls');
      const settingsScrollable = getComputedStyle(controls).overflowY === 'auto';
      const duplicateResults = Boolean(document.querySelector('.image-results-container, .image-batch-result-strip'));
      return { width: innerWidth, height: innerHeight, boxes, settingsScrollable, duplicateResults, overflowX: document.documentElement.scrollWidth > innerWidth, overflowY: document.documentElement.scrollHeight > innerHeight };
    });
    assert.equal(report.overflowX, false);
    assert.equal(report.settingsScrollable, true, 'all generation settings remain reachable in the available panel space');
    assert.equal(report.duplicateResults, false);
    for (const box of report.boxes) { assert.ok(box.top >= 0 && box.bottom <= height && box.left >= 0 && box.right <= width, `${box.selector} outside ${width}×${height}`); assert.ok(box.height > 0); }
    assert.ok(report.boxes[1].top >= report.boxes[0].top - 1 && report.boxes[1].bottom <= report.boxes[0].bottom + 1, 'generation actions remain visible inside the controls viewport');
    const file = path.join(resolved, `image-batch-${width}x${height}-font${scale}.png`);
    await page.screenshot({ path: file, scale: 'css' }); qa.screenshots.push(file); reports.push(report);
  }
  return { reports, screenshots: qa.screenshots };
}

export const getImageBatchQa = (page) => runs.get(page);

export async function imageBatchCancelQa(page) {
  const qa = runs.get(page);
  await count(page).selectOption('3');
  await generate(page).click();
  await eventually(() => qa.paused.length === 1);
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.getByRole('button', { name: '取消排队', exact: true }).first().click();
  assert.match(await page.locator('body').innerText(), /已取消排队，未调用图像接口/u);
  await page.getByRole('button', { name: '删除任务', exact: true }).click();
  qa.hold = false; qa.paused.splice(0).forEach((resolve) => resolve());
  await waitForTasks(page, 2, true);
  const tasks = (await read(page)).project.generationTasks;
  assert.equal(tasks.every((task) => task.status === 'succeeded'), true);
  assert.deepEqual(tasks.map((task) => task.batchIndex), [0, 2]);
  assert.equal(qa.requests.filter((request) => request.image).length, 2, 'cancelled/deleted second image never reaches the image API');
  assert.equal(qa.requests.filter((request) => !request.image).length, 1);
  return { generated: 2, cancelledThenDeleted: 1, converterRequests: 1 };
}

export async function imageBatchRestartQa(page) {
  const qa = runs.get(page);
  await count(page).selectOption('3');
  await generate(page).click();
  await eventually(() => qa.paused.length === 1);
  await waitForTasks(page, 3);
  const submitted = qa.requests.filter((request) => request.image).length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForTasks(page, 3, true);
  const tasks = (await read(page)).project.generationTasks;
  assert.equal(tasks.every((task) => task.status === 'failed' && /关闭|刷新|中断/u.test(task.error)), true);
  qa.hold = false; qa.paused.splice(0).forEach((resolve) => resolve());
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  assert.equal(qa.requests.filter((request) => request.image).length, submitted, 'restart never automatically resubmits queued or interrupted images');
  assert.match(await page.locator('body').innerText(), /应用关闭或刷新而中断/u);
  return { interrupted: 3, imageRequestsBefore: submitted, imageRequestsAfter: submitted, automaticResubmissions: 0 };
}
