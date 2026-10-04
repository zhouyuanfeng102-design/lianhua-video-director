import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { commitStateTransition, replaceProjectSourceDocument, deriveWorkspaceUiState } from '../src/appEffects';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { normalizeStoryDraft, readProjectStoryDraft, storyDraftIdentity, withProjectStoryDraft } from '../src/storyDraft';
import { openProjectWorkspace } from '../src/projectBackground';
import type { AppState } from '../src/types';

// Synthetic states only. Execute the actual App transactions, not a second
// implementation of the guard, persistence or export logic.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [
  'withProjectLibrary', 'persistStoryEditorDraft', 'setStoryInput', 'setStoryName',
  'stateWithCurrentDraft', 'persistPrimarySourceDocument', 'handleImportStoryFile',
  'handleSaveStory', 'handleExportProject', 'switchProject',
] as const;
const declarations = new Map<string, ts.VariableDeclaration>();
let closeEffect: ts.ExpressionStatement | undefined;
let integrityDeclaration: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && names.includes(node.name.text as typeof names[number])) declarations.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.name.text === 'resolveSourceIntegrityForAction') integrityDeclaration = node;
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'useEffect'
    && node.getText(ast).includes('bridge.onBeforeClose(')) closeEffect = node;
  ts.forEachChild(node, visit);
};
visit(ast);
for (const name of names) assert.ok(declarations.has(name), `production ${name}`);
assert.ok(closeEffect);
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const transactionCode = compile(names.map((name) => `const ${declarations.get(name)!.getText(ast)};`).join('\n'));
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = (): AppState => {
  const state = createInitialState();
  const a = { ...state.project, id: 'draft-project-a', name: 'A', storyDraft: undefined,
    sourceDocuments: [{ id: 'source-a', name: 'A原文', content: '已确认A原文。', createdAt: 1, updatedAt: 2 }],
  };
  const b = { ...a, id: 'draft-project-b', name: 'B',
    sourceDocuments: [{ id: 'source-b', name: 'B原文', content: '已确认B原文。', createdAt: 1, updatedAt: 2 }],
  };
  return { ...state, project: a, projects: [a, b], activeProjectId: a.id };
};
const harness = (initial = fixture()) => {
  const stateRef = { current: initial };
  const draft = readProjectStoryDraft(initial.project);
  const ui = { ...draft };
  const storyDraftRef = { current: draft };
  const storyDraftOwnerRef = { current: initial.project.id };
  const workspaceEpochRef = { current: 1 };
  const storyImportOperationRef = { current: 0 };
  const notices: unknown[][] = [];
  const writes: string[] = [];
  const integrityCalls: string[] = [];
  const exports: Array<{ content: string }> = [];
  const history: { undo: AppState[]; redo: AppState[] } = { undo: [], redo: [] };
  let imports = 0;
  const configuration = {
    read: async (_file: unknown) => '导入的全文。',
    resolve: async (text: string, _label: string, _current?: () => boolean): Promise<string | undefined> => text,
  };
  let api: any;
  const dependencies: Record<string, any> = {
    state: initial, stateRef, storyDraftRef, storyDraftOwnerRef, workspaceEpochRef, storyImportOperationRef,
    storyName: draft.storyName, storyInput: draft.storyInput,
    withProjectStoryDraft, readProjectStoryDraft, storyDraftIdentity, replaceProjectSourceDocument, openProjectWorkspace,
    useCallback: (fn: unknown) => fn,
    setStoryInputInternal: (value: string) => { ui.storyInput = value; },
    setStoryNameInternal: (value: string) => { ui.storyName = value; },
    createId: (prefix: string) => `${prefix}-test`, resetSourceDerivedUi: () => {},
    invalidateSequenceEstimate: () => {}, notify: (...args: unknown[]) => notices.push(args),
    readFileAsText: (file: unknown) => { imports += 1; return configuration.read(file); },
    resolveSourceIntegrityForAction: (text: string, label: string, current?: () => boolean) => {
      integrityCalls.push(text); return configuration.resolve(text, label, current);
    },
    setSelectedProjectIds: () => {}, setProjectLibraryOpen: () => {}, setView: () => {},
    syncWorkspaceUiState: (value: AppState) => {
      workspaceEpochRef.current += 1; storyImportOperationRef.current += 1;
      storyDraftOwnerRef.current = value.project.id;
      storyDraftRef.current = readProjectStoryDraft(value.project);
      Object.assign(ui, storyDraftRef.current);
    },
    desktopBridge: () => ({ exportProjectPackage: async (value: { content: string }) => {
      exports.push(value); return { assetCount: 0, missingCount: 0 };
    } }),
    serializeStateForStorage, isNsfwPrivateProfileAsset: () => false,
    safeFileName: (name: string) => name,
  };
  const commit = (update: any, background: boolean) => {
    const before = stateRef.current;
    const reducer = (value: AppState) => api.withProjectLibrary(typeof update === 'function' ? update(value) : update, value);
    const result = commitStateTransition(before, reducer(before), history.undo, history.redo,
      !background, 50, background && typeof update === 'function' ? reducer : undefined);
    stateRef.current = result.current;
    history.undo = result.undo; history.redo = result.redo;
    dependencies.state = result.current;
    writes.push(background ? 'draft/background' : 'explicit');
  };
  dependencies.setState = (update: unknown) => commit(update, false);
  dependencies.setBackgroundState = (update: unknown) => commit(update, true);
  api = new Function('dependencies', `with(dependencies) { ${transactionCode}\nreturn { ${names.join(',')} }; }`)(dependencies);
  const importFile = (name = 'A导入.txt') => {
    const event = { target: { files: [{ name }], value: name } };
    const pending = api.handleImportStoryFile(event) as Promise<void>;
    assert.equal(event.target.value, '', 'picker resets synchronously, never after a newer import');
    return pending;
  };
  const close = async () => {
    const saved: AppState[] = []; const completed = deferred<{ ok: boolean }>();
    let beforeClose: (event: { requestId: string }) => void = () => assert.fail('missing close handler');
    Object.assign(dependencies, {
      window: { lianhuaDesktop: {
        onBeforeClose: (callback: typeof beforeClose) => { beforeClose = callback; return () => {}; },
        completeBeforeClose: async (value: { ok: boolean }) => { completed.resolve(value); return true; },
      } },
      useEffect: (effect: () => unknown) => effect(), desktopStateReady: true,
      closingSaveRef: { current: false }, closingRequestIdRef: { current: '' },
      restoreCompletionRef: { current: Promise.resolve() }, setSavingBeforeClose: () => {},
      setSaveStatus: () => {}, setNotice: () => {},
      saveStateAsync: async (value: AppState) => { saved.push(normalizeState(JSON.parse(serializeStateForStorage(value).serialized))); },
      stateWithCurrentDraft: api.stateWithCurrentDraft,
    });
    new Function('dependencies', `with(dependencies) { ${compile(closeEffect!.getText(ast))} }`)(dependencies);
    beforeClose({ requestId: 'isolated-close' });
    assert.equal((await completed.promise).ok, true);
    assert.ok(saved.length); return saved.at(-1)!;
  };
  return { ...api, stateRef, ui, storyDraftRef, storyDraftOwnerRef, workspaceEpochRef, storyImportOperationRef,
    notices, writes, integrityCalls, exports, history, configuration, importFile, close,
    get imports() { return imports; },
  };
};

