import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated browser fixture only: this test clears browser storage before the app
// boots, serves Vite on loopback, and rejects every non-loopback request.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'video-batch'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Batch video QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Batch video QA output must not traverse directory links');
}
fs.mkdirSync(outputDirectory, { recursive: true });

const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const viteBootstrap = `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated batch video QA Vite ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', viteBootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({
  electron: vite,
  qaLabel: 'isolated long-story batch video UI QA',
  runTimeoutMs: 240_000,
  closeTimeoutMs: 10_000,
});

let browser;
let context;
let page;
const errors = [];
const stages = [];
const screenshots = [];

const visibleControlLayout = async (scopeSelector) => page.evaluate((selector) => {
  const scope = document.querySelector(selector);
  if (!scope) return { missing: selector, viewport: { width: innerWidth, height: innerHeight }, overflow: [], occluded: [], overlaps: [] };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const closedDetails = element.closest('details:not([open])');
    if (closedDetails && element.tagName !== 'SUMMARY') return false;
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      && box.width > 1 && box.height > 1 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  };
  const clippedRect = (element) => {
    const box = element.getBoundingClientRect();
    let left = Math.max(0, box.left); let right = Math.min(innerWidth, box.right);
    let top = Math.max(0, box.top); let bottom = Math.min(innerHeight, box.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor); const clip = ancestor.getBoundingClientRect();
      if (/(?:auto|scroll|hidden|clip)/u.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (/(?:auto|scroll|hidden|clip)/u.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      if (ancestor === scope) break;
    }
    return right - left > 2 && bottom - top > 2 ? { left, right, top, bottom, width: right - left, height: bottom - top } : undefined;
  };
  const controls = [...scope.querySelectorAll('button,input,select,textarea,summary,[role="tab"]')]
    .filter((element, index, all) => visible(element) && all.indexOf(element) === index)
    .map((element) => ({ element, rect: clippedRect(element) })).filter((item) => item.rect);
  const identify = (element) => element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) || `${element.tagName}.${element.className}`;
  const overflow = [...scope.querySelectorAll('*')].filter(visible).flatMap((element) => {
    const box = element.getBoundingClientRect();
    return box.left < -1 || box.right > innerWidth + 1
      ? [{ element: identify(element), left: Math.round(box.left), right: Math.round(box.right) }]
      : [];
  }).slice(0, 20);
  const occluded = controls.flatMap(({ element, rect: box }) => {
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === element || element.contains(hit) || hit.contains(element))
      ? [] : [{ element: identify(element), hit: hit ? identify(hit) : 'none', x: Math.round(x), y: Math.round(y) }];
  });
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    const { element: left, rect: a } = controls[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const { element: right, rect: b } = controls[rightIndex];
      if (left.contains(right) || right.contains(left)) continue;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 2 && height > 2) overlaps.push({ left: identify(left), right: identify(right), width: Math.round(width), height: Math.round(height) });
    }
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentScrollWidth: document.documentElement.scrollWidth,
    overflow,
    occluded,
    overlaps: overlaps.slice(0, 20),
  };
}, scopeSelector);

const assertCleanLayout = (layout, label) => {
  assert.equal(layout.missing, undefined, `${label}: scope exists`);
  assert.ok(layout.documentScrollWidth <= layout.viewport.width + 1, `${label}: horizontal document overflow ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.overflow, [], `${label}: visible content escapes the viewport`);
  assert.deepEqual(layout.occluded, [], `${label}: an interactive control is covered`);
  assert.deepEqual(layout.overlaps, [], `${label}: interactive controls overlap`);
};

