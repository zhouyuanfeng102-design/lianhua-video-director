import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { installTailReferenceFixture } from './videoTailReferenceUiQa.mjs';

// Run from a persistent Playwright Interactive session. No standalone browser
// launcher: callers own the session, and this fixture never saves user data.
export async function installTailChainFixture(page, baseUrl) {
  await installTailReferenceFixture(page, baseUrl);
  await page.evaluate(() => {
    window.__tailReferenceQa.mutateProject((project) => ({ ...project, assets: project.assets.filter((asset) => asset.mediaType === 'image'), generationTasks: [] }));
    document.querySelector('main').style.setProperty('--ui-font-scale', '1.3');
  });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
}

export async function runTailChainUiAssertions(page, outputDirectory) {
  if (outputDirectory) await fs.mkdir(outputDirectory, { recursive: true });
  const screenshots = []; const stages = [];
  const row = (index) => page.locator(`[data-segment-id="tail-qa-segment-${index}"]`);
  const dialog = () => page.getByRole('dialog');
  const capture = async (name) => {
    if (!outputDirectory) return;
    const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); screenshots.push(file);
  };
  const assertControls = async () => {
    const geometry = await dialog().evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const invisible = [...element.querySelectorAll('.vd-modal-header button,.vd-modal-footer button,.vd-modal-footer input,select,[role="tab"]')]
        .filter((control) => control.getClientRects().length).flatMap((control) => {
          const box = control.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return hit && (hit === control || control.contains(hit)) ? [] : [control.getAttribute('aria-label') || control.textContent];
        });
      return { fit: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, invisible };
    });
    assert.equal(geometry.fit, true); assert.equal(geometry.invisible.length, 0, JSON.stringify(geometry));
  };
  await page.getByRole('button', { name: '全选英文', exact: true }).click();
  assert.equal(await row(1).getByRole('button', { name: '第 1 段用上段尾帧', exact: true }).isDisabled(), true);
  await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
  assert.equal(await dialog().count(), 0);
  assert.match(await row(2).innerText(), /自动衔接：第 1 段 → 本地末帧/u);
  assert.equal(await page.evaluate(() => window.__tailReferenceQa.requests.length), 0, 'configuration does not call AI or extract nonexistent videos');
  stages.push('zero-video-one-click-ai-configuration-without-dialog');
  await row(1).getByRole('button', { name: '中文', exact: true }).click();
  await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).click();
  assert.equal(await dialog().count(), 0);
  await capture('one-click-bulk-auto');
  assert.equal(await page.locator('.vd-batch-row .vd-auto-tail-badge').count(), 2);
  await row(2).getByRole('button', { name: '第 2 段取消自动衔接', exact: true }).click();
  assert.equal(await row(2).locator('.vd-auto-tail-badge').count(), 0);
  await page.getByRole('button', { name: '已选后续段自动衔接', exact: true }).click();
  await row(2).getByLabel('选择第 2 段', { exact: true }).uncheck();
  assert.match(await row(3).innerText(), /同时选择第 2 段/u);
  assert.equal(await page.getByRole('button', { name: '检查并生成 2 段视频', exact: true }).isDisabled(), true);
  await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  stages.push('bulk-setup-clear-restore-current-language-and-no-gap-shortcut');
  await capture('configured-chain-list');
  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  assert.match(await dialog().innerText(), /第 1 段（中文稿）完成并保存/u);
  assert.match(await dialog().innerText(), /第 2 段（英文稿）完成并保存/u);
  assert.equal(await dialog().getByRole('button', { name: '确认生成 3 段', exact: true }).isDisabled(), true);
  await dialog().getByLabel('确认批量生成费用', { exact: true }).check();
  for (const viewport of [{ width: 1120, height: 720 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [1, 1.3, 1.5]) {
      await page.evaluate((value) => document.querySelector('main').style.setProperty('--ui-font-scale', String(value)), scale);
      await assertControls(); await capture(`final-batch-confirm-${viewport.width}x${viewport.height}-${scale}`);
    }
  }
  await dialog().getByRole('button', { name: '确认生成 3 段', exact: true }).click();
  await page.waitForFunction(() => window.__tailReferenceQa.submissions.length === 1);
  const result = await page.evaluate(() => ({ input: window.__tailReferenceQa.submissions[0], original: window.__tailReferenceQa.originalBoards,
    boards: JSON.stringify(window.__tailReferenceQa.project.storyboards), extractions: window.__tailReferenceQa.requests.length }));
  assert.equal(result.input.items.length, 3); assert.equal(result.input.items[0].previousTail, undefined);
  assert.equal(result.input.items[1].previousTail.predecessorItemKey, result.input.items[0].itemKey);
  assert.equal(result.input.items[2].previousTail.predecessorItemKey, result.input.items[1].itemKey);
  assert.equal(result.input.items.map((item) => item.draft.source.language).join(','), 'zh,en,en');
  for (const item of result.input.items.slice(1)) {
    assert.equal(item.previousTail.selectionMode, undefined); assert.equal(item.previousTail.requireAiSelection, undefined);
    assert.equal(item.previousTail.placement.mode, 'replace'); assert.equal(item.previousTail.placement.index, 0);
    assert.equal(item.previousTail.placement.role, 'general'); assert.equal(item.previousTail.placement.replacedAssetId, 'tail-qa-original-image');
  }
  assert.equal(result.original, result.boards); assert.equal(result.extractions, 0);
  stages.push('normal-clicks-submit-three-frozen-dependencies-without-original-mutation');
  return { stages, screenshots, items: result.input.items.length };
}