test('draft normalization preserves exact/empty text but rejects malformed shapes', () => {
  for (const value of [null, [], 'text', { name: 4, content: 'x' }, { name: 'x', content: null }]) {
    assert.equal(normalizeStoryDraft(value), undefined);
  }
  assert.deepEqual(normalizeStoryDraft({ name: '', content: '\n ', updatedAt: Infinity }), { name: '', content: '\n ', updatedAt: 0 });
});

test('typing and functional setters save independent drafts without clearing existing work', async () => {
  const qa = harness(); const original = qa.stateRef.current.project;
  const existing = JSON.stringify(original);
  qa.setStoryInput('新草稿\n'); qa.setStoryInput((value: string) => `${value}追加全文。`);
  qa.setStoryName('  草稿标题  ');
  const project = qa.stateRef.current.project;
  assert.deepEqual(project.storyDraft && { name: project.storyDraft.name, content: project.storyDraft.content },
    { name: '  草稿标题  ', content: '新草稿\n追加全文。' });
  for (const key of ['sourceDocuments', 'scenes', 'storyboards', 'sequencePlans', 'characters', 'assets'] as const) {
    assert.equal(project[key], original[key], `${key} stays untouched`);
  }
  assert.equal(JSON.stringify(original), existing);
  assert.equal(qa.history.undo.length, 0, 'typing is not a destructive project transaction');
  const saved = await qa.close();
  assert.deepEqual(readProjectStoryDraft(saved.project), qa.ui);
  assert.equal(saved.project.sourceDocuments[0].content, original.sourceDocuments[0].content);
});

