import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  checkStoryboardContinuity,
  estimateDialogueDurationSec,
  type ContinuityShotLike
} from '../src/continuity';
import { buildGenerationPlan } from '../src/generationPlan';
import { videoBatchCandidateWillSubmit } from '../src/videoBatchSelection';
import {
  comparePromptText,
  compareStoryboardRevisions,
  createABCandidates,
  createStoryboardRevision
} from '../src/storyboardVersions';

const shot = (overrides: Partial<ContinuityShotLike> & Pick<ContinuityShotLike, 'id' | 'startSec' | 'endSec'>): ContinuityShotLike => ({
  purpose: '保持连续', subject: 'Alice', action: '站立', camera: '固定', transition: '', lighting: '3200K 暖光',
  sound: '', result: '', referenceAssetIds: [], ...overrides
});

const healthy = [
  shot({ id: 's1', startSec: 0, endSec: 3, appearanceAnchor: '黑发，蓝外套', scene: 'room', propStates: { key: 'closed' }, motionDirection: 'left-to-right', dialogueText: '好。' }),
  shot({ id: 's2', startSec: 3, endSec: 6, appearanceAnchor: '黑发，蓝外套', scene: 'room', propStates: { key: 'closed' }, motionDirection: 'left-to-right' })
];
assert.equal(checkStoryboardContinuity({ durationSec: 6, shots: healthy }).valid, true);

const negativeStartReport = checkStoryboardContinuity([
  shot({ id: 'negative-start', startSec: -0.001, endSec: 1 }),
], { toleranceSec: 0.05 });
const negativeStartIssue = negativeStartReport.issues.find((issue) => issue.code === 'invalid-range');
assert.equal(negativeStartReport.valid, false, 'a negative shot start must not be accepted within timeline tolerance');
assert.equal(negativeStartIssue?.message, 'Shot negative-start has an invalid time range.');
assert.deepEqual(negativeStartIssue?.shotIds, ['negative-start']);
assert.deepEqual(negativeStartIssue?.details, { start: -0.001, end: 1 });

const broken = [
  shot({ id: 'a', startSec: 0, endSec: 2, subject: 'Alice', scene: 'room', appearanceAnchor: '黑发蓝外套', propStates: { key: 'closed' }, lighting: '3000K 暖光', motionDirection: 'left-to-right', dialogueText: '这是一个非常非常长的对白，需要超过镜头时长才能说完。' }),
  shot({ id: 'b', startSec: 1.5, endSec: 2.5, subject: 'Bob', scene: 'street', appearanceAnchor: '金发红斗篷', propStates: { key: 'open' }, lighting: '6500K 冷蓝光', motionDirection: 'right-to-left', referenceAssetIds: ['r1', 'r2'] })
];
const brokenReport = checkStoryboardContinuity({ durationSec: 2.5, shots: broken }, {
  requireAnchorEveryShot: true,
  assets: [{ id: 'r1', type: 'image' }, { id: 'r2', type: 'image' }],
  target: { targetId: 'demo', maxReferencesPerShot: 1 }
});
assert.ok(brokenReport.issues.some((issue) => issue.code === 'time-overlap'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'subject-change'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'scene-jump'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'prop-state-change'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'lighting-jump'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'axis-conflict'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'dialogue-overflow'));
assert.ok(brokenReport.issues.some((issue) => issue.code === 'reference-limit'));
assert.equal(brokenReport.valid, false);

const referenceReport = checkStoryboardContinuity({
  durationSec: 2,
  shots: [shot({ id: 'reference-shot', startSec: 0, endSec: 2, referenceAssetIds: ['missing', 'known-image', 'known-video'] })],
}, {
  assets: [
    { id: 'known-image', type: 'image' },
    { id: 'known-video', type: 'video' },
  ],
  target: {
    targetId: 'reference-test',
    maxReferencesPerShot: 1,
    maxImageReferencesPerShot: 0,
    maxVideoReferencesPerShot: 0,
    supportedMediaTypes: ['video'],
  },
});
const referenceLimitIssues = referenceReport.issues.filter((issue) => issue.code === 'reference-limit');
assert.equal(new Set(referenceLimitIssues.map((issue) => issue.id)).size, referenceLimitIssues.length);
assert.equal(
  referenceLimitIssues.find((issue) => issue.details?.mediaType === 'image')?.details?.count,
  1,
  'a missing asset must not be counted as an image reference',
);
assert.equal(
  referenceReport.issues.some((issue) => issue.code === 'reference-type-unsupported' && issue.details?.assetId === 'missing'),
  false,
  'unknown assets should only produce the dedicated reference-missing issue',
);

assert.ok(estimateDialogueDurationSec('这是一段需要时间的对白。') > 1);
assert.equal(
  estimateDialogueDurationSec('一路，向前，不要，回头。'),
  estimateDialogueDurationSec('一路向前不要回头'),
  'adding commas and sentence punctuation must not increase continuity dialogue duration',
);

const plan = buildGenerationPlan([
  shot({ id: 'p1', index: 1, startSec: 0, endSec: 2, action: '静止' }),
  shot({ id: 'p2', index: 2, startSec: 2, endSec: 12, action: '爆炸后高速追逐', referenceAssetIds: ['img', 'vid'] }),
  shot({ id: 'p3', index: 3, startSec: 12, endSec: 15, action: '收束' })
], {
  targetId: 'demo', pilotShotCount: 1, batchSize: 1,
  target: { id: 'demo', maxReferencesPerShot: 3, unitsPerSecond: 2, baseUnitsPerShot: 1, unitsPerReference: 0.5 }
});
assert.deepEqual(plan.pilotShotIds, ['p2']);
assert.equal(plan.batches[0].kind, 'pilot');
assert.equal(plan.shots.find((item) => item.shotId === 'p2')?.referenceCount, 2);
assert.equal(plan.totalEstimatedUnits, 34);
assert.equal(plan.batches.length, 3);

const planWithEmptyReferences = buildGenerationPlan([
  shot({ id: 'empty-reference-shot', startSec: 0, endSec: 2, referenceAssetIds: ['', 'image-1', ''] }),
]);
assert.equal(planWithEmptyReferences.totalReferenceCount, 1);
assert.equal(planWithEmptyReferences.uniqueReferenceCount, 1);

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appEffectsSource = readFileSync(new URL('../src/appEffects.ts', import.meta.url), 'utf8');
const videoGenerationSource = readFileSync(new URL('../src/videoGeneration.ts', import.meta.url), 'utf8');
const videoDraftSource = readFileSync(new URL('../src/videoDirectorDraft.ts', import.meta.url), 'utf8');
const videoViewSource = readFileSync(new URL('../src/components/VideoDirectorView.tsx', import.meta.url), 'utf8');
const videoDirectorViewStart = videoViewSource.indexOf('export function VideoDirectorView(');
assert.ok(videoDirectorViewStart >= 0, 'VideoDirectorView function must remain available');
// VideoTaskCard is intentionally still defined in this module for the shared
// generation-task page, so placement assertions must inspect only the director
// function declared at the end of the module.
const videoDirectorViewFunctionSource = videoViewSource.slice(videoDirectorViewStart);
assert.doesNotMatch(
  appSource,
  /分析并拆段|analyzeAndCreateSequencePlan/u,
  'the hidden one-click analysis and segmentation flow must be removed completely',
);
for (const requiredAction of [
  'generateSequenceMasterPrompt',
  'updateSequenceMasterPrompt',
  'confirmSequenceMasterPrompt',
  'segmentConfirmedMasterPrompt',
]) {
  assert.equal(
    appSource.includes(requiredAction),
    true,
    `the visible three-stage flow must expose ${requiredAction}`,
  );
}
for (const visibleLabel of [
  '① 生成全片总提示词',
  '确认总提示词',
  '② AI 按剧情边界分段',
  '确认分段，进入③单段导演',
]) {
  assert.equal(appSource.includes(visibleLabel), true, `missing visible planning action: ${visibleLabel}`);
}

assert.match(
  appSource,
  /directorSettingsFingerprint/u,
  'the long-story flow must derive a stable fingerprint from the visible director settings',
);
assert.match(
  appSource,
  /confirmDirectorSettings/u,
  'the long-story flow must expose an explicit director-settings confirmation action',
);
const generateMasterGuardStart = appSource.indexOf('const generateSequenceMasterPrompt = async () => {');
const generateMasterGuardEnd = appSource.indexOf('const updateSequenceMasterPrompt =', generateMasterGuardStart);
assert.ok(generateMasterGuardStart >= 0 && generateMasterGuardEnd > generateMasterGuardStart);
const generateMasterGuardSource = appSource.slice(generateMasterGuardStart, generateMasterGuardEnd);
assert.match(
  generateMasterGuardSource,
  /directorSettingsConfirmed[\s\S]*?return;/u,
  'master generation must stop before building a prompt when director settings were not explicitly confirmed',
);
assert.match(
  generateMasterGuardSource,
  /masterPromptDirectorSettingsFingerprint/u,
  'the generated master plan must persist the settings snapshot that produced it',
);
assert.match(
  appSource,
  /全片导演参数/u,
  'the planning UI must identify the director parameters that feed the master prompt',
);

const sourceBetween = (startToken: string, endToken: string): string => {
  const start = appSource.indexOf(startToken);
  const end = appSource.indexOf(endToken, start);
  assert.ok(start >= 0 && end > start, `source block must exist between ${startToken} and ${endToken}`);
  return appSource.slice(start, end);
};

const videoTaskCardSource = videoViewSource.slice(
  videoViewSource.indexOf('export function VideoTaskCard('),
  videoViewSource.indexOf('const cloneVideoReferences ='),
);
assert.doesNotMatch(videoTaskCardSource, /<video\b/u, 'generation-task video cards must not mount a playable video element');
assert.match(videoTaskCardSource, /vd-task-thumbnail[\s\S]*?<img/u, 'generation-task video cards must use a static thumbnail image');

const visualStylesImport = appSource.match(
  /import\s*\{[^}]*\}\s*from\s*["']\.\/visualStyles["'];?/u,
)?.[0] || '';
assert.match(
  visualStylesImport,
  /visualStyleDefinitions/u,
  'App must import the shared visual-style catalog instead of maintaining a local option list',
);
assert.match(
  visualStylesImport,
  /applyVisualStyleSelection/u,
  'App must import the pure visual-style/preset selection helper',
);
assert.match(
  appSource,
  /visualStyleFallback:\s*style\.name/u,
  'stored shot regeneration must use the resolved board style preset name when visualStyle is missing',
);
assert.equal(
  (appSource.match(/visualStyleFallback:\s*boardStylePreset\?\.name/gu) || []).length,
  2,
  'single-shot copy and preview must both use the resolved board style preset name as fallback',
);
assert.match(
  appSource,
  /updateDirectorLookDraft\(\{\s*visualStyle:\s*selection\.visualStyle,\s*styleId:\s*selection\.stylePresetId\s*\}\)/u,
  'visual-style input must persist its text and quietly repaired fallback preset ID together',
);
assert.match(
  visualStylesImport,
  /resolveVisualStyleSelectDisplay/u,
  'App must import the pure controlled-select display resolver',
);
assert.doesNotMatch(
  appSource,
  /const\s+visualStyleOptions\s*=/u,
  'App must not retain a duplicate visual-style option catalog',
);

