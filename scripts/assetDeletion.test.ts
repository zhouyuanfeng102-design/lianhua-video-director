import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { storyboardReferencesAsset } from '../src/assetDeletion';
import { invalidateSequenceSegmentsForMasterPrompt } from '../src/appEffects';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { createInitialState } from '../src/storage';
import type { AppState, ReferenceAsset, Storyboard, VideoSequencePlan } from '../src/types';

const deletedId = 'asset-to-delete';
const retainedId = 'asset-to-keep';
const chinese = '【0s-5.00s】 主体：@李云；台词：第3.2s @李云：“谁？”；音效：环境层-[雨声]';
const english = '[0s-5.00s] Li Yun listens. At 3.2s @李云：“谁？”';
const makeAsset = (id: string): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
});
const makeBoard = (id: string, patch: Partial<Storyboard> = {}): Storyboard => ({
  id, sceneId: 'scene-a', workflow: 'drama', inputMode: 'text', durationSec: 5,
  durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: 'style_cinema', ruleSetId: 'timeline_director_cn',
  converterPresetId: 'converter_unified_video', globalLock: '李云身份不变',
  shots: [{
    id: `${id}-shot`, index: 1, startSec: 0, endSec: 5, purpose: '观察',
    subject: '李云', action: '李云听到敲门声', camera: '中景缓推', transition: '切入',
    lighting: '烛光', sound: '雨声', result: '李云看向门口',
    referenceAssetIds: [], prompt: chinese, locked: true,
  }],
  finalPrompt: chinese, englishPrompt: english, englishPromptSource: chinese,
  officialPromptZh: chinese, officialPromptEn: english,
  officialPromptSource: 'saved-source-fingerprint', officialPromptEnSource: chinese,
  targetModelId: 'minimax-h3',
  targetOutput: {
    targetId: 'minimax-h3', prompt: chinese, parameters: { seed: 123 },
    referenceManifest: [], warnings: [], generatedAt: 1,
  },
  promptTrace: {
    modelRuleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video',
    sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1,
    mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: 'saved-conversion',
  },
  promptPlan: {
    canonicalPrompt: chinese, durationSec: 5, aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', workflow: 'drama', inputMode: 'text',
    shotIds: [`${id}-shot`], referenceAssetIds: [], constraints: [],
    trace: { ruleSetId: 'timeline_director_cn', converterId: 'converter_unified_video' },
  },
  generationPlan: { selectedShotIds: [`${id}-shot`], batches: [], totalEstimatedUnits: 1, createdAt: 1 },
  revisions: [{ id: `${id}-revision`, createdAt: 1, finalPrompt: chinese, englishPrompt: english }],
  createdAt: 1, updatedAt: 1,
  ...patch,
});

const makeState = (boards: Storyboard[]): AppState => {
  const state = createInitialState();
  state.project.assets = [makeAsset(deletedId), makeAsset(retainedId)];
  state.project.storyboards = boards;
  state.project.scenes = [{
    ...state.project.scenes[0], id: 'scene-a', storyboardIds: boards.map((board) => board.id),
  }];
  return state;
};

