import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { lookupPreviousSegmentVideos } from '../src/videoTailReference';
import { selectProjectVideoTailFrame, type ProjectTailFrameSelectionInput } from '../src/videoTailFrameSelectionBridge';
import type { VideoTailFrameSelectionInput, VideoTailFrameSelectionResult } from '../src/videoFrameSelection';
import type { AppState, Project, ReferenceAsset, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';
import type { WorkbenchExtractedFrame } from '../src/videoWorkbenchTypes';

type Select = NonNullable<Parameters<typeof selectProjectVideoTailFrame>[1]>;

let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => {
  await run(); groups += 1; console.log(`PASS ${name}`);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const pixels = (last: boolean): WorkbenchExtractedFrame => ({
  role: last ? 'last-frame' : 'custom-frame', frameIndex: last ? 249 : 215,
  timeSec: last ? 9.96 : 8.6, width: 1920, height: 1080,
  fileName: last ? 'actual-last.png' : 'earlier-candidate.png',
  relativePath: last ? 'media/images/actual-last.png' : 'media/images/earlier-candidate.png',
  checksum: (last ? 'b' : 'a').repeat(64), mediaType: 'image', mimeType: 'image/png',
  managed: true, missing: false, sizeBytes: 4096,
  url: last ? 'app-media://actual-last.png' : 'app-media://earlier-candidate.png',
});

const recommendation = (useLast = false): VideoTailFrameSelectionResult => ({
  frame: pixels(useLast),
  candidates: [
    { id: 'candidate-early', timeSec: 8.6, isLastFrame: false, frame: pixels(false) },
    { id: 'candidate-last', timeSec: 9.96, isLastFrame: true, frame: pixels(true) },
  ],
  selection: {
    source: useLast ? 'last-frame' : 'ai', selectedId: useLast ? 'candidate-last' : 'candidate-early',
    reason: useLast ? '保留真实尾帧。' : '非人类六足巨兽的背影与遮挡符合下一段；不必露脸或补成人形。',
    warning: useLast ? '视觉服务未返回建议，已回退原尾帧。' : '选中帧提前 1.360 秒；原视频未裁剪，可能动作回退。',
    offsetFromEndSec: useLast ? 0 : 1.36, selectedTimeSec: useLast ? 9.96 : 8.6,
    lastFrameTimeSec: 9.96, candidateCount: 2,
  },
});

function fixture() {
  let state = createInitialState();
  const project = state.project;
  project.id = 'bridge-source-project';
  project.name = '隔离桥接回归项目';
  const previousPrompt = `  原视频实际使用的英文稿\nBack view of a six-legged creature.\r\n${'完整动作与对白，不做本地摘要。'.repeat(7000)}\n末尾原文  `;
  const nextPrompt = `  本次选择的后段英文稿\nThe creature turns without changing species.\r\n${'保持背影、特写和原始对白。'.repeat(3500)}\n下一段末尾  `;
  const boards: Storyboard[] = [1, 2].map((index) => ({
    id: `bridge-board-${index}`, sceneId: project.scenes[0].id,
    workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '15s',
    shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo',
    stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots: [],
    globalReferenceAssetIds: ['bridge-role-reference'], finalPrompt: `编辑器当前第${index}段（不能覆盖成片快照）`,
    officialPromptZh: `当前中文第${index}段（与成片所用英文不同）`,
    sequencePlanId: 'bridge-plan', segmentId: `bridge-segment-${index}`, segmentIndex: index, segmentCount: 2,
    createdAt: 1, updatedAt: 2,
  }));
  const plan: VideoSequencePlan = {
    id: 'bridge-plan', title: '真实两段计划', sourceStoryTitle: '完整剧情',
    sourceStoryContent: `剧情原文\n${'修仙者与非人类六足巨兽相遇，镜头可以只拍背影。'.repeat(3000)}\n不省略结尾。`,
    durationMode: 'ai-estimated', totalDurationSec: 20, segmentDurationSec: 10,
    segmentationMode: 'natural', fitStatus: 'balanced', createdAt: 1, updatedAt: 2,
    segments: boards.map((board, index) => ({
      id: board.segmentId!, index: index + 1, title: `第${index + 1}段`, globalStartSec: index * 10,
      globalEndSec: (index + 1) * 10, durationSec: 10, content: `完整第${index + 1}段原文\n${'对白与动作。'.repeat(100)}`,
      summary: '', sourceSceneIds: [board.sceneId], sourceBeatIds: [], narrativePurpose: '',
      entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready',
    })),
  };
  const video: ReferenceAsset = {
    id: 'bridge-video', name: '第1段真实英文成片', type: 'video', mediaType: 'video', mimeType: 'video/mp4',
    role: 'motion', source: 'generated', tags: [], createdAt: 1, updatedAt: 2,
    relativePath: 'media/videos/bridge-first.mp4', checksum: 'c'.repeat(64),
    sourceStoryboardId: boards[0].id, sourceVideoTaskId: 'bridge-video-task',
  };
  const roleReference: ReferenceAsset = {
    id: 'bridge-role-reference', name: '六足甲壳主体的完整身份参考（不强求露脸）',
    type: 'reference', mediaType: 'image', role: 'character', source: 'imported', tags: [],
    relativePath: 'media/images/identity.png', checksum: 'd'.repeat(64), createdAt: 1, updatedAt: 1,
  };
  const task: VideoGenerationTask = {
    id: 'bridge-video-task', kind: 'video', storyboardId: boards[0].id, targetId: 'fixture-video-model',
    status: 'succeeded', requestBody: {}, resultAssetId: video.id, sequencePlanId: plan.id,
    segmentId: plan.segments[0].id, segmentIndex: 1, createdAt: 1, updatedAt: 2,
    videoJob: {
      stage: 'succeeded', message: '已保存原成片', snapshot: {
        projectId: project.id, clientId: 'bridge-client', images: [], connection: { backend: 'api' },
        draft: {
          backend: 'api', name: '原成片', prompt: previousPrompt, parameters: {}, references: [],
          source: { storyboardId: boards[0].id, sequencePlanId: plan.id, segmentId: plan.segments[0].id, segmentIndex: 1, language: 'en' },
        },
      },
    },
  };
  project.storyboards = boards; project.sequencePlans = [plan]; project.assets = [video, roleReference];
  project.generationTasks = [task]; state.activeProjectId = project.id; state.projects = [project];
  state.settings.visionApi = {
    ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible',
    baseUrl: 'https://vision.fixture.invalid/v1', model: 'explicit-vision-model', apiKey: 'fixture-vision-secret',
  };
  state.settings.textApi = { ...state.settings.textApi, model: 'must-not-use-this-text-model' };
  const controller = new AbortController();
  const calls = { setState: 0, persist: 0 };
  const progress: string[] = [];
  const input: ProjectTailFrameSelectionInput = {
    projectId: project.id, jobId: 'bridge-selection',
    source: { assetId: video.id, relativePath: video.relativePath!, expectedChecksum: video.checksum },
    context: { sequencePlanId: plan.id, segmentId: plan.segments[1].id, prompt: nextPrompt,
      references: [{ assetId: roleReference.id, role: 'character' }] },
    desktop: {}, signal: controller.signal,
    getState: () => state,
    setState: (update) => { calls.setState += 1; state = update(state); },
    persistState: async () => { calls.persist += 1; },
    onProgress: (message) => { progress.push(message); },
  };
  const set = (update: (current: AppState) => AppState) => { state = update(state); };
  const updateProject = (update: (current: Project) => Project) => set((current) => {
    const changed = update(current.project);
    return { ...current, project: changed, projects: current.projects.map((item) => item.id === changed.id ? changed : item) };
  });
  const switchProject = () => set((current) => {
    const other = createInitialState().project; other.id = 'bridge-other-project'; other.assets = [];
    return { ...current, project: other, activeProjectId: other.id, projects: [...current.projects, other] };
  });
  return { input, controller, calls, progress, previousPrompt, nextPrompt, state: () => state, set, updateProject, switchProject };
}

await test('真实上一段成片快照、前后全文与角色资料原样交给明确选择的视觉模型', async () => {
  const f = fixture(); const before = structuredClone(f.state()); let requests = 0;
  assert.equal(lookupPreviousSegmentVideos(f.state().project, f.input.context).versions[0]?.asset.id, f.input.source.assetId);
  const selected = await selectProjectVideoTailFrame(f.input, async (request) => {
    requests += 1;
    assert.equal(request.previousPrompt, f.previousPrompt);
    assert.equal(request.nextPrompt, f.nextPrompt);
    assert.deepEqual(request.config, before.settings.visionApi);
    assert.notEqual(request.config.model, before.settings.textApi.model);
    assert.notEqual(request.source, f.input.source); assert.deepEqual(request.source, f.input.source);
    assert.equal(request.signal, f.controller.signal);
    const context = JSON.parse(request.storyContext!);
    assert.equal(context.fullStory, before.project.sequencePlans[0].sourceStoryContent);
    assert.equal(context.previousSegment, before.project.sequencePlans[0].segments[0].content);
    assert.equal(context.nextSegment, before.project.sequencePlans[0].segments[1].content);
    assert.deepEqual(context.characters, before.project.characters);
    assert.deepEqual(context.references, [{ role: 'character', name: before.project.assets[1].name }]);
    await request.onBeforeAI?.(); request.onProgress?.('视觉 AI 正在比较候选帧');
    return recommendation();
  });
  assert.equal(requests, 1); assert.equal(selected.selection.reason, recommendation().selection.reason);
  assert.deepEqual(f.progress, ['视觉 AI 正在比较候选帧']);
  assert.equal(f.calls.persist, 1); assert.equal(f.calls.setState, 1);
});

await test('新选帧请求排除已转移旧人物，历史成片快照与旧档案保留', async () => {
  const f = fixture();
  f.updateProject((project) => ({ ...project, characters: [
    ...project.characters,
    { ...project.characters[0], id: 'archived-role', name: '归档旧人物', dossier: { archivedIntoCharacterId: project.characters[0].id } },
  ] }));
  const before = structuredClone(f.state().project);
  await selectProjectVideoTailFrame(f.input, async (request) => {
    const context = JSON.parse(request.storyContext!);
    assert.ok(context.characters.every((character: { id: string }) => character.id !== 'archived-role'));
    assert.equal(request.previousPrompt, f.previousPrompt);
    return recommendation();
  });
  assert.deepEqual(f.state().project.characters, before.characters);
  assert.deepEqual(f.state().project.generationTasks, before.generationTasks);
});

await test('全部候选与真实尾帧保存到原项目，返回所选精确像素且不改分镜、任务、原视频或参考图', async () => {
  const f = fixture(); const before = structuredClone(f.state().project);
  const result = await selectProjectVideoTailFrame(f.input, async () => recommendation());
  assert.equal(result.frame.id, 'bridge-selection_candidate-early');
  assert.equal(result.frame.relativePath, pixels(false).relativePath); assert.equal(result.frame.checksum, pixels(false).checksum);
  assert.equal(result.frame.type, 'reference'); assert.equal(result.frame.role, 'composition');
  assert.equal(result.frame.sourceVideoAssetId, f.input.source.assetId);
  assert.equal(result.frame.sourceVideoChecksum, f.input.source.expectedChecksum);
  assert.equal(result.frame.sourceTimeSec, 8.6); assert.equal(result.frame.sourceFrameIndex, 215);
  const originalTail = result.candidates.find((entry) => entry.isLastFrame)!;
  assert.equal(originalTail.asset.type, 'last-frame'); assert.equal(originalTail.asset.referenceRole, 'last-frame');
  assert.equal(originalTail.asset.checksum, pixels(true).checksum); assert.notEqual(originalTail.asset.id, result.frame.id);
  for (const candidate of result.candidates) {
    assert.deepEqual(f.state().project.assets.find((asset) => asset.id === candidate.asset.id), candidate.asset);
    assert.ok(!JSON.stringify(candidate.asset).includes('base64,'));
  }
  for (const original of before.assets) assert.deepEqual(f.state().project.assets.find((asset) => asset.id === original.id), original);
  assert.deepEqual(f.state().project.storyboards, before.storyboards);
  assert.deepEqual(f.state().project.sequencePlans, before.sequencePlans);
  assert.deepEqual(f.state().project.generationTasks, before.generationTasks);
  assert.deepEqual(f.state().projects.find((project) => project.id === before.id)?.assets, f.state().project.assets);
});

await test('AI无建议时仍返回可应用的原尾帧与完整回退解释', async () => {
  const f = fixture(); const expected = recommendation(true);
  const result = await selectProjectVideoTailFrame(f.input, async () => expected);
  assert.equal(result.frame.id, 'bridge-selection_candidate-last');
  assert.equal(result.frame.checksum, pixels(true).checksum);
  assert.deepEqual(result.selection, expected.selection); assert.equal(result.candidates.length, 2);
});

await test('已取消的请求不进入抽帧或AI，不写入任何候选', async () => {
  const f = fixture(); const before = structuredClone(f.state()); f.controller.abort(); let calls = 0;
  await assert.rejects(selectProjectVideoTailFrame(f.input, async () => { calls += 1; return recommendation(); }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), before);
});

await test('取消期间迟到的AI结果不保存或应用参考图', async () => {
  const f = fixture(); const before = structuredClone(f.state()); const wait = deferred<VideoTailFrameSelectionResult>();
  const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
  f.controller.abort(); wait.resolve(recommendation());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), before);
});

