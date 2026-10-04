import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOfficialH3Prompt, buildOfficialH3SourceFingerprint, hasCurrentOfficialH3EnglishPrompt,
  hasCurrentOfficialH3Prompt, type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { isSemanticSequencePlan, semanticSequenceCharacters } from '../src/semanticSequencePlan';
import { createInitialState } from '../src/storage';
import { buildVideoBatchRows } from '../src/videoBatch';
import { videoPromptChoices } from '../src/videoDirectorDraft';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, Character, Project, Storyboard, VideoSequencePlan } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// Preserve the director's pre-fix saving algorithm as an independent oracle.
// Existing saved deliveries must become usable without migration/recompilation.
const originalDirectorContext = (project: Project, board: Storyboard): OfficialH3ProjectContext => {
  const plan = project.sequencePlans.find((candidate) => candidate.id === board.sequencePlanId);
  return {
    assets: project.assets,
    characters: semanticSequenceCharacters(plan, project.characters),
    locations: project.locations,
    props: project.props,
    sceneContent: isSemanticSequencePlan(plan) ? board.sourceStoryContent
      : project.scenes.find((scene) => scene.id === board.sceneId)?.content,
  };
};

const makeFixture = (semantic = true) => {
  const state = createInitialState();
  const liveCharacter: Character = {
    id: 'traveller', name: '林澜', gender: '女性', apparentAge: '成年人', race: '人类',
    appearance: '黑色短发', outfit: '红色外套', signatureProps: '', personality: '',
    motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
  };
  const plan: VideoSequencePlan = {
    id: 'semantic-video-plan', title: '廊桥之行', sourceStoryTitle: '廊桥之行',
    sourceStoryContent: '林澜离开集市，走过廊桥，最后回到山村。',
    ...(semantic ? {
      planningMode: 'semantic-segments' as const,
      semanticPlanningSnapshot: {
        version: 1 as const, directorSettingsFingerprint: 'saved-director-settings',
        creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
        characterContinuity: [{ id: 'traveller', name: '林澜', gender: '女性',
          apparentAge: '成年人', race: '人类', appearance: '黑色长发', outfit: '蓝色披风' }],
      },
    } : {}),
    durationMode: 'ai-estimated', totalDurationSec: 15, segmentDurationSec: 15,
    segmentationMode: 'natural', fitStatus: 'balanced', segments: [{
      id: 'bridge-segment', index: 1, title: '走向廊桥', globalStartSec: 0, globalEndSec: 15,
      durationSec: 15, content: '林澜停在廊桥入口，抬头看向对岸。', summary: '廊桥入口',
      sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '建立空间', entryState: '抵达入口',
      exitState: '望向对岸', transitionHint: '自然衔接', storyboardId: 'bridge-board', status: 'ready',
    }], createdAt: 1, updatedAt: 1,
  };
  const source: Storyboard = {
    id: 'bridge-board', sceneId: semantic ? '' : 'bridge-scene', sequencePlanId: plan.id,
    segmentId: plan.segments[0].id, segmentIndex: 1, sourceStoryContent: plan.segments[0].content,
    sourceStoryTitle: plan.title, workflow: 'drama', inputMode: 'text', durationSec: 15,
    durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9',
    resolution: '1080p', audioMode: 'stereo', stylePresetId: 'style', ruleSetId: 'rules',
    converterPresetId: 'converter', globalLock: '', shots: [{
      id: 'bridge-shot', index: 1, startSec: 0, endSec: 15, purpose: '建立空间', subject: '林澜',
      action: '林澜抬头看向廊桥', camera: '中景固定', transition: '自然衔接', lighting: '清晨侧光',
      sound: '脚步声', result: '林澜停步', referenceAssetIds: [], prompt: '', locked: false,
    }],
    finalPrompt: '【0s-15s】主体：林澜；动作：林澜抬头看向廊桥；空间：廊桥入口；光影：清晨侧光；镜头：中景固定；台词：无；音效：脚步声。',
    createdAt: 1, updatedAt: 1,
  };
  state.project.characters = [liveCharacter];
  state.project.sequencePlans = [plan];
  state.project.scenes = [{
    id: 'bridge-scene', title: '原解析场景', content: '整段解析场景正文，与 AI 保存的局部段落不同。',
    summary: '', characterIds: ['traveller'], propIds: [], storyboardIds: [source.id], createdAt: 1, updatedAt: 1,
  }];
  const board = applyOfficialH3Prompt(source, originalDirectorContext(state.project, source));
  // Distinct saved derivative: these tests verify exact transport, not translation quality.
  board.officialPromptEn = board.officialPromptZh!.replaceAll('林澜', 'Lin Lan');
  board.officialPromptEnSource = board.officialPromptZh;
  state.project.storyboards = [board];
  state.projects = [state.project];
  return { state, project: state.project, plan, board };
};

