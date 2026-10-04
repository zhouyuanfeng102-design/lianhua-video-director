import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {
  commitStateTransition,
  deriveWorkspaceUiState,
  isCurrentProjectOperation,
  replaceProjectSourceDocument,
  resolveWorkspaceDirectorLook,
  takeHistoryStep,
} from '../src/appEffects';
import { normalizeDirectorLookDraft, type DirectorLookDraft } from '../src/directorLookDraft';
import { createInitialState } from '../src/storage';
import { normalizeGridDirectorInputMode } from '../src/gridDirectorWorkflow';
import { activeDirectorWorkflow } from '../src/gridRetirement';
import type { AppState, Project } from '../src/types';

// Run the production UI transactions without mounting React, accessing user
// storage, or sending model requests. AST boundaries work with both LF/CRLF.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarationNames = [
  'withProjectLibrary', 'syncWorkspaceUiState', 'undo', 'redo',
  'persistPrimarySourceDocument', 'handleSaveStory', 'updateDirectorLookDraft',
] as const;
const declarations = new Map<string, ts.VariableDeclaration>();
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && declarationNames.some((name) => name === node.name.getText(appAst))) {
    assert.equal(declarations.has(node.name.text), false, `ambiguous production declaration: ${node.name.text}`);
    declarations.set(node.name.text, node);
  }
  ts.forEachChild(node, visit);
};
visit(appAst);
for (const name of declarationNames) {
  assert.ok(declarations.has(name), `the production ${name} transaction must remain covered`);
}
const transactionSource = ts.transpileModule(
  declarationNames.map((name) => `const ${declarations.get(name)!.getText(appAst)};`).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const identifiers = new Set<string>();
const collectIdentifiers = (node: ts.Node): void => {
  if (ts.isIdentifier(node)) identifiers.add(node.text);
  ts.forEachChild(node, collectIdentifiers);
};
for (const declaration of declarations.values()) collectIdentifiers(declaration);

type Draft = { storyInput: string; storyName: string };
type SourceResolver = (text: string, action: string) => Promise<string | undefined>;
type Transactions = {
  withProjectLibrary: (next: AppState, previous?: AppState) => AppState;
  syncWorkspaceUiState: (state: AppState) => void;
  undo: () => void;
  redo: () => void;
  handleSaveStory: () => Promise<void>;
  updateDirectorLookDraft: (patch: Partial<DirectorLookDraft>) => void;
};

const fixture = () => {
  const initial = createInitialState();
  const project = (id: string, title: string, content: string): Project => ({
    ...initial.project,
    id, name: `${id} 项目`,
    sourceDocuments: [{ id: `source-${id}`, name: title, content, createdAt: 1, updatedAt: 1 }],
    scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
  });
  const a = project('project-a', 'A 的剧情标题', 'A 独有的剧情，绝不能被 B 覆盖。');
  const b = project('project-b', 'B 的剧情标题', 'B 独有的剧情，绝不能被 A 覆盖。');
  const stateFor = (active: Project): AppState => ({
    ...initial, project: active, activeProjectId: active.id,
    projects: [active.id === a.id ? active : a, active.id === b.id ? active : b],
  });
  return { a, b, stateA: stateFor(a), stateB: stateFor(b), stateFor };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const probe = (
  initial: AppState,
  undo: AppState[] = [],
  redo: AppState[] = [],
  resolveSource: SourceResolver = async (text) => text,
) => {
  const stateRef = { current: initial };
  const undoStack = { current: [...undo] };
  const redoStack = { current: [...redo] };
  const workspaceEpochRef = { current: 0 };
  const controls = deriveWorkspaceUiState(initial);
  const ui: Record<string, unknown> = { ...controls };
  const storyDraftRef = { current: { storyInput: controls.storyInput, storyName: controls.storyName } };
  const notices: unknown[] = [];
  const integrityRequests: Array<{ text: string; action: string }> = [];
  let persistenceCalls = 0;
  let synchronizations = 0;
  let transactions: Transactions;
  const dependencies: Record<string, unknown> = {};

  // Unrelated React setters and lifecycle refs are inert. The story setters
  // update visible UI only: render-captured storyInput/storyName intentionally
  // stay stale until render() to reproduce an immediate post-history save.
  for (const identifier of identifiers) {
    if (/^set[A-Z]/u.test(identifier)) {
      const key = (identifier[3].toLowerCase() + identifier.slice(4)).replace(/Internal$/u, '');
      dependencies[identifier] = (value: unknown) => {
        ui[key] = typeof value === 'function'
          ? (value as (previous: unknown) => unknown)(ui[key])
          : value;
      };
    } else if (identifier.endsWith('Ref')) {
      dependencies[identifier] = {
        current: /(?:Epoch|Operation|Owner)Ref$/u.test(identifier) ? 0 : null,
      };
    }
  }
  Object.assign(dependencies, {
    useCallback: (callback: unknown) => callback,
    stateRef, undoStack, redoStack, workspaceEpochRef, storyDraftRef,
    state: initial, directorLookDraftEpoch: workspaceEpochRef.current,
    directorStyleId: controls.directorStyleId, directorCategory: controls.directorCategory,
    directorStyleName: controls.directorStyleName, directorStyleSummary: controls.directorStyleSummary,
    visualStyle: controls.visualStyle, styleId: controls.styleId,
    normalizeDirectorLookDraft, resolveWorkspaceDirectorLook,
    storyInput: controls.storyInput, storyName: controls.storyName,
    takeHistoryStep, isCurrentProjectOperation, replaceProjectSourceDocument,
    deriveWorkspaceUiState: (state: AppState) => {
      synchronizations += 1;
      return deriveWorkspaceUiState(state);
    },
    normalizeGridDirectorInputMode, activeDirectorWorkflow,
    parseDirectorSettingsFingerprint: () => ({}),
    resolveSequenceSegmentDuration: (_preset: string, duration: number) => duration,
    resolveDirectorStylePreset: () => ({ category: 'cinema', name: '电影' }),
    formatDirectorStyleSummary: () => '导演风格',
    createEmptyAssetForm: () => ({}),
    resetSourceDerivedUi: () => {},
    createId: (kind: string) => `${kind}-history-fixture`,
    setStateInternal: (state: AppState) => { ui.state = state; },
    setState: (update: AppState | ((current: AppState) => AppState)) => {
      persistenceCalls += 1;
      const current = stateRef.current;
      const candidate = typeof update === 'function' ? update(current) : update;
      const next = transactions.withProjectLibrary(candidate, current);
      const result = commitStateTransition(current, next, undoStack.current, redoStack.current, true);
      stateRef.current = result.current;
      undoStack.current = result.undo;
      redoStack.current = result.redo;
      ui.state = result.current;
    },
    setBackgroundState: (update: AppState | ((current: AppState) => AppState)) => {
      const reduceState = (source: AppState) => transactions.withProjectLibrary(
        typeof update === 'function' ? update(source) : update, source,
      );
      const current = stateRef.current;
      const result = commitStateTransition(
        current, reduceState(current), undoStack.current, redoStack.current, false, 50,
        typeof update === 'function' ? reduceState : undefined,
      );
      stateRef.current = result.current;
      undoStack.current = result.undo;
      redoStack.current = result.redo;
      ui.state = result.current;
    },
    notify: (...args: unknown[]) => { notices.push(args); },
    resolveSourceIntegrityForAction: (text: string, action: string) => {
      integrityRequests.push({ text, action });
      return resolveSource(text, action);
    },
  });
  transactions = new Function('dependencies', `with (dependencies) {
    ${transactionSource}
    return { withProjectLibrary, syncWorkspaceUiState, undo, redo, handleSaveStory, updateDirectorLookDraft };
  }`)(dependencies) as Transactions;
  const render = () => {
    dependencies.storyInput = ui.storyInput;
    dependencies.storyName = ui.storyName;
    storyDraftRef.current = {
      storyInput: String(ui.storyInput), storyName: String(ui.storyName),
    };
  };
  return {
    ...transactions, stateRef, undoStack, redoStack, workspaceEpochRef, storyDraftRef,
    ui, notices, integrityRequests, render,
    editDraft: (draft: Draft) => { Object.assign(ui, draft); render(); },
    get persistenceCalls() { return persistenceCalls; },
    get synchronizations() { return synchronizations; },
  };
};

const savedDraft = (project: Project): Draft => ({
  storyInput: project.sourceDocuments[0].content,
  storyName: project.sourceDocuments[0].name,
});

test('workspace synchronization updates the draft ref before a React render', () => {
  const { a, stateA, stateB } = fixture();
  const current = probe(stateB);
  current.syncWorkspaceUiState(stateA);
  assert.deepEqual(current.storyDraftRef.current, savedDraft(a));
  assert.equal(current.ui.storyInput, a.sourceDocuments[0].content);
  assert.equal(current.ui.storyName, a.sourceDocuments[0].name);
});

for (const direction of ['undo', 'redo'] as const) {
  test(`cross-project ${direction} synchronizes title/text and an immediate save stays in the restored project`, async () => {
    const { a, b, stateA, stateB } = fixture();
    const current = probe(stateB, direction === 'undo' ? [stateA] : [], direction === 'redo' ? [stateA] : []);
    const before = JSON.stringify({ stateA, stateB });
    current.editDraft({ storyInput: 'B 还未保存的输入', storyName: 'B 未保存的标题' });
    current[direction]();
    assert.equal(current.stateRef.current.project.id, a.id);
    assert.deepEqual(current.storyDraftRef.current, savedDraft(a));
    assert.equal(current.ui.storyInput, a.sourceDocuments[0].content);
    assert.equal(current.ui.storyName, a.sourceDocuments[0].name);
    await current.handleSaveStory(); // Deliberately no render() after history.
    assert.deepEqual(current.integrityRequests, [{ text: a.sourceDocuments[0].content, action: '保存原文' }]);
    assert.deepEqual(savedDraft(current.stateRef.current.project), savedDraft(a));
    assert.deepEqual(savedDraft(current.stateRef.current.projects.find((project) => project.id === b.id)!), savedDraft(b));
    assert.equal(current.persistenceCalls, 1);
    assert.equal(JSON.stringify({ stateA, stateB }), before, 'history source snapshots must remain immutable');
  });
}

test('undo then redo restores each project own draft without reusing the preceding render', async () => {
  const { a, b, stateA, stateB } = fixture();
  const current = probe(stateB, [stateA]);
  current.undo();
  assert.deepEqual(current.storyDraftRef.current, savedDraft(a));
  current.render();
  current.redo();
  assert.deepEqual(current.storyDraftRef.current, savedDraft(b));
  await current.handleSaveStory();
  assert.equal(current.stateRef.current.project.id, b.id);
  assert.deepEqual(savedDraft(current.stateRef.current.project), savedDraft(b));
  assert.equal(current.integrityRequests[0].text, b.sourceDocuments[0].content);
});

test('same-project undo and redo preserve unsaved story and director drafts', () => {
  const { a, stateA, stateFor } = fixture();
  const newer = stateFor({ ...a, description: '当前项目的较新编辑' });
  const current = probe(newer, [stateA]);
  const draft = { storyInput: '还未保存的剧情内容', storyName: '还未保存的剧情标题' };
  current.editDraft(draft);
  current.ui.extraRequirement = '尚未确认的导演要求';
  current.ui.shotCount = 17;
  current.undo();
  assert.equal(current.stateRef.current.project.id, a.id);
  assert.deepEqual(current.storyDraftRef.current, draft);
  assert.equal(current.ui.storyInput, draft.storyInput);
  assert.equal(current.ui.storyName, draft.storyName);
  assert.equal(current.ui.extraRequirement, '尚未确认的导演要求');
  assert.equal(current.ui.shotCount, 17);
  current.redo();
  assert.deepEqual(current.storyDraftRef.current, draft);
  assert.equal(current.ui.extraRequirement, '尚未确认的导演要求');
  assert.equal(current.ui.shotCount, 17);
  assert.equal(current.synchronizations, 0, 'same-project history must not reset controlled workspace fields');
});

test('director look edits replay into owned project history and survive same/cross-project undo-redo', () => {
  const { a, b, stateA, stateB, stateFor } = fixture();
  const otherLook: DirectorLookDraft = {
    directorStyleId: 'custom-b', directorCategory: '项目B分类', directorStyleName: '项目B风格',
    directorStyleSummary: 'B的风格说明', visualStyle: 'B的画面风格', styleId: 'style-b',
  };
  b.directorLookDraft = otherLook;
  const look: DirectorLookDraft = {
    directorStyleId: 'custom-a', directorCategory: '项目A分类', directorStyleName: '项目A最新风格',
    directorStyleSummary: 'A的最新自定义说明', visualStyle: '', styleId: 'style-a',
  };
  const current = probe(stateFor({ ...a, description: '新的可撤销编辑' }), [stateB, stateA]);
  const historySourceBefore = JSON.stringify({ stateA, stateB });
  const confirmedBefore = current.stateRef.current.project.directorSettingsConfirmedFingerprint;
  current.updateDirectorLookDraft(look);
  assert.equal(current.undoStack.current.length, 2, 'draft edits do not create or discard unrelated history entries');
  assert.equal(current.redoStack.current.length, 0);
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, look);
  for (const snapshot of current.undoStack.current) {
    const owner = snapshot.project.id === a.id ? snapshot.project : snapshot.projects.find((project) => project.id === a.id)!;
    assert.deepEqual(owner.directorLookDraft, look, 'background replay also updates an archived owning project');
    assert.equal(owner.directorSettingsConfirmedFingerprint, confirmedBefore, 'draft replay does not confirm generation settings');
    assert.deepEqual(snapshot.projects.find((project) => project.id === b.id)!.directorLookDraft, otherLook);
  }
  assert.equal(JSON.stringify({ stateA, stateB }), historySourceBefore, 'background replay never mutates the original history objects');
  current.undo();
  assert.equal(current.stateRef.current.project.id, a.id);
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, look);
  assert.equal(current.ui.directorStyleName, look.directorStyleName);
  assert.equal(current.ui.visualStyle, '', 'an explicitly cleared field remains empty through history');
  assert.equal(current.synchronizations, 0);
  current.redo();
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, look);
  current.undo();
  current.undo();
  assert.equal(current.stateRef.current.project.id, b.id);
  assert.equal(current.ui.directorStyleName, otherLook.directorStyleName);
  assert.equal(current.ui.visualStyle, otherLook.visualStyle);
  assert.deepEqual(current.stateRef.current.projects.find((project) => project.id === a.id)!.directorLookDraft, look);
  current.redo();
  assert.equal(current.stateRef.current.project.id, a.id);
  assert.deepEqual(current.stateRef.current.project.directorLookDraft, look);
  assert.equal(current.ui.directorStyleName, look.directorStyleName);
  assert.equal(current.ui.visualStyle, '');
  assert.equal(current.persistenceCalls, 0, 'keeping editing preferences never invokes a foreground source-save action');
});

