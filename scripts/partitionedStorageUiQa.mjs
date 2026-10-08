import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real Electron save/restart/restore/export, restricted to a new synthetic profile.
// No existing profile, API key, user project, or provider request is accessed.
const root = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const require = createRequire(import.meta.url);
const { prepareStateForSave } = require('../electron/stateSerialization.cjs');
const { readProjectLibrary } = require('../electron/projectLibraryStore.cjs');
const { createStateStore } = require('../electron/statePersistenceStore.cjs');
const { createInitialState, normalizeState, serializeStateForStorage } = await tsImport('../src/storage.ts', import.meta.url);
const qaRoot = fs.mkdtempSync(path.join(root, '.qa-partitioned-storage-'));
const dataRoot = path.join(qaRoot, 'profile');
const output = path.join(qaRoot, 'output');
fs.mkdirSync(dataRoot); fs.mkdirSync(output);
fs.writeFileSync(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic storage migration QA only\n', { flag: 'wx' });
const stateFile = path.join(dataRoot, 'project-state.json');
const packageFile = path.join(output, 'storage-roundtrip.lhvd');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const now = Date.now();
const initial = createInitialState();
const story = '成年旅人甲在廊桥上与成年旅人乙交谈。';
const promptZh = 'integrated_multimodal_description: [Shot 1] 成年旅人甲在廊桥上与成年旅人乙交谈。\n\noverall_soundscape: 微风。\n\nnon_diegetic_music: N/A';
const promptEn = 'integrated_multimodal_description: [Shot 1] Adult traveler A speaks with adult traveler B on a bridge.\n\noverall_soundscape: Gentle wind.\n\nnon_diegetic_music: N/A';
const makeProject = (id) => ({
  ...initial.project, id, name: `存储迁移测试 ${id}`, description: '迁移前说明', activeChapterId: `${id}-chapter`, chapterWorkspaces: {}, storyDraft: story,
  sourceDocuments: [{ id: `${id}-chapter`, name: '第1章', content: story, createdAt: now, updatedAt: now }],
  characters: [{ id: `${id}-character`, name: '成年旅人甲', gender: '女性', appearance: '成年旅人，蓝色长外套', outfit: '蓝色长外套', assetIds: [`${id}-image`] }],
  locations: [], props: [], scenes: [], sequencePlans: [], generationTasks: [],
  assets: [{ id: `${id}-image`, name: '人物参考图', type: 'character', role: 'character', referenceRole: 'character', mediaType: 'image', mimeType: 'image/png',
    dataUrl, width: 1, height: 1, source: 'upload', tags: [], sourceEntityId: `${id}-character`, sourceEntityKind: 'character',
    characterReferenceId: `${id}-character`, createdAt: now, updatedAt: now }],
  storyboards: [{ id: `${id}-board`, chapterId: `${id}-chapter`, sceneId: '', sourceStoryContent: story, sourceStoryTitle: '廊桥交谈',
    workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
    pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: initial.settings.defaultStylePresetId,
    ruleSetId: initial.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '',
    shots: [{ id: `${id}-shot`, index: 1, startSec: 0, endSec: 5, subject: '成年旅人甲', action: '交谈', purpose: '会面', camera: '中景固定', lighting: '自然光', sound: '微风', transition: '自然', result: '交谈', referenceAssetIds: [`${id}-image`], prompt: promptZh, locked: false }],
    finalPrompt: promptZh, officialPromptZh: promptZh, officialPromptEn: promptEn, officialPromptEnSource: promptZh, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now }],
  updatedAt: now,
});
const projectA = makeProject('migration-a');
const projectB = makeProject('migration-b');
const state = normalizeState({ ...initial, project: projectA, projects: [projectA, projectB], activeProjectId: projectA.id });
for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo']) {
  if (state.settings[key]) { state.settings[key].enabled = false; state.settings[key].apiKey = ''; }
}
for (const key of ['apiCredentialBook', 'textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles']) state.settings[key] = [];
const authored = (value) => value.projects.map((project) => ({ id: project.id, characters: project.characters, sourceDocuments: project.sourceDocuments,
  storyboards: project.storyboards.map((board) => ({ id: board.id, finalPrompt: board.finalPrompt, officialPromptZh: board.officialPromptZh,
    officialPromptEn: board.officialPromptEn, officialPromptEnSource: board.officialPromptEnSource, shots: board.shots })),
  assets: project.assets.map((asset) => ({ id: asset.id, characterReferenceId: asset.characterReferenceId, sourceEntityId: asset.sourceEntityId, sourceEntityKind: asset.sourceEntityKind })),
}));
const expectedAuthored = authored(state);
const legacy = prepareStateForSave(serializeStateForStorage(state).serialized, now).payload;
fs.writeFileSync(stateFile, legacy, { flag: 'wx' });

