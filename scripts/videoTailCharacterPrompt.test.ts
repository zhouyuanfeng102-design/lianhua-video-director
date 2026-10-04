import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

// Runtime tests exercise the real buttons. This additionally prevents an
// app-level callback or lazy import from restoring whole-prompt AI rewriting.
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const app = source('../src/App.tsx');
const view = source('../src/components/VideoDirectorView.tsx');
const binding = source('../src/videoTailCharacters.ts');
const appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const viewAst = ts.createSourceFile('VideoDirectorView.tsx', view, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let tests = 0;
const test = (name: string, run: () => void) => { run(); console.log(`ok ${++tests} - ${name}`); };
const nodes = (root: ts.Node): ts.Node[] => {
  const result: ts.Node[] = [root];
  ts.forEachChild(root, (child) => { result.push(...nodes(child)); });
  return result;
};

test('video director has no full-prompt AI review callback, state or service calls', () => {
  const identifiers = nodes(viewAst).filter(ts.isIdentifier).map((node) => node.text);
  for (const removed of ['reviewTailCharacterPrompt', 'reviewTailCharacterCandidate', 'reviewVideoTailCharacterPrompt',
    'reviewedPrompts', 'reviewedPromptsRef', 'reviewErrors', 'reviewBusy',
    'requestTextModel', 'repairH3PromptProtocolWithAi']) {
    assert.ok(!identifiers.includes(removed), `unexpected video-reference AI dependency: ${removed}`);
  }
  assert.doesNotMatch(view, /等待文本AI|文本AI已完成组合提示词复核|文本AI同步H3/u);
});

test('app no longer injects or lazy-loads an AI reviewer into VideoDirectorView', () => {
  const appNodes = nodes(appAst);
  assert.ok(!appNodes.filter(ts.isJsxAttribute).some((node) => node.name.getText(appAst) === 'reviewTailCharacterPrompt'));
  assert.ok(!appNodes.filter(ts.isIdentifier).some((node) => node.text === 'reviewTailCharacterPrompt'));
  assert.ok(!appNodes.filter(ts.isStringLiteral).some((node) => /(?:^|\/)videoTailCharacterPrompt$/u.test(node.text)));
  assert.equal(existsSync(new URL('../src/videoTailCharacterPrompt.ts', import.meta.url)), false,
    'retired reference-only full-prompt rewrite service must not remain callable');
});

test('reference binding neither authors a name/responsibility preamble nor calls AI repair', () => {
  assert.doesNotMatch(binding, /Reference assignment for this submission|本次参考职责|tail_character_prompt_review_data/u);
  assert.doesNotMatch(binding, /requestTextModel|repairH3PromptProtocolWithAi|reviewVideoTailCharacterPrompt|reviewInput/u);
});

test('all original reference controls remain available', () => {
  for (const label of ['选择参考图', '复制上段选图', '用上段尾帧', '本地末帧＋参考图', '一键末帧＋参考图']) {
    assert.ok(view.includes(label), `missing original control: ${label}`);
  }
  assert.ok(nodes(viewAst).filter(ts.isIdentifier).some((node) => node.text === 'prepareVideoTailCharacterDraft'),
    'local image/slot binding remains available');
});

test('tail-reference picker copy does not falsely require identities in every additional slot', () => {
  assert.doesNotMatch(view, /这里选择人物参考图|第2槽起固定人物|人物从槽2开始|一键末帧＋人物参考/u);
  assert.match(view, /默认.*人物/u);
  assert.match(view, /场景.*(?:其它|其他)|(?:其它|其他).*场景/u);
});

console.log(`local tail/reference no-regeneration wiring: ${tests} cases passed; no API requests`);
