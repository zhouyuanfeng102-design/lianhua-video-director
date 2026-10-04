import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const baseOutput = path.join(root, 'output', 'playwright');
const packageVersion = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/[^\w.-]/gu, '_');
const output = path.resolve(process.env.QA_OUTPUT || path.join(baseOutput, `localized-task-errors-${packageVersion}-${Date.now()}`));
const relative = path.relative(baseOutput, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Localized-error QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Localized-error QA cannot traverse output links');
fs.mkdirSync(output, { recursive: true });
// Entirely synthetic strings. They deliberately exercise both labelled payload
// filtering and the configured-key / actual-task-prompt redaction integration.
const fakeKnownKey = 'qa-credential-fixture-never-a-real-key-672819';
const fakePrompt = '隔离验收私密剧情：演员穿着蓝色外套站在廊桥边，手持一本虚构的测试册，镜头保持自然光和中景。';
const fakeNodePrompt = 'A synthetic private video description assigned to workflow node seventeen.';
const fakeToken = 'qa-url-query-token-672819';
const fakeUrlUser = 'qa-url-user-672819';
const fakeUrlPassword = 'qa-url-password-672819';
const fakeBearer = 'qa-authorization-token-672819';
const tlsRaw = "Error invoking remote method 'lianhua:http-request': Error: Client network socket disconnected before secure TLS connection was established";
const sensitiveTlsRaw = `${tlsRaw}; HTTP 502; code=ECONNRESET; stage=tls-handshake; route=system-proxy; endpoint=https://${fakeUrlUser}:${fakeUrlPassword}@images.fixture.invalid/v1/private-generate?token=${fakeToken}; echoed=${fakePrompt}; memo=${fakeKnownKey}; Authorization=Bearer ${fakeBearer}; requestBody={"prompt":"${fakePrompt}","apiKey":"${fakeKnownKey}"}`;
const forbiddenDiagnostics = [fakeKnownKey, fakePrompt, fakeNodePrompt, fakeToken, fakeUrlUser, fakeUrlPassword, fakeBearer, 'v1/private-generate', 'private-node-input', 'private-node-traceback', 'private-node-pixels'];
const samples = [
  { id: 'h3-identity-schema', stage: 'storyboard-convert', unchangedSummary: true, raw: '最终视频提示词生成失败：AI已自动重试修复交付排程3次，仍未返回可同步的数据：AI交付identityBindings格式无效（本地交付数据校验）：字段“identityBindings.characters[0].speakerToken”：要求正文已有的声源编号标签，未使用时省略；实际布尔值。', expected: 'identityBindings.characters[0].speakerToken', details: ['本地交付数据校验', '实际布尔值'], technicalContains: ['identityBindings.characters[0].speakerToken'] },
  { id: 'h3-shot-schema', stage: 'storyboard-convert', unchangedSummary: true, raw: '最终视频提示词生成失败：AI交付元数据格式无效（本地交付数据校验）：第1镜，字段“shotMetadata[0].sourceBeatIds”：要求来源节拍编号字符串数组；实际字符串（10字符）。', expected: 'shotMetadata[0].sourceBeatIds', details: ['第1镜', '实际字符串（10字符）'], technicalContains: ['shotMetadata[0].sourceBeatIds'] },
  { id: 'h3-identity-legacy', stage: 'storyboard-convert', unchangedSummary: true, raw: '最终视频提示词生成失败：AI已自动重试修复交付排程3次，仍未返回可同步的数据：AI交付identityBindings格式无效，不能静默丢弃已声明的绑定记录。', expected: 'identityBindings格式无效', details: ['3次', '不能静默丢弃'], technicalContains: ['identityBindings格式无效'] },
  { id: 'h3-legacy-protocol', stage: 'storyboard-convert', raw: '最终视频提示词生成失败：AI已自动重试修复H3格式3次，但返回内容仍不符合官方格式：缺少完整H3官方section、连续[Shot N]或逐镜At切点，或返回了普通六字段时间轴。本次新结果未保存，原有结果保持不变。', expected: '普通六字段时间轴', details: ['3次', '原有结果保持不变'], technicalContains: ['缺少完整H3官方section、连续[Shot N]或逐镜At切点'] },
  { id: 'h3-specific-section', stage: 'storyboard-convert', unchangedSummary: true, raw: '最终视频提示词生成失败：AI已自动重试修复H3格式3次（中文阶段），但返回内容仍不符合官方格式：H3缺少必需章节：“summary”；章节标题必须使用正式字段名和半角冒号。本次新结果未保存，原有结果保持不变。', expected: 'H3缺少必需章节：“summary”', details: ['中文阶段', '原有结果保持不变'], technicalContains: ['H3缺少必需章节：“summary”'] },
  { id: 'tls-historical', raw: tlsRaw, expected: 'TLS 加密连接尚未建立就已断开', technicalContains: ['Client network socket disconnected before secure TLS connection was established'] },
  { id: 'tls-sensitive', raw: sensitiveTlsRaw, prompt: fakePrompt, expected: 'TLS 加密连接尚未建立就已断开', details: ['HTTP 502', 'ECONNRESET'], technicalContains: ['Client network socket disconnected before secure TLS connection was established', 'HTTP 状态：502', '错误码：ECONNRESET', 'tls-handshake', '传输路由：system-proxy', '服务地址（仅域名）：https://images.fixture.invalid', '[已脱敏]'] },
  { id: 'image-quota', raw: '图像接口请求失败：No available image quota. Please try again later.', expected: '上游当前没有可用的图像生成额度，请稍后重试' },
  { id: 'image-overloaded', raw: '图像接口请求失败：System is overloaded. Please try again later.', expected: '上游服务当前负载过高，请稍后重试' },
  { id: 'image-overloaded-status', raw: '图像接口请求失败（HTTP 503）：System is overloaded. Please try again later.（错误码：server_overloaded）', expected: '上游服务当前负载过高，请稍后重试', details: ['HTTP 503', 'server_overloaded'] },
  { id: 'upstream', raw: '图像接口请求失败：Upstream did not return the expected image. Please adjust your prompt.', expected: '上游服务未返回预期图像' },
  { id: 'safety', raw: '图像接口请求失败：The generated image was filtered by the safety policy. Please adjust your prompt and try again.', expected: '生成的图像被安全策略拦截' },
  { id: 'upstream-safety-zh', raw: '图像接口请求失败：您的请求无法用于生成图像。该请求可能因安全政策被拦截，或不适合进行图像生成。', expected: '上游图像接口返回了内容安全拒绝' },
  { id: 'png', raw: "Error invoking remote method 'lianhua:store-generated-image': Error: 生成图片的 PNG 文件签名无效。", expected: 'PNG 文件签名无效' },
  { id: 'comfy-workflow', raw: '当前 ComfyUI Workflow 没有连接到输出的 LoadImage 参考图节点。请导入带 LoadImage/IPAdapter 或图生图链路的 API Workflow。', expected: '没有连接到输出的 LoadImage 参考图节点' },
  { id: 'unknown', raw: 'Provider returned an unexpected ceremonial teapot.', expected: '无法识别具体原因', technicalContains: ['Provider returned an unexpected ceremonial teapot.'] },
];
const videoError = 'api queue limit reached, please retry later | API 并发数已达上线，请降低并发或稍后重试';
const storageKey = 'lianhua_video_director_state_v22';
const logKey = 'lianhua_runtime_error_log_v1';
const port = await findAvailableTcpPort(); const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await s.listen(); console.log('Localized errors isolated UI ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'localized task error UI QA', runTimeoutMs: 100_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; const errors = []; const displays = []; const detailDisplays = []; const blockedRequests = []; const executionChecks = [];

const assertSafeDiagnostics = (text, label) => {
  for (const forbidden of forbiddenDiagnostics) assert.ok(!text.includes(forbidden), `${label} leaked a synthetic credential, URL secret or original prompt`);
};

const assertSmallWindowLayout = async (label, panel) => {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(dimensions.width, 1280); assert.equal(dimensions.height, 800);
  assert.ok(dimensions.scrollWidth <= dimensions.width + 2, `${label}: page must not overflow horizontally`);
  const metrics = await panel.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const pre = node.querySelector('pre');
    const button = node.querySelector('button');
    const buttonBox = button?.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      preScrollWidth: pre?.scrollWidth, preClientWidth: pre?.clientWidth, buttonLeft: buttonBox?.left, buttonRight: buttonBox?.right };
  });
  assert.ok(metrics.left >= -2 && metrics.right <= dimensions.width + 2, `${label}: diagnostic card must fit viewport`);
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, `${label}: long diagnostics must wrap inside card`);
  assert.ok(metrics.preScrollWidth <= metrics.preClientWidth + 2, `${label}: detail text must not require horizontal scrolling`);
  assert.ok(metrics.buttonLeft >= -2 && metrics.buttonRight <= dimensions.width + 2, `${label}: copy action must remain reachable`);
};

