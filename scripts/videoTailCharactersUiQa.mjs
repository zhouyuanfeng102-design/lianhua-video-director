import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A component-only harness. It never mounts App, loads saved projects, reads
// native files, or makes an image/video/vision API request. All asynchronous
// media work and paid submission boundaries are controlled below.
export const tailCharactersQaInventory = [
  '保留尾帧单独入口；新增组合入口首段禁用，配置不弹窗',
  '准确上段最新成片本地提取真实末帧，尾帧第1槽、所选人物第2槽起',
  'H3 Picture重新编号、Subject编号不改，中英文同时绑定',
  '人物主图回退不混入历史生成图、场景图或私密图',
  '无前段成片或前段已选时只配置依赖；文本API关闭时仍可完成，零文本/视觉AI请求',
  '中英文读取已有稿，预览、选图、复制、尾帧组合与批量提交不重写剧情/对白/镜头/声音',
  '批量配置不会偷选缺失前段，槽不足明确说明且不丢图',
  'RunningHub四槽：三位主角有图、摊主仅文字无图，一键组合不要求配角补图且不占槽',
  'RunningHub四槽按每段实际3/2/0图提交，未使用槽显式清空，不补图、不带云端旧图',
  'RunningHub尾帧＋两人物只占3/4槽，可直接生成或建立逐段依赖；超容量仍有具体错误',
  '中英文配角剧情与Subject保留；首段构图＋三主角、后续本地末帧＋三主角按真实云端映射提交mock',
  '取消组合恢复原选图/原提示词，原资产、分镜、视频不变',
  '改变批量起点清理旧依赖；已确认的同ID尾帧内容变化不提交',
  '抽帧错误及取消不改动参考图，连接/项目/素材变化丢弃迟到结果',
  '1120×760、1280×800按钮可操作且无横向溢出',
];

