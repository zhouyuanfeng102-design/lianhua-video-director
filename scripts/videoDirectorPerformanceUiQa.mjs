import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installSeedanceCharacterBindingFixture, runSeedanceCharacterBindingAssertions } from './videoSeedanceCharacterBindingUiQa.mjs';
import { installTailCharactersFixture } from './videoTailCharactersUiQa.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', 'video-director-performance');
const baselineView = process.argv.includes('--compare-ui-baseline')
  ? execFileSync('git', ['show', 'HEAD:src/components/VideoDirectorView.tsx'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : undefined;
const instrumented = new Map([
  ['/src/videoBatch.ts', ['buildVideoBatchRows']],
  ['/src/videoH3ReferenceBinding.ts', ['prepareVideoH3ReferenceDraft']],
  ['/src/videoTailCharacters.ts', ['prepareVideoTailCharacterDraft']],
  ['/src/videoDirectorDraft.ts', ['readVideoDirectorChapterDraft', 'videoPromptChoices', 'videoPromptReferencePreviews']],
  ['/src/videoSeedanceReferenceBinding.ts', ['prepareVideoSeedanceReferenceDraft']],
]);

async function mountScaleFixture(page) {
  await page.evaluate(async () => {
    const qa = window.__seedanceCharacterBindingQa;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { buildOfficialSeedanceInput } = await import('/src/seedanceSource.ts');
    const { getOfficialSeedanceSourceFingerprint } = await import('/src/seedancePrompt.ts');
    const { withChapterWorkspace, chapterWorkspace } = await import('/src/chapters.ts');
    const project = structuredClone(qa.project); project.id = 'scb-scale-project';
    const template = project.storyboards[0]; const templateSegment = project.sequencePlans[0].segments[0];
    project.characters.push(...project.characters.map((character, index) => ({ ...character, id: `scb-character-${index + 5}`, name: ['周远', '贺晨', '梁安', '程嘉'][index], assetIds: [] })));
    project.activeChapterId = 'scale-chapter';
    project.sourceDocuments = [{ id: 'scale-chapter', name: '合成章节', content: '八位中性合成人物在庭院中准备同行。', createdAt: 1, updatedAt: 1 }];
    project.sequencePlans[0].chapterId = 'scale-chapter';
    project.sequencePlans[0].segments = Array.from({ length: 16 }, (_, index) => ({ ...templateSegment, id: `scb-segment-${index + 1}`, index: index + 1, storyboardId: `scb-board-${index + 1}`, title: `合成第${index + 1}段`, globalStartSec: index * 30, globalEndSec: (index + 1) * 30 }));
    const makePrompt = (language, index) => {
      const subject = project.characters.map((character) => `${character.name}为三十岁人物，穿普通外套，身份与发型保持连续。`).join('');
      const sentence = language === 'en' ? 'The group walks through the courtyard in a steady medium shot. Their clothes and identities remain consistent while the camera follows the ordinary action without adding dialogue. ' : '众人沿石砖庭院缓慢前行，镜头在稳定的中景中跟随，衣着身份保持连续，树影和自然光保持一致，背景只有轻微风声与脚步声，不添加新的对白或动作。';
      const body = sentence.repeat(Math.ceil(6000 / sentence.length)).slice(0, 6000);
      return [`视频规格：时长30秒，画幅16:9，分辨率2K，立体声。`, '', '参考素材与职责：本次未提供图片、视频或音频参考素材，庭院按“清晨开放的石砖庭院”建立空间。', '', `主体连续性：${subject}`, '', `一句话概述：第${index + 1}段，众人准备同行。`, '', `连续时间轴：\n0秒至10秒，林舟与苏晴走入庭院。\n10秒至20秒，陈宁说：“我们现在出发。”${body}\n20秒至30秒，许岚等人也摆手拒绝，随后众人一起向门口前进。`, '', '全局约束：身份与服装连续，保留中文对白，不加入字幕。'].join('\n');
    };
    project.storyboards = project.sequencePlans[0].segments.map((segment, index) => {
      const board = structuredClone(template); Object.assign(board, { id: segment.storyboardId, chapterId: 'scale-chapter', segmentId: segment.id, segmentIndex: segment.index, segmentCount: 16, sourceStoryTitle: segment.title });
      board.seedance25Output = { ...board.seedance25Output, promptZh: makePrompt('zh', index), promptEn: index < 14 ? makePrompt('en', index) : '' };
      return board;
    });
    for (const board of project.storyboards) {
      const fingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
      Object.assign(board.seedance25Output, { sourceFingerprint: fingerprint, englishSourceFingerprint: fingerprint });
    }
    const draft = { name: '', backend: 'api', prompt: '', references: [], parameters: {} };
    const batch = { planId: 'scb-plan', backend: 'api', workflowId: '', apiProfileId: '', parameterText: '{}', parameterDrafts: [], selectedKeys: ['scb-board-1:seedance:zh'], languages: {}, promptFormat: 'seedance', promptFormats: {}, referenceOverrides: {}, referenceRoleOverrides: {}, automaticTails: {}, tailCharacterModes: {}, previewSegmentId: 'scb-segment-1', previewPane: 'prompt', settingsCollapsed: false, query: '' };
    project.chapterWorkspaces = { 'scale-chapter': { videoDirector: { draft, parameterText: '{}', parameterDrafts: [], generationMode: 'batch', batch } } };
    const perf = window.__videoDirectorPerf = { commits: [], persisted: 0, otherProjects: Array.from({ length: 103 }, (_, index) => ({ id: `unused-library-project-${index}` })), chars: project.storyboards.reduce((sum, board) => sum + board.seedance25Output.promptZh.length + board.seedance25Output.promptEn.length, 0) };
    function Harness() {
      const [currentProject, setProject] = React.useState(project);
      perf.project = currentProject;
      return React.createElement(VideoDirectorView, { project: currentProject, settings: qa.settings, controller: qa.controller,
        onChapterDraftChange: (_id, chapterId, next) => {
          perf.persisted += 1;
          setProject((current) => JSON.stringify(chapterWorkspace(current, chapterId).videoDirector) === JSON.stringify(next)
            ? current : withChapterWorkspace(current, { videoDirector: next }, chapterId));
        },
      });
    }
    window.__videoPerformanceCounters = {};
    qa.root.render(React.createElement(React.Profiler, { id: 'scale', onRender: (id, phase, actualDuration, baseDuration, startTime, commitTime) => perf.commits.push({ phase, actualDuration, baseDuration, startTime, commitTime }) }, React.createElement(Harness)));
  });
  await page.locator('[data-segment-id="scb-segment-16"]').waitFor();
}

async function measure(page) {
  await mountScaleFixture(page);
  await page.waitForTimeout(100);
  const snapshot = () => page.evaluate(() => ({ counters: { ...window.__videoPerformanceCounters }, commits: [...window.__videoDirectorPerf.commits], persisted: window.__videoDirectorPerf.persisted, chars: window.__videoDirectorPerf.chars }));
  const mounted = await snapshot();
  await page.waitForTimeout(2000);
  const idle = await snapshot();
  assert.equal(idle.commits.length, mounted.commits.length, 'idle director has no render loop');
  assert.deepEqual(idle.counters, mounted.counters, 'idle director does not keep rebuilding candidates');
  await page.locator('[data-segment-id="scb-segment-2"]').getByRole('button', { name: '预览', exact: true }).click();
  await page.waitForTimeout(100);
  const preview = await snapshot();
  return { characterCount: 8, segmentCount: 16, promptCount: 30, promptCharacters: mounted.chars,
    mount: { ...mounted, renderMs: mounted.commits.reduce((sum, item) => sum + item.actualDuration, 0) },
    idleExtraCommits: idle.commits.length - mounted.commits.length,
    preview: { counters: Object.fromEntries(Object.keys(preview.counters).map((key) => [key, preview.counters[key] - (idle.counters[key] || 0)])), commits: preview.commits.slice(idle.commits.length), renderMs: preview.commits.slice(idle.commits.length).reduce((sum, item) => sum + item.actualDuration, 0), persisted: preview.persisted - idle.persisted } };
}

async function targetedTail(page, origin) {
  const { blockedRequests } = await installTailCharactersFixture(page, origin);
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
  const row = page.locator('[data-segment-id="tcq-segment-2"]');
  await row.locator('.vd-batch-row-settings > summary').click();
  await row.getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__tailCharactersQa.pending));
  await page.evaluate(() => window.__tailCharactersQa.pending.resolve());
  await page.waitForFunction(() => !window.__tailCharactersQa.pending && !window.__tailCharactersQa.busy);
  assert.match(await row.innerText(), /参考图 3 张/u);
  await row.getByRole('button', { name: '预览', exact: true }).click();
  const prompt = await page.locator('.vd-batch-preview .vd-prompt-preview').innerText();
  assert.match(prompt, /<Subject 1> is 甲人物 referenced from <Picture 2>/u);
  assert.match(prompt, /<Subject 2> is 乙人物 referenced from <Picture 3>/u);
  const original = await page.evaluate(() => window.__tailCharactersQa.project.storyboards[1].officialPromptZh);
  assert.equal(prompt, original.replace(/<Picture ([12])>/gu, (_, number) => `<Picture ${Number(number) + 1}>`));
  assert.deepEqual(blockedRequests, []);
  return { lazyTailPreparation: true, exactAuthoredPromptExceptPictureNumbers: true };
}