const visualStyleControlSource = sourceBetween('id="director-setup-style"', 'id="director-setup-motion"');
assert.match(
  visualStyleControlSource,
  /visualStyleDefinitions\.map/u,
  'the visual-style selector must keep selectable shared catalog definitions',
);
assert.match(
  appSource,
  /const\s+visualStyleSelectDisplay\s*=\s*resolveVisualStyleSelectDisplay\(visualStyle\)/u,
  'the controlled visual-style input must derive its display value without mutating loaded project state',
);
assert.match(
  visualStyleControlSource,
  /value=\{visualStyleSelectDisplay\.value\}/u,
  'saved catalog IDs must display through their canonical input value',
);
assert.doesNotMatch(
  visualStyleControlSource,
  /value=\{visualStyle\}/u,
  'the controlled input must not expose stored IDs as user-facing visual style text',
);
assert.match(
  visualStyleControlSource,
  /onChange=\{\(event\)\s*=>\s*handleVisualStyleSelection\(event\.target\.value\)\}/u,
  'visual-style edits must enter the shared selection-normalization path',
);
assert.match(
  visualStyleControlSource,
  /className="director-choice-combo"[\s\S]*aria-label="选择导演分类"[\s\S]*className="director-choice-combo"[\s\S]*aria-label="选择导演风格"[\s\S]*className="director-choice-combo"[\s\S]*aria-label="选择视觉风格"/u,
  'director style fields must expose real clickable select controls next to custom text inputs',
);
assert.doesNotMatch(
  visualStyleControlSource,
  /<Field label="风格预设">/u,
  'the director parameter card must not expose the redundant style-preset selector',
);
assert.match(
  visualStyleControlSource,
  /AI 分析填写/u,
  'the style card must expose an AI analysis fill action',
);
assert.match(
  appSource,
  /const analyzeDirectorLookSettings = async \(\) => \{[\s\S]*requestDirectorLookAutofill/u,
  'the AI analysis fill action must call the text-model director look autofill helper',
);
assert.match(
  visualStyleControlSource,
  /<input[\s\S]*value=\{directorStyleName\}[\s\S]*<select[\s\S]*aria-label="选择导演风格"[\s\S]*applyDirectorStylePresetToControls\(event\.target\.value\)/u,
  'director style must be a custom text input with selectable presets',
);

const visualSelectionStart = appSource.indexOf('const handleVisualStyleSelection =');
const visualSelectionEnd = appSource.indexOf('const analyzeDirectorLookSettings =', visualSelectionStart);
assert.ok(
  visualSelectionStart >= 0 && visualSelectionEnd > visualSelectionStart,
  'the director view must expose a bounded visual-style selection handler',
);
const visualSelectionSource = appSource.slice(visualSelectionStart, visualSelectionEnd);
assert.match(
  visualSelectionSource,
  /const\s+availablePresetIds\s*=\s*state\.stylePresets\.map\([\s\S]*?preset\.id[\s\S]*?\)[\s\S]*?applyVisualStyleSelection\(\s*value,\s*availablePresetIds,\s*styleId,?\s*\)/u,
  'the visual-style helper must receive the currently available preset IDs and current preset',
);
assert.match(
  visualSelectionSource,
  /updateDirectorLookDraft\(\{\s*visualStyle:\s*selection\.visualStyle,\s*styleId:\s*selection\.stylePresetId\s*\}\)/u,
  'a user edit must atomically save visual style text and the repaired hidden fallback preset',
);
assert.doesNotMatch(
  visualSelectionSource,
  /风格预设/u,
  'visual-style edits must not surface style-preset notices in the director card',
);

const rulesViewStart = appSource.indexOf('function RulesView(ctx: AppContext)');
const rulesViewEnd = appSource.indexOf('function GenerationTasksView(ctx: AppContext)', rulesViewStart);
assert.ok(rulesViewStart >= 0 && rulesViewEnd > rulesViewStart);
const rulesViewSource = appSource.slice(rulesViewStart, rulesViewEnd);
assert.match(
  rulesViewSource,
  /<strong>风格预设<\/strong>/u,
  'the rule center must still keep style-preset management for compatibility',
);
for (const imagePromptRuleCenterFeature of [
  '生图规则集',
  '生图分类预设',
  'imagePromptRules.ruleSets',
  'imagePromptRules.categoryPresets',
  'imagePromptRuleSetIdByBackend',
  'imagePromptPresetIdByAssetKind',
  'defaultRuleSetByBackend',
  '生图后端',
  '输出格式',
  '资产分类',
  '负面提示词',
]) {
  assert.equal(
    rulesViewSource.includes(imagePromptRuleCenterFeature),
    true,
    `the rule center must expose editable image-prompt management for ${imagePromptRuleCenterFeature}`,
  );
}
assert.match(
  rulesViewSource,
  /ruleTab\s*===\s*["']image-rules["'][\s\S]*?setRuleTab\(["']image-rules["']\)/u,
  'the image rule-set tab must be an explicit rule-center mode',
);
assert.match(
  rulesViewSource,
  /ruleTab\s*===\s*["']image-presets["'][\s\S]*?setRuleTab\(["']image-presets["']\)/u,
  'the image category-preset tab must be an explicit rule-center mode',
);
assert.match(
  rulesViewSource,
  /backend:\s*currentImageRule\.backend[\s\S]*?imagePromptRuleSetIdByBackend/u,
  'setting an image rule as default must bind its own backend in persisted settings',
);
assert.match(
  rulesViewSource,
  /assetKind:\s*currentImagePreset\.assetKind[\s\S]*?imagePromptPresetIdByAssetKind/u,
  'setting an image category preset as default must bind its own asset kind in persisted settings',
);
assert.match(
  rulesViewSource,
  /categoryPresetIds:\s*\[\.\.\.source\.categoryPresetIds\][\s\S]*?defaultPresetByAssetKind:\s*\{\s*\.\.\.source\.defaultPresetByAssetKind\s*\}/u,
  'copying an image rule set must not share mutable preset bindings with its source',
);
assert.match(
  rulesViewSource,
  /normalizeImagePromptRuleSet[\s\S]*?normalizeImagePromptCategoryPreset/u,
  'image rule-center imports must pass through the shared normalizers',
);
assert.match(
  rulesViewSource,
  /\bstyleId,\s*\n\s*updateDirectorLookDraft,/u,
  'the rule center must receive the live director style selection and persisted draft action so deletion can repair it',
);
const deleteCurrentStart = rulesViewSource.indexOf('const deleteCurrent =');
const deleteCurrentEnd = rulesViewSource.indexOf('const cloneCurrent =', deleteCurrentStart);
assert.ok(deleteCurrentStart >= 0 && deleteCurrentEnd > deleteCurrentStart);
const deleteCurrentSource = rulesViewSource.slice(deleteCurrentStart, deleteCurrentEnd);
assert.match(
  deleteCurrentSource,
  /if\s*\(state\.stylePresets\.length\s*<=\s*1\)[\s\S]*?至少保留一个风格预设[\s\S]*?return/u,
  'deleting the last style preset must remain blocked before any IDs are changed',
);
assert.match(
  deleteCurrentSource,
  /const\s+remainingStylePresets\s*=\s*state\.stylePresets\.filter\([\s\S]*?item\.id\s*!==\s*currentStyle\.id[\s\S]*?\)/u,
  'style deletion must derive every replacement ID from the real remaining preset list',
);
assert.match(
  deleteCurrentSource,
  /const\s+safeStylePresetId\s*=\s*remainingStylePresets\[0\]\?\.id\s*\|\|\s*""/u,
  'style deletion must choose a deterministic safe remaining preset',
);
assert.match(
  deleteCurrentSource,
  /const\s+nextDirectorStyleId\s*=\s*remainingStylePresets\.some\([\s\S]*?item\.id\s*===\s*styleId[\s\S]*?\)\s*\?\s*styleId\s*:\s*safeStylePresetId/u,
  'deleting an unrelated preset must preserve a valid director style while deleting the active one repairs it',
);
assert.match(
  deleteCurrentSource,
  /const\s+nextDefaultStylePresetId\s*=\s*remainingStylePresets\.some\([\s\S]*?item\.id\s*===\s*state\.settings\.defaultStylePresetId[\s\S]*?\)\s*\?\s*state\.settings\.defaultStylePresetId\s*:\s*safeStylePresetId/u,
  'deleting an unrelated preset must preserve a valid default style while deleting the default repairs it',
);
assert.match(
  deleteCurrentSource,
  /settings:\s*\{[\s\S]*?\.\.\.current\.settings,[\s\S]*?defaultStylePresetId:\s*nextDefaultStylePresetId[\s\S]*?\}/u,
  'style deletion must persist the repaired default style ID with the remaining presets',
);
assert.match(
  deleteCurrentSource,
  /updateDirectorLookDraft\(\{\s*styleId:\s*nextDirectorStyleId\s*\}\)[\s\S]*?setSelectedStyleId\(safeStylePresetId\)/u,
  'the persisted director selection and rule-center control must be synchronized to real remaining options',
);

const workspaceSyncStart = appSource.indexOf('const syncWorkspaceUiState = useCallback');
const workspaceSyncEnd = appSource.indexOf('  useEffect(() => {', workspaceSyncStart);
assert.ok(workspaceSyncStart >= 0 && workspaceSyncEnd > workspaceSyncStart);
const workspaceSyncSource = appSource.slice(workspaceSyncStart, workspaceSyncEnd);
assert.match(
  workspaceSyncSource,
  /const\s+loadedDirectorLook\s*=\s*resolveWorkspaceDirectorLook\(loadedState,\s*loadedDirectorSnapshot\)[\s\S]*?setStyleId\(loadedDirectorLook\.styleId\)/u,
  'loading a project must use the shared draft-first resolver for its director style preset',
);
assert.match(
  workspaceSyncSource,
  /const\s+nextVisualStyle\s*=\s*loadedDirectorLook\.visualStyle;[\s\S]*?setVisualStyle\(nextVisualStyle\)[\s\S]*?setAssetForm\(\{[\s\S]*?style:\s*nextVisualStyle\s*\|\|\s*"电影写实"/u,
  'loading a project must restore the prompt director visual style and seed the image workbench form from the same value',
);
assert.doesNotMatch(
  workspaceSyncSource,
  /applyVisualStyleSelection|handleVisualStyleSelection|updateDirectorLookDraft/u,
  'loading an old project must restore both saved controls without triggering user-only linkage',
);

const rebuildStoryboardSource = sourceBetween(
  'const rebuildStoryboard =',
  'const updateStoryboard =',
);
assert.match(
  rebuildStoryboardSource,
  /renderShotPrompt\(/u,
  'stored shot regeneration must continue rendering individual shot prompts',
);
assert.match(
  rebuildStoryboardSource,
  /visualStyle:\s*board\.visualStyle/u,
  'stored shot regeneration must pass the board visual style into renderShotPrompt',
);
assert.match(
  rebuildStoryboardSource,
  /visualStyleFallback:\s*style\.name/u,
  'stored shot regeneration must pass the resolved preset fallback into renderShotPrompt',
);
assert.match(
  rebuildStoryboardSource,
  /styleVisual:\s*style\.visual/u,
  'stored shot regeneration must pass the board visual style, resolved preset fallback, and editable visual rules into renderShotPrompt',
);
assert.match(
  rebuildStoryboardSource,
  /isOfficialH3TargetId\(rebuildTargetModelId\)[\s\S]*?return\s*\{[\s\S]*?targetOutput:\s*undefined/u,
  'rebuilding a non-H3 storyboard must preserve the selected target and invalidate its stale adapted artifact (including legacy H3 aliases)',
);
assert.match(
  rebuildStoryboardSource,
  /rebuildTargetModelId\s*=\s*configuredTargetModelId[\s\S]*?outputTargetModelId[\s\S]*?board\.officialPromptZh/u,
  'rebuild target resolution must prefer explicit target metadata before legacy H3 prompt inference',
);
assert.match(
  rebuildStoryboardSource,
  /try\s*\{[\s\S]*?applyOfficialH3Prompt\(/u,
  'only the resolved MiniMax H3 branch may invoke the official H3 compiler during rebuild',
);
assert.match(
  videoDraftSource,
  /isOfficialH3TargetId\(board\.targetModelId\)[\s\S]*?hasCurrentOfficialH3Prompt\(board, context\)/u,
  'the director prompt selector must resolve legacy H3 aliases and distinguish a current official artifact from its structured source',
);
assert.match(
  videoDraftSource,
  /hasCurrentOfficialH3EnglishPrompt\(board, context\)/u,
  'video prompt selection must not offer a stale or dialogue-changing English H3 cache',
);
assert.match(videoDirectorViewFunctionSource, /const delivery = useMemo\(\(\) => prepareVideoH3ReferenceDraft\(project, \{ \.\.\.draft,/u, 'the video director prepares the selected editable draft for its explicit reference bindings');
assert.match(videoDirectorViewFunctionSource, /await controller\.start\(\{\s*\.\.\.delivery\.draft/u, 'the video director must send that prepared draft through the shared controller');
assert.doesNotMatch(
  videoDirectorViewFunctionSource,
  /<VideoTaskCard|vd-task-section|data-video-task-id|taskLimit|pendingTaskFocus|project\.generationTasks/u,
  'the video director must not render, paginate, or auto-focus generation task cards',
);
assert.match(
  videoDirectorViewFunctionSource,
  /onOpenJobs[\s\S]*?onClick=\{onOpenJobs\}>查看生成任务<\/button>/u,
  'the video director must keep an explicit shortcut to the sole generation-task surface',
);
assert.match(videoGenerationSource, /requestBody:\s*\{\s*prompt:\s*draft\.prompt,\s*parameters:\s*draft\.parameters/u, 'the engine must retain the exact chosen prompt and explicit parameters in its task snapshot');
const copyShotSource = sourceBetween(
  'const copyShot = async',
  'const updateBoundary =',
);
assert.match(
  copyShotSource,
  /renderShotPrompt\(/u,
  'copying an individual shot must render through renderShotPrompt',
);
assert.match(
  copyShotSource,
  /visualStyle:\s*board\.visualStyle/u,
  'copying an individual shot must pass the board visual style into renderShotPrompt',
);
assert.match(
  copyShotSource,
  /visualStyleFallback:\s*boardStylePreset\?\.name/u,
  'copying an individual shot must pass the resolved preset fallback into renderShotPrompt',
);
assert.match(
  copyShotSource,
  /styleVisual:\s*boardStylePreset\?\.visual/u,
  'copying an individual shot must pass the board visual style, resolved preset fallback, and editable visual rules into renderShotPrompt',
);
const storyboardViewSource = sourceBetween(
  'function StoryboardView(ctx: AppContext) {',
  'function ImageWorkbenchView(ctx: AppContext) {',
);
assert.match(
  storyboardViewSource,
  /\{shot\.prompt\s*\|\|\s*renderShotPrompt\(/u,
  'the expanded single-shot preview must fall back to renderShotPrompt when a shot has no stored prompt',
);
assert.match(
  storyboardViewSource,
  /visualStyle:\s*board\.visualStyle/u,
  'the expanded single-shot preview must pass the board visual style into renderShotPrompt',
);
assert.match(
  storyboardViewSource,
  /visualStyleFallback:\s*boardStylePreset\?\.name/u,
  'the expanded single-shot preview must pass the resolved preset fallback into renderShotPrompt',
);
assert.match(
  storyboardViewSource,
  /styleVisual:\s*boardStylePreset\?\.visual/u,
  'the expanded single-shot preview must pass the board visual style, resolved preset fallback, and editable visual rules into renderShotPrompt',
);

const imageWorkbenchSource = sourceBetween(
  'function ImageWorkbenchView(ctx: AppContext) {',
  'function AssetsView(ctx: AppContext) {',
);
assert.match(
  imageWorkbenchSource,
  /const renderImageWorkbenchFieldControl = \(key: string, label: string\) => \{[\s\S]*?key !== "style"[\s\S]*?resolveVisualStyleSelectDisplay\(assetForm\.style \|\| ""\)[\s\S]*?visualStyleDefinitions\.map[\s\S]*?选择上方预设，或直接输入自定义视觉风格/u,
  'the image workbench visual style field must offer the shared director style catalog plus a custom text fallback',
);
assert.match(
  imageWorkbenchSource,
  /<option value="">自定义 \/ 不套用预设<\/option>/u,
  'the image workbench style selector must keep an explicit custom/no-preset option',
);
assert.match(
  imageWorkbenchSource,
  /const inheritedImageVisualStyle = visualStyle\.trim\(\) \|\| "电影写实";[\s\S]*?const createInheritedAssetForm = \(\) => \(\{[\s\S]*?style: inheritedImageVisualStyle/u,
  'the image workbench must derive its default style from the prompt director visual style',
);
assert.match(
  imageWorkbenchSource,
  /if \(assetFormStyleSource !== "director"\) return;[\s\S]*?setAssetForm\([\s\S]*?style: inheritedImageVisualStyle/u,
  'the image workbench must keep following prompt-director AI visual style until the user edits image style manually',
);
assert.match(
  imageWorkbenchSource,
  /if \(key === "style"\) setAssetFormStyleSource\("manual"\)/u,
  'manual image-workbench style edits must stop automatic director-style inheritance',
);
const completeAssetDetailsSource = sourceBetween(
  '  const completeAssetDetails = async () => {',
  '  const addImageAssetToOwningProject =',
);
assert.match(
  completeAssetDetailsSource,
  /const privateAutofillRequestedByMode = imageGenerationMode === "private"[\s\S]*?privateAutofillRequestedByMode[\s\S]*?\|\| privateProfileHasAnyValue[\s\S]*?detectNsfwCharacterNames/u,
  'private image mode itself must opt into private dossier autofill instead of relying on story NSFW detection',
);
assert.match(
  completeAssetDetailsSource,
  /const ordinaryRequestedFields = missingImageAssetFormFields\(assetKind, assetForm\);/u,
  'ordinary character autofill must include age fields even when private dossier autofill is also requested',
);
assert.match(
  completeAssetDetailsSource,
  /const privateBasisMissing = missingCharacterPrivateProfileBasisFields\(effectiveForm\)[\s\S]*?请先补齐普通人物资料/u,
  'private dossier autofill must require ordinary character facts before generating private fields',
);
const createImageTaskSource = sourceBetween(
  '  const createPromptAsset = async () => {',
  '  const generateSelectedStoryboardImages = async () => {',
);
assert.doesNotMatch(
  createImageTaskSource,
  /const\s+taskId\s*=\s*state\.settings\.imageApi\.enabled[\s\S]*?createId\("image_task"\)[\s\S]*?:\s*""/u,
  'AI prompt-only generation must no longer bypass the tracked image task lifecycle',
);
// Inspect the actual submission function, not a variable spelling or a later
// storyboard worker. One member and N-member batches share this safety rule.
const imageSubmissionAst = ts.createSourceFile('image-workbench-submit.tsx', createImageTaskSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const imageSubmissionStatement = imageSubmissionAst.statements.find(ts.isVariableStatement);
assert.ok(imageSubmissionStatement);
const imageSubmissionInitializer = imageSubmissionStatement.declarationList.declarations[0].initializer;
assert.ok(imageSubmissionInitializer && ts.isArrowFunction(imageSubmissionInitializer) && ts.isBlock(imageSubmissionInitializer.body));
const imageSubmissionBody = imageSubmissionInitializer.body;
const imageSubmissionCalls: ts.CallExpression[] = [];
const visitImageSubmission = (node: ts.Node): void => {
  if (ts.isCallExpression(node)) imageSubmissionCalls.push(node);
  ts.forEachChild(node, visitImageSubmission);
};
visitImageSubmission(imageSubmissionBody);
const imageTaskCreationCalls = imageSubmissionCalls.filter((node) => node.expression.getText(imageSubmissionAst) === 'createImageGenerationTask');
assert.ok(imageTaskCreationCalls.length > 0, 'every submission must create tracked tasks');
for (const [configuration, requiredChecks] of [
  ['text', ['!requestedTextApi.enabled', '!requestedTextApi.baseUrl.trim()', '!requestedTextApi.model.trim()']],
  ['image', ['requestedImageApi.enabled', '!requestedImageApi.baseUrl.trim()', '!comfyWorkflowReady']],
] as const) {
  const preflight = imageSubmissionBody.statements.find((statement): statement is ts.IfStatement => (
    ts.isIfStatement(statement) && requiredChecks.every((check) => statement.expression.getText(imageSubmissionAst).includes(check))
  ));
  assert.ok(preflight && ts.isBlock(preflight.thenStatement), `${configuration} API configuration must be checked at the submission boundary`);
  assert.ok(preflight.thenStatement.statements.some(ts.isReturnStatement), `${configuration} preflight must return before enqueueing any work`);
  assert.ok(imageTaskCreationCalls.every((call) => preflight.end < call.getStart(imageSubmissionAst)), `${configuration} preflight must precede every tracked task creation, including batch members`);
}
assert.ok(
  createImageTaskSource.indexOf('createImageGenerationTask({')
    < createImageTaskSource.indexOf('await requestImagePromptConverter('),
  'the image task must be visible before mandatory prompt conversion starts',
);
assert.ok(
  createImageTaskSource.indexOf('createImageGenerationTask({')
    < createImageTaskSource.indexOf('await requestImageModel('),
  'the image task must be visible before the image API request starts',
);
const imageQueueCalls = imageSubmissionCalls.filter((node) => node.expression.getText(imageSubmissionAst) === 'enqueueImageBatchMembers');
assert.equal(imageQueueCalls.length, 1, 'the batch must enter the shared image queue once');
const imageQueueCall = imageQueueCalls[0];
const imageQueueWorker = imageQueueCall.arguments[2];
assert.ok(imageQueueWorker && ts.isArrowFunction(imageQueueWorker) && ts.isBlock(imageQueueWorker.body));
const imageQueueStart = imageQueueWorker.body.getStart(imageSubmissionAst);
const imageQueueEnd = imageQueueWorker.body.end;
assert.ok(
  imageTaskCreationCalls.every((call) => call.end < imageQueueCall.getStart(imageSubmissionAst))
    && imageQueueStart < createImageTaskSource.indexOf('status: "running"')
    && createImageTaskSource.indexOf('status: "running"')
      < createImageTaskSource.indexOf('await requestImagePromptConverter(')
    && createImageTaskSource.indexOf('status: "succeeded"') < imageQueueEnd
    && createImageTaskSource.indexOf('status: "failed"') < imageQueueEnd,
  'the full workbench lifecycle must remain inside the global image queue from running through success or failure',
);
const imageBatchHelperSource = readFileSync(new URL('../src/imageBatch.ts', import.meta.url), 'utf8');
assert.match(imageBatchHelperSource, /members\.map\([\s\S]*?enqueueImageTask\(async[\s\S]*?if \(!canStart\(member\)\) return;[\s\S]*?await worker\(member, index\)/u,
  'batch members must use the existing complete-worker FIFO and skip cancelled or deleted work before starting');
assert.match(
  createImageTaskSource,
  /status:\s*"succeeded"[\s\S]*?resultAssetId:\s*asset\.id/u,
  'a successful image request must link the task to the saved asset',
);
assert.match(
  createImageTaskSource,
  /status:\s*"failed"[\s\S]*?error:\s*reportedError/u,
  'a failed image request must retain its error on the task',
);
assert.doesNotMatch(
  createImageTaskSource,
  /\b(?:setBusy|getBusyEpoch)\s*\(/u,
  'an image batch must neither lock the workbench nor clear another workspace operation while running in the background',
);
assert.match(createImageTaskSource, /latestImageBatchIdRef\.current\[requestedGenerationMode\] === requestedBatchId/u,
  'an older image batch must not replace the latest lane results');
assert.match(
  imageWorkbenchSource,
  /applyOwnedProjectUpdate\([\s\S]*?requestedProjectId[\s\S]*?generationTasks/u,
  'image task writes must route back to the project that started the request',
);

const generationTasksViewSource = sourceBetween(
  'function GenerationTasksView(ctx: AppContext) {',
  'function SettingsView(ctx: AppContext) {',
);
assert.match(
  videoGenerationSource,
  /if \(item\.kind !== 'video' && item\.kind != null\) continue/u,
  'the background engine must exclude image and autofill records while adopting video tasks',
);
assert.match(
  generationTasksViewSource,
  /onResume=\{ctx\.videoController\.resume\}\s+onCancel=\{ctx\.videoController\.cancel\}/u,
  'the task view must delegate video recovery/cancellation to the shared background controller',
);
assert.match(
  generationTasksViewSource,
  /<VideoTaskCard\s+task=\{task\}[\s\S]*?onReuse=\{\(item\)\s*=>\s*ctx\.openVideoDirector\(\{\s*taskId:\s*item\.id\s*\}\)\}/u,
  'the generation task page must remain the sole video task-card surface and keep its reuse entry into the video director',
);
assert.doesNotMatch(generationTasksViewSource, /selectNextPendingVideoTask|setInterval\(/u, 'switching away from the task view must not own or stop video polling');
assert.match(
  generationTasksViewSource,
  /const imageTasks = tasks\.filter\(isImageGenerationTask\);[\s\S]*?const videoTasks = tasks\.filter\(isVideoGenerationTask\);[\s\S]*?const autofillTasks = tasks\.filter\(isAutofillGenerationTask\);/u,
  'generation tasks must be divided into image, video, and data-completion collections',
);
assert.match(generationTasksViewSource, /role="tablist" aria-label="任务分类"/u);
assert.match(generationTasksViewSource, /label: "图片任务"[\s\S]*?label: "视频任务"[\s\S]*?label: "资料任务"/u);
assert.match(generationTasksViewSource, /activeTaskCategory === "image" && imageTasks\.map\(renderImageTaskCard\)/u);
assert.match(generationTasksViewSource, /activeTaskCategory === "autofill" && autofillTasks\.map\(renderAutofillTaskCard\)/u);
assert.match(
  generationTasksViewSource,
  /const videoTaskGroups = \(\(\) => \{[\s\S]*?task\.batchId[\s\S]*?activeTaskCategory === "video" && videoTaskGroups\.map\(renderVideoTaskGroup\)/u,
  'video tasks must remain category-filtered while batch members are grouped behind one summary card',
);
assert.match(
  generationTasksViewSource,
  /const retryableFailures = group\.tasks\.filter[\s\S]*?videoTaskBatchStatus[\s\S]*?=== "failed"[\s\S]*?ctx\.openVideoDirector\(\{ batchTaskIds: retryableFailures\.map/u,
  'retrying a failed video batch must only navigate its ordinary failed members back to the review UI',
);
assert.doesNotMatch(
  generationTasksViewSource.slice(
    generationTasksViewSource.indexOf('只重试失败项') - 600,
    generationTasksViewSource.indexOf('只重试失败项') + 200,
  ),
  /startBatch\(/u,
  'the failed-item action must never submit or incur fees directly from the task summary',
);
assert.match(
  videoViewSource,
  /batchQueueState !== 'cancelled'[\s\S]*?task\.videoJob\.stage !== 'stopped'[\s\S]*?\(task\.status === 'failed' \|\| task\.videoJob\.stage === 'failed'\)/u,
  'cancelled, stopped, and non-failed batch members must not enter failed-item review',
);
assert.match(
  videoViewSource,
  /launchRequest\.batchTaskIds\?\.length[\s\S]*?setGenerationMode\('batch'\)[\s\S]*?retryTaskIds=\{launchRequest\?\.batchTaskIds\}/u,
  'a failed batch launch request must open the long-story review panel instead of the single-item submitter',
);
assert.match(
  videoViewSource,
  /const \[regenerateSucceeded, setRegenerateSucceeded\] = useState\(false\)[\s\S]*?items: buildVideoBatchSubmissionItems\(selected, regenerateSucceeded,/u,
  'successful duplicates must require an explicit default-off option that reaches the selected batch items',
);
const videoBatchSelectionSource = readFileSync(new URL('../src/videoBatchSelection.ts', import.meta.url), 'utf8');
assert.match(videoBatchSelectionSource, /force: regenerateSucceeded \|\| undefined/u,
  'explicit regeneration must not depend on an incomplete UI duplicate cache');
assert.match(
  videoViewSource,
  /const pending = selected\.filter\(\(candidate\) => videoBatchCandidateWillSubmit\(candidate, regenerateSucceeded\)\)[\s\S]*?candidate\?\.duplicate\?\.kind === 'in-flight' \? '已在队列，将跳过'/u,
  'the successful-result override must not bypass in-flight duplicate protection',
);
const completedBatchChoice = { duplicate: { kind: 'succeeded' as const, taskId: 'completed', status: 'succeeded' as const } };
const activeBatchChoice = { duplicate: { kind: 'in-flight' as const, taskId: 'active', status: 'unknown' as const } };
assert.equal(videoBatchCandidateWillSubmit(completedBatchChoice, false), false, 'successful video remains protected by default');
assert.equal(videoBatchCandidateWillSubmit(completedBatchChoice, true), true, 'explicit regeneration makes successful video selectable again');
assert.equal(videoBatchCandidateWillSubmit(activeBatchChoice, true), false, 'regeneration must not advertise duplicate submission of running or uncertain jobs');
assert.match(videoViewSource, /videoBatchConfirmationItemStatus\(candidate, inputItem, hasAutomaticSelection\)/u,
  'confirmation rows must describe active duplicates before a force-regeneration authorization');
assert.match(videoViewSource, /videoBatchConfirmationPendingCount\(confirmation\.candidates, confirmation\.input\.items\)/u,
  'ordinary confirmation counts must use the same active-task exclusion as pending counts');
assert.doesNotMatch(
  generationTasksViewSource,
  /tasks\.map\(\(task:\s*VideoGenerationTask\)/u,
  'the shared task list must not cast image records to video tasks',
);

const generateMasterSource = sourceBetween(
  'const generateSequenceMasterPrompt = async () => {',
  'const updateSequenceMasterPrompt =',
);
assert.match(
  generateMasterSource,
  /parseMasterTimelinePrompt\(\s*masterStoryboard\.finalPrompt,\s*completedTotalDuration,\s*hasAiAuthoredMasterTimeline\(masterStoryboard\)\s*\?\s*undefined\s*:\s*segmentDurationSec,?\s*\)/u,
  'a complete AI-authored master must be readable without a local fixed-grid boundary gate',
);
const updateMasterSource = sourceBetween(
  'const updateSequenceMasterPrompt =',
  'const confirmSequenceMasterPrompt =',
);
const updateStoryboardSource = sourceBetween(
  'const updateStoryboard =',
  '  useEffect(() => {',
);
const startupPromptMigrationSource = sourceBetween(
  'const pendingIds = pendingPromptMigrationIds(',
  'const chooseWorkflow =',
);
const deleteAssetSource = sourceBetween(
  'const deleteAsset = (id: string) => {',
  'const bindToStoryboard =',
);
const confirmMasterSource = sourceBetween(
  'const confirmSequenceMasterPrompt =',
  'const segmentConfirmedMasterPrompt = async () => {',
);
const confirmSequencePlanSource = sourceBetween(
  'const confirmSequencePlan = () => {',
  'const generateSequenceMasterPrompt = async () => {',
);
const segmentMasterSource = sourceBetween(
  'const segmentConfirmedMasterPrompt = async () => {',
  'const chooseScene =',
);
const masterInputFingerprintSource = sourceBetween(
  'const sequenceMasterInputFingerprint =',
  'const sequencePlanInputFingerprint =',
);
assert.match(
  masterInputFingerprintSource,
  /planId[\s\S]*title[\s\S]*story[\s\S]*durationMode[\s\S]*totalDurationSec[\s\S]*segmentDurationSec/su,
  'master-input identity must cover the plan, story snapshot, duration mode, full duration, and fixed segment duration',
);
assert.match(
  masterInputFingerprintSource,
  /segmentDurationSec/u,
  'changing the fixed segment duration must invalidate a confirmed master prompt',
);
const masterMismatchStart = appSource.indexOf('const activeSequenceMasterInputFingerprint =');
const masterMismatchEnd = appSource.indexOf('const activeSequencePlanInputFingerprint =', masterMismatchStart);
assert.ok(masterMismatchStart >= 0 && masterMismatchEnd > masterMismatchStart);
const masterMismatchSource = appSource.slice(masterMismatchStart, masterMismatchEnd);
assert.match(masterMismatchSource, /activeSequenceMasterMismatch/su);
assert.match(masterMismatchSource, /segmentDurationSec/u);

const masterCanSegmentStart = appSource.indexOf('const masterCanSegment = Boolean(');
const masterCanSegmentEnd = appSource.indexOf('  return (', masterCanSegmentStart);
assert.ok(masterCanSegmentStart >= 0 && masterCanSegmentEnd > masterCanSegmentStart);
const masterCanSegmentSource = appSource.slice(masterCanSegmentStart, masterCanSegmentEnd);
assert.match(masterCanSegmentSource, /activeSequenceMasterMismatch/u);
assert.doesNotMatch(masterCanSegmentSource, /activeSequencePlanMismatch/u);
assert.match(
  segmentMasterSource,
  /sequenceMasterSnapshotFingerprint\(livePlan\)[\s\S]*liveMasterInputFingerprint/su,
  'the split preflight must compare master-authoring inputs including the fixed segment grid',
);
assert.match(
  segmentMasterSource,
  /const requestSegmentDurationSec = livePlan\.segmentDurationSec;/u,
  'segmentation must use the fixed duration persisted with the confirmed plan, never a changed UI control',
);
for (const currentSplitSetting of [
  'const requestSegmentDurationSec = livePlan.segmentDurationSec;',
  'const requestSegmentationMode = livePlan.segmentationMode;',
]) {
  assert.equal(
    segmentMasterSource.includes(currentSplitSetting),
    true,
    `confirmed segmentation must use the setting persisted by the confirmed plan: ${currentSplitSetting}`,
  );
}
assert.match(
  segmentMasterSource,
  /requestAiStorySegmentation\(\s*current\.settings\.textApi/su,
  'confirmed segmentation must ask the text model to choose semantic boundaries',
);
assert.match(
  segmentMasterSource,
  /maxSegmentDurationSec:[\s\S]*?beats,[\s\S]*?masterShots/su,
  'the AI segmentation request must include the complete master timeline, source beats, and hard per-segment limit',
);
assert.match(
  segmentMasterSource,
  /const completeAiSegmentationPlan[\s\S]*?materializeAiSequenceSegments\(\s*segmentationBase,\s*masterStoryboard\.shots,\s*candidate\.segments/su,
  'the persisted plan must be materialized from the AI-owned complete-shot groups',
);
assert.match(
  segmentMasterSource,
  /const completeAiSegmentationPlan[\s\S]*?materializeAiSequenceSegments\([\s\S]*?reconcileSequenceSegmentsToShotProvenance\([\s\S]*?assertAiSequenceSegmentShotCoverage\([\s\S]*?validateSequencePlan\(/su,
  'one final consumer validator must cover materialization, provenance, shot coverage, and persisted-plan validation',
);
assert.match(
  segmentMasterSource,
  /requestAiStorySegmentation\([\s\S]*?validateResult:\s*\(candidate\)\s*=>\s*\{\s*validatedCompletedPlan\s*=\s*completeAiSegmentationPlan\(candidate\);\s*\}/su,
  'downstream consumer failures must participate in the text API repair request',
);
assert.match(
  segmentMasterSource,
  /onRepair:[\s\S]*?正在自动调用同一 API 修复/u,
  'automatic downstream repair must be visible without asking the user to edit source data',
);
assert.match(
  segmentMasterSource,
  /let validatedCompletedPlan:[\s\S]*?const aiPlan = await requestAiStorySegmentation\([\s\S]*?const completedPlan = validatedCompletedPlan \?\? completeAiSegmentationPlan\(aiPlan\);[\s\S]*?setState\(\(latest\)/su,
  'the application must commit only a response that passed the same complete validator after any repair',
);
assert.match(
  segmentMasterSource,
  /onRepair:[\s\S]*?if \(segmentationRequestIsStale\(\)\) \{\s*requestController\.abort\(\);\s*return;\s*\}/su,
  'a stale segmentation request must be cancelled before the automatic repair API dispatch',
);
assert.match(
  segmentMasterSource,
  /assertAiSequenceSegmentShotCoverage\(provenancePlan,\s*masterStoryboard\.shots\)/su,
  'AI shot ownership must be checked without selecting replacement boundaries locally',
);
assert.doesNotMatch(
  segmentMasterSource,
  /allocateSegmentDurationsForShotCapacity|buildLocalSequencePlan\(|requestStorySegmentation\(|resolveSequenceFitStatus\(/u,
  'confirmed segmentation must not use a local duration allocator or legacy local segmentation request',
);
assert.match(
  segmentMasterSource,
  /segmentationSource:\s*["']ai["'][\s\S]*?planningStage:\s*["']segmented["']/su,
  'the committed plan must record that its boundaries came from the AI segmenter',
);
assert.doesNotMatch(
  segmentMasterSource,
  /autoExtendedBySec|automaticExtensionSummary/u,
  'AI-owned boundaries must not be silently lengthened by a local shot-capacity repair',
);
assert.match(
  confirmSequencePlanSource,
  /validateSequencePlan\(activeSequencePlan,\s*\{[\s\S]*?requireMasterStoryboard:\s*true,[\s\S]*?storyboards:\s*stateRef\.current\.project\.storyboards/su,
  'final confirmation must validate the authoritative master storyboard in the same call as the plan',
);

const initialSequenceSource = sourceBetween(
  'const initialSequencePlan =',
  'const undoStack =',
);
assert.match(initialSequenceSource, /sequencePlanMasterConfirmationIssue\(/u);
const syncWorkspaceSource = sourceBetween(
  'const syncWorkspaceUiState = useCallback',
  '  useEffect(() => {',
);
assert.match(syncWorkspaceSource, /sequencePlanMasterConfirmationIssue\(/u);
assert.match(
  appSource,
  /const activeSequenceMasterConfirmationIssue\s*=\s*activeSequencePlan[\s\S]*?sequencePlanMasterConfirmationIssue\(/su,
  'both confirmed and segmented live plans must receive exact master confirmation validation',
);
const readyStart = appSource.indexOf('const activeSequencePlanReadyForGeneration = Boolean(');
const readyEnd = appSource.indexOf('const activeDuration =', readyStart);
const readySource = readyStart >= 0 && readyEnd > readyStart ? appSource.slice(readyStart, readyEnd) : '';
assert.match(readySource, /!activeSequenceMasterConfirmationIssue/u);

const finalReducerMatch = segmentMasterSource.match(
  /setState\(\(latest\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/u,
);
assert.ok(finalReducerMatch, 'confirmed segmentation must have a discoverable final reducer');
const finalReducerSource = finalReducerMatch?.[1] || '';
for (const latestReducerGuard of [
  'latest.project.id !== requestProjectId',
  'const latestPlan = latest.project.sequencePlans.find',
  'const latestBoard = latest.project.storyboards.find',
  'latestPlan.updatedAt !== requestPlanRevision',
  'latestPlan.planningStage !== "master-confirmed"',
  'latestPlan.masterStoryboardId !== requestMasterId',
  'masterPromptConfirmationFingerprint(latestPlan, latestBoard)',
  'sequencePlanMasterConfirmationIssue(',
  'latest.project.storyboards',
]) {
  assert.equal(
    finalReducerSource.includes(latestReducerGuard),
    true,
    `final segmentation reducer must recheck ${latestReducerGuard} from latest state`,
  );
}
assert.doesNotMatch(
  finalReducerSource,
  /segmentationRequestIsStale\(/u,
  'the final reducer must not validate persistent state through stateRef.current',
);

const planningIdentityStart = appSource.indexOf('const buildSequencePlanningIdentity = (semantic: boolean) => JSON.stringify([');
const planningIdentityEnd = appSource.indexOf('const sequencePlanningIdentityRef', planningIdentityStart);
assert.ok(planningIdentityStart >= 0 && planningIdentityEnd > planningIdentityStart);
const planningIdentitySource = appSource.slice(planningIdentityStart, planningIdentityEnd);
for (const textApiField of [
  'state.settings.textApi.enabled',
  'state.settings.textApi.provider',
  'state.settings.textApi.baseUrl',
  'state.settings.textApi.apiKey',
  'state.settings.textApi.model',
  'state.settings.textApi.temperature',
  'state.settings.textApi.maxTokens',
  'state.settings.textApi.vision',
]) {
  assert.equal(
    planningIdentitySource.includes(textApiField),
    true,
    `sequence planning identity must include ${textApiField}`,
  );
}
assert.match(
  generateMasterSource,
  /buildStoryboard\(\{[\s\S]*?fullTimeline:\s*true[\s\S]*?deferCommit:\s*true/su,
  'master generation must build one complete full-duration storyboard before review',
);
assert.match(
  generateMasterSource,
  /masterStoryboardId:\s*masterStoryboard\.id/su,
  'the sequence plan must retain its authoritative full-timeline storyboard',
);
assert.match(
  generateMasterSource,
  /planningStage:\s*["']master-draft["'][\s\S]*?segments:\s*\[\]/su,
  'master generation must persist a reviewable draft shell without segments',
);
assert.doesNotMatch(
  generateMasterSource,
  /requestStorySegmentation\(|sliceMasterShotsForSegment\(|buildLocalSequencePlan\(/u,
  'master generation must not perform or discard hidden segmentation work',
);
assert.match(
  updateMasterSource,
  /finalPrompt:\s*prompt[\s\S]*?planningStage:\s*["']master-draft["']/su,
  'editing the master prompt must persist the original text and return the plan to draft review',
);
assert.doesNotMatch(updateMasterSource, /applyMasterPromptEdit\(/u, 'typing must not mutate parsed shots');
assert.match(
  updateMasterSource,
  /invalidateSequenceSegmentsForMasterPrompt\(/u,
  'editing a segmented master prompt must atomically invalidate every old segment and derived result',
);
assert.doesNotMatch(
  updateMasterSource,
  /livePlan\.segments\.length\s*>\s*0/u,
  'an already segmented plan must remain editable so it can be rebuilt from a revised master timeline',
);
assert.match(
  updateMasterSource,
  /setActiveStoryboardId\(["']{2}\)/u,
  'invalidating old segment storyboards must also clear the active storyboard selection',
);
assert.match(
  updateMasterSource,
  /setAcceptedSequencePlanMismatchFingerprint\(["']{2}\)/u,
  'editing the master prompt must clear any prior permission to accept a mismatched plan snapshot',
);
assert.match(
  generateMasterSource,
  /invalidateSequenceSegmentsForMasterPrompt\(/u,
  'regenerating a master prompt must also discard every result derived from the previous timeline',
);
assert.match(
  updateStoryboardSource,
  /masterPromptConfirmationFingerprint\([\s\S]*?invalidateSequenceSegmentsForMasterPrompt\(/su,
  'editing the authoritative master board through the general storyboard editor must invalidate its old segments too',
);
assert.match(
  startupPromptMigrationSource,
  /masterPromptConfirmationFingerprint\([\s\S]*?invalidateSequenceSegmentsForMasterPrompt\([\s\S]*?invalidatedStoryboardIds/su,
  'startup prompt migration must invalidate old segments and expose their board IDs when rebuilding changes a master prompt',
);
assert.match(
  deleteAssetSource,
  /deleteAssetFromProject\(current\.project, id\)/u,
  'asset deletion must only detach media references through the shared deletion transaction',
);
assert.doesNotMatch(
  deleteAssetSource,
  /rebuildStoryboard|invalidateSequenceSegmentsForMasterPrompt|masterPromptConfirmationFingerprint/u,
  'deleting an asset must preserve authored prompts and all existing sequence segments',
);
assert.match(
  appSource,
  /planningStage\s*===\s*["']master-draft["'][\s\S]*?planningStage\s*===\s*["']master-confirmed["'][\s\S]*?planningStage\s*===\s*["']segmented["'][\s\S]*?className=["']sequence-master-review["']/su,
  'the authoritative master prompt editor must remain reachable after segmentation',
);
assert.match(
  confirmMasterSource,
  /applyMasterPromptEdit\([\s\S]*?planningStage:\s*["']master-confirmed["'][\s\S]*?masterPromptConfirmationFingerprint\(/su,
  'confirmation must parse the reviewed prompt and persist its live fingerprint',
);
assert.match(
  confirmMasterSource,
  /validateStoryboardPrompt\(\s*updatedBoard[\s\S]*?if\s*\(masterPromptValidation\.errors\.length\)/su,
  'master confirmation must validate timeline structure before the user reaches segmentation',
);
assert.doesNotMatch(
  confirmMasterSource,
  /requestStorySegmentation\(|sliceMasterShotsForSegment\(|buildLocalSequencePlan\(/u,
  'confirmation must never create segments',
);
assert.match(
  segmentMasterSource,
  /sequencePlanMasterConfirmationIssue\([\s\S]*?const completeAiSegmentationPlan[\s\S]*?materializeAiSequenceSegments\([\s\S]*?planningStage:\s*["']segmented["'][\s\S]*?requestAiStorySegmentation\(/su,
  'only a confirmed master prompt may start the AI semantic segmentation pass',
);
assert.doesNotMatch(
  segmentMasterSource,
  /alignSequenceSegmentsToMasterShotBoundaries\(|sliceMasterShotsForSegment\(masterStoryboard\.shots/u,
  'semantic segmentation must not locally realign or slice the master timeline while choosing boundaries',
);
assert.equal(
  (appSource.match(/requestStorySegmentation\(/gu) || []).length,
  0,
  'the application must no longer invoke the legacy local-boundary segmentation API',
);
assert.equal(
  appSource.includes('const materializeMasterShotsForGeneration ='),
  false,
  'master-shot slicing must have one shared implementation',
);
assert.match(
  segmentMasterSource,
  /masterStoryboard\.shots[\s\S]*?materializeAiSequenceSegments/su,
  'each AI segment must point to complete shots from the authoritative full timeline',
);
assert.match(
  generateMasterSource,
  /const\s+masterStoryboardSourceScenes\s*=\s*masterSourceScenes\.length[\s\S]*?\[masterScene\][\s\S]*?sourceScenes:\s*masterStoryboardSourceScenes/su,
  'a text-only new project must retain the synthetic whole-story scene snapshot while building its master prompt',
);
assert.match(
  generateMasterSource,
  /requiredSegmentDurationSec:\s*segmentDurationSec/u,
  'the authoritative master-shot request must retain the selected segment duration as model context',
);
assert.doesNotMatch(
  generateMasterSource,
  /少于固定分段数/u,
  'the local preferred segment count must not reject an AI-authored shot-count request',
);
assert.match(
  segmentMasterSource,
  /allowedSegmentDurationsSec:\s*\[requestSegmentDurationSec\]/u,
  'AI review and repair must receive the selected duration as an explicit singleton fixed-duration grid',
);
assert.match(segmentMasterSource, /preferredSegmentDurationSec:[\s\S]*?requestSegmentDurationSec/u,
  'AI receives the preferred duration alongside the authoritative complete-shot grid');
assert.match(confirmMasterSource, /hasAiAuthoredMasterTimeline\(liveBoard\)\s*\?\s*undefined\s*:\s*livePlan\.segmentDurationSec/u,
  'confirmation must not restore the fixed-grid gate for model-authored shots');
assert.match(appSource, /reviewWithAi:\s*true,[\s\S]*?onReview:[\s\S]*?AI 正在通过同一 API 校验并修复完整分镜/u,
  'the director must explicitly request the real AI self-review round and report its progress');
assert.match(appSource,
  /usesSemanticPlanning\s*\?\s*activeSequencePlan\s*\?\s*semanticPlanDurationSummary\s*:\s*"AI 理解原剧情的动作、对白与因果，在所选时长方式下编排边界；每段固定时长。"\s*:\s*"历史总稿和已有分段保持可用；也可按原剧情另建 AI 分段计划。"/u,
  'new planning explains semantic fixed-duration segments and saved plan duration while preserving the historical master route');
assert.match(appSource,
  /全片 \$\{target\} 秒 = \$\{count\} 段 × \$\{resolvedPlanningSegmentDuration\} 秒；每段足额，无短尾段。/u,
  'the historical master help must retain the selected full-duration grid without a short tail');
assert.match(
  appSource,
  /const\s+directorPreviewStory\s*=\s*productionMode\s*===\s*"sequence"\s*&&\s*activeSequenceSegment[\s\S]*?\?\s*activeSequenceSegment\.content\s*:\s*directorScene\?\.content\s*\|\|\s*storyInput/su,
  'sequence director previews must analyze the active segment story instead of the full project story',
);
assert.doesNotMatch(
  appSource,
  /recommendShotCount\(/u,
  'the director UI must not calculate a local shot count before the AI returns a complete plan',
);
assert.match(
  appSource,
  /const\s+confirmedSequenceShotCount[\s\S]*?activeSequenceSegment\?\.sourceShotIds\?\.length[\s\S]*?AI 全片时间轴分段/su,
  'sequence mode must display only the confirmed AI master-slice shot count',
);
assert.match(
  appSource,
  /const\s+confirmedSequenceShotCount[\s\S]*?activeSequenceSegment\?\.contentOverridden[\s\S]*?activeStoryboard\?\.shots\.length/su,
  'an overridden sequence segment must display its newly returned AI storyboard count instead of stale master provenance',
);
const buildStoryboardStart = appSource.indexOf('const buildStoryboard = async');
const buildStoryboardEnd = appSource.indexOf('const handleCopyPrompt', buildStoryboardStart);
assert.ok(buildStoryboardStart >= 0 && buildStoryboardEnd > buildStoryboardStart, 'storyboard builder source must be discoverable');
const buildStoryboardSource = appSource.slice(buildStoryboardStart, buildStoryboardEnd);

for (const retiredGuard of [
  'if (preflightWorkflow === "grid")',
  'if (!fullTimeline && requestMasterBoard?.workflow === "grid")',
]) {
  const retirementIndex = buildStoryboardSource.indexOf(retiredGuard);
  assert.ok(retirementIndex >= 0, `new creation must reject the retired route: ${retiredGuard}`);
  assert.ok(
    retirementIndex < buildStoryboardSource.indexOf('setBusy(true)')
      && retirementIndex < buildStoryboardSource.indexOf('requestShotRecommendation('),
    'both direct grid creation and a legacy grid master must stop before busy state or any paid text-model request',
  );
  const guardSource = buildStoryboardSource.slice(retirementIndex, buildStoryboardSource.indexOf('\n    }', retirementIndex));
  assert.match(guardSource, /reportOverrideFailure\(GRID_CREATION_RETIRED_MESSAGE\);/u);
  assert.match(guardSource, /notify\(GRID_CREATION_RETIRED_MESSAGE, "normal"\);\s*return undefined;/u,
    'retired creation must return an explanatory result instead of requesting a grid master');
  assert.doesNotMatch(guardSource, /setState\(|setView\(|openGridWorkbenchFromDirector\(|requestShotRecommendation\(/u,
    'retired creation cannot mutate saved data, open the old workbench or submit a model request');
}
assert.doesNotMatch(buildStoryboardSource, /resolveGridDirectorPreflight\(/u,
  'new creation no longer authorizes a grid workflow after checking for a mother image');
assert.match(
  buildStoryboardSource,
  /const\s+effectiveInputMode\s*=\s*masterBoardForSegment\?\.inputMode\s*\|\|\s*normalizedDirectorInputModeForGeneration/su,
  'active creation must retain its effective input mode throughout the same generation call',
);
assert.doesNotMatch(
  appSource,
  /\["text",\s*"reference",\s*"text_reference"\]\s+as\s+InputMode\[\]/su,
  'the redundant third image + story switch must not return to the director UI',
);
assert.doesNotMatch(appSource, /disabled=\{directorWorkflow === "grid"\}/u,
  'a retired grid control must not disable the active text-only director input');
assert.doesNotMatch(appSource, /onClick=\{\(\) => setDirectorInputMode\("(?:text|reference)"\)\}/u,
  'the retired text/reference toggle must not return to the prompt director');
assert.doesNotMatch(appSource, /storyboard-i2i-entry|选择参考图\s*<\/Button>/u,
  'the duplicate reference shortcut must not return above the director settings');
assert.equal((appSource.match(/onClick=\{\(\) => setDirectorPane\("references"\)\}/gu) || []).length, 1,
  'the right-side reference tab remains the sole director reference-selection entry');
assert.match(appSource, /className="segmented director-panel-tabs reference-result-tabs"[\s\S]*?onClick=\{\(\) => setDirectorPane\("references"\)\}>参考图[\s\S]*?directorPane === "references"[\s\S]*?<StoryboardDirectImageTools ctx=\{ctx\} storyboard=\{directorResultStoryboard\} \/>/u,
  'the surviving right-side tab opens the same storyboard reference picker without changing the original generation workflow');
assert.match(buildStoryboardSource,
  /normalizedDirectorInputModeForGeneration\s*=\s*normalizeGridDirectorInputMode\(\s*preflightWorkflow,\s*"text",?\s*\)/su,
  'new video prompt creation continues directly from text without a redundant input-mode toggle');
const retiredWorkbenchNavigation = sourceBetween(
  '  const openGridWorkbenchFromDirector =',
  '  const projectLibrary =',
);
assert.match(retiredWorkbenchNavigation, /notify\(GRID_CREATION_RETIRED_MESSAGE, "normal"\)/u);
assert.doesNotMatch(retiredWorkbenchNavigation, /set(?:State|View|AssetKind|DirectorWorkflow|DirectorInputMode|SelectedAssetIds|ImageWorkbenchSource)\(/u,
  'a stale historical navigation callback may explain retirement but cannot reopen, bind or rewrite a grid creation flow');

const comfyStoryboardImageBatchStart = appSource.indexOf('const generateStoryboardImageBatch = async');
const comfyStoryboardImageBatchEnd = appSource.indexOf('\n  return (', comfyStoryboardImageBatchStart);
assert.ok(
  comfyStoryboardImageBatchStart >= 0 && comfyStoryboardImageBatchEnd > comfyStoryboardImageBatchStart,
  'storyboard image batch source must be discoverable',
);
const comfyStoryboardImageBatchSource = appSource.slice(comfyStoryboardImageBatchStart, comfyStoryboardImageBatchEnd);
const comfyGridCapabilityIndex = comfyStoryboardImageBatchSource.indexOf(
  'assertComfyUIWorkflowCanBindReferenceImages(',
);
assert.ok(comfyGridCapabilityIndex >= 0, 'ComfyUI grid image generation needs an explicit reference-workflow preflight');
assert.ok(
  comfyGridCapabilityIndex < comfyStoryboardImageBatchSource.indexOf('prepareStoryboardImageIdentityContext({')
    && comfyGridCapabilityIndex < comfyStoryboardImageBatchSource.indexOf('createImageGenerationTask({')
    && comfyGridCapabilityIndex < comfyStoryboardImageBatchSource.indexOf('requestImageModel(imageApi, input,'),
  'a ComfyUI workflow that cannot consume the grid master must fail before identity AI, task creation, or image submission',
);
assert.match(
  comfyStoryboardImageBatchSource,
  /当前 ComfyUI Workflow 无法接入已绑定的九宫格母版[\s\S]*?notify\([\s\S]*?reportRuntimeError\("image-preparation", failure, imageInputErrorContext\)[\s\S]*?return;/su,
  'a failed grid reference preflight must be both visible and persisted in the runtime error log',
);
assert.match(
  comfyStoryboardImageBatchSource,
  /catch \(error\) \{[\s\S]*?const safeError = getSafeErrorDiagnostics\(error,[\s\S]*?const usesTextApi = imageTaskStage === "image-prompt-convert";[\s\S]*?reportRuntimeError\(imageTaskStage, safeError, \{[\s\S]*?model: usesTextApi \? textApi\.model : imageApi\.model,[\s\S]*?endpoint: usesTextApi \? textApi\.baseUrl : imageApi\.baseUrl,[\s\S]*?\}\)[\s\S]*?status: "failed"/su,
  'per-image ComfyUI failures must be safely recorded under their actual stage and provider as well as failed tasks',
);

assert.match(
  buildStoryboardSource,
  /if\s*\(canonicalMasterSlice\)\s*\{[\s\S]*?沿用 AI 生成的全片总视频提示词镜头划分[\s\S]*?\}\s*else\s*\{\s*const\s+modelPlan\s*=\s*await\s+requestShotRecommendation/su,
  'only a source-valid canonical master slice may bypass a fresh AI storyboard request',
);
assert.doesNotMatch(
  buildStoryboardSource,
  /if\s*\(masterSlice\)\s*\{[\s\S]*?recommendationNow\s*=/su,
  'an overridden sequence segment must never reuse a stale master count and fall into local shot construction',
);
assert.doesNotMatch(
  buildStoryboardSource,
  /candidate\.id\s*===\s*segmentForGeneration\.id\s*&&\s*masterSlice\s*\?\s*\{\s*\.\.\.candidate,\s*sourceShotIds:/su,
  'a freshly AI-replanned overridden segment must not be relabelled as the stale master slice during commit',
);
assert.match(
  buildStoryboardSource,
  /shotPlanMode:\s*canonicalMasterSlice[\s\S]*?["']ai-complete["']/su,
  'only the new complete per-shot AI response path may stamp reusable AI-shot provenance',
);
assert.match(
  appSource,
  /const\s+usesConfirmedMasterSlice[\s\S]*?disabled=\{usesConfirmedMasterSlice\}/su,
  'canonical sequence slices must disable ineffective per-segment shot-mode promises',
);
assert.match(
  appSource,
  /board\.promptTrace\?\.shotPlanMode\s*===\s*["']ai-complete["'][\s\S]*?AI 初稿后本地编辑[\s\S]*?旧版或本地分镜/su,
  'the storyboard header must not relabel legacy or locally edited shot plans as current complete AI output',
);

assert.match(
  appSource,
  /interface StoryboardGenerationOverride\s*\{[\s\S]*?sequencePlanId\?:\s*string;[\s\S]*?segment\?:\s*VideoSegment;[\s\S]*?fullTimeline\?:\s*boolean;[\s\S]*?deferCommit\?:\s*boolean;/su,
  'sequence generation must expose a typed override for both master and segment timelines',
);
assert.match(
  buildStoryboardSource,
  /async\s*\(\s*override\?:\s*StoryboardGenerationOverride\s*,?\s*\)\s*:\s*Promise<Storyboard\s*\|\s*undefined>/su,
  'storyboard generation must remain callable without arguments and return its completed board',
);
assert.match(
  buildStoryboardSource,
  /const\s+segmentForGeneration\s*=\s*override\?\.segment/su,
  'the override segment must be snapshotted before asynchronous work starts',
);
assert.match(
  appSource,
  /const\s+segmentStoryboardConfigurationIdentity\s*=\s*JSON\.stringify\(\[/su,
  'segment generation must track director settings separately from mutable plan status',
);
assert.match(
  buildStoryboardSource,
  /requestConfigurationIdentity[\s\S]+segmentStoryboardConfigurationIdentityRef\.current/su,
  'segment requests must capture the current director configuration identity',
);
assert.doesNotMatch(
  appSource.slice(
    appSource.indexOf('const sequenceStoryboardGenerationIdentity'),
    appSource.indexOf('const navItems'),
  ),
  /segment\.(?:status|storyboardId|sourceShotIds)/u,
  'completion-only state and derived master-shot links must not invalidate their own async request',
);
assert.match(
  appSource.slice(
    appSource.indexOf('const sequenceStoryboardGenerationIdentity'),
    appSource.indexOf('const navItems'),
  ),
  /Boolean\(segment\.locked\)/u,
  'locking an in-flight segment must invalidate its late storyboard commit',
);
assert.match(
  buildStoryboardSource,
  /let\s+duration\s*=\s*override\?\.durationSec[\s\S]*?segmentForGeneration\?\.durationSec[\s\S]*?activeDuration/su,
  'generation must use the full-timeline override or segment local duration',
);
assert.match(appSource, /content:\s*segment\.content/su, 'the synthetic scene must use segment content');
assert.match(appSource, /summary:\s*segment\.summary/su, 'the synthetic scene must use segment summary');
assert.match(
  buildStoryboardSource,
  /!segmentForGeneration\s*&&\s*!sourceScenesForGeneration\.length/su,
  'a sequence segment with valid local content must remain generatable when its source-scene list is empty',
);
assert.match(buildStoryboardSource, /(?:sourceSceneIds:\s*sourceSceneIds|\bsourceSceneIds,)/su, 'the board must retain its segment source-scene links');
assert.match(
  buildStoryboardSource,
  /sourceStoryContent:\s*segmentGenerationSource\.sourceStoryContent/su,
  'the board must persist the exact source selected by the segment override/master-reuse policy',
);
assert.match(
  buildStoryboardSource,
  /sourceContentHash:\s*segmentGenerationSource\.sourceContentHash/su,
  'the board source hash must come from the same segment generation source decision',
);
for (const field of [
  'sequencePlanId',
  'segmentId',
  'segmentIndex',
  'segmentCount',
  'globalStartSec',
  'globalEndSec',
  'continuityIn',
  'continuityOut',
]) {
  assert.match(
    buildStoryboardSource,
    new RegExp(`${field}:\\s*segmentForGeneration|${field}:\\s*override`, 'su'),
    `segment storyboard must persist ${field}`,
  );
}
assert.match(
  buildStoryboardSource,
  /linkSegmentStoryboard\(\s*plan,\s*segmentForGeneration\.id,\s*complete\.id,?\s*\)/su,
  'the matching sequence segment must be linked in the same project update',
);
assert.match(
  buildStoryboardSource,
  /const\s+withoutRegeneratedBoard\s*=\s*scene\.storyboardIds\.filter\([\s\S]*?storyboardId\s*!==\s*complete\.id[\s\S]*?storyboardIds:\s*\[[\s\S]*?\.\.\.new Set\(\[complete\.id,\s*\.\.\.withoutRegeneratedBoard\]\)[\s\S]*?\]/su,
  'source-scene storyboard links must remove stale copies before adding the regenerated board once',
);
assert.match(
  buildStoryboardSource,
  /withoutRegeneratedBoard\.length\s*!==\s*scene\.storyboardIds\.length[\s\S]*?storyboardIds:\s*withoutRegeneratedBoard/su,
  'regeneration must remove the old board backlink from scenes no longer used by the board',
);
assert.match(
  buildStoryboardSource,
  /existingSegmentBoardId[\s\S]+const\s+storyboards\s*=[\s\S]+board\.id === existingSegmentBoardId/su,
  'regenerating a segment must replace its prior board instead of appending a duplicate',
);
assert.match(
  buildStoryboardSource,
  /if\s*\(\s*!segmentForGeneration\s*&&\s*!override\?\.keepDirector\s*\)\s*setView\("storyboard"\)/su,
  'sequence generation must stay in the director while the legacy path opens the storyboard',
);
assert.match(
  buildStoryboardSource,
  /if\s*\(\s*segmentForGeneration\s*\|\|\s*override\?\.keepDirector\s*\)\s*setView\("director"\)/su,
  'a completed sequence segment must explicitly remain in the director workspace',
);
assert.match(buildStoryboardSource, /return complete;/u, 'successful generation must return the completed board');
const commitAcceptedStart = buildStoryboardSource.indexOf('let commitAccepted = false');
const commitAcceptedEnd = buildStoryboardSource.indexOf('return commitAccepted;', commitAcceptedStart);
assert.ok(
  commitAcceptedStart >= 0 && commitAcceptedEnd > commitAcceptedStart,
  'storyboard generation must observe whether the functional state reducer accepted its commit',
);
const commitReducerSource = buildStoryboardSource.slice(commitAcceptedStart, commitAcceptedEnd);
assert.match(
  commitReducerSource,
  /if\s*\(current\.project\.id\s*!==\s*requestProjectId\)\s*return current/su,
  'a reducer running against another project must reject the generated board',
);
assert.match(
  commitReducerSource,
  /!currentPlan[\s\S]*?!currentSegment[\s\S]*?return current/su,
  'a reducer running after its sequence segment became stale must reject the generated board',
);
assert.ok(
  commitReducerSource.indexOf('commitAccepted = true') > commitReducerSource.lastIndexOf('return current'),
  'all stale reducer exits must occur before the commit is marked accepted',
);
assert.match(
  buildStoryboardSource.slice(commitAcceptedEnd),
  /if\s*\(!commitQualifiedBoard\(complete\)\)\s*\{[\s\S]*?return undefined;[\s\S]*?setActiveStoryboardId\(complete\.id\)/su,
  'a rejected reducer commit must return undefined before activation, notification, or batch success accounting',
);
assert.match(
  buildStoryboardSource,
  /if\s*\(\s*!isGenerationRequestCurrent\(\)\s*\)\s*return undefined;[\s\S]*?if\s*\(\s*fullTimeline\s*\)\s*throw error;[\s\S]*?reportOverrideFailure\(reason\)[\s\S]*?return undefined;/su,
  'stale storyboard requests must stay silent while current full-timeline failures propagate their original reason',
);
assert.doesNotMatch(appSource, /onClick=\{buildStoryboard\}/u, 'React click events must never be forwarded as generation overrides');

const generateCurrentStart = appSource.indexOf('const generateCurrentSequenceSegment = async');
const generateAllStart = appSource.indexOf('const generateAllSequenceSegments = async');
const generateAllEnd = appSource.indexOf('const handleCopyPrompt', generateAllStart);
assert.ok(
  generateCurrentStart >= 0 && generateAllStart > generateCurrentStart,
  'single-segment generation must be discoverable',
);
const generateCurrentSource = appSource.slice(generateCurrentStart, generateAllStart);
assert.ok(
  generateCurrentSource.indexOf('prepareMasterAlignedSequencePlan(') >= 0
    && generateCurrentSource.indexOf('prepareMasterAlignedSequencePlan(')
      < generateCurrentSource.indexOf('sequenceStoryboardGenerationIdentity('),
  'single-segment retry must repair old boundaries before it snapshots generation identity',
);
assert.match(
  generateCurrentSource,
  /const\s+requestConfigurationIdentity\s*=\s*segmentStoryboardConfigurationIdentityRef\.current[\s\S]*?const\s+stillCurrent\s*=\s*Boolean\([\s\S]*?requestConfigurationIdentity[\s\S]*?segmentStoryboardConfigurationIdentityRef\.current/su,
  'single-segment generation must discard a late result after real director settings change without marking the segment failed',
);
const segmentConfigurationStart = appSource.indexOf(
  'const segmentStoryboardConfigurationIdentity = JSON.stringify([',
);
const segmentConfigurationEnd = appSource.indexOf(
  'const segmentStoryboardConfigurationIdentityRef = useRef(',
  segmentConfigurationStart,
);
assert.ok(segmentConfigurationStart >= 0 && segmentConfigurationEnd > segmentConfigurationStart);
assert.doesNotMatch(
  appSource.slice(segmentConfigurationStart, segmentConfigurationEnd),
  /durationPreset|customDuration|sequencePlans/u,
  'display-only segment duration state and mutable plan status must not self-cancel generation',
);
assert.ok(
  generateAllStart >= 0 && generateAllEnd > generateAllStart,
  'serial all-segment generation must be discoverable',
);
const generateAllSource = appSource.slice(generateAllStart, generateAllEnd);
assert.ok(
  generateAllSource.indexOf('prepareMasterAlignedSequencePlan(') >= 0
    && generateAllSource.indexOf('prepareMasterAlignedSequencePlan(')
      < generateAllSource.indexOf('pendingSequenceSegmentIds(')
    && generateAllSource.indexOf('prepareMasterAlignedSequencePlan(')
      < generateAllSource.indexOf('sequenceBatchPlanFingerprint('),
  'batch generation must repair old boundaries before queue selection and identity snapshots',
);
assert.match(
  generateAllSource,
  /planSnapshot:\s*sequenceBatchPlanFingerprint\(sourcePlan\)[\s\S]*configurationSnapshot:\s*segmentStoryboardConfigurationIdentityRef\.current/su,
  'serial generation must snapshot all segment edits, locks, and director configuration',
);
assert.match(
  generateAllSource,
  /for\s*\(\s*const\s+segmentId\s+of\s+pendingIds\s*\)/su,
  'all-segment generation must use an explicitly serial for...of queue',
);
assert.match(
  generateAllSource,
  /await\s+buildStoryboard\(\{[\s\S]*?sequencePlanId:\s*plan\.id,[\s\S]*?segment:\s*liveSegment,[\s\S]*?segmentCount:\s*liveCount,[\s\S]*?keepDirector:\s*true,?[\s\S]*?\}\)/su,
  'each live segment must await the existing storyboard builder before the next starts',
);
assert.doesNotMatch(
  generateAllSource,
  /Promise\.all/u,
  'all-segment generation must never submit segment builders concurrently',
);
assert.match(
  generateAllSource,
  /updateSequenceSegmentRuntimeStatus\([\s\S]*?segmentId,[\s\S]*?"generating"/su,
  'each queued segment must be marked generating before work starts',
);
assert.match(
  generateAllSource,
  /if\s*\(\s*!completedBoard[\s\S]*?updateSequenceSegmentRuntimeStatus\([\s\S]*?"failed"/su,
  'an ordinary generation failure must be persisted without rolling back earlier segments',
);
assert.match(
  generateAllSource,
  /await\s+saveStateAsync\(stateRef\.current\)/u,
  'the latest state snapshot must be saved after every attempted segment',
);
assert.match(appSource, /取消顺序生成/u, 'the running queue must expose an explicit cancellation action');
assert.match(appSource, /sequenceBatchProgress/u, 'the running queue must expose visible progress');
assert.match(appSource, /onClick=\{\(\)\s*=>\s*void generateAllSequenceSegments\(activeSequencePlan\)\}/u);

const chooseSequenceStart = appSource.indexOf('const chooseSequenceSegment =');
const chooseSequenceEnd = appSource.indexOf('const persistSequencePlan', chooseSequenceStart);
const chooseSequenceSource = appSource.slice(chooseSequenceStart, chooseSequenceEnd);
assert.match(
  chooseSequenceSource,
  /setActiveStoryboardId\(segment\.storyboardId\s*\|\|\s*""\)/u,
  'selecting a segment must activate its own linked board or clear the previous result',
);

const directorViewStart = appSource.indexOf('function DirectorView');
const directorViewEnd = appSource.indexOf('function StoryboardView', directorViewStart);
const directorViewSource = appSource.slice(directorViewStart, directorViewEnd);
assert.match(
  directorViewSource,
  /activeStoryboard:\s*rootActiveStoryboard/u,
  'the root board must be renamed before deriving the displayed sequence board',
);
assert.match(
  directorViewSource,
  /const\s+activeStoryboard\s*=\s*productionMode\s*===\s*"sequence"/u,
  'the director result must be derived from the current sequence segment',
);
assert.match(appSource, /导出全部分段提示词/u);
assert.doesNotMatch(directorViewSource, /导出分段 JSON/u, 'the retired sequence JSON export must not remain in the director UI');
assert.match(directorViewSource, /<DirectorPromptMoreMenu[\s\S]*?label:\s*"修复对白与排时"[\s\S]*?label:\s*"导出全部分段提示词"/u,
  'low-frequency repair and whole-plan TXT export must remain reachable through More');
assert.match(appSource, /未关联分段分镜/u, 'orphaned sequence storyboards must remain browsable');
assert.match(appSource, /全局.*本段/u, 'sequence storyboard navigation must show global and local duration context');

const storyboardImageBatchStart = directorViewSource.indexOf(
  'const generateStoryboardImageBatch = async (mode: StoryboardImageBatchMode) => {',
);
const storyboardImageBatchEnd = directorViewSource.indexOf('\n  return (', storyboardImageBatchStart);
assert.ok(
  storyboardImageBatchStart >= 0 && storyboardImageBatchEnd > storyboardImageBatchStart,
  'the storyboard image batch flow must be discoverable',
);
const storyboardImageBatchSource = directorViewSource.slice(
  storyboardImageBatchStart,
  storyboardImageBatchEnd,
);
assert.ok(
  storyboardImageBatchSource.indexOf('storyboardImageBatchLifecycle.begin(guardKey)')
    < storyboardImageBatchSource.indexOf('await prepareStoryboardImageIdentityContext({'),
  'the duplicate-start lease must be acquired before waiting for AI identity enrichment',
);
assert.match(
  storyboardImageBatchSource,
  /const\s+imageBatchRequestIdentity\s*=\s*getCurrentStoryboardOperationIdentity\(\);[\s\S]*?const imagePlanningIsCurrent = \(\) =>[\s\S]*?getCurrentState\(\)\.project\.storyboards\.find[\s\S]*?isCurrentStoryboardOperation\([\s\S]*?await prepareStoryboardImageIdentityContext\([\s\S]*?if\s*\(!imagePlanningIsCurrent\(\)\)\s*return;/u,
  'editing or switching the source storyboard while visible-character AI is running must stop the stale batch before any image-model charge',
);
assert.match(
  storyboardImageBatchSource,
  /requestVisibleCharacters:\s*async\s*\(\)\s*=>[\s\S]*?requestStoryboardVisibleCharacters\([\s\S]*?knownCharacterNames:[\s\S]*?shots:/u,
  'the real storyboard image flow must ask the text AI for an authoritative per-shot visible-character map before identity completion',
);
assert.match(
  storyboardImageBatchSource,
  /const\s+liveProjectContext\s*=\s*getCurrentProjectImageContext\(\);[\s\S]*?mergeStoryboardImageIdentityEnrichment\(\s*liveProjectContext\.characters,\s*preparedIdentity\.context\.characters,\s*preparedIdentity\.plan\.targets,/u,
  'AI identity fields must merge into the live character list instead of replacing it with the request snapshot',
);
assert.match(
  storyboardImageBatchSource,
  /projectContext\s*=\s*\{[\s\S]*?\.\.\.liveProjectContext,[\s\S]*?characters:\s*mergedCharacters,[\s\S]*?visibleCharacterNamesByShotId:\s*preparedIdentity\.context\.visibleCharacterNamesByShotId,/u,
  'the AI per-shot visible-character decision must survive the live project merge and reach every image converter request',
);
assert.match(
  storyboardImageBatchSource,
  /const\s+currentOfficialPromptContext\s*:\s*OfficialH3ProjectContext\s*=\s*\{[\s\S]*?assets:\s*project\.assets,[\s\S]*?characters:\s*project\.characters,[\s\S]*?refreshOfficialH3PromptAfterSourceUpdate\([\s\S]*?currentOfficialPromptContext,/u,
  'official H3 enrichment refresh must compare against the live source bible at atomic commit time',
);
assert.match(
  storyboardImageBatchSource,
  /projectContext\s*=\s*\{\s*\.\.\.liveProjectContext,\s*characters:\s*mergedCharacters,\s*visibleCharacterNamesByShotId:\s*preparedIdentity\.context\.visibleCharacterNamesByShotId,?\s*\};[\s\S]*?characters:\s*projectContext\.characters\.map/u,
  'the persisted characters and this batch must share the same live-state merge result',
);
assert.match(
  storyboardImageBatchSource,
  /sourceUnchanged\s*=\s*Boolean\([\s\S]*?storyboardImageSourceFingerprint\(currentBoard,\s*request,\s*\{[\s\S]*?visibleCharacterNamesByShotId:\s*projectContext\.visibleCharacterNamesByShotId,/u,
  'completion-time fingerprinting must reuse the batch AI visible-character map or successful images will be treated as stale and never bind',
);
assert.doesNotMatch(
  storyboardImageBatchSource,
  /(?:targetModelId|targetOutput|officialPromptZh|officialPromptEn|officialPromptSource|officialPromptEnSource)\s*:/u,
  'storyboard image success binding must preserve the current official H3 artifact',
);
assert.match(
  storyboardImageBatchSource,
  /const\s+bound\s*=\s*bindStoryboardImageAsset\([\s\S]*?return\s*\{\s*\.\.\.bound,/u,
  'storyboard image success binding must return the complete board so official fields survive',
);
assert.equal(
  (storyboardImageBatchSource.match(/storyboardImageBatchLifecycle\.finish\(batchLease\)/gu) || []).length,
  1,
  'every post-lease return and the completed batch must release the lease through one finally block',
);
assert.match(
  storyboardImageBatchSource,
  /try\s*\{[\s\S]*?await prepareStoryboardImageIdentityContext\([\s\S]*?if\s*\(!novelAiReferencePreflight\.allowed\)\s*\{[\s\S]*?return;[\s\S]*?\}\s*finally\s*\{\s*storyboardImageBatchLifecycle\.finish\(batchLease\);\s*setStoryboardImagePreparation\([^;]*\);\s*\}/u,
  'identity/preflight early exits and normal generation must all be enclosed by the lease finally',
);

for (const field of ['sequencePlanId', 'segmentId', 'segmentIndex']) {
  assert.match(
    videoGenerationSource,
    new RegExp(`${field}:\\s*draft\\.source\\?\\.${field}`, 'u'),
    `shared video tasks must retain the chosen source ${field}`,
  );
}

const saveStorySource = appSource.slice(
  appSource.indexOf('const handleSaveStory ='),
  appSource.indexOf('const handleAnalyzeStory ='),
);
const analyzeStorySource = appSource.slice(
  appSource.indexOf('const handleAnalyzeStory ='),
  appSource.indexOf('const handleImportStoryFile ='),
);
const importStorySource = appSource.slice(
  appSource.indexOf('const handleImportStoryFile ='),
  appSource.indexOf('const buildStoryboard ='),
);
const sourceIntegrityMasterGenerationSource = appSource.slice(
  appSource.indexOf('const generateSequenceMasterPrompt ='),
  appSource.indexOf('const updateSequenceMasterPrompt ='),
);
for (const [label, source] of [
  ['saving', saveStorySource],
  ['import', importStorySource],
  ['master generation', sourceIntegrityMasterGenerationSource],
] as const) {
  assert.match(
    source,
    /resolveSourceIntegrityForAction\(/u,
    `${label} must require an explicit source-integrity decision before consuming duplicate text`,
  );
}
assert.doesNotMatch(analyzeStorySource,
  /(?:resolveSourceIntegrityForAction|splitIntoScenes|analyzeTextLocally|mergeAuthoritativeStorySceneBlocks|runIndependentStoryAnalysisEnrichment)\(/u,
  'full-source AI analysis must not deduplicate, locally split or replace the source before sending it to the model');
assert.match(analyzeStorySource, /const sourceStory = storyInput;/u,
  'AI directly receives the complete story draft, including material the user has not yet saved');
assert.match(analyzeStorySource, /const blocks = analysisResponse\.scenes\.map\(/u,
  'the AI response, not local scene segmentation, defines the persisted scene rows');
assert.match(analyzeStorySource, /content:\s*block\.content/u,
  'scene records preserve the AI-authored content instead of substituting a local excerpt');
assert.match(analyzeStorySource,
  /if\s*\(!useApi\)\s*\{[\s\S]*?setView\("settings"\);\s*return;/u,
  'analysis requires a configured text API and cannot fall back to local entity generation');
assert.match(analyzeStorySource,
  /if\s*\(!isAnalysisCurrent\(\)\)\s*return;[\s\S]*?setState\(\(current\) => applyProjectUpdateForRequest\(/u,
  'the full-source result is committed only while the owning project and draft remain current');

const segmentPlanningSource = appSource.slice(
  appSource.indexOf('const segmentConfirmedMasterPrompt ='),
  appSource.indexOf('const updateSequenceSegmentFromEditor ='),
);
assert.match(
  segmentPlanningSource,
  /reconcileSequenceSegmentsToShotProvenance\(/u,
  'shot-boundary alignment must reconcile segment text and beat ownership from authoritative shot provenance',
);
assert.match(
  buildStoryboardSource,
  /composeDerivedLocalPrompt\(\s*canonicalMasterSlice\.shots\s*,\s*segmentForGeneration\?\.entryState\s*,\s*segmentForGeneration\?\.exitState\s*,?\s*\)/su,
  'master-derived segment prompts must receive entry and exit continuity states',
);
assert.doesNotMatch(
  analyzeStorySource,
  /:\s*nextScenes\.map\(\(scene\)\s*=>\s*scene\.id\)/u,
  'ordinary storyboards must not be rebound to every scene after story re-analysis',
);
assert.match(
  analyzeStorySource,
  /if\s*\(locationName\)[\s\S]*?nextLocations\.push\(location\)/su,
  'story analysis must only persist a location when it has a non-empty name',
);

const conversionPromptSource = appEffectsSource.slice(
  appEffectsSource.indexOf('const coreTask = ['),
  appEffectsSource.indexOf('const userPrompt = [', appEffectsSource.indexOf('const coreTask = [')),
);
assert.match(conversionPromptSource, /VIDEO_CONVERSION_STORY_RULE/u, 'live conversion must use the shared story-to-video source contract');
assert.match(conversionPromptSource, /VIDEO_DIALOGUE_RULE/u, 'live conversion must carry the full-dialogue preservation contract');
assert.match(conversionPromptSource, /VIDEO_SCENE_STYLE_RULE[\s\S]*?VIDEO_LOCAL_TIME_RULE/u, 'natural staging and local-time rules must come from the shared contract');
assert.doesNotMatch(conversionPromptSource, /1[–-]3个阶段|禁止使用“随后、然后、接着、紧接着、随即”/u, 'retired wording and action-count gates cannot be restored by the workflow test');
assert.doesNotMatch(conversionPromptSource, /动作1→动作2→动作3|三拍动作链/u);
const singleSegmentPromptSource = readFileSync(new URL('../src/singleSegmentPrompt.ts', import.meta.url), 'utf8');
assert.match(
  buildStoryboardSource,
  /await generateSingleSegmentPrompt\(/u,
  'clicking generate must invoke the shared single-segment service before committing a final prompt',
);
assert.match(singleSegmentPromptSource, /await convertStoryboardDraftToFinal\(/u, 'the shared service must actually invoke the converter');
assert.match(
  buildStoryboardSource,
  /const generationCharacters = semanticSequenceCharacters\(sourcePlanForGeneration, state\.project\.characters\);/u,
  'generation must resolve frozen semantic character facts while retaining live project facts for historical/single routes',
);
assert.match(
  buildStoryboardSource,
  /requestShotRecommendation\([\s\S]*?characterContinuity:\s*generationCharacters/u,
  'AI storyboard planning must receive the resolved character gender and identity continuity facts',
);
assert.match(
  buildStoryboardSource,
  /const singleSegmentContext:[\s\S]*?characters:\s*generationCharacters[\s\S]*?generateSingleSegmentPrompt\(\{[\s\S]*?context: singleSegmentContext/u,
  'the shared final prompt service must receive the same resolved character gender and identity facts',
);
assert.match(singleSegmentPromptSource, /convertStoryboardDraftToFinal\(\{[\s\S]*?characters:\s*input\.context\.characters/u, 'the shared converter must consume the supplied character facts');
assert.doesNotMatch(
  buildStoryboardSource,
  /strictConversion:\s*true|previousFinalPrompt:\s*localDraft\.finalPrompt|转化器返回内容未通过最终质量校验/u,
  'automatic conversion must not run strict quality gates after the model returned a usable prompt',
);
assert.doesNotMatch(
  buildStoryboardSource,
  /validateStoryboardPrompt\(\s*complete[\s\S]*?提示词校验未通过/u,
  'the converted final prompt must not be discarded by a second local quality-validation pass',
);
const sharedPromptGenerationIndex = buildStoryboardSource.indexOf(
  'await generateSingleSegmentPrompt({',
);
const deferredMasterReturnIndex = buildStoryboardSource.indexOf(
  'if (fullTimeline && override?.deferCommit) return complete;',
);
assert.ok(
  sharedPromptGenerationIndex >= 0 && deferredMasterReturnIndex > sharedPromptGenerationIndex,
  'every generated board, including a deferred full-timeline board, must await the shared bilingual pipeline before returning or committing',
);
assert.match(
  singleSegmentPromptSource,
  /await translateVideoPromptToEnglish\([\s\S]*?officialPromptEnSource:\s*official\.officialPromptZh,[\s\S]*?englishPromptSource:\s*official\.finalPrompt/u,
  'the Chinese and English prompts must be attached to the same completed storyboard with an exact source link',
);
assert.match(singleSegmentPromptSource, /await convertStoryboardDraftToFinal\([\s\S]*?applyOfficialH3Prompt\(chinese,[\s\S]*?await reviewQualifiedChinese\(official, conversionSource\)[\s\S]*?return translateQualifiedChinese\(reviewed, false, conversionSource\)/u, 'ordinary generation must compile Chinese, review it through AI, then translate that exact reviewed official artifact');
assert.match(
  buildStoryboardSource,
  /await\s+generateSingleSegmentPrompt\([\s\S]*?isCurrent:\s*isGenerationRequestCurrent,[\s\S]*?if\s*\(!isGenerationRequestCurrent\(\)\)\s*return undefined;/u,
  'a late English response must be rejected before the bilingual storyboard can be committed',
);
assert.match(
  buildStoryboardSource,
  /onQualifiedChinese:[\s\S]*?commitQualifiedBoard\(qualified\)[\s\S]*?await saveStateAsync\(stateRef\.current\)[\s\S]*?if \(complete\.officialPromptEnError\)[\s\S]*?中文已完成并保存；英文待重试/u,
  'qualified Chinese is persisted before English, and English failure must remain independently retryable',
);
assert.doesNotMatch(
  directorViewSource,
  /translatePromptToEnglish|重新翻译英文|转成英文/u,
  'the manual English conversion action must be removed from the director result panel',
);
assert.equal(
  (directorViewSource.match(/className=\{`result-language-card\s+(?:zh|en)/gu) || []).length,
  2,
  'the result header must always render separate Chinese and English language cards',
);
assert.match(
  directorViewSource,
  /role="group"[\s\S]*?aria-label="提示词语言"[\s\S]*?aria-pressed=\{promptLanguage === "zh"\}[\s\S]*?aria-pressed=\{promptLanguage === "en"\}/u,
  'the language cards must expose their selected state without incomplete tab semantics',
);
assert.match(
  directorViewSource,
  /className=\{`result-language-card en[\s\S]*?disabled=\{!validEnglishPrompt\}/u,
  'legacy or edited results without a matching English source must keep the English card visible but disabled',
);
assert.doesNotMatch(appSource, /enhanceWithApi|转换器 API 润色/u);

const sequenceCustomDurationSource = appSource.slice(
  appSource.indexOf('aria-label="自定义单段秒数"'),
  appSource.indexOf('</Field>', appSource.indexOf('aria-label="自定义单段秒数"')),
);
assert.match(
  sequenceCustomDurationSource,
  /max=\{MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC\}/u,
  'the AI-planning custom duration input must expose the supported 1–300 second range',
);
assert.match(
  sequenceCustomDurationSource,
  /Math\.min\(\s*MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC,/u,
  'the AI-planning custom duration handler must not silently reuse the legacy 15-second local partition limit',
);

const baseBoard = {
  id: 'board-1', finalPrompt: 'A\nB', englishPrompt: 'A', shots: [
    { id: 's1', index: 1, startSec: 0, endSec: 2, prompt: 'A' }
  ], updatedAt: 100
};
const revision1 = createStoryboardRevision(baseBoard, [], { label: 'initial', createdAt: 100 });
const revision2 = createStoryboardRevision({ ...baseBoard, finalPrompt: 'A\nC', shots: [{ ...baseBoard.shots[0], prompt: 'C' }] }, [revision1], { label: 'rewrite', createdAt: 200 });
assert.equal(revision1.revision, 1);
assert.equal(revision2.revision, 2);
assert.equal(revision1.finalPrompt, 'A\nB');
const diff = comparePromptText(revision1.finalPrompt, revision2.finalPrompt);
assert.deepEqual(diff.removed, ['B']);
assert.deepEqual(diff.added, ['C']);
const revisionDiff = compareStoryboardRevisions(revision1, revision2);
assert.deepEqual(revisionDiff.changedShotIds, ['s1']);
const ab = createABCandidates(revision1, [revision2]);
assert.equal(ab.candidates.length, 2);
assert.equal(ab.candidates[1].changedFromBase, true);

console.log('continuity, generation-plan, and storyboard-version checks passed');
