import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import type { AppState, ReferenceAsset } from '../src/types';

// Execute the actual save handlers against synthetic states, including an
// outgoing render whose event handler runs after the current project changes.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = ast.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'AssetsView');
assert.ok(view);
const handlers = new Map<string, ts.VariableDeclaration>();
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ['editAsset', 'saveAsset'].includes(node.name.getText(ast))) {
    handlers.set(node.name.getText(ast), node);
  }
  ts.forEachChild(node, visit);
};
visit(view);
assert.equal(handlers.size, 2);
const compiled = ts.transpileModule(
  [...handlers.values()].map((node) => `const ${node.getText(ast)};`).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const initial = createInitialState();
const asset: ReferenceAsset = {
  id: 'shared-asset', name: 'Original', type: 'reference', role: 'composition',
  mediaType: 'image', referenceRole: 'general', tags: ['original'], createdAt: 1, updatedAt: 1,
};
const makeState = (id = 'project-b', assets = [asset]): AppState => {
  const project = { ...initial.project, id, assets, updatedAt: 1 };
  return { ...initial, project, projects: [project], activeProjectId: id };
};
const fixture = () => {
  let current = makeState();
  const notices: { text: string; tone?: string }[] = [];
  let updates = 0;
  const scope: Record<string, unknown> = {
    state: current,
    editingAssetTarget: null,
    assetDraft: {},
    setEditingAssetTarget: (target: unknown) => { scope.editingAssetTarget = target; },
    setAssetDraft: (draft: unknown) => { scope.assetDraft = draft; },
    setState: (update: (state: AppState) => AppState) => { current = update(current); updates += 1; },
    notify: (text: string, tone?: string) => { notices.push({ text, tone }); },
  };
  const editor = new Function('scope', `with(scope) { ${compiled}; return { editAsset, saveAsset }; }`)(scope) as {
    editAsset: (asset: ReferenceAsset) => void; saveAsset: () => void;
  };
  return {
    editor, scope, notices,
    get current() { return current; },
    get updates() { return updates; },
    replaceCurrent(next: AppState) { current = next; },
  };
};

test('ordinary asset edits preserve other assets and save all edited fields', () => {
  const f = fixture();
  const other = { ...asset, id: 'other', name: 'Untouched' };
  f.replaceCurrent(makeState('project-b', [asset, other]));
  f.editor.editAsset(asset);
  f.scope.assetDraft = {
    name: ' New name ', tags: ' one、two, ，three ', visualAnchor: ' visual ', prompt: ' prompt ',
    mediaType: 'audio', referenceRole: 'audio', durationSec: 3.5, targetBindings: 'voiceover、ambient',
  };
  f.editor.saveAsset();
  const saved = f.current.project.assets[0];
  assert.equal(saved.name, 'New name');
  assert.deepEqual(saved.tags, ['one', 'two', 'three']);
  assert.equal(saved.visualAnchor, 'visual');
  assert.equal(saved.prompt, 'prompt');
  assert.equal(saved.mediaType, 'audio');
  assert.equal(saved.referenceRole, 'audio');
  assert.equal(saved.durationSec, 3.5);
  assert.deepEqual(saved.targetBindings, ['voiceover', 'ambient']);
  assert.equal(f.current.project.assets[1], other);
  assert.equal(asset.name, 'Original', 'the original asset is not mutated');
  assert.equal(f.scope.editingAssetTarget, null);
  assert.equal(f.updates, 1);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].text, /已保存/u);
  assert.notEqual(f.notices[0].tone, 'error');
});

for (const sharesAssetId of [false, true]) {
  test(`an outgoing project handler cannot save after switching projects (shared ID: ${sharesAssetId})`, () => {
    const f = fixture();
    f.editor.editAsset(asset);
    f.scope.assetDraft = { ...(f.scope.assetDraft as object), name: 'Outgoing draft' };
    const incoming = makeState('project-a', [{ ...asset, id: sharesAssetId ? asset.id : 'other-id', name: 'Incoming original' }]);
    f.replaceCurrent(incoming);
    f.editor.saveAsset();
    assert.equal(f.current, incoming);
    assert.equal(f.current.project.assets[0].name, 'Incoming original');
    assert.equal(f.updates, 0);
    assert.equal(f.scope.editingAssetTarget, null);
    assert.deepEqual(f.notices.map(({ tone }) => tone), ['error']);
    assert.match(f.notices[0].text, /项目已切换/u);
  });
}

test('an asset removed while the editor is open does not report a successful save', () => {
  const f = fixture();
  f.editor.editAsset(asset);
  const withoutAsset = makeState('project-b', []);
  f.replaceCurrent(withoutAsset);
  f.editor.saveAsset();
  assert.equal(f.current, withoutAsset);
  assert.equal(f.updates, 0);
  assert.equal(f.scope.editingAssetTarget, null);
  assert.deepEqual(f.notices.map(({ tone }) => tone), ['error']);
  assert.match(f.notices[0].text, /资产已不存在/u);
});

test('saving without an active editor is a no-op', () => {
  const f = fixture();
  const before = f.current;
  f.editor.saveAsset();
  assert.equal(f.current, before);
  assert.equal(f.updates, 0);
  assert.deepEqual(f.notices, []);
});
