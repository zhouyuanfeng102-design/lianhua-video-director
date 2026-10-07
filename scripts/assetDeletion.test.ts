import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { deleteAssetFromProject, storyboardReferencesAsset } from '../src/assetDeletion';
import { composeDerivedLocalPrompt, hasCurrentTextApiConversion, isSequenceSegmentComplete } from '../src/appEffects';
import {
  applyOfficialH3Prompt, buildOfficialH3CompileInput, buildOfficialH3SourceFingerprint,
  hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt,
} from '../src/officialPrompt';
import { compileOfficialSeedancePrompt, getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { sourceContentHash } from '../src/sourceContentHash';
import { bindStoryboardImageAsset, buildStoryboardImageRequests } from '../src/storyboardImages';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, Project, ReferenceAsset, Storyboard, VideoSequencePlan } from '../src/types';

const deletedId = 'asset-to-delete';
const retainedId = 'asset-to-keep';
const shotPrompts = [
  '【0s-5s】主体：李云；动作：李云听见敲门声，停步望向木门；空间：雨夜客栈；光影：暖色烛光；镜头：中景缓推；台词：第3.2s李云：“谁？”；音效：雨声与敲门声。',
  '【5s-10s】主体：李云；动作：李云抬手靠近门闩，侧耳倾听门外；空间：雨夜客栈；光影：暖色烛光；镜头：固定近景；台词：无；音效：雨声。',
];
// Preserve this exact spacing: the old deletion path rejoined shots with one
// newline and silently broke the converter fingerprint despite identical prose.
const canonical = shotPrompts.join('\n\n');
const english = [
  'integrated_multimodal_description: [Shot 1] Li Yun listens beside a wooden door. At 3.2s he says: <d>[Chinese] 谁？</d>',
  '[Shot 2] At 00:05.000, Li Yun raises his hand toward the latch and listens. No dialogue.',
  'overall_soundscape: Steady rain outside.',
  'non_diegetic_music: N/A',
].join('\n\n');
const makeAsset = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
  ...patch,
});
const contextFor = (project: Project) => ({
  assets: project.assets, characters: project.characters, locations: project.locations, props: project.props,
});
const makeBoard = (id: string, patch: Partial<Storyboard> = {}): Storyboard => {
  const shots: Storyboard['shots'] = shotPrompts.map((prompt, index) => ({
    id: `${id}-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
    purpose: '观察', subject: '李云', action: index ? '李云抬手靠近门闩' : '李云听到敲门声',
    camera: '中景缓推', transition: '切入', lighting: '烛光', sound: '雨声', result: '李云看向门口',
    referenceAssetIds: [], prompt, locked: true,
  }));
  const board: Storyboard = {
    id, sceneId: 'scene-a', workflow: 'drama', inputMode: 'text', durationSec: 10,
    durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: 'style_cinema', ruleSetId: 'timeline_director_cn',
    converterPresetId: 'converter_unified_video', globalLock: '李云身份不变', shots,
    finalPrompt: canonical,
    promptTrace: {
      modelRuleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video',
      sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1,
      mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical),
    },
    promptPlan: {
      canonicalPrompt: canonical, durationSec: 10, aspectRatio: '16:9', resolution: '2K',
      audioMode: 'stereo', workflow: 'drama', inputMode: 'text',
      shotIds: shots.map((shot) => shot.id), referenceAssetIds: [], constraints: [],
      trace: { ruleSetId: 'timeline_director_cn', converterId: 'converter_unified_video' },
    },
    generationPlan: { selectedShotIds: shots.map((shot) => shot.id), batches: [], totalEstimatedUnits: 1, createdAt: 1 },
    revisions: [{ id: `${id}-revision`, createdAt: 1, finalPrompt: canonical, englishPrompt: english,
      shots: shots.map((shot) => ({ ...shot, referenceAssetIds: [deletedId] })),
    }],
    createdAt: 1, updatedAt: 1,
  };
  const sourceContext = { assets: [], characters: [], locations: [], props: [] };
  const official = applyOfficialH3Prompt(board, sourceContext);
  // Simulate a saved AI staging review which adds content absent from the
  // canonical compiler output. Deletion must preserve it byte for byte too.
  const reviewedChinese = official.officialPromptZh!.replace('[Shot 1]', '[Shot 1] 李云保持原来的警惕神情。');
  const seedance = compileOfficialSeedancePrompt(buildOfficialH3CompileInput(official, sourceContext));
  return {
    ...official,
    officialPromptZh: reviewedChinese,
    targetOutput: { ...official.targetOutput!, prompt: reviewedChinese },
    officialPromptEn: english, officialPromptEnSource: reviewedChinese,
    englishPrompt: english, englishPromptSource: reviewedChinese,
    seedance25Output: {
      targetId: 'seedance-2.5', promptZh: seedance.promptZh, promptEn: 'Li Yun listens at the door.',
      durationSec: 10, sourceFingerprint: seedance.sourceFingerprint,
      englishSourceFingerprint: seedance.sourceFingerprint, referenceManifest: [], warnings: [], generatedAt: 1,
    },
    ...patch,
  };
};
const makeState = (boards: Storyboard[]): AppState => {
  const state = createInitialState();
  state.project.assets = [makeAsset(deletedId), makeAsset(retainedId)];
  state.project.characters = [];
  state.project.locations = [];
  state.project.props = [];
  state.project.storyboards = boards;
  state.project.scenes = [{ ...state.project.scenes[0], id: 'scene-a', storyboardIds: boards.map((board) => board.id) }];
  return state;
};
const authoredKeys = [
  'finalPrompt', 'englishPrompt', 'englishPromptSource', 'officialPromptZh', 'officialPromptEn',
  'officialPromptSource', 'officialPromptEnSource', 'seedance25Output', 'targetOutput', 'promptPlan',
  'promptTrace', 'generationPlan', 'continuityReport', 'revisions', 'globalLock',
] as const;
const assertAuthoredUnchanged = (before: Storyboard, after: Storyboard): void => {
  for (const key of authoredKeys) assert.strictEqual(after[key], before[key], `${key} must not change when a media asset is deleted`);
  assert.deepEqual(after.shots.map(({ referenceAssetIds: _ids, ...shot }) => shot),
    before.shots.map(({ referenceAssetIds: _ids, ...shot }) => shot));
};

// Execute the actual App wiring with the real pure deletion helper. No prompt
// rebuilding stub or model request can hide invalidation behavior anymore.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let deleteDeclaration: string | undefined;
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'deleteAsset') deleteDeclaration = `const ${node.getText(appAst)};`;
  ts.forEachChild(node, visit);
};
visit(appAst);
assert.ok(deleteDeclaration);
assert.doesNotMatch(deleteDeclaration, /rebuildStoryboard|invalidateSequenceSegmentsForMasterPrompt/u);
const deleteHandlerSource = ts.transpileModule(deleteDeclaration, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const deleteFromState = (initial: AppState, assetId = deletedId) => {
  let state = initial;
  let selectedAssetIds = [deletedId, retainedId];
  const dependencies = {
    deleteAssetFromProject,
    setSelectedAssetIds: (update: (current: string[]) => string[]) => { selectedAssetIds = update(selectedAssetIds); },
    notify: () => {},
    setState: (update: (current: AppState) => AppState) => { state = update(state); },
  };
  const deletion = new Function('dependencies', `with (dependencies) { ${deleteHandlerSource}; return deleteAsset; }`)(dependencies) as (id: string) => void;
  deletion(assetId);
  return { state, selectedAssetIds };
};

const unrelatedBoard = makeBoard('unrelated');
const unrelatedState = makeState([unrelatedBoard]);
const beforeUnrelated = JSON.stringify(unrelatedState);
const unrelated = deleteFromState(unrelatedState);
assert.strictEqual(unrelated.state.project.storyboards, unrelatedState.project.storyboards);
assert.strictEqual(unrelated.state.project.characters, unrelatedState.project.characters);
assert.deepEqual(unrelated.selectedAssetIds, [retainedId]);
assert.equal(unrelated.state.project.assets.some((asset) => asset.id === deletedId), false);
assert.equal(JSON.stringify(unrelatedState), beforeUnrelated, 'undo snapshots must remain immutable');
assert.strictEqual(deleteFromState(unrelatedState, 'missing').state, unrelatedState);
assert.strictEqual(deleteAssetFromProject(unrelatedState.project, '', 123), unrelatedState.project);
assert.equal(storyboardReferencesAsset(unrelatedBoard, ''), false);

const referenceCases: Array<[string, Partial<Storyboard>]> = [
  ['shot', { shots: unrelatedBoard.shots.map((shot) => ({ ...shot, referenceAssetIds: [deletedId, retainedId] })) }],
  ['global', { globalReferenceAssetIds: [deletedId, retainedId] }],
  ['first frame', { firstFrameAssetId: deletedId }],
  ['last frame', { lastFrameAssetId: deletedId }],
  ['image selections', { imageToImage: { referenceAssetIds: [deletedId, retainedId], selectedShotIds: ['shot-a'],
    referenceAssetIdsByShotId: { 'shot-a': [deletedId, retainedId], 'shot-b': [retainedId] } } }],
  ['audio', { audioLedger: [
    { id: 'cue-a', label: '李云提问', kind: 'dialogue', sourceAssetId: deletedId, speaker: '李云', text: '谁？', startSec: 3.2, endSec: 4, notes: '保持低声' },
    { id: 'cue-b', label: '雨声', kind: 'ambience', sourceAssetId: retainedId },
  ] }],
];
for (const [label, patch] of referenceCases) {
  const board = makeBoard(`bound-${label}`, patch);
  const initial = makeState([board, unrelatedBoard]);
  const before = JSON.stringify(initial);
  const result = deleteFromState(initial).state.project;
  const cleaned = result.storyboards[0];
  assertAuthoredUnchanged(board, cleaned);
  assert.strictEqual(result.storyboards[1], unrelatedBoard);
  assert.equal(cleaned.shots.some((shot) => shot.referenceAssetIds.includes(deletedId)), false);
  assert.equal(cleaned.globalReferenceAssetIds?.includes(deletedId) || false, false);
  assert.notEqual(cleaned.firstFrameAssetId, deletedId);
  assert.notEqual(cleaned.lastFrameAssetId, deletedId);
  assert.equal(cleaned.imageToImage?.referenceAssetIds.includes(deletedId) || false, false);
  assert.equal(Object.values(cleaned.imageToImage?.referenceAssetIdsByShotId || {}).some((ids) => ids.includes(deletedId)), false);
  assert.equal(cleaned.audioLedger?.some((cue) => cue.sourceAssetId === deletedId) || false, false);
  if (label === 'shot') assert.deepEqual(cleaned.shots[0].referenceAssetIds, [retainedId]);
  if (label === 'audio') {
    const { sourceAssetId: _sourceAssetId, ...expected } = board.audioLedger![0];
    assert.deepEqual(cleaned.audioLedger![0], expected, 'audio text/timing/emotion stay after unbinding its media file');
    assert.strictEqual(cleaned.audioLedger![1], board.audioLedger![1]);
  }
  if (label === 'image selections') assert.strictEqual(cleaned.imageToImage!.referenceAssetIdsByShotId['shot-b'], board.imageToImage!.referenceAssetIdsByShotId['shot-b']);
  assert.equal(JSON.stringify(initial), before, label);
}

const historical = makeBoard('historical', {
  promptTrace: { ...unrelatedBoard.promptTrace!, referenceAssetIds: [deletedId] },
  promptPlan: { ...unrelatedBoard.promptPlan!, referenceAssetIds: [deletedId] },
  targetOutput: { ...unrelatedBoard.targetOutput!, referenceManifest: [{ id: deletedId }, { assetId: deletedId }] },
});
assert.strictEqual(deleteFromState(makeState([historical])).state.project.storyboards[0], historical,
  'saved provenance is retained so missing real inputs can be diagnosed without rewriting the prompt');

const entityState = makeState([unrelatedBoard]);
const defaults = createInitialState().project;
entityState.project.characters = defaults.characters.map((item) => ({ ...item, assetIds: [deletedId, retainedId] }));
entityState.project.locations = defaults.locations.map((item) => ({ ...item, assetIds: [deletedId] }));
entityState.project.props = defaults.props.map((item) => ({ ...item, assetIds: [deletedId] }));
const entityResult = deleteAssetFromProject(entityState.project, deletedId, 100);
assert.deepEqual(entityResult.characters[0].assetIds, [retainedId]);
assert.deepEqual(entityResult.locations[0].assetIds, []);
assert.deepEqual(entityResult.props[0].assetIds, []);
assert.strictEqual(entityResult.storyboards[0], unrelatedBoard);

const master = makeBoard('master', { sequencePlanId: 'plan-a', firstFrameAssetId: deletedId });
const segment = makeBoard('segment-board', { sequencePlanId: 'plan-a', segmentId: 'segment-a' });
const plan: VideoSequencePlan = {
  id: 'plan-a', title: '全片', sourceStoryTitle: '剧情', sourceStoryContent: '李云听到敲门声',
  durationMode: 'fixed', totalDurationSec: 10, segmentDurationSec: 10,
  segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented',
  masterStoryboardId: master.id, masterPromptConfirmedAt: 1,
  masterPromptConfirmedFingerprint: 'saved-confirmation', reviewConfirmedFingerprint: 'saved-review',
  segments: [{ id: 'segment-a', index: 1, title: '第一段', globalStartSec: 0, globalEndSec: 10, durationSec: 10,
    content: '李云听到敲门声', summary: '敲门', sourceSceneIds: ['scene-a'], sourceBeatIds: [],
    sourceShotIds: master.shots.map((shot) => shot.id), narrativePurpose: '观察', entryState: '听雨', exitState: '看门',
    transitionHint: '动作衔接', storyboardId: segment.id, status: 'ready' }], createdAt: 1, updatedAt: 1,
};
const sequenceState = makeState([master, segment]);
sequenceState.project.sequencePlans = [plan];
const sequenceResult = deleteFromState(sequenceState).state.project;
assert.strictEqual(sequenceResult.sequencePlans, sequenceState.project.sequencePlans);
assert.strictEqual(sequenceResult.storyboards[1], segment);
assert.strictEqual(sequenceResult.scenes, sequenceState.project.scenes);
assert.equal(isSequenceSegmentComplete(plan.segments[0], sequenceResult.storyboards, plan.id), true);
assertAuthoredUnchanged(master, sequenceResult.storyboards[0]);

// Real generated-output lifecycle: bind two boundary images and two storyboard
// images, delete the whole batch, save/reopen, then bind replacement outputs.
const imageState = makeState([segment]);
imageState.project.sequencePlans = [{ ...plan, planningMode: 'semantic-segments', masterStoryboardId: undefined }];
imageState.project.assets = [];
const imageRequests = [
  ...buildStoryboardImageRequests(segment, 'boundary-frames'),
  ...buildStoryboardImageRequests(segment, 'storyboard-shots'),
];
let withImages = segment;
imageRequests.forEach((request, index) => {
  const id = `generated-${index}`;
  imageState.project.assets.push(makeAsset(id, { source: 'generated', sourceStoryboardId: segment.id, imageVariant: request.imageVariant }));
  withImages = bindStoryboardImageAsset(withImages, request, id);
});
imageState.project.storyboards = [withImages];
const validContext = contextFor(imageState.project);
assert.equal(hasCurrentTextApiConversion(withImages), true);
assert.equal(hasCurrentOfficialH3Prompt(withImages, validContext), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(withImages, validContext), true);
assert.notEqual(composeDerivedLocalPrompt(withImages.shots), withImages.finalPrompt,
  'this fixture must reproduce the whitespace-sensitive failure in the former reconstruction path');
const sourceFingerprint = buildOfficialH3SourceFingerprint(withImages, validContext);
let cleanedProject = imageState.project;
for (const asset of imageState.project.assets) {
  cleanedProject = deleteAssetFromProject(cleanedProject, asset.id, 200);
  const board = cleanedProject.storyboards[0];
  assertAuthoredUnchanged(withImages, board);
  assert.equal(hasCurrentTextApiConversion(board), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(board, contextFor(cleanedProject)), true);
  assert.equal(buildOfficialH3SourceFingerprint(board, contextFor(cleanedProject)), sourceFingerprint);
  assert.equal(isSequenceSegmentComplete(plan.segments[0], cleanedProject.storyboards, plan.id), true);
  assert.equal(getOfficialSeedanceSourceFingerprint(buildOfficialH3CompileInput(board, contextFor(cleanedProject))), board.seedance25Output!.sourceFingerprint);
}
assert.equal(cleanedProject.assets.length, 0);
assert.equal(cleanedProject.storyboards[0].shots.every((shot) => shot.referenceAssetIds.length === 0), true);
const serializedState = { ...imageState, project: cleanedProject, projects: [cleanedProject], activeProjectId: cleanedProject.id };
const restored = normalizeState(JSON.parse(serializeStateForStorage(serializedState).serialized));
const restoredBoard = restored.project.storyboards.find((board) => board.id === segment.id)!;
const baselineState = { ...imageState, projects: [imageState.project], activeProjectId: imageState.project.id };
const normalizedBaseline = normalizeState(JSON.parse(serializeStateForStorage(baselineState).serialized));
const baselineBoard = normalizedBaseline.project.storyboards.find((board) => board.id === segment.id)!;
assert.ok(restoredBoard);
for (const key of authoredKeys) assert.deepEqual(restoredBoard[key], baselineBoard[key], `storage must preserve ${key}`);
assert.equal(hasCurrentTextApiConversion(restoredBoard), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(restoredBoard, contextFor(restored.project)), true);
const replacement = makeAsset('replacement', { source: 'generated', sourceStoryboardId: restoredBoard.id, imageVariant: 'first-frame' });
const rebound = bindStoryboardImageAsset(restoredBoard, imageRequests[0], replacement.id);
const replacementProject = { ...restored.project, assets: [replacement], storyboards: [rebound] };
assertAuthoredUnchanged(restoredBoard, rebound);
assert.equal(hasCurrentOfficialH3EnglishPrompt(rebound, contextFor(replacementProject)), true);
assert.equal(hasCurrentTextApiConversion(rebound), true);

console.log('Asset deletion regression tests passed (exact bilingual delivery, real UI wiring, generated-output lifecycle and storage).');
