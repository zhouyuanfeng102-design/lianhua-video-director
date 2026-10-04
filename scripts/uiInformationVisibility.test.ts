import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const printer = ts.createPrinter();
interface Props { children?: React.ReactNode; [key: string]: any }
type Node = React.ReactElement<Props>;

// Execute the actual production JSX without importing App (which loads storage
// and asynchronous task effects). Browser QA separately verifies native details,
// keyboard interaction, wrapping, and geometry in short/high-font windows.
const renderBlock = (className: string, scope: Record<string, unknown>): Node => {
  let block: ts.JsxElement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => (
      ts.isJsxAttribute(attribute)
      && attribute.name.getText(ast) === 'className'
      && attribute.initializer
      && ts.isStringLiteral(attribute.initializer)
      && attribute.initializer.text === className
    ))) block = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(block, `production JSX ${className} must exist`);
  const code = ts.transpileModule(`return (${printer.printNode(ts.EmitHint.Unspecified, block, ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function('React', ...Object.keys(scope), code)(React, ...Object.values(scope));
};
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!React.isValidElement<Props>(value)) return [];
  return [value, ...nodesOf(value.props.children)];
};
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<Props>(value) ? textOf(value.props.children) : '';
};
const byClass = (tree: Node, className: string): Node => {
  const node = nodesOf(tree).find((entry) => entry.props.className === className);
  assert.ok(node, `missing ${className}`);
  return node;
};
const fitLabels = { comfortable: '宽松', balanced: '均衡', compressed: '偏紧' };
const guide = 'AI 估时会读取全文、完整对白和当前节奏、导演及额外要求；更改要求后需重新估时，已有计划不会自动改写。';

const noEstimate = renderBlock('sequence-estimate-copy', { durationEstimate: null, activeSequencePlan: null, fitLabels });
assert.match(textOf(noEstimate), /尚未估时/u);
assert.ok(nodesOf(noEstimate).some((node) => node.type === 'summary' && textOf(node) === '估时方式与重新估时说明'));
assert.equal(textOf(byClass(noEstimate, 'sequence-estimate-detail-body')), guide);

const reason = ('合理安排对白与动作并行。保留有叙事作用的停顿。\n').repeat(1200) + '理由末尾不能丢失';
const estimate = { recommendedSec: 80, minSec: 72, maxSec: 95, fitStatus: 'balanced', reason };
const estimateSnapshot = JSON.stringify(estimate);
const full = renderBlock('sequence-estimate-copy', {
  durationEstimate: estimate, activeSequencePlan: { fitStatus: 'compressed' }, fitLabels,
});
const details = byClass(full, 'sequence-estimate-details');
assert.equal(details.type, 'details');
assert.equal(details.props.open, undefined, 'reason must default to collapsed without hiding its opener');
assert.ok(nodesOf(details).some((node) => node.type === 'summary' && textOf(node) === '范围 72—95 秒 · 查看估时说明'));
assert.match(textOf(full), /估时建议 80 秒 · 均衡/u);
const body = byClass(full, 'sequence-estimate-detail-body');
assert.equal(body.props.tabIndex, 0, 'keyboard users must be able to scroll the complete reason');
assert.equal(body.props['aria-label'], '估时完整说明');
assert.ok(textOf(body).includes(reason));
assert.ok(textOf(body).includes('当前计划：偏紧'));
assert.ok(textOf(body).includes(guide), 're-estimation guidance stays available after estimating');
assert.equal(JSON.stringify(estimate), estimateSnapshot);
assert.ok(nodesOf(full).every((node) => !node.props.onClick && !node.props.onToggle), 'disclosure must not run planning actions or mutate confirmed estimates');

let libraryOpen = false;
const name = 'AI选帧与任务复制隔离测试_含完整版本及人物名称_'.repeat(80) + '名称末尾';
const card = renderBlock('status-card status-card-switcher', {
  state: { project: { name } },
  setProjectLibraryOpen: (open: boolean) => { libraryOpen = open; },
});
assert.equal(textOf(byClass(card, 'sidebar-project-name')), name, 'the complete name must survive JSX rendering');
assert.ok(card.props.title.includes(name));
assert.match(card.props.title, /点击打开项目库查看完整名称/u);
assert.equal(card.props.role, 'button');
assert.equal(card.props.tabIndex, 0);
card.props.onClick();
assert.equal(libraryOpen, true);
libraryOpen = false;
let prevented = false;
card.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
assert.equal(libraryOpen, true, 'keyboard users can open the full project library');
assert.equal(prevented, true);
const version = renderBlock('sidebar-version', { packageInfo: { version: '0.5.144' } });
assert.equal(textOf(version), '莲华视频导演台v0.5.144');

console.log('UI complete information regression checks passed (estimate details, long names, keyboard access)');
