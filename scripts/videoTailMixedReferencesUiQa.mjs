import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installTailCharactersFixture } from './videoTailCharactersUiQa.mjs';

// Mount the real director against an in-memory fixture, never App or user data.
// Native media work and paid submissions stay mocked; the reused fixture aborts
// every external, text, video and vision endpoint before a request can leave.
export async function runTailMixedReferencesUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = []; const layouts = [];
  const row = (index) => page.locator(`[data-segment-id="tcq-segment-${index}"]`);
  const composite = (index) => row(index).getByRole('button', { name: `第 ${index} 段本地末帧加参考图`, exact: true });
  const showList = async () => {
    const control = page.getByRole('tab', { name: '分段清单', exact: true });
    if (await control.isVisible()) await control.click();
  };
  const capture = async (name) => {
    const file = path.join(outputDirectory, `${name}.png`);
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file);
  };
  const inspectLayout = async (locator, stage, viewport) => {
    const layout = await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        left: box.left, right: box.right, width: box.width, contentWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${stage}: no document horizontal overflow`);
    assert.ok(layout.left >= -1 && layout.right <= layout.viewportWidth + 1, `${stage}: panel remains in the viewport`);
    assert.ok(layout.contentWidth <= layout.clientWidth + 1, `${stage}: no panel horizontal overflow`);
    layouts.push({ stage, viewport, ...layout });
  };
  const openPicker = async (index) => {
    await showList(); await row(index).getByRole('button', { name: `第 ${index} 段选择参考图`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `第 ${index} 段 · 选择参考图`, exact: true });
    await dialog.waitFor(); return dialog;
  };
  const applyPicker = async (dialog) => {
    await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const preview = async (index, pane) => {
    await showList(); await row(index).getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('tab', { name: pane, exact: true }).click();
    return pane === '完整提示词' ? page.locator('.vd-batch-preview .vd-prompt-preview').innerText()
      : page.locator('.vd-batch-reference-preview > div').allInnerTexts();
  };
  const submissionCounts = () => page.evaluate(() => ({ submit: window.__tailCharactersQa.submissions.length,
    visual: window.__tailCharactersQa.visualCalls, extract: window.__tailCharactersQa.rawExtracts }));
  const actualWorkflowBindings = (input) => page.evaluate(async (batch) => {
    const { resolveConfiguredVideoApi } = await import('/src/runningHubVideo.ts');
    const { buildVideoApiBody } = await import('/src/videoGenerationApi.ts');
    const { bindComfyVideoWorkflow } = await import('/src/comfyuiVideo.ts');
    const { videoBatchTailReferences } = await import('/src/videoBatch.ts');
    const item = batch.items[1]; const draft = structuredClone(item.draft);
    draft.references = videoBatchTailReferences(draft.references, item.previousTail.placement, 'mock-only-mixed-tail');
    const uploads = draft.references.map((reference) => `fixture-only/${reference.assetId}.png`);
    if (draft.backend === 'api') {
      const api = resolveConfiguredVideoApi(window.__tailCharactersQa.settings, draft);
      const request = buildVideoApiBody(api, draft, uploads);
      return { references: draft.references, prompt: request.nodeInfoList[0].fieldValue,
        bindings: request.nodeInfoList.slice(1).map((node) => ({ nodeId: node.nodeId, value: node.fieldValue })) };
    }
    const workflow = window.__tailCharactersQa.settings.comfyuiVideo.workflows.find((entry) => entry.id === draft.workflowId);
    const nodes = bindComfyVideoWorkflow(workflow, draft.prompt, uploads, draft.parameters, draft.references);
    return { references: draft.references, prompt: nodes['1'].inputs.text,
      bindings: workflow.mapping.images.map((binding) => ({ nodeId: binding.nodeId, value: nodes[binding.nodeId].inputs[binding.inputName] })) };
  }, input);

  for (const source of ['runninghub', 'comfyui']) {
    for (const viewport of [{ width: 1120, height: 760 }, { width: 1280, height: 800 }]) {
      const scenario = `${source}-${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport);
      await page.evaluate((kind) => window.__tailCharactersQa.reset({ source: kind, slots: 5, firstRole: 'first-frame',
        withoutVideos: true, staleImageDefaults: true }), source);
      await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
      assert.equal(await page.getByLabel('批量生成方式', { exact: true }).inputValue(), source);
      await page.getByRole('button', { name: '全选中文', exact: true }).click();
      await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0, 'mode setup never opens extra windows');
      assert.deepEqual(await submissionCounts(), { submit: 0, visual: 0, extract: 0 });
      assert.equal(await composite(2).getAttribute('aria-pressed'), 'true');

      const dialog = await openPicker(2);
      assert.equal(await dialog.getByRole('tab', { name: '图片选择', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await dialog.getByRole('button', { name: '取消选择图片 甲人物已选参考', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await dialog.getByRole('button', { name: '取消选择图片 乙人物普通主图', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await dialog.getByRole('button', { name: '选择图片 无关场景图', exact: true }).isDisabled(), false);
      assert.equal(await dialog.getByRole('combobox').count(), 0, 'image gallery has no duplicate purpose controls');
      assert.match(await dialog.innerText(), /默认.*人物[\s\S]*(?:场景|其它)/u);
      // Free the first identity slot, retain the second one, and fill that same
      // vacancy with a scene. The existing character must never be renumbered.
      await dialog.getByRole('button', { name: '取消选择图片 甲人物已选参考', exact: true }).click();
      assert.match(await dialog.getByLabel('图片 乙人物普通主图 占用槽位', { exact: true }).innerText(), /人物.*槽3/u);
      await dialog.getByRole('button', { name: '选择图片 无关场景图', exact: true }).click();
      assert.match(await dialog.getByLabel('图片 无关场景图 占用槽位', { exact: true }).innerText(), /人物.*槽2/u);
      await dialog.getByRole('tab', { name: '槽位用途', exact: true }).click();
      assert.equal(await dialog.getByLabel('第 2 段图片槽 1 用途', { exact: true }).count(), 0, 'reserved tail role has no editor');
      assert.equal(await dialog.getByRole('button', { name: '移除图片槽 1 的图片', exact: true }).count(), 0, 'reserved tail cannot be removed in the picker');
      assert.match(await dialog.locator('.vd-slot-reserved').innerText(), /本地真实末帧/u);
      assert.equal(await dialog.getByRole('combobox').count(), 4, 'all four other physical slots are shown, including empty slots');
      await dialog.getByLabel('第 2 段图片槽 2 用途', { exact: true }).selectOption('scene');
      assert.equal(await dialog.getByLabel('第 2 段图片槽 3 用途', { exact: true }).inputValue(), 'character');
      assert.match(await dialog.innerText(), /旧工作流标为人物参考.*场景参考.*仅提示，不阻止生成/u);
      assert.equal(await dialog.getByRole('button', { name: '使用本段图片', exact: true }).isDisabled(), false);
      await inspectLayout(dialog, `${scenario}-slots`, viewport); await capture(`${scenario}-slot-purposes`);
      await dialog.getByRole('tab', { name: '图片选择', exact: true }).click();
      assert.match(await dialog.getByLabel('图片 无关场景图 占用槽位', { exact: true }).innerText(), /^场景1（槽2）/u);
      assert.match(await dialog.getByLabel('图片 乙人物普通主图 占用槽位', { exact: true }).innerText(), /^人物1（槽3）/u);
      await inspectLayout(dialog, `${scenario}-images`, viewport); await capture(`${scenario}-mixed-images`);
      await applyPicker(dialog);
      assert.equal(await composite(2).getAttribute('aria-pressed'), 'true', 'saving mixed refs preserves the tail combination');
      assert.deepEqual(await submissionCounts(), { submit: 0, visual: 0, extract: 0 });

      const refs = await preview(2, '参考图与用途');
      assert.equal(refs.length, 3);
      assert.match(refs[0], /^1\. 等待上一段本地真实末帧/u);
      assert.match(refs[1], /^2\. 无关场景图[\s\S]*场景参考.*槽 2/u);
      assert.match(refs[2], /^3\. 乙人物普通主图[\s\S]*人物参考.*槽 3/u);
      await inspectLayout(page.locator('.vd-batch-preview'), `${scenario}-preview`, viewport);
      await capture(`${scenario}-mixed-preview`);
      const prompt = await preview(2, '完整提示词');
      const original = await page.evaluate(() => JSON.parse(window.__tailCharactersQa.originalBoards)[1].officialPromptZh);
      assert.equal(prompt.slice(prompt.indexOf('detailed_description:')), original.slice(original.indexOf('detailed_description:')),
        'shot actions, literal dialogue, sound and music remain byte-for-byte authored');
      assert.match(prompt, /<Subject 1> is 甲人物/u);
      assert.match(prompt, /<Subject 2> is 乙人物 referenced from <Picture 3>/u);
      for (const section of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
        assert.equal(prompt.split(`${section}:`).length, 2, `${scenario}: preserve exactly one H3 ${section}`);
      }
      const reopened = await openPicker(2);
      assert.equal(await reopened.getByRole('button', { name: '取消选择图片 无关场景图', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await reopened.getByRole('button', { name: '选择图片 甲人物已选参考', exact: true }).getAttribute('aria-pressed'), 'false');
      await reopened.getByRole('tab', { name: '槽位用途', exact: true }).click();
      assert.equal(await reopened.getByLabel('第 2 段图片槽 2 用途', { exact: true }).inputValue(), 'scene');
      assert.equal(await reopened.getByLabel('第 2 段图片槽 3 用途', { exact: true }).inputValue(), 'character');
      await applyPicker(reopened);
      const other = await openPicker(3);
      assert.equal(await other.getByRole('button', { name: '取消选择图片 甲人物已选参考', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await other.getByRole('button', { name: '选择图片 无关场景图', exact: true }).getAttribute('aria-pressed'), 'false');
      await other.getByRole('tab', { name: '槽位用途', exact: true }).click();
      assert.equal(await other.getByLabel('第 3 段图片槽 2 用途', { exact: true }).inputValue(), 'character');
      await applyPicker(other);
      // Re-applying the batch shortcut must preserve explicit per-segment refs.
      await showList(); await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
      const check = page.getByRole('button', { name: '检查并生成 3 段视频', exact: true });
      assert.equal(await check.isDisabled(), false); await check.click();
      const confirmation = page.getByRole('dialog', { name: '确认批量生成视频', exact: true }); await confirmation.waitFor();
      assert.deepEqual(await submissionCounts(), { submit: 0, visual: 0, extract: 0 }, 'opening confirmation alone has no paid side effect');
      await confirmation.getByLabel('确认批量生成费用', { exact: true }).check();
      await confirmation.getByRole('button', { name: '确认生成 3 段', exact: true }).click();
      await page.waitForFunction(() => window.__tailCharactersQa.submissions.length === 1);
      const input = await page.evaluate(() => window.__tailCharactersQa.submissions[0]);
      assert.deepEqual(input.items[1].draft.references.map((reference) => [reference.assetId, reference.role]),
        [['tcq-scene', 'scene'], ['tcq-b-primary', 'character']]);
      assert.deepEqual(input.items[1].draft.referenceSlotRoles, ['scene', 'character']);
      assert.deepEqual(input.items[2].draft.references.map((reference) => [reference.assetId, reference.role]),
        [['tcq-a-selected', 'character'], ['tcq-b-primary', 'character']]);
      assert.equal(input.items[1].previousTail.predecessorItemKey, input.items[0].itemKey);
      assert.equal(input.items[1].previousTail.placement.mode, 'prepend');
      assert.equal(input.items[1].draft.prompt, prompt, 'submitted prompt is exactly the inspected H3 preview');
      const mapped = await actualWorkflowBindings(input);
      assert.deepEqual(mapped.references.map((reference) => [reference.assetId, reference.role]),
        [['mock-only-mixed-tail', 'first-frame'], ['tcq-scene', 'scene'], ['tcq-b-primary', 'character']]);
      assert.equal(mapped.prompt, prompt);
      assert.deepEqual(mapped.bindings.slice(0, 3), [
        { nodeId: '2', value: 'fixture-only/mock-only-mixed-tail.png' },
        { nodeId: '3', value: 'fixture-only/tcq-scene.png' },
        { nodeId: '4', value: 'fixture-only/tcq-b-primary.png' },
      ]);
      assert.deepEqual(mapped.bindings.slice(3).map((binding) => binding.value), source === 'runninghub' ? ['None', 'None'] : ['', '']);
      assert.deepEqual(await submissionCounts(), { submit: 1, visual: 0, extract: 0 });
      assert.equal(await page.evaluate(() => {
        const qa = window.__tailCharactersQa;
        return JSON.stringify(qa.project.storyboards) === qa.originalBoards && JSON.stringify(qa.project.assets) === qa.originalAssets;
      }), true, 'no original prompt, asset or project content is changed');
      stages.push({ scenario, passed: true, selectedPhysicalSlots: ['本地末帧', '场景', '人物', '空', '空'], networkRequests: 0 });
    }
  }
  return { passed: true, stages, screenshots, layouts };
}

export async function runStandaloneTailMixedReferencesUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..');
  const outputDirectory = path.join(root, 'output', 'playwright', 'video-tail-mixed-references');
  await fs.mkdir(outputDirectory, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  let browser;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } }); page.setDefaultTimeout(20_000);
    const errors = []; page.on('pageerror', (cause) => errors.push(cause.message));
    const { blockedRequests, textRequests } = await installTailCharactersFixture(page, `http://127.0.0.1:${address.port}`);
    const report = await runTailMixedReferencesUiAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(textRequests, []);
    const complete = { ...report, errors, blockedRequests, textRequests };
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(complete, null, 2)); return complete;
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause) }, null, 2));
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(outputDirectory, 'failure.png') });
      await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`);
    }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneTailMixedReferencesUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
