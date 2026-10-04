import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sanitizeFinalImagePrompt, type ImagePromptFormat } from '../src/imagePromptRules';
import {
  normalizePrivateSingleImagePrompt,
  ordinaryImageVariantConverterRule,
  privateImagePromptProblem,
  privateImageVariantConverterRule as buildPrivateImageVariantConverterRule,
  privateImageVariantRepairRule,
} from '../src/imageGeneration';

// Exercise the production shared converter Promise, not a copied regex.
// No network, images, credentials, or user data are involved.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer: ts.Expression | undefined;
let privateRulesInitializer: ts.Expression | undefined;
let converterRulesInitializer: ts.Expression | undefined;
const visit = (node: ts.Node): void => {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === 'batchConvertedPrompt'
    && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) initializer = node.right;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (node.name.text === 'privateVariantConverterRule') privateRulesInitializer = node.initializer;
    if (node.name.text === 'converterRules' && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === 'buildImagePromptConverterSystemPrompt') converterRulesInitializer = node.initializer;
  }
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(initializer, 'the production shared converter must be available');
assert.ok(privateRulesInitializer && converterRulesInitializer, 'the production variant rules must be available');
const rulesCompiled = ts.transpileModule(`const privateVariantConverterRule = ${privateRulesInitializer.getText(ast)}; const rules = ${converterRulesInitializer.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const rulesFor = new Function('requestedImageVariant', 'requestedNsfwPrivatePart', 'requestedPrivateOutputLabel',
  'imagePromptSelection', 'buildImagePromptConverterSystemPrompt', 'privateImageVariantConverterRule', 'ordinaryImageVariantConverterRule', `${rulesCompiled}\nreturn rules;`) as (
    variant: string, part: string | undefined, label: string, selection: unknown,
    build: (selection: unknown, rules: string) => string, privateRule: typeof buildPrivateImageVariantConverterRule, ordinaryRule: typeof ordinaryImageVariantConverterRule,
  ) => string;
const productionRules = (variant: string) => rulesFor(variant, variant.startsWith('private-') ? 'body' : undefined,
  '测试视图', {}, (_selection, rules) => rules, buildPrivateImageVariantConverterRule, ordinaryImageVariantConverterRule);
const compiled = ts.transpileModule(`const result = ${initializer.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
// This converter-only fixture owns an active task. Queue revocation and its
// real state boundary are covered by queuedGenerationTasks and the App UI QA.
const activeQueueFixture = `const imageBatchTaskIsActive = () => true;
const getCurrentState = () => undefined;
const requestedProjectId = 'converter-only-fixture';
const task = {};`;
const run = new Function('requestImagePromptConverter', 'requestedTextApi', 'requestedImagePromptAssetKind',
  'conversionSource', 'imagePromptSelection', 'converterRules', 'requestedImageVariant', 'requestedNsfwPrivatePart',
  'sanitizeFinalImagePrompt', 'normalizePrivateSingleImagePrompt', 'privateImagePromptProblem',
  'privateImageVariantRepairRule', `${activeQueueFixture}\n${compiled}\nreturn result;`) as (
    request: (...args: unknown[]) => Promise<string>, config: unknown, kind: string, input: string,
    selection: { ruleSet: { format: ImagePromptFormat } }, rules: string, variant: string, part: string | undefined,
    sanitize: typeof sanitizeFinalImagePrompt, normalize: typeof normalizePrivateSingleImagePrompt,
    problem: typeof privateImagePromptProblem, repair: typeof privateImageVariantRepairRule,
  ) => Promise<string>;
const convert = (reply: string, variant: string, format: ImagePromptFormat = 'natural-language', failure?: Error) => {
  const calls: unknown[][] = [];
  const pending = run(async (...args: unknown[]) => { calls.push(args); if (failure) throw failure; return reply; },
    { enabled: true, model: 'mock-only' }, variant === 'private-turnaround' ? 'character-private' : 'character',
    '完整的原始人物资料，原样交给转换器。', { ruleSet: { format } }, productionRules(variant), variant,
    variant.startsWith('private-') ? 'full-body' : undefined,
    sanitizeFinalImagePrompt, normalizePrivateSingleImagePrompt, privateImagePromptProblem, privateImageVariantRepairRule);
  return { calls, pending };
};

let cases = 0;
for (const variant of ['turnaround', 'private-turnaround']) {
  const rules = productionRules(variant);
  for (const expected of [/四视图/u, /正面/u, /90\s*度左侧面/u, /背面/u, /45\s*度前(?:侧)?三分之四/u, /中性灰无缝背景/u]) {
    assert.match(rules, expected, `${variant} must send ${expected} to the converter`);
  }
  for (const reply of [
    '四视图角色设定板：正面、左侧面、背面、45度前三分之四，正交投影，中性灰背景。不使用绿幕。',
    '四个同一角色的完整视图排列在灰色背景上。不要绿幕，也不要三视图，不使用绿色背景。',
    'Four views of one neutral display mannequin: frontal, left profile, rear and three-quarter, orthographic, neutral gray backdrop, without green screen; not three views.',
    '四个完整轮廓：正对镜头、向左侧身、背对镜头及斜前方。采用平行投影、灰底，不用绿色背景。',
  ]) {
    const { calls, pending } = convert(reply, variant);
    assert.equal(await pending, sanitizeFinalImagePrompt(reply, 'natural-language'));
    assert.equal(calls.length, 1, 'local wording must not trigger semantic repair or another model call');
    assert.equal(calls[0][2], '完整的原始人物资料，原样交给转换器。');
    assert.equal(calls[0][4], rules, 'the production variant constraints reach the actual converter request');
    cases += 1;
  }
  const empty = convert(' \n\t ', variant);
  await assert.rejects(empty.pending, /最终生图提示词为空/u);
  assert.equal(empty.calls.length, 1, 'technical empty-result checks remain'); cases += 1;
  const transport = new Error('mock model connection failure'); const failed = convert('', variant, 'natural-language', transport);
  await assert.rejects(failed.pending, (error) => error === transport);
  assert.equal(failed.calls.length, 1); cases += 1;
}
assert.doesNotMatch(initializer.getText(ast), /fourViewProblem|firstFourViewProblem|repairedFourViewProblem/u,
  'four-view content semantics must not be reintroduced as local submission gates');
assert.doesNotMatch(productionRules('full-body'), /四视图|恰好四个/u,
  'ordinary single-image variants must not inherit the four-view layout');
console.log(`Four-view permissive converter: ${cases} production-path cases passed; no local semantic retries or live calls.`);
