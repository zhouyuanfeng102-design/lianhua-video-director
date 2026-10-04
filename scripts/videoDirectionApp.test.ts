import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as effects from '../src/appEffects';
import * as direction from '../src/videoCreativeDirection';
import * as actingCamera from '../src/videoActingCameraRules';
import * as engine from '../src/promptEngine';
import * as official from '../src/officialPrompt';
import * as storage from '../src/storage';
import * as sequence from '../src/sequencePlan';
import * as semantic from '../src/semanticSequencePlan';
import * as segmentation from '../src/storySegmentation';
import * as timeline from '../src/masterTimeline';
import * as styles from '../src/directorStyles';
import * as visual from '../src/visualStyles';
import * as identities from '../src/storyboardRequestIdentity';
import * as handoff from '../src/sequencePromptHandoff';
import { normalizeGridDirectorInputMode } from '../src/gridDirectorWorkflow';
import { GRID_CREATION_RETIRED_MESSAGE } from '../src/gridRetirement';
import { availableVideoPrivateParts } from '../src/videoPrivateScope';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { StoryDurationEstimate } from '../src/services/llm';
import { getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
import {
  generateSingleSegmentPrompt, getSingleSegmentReferences,
  type GenerateSingleSegmentPromptInput, type SingleSegmentPromptStage,
} from './fixtures/h3PipelineMock';
import type {
  AiStoryboardShotPlan, AppState, Character, Scene, Storyboard, StylePreset, VideoSegment, VideoSequencePlan,
} from '../src/types';

// Run the real App callback and materializer, not a rewritten copy of their
// control flow. Only model I/O and UI/state boundaries are replaced. Fixtures
// contain anonymous adults doing neutral actions; no saved user data or media.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find((node): node is ts.FunctionDeclaration => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'App'
));
assert.ok(app?.body);
const declarations = (names: readonly string[], statements = app.body!.statements): string => names.map((name) => {
  const statement = statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(statement, `production declaration ${name}`);
  return statement.getText(ast);
}).join('\n');
const evaluate = (code: string, dependencies: Record<string, unknown>, result: string): any => new Function(
  'dependencies', `with (dependencies) {
    ${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText}
    return ${result};
  }`,
)(dependencies);
const topCode = declarations([
  'converterSupportsWorkflow', 'sequenceStoryboardGenerationIdentity', 'parseDirectorSettingsFingerprint',
  'combineDirectorScenes', 'buildVideoSegmentScene', 'buildWholeStoryScene',
], ast.statements);
const callbackCode = declarations(['hasActiveStoryboardBuild', 'rebuildStoryboard', 'buildStoryboard']);
const jsonData = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `actual request contains ${tag}`);
  return JSON.parse(match[1]);
};

const story = '成年甲沿走廊向前走，成年乙在身侧同行。两人在窗边停下，共同查看手里的纸页。';
const fullExtra = `  ${'遵守原文行动与人物关系，保留每一项已选创作要求。'.repeat(220)}\n末尾独立要求：以纸页落定收尾。  `;
const fullPreset = (): StylePreset => ({
  ...storage.defaultStylePresets[0], id: 'direction-style', name: '匿名成人中性场景测试风格',
  visual: `${'自然材质与原文环境。'.repeat(60)}VISUAL_END`,
  camera: `${'以剧情信息为摄影依据。'.repeat(60)}CAMERA_END`,
  lighting: `${'使用场景已有光源。'.repeat(60)}LIGHTING_END`,
  sound: `${'保留必要场内声音。'.repeat(60)}SOUND_END`,
});
const makeState = (): AppState => {
  const state = storage.createInitialState();
  const character = (id: string, name: string): Character => ({
    id, name, gender: '未指定', apparentAge: '成年', race: '人类', appearance: '普通成人外观',
    outfit: '日常外套', signatureProps: '', personality: '平和', motionHabits: '',
    anchor: '保持身份稳定', negativeContinuity: '', assetIds: [],
  });
  const characters = [character('adult-a', '成年甲'), character('adult-b', '成年乙')];
  const scene: Scene = {
    id: 'direction-scene', title: '走廊查看纸页', content: story, summary: '同行后查看纸页',
    characterIds: characters.map((item) => item.id), locationIds: [], propIds: [], storyboardIds: [],
    createdAt: 1, updatedAt: 1,
  };
  state.project = { ...state.project, id: 'direction-project', name: '纯合成导演回归',
    sourceDocuments: [{ id: 'direction-source', name: scene.title, content: story, createdAt: 1, updatedAt: 1 }],
    characters, locations: [], props: [], scenes: [scene], assets: [], generationTasks: [], storyboards: [], sequencePlans: [],
  };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  state.stylePresets = [fullPreset()];
  state.settings = { ...state.settings, textApi: { ...state.settings.textApi,
    enabled: true, baseUrl: 'https://mock.invalid', model: 'fixture-only', apiKey: '', vision: false,
  } };
  return state;
};
const plannedShots = (count: number, duration: number): AiStoryboardShotPlan[] => Array.from({ length: count }, (_, index) => ({
  startSec: index * duration / count, endSec: (index + 1) * duration / count, sourceExcerpt: story,
  subject: '成年甲、成年乙', action: index ? '两人共同查看纸页' : '两人沿走廊同行',
  purpose: index ? '看清纸页与两人的注意关系' : '交代共同路线',
  space: '窗户在走廊右侧，起点在人物身后，纸页位于两人手间',
  direction: '两人保持面向走廊前方', performance: '视线跟随当前动作，停下后注意纸页',
  camera: index % 2 ? 'MODEL_CHOSEN_DETAIL：固定侧面近景看纸页与视线' : 'MODEL_CHOSEN_WIDE：侧面中景平移交代路线',
  lighting: 'MODEL_CHOSEN_WINDOW：右侧窗光照亮衣袖和纸页',
  transition: index ? '通过共同纸页接续观察目标' : '保持路线连续',
  dialogue: '无', sound: '轻微脚步与纸页声', result: '两人保持原前后关系',
}));
const canonicalPrompt = (board: Storyboard): string => board.shots.map((shot) => [
  `【${shot.startSec}s-${shot.endSec}s】主体：@成年甲、@成年乙（注意当前动作）[朝向：${shot.direction}] 正在 [${shot.action}]（${shot.purpose}）`,
  `空间：${shot.space}`, `光影：${shot.lighting}`, `镜头：${shot.camera}`, '台词：无',
  '音效：环境层-[无] 动作层-[轻微脚步与纸页声] 情绪层-[无配乐]',
].join('；')).join('\n');

