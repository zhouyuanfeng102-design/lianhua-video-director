import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'resolveSourceIntegrityForAction') {
    declaration = node;
  }
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(declaration);
const compiled = ts.transpileModule(`const ${declaration.getText(ast)}; return resolveSourceIntegrityForAction;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const resolve = new Function(`${compiled}`)() as (
  content: string,
  label: string,
  isCurrent?: () => boolean,
) => Promise<string | undefined>;
assert.equal(await resolve('事件句\n动作过程：同一段', 'AI 理解剧情并分段'), '事件句\n动作过程：同一段');
assert.equal(await resolve('原文', '保存原文', () => false), undefined);
assert.equal(source.includes('detectSourceIntegrityIssues('), false);
assert.equal(source.includes('confirmSourceIntegrityAction('), false);
console.log('source integrity gate checks passed');
