import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as effects from '../src/appEffects';
import * as official from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import * as handoff from '../src/sequencePromptHandoff';
import * as semantic from '../src/semanticSequencePlan';
import * as versions from '../src/storyboardVersions';
import { synchronizeH3StagingDelivery } from '../src/h3StagingDelivery';
import { getSingleSegmentReferences, type GenerateSingleSegmentPromptInput } from '../src/singleSegmentPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { normalizeVideoCreativeDirection } from '../src/videoCreativeDirection';
import { createInitialState } from '../src/storage';
import type { AppState, H3IdentityBindings, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';
import type { RegenerateSequenceReferencePromptInput } from '../src/sequenceReferencePrompt';

// Compile and execute the production App entry/commit callbacks. Only the
// model-facing pipeline is replaced; the mock deliberately ignores aborts so
// stale results must be rejected by the real App boundary. No project data,
// desktop bridge, live API, video generation or UI is touched.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
const collect = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(ast);
const compiled = ts.transpileModule([
  'sequenceStoryboardGenerationIdentity', 'hasActiveStoryboardBuild',
  'reviseStandaloneStoryboardPrompt', 'refreshSequenceSegmentOfficialPrompt', 'repairStoryboardDialogue',
  'storyboardShotPlanningFingerprint', 'updateStoryboard', 'normalizedRevisionHistory', 'restoreRevision',
].map((name) => {
  const node = declarations.get(name); assert.ok(node, `production callback ${name} exists`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Mode = 'dialogue-repair' | 'translate-english';
type Entry = 'sequence' | 'standalone';
type Runtime = {
  refreshSequenceSegmentOfficialPrompt: (plan: VideoSequencePlan, segment: VideoSegment, board: Storyboard,
    context: official.OfficialH3ProjectContext, mode: Mode) => Promise<boolean>;
  reviseStandaloneStoryboardPrompt: (id: string, mode: Mode) => Promise<void>;
  repairStoryboardDialogue: (id: string) => Promise<void>;
  restoreRevision: (revisionId: string) => void;
  updateStoryboard: (id: string, updater: (board: Storyboard) => Storyboard, rebuild?: boolean,
    options?: { exactRevisionRestore?: true }) => void;
};
const evaluate = (dependencies: Record<string, unknown>): Runtime => new Function('d', `with(d){${compiled};
  return {refreshSequenceSegmentOfficialPrompt,reviseStandaloneStoryboardPrompt,repairStoryboardDialogue,restoreRevision,updateStoryboard};}`)(dependencies);
const clone = <T>(value: T): T => structuredClone(value);
const savedJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const noOp = () => {};
const fixtureIdentity = (phase: string, language: 'zh' | 'en'): H3IdentityBindings => ({
  version: 1, characters: [
    { characterId: 'qa-person-a', name: '成年甲', speakerToken: '(S1)', referenceAnchor: `Identity: 成年甲 (S1), ${phase}-${language}-visual-identity.` },
    { characterId: 'qa-person-b', name: '成年乙', speakerToken: '(S2)', referenceAnchor: `Identity: 成年乙 (S2), ${phase}-${language}-visual-identity.` },
  ],
});
const story = '成年甲面向成年丙说：“请你听我把这句话说完整。”成年乙接着说：“我有自己的事要告诉你。”“师兄，我……也有事要对你说。”成年丙全程倾听。';
const spokenLines = ['请你听我把这句话说完整。', '我有自己的事要告诉你。', '师兄，我……也有事要对你说。'];
const context: official.OfficialH3ProjectContext = { assets: [], characters: [], locations: [], props: [], sceneContent: story };
const canonicalLine = (start: number, end: number, marker: string, index: number): string => {
  const dialogue = marker.startsWith('REPAIRED')
    ? index < spokenLines.length
      ? `本镜第0.2–4.5秒 @${index === 0 ? '成年甲' : '成年乙'}（原声音、画内、面向成年丙）：${spokenLines[index]}`
      : '无'
    : index < 2 ? '无'
      : `本镜第0.2–1.4秒 @成年甲：${spokenLines[0]}；本镜第1.5–2.6秒 @成年乙：${spokenLines[1]}；本镜第2.8–3.4秒 @成年乙（柔和、断续）：${spokenLines[2]}`;
  return `【${start}s-${end}s】主体：@成年甲、成年乙、成年丙（自然反应）[朝向：原交谈对象] 正在 [${marker}：按原顺序发话，听者自然倾听]（交谈推进）；空间：原站位与原轴线；光影：自然场内光；镜头：${index ? '说话者中近景' : '关系中景'}；台词：${dialogue}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
};
const canonicalFor = (repaired: boolean, autoReplan = false): string => (repaired
  ? autoReplan ? [[0, 5], [5, 10], [10, 14.7], [14.7, 15]] : [[0, 5], [5, 10], [10, 15]]
  : [[0, 6], [6, 11.5], [11.5, 15]])
  .map(([start, end], index) => canonicalLine(start, end, repaired ? `REPAIRED_${index}` : `OLD_${index}`, index)).join('\n');
const placeIdentityAnchors = (board: Storyboard, phase: string): void => {
  board.h3IdentityBindings = fixtureIdentity(phase, 'zh');
  board.officialPromptZh = board.officialPromptZh!.replace('[Shot 1]',
    `[Shot 1] ${board.h3IdentityBindings.characters.map((item) => item.referenceAnchor).join(' ')}`);
  board.targetOutput!.prompt = board.officialPromptZh;
};
const fillEnglish = (board: Storyboard, phase: string): void => {
  board.h3IdentityBindingsEn = fixtureIdentity(phase, 'en');
  board.officialPromptEn = board.officialPromptZh;
  for (const [index, item] of board.h3IdentityBindings!.characters.entries()) {
    board.officialPromptEn = board.officialPromptEn!.replace(item.referenceAnchor, board.h3IdentityBindingsEn.characters[index].referenceAnchor);
  }
  board.officialPromptEnSource = board.officialPromptZh;
  board.englishPrompt = board.officialPromptEn; board.englishPromptSource = board.finalPrompt; board.officialPromptEnError = '';
};

const fixture = (entry: Entry, autoReplan = false) => {
  let state = createInitialState();
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible',
    baseUrl: 'https://dialogue-app.mock.invalid', apiKey: '', model: 'mock-only' };
  const converter = state.converterPresets.find((item) => item.enabled && item.scope === 'video')!;
  const plan: VideoSequencePlan = {
    id: 'qa-plan', title: '合成对白修复', sourceStoryTitle: '合成对白修复', sourceStoryContent: story,
    durationMode: 'fixed', requestedTotalDurationSec: 45, totalDurationSec: 45, segmentDurationSec: 15,
    segmentationMode: 'fixed', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
    segments: [1, 2, 3].map((index) => ({ id: `segment-${index}`, index, title: `第${index}段`,
      globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15, content: story, summary: '合成片段正文',
      sourceSceneIds: ['qa-scene'], sourceBeatIds: [`beat-${index}`], narrativePurpose: '原话与人物关系',
      entryState: '维持原交谈位置', exitState: '原句已说完', transitionHint: '短动作承接，不重播原话', continuityPack: '既有站位和因果',
      storyboardId: `board-${index}`, status: 'ready', locked: false })),
  };
  const makeBoard = (id: string, segmentIndex?: number): Storyboard => {
    const canonical = canonicalFor(false);
    const draft: Storyboard = {
      id, sceneId: 'qa-scene', sourceStoryContent: story, sourceStoryTitle: '合成对白修复', workflow: 'drama', inputMode: 'text',
      durationSec: 15, durationPreset: '15s', shotMode: autoReplan ? 'auto' : 'exact',
      shotCount: autoReplan ? undefined : 3, recommendedShotCount: autoReplan ? 3 : undefined,
      pace: 'standard', aspectRatio: '16:9',
      resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
      ruleSetId: state.settings.defaultRuleSetId, converterPresetId: converter.id, globalLock: '',
      shots: [[0, 6], [6, 11.5], [11.5, 15]].map(([startSec, endSec], index) => ({
        id: `${id}-shot-${index}`, index: index + 1, startSec, endSec, subject: '成年甲、成年乙、成年丙',
        action: `OLD_${index}按原顺序发话`, purpose: '原话与人物关系', camera: '原机位', transition: '连续', lighting: '场内光',
        sound: '', result: '继续原站位', dialogue: '无', locked: false, referenceAssetIds: [],
        prompt: canonical.split('\n')[index],
      })),
      finalPrompt: canonical,
      ...(segmentIndex ? { sequencePlanId: plan.id, segmentId: `segment-${segmentIndex}`, segmentIndex, segmentCount: 3,
        globalStartSec: (segmentIndex - 1) * 15, globalEndSec: segmentIndex * 15,
        continuityIn: '维持原交谈位置', continuityOut: '原句已说完' } : {}),
      promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical), generatedAt: 1,
        modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [] },
      promptPlan: { canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
        workflow: 'drama', inputMode: 'text', shotIds: [0, 1, 2].map((index) => `${id}-shot-${index}`),
        referenceAssetIds: [], constraints: ['画幅16:9', '镜头偏好：自然切换'], trace: { ruleSetId: state.settings.defaultRuleSetId, converterId: converter.id } },
      audioLedger: [{ id: 'old-last-line', kind: 'dialogue', label: '旧草稿声账本', speaker: '成年乙',
        text: '师兄，我……也有事要对你说。', startSec: 14.3, endSec: 14.9 }],
      h3IdentityBindings: fixtureIdentity('old', 'zh'), h3IdentityBindingsEn: fixtureIdentity('old', 'en'),
      createdAt: 1, updatedAt: 1,
    };
    const board = official.applyOfficialH3Prompt(draft, context);
    placeIdentityAnchors(board, 'old');
    board.targetOutput!.parameters = { ...board.targetOutput!.parameters, sentinel: 'saved-video-parameters' };
    fillEnglish(board, 'old');
    board.revisions = [versions.createStoryboardRevision(board, [], { reason: 'existing-history', createdAt: 1 })];
    return board;
  };
  const boards = [1, 2, 3].map((index) => makeBoard(`board-${index}`, index));
  boards.push(makeBoard('standalone-board'));
  const targetId = entry === 'sequence' ? 'board-2' : 'standalone-board';
  state.project = { ...state.project, id: 'qa-project', assets: [], characters: [], locations: [], props: [],
    scenes: [{ id: 'qa-scene', title: '合成对白修复', content: story, summary: '', characterIds: [], locationIds: [], propIds: [],
      storyboardIds: boards.map((board) => board.id), createdAt: 1, updatedAt: 1 }],
    sequencePlans: [plan], storyboards: boards, generationTasks: [
      { id: 'already-queued-video', kind: 'video', storyboardId: targetId, targetId: 'minimax-h3', status: 'draft',
        requestBody: { prompt: 'IMMUTABLE_QUEUED_PROMPT', references: ['already-frozen-ref'] }, createdAt: 1, updatedAt: 1 },
      { id: 'other-segment-video', kind: 'video', storyboardId: 'board-3', targetId: 'minimax-h3', status: 'succeeded',
        requestBody: { prompt: 'OTHER_SAVED_PROMPT' }, resultUrl: 'synthetic-local-video.mov', createdAt: 1, updatedAt: 1 },
    ] };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const stateRef = { current: state };
  const operationRef: { current: { controller: AbortController } | null } = { current: null };
  const batchRef: { current: object | null } = { current: null };
  const epochRef = { current: 1 };
  const configurationRef = { current: 'qa-director-configuration' };
  let selectedBoardId = targetId;
  let englishFailure = false;
  const notices: string[] = [];
  const calls: Array<{ kind: Entry; mode: Mode; input: GenerateSingleSegmentPromptInput | RegenerateSequenceReferencePromptInput }> = [];
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const produce = async (kind: Entry, input: GenerateSingleSegmentPromptInput | RegenerateSequenceReferencePromptInput): Promise<Storyboard> => {
    const mode = input.mode === 'translate-english' ? 'translate-english' : 'dialogue-repair';
    assert.ok(kind === 'sequence' ? input.mode === mode
      : input.mode === 'translate-english' || 'purpose' in input && input.purpose === 'dialogue-repair');
    calls.push({ kind, mode, input }); started(); await gate;
    let next = clone(input.board);
    if (mode === 'dialogue-repair') {
      const sourceIds = next.shots.map((shot) => [shot.id]);
      if (autoReplan) sourceIds.push([]);
      next = synchronizeH3StagingDelivery(next, canonicalFor(true, autoReplan), sourceIds);
      next = official.applyOfficialH3Prompt(next, input.context);
      placeIdentityAnchors(next, 'repaired');
    }
    fillEnglish(next, 'repaired');
    if (input.sequenceHandoff) next = handoff.stampSequencePromptHandoff(next, input.sequenceHandoff);
    if (englishFailure) Object.assign(next, { officialPromptEn: '', officialPromptEnSource: '', englishPrompt: '',
      englishPromptSource: '', officialPromptEnError: 'SYNTHETIC_ENGLISH_FAILURE', h3IdentityBindingsEn: undefined });
    return next;
  };
  const dependencies: Record<string, unknown> = {
    ...effects, ...official, ...handoff, ...semantic, ...versions, officialH3ContextForStoryboard, sourceContentHash, getSingleSegmentReferences,
    masterPromptConfirmationFingerprint, normalizeVideoCreativeDirection,
    get board() { return state.project.storyboards.find((board) => board.id === targetId); },
    rebuildStoryboard: (board: Storyboard) => board,
    setActiveSegmentId: noOp, setConfirmedSequencePlanFingerprint: noOp, setAcceptedSequencePlanMismatchFingerprint: noOp,
    setAcknowledgedCompressedPlanFingerprint: noOp, setSequenceStage: noOp,
    busy: false, stateRef, sequencePromptRefreshRef: operationRef, workspaceEpochRef: epochRef,
    storyboardBuildLeaseRef: { current: undefined }, storyboardBusyOwnerRef: { current: 0 },
    sequenceBatchIdentityRef: batchRef, sequenceOperationIsCurrent: (identity: object) => batchRef.current === identity,
    segmentStoryboardConfigurationIdentityRef: configurationRef, converterId: converter.id,
    getCurrentStoryboardOperationIdentity: () => ({ storyboardId: selectedBoardId, workspaceEpoch: epochRef.current }),
    getBusyEpoch: () => 1, isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
    notify: (message: string) => notices.push(message), cleanVideoPrompt: (value: string) => value.trim(), setBusy: noOp,
    reportRuntimeError: (kind: string, error: unknown) => notices.push(`${kind}:${String(error)}`),
    loadVideoPromptReferenceImages: async () => assert.fail('dialogue repair cannot load reference pixels'),
    requestTextModel: async () => assert.fail('App fixture cannot call a transport'),
    regenerateSequenceReferencePrompt: (input: RegenerateSequenceReferencePromptInput) => produce('sequence', input),
    generateSingleSegmentPrompt: (input: GenerateSingleSegmentPromptInput) => produce('standalone', input),
    setState: (updater: (current: AppState) => AppState) => { state = updater(state); stateRef.current = state; },
  };
  const runtime = evaluate(dependencies);
  return {
    entry, targetId, ready, release, notices, calls,
    get state() { return state; },
    get board() { return state.project.storyboards.find((board) => board.id === targetId)!; },
    call: (mode: Mode = 'dialogue-repair') => entry === 'sequence'
      ? runtime.refreshSequenceSegmentOfficialPrompt(state.project.sequencePlans[0], state.project.sequencePlans[0].segments[1],
        state.project.storyboards.find((board) => board.id === targetId)!, context, mode)
      : runtime.reviseStandaloneStoryboardPrompt(targetId, mode),
    clickRepair: () => runtime.repairStoryboardDialogue(targetId),
    restore: (revisionId: string) => runtime.restoreRevision(revisionId),
    editBoard: (updater: (board: Storyboard) => Storyboard, rebuild = false, options?: { exactRevisionRestore?: true }) =>
      runtime.updateStoryboard(targetId, updater, rebuild, options),
    update: (mutate: (current: AppState) => void) => { state = clone(state); mutate(state); stateRef.current = state; },
    cancel: () => operationRef.current?.controller.abort(),
    changeConfiguration: () => { configurationRef.current = 'changed-live-director-configuration'; },
    changeEpoch: () => { epochRef.current += 1; },
    changeSelectedBoard: () => { selectedBoardId = 'board-3'; },
    setEnglishFailure: (value: boolean) => { englishFailure = value; },
  };
};
type Harness = ReturnType<typeof fixture>;
const begin = async (h: Harness, entryPoint = false) => {
  const pending = entryPoint ? h.clickRepair() : h.call();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([h.ready,
      pending.then((result) => { throw new Error(`App stopped before mocked pipeline: ${String(result)}; ${h.notices.join('; ')}`); }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('App did not reach mocked pipeline')), 3000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
  return { pending };
};
let groups = 0;
const errors: unknown[] = [];
const test = async (name: string, run: () => Promise<void>) => {
  try { await run(); groups += 1; console.log(`PASS ${name}`); }
  catch (error) { errors.push(error); console.error(`FAIL ${name}`); console.error(error); }
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => assert.fail('live network is forbidden')) as typeof fetch;
try {
  for (const entry of ['sequence', 'standalone'] as const) {
    await test(`${entry}: actual repair button commits synchronized timing/canonical/H3/identity and immutable before-after versions only to selected board`, async () => {
      const h = fixture(entry); const before = clone(h.state.project); const oldBoard = clone(h.board);
      const { pending } = await begin(h, true);
      await h.clickRepair(); assert.equal(h.calls.length, 1, 'repeat click cannot launch another model pipeline');
      h.release(); await pending;
      const result = h.board;
      assert.deepEqual(h.calls.map(({ kind, mode }) => [kind, mode]), [[entry, 'dialogue-repair']]);
      assert.equal(result.finalPrompt, canonicalFor(true));
      assert.equal(result.promptPlan?.canonicalPrompt, canonicalFor(true));
      assert.equal(result.promptTrace?.convertedPromptFingerprint, sourceContentHash(canonicalFor(true)));
      assert.deepEqual(result.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 5], [5, 10], [10, 15]]);
      assert.equal(result.shots.map((shot) => shot.prompt).join('\n'), result.finalPrompt);
      assert.equal(result.shotCount, 3); assert.equal(result.durationSec, 15);
      assert.equal(result.audioLedger, undefined, 'old speech windows cannot survive a retimed canonical delivery');
      assert.notEqual(result.officialPromptZh, oldBoard.officialPromptZh);
      assert.equal(result.targetOutput?.prompt, result.officialPromptZh);
      assert.deepEqual(result.targetOutput?.parameters, oldBoard.targetOutput?.parameters);
      assert.equal(official.hasCurrentOfficialH3Prompt(result, context), true);
      assert.equal(official.hasCurrentOfficialH3EnglishPrompt(result, context), true);
      assert.deepEqual(result.h3IdentityBindings, fixtureIdentity('repaired', 'zh'));
      assert.deepEqual(result.h3IdentityBindingsEn, fixtureIdentity('repaired', 'en'));
      const revisions = result.revisions!;
      assert.equal(revisions.length, 3, 'existing history plus explicit before/after snapshots');
      assert.deepEqual(revisions[0], oldBoard.revisions![0]);
      assert.equal(revisions[1].reason, 'pre-dialogue-repair'); assert.equal(revisions[2].reason, 'dialogue-repair');
      assert.equal(revisions[1].finalPrompt, oldBoard.finalPrompt); assert.equal(revisions[2].finalPrompt, result.finalPrompt);
      assert.deepEqual(revisions[1].shots, savedJson(oldBoard.shots)); assert.deepEqual(revisions[2].shots, savedJson(result.shots));
      assert.deepEqual(revisions[1].h3IdentityBindings, oldBoard.h3IdentityBindings);
      assert.deepEqual(revisions[2].h3IdentityBindings, result.h3IdentityBindings);
      assert.deepEqual(revisions[2].h3IdentityBindingsEn, result.h3IdentityBindingsEn);
      assert.equal(result.activeRevisionId, revisions[2].id);
      assert.notStrictEqual(revisions[2].shots, result.shots, 'revision snapshots never share live shot arrays');
      assert.deepEqual(h.state.project.storyboards.filter((board) => board.id !== h.targetId), before.storyboards.filter((board) => board.id !== h.targetId));
      assert.deepEqual(h.state.project.sequencePlans, before.sequencePlans);
      assert.deepEqual(h.state.project.generationTasks, before.generationTasks, 'queued/running/completed video provenance is never rewritten');
      assert.deepEqual(h.state.project.assets, before.assets);
      if (entry === 'sequence') assert.equal(handoff.getSequencePromptHandoffStatus(result, h.state.project).kind, 'current');
    });

    await test(`${entry}: actual revision restore retains matched H3/AI completion and cloned plan/trace before and after repair`, async () => {
      const h = fixture(entry); const queued = clone(h.state.project.generationTasks); const { pending } = await begin(h);
      h.release(); await pending;
      const repaired = clone(h.board);
      const before = repaired.revisions![1]; const after = repaired.revisions![2];
      assert.ok(before.promptPlan && before.promptTrace && after.promptPlan && after.promptTrace);
      const checkReady = () => {
        assert.equal(official.hasCurrentOfficialH3Prompt(h.board, context), true);
        assert.equal(official.hasCurrentOfficialH3EnglishPrompt(h.board, context), true);
        assert.equal(effects.hasCurrentTextApiConversion(h.board), true);
        if (entry === 'sequence') assert.equal(effects.isSequenceSegmentComplete(h.state.project.sequencePlans[0].segments[1],
          h.state.project.storyboards, h.state.project.sequencePlans[0].id), true);
      };
      h.restore(before.id);
      assert.equal(h.board.finalPrompt, canonicalFor(false));
      assert.deepEqual(h.board.promptPlan, before.promptPlan); assert.deepEqual(h.board.promptTrace, before.promptTrace);
      assert.notEqual(h.board.promptPlan, h.board.revisions![1].promptPlan);
      assert.notEqual(h.board.promptTrace, h.board.revisions![1].promptTrace);
      assert.notEqual(h.board.targetOutput, h.board.revisions![1].targetOutput);
      assert.equal(h.board.revisions?.length, 4, 'restoration saves the pre-restore state');
      checkReady();
      h.restore(after.id);
      assert.equal(h.board.finalPrompt, canonicalFor(true));
      assert.deepEqual(h.board.promptPlan, after.promptPlan); assert.deepEqual(h.board.promptTrace, after.promptTrace);
      assert.equal(h.board.revisions?.length, 5); checkReady();
      assert.deepEqual(h.board.revisions!.slice(0, 3), repaired.revisions);
      assert.deepEqual(h.state.project.generationTasks, queued);
      assert.equal(h.calls.length, 1, 'restoration never calls the text or video API');
    });

    await test(`${entry}: actual legacy restore clears newer plan/trace instead of inventing API provenance`, async () => {
      const h = fixture(entry);
      h.update((state) => {
        const revision = state.project.storyboards.find((board) => board.id === h.targetId)!.revisions![0];
        delete revision.promptPlan; delete revision.promptTrace;
      });
      const legacy = clone(h.board.revisions![0]);
      h.restore(legacy.id);
      assert.equal(h.board.promptPlan, undefined); assert.equal(h.board.promptTrace, undefined);
      assert.equal(h.board.finalPrompt, legacy.finalPrompt); assert.equal(h.board.officialPromptZh, legacy.officialPromptZh);
      assert.equal(effects.hasCurrentTextApiConversion(h.board), false);
      assert.equal(h.calls.length, 0);
    });

    await test(`${entry}: auto three-to-four-shot repair and actual before/after restore preserve shot-count authority`, async () => {
      const h = fixture(entry, true); const queued = clone(h.state.project.generationTasks);
      const { pending } = await begin(h); h.release(); await pending;
      const repaired = clone(h.board); const before = repaired.revisions![1]; const after = repaired.revisions![2];
      assert.equal(repaired.shotMode, 'auto'); assert.equal(repaired.shotCount, undefined);
      assert.equal(repaired.recommendedShotCount, 4); assert.equal(repaired.shots.length, 4);
      assert.equal(before.shotMode, 'auto'); assert.equal(before.shotCount, undefined); assert.equal(before.recommendedShotCount, 3);
      assert.equal(after.shotMode, 'auto'); assert.equal(after.shotCount, undefined); assert.equal(after.recommendedShotCount, 4);
      for (const [revision, expectedCount] of [[before, 3], [after, 4]] as const) {
        h.restore(revision.id);
        assert.equal(h.board.shotMode, 'auto'); assert.equal(h.board.shotCount, undefined);
        assert.equal(h.board.recommendedShotCount, expectedCount); assert.equal(h.board.shots.length, expectedCount);
        assert.equal(h.board.finalPrompt, revision.finalPrompt); assert.equal(h.board.officialPromptZh, revision.officialPromptZh);
        assert.equal(official.hasCurrentOfficialH3Prompt(h.board, context), true);
        assert.equal(effects.hasCurrentTextApiConversion(h.board), true);
        assert.equal(h.board.durationSec, 15);
      }
      assert.deepEqual(h.state.project.generationTasks, queued);
      assert.equal(h.calls.length, 1, 'auto revision restores do not generate new text or video');
    });

    await test(`${entry}: real update callback still invalidates ordinary edits and refuses bypass during rebuild`, async () => {
      for (const [rebuild, options] of [[false, undefined], [true, { exactRevisionRestore: true }]] as const) {
        const h = fixture(entry);
        h.editBoard((board) => ({ ...board, shots: board.shots.map((shot, index) => index ? shot : { ...shot, camera: 'manual-edit' }) }),
          rebuild, options);
        assert.equal(h.board.promptTrace?.mode, 'local-fallback');
        assert.equal(h.board.promptTrace?.shotPlanMode, 'locally-edited');
        assert.equal(h.board.promptTrace?.convertedPromptFingerprint, undefined);
        assert.equal(effects.hasCurrentTextApiConversion(h.board), false);
        assert.equal(h.calls.length, 0);
      }
    });

    await test(`${entry}: English failure retains synchronized Chinese and both revisions; English-only retry preserves repaired source`, async () => {
      const h = fixture(entry); h.setEnglishFailure(true); const before = clone(h.board); const { pending } = await begin(h);
      h.release(); await pending;
      const repaired = clone(h.board);
      assert.equal(repaired.finalPrompt, canonicalFor(true));
      assert.notEqual(repaired.officialPromptZh, before.officialPromptZh);
      assert.equal(official.hasCurrentOfficialH3Prompt(repaired, context), true);
      assert.equal(repaired.officialPromptEn, ''); assert.equal(repaired.h3IdentityBindingsEn, undefined);
      assert.equal(repaired.officialPromptEnError, 'SYNTHETIC_ENGLISH_FAILURE');
      assert.equal(repaired.revisions?.length, 3);
      assert.deepEqual(repaired.h3IdentityBindings, fixtureIdentity('repaired', 'zh'));
      h.setEnglishFailure(false); await h.call('translate-english');
      assert.deepEqual(h.calls.map(({ mode }) => mode), ['dialogue-repair', 'translate-english']);
      assert.equal(h.board.finalPrompt, repaired.finalPrompt); assert.equal(h.board.officialPromptZh, repaired.officialPromptZh);
      assert.deepEqual(h.board.shots, repaired.shots); assert.deepEqual(h.board.promptPlan, repaired.promptPlan);
      assert.deepEqual(h.board.h3IdentityBindings, repaired.h3IdentityBindings);
      assert.deepEqual(h.board.h3IdentityBindingsEn, fixtureIdentity('repaired', 'en'));
      assert.deepEqual(h.board.revisions, repaired.revisions, 'English-only retry cannot redo the Chinese repair or revisions');
      assert.equal(h.board.officialPromptEnError, ''); assert.equal(h.board.officialPromptEnSource, h.board.officialPromptZh);
    });

    const mutations: Array<[string, (h: Harness) => void]> = [
      ['cancel', (h) => h.cancel()],
      ['workspace epoch', (h) => h.changeEpoch()],
      ['project', (h) => h.update((state) => { state.project.id = 'changed-project'; })],
      ['live director parameters', (h) => h.changeConfiguration()],
      ['saved request parameters', (h) => h.update((state) => {
        state.project.storyboards.find((board) => board.id === h.targetId)!.targetOutput!.parameters.sentinel = 'changed-by-user';
      })],
      ['API selection', (h) => h.update((state) => { state.settings.textApi.model = 'changed-api-model'; })],
      ['user Chinese edit', (h) => h.update((state) => { state.project.storyboards.find((board) => board.id === h.targetId)!.officialPromptZh += '\nUSER_EDIT'; })],
      ['user shot edit', (h) => h.update((state) => { state.project.storyboards.find((board) => board.id === h.targetId)!.shots[0].camera = 'USER_CAMERA_EDIT'; })],
    ];
    if (entry === 'sequence') mutations.push(
      ['parent final text', (h) => h.update((state) => { state.project.storyboards[0].officialPromptZh += '\nUSER_PARENT_EDIT'; })],
      ['parent link', (h) => h.update((state) => { state.project.sequencePlans[0].segments[0].storyboardId = 'changed-parent'; })],
      ['parent result state', (h) => h.update((state) => { state.project.sequencePlans[0].segments[0].exitState = 'changed-parent-result'; })],
      ['current segment source', (h) => h.update((state) => { state.project.sequencePlans[0].segments[1].content += 'USER_SOURCE_EDIT'; })],
    );
    else mutations.push(['selected board', (h) => h.changeSelectedBoard()]);
    for (const [label, mutate] of mutations) await test(`${entry}: ${label} invalidates an uncancellable late repair without changing drafts/versions/tasks`, async () => {
      const h = fixture(entry); const { pending } = await begin(h); mutate(h);
      const expected = clone(h.state.project); h.release(); await pending;
      assert.deepEqual(h.state.project, expected);
      assert.equal(h.calls.length, 1);
    });
  }
  await test('locked selected sequence segment is rejected before any repair pipeline and all drafts/tasks remain intact', async () => {
    const h = fixture('sequence'); h.update((state) => { state.project.sequencePlans[0].segments[1].locked = true; });
    const expected = clone(h.state.project); await h.clickRepair();
    assert.equal(h.calls.length, 0); assert.deepEqual(h.state.project, expected);
    assert.ok(h.notices.some((value) => value.includes('已锁定')));
  });
} finally { globalThis.fetch = originalFetch; }
if (errors.length) throw new AggregateError(errors, `${errors.length} actual dialogue-repair App regression(s) failed`);
console.log(`dialogueRepairApp: ${groups} isolated actual-callback groups passed; no paid API or real project data`);
