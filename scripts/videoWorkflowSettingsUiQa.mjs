import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Caller owns the Playwright session. Only fresh browser storage and fake
// workflow JSON are used; all non-fixture network traffic is blocked.
export async function installVideoSettingsQa(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort());
  if (page.routeWebSocket) await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(async () => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState(); state.settings.videoBackend = 'comfyui';
    state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', promptPath: '/prompt', workflows: [], activeWorkflowId: null };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('tab', { name: '视频生成', exact: true }).click();
}

export const videoSettingsQaWorkflow = JSON.stringify({
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '隔离验证提示词' }, _meta: { title: '提示词' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
  '3': { class_type: 'KSampler', inputs: { prompt: ['1', 0], latent_image: ['2', 0], seed: 42, steps: 20, cfg: 6.5 } },
  '4': { class_type: 'VHS_VideoCombine', inputs: { images: ['3', 0], frame_rate: 24, save_output: true } },
}, null, 2);
const manager = (page) => page.getByRole('dialog', { name: 'ComfyUI 视频工作流管理', exact: true });
const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')));

export async function settingsViewportCheck(page, selector = '.video-settings-redesign') {
  return page.locator(selector).evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const hiddenControls = [...root.querySelectorAll('button,input:not([type="hidden"]),select,textarea')].filter((item) => item.getClientRects().length && !item.closest('[hidden]')).flatMap((item) => {
      const box = item.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && hit && (hit === item || item.contains(hit)) ? [] : [item.getAttribute('aria-label') || item.textContent];
    });
    return { width: innerWidth, height: innerHeight, fit: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1,
      hiddenControls, horizontalOverflow: root.scrollWidth > root.clientWidth + 1, verticalOverflow: root.scrollHeight > root.clientHeight + 1 };
  });
}

export async function exerciseVideoWorkflowManager(page, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true }); const checks = [];
  await page.locator('.video-settings-redesign input[type=file]').setInputFiles({ name: 'QA视频甲.json', mimeType: 'application/json', buffer: Buffer.from(videoSettingsQaWorkflow) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).settings.comfyuiVideo.workflows.length === 1);
  const original = (await state(page)).settings.comfyuiVideo.workflows[0];
  await page.getByRole('button', { name: '管理 Workflow', exact: true }).click();
  await manager(page).getByRole('button', { name: '复制', exact: true }).click();
  await manager(page).getByLabel('视频工作流名称', { exact: true }).fill('QA视频乙-24步');
  await manager(page).getByRole('tab', { name: /参数设置/u }).click();
  await manager(page).getByLabel('参数 steps 默认值', { exact: true }).fill('24');
  await manager(page).getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).settings.comfyuiVideo.workflows.length === 2);
  const copied = (await state(page)).settings.comfyuiVideo;
  assert.equal(copied.activeWorkflowId, original.id, 'copy/save must not activate');
  assert.equal(JSON.parse(copied.workflows[1].workflowJson)['3'].inputs.steps, 24);
  assert.equal(copied.workflows[0].workflowJson, original.workflowJson);
  await manager(page).getByRole('button', { name: '设为当前', exact: true }).click();
  await manager(page).getByRole('tab', { name: '节点映射', exact: true }).click();
  await manager(page).getByRole('tab', { name: '图片槽 1', exact: true }).click();
  await manager(page).getByLabel('图片槽 1 用途', { exact: true }).selectOption('first-frame');
  await manager(page).getByRole('button', { name: '保存工作流', exact: true }).click();
  await manager(page).getByRole('tab', { name: 'API JSON', exact: true }).click();
  const text = await manager(page).getByLabel('视频工作流 API JSON 编辑稿', { exact: true }).inputValue();
  await manager(page).getByLabel('视频工作流 API JSON 编辑稿', { exact: true }).fill(text.replace('"steps": 24', '"steps": 25'));
  await manager(page).getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await manager(page).getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction(() => { const c = JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).settings.comfyuiVideo; const w = c.workflows.find((item) => item.id === c.activeWorkflowId); return w.mapping.images[0].role === 'first-frame' && JSON.parse(w.workflowJson)['3'].inputs.steps === 25; });
  checks.push('import-copy-rename-typed-parameter-save-explicit-activate-json-preserves-role-and-unsaved-close-cancel');
  const downloadWait = page.waitForEvent('download');
  await manager(page).getByRole('button', { name: '导出 API JSON', exact: true }).click();
  const download = await downloadWait; const exportedPath = path.join(outputDirectory, 'exported-workflow.json'); await download.saveAs(exportedPath);
  assert.equal(JSON.parse(await fs.readFile(exportedPath, 'utf8'))['3'].inputs.steps, 25);
  await manager(page).getByRole('button', { name: '新建草稿', exact: true }).click();
  await manager(page).getByRole('button', { name: '保存工作流', exact: true }).click();
  assert.equal(await manager(page).getByRole('button', { name: '设为当前', exact: true }).isDisabled(), true);
  await manager(page).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await manager(page).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除工作流', exact: true }).click();
  await manager(page).getByRole('button', { name: '完成', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).settings.comfyuiVideo.workflows.length === 2);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'API 设置', exact: true }).click(); await page.getByRole('tab', { name: '视频生成', exact: true }).click();
  const after = (await state(page)).settings.comfyuiVideo;
  assert.equal(after.workflows.length, 2); assert.equal(after.activeWorkflowId, copied.workflows[1].id);
  checks.push('export-draft-cannot-activate-delete-confirm-reload-preserves-two-workflows');
  const layouts = [];
  for (const size of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(size);
    for (const scale of [1, 1.3]) {
      await page.evaluate((value) => document.querySelector('.app-shell').style.setProperty('--ui-font-scale', String(value)), scale);
      layouts.push(await settingsViewportCheck(page));
      await page.screenshot({ path: path.join(outputDirectory, `main-${size.width}-${scale}.png`), scale: 'css', animations: 'disabled' });
      await page.getByRole('button', { name: '管理 Workflow', exact: true }).click();
      for (const tab of ['基本信息', '节点映射', '参数设置', 'API JSON']) {
        await manager(page).getByRole('tab', { name: new RegExp(`^${tab}`, 'u') }).click();
        layouts.push(await settingsViewportCheck(page, '.vwm-dialog'));
        await page.screenshot({ path: path.join(outputDirectory, `manager-${tab}-${size.width}-${scale}.png`), scale: 'css', animations: 'disabled' });
      }
      await manager(page).getByRole('button', { name: '完成', exact: true }).click();
    }
  }
  return { checks, layouts, exportedPath };
}