const harness = (options: { count?: number; extra?: string; state?: AppState; plan?: VideoSequencePlan;
  adjustedEstimate?: StoryDurationEstimate } = {}) => {
  const state = options.state || makeState();
  const stateRef = { current: state };
  const preset = state.stylePresets[0];
  const converter = state.converterPresets.find((item) => item.enabled && (item.workflow === 'all' || item.workflow === 'drama') && item.scope === 'video')!;
  assert.ok(converter);
  const calls = {
    plans: [] as Record<string, any>[], pipeline: [] as GenerateSingleSegmentPromptInput[],
    rebuiltPlanExtras: [] as Array<string | undefined>,
    rebuiltPlanStyles: [] as StylePreset[],
    model: [] as Array<{ stage: SingleSegmentPromptStage; system: string; user: string }>,
    notices: [] as string[], errors: [] as unknown[], saved: [] as AppState[],
  };
  const noop = () => {};
  const deps: Record<string, any> = {
    ...effects, ...direction, ...engine, ...official, ...storage, ...sequence, ...semantic,
    ...segmentation, ...timeline, ...styles, ...visual, ...identities, ...handoff,
    normalizeGridDirectorInputMode, GRID_CREATION_RETIRED_MESSAGE, availableVideoPrivateParts,
    sourceContentHash, getSingleSegmentReferences,
    buildPromptPlan: (input: Parameters<typeof engine.buildPromptPlan>[0]) => {
      calls.rebuiltPlanExtras.push(input.extra);
      calls.rebuiltPlanStyles.push(structuredClone(input.style));
      return engine.buildPromptPlan(input);
    },
    state, stateRef, storyInput: story, storyName: state.project.scenes[0].title,
    directorSourceScenes: state.project.scenes, directorScene: state.project.scenes[0],
    selectedAssetIds: [], extraRequirement: options.extra ?? fullExtra,
    directorWorkflow: 'drama', directorInputMode: 'text', activeDuration: 15,
    durationPreset: '15s', shotMode: 'auto', shotCount: 3, pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    styleId: preset.id, activeStyle: preset,
    ruleSetId: state.ruleSets[0].id, activeRuleSet: state.ruleSets[0], converterId: converter.id,
    directorStyleId: styles.directorStylePresets[0].id, directorStyleName: '完整导演名称',
    directorStyleSummary: '根据原文选择可见的自然表演与摄影关系。', directorCategory: '剧情',
    cameraTerms: [], lightingTerms: [], visualStyle: '自然写实', activeSceneId: state.project.scenes[0].id,
    sequencePromptRefreshRef: { current: null }, sequenceBatchIdentityRef: { current: null },
    storyboardBuildLeaseRef: { current: undefined }, storyboardBusyOwnerRef: { current: 0 },
    workspaceEpochRef: { current: 1 }, storyDraftRef: { current: { storyInput: story, storyName: state.project.scenes[0].title } },
    storyboardGenerationIdentityRef: { current: 'fixture-render' }, segmentStoryboardConfigurationIdentityRef: { current: 'fixture-config' },
    activeSequencePlanReadyForGeneration: true, activeSequencePlan: options.plan,
    sequenceOperationIsCurrent: () => assert.fail('this fixture does not start a batch'),
    setBusy: noop, setView: noop, setSequenceStage: noop, setConverterId: noop, setActiveStoryboardId: noop,
    notify: (message: string) => calls.notices.push(message),
    reportRuntimeError: (_stage: string, error: unknown) => calls.errors.push(error),
    requestDirectorDecision: async () => ({ workflow: 'drama', reason: '模型按中性同行场景选择' }),
    requestShotRecommendation: async (_config: unknown, input: Record<string, any>) => {
      calls.plans.push(structuredClone(input));
      return { reason: 'MODEL_SHOT_COUNT_REASON：依剧情信息选镜',
        // Deliberately return estimate metadata even without permission: App
        // must ignore unauthorized retiming, while the mock's actual shots
        // continue honoring the fixed/ordinary request duration.
        ...(options.adjustedEstimate ? { durationSec: options.adjustedEstimate.recommendedSec, durationEstimate: options.adjustedEstimate } : {}),
        shots: plannedShots(options.count ?? 4, input.durationAdjustmentPolicy === 'ai-estimated' && options.adjustedEstimate
          ? options.adjustedEstimate.recommendedSec : input.durationSec) };
    },
    requestTextModel: () => assert.fail('no real text transport is allowed'),
    saveStateAsync: async (snapshot: AppState) => {
      assert.ok(snapshot.project.storyboards.some((board) => board.officialPromptZh && !board.officialPromptEn),
        'the actual App checkpoint persists qualified Chinese before English');
      calls.saved.push(structuredClone(snapshot));
    },
    loadVideoPromptReferenceImages: () => assert.fail('the synthetic text fixture has no image pixels'),
    setState: (update: (current: AppState) => AppState) => { stateRef.current = update(stateRef.current); },
    generateSingleSegmentPrompt: async (input: GenerateSingleSegmentPromptInput) => {
      calls.pipeline.push(input);
      return generateSingleSegmentPrompt({ ...input, request: async (system, user, stage) => {
        calls.model.push({ stage, system, user });
        if (stage === 'convert') return canonicalPrompt(input.board);
        if (stage === 'review') return jsonData(user, 'video_staging_review_data').candidatePrompt;
        if (user.includes('<review_data>')) return jsonData(user, 'review_data').candidateEnglishPrompt;
        // Protocol-only echo: this checks H3 transport, not real translation quality.
        return user;
      } });
    },
  };
  const callbacks = evaluate(`${topCode}\n${callbackCode}`, deps, '({ buildStoryboard, rebuildStoryboard })');
  return {
    deps, calls, stateRef,
    run: async (override?: Record<string, unknown>): Promise<Storyboard> => {
      const result = await callbacks.buildStoryboard(override);
      assert.ok(result, [...calls.errors.map(String), ...calls.notices].join('\n'));
      return result;
    },
    rebuild: callbacks.rebuildStoryboard as (board: Storyboard) => Storyboard,
  };
};
const presetSnapshot = (style: StylePreset) => ({
  id: style.id, name: style.name, visual: style.visual, camera: style.camera, lighting: style.lighting, sound: style.sound,
});
const assertCompleteDirection = (value: direction.VideoCreativeDirection | undefined, style: StylePreset, extra: string) => {
  assert.ok(value, 'App stores the complete creativeDirection snapshot');
  assert.deepEqual(value.directorStyle, { id: styles.directorStylePresets[0].id,
    name: '完整导演名称', summary: '根据原文选择可见的自然表演与摄影关系。' });
  assert.deepEqual(value.visualStyle, { name: '自然写实', prompt: visual.resolveVisualStylePrompt('自然写实') });
  assert.deepEqual(value.stylePreset, presetSnapshot(style));
  assert.equal(value.extraRequirement, extra, 'the exact full requirement, including its final clause and whitespace, survives');
  assert.deepEqual(value.cameraTerms, []); assert.deepEqual(value.lightingTerms, []);
};