for (const direction of ['undo', 'redo'] as const) {
  test(`a pending source-save confirmation cannot write after cross-project ${direction}`, async () => {
    const { stateA, stateB } = fixture();
    const confirmation = deferred<string | undefined>();
    const current = probe(stateB, direction === 'undo' ? [stateA] : [], direction === 'redo' ? [stateA] : [], () => confirmation.promise);
    current.editDraft({ storyInput: '只属于 B 的待确认剧情', storyName: '只属于 B 的待确认标题' });
    const pending = current.handleSaveStory();
    assert.equal(current.integrityRequests.length, 1);
    current[direction]();
    const restored = JSON.stringify(current.stateRef.current);
    confirmation.resolve('B 的确认结果，不能写入 A');
    await pending;
    assert.equal(current.persistenceCalls, 0);
    assert.equal(JSON.stringify(current.stateRef.current), restored);
  });
}

test('a pending save is stale after A to B to A even though the project id matches again', async () => {
  const { a, stateA, stateB } = fixture();
  const confirmation = deferred<string | undefined>();
  const current = probe(stateA, [stateB], [], () => confirmation.promise);
  current.editDraft({ storyInput: 'A 的旧保存请求', storyName: 'A 的旧标题' });
  const pending = current.handleSaveStory();
  current.undo();
  current.redo();
  assert.equal(current.stateRef.current.project.id, a.id);
  const restored = JSON.stringify(current.stateRef.current);
  confirmation.resolve('在 A→B→A 前发起的过期结果');
  await pending;
  assert.equal(current.persistenceCalls, 0, 'project id alone is not sufficient to own an asynchronous save');
  assert.equal(JSON.stringify(current.stateRef.current), restored);
});

