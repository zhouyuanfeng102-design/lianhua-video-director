import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as appEffects from '../src/appEffects';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { normalizeDirectorLookDraft, type DirectorLookDraft } from '../src/directorLookDraft';
import { normalizeGridDirectorInputMode } from '../src/gridDirectorWorkflow';
import { activeDirectorWorkflow } from '../src/gridRetirement';
import { formatDirectorStyleSummary, resolveDirectorStylePreset } from '../src/directorStyles';
import type { AppState, Project, Storyboard } from '../src/types';

// Execute the actual App transactions, not a second hand-written version of
// their behavior. All state is synthetic and in memory: no React mount, real
// storage, desktop bridge or model/video/image endpoint is involved.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [
  'withProjectLibrary', 'parseDirectorSettingsFingerprint',
  'commitState', 'updateDirectorLookDraft', 'syncWorkspaceUiState', 'restoreSequenceDirectorSettings',
] as const;
const declarations = new Map<string, ts.VariableDeclaration>();
const identifiers = new Set<string>();
const collectNames = (node: ts.Node): void => {
  if (ts.isIdentifier(node)) identifiers.add(node.text);
  ts.forEachChild(node, collectNames);
};
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && names.some((name) => name === node.name.getText(ast))) {
    assert.ok(!declarations.has(node.name.text), `the production action ${node.name.text} is unambiguous`);
    declarations.set(node.name.text, node); collectNames(node);
  }
  ts.forEachChild(node, visit);
};
visit(ast);
const compiled = ts.transpileModule(names.map((name) => {
  const declaration = declarations.get(name); assert.ok(declaration, `production ${name} is tested`);
  return `const ${declaration.getText(ast)};`;
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const fields = ['directorStyleId', 'directorCategory', 'directorStyleName', 'directorStyleSummary', 'visualStyle', 'styleId'] as const;
const lookA: DirectorLookDraft = {
  directorStyleId: 'custom_director_fixture_a', directorCategory: '最终幻想CG',
  directorStyleName: '最终幻想7克制调度', directorStyleSummary: '角色的自然动作与空间关系优先。',
  visualStyle: '最终幻想7重制版', styleId: 'style_cinema',
};
const lookB: DirectorLookDraft = {
  directorStyleId: 'custom_director_fixture_b', directorCategory: '淡彩水墨',
  directorStyleName: '项目B留白长镜头', directorStyleSummary: '随角色缓慢进入画面。',
  visualStyle: '柔和手绘水墨', styleId: 'style_anime',
};
const fingerprint = (look: DirectorLookDraft, extras: { shotCount?: number } = {}) => JSON.stringify([
  'drama', 'text', 'auto', extras.shotCount || 3, 'standard', '16:9', '2K', 'stereo', look.styleId,
  'timeline_director_cn', 'converter_unified_video', look.directorStyleId,
  [], [], look.visualStyle, '', [], true, 'openai_compatible', 'https://synthetic.invalid/v1', 'mock', 0.7, 8192, false,
  look.directorCategory, look.directorStyleName, look.directorStyleSummary,
]);
const fixture = () => {
  const initial = createInitialState();
  const makeProject = (id: string): Project => ({
    ...initial.project, id, name: `导演草稿隔离测试 ${id}`, sourceDocuments: [],
    characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
  });
  const a = makeProject('look-draft-test-a'); const b = makeProject('look-draft-test-b');
  delete a.directorSettingsConfirmedFingerprint; delete a.directorSettingsConfirmedAt;
  delete a.directorLookDraft; delete b.directorLookDraft;
  const state = { ...initial, project: a, projects: [a, b], activeProjectId: a.id };
  return { state, a, b };
};
type ActionSet = {
  withProjectLibrary: (state: AppState, previous?: AppState) => AppState;
  commitState: (update: AppState | ((current: AppState) => AppState), recordHistory: boolean) => void;
  updateDirectorLookDraft: (patch: Partial<DirectorLookDraft>) => void;
  syncWorkspaceUiState: (state: AppState) => void;
  restoreSequenceDirectorSettings: (fingerprint?: string) => void;
};
const probe = (initial: AppState) => {
  const stateRef = { current: initial }; const workspaceEpochRef = { current: 0 };
  const undoStack = { current: [] as AppState[] }; const redoStack = { current: [] as AppState[] };
  const ui: Record<string, unknown> = { ...appEffects.deriveWorkspaceUiState(initial) };
  let backgroundWrites = 0; let actions: ActionSet;
  const render = (): ActionSet => {
    const dependencies: Record<string, unknown> = { ...appEffects };
    for (const identifier of identifiers) {
      if (/^set[A-Z]/u.test(identifier)) {
        const key = (identifier[3].toLowerCase() + identifier.slice(4)).replace(/Internal$/u, '');
        dependencies[identifier] = (value: unknown) => {
          ui[key] = typeof value === 'function' ? (value as (current: unknown) => unknown)(ui[key]) : value;
        };
      } else if (identifier.endsWith('Ref')) {
        dependencies[identifier] = { current: /(?:Epoch|Operation|Owner)Ref$/u.test(identifier) ? 0 : null };
      }
    }
    Object.assign(dependencies, {
      ...ui, state: stateRef.current, stateRef, workspaceEpochRef, undoStack, redoStack,
      directorLookDraftEpoch: workspaceEpochRef.current,
      activeSequencePlan: undefined, activeDirectorWorkflow, normalizeGridDirectorInputMode,
      normalizeDirectorLookDraft, resolveDirectorStylePreset, formatDirectorStyleSummary,
      createEmptyAssetForm: () => ({}), useCallback: (callback: unknown) => callback,
      setBackgroundState: (update: AppState | ((current: AppState) => AppState)) => {
        const previous = stateRef.current;
        actions.commitState(update, false);
        if (stateRef.current !== previous) backgroundWrites += 1;
      },
    });
    actions = new Function('dependencies', `with (dependencies) {
      ${compiled}
      return { ${names.filter((name) => name !== 'parseDirectorSettingsFingerprint').join(', ')} };
    }`)(dependencies) as ActionSet;
    return actions;
  };
  render();
  return {
    stateRef, workspaceEpochRef, undoStack, redoStack, ui, render,
    get actions() { return actions; },
    get writes() { return backgroundWrites; },
    look: () => Object.fromEntries(fields.map((field) => [field, ui[field]])) as unknown as DirectorLookDraft,
    switchState: (next: AppState) => { stateRef.current = next; actions.syncWorkspaceUiState(next); render(); },
  };
};

test('manual and AI patch transaction saves all six fields without confirming or generating', () => {
  const { state, b } = fixture(); const current = probe(state);
  const before = JSON.stringify({ boards: state.project.storyboards, plans: state.project.sequencePlans, b });
  current.actions.updateDirectorLookDraft(lookA);
  assert.equal(current.writes, 1, 'a complete AI result is one atomic project write');
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, lookA);
  assert.deepEqual(current.look(), lookA);
  assert.equal(current.stateRef.current.project.directorSettingsConfirmedFingerprint, undefined);
  assert.equal(JSON.stringify({ boards: current.stateRef.current.project.storyboards, plans: current.stateRef.current.project.sequencePlans,
    b: current.stateRef.current.projects.find((project) => project.id === b.id) }), before);
  assert.deepEqual(current.stateRef.current.projects.find((project) => project.id === state.project.id)?.directorLookDraft, lookA);
});

test('several input events in one render merge through the current project draft', () => {
  const { state } = fixture(); const current = probe(state);
  current.actions.updateDirectorLookDraft({ directorCategory: lookA.directorCategory });
  current.actions.updateDirectorLookDraft({ directorStyleId: lookA.directorStyleId, directorStyleName: lookA.directorStyleName,
    directorStyleSummary: lookA.directorStyleSummary });
  current.actions.updateDirectorLookDraft({ visualStyle: lookA.visualStyle, styleId: lookA.styleId });
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, lookA);
  assert.deepEqual(current.look(), lookA, 'later patches never revive render-captured defaults');
  assert.equal(current.writes, 3);
});

test('unconfirmed draft survives actual serialize/normalize and workspace restoration', () => {
  const { state } = fixture(); const current = probe(state);
  current.actions.updateDirectorLookDraft(lookA);
  const restored = normalizeState(JSON.parse(serializeStateForStorage(current.stateRef.current).serialized));
  current.switchState(restored);
  assert.deepEqual(current.look(), lookA);
  assert.deepEqual(appEffects.deriveWorkspaceUiState(restored).directorStyleName, lookA.directorStyleName);
  assert.equal(current.stateRef.current.project.directorSettingsConfirmedFingerprint, undefined);
});

test('project switches keep each draft and do not inherit the previous project values', () => {
  const { state, b } = fixture(); const current = probe(state);
  current.actions.updateDirectorLookDraft(lookA);
  let source = current.stateRef.current;
  current.switchState({ ...source, project: b, activeProjectId: b.id });
  assert.notDeepEqual(current.look(), lookA);
  current.actions.updateDirectorLookDraft(lookB);
  source = current.stateRef.current;
  const savedA = source.projects.find((project) => project.id === state.project.id)!;
  current.switchState({ ...source, project: savedA, activeProjectId: savedA.id });
  assert.deepEqual(current.look(), lookA);
  source = current.stateRef.current;
  const savedB = source.projects.find((project) => project.id === b.id)!;
  current.switchState({ ...source, project: savedB, activeProjectId: savedB.id });
  assert.deepEqual(current.look(), lookB);
});

test('explicitly empty fields survive save and restore instead of activating presets', () => {
  const { state } = fixture(); const current = probe(state);
  const empty = Object.fromEntries(fields.map((field) => [field, ''])) as unknown as DirectorLookDraft;
  current.actions.updateDirectorLookDraft(empty);
  current.switchState(normalizeState(JSON.parse(serializeStateForStorage(current.stateRef.current).serialized)));
  assert.deepEqual(current.look(), empty);
});

test('returning to whole-film planning preserves edited look but restores unrelated timing', () => {
  const { state } = fixture(); state.project.directorSettingsConfirmedFingerprint = fingerprint(lookB, { shotCount: 8 });
  state.project.directorSettingsConfirmedAt = 12;
  const current = probe(state); current.actions.updateDirectorLookDraft(lookA);
  const before = JSON.stringify(current.stateRef.current);
  current.render().restoreSequenceDirectorSettings();
  assert.deepEqual(current.look(), lookA, 'old confirmed look must not overwrite the current authored draft');
  assert.equal(current.ui.shotCount, 8, 'the fix must not remove legitimate whole-film timing restoration');
  assert.equal(JSON.stringify(current.stateRef.current), before, 'navigation never rewrites confirmed snapshots or H3 output');
});

test('explicit historical-plan snapshot cannot replace a current project look draft', () => {
  const { state } = fixture(); const current = probe(state);
  current.actions.updateDirectorLookDraft(lookA);
  current.render().restoreSequenceDirectorSettings(fingerprint(lookB, { shotCount: 6 }));
  assert.deepEqual(current.look(), lookA);
  assert.equal(current.ui.shotCount, 6);
});

test('legacy complete confirmed snapshot remains the fallback when no editor draft exists', () => {
  const { state } = fixture(); const current = probe(state);
  current.actions.restoreSequenceDirectorSettings(fingerprint(lookB));
  assert.deepEqual(current.look(), lookB);
  assert.equal(current.stateRef.current.project.directorLookDraft, undefined, 'viewing legacy state does not manufacture an edited draft');
});

test('legacy storyboard custom names and summaries restore without built-in preset substitution', () => {
  const { state } = fixture();
  state.project.storyboards = [{
    id: 'legacy-custom-look-board', sceneId: '', workflow: 'drama', inputMode: 'text', durationPreset: '15s', durationSec: 15,
    shotMode: 'auto', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: lookA.styleId, ruleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video',
    directorStyleId: lookA.directorStyleId, directorStyleName: lookA.directorStyleName, directorStyleSummary: lookA.directorStyleSummary,
    visualStyle: lookA.visualStyle, globalLock: '', globalReferenceAssetIds: [], shots: [], finalPrompt: 'untouched-legacy-H3', createdAt: 1, updatedAt: 1,
  } satisfies Storyboard];
  const current = probe(state); current.actions.syncWorkspaceUiState(state);
  assert.equal(current.ui.directorStyleId, lookA.directorStyleId);
  assert.equal(current.ui.directorStyleName, lookA.directorStyleName);
  assert.equal(current.ui.directorStyleSummary, lookA.directorStyleSummary);
  assert.equal(current.ui.visualStyle, lookA.visualStyle);
  assert.equal(state.project.storyboards[0].finalPrompt, 'untouched-legacy-H3');
});

test('a callback captured before switching projects cannot apply an old AI patch', () => {
  const { state, b } = fixture(); const current = probe(state); const oldAction = current.actions.updateDirectorLookDraft;
  current.switchState({ ...state, project: b, activeProjectId: b.id });
  const before = JSON.stringify(current.stateRef.current); const beforeLook = current.look();
  oldAction(lookA);
  assert.equal(JSON.stringify(current.stateRef.current), before);
  assert.deepEqual(current.look(), beforeLook);
  assert.equal(current.writes, 0);
});

test('A-to-B-to-A invalidates an old callback even though its project id matches again', () => {
  const { state, b } = fixture(); const current = probe(state); const oldAction = current.actions.updateDirectorLookDraft;
  current.switchState({ ...state, project: b, activeProjectId: b.id });
  current.switchState(state);
  const before = JSON.stringify(current.stateRef.current); oldAction(lookA);
  assert.equal(JSON.stringify(current.stateRef.current), before);
  assert.equal(current.writes, 0);
  current.actions.updateDirectorLookDraft(lookB);
  assert.deepEqual(current.look(), lookB, 'a fresh render owns a valid new edit');
});

test('AI fill uses the same single atomic draft transaction instead of several independent setters', () => {
  const action = source.slice(source.indexOf('const analyzeDirectorLookSettings ='), source.indexOf('const toggleTerm =', source.indexOf('const analyzeDirectorLookSettings =')));
  assert.equal((action.match(/updateDirectorLookDraft\(/gu) || []).length, 1);
  assert.doesNotMatch(action, /setDirectorCategory\(|setDirectorStyleName\(|setDirectorStyleSummary\(|setVisualStyle\(/u);
  assert.match(action, /if \(!isCurrent\(\)\) return/u, 'late AI results must stay rejected before persistence');
});

test('background draft persistence survives unrelated undo/redo without writing the wrong active project', () => {
  const { state, b } = fixture(); const current = probe(state);
  const olderA = structuredClone(state);
  const oldB = structuredClone({ ...state, project: b, activeProjectId: b.id });
  current.undoStack.current = [olderA, oldB]; current.redoStack.current = [structuredClone(state)];
  current.actions.updateDirectorLookDraft(lookA);
  assert.equal(current.undoStack.current.length, 2, 'typing is a background preference, not a new history record');
  assert.equal(current.redoStack.current.length, 1, 'typing does not discard unrelated redo history');
  const archivedA = current.undoStack.current[1].projects.find((project) => project.id === state.project.id)!;
  assert.deepEqual(archivedA.directorLookDraft, lookA);
  assert.equal(current.undoStack.current[1].project.id, b.id);
  assert.equal(current.undoStack.current[1].project.directorLookDraft, undefined);
  assert.deepEqual(current.undoStack.current[0].project.directorLookDraft, lookA);
  assert.deepEqual(current.redoStack.current[0].project.directorLookDraft, lookA);
  assert.equal(olderA.project.directorLookDraft, undefined, 'original history values remain immutable');
  assert.equal(oldB.projects.find((project) => project.id === state.project.id)!.directorLookDraft, undefined);
  current.switchState(current.undoStack.current[0]);
  assert.deepEqual(current.look(), lookA);
});