async function targetedFrozenRetry(page) {
  await page.evaluate(async () => {
    const qa = window.__seedanceCharacterBindingQa;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const project = structuredClone(qa.project); const draft = structuredClone(qa.submissions.at(-1).items[0].draft);
    const now = Date.now(); const taskId = 'scb-frozen-failed-task';
    qa.frozenExpected = { prompt: draft.prompt, references: structuredClone(draft.references) };
    const images = draft.references.map((reference) => ({ ...structuredClone(project.assets.find((asset) => asset.id === reference.assetId)), ...reference, assetId: reference.assetId, freezeState: 'frozen', frozenAt: now }));
    project.generationTasks = [{ id: taskId, kind: 'video', status: 'failed', requestBody: {}, createdAt: now, updatedAt: now, videoJob: { stage: 'failed', snapshot: { projectId: project.id, clientId: taskId, draft, connection: { backend: 'api', api: structuredClone(qa.settings.videoTaskApi) }, images } } }];
    project.assets.forEach((asset) => { asset.name = `当前资产已变更-${asset.id}`; });
    const settings = { ...qa.settings, videoApiProfiles: [{ ...qa.settings.videoTaskApi, id: 'scb-new-api', name: '隔离新连接', endpoint: `${location.origin}/unused-new-video`, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', images: '{{images}}' }) }] };
    qa.retrySettings = settings;
    qa.root.render(React.createElement(VideoDirectorView, { key: 'frozen-retry-regression', project, settings, controller: qa.controller, launchRequest: { id: 'frozen-retry-launch', batchTaskIds: [taskId] } }));
  });
  await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).waitFor();
  const before = await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.length);
  const preview = await page.locator('.vd-batch-preview .vd-prompt-preview').innerText();
  const expected = await page.evaluate(() => window.__seedanceCharacterBindingQa.frozenExpected);
  assert.equal(preview, expected.prompt, 'failed frozen retry keeps the exact archived prompt after live asset metadata changes');
  await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await dialog.getByRole('button', { name: '确认生成 1 段', exact: true }).click();
  await page.waitForFunction((count) => window.__seedanceCharacterBindingQa.submissions.length === count, before + 1);
  const submitted = await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.at(-1).items[0].draft);
  assert.equal(submitted.reuseTaskId, 'scb-frozen-failed-task'); assert.equal(submitted.prompt, expected.prompt); assert.deepEqual(submitted.references, expected.references);
  const row = page.locator('[data-segment-id="scb-segment-1"]');
  await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '第 1 段 · 选择参考图', exact: true });
  await picker.getByRole('button', { name: '取消选择图片 林舟人物图', exact: true }).click();
  await picker.getByRole('button', { name: '使用本段图片', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  const changedPrompt = await page.locator('.vd-batch-preview .vd-prompt-preview').innerText();
  assert.notEqual(changedPrompt, expected.prompt);
  assert.ok(!changedPrompt.split('\n').some((line) => line.startsWith('@Image 9：')), 'removing an archived image removes its old ninth dense-array ordinal');
  const submitCurrent = async () => {
    const count = await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.length);
    await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
    await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await dialog.getByRole('button', { name: '确认生成 1 段', exact: true }).click();
    await page.waitForFunction((value) => window.__seedanceCharacterBindingQa.submissions.length === value, count + 1);
    return page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.at(-1).items[0].draft);
  };
  const changed = await submitCurrent(); assert.equal(changed.reuseTaskId, undefined); assert.equal(changed.references.length, 8); assert.equal(changed.prompt, changedPrompt);
  assert.ok(changed.references.every((reference) => reference.assetId !== 'scb-image-6'));
  const bindingsBefore = await page.evaluate(() => window.__videoPerformanceCounters.prepareVideoSeedanceReferenceDraft);
  await page.getByLabel('批量视频 API 配置', { exact: true }).selectOption('scb-new-api');
  const newPreview = await page.locator('.vd-batch-preview .vd-prompt-preview').innerText();
  const newDraft = await submitCurrent();
  assert.equal(newDraft.reuseTaskId, undefined); assert.equal(newDraft.apiProfileId, 'scb-new-api'); assert.equal(newDraft.prompt, newPreview);
  assert.ok(await page.evaluate((count) => window.__videoPerformanceCounters.prepareVideoSeedanceReferenceDraft > count, bindingsBefore), 'changed-connection retry executes its required binding pass');
  const body = await page.evaluate(async (draft) => {
    const { resolveConfiguredVideoApi } = await import('/src/runningHubVideo.ts'); const { buildVideoApiBody } = await import('/src/videoGenerationApi.ts');
    return buildVideoApiBody(resolveConfiguredVideoApi(window.__seedanceCharacterBindingQa.retrySettings, draft), draft, draft.references.map((reference) => `https://synthetic.invalid/${reference.assetId}.png`));
  }, newDraft);
  assert.equal(body.prompt, newPreview); assert.equal(body.images.length, 8);
  newDraft.references.forEach((reference, index) => assert.ok(newPreview.split('\n').some((line) => line.startsWith(`@Image ${index + 1}：`) && line.includes(`当前资产已变更-${reference.assetId}`))));
  return { exactFrozenPrompt: true, exactFrozenReferences: true, reusedSnapshot: true, explicitImageChangeUnfreezes: true, changedConnectionRebinds: true, previewAndSerializedRequestAgree: true };
}