for (const fullTimeline of [false, true]) {
  test(`actual App ${fullTimeline ? 'master' : 'single'} generation carries full direction to conversion, Chinese review and English review`, async () => {
    const qa = harness();
    const board = await qa.run(fullTimeline ? { fullTimeline: true, durationSec: 15, deferCommit: true,
      pacing: { pace: '标准', directorCategory: '剧情', directorStyle: qa.deps.directorStyleName,
        directorStyleSummary: qa.deps.directorStyleSummary, extraRequirement: fullExtra },
    } : undefined);
    assertCompleteDirection(board.creativeDirection, qa.deps.activeStyle, fullExtra);
    assert.equal(qa.calls.plans.length, 1);
    assert.equal(qa.calls.saved.length, fullTimeline ? 0 : 1, 'only ordinary generation persists Chinese before translation; deferred masters remain transactional');
    assert.equal(qa.calls.plans[0].requiredShotCount, undefined, 'auto does not impose the UI fallback of three');
    assert.equal(qa.calls.plans[0].pacing.extraRequirement, fullExtra);
    for (const field of ['name', 'visual', 'camera', 'lighting', 'sound'] as const) {
      assert.equal(qa.calls.plans[0].stylePreset[field], qa.deps.activeStyle[field], `planning keeps full preset ${field}`);
    }
    assert.deepEqual(qa.calls.plans[0].cameraTerms, []); assert.deepEqual(qa.calls.plans[0].lightingTerms, []);
    assert.equal(board.shots.length, 4); assert.equal(board.shotMode, 'auto'); assert.equal(board.shotCount, undefined);
    assert.match(board.shotCountReason || '', /MODEL_SHOT_COUNT_REASON/u);
    assert.deepEqual(board.shots.map((shot) => shot.camera), plannedShots(4, 15).map((shot) => shot.camera));
    assert.deepEqual(board.shots.map((shot) => shot.lighting), plannedShots(4, 15).map((shot) => shot.lighting));
    const conversion = qa.calls.model.find((call) => call.stage === 'convert')!;
    const review = qa.calls.model.find((call) => call.stage === 'review')!;
    const englishReview = qa.calls.model.find((call) => call.stage === 'translate' && call.user.includes('<review_data>'))!;
    const conversionData = jsonData(conversion.user, 'video_conversion_data');
    assertCompleteDirection(conversionData.creativeDirection, qa.deps.activeStyle, fullExtra);
    assertCompleteDirection(jsonData(review.user, 'video_staging_review_data').creativeDirection, qa.deps.activeStyle, fullExtra);
    assertCompleteDirection(jsonData(englishReview.user, 'review_data').stagingContext.creativeDirection, qa.deps.activeStyle, fullExtra);
    assert.ok(conversion.system.includes(actingCamera.VIDEO_AI_SHOT_COVERAGE_RULE));
    assert.ok(review.system.includes(actingCamera.VIDEO_ACTING_CAMERA_FIELD_RULE));
    assert.ok(englishReview.system.includes(actingCamera.VIDEO_ACTING_CAMERA_TRANSLATION_RULE));
    assert.match(conversion.system, /空的cameraTerms\/lightingTerms[\s\S]*仍由AI结合剧情选择/u);
    assert.equal(getH3PromptProtocolIssue(board.officialPromptZh!), undefined);
    assert.equal(getH3PromptProtocolIssue(board.officialPromptEn!, board.officialPromptZh), undefined);
    const protocol = readH3PromptProtocol(board.officialPromptZh!)!;
    assert.deepEqual(protocol.sections, ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']);
    assert.deepEqual(protocol.shots, [
      { marker: '[Shot 1]', cut: null }, { marker: '[Shot 2]', cut: 'At 00:03.750' },
      { marker: '[Shot 3]', cut: 'At 00:07.500' }, { marker: '[Shot 4]', cut: 'At 00:11.250' },
    ]);
    assert.doesNotMatch(board.officialPromptZh!, /^(?:performance_review|spatial_map|camera_reason|表演审查|空间地图|运镜理由):/mu);
    assert.equal(qa.stateRef.current.project.generationTasks.length, 0, 'text-only generation never creates a paid video task');
  });
}

test('actual App auto mode accepts one model-authored continuous shot instead of manufacturing three', async () => {
  const qa = harness({ count: 1 }); const board = await qa.run();
  assert.equal(qa.calls.plans[0].requiredShotCount, undefined);
  assert.equal(board.shots.length, 1); assert.equal(board.recommendedShotCount, 1);
  assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 15]]);
  assert.equal(readH3PromptProtocol(board.officialPromptZh!)?.shots.length, 1);
});