await test('切换项目期间迟到结果不串写新项目或原项目', async () => {
  const f = fixture(); const original = structuredClone(f.state().project); const wait = deferred<VideoTailFrameSelectionResult>();
  const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
  f.switchProject(); const afterSwitch = structuredClone(f.state()); wait.resolve(recommendation());
  await assert.rejects(pending, /项目已切换/u);
  assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), afterSwitch);
  assert.deepEqual(f.state().projects.find((project) => project.id === original.id), original);
});

await test('原视频校验和、路径、存在状态发生变化时拒绝迟到结果', async () => {
  for (const patch of [{ checksum: 'e'.repeat(64) }, { relativePath: 'media/videos/replaced.mp4' }, { missing: true }]) {
    const f = fixture(); const wait = deferred<VideoTailFrameSelectionResult>();
    const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
    f.updateProject((project) => ({ ...project, assets: project.assets.map((asset) => asset.id === f.input.source.assetId ? { ...asset, ...patch } : asset) }));
    const changed = structuredClone(f.state()); wait.resolve(recommendation());
    await assert.rejects(pending, /成片已改变或丢失/u); assert.equal(f.calls.setState, 0); assert.deepEqual(f.state(), changed);
  }
  const f = fixture(); const wait = deferred<VideoTailFrameSelectionResult>();
  const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
  f.updateProject((project) => ({ ...project, assets: project.assets.filter((asset) => asset.id !== f.input.source.assetId) }));
  wait.resolve(recommendation()); await assert.rejects(pending, /成片已改变或丢失/u); assert.equal(f.calls.setState, 0);
});