async function runVariant(variant) {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const instrumentation = { name: 'qa-only-call-counters', enforce: 'pre', transform(source, id) {
    const clean = id.replaceAll('\\', '/').split('?')[0];
    if (variant === 'before' && baselineView && clean.endsWith('/src/components/VideoDirectorView.tsx')) source = baselineView;
    const entries = [...instrumented.entries()].find(([suffix]) => clean.endsWith(suffix));
    if (entries) for (const name of entries[1]) {
      const expressionBody = name === 'videoPromptChoices' || name === 'videoPromptReferencePreviews';
      if (expressionBody) continue;
      const pattern = new RegExp(`(export const ${name} = [\\s\\S]*?=> \\{)`);
      source = source.replace(pattern, `$1\n globalThis.__videoPerformanceCounters ||= {}; globalThis.__videoPerformanceCounters.${name} = (globalThis.__videoPerformanceCounters.${name} || 0) + 1;`);
    }
    return source;
  } };
  const server = await createServer({ root, plugins: [instrumentation], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); let browser;
  try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(60000);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    if (process.argv.includes('--tail-only')) {
      try { const tail = await targetedTail(page, origin); assert.deepEqual(errors, []); return { passed: true, tail, errors }; }
      catch (error) { await fs.writeFile(path.join(output, 'tail-failure.txt'), await page.locator('body').innerText()); await page.screenshot({ path: path.join(output, 'tail-failure.png') }); throw error; }
    }
    if (process.argv.includes('--retry-only')) {
      await installSeedanceCharacterBindingFixture(page, origin);
      await page.evaluate(async () => {
        const qa = window.__seedanceCharacterBindingQa;
        const { emptyVideoDraft, videoPromptChoices, applyVideoPromptChoice } = await import('/src/videoDirectorDraft.ts');
        const { prepareVideoH3ReferenceDraft } = await import('/src/videoH3ReferenceBinding.ts');
        const draft = applyVideoPromptChoice(emptyVideoDraft(qa.settings), videoPromptChoices(qa.project, undefined, 'seedance')[0], qa.project, false);
        draft.references = qa.project.assets.map((asset, index) => ({ assetId: asset.id, role: qa.roles[index], slotIndex: index }));
        qa.submissions.push({ items: [{ draft: prepareVideoH3ReferenceDraft(qa.project, draft, { backend: 'api', api: qa.settings.videoTaskApi }).draft }] });
      });
      try { const retry = await targetedFrozenRetry(page); assert.deepEqual(errors, []); return { passed: true, retry, errors }; }
      catch (error) { await fs.writeFile(path.join(output, 'retry-failure.txt'), await page.locator('body').innerText()); await page.screenshot({ path: path.join(output, 'retry-failure.png') }); throw error; }
    }
    const fixture = await installSeedanceCharacterBindingFixture(page, origin);
    console.log(`[${variant}] warm modules ready; measuring 16 segments`);
    const performance = await measure(page);
    console.log(`[${variant}] mount ${performance.mount.renderMs.toFixed(1)} ms; preview ${performance.preview.renderMs.toFixed(1)} ms`);
    await fs.writeFile(path.join(output, `${variant}-performance.json`), JSON.stringify(performance, null, 2));
    assert.deepEqual(errors, []); assert.deepEqual(fixture.blockedRequests, []);
    let functional;
    if (variant === 'after') {
      const bindingPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const bindingFixture = await installSeedanceCharacterBindingFixture(bindingPage, origin);
      functional = await runSeedanceCharacterBindingAssertions(bindingPage, output);
      assert.deepEqual(bindingFixture.blockedRequests, []);
      functional.frozenRetry = await targetedFrozenRetry(bindingPage);
      await fs.writeFile(path.join(output, 'binding-and-frozen-report.json'), JSON.stringify(functional, null, 2));
      const tailPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      functional.tail = await targetedTail(tailPage, origin);
    }
    return { performance, functional, errors, blockedRequests: fixture.blockedRequests };
  } finally { await browser?.close(); await server.close(); }
}