for (const [initial, adjusted] of [[15, 30], [30, 15]]) {
  test(`AI-estimated master ${initial}→${adjusted} reaches real materialization, H3 and request-local estimate without saving early`, async () => {
    const adjustedEstimate: StoryDurationEstimate = { minSec: adjusted, recommendedSec: adjusted, maxSec: adjusted + 15,
      fitStatus: 'balanced', reason: '模型完整安排原文发话与互斥动作，以完整15秒窗口调整尚未确认的全片预算。' };
    const qa = harness({ adjustedEstimate });
    const reported: StoryDurationEstimate[] = [];
    const before = JSON.stringify(qa.stateRef.current.project);
    const board = await qa.run({ fullTimeline: true, durationSec: initial, requiredSegmentDurationSec: 15,
      durationAdjustmentPolicy: 'ai-estimated', deferCommit: true, onDurationPlanned: (value: StoryDurationEstimate) => reported.push(value) });
    assert.equal(qa.calls.plans[0].durationAdjustmentPolicy, 'ai-estimated');
    assert.equal(qa.calls.plans[0].allowDurationExpansion, undefined, 'App uses explicit bidirectional permission, not the legacy expansion flag');
    assert.equal(qa.calls.plans[0].requiredSegmentDurationSec, 15);
    assert.equal(board.durationSec, adjusted); assert.deepEqual(reported, [adjustedEstimate]);
    assert.equal(qa.calls.pipeline[0].board.durationSec, adjusted);
    assert.equal(qa.calls.pipeline[0].board.shots.length, 4, '15-second windows do not become one shot each');
    assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]),
      plannedShots(4, adjusted).map((shot) => [shot.startSec, shot.endSec]));
    assert.equal(getH3PromptProtocolIssue(board.officialPromptZh!), undefined);
    assert.equal(JSON.stringify(qa.stateRef.current.project), before, 'only completed outer master transaction may save the change');
  });

  test(`fixed master ignores unauthorized ${initial}→${adjusted} estimate metadata`, async () => {
    const qa = harness({ adjustedEstimate: { minSec: adjusted, recommendedSec: adjusted, maxSec: adjusted + 15,
      fitStatus: 'balanced', reason: 'untrusted extra field' } });
    const board = await qa.run({ fullTimeline: true, durationSec: initial, requiredSegmentDurationSec: 15,
      durationAdjustmentPolicy: 'fixed', deferCommit: true,
      onDurationPlanned: () => assert.fail('fixed master cannot report an adjusted whole-film estimate') });
    assert.equal(qa.calls.plans[0].durationAdjustmentPolicy, 'fixed');
    assert.equal(qa.calls.plans[0].allowDurationExpansion, undefined);
    assert.equal(board.durationSec, initial);
    assert.equal(qa.calls.pipeline[0].board.durationSec, initial);
    assert.equal(board.shots.at(-1)?.endSec, initial);
  });
}