await test('调用视觉API前再次核对来源，已取消或变更来源不会跨过收费回调', async () => {
  for (const change of ['cancel', 'project', 'checksum'] as const) {
    const f = fixture(); let paid = false;
    const select: Select = async (request) => {
      if (change === 'cancel') f.controller.abort();
      else if (change === 'project') f.switchProject();
      else f.updateProject((project) => ({ ...project, assets: project.assets.map((asset) => asset.id === f.input.source.assetId ? { ...asset, checksum: 'f'.repeat(64) } : asset) }));
      await request.onBeforeAI!(); paid = true; return recommendation();
    };
    await assert.rejects(selectProjectVideoTailFrame(f.input, select), /已取消|项目已切换|成片已改变或丢失/u);
    assert.equal(paid, false); assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0);
  }
});

await test('不存在准确上一段、错误段落、未完成成片和静态参考图均不伪装成尾帧', async () => {
  const invalid: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => { f.input.context.segmentId = 'bridge-segment-1'; },
    (f) => { f.input.context.segmentId = 'non-existent'; },
    (f) => { f.input.context.sequencePlanId = 'another-plan'; },
    (f) => f.updateProject((project) => ({ ...project, generationTasks: project.generationTasks.map((task) => ({ ...task, status: 'running' })) })),
    (f) => f.updateProject((project) => ({ ...project, generationTasks: project.generationTasks.map((task) => ({ ...task, sequencePlanId: 'another-plan' })) })),
    (f) => f.updateProject((project) => ({ ...project, assets: project.assets.map((asset) => asset.id === f.input.source.assetId ? { ...asset, sourceStoryboardId: 'bridge-board-2' } : asset) })),
    (f) => { const image = f.state().project.assets[1]; f.input.source = { assetId: image.id, relativePath: image.relativePath!, expectedChecksum: image.checksum }; },
  ];
  for (const mutate of invalid) {
    const f = fixture(); mutate(f); const before = structuredClone(f.state()); let calls = 0;
    await assert.rejects(selectProjectVideoTailFrame(f.input, async () => { calls += 1; return recommendation(); }), /准确的上一段/u);
    assert.equal(calls, 0); assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), before);
  }
});

