import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { installTailReferenceFixture } from './videoTailReferenceUiQa.mjs';

// Caller-owned Playwright session. Only isolated component state and captured
// submissions: there is no real generation endpoint or project persistence.
export async function installRegenerationFixture(page, baseUrl, completed = true) {
  await installTailReferenceFixture(page, baseUrl);
  await page.evaluate(async (withCompleted) => {
    const qa = window.__tailReferenceQa;
    const { buildVideoBatchRows } = await import('/src/videoBatch.ts');
    const rows = buildVideoBatchRows(qa.project, qa.project.sequencePlans[0], qa.settings, {
      backend: 'comfyui', workflowId: 'tail-qa-workflow', parameters: {},
    });
    qa.mutateProject((project) => ({ ...project, generationTasks: withCompleted ? rows.map((row) => ({
      id: `completed-${row.segmentIndex}`, kind: 'video', status: 'succeeded', resultAssetId: `old-result-${row.segmentIndex}`,
      requestFingerprint: row.zh.requestFingerprint, storyboardId: row.storyboardId, sequencePlanId: row.sequencePlanId,
      segmentId: row.segmentId, segmentIndex: row.segmentIndex, targetId: 'qa', requestBody: {}, remoteTaskId: `remote-old-${row.segmentIndex}`,
      videoJob: { stage: 'preparing', snapshot: { projectId: project.id, draft: row.zh.draft, clientId: `old-client-${row.segmentIndex}`,
        connection: { backend: 'comfyui', comfyui: { enabled: true, baseUrl: qa.settings.comfyuiVideo.baseUrl }, workflow: qa.settings.comfyuiVideo.workflows[0] }, images: [] },
        preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] } }, createdAt: Date.now(), updatedAt: Date.now(),
    })) : [] }));
    document.querySelector('main').style.setProperty('--ui-font-scale', '1.3');
  }, completed);
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
}

export async function assertRegenerationUi(page, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const toggle = page.getByLabel('重新生成已成功项', { exact: true });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '检查并生成 0 段视频', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '允许重新生成已完成项', exact: true }).click();
  assert.equal(await toggle.isChecked(), true);
  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  assert.equal(await dialog.getByRole('button', { name: '确认生成 3 段', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(outputDirectory, 'regenerate-three-confirm.png'), scale: 'css' });
  await page.getByLabel('确认批量生成费用', { exact: true }).check();
  await dialog.getByRole('button', { name: '确认生成 3 段', exact: true }).click();
  await page.waitForFunction(() => window.__tailReferenceQa.submissions.length === 1);
  const input = await page.evaluate(() => window.__tailReferenceQa.submissions[0]);
  assert.equal(input.items.length, 3); assert.ok(input.items.every((item) => item.force === true));
  await toggle.uncheck();
  assert.equal(await page.getByRole('button', { name: '检查并生成 0 段视频', exact: true }).isDisabled(), true);
  return { submitted: input.items.length, forceEverySelectedItem: true, defaultSkipAndFeeConfirmation: true };
}

export async function assertDirectTailReplacementUi(page, outputDirectory) {
  const row = (number) => page.locator(`[data-segment-id="tail-qa-segment-${number}"]`);
  await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await row(2).innerText(), /自动衔接：第 1 段 → AI 辅助选帧/u);
  await page.screenshot({ path: path.join(outputDirectory, 'existing-reference-one-click-replace.png'), scale: 'css' });
  await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('.vd-batch-row .vd-auto-tail-badge').count(), 2);
  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  await page.getByLabel('确认批量生成费用', { exact: true }).check();
  await page.getByRole('button', { name: '确认生成 3 段', exact: true }).click();
  await page.waitForFunction(() => window.__tailReferenceQa.submissions.length === 1);
  const result = await page.evaluate(() => ({ input: window.__tailReferenceQa.submissions[0], original: window.__tailReferenceQa.originalBoards,
    current: JSON.stringify(window.__tailReferenceQa.project.storyboards), originalAsset: window.__tailReferenceQa.project.assets.some((asset) => asset.id === 'tail-qa-original-image') }));
  assert.equal(result.input.items.length, 3);
  for (const item of result.input.items.slice(1)) {
    assert.equal(item.previousTail.selectionMode, 'ai-assisted'); assert.equal(item.previousTail.requireAiSelection, true);
    assert.equal(item.previousTail.placement.mode, 'replace'); assert.equal(item.previousTail.placement.index, 0);
    assert.equal(item.previousTail.placement.replacedAssetId, 'tail-qa-original-image');
    assert.equal(item.draft.references.length, 1, 'user does not need to clear the existing selected image');
  }
  assert.equal(result.current, result.original); assert.equal(result.originalAsset, true);
  return { directSingleSlotReplacement: true, bulkReplacement: true, oldImagesAndStoryboardsUnchanged: true };
}

