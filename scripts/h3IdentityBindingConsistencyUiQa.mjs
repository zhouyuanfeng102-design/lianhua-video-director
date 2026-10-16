import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Read-only examination of one explicitly selected partitioned project. All
// UI edits use a structuredClone in an isolated browser context. The production
// bundle is served statically; no Vite dev server, model request or generation.
const root = path.resolve(import.meta.dirname, '..');
const phase = process.argv[2] || 'all';
assert.ok(['data', 'ui', 'all'].includes(phase), 'phase must be data, ui or all');
const dataRoot = path.resolve(process.env.QA_SOURCE_DATA || path.join(root, '交付', '莲华视频导演台数据'));
const output = path.join(root, 'output', 'playwright', 'h3-identity-binding-consistency');
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  if (fs.existsSync(candidate)) assert.equal(fs.lstatSync(candidate).isSymbolicLink(), false, 'QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const reportFile = path.join(output, `${phase}-report.json`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestPath = path.join(dataRoot, 'project-state.json');
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.storageFormat, 'lianhua-project-library-v1');
assert.match(manifest.project.hash, /^[a-f0-9]{64}$/u);
const projectPath = path.join(dataRoot, 'project-library', `${manifest.project.hash}.json`);
const projectBytes = fs.readFileSync(projectPath);
assert.equal(sha(projectBytes), manifest.project.hash, 'selected project body must match its saved hash');
const sourceProject = JSON.parse(projectBytes);
assert.equal(sourceProject.id, 'project_mvar9cbj_8redw4', 'only the explicitly authorized current project is read');
const project = structuredClone(sourceProject);
const chapterId = project.activeChapterId;
const savedDirector = project.chapterWorkspaces[chapterId].videoDirector;
const batch = savedDirector.batch;
const targetPlan = project.sequencePlans.find((plan) => plan.id === batch.planId);
assert.equal(targetPlan.segments.length, 5);
assert.equal(targetPlan.segments.find((segment) => segment.index === 5).storyboardId, 'storyboard_mvaw7nqr_56puid');
const targetCharacters = [
  { id: 'character_mvarmeci_3umpfj', assetId: 'asset_mvatsfvl_2ph69t', slot: 4 },
  { id: 'character_mvarmeci_bcsn5s', assetId: 'asset_mvatgjky_9xr5r5', slot: 5 },
];
const qa = { pass: false, phase, productionDataReadOnly: true, isolatedBrowserClone: true, noGeneration: true, stages: [], cases: [], screenshots: [], errors: [], blockedRequests: [], bridgeRequests: [] };
const assertSourceUnchanged = () => {
  assert.equal(sha(fs.readFileSync(manifestPath)), sha(manifestBytes), 'source project-state.json changed during QA');
  assert.equal(sha(fs.readFileSync(projectPath)), sha(projectBytes), 'source project body changed during QA');
  qa.sourceFilesUnchanged = true;
};
const sourceBefore = JSON.stringify(project);
const { STORAGE_KEY } = await tsImport('../src/storage.ts', import.meta.url);
const { chapterScopeProject } = await tsImport('../src/chapters.ts', import.meta.url);
const { buildVideoBatchRows, videoPromptChoiceKey, videoBatchConnectionIdentity, videoBatchTailReferences } = await tsImport('../src/videoBatch.ts', import.meta.url);
const { prepareVideoH3ReferenceDraft } = await tsImport('../src/videoH3ReferenceBinding.ts', import.meta.url);
const { videoReferenceUsage } = await tsImport('../src/videoReferenceUsage.ts', import.meta.url);
const { prepareVideoTailCharacterDraft } = await tsImport('../src/videoTailCharacters.ts', import.meta.url);
const { prepareVideoAudioDraft } = await tsImport('../src/videoAudioReferences.ts', import.meta.url);
const { videoH3MediaModeContract } = await tsImport('../src/videoH3MediaMode.ts', import.meta.url);
const { repairH3IdentityBindings } = await tsImport('../src/h3IdentityRepair.ts', import.meta.url);
const { normalizeH3IdentityBindings } = await tsImport('../src/h3IdentityBindings.ts', import.meta.url);
const { officialH3ContextForStoryboard } = await tsImport('../src/officialH3Context.ts', import.meta.url);