await test('无历史任务但仍有真实上段本地成片时沿用原文，不用参考图冒充视频', async () => {
  const f = fixture(); f.updateProject((project) => ({ ...project, generationTasks: [] }));
  const expected = f.state().project.storyboards[0].officialPromptZh;
  let source: VideoTailFrameSelectionInput | undefined;
  await selectProjectVideoTailFrame(f.input, async (request) => { source = request; return recommendation(); });
  assert.equal(source!.previousPrompt, expected); assert.equal(source!.source.assetId, 'bridge-video');
});

await test('上段成片来源关系在AI期间变化时不接收迟到结果', async () => {
  const f = fixture(); const wait = deferred<VideoTailFrameSelectionResult>();
  const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
  f.updateProject((project) => ({ ...project, assets: project.assets.map((asset) => asset.id === f.input.source.assetId ? { ...asset, sourceStoryboardId: 'bridge-board-2' } : asset) }));
  wait.resolve(recommendation());
  await assert.rejects(pending, /准确的上一段|来源|关系|成片已改变/u);
  assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0);
});

await test('像素未变且新归属仍合法时也不能替换已经冻结的上一段任务身份', async () => {
  for (const change of ['task', 'segment'] as const) {
    const f = fixture(); const wait = deferred<VideoTailFrameSelectionResult>();
    const pending = selectProjectVideoTailFrame(f.input, () => wait.promise);
    f.updateProject((project) => {
      const old = project.generationTasks[0] as VideoGenerationTask;
      if (change === 'task') return {
        ...project, generationTasks: [{ ...old, id: 'replacement-task' }],
        assets: project.assets.map((asset) => asset.id === f.input.source.assetId ? { ...asset, sourceVideoTaskId: 'replacement-task' } : asset),
      };
      const id = 'replacement-previous-segment';
      return {
        ...project,
        sequencePlans: project.sequencePlans.map((plan) => ({ ...plan, segments: plan.segments.map((segment) => segment.index === 1 ? { ...segment, id } : segment) })),
        storyboards: project.storyboards.map((board) => board.segmentIndex === 1 ? { ...board, segmentId: id } : board),
        generationTasks: [{ ...old, segmentId: id, videoJob: { ...old.videoJob!, snapshot: {
          ...old.videoJob!.snapshot, draft: { ...old.videoJob!.snapshot.draft, source: { ...old.videoJob!.snapshot.draft.source!, segmentId: id } },
        } } }],
      };
    });
    assert.equal(lookupPreviousSegmentVideos(f.state().project, f.input.context).versions.length, 1, '新的关系本身可用，但不是本次分析已经冻结的原关系');
    wait.resolve(recommendation());
    await assert.rejects(pending, /来源关系已改变/u);
    assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0);
  }
});

