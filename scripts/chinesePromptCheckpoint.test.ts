import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } from '../src/officialPrompt';
import * as effects from '../src/appEffects';
import { createInitialState } from '../src/storage';
import { linkSegmentStoryboard } from '../src/sequencePlan';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AppState, Storyboard, VideoSequencePlan } from '../src/types';

const action = '抬手指向地图→放下手';
const canonical = `【0s-5s】主体：@旅人甲（专注）[朝向：地图] 正在 [${action}]；空间：大厅；光影：自然光；镜头：固定中景；台词：无；音效：无`;
const context = { assets: [], characters: [] };
const draft: Storyboard = {
  id: 'board-1', sceneId: 'scene-1', sequencePlanId: 'plan-1', segmentId: 'segment-1', segmentIndex: 1, segmentCount: 1,
  sourceStoryContent: '旅人甲在大厅查看地图。', workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s',
  shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: canonical,
  shots: [{ id: 'shot-1', index: 1, startSec: 0, endSec: 5, subject: '旅人甲', action, purpose: '看地图',
    camera: '固定中景', transition: '自然结束', lighting: '自然光', sound: '无', result: '手已放下', referenceAssetIds: [], locked: false, prompt: canonical }],
  promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical),
    generatedAt: 1, modelRuleSetId: '', converterPresetId: '', sourceDocumentIds: [], referenceAssetIds: [] },
  createdAt: 1, updatedAt: 1,
};
const source = applyOfficialH3Prompt(draft, context);
source.officialPromptEn = 'OLD_ENGLISH'; source.officialPromptEnSource = 'OLD_CHINESE'; source.englishPrompt = 'OLD_ENGLISH';
const sourceBefore = JSON.stringify(source);
const chinese = source.officialPromptZh!;
const english = 'integrated_multimodal_description: [Shot 1] The traveler points at the map and lowers his hand.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
let checkpoint: Storyboard | undefined;
const stages: string[] = [];
const partial = await generateSingleSegmentPrompt({ board: source, context, purpose: 'dialogue-repair', clean: (text) => text,
  onQualifiedChinese: async (board) => {
    stages.push('checkpoint'); checkpoint = structuredClone(board);
    assert.ok(hasCurrentOfficialH3Prompt(board, context));
    assert.equal(board.officialPromptEn, ''); assert.equal(board.englishPrompt, '');
    assert.equal(board.officialPromptEnSource, ''); assert.equal(board.h3IdentityBindingsEn, undefined);
  },
  request: async (_system, _user, stage) => {
    stages.push(stage);
    if (stage === 'review') return JSON.stringify({ canonicalPrompt: canonical, h3Prompt: chinese, shotSourceIds: [['shot-1']] });
    assert.ok(checkpoint, 'qualified Chinese is checkpointed before the first English request');
    throw new Error('QA English transport unavailable');
  },
});
assert.equal(stages[0], 'review'); assert.deepEqual(stages.slice(1), ['checkpoint', 'translate']);
assert.ok(hasCurrentOfficialH3Prompt(partial, context)); assert.equal(partial.officialPromptZh, chinese);
assert.match(partial.officialPromptEnError!, /QA English/u);
assert.equal(partial.officialPromptEn, ''); assert.equal(partial.officialPromptEnSource, '');
assert.equal(JSON.stringify(source), sourceBefore, 'old input is never mutated');
let englishCalls = 0;
const retried = await generateSingleSegmentPrompt({ board: partial, context, mode: 'translate-english', reviewWithAi: true,
  clean: (text) => text, onQualifiedChinese: () => assert.fail('English-only retry must not re-save or regenerate Chinese'),
  request: async (_system, _user, stage) => { assert.equal(stage, 'translate'); englishCalls++; return english; },
});
assert.equal(englishCalls, 2); assert.ok(hasCurrentOfficialH3EnglishPrompt(retried, context));
assert.equal(retried.officialPromptZh, partial.officialPromptZh); assert.deepEqual(retried.shots, partial.shots);
assert.equal(retried.officialPromptEnSource, partial.officialPromptZh);
let current = true; let translations = 0;
await assert.rejects(() => generateSingleSegmentPrompt({ board: source, context, purpose: 'dialogue-repair', clean: (text) => text,
  isCurrent: () => current, onQualifiedChinese: () => { current = false; },
  request: async (_system, _user, stage) => {
    if (stage === 'review') return JSON.stringify({ canonicalPrompt: canonical, h3Prompt: chinese, shotSourceIds: [['shot-1']] });
    translations++; return english;
  },
}), { name: 'AbortError' });
assert.equal(translations, 0, 'project switch at the checkpoint prevents starting an unrelated English request');