test('normal close catches a latest owned draft without implicit source commit', async () => {
  const qa = harness(); const original = qa.stateRef.current.project;
  qa.storyDraftRef.current = { storyInput: '', storyName: '' };
  const saved = await qa.close();
  assert.deepEqual(readProjectStoryDraft(saved.project), { storyInput: '', storyName: '' });
  assert.deepEqual(saved.project.sourceDocuments, normalizeState(fixture()).project.sourceDocuments);
  assert.equal(saved.project.scenes.length, original.scenes.length);
  assert.equal(saved.project.storyboards.length, original.storyboards.length);
});

test('switch transaction preserves task progress delivered after its render snapshot', () => {
  const qa = harness();
  const original = qa.stateRef.current.project;
  const otherId = qa.stateRef.current.projects[1].id;
  const tasks: AppState['project']['generationTasks'] = [{
    id: 'background-arrival', kind: 'video', status: 'running', remoteTaskId: 'existing-remote',
    storyboardId: '', targetId: 'synthetic', requestBody: {}, createdAt: 1, updatedAt: 2,
  }];
  // Simulate an engine callback before React has rendered a new handler.
  qa.stateRef.current = { ...qa.stateRef.current, project: { ...original, generationTasks: tasks } };
  qa.switchProject(otherId);
  assert.equal(qa.stateRef.current.projects.find((project: AppState['project']) => project.id === original.id)!.generationTasks, tasks);
  qa.switchProject(original.id);
  assert.equal(qa.stateRef.current.project.generationTasks, tasks);
});

test('A/B switching, serialized restore and export preserve each own draft and confirmed source', async () => {
  const qa = harness(); const a = qa.stateRef.current.project.id;
  const b = qa.stateRef.current.projects[1].id;
  qa.setStoryInput('A未提交草稿'); qa.setStoryName('A草稿名');
  qa.switchProject(b); qa.setStoryInput('B未提交草稿'); qa.setStoryName('B草稿名');
  qa.switchProject(a);
  assert.deepEqual(qa.ui, { storyInput: 'A未提交草稿', storyName: 'A草稿名' });
  const roundtrip = normalizeState(JSON.parse(serializeStateForStorage(qa.stateRef.current).serialized));
  assert.deepEqual(readProjectStoryDraft(roundtrip.projects.find((project) => project.id === b)!),
    { storyInput: 'B未提交草稿', storyName: 'B草稿名' });
  assert.deepEqual(deriveWorkspaceUiState(roundtrip).storyInput, 'A未提交草稿');
  await qa.handleExportProject();
  const exported = normalizeState(JSON.parse(qa.exports[0].content));
  assert.equal(exported.project.storyDraft?.content, 'A未提交草稿');
  assert.equal(exported.project.sourceDocuments[0].content, '已确认A原文。');
  assert.equal(exported.projects.length, 1);
});

test('a foreign owned draft cannot enter save/export target even before UI restore', () => {
  const qa = harness(); const original = qa.stateRef.current;
  qa.storyDraftOwnerRef.current = 'another-project';
  qa.storyDraftRef.current = { storyInput: '不属于A', storyName: '不属于A' };
  assert.equal(qa.stateWithCurrentDraft(original), original);
});

test('explicit save clears the draft, and unchanged source/name never deletes scenes', async () => {
  const qa = harness(); const original = qa.stateRef.current.project;
  qa.setStoryName(`  ${original.sourceDocuments[0].name}  `);
  assert.ok(qa.stateRef.current.project.storyDraft);
  await qa.handleSaveStory();
  assert.equal(qa.stateRef.current.project.storyDraft, undefined);
  assert.equal(qa.stateRef.current.project.scenes, original.scenes);
  qa.setStoryInput('确认的新原文');
  await qa.handleSaveStory();
  assert.equal(qa.stateRef.current.project.sourceDocuments[0].content, '确认的新原文');
  assert.equal(qa.stateRef.current.project.storyDraft, undefined);
  assert.equal(qa.stateRef.current.project.scenes.length, 0, 'only explicit source replacement invalidates old derived work');
});