await test('保存失败向调用者报错，已抽出的候选可以保留但不能宣称已应用本段', async () => {
  const f = fixture(); const originalBoards = structuredClone(f.state().project.storyboards);
  f.input.persistState = async () => { f.calls.persist += 1; throw new Error('fixture: 选帧图片记录保存失败'); };
  await assert.rejects(selectProjectVideoTailFrame(f.input, async () => recommendation()), /保存失败/u);
  assert.equal(f.calls.setState, 1); assert.equal(f.calls.persist, 1);
  assert.deepEqual(f.state().project.storyboards, originalBoards);
  assert.equal(f.state().project.assets.filter((asset) => asset.id.startsWith('bridge-selection_')).length, 2);
});

await test('状态更新未接受候选时不能返回不存在的参考图', async () => {
  const f = fixture(); const before = structuredClone(f.state());
  f.input.setState = () => { f.calls.setState += 1; };
  await assert.rejects(selectProjectVideoTailFrame(f.input, async () => recommendation()), /选帧图片尚未保存/u);
  assert.deepEqual(f.state(), before);
});

await test('持久化期间取消或切换项目不会返回可应用结果，也不会改写分镜选择', async () => {
  for (const change of ['cancel', 'project'] as const) {
    const f = fixture(); const boards = structuredClone(f.state().project.storyboards);
    const wait = deferred<void>(); const entered = deferred<void>();
    f.input.persistState = async () => { f.calls.persist += 1; entered.resolve(); await wait.promise; };
    const pending = selectProjectVideoTailFrame(f.input, async () => recommendation());
    await entered.promise;
    if (change === 'cancel') f.controller.abort(); else f.switchProject();
    wait.resolve(); await assert.rejects(pending, /已取消|项目已切换/u);
    const owner = f.state().projects.find((project) => project.id === f.input.projectId)!;
    assert.deepEqual(owner.storyboards, boards);
    if (change === 'project') assert.deepEqual(f.state().project.assets, []);
  }
});