// Exercise the actual UI deletion transaction without mounting React or making
// model requests. Only prompt rebuilding is a spy; reference cleanup and master
// timeline invalidation run through the production handler and real helpers.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let deleteDeclaration: string | undefined;
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'deleteAsset') {
    deleteDeclaration = `const ${node.getText(appAst)};`;
  }
  ts.forEachChild(node, visit);
};
visit(appAst);
assert.ok(deleteDeclaration, 'the AssetsView delete action must remain covered by this integration test');
const deleteHandlerSource = ts.transpileModule(deleteDeclaration, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const deleteFromState = (initial: AppState, assetId = deletedId) => {
  let state = initial;
  const rebuilt: Storyboard[] = [];
  const rebuildSnapshots: AppState[] = [];
  const dependencies = {
    storyboardReferencesAsset,
    masterPromptConfirmationFingerprint,
    invalidateSequenceSegmentsForMasterPrompt,
    setSelectedAssetIds: () => {},
    notify: () => {},
    setState: (update: (current: AppState) => AppState) => { state = update(state); },
    rebuildStoryboard: (board: Storyboard, shots: Storyboard['shots'], snapshot: AppState): Storyboard => {
      rebuilt.push(board);
      rebuildSnapshots.push(snapshot);
      return {
        ...board, shots, finalPrompt: `rebuilt ${board.id}`, officialPromptZh: `rebuilt ${board.id}`,
        officialPromptEn: '', englishPrompt: '', generationPlan: undefined,
      };
    },
  };
  const deletion = new Function('dependencies', `with (dependencies) { ${deleteHandlerSource}; return deleteAsset; }`)(dependencies) as (id: string) => void;
  deletion(assetId);
  return { state, rebuilt, rebuildSnapshots };
};

const unrelatedBoard = makeBoard('unrelated');
const unrelatedState = makeState([unrelatedBoard]);
const beforeUnrelated = JSON.stringify(unrelatedState);
const unrelated = deleteFromState(unrelatedState);
assert.equal(unrelated.rebuilt.length, 0, 'deleting an unbound image must never invoke prompt reconstruction');
assert.strictEqual(unrelated.state.project.storyboards[0], unrelatedBoard, 'the complete unrelated board must retain object identity');
assert.equal(unrelated.state.project.storyboards[0].officialPromptEn, english);
assert.match(unrelated.state.project.storyboards[0].finalPrompt, /第3\.2s/u, 'converter-authored dialogue timing must stay exact');
assert.strictEqual(unrelated.state.project.storyboards[0].generationPlan, unrelatedBoard.generationPlan);
assert.equal(unrelated.state.project.assets.some((asset) => asset.id === deletedId), false);
assert.equal(JSON.stringify(unrelatedState), beforeUnrelated, 'the original project and undo snapshot must remain immutable');

const referenceCases: Array<[string, (board: Storyboard) => Storyboard]> = [
  ['shot', (board) => ({ ...board, shots: board.shots.map((shot) => ({ ...shot, referenceAssetIds: [deletedId, retainedId] })) })],
  ['global', (board) => ({ ...board, globalReferenceAssetIds: [deletedId, retainedId] })],
  ['trace', (board) => ({ ...board, promptTrace: { ...board.promptTrace!, referenceAssetIds: [deletedId, retainedId] } })],
  ['prompt plan', (board) => ({ ...board, promptPlan: { ...board.promptPlan!, referenceAssetIds: [deletedId] } })],
  ['target manifest', (board) => ({ ...board, targetOutput: { ...board.targetOutput!, referenceManifest: [{ id: deletedId }] } })],
  ['legacy target manifest', (board) => ({ ...board, targetOutput: { ...board.targetOutput!, referenceManifest: [{ assetId: deletedId }] } })],
  ['first frame', (board) => ({ ...board, firstFrameAssetId: deletedId })],
  ['last frame', (board) => ({ ...board, lastFrameAssetId: deletedId })],
  ['audio', (board) => ({ ...board, audioLedger: [
    { id: 'deleted-cue', label: '旧环境声', kind: 'ambience', sourceAssetId: deletedId },
    { id: 'retained-cue', label: '保留环境声', kind: 'ambience', sourceAssetId: retainedId },
  ] })],
];
for (const [label, bind] of referenceCases) {
  const boundBoard = bind(makeBoard(`bound-${label}`));
  assert.equal(storyboardReferencesAsset(boundBoard, deletedId), true, `${label} must be treated as a current dependency`);
  const result = deleteFromState(makeState([boundBoard, unrelatedBoard]));
  assert.equal(result.rebuilt.length, 1, `only the ${label} owner may be rebuilt`);
  assert.strictEqual(result.state.project.storyboards[1], unrelatedBoard, `${label} cleanup must not touch another board`);
  const cleaned = result.rebuilt[0];
  assert.equal(cleaned.shots.some((shot) => shot.referenceAssetIds.includes(deletedId)), false);
  assert.equal(cleaned.globalReferenceAssetIds?.includes(deletedId) || false, false);
  assert.equal(cleaned.promptTrace?.referenceAssetIds.includes(deletedId) || false, false);
  assert.notEqual(cleaned.firstFrameAssetId, deletedId);
  assert.notEqual(cleaned.lastFrameAssetId, deletedId);
  assert.equal(cleaned.audioLedger?.some((cue) => cue.sourceAssetId === deletedId) || false, false);
  assert.equal(result.rebuildSnapshots[0].project.assets.some((asset) => asset.id === deletedId), false);
  if (label === 'shot') assert.deepEqual(cleaned.shots[0].referenceAssetIds, [retainedId]);
  if (label === 'audio') assert.deepEqual(cleaned.audioLedger?.map((cue) => cue.id), ['retained-cue']);
}

const entityState = makeState([unrelatedBoard]);
entityState.project.characters[0].assetIds = [deletedId, retainedId];
entityState.project.locations[0].assetIds = [deletedId];
entityState.project.props[0].assetIds = [deletedId];
const entityDeletion = deleteFromState(entityState);
assert.deepEqual(entityDeletion.state.project.characters[0].assetIds, [retainedId]);
assert.deepEqual(entityDeletion.state.project.locations[0].assetIds, []);
assert.deepEqual(entityDeletion.state.project.props[0].assetIds, []);
assert.strictEqual(entityDeletion.state.project.storyboards[0], unrelatedBoard, 'an entity asset library alone is not a reference selected by this board');
assert.equal(entityDeletion.rebuilt.length, 0);

const historicalOnly = makeBoard('historical', {
  revisions: [{ id: 'old-revision', createdAt: 1, finalPrompt: chinese,
    shots: unrelatedBoard.shots.map((shot) => ({ ...shot, referenceAssetIds: [deletedId] })),
  }],
});
assert.equal(storyboardReferencesAsset(historicalOnly, deletedId), false, 'historical revisions must not invalidate the current prompt');
assert.strictEqual(deleteFromState(makeState([historicalOnly])).state.project.storyboards[0], historicalOnly);

const master = makeBoard('master', { sequencePlanId: 'plan-a' });
const segment = makeBoard('segment-board', { sequencePlanId: 'plan-a', segmentId: 'segment-a' });
const plan: VideoSequencePlan = {
  id: 'plan-a', title: '全片', sourceStoryTitle: '剧情', sourceStoryContent: '李云听到敲门声',
  durationMode: 'fixed', totalDurationSec: 5, segmentDurationSec: 5,
  segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented',
  masterStoryboardId: master.id, masterPromptConfirmedAt: 1,
  masterPromptConfirmedFingerprint: 'saved-confirmation', reviewConfirmedFingerprint: 'saved-review',
  segments: [{
    id: 'segment-a', index: 1, title: '第一段', globalStartSec: 0, globalEndSec: 5, durationSec: 5,
    content: '李云听到敲门声', summary: '敲门', sourceSceneIds: ['scene-a'], sourceBeatIds: [],
    sourceShotIds: [master.shots[0].id], narrativePurpose: '观察', entryState: '听雨', exitState: '看门',
    transitionHint: '动作衔接', storyboardId: segment.id, status: 'ready',
  }], createdAt: 1, updatedAt: 1,
};
const sequenceState = makeState([master, segment]);
sequenceState.project.sequencePlans = [plan];
const sequenceDeletion = deleteFromState(sequenceState);
assert.strictEqual(sequenceDeletion.state.project.storyboards[0], master);
assert.strictEqual(sequenceDeletion.state.project.storyboards[1], segment);
assert.strictEqual(sequenceDeletion.state.project.sequencePlans, sequenceState.project.sequencePlans);
assert.strictEqual(sequenceDeletion.state.project.sequencePlans[0], plan);
assert.strictEqual(sequenceDeletion.state.project.scenes, sequenceState.project.scenes);
assert.equal(sequenceDeletion.state.project.sequencePlans[0].segments[0].status, 'ready');

// A genuinely bound master still follows the existing invalidation semantics.
const boundMaster = referenceCases[0][1](master);
const relatedSequence = makeState([boundMaster, segment, unrelatedBoard]);
relatedSequence.project.sequencePlans = [plan];
const relatedSequenceDeletion = deleteFromState(relatedSequence);
assert.equal(relatedSequenceDeletion.state.project.sequencePlans[0].planningStage, 'master-draft');
assert.deepEqual(relatedSequenceDeletion.state.project.sequencePlans[0].segments, []);
assert.equal(relatedSequenceDeletion.state.project.storyboards.some((board) => board.id === segment.id), false);
assert.strictEqual(relatedSequenceDeletion.state.project.storyboards.find((board) => board.id === unrelatedBoard.id), unrelatedBoard);
assert.equal(relatedSequenceDeletion.state.project.scenes[0].storyboardIds.includes(segment.id), false);

const missing = deleteFromState(sequenceState, 'nonexistent-id');
assert.strictEqual(missing.state, sequenceState, 'deleting a missing asset must be a no-op, including project timestamps and plans');
assert.equal(missing.rebuilt.length, 0);
assert.equal(storyboardReferencesAsset(unrelatedBoard, ''), false);

console.log('Asset deletion regression tests passed.');
