import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// These structural regressions complement the real-browser viewport checks.
// They intentionally do not mount the UI, touch user data, or launch media jobs.
const source = readFileSync(new URL('../src/components/VideoWorkbenchView.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/videoWorkbench.css', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('VideoWorkbenchView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const openings: Opening[] = [];
const collect = (node: ts.Node) => {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) openings.push(node);
  ts.forEachChild(node, collect);
};
collect(parsed);
const attr = (node: Opening, name: string): ts.JsxAttribute | undefined => node.attributes.properties.find(
  (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(parsed) === name,
);
const textAttr = (node: Opening, name: string): string | undefined => {
  const value = attr(node, name)?.initializer;
  if (!value) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression)) return value.expression.text;
  return undefined;
};
const jsxScope = (node: Opening): ts.Node => ts.isJsxOpeningElement(node) ? node.parent : node;
const isInsidePanel = (node: ts.Node) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && textAttr(parent.openingElement, 'role') === 'tabpanel') return true;
  }
  return false;
};
const classIncludes = (node: Opening, className: string) => textAttr(node, 'className')?.split(/\s+/u).includes(className);

test('workbench preview stays mounted outside task panels when switching tools', () => {
  const players = openings.filter((node) => node.tagName.getText(parsed) === 'video');
  assert.equal(players.length, 1, 'there must be a single persistent preview player');
  assert.equal(isInsidePanel(players[0]), false, 'tool tabs must not unmount the player and lose its playhead');
  assert.ok(attr(players[0], 'controls'), 'the video workbench, unlike generation jobs, retains playback controls');
});