await test('模型选择不在候选清单中时不保存伪造图片', async () => {
  const f = fixture(); const before = structuredClone(f.state()); const result = recommendation();
  result.selection.selectedId = 'invented-frame';
  await assert.rejects(selectProjectVideoTailFrame(f.input, async () => result), /没有对应的本地图片/u);
  assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), before);
});

await test('抽帧服务失败原样报错，不额外重试、不保存候选、不触发视频生成', async () => {
  const f = fixture(); const before = structuredClone(f.state()); let calls = 0;
  await assert.rejects(selectProjectVideoTailFrame(f.input, async () => { calls += 1; throw new Error('fixture: FFmpeg不能读取源视频'); }), /不能读取源视频/u);
  assert.equal(calls, 1); assert.equal(f.calls.setState, 0); assert.equal(f.calls.persist, 0); assert.deepEqual(f.state(), before);
});

await test('不同选帧会话拥有独立候选资产编号，不覆盖前一次选图', async () => {
  const f = fixture(); const first = await selectProjectVideoTailFrame(f.input, async () => recommendation());
  const second = await selectProjectVideoTailFrame({ ...f.input, jobId: 'bridge-selection-next' }, async () => recommendation(true));
  assert.notEqual(first.frame.id, second.frame.id);
  for (const candidate of [...first.candidates, ...second.candidates]) assert.ok(f.state().project.assets.some((asset) => asset.id === candidate.asset.id));
  assert.equal(f.calls.persist, 2);
});

await test('一键严格AI标记传给视觉选帧，旧服务原尾帧回退不写入或应用', async () => {
  const f = fixture(); f.input.context.requireAiSelection = true; const before = structuredClone(f.state());
  await assert.rejects(selectProjectVideoTailFrame(f.input, async (request) => {
    assert.equal(request.requireAiSelection, true); return recommendation(true);
  }), /未应用原尾帧/u);
  assert.equal(f.calls.persist, 0); assert.equal(f.calls.setState, 0); assert.deepEqual(f.state(), before);
  const selected = await selectProjectVideoTailFrame(f.input, async (request) => {
    assert.equal(request.requireAiSelection, true); return recommendation();
  });
  assert.equal(selected.selection.source, 'ai'); assert.equal(f.calls.persist, 1);
});

console.log(`videoTailFrameSelectionBridge: ${groups} regression groups passed; no network or real project writes.`);
