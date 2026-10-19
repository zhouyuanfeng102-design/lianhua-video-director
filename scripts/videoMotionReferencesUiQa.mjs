import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';
import { installVideoAudioFixture } from './videoAudioReferencesUiQa.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `video-motion-reference-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
let browser; let page; const errors = []; const report = { passed: false, output, errors };
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push(error.message));
  const network = await installVideoAudioFixture(page, `http://127.0.0.1:${port}`);
  await page.evaluate(() => {
    const qa = window.__videoAudioQa;
    const settings = structuredClone(qa.settings);
    const workflow = settings.runningHubVideo.workflows[0];
    workflow.mapping.videos = [{ nodeId: '310', inputName: 'video' }];
    const template = JSON.parse(workflow.requestTemplate);
    template.nodeInfoList.push({ nodeId: '310', fieldName: 'video', fieldValue: '' });
    workflow.requestTemplate = JSON.stringify(template);
    qa.update({ settings, project: { ...qa.project, assets: [...qa.project.assets, {
      id: 'motion-clip', name: '合成动作参考', type: 'video', mediaType: 'video', mimeType: 'video/mp4',
      fileName: 'motion.mp4', dataUrl: 'data:video/mp4;base64,AAAA', durationSec: 5, tags: [], createdAt: 1, updatedAt: 1,
    }] } });
  });
  await page.getByLabel('本段动作视频 1', { exact: true }).selectOption('motion-clip');
  await page.getByLabel('本段动作视频 1 用途', { exact: true }).fill('参考三次出拳和两次扫腿的连续速度');
  const editor = page.getByLabel('本次生成使用的完整提示词', { exact: true });
  await editor.fill('甲连续出拳三次，乙格挡；甲低扫两次后脱开。');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__videoAudioQa.submissions.length === 1);
  const submitted = await page.evaluate(() => window.__videoAudioQa.submissions[0].draft);
  assert.equal(submitted.videoReferences[0].assetId, 'motion-clip');
  assert.match(submitted.prompt, /三次出拳和两次扫腿/);
  assert.match(submitted.prompt, /Video 1/);
  assert.equal((submitted.prompt.match(/Motion reference only/gu) || []).length, 1);
  await page.evaluate(() => window.__videoAudioQa.persist());
  await page.evaluate(() => window.__videoAudioQa.restore());
  assert.equal(await page.getByLabel('本段动作视频 1', { exact: true }).inputValue(), 'motion-clip');
  assert.equal(await page.getByLabel('本段动作视频 1 用途', { exact: true }).inputValue(), '参考三次出拳和两次扫腿的连续速度');
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
  const firstBatchSelect = page.getByLabel('第 1 段动作视频 1', { exact: true });
  await firstBatchSelect.evaluate((node) => { let parent = node.parentElement; while (parent) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; } });
  await firstBatchSelect.selectOption('motion-clip');
  await page.getByLabel('第 1 段动作视频 1 用途', { exact: true }).fill('只参考走路与接物的动作');
  await page.waitForFunction(() => window.__videoAudioQa.latestDraft?.batch?.videoOverrides?.['aq-segment-1']?.[0]?.notes === '只参考走路与接物的动作');
  const persisted = await page.evaluate(() => window.__videoAudioQa.persist());
  assert.equal(persisted.chapterDraft.batch.videoOverrides['aq-segment-1'][0].assetId, 'motion-clip');
  await page.evaluate(() => window.__videoAudioQa.restore());
  assert.equal(await page.getByLabel('第 1 段动作视频 1', { exact: true }).inputValue(), 'motion-clip');
  assert.equal(await page.getByRole('button', { name: /重排动作节奏|优化动作速度/ }).count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(network.blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'references.png') });
  Object.assign(report, { passed: true, submissions: 1, realRequests: 0, singleAndBatchPersistence: true });
} catch (error) {
  report.error = String(error);
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()); }
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser?.close(); await server.close();
}