test('all workbench tools remain reachable through labelled page-local tabs', () => {
  assert.ok(openings.some((node) => textAttr(node, 'role') === 'tablist'), 'workbench tools need an explicit tablist');
  assert.ok(openings.some((node) => textAttr(node, 'role') === 'tabpanel'), 'selected tool needs a labelled panel');
  for (const tab of ['edit', 'frames', 'jobs']) {
    assert.match(source, new RegExp(`['"]${tab}['"]`, 'u'), `the ${tab} tool must remain reachable`);
  }
  assert.doesNotMatch(source, /\['output',\s*'输出声音'/u, 'output is inline beneath the timeline, not a separate tab');
  const inlineOutput = openings.find((node) => node.tagName.getText(parsed) === 'WorkbenchOutputSettings');
  assert.ok(inlineOutput, 'all output and sound controls must remain on the edit page');
  assert.equal(isInsidePanel(inlineOutput), true);
});

test('large material, timeline, frame and processing lists retain explicit pagination', () => {
  const pagers = openings.filter((node) => node.tagName.getText(parsed) === 'Pagination');
  for (const label of ['视频素材', '剪辑片段', '衔接参考帧', '处理记录']) {
    assert.ok(pagers.some((node) => textAttr(node, 'label') === label), `${label} pagination must exist instead of clipping long projects`);
  }
  assert.doesNotMatch(source, /\.slice\(\s*0\s*,\s*(?:80|10)\s*\)/u, 'old arbitrary frame/job caps must not discard older pages');
  assert.ok(css.includes('.vwb-pagination'), 'pagination must have a stable layout contract');
});

test('navigation actions never scroll the one-page workbench into another off-screen section', () => {
  assert.doesNotMatch(source, /\.scrollIntoView(?:IfNeeded)?\s*\(/u);
  for (const action of ['预览成片', '查看抽帧', '重新执行']) assert.ok(source.includes(action), `${action} must survive the layout change`);
});

test('the workbench uses viewport height and pagination rather than collection scroll boxes', () => {
  assert.match(css, /\.workspace:has\(>\s*\.video-workbench-view\)\s*\{\s*overflow:\s*hidden/u);
  const viewRule = css.match(/\.video-workbench-view\s*\{([^}]+)\}/u)?.[1] || '';
  assert.match(viewRule, /height:\s*100%/u);
  assert.match(viewRule, /min-height:\s*0/u);
  assert.match(viewRule, /minmax\(0,\s*1fr\)/u);
  assert.doesNotMatch(css, /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/u, 'a hidden outer scrollbar must not be replaced with inner collection scrollbars');
});

test('opening a historical frame result reveals its absolute index after the target panel measures itself', () => {
  assert.match(source, /framePages\.revealIndex\(Math\.max\(0,\s*frameIndex\)\)/u);
  assert.match(source, /setRequestedPage\(Math\.floor\(pendingIndex\.current\s*\/\s*nextCapacity\)\)/u);
  assert.match(source, /pendingIndex\.current\s*=\s*undefined/u, 'one-shot navigation must not override subsequent manual pagination');
});

test('progress cancellation remains outside tool panels and therefore always reachable', () => {
  const footer = openings.find((node) => classIncludes(node, 'vwb-footer'));
  assert.ok(footer, 'a fixed page-local footer must own processing feedback');
  assert.equal(isInsidePanel(footer), false, 'switching tabs must not hide cancellation');
  const footerSource = jsxScope(footer).getText(parsed);
  assert.match(footerSource, /controller\.cancel/u);
  assert.ok(footerSource.includes('取消处理'));
});

test('all six extraction modes and decoded frame numbering retain their original meaning', () => {
  const optionValues = new Set(openings.filter((node) => node.tagName.getText(parsed) === 'option').map((node) => textAttr(node, 'value')));
  for (const mode of ['first', 'last', 'time', 'frame', 'uniform', 'boundaries']) assert.ok(optionValues.has(mode), `${mode} extraction must remain available`);
  assert.match(source, /frameIndex\s*:\s*frameNumber\s*-\s*1/u, 'visible frame 1 must still address decoded frame index 0');
  assert.match(source, /inSec\s*:\s*extractRange\.inSec/u);
  assert.match(source, /outSec\s*:\s*extractRange\.outSec/u);
  assert.ok(source.includes('使用当前画面时间'));
});

test('non-destructive editing still exposes trim, split, order, original volume and transitions', () => {
  for (const action of ['当前画面设为入点', '当前画面设为出点', '当前处分割', '按剧情装载']) {
    assert.ok(source.includes(action), `${action} must not disappear to make the page fit`);
  }
  assert.match(source, /window\.confirm\('清空当前时间线/u);
  assert.match(source, /clips\s*:\s*\[\]/u, 'clearing must only remove draft clips');
  for (const property of ['inSec', 'outSec', 'volume', 'transitionAfter']) assert.match(source, new RegExp(`\\b${property}\\b`, 'u'));
  assert.ok(source.includes('crossfade'));
  assert.ok(source.includes('moveClip'));
});

test('paged timeline order controls still use the global clip position', () => {
  assert.match(source, /const index\s*=\s*clipPages\.page\s*\*\s*clipPages\.capacity\s*\+\s*pageIndex/u);
  assert.match(source, /moveClip\(clip\.id,\s*index\s*-\s*1\)/u);
  assert.match(source, /moveClip\(clip\.id,\s*index\s*\+\s*1\)/u);
  assert.match(source, /moveClip\(draggedClipId,\s*index\)/u);
  assert.match(source, /selectedClipIndex\s*<\s*draft\.clips\.length\s*-\s*1/u, 'transitions depend on the real next clip, not the end of a page');
});

test('output keeps low-volume BGM controls and original sound priority', () => {
  for (const property of ['fileName', 'width', 'height', 'fps', 'fadeInSec', 'fadeOutSec', 'bgmAssetId', 'bgmVolume', 'ducking']) {
    assert.match(source, new RegExp(`\\b${property}\\b`, 'u'), `${property} must remain editable after tab restructuring`);
  }
  assert.ok(source.includes('renderTimeline'));
  assert.ok(source.includes('输出与声音'));
  assert.ok(source.includes('原声优先'));
  assert.match(css, /\.vwb-inline-output/u);
  assert.doesNotMatch(css, /transform\s*:\s*scale|\bzoom\s*:/u, 'compact controls must retain native hit boxes');
});

test('reference-frame handoff remains confirmation-only and preserves reference roles', () => {
  const send = parsed.statements.flatMap((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'VideoWorkbenchView'
    ? (statement.body?.statements || []) : []).find((statement) => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'sendFrame'));
  assert.ok(send, 'frame handoff action must remain available');
  const sendSource = send.getText(parsed);
  assert.match(sendSource, /window\.confirm/u);
  assert.match(sendSource, /onOpenVideoDirector/u);
  assert.match(sendSource, /referenceRoleOverrides/u);
  assert.match(sendSource, /'first-frame'/u);
  assert.match(sendSource, /'composition'/u);
  assert.doesNotMatch(sendSource, /videoRequest|submitVideo|generateVideo/u, 'reference handoff must not submit paid generation');
});