test('same-project history invalidates a pending save without clearing the unsaved draft', async () => {
  const { a, stateA, stateFor } = fixture();
  const confirmation = deferred<string | undefined>();
  const current = probe(stateFor({ ...a, description: '较新编辑' }), [stateA], [], () => confirmation.promise);
  const draft = { storyInput: '等待确认的草稿', storyName: '等待确认的标题' };
  current.editDraft(draft);
  const pending = current.handleSaveStory();
  current.undo();
  const restored = JSON.stringify(current.stateRef.current);
  confirmation.resolve('撤销之后才返回的旧结果');
  await pending;
  assert.equal(current.persistenceCalls, 0);
  assert.equal(JSON.stringify(current.stateRef.current), restored);
  assert.deepEqual(current.storyDraftRef.current, draft);
});

test('a normal confirmed save writes the captured title and text without touching another project', async () => {
  const { a, b, stateA } = fixture();
  const confirmation = deferred<string | undefined>();
  const current = probe(stateA, [], [], () => confirmation.promise);
  current.editDraft({ storyInput: 'A 的新剧情', storyName: '  A 的新标题  ' });
  const pending = current.handleSaveStory();
  confirmation.resolve('A 的新剧情（已确认）');
  await pending;
  assert.equal(current.persistenceCalls, 1);
  assert.equal(current.stateRef.current.project.id, a.id);
  assert.deepEqual(savedDraft(current.stateRef.current.project), {
    storyInput: 'A 的新剧情（已确认）', storyName: 'A 的新标题',
  });
  assert.deepEqual(savedDraft(current.stateRef.current.projects.find((project) => project.id === b.id)!), savedDraft(b));
  assert.deepEqual(current.storyDraftRef.current, savedDraft(current.stateRef.current.project));
});

