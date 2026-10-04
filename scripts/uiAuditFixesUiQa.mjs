import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'ui-audit-fixes-0.5.88'));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UI fix artifacts must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('UI fix output must not traverse directory links');
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const baseUrl = `http://127.0.0.1:${port}/`; const key = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await s.listen(); console.log('Focused UI fix QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused UI audit fixes QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; const errors = []; const results = []; const screenshots = [];
const rect = (locator) => locator.evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; });
const nativeReveal = async (target, container) => {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const area = await rect(container); const box = await target.boundingBox();
    if (box && box.y >= area.y + 1 && box.y + box.height <= area.bottom - 1) return;
    const direction = box && box.y < area.y ? -1 : 1;
    await page.mouse.move(area.right - 28, area.y + area.height / 2);
    await page.mouse.wheel(0, direction * Math.max(130, Math.floor(area.height * 0.55)));
    await page.waitForTimeout(80);
  }
  assert.fail('native mouse wheel did not reveal the requested settings control');
};
const assertHit = (target) => target.evaluate((element) => {
  const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return hit === element || element.contains(hit) || [...(element.labels || [])].some((label) => label === hit || label.contains(hit));
});

const installFixture = (font) => page.evaluate(async ({ storageKey, fontScale }) => {
  const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
  const state = JSON.parse(localStorage.getItem(storageKey)); const now = Date.now();
  const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 108; const paint = canvas.getContext('2d'); paint.fillStyle = '#83a5b7'; paint.fillRect(0, 0, 144, 108); paint.fillStyle = '#fff'; paint.fillText('SAFE LOCAL FIXTURE', 8, 55);
  const image = { id: 'ui-fix-image', name: '合成廊桥参考图', type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', dataUrl: canvas.toDataURL('image/png'), width: 144, height: 108, tags: ['SFW合成'], source: 'upload', createdAt: now, updatedAt: now };
  const source = '林澜来到廊桥，推开木门，回望同伴并说：“先在这里等我。”最后她把信放入外套，停在门口。';
  const scene = { id: 'ui-fix-scene', title: '廊桥来信', content: source, summary: '同伴在木门外等候', characterIds: [], locationIds: [], propIds: [], storyboardIds: ['ui-fix-board'], createdAt: now, updatedAt: now };
  const shots = ['沿廊桥走近木门', '抬手推开木门', '回望同伴', '示意同伴原地等候', '收好信封并站稳'].map((action, index) => ({ id: `ui-fix-shot-${index}`, index: index + 1, startSec: index * 3, endSec: (index + 1) * 3, subject: '林澜', action, purpose: '推进来信事件', camera: '中景', lighting: '自然光', sound: '', transition: '连续', result: '保持原有空间关系', referenceAssetIds: [], locked: false,
    prompt: `【${index * 3}s-${(index + 1) * 3}s】 主体：@林澜（沉着）[朝向：门口] 正在 [${action}，身体朝向与之前保持连续，衣摆随动作自然摆动，手里的信封保持完好；她在动作结束后短暂停顿，目光自然移动到同伴所在的位置，人物行动与回应关系保持清楚可辨]（推进当前事件）；空间：林澜在廊桥木门旁，同伴在她身后，信封由林澜持有，前景是扶栏与湿润木板，背景是岸边的小路，各处位置关系与上一镜保持一致；光影：门外柔和自然光照在人物侧脸与外套上，桥内的亮度稍低，手部和脸部仍可辨认；镜头：中景稳定跟随，保留人物运动前方空间，不改变视线轴；台词：${index === 0 ? '第1s @林澜：“先在这里等我。”' : '无'}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]` }));
  const board = applyOfficialH3Prompt({ id: 'ui-fix-board', sceneId: scene.id, sourceStoryContent: source, sourceStoryTitle: '廊桥长稿合成测试', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 5, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', shots, finalPrompt: shots.map((item) => item.prompt).join('\n'), targetModelId: 'minimax-h3', createdAt: now, updatedAt: now }, { assets: [image], characters: [], locations: [], props: [], sceneContent: source });
  const media = await new Promise((resolve, reject) => { const stream = canvas.captureStream(10); const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); }; recorder.onerror = reject; recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); const blob = new Blob(chunks, { type: 'video/webm' }); const reader = new FileReader(); reader.onload = () => resolve({ dataUrl: reader.result, sizeBytes: blob.size }); reader.onerror = reject; reader.readAsDataURL(blob); }; recorder.start(); setTimeout(() => recorder.stop(), 220); });
  const task = { id: 'ui-fix-task', kind: 'video', storyboardId: board.id, targetId: '合成接口', status: 'succeeded', resultAssetId: 'ui-fix-video', requestBody: {}, createdAt: now, updatedAt: now, videoJob: { stage: 'succeeded', completedAt: now, snapshot: { projectId: 'ui-fix-project', clientId: 'ui-fix-client', draft: { name: '合成视频', prompt: board.officialPromptZh, backend: 'api', parameters: { seed: 42 }, references: [{ assetId: image.id, role: 'composition' }] }, connection: { backend: 'api', api: { enabled: false, endpoint: '', statusEndpointTemplate: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' } }, images: [{ assetId: image.id, name: image.name, role: 'composition', dataUrl: image.dataUrl, freezeState: 'frozen' }] } } };
  const video = { ...media, id: 'ui-fix-video', name: '合成视频', type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', mimeType: 'video/webm', source: 'generated', sourceVideoTaskId: task.id, videoSourceTask: structuredClone(task), tags: [], createdAt: now, updatedAt: now };
  state.project = { ...state.project, id: 'ui-fix-project', name: 'UI修复隔离验收', sourceDocuments: [{ id: 'ui-fix-source', name: '廊桥来信', content: source, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [board], sequencePlans: [], characters: [], locations: [], props: [], assets: [image, video], generationTasks: [task], updatedAt: now }; state.projects = [state.project]; state.activeProjectId = state.project.id;
  state.settings.uiFontScalePercent = fontScale; for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
  state.settings.textApiProfiles = []; state.settings.visionApiProfiles = []; state.settings.imageApiProfiles = []; state.settings.videoApiProfiles = []; state.settings.apiCredentialBook = [];
  const workflowJson = JSON.stringify({ 312: { class_type: 'PrimitiveStringMultiline', inputs: { value: '合成工作流' } }, 335: { class_type: 'LoadImage', inputs: { image: 'fixture.png' } }, 328: { class_type: 'VHS_VideoCombine', inputs: { images: ['335', 0], frame_rate: 24 } } });
  state.settings.comfyuiVideo = { enabled: false, baseUrl: '', apiKey: '', activeWorkflowId: 'ui-fix-workflow', workflows: [{ id: 'ui-fix-workflow', name: '合成工作流', workflowJson, mapping: { prompt: [{ nodeId: '312', inputName: 'value' }], images: [{ nodeId: '335', inputName: 'image' }], outputNodeId: '328', parameters: {} }, createdAt: now, updatedAt: now }] };
  localStorage.setItem(storageKey, JSON.stringify(state));
}, { storageKey: key, fontScale: font });

const run = async () => {
  await waitForCondition({ label: 'UI fixes Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  for (const spec of [{ width: 1366, height: 768, font: 125 }, { width: 1280, height: 800, font: 100 }]) {
    const name = `${spec.width}x${spec.height}-font${spec.font}`;
    context = await browser.newContext({ viewport: { width: spec.width, height: spec.height } }); page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__ui_fix_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__ui_fix_qa__', '1'); }
      window.__uiFixQa = { permissionCalls: [], apiCalls: [] };
      const recovery = { allowPrivateNetwork: false, backupDirectory: '', backupOnSave: false, keepCount: 20 };
      window.lianhuaDesktop = {
        recoveryStatus: async () => ({ dataRoot: 'QA-only', stateFile: 'QA-only/project.json', stateValid: true, stateChecksum: 'fixture', stateSize: 1, snapshots: [], recovery: { ...recovery }, encryptionAvailable: true }),
        updateRecoveryConfig: async (patch) => { Object.assign(recovery, patch); window.__uiFixQa.permissionCalls.push(patch); return { ...recovery }; },
        storagePaths: async () => ({ dataRoot: 'QA-only', sessionData: 'QA-only/session', cache: 'QA-only/cache', temp: 'QA-only/temp', logs: 'QA-only/logs', assets: 'QA-only/assets', snapshots: 'QA-only/snapshots', encryptionAvailable: true }),
        videoRequest: async (payload) => { window.__uiFixQa.apiCalls.push(payload.url); throw new Error('Real API is forbidden in UI fixture'); },
        onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
      };
    });
    await page.route('**/*', async (route) => { const req = route.request(); const url = new URL(req.url()); if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(req.method()))) { errors.push('Unexpected API request'); await route.abort('blockedbyclient'); } else await route.continue(); });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 }); await page.waitForFunction((storageKey) => Boolean(localStorage.getItem(storageKey)), key); await installFixture(spec.font); await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
    const nav = (label) => page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
    await nav('API 设置'); await page.locator('.settings-api-tabs [role="tab"]').filter({ hasText: '视频' }).click();
    const permission = page.getByRole('checkbox', { name: '允许访问本机与局域网模型端点', exact: true }); const form = page.locator('.settings-panel-stage > .video-generation-settings');
    const permissionBox = await rect(permission); const formBox = await rect(form);
    assert.ok(permissionBox.bottom < formBox.y, 'permission checkbox must own an independent unobstructed row'); assert.equal(await assertHit(permission), true);
    await page.mouse.click(permissionBox.x + permissionBox.width / 2, permissionBox.y + permissionBox.height / 2); await page.waitForFunction(() => document.querySelector('.settings-panel-stage > .card input[type="checkbox"]')?.checked === true);
    assert.deepEqual(await page.evaluate(() => window.__uiFixQa.permissionCalls), [{ allowPrivateNetwork: true }]);
    const auth = page.getByLabel('认证头名称', { exact: true }); await nativeReveal(auth, form); assert.equal(await assertHit(auth), true); await auth.fill('Authorization');
    const advanced = page.getByText('高级协议映射与请求模板', { exact: true }); await nativeReveal(advanced, form); await advanced.click();
    const template = page.getByLabel('视频请求模板 JSON', { exact: true }); await nativeReveal(template, form); assert.equal(await assertHit(template), true); await template.fill('{"prompt":"{{prompt}}","images":"{{images}}"}');
    const saveTemplate = page.getByRole('button', { name: '保存请求模板', exact: true }); await nativeReveal(saveTemplate, form); assert.equal(await assertHit(saveTemplate), true); await saveTemplate.click();
    await page.waitForFunction((storageKey) => JSON.parse(localStorage.getItem(storageKey)).settings.videoTaskApi.requestTemplate?.includes('{{prompt}}'), key);
    const apiScrollTop = await form.evaluate((node) => node.scrollTop); assert.ok(apiScrollTop > 0, 'advanced settings must have been reached by native wheel'); assert.equal((await rect(permission)).y, permissionBox.y);
    await page.screenshot({ path: path.join(output, `${name}-video-api-scrolled.png`), fullPage: false }); screenshots.push(`${name}-video-api-scrolled.png`);
    const comfyTab = page.getByRole('tab', { name: 'ComfyUI 视频', exact: true }); await nativeReveal(comfyTab, form); await comfyTab.click();
    const workflowDetails = page.getByText('工作流 API JSON 原文', { exact: true }); await nativeReveal(workflowDetails, form); await workflowDetails.click();
    const workflowText = page.getByLabel('视频工作流 JSON', { exact: true }); await nativeReveal(workflowText, form); assert.equal(await assertHit(workflowText), true); assert.ok((await workflowText.inputValue()).includes('PrimitiveStringMultiline'));
    await page.screenshot({ path: path.join(output, `${name}-comfy-scrolled.png`), fullPage: false }); screenshots.push(`${name}-comfy-scrolled.png`);
    await page.mouse.click(permissionBox.x + permissionBox.width / 2, permissionBox.y + permissionBox.height / 2); await page.waitForFunction(() => document.querySelector('.settings-panel-stage > .card input[type="checkbox"]')?.checked === false);
    assert.deepEqual(await page.evaluate(() => window.__uiFixQa.permissionCalls), [{ allowPrivateNetwork: true }, { allowPrivateNetwork: false }]);
    await nav('提示词导演台');
    const assertDirectorFooter = async () => {
      const area = await rect(page.locator('.director-side-panel'));
      const buttons = await page.locator('.director-result-actions button').all(); assert.equal(buttons.length, 3);
      for (const button of buttons) { const bounds = await rect(button); assert.ok(bounds.bottom <= area.bottom - 1 && bounds.y >= area.y, 'result action must fit completely inside its panel'); assert.equal(await assertHit(button), true); }
      const text = page.locator('.director-result-copy'); const bounds = await rect(text); assert.ok(bounds.height >= 30, 'prompt remains a readable scroll region');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(0, 900); await page.waitForTimeout(100); assert.ok(await text.evaluate((node) => node.scrollTop > 0), 'long original prompt scrolls without moving actions');
      return { area, footer: await rect(page.locator('.director-result-actions')), textHeight: bounds.height };
    };
    const director = await assertDirectorFooter();
    await page.locator('.input-mode-card button').nth(1).click(); await page.locator('.reference-result-tabs').getByRole('button', { name: '参考图', exact: true }).click(); await page.locator('.director-asset-grid').waitFor();
    await page.locator('.reference-result-tabs').getByRole('button', { name: '结果', exact: true }).click(); const withReferences = await assertDirectorFooter();
    await page.screenshot({ path: path.join(output, `${name}-director-footer.png`), fullPage: false }); screenshots.push(`${name}-director-footer.png`);
    await nav('资产库'); await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '资产库首页', exact: true }).count(), 0);
    const checkFont = await page.locator('.asset-video-check').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize)); assert.equal(checkFont, 12 * spec.font / 100);
    await page.getByRole('button', { name: '视频资产库', exact: true }).click(); await page.locator('.asset-video-source summary').click(); const sourceFont = await page.locator('.asset-video-source').evaluate((node) => parseFloat(getComputedStyle(node).fontSize)); assert.equal(sourceFont, 12 * spec.font / 100);
    const sidebar = await page.locator('.sidebar nav').evaluate((node) => { const r = node.getBoundingClientRect(); return { scrollTop: node.scrollTop, overflowY: getComputedStyle(node).overflowY, buttons: [...node.querySelectorAll('.nav-item')].map((button) => { const b = button.getBoundingClientRect(); return b.y >= r.y - 1 && b.bottom <= r.bottom + 1; }) }; }); assert.equal(sidebar.buttons.length, 10); assert.ok(sidebar.buttons.every(Boolean)); assert.equal(sidebar.scrollTop, 0); assert.ok(['clip', 'hidden'].includes(sidebar.overflowY));
    assert.deepEqual(await page.evaluate(() => window.__uiFixQa.apiCalls), []); assert.deepEqual(errors, []);
    results.push({ ...spec, permissionClickable: true, apiScrollTop, director, withReferences, fonts: { checkFont, sourceFont }, sidebarFitPreserved: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, results, screenshots, errors }, null, 2)); console.log(JSON.stringify({ passed: name, apiScrollTop, fonts: { checkFont, sourceFont } }));
    await context.close(); context = undefined;
  }
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), cause: error?.cause ? String(error.cause) : undefined, results, errors }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