async function checkDataConsistency() {
  const scoped = chapterScopeProject(project, chapterId);
  const plan = scoped.sequencePlans.find((candidate) => candidate.id === targetPlan.id);
  const overridesByChoice = {};
  for (const segment of plan.segments) {
    const references = batch.referenceOverrides[segment.id];
    if (references && segment.storyboardId) for (const language of ['zh', 'en']) {
      overridesByChoice[videoPromptChoiceKey(segment.storyboardId, language, batch.promptFormats?.[segment.id] || batch.promptFormat)] = structuredClone(references);
    }
  }
  const rows = buildVideoBatchRows(scoped, plan, structuredClone(manifest.settings), {
    backend: batch.backend, workflowId: batch.workflowId || undefined, apiProfileId: batch.apiProfileId,
    runningHubWorkflowId: batch.runningHubWorkflowId, parameters: JSON.parse(batch.parameterText),
    referenceOverrides: overridesByChoice, promptFormat: batch.promptFormat, promptFormats: batch.promptFormats,
  });
  assert.equal(rows.length, 5);
  let repairRequests = 0;
  for (const row of rows) for (const language of ['zh', 'en']) {
    const candidate = row[language];
    assert.ok(candidate, `segment ${row.segmentIndex} ${language} must be selectable`);
    let draft = structuredClone(candidate.draft);
    const roles = batch.referenceRoleOverrides[row.segmentId];
    if (roles) draft.referenceSlotRoles = [...roles];
    const mode = batch.tailCharacterModes[row.segmentId];
    const automatic = batch.automaticTails[row.segmentId];
    if (mode) {
      const prepared = prepareVideoTailCharacterDraft(scoped, draft, { preserveSlots: Boolean(mode.editedReferences) || Object.hasOwn(batch.referenceOverrides, row.segmentId) });
      assert.equal(prepared.issue, undefined);
      draft = prepared.draft;
      if (mode.kind === 'static' && mode.tailAssetId && mode.tailRole) {
        draft.references = videoBatchTailReferences(draft.references, { mode: 'prepend', index: 0, role: mode.tailRole }, mode.tailAssetId);
        draft.referenceSlotRoles = [mode.tailRole, ...(draft.referenceSlotRoles || draft.references.slice(1).map((reference) => reference.role))];
      }
    }
    const audioOverride = batch.audioOverrides?.[row.segmentId];
    if (audioOverride) draft = { ...draft, audioSelectionMode: audioOverride.mode, audioReferences: structuredClone(audioOverride.references || []), reuseTaskId: undefined };
    if (draft.audioReferenceBinding && draft.prompt === draft.audioReferenceBinding.renderedPrompt) draft = { ...draft, prompt: draft.audioReferenceBinding.basePrompt, audioReferenceBinding: undefined };
    const context = { ...videoBatchConnectionIdentity(manifest.settings, draft), slotRoles: draft.referenceSlotRoles };
    if (!automatic) draft.references = videoReferenceUsage(draft.references, context);
    const bindingInput = automatic ? { ...draft, references: videoBatchTailReferences(draft.references, automatic.placement, '__future_tail_binding__') } : draft;
    let prepared = prepareVideoH3ReferenceDraft(scoped, bindingInput, context);
    draft = automatic ? { ...prepared.draft, references: draft.references } : prepared.draft;
    draft = prepareVideoAudioDraft(scoped, draft, context.api);
    const update = batch.h3ReferenceUpdates?.[candidate.key];
    const actualModeDraft = automatic ? { ...draft, references: bindingInput.references } : draft;
    const identity = videoH3MediaModeContract(actualModeDraft, context).inputIdentity;
    const sourcePrompt = candidate.draft.h3ReferenceBinding?.basePrompt || candidate.draft.prompt;
    if (update?.h3MediaModeUpdate?.inputIdentity === identity && update.h3MediaModeUpdate.sourcePrompt === sourcePrompt) {
      draft = prepareVideoAudioDraft(scoped, { ...draft, prompt: update.prompt, h3ReferenceBinding: update.h3ReferenceBinding,
        h3MediaMode: update.h3MediaMode, h3MediaModeUpdate: update.h3MediaModeUpdate,
        h3ReferenceWarnings: update.h3ReferenceWarnings, audioReferenceBinding: update.audioReferenceBinding }, context.api);
    }
    // The picker recomputes states with the same selected slots; it does not
    // trust an old rendered state's green/pending cache.
    prepared = prepareVideoH3ReferenceDraft(scoped, { ...draft, references: videoReferenceUsage(draft.references, context), reuseTaskId: undefined }, context);
    const selected = prepared.characterStates.filter((state) => state.slots.length);
    assert.ok(selected.length > 0, `segment ${row.segmentIndex} ${language} selected character metadata must remain visible`);
    for (const state of selected) assert.equal(state.status, 'bound', `segment ${row.segmentIndex} ${language} ${state.name}: ${state.reason || state.status}`);
    const board = scoped.storyboards.find((board) => board.id === row.storyboardId);
    const authoredPrompt = language === 'zh' ? board.officialPromptZh : board.officialPromptEn;
    const bindings = language === 'zh' ? board.h3IdentityBindings : board.h3IdentityBindingsEn;
    const repaired = await repairH3IdentityBindings({
      prompt: authoredPrompt, bindings, characters: officialH3ContextForStoryboard(scoped, board).characters,
      language: language === 'zh' ? '中文' : '英文', targetCharacterIds: selected.map((state) => state.characterId),
      request: async () => { repairRequests++; throw new Error('Read-only QA forbids AI requests'); },
    });
    assert.equal(repaired.attempts, 0);
    assert.equal(repaired.changed, false);
    assert.equal(repaired.prompt, authoredPrompt);
    assert.deepEqual(repaired.identityBindings, normalizeH3IdentityBindings(bindings));
    if (row.segmentIndex === 5) for (const target of targetCharacters) {
      assert.equal(draft.references[target.slot - 1].assetId, target.assetId);
      const state = selected.find((state) => state.characterId === target.id);
      assert.equal(state?.status, 'bound'); assert.deepEqual(state.slots, [target.slot]);
    }
    qa.cases.push({ segment: row.segmentIndex, language, characters: selected.map(({ name, status, slots }) => ({ name, status, slots })), repairAttempts: repaired.attempts, sourcePromptUnchanged: repaired.prompt === authoredPrompt });
  }
  assert.equal(repairRequests, 0); assert.equal(qa.cases.length, 10);
  assert.equal(JSON.stringify(project), sourceBefore, 'all data-phase helpers must leave the in-memory source unchanged');
  qa.stages.push('five-actual-segments-both-languages-selected-characters-bound-and-repair-zero-requests');
  qa.repairRequests = repairRequests;
  assertSourceUnchanged();
}