test('speech-first duration permission cannot leak into ordinary single-segment generation', async () => {
  const qa = harness({ adjustedEstimate: { minSec: 30, recommendedSec: 30, maxSec: 45, fitStatus: 'balanced', reason: 'untrusted extra field' } });
  const board = await qa.run({ durationSec: 15, requiredSegmentDurationSec: 15, durationAdjustmentPolicy: 'ai-estimated',
    onDurationPlanned: () => assert.fail('ordinary single generation cannot report an expanded whole-film estimate') });
  assert.equal(qa.calls.plans[0].durationAdjustmentPolicy, undefined);
  assert.equal(qa.calls.plans[0].allowDurationExpansion, undefined);
  assert.equal(qa.calls.plans[0].requiredSegmentDurationSec, undefined);
  assert.equal(board.durationSec, 15); assert.equal(qa.calls.pipeline[0].board.durationSec, 15);
});

for (const masterExtra of [fullExtra, '']) {
  test(`actual App master slice inherits the saved full preset and ${masterExtra ? 'full' : 'intentionally empty'} requirement despite changed UI`, async () => {
    const masterQa = harness({ extra: masterExtra });
    const master = await masterQa.run({ fullTimeline: true, durationSec: 15, deferCommit: true,
      pacing: { pace: '标准', directorCategory: '剧情', directorStyle: masterQa.deps.directorStyleName,
        directorStyleSummary: masterQa.deps.directorStyleSummary, extraRequirement: masterExtra },
    });
    const snapshot = structuredClone(master.creativeDirection!);
    const state = makeState();
    const segment: VideoSegment = {
      id: 'direction-segment', index: 1, title: '走廊查看纸页第一段', globalStartSec: 0, globalEndSec: 15,
      durationSec: 15, content: story, summary: '同行后查看纸页', sourceSceneIds: [state.project.scenes[0].id],
      sourceBeatIds: [...new Set(master.shots.flatMap((shot) => shot.sourceBeatIds || []))],
      sourceShotIds: master.shots.map((shot) => shot.id), narrativePurpose: '建立同行关系',
      entryState: '两人沿走廊同行', exitState: '共同查看纸页', transitionHint: '', status: 'planned',
    };
    const plan: VideoSequencePlan = {
      id: 'direction-plan', title: '走廊查看纸页', sourceStoryTitle: '走廊查看纸页', sourceStoryContent: story,
      sourceContentHash: sourceContentHash(story), durationMode: 'fixed', requestedTotalDurationSec: 15,
      totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'natural', segmentationSource: 'ai', fitStatus: 'balanced',
      masterStoryboardId: master.id, segments: [segment], createdAt: 1, updatedAt: 1,
    };
    master.sequencePlanId = plan.id;
    const before = JSON.stringify(master);
    state.project.storyboards = [master]; state.project.sequencePlans = [plan];
    state.stylePresets = [{ ...fullPreset(), name: 'CURRENT_UI_ONLY', visual: 'CURRENT_UI_ONLY_VISUAL',
      camera: 'CURRENT_UI_ONLY_CAMERA', lighting: 'CURRENT_UI_ONLY_LIGHT', sound: 'CURRENT_UI_ONLY_SOUND' }];
    const qa = harness({ state, plan, extra: 'CURRENT_UI_ONLY_EXTRA' });
    qa.deps.cameraTerms = ['CURRENT_UI_ONLY_CAMERA_TERM']; qa.deps.lightingTerms = ['CURRENT_UI_ONLY_LIGHT_TERM'];
    qa.deps.visualStyle = 'CURRENT_UI_ONLY_VISUAL_NAME'; qa.deps.directorStyleSummary = 'CURRENT_UI_ONLY_DIRECTOR';
    const board = await qa.run({ segment, sequencePlanId: plan.id, segmentCount: 1 });
    assert.deepEqual(board.creativeDirection, snapshot, 'the confirmed master snapshot, not edited live preset/UI controls, owns a slice');
    assert.equal(board.extraRequirement, masterExtra);
    assert.deepEqual(board.cameraTerms, []); assert.deepEqual(board.lightingTerms, []);
    assert.equal(qa.calls.plans.length, 0, 'a canonical master slice does not re-plan its camera or count');
    assert.equal(qa.calls.pipeline[0].skipConversion, true);
    assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]), master.shots.map((shot) => [shot.startSec, shot.endSec]));
    const review = qa.calls.model.find((call) => call.stage === 'review')!;
    assert.deepEqual(jsonData(review.user, 'video_staging_review_data').creativeDirection, snapshot);
    const englishReview = qa.calls.model.find((call) => call.stage === 'translate' && call.user.includes('<review_data>'))!;
    assert.deepEqual(jsonData(englishReview.user, 'review_data').stagingContext.creativeDirection, snapshot);
    assert.doesNotMatch(JSON.stringify(jsonData(review.user, 'video_staging_review_data').creativeDirection), /CURRENT_UI_ONLY/u);
    assert.equal(JSON.stringify(master), before, 'generation cannot mutate the saved master');
    assert.notEqual(board.creativeDirection, master.creativeDirection);
    assert.notEqual(board.creativeDirection!.stylePreset, master.creativeDirection!.stylePreset);
    assert.notEqual(board.creativeDirection!.cameraTerms, master.creativeDirection!.cameraTerms);
    const rebuilt = qa.rebuild(board);
    assert.equal(rebuilt.extraRequirement, masterExtra);
    assert.deepEqual(rebuilt.creativeDirection, snapshot);
    assert.equal(qa.calls.rebuiltPlanExtras.at(-1), masterExtra,
      'rebuild passes the saved empty/full requirement to the actual prompt planner instead of current UI');
    assert.deepEqual(presetSnapshot(qa.calls.rebuiltPlanStyles.at(-1)!), snapshot.stylePreset,
      'rebuild passes the complete saved preset to the actual prompt planner, not the edited same-ID catalog entry');

    // An explicitly edited segment must re-plan its story, but its selected
    // film direction is still the confirmed master's, not current UI drift.
    const editedState = structuredClone(state);
    const editedPlan = editedState.project.sequencePlans[0];
    const editedSegment = { ...editedPlan.segments[0], contentOverridden: true };
    editedPlan.segments = [editedSegment];
    const edited = harness({ state: editedState, plan: editedPlan, extra: 'CURRENT_UI_ONLY_EXTRA' });
    edited.deps.cameraTerms = ['CURRENT_UI_ONLY_CAMERA_TERM'];
    edited.deps.lightingTerms = ['CURRENT_UI_ONLY_LIGHT_TERM'];
    const editedBoard = await edited.run({ segment: editedSegment, sequencePlanId: editedPlan.id, segmentCount: 1 });
    assert.equal(edited.calls.plans.length, 1, 'edited segment uses its re-planning path');
    assert.deepEqual(editedBoard.creativeDirection, snapshot);
    for (const field of ['name', 'visual', 'camera', 'lighting', 'sound'] as const) {
      assert.equal(edited.calls.plans[0].stylePreset[field], snapshot.stylePreset![field], `edited segment planning keeps master ${field}`);
    }
    assert.equal(edited.calls.plans[0].pacing.extraRequirement, masterExtra);
    assert.equal(edited.calls.pipeline[0].skipConversion, false);
  });
}

