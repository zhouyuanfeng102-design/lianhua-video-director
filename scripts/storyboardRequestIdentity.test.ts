import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { isCurrentOperationIdentity, isCurrentSequenceOperation } from '../src/appEffects';
import { buildSequencePromptHandoff } from '../src/sequencePromptHandoff';
import { sequencePlanReviewFingerprint } from '../src/sequencePlan';
import { isSemanticSequencePlan, semanticSequenceSourceFingerprint } from '../src/semanticSequencePlan';
import { storyboardRequestApiIdentity, storyboardRequestSourceIdentity } from '../src/storyboardRequestIdentity';
import type { AppState, ReferenceAsset, Scene, VideoSegment, VideoSequencePlan } from '../src/types';

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
assert.ok(app && ts.isFunctionDeclaration(app) && app.body);
const appStatements = app.body.statements;
const declarations = (statements: ts.NodeArray<ts.Statement>, names: readonly string[]) => names.map((name) => {
  const statement = statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(statement, `production ${name}`); return statement.getText(ast);
}).join('\n');
const evaluate = (code: string, dependencies: Record<string, unknown>, result: string) => new Function('dependencies', `with (dependencies) {
  ${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText}
  return ${result};
}`)(dependencies);
const identityNames = ['storyboardGenerationIdentity', 'segmentStoryboardConfigurationIdentity'];
const sequenceStoryboardGenerationIdentity = evaluate(
  declarations(ast.statements, ['sequenceStoryboardGenerationIdentity']), {}, 'sequenceStoryboardGenerationIdentity',
);
const sequenceBatchPlanFingerprint = evaluate(
  declarations(ast.statements, ['sequenceBatchPlanFingerprint']), { sequencePlanReviewFingerprint }, 'sequenceBatchPlanFingerprint',
);
const identityCode = declarations(appStatements, identityNames);
const buildStatement = appStatements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === 'buildStoryboard'));
assert.ok(buildStatement && ts.isVariableStatement(buildStatement));
const build = buildStatement.declarationList.declarations[0].initializer;
assert.ok(build && ts.isArrowFunction(build) && ts.isBlock(build.body));
const guardCode = declarations(build.body.statements, [
  'fullTimeline', 'requestProjectId', 'requestEpoch', 'requestHandoff', 'requestBatchIdentity',
  'handoffSourceIsCurrent', 'requestMasterBoard', 'requestSequencePlan', 'requestSemanticFingerprint', 'requestReferenceIds',
  'currentRequestSourceIdentity', 'requestSourceIdentity', 'requestApiIdentity',
  'requestConfigurationIdentity', 'requestIdentity', 'buildOwner', 'isGenerationRequestCurrent',
]);
const fixture = (): AppState => {
  const state = createInitialState();
  const character = { ...state.project.characters[0], id: 'character-main', name: '小师妹', assetIds: ['ref-selected'] };
  const unrelatedCharacter = { ...character, id: 'character-unrelated', name: '远方陌生客', assetIds: [] };
  const scene: Scene = { id: 'scene-main', title: '练剑', content: '小师妹边格挡边说：“再练一次。”',
    summary: '交手', characterIds: [character.id], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 2 };
  const asset: ReferenceAsset = { id: 'ref-selected', name: '小师妹全身', type: 'character', role: 'character',
    sourceEntityId: character.id, sourceEntityKind: 'character', dataUrl: 'data:image/png;base64,AAAA',
    checksum: 'pixel-version-a', visualAnchor: '黑发青衣', tags: [], createdAt: 1, updatedAt: 2 };
  const implicit = { ...asset, id: 'ref-master-only', checksum: 'master-a' };
  return { ...state, project: { ...state.project, id: 'request-project',
    sourceDocuments: [{ id: 'source-main', name: '练剑', content: scene.content, createdAt: 1, updatedAt: 2 }],
    characters: [character, unrelatedCharacter], scenes: [scene], locations: [], props: [],
    assets: [asset, implicit], generationTasks: [], storyboards: [], sequencePlans: [],
  } };
};
const environment = (state = fixture()) => {
  const source = state.project.sourceDocuments[0];
  const bindings: Record<string, any> = {
    state, activeSequencePlan: undefined, storyInput: source.content, storyName: source.name,
    directorSourceScenes: state.project.scenes, directorScene: state.project.scenes[0],
    selectedAssetIds: ['ref-selected'], extraRequirement: '动作和对白同时进行',
    storyboardRequestSourceIdentity, storyboardRequestApiIdentity,
    isSemanticSequencePlan, semanticSequenceSourceFingerprint,
    activeStyle: state.stylePresets[0], activeRuleSet: state.ruleSets[0], activeConverter: state.converterPresets[0],
    directorWorkflow: 'drama', directorInputMode: 'reference', durationPreset: '15s', customDuration: 15,
    shotMode: 'auto', shotCount: 3, pace: 'tight', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    styleId: 'cinema', ruleSetId: 'rule', converterId: 'converter', directorStyleId: 'cinema',
    directorCategory: '剧情', directorStyleName: '自然', directorStyleSummary: '自然动作',
    cameraTerms: [], lightingTerms: [], visualStyle: '写实',
  };
  const identities = () => evaluate(identityCode, bindings, `({ ${identityNames.join(', ')} })`);
  return { bindings, identities };
};
const guardHarness = (segmented = false, batched = false) => {
  const env = environment(); const { bindings } = env;
  const stateRef = { current: bindings.state as AppState };
  const segment: VideoSegment = { id: 'segment-main', index: 1, title: '练剑第一段',
    globalStartSec: 0, globalEndSec: 15, durationSec: 15, content: bindings.storyInput,
    summary: '', sourceSceneIds: ['scene-main'], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', status: 'planned' };
  if (segmented) {
    stateRef.current = { ...stateRef.current, project: { ...stateRef.current.project,
      sequencePlans: [{ id: 'sequence-main', segments: [segment], masterStoryboardId: 'board-master' } as VideoSequencePlan],
      storyboards: [{ id: 'board-master', shots: [{ referenceAssetIds: ['ref-master-only'] }] } as any],
    } };
    bindings.state = stateRef.current;
    bindings.activeSequencePlan = stateRef.current.project.sequencePlans.find((plan) => plan.id === 'sequence-main');
  }
  const initial = env.identities();
  const workspaceEpochRef = { current: 1 };
  const storyDraftRef = { current: { storyInput: bindings.storyInput, storyName: bindings.storyName } };
  const storyboardGenerationIdentityRef = { current: initial.storyboardGenerationIdentity };
  const segmentStoryboardConfigurationIdentityRef = { current: initial.segmentStoryboardConfigurationIdentity };
  const sequenceBatchIdentityRef = { current: null as unknown };
  const sequenceBatchEpochRef = { current: 1 };
  const storyboardBuildLeaseRef = { current: undefined as { owner: number; projectId: string; epoch: number } | undefined };
  Object.assign(bindings, {
    stateRef, workspaceEpochRef, storyDraftRef,
    storyboardGenerationIdentityRef, segmentStoryboardConfigurationIdentityRef,
    sourceSceneIds: ['scene-main'], segmentForGeneration: segmented ? segment : undefined,
    override: segmented ? { sequencePlanId: 'sequence-main', segmentCount: 1 } : undefined,
    sequenceStoryboardGenerationIdentity, isCurrentOperationIdentity,
    buildSequencePromptHandoff, sequenceBatchPlanFingerprint, isCurrentSequenceOperation,
    sequenceBatchIdentityRef, sequenceBatchEpochRef, storyboardBuildLeaseRef,
    activePlanIdRef: { current: segmented ? 'sequence-main' : '' },
  });
  // Keep the production batch/lease guards active. Ordinary fixtures represent
  // a standalone request or the first segment, not an invented missing parent.
  const batchGuards = evaluate(declarations(appStatements, [
    'currentSequenceOperationIdentity', 'sequenceOperationIsCurrent',
  ]), bindings, '({ currentSequenceOperationIdentity, sequenceOperationIsCurrent })');
  bindings.sequenceOperationIsCurrent = batchGuards.sequenceOperationIsCurrent;
  if (batched) sequenceBatchIdentityRef.current = batchGuards.currentSequenceOperationIdentity('sequence-main');
  const guards = evaluate(guardCode, bindings,
    '({ isCurrent: isGenerationRequestCurrent, setBuildOwner: (owner) => { buildOwner = owner; } })') as {
      isCurrent: () => boolean; setBuildOwner: (owner: number) => void;
    };
  const { isCurrent } = guards;
  const render = () => {
    bindings.state = stateRef.current;
    bindings.activeSequencePlan = stateRef.current.project.sequencePlans.find((plan) => plan.id === bindings.activePlanIdRef.current);
    bindings.directorSourceScenes = stateRef.current.project.scenes;
    bindings.directorScene = stateRef.current.project.scenes[0];
    bindings.storyInput = storyDraftRef.current.storyInput; bindings.storyName = storyDraftRef.current.storyName;
    const next = env.identities();
    storyboardGenerationIdentityRef.current = next.storyboardGenerationIdentity;
    segmentStoryboardConfigurationIdentityRef.current = next.segmentStoryboardConfigurationIdentity;
  };
  return { ...env, stateRef, storyDraftRef, workspaceEpochRef, isCurrent, render,
    sequenceBatchIdentityRef, sequenceBatchEpochRef, storyboardBuildLeaseRef, setBuildOwner: guards.setBuildOwner };
};

test('actual single and sequence identity ignore task timestamps and unrelated media associations', () => {
  for (const segmented of [false, true]) {
    const qa = guardHarness(segmented); const initial = qa.identities();
    const project = qa.stateRef.current.project;
    qa.stateRef.current = { ...qa.stateRef.current, project: { ...project,
      updatedAt: project.updatedAt + 1000,
      generationTasks: [{ id: 'task-background', kind: 'image', status: 'succeeded', updatedAt: 500 } as any],
      characters: project.characters.map((character) => ({ ...character,
        assetIds: [...character.assetIds, 'generated-background'], updatedAt: 500,
      })),
      scenes: project.scenes.map((scene) => ({ ...scene, updatedAt: 500, storyboardIds: ['generated-board'] })),
      assets: [...project.assets.map((asset) => ({ ...asset, updatedAt: 500 })),
        { ...project.assets[0], id: 'generated-background', checksum: 'new-unselected-pixels' }],
    } };
    assert.equal(qa.isCurrent(), true, 'guard is safe even before rerender');
    qa.render(); assert.deepEqual(qa.identities(), initial);
    assert.equal(qa.isCurrent(), true, 'model results remain acceptable after real render identity refresh');
  }
});

test('unrelated character profiles do not invalidate a source that never mentions/references them', () => {
  const qa = guardHarness();
  qa.stateRef.current = { ...qa.stateRef.current, project: { ...qa.stateRef.current.project,
    characters: qa.stateRef.current.project.characters.map((character) => character.id === 'character-unrelated'
      ? { ...character, appearance: '仅别的剧情人物变化' } : character),
  } };
  qa.render(); assert.equal(qa.isCurrent(), true);
});

for (const segmented of [false, true]) {
  for (const mutation of ['story', 'name', 'source', 'scene', 'character', 'api-key', 'api-model'] as const) {
    test(`${segmented ? 'sequence' : 'single'} actual guard invalidates ${mutation} before a render`, () => {
      const qa = guardHarness(segmented); const current = qa.stateRef.current;
      const project = { ...current.project };
      let settings = current.settings;
      switch (mutation) {
        case 'story': qa.storyDraftRef.current.storyInput += '新增剧情'; break;
        case 'name': qa.storyDraftRef.current.storyName += '新标题'; break;
        case 'source': project.sourceDocuments = project.sourceDocuments.map((item) => ({ ...item, content: '已提交新原文' })); break;
        case 'scene': project.scenes = project.scenes.map((item) => ({ ...item, content: '场景正文改变' })); break;
        case 'character': project.characters = project.characters.map((item) => item.id === 'character-main' ? { ...item, outfit: '新衣服' } : item); break;
        case 'api-key': settings = { ...settings, textApi: { ...settings.textApi, apiKey: 'different-secret-do-not-log' } }; break;
        case 'api-model': settings = { ...settings, textApi: { ...settings.textApi, model: 'different-model' } }; break;
      }
      qa.stateRef.current = { ...current, project, settings };
      assert.equal(qa.isCurrent(), false);
      qa.render(); assert.equal(qa.isCurrent(), false);
    });
  }
  for (const mutation of ['pixels', 'checksum', 'anchor', 'missing', 'mode', 'selection'] as const) {
    test(`${segmented ? 'sequence' : 'single'} actual request ignores retired hidden image ${mutation} before and after render`, () => {
      const qa = guardHarness(segmented);
      const initial = qa.identities();
      const current = qa.stateRef.current;
      const project = { ...current.project };
      switch (mutation) {
        case 'pixels': project.assets = project.assets.map((item) => item.id === 'ref-selected' ? { ...item, dataUrl: 'data:image/png;base64,BBBB' } : item); break;
        case 'checksum': project.assets = project.assets.map((item) => item.id === 'ref-selected' ? { ...item, checksum: 'changed-hidden-pixels' } : item); break;
        case 'anchor': project.assets = project.assets.map((item) => item.id === 'ref-selected' ? { ...item, visualAnchor: '换了一张脸' } : item); break;
        case 'missing': project.assets = project.assets.filter((item) => item.id !== 'ref-selected'); break;
        case 'mode': qa.bindings.directorInputMode = 'text_reference'; break;
        case 'selection': qa.bindings.selectedAssetIds = ['ref-master-only']; break;
      }
      qa.stateRef.current = { ...current, project };
      assert.equal(qa.isCurrent(), true, 'retired inputs are not part of the live request');
      qa.render();
      assert.deepEqual(qa.identities(), initial, 'the React render identity ignores retired inputs too');
      assert.equal(qa.isCurrent(), true, 'a render must not cancel a request through hidden legacy state');
    });
  }
}

for (const mutation of ['pixels', 'checksum', 'anchor', 'missing'] as const) {
  test(`sequence still guards effective historical master-shot reference ${mutation} before and after render`, () => {
    const qa = guardHarness(true);
    const current = qa.stateRef.current;
    const project = { ...current.project };
    switch (mutation) {
      case 'pixels': project.assets = project.assets.map((asset) => asset.id === 'ref-master-only' ? { ...asset, dataUrl: 'data:image/png;base64,BBBB' } : asset); break;
      case 'checksum': project.assets = project.assets.map((asset) => asset.id === 'ref-master-only' ? { ...asset, checksum: 'master-new' } : asset); break;
      case 'anchor': project.assets = project.assets.map((asset) => asset.id === 'ref-master-only' ? { ...asset, visualAnchor: '历史主提示词的参考锚点发生变化' } : asset); break;
      case 'missing': project.assets = project.assets.filter((asset) => asset.id !== 'ref-master-only'); break;
    }
    qa.stateRef.current = { ...current, project };
    assert.equal(qa.isCurrent(), false, 'effective master-shot refs remain guarded independently from hidden UI selections');
    qa.render();
    assert.equal(qa.isCurrent(), false);
  });
}

test('effective director fields still invalidate actual render identity', () => {
  for (const [field, value] of [
    ['pace', 'slow'], ['extraRequirement', '改为悲伤的对白停顿'],
    ['directorStyleSummary', '新导演要求'], ['cameraTerms', ['手持']],
  ] as const) {
    for (const segmented of [false, true]) {
      const qa = guardHarness(segmented); qa.bindings[field] = value; qa.render();
      assert.equal(qa.isCurrent(), false, field);
    }
  }
});

test('credentials are sensitive to change but absent from serialized identity output', () => {
  const config = { apiKey: 'unique-private-fixture-key', model: 'sample' };
  const identity = storyboardRequestApiIdentity(config);
  assert.equal(identity.includes(config.apiKey), false);
  assert.notEqual(storyboardRequestApiIdentity({ ...config, apiKey: 'changed-private-fixture-key' }), identity);
});

test('workspace epoch rejects A -> B -> A even when creative inputs match again', () => {
  const qa = guardHarness(); qa.workspaceEpochRef.current += 2;
  assert.equal(qa.isCurrent(), false);
});

test('sequence status and scene linkage writes cannot cancel the next segment', () => {
  const qa = guardHarness(true); const project = qa.stateRef.current.project;
  qa.stateRef.current = { ...qa.stateRef.current, project: { ...project,
    sequencePlans: project.sequencePlans.map((plan) => ({ ...plan, updatedAt: 900,
      segments: plan.segments.map((segment) => ({ ...segment, status: 'generating', failureReason: undefined })),
    })),
  } };
  qa.render(); assert.equal(qa.isCurrent(), true);
});

test('commit reducer repeats live request guard before writing a finished board', () => {
  const text = build.body.getText(ast);
  assert.match(text, /let commitAccepted = false;\s*setState\(\(current\) => \{\s*if \(!isGenerationRequestCurrent\(\)\) return current;/u);
});

test('actual request guard rejects a cancelled or replaced batch before the next render', () => {
  for (const mutation of ['cancel', 'replace', 'epoch'] as const) {
    const qa = guardHarness(true, true);
    assert.equal(qa.isCurrent(), true);
    if (mutation === 'cancel') qa.sequenceBatchIdentityRef.current = null;
    if (mutation === 'replace') qa.sequenceBatchIdentityRef.current = { ...(qa.sequenceBatchIdentityRef.current as object) };
    if (mutation === 'epoch') qa.sequenceBatchEpochRef.current += 1;
    assert.equal(qa.isCurrent(), false, mutation);
  }
});

test('actual request guard accepts only its own live storyboard build lease', () => {
  const qa = guardHarness(true);
  qa.setBuildOwner(1);
  qa.storyboardBuildLeaseRef.current = { owner: 1, projectId: qa.stateRef.current.project.id, epoch: 1 };
  assert.equal(qa.isCurrent(), true);
  qa.storyboardBuildLeaseRef.current = { ...qa.storyboardBuildLeaseRef.current, owner: 2 };
  assert.equal(qa.isCurrent(), false);
  qa.storyboardBuildLeaseRef.current = undefined;
  assert.equal(qa.isCurrent(), false, 'a released old operation cannot write late output');
});