for (const stage of ['read', 'integrity'] as const) {
  for (const action of ['switch', 'roundtrip', 'edit', 'rename', 'edit-revert'] as const) {
    test(`obsolete import after ${action} at ${stage} cannot touch source, draft, scenes or plans`, async () => {
      const qa = harness(); const delayed = deferred<string>();
      if (stage === 'read') qa.configuration.read = () => delayed.promise;
      else qa.configuration.resolve = () => delayed.promise;
      const pending = qa.importFile(); await Promise.resolve();
      const a = qa.stateRef.current.project.id; const b = qa.stateRef.current.projects[1].id;
      if (action === 'switch' || action === 'roundtrip') {
        qa.switchProject(b); if (action === 'roundtrip') qa.switchProject(a);
      } else if (action === 'rename') qa.setStoryName('新标题');
      else {
        const before = qa.ui.storyInput; qa.setStoryInput('输入了新的草稿');
        if (action === 'edit-revert') qa.setStoryInput(before);
      }
      const afterAction = JSON.stringify(qa.stateRef.current); const notices = qa.notices.length;
      delayed.resolve('绝不写入的旧导入'); await pending;
      assert.equal(JSON.stringify(qa.stateRef.current), afterAction);
      assert.equal(qa.notices.length, notices, 'no stale success/error notice');
      if (stage === 'read') assert.equal(qa.integrityCalls.length, 0, 'stale input never reaches cleanup/confirmation');
    });
  }
}

test('overlapping imports are latest-wins even when first request settles last', async () => {
  const qa = harness(); const first = deferred<string>(); const second = deferred<string>();
  qa.configuration.read = (file: any) => file.name === '旧导入.txt' ? first.promise : second.promise;
  const old = qa.importFile('旧导入.txt'); const current = qa.importFile('新导入.txt');
  second.resolve('新导入内容'); await current;
  assert.equal(qa.stateRef.current.project.sourceDocuments[0].content, '新导入内容');
  first.resolve('旧导入内容'); await old;
  assert.equal(qa.stateRef.current.project.sourceDocuments[0].content, '新导入内容');
  assert.equal(qa.stateRef.current.project.sourceDocuments[0].name, '新导入');
  assert.equal(qa.notices.filter((entry: unknown[]) => String(entry[0]).startsWith('已导入')).length, 1);
});

test('background task bookkeeping does not cancel a valid import', async () => {
  const qa = harness(); const delayed = deferred<string>();
  qa.configuration.read = () => delayed.promise;
  const pending = qa.importFile();
  qa.stateRef.current = { ...qa.stateRef.current, project: { ...qa.stateRef.current.project, updatedAt: Date.now() + 100 } };
  delayed.resolve('正常导入'); await pending;
  assert.equal(qa.stateRef.current.project.sourceDocuments[0].content, '正常导入');
});

test('actual source-cleanup await also discards stale notices and never opens a second cleanup prompt', async () => {
  assert.ok(integrityDeclaration);
  for (const mode of ['success', 'failure'] as const) {
    let current = true; let confirmations = 0; let resolutions = 0;
    const notices: unknown[] = []; const backup = deferred<boolean>();
    const dependencies = {
      detectSourceIntegrityIssues: () => [{ kind: 'fixture' }], sourceContentHash: (text: string) => text,
      sourceIntegrityAcknowledgedHashRef: { current: '' }, window: { confirm: () => true },
      confirmSourceIntegrityAction: () => { confirmations += 1; return 'keep-first'; },
      desktopBridge: () => ({ createRestorePoint: () => {} }), sourceDraftSnapshot: () => 'synthetic-snapshot',
      createRestorePointWithNotice: async (_create: unknown, _snapshot: unknown, notify: (value: unknown) => void) => {
        const result = await backup.promise; notify('late backup notice'); return result;
      },
      setNotice: (notice: unknown) => notices.push(notice), notify: (notice: unknown) => notices.push(notice),
      applySourceIntegrityResolution: () => { resolutions += 1; return 'cleaned'; },
    };
    const resolve: (content: string, label: string, isCurrent: () => boolean) => Promise<string | undefined> = new Function('dependencies', `with(dependencies) {
      ${compile(`const ${integrityDeclaration.getText(ast)};`)} return resolveSourceIntegrityForAction;
    }`)(dependencies);
    const pending = resolve('synthetic duplicate', '导入剧情', () => current);
    current = false;
    if (mode === 'success') backup.resolve(true); else backup.reject(new Error('late backup failure'));
    assert.equal(await pending, undefined);
    assert.equal(confirmations, 1); assert.equal(resolutions, 0); assert.deepEqual(notices, []);
  }
});

test('draft roundtrip does not inherit active project drafts into legacy archived projects', () => {
  const state = fixture(); state.project.storyDraft = { content: 'active only', name: 'draft', updatedAt: 1 };
  const normalized = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(normalized.project.storyDraft?.content, 'active only');
  assert.equal(normalized.projects.find((project) => project.id === 'draft-project-b')?.storyDraft, undefined);
});