test('actual App semantic segment freezes public characters and carries only its own evidence through conversion and Chinese review', async () => {
  const state = makeState();
  const savedStyle = fullPreset();
  const savedCharacters = structuredClone(state.project.characters).map((character, index) => ({
    ...character, appearance: `FROZEN_APPEARANCE_${index}`, outfit: `FROZEN_OUTFIT_${index}`,
  }));
  const savedDirection = direction.buildVideoCreativeDirection({
    directorStyle: { id: styles.directorStylePresets[0].id, name: '完整导演名称', summary: '根据原文选择可见的自然表演与摄影关系。' },
    visualStyle: { name: '自然写实', prompt: visual.resolveVisualStylePrompt('自然写实') },
    stylePreset: presetSnapshot(savedStyle), cameraTerms: [], lightingTerms: [], extraRequirement: '',
  });
  const converter = state.converterPresets.find((item) => item.enabled && item.scope === 'video')!;
  const savedSettings: unknown[] = ['drama', 'text', 'auto', 3, 'slow', '9:16', '4K', 'none',
    savedStyle.id, state.ruleSets[0].id, converter.id, styles.directorStylePresets[0].id, [], [], '自然写实', '', []];
  savedSettings[24] = '剧情'; savedSettings[25] = '完整导演名称'; savedSettings[26] = '根据原文选择可见的自然表演与摄影关系。';
  // Reproduce old semantic plans whose action body and source evidence omit
  // the spoken line even though its assigned dialogue record is present.
  const currentBody = story;
  const futureBody = 'FUTURE_SEGMENT_ONLY：成年乙离开走廊，说：“FUTURE_DIALOGUE_ONLY。”';
  const response: semantic.SemanticSequenceResponse = {
    segmentCount: 2, reason: '模型按同行观察与离开两个连续阶段分配正文。', fitStatus: 'balanced',
    segments: [currentBody, futureBody].map((content, index) => ({
      title: `语义段${index + 1}`, content, summary: index ? '成年乙离开' : '两人同行查看纸页',
      narrativePurpose: '持续推进观察过程', entryState: index ? '观察已经结束' : '两人刚开始同行',
      exitState: index ? '成年乙离开画面' : '两人正在看纸页', transitionHint: '从已完成的状态继续',
      boundaryReason: '真实动作阶段', continuityPack: '保持同一走廊与既定外套',
      semanticSource: {
        sourceEvidence: [{ text: content }],
        events: [{ id: 'shared-observation', description: '两人同行后查看纸页', phase: index ? 'FUTURE_PHASE_ONLY' : '当前观察阶段' }],
        dialogues: [{ id: `dialogue-${index}`, speaker: index ? '成年乙' : '成年甲',
          text: index ? 'FUTURE_DIALOGUE_ONLY。' : '先看这一页。', language: '中文', continuation: '本段完整发话' }],
      },
    })),
  };
  const plan = semantic.materializeSemanticSequencePlan({
    title: '纯合成语义分段', story: `${currentBody}成年甲说：“先看这一页。”\n${futureBody}`, segmentDurationSec: 15,
    directorSettingsFingerprint: JSON.stringify(savedSettings), creativeDirection: savedDirection,
    pacing: { pace: '舒缓', directorCategory: '剧情', extraRequirement: '' },
    characterContinuity: savedCharacters, sourceSceneIds: [], shotMode: 'auto',
  }, response, { planId: 'semantic-direction-plan', now: 1 });
  const originalPlan = JSON.stringify(plan);
  state.project.sequencePlans = [plan];
  // A same-ID live edit, a deleted live identity, and unrelated old scene data
  // must not change the ordinary facts frozen by semantic planning.
  state.project.characters = [
    { ...state.project.characters[0], name: 'LIVE_ONLY_NAME', appearance: 'LIVE_ONLY_APPEARANCE', outfit: 'LIVE_ONLY_OUTFIT' },
    { ...state.project.characters[1], id: 'unrelated-adult', name: 'UNRELATED_PERSON_ONLY', outfit: 'UNRELATED_OUTFIT_ONLY' },
  ];
  state.project.scenes[0] = { ...state.project.scenes[0], content: 'UNRELATED_SCENE_ONLY',
    characterIds: ['unrelated-adult'], locationIds: ['unrelated-location'], propIds: ['unrelated-prop'] };
  state.stylePresets = [{ ...savedStyle, visual: 'LIVE_ONLY_VISUAL', camera: 'LIVE_ONLY_CAMERA' }];
  const qa = harness({ state, plan, extra: 'LIVE_ONLY_EXTRA' });
  qa.deps.cameraTerms = ['LIVE_ONLY_CAMERA_TERM']; qa.deps.lightingTerms = ['LIVE_ONLY_LIGHT_TERM'];
  const segment = plan.segments[0];
  const generationStory = semantic.semanticSegmentStoryContent(segment);
  assert.ok(!currentBody.includes('先看这一页。'));
  assert.ok(generationStory.includes('先看这一页。'));
  const board = await qa.run({ segment, sequencePlanId: plan.id, segmentCount: 2 });
  assert.equal(qa.calls.plans.length, 1, 'a semantic segment creates its own shot plan without a master storyboard');
  const planning = qa.calls.plans[0];
  assert.equal(planning.story, generationStory); assert.equal(planning.durationSec, 15);
  assert.equal(planning.requiredShotCount, undefined); assert.equal(planning.requiredSegmentDurationSec, undefined);
  assert.equal(planning.sequenceSegmentContext.kind, 'semantic-segment-source-v1');
  assert.deepEqual(planning.sequenceSegmentContext.segment.semanticSource, response.segments[0].semanticSource);
  assert.deepEqual(planning.characterContinuity.map((character: Record<string, unknown>) => ({
    id: character.id, name: character.name, appearance: character.appearance, outfit: character.outfit,
  })), savedCharacters.map(({ id, name, appearance, outfit }) => ({ id, name, appearance, outfit })));
  const pipeline = qa.calls.pipeline[0];
  assert.equal(pipeline.masterSource, undefined); assert.equal(pipeline.skipConversion, false);
  assert.equal(pipeline.sourceStoryContent, generationStory); assert.equal(pipeline.context.sceneContent, generationStory);
  for (const shot of pipeline.board.shots.filter((item) => item.sourceLocationStatus === 'located')) {
    assert.ok(generationStory.slice(shot.sourceStart, shot.sourceEnd).includes(shot.sourceExcerpt!),
      'materialized source coordinates address the same complete generation source');
  }
  assert.deepEqual(pipeline.sequenceSegmentContext?.segment.semanticSource, response.segments[0].semanticSource);
  assert.ok(pipeline.context.characters, 'the actual conversion pipeline receives frozen character facts');
  assert.deepEqual(pipeline.context.characters.map(({ id, name, appearance, outfit }) => ({ id, name, appearance, outfit })),
    savedCharacters.map(({ id, name, appearance, outfit }) => ({ id, name, appearance, outfit })));
  assert.deepEqual(board.creativeDirection, savedDirection); assert.equal(board.extraRequirement, '');
  assert.deepEqual([board.pace, board.aspectRatio, board.resolution, board.audioMode], ['slow', '9:16', '4K', 'none']);
  assert.deepEqual(board.sourceSceneIds, []); assert.equal(board.sourceStoryContent, generationStory);
  assert.equal(board.sourceContentHash, sourceContentHash(generationStory));
  assert.equal(board.sourceSceneSnapshots?.length, 1); assert.equal(board.sourceSceneSnapshots?.[0].content, generationStory);
  assert.deepEqual(board.sourceSceneSnapshots?.[0].characterIds, savedCharacters.map((character) => character.id));
  assert.deepEqual(board.sourceSceneSnapshots?.[0].locationIds, []); assert.deepEqual(board.sourceSceneSnapshots?.[0].propIds, []);
  assert.deepEqual(board.promptTrace?.sourceDocumentIds, []);
  const conversion = qa.calls.model.find((call) => call.stage === 'convert')!;
  const review = qa.calls.model.find((call) => call.stage === 'review')!;
  for (const call of [conversion, review]) {
    assert.deepEqual(jsonData(call.user, 'semantic_segment_source_data').sequenceSegmentContext.segment.semanticSource,
      response.segments[0].semanticSource, `${call.stage} receives current evidence, event phase and exact dialogue`);
    assert.match(call.system, /SEMANTIC_SEGMENT_SOURCE_CONTEXT_V1/u);
  }
  const reviewData = jsonData(review.user, 'video_staging_review_data');
  assert.equal(reviewData.sourceStoryContent, generationStory);
  assert.deepEqual(reviewData.characterIdentityFacts.map(({ name, appearance, outfit }: Record<string, unknown>) => ({ name, appearance, outfit })),
    savedCharacters.map(({ name, appearance, outfit }) => ({ name, appearance, outfit })));
  for (const call of qa.calls.model) {
    assert.doesNotMatch(call.user, /FUTURE_(?:SEGMENT|DIALOGUE|PHASE)_ONLY|LIVE_ONLY_|UNRELATED_(?:SCENE|PERSON|OUTFIT)_ONLY/u,
      `${call.stage} cannot import future story or live public-character/UI drift`);
    if (call.stage === 'translate') assert.doesNotMatch(call.user, /<semantic_segment_source_data>/u,
      'English translates the qualified Chinese rather than replanning semantic evidence');
  }
  assert.equal(getH3PromptProtocolIssue(board.officialPromptZh!), undefined);
  assert.equal(getH3PromptProtocolIssue(board.officialPromptEn!, board.officialPromptZh), undefined);
  assert.equal(JSON.stringify(plan), originalPlan, 'segment generation does not rewrite the immutable semantic plan');
  assert.deepEqual(qa.stateRef.current.project.storyboards.map((saved) => saved.id), [board.id],
    'the actual commit saves only the current segment, never a full-film master');
  const savedPlan = qa.stateRef.current.project.sequencePlans[0];
  assert.equal(savedPlan.masterStoryboardId, undefined); assert.equal(savedPlan.segments[0].storyboardId, board.id);
  assert.deepEqual(savedPlan.semanticPlanningSnapshot, plan.semanticPlanningSnapshot);
  assert.equal(JSON.stringify(savedPlan.segments[1]), JSON.stringify(plan.segments[1]),
    'the future segment keeps identical persisted data, including its planned status and absent storyboard');
  assert.deepEqual(qa.stateRef.current.project.scenes[0].storyboardIds, [], 'unrelated source scenes are not rebound to this segment');
  assert.deepEqual(qa.stateRef.current.project.generationTasks, [], 'mock text generation never creates a paid video task');
});

test('actual App keeps an explicitly selected exact count separate from automatic coverage', async () => {
  const qa = harness({ count: 2 });
  const board = await qa.run({ shotMode: 'exact', shotCount: 2 });
  assert.equal(qa.calls.plans[0].requiredShotCount, 2);
  assert.equal(board.shotMode, 'exact'); assert.equal(board.shotCount, 2); assert.equal(board.shots.length, 2);
  assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 7.5], [7.5, 15]]);
  assert.equal(readH3PromptProtocol(board.officialPromptZh!)?.shots.length, 2);
});