await fs.mkdir(output, { recursive: true });
try {
  if (process.argv.includes('--tail-only') || process.argv.includes('--retry-only')) {
    const report = await runVariant('after'); await fs.writeFile(path.join(output, process.argv.includes('--tail-only') ? 'tail-report.json' : 'retry-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } else {
  const before = baselineView ? await runVariant('before') : undefined; const after = await runVariant('after');
  assert.equal(after.performance.mount.counters.prepareVideoTailCharacterDraft || 0, 0, 'ordinary batch mount does not prepare disabled tail modes');
  assert.equal(after.performance.mount.counters.readVideoDirectorChapterDraft, 1, 'initial chapter draft is read once');
  if (before) assert.ok(after.performance.mount.counters.prepareVideoSeedanceReferenceDraft < before.performance.mount.counters.prepareVideoSeedanceReferenceDraft, 'each unchanged candidate loses its redundant second binding');
  assert.equal(after.performance.mount.counters.prepareVideoSeedanceReferenceDraft, after.performance.mount.counters.buildVideoBatchRows * 30, 'one binding per bilingual candidate for each actual source rebuild');
  const report = { passed: true, description: 'Current UI deterministic call counts; optional --compare-ui-baseline replaces only UI source with HEAD for a before/after comparison. React Profiler render time excludes Vite imports and fixture construction.', before, after };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2)); console.error(error); process.exitCode = 1;
}