test('saved semantic H3 is current under the director context and stale under the old video context', () => {
  const { project, board } = makeFixture();
  const director = originalDirectorContext(project, board);
  assert.deepEqual(officialH3ContextForStoryboard(project, board), director,
    'the shared resolver must retain the source identity used to save existing director results');
  const oldVideo = { ...director, characters: project.characters,
    sceneContent: project.scenes.find((scene) => scene.id === board.sceneId)?.content };
  assert.equal(director.sceneContent, board.sourceStoryContent);
  assert.notEqual(director.sceneContent, oldVideo.sceneContent);
  assert.equal(director.characters?.[0].outfit, '蓝色披风');
  assert.equal(oldVideo.characters[0].outfit, '红色外套');
  assert.equal(hasCurrentOfficialH3Prompt(board, director), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(board, director), true);
  assert.notEqual(buildOfficialH3SourceFingerprint(board, oldVideo), board.officialPromptSource);
  assert.equal(hasCurrentOfficialH3Prompt(board, oldVideo), false);
});

test('single and batch pickers expose the exact saved semantic Chinese and English deliveries', () => {
  const { state, project, plan, board } = makeFixture();
  const before = JSON.stringify(project);
  const choices = videoPromptChoices(project);
  assert.deepEqual(choices.map((choice) => [choice.language, choice.prompt]), [
    ['zh', board.officialPromptZh], ['en', board.officialPromptEn],
  ], 'the generated H3 deliveries must not disappear when switching to the video director');
  const rows = buildVideoBatchRows(project, plan, state.settings);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].zh?.draft.prompt, board.officialPromptZh);
  assert.equal(rows[0].en?.draft.prompt, board.officialPromptEn);
  assert.equal(JSON.stringify(project), before, 'reading saved deliveries must not regenerate or mutate them');
});

test('live public character edits/deletion cannot invalidate a frozen semantic identity', () => {
  const { project, board } = makeFixture();
  project.characters[0].appearance = '之后编辑的白发';
  project.characters[0].name = '之后编辑的名字';
  assert.deepEqual(videoPromptChoices(project).map((choice) => choice.prompt), [board.officialPromptZh, board.officialPromptEn]);
  project.characters = [];
  assert.deepEqual(videoPromptChoices(project).map((choice) => choice.prompt), [board.officialPromptZh, board.officialPromptEn]);
});

test('real canonical/semantic identity changes still hide stale deliveries', () => {
  for (const change of [
    ({ board }: ReturnType<typeof makeFixture>) => { board.finalPrompt += '\n新增镜头内容'; },
    ({ plan }: ReturnType<typeof makeFixture>) => { plan.semanticPlanningSnapshot!.characterContinuity[0].outfit = '更改计划里的服装'; },
  ]) {
    const fixture = makeFixture();
    change(fixture);
    assert.equal(hasCurrentOfficialH3Prompt(fixture.board, originalDirectorContext(fixture.project, fixture.board)), false);
    assert.deepEqual(videoPromptChoices(fixture.project), []);
    const [row] = buildVideoBatchRows(fixture.project, fixture.plan, fixture.state.settings);
    assert.equal(row.zh, undefined);
    assert.equal(row.en, undefined);
  }
});

