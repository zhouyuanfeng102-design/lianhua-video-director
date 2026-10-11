import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One targeted packaged pass. All API replies, reference pictures, rules and
// project data are synthetic and live in a newly created isolated profile.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
assert.ok(electronOption !== -1 && process.argv[electronOption + 1], '--electron requires a packaged executable path');
const executable = path.resolve(process.argv[electronOption + 1]);
await fs.access(executable);
const output = path.join(root, 'output', 'playwright', `custom-image-workbench-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow symbolic links: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = { pass: false, version, packagedElectron: true, mockOnly: true, noProductionDataRead: true,
  stages: [], requests: [], screenshots: [], pageErrors: [], consoleErrors: [], blockedRequests: [], fixtureErrors: [] };
const projectId = 'qa-custom-image-project';
const rawPrompt = '  自定义原文：画一个中性的木方块。\n保留 | 竖线与 __WIDTH__ 标记。  ';
const referencePrompt = '  根据本次两张参考色块，画一个简单的陶杯。\n仅此本次要求 | 不加入历史。  ';
const rulePrompt = '按我选的第二条规则，画桌上的陶杯，背景简洁。';
const finalRulePrompt = 'RULE_B_FINAL: A plain ceramic cup on a wooden table, simple background.';
const unsentDraft = '  尚未提交的草稿 | 保留两端空格。  ';
const ruleA = { id: 'qa-custom-rule-a', name: '隔离规则 A', backend: 'openai', format: 'natural-language', description: '',
  systemPrompt: 'QA_RULE_A: 保留用户要求。', outputRules: '仅输出最终提示词。', enabled: true,
  categoryPresetIds: [], defaultPresetByAssetKind: {}, version: '1.0', updatedAt: 1 };
const ruleB = { ...ruleA, id: 'qa-custom-rule-b', name: '隔离用户规则 B', backend: 'comfyui', version: '2.0',
  systemPrompt: 'QA_SELECTED_RULE_B: 用简洁自然语言表达用户要求。' };

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const neutralPng = (width, height, color) => {
  const chunk = (kind, payload) => {
    const name = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(payload.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
    return Buffer.concat([length, name, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    color.forEach((component, index) => { raw[offset + index] = component; });
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uploadPixels = neutralPng(64, 64, [172, 190, 205]);
const libraryPixels = neutralPng(64, 64, [184, 199, 173]);
const outputPixels = neutralPng(1024, 1024, [195, 186, 171]);
const referenceName = '隔离资产库中性色块';
const expectedReferenceChecksums = [sha256(uploadPixels), sha256(libraryPixels)];
const parseMultipart = (body, contentType) => {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType)?.slice(1).find(Boolean);
  assert.ok(boundary, 'image edits retain a real multipart boundary');
  const fields = {}, files = [];
  for (let part of body.toString('latin1').split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) break;
    part = part.replace(/^\r\n/u, '').replace(/\r\n$/u, '');
    const headerEnd = part.indexOf('\r\n\r\n'); if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd), bytes = Buffer.from(part.slice(headerEnd + 4), 'latin1');
    const name = /(?:^|;)\s*name="([^"]+)"/imu.exec(headers)?.[1];
    assert.ok(name, 'every multipart part has a declared name');
    if (/filename="/iu.test(headers)) files.push({ name, checksum: sha256(bytes), sizeBytes: bytes.length });
    else fields[name] = bytes.toString('utf8');
  }
  return { fields, files };
};

let harness, browser, page, dataRoot;
const screenshot = async (name) => {
  const destination = path.join(output, `${name}.png`);
  await page.screenshot({ path: destination, scale: 'css' }); report.screenshots.push(destination);
};
const mock = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    assert.equal(request.method, 'POST');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (request.url === '/qa-custom-text/v1/chat/completions') {
      const payload = JSON.parse(bytes.toString('utf8'));
      assert.deepEqual(payload.messages.map((message) => message.role), ['system', 'user'], 'conversion has no implicit chat history');
      assert.equal(payload.messages[1].content, rulePrompt);
      assert.match(payload.messages[0].content, /QA_SELECTED_RULE_B/u);
      assert.doesNotMatch(payload.messages[0].content, /QA_RULE_A|image_prompt_category_preset|morphology|bodyPlan/u);
      report.requests.push({ kind: 'text', endpoint: request.url, userPrompt: payload.messages[1].content, selectedRule: ruleB.id });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: finalRulePrompt } }] })); return;
    }
    assert.ok(['/qa-custom-image/v1/images/generations', '/qa-custom-image/v1/images/edits'].includes(request.url),
      `Unexpected fixture stage: ${request.url}`);
    const multipart = request.url.endsWith('/edits') ? parseMultipart(bytes, request.headers['content-type'] || '') : undefined;
    const fields = multipart?.fields || JSON.parse(bytes.toString('utf8'));
    const prompt = fields.prompt;
    assert.ok([rawPrompt, referencePrompt, finalRulePrompt].includes(prompt), 'actual image prompt is exactly original text or the selected conversion output');
    assert.equal(fields.model, 'qa-custom-image'); assert.equal(fields.size, '1024x1024');
    const references = multipart?.files.map((file) => file.checksum) || [];
    assert.deepEqual(references, prompt === rawPrompt ? [] : expectedReferenceChecksums);
    report.requests.push({ kind: 'image', endpoint: request.url, prompt, size: fields.size, referenceChecksums: references });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ b64_json: outputPixels.toString('base64') }] }));
  } catch (error) {
    report.fixtureErrors.push(error.stack || error.message);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic custom-image fixture failed' } }));
  }
});
const storedProject = async () => page.evaluate(async () => JSON.parse(await window.lianhuaDesktop.loadState()).project);
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 20_000, intervalMs: 80,
  check: async () => predicate(await storedProject()) });
const customTasks = (project) => project.generationTasks.filter((task) => task.kind === 'image' && task.assetKind === 'custom');
const settle = async (count) => {
  await waitStored((project) => customTasks(project).length === count && customTasks(project).every((task) => ['succeeded', 'failed'].includes(task.status)),
    `${count} custom tasks save to the isolated desktop profile`);
  const project = await storedProject(), tasks = customTasks(project);
  tasks.forEach((task) => assert.equal(task.status, 'succeeded', task.error || task.name));
  assert.equal(project.assets.filter((asset) => asset.customImageInput).length, count, 'every custom image automatically enters the asset library');
  return { project, task: tasks[0] };
};
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const openCustom = async () => {
  await nav('图像工作台'); await page.getByRole('button', { name: '自定义生图', exact: true }).click();
  await page.locator('.custom-image-composer').waitFor();
};
const controlsFit = async () => {
  const clips = await page.locator('.custom-image-composer, .custom-image-controls').evaluateAll((sections) => {
    const controls = sections.flatMap((section) => [...section.querySelectorAll('textarea,button,select,input:not([type=file])')]);
    return controls.flatMap((element) => {
      const box = element.getBoundingClientRect(); if (!box.width || !box.height) return [];
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const name = element.getAttribute('aria-label') || element.textContent || element.type;
      return box.x < 0 || box.right > innerWidth + 1 || box.y < 0 || box.bottom > innerHeight + 1 || !(hit === element || element.contains(hit))
        ? [{ name, x: box.x, y: box.y, right: box.right, bottom: box.bottom }] : [];
    });
  });
  assert.deepEqual(clips, [], 'all composer and settings controls fit 1280×800 without clipping or overlays');
};

try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const { createInitialState, normalizeState } = await tsImport('../src/storage.ts', import.meta.url);
  const initial = createInitialState(), now = Date.now();
  const referenceAsset = { id: 'qa-library-reference', name: referenceName, type: 'reference', role: 'composition', referenceRole: 'general',
    mediaType: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,${libraryPixels.toString('base64')}`,
    width: 64, height: 64, source: 'upload', tags: ['隔离中性色块'], createdAt: now, updatedAt: now };
  const project = { ...initial.project, id: projectId, name: '自定义生图隔离检查', characters: [], locations: [], props: [], scenes: [], assets: [referenceAsset],
    storyboards: [], sequencePlans: [], generationTasks: [], sourceDocuments: [], chapterWorkspaces: {}, customImageDraft: undefined,
    storyDraft: 'QA_UNUSED_STORY: 这段项目剧情不得自动加入本次请求。', updatedAt: now };
  const state = normalizeState({ ...initial, project, projects: [project], activeProjectId: projectId,
    imagePromptRules: { schemaVersion: 1, catalogVersion: initial.imagePromptRules.catalogVersion, ruleSets: [ruleA, ruleB],
      categoryPresets: [], defaultRuleSetByBackend: { openai: ruleA.id } },
    settings: { ...initial.settings, uiFontScalePercent: 100,
      textApi: { ...initial.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${mockOrigin}/qa-custom-text/v1`,
        model: 'qa-custom-text', apiKey: '', maxTokens: 1000 }, activeTextApiProfileId: null, textApiProfiles: [], apiCredentialBook: [],
      imageApi: { enabled: true, backend: 'openai', baseUrl: `${mockOrigin}/qa-custom-image/v1`, model: 'qa-custom-image', apiKey: '',
        imageProtocol: 'openai-images', imageResolutionProfile: 'gpt-image-legacy' }, activeImageApiProfileId: null, imageApiProfiles: [],
      imagePromptRuleSetIdByBackend: { openai: ruleA.id },
      visionApi: { ...initial.settings.visionApi, enabled: false, apiKey: '' },
      videoTaskApi: { ...initial.settings.videoTaskApi, enabled: false, apiKey: '' },
      runningHubVideo: { ...initial.settings.runningHubVideo, enabled: false, apiKey: '' } } });
  dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-')); report.isolatedDataRoot = dataRoot;
  await fs.writeFile(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic custom-image profile; no production data imported.\n');
  await fs.writeFile(path.join(dataRoot, 'project-state.json'), JSON.stringify(state));
  const uploadPath = path.join(dataRoot, 'qa-upload-reference.png'); await fs.writeFile(uploadPath, uploadPixels);
  const bootstrapTemp = path.join(dataRoot, 'portable-bootstrap'); await fs.mkdir(bootstrapTemp);
  const port = await findAvailableTcpPort(), cdpOrigin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, LIANHUA_DATA_DIR: dataRoot, LIANHUA_QA_MODE: '1', LIANHUA_ALLOW_PRIVATE_NETWORK: '1',
    TEMP: bootstrapTemp, TMP: bootstrapTemp, TMPDIR: bootstrapTemp };
  delete env.ELECTRON_START_URL; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--no-first-run'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  harness = createQaProcessHarness({ electron: child, qaLabel: 'custom image workbench', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
  async function run() {
    await waitForCondition({ label: 'packaged renderer startup', timeoutMs: 90_000, intervalMs: 100,
      check: async () => { try { return (await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = await chromium.connectOverCDP(cdpOrigin);
    const context = browser.contexts()[0]; assert.ok(context);
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && url.origin !== mockOrigin) {
        report.blockedRequests.push({ method: request.method(), pathname: url.pathname }); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = context.pages().find((entry) => entry.url().startsWith('file:')); assert.ok(page);
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
    assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase());
    await page.reload({ waitUntil: 'networkidle' }); await page.locator('.app-shell').waitFor();
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`), 'packaged version matches current source');
    await page.setViewportSize({ width: 1280, height: 800 }); await openCustom();
    const input = page.getByLabel('自定义生图要求', { exact: true });
    const send = page.getByRole('button', { name: '发送并生图', exact: true });
    const conversion = page.getByRole('checkbox', { name: /使用规则转换/u });
    assert.equal(await conversion.isChecked(), false); assert.equal(await page.getByLabel('自定义生图规则', { exact: true }).count(), 0);
    await input.fill(rawPrompt); await controlsFit(); await screenshot('raw-composer-1280x800');
    await send.click(); const first = await settle(1);
    assert.equal(first.task.prompt, rawPrompt); assert.equal(first.task.customImageInput.userPrompt, rawPrompt);
    assert.equal(first.task.customImageInput.promptMode, 'raw'); assert.equal(report.requests.filter((request) => request.kind === 'text').length, 0);
    assert.equal(await page.locator(`.custom-image-turn[data-task-id="${first.task.id}"] .custom-image-user-text`).textContent(), rawPrompt);
    assert.equal(first.project.assets.find((asset) => asset.id === first.task.resultAssetId).managed, true);
    const savedPixels = await page.evaluate(async (asset) => window.lianhuaDesktop.readManagedImageDataUrl({ relativePath: asset.relativePath, expectedChecksum: asset.checksum }),
      first.project.assets.find((asset) => asset.id === first.task.resultAssetId));
    assert.equal(typeof savedPixels.dataUrl, 'string', 'managed-image IPC returns verified image metadata and dataUrl');
    assert.equal(sha256(Buffer.from(savedPixels.dataUrl.split(',')[1], 'base64')), sha256(outputPixels), 'actual desktop asset store retains generated pixels');
    report.stages.push('default raw preserves original whitespace, pipes and markers; no text request; generated pixels saved to asset store');

    await page.getByLabel('上传自定义生图参考图', { exact: true }).setInputFiles(uploadPath);
    await waitStored((current) => current.customImageDraft?.referenceAssetIds.length === 1, 'uploaded reference joins the composer');
    await page.getByRole('button', { name: '从资产库选择', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '从资产库选择参考图', exact: true }); await picker.waitFor();
    await picker.locator('.reference-image-picker-item').filter({ hasText: referenceName }).click();
    await picker.getByRole('button', { name: '使用所选图片', exact: true }).click();
    await waitStored((current) => current.customImageDraft?.referenceAssetIds.length === 2, 'asset-library selection joins the composer');
    await input.fill(referencePrompt); await send.click(); const second = await settle(2);
    assert.deepEqual(second.task.referenceAssetSnapshots.map((reference) => reference.checksum), expectedReferenceChecksums);
    assert.equal(report.requests.filter((request) => request.kind === 'text').length, 0);
    assert.match(report.requests.filter((request) => request.kind === 'image').at(-1).endpoint, /\/edits$/u);
    report.stages.push('file upload plus asset-library reference send two actual ordered PNG files to image edits');

    await conversion.check(); const ruleSelect = page.getByLabel('自定义生图规则', { exact: true });
    await ruleSelect.selectOption(ruleB.id); await input.fill(rulePrompt);
    await controlsFit(); await screenshot('optional-rule-composer-1280x800');
    await send.click(); const third = await settle(3), ruleTask = third.task;
    assert.equal(ruleTask.customImageInput.promptMode, 'rules'); assert.equal(ruleTask.customImageInput.userPrompt, rulePrompt);
    assert.equal(ruleTask.customImageInput.ruleSelection.id, ruleB.id); assert.equal(ruleTask.prompt, finalRulePrompt);
    assert.equal(report.requests.filter((request) => request.kind === 'text').length, 1);
    const ruleAsset = third.project.assets.find((asset) => asset.id === ruleTask.resultAssetId);
    assert.equal(ruleAsset.customImageInput.userPrompt, rulePrompt); assert.equal(ruleAsset.prompt, finalRulePrompt);
    await input.fill(unsentDraft);
    await waitStored((current) => current.customImageDraft?.userPrompt === unsentDraft && current.customImageDraft.ruleSetId === ruleB.id,
      'unsent draft and selected rule persist');
    await page.reload({ waitUntil: 'networkidle' }); await openCustom();
    assert.equal(await input.inputValue(), unsentDraft); assert.equal(await conversion.isChecked(), true); assert.equal(await ruleSelect.inputValue(), ruleB.id);
    assert.equal(await page.locator('.custom-image-turn').count(), 3);
    assert.equal(customTasks(await storedProject()).find((task) => task.id === ruleTask.id).prompt, finalRulePrompt);
    await controlsFit(); await screenshot('saved-history-draft-1280x800');
    report.stages.push('explicit second enabled user rule converts once; source and final stored separately; draft, references, rules and history survive actual reload');

    await nav('生成任务'); const taskCard = page.locator(`#image-task-${ruleTask.id}`); await taskCard.waitFor();
    await taskCard.locator('.image-regenerate-button').click(); const fourth = await settle(4);
    assert.equal(fourth.task.prompt, finalRulePrompt); assert.equal(fourth.task.customImageInput.operation, 'saved-final');
    assert.equal(report.requests.filter((request) => request.kind === 'text').length, 1, 'task replay never reconverts saved final text');
    await nav('资产库'); const assetCard = page.locator(`#asset-card-${ruleAsset.id}`); await assetCard.waitFor();
    await assetCard.locator('.asset-regenerate-button').click(); const fifth = await settle(5);
    assert.equal(fifth.task.prompt, finalRulePrompt); assert.equal(fifth.task.customImageInput.operation, 'saved-final');
    assert.equal(report.requests.filter((request) => request.kind === 'text').length, 1, 'asset replay never reconverts saved final text');
    assert.equal(report.requests.filter((request) => request.kind === 'image').length, 5);
    assert.equal(customTasks(fifth.project).find((task) => task.id === ruleTask.id).resultAssetId, ruleAsset.id);
    assert.equal(fifth.project.assets.find((asset) => asset.id === ruleAsset.id).prompt, finalRulePrompt);
    await openCustom(); assert.equal(await input.inputValue(), unsentDraft); await controlsFit(); await screenshot('complete-history-1280x800');
    report.stages.push('task and asset regeneration reuse saved final prompt with zero additional text requests; old results and unsent draft remain');
    assert.deepEqual(report.fixtureErrors, []); assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.blockedRequests, []);
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {});
} finally {
  harness?.markElectronStopping(); await browser?.close().catch(() => {});
  await harness?.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  if (harness) await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, packagedElectron: true, stages: report.stages,
  requestCounts: { text: report.requests.filter((request) => request.kind === 'text').length, image: report.requests.filter((request) => request.kind === 'image').length },
  failure: report.failure?.message, report: path.join(output, 'report.json') }, null, 2));