const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Partitioned storage QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'partitioned storage UI QA', runTimeoutMs: 210_000, closeTimeoutMs: 10_000 });
const report = { dataRoot, output, checks: [], errors: [], externalRequests: [], screenshots: [] };
let app;
let page;
let failure;
const load = () => page.evaluate(async () => JSON.parse(await window.lianhuaDesktop.loadState()));
const checked = (label) => { report.checks.push(label); console.log(label); };
const assertMedia = (loaded) => {
  const normalized = normalizeState(loaded);
  assert.deepEqual(authored(normalized), expectedAuthored, 'bilingual prompts, shots, characters and references must survive');
  const assets = normalized.projects.map((project) => project.assets[0]);
  assert.equal(new Set(assets.map((asset) => asset.relativePath)).size, 1, 'identical bytes are stored once across projects');
  for (const asset of assets) {
    assert.equal(asset.dataUrl, undefined);
    assert.equal(digest(fs.readFileSync(path.join(dataRoot, 'assets', asset.relativePath))), digest(png));
  }
};
const launch = async ({ profile = dataRoot, expectMigration = true } = {}) => {
  const env = { ...process.env, LIANHUA_DATA_DIR: profile, ELECTRON_START_URL: `${origin}/`, LIANHUA_QA_MODE: '1',
    LIANHUA_QA_EXPORT_PATH: packageFile, LIANHUA_QA_IMPORT_PATH: packageFile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await electron.launch({ args: [path.join(root, 'electron', 'main.cjs')], cwd: root, env, timeout: 35_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await app.context().route(/^https?:\/\//u, async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
      report.externalRequests.push(request.url()); await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await (expectMigration ? page.locator('.app-shell .sidebar .nav-item').first() : page.getByRole('alertdialog')).waitFor({ timeout: 45_000 });
  const paths = await page.evaluate(() => window.lianhuaDesktop.storagePaths());
  assert.equal(path.resolve(paths.dataRoot), profile);
  if (expectMigration) await waitForCondition({ label: 'first partitioned autosave', timeoutMs: 30_000, intervalMs: 100, check: () => {
    try { return JSON.parse(fs.readFileSync(path.join(profile, 'project-state.json'), 'utf8')).storageFormat === 'lianhua-project-library-v1'; } catch { return false; }
  } });
};
const close = async () => {
  if (!app) return;
  const child = app.process();
  const closing = app.waitForEvent('close', { timeout: 20_000 });
  await page.evaluate(() => { setTimeout(() => window.close(), 0); });
  await closing;
  assert.equal(child.exitCode, 0);
  app = undefined; page = undefined;
};
try {
  await Promise.race([(async () => {
    await waitForCondition({ label: 'migration QA dev server', timeoutMs: 35_000, intervalMs: 100, check: async () => {
      try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    } });
    if (process.env.QA_IMPORT_ONLY === '1') {
      await createStateStore({ dataRoot }).save(legacy, async () => ({ mode: 'keep' }));
      const sourceFiles = fs.readdirSync(dataRoot, { recursive: true }).map((relative) => path.join(dataRoot, relative)).filter((file) => fs.statSync(file).isFile());
      const sourceHashes = sourceFiles.map((file) => [file, digest(fs.readFileSync(file))]);
      const importProfile = path.join(qaRoot, 'import-profile'); fs.mkdirSync(importProfile);
      fs.writeFileSync(path.join(importProfile, '.qa-isolated-profile'), 'Separate synthetic import destination');
      await launch({ profile: importProfile });
      await page.locator('input[type="file"][accept=".json,.lhvd"]').setInputFiles(stateFile);
      await page.getByText('项目导入成功，已加入项目库。', { exact: true }).waitFor();
      await waitForCondition({ label: 'imported project library autosave', timeoutMs: 20_000, intervalMs: 100, check: async () => {
        const value = await load(); return value.project.id === 'migration-a';
      } });
      const imported = normalizeState(await load());
      const importedProjects = imported.projects.filter((project) => project.id.startsWith('migration-'));
      assert.deepEqual(authored({ ...imported, projects: importedProjects }), expectedAuthored);
      for (const project of importedProjects) for (const asset of project.assets) {
        assert.equal(digest(fs.readFileSync(path.join(importProfile, 'assets', asset.relativePath))), digest(png));
      }
      await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
      const image = page.locator('#asset-card-migration-a-image img').first(); await image.waitFor();
      await page.waitForFunction(() => { const image = document.querySelector('#asset-card-migration-a-image img'); return image?.complete && image.naturalWidth > 0; });
      await page.locator('#asset-card-migration-a-image').getByText('人物参考：成年旅人甲', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, '03-imported-backup-image.png'), fullPage: false }); report.screenshots.push('03-imported-backup-image.png');
      await close();
      for (const [file, hash] of sourceHashes) assert.equal(digest(fs.readFileSync(file)), hash, 'source profile files must not change during import');
      checked('actual JSON file input imports another profile manifest, both projects and all bilingual prompts; PNG renders with optional character binding; source profile stays byte-identical');
      assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
      return;
    }
    if (process.env.QA_CORRUPT_ONLY !== '1') {
    await launch();
    assertMedia(await load());
    assert.ok(fs.readdirSync(path.join(dataRoot, 'project-library')).filter((name) => name.endsWith('.json')).length >= 2);
    checked('legacy JSON automatically becomes project files + manifest; both prompts and optional character binding unchanged; PNG bytes deduplicated losslessly');
    await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
    await page.locator('#asset-card-migration-a-image img').first().waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('#asset-card-migration-a-image img');
      return image?.complete && image.naturalWidth > 0;
    });
    await page.screenshot({ path: path.join(output, '01-migrated-assets.png'), fullPage: false }); report.screenshots.push('01-migrated-assets.png');
    await close();
    await launch();
    const reloaded = await load(); assertMedia(reloaded);
    checked('actual close/restart reloads every project and managed image');
    const restored = await page.evaluate(async () => {
      const desktop = window.lianhuaDesktop;
      const loaded = JSON.parse(await desktop.loadState());
      const snapshot = await desktop.createRestorePoint(JSON.stringify(loaded));
      loaded.project.description = '必须被恢复点撤回的临时修改';
      await desktop.saveState(JSON.stringify(loaded));
      const changed = JSON.parse(await desktop.loadState());
      const restored = JSON.parse(await desktop.restoreSnapshot(snapshot.path.split(/[\\/]/).pop()));
      return { changedDescription: changed.project.description, restored };
    });
    assert.equal(restored.changedDescription, '必须被恢复点撤回的临时修改');
    assert.equal(restored.restored.project.description, '迁移前说明'); assertMedia(restored.restored);
    checked('restore point switches project versions and retains bilingual prompt/image binding');
    const exported = await page.evaluate(async () => {
      const desktop = window.lianhuaDesktop;
      return desktop.exportProjectPackage({ content: await desktop.loadState(), fileName: 'storage-roundtrip' });
    });
    assert.equal(exported.path, packageFile); assert.ok(exported.assetCount > 0); assert.equal(exported.missingCount, 0);
    assert.ok(fs.statSync(packageFile).size > 0);
    const imported = await page.evaluate(async () => JSON.parse(await window.lianhuaDesktop.importProjectPackage(null)));
    assertMedia(imported);
    checked('project package export includes managed PNG; import returns complete readable prompts and character references');
    await close();
    const finalState = readProjectLibrary(fs.readFileSync(stateFile, 'utf8'), { root: dataRoot });
    assertMedia(finalState);
    report.legacyBytes = Buffer.byteLength(legacy); report.manifestBytes = fs.statSync(stateFile).size;
    }
    const corruptProfile = path.join(qaRoot, 'corrupt-profile');
    fs.mkdirSync(corruptProfile);
    const corruptFile = path.join(corruptProfile, 'project-state.json');
    const corruptContent = '{broken original project data that must not be replaced';
    fs.writeFileSync(corruptFile, corruptContent, { flag: 'wx' });
    await launch({ profile: corruptProfile, expectMigration: false });
    await page.getByRole('heading', { name: '项目库读取失败，已停止自动保存', exact: true }).waitFor();
    await page.keyboard.press('Control+s');
    await page.keyboard.press('Control+z');
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), corruptContent);
    await page.screenshot({ path: path.join(output, '02-corrupt-state-protected.png'), fullPage: false }); report.screenshots.push('02-corrupt-state-protected.png');
    await close();
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), corruptContent, 'startup and close must not overwrite a corrupt existing library with defaults');
    assert.equal(fs.existsSync(path.join(corruptProfile, 'project-library')), false);
    checked('corrupt existing library visibly reports load failure and remains byte-identical through startup and close');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  })(), harness.qaFailure]);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  if (app) {
    let child;
    try { child = app.process(); } catch { /* already closed */ }
    await app.close().catch(() => { child?.kill(); });
  }
  harness.markElectronStopping(); await harness.stopAll().catch((error) => { failure ||= error; });
  fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog());
  Object.assign(report, { passed: !failure, noRealUserDataAccessed: true, noProviderCalls: true, ...(failure ? { failure: String(failure) } : {}) });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