for (const field of ['storyInput', 'storyName'] as const) {
  test(`editing ${field} during source confirmation discards the obsolete save`, async () => {
    const { stateA } = fixture();
    const confirmation = deferred<string | undefined>();
    const current = probe(stateA, [], [], () => confirmation.promise);
    const original = { storyInput: '等待确认的旧正文', storyName: '等待确认的旧标题' };
    current.editDraft(original);
    const pending = current.handleSaveStory();
    const next = { ...original, [field]: '等待期间输入的新草稿' };
    current.editDraft(next);
    const before = JSON.stringify(current.stateRef.current);
    confirmation.resolve('已过期的旧正文处理结果');
    await pending;
    assert.equal(current.persistenceCalls, 0);
    assert.equal(JSON.stringify(current.stateRef.current), before);
    assert.deepEqual(current.storyDraftRef.current, next);
  });
}

test('empty history is a true no-op and does not cancel a pending normal save', async () => {
  const { stateA } = fixture();
  const confirmation = deferred<string | undefined>();
  const current = probe(stateA, [], [], () => confirmation.promise);
  current.editDraft({ storyInput: '无历史也可保存', storyName: '正常保存' });
  const pending = current.handleSaveStory();
  current.undo();
  current.redo();
  assert.equal(current.workspaceEpochRef.current, 0);
  confirmation.resolve('无历史也可保存');
  await pending;
  assert.equal(current.persistenceCalls, 1);
  assert.equal(current.synchronizations, 0);
});

test('canceling source confirmation never persists a draft', async () => {
  const { stateA } = fixture();
  const current = probe(stateA, [], [], async () => undefined);
  current.editDraft({ storyInput: '取消后的草稿', storyName: '保留在输入区' });
  const before = JSON.stringify(current.stateRef.current);
  await current.handleSaveStory();
  assert.equal(current.persistenceCalls, 0);
  assert.equal(JSON.stringify(current.stateRef.current), before);
});
