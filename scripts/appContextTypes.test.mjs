import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const appPath = new URL("../src/App.tsx", import.meta.url);
const sourceText = readFileSync(appPath, "utf8");
const sourceFile = ts.createSourceFile(
  appPath.pathname,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const descendants = (root, predicate) => {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
};

const arrowDeclaration = (name) => {
  const declaration = descendants(sourceFile, (node) => ts.isVariableDeclaration(node)
    && node.name.getText(sourceFile) === name && ts.isArrowFunction(node.initializer))[0];
  assert.ok(declaration, `${name} arrow handler should exist`);
  return declaration.initializer;
};
const callsNamed = (root, name) => descendants(root, (node) => ts.isCallExpression(node)
  && node.expression.getText(sourceFile) === name);
const isInsideTryBlock = (node, root) => {
  for (let parent = node.parent; parent && parent !== root.parent; parent = parent.parent) {
    if (ts.isTryStatement(parent) && node.pos >= parent.tryBlock.pos && node.end <= parent.tryBlock.end) return true;
  }
  return false;
};

test("app context wiring is checked by TypeScript instead of any", () => {
  const anyTypedConsumers = descendants(
    sourceFile,
    (node) => ts.isFunctionDeclaration(node)
      && node.parameters[0]?.name.getText(sourceFile) === "ctx"
      && node.parameters[0]?.type?.kind === ts.SyntaxKind.AnyKeyword,
  ).map((node) => node.name.text);

  assert.deepEqual(anyTypedConsumers, []);
  assert.equal(
    descendants(
      sourceFile,
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "getContextShape",
    ).length,
    0,
  );
});

test("the app context object is checked against the shared context contract", () => {
  const appContext = descendants(
    sourceFile,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "appContext",
  )[0];

  assert.ok(appContext, "appContext declaration should exist");
  assert.ok(
    appContext.initializer && ts.isSatisfiesExpression(appContext.initializer),
    "appContext must use `satisfies AppContext` so missing wiring fails compilation",
  );
});

test("StoryView does not request the removed setActiveSceneId binding", () => {
  const storyView = descendants(
    sourceFile,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "StoryView",
  )[0];
  const staleBindings = descendants(
    storyView,
    (node) => ts.isBindingElement(node) && node.name.getText(sourceFile) === "setActiveSceneId",
  );

  assert.equal(staleBindings.length, 0);
});

test("StoryView has two explicit preparation actions, reversible results and one analysis action", () => {
  const storyView = descendants(sourceFile, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'StoryView')[0];
  const attributes = (node) => new Map(node.openingElement.attributes.properties
    .filter(ts.isJsxAttribute).map((attribute) => [attribute.name.getText(sourceFile), attribute.initializer]));
  const actions = descendants(storyView, (node) => ts.isJsxElement(node)
    && attributes(node).get('className')?.text === 'row story-input-actions')[0];
  assert.ok(actions, 'story input action row should exist');
  const actionSource = actions.getText(sourceFile);
  const buttons = descendants(actions, (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'Button');
  assert.equal(buttons.length, 5, 'expand, optimize, optional restore, clear and analysis remain available');
  for (const [label, mode] of [['AI扩写', 'expand'], ['AI剧情优化', 'optimize']]) {
    const matches = buttons.filter((button) => attributes(button).get('title')?.text === label);
    assert.equal(matches.length, 1, `${label} has one direct button`);
    const buttonAttributes = attributes(matches[0]);
    const calls = descendants(buttonAttributes.get('onClick'), (node) => ts.isCallExpression(node)
      && node.expression.getText(sourceFile) === 'handleExpandStory');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.length, 1);
    assert.equal(calls[0].arguments[0].text, mode, `${label} must pass its own literal mode, not a stale dropdown value`);
    assert.match(buttonAttributes.get('disabled').getText(sourceFile), /!storyInput\.trim\(\) \|\| busy \|\| storyExpansionBusy/u);
  }
  assert.equal(descendants(actions, (node) => ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'handleExpandStory').length, 2);
  assert.equal((actionSource.match(/onClick=\{handleAnalyzeStory\}/gu) || []).length, 1);
  assert.doesNotMatch(actionSource, /AI 剧情处理方式|<select|story-preparation-mode/u, 'mode dropdown is intentionally removed');
  assert.match(actionSource, /canRestoreStoryPreparation &&/u);
  assert.match(actionSource, /onClick=\{handleRestoreStoryPreparation\}/u);
  assert.match(actionSource, /解析并补全/u);
  assert.doesNotMatch(actionSource, /AI 增强补全|AI 补全中/u);
  assert.ok(
    actionSource.indexOf('AI扩写') < actionSource.indexOf('AI剧情优化')
      && actionSource.indexOf('AI剧情优化') < actionSource.indexOf('还原处理前文本')
      && actionSource.indexOf('还原处理前文本') < actionSource.indexOf('清空')
      && actionSource.indexOf('清空') < actionSource.indexOf('解析并补全'),
    "story actions remain expand, optimize, optional restore, clear, then analysis",
  );
});

test("AI preparation uses the clicked mode and enabled rules while preserving request and draft protections", () => {
  const declaration = descendants(sourceFile, (node) => ts.isVariableDeclaration(node)
    && node.name.getText(sourceFile) === 'handleExpandStory')[0];
  assert.ok(declaration && ts.isArrowFunction(declaration.initializer), 'shared AI preparation handler should exist');
  const handler = declaration.initializer;
  assert.equal(handler.parameters.length, 1);
  assert.equal(handler.parameters[0].name.getText(sourceFile), 'requestMode');
  assert.equal(handler.parameters[0].type.getText(sourceFile), 'StoryPreparationMode');
  const actionSource = handler.body.getText(sourceFile);

  assert.match(actionSource, /storyExpansionPresets/u);
  assert.match(actionSource, /defaultStoryExpansionPresetId/u);
  assert.match(actionSource, /\.enabled/u);
  assert.match(
    actionSource,
    /requestStoryPreparationWithReview\([\s\S]*?settings\.textApi,[\s\S]*?sourceStory,[\s\S]*?requestController\.signal,[\s\S]*?expansionPreset,[\s\S]*?requestMode/u,
  );
  const preparationCall = callsNamed(handler.body, 'requestStoryPreparationWithReview')[0];
  assert.equal(preparationCall.arguments.length, 6,
    'the preparation request must carry the optional expansion target without dropping the full source');
  assert.equal(preparationCall.arguments[1].getText(sourceFile), 'sourceStory',
    'AI expansion must receive the complete source draft, not a local summary or excerpt');
  assert.equal(preparationCall.arguments[4].getText(sourceFile), 'requestMode',
    'the clicked action must select optimize versus expand at the request boundary');
  assert.equal(preparationCall.arguments[5].getText(sourceFile), 'requestedTargetLength',
    'the custom target length must be passed only as AI guidance to the expansion service');
  assert.match(actionSource, /const requestedTargetLength = requestMode === ["']expand["']/u,
    'optimization must not accidentally inherit the expansion length field');
  assert.match(sourceText, /useState<StoryPreparationMode>\("optimize"\)/u);
  assert.equal(callsNamed(handler.body, 'requestStoryPreparationWithReview').length, 1, 'both actions use the single explicit-mode request and review API');
  assert.equal(callsNamed(handler.body, 'requestStoryPreparation').length, 0, 'the UI cannot bypass review by calling the compatibility string wrapper');
  assert.match(actionSource, /if \(storyExpansionAbortRef\.current \|\| busy\) return/u);
  assert.match(actionSource, /storyPreparationModeRef\.current = requestMode/u);
  assert.match(actionSource, /requestController\.signal\.aborted/u);
  assert.match(actionSource, /requestEpoch !== workspaceEpochRef\.current/u);
  assert.match(actionSource, /isCurrentProjectOperation\(requestProjectId, stateRef\.current\.project\.id\)/u);
  assert.match(actionSource, /isCurrentOperationIdentity\(requestIdentity, storyExpansionIdentityRef\.current\)/u);
  assert.match(actionSource, /hasCurrentPreparationSettings\(\)/u);
  assert.match(actionSource, /reportRuntimeError\(["']story-preparation["'], error\)/u, 'non-stale AI preparation failures must stay in the runtime error log');
  assert.match(actionSource, /setStoryPreparationUndo\(\{ projectId: requestProjectId, before: sourceStory, after: expandedStory \}\)/u);
  assert.doesNotMatch(actionSource, /persistPrimarySourceDocument\(|handleAnalyzeStory\(|setState\(/u, 'processing only changes the input draft; save/analyze still requires user action');
  assert.match(sourceText, /storyPreparationUndo\.after === storyInput/u, 'restore must not replace text the user has edited after processing');
  assert.doesNotMatch(actionSource, /年龄|成年|未成年|\bage\b/iu);
});

test('every optimization result is pending user review before any editor write, including zero-warning results', () => {
  const handler = arrowDeclaration('handleExpandStory');
  const optimization = descendants(handler.body, (node) => ts.isIfStatement(node)
    && /^requestMode === ["']optimize["']$/u.test(node.expression.getText(sourceFile)))[0];
  assert.ok(optimization && ts.isBlock(optimization.thenStatement));
  const branch = optimization.thenStatement;
  const branchSource = branch.getText(sourceFile);
  assert.match(branchSource, /pendingStoryReviewRef\.current = review/u);
  assert.match(branchSource, /setPendingStoryReview\(review\)/u);
  assert.match(branchSource, /setStoryReviewOpen\(true\)/u);
  assert.match(branchSource, /result:\s*preparationResult/u);
  assert.match(branchSource, /before:\s*sourceStory/u);
  assert.ok(ts.isReturnStatement(branch.statements.at(-1)), 'optimization must leave the handler before the separate expansion draft-write path');
  assert.doesNotMatch(branchSource, /\b(?:setStoryInput|setStoryName|setStoryPreparationUndo|setState|persistPrimarySourceDocument|handleAnalyzeStory)\s*\(/u);
  assert.doesNotMatch(branchSource, /if\s*\([^)]*warnings/u, 'warning count must not decide whether a user preview is required');
  const editorWrites = callsNamed(handler.body, 'setStoryInput');
  assert.equal(editorWrites.length, 1, 'only the existing expansion branch may directly replace the editor');
  assert.ok(editorWrites[0].pos > optimization.end);

  const adopt = arrowDeclaration('adoptStoryReview').body.getText(sourceFile);
  for (const guard of ['review.id !== expectedId', 'review.projectId !== stateRef.current.project.id',
    'review.workspaceEpoch !== workspaceEpochRef.current', 'review.before !== currentDraft.storyInput',
    'review.sourceName !== currentDraft.storyName', 'storyExpansionAbortRef.current']) {
    assert.ok(adopt.includes(guard), `adoption must recheck ${guard} at click time`);
  }
  assert.match(adopt, /setStoryInput\(review\.result\.text\)/u, 'adoption uses the actual AI text, not a local rewrite');
  assert.match(adopt, /setStoryPreparationUndo\(\{ projectId: review\.projectId, before: review\.before, after: review\.result\.text \}\)/u);
  assert.ok(adopt.indexOf('pendingStoryReviewRef.current = null') < adopt.indexOf('setStoryInput('), 'consume the preview before writing so duplicate clicks cannot apply twice');
  assert.doesNotMatch(adopt, /\b(?:setState|persistPrimarySourceDocument|handleAnalyzeStory)\s*\(/u, 'adopting does not save or analyze without another user action');

  const keep = arrowDeclaration('keepOriginalStoryReview').body.getText(sourceFile);
  assert.match(keep, /pendingStoryReviewRef\.current = null/u);
  assert.doesNotMatch(keep, /\b(?:setStoryInput|setStoryName|setState|persistPrimarySourceDocument)\s*\(|storyDraftRef\.current\s*=/u,
    'declining a pending result only dismisses it and cannot restore a stale original over newer user edits');
  const reviewDialogs = descendants(sourceFile, (node) => ts.isJsxSelfClosingElement(node)
    && node.tagName.getText(sourceFile) === 'StoryPreparationReviewDialog');
  assert.equal(reviewDialogs.length, 1);
  assert.match(reviewDialogs[0].getText(sourceFile), /onAdopt=\{\(\) => adoptStoryReview\(pendingStoryReview\.id\)\}/u);
  assert.match(reviewDialogs[0].getText(sourceFile), /stale=\{storyReviewStale \|\| busy \|\| storyExpansionBusy\}/u);
});

test('all state snapshot and export boundaries use compact persistence with caught synchronous size errors', () => {
  const keyboard = arrowDeclaration('onKeyDown');
  const keyboardSerializers = callsNamed(keyboard, 'serializeStateForStorage');
  assert.equal(keyboardSerializers.length, 1);
  assert.equal(keyboardSerializers[0].arguments[0].getText(sourceFile), 'stateRef.current');
  assert.ok(isInsideTryBlock(keyboardSerializers[0], keyboard), 'Ctrl+S must catch a synchronous serialization/size failure');
  assert.match(keyboard.body.getText(sourceFile), /catch\s*\(error\)\s*\{\s*setNotice\(/u);
  assert.doesNotMatch(keyboard.body.getText(sourceFile), /JSON\.stringify\(stateRef\.current\)/u);

  const sourceSnapshot = arrowDeclaration('sourceDraftSnapshot');
  const snapshotSerializers = callsNamed(sourceSnapshot, 'serializeStateForStorage');
  assert.equal(snapshotSerializers.length, 1);
  assert.match(snapshotSerializers[0].arguments[0].getText(sourceFile), /^withProjectLibrary\(/u,
    'source-cleanup snapshots must first synchronize the draft with its project library');
  const sourceIntegrity = arrowDeclaration('resolveSourceIntegrityForAction');
  const snapshotCalls = callsNamed(sourceIntegrity, 'sourceDraftSnapshot');
  assert.equal(snapshotCalls.length, 1);
  assert.ok(isInsideTryBlock(snapshotCalls[0], sourceIntegrity), 'a failed compact draft snapshot cannot escape as an unhandled promise rejection');
  assert.match(sourceIntegrity.body.getText(sourceFile), /catch\s*\(error\)\s*\{\s*(?:if\s*\(!isCurrent\(\)\)\s*return undefined;\s*)?notify\([\s\S]*?return undefined;/u,
    'failure to back up the original must cancel the cleanup operation');

  const manualSnapshot = arrowDeclaration('createRestorePoint');
  const manualSerializers = callsNamed(manualSnapshot, 'serializeStateForStorage');
  assert.equal(manualSerializers.length, 1);
  assert.equal(manualSerializers[0].arguments[0].getText(sourceFile), 'state');
  assert.ok(isInsideTryBlock(manualSerializers[0], manualSnapshot));

  const exporter = arrowDeclaration('handleExportProject');
  const exportSerializers = callsNamed(exporter, 'serializeStateForStorage');
  assert.equal(exportSerializers.length, 2, 'desktop package and browser JSON exports both use the same compact envelope');
  for (const serializer of exportSerializers) {
    assert.equal(serializer.arguments[0].getText(sourceFile), 'safeState');
    assert.ok(isInsideTryBlock(serializer, exporter));
  }
  assert.match(exporter.body.getText(sourceFile), /safeState\.projects = \[safeState\.project\]/u,
    'single-project export must not mix unrelated library projects into the package');
  const jsonDownload = callsNamed(exporter, 'downloadText')[0];
  assert.ok(jsonDownload);
  assert.equal(jsonDownload.arguments[1].getText(sourceFile), 'serializeStateForStorage(safeState).serialized',
    'pretty-printing or re-expanding project aliases must not exceed the size accepted for saving');
  assert.match(exporter.body.getText(sourceFile), /content:\s*serializeStateForStorage\(safeState\)\.serialized/u);
  assert.equal(callsNamed(sourceFile, 'serializeStateForStorage').length, 5,
    'Ctrl+S, source cleanup, desktop export, JSON export and manual recovery are all protected');
});

test("Rule Center exposes independent editable story preparation rules with compatible saved IDs", () => {
  const rulesStart = sourceText.indexOf("function RulesView(ctx: AppContext) {");
  const rulesEnd = sourceText.indexOf("function GenerationTasksView", rulesStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart, "RulesView should exist");
  const rulesSource = sourceText.slice(rulesStart, rulesEnd);

  assert.match(rulesSource, /ruleTab === ["']expansions["']/u);
  assert.match(rulesSource, /AI 剧情优化规则/u);
  assert.match(rulesSource, /storyExpansionPresets/u);
  assert.match(rulesSource, /updateStoryExpansion/u);
  assert.match(rulesSource, /defaultStoryExpansionPresetId/u);
  assert.match(rulesSource, /剧情处理规则/u);
  assert.match(rulesSource, /输出规则/u);

  const defaultStart = rulesSource.indexOf("const setDefault = () => {");
  const defaultEnd = rulesSource.indexOf("return (", defaultStart);
  assert.ok(defaultStart >= 0 && defaultEnd > defaultStart, "default preset handler should exist");
  const defaultSource = rulesSource.slice(defaultStart, defaultEnd);
  assert.match(defaultSource, /storyExpansionPresets/u);
  assert.match(defaultSource, /enabled: true/u);
});