export async function installTailCharactersFixture(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const blockedRequests = [];
  const textRequests = [];
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/unused-comfy/**', async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/unused-runninghub/**', async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/unused-text/**', async (route) => {
    textRequests.push(route.request().url()); blockedRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/__video_tail_characters_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__video_tail_characters_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    await import('/src/styles.css');
    const e = React.createElement; const state = createInitialState(); const now = Date.now();
    const makeImage = (id, name, entityId, extra = {}) => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 150;
      const paint = canvas.getContext('2d'); paint.fillStyle = entityId === 'tcq-character-b' ? '#577351' : '#45648c'; paint.fillRect(0, 0, 240, 150);
      paint.fillStyle = '#fff'; paint.font = '18px sans-serif'; paint.fillText(name, 12, 82);
      return { id, name, type: 'reference', role: 'character', referenceRole: 'character', source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 240, height: 150, relativePath: `assets/${id}.png`, checksum: `checksum-${id}`, sourceEntityId: entityId, sourceEntityKind: entityId ? 'character' : undefined, tags: [], createdAt: now, updatedAt: now, ...extra };
    };
    const assets = [
      makeImage('tcq-a-primary', '甲人物普通主图', 'tcq-character-a'),
      makeImage('tcq-a-selected', '甲人物已选参考', 'tcq-character-a'),
      makeImage('tcq-b-primary', '乙人物普通主图', 'tcq-character-b'),
      makeImage('tcq-a-private', '甲人物私密图', 'tcq-character-a', { referenceScope: 'nsfw-private-profile', imageVariant: 'private-full-body' }),
      makeImage('tcq-a-history', '甲人物历史生成图', 'tcq-character-a', { source: 'generated', sourceStoryboardId: 'tcq-board-1', imageVariant: 'storyboard-frame' }),
      makeImage('tcq-scene', '无关场景图', undefined, { role: 'scene', referenceRole: 'scene', sourceEntityKind: 'location' }),
    ];
    const characters = ['a', 'b'].map((letter, index) => ({ id: `tcq-character-${letter}`, name: index ? '乙人物' : '甲人物', gender: index ? '男' : '女', apparentAge: '30', race: '人类', appearance: '固定身份', outfit: '普通外套', signatureProps: '', personality: '', motionHabits: '', anchor: '隔离测试人物', negativeContinuity: '', assetIds: index ? ['tcq-b-primary'] : ['tcq-a-primary', 'tcq-a-private', 'tcq-a-history'] }));
    const segments = Array.from({ length: 3 }, (_, offset) => ({ id: `tcq-segment-${offset + 1}`, index: offset + 1, title: `同行第${offset + 1}段`, globalStartSec: offset * 15, globalEndSec: (offset + 1) * 15, durationSec: 15, content: '甲人物与乙人物沿山道并肩前行。', summary: '连续前行', sourceSceneIds: ['tcq-scene'], sourceBeatIds: [], narrativePurpose: '连续动作', entryState: '', exitState: '', transitionHint: '', storyboardId: `tcq-board-${offset + 1}`, status: 'ready' }));
    const plan = { id: 'tcq-plan', title: '尾帧＋人物参考隔离验证', sourceStoryTitle: '隔离测试剧情', sourceStoryContent: '甲人物与乙人物沿山道并肩前行。', durationMode: 'ai-estimated', totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const prompt = (language, index, references) => [
      'subject_definitions:',
      `<Subject 1> is 甲人物 ${references.includes('tcq-a-selected') ? `referenced from <Picture ${references.indexOf('tcq-a-selected') + 1}>` : 'defined by the canonical prompt'}: ${language === 'en' ? 'person A, ordinary coat' : '甲人物，普通外套'}。`,
      `<Subject 2> is 乙人物 ${references.includes('tcq-b-primary') ? `referenced from <Picture ${references.indexOf('tcq-b-primary') + 1}>` : 'defined by the canonical prompt'}: ${language === 'en' ? 'person B, ordinary coat' : '乙人物，普通外套'}。`,
      'summary:', language === 'en' ? `Both people continue walking in segment ${index}.` : `第${index}段，两人继续前行。`,
      'retention_analysis:',
      `<Subject 1>${references.includes('tcq-a-selected') ? ` reference <Picture ${references.indexOf('tcq-a-selected') + 1}>` : ''}; <Subject 2>${references.includes('tcq-b-primary') ? ` reference <Picture ${references.indexOf('tcq-b-primary') + 1}>` : ''}.`,
      'detailed_description:', language === 'en'
        ? 'Shot 1 【0s-15s】 <Subject 1> walks beside <Subject 2> along the road. Dialogue by <Subject 1>: "明天一起出发。"'
        : 'Shot 1 【0s-15s】<Subject 1>与<Subject 2>沿山道并肩前行。<Subject 1>说：“明天一起出发。”',
      'overall_soundscape:', language === 'en' ? 'Footsteps and wind.' : '脚步与风声。',
      'non_diegetic_music:', language === 'en' ? 'Keep the authored existing music state.' : '维持原有配乐状态。',
    ].join('\n');
    const makeBoard = (segment, references = ['tcq-a-selected', 'tcq-b-primary']) => {
      const addSceneSource = (value) => references.includes('tcq-scene') ? value.replace('summary:', `summary:\nScene from <Picture ${references.indexOf('tcq-scene') + 1}>.`) : value;
      const zh = addSceneSource(prompt('zh', segment.index, references)); const en = addSceneSource(prompt('en', segment.index, references));
      return { id: segment.storyboardId, sceneId: 'tcq-scene', sourceStoryTitle: segment.title, workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: references, finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh, officialPromptEn: en, officialPromptEnSource: zh, englishPrompt: en, englishPromptSource: zh, promptMigrationPending: false,
        targetOutput: { prompt: zh, referenceManifest: references.map((id, index) => ({ id, token: `<Picture ${index + 1}>` })) },
        promptTrace: { sourceDocumentIds: [], referenceAssetIds: references, generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete' },
        shots: [{ id: `tcq-shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, subject: '甲人物与乙人物', action: '并肩前行', camera: '跟拍', lighting: '自然光', sound: '风声', referenceAssetIds: references, prompt: zh, locked: false }], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, createdAt: now, updatedAt: now };
    };
    // Reproduce the reported cloud workflow: the first segment already has a
    // composition image + three identity images. Later segments initially have
    // only the three identity images; the one-click action reserves slot 1 for
    // their exact predecessor's local last frame. The stallholder is authored
    // text, not an unfulfilled request for a fourth identity reference.
    const supportingRolePrompt = (language, index, references) => {
      const identityIds = ['tcq-a-selected', 'tcq-b-primary', 'tcq-c-primary'];
      const names = ['甲人物', '乙人物', '丙人物'];
      const vendor = index === 3;
      return [
        'subject_definitions:',
        ...identityIds.map((id, offset) => `<Subject ${offset + 1}> is ${names[offset]} referenced from <Picture ${references.indexOf(id) + 1}>: ${language === 'en' ? `person ${['A', 'B', 'C'][offset]}, ordinary coat` : `${names[offset]}，普通外套`}。`),
        ...(vendor ? [`<Subject 4> is 摊主 defined by the canonical prompt: ${language === 'en' ? 'adult stallholder, plain apron' : '成年摊主，朴素围裙'}。`] : []),
        'summary:', language === 'en' ? `Three people visit the mooncake stall in segment ${index}.` : `第${index}段，三人来到月饼摊前。`,
        ...(references.includes('tcq-scene') ? [`Scene composition from <Picture ${references.indexOf('tcq-scene') + 1}>.`] : []),
        'retention_analysis:', identityIds.map((id, offset) => `<Subject ${offset + 1}> reference <Picture ${references.indexOf(id) + 1}>.`).join(' '),
        'detailed_description:', language === 'en'
          ? `Shot 1 【0s-15s】 <Subject 1>, <Subject 2> and <Subject 3> stand at the stall.${vendor ? ' <Subject 4> passes the wrapped mooncakes to <Subject 1>. Dialogue by <Subject 4>: "月饼包好了。"' : ' Dialogue by <Subject 1>: "明天一起出发。"'}`
          : `Shot 1 【0s-15s】<Subject 1>、<Subject 2>与<Subject 3>站在摊前。${vendor ? '<Subject 4>把包好的月饼交给<Subject 1>。<Subject 4>说：“月饼包好了。”' : '<Subject 1>说：“明天一起出发。”'}`,
        'overall_soundscape:', language === 'en' ? 'Quiet marketplace ambience.' : '轻微集市环境声。',
        'non_diegetic_music:', language === 'en' ? 'Keep the authored existing music state.' : '维持原有配乐状态。',
      ].join('\n');
    };
    const makeVideo = (id, time) => ({ id, name: '第一段成片', type: 'video', mediaType: 'video', mimeType: 'video/mp4', role: 'motion', referenceRole: 'motion', source: 'generated', sourceStoryboardId: 'tcq-board-1', relativePath: `assets/${id}.mp4`, checksum: `checksum-${id}`, durationSec: 15, width: 480, height: 270, tags: [], createdAt: time, updatedAt: time });
    const makeProject = (options = {}) => {
      const varyingReferences = [['tcq-scene', 'tcq-a-selected', 'tcq-b-primary'], ['tcq-a-selected', 'tcq-b-primary'], []];
      const boards = segments.map((segment, index) => makeBoard(segment, options.varyingImageCounts ? varyingReferences[index] : options.withoutReferences ? [] : options.withScene ? ['tcq-a-selected', 'tcq-b-primary', 'tcq-scene'] : undefined));
      const project = { ...state.project, id: 'tcq-project', name: '尾帧＋人物隔离测试', sourceDocuments: [], characters: structuredClone(characters), locations: [], props: [], scenes: [{ id: 'tcq-scene', title: '隔离测试', content: '甲人物与乙人物沿山道并肩前行。', summary: '', characterIds: characters.map((character) => character.id), propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }], sequencePlans: [structuredClone(plan)], storyboards: boards, assets: [...structuredClone(assets), ...(options.withoutVideos ? [] : [makeVideo('tcq-video-old', now - 2000), makeVideo('tcq-video-new', now - 1000)])], generationTasks: [] };
      if (options.withSupportingCharacter) {
        project.assets.push(makeImage('tcq-c-primary', '丙人物普通主图', 'tcq-character-c'));
        project.characters.push(
          { ...structuredClone(characters[0]), id: 'tcq-character-c', name: '丙人物', assetIds: ['tcq-c-primary'] },
          { ...structuredClone(characters[1]), id: 'tcq-stallholder', name: '摊主', assetIds: [] },
        );
        project.scenes[0].content = '甲人物、乙人物和丙人物到月饼摊，摊主将包好的月饼交给甲人物。';
        project.scenes[0].characterIds = project.characters.map((character) => character.id);
        project.sequencePlans[0].sourceStoryContent = project.scenes[0].content;
        boards.forEach((board, offset) => {
          const references = [...(offset === 0 ? ['tcq-scene'] : []), 'tcq-a-selected', 'tcq-b-primary', 'tcq-c-primary'];
          const zh = supportingRolePrompt('zh', offset + 1, references); const en = supportingRolePrompt('en', offset + 1, references);
          const segment = project.sequencePlans[0].segments[offset];
          segment.content = offset === 2 ? project.scenes[0].content : '甲人物、乙人物和丙人物站在月饼摊前。';
          Object.assign(board, { globalReferenceAssetIds: references, finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh, officialPromptEn: en, officialPromptEnSource: zh, englishPrompt: en, englishPromptSource: zh,
            targetOutput: { prompt: zh, referenceManifest: references.map((id, index) => ({ id, token: `<Picture ${index + 1}>` })) },
            promptTrace: { ...board.promptTrace, referenceAssetIds: references, convertedPromptFingerprint: sourceContentHash(zh) },
          });
          Object.assign(board.shots[0], { subject: `甲人物、乙人物、丙人物${offset === 2 ? '、摊主' : ''}`, action: offset === 2 ? '摊主把包好的月饼交给甲人物。' : '三人在月饼摊前站定。', referenceAssetIds: references, prompt: zh });
        });
      }
      return project;
    };
    const makeSettings = (options = {}) => {
      const slotCount = options.slots ?? 3; const nodes = { 1: { class_type: 'Text', inputs: { text: '' } } };
      const images = Array.from({ length: slotCount }, (_, index) => { const nodeId = String(index + 2); nodes[nodeId] = { class_type: 'LoadImage', inputs: { image: '' } }; return { nodeId, inputName: 'image', role: index === 0 ? options.firstRole || 'general' : 'character' }; });
      const source = options.source || 'comfyui'; const mapping = { prompt: [{ nodeId: '1', inputName: 'text' }], images };
      return { ...state.settings, videoBackend: source === 'runninghub' ? 'api' : 'comfyui', videoSource: source,
        textApi: { ...state.settings.textApi, enabled: false, apiKey: '', baseUrl: `${location.origin}/unused-text/rewrite` }, textApiProfiles: [], activeTextApiProfileId: null,
        runningHubVideo: { enabled: true, baseUrl: `${location.origin}/unused-runninghub`, apiKey: '', activeWorkflowId: 'tcq-cloud-workflow', workflows: [{ id: 'tcq-cloud-workflow', name: '隔离四槽云端工作流', runKind: 'workflow', remoteId: '1234567890', requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: '' }, ...images.map((binding, index) => ({ nodeId: binding.nodeId, fieldName: binding.inputName, fieldValue: options.staleImageDefaults ? index === slotCount - 1 ? 'fixture-only/old-cloud-image.png' : 'None' : '' }))], usePersonalQueue: false }), mapping, createdAt: now, updatedAt: now }] },
        comfyuiVideo: { enabled: true, baseUrl: `${location.origin}/unused-comfy`, apiKey: '', activeWorkflowId: 'tcq-workflow', workflows: [{ id: 'tcq-workflow', name: '隔离三槽工作流', workflowJson: JSON.stringify(nodes), mapping, createdAt: now, updatedAt: now }] } };
    };
    const qa = window.__tailCharactersQa = { requests: [], submissions: [], cancels: 0, visualCalls: 0, rawExtracts: 0, holdCancel: false, frameCount: 0, resetCount: 0 };
    const controller = { runtimes: {}, start: async (draft) => { qa.submissions.push(structuredClone(draft)); return 'mock-task'; }, startBatch: async (input) => { qa.submissions.push(structuredClone(input)); return { taskIds: [], skipped: [] }; }, cancel: async () => {}, resume: async () => {}, retryDownload: async () => {} };
    function Harness() {
      const [currentProject, setProject] = React.useState(makeProject); const [currentSettings, setSettings] = React.useState(makeSettings); const [busy, setBusy] = React.useState(false); const [epoch, setEpoch] = React.useState(0);
      qa.project = currentProject; qa.settings = currentSettings; qa.busy = busy;
      qa.mutateProject = (mutation) => setProject((current) => mutation(structuredClone(current)));
      qa.mutateSettings = (mutation) => setSettings((current) => mutation(structuredClone(current)));
      qa.reset = (options = {}) => {
        if (qa.pending) throw new Error('Cannot reset an outstanding mock extraction operation');
        const project = makeProject(options);
        // The real director caches drafts per project, even after a remount.
        // Each isolated scenario must have its own identity so a previous
        // ComfyUI draft cannot override this scenario's RunningHub settings.
        project.id = `tcq-project-reset-${qa.resetCount + 1}`;
        qa.holdCancel = false; qa.requests = []; qa.submissions = []; qa.cancels = 0; qa.visualCalls = 0; qa.rawExtracts = 0; qa.originalBoards = JSON.stringify(project.storyboards); qa.originalAssets = JSON.stringify(project.assets); qa.originalVideos = JSON.stringify(project.assets.filter((asset) => asset.type === 'video'));
        setBusy(false); setProject(project); setSettings(makeSettings(options)); setEpoch((value) => value + 1); qa.resetCount += 1;
      };
      const tools = { available: true, busy, progress: busy ? { jobId: 'mock-select', projectId: currentProject.id, kind: 'extract', stage: 'processing', percent: 57, message: '正在本地提取真实末帧（隔离测试）' } : undefined,
        selectFrame: async () => { qa.visualCalls += 1; throw new Error('New composite UI must not request visual AI'); },
        extract: async (source) => {
          if (qa.pending) throw new Error('Concurrent mock local extraction');
          const ownerId = currentProject.id; qa.rawExtracts += 1; qa.requests.push(structuredClone(source)); qa.localAbort = new AbortController(); qa.signal = qa.localAbort.signal; setBusy(true);
          try { return await new Promise((resolve, reject) => { qa.pending = { source, ownerId, resolve: () => {
            const frame = { ...makeImage(`tcq-frame-${++qa.frameCount}`, `本地末帧画面${qa.frameCount}`, undefined), role: 'last-frame', referenceRole: 'last-frame', source: 'derived', sourceVideoAssetId: source.assetId, sourceVideoChecksum: source.expectedChecksum, sourceTimeSec: 14.96, sourceFrameIndex: 374 };
            setProject((current) => current.id === ownerId ? { ...current, assets: [frame, ...current.assets] } : current);
            resolve(frame);
          }, reject }; }); } finally { qa.pending = undefined; setBusy(false); }
        },
        cancel: async () => { qa.cancels += 1; qa.localAbort?.abort(); if (!qa.holdCancel) qa.pending?.reject(new DOMException('已取消本地末帧提取', 'AbortError')); },
      };
      return e('main', { style: { height: '100dvh', padding: 12, boxSizing: 'border-box', '--ui-font-scale': 1.5 } }, e(VideoDirectorView, { key: epoch, project: currentProject, settings: currentSettings, controller, tailFrameTools: tools }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).waitFor();
  return { blockedRequests, textRequests };
}

const assertCompositePrompt = (prompt, language = 'zh') => {
  assert.doesNotMatch(prompt, /supplies the opening continuity frame|reference_binding:/u, 'selecting images must not inject a reference preamble or new plot text');
  assert.match(prompt, /<Subject 1> is 甲人物 referenced from <Picture\s*2>/u, 'first identity shifted to Picture 2');
  assert.match(prompt, /<Subject 2> is 乙人物 referenced from <Picture\s*3>/u, 'second identity shifted to Picture 3');
  assert.match(prompt, /<Subject 1>/u); assert.match(prompt, /<Subject 2>/u); assert.doesNotMatch(prompt, /<Subject 3>/u, 'subject numbers must not be shifted');
  assert.match(prompt, language === 'en' ? /person A, ordinary coat/u : /甲人物，普通外套/u, 'authored identity and wardrobe text survives');
  for (const section of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) assert.equal(prompt.split(`${section}:`).length, 2, `one ${section} section remains`);
  assert.match(prompt, /明天一起出发/u, 'dialogue is retained verbatim');
};

export async function runTailCharactersUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = []; const layouts = [];
  const row = (index) => page.locator(`[data-segment-id="tcq-segment-${index}"]`);
  const composite = (index) => row(index).getByRole('button', { name: `第 ${index} 段本地末帧加参考图`, exact: true });
  const cancelComposite = (index) => row(index).getByRole('button', { name: `第 ${index} 段取消尾帧加参考图`, exact: true });
  const showList = async () => { const tab = page.getByRole('tab', { name: '分段清单', exact: true }); if (await tab.isVisible()) await tab.click(); };
  const reset = async (options = {}) => { await page.evaluate((value) => window.__tailCharactersQa.reset(value), options); await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); };
  const capture = async (name) => { if (!outputDirectory) return; const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file); };
  const counts = () => page.evaluate(() => ({ ai: window.__tailCharactersQa.visualCalls, submit: window.__tailCharactersQa.submissions.length, raw: window.__tailCharactersQa.rawExtracts }));
  const start = async () => { await showList(); await composite(2).click(); await page.waitForFunction(() => Boolean(window.__tailCharactersQa.pending)); assert.equal(await page.getByRole('dialog').count(), 0); };
  const finish = async () => { await page.evaluate(() => window.__tailCharactersQa.pending.resolve()); await page.waitForFunction(() => !window.__tailCharactersQa.pending && !window.__tailCharactersQa.busy); await page.getByRole('button', { name: '取消末帧提取', exact: true }).waitFor({ state: 'hidden' }); };
  const submit = async (count) => {
    const previousCount = (await counts()).submit;
    await showList(); await page.getByRole('button', { name: `检查并生成 ${count} 段视频`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true }); await dialog.waitFor();
    assert.equal((await counts()).submit, previousCount, 'opening fee confirmation never submits');
    const button = dialog.getByRole('button', { name: `确认生成 ${count} 段`, exact: true }); assert.equal(await button.isDisabled(), true);
    await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await button.click();
    await page.waitForFunction((value) => window.__tailCharactersQa.submissions.length === value, previousCount + 1);
    return page.evaluate(() => window.__tailCharactersQa.submissions.at(-1));
  };
  const currentPrompt = async (index) => { await showList(); await row(index).getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '完整提示词', exact: true }).click(); return page.locator('.vd-batch-preview .vd-prompt-preview').innerText(); };
  const savedPrompt = (index, language = 'zh') => page.evaluate(({ index, language }) => JSON.parse(window.__tailCharactersQa.originalBoards)[index - 1][language === 'en' ? 'officialPromptEn' : 'officialPromptZh'], { index, language });
  const assertPreparedPrompt = async (prompt, index, language = 'zh') => {
    assertCompositePrompt(prompt, language);
    assert.equal(prompt, (await savedPrompt(index, language)).replace(/<Picture ([12])>/gu, (_, number) => `<Picture ${Number(number) + 1}>`), 'the complete authored H3 text changes only its existing picture numbers');
  };
  const referencePreview = async (index) => { await showList(); await row(index).getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '参考图与用途', exact: true }).click(); return page.locator('.vd-batch-reference-preview > div').allInnerTexts(); };
  const originalsIntact = async () => {
    const integrity = await page.evaluate(() => { const qa = window.__tailCharactersQa; const original = JSON.parse(qa.originalAssets); return { boards: JSON.stringify(qa.project.storyboards) === qa.originalBoards, assets: original.every((asset) => JSON.stringify(qa.project.assets.find((entry) => entry.id === asset.id)) === JSON.stringify(asset)), videos: JSON.stringify(qa.project.assets.filter((asset) => asset.type === 'video')) === qa.originalVideos }; });
    assert.deepEqual(integrity, { boards: true, assets: true, videos: true });
    assert.equal(await page.evaluate(() => window.__tailCharactersQa.settings.textApi.enabled), false, 'all controls must work with the text API disabled');
  };
  // Use the real API builder after reconstructing a synthetic dependency tail.
  // This checks the submission boundary, not only an enabled UI button; neither
  // an uploader nor a generation engine is invoked.
  const cloudRequests = (input) => page.evaluate(async (batch) => {
    const { resolveConfiguredVideoApi } = await import('/src/runningHubVideo.ts');
    const { buildVideoApiBody } = await import('/src/videoGenerationApi.ts');
    const { videoBatchTailReferences } = await import('/src/videoBatch.ts');
    return batch.items.map((item) => {
      const api = resolveConfiguredVideoApi(window.__tailCharactersQa.settings, item.draft);
      const draft = structuredClone(item.draft);
      if (item.previousTail) draft.references = videoBatchTailReferences(draft.references, item.previousTail.placement, `mock-only-local-tail-${draft.source.segmentIndex}`);
      const imageIds = draft.references.map((reference) => reference.assetId);
      return { provider: api.provider, roles: api.runningHubImageRoles, imageIds, request: buildVideoApiBody(api, draft, imageIds.map((id) => `fixture-only/${id}.png`)) };
    });
  }, input);
  const assertCloudSlots = (mapped, prompt, expectedImageIds, emptyValue = 'None') => {
    assert.equal(mapped.provider, 'runninghub');
    assert.deepEqual(mapped.imageIds, expectedImageIds, 'the actual selection is neither padded nor truncated');
    assert.equal(mapped.request.nodeInfoList.length, 5, 'all four mapped image inputs remain explicit, including unused ones');
    assert.equal(mapped.request.nodeInfoList[0].fieldValue, prompt, 'the complete authored H3 prompt is unchanged');
    assert.deepEqual(mapped.request.nodeInfoList.slice(1).map((node) => [node.nodeId, node.fieldName, node.fieldValue]), Array.from({ length: 4 }, (_, offset) => [String(offset + 2), 'image', expectedImageIds[offset] ? `fixture-only/${expectedImageIds[offset]}.png` : emptyValue]));
    assert.equal(mapped.request.usePersonalQueue, false, 'unrelated cloud defaults remain unchanged');
    assert.doesNotMatch(JSON.stringify(mapped.request), /old-cloud-image|\{\{image_\d+\}\}/u, 'unused inputs contain neither a previous cloud image nor unresolved placeholders');
  };

  await reset();
  await row(2).getByRole('button', { name: '英文', exact: true }).click();
  assert.equal(await currentPrompt(2), await savedPrompt(2, 'en'), 'the English button reads the previously generated English prompt without translation');
  await showList(); await row(2).getByRole('button', { name: '第 2 段选择参考图', exact: true }).click();
  const rowPicker = page.getByRole('dialog', { name: '第 2 段 · 选择参考图', exact: true });
  await rowPicker.getByRole('button', { name: '使用本段图片', exact: true }).click();
  assert.equal(await currentPrompt(2), await savedPrompt(2, 'en'), 'ordinary reference selection never rewrites English plot or H3');
  await showList(); await row(2).getByRole('button', { name: '第 2 段复制上一段参考图', exact: true }).click();
  assert.equal(await currentPrompt(2), await savedPrompt(2, 'en'), 'copying the previous selection copies only images');
  await showList(); await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__tailCharactersQa.pending)); await finish();
  assert.equal(await currentPrompt(2), await savedPrompt(2, 'en'), 'the ordinary tail button does not rewrite any part of the prompt');
  await showList(); await row(2).getByRole('button', { name: '中文', exact: true }).click();
  assert.equal(await currentPrompt(2), await savedPrompt(2), 'switching back restores the saved Chinese text exactly');
  await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  const plainRowInput = await submit(1);
  assert.equal(plainRowInput.items[0].draft.prompt, await savedPrompt(2));
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 1 }); await originalsIntact();
  stages.push('all-row-controls-read-saved-language-and-preserve-full-prompt-with-text-api-disabled');

  await reset();
  assert.equal(await composite(1).isDisabled(), true);
  assert.equal(await row(2).getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).count(), 1);
  assert.equal(await composite(2).innerText(), '本地末帧＋参考图');
  await start();
  assert.equal(await page.evaluate(() => window.__tailCharactersQa.requests[0].assetId), 'tcq-video-new');
  assert.equal(await page.evaluate(() => window.__tailCharactersQa.requests[0].context), undefined);
  assert.equal(await page.getByRole('tab', { name: '单段生成', exact: true }).isDisabled(), true);
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 1 }); await capture('static-local-progress');
  await finish(); assert.equal(await page.getByRole('dialog').count(), 0); assert.match(await row(2).innerText(), /参考图 3 张/u);
  assert.equal(await page.locator('.vd-batch-columns').getAttribute('data-pane'), 'list', 'Local result does not switch to another screen');
  const staticPreview = await referencePreview(2); assert.equal(staticPreview.length, 3); assert.match(staticPreview[0], /^1\. 本地末帧画面/u); assert.match(staticPreview[1], /^2\. 甲人物已选参考/u); assert.match(staticPreview[2], /^3\. 乙人物普通主图/u); await capture('static-slot-order');
  await assertPreparedPrompt(await currentPrompt(2), 2); await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  const staticInput = await submit(1); const staticItem = staticInput.items[0];
  assert.match(staticItem.draft.references[0].assetId, /^tcq-frame-/u);
  assert.deepEqual(staticItem.draft.references.slice(1).map((reference) => reference.assetId), ['tcq-a-selected', 'tcq-b-primary']);
  assert.equal(staticItem.previousTail, undefined); await assertPreparedPrompt(staticItem.draft.prompt, 2); await originalsIntact();
  stages.push('static-latest-local-tail-is-slot-one-and-subject-numbering-is-stable');

  await showList(); await row(2).getByRole('button', { name: '英文', exact: true }).click();
  // Language switching reads the existing English delivery and only remaps
  // its image bindings; no translation/review request is needed.
  await row(2).getByRole('button', { name: '第 2 段选择参考图', exact: true }).click();
  const englishPicker = page.getByRole('dialog', { name: '第 2 段 · 选择参考图', exact: true });
  await englishPicker.getByRole('button', { name: '使用本段图片', exact: true }).click(); await englishPicker.waitFor({ state: 'hidden' });
  const englishInput = await submit(1); await assertPreparedPrompt(englishInput.items[0].draft.prompt, 2, 'en');
  assert.deepEqual(englishInput.items[0].draft.references, staticItem.draft.references);
  await showList(); await cancelComposite(2).click();
  const restoredEnglish = await currentPrompt(2); const originalEnglish = await page.evaluate(() => JSON.parse(window.__tailCharactersQa.originalBoards)[1].officialPromptEn);
  assert.equal(restoredEnglish, originalEnglish); await showList(); assert.match(await row(2).innerText(), /参考图 2 张/u);
  const restoredInput = await submit(1); assert.deepEqual(restoredInput.items[0].draft.references.map((reference) => reference.assetId), ['tcq-a-selected', 'tcq-b-primary']);
  assert.equal(restoredInput.items[0].draft.prompt, originalEnglish); await originalsIntact();
  stages.push('bilingual-bindings-and-cancel-restore-originals');

  await reset({ withoutReferences: true }); await start(); await finish(); await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  const fallback = (await submit(1)).items[0];
  assert.deepEqual(fallback.draft.references.slice(1).map((reference) => reference.assetId), ['tcq-a-primary', 'tcq-b-primary']);
  assert.ok(fallback.draft.references.every((reference) => !/private|history|scene/u.test(reference.assetId)));
  await originalsIntact(); stages.push('ordinary-primary-fallback-excludes-private-history-and-scene');

  await reset({ source: 'runninghub', slots: 4, varyingImageCounts: true, staleImageDefaults: true, withoutVideos: true });
  const varyingOriginalState = await page.evaluate(() => JSON.stringify({ project: window.__tailCharactersQa.project, settings: window.__tailCharactersQa.settings }));
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  for (const [offset, count] of [3, 2, 0].entries()) {
    assert.match(await row(offset + 1).innerText(), new RegExp(`参考图 ${count} 张`, 'u'));
    assert.doesNotMatch(await row(offset + 1).innerText(), /请按槽位选图|必须.*填满|数量不匹配/u);
  }
  assert.equal(await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).isDisabled(), false);
  await capture('runninghub-four-slots-variable-three-two-zero');
  const varyingInput = await submit(3);
  const expectedVaryingImages = [['tcq-scene', 'tcq-a-selected', 'tcq-b-primary'], ['tcq-a-selected', 'tcq-b-primary'], []];
  const varyingRequests = await cloudRequests(varyingInput);
  for (const [index, item] of varyingInput.items.entries()) {
    assert.equal(item.previousTail, undefined, 'ordinary per-segment references do not create an unwanted tail dependency');
    assert.deepEqual(item.draft.references.map((reference) => reference.assetId), expectedVaryingImages[index]);
    assert.equal(item.draft.prompt, await page.evaluate((offset) => JSON.parse(window.__tailCharactersQa.originalBoards)[offset].officialPromptZh, index));
    assertCloudSlots(varyingRequests[index], item.draft.prompt, expectedVaryingImages[index]);
  }
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 0 }); await originalsIntact();
  assert.equal(await page.evaluate(() => JSON.stringify({ project: window.__tailCharactersQa.project, settings: window.__tailCharactersQa.settings })), varyingOriginalState);
  stages.push('runninghub-four-slots-submit-per-segment-three-two-zero-images-and-explicitly-clear-unused-cloud-inputs');

  await reset({ source: 'runninghub', slots: 4, firstRole: 'first-frame', staleImageDefaults: true });
  await start(); await finish(); await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  assert.match(await row(2).innerText(), /参考图 3 张/u);
  const cloudStatic = await submit(1); const cloudStaticItem = cloudStatic.items[0];
  assert.equal(cloudStaticItem.draft.references[0].role, 'first-frame');
  assert.deepEqual(cloudStaticItem.draft.references.slice(1).map((reference) => reference.assetId), ['tcq-a-selected', 'tcq-b-primary']);
  await assertPreparedPrompt(cloudStaticItem.draft.prompt, 2);
  assertCloudSlots((await cloudRequests(cloudStatic))[0], cloudStaticItem.draft.prompt, cloudStaticItem.draft.references.map((reference) => reference.assetId));
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 1 }); await originalsIntact();
  stages.push('runninghub-static-local-tail-and-two-identities-use-three-of-four-slots');

  await reset({ source: 'runninghub', slots: 4, staleImageDefaults: true, withoutVideos: true });
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 });
  for (const index of [2, 3]) assert.match(await row(index).innerText(), /最终参考图 3 张/u);
  const cloudDeferred = await submit(3); const cloudDeferredRequests = await cloudRequests(cloudDeferred);
  for (const [index, item] of cloudDeferred.items.entries()) {
    const expected = [...(index ? [`mock-only-local-tail-${index + 1}`] : []), 'tcq-a-selected', 'tcq-b-primary'];
    assertCloudSlots(cloudDeferredRequests[index], item.draft.prompt, expected);
    if (index) {
      assert.equal(item.previousTail.predecessorItemKey, cloudDeferred.items[index - 1].itemKey);
      assert.equal(item.previousTail.requireAiSelection, undefined); assert.equal(item.previousTail.selectionMode, undefined);
      await assertPreparedPrompt(item.draft.prompt, index + 1);
    } else assert.equal(item.previousTail, undefined);
  }
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 0 }); await originalsIntact();
  stages.push('runninghub-underfilled-tail-queue-keeps-exact-predecessors-and-only-needed-images');

  await reset({ source: 'runninghub', slots: 2, withScene: true });
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  assert.match(await row(1).innerText(), /(?:3 张[\s\S]*(?:超出|超过|只有|最多支持)[\s\S]*2|2 个[\s\S]*3 张)/u, 'capacity errors identify both the selected image count and available slots');
  assert.equal(await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).isDisabled(), true);
  assert.match(await row(1).innerText(), /参考图 3 张/u, 'over-capacity selection remains visible instead of silently dropping a picture');
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); await originalsIntact();
  stages.push('runninghub-over-capacity-still-gives-a-specific-error-and-preserves-all-selected-images');

  await reset(); await row(1).getByLabel('选择第 1 段', { exact: true }).check(); await row(2).getByLabel('选择第 2 段', { exact: true }).check(); await composite(2).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await row(2).innerText(), /最终参考图 3 张/u); await assertPreparedPrompt(await currentPrompt(2), 2);
  const dependencyPreview = await referencePreview(2); assert.equal(dependencyPreview.length, 3); assert.match(dependencyPreview[0], /^1\. 等待上一段本地真实末帧/u); assert.match(dependencyPreview[1], /^2\. 甲人物已选参考/u); assert.match(dependencyPreview[2], /^3\. 乙人物普通主图/u); await capture('future-slot-order');
  const dependentInput = await submit(2); const dependent = dependentInput.items.find((item) => item.draft.source.segmentIndex === 2);
  assert.equal(dependent.previousTail.placement.mode, 'prepend'); assert.equal(dependent.previousTail.placement.index, 0); assert.equal(dependent.previousTail.requireAiSelection, undefined); assert.equal(dependent.previousTail.selectionMode, undefined);
  assert.equal(dependent.previousTail.predecessorItemKey, dependentInput.items[0].itemKey);
  assert.deepEqual(dependent.draft.references.map((reference) => reference.assetId), ['tcq-a-selected', 'tcq-b-primary']); await assertPreparedPrompt(dependent.draft.prompt, 2);
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 0 }); await originalsIntact(); stages.push('selected-predecessor-defers-local-extraction-and-preserves-durable-slot-zero-dependency');

  await reset({ withoutVideos: true }); await composite(2).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await row(2).innerText(), /第 1 段/u); assert.equal(await row(1).getByLabel('选择第 1 段', { exact: true }).isChecked(), false);
  await row(2).getByLabel('选择第 2 段', { exact: true }).check(); assert.equal(await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).isDisabled(), true);
  await cancelComposite(2).click(); assert.match(await row(2).innerText(), /参考图 2 张/u); stages.push('missing-predecessor-does-not-auto-select-or-charge');

  await reset({ slots: 2 }); await composite(2).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); assert.match(await page.locator('.vd-batch-panel').innerText(), /需要 3 个图片槽[\s\S]*只有 2 个/u);
  assert.equal(await cancelComposite(2).count(), 0); assert.match(await row(2).innerText(), /参考图 2 张/u); await originalsIntact(); await capture('insufficient-slots'); stages.push('slot-capacity-is-explicit-and-never-drops-a-character');

  await reset({ firstRole: 'first-frame' }); await start(); await finish(); await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  const firstFrame = (await submit(1)).items[0]; assert.equal(firstFrame.draft.references[0].role, 'first-frame'); assert.deepEqual(firstFrame.draft.references.slice(1).map((reference) => reference.role), ['character', 'character']);
  stages.push('explicit-first-frame-mapping-is-respected-at-slot-zero');

  await reset({ withScene: true }); await start(); await finish();
  assert.match(await currentPrompt(2), /Scene from <Picture 1>/u, 'old scene token now names the continuity frame');
  const scenePreview = await referencePreview(2); assert.equal(scenePreview.length, 3);
  assert.match(await page.locator('.vd-batch-reference-preview').innerText(), /无关场景图[\s\S]*开场画面职责改由图片1/u, 'scene replacement responsibility is disclosed');
  assert.match(await page.locator('.vd-batch-reference-preview').innerText(), /普通\/构图参考[\s\S]*不保证视频严格/u, 'ordinary first slot is not presented as strong first-frame conditioning');
  await page.getByRole('button', { name: '收起批量设置', exact: true }).click(); await capture('scene-responsibility-and-slot-warning'); await originalsIntact(); stages.push('scene-replacement-and-non-first-frame-warning-are-visible');

  await reset({ slots: 4 }); await row(2).getByRole('button', { name: '第 2 段选择参考图', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '第 2 段 · 选择参考图', exact: true });
  await picker.getByRole('button', { name: '选择图片 甲人物私密图', exact: true }).click(); await picker.getByRole('button', { name: '使用本段图片', exact: true }).click(); await composite(2).click();
  await page.waitForFunction(() => Boolean(window.__tailCharactersQa.pending)); await finish();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 1 });
  const explicitlySelectedPreview = await referencePreview(2);
  assert.equal(explicitlySelectedPreview.length, 4, 'tail and every explicitly selected image are kept');
  assert.ok(explicitlySelectedPreview.some((entry) => entry.includes('甲人物私密图')), 'an explicitly chosen image is not filtered by category');
  await showList(); assert.match(await row(2).innerText(), /参考图 4 张/u); assert.equal(await cancelComposite(2).count(), 1); await originalsIntact(); stages.push('explicit-other-image-selection-is-preserved-without-type-gating-or-auto-submission');

  await reset(); await row(1).getByLabel('选择第 1 段', { exact: true }).check(); await row(3).getByLabel('选择第 3 段', { exact: true }).check(); await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); assert.equal(await row(2).getByLabel('选择第 2 段', { exact: true }).isChecked(), false); assert.equal(await cancelComposite(3).count(), 0);
  assert.match(await page.locator('.vd-batch-panel').innerText(), /请同时选中准确的第 2 段/u); stages.push('gapped-bulk-selection-never-borrows-an-unrelated-predecessor');

  await reset(); await start(); await page.evaluate(() => window.__tailCharactersQa.pending.reject(new Error('隔离测试：本地抽帧不可用'))); await page.waitForFunction(() => !window.__tailCharactersQa.pending);
  assert.match(await page.locator('.vd-batch-panel').innerText(), /本地抽帧不可用/u); assert.match(await row(2).innerText(), /参考图 2 张/u); assert.equal((await counts()).raw, 1); assert.equal((await counts()).ai, 0);
  await start(); await finish(); await originalsIntact(); stages.push('local-extraction-failure-displays-reason-and-preserves-references');

  await reset(); await page.evaluate(() => { window.__tailCharactersQa.holdCancel = true; }); await start();
  await page.getByRole('button', { name: '取消末帧提取', exact: true }).click(); await page.waitForFunction(() => window.__tailCharactersQa.signal.aborted); await finish();
  await showList(); assert.match(await row(2).innerText(), /参考图 2 张/u); assert.equal(await cancelComposite(2).count(), 0); assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 1 }); await originalsIntact(); stages.push('cancelled-late-local-result-is-never-bound');

  for (const change of ['source', 'reference', 'connection', 'project']) {
    await reset(); await page.evaluate(() => { window.__tailCharactersQa.holdCancel = true; }); await start();
    await page.evaluate((kind) => {
      const qa = window.__tailCharactersQa;
      if (kind === 'connection') qa.mutateSettings((settings) => { settings.comfyuiVideo.baseUrl += '-changed'; return settings; });
      else qa.mutateProject((project) => { if (kind === 'project') project.id += '-other'; else project.assets.find((asset) => asset.id === (kind === 'source' ? 'tcq-video-new' : 'tcq-a-selected')).checksum = 'changed'; return project; });
    }, change);
    await page.waitForFunction(() => window.__tailCharactersQa.signal.aborted); await finish();
    await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); await showList(); assert.match(await row(2).innerText(), /参考图 2 张/u); assert.equal(await cancelComposite(2).count(), 0); assert.equal((await counts()).submit, 0);
    stages.push(`${change}-invalidates-stale-local-result`);
  }

  for (const field of ['checksum', 'relativePath']) {
    await reset(); await start(); await finish(); await showList(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
    await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
    await confirmation.getByLabel('确认批量生成费用', { exact: true }).check();
    await page.evaluate((property) => window.__tailCharactersQa.mutateProject((project) => {
      const frame = project.assets.find((asset) => /^tcq-frame-/u.test(asset.id));
      if (!frame) throw new Error('Missing generated fixture frame');
      frame[property] = property === 'checksum' ? 'replaced-same-id-image-content' : 'assets/replaced-same-id-frame.png';
      return project;
    }), field);
    await page.waitForFunction(() => document.querySelector('[data-segment-id="tcq-segment-2"]')?.textContent.includes('图片内容已变化')).catch((cause) => { throw new Error(`Same-ID tail ${field} change was not detected`, { cause }); });
    await confirmation.getByRole('button', { name: '确认生成 1 段', exact: true }).click(); await confirmation.waitFor({ state: 'hidden' });
    assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 1 }); assert.match(await row(2).innerText(), /图片内容已变化/u);
    assert.equal(await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).isDisabled(), true);
    await originalsIntact(); stages.push(`same-id-tail-${field}-invalidates-open-fee-confirmation`);
  }

  await reset(); await page.getByRole('button', { name: '全选中文', exact: true }).click(); await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
  await row(1).getByLabel('选择第 1 段', { exact: true }).uncheck();
  assert.match(await row(2).innerText(), /同时选择第 1 段/u);
  await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
  assert.equal(await cancelComposite(2).count(), 0); assert.equal(await cancelComposite(3).count(), 1); assert.match(await row(2).innerText(), /参考图 2 张/u);
  assert.equal(await currentPrompt(2), await page.evaluate(() => JSON.parse(window.__tailCharactersQa.originalBoards)[1].officialPromptZh));
  const shifted = await submit(2); assert.deepEqual(shifted.items.map((item) => item.draft.source.segmentIndex), [2, 3]); assert.equal(shifted.items[0].previousTail, undefined);
  assert.equal(shifted.items[1].previousTail.predecessorItemKey, shifted.items[0].itemKey); assert.equal(shifted.items[1].previousTail.placement.mode, 'prepend'); assert.equal(shifted.items[1].previousTail.placement.index, 0);
  assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 0 }); await originalsIntact(); stages.push('shifted-bulk-start-clears-old-dependency-and-restores-starting-prompt');

  for (const language of ['zh', 'en']) {
    await reset({ source: 'runninghub', slots: 4, firstRole: 'first-frame', withSupportingCharacter: true, withoutVideos: true });
    assert.equal(await page.getByLabel('批量生成方式', { exact: true }).inputValue(), 'runninghub');
    const originalState = await page.evaluate(() => JSON.stringify({ project: window.__tailCharactersQa.project, settings: window.__tailCharactersQa.settings }));
    const originalPrompt = await page.evaluate((value) => window.__tailCharactersQa.project.storyboards[2][value === 'en' ? 'officialPromptEn' : 'officialPromptZh'], language);
    assert.match(await row(3).innerText(), /参考图 3 张/u, 'the unconfigured follower retains only its three identity references');
    assert.doesNotMatch(await row(3).innerText(), /本段有 3 张；请按槽位|要求填满/u, 'unused cloud slots no longer require filler images');
    await page.getByRole('button', { name: language === 'en' ? '全选英文' : '全选中文', exact: true }).click();
    await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'one-click setup does not open another dialog');
    assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }, 'a text-only supporting character creates no visual selection call');
    assert.equal(await cancelComposite(1).count(), 0); assert.equal(await cancelComposite(2).count(), 1); assert.equal(await cancelComposite(3).count(), 1);
    assert.match(await row(3).innerText(), /最终参考图 4 张/u);
    assert.doesNotMatch(await page.locator('.vd-batch-panel').innerText(), /摊主[^\n]*(?:没有可用|补图|需要.*图片)/u, 'the stallholder is not treated as a missing identity input');
    const preview = await referencePreview(3);
    assert.equal(preview.length, 4, 'only the continuation frame and three main identities occupy slots');
    assert.match(preview[0], /^1\. 等待上一段本地真实末帧/u);
    for (const [index, name] of ['甲人物已选参考', '乙人物普通主图', '丙人物普通主图'].entries()) assert.match(preview[index + 1], new RegExp(`^${index + 2}\\. ${name}`, 'u'));
    await capture(`runninghub-supporting-role-${language}-four-slots`);
    const previewPrompt = await currentPrompt(3);
    assert.equal(previewPrompt, originalPrompt.replace(/<Picture ([123])>/gu, (_, number) => `<Picture ${Number(number) + 1}>`), 'supporting-role prompts also retain every authored byte except picture numbers');
    const vendorDefinition = originalPrompt.split('\n').find((line) => line.startsWith('<Subject 4> is 摊主'));
    assert.ok(vendorDefinition); assert.ok(previewPrompt.split('\n').includes(vendorDefinition), 'the canonical text-only supporting Subject is kept verbatim');
    for (const [index, name] of ['甲人物', '乙人物', '丙人物'].entries()) assert.match(previewPrompt, new RegExp(`<Subject ${index + 1}> is ${name} referenced from <Picture ${index + 2}>`, 'u'));
    assert.equal(previewPrompt.slice(previewPrompt.indexOf('detailed_description:')), originalPrompt.slice(originalPrompt.indexOf('detailed_description:')), 'supporting action, dialogue, all Shot/At text and sound remain exactly authored');
    assert.match(previewPrompt, /月饼包好了/u); assert.doesNotMatch(previewPrompt, /<Picture\s*5>/u, 'a supporting character does not create a fifth picture slot');
    for (const section of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) assert.equal(previewPrompt.split(`${section}:`).length, 2, `one ${section} section remains in ${language}`);
    const cloudInput = await submit(3);
    assert.deepEqual(cloudInput.items[0].draft.references.map((reference) => reference.assetId), ['tcq-scene', 'tcq-a-selected', 'tcq-b-primary', 'tcq-c-primary']);
    assert.equal(cloudInput.items[0].previousTail, undefined, 'first segment retains its explicitly selected composition');
    for (let index = 1; index < cloudInput.items.length; index += 1) {
      const item = cloudInput.items[index];
      assert.equal(item.draft.backend, 'api'); assert.equal(item.draft.runningHubWorkflowId, 'tcq-cloud-workflow');
      assert.deepEqual(item.draft.references.map((reference) => reference.assetId), ['tcq-a-selected', 'tcq-b-primary', 'tcq-c-primary']);
      assert.deepEqual(item.draft.references.map((reference) => reference.role), ['character', 'character', 'character']);
      assert.equal(item.previousTail.predecessorItemKey, cloudInput.items[index - 1].itemKey);
      assert.equal(item.previousTail.requireAiSelection, undefined); assert.equal(item.previousTail.selectionMode, undefined); assert.equal(item.previousTail.placement.mode, 'prepend'); assert.equal(item.previousTail.placement.index, 0);
    }
    assert.equal(cloudInput.items[2].draft.prompt, previewPrompt, 'the submitted third prompt matches the inspected H3 preview');
    const mappedRequests = await cloudRequests(cloudInput);
    for (const [index, mapped] of mappedRequests.entries()) {
      assert.equal(mapped.provider, 'runninghub'); assert.deepEqual(mapped.roles, ['first-frame', 'character', 'character', 'character']);
      assert.deepEqual(mapped.imageIds, [index === 0 ? 'tcq-scene' : `mock-only-local-tail-${index + 1}`, 'tcq-a-selected', 'tcq-b-primary', 'tcq-c-primary']);
      assert.equal(mapped.request.nodeInfoList.length, 5, 'one prompt and exactly four explicitly mapped image fields');
      assert.equal(mapped.request.nodeInfoList[0].fieldValue, cloudInput.items[index].draft.prompt);
      assert.deepEqual(mapped.request.nodeInfoList.slice(1).map((node) => [node.nodeId, node.fieldName, node.fieldValue]), mapped.imageIds.map((id, offset) => [String(offset + 2), 'image', `fixture-only/${id}.png`]));
      assert.equal(mapped.request.usePersonalQueue, false, 'unrelated provider defaults are retained');
    }
    assert.deepEqual(await counts(), { ai: 0, submit: 1, raw: 0 }); await originalsIntact();
    assert.equal(await page.evaluate(() => JSON.stringify({ project: window.__tailCharactersQa.project, settings: window.__tailCharactersQa.settings })), originalState, 'one-click configuration and mock submission do not mutate the source project or settings');
    stages.push(`runninghub-${language}-three-main-identities-and-text-only-stallholder-fit-four-slots-without-visual-ai`);
  }

  await reset(); await page.getByRole('button', { name: '全选中文', exact: true }).click(); await page.getByRole('button', { name: '已选后续段尾帧加参考图', exact: true }).click();
  assert.deepEqual(await counts(), { ai: 0, submit: 0, raw: 0 }); assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await cancelComposite(1).count(), 0); assert.equal(await cancelComposite(2).count(), 1); assert.equal(await cancelComposite(3).count(), 1);
  const bulk = await submit(3); assert.equal(bulk.items[0].previousTail, undefined);
  for (let index = 1; index < bulk.items.length; index += 1) { const item = bulk.items[index]; assert.equal(item.previousTail.predecessorItemKey, bulk.items[index - 1].itemKey); assert.equal(item.previousTail.placement.mode, 'prepend'); assert.equal(item.previousTail.placement.index, 0); await assertPreparedPrompt(item.draft.prompt, index + 1); }
  await originalsIntact(); stages.push('bulk-selected-followers-form-exact-chain-without-paid-calls');
  for (const viewport of [{ width: 1120, height: 760 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport); await showList(); await composite(2).scrollIntoViewIfNeeded();
    const layout = await composite(2).evaluate((button) => { const box = button.getBoundingClientRect(); const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, buttonWidth: box.width, buttonRight: box.right, buttonLeft: box.left, color: getComputedStyle(button).color, hit: Boolean(target && (target === button || button.contains(target))) }; });
    assert.ok(layout.documentWidth <= layout.width + 1, 'no horizontal document overflow'); assert.ok(layout.buttonWidth > 0 && layout.buttonRight <= layout.width && layout.buttonLeft >= 0); assert.equal(layout.hit, true, 'composite button remains clickable'); assert.equal(layout.color, 'rgb(255, 255, 255)', 'active composite button text has white contrast');
    layouts.push({ viewport, ...layout }); await capture(`composite-layout-${viewport.width}x${viewport.height}`);
  }
  stages.push('responsive-composite-controls');
  return { passed: true, inventory: tailCharactersQaInventory, stages, screenshots, layouts };
}

export async function runStandaloneTailCharactersUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputDirectory = path.join(root, 'output', 'playwright', 'video-tail-characters');
  await fs.mkdir(outputDirectory, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); let browser;
  try {
    await server.listen(); const address = server.httpServer.address(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } }); page.setDefaultTimeout(20_000); const errors = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    const { blockedRequests, textRequests } = await installTailCharactersFixture(page, `http://127.0.0.1:${address.port}`);
    const report = await runTailCharactersUiAssertions(page, outputDirectory); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no external or paid endpoint was even attempted'); assert.deepEqual(textRequests, [], 'no prompt re-review or rewrite request was attempted');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, errors, blockedRequests, textRequests }, null, 2)); return report;
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause) }, null, 2));
    if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); } }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneTailCharactersUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