const waitForExactText = async (locator, expected) => locator.evaluate((element, text) => new Promise((resolve, reject) => {
  const matches = () => element.textContent === text;
  if (matches()) { resolve(true); return; }
  const observer = new MutationObserver(() => {
    if (!matches()) return;
    observer.disconnect(); clearTimeout(timer); resolve(true);
  });
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out waiting for: ${text}; current: ${element.textContent}`)); }, 10_000);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
}), expected);

const assertControlHit = async (locator, label) => {
  const hit = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2; const y = box.top + box.height / 2;
    const target = document.elementFromPoint(x, y);
    return {
      ok: Boolean(target && (target === element || element.contains(target) || target.contains(element))),
      target: target?.getAttribute('aria-label') || target?.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) || target?.tagName || 'none',
      box: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) },
    };
  });
  assert.ok(hit.ok, `${label} must be the topmost hit target: ${JSON.stringify(hit)}`);
};

const run = async () => {
  await waitForCondition({
    label: 'batch video QA Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => {
      try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    },
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1120, height: 720 } });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.addInitScript(({ origin }) => {
    if (!sessionStorage.getItem('__video_batch_ui_qa__')) {
      localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__video_batch_ui_qa__', '1');
    }
    window.__videoBatchQa = { requests: [], posts: [], credentials: {}, checkpoints: {} };
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        if (!request.url.startsWith(origin)) throw new Error(`QA rejected non-local video endpoint: ${request.url}`);
        const method = request.method || 'GET';
        window.__videoBatchQa.requests.push({ url: request.url, method, body: request.body });
        if (method === 'POST') {
          const ordinal = window.__videoBatchQa.posts.length + 1;
          const entry = { ordinal, url: request.url, body: request.body };
          window.__videoBatchQa.posts.push(entry);
          return json({ id: `qa-batch-remote-${ordinal}`, status: 'queued' });
        }
        return json({ id: request.url.split('/').pop(), status: 'queued', progress: 0 });
      },
      cancelVideoRequest: async () => true,
      watchVideoProgress: async () => {},
      unwatchVideoProgress: async () => true,
      onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => {
        if (apiKey) window.__videoBatchQa.credentials[taskId] = apiKey;
        else delete window.__videoBatchQa.credentials[taskId];
        return { persisted: true };
      },
      getVideoTaskCredential: async (taskId) => window.__videoBatchQa.credentials[taskId] ?? null,
      saveVideoTaskCheckpoint: async (task) => {
        window.__videoBatchQa.checkpoints[task.id] = structuredClone(task);
        return { persisted: true };
      },
      getVideoTaskCheckpoint: async (taskId) => structuredClone(window.__videoBatchQa.checkpoints[taskId] || null),
      deleteVideoTaskCheckpoint: async (taskId) => { delete window.__videoBatchQa.checkpoints[taskId]; return { deleted: true }; },
      downloadGeneratedMedia: async () => { throw new Error('Queued-only batch QA must not download media'); },
      assetStatus: async () => ({ exists: true }),
      revealAsset: async () => true,
    };
  }, { origin: new URL(baseUrl).origin });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push(`Unexpected non-local request: ${route.request().url()}`);
    await route.abort('blockedbyclient');
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  const fixture = await page.evaluate(async ({ key, base }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const now = Date.now();
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const makeImage = (id, name, color, role) => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 160, 100); paint.fillStyle = '#fff'; paint.font = '16px sans-serif'; paint.fillText(name, 10, 54);
      return {
        id, name, type: role === 'character' ? 'character' : 'reference', role, referenceRole: role,
        mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'),
        checksum: `qa-checksum-${id}`, width: 160, height: 100, source: 'upload', tags: ['批量隔离验证'], createdAt: now, updatedAt: now,
      };
    };
    const assets = [
      makeImage('qa-base-character', '全片人物参考', '#775b8e', 'character'),
      makeImage('qa-extra-scene', '第一段额外场景', '#547b88', 'scene'),
      makeImage('qa-style-reference', '备用风格参考', '#9a6c54', 'style'),
    ];
    const segments = Array.from({ length: 15 }, (_, offset) => {
      const index = offset + 1;
      return {
        id: `qa-segment-${index}`, index, title: `剧情片段 ${String(index).padStart(2, '0')}`,
        globalStartSec: offset * 10, globalEndSec: index * 10, durationSec: 10,
        content: `第 ${index} 段隔离剧情`, summary: `第 ${index} 段摘要`, sourceSceneIds: ['qa-scene'], sourceBeatIds: [`qa-beat-${index}`],
        narrativePurpose: '推进长剧情', entryState: '承接上一段', exitState: '进入下一段', transitionHint: '动作连续',
        storyboardId: `qa-board-${index}`, status: 'ready',
      };
    });
    const plan = {
      id: 'qa-plan-15', title: '十五段一键批量验证', sourceStoryTitle: '十五段一键批量验证', sourceStoryContent: '仅存在浏览器内存的测试剧情',
      durationMode: 'ai-estimated', totalDurationSec: 150, segmentDurationSec: 10,
      segmentationMode: 'natural', segmentationSource: 'ai', fitStatus: 'balanced', planningStage: 'segmented',
      masterStoryboardId: 'qa-master-board',
      segments: [...segments].sort((left, right) => (left.index % 4) - (right.index % 4)),
      createdAt: now, updatedAt: now,
    };
    const board = (index) => {
      const zh = `【0s-10s】 主体：第 ${index} 段人物；动作：连续推进并完成本段动作；镜头：中景跟拍；光线：统一自然光；声音：环境声。`;
      const en = index === 7 ? zh : `【0s-10s】 Subject: segment ${index} character; continuous action and camera motion; natural light; ambient sound.`;
      return {
        id: `qa-board-${index}`, sceneId: 'qa-scene', sourceStoryTitle: '十五段一键批量验证',
        workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1,
        pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
        stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom',
        globalLock: '', globalReferenceAssetIds: ['qa-base-character'],
        finalPrompt: zh, englishPrompt: en, englishPromptSource: zh,
        officialPromptZh: zh, officialPromptEn: en, officialPromptSource: zh, officialPromptEnSource: zh,
        promptMigrationPending: false,
        promptTrace: {
          modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', stylePresetId: state.settings.defaultStylePresetId,
          sourceDocumentIds: [], referenceAssetIds: ['qa-base-character'], generatedAt: now, mode: 'text-api',
          convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete',
        },
        shots: [{
          id: `qa-shot-${index}`, index: 1, startSec: 0, endSec: 10, purpose: '推进剧情', subject: `第 ${index} 段人物`,
          action: '完成连续动作', camera: '中景跟拍', transition: '自然衔接', lighting: '统一自然光', sound: '环境声', result: '动作完成',
          referenceAssetIds: ['qa-base-character'], prompt: zh, locked: false,
        }],
        sequencePlanId: plan.id, segmentId: `qa-segment-${index}`, segmentIndex: index, segmentCount: 15,
        createdAt: now - index, updatedAt: now - index,
      };
    };
    const boards = Array.from({ length: 15 }, (_, offset) => board(offset + 1));
    const master = {
      ...board(1), id: 'qa-master-board', segmentId: undefined, segmentIndex: undefined,
      sourceStoryTitle: '禁止进入批量列表的全片母版', finalPrompt: 'MASTER MUST NOT APPEAR', officialPromptZh: 'MASTER MUST NOT APPEAR',
      officialPromptEn: 'MASTER MUST NOT APPEAR', officialPromptEnSource: 'MASTER MUST NOT APPEAR',
      promptTrace: { ...board(1).promptTrace, convertedPromptFingerprint: sourceContentHash('MASTER MUST NOT APPEAR') }, updatedAt: now + 1_000,
    };
    const scene = {
      id: 'qa-scene', title: '批量测试场景', content: '仅存在浏览器内存的测试剧情', summary: '十五段批量验证',
      characterIds: [], propIds: [], storyboardIds: [master.id, ...boards.map((item) => item.id)], createdAt: now, updatedAt: now,
    };
    state.settings.videoBackend = 'api';
    state.settings.activeVideoApiProfileId = null; state.settings.videoApiProfiles = [];
    state.settings.videoTaskApi = {
      ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'qa-batch-video',
      endpoint: `${base}qa-video`, statusEndpointTemplate: `${base}qa-video/{id}`, apiKey: '',
      taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result.url', progressPath: 'progress', requestTemplate: '',
    };
    state.settings.uiFontScalePercent = 150;
    const project = {
      ...state.project, id: 'qa-video-batch-project', name: '隔离批量视频项目', sourceDocuments: [], characters: [], locations: [], props: [],
      scenes: [scene], sequencePlans: [plan], storyboards: [master, ...boards], assets, generationTasks: [], updatedAt: now,
    };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    const { buildVideoBatchRows } = await import('/src/videoBatch.ts');
    const rows = buildVideoBatchRows(project, plan, state.settings);
    const { apiKey: _secret, ...safeApi } = state.settings.videoTaskApi;
    const successfulEnglishTasks = rows.slice(5, 10).map((row, offset) => {
      const candidate = row.en;
      return {
        id: `qa-existing-en-${row.segmentIndex}`, kind: 'video', storyboardId: candidate.storyboardId, targetId: safeApi.model,
        status: 'succeeded', requestBody: { prompt: candidate.draft.prompt }, requestFingerprint: candidate.requestFingerprint,
        sequencePlanId: plan.id, segmentId: row.segmentId, segmentIndex: row.segmentIndex,
        ...(offset < 3 ? {
          batchId: 'qa-history-batch-3', batchLabel: '历史英文三段批次', batchItemKey: candidate.key,
          batchIndex: offset + 1, batchTotal: 3, batchConcurrency: 1,
        } : {}),
        createdAt: now - 20_000 - offset, updatedAt: now - 10_000 - offset,
        videoJob: {
          stage: 'succeeded', completedAt: now - 10_000 - offset,
          snapshot: {
            projectId: project.id, draft: structuredClone(candidate.draft), connection: { backend: 'api', api: safeApi }, clientId: `qa-existing-client-${row.segmentIndex}`,
            images: candidate.draft.references.map((reference) => {
              const source = assets.find((asset) => asset.id === reference.assetId);
              return { ...reference, name: source.name, dataUrl: source.dataUrl, checksum: source.checksum, width: source.width, height: source.height, freezeState: 'frozen', frozenAt: now - 20_000 };
            }),
          },
        },
      };
    });
    const failedCandidate = rows[0].en;
    const cancelledCandidate = rows[1].en;
    const failedDraft = {
      ...structuredClone(failedCandidate.draft),
      name: '失败批次第 1 段原任务',
      prompt: 'FAILED BATCH ORIGINAL ENGLISH PROMPT — must be reviewed before retry.',
      parameters: { duration: 9, seed: 7001, retry_marker: 'original-failed-snapshot' },
    };
    const cancelledDraft = {
      ...structuredClone(cancelledCandidate.draft),
      name: '已取消批次第 2 段原任务',
      prompt: 'CANCELLED BEFORE POST — must not enter failed-item retry.',
      parameters: { duration: 8, seed: 7002, cancelled_marker: true },
    };
    const retryGroup = [
      {
        id: 'qa-retryable-failed-1', kind: 'video', storyboardId: failedCandidate.storyboardId, targetId: safeApi.model,
        status: 'failed', requestBody: { prompt: failedDraft.prompt, parameters: failedDraft.parameters }, error: 'isolated failure',
        sequencePlanId: plan.id, segmentId: rows[0].segmentId, segmentIndex: rows[0].segmentIndex,
        batchId: 'qa-failed-and-cancelled-batch', batchLabel: '失败与取消混合批次', batchItemKey: failedCandidate.key,
        batchIndex: 1, batchTotal: 2, batchConcurrency: 1, createdAt: now - 40_000, updatedAt: now - 30_000,
        videoJob: {
          stage: 'failed', message: 'isolated failure', completedAt: now - 30_000, batchQueueState: 'done',
          snapshot: {
            projectId: project.id, draft: failedDraft, connection: { backend: 'api', api: safeApi }, clientId: 'qa-retryable-failed-client',
            images: failedDraft.references.map((reference) => {
              const source = assets.find((asset) => asset.id === reference.assetId);
              return { ...reference, name: '失败任务冻结人物参考', dataUrl: source.dataUrl, checksum: source.checksum, freezeState: 'frozen', frozenAt: now - 40_000 };
            }),
          },
        },
      },
      {
        id: 'qa-cancelled-before-post-2', kind: 'video', storyboardId: cancelledCandidate.storyboardId, targetId: safeApi.model,
        status: 'draft', requestBody: { prompt: cancelledDraft.prompt, parameters: cancelledDraft.parameters },
        sequencePlanId: plan.id, segmentId: rows[1].segmentId, segmentIndex: rows[1].segmentIndex,
        batchId: 'qa-failed-and-cancelled-batch', batchLabel: '失败与取消混合批次', batchItemKey: cancelledCandidate.key,
        batchIndex: 2, batchTotal: 2, batchConcurrency: 1, createdAt: now - 39_000, updatedAt: now - 29_000,
        videoJob: {
          stage: 'stopped', message: '已在提交前停止', trackingStopped: true, batchQueueState: 'cancelled',
          preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
          snapshot: {
            projectId: project.id, draft: cancelledDraft, connection: { backend: 'api', api: safeApi }, clientId: 'qa-cancelled-client',
            images: cancelledDraft.references.map((reference) => {
              const source = assets.find((asset) => asset.id === reference.assetId);
              return { ...reference, name: source.name, dataUrl: source.dataUrl, checksum: source.checksum, freezeState: 'frozen', frozenAt: now - 39_000 };
            }),
          },
        },
      },
    ];
    project.generationTasks = [...successfulEnglishTasks, ...retryGroup];
    state.ui = { ...state.ui, activeView: 'video' };
    localStorage.setItem(key, JSON.stringify(state));
    return { rowCount: rows.length, duplicateTaskIds: successfulEnglishTasks.map((task) => task.id), retryGroupTaskIds: retryGroup.map((task) => task.id) };
  }, { key: storageKey, base: baseUrl });
  assert.equal(fixture.rowCount, 15);
  assert.equal(fixture.duplicateTaskIds.length, 5);
  assert.deepEqual(fixture.retryGroupTaskIds, ['qa-retryable-failed-1', 'qa-cancelled-before-post-2']);

  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  const reloadedFixture = await page.evaluate(async (key) => {
    const state = JSON.parse(localStorage.getItem(key));
    const { buildVideoBatchRows } = await import('/src/videoBatch.ts');
    const { videoPromptChoices } = await import('/src/videoDirectorDraft.ts');
    const plan = state.project.sequencePlans.find((item) => item.id === 'qa-plan-15');
    const rows = buildVideoBatchRows(state.project, plan, state.settings);
    return {
      boards: state.project.storyboards.length,
      choices: videoPromptChoices(state.project).length,
      rowChoices: rows.filter((row) => row.zh && row.en).length,
      firstBoard: state.project.storyboards.find((item) => item.id === 'qa-board-1'),
      firstSegment: plan?.segments.find((item) => item.id === 'qa-segment-1'),
    };
  }, storageKey);
  assert.equal(reloadedFixture.boards, 16, `fixture boards survived reload: ${JSON.stringify(reloadedFixture)}`);
  assert.equal(reloadedFixture.choices, 32, `fixture bilingual choices survived reload: ${JSON.stringify(reloadedFixture)}`);
  assert.equal(reloadedFixture.rowChoices, 15, `fixture rows retain both languages: ${JSON.stringify(reloadedFixture)}`);
  const sidebar = page.locator('.sidebar');
  await sidebar.getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator('.jobs-view').waitFor();
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
  const historyBatch = page.locator('[data-video-batch-id="qa-history-batch-3"]');
  assert.equal(await page.locator('[data-video-batch-id]').count(), 2);
  assert.ok((await historyBatch.innerText()).includes('共 3 项 · 中文 0 · 英文 3'));
  assert.ok((await historyBatch.innerText()).includes('成功 3'));
  const historyToggle = historyBatch.locator('.video-task-batch-toggle');
  assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await historyBatch.locator('.video-task-batch-items').count(), 0, 'a task batch is collapsed by default');
  await historyToggle.click();
  assert.equal(await historyToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await historyBatch.locator('[data-video-task-id]').count(), 3);
  stages.push('task page renders the historical and retry fixture batches separately; the successful batch is collapsed by default and expandable to three cards');
  await sidebar.getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const panel = page.locator('.vd-batch-panel');
  await panel.waitFor();
  const rows = panel.locator('.vd-batch-row');
  assert.equal(await rows.count(), 15, 'the master board is not rendered as a sixteenth row');
  const rowHeadings = await rows.locator('.vd-batch-row-main > strong').allTextContents();
  assert.deepEqual(rowHeadings, Array.from({ length: 15 }, (_, index) => `第 ${index + 1} 段 · 剧情片段 ${String(index + 1).padStart(2, '0')}`));
  assert.equal(await panel.getByText('MASTER MUST NOT APPEAR', { exact: true }).count(), 0);
  assert.equal(await panel.getByText('禁止进入批量列表的全片母版', { exact: true }).count(), 0);
  stages.push('15 rows are ordered 1-15 and the master storyboard is excluded');

  const summary = panel.locator('.vd-batch-summary strong');
  await panel.getByRole('button', { name: '全选中文', exact: true }).click();
  await waitForExactText(summary, '已选 15 段 · 待提交 15 段 · 跳过 0 段');
  assert.equal(await summary.textContent(), '已选 15 段 · 待提交 15 段 · 跳过 0 段');
  assert.deepEqual(await panel.locator('.vd-batch-language button[aria-pressed="true"]').allTextContents(), Array(15).fill('中文'));
  assert.equal(await panel.locator('.vd-batch-check input:checked').count(), 15);
  await panel.getByRole('button', { name: '全选英文', exact: true }).click();
  await waitForExactText(summary, '已选 15 段 · 待提交 10 段 · 跳过 5 段');
  assert.equal(await summary.textContent(), '已选 15 段 · 待提交 10 段 · 跳过 5 段');
  assert.deepEqual(await panel.locator('.vd-batch-language button[aria-pressed="true"]').allTextContents(), Array(15).fill('英文'));
  assert.equal(await panel.locator('.vd-batch-row-main').filter({ hasText: '已生成，将跳过' }).count(), 5);
  stages.push('Chinese and English select-all are independent; five exact English successes are skipped');

  await panel.getByRole('button', { name: '清空选择', exact: true }).click();
  const row = (index) => rows.nth(index - 1);
  await row(1).getByRole('button', { name: '中文', exact: true }).click();
  await row(1).getByRole('checkbox', { name: '选择第 1 段', exact: true }).check();
  await row(2).getByRole('checkbox', { name: '选择第 2 段', exact: true }).check();
  await row(3).getByRole('button', { name: '中文', exact: true }).click();
  await row(3).getByRole('checkbox', { name: '选择第 3 段', exact: true }).check();
  await waitForExactText(summary, '已选 3 段 · 待提交 3 段 · 跳过 0 段');
  assert.equal(await summary.textContent(), '已选 3 段 · 待提交 3 段 · 跳过 0 段');
  await panel.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '确认批量生成视频' });
  const mixed = await dialog.locator('.vd-batch-confirm-list > div > span').allTextContents();
  assert.equal(mixed.length, 3);
  assert.ok(mixed[0].startsWith('中文 ·'));
  assert.ok(mixed[1].startsWith('英文描述 ·'));
  assert.ok(mixed[2].startsWith('中文 ·'));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('free mixed selection keeps exactly one language choice for each selected segment');

  await row(1).getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '第 1 段 · 选择参考图' });
  assert.equal(await dialog.getByRole('button', { name: '取消选择图片 全片人物参考', exact: true }).getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '选择图片 第一段额外场景', exact: true }).click();
  await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
  assert.ok((await row(1).locator('.vd-batch-row-main').innerText()).includes('参考图 2 张'));
  await row(2).getByRole('button', { name: '第 2 段选择参考图', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '第 2 段 · 选择参考图' });
  assert.equal(await dialog.getByRole('button', { name: '选择图片 第一段额外场景', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await dialog.getByRole('button', { name: '取消选择图片 全片人物参考', exact: true }).getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await row(1).getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '第 1 段 · 选择参考图' });
  assert.equal(await dialog.getByRole('button', { name: '取消选择图片 第一段额外场景', exact: true }).getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('per-segment image choices remain isolated and persist when the segment is reopened');

  await panel.getByRole('button', { name: '全选英文', exact: true }).click();
  await waitForExactText(summary, '已选 15 段 · 待提交 10 段 · 跳过 5 段');
  assert.equal(await summary.textContent(), '已选 15 段 · 待提交 10 段 · 跳过 5 段');
  const regenerateSucceeded = panel.getByRole('checkbox', { name: '重新生成已成功项', exact: true });
  assert.equal(await regenerateSucceeded.isChecked(), false, 'successful duplicates must stay skipped by default');
  await regenerateSucceeded.check();
  await waitForExactText(summary, '已选 15 段 · 待提交 15 段 · 跳过 0 段');
  assert.ok((await row(6).innerText()).includes('已生成，将重新生成'));
  await panel.getByRole('button', { name: '检查并生成 15 段视频', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认批量生成视频' });
  assert.equal(await dialog.locator('.vd-batch-confirm-list > div').filter({ hasText: '重新生成（再次收费）' }).count(), 5);
  assert.equal(await dialog.getByRole('button', { name: '确认生成 15 段', exact: true }).count(), 1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await regenerateSucceeded.uncheck();
  await waitForExactText(summary, '已选 15 段 · 待提交 10 段 · 跳过 5 段');
  stages.push('successful duplicates remain skipped by default and require an explicit billable-regeneration review');
  const compactLayout = await visibleControlLayout('.vd-batch-panel');
  assertCleanLayout(compactLayout, '1120x720 at 150% font scale');
  await page.screenshot({ path: path.join(outputDirectory, 'batch-panel-1120x720-font-150.png'), fullPage: false });
  screenshots.push('batch-panel-1120x720-font-150.png');

  const advanced = panel.locator('.vd-batch-advanced');
  await advanced.locator('summary').click();
  assert.equal(await advanced.getAttribute('open'), '');
  const expandedLayout = await visibleControlLayout('.vd-batch-panel');
  assertCleanLayout(expandedLayout, 'expanded parameters at 1120x720 and 150% font scale');
  await assertControlHit(advanced.getByLabel('批量公共参数 JSON', { exact: true }), 'expanded public-parameter editor');
  await row(15).scrollIntoViewIfNeeded();
  await assertControlHit(row(15).getByRole('checkbox', { name: '选择第 15 段', exact: true }), 'last-row checkbox');
  await assertControlHit(row(15).getByRole('button', { name: '中文', exact: true }), 'last-row Chinese selector');
  await assertControlHit(row(15).getByRole('button', { name: '英文', exact: true }), 'last-row English selector');
  await assertControlHit(row(15).getByRole('button', { name: '预览', exact: true }), 'last-row preview');
  await assertControlHit(row(15).getByRole('button', { name: '第 15 段选择参考图', exact: true }), 'last-row image picker');
  await assertControlHit(row(15).getByRole('button', { name: '第 15 段复制上一段参考图', exact: true }), 'last-row copy-previous action');
  const listFooterBoundary = await panel.evaluate((element) => {
    const list = element.querySelector('.vd-batch-list').getBoundingClientRect();
    const footer = element.querySelector('.vd-batch-footer').getBoundingClientRect();
    return { listBottom: Math.round(list.bottom), footerTop: Math.round(footer.top), gap: Math.round(footer.top - list.bottom) };
  });
  assert.ok(listFooterBoundary.listBottom <= listFooterBoundary.footerTop + 1, `scroll list must end above the footer: ${JSON.stringify(listFooterBoundary)}`);
  await page.screenshot({ path: path.join(outputDirectory, 'batch-last-row-expanded-1120x720-font-150.png'), fullPage: false });
  screenshots.push('batch-last-row-expanded-1120x720-font-150.png');
  await advanced.locator('summary').click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await row(1).scrollIntoViewIfNeeded();
  const wideLayout = await visibleControlLayout('.vd-batch-panel');
  assertCleanLayout(wideLayout, '1280x800 at 150% font scale');
  await page.screenshot({ path: path.join(outputDirectory, 'batch-panel-1280x800-font-150.png'), fullPage: false });
  screenshots.push('batch-panel-1280x800-font-150.png');
  await page.setViewportSize({ width: 1120, height: 720 });
  stages.push('expanded parameters, last-row hit targets, footer boundary and 1280x800 layout remain unobstructed at 150% font scale');

  await panel.getByRole('button', { name: '检查并生成 10 段视频', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认批量生成视频' });
  assert.equal(await dialog.locator('.vd-batch-confirm-list > div').count(), 15);
  assert.equal(await dialog.locator('.vd-batch-confirm-list > div').filter({ hasText: '将跳过' }).count(), 5);
  assert.equal(await dialog.locator('.vd-batch-confirm-list > div').filter({ hasText: '待提交' }).count(), 10);
  const dialogLayout = await visibleControlLayout('.vd-batch-confirm-dialog');
  assertCleanLayout(dialogLayout, 'batch confirmation at 1120x720 and 150% font scale');
  await page.screenshot({ path: path.join(outputDirectory, 'batch-confirm-1120x720-font-150.png'), fullPage: false });
  screenshots.push('batch-confirm-1120x720-font-150.png');
  await dialog.getByRole('checkbox', { name: '确认批量生成费用', exact: true }).check();
  await dialog.getByRole('button', { name: '确认生成 10 段', exact: true }).evaluate((button) => { button.click(); button.click(); });

  await page.locator('.jobs-view').waitFor({ timeout: 40_000 });
  await page.waitForFunction(() => window.__videoBatchQa.posts.length === 10, undefined, { timeout: 60_000 });
  await page.waitForTimeout(750);
  const postBodies = await page.evaluate(() => window.__videoBatchQa.posts.map((entry) => JSON.parse(entry.body)));
  assert.equal(postBodies.length, 10, 'double activation cannot create duplicate billable POSTs');
  assert.equal(new Set(postBodies.map((body) => body.prompt)).size, 10, 'each pending segment is posted exactly once');
  for (const skippedIndex of [6, 7, 8, 9, 10]) {
    assert.equal(postBodies.some((body) => body.prompt.includes(`segment ${skippedIndex} character`) || body.prompt.includes(`第 ${skippedIndex} 段人物`)), false, `existing segment ${skippedIndex} is not posted`);
  }
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks, storageKey);
  const created = stored.filter((task) => task.batchId && !['qa-history-batch-3', 'qa-failed-and-cancelled-batch'].includes(task.batchId));
  assert.equal(stored.length, 17, 'five successful tasks, two retry fixtures, and ten new tasks are retained');
  assert.equal(created.length, 10);
  assert.equal(new Set(created.map((task) => task.batchId)).size, 1);
  assert.deepEqual(created.map((task) => task.batchIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(created.every((task) => task.batchTotal === 10 && task.batchLabel === '十五段一键批量验证 · 批量视频'));
  assert.equal(new Set(created.map((task) => task.requestFingerprint)).size, 10);
  stages.push('confirmation, exact-task skipping, double-submit guard, ten unique POSTs and durable batch metadata verified');

  assert.equal(await page.locator('[data-video-batch-id]').count(), 3, 'the successful, failed/cancelled, and newly submitted batches remain separate');
  const batchUi = page.locator(`[data-video-batch-id="${created[0].batchId}"]`);
  assert.equal(await batchUi.count(), 1, 'the ten new tasks are grouped into one batch summary');
  const batchText = await batchUi.innerText();
  assert.ok(batchText.includes('十五段一键批量验证 · 批量视频'));
  assert.ok(batchText.includes('共 10 项 · 中文 0 · 英文 10'), `batch language summary: ${batchText}`);
  assert.ok(batchText.includes('排队 10'), `batch status summary: ${batchText}`);
  const createdToggle = batchUi.locator('.video-task-batch-toggle');
  assert.equal(await createdToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await batchUi.locator('.video-task-batch-items').count(), 0);
  await createdToggle.click();
  assert.equal(await batchUi.locator('[data-video-task-id]').count(), 10);
  stages.push('generation task page keeps batches separate and reports the new ten-task English queue correctly');
  await page.screenshot({ path: path.join(outputDirectory, 'batch-tasks-after-submit-1120x720-font-150.png'), fullPage: false });
  screenshots.push('batch-tasks-after-submit-1120x720-font-150.png');
  await createdToggle.click();

  const failedBatchUi = page.locator('[data-video-batch-id="qa-failed-and-cancelled-batch"]');
  await failedBatchUi.scrollIntoViewIfNeeded();
  const failedBatchText = await failedBatchUi.innerText();
  assert.ok(failedBatchText.includes('失败 1'), `failed batch status summary: ${failedBatchText}`);
  assert.ok(failedBatchText.includes('已停止 1'), `cancelled-before-submit item must be reported separately: ${failedBatchText}`);
  const retryFailedButton = failedBatchUi.locator('button').filter({ hasText: '只重试失败项' });
  assert.equal(await retryFailedButton.count(), 1);
  await retryFailedButton.click();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab', { name: '长剧情批量', exact: true }).getAttribute('aria-selected'), 'true');
  await waitForExactText(summary, '已选 1 段 · 待提交 1 段 · 跳过 0 段');
  assert.equal(await row(1).getByRole('checkbox', { name: '选择第 1 段', exact: true }).isChecked(), true);
  assert.equal(await row(2).getByRole('checkbox', { name: '选择第 2 段', exact: true }).isChecked(), false, 'cancelled unsubmitted work is not treated as a retryable failure');
  const retryRowText = await row(1).innerText();
  assert.ok(retryRowText.includes('9 秒'));
  assert.ok(retryRowText.includes('失败任务快照，待复核'));
  await panel.getByRole('tab', { name: '当前段预览', exact: true }).click();
  assert.ok((await panel.locator('.vd-batch-preview .vd-prompt-preview').textContent()).includes('FAILED BATCH ORIGINAL ENGLISH PROMPT'));
  await panel.getByRole('tab', { name: '参考图与用途', exact: true }).click();
  assert.ok((await panel.locator('.vd-batch-reference-preview').innerText()).includes('失败任务冻结人物参考'));
  const retryAdvanced = panel.locator('.vd-batch-advanced');
  await retryAdvanced.locator('summary').click();
  assert.deepEqual(JSON.parse(await retryAdvanced.getByLabel('批量公共参数 JSON', { exact: true }).inputValue()), {
    duration: 9, seed: 7001, retry_marker: 'original-failed-snapshot',
  });
  assert.equal(await page.evaluate(() => window.__videoBatchQa.posts.length), 10, 'opening failed-item review must not submit or charge');
  await panel.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认批量生成视频' });
  assert.equal(await dialog.locator('.vd-batch-confirm-list > div').filter({ hasText: '失败项复核后待提交' }).count(), 1);
  assert.equal(await dialog.getByRole('checkbox', { name: '确认批量生成费用', exact: true }).isChecked(), false);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__videoBatchQa.posts.length), 10, 'closing failed-item confirmation must remain non-billable');
  stages.push('failed-only review restores original language, prompt, duration, parameters and frozen image while excluding cancelled work and requiring fee confirmation');

  assert.deepEqual(errors, []);
  const report = {
    mockOnly: true,
    noProductionDataRead: true,
    viewport: { width: 1120, height: 720 },
    uiFontScalePercent: 150,
    fixture: { segments: 15, bilingualPairs: 15, masterStoryboards: 1, imageAssets: 3, existingSuccessfulEnglishTasks: 5, retryableFailures: 1, cancelledBeforeSubmit: 1 },
    result: { selected: 15, skipped: 5, posted: postBodies.length, storedBatchTasks: created.length },
    layout: { panel: compactLayout, expanded: expandedLayout, wide: wideLayout, listFooterBoundary, confirmation: dialogLayout },
    stages, screenshots, errors,
  };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  const body = page ? (await page.locator('body').innerText().catch(() => '')).slice(-8_000) : '';
  if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ stages, errors, body, error: String(error), cause: error?.cause ? String(error.cause) : undefined }, null, 2));
  throw new Error(`Batch video UI QA failed: ${JSON.stringify({ stages, errors })}`, { cause: error });
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