async function checkProductionPicker() {
  const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
  const dist = path.join(root, 'dist'); assert.ok(fs.existsSync(path.join(dist, 'index.html')));
  const clone = structuredClone(project); clone.generationTasks = [];
  const images = {};
  for (const asset of clone.assets) {
    if (asset.relativePath && !['audio', 'video'].includes(asset.type) && !['audio', 'video'].includes(asset.mediaType)) {
      const file = path.resolve(dataRoot, asset.relativePath); const relative = path.relative(dataRoot, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(file) && fs.statSync(file).isFile()) images[asset.id] = file;
    }
    if (images[asset.id]) { asset.dataUrl = `${origin}/__qa-assets/${encodeURIComponent(asset.id)}`; asset.url = asset.dataUrl; }
    else if (!asset.dataUrl?.startsWith('data:')) { asset.dataUrl = ''; asset.url = ''; }
  }
  const scrubSettings = (value, key = '') => {
    if (/(?:apiKey|secret|password|accessToken|refreshToken|authorization)$/iu.test(key)) return '';
    if (Array.isArray(value)) return value.map((entry) => scrubSettings(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scrubSettings(entry, name)]));
    if (typeof value === 'string' && /^https?:\/\//iu.test(value)) return `${origin}/__forbidden_api__`;
    return value;
  };
  const seed = { ...structuredClone(manifest), project: clone, projects: [clone], activeProjectId: clone.id,
    settings: scrubSettings(manifest.settings), ui: { ...manifest.ui, activeView: 'video' } };
  delete seed.storageFormat; delete seed.integrity;
  for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) if (seed.settings[key]) seed.settings[key].enabled = false;
  for (const key of ['textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles']) {
    for (const profile of seed.settings[key] || []) { if (profile.config) profile.config.enabled = false; profile.enabled = false; }
  }
  seed.settings.uiFontScalePercent = 100;
  seed.project.chapterWorkspaces[chapterId].videoDirector.generationMode = 'batch';
  seed.project.chapterWorkspaces[chapterId].videoDirector.batch.previewSegmentId = targetPlan.segments.find((segment) => segment.index === 5).id;
  const serverSource = `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';const base=${JSON.stringify(dist)};const images=${JSON.stringify(images)};const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2'};http.createServer((request,response)=>{if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}try{const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);let target;if(pathname.startsWith('/__qa-assets/')){target=images[pathname.slice(13)];if(!target)throw 0;}else{target=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw 0;}const body=fs.readFileSync(target);response.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});response.end(body);}catch{response.writeHead(404);response.end();}}).listen(${port},'127.0.0.1');`;
  const server = spawn(process.execPath, ['--input-type=module', '-e', serverSource], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const harness = createQaProcessHarness({ electron: server, qaLabel: 'production H3 identity consistency picker QA', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
  let browser; let context; let page;
  const run = async () => {
    await waitForCondition({ label: 'production static server', timeoutMs: 20_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
    await context.addInitScript(({ key, state }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
      const calls = window.__identityConsistencyBridge = [];
      const forbidden = async () => { calls.push('forbidden-api-or-generation'); throw new Error('Read-only QA forbids API/generation'); };
      window.lianhuaDesktop = { onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
        request: forbidden, videoRequest: forbidden, downloadImage: forbidden, downloadGeneratedMedia: forbidden };
    }, { key: STORAGE_KEY, state: seed });
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/__forbidden_api__'))) {
        qa.blockedRequests.push({ origin: url.origin, method: request.method() }); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => qa.errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('.sidebar').waitFor({ timeout: 30_000 });
    await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
    await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
    assert.equal(await page.locator('.vd-batch-row').count(), 5);
    const row = page.locator('[data-segment-id="sequence_mvaub29h_ubq86z_segment_5"]');
    await row.scrollIntoViewIfNeeded();
    if (!(await row.locator('.vd-batch-row-settings').getAttribute('open') !== null)) await row.locator('.vd-batch-row-settings > summary').click();
    for (const [language, label] of [['zh', '中文'], ['en', '英文']]) {
      await row.locator('.vd-batch-language').getByRole('button', { name: label, exact: true }).click();
      await row.getByRole('button', { name: '第 5 段选择参考图', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '第 5 段 · 选择参考图', exact: true }); await dialog.waitFor();
      const states = [];
      for (const target of targetCharacters) {
        const chip = dialog.locator(`.vd-segment-character-chip[data-character-id="${target.id}"]`);
        await chip.waitFor();
        assert.equal(await chip.getAttribute('data-reference-status'), 'bound');
        assert.equal(await chip.locator('.vd-segment-character-state').innerText(), `已选 · 已关联图片 ${target.slot}`);
        assert.equal(await chip.evaluate((element) => element.classList.contains('pending')), false);
        const colors = await chip.evaluate((element) => {
          const probe = document.createElement('span'); probe.style.color = 'var(--green)'; element.append(probe);
          const result = { actual: getComputedStyle(element.querySelector('.vd-segment-character-state')).color, expected: getComputedStyle(probe).color };
          probe.remove(); return result;
        });
        assert.equal(colors.actual, colors.expected, 'linked state text must use the green status color');
        states.push({ name: await chip.locator('.vd-segment-character-name').innerText(), status: 'bound', slot: target.slot, color: colors.actual });
      }
      assert.equal(await dialog.locator('.vd-segment-character-chip.pending').count(), 0);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const screenshot = path.join(output, `segment-5-${language}-picker-bound.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' }); qa.screenshots.push(screenshot);
      qa.cases.push({ segment: 5, language, productionPicker: true, characters: states });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
    qa.bridgeRequests = await page.evaluate(() => window.__identityConsistencyBridge);
    assert.deepEqual(qa.bridgeRequests, []); assert.deepEqual(qa.blockedRequests, []); assert.deepEqual(qa.errors, []);
    qa.stages.push('production-dist-segment-five-chinese-and-english-picker-shows-both-identities-bound-at-four-and-five');
  };
  try { await Promise.race([run(), harness.qaFailure]); }
  catch (error) {
    if (page && !page.isClosed()) { const file = path.join(output, 'ui-failure.png'); await page.screenshot({ path: file }).catch(() => {}); qa.screenshots.push(file); }
    throw error;
  } finally {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); harness.markElectronStopping(); await harness.stopAll();
    fs.writeFileSync(path.join(output, 'server.log'), harness.readElectronLog());
  }
  assertSourceUnchanged();
}

try {
  if (phase !== 'ui') await checkDataConsistency();
  if (phase !== 'data') await checkProductionPicker();
  assertSourceUnchanged(); qa.pass = true;
} catch (error) { qa.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { try { assertSourceUnchanged(); } catch (error) { qa.pass = false; qa.sourceIntegrityFailure = error.message; process.exitCode = 1; } fs.writeFileSync(reportFile, JSON.stringify(qa, null, 2)); }
console.log(JSON.stringify({ pass: qa.pass, phase, cases: qa.cases.length, repairRequests: qa.repairRequests, stages: qa.stages, sourceFilesUnchanged: qa.sourceFilesUnchanged, report: reportFile, failure: qa.failure?.message }, null, 2));