const run = async () => {
  await waitForCondition({ label: 'localized errors Vite startup', timeoutMs: 35_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }); page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ png, key, knownKey }) => {
    if (!sessionStorage.getItem('__localized_errors_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__localized_errors_qa__', '1'); }
    // Real desktop state restores credentials outside the scrubbed browser
    // cache. This browser-only harness has no filesystem bridge; supply only
    // its synthetic credential again on reload, without altering preferences,
    // tasks, provider enablement, logs or any real profile.
    const cached = localStorage.getItem(key);
    if (cached) {
      const state = JSON.parse(cached);
      if (state.project?.id === 'localized-errors-project') {
        state.settings.imageApi.apiKey = knownKey;
        state.settings.videoTaskApi.apiKey = knownKey;
        localStorage.setItem(key, JSON.stringify(state));
      }
    }
    const countsKey = '__localized_errors_qa_counts__';
    window.__localizedQa = JSON.parse(sessionStorage.getItem(countsKey) || '{"apiCalls":0,"exportAttempts":0,"clipboard":[]}');
    const persistCounts = () => sessionStorage.setItem(countsKey, JSON.stringify(window.__localizedQa));
    const disallowApi = async () => { window.__localizedQa.apiCalls += 1; persistCounts(); throw new Error('No API allowed in error-display QA'); };
    // Never read or write the real user's clipboard.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__localizedQa.clipboard.push(String(text)); persistCounts(); } } });
    window.lianhuaDesktop = {
      request: disallowApi,
      videoRequest: disallowApi,
      onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
      exportProjectPackage: async () => { window.__localizedQa.exportAttempts += 1; persistCounts(); throw new Error(png); },
    };
  }, { png: samples.find((item) => item.id === 'png')?.raw || '', key: storageKey, knownKey: fakeKnownKey });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const localRead = url.origin === new URL(baseUrl).origin && /^https?:$/u.test(url.protocol) && ['GET', 'HEAD'].includes(request.method());
    if (!localRead && !['data:', 'blob:'].includes(url.protocol)) {
      blockedRequests.push({ origin: url.origin, method: request.method() });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await context.routeWebSocket(/.*/u, (socket) => {
    const url = new URL(socket.url());
    // Vite's own client may connect even with hot updates disabled. Only its
    // exact loopback host/port is allowed; provider WebSockets remain blocked.
    if (url.hostname === '127.0.0.1' && url.port === String(port)) socket.connectToServer();
    else { blockedRequests.push({ protocol: 'websocket', origin: url.origin }); socket.close(); }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 35_000 }); await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, logs, cases, videoRaw, knownKey, privatePrompt, privateNodePrompt }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 108; const paint = canvas.getContext('2d'); paint.fillStyle = '#879fb5'; paint.fillRect(0, 0, 144, 108); paint.fillStyle = '#fff'; paint.fillText('PRESERVED IMAGE', 10, 55);
    const image = { id: 'preserved-image', name: '原图片保留验证', type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', dataUrl: canvas.toDataURL('image/png'), width: 144, height: 108, tags: ['合成SFW'], createdAt: now, updatedAt: now };
    const prompt = '林澜身着蓝色外套站在廊桥边，画面保持自然光和中景。';
    const tasks = cases.map((item) => ({ id: `localized-${item.id}`, kind: 'image', name: `历史错误-${item.id}`, assetKind: 'character', imageVariant: 'portrait', status: 'failed', prompt: item.prompt || prompt, negativePrompt: '保持原负面提示', width: 144, height: 108, backend: 'openai', model: 'fixture-image-model', resultAssetId: image.id, error: item.raw, createdAt: now, updatedAt: now }));
    tasks.push({ id: 'localized-video', kind: 'video', storyboardId: '', targetId: 'fixture-video', status: 'failed',
      requestBody: { prompt: privatePrompt, nodeInfoList: [{ nodeId: '17', fieldName: 'text', fieldValue: privateNodePrompt }] },
      error: videoRaw, response: { errorCode: 'RH_QUEUE_FULL', statusCode: 429, errorMessage: videoRaw,
        failedReason: { node_id: '17', node_type: 'VideoSampler', exception_type: 'VendorCapacityError',
          exception_message: `Provider concurrency diagnostic; echoed=${privatePrompt}; node=${privateNodePrompt}; memo=${knownKey}`,
          current_inputs: { custom: 'private-node-input' }, traceback: ['private-node-traceback'], current_outputs: ['private-node-pixels'] } },
      createdAt: now, updatedAt: now, videoJob: { stage: 'failed', message: videoRaw, completedAt: now, snapshot: {
        projectId: 'localized-errors-project', clientId: 'fixture-client', draft: { name: '历史视频并发上限失败', prompt: privatePrompt,
          backend: 'api', references: [], parameters: { seed: 424242 } }, connection: { backend: 'api', api: {
          provider: 'runninghub', enabled: false, endpoint: '', statusEndpointTemplate: '', authHeader: 'Authorization', authScheme: 'Bearer',
          taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' } }, images: [] } } });
    tasks.push({ id: 'localized-autofill', kind: 'autofill', name: '资料补充验证', assetKind: 'character', status: 'succeeded', requestedFields: ['外貌'], model: 'fixture-text-model', result: { 外貌: '深色短发，灰蓝色眼睛' }, createdAt: now, updatedAt: now });
    state.project = { ...state.project, id: 'localized-errors-project', name: '中文报错隔离验收', sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], assets: [image], generationTasks: tasks, characters: [], locations: [], props: [], updatedAt: now }; state.projects = [state.project]; state.activeProjectId = state.project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
    state.settings.imageApi.apiKey = knownKey;
    state.settings.videoTaskApi.apiKey = knownKey;
    state.settings.videoExecutionMode = 'queue'; state.settings.videoExecutionConcurrency = 1;
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(logs, JSON.stringify(cases.map((item, index) => ({ id: `raw-log-${item.id}`, occurredAt: now - index, stage: item.stage || 'image-generation', message: item.raw, projectId: state.project.id, projectName: state.project.name }))));
  }, { key: storageKey, logs: logKey, cases: samples, videoRaw: videoError, knownKey: fakeKnownKey, privatePrompt: fakePrompt, privateNodePrompt: fakeNodePrompt });
  await page.reload({ waitUntil: 'networkidle', timeout: 35_000 });
  const readStored = () => page.evaluate(({ key, logs }) => { const state = JSON.parse(localStorage.getItem(key)); return { assets: state.project.assets, tasks: state.project.generationTasks, logs: JSON.parse(localStorage.getItem(logs)) }; }, { key: storageKey, logs: logKey });
  const before = await readStored();
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: `图片任务，${samples.length} 个`, exact: true }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: '视频任务，1 个', exact: true }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: '资料任务，1 个', exact: true }).count(), 1);
  for (const item of samples) {
    const panel = page.locator(`#image-task-localized-${item.id} .task-error-details`);
    const message = panel.locator('.task-error-summary');
    await message.waitFor(); const text = await message.innerText();
    assert.equal(await panel.locator('details').getAttribute('open'), null, 'technical details start collapsed');
    assert.equal(await panel.locator('pre').isVisible(), false, 'folded raw detail must not be visible');
    assert.ok(text.includes(item.expected), `${item.id} should have a meaningful Chinese display: ${text}`);
    assert.doesNotMatch(text, /Upstream did not|The generated image|Please adjust|Error invoking|ceremonial teapot|No available image quota|System is overloaded|Please try again later/iu);
    for (const detail of item.details || []) assert.ok(text.includes(detail), `${item.id} must retain ${detail}`);
    if (item.id === 'unknown') assert.doesNotMatch(text, /安全策略|未返回.*图像|密钥无效/u, 'unknown English must not invent a known cause');
    if (item.id.startsWith('h3-')) assert.doesNotMatch(text, /未识别的错误|暂时无法确定|上游服务/u, 'known H3 format evidence must not be presented as an unknown provider failure');
    assertSafeDiagnostics(text, `${item.id} summary`);
    displays.push({ id: item.id, text });
    if (item.technicalContains) {
      await panel.locator('summary').click();
      const detail = await panel.locator('pre').innerText();
      for (const expected of item.technicalContains) assert.ok(detail.includes(expected), `${item.id} raw details must preserve ${expected}`);
      assertSafeDiagnostics(detail, `${item.id} technical details`);
      await panel.getByRole('button', { name: '复制错误详情', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: '已复制（敏感信息已脱敏）' }).waitFor();
      const copied = await page.evaluate(() => window.__localizedQa.clipboard.at(-1));
      assert.equal(copied, detail, 'mocked clipboard receives exactly the safe visible details');
      assertSafeDiagnostics(copied, `${item.id} copied details`);
      await assertSmallWindowLayout(`image ${item.id}`, panel);
      await page.screenshot({ path: path.join(output, `localized-${item.id}-details.png`), fullPage: false });
      detailDisplays.push({ id: item.id, detail, copiedMatchesVisible: true });
      await panel.locator('summary').click();
    }
  }
  await page.locator('#image-task-localized-upstream').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'localized-image-errors.png'), fullPage: false });
  await page.locator('#image-task-localized-image-quota').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'localized-image-capacity-errors.png'), fullPage: false });
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
  assert.equal(await page.locator('[id^="image-task-"]').count(), 0, 'image tasks must not remain visible in the video category');
  const videoCard = page.locator('[data-video-task-id="localized-video"]');
  const videoPanel = videoCard.locator('.task-error-details');
  assert.equal(await videoPanel.count(), 1, 'a failed video has one merged error panel');
  assert.equal(await videoCard.locator('.vd-task-message').count(), 0, 'do not repeat the same error as a grey status line');
  const videoText = await videoPanel.locator('.task-error-summary').innerText();
  assert.match(videoText, /接口并发生成数量已达上限，请等待正在运行的任务完成后再试/u);
  assert.equal((videoText.match(/接口并发生成数量已达上限/gu) || []).length, 1, 'provider node metadata must not duplicate the main cause');
  assert.match(videoText, /429/u); assert.match(videoText, /RH_QUEUE_FULL/u); assert.doesNotMatch(videoText, /余额|充值|提示词错误|本地.*拦截|未识别|暂时无法/u);
  assertSafeDiagnostics(videoText, 'video summary');
  assert.equal(await videoPanel.locator('pre').isVisible(), false);
  await videoPanel.locator('summary').click();
  const videoDetail = await videoPanel.locator('pre').innerText();
  for (const expected of [videoError, 'RH_QUEUE_FULL', 'HTTP 状态：429', '节点：17', 'VideoSampler', 'VendorCapacityError', 'Provider concurrency diagnostic', '[已脱敏]']) assert.ok(videoDetail.includes(expected), `video details must preserve ${expected}`);
  assertSafeDiagnostics(videoDetail, 'video technical details');
  await videoPanel.getByRole('button', { name: '复制错误详情', exact: true }).click();
  await videoPanel.getByRole('status').filter({ hasText: '已复制（敏感信息已脱敏）' }).waitFor();
  assert.equal(await page.evaluate(() => window.__localizedQa.clipboard.at(-1)), videoDetail);
  assertSafeDiagnostics(await page.evaluate(() => window.__localizedQa.clipboard.at(-1)), 'copied video details');
  await assertSmallWindowLayout('video diagnostic', videoPanel);
  await page.screenshot({ path: path.join(output, 'localized-video-queue-limit-details.png'), fullPage: false });
  displays.push({ id: 'video', text: videoText, duplicateGreyStatus: false });
  detailDisplays.push({ id: 'video', detail: videoDetail, copiedMatchesVisible: true });
  await videoPanel.locator('summary').click();

  const executionMode = () => page.getByRole('combobox', { name: '视频执行方式', exact: true });
  const concurrency = () => page.getByRole('spinbutton', { name: '视频并发数量', exact: true });
  const storedExecution = () => page.evaluate((key) => {
    const { settings } = JSON.parse(localStorage.getItem(key));
    return { mode: settings.videoExecutionMode, count: settings.videoExecutionConcurrency };
  }, storageKey);
  const waitExecution = async (mode, count) => page.waitForFunction(({ key, mode, count }) => {
    const { settings } = JSON.parse(localStorage.getItem(key));
    return settings.videoExecutionMode === mode && settings.videoExecutionConcurrency === count;
  }, { key: storageKey, mode, count });
  const assertControlLayout = async (label) => {
    await page.locator('.video-execution-controls').scrollIntoViewIfNeeded();
    const size = await page.locator('.video-execution-controls').evaluate((node) => ({
      viewport: window.innerWidth, pageWidth: document.documentElement.scrollWidth,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      client: node.clientWidth, scroll: node.scrollWidth,
    }));
    assert.ok(size.pageWidth <= size.viewport + 2 && size.left >= -2 && size.right <= size.viewport + 2 && size.scroll <= size.client + 2, `${label}: controls must fit the small window`);
  };
  assert.equal(await executionMode().inputValue(), 'queue'); assert.equal(await concurrency().isDisabled(), true);
  await executionMode().selectOption('concurrent'); await concurrency().fill('3'); await waitExecution('concurrent', 3);
  assert.equal(await concurrency().isDisabled(), false); assert.equal(await page.locator('.video-execution-limit').innerText(), '每个连接最多同时生成 3 个视频');
  assert.match(await page.locator('.video-execution-controls').innerText(), /同一连接跨项目共用；不同连接分别执行/u);
  await assertControlLayout('video jobs concurrent');
  await page.screenshot({ path: path.join(output, 'video-execution-jobs-concurrent-3.png'), fullPage: false });
  executionChecks.push({ page: 'generation-jobs', mode: 'concurrent', count: 3, saved: true });
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  assert.equal(await executionMode().inputValue(), 'concurrent'); assert.equal(await concurrency().inputValue(), '3');
  await assertControlLayout('video director concurrent');
  await page.screenshot({ path: path.join(output, 'video-execution-director-concurrent-3.png'), fullPage: false });
  executionChecks.push({ page: 'video-director', mode: 'concurrent', count: 3, sharedAcrossPages: true });
  for (const invalid of ['0', '101']) {
    await concurrency().fill(invalid);
    assert.equal(await concurrency().getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('.video-execution-warning').innerText(), /当前输入未保存/u);
    assert.deepEqual(await storedExecution(), { mode: 'concurrent', count: 3 }, 'invalid concurrency cannot overwrite the saved limit');
    executionChecks.push({ invalid, rejected: true, savedCount: 3 });
  }
  await concurrency().fill('3');
  await page.reload({ waitUntil: 'networkidle', timeout: 35_000 });
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  assert.equal(await executionMode().inputValue(), 'concurrent'); assert.equal(await concurrency().inputValue(), '3');
  executionChecks.push({ page: 'video-director', afterReload: true, mode: 'concurrent', count: 3 });
  await executionMode().selectOption('queue'); await waitExecution('queue', 3);
  assert.equal(await concurrency().isDisabled(), true);
  assert.equal(await page.locator('.video-execution-limit').innerText(), '同一连接内等待当前视频结束，再提交下一项');
  assert.equal(await executionMode().locator('option:checked').innerText(), '排队生成（一次 1 个）');
  await assertControlLayout('video director serial queue');
  await page.screenshot({ path: path.join(output, 'video-execution-director-queue.png'), fullPage: false });
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
  assert.equal(await executionMode().inputValue(), 'queue'); assert.equal(await concurrency().isDisabled(), true);
  assert.equal(await concurrency().inputValue(), '3', 'queue mode keeps the preferred parallel count but uses an effective limit of one');
  executionChecks.push({ page: 'generation-jobs', mode: 'queue', preferredCount: 3, effectiveCount: 1, noHistoricalRetry: true });
  await page.getByRole('tab', { name: '资料任务，1 个', exact: true }).click();
  assert.equal(await page.locator('[data-video-task-id]').count(), 0, 'video tasks must not remain visible in the data category');
  assert.equal(await page.locator('[id^="image-task-"]').count(), 0, 'image tasks must not remain visible in the data category');
  assert.equal(await page.locator('#autofill-task-localized-autofill').count(), 1, 'the data category must contain the autofill task');
  await page.locator('.runtime-error-log-trigger').click(); const dialog = page.getByRole('dialog', { name: '报错日志', exact: true });
  const logTexts = await dialog.locator('.runtime-error-log-entry .task-error-summary').allTextContents();
  assert.equal(logTexts.length, samples.length);
  samples.forEach((item, index) => {
    assert.ok(logTexts[index].includes(item.expected));
    if (item.id.startsWith('h3-')) assert.doesNotMatch(logTexts[index], /未识别的错误|暂时无法确定|上游服务/u);
    assert.doesNotMatch(logTexts[index], /No available image quota|System is overloaded|Please try again later/iu);
    for (const detail of item.details || []) assert.ok(logTexts[index].includes(detail), `${item.id} log must retain ${detail}`);
    if (item.unchangedSummary) assert.equal(logTexts[index], item.raw);
    else if (item.id !== 'comfy-workflow') assert.ok(logTexts[index] !== item.raw);
    assertSafeDiagnostics(logTexts[index], `${item.id} log summary`);
  });
  for (const [index, item] of samples.entries()) {
    if (!item.technicalContains) continue;
    const entry = dialog.locator('.runtime-error-log-entry').nth(index);
    const panel = entry.locator('.task-error-details');
    assert.equal(await panel.locator('pre').isVisible(), false);
    await panel.locator('summary').click();
    const detail = await panel.locator('pre').innerText();
    for (const expected of item.technicalContains) assert.ok(detail.includes(expected), `${item.id} log detail must preserve ${expected}`);
    assertSafeDiagnostics(detail, `${item.id} log detail`);
    await panel.getByRole('button', { name: '复制错误详情', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '已复制（敏感信息已脱敏）' }).waitFor();
    assert.equal(await page.evaluate(() => window.__localizedQa.clipboard.at(-1)), detail, 'logs also copy safe raw diagnostics');
    await assertSmallWindowLayout(`log ${item.id}`, panel);
    await page.screenshot({ path: path.join(output, `localized-${item.id}-log-details.png`), fullPage: false });
    await panel.locator('summary').click();
  }
  await dialog.getByRole('button', { name: '复制日志', exact: true }).click();
  const copiedLog = await page.evaluate(() => window.__localizedQa.clipboard.at(-1));
  assert.match(copiedLog, /Client network socket disconnected before secure TLS connection was established/u, 'whole-log copying retains the genuine transport failure');
  assert.match(copiedLog, /Provider returned an unexpected ceremonial teapot/u, 'whole-log copying retains unknown diagnostic text');
  assertSafeDiagnostics(copiedLog, 'whole copied log');
  await page.screenshot({ path: path.join(output, 'localized-log-display.png'), fullPage: false });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.top-action-export').click(); const notice = page.locator('.sidebar-notice.error'); await notice.waitFor();
  assert.match(await notice.innerText(), /PNG 文件签名无效/u); assert.doesNotMatch(await notice.innerText(), /Error invoking|lianhua:store/u); assert.doesNotMatch(await notice.getAttribute('title'), /Error invoking|lianhua:store/u);
  const after = await readStored(); assert.deepEqual(after, before, 'presentation must not rewrite original task/log errors, prompts, images or parameters');
  for (const item of samples) assert.equal(after.tasks.find((task) => task.id === `localized-${item.id}`).error, item.raw);
  assert.equal(after.tasks.find((task) => task.id === 'localized-video').error, videoError);
  const counts = await page.evaluate(() => window.__localizedQa); assert.equal(counts.apiCalls, 0); assert.equal(counts.exportAttempts, 1); assert.equal(counts.clipboard.length, samples.filter((item) => item.technicalContains).length * 2 + 2); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const report = { version: packageVersion, mockOnly: true, noProductionDataRead: true, freshBrowserProfile: true, viewport: { width: 1280, height: 800 }, displays, detailDisplays, executionChecks, logTexts, notice: await notice.innerText(), rawStateAndLogsPreserved: true, originalImageAndPromptsPreserved: true, copiedDiagnosticsRedacted: true, wholeLogCopyRedacted: true, clipboardMockOnly: true, apiCalls: counts.apiCalls, automaticRetries: 0, mockedExportFailure: true, errors, blockedRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), displays, errors }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