// Regression for the actual reported case: several storyboard references were
// inherited but the chosen Comfy workflow / first_image API has only one input.
export async function installMultiReferenceTailFixture(page, baseUrl, { backend = 'comfyui', slotRole = 'general' } = {}) {
  await installRegenerationFixture(page, baseUrl, false);
  await page.evaluate(({ backend, slotRole }) => {
    const qa = window.__tailReferenceQa;
    const original = qa.project.assets.find((asset) => asset.id === 'tail-qa-original-image');
    qa.mutateProject((project) => {
      const sourceRole = backend === 'api' ? 'first-frame' : slotRole;
      const extra = ['character', 'scene'].map((role) => ({ ...original, id: `tail-qa-extra-${role}`,
        name: role === 'character' ? '额外人物参考图' : '额外分镜场景图', role, referenceRole: role }));
      const ids = [original.id, ...extra.map((asset) => asset.id)];
      return { ...project, generationTasks: [], assets: [
        ...project.assets.map((asset) => asset.id === original.id ? { ...asset, role: sourceRole, referenceRole: sourceRole } : asset), ...extra,
      ], storyboards: project.storyboards.map((board, index) => !index ? board : { ...board, globalReferenceAssetIds: ids,
        promptTrace: { ...board.promptTrace, referenceAssetIds: ids }, shots: board.shots.map((shot) => ({ ...shot, referenceAssetIds: ids })) }) };
    });
    qa.mutateSettings((settings) => {
      settings.videoBackend = backend;
      settings.comfyuiVideo.workflows[0].mapping.images[0].role = slotRole;
      settings.videoTaskApi = { ...settings.videoTaskApi, enabled: true, provider: 'generic', endpoint: `${location.origin}/unused-video-api`,
        requestTemplate: JSON.stringify({ prompt: '{{prompt}}', image_url: '{{first_image}}' }) };
      return settings;
    });
  }, { backend, slotRole });
  await page.getByLabel('批量生成方式', { exact: true }).selectOption(backend);
  await page.waitForFunction(() => window.__tailReferenceQa.project.storyboards[1].globalReferenceAssetIds.length === 3);
  await page.evaluate(() => { const qa = window.__tailReferenceQa;
    qa.multiOriginalBoards = JSON.stringify(qa.project.storyboards); qa.multiOriginalAssets = JSON.stringify(qa.project.assets); });
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
}

export async function assertMultiReferenceTailReplacementUi(page, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const row = (number) => page.locator(`[data-segment-id="tail-qa-segment-${number}"]`);
  assert.match(await row(2).innerText(), /参考图 3 张/u);
  await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await row(2).innerText(), /最终参考图 1 张/u);
  assert.equal(await row(2).locator('.vd-error').count(), 0);
  await page.screenshot({ path: path.join(outputDirectory, 'three-references-one-click-replace.png'), scale: 'css' });
  await row(2).getByRole('button', { name: '第 2 段取消自动衔接', exact: true }).click();
  assert.match(await row(2).innerText(), /参考图 3 张/u);
  await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  for (const number of [2, 3]) assert.match(await row(number).innerText(), /最终参考图 1 张/u);
  await page.screenshot({ path: path.join(outputDirectory, 'three-references-bulk-replace.png'), scale: 'css' });
  await row(3).getByRole('button', { name: '英文', exact: true }).click();
  assert.match(await row(3).innerText(), /最终参考图 1 张/u);
  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  assert.match(await confirm.innerText(), /本段全部 3 张参考图替换为 1 张上段衔接帧/u);
  await confirm.getByLabel('确认批量生成费用', { exact: true }).check();
  await confirm.getByRole('button', { name: '确认生成 3 段', exact: true }).click();
  await page.waitForFunction(() => window.__tailReferenceQa.submissions.length === 1);
  const result = await page.evaluate(() => { const qa = window.__tailReferenceQa; return {
    input: qa.submissions[0], oldBoards: qa.multiOriginalBoards, boards: JSON.stringify(qa.project.storyboards),
    oldAssets: qa.multiOriginalAssets, assets: JSON.stringify(qa.project.assets), extractions: qa.requests.length,
  }; });
  assert.equal(result.input.items.length, 3); assert.equal(result.input.items[0].previousTail, undefined);
  for (const item of result.input.items.slice(1)) {
    assert.equal(item.previousTail.selectionMode, 'ai-assisted'); assert.equal(item.previousTail.requireAiSelection, true);
    assert.equal(item.previousTail.placement.mode, 'replace-all'); assert.equal(item.previousTail.placement.index, 0);
    assert.deepEqual(item.previousTail.placement.replacedReferences, item.draft.references);
    assert.equal(item.draft.references.length, 3, 'configured UI selection remains intact for cancel/review; the engine projects final refs');
  }
  assert.equal(result.input.items[2].draft.source.language, 'en');
  assert.equal(result.oldBoards, result.boards); assert.equal(result.oldAssets, result.assets);
  assert.equal(result.extractions, 0, 'auto configuration does not consume a historical tail or fabricate pixels');
  return { multipleReferencesDirectReplace: true, cancelRestoresSelection: true, bulkReplace: true, bilingualSelection: true, originalsUnchanged: true };
}
