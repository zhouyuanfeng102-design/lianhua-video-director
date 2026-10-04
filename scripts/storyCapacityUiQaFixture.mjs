// Loaded from the persistent Playwright Interactive session. This helper only
// stages a synthetic state and observes this test's real Electron IPC handlers.
// User-visible actions are intentionally driven separately by Playwright.
export async function installCapacityIpcAudit(electronApp, expectedDataRoot) {
  return electronApp.evaluate(({ app, ipcMain }, expected) => {
    const normalize = (value) => value.replaceAll('\\', '/').toLowerCase();
    if (normalize(app.getPath('userData')) !== normalize(expected)) throw new Error('Capacity QA profile is not isolated');
    if (globalThis.__capQaAudit) return { alreadyInstalled: true };
    const audit = { stage: 'bootstrap', calls: [], apiRequests: 0 };
    globalThis.__capQaAudit = audit;
    for (const channel of ['lianhua:save-state', 'lianhua:create-restore-point', 'lianhua:export-project-package']) {
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function') throw new Error(`Missing real IPC handler ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, payload) => {
        const serialized = typeof payload === 'string' ? payload : payload?.content;
        if (typeof serialized !== 'string') throw new Error('Capacity QA expected serialized state');
        const row = {
          channel, stage: audit.stage, time: Date.now(), bytes: Buffer.byteLength(serialized, 'utf8'),
          paddingCopies: [...serialized.matchAll(/"capacityFixturePadding"\s*:/gu)].length,
          activeReferenceCount: [...serialized.matchAll(/"__activeProjectReference"\s*:\s*true/gu)].length,
          completed: false,
        };
        audit.calls.push(row);
        try {
          const result = await original(event, payload);
          row.completed = true;
          row.ok = result?.ok ?? Boolean(result);
          row.path = result?.path;
          row.checksum = result?.checksum;
          row.backupError = result?.backupError;
          return result;
        } catch (error) {
          row.completed = true;
          row.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      });
    }
    for (const channel of ['lianhua:http-request', 'lianhua:video-request']) {
      if (!ipcMain._invokeHandlers.has(channel)) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        audit.apiRequests += 1;
        throw new Error('Capacity QA prohibits all model requests');
      });
    }
    return { installed: true, dataRoot: app.getPath('userData') };
  }, expectedDataRoot);
}

export async function setCapacityStage(electronApp, stage) {
  await electronApp.evaluate((_electron, value) => { globalThis.__capQaAudit.stage = value; }, stage);
}

export async function readCapacityAudit(electronApp) {
  return electronApp.evaluate(() => globalThis.__capQaAudit);
}

export async function stageCapacityState(page, sizeMiB = 65) {
  return page.evaluate(async (size) => {
    const bridge = window.lianhuaDesktop;
    const raw = await bridge.loadState();
    if (!raw) throw new Error('The isolated default profile must save once before staging');
    const state = JSON.parse(raw);
    delete state.integrity;
    const stamp = Date.now();
    const content = '这是独立容量验收的合成原文，没有真实人物资料或 API 请求。';
    const project = {
      ...state.project, id: 'cap-qa-121-project', name: '容量验收 65 MiB 独立项目', description: '仅用于桌面存储回归，不是真实用户剧情。',
      sourceDocuments: [{ id: 'cap-qa-source', name: '容量验收原文', content, createdAt: stamp, updatedAt: stamp }],
      characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
      // Preserved project metadata that is not displayed in any current UI.
      capacityFixturePadding: 'X'.repeat(size * 1024 * 1024),
      createdAt: stamp, updatedAt: stamp,
    };
    state.project = project;
    state.projects = [{ id: project.id, __activeProjectReference: true }];
    state.activeProjectId = project.id;
    for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) {
      if (state.settings[key]) state.settings[key] = { ...state.settings[key], enabled: false, apiKey: '' };
    }
    state.settings.apiCredentialBook = [];
    for (const key of ['textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles']) state.settings[key] = [];
    const serialized = JSON.stringify(state);
    const result = await bridge.saveState(serialized);
    return { ok: result.ok, bytes: new Blob([serialized]).size, paddingLength: project.capacityFixturePadding.length, projectId: project.id };
  }, sizeMiB);
}