// Execute production App checkpoint/commit closures, not copies of reducers.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration>();
let callback: ts.Expression | undefined;
const walk = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onQualifiedChinese') callback = node.initializer;
  ts.forEachChild(node, walk);
};
walk(ast);
assert.ok(callback);
const productionCode = ['sequenceStoryboardGenerationIdentity', 'commitQualifiedBoard'].map((name) => {
  const node = declarations.get(name); assert.ok(node); return `const ${node.getText(ast)};`;
}).join('\n');
const compiled = ts.transpileModule(`let chineseCheckpoint; ${productionCode}\nconst checkpoint = ${callback.getText(ast)};
return { checkpoint, commit: commitQualifiedBoard };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const fixture = (hasExistingBoard = true) => {
  let state = createInitialState(); let isCurrent = true; let selected = ''; let writes = 0;
  const plan: VideoSequencePlan = { id: 'plan-1', title: '查看地图', sourceStoryTitle: '查看地图', sourceStoryContent: draft.sourceStoryContent!,
    durationMode: 'fixed', requestedTotalDurationSec: 5, totalDurationSec: 5, segmentDurationSec: 5, fitStatus: 'balanced',
    segmentationMode: 'fixed', createdAt: 1, updatedAt: 1, segments: [{ id: 'segment-1', index: 1, title: '查看地图', durationSec: 5,
      globalStartSec: 0, globalEndSec: 5, content: draft.sourceStoryContent!, summary: '查看地图', sourceSceneIds: ['scene-1'],
      sourceBeatIds: ['beat-1'], narrativePurpose: '查看地图', entryState: '', exitState: '', transitionHint: '', continuityPack: '',
      storyboardId: hasExistingBoard ? source.id : undefined, status: 'generating', locked: false }] };
  const segment = plan.segments[0];
  state.project = { ...state.project, id: 'project-1', storyboards: hasExistingBoard ? [structuredClone(source)] : [], sequencePlans: [plan],
    scenes: [{ id: 'scene-1', title: '大厅', content: draft.sourceStoryContent!, summary: '', characterIds: [], locationIds: [], propIds: [],
      storyboardIds: hasExistingBoard ? [source.id] : [], createdAt: 1, updatedAt: 1 }] };
  const stateRef = { current: state }; const notices: string[] = [];
  const deps: Record<string, unknown> = { ...effects, sourceContentHash, linkSegmentStoryboard, runtimeFailureStage: '',
    setState: (update: (value: AppState) => AppState) => { state = update(state); stateRef.current = state; },
    stateRef, isGenerationRequestCurrent: () => isCurrent, requestProjectId: state.project.id,
    segmentForGeneration: segment, override: { sequencePlanId: plan.id }, fullTimeline: false,
    requestConfigurationIdentity: 'config', segmentStoryboardConfigurationIdentityRef: { current: 'config' },
    canonicalMasterSlice: undefined, existingSegmentBoardId: hasExistingBoard ? source.id : undefined,
    requestExistingSegmentBoardSnapshot: JSON.stringify(state.project.storyboards[0]), sourceSceneIds: ['scene-1'], t: 2,
    setActiveStoryboardId: (id: string) => { selected = id; },
    saveStateAsync: async (value: AppState) => { writes++; assert.equal(value.project.storyboards[0].officialPromptEn, ''); },
    notify: (message: string) => notices.push(message),
  };
  const identityNode = declarations.get('sequenceStoryboardGenerationIdentity')!;
  const identityCode = ts.transpileModule(`const ${identityNode.getText(ast)}; return sequenceStoryboardGenerationIdentity;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  deps.requestIdentity = new Function('d', `with(d){${identityCode}}`)(deps)(state.project.id, plan.id, segment, 1);
  const app = new Function('d', `with(d){${compiled}}`)(deps) as { checkpoint: (board: Storyboard) => Promise<void>; commit: (board: Storyboard) => boolean };
  return { app, stateRef, notices, stop: () => { isCurrent = false; }, get selected() { return selected; }, get writes() { return writes; } };
};
{
  const h = fixture(); await h.app.checkpoint(structuredClone(checkpoint!));
  assert.equal(h.writes, 1); assert.equal(h.selected, source.id);
  assert.equal(h.stateRef.current.project.storyboards[0].officialPromptZh, chinese);
  assert.equal(h.stateRef.current.project.sequencePlans[0].segments[0].status, 'ready');
  assert.equal(effects.resolveSequenceSegmentPromptAction(h.stateRef.current.project.sequencePlans[0].segments[0], h.stateRef.current.project.storyboards, 'plan-1', context).action, 'translate-english');
  assert.ok(h.app.commit(partial));
}
for (const mutation of ['user-edit', 'project-change', 'cancel'] as const) {
  const h = fixture(); await h.app.checkpoint(structuredClone(checkpoint!));
  if (mutation === 'user-edit') h.stateRef.current.project.storyboards[0].shots[0].action = '用户新的动作';
  if (mutation === 'project-change') h.stateRef.current.project.id = 'project-2';
  if (mutation === 'cancel') h.stop();
  const before = JSON.stringify(h.stateRef.current);
  assert.equal(h.app.commit(retried), false, `${mutation} must reject a late English commit`);
  assert.equal(JSON.stringify(h.stateRef.current), before);
}
{
  const h = fixture(); h.stop();
  await assert.rejects(() => h.app.checkpoint(checkpoint!), { name: 'AbortError' }); assert.equal(h.writes, 0);
}
for (const mutation of ['user-edit', 'delete', 'replace-same-id', 'replace-new-id'] as const) {
  const h = fixture();
  if (mutation === 'user-edit') h.stateRef.current.project.storyboards[0].shots[0].action = '用户改为合上地图';
  if (mutation === 'delete') h.stateRef.current.project.storyboards = [];
  if (mutation === 'replace-same-id' || mutation === 'replace-new-id') {
    const replacement = structuredClone(source);
    replacement.id = mutation === 'replace-new-id' ? 'replacement-board' : source.id;
    replacement.shots[0].action = '用户替换为收起地图';
    h.stateRef.current.project.storyboards = [replacement];
  }
  const before = JSON.stringify(h.stateRef.current);
  await assert.rejects(() => h.app.checkpoint(structuredClone(checkpoint!)), { name: 'AbortError' },
    `${mutation} before qualified Chinese returns must reject the first checkpoint`);
  assert.equal(h.writes, 0, `${mutation} must not persist a rejected Chinese result`);
  assert.equal(h.selected, '', `${mutation} must not select the rejected result`);
  assert.deepEqual(h.notices, [], `${mutation} must not report a successful save`);
  assert.equal(JSON.stringify(h.stateRef.current), before, `${mutation} must preserve the user's latest state`);
}
{
  const h = fixture(false);
  const added = structuredClone(source);
  added.id = 'user-added-board'; added.shots[0].action = '用户新增查看门口的镜头';
  h.stateRef.current.project.storyboards = [added];
  const before = JSON.stringify(h.stateRef.current);
  await assert.rejects(() => h.app.checkpoint(structuredClone(checkpoint!)), { name: 'AbortError' });
  assert.equal(h.writes, 0, 'a board added after a request began must not be overwritten or saved over');
  assert.equal(h.selected, ''); assert.deepEqual(h.notices, []);
  assert.equal(JSON.stringify(h.stateRef.current), before, 'the newly added board and its segment state remain unchanged');
}
{
  const h = fixture(false); await h.app.checkpoint(structuredClone(checkpoint!));
  assert.equal(h.writes, 1, 'first-generation Chinese is still saved when no board existed and none was added');
  assert.equal(h.stateRef.current.project.storyboards.length, 1);
  assert.equal(h.stateRef.current.project.storyboards[0].officialPromptZh, chinese);
  assert.ok(h.app.commit(retried), 'the bilingual completion may replace its own newly created checkpoint');
}
console.log('Qualified Chinese checkpoint: pipeline + production App persistence/stale-write/English-only retry checks passed');