test('missing or stale English does not hide current Chinese', () => {
  for (const missing of [true, false]) {
    const { state, project, board, plan } = makeFixture();
    if (missing) board.officialPromptEn = '';
    else board.officialPromptEnSource = '以前的中文交付稿';
    board.englishPrompt = 'Legacy six-field English source must not substitute for an H3 delivery.';
    board.englishPromptSource = board.finalPrompt;
    assert.deepEqual(videoPromptChoices(project).map((choice) => choice.language), ['zh']);
    const [row] = buildVideoBatchRows(project, plan, state.settings);
    assert.equal(row.zh?.draft.prompt, board.officialPromptZh);
    assert.equal(row.en, undefined);
  }
});

test('legacy plan and non-sequence H3 retain their live scene/character context', () => {
  for (const standalone of [false, true]) {
    const { project, board } = makeFixture(false);
    if (standalone) { delete board.sequencePlanId; delete board.segmentId; project.sequencePlans = []; }
    assert.deepEqual(videoPromptChoices(project).map((choice) => choice.prompt), [board.officialPromptZh, board.officialPromptEn]);
    project.characters[0].outfit = '修改后的传统场景服装';
    assert.deepEqual(videoPromptChoices(project), [], 'legacy sources still follow current project character facts');
  }
});

const makeSubmissionHarness = () => {
  const fixture = makeFixture();
  const { state, board } = fixture;
  state.settings.videoTaskApi = {
    enabled: true, endpoint: 'https://semantic-video.example/generate', statusEndpointTemplate: 'https://semantic-video.example/tasks/{id}',
    apiKey: 'fixture-only-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id',
    statusPath: 'status', resultUrlPath: 'output.url', provider: 'generic', model: 'minimax-h3',
  };
  const requests: Array<{ method?: string; body?: string }> = [];
  const credentials = new Map<string, string>();
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => { requests.push(payload); return { status: 200, body: JSON.stringify({ id: 'mock-remote', status: 'queued' }) }; },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => {
      if (apiKey) credentials.set(taskId, apiKey); else credentials.delete(taskId);
      return { persisted: true };
    },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    downloadGeneratedMedia: async () => ({ fileName: 'unused.mp4', relativePath: 'video/unused.mp4', checksum: 'unused',
      sizeBytes: 1, mediaType: 'video', managed: true, missing: false, url: 'lianhua-media://asset/unused.mp4' }),
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  };
  const engine = new VideoGenerationEngine({
    getState: () => state, setState: (updater: (current: AppState) => AppState) => { Object.assign(state, updater(state)); },
    desktop, onRuntime: () => {}, pollIntervalMs: 5,
  });
  const draft = (language: 'zh' | 'en'): VideoGenerationDraft => ({
    name: '语义提示词上下文回归', prompt: language === 'en' ? board.officialPromptEn! : board.officialPromptZh!,
    backend: 'api', references: [], parameters: {},
    source: { storyboardId: board.id, sequencePlanId: board.sequencePlanId, segmentId: board.segmentId,
      segmentIndex: 1, language, promptVersion: board.updatedAt, label: '语义上下文测试' },
  });
  return { ...fixture, requests, engine, draft };
};

test('submission boundary accepts the exact saved semantic deliveries in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    const h = makeSubmissionHarness();
    const draft = h.draft(language);
    try {
      await h.engine.start(draft);
      const posts = h.requests.filter((request) => request.method === 'POST');
      assert.equal(posts.length, 1);
      assert.equal(JSON.parse(posts[0].body || '{}').prompt, draft.prompt);
    } finally { h.engine.dispose(); }
  }
});

test('submission rejects actual staleness, missing English and manually edited H3 before POST', async () => {
  for (const scenario of ['stale', 'missing-english', 'edited'] as const) {
    const h = makeSubmissionHarness();
    const draft = h.draft(scenario === 'missing-english' ? 'en' : 'zh');
    if (scenario === 'stale') h.board.finalPrompt += '\n新增动作';
    if (scenario === 'missing-english') h.board.officialPromptEn = '';
    if (scenario === 'edited') draft.prompt += '\n手动变更';
    try {
      await assert.rejects(() => h.engine.start(draft), scenario === 'edited' ? /不是当前官方 H3 交付稿/u : /已失效或尚未生成/u);
      assert.equal(h.requests.filter((request) => request.method === 'POST').length, 0);
    } finally { h.engine.dispose(); }
  }
});
