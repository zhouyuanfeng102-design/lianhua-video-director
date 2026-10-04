import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertVideoReferencePickerStartsWithImages, installVideoReferenceUsageFixture, showVideoReferencePickerPane } from './videoReferenceUsageUiQa.mjs';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Real VideoDirectorView only: synthetic canvas assets, isolated React state,
// no production App/storage/desktop bridge, and a record-only mock controller.
// The inherited fixture aborts external and provider-shaped network requests.
export const stableSlotQaInventory = [
  '取消首张或中间图，其他图片的物理槽位和用途不变',
  '新图自动补最前空槽并继承该槽用途；多个空槽不按取消顺序重排',
  '空槽可保存并重新打开，后续补图仍回到原槽',
  '自定义用途及空槽用途跨保存、关闭和重开保留',
  '关闭未确认的选图器不改变生成草稿',
  '长剧情各段参考图独立，编辑一段不改变其他段',
  '图片选择和槽位用途独立分栏，切栏不改变已选图、空槽和用途',
  '本地末帧组合继续预留槽1，替换人物图不再次抽帧且不调用视觉AI',
  '组合选图保存空槽后不自动补回人物，再次启用组合也不压缩或失效',
  '静态本地末帧组合复制到下一段，首帧及后续空槽用途保持',
  'mock提交保留真实slotIndex，图片密集数组与物理槽号不混用',
  '原项目、H3提示词和设置不变，未尝试任何外部或付费请求',
];

const names = {
  'ruq-composition': '分镜构图原图', 'ruq-a': '甲人物参考', 'ruq-b': '乙人物参考',
  'ruq-c': '丙人物参考', 'ruq-scene': '普通场景照片', 'ruq-style': '普通风格照片',
  'ruq-a-alt': '甲人物另一张参考', 'ruq-local-frame': '本地真实最后一帧',
};
const originalSlots = {
  'ruq-composition': '构图1（槽1）', 'ruq-a': '人物1（槽2）',
  'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）',
};
const reference = (assetId, slotIndex, role = slotIndex === 0 ? 'composition' : 'character') => ({ assetId, slotIndex, role });
const originals = Object.keys(originalSlots).map((assetId, index) => reference(assetId, index));

function assertDraftSlots(draft, expected, context) {
  assert.ok(Array.isArray(draft.references) && draft.references.every((entry) => entry && typeof entry.assetId === 'string' && entry.assetId), `${context}: references stay a dense array of actual images`);
  const actual = draft.references.map((entry, index) => ({ assetId: entry.assetId, role: entry.role, slotIndex: entry.slotIndex ?? index })).sort((left, right) => left.slotIndex - right.slotIndex);
  assert.equal(new Set(actual.map((entry) => entry.slotIndex)).size, actual.length, `${context}: no two images occupy the same physical slot`);
  assert.deepEqual(actual, expected, `${context}: submission must retain image identity, purpose and physical slot`);
}

export async function runVideoReferenceStableSlotsUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  const row = (index) => page.locator(`[data-segment-id="ruq-segment-${index}"]`);
  const section = () => page.locator('.vd-reference-card');
  const showList = async () => { const tab = page.getByRole('tab', { name: '分段清单', exact: true }); if (await tab.isVisible()) await tab.click(); };
  const reset = async (options = {}) => {
    await page.evaluate((value) => window.__videoReferenceUsageQa.reset(value), options);
    if (options.single) await section().locator('.vd-reference-row').first().waitFor();
    else { await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); await showList(); }
  };
  const picker = async (index) => {
    if (index) { await showList(); await row(index).getByRole('button', { name: `第 ${index} 段选择参考图`, exact: true }).click(); }
    else await section().getByRole('button', { name: '从图片资产库选择', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: index ? `第 ${index} 段 · 选择参考图` : '从图片资产库选择生成参考图', exact: true });
    await dialog.waitFor(); await assertVideoReferencePickerStartsWithImages(dialog); return dialog;
  };
  const selected = (dialog, id) => dialog.getByRole('button', { name: `取消选择图片 ${names[id]}`, exact: true });
  const remove = async (dialog, id) => selected(dialog, id).click();
  const add = async (dialog, id) => dialog.getByRole('button', { name: `选择图片 ${names[id]}`, exact: true }).click();
  const close = async (dialog) => { await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
  const apply = async (dialog, batch = false) => { await dialog.getByRole('button', { name: batch ? '使用本段图片' : '使用所选图片', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
  const assertSlots = async (dialog, expected, context) => {
    assert.equal(await dialog.locator('.vd-image-pick[aria-pressed="true"]').count(), Object.keys(expected).length, `${context}: exact selected image count, no hidden replacement`);
    for (const [id, label] of Object.entries(expected)) {
      const actual = await selected(dialog, id).locator('.vd-image-slot-badge').innerText();
      assert.equal(actual.split(' · ')[0], label, `${context}: ${names[id]} keeps its slot and purpose`);
    }
  };
  const capture = async (name) => { if (!outputDirectory) return; const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file); };
  const integrity = async (expectedExtractions = 0) => assert.deepEqual(await page.evaluate(() => {
    const qa = window.__videoReferenceUsageQa;
    const project = { ...qa.project, assets: qa.project.assets.filter((asset) => !qa.generatedFrameIds.includes(asset.id)) };
    return { project: JSON.stringify(project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls };
  }), { project: true, settings: true, aiCalls: 0, extractionCalls: expectedExtractions }, 'selection edits never alter source project, H3 or settings');
  const submissions = () => page.evaluate(() => window.__videoReferenceUsageQa.submissions.length);
  const submitSingle = async () => {
    const before = await submissions(); await page.getByRole('button', { name: '生成视频', exact: true }).click();
    await page.waitForFunction((count) => window.__videoReferenceUsageQa.submissions.length === count, before + 1);
    const result = await page.evaluate(() => window.__videoReferenceUsageQa.submissions.at(-1));
    assert.equal(result.kind, 'single'); return result.draft;
  };
  const submitBatch = async (total) => {
    const before = await submissions(); await showList();
    const button = page.getByRole('button', { name: `检查并生成 ${total} 段视频`, exact: true });
    assert.equal(await button.isEnabled(), true, 'stable slots must not disable an otherwise valid batch'); await button.click();
    const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true }); await dialog.waitFor();
    assert.equal(await submissions(), before, 'opening confirmation does not submit a video');
    const confirm = dialog.getByRole('button', { name: `确认生成 ${total} 段`, exact: true }); assert.equal(await confirm.isDisabled(), true);
    await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await confirm.click();
    await page.waitForFunction((count) => window.__videoReferenceUsageQa.submissions.length === count, before + 1);
    return page.evaluate(() => window.__videoReferenceUsageQa.submissions.at(-1).input);
  };
  const chooseBatch = async (...indices) => { await showList(); for (const index of indices) await row(index).getByLabel(`选择第 ${index} 段`, { exact: true }).check(); };

  for (const source of ['runninghub', 'comfyui']) {
    await reset({ source, single: true }); let dialog = await picker();
    await assertSlots(dialog, originalSlots, `${source}/original`);
    await remove(dialog, 'ruq-composition');
    await assertSlots(dialog, { 'ruq-a': originalSlots['ruq-a'], 'ruq-b': originalSlots['ruq-b'], 'ruq-c': originalSlots['ruq-c'] }, `${source}/remove-first`);
    await add(dialog, 'ruq-scene');
    const replacedFirst = { ...originalSlots }; delete replacedFirst['ruq-composition']; replacedFirst['ruq-scene'] = '构图1（槽1）';
    await assertSlots(dialog, replacedFirst, `${source}/replace-first`); await close(dialog);
    dialog = await picker(); await assertSlots(dialog, originalSlots, `${source}/cancel-discards-edits`);
    await remove(dialog, 'ruq-composition'); await add(dialog, 'ruq-scene'); await apply(dialog);
    dialog = await picker(); await assertSlots(dialog, replacedFirst, `${source}/apply-reopen`);
    await remove(dialog, 'ruq-a');
    await assertSlots(dialog, { 'ruq-scene': '构图1（槽1）', 'ruq-b': originalSlots['ruq-b'], 'ruq-c': originalSlots['ruq-c'] }, `${source}/remove-middle`);
    await add(dialog, 'ruq-a-alt');
    const replacedMiddle = { 'ruq-scene': '构图1（槽1）', 'ruq-a-alt': '人物1（槽2）', 'ruq-b': originalSlots['ruq-b'], 'ruq-c': originalSlots['ruq-c'] };
    await assertSlots(dialog, replacedMiddle, `${source}/replace-middle`); await apply(dialog);
    assertDraftSlots(await submitSingle(), [reference('ruq-scene', 0), reference('ruq-a-alt', 1), reference('ruq-b', 2), reference('ruq-c', 3)], `${source}/replacement-submission`);

    dialog = await picker(); await remove(dialog, 'ruq-b'); await apply(dialog);
    dialog = await picker();
    await assertSlots(dialog, { 'ruq-scene': '构图1（槽1）', 'ruq-a-alt': '人物1（槽2）', 'ruq-c': '人物3（槽4）' }, `${source}/saved-middle-gap`);
    await close(dialog);
    assertDraftSlots(await submitSingle(), [reference('ruq-scene', 0), reference('ruq-a-alt', 1), reference('ruq-c', 3)], `${source}/gap-submission`);
    dialog = await picker(); await add(dialog, 'ruq-b'); await assertSlots(dialog, replacedMiddle, `${source}/refill-persisted-gap`);

    // Remove in reverse order: vacancy allocation must use slot order, not
    // click order, asset library order, or the compact references array index.
    await remove(dialog, 'ruq-c'); await remove(dialog, 'ruq-scene');
    await assertSlots(dialog, { 'ruq-a-alt': '人物1（槽2）', 'ruq-b': '人物2（槽3）' }, `${source}/two-vacancies`);
    await add(dialog, 'ruq-composition');
    await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-a-alt': '人物1（槽2）', 'ruq-b': '人物2（槽3）' }, `${source}/lowest-vacancy-first`);
    await add(dialog, 'ruq-style');
    await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-a-alt': '人物1（槽2）', 'ruq-b': '人物2（槽3）', 'ruq-style': '人物3（槽4）' }, `${source}/second-vacancy-inherits-purpose`);
    await capture(`${source}-multiple-vacancies-refilled`); await apply(dialog);
    const finalDraft = await submitSingle();
    assertDraftSlots(finalDraft, [reference('ruq-composition', 0), reference('ruq-a-alt', 1), reference('ruq-b', 2), reference('ruq-style', 3)], `${source}/multi-vacancy-submission`);
    assert.equal(finalDraft.prompt, await page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].officialPromptZh), 'UI-only selection never rewrites source H3');
    await integrity(); stages.push(`${source}: single first/middle replacement, cancel, persistent gap, multiple holes and mock submission`);
  }

  await reset({ source: 'api', single: true });
  let dialog = await picker(); await showVideoReferencePickerPane(dialog, '槽位用途'); await dialog.getByLabel('本段图片槽 2 用途', { exact: true }).selectOption('prop'); await showVideoReferencePickerPane(dialog, '图片选择'); await remove(dialog, 'ruq-a'); await apply(dialog);
  dialog = await picker();
  await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-b': '人物1（槽3）', 'ruq-c': '人物2（槽4）' }, 'single-custom-purpose/persisted-gap');
  await add(dialog, 'ruq-scene');
  await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-scene': '道具1（槽2）', 'ruq-b': '人物1（槽3）', 'ruq-c': '人物2（槽4）' }, 'single-custom-purpose/refill');
  await apply(dialog);
  const customSingle = await submitSingle();
  assertDraftSlots(customSingle, [reference('ruq-composition', 0, 'composition'), reference('ruq-scene', 1, 'prop'), reference('ruq-b', 2), reference('ruq-c', 3)], 'single-custom-purpose/submission');
  await integrity(); stages.push('single: manually chosen purpose survives a saved vacancy and is inherited by a different-category replacement');

  for (const source of ['runninghub', 'comfyui']) {
    await reset({ source }); await chooseBatch(1, 2);
    dialog = await picker(1); await remove(dialog, 'ruq-composition');
    await assertSlots(dialog, { 'ruq-a': originalSlots['ruq-a'], 'ruq-b': originalSlots['ruq-b'], 'ruq-c': originalSlots['ruq-c'] }, `${source}/batch-remove-first`);
    await add(dialog, 'ruq-scene'); await close(dialog);
    dialog = await picker(1); await assertSlots(dialog, originalSlots, `${source}/batch-cancel-discards-edits`);
    await remove(dialog, 'ruq-composition'); await add(dialog, 'ruq-scene'); await apply(dialog, true);
    dialog = await picker(2); await assertSlots(dialog, originalSlots, `${source}/batch-row-2-unaffected`);
    await remove(dialog, 'ruq-b'); await apply(dialog, true);
    dialog = await picker(2);
    await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-a': '人物1（槽2）', 'ruq-c': '人物3（槽4）' }, `${source}/batch-persisted-gap`);
    await close(dialog);
    const withGap = await submitBatch(2);
    assertDraftSlots(withGap.items.find((item) => item.draft.source.segmentIndex === 1).draft, [reference('ruq-scene', 0), ...originals.slice(1)], `${source}/batch-row-1-submission`);
    assertDraftSlots(withGap.items.find((item) => item.draft.source.segmentIndex === 2).draft, [originals[0], originals[1], originals[3]], `${source}/batch-gap-submission`);
    dialog = await picker(2); await add(dialog, 'ruq-style');
    await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-a': '人物1（槽2）', 'ruq-style': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, `${source}/batch-replace-middle`);
    await capture(`${source}-batch-middle-replaced`); await apply(dialog, true);
    dialog = await picker(1); await assertSlots(dialog, { 'ruq-scene': '构图1（槽1）', 'ruq-a': '人物1（槽2）', 'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, `${source}/batch-row-1-still-unchanged`); await close(dialog);
    dialog = await picker(3); await assertSlots(dialog, originalSlots, `${source}/batch-row-3-unaffected`); await close(dialog);
    const replaced = await submitBatch(2);
    assertDraftSlots(replaced.items.find((item) => item.draft.source.segmentIndex === 2).draft, [originals[0], originals[1], reference('ruq-style', 2), originals[3]], `${source}/batch-replaced-submission`);
    await integrity(); stages.push(`${source}: independent batch rows, cancelled edits, saved hole and stable submitted slots`);
  }

  await reset({ source: 'api' }); await chooseBatch(1);
  dialog = await picker(1);
  await showVideoReferencePickerPane(dialog, '槽位用途');
  await dialog.getByLabel('第 1 段图片槽 2 用途', { exact: true }).selectOption('prop');
  await showVideoReferencePickerPane(dialog, '图片选择');
  await remove(dialog, 'ruq-a'); await apply(dialog, true);
  dialog = await picker(1); await add(dialog, 'ruq-scene');
  await assertSlots(dialog, { 'ruq-composition': '构图1（槽1）', 'ruq-scene': '道具1（槽2）', 'ruq-b': '人物1（槽3）', 'ruq-c': '人物2（槽4）' }, 'batch-custom-purpose/refill-after-reopen');
  await apply(dialog, true);
  const customBatch = await submitBatch(1);
  assertDraftSlots(customBatch.items[0].draft, [reference('ruq-composition', 0, 'composition'), reference('ruq-scene', 1, 'prop'), reference('ruq-b', 2), reference('ruq-c', 3)], 'batch-custom-purpose/submission');
  await integrity(); stages.push('batch: custom purpose survives apply/reopen and transfers only to the replacement image');

  await reset(); await chooseBatch(1, 2);
  await row(2).getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
  dialog = await picker(2); await remove(dialog, 'ruq-a');
  await assertSlots(dialog, { 'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, 'automatic-tail/remove-identity');
  await add(dialog, 'ruq-a-alt');
  await assertSlots(dialog, { 'ruq-a-alt': '人物1（槽2）', 'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, 'automatic-tail/refill-reserved-offset');
  await apply(dialog, true);
  assert.equal(await row(2).getByRole('button', { name: '第 2 段取消尾帧加参考图', exact: true }).count(), 1, 'selection changes must retain local-tail composite mode');
  const chain = await submitBatch(2); const successor = chain.items.find((item) => item.draft.source.segmentIndex === 2);
  assert.equal(successor.previousTail.placement.mode, 'prepend'); assert.equal(successor.previousTail.placement.index, 0);
  assert.equal(successor.previousTail.requireAiSelection, undefined); assert.equal(successor.previousTail.selectionMode, undefined);
  // The automatic frame is not present yet: references use local identity
  // slots 0..2, then the existing prepend operation supplies physical slot 0.
  assertDraftSlots(successor.draft, [reference('ruq-a-alt', 0, 'character'), reference('ruq-b', 1), reference('ruq-c', 2)], 'automatic-tail/identity-submission');
  assert.match(successor.draft.prompt, /<Subject 1> is 甲人物 referenced from <Picture 2>/u);
  assert.match(successor.draft.prompt, /<Subject 2> is 乙人物 referenced from <Picture 3>/u);
  assert.match(successor.draft.prompt, /<Subject 3> is 丙人物 referenced from <Picture 4>/u);
  await integrity(); stages.push('Local tail combination: slot 1 reserved, identity substitution stays in slot 2, no visual AI request during selection');

  dialog = await picker(2); await remove(dialog, 'ruq-b'); await apply(dialog, true);
  dialog = await picker(2);
  const sparseIdentitySlots = { 'ruq-a-alt': '人物1（槽2）', 'ruq-c': '人物3（槽4）' };
  await assertSlots(dialog, sparseIdentitySlots, 'automatic-tail/persisted-character-gap');
  await capture('automatic-tail-persisted-character-gap'); await close(dialog);
  const sparseChain = await submitBatch(2); const sparseSuccessor = sparseChain.items.find((item) => item.draft.source.segmentIndex === 2);
  assertDraftSlots(sparseSuccessor.draft, [reference('ruq-a-alt', 0, 'character'), reference('ruq-c', 2)], 'automatic-tail/sparse-submission');
  assert.equal(sparseSuccessor.previousTail.placement.mode, 'prepend');
  assert.match(sparseSuccessor.draft.prompt, /<Subject 2> is 乙人物/u, 'removing its photo does not delete the authored character');
  assert.match(sparseSuccessor.draft.prompt, /<Subject 3> is 丙人物 referenced from <Picture 4>/u, 'later character retains its physical picture binding across the hole');
  await row(2).getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
  dialog = await picker(2);
  await assertSlots(dialog, sparseIdentitySlots, 'automatic-tail/reapply-composite-keeps-gap'); await close(dialog);
  const restartedChain = await submitBatch(2); const restartedSuccessor = restartedChain.items.find((item) => item.draft.source.segmentIndex === 2);
  assertDraftSlots(restartedSuccessor.draft, [reference('ruq-a-alt', 0, 'character'), reference('ruq-c', 2)], 'automatic-tail/reapplied-sparse-submission');
  assert.equal(restartedSuccessor.draft.prompt, sparseSuccessor.draft.prompt, 'reapplying the same composite is idempotent, not a stale-source or rebind operation');
  dialog = await picker(2); await add(dialog, 'ruq-b');
  await assertSlots(dialog, { 'ruq-a-alt': '人物1（槽2）', 'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, 'automatic-tail/refill-after-sparse-reapply');
  await apply(dialog, true);
  const refilledChain = await submitBatch(2); const refilledSuccessor = refilledChain.items.find((item) => item.draft.source.segmentIndex === 2);
  assertDraftSlots(refilledSuccessor.draft, [reference('ruq-a-alt', 0, 'character'), reference('ruq-b', 1), reference('ruq-c', 2)], 'automatic-tail/refilled-submission');
  assert.match(refilledSuccessor.draft.prompt, /<Subject 2> is 乙人物 referenced from <Picture 3>/u);
  await integrity(); stages.push('Local tail sparse combination: save/remove/reopen, reapply without auto-add or compaction, then refill original identity slot');

  // The fixture supplies a synthetic previous video and a record-only local
  // extractor. One mock extraction creates an in-memory frame; no media/API
  // engine or real file is involved. Copying this static selection needs no
  // second selection and must retain both slot 0 and the later vacancy.
  await reset({ withVideo: true }); await chooseBatch(2, 3);
  await row(2).getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
  await page.waitForFunction(() => window.__videoReferenceUsageQa.extractionCalls === 1 && window.__videoReferenceUsageQa.project.assets.some((asset) => asset.id === 'ruq-local-frame'));
  await row(2).getByRole('button', { name: '第 2 段取消尾帧加参考图', exact: true }).waitFor();
  dialog = await picker(2); await remove(dialog, 'ruq-b'); await apply(dialog, true);
  dialog = await picker(2);
  await assertSlots(dialog, { 'ruq-a': '人物1（槽2）', 'ruq-c': '人物3（槽4）' }, 'static-tail/persisted-character-gap'); await close(dialog);
  await row(3).getByRole('button', { name: '第 3 段复制上一段参考图', exact: true }).click();
  dialog = await picker(3);
  await assertSlots(dialog, { 'ruq-local-frame': '首帧（槽1）', 'ruq-a': '人物1（槽2）', 'ruq-c': '人物3（槽4）' }, 'static-tail/copied-frame-and-gap');
  await capture('static-tail-copied-frame-and-character-gap'); await close(dialog);
  const staticGapBatch = await submitBatch(2);
  for (const segmentIndex of [2, 3]) {
    const item = staticGapBatch.items.find((entry) => entry.draft.source.segmentIndex === segmentIndex);
    assertDraftSlots(item.draft, [reference('ruq-local-frame', 0, 'first-frame'), reference('ruq-a', 1), reference('ruq-c', 3)], `static-tail/copied-gap-segment-${segmentIndex}`);
    assert.equal(item.previousTail, undefined, 'copying an already selected static frame does not create a new tail dependency');
  }
  dialog = await picker(3); await add(dialog, 'ruq-b');
  await assertSlots(dialog, { 'ruq-local-frame': '首帧（槽1）', 'ruq-a': '人物1（槽2）', 'ruq-b': '人物2（槽3）', 'ruq-c': '人物3（槽4）' }, 'static-tail/copied-vacancy-refill'); await apply(dialog, true);
  dialog = await picker(2); await assertSlots(dialog, { 'ruq-a': '人物1（槽2）', 'ruq-c': '人物3（槽4）' }, 'static-tail/source-gap-not-mutated-by-copy'); await close(dialog);
  const staticRefilledBatch = await submitBatch(2);
  assertDraftSlots(staticRefilledBatch.items.find((item) => item.draft.source.segmentIndex === 3).draft, [reference('ruq-local-frame', 0, 'first-frame'), reference('ruq-a', 1), reference('ruq-b', 2), reference('ruq-c', 3)], 'static-tail/copied-refill-submission');
  await integrity(1); stages.push('Static local tail: copy keeps frame slot 0 and sparse identity slots; refill inherits copied vacancy purpose without another extraction');
  return { passed: true, inventory: stableSlotQaInventory, stages, screenshots };
}

export async function runStandaloneVideoReferenceStableSlotsUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `video-reference-stable-slots-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain within output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output must not traverse a symlink'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  const port = await findAvailableTcpPort();
  const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
  let browser; let page; const errors = []; let blockedRequests = [];
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(25_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${port}`, { fontScale: 1 }));
    const report = await runVideoReferenceStableSlotsUiAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'not even an attempted external or paid API request');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, outputDirectory, errors, blockedRequests }, null, 2));
    return { ...report, outputDirectory };
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), errors, blockedRequests }, null, 2));
    if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoReferenceStableSlotsUiQa(), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
