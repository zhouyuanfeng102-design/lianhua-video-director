import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildImageWorkbenchEntity,
  imageWorkbenchEntityToForm,
} from '../src/imageGeneration';
import type { Character } from '../src/types';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const imageWorkbenchStart = source.indexOf('function ImageWorkbenchView(ctx: AppContext)');
const assetsViewStart = source.indexOf('function AssetsView(ctx: AppContext)');
assert.ok(imageWorkbenchStart >= 0 && assetsViewStart > imageWorkbenchStart);
const imageWorkbench = source.slice(imageWorkbenchStart, assetsViewStart);
const storyboardBatchStart = source.indexOf('const generateStoryboardImageBatch = async');
const storyboardRenderStart = source.indexOf('return (', storyboardBatchStart);
assert.ok(storyboardBatchStart >= 0 && storyboardRenderStart > storyboardBatchStart);
const storyboardBatch = source.slice(storyboardBatchStart, storyboardRenderStart);
const selectedStoryboardBatchStart = imageWorkbench.indexOf('const generateSelectedStoryboardImages = async');
const selectedStoryboardBatchEnd = imageWorkbench.indexOf('const prompt = generatedPrompt;', selectedStoryboardBatchStart);
assert.ok(selectedStoryboardBatchStart >= 0 && selectedStoryboardBatchEnd > selectedStoryboardBatchStart);
const selectedStoryboardBatch = imageWorkbench.slice(selectedStoryboardBatchStart, selectedStoryboardBatchEnd);
const createPromptAssetStart = imageWorkbench.indexOf('const createPromptAsset = async () =>');
const createPromptAssetEnd = imageWorkbench.indexOf(
  'const generateSelectedStoryboardImages = async',
  createPromptAssetStart,
);
assert.ok(createPromptAssetStart >= 0 && createPromptAssetEnd > createPromptAssetStart);
const createPromptAsset = imageWorkbench.slice(createPromptAssetStart, createPromptAssetEnd);
const analyzeReferenceStart = imageWorkbench.indexOf('const analyzeUploadedReference = async () =>');
assert.ok(analyzeReferenceStart >= 0 && createPromptAssetStart > analyzeReferenceStart);
const analyzeReference = imageWorkbench.slice(analyzeReferenceStart, createPromptAssetStart);
assert.doesNotMatch(analyzeReference, /sanitizeNonHuman(?:Age|Morphology)AnalysisFields/u,
  'vision output must not be locally rejected or rewritten by species/age keyword rules');
assert.match(analyzeReference, /const suggestedFields = \{ \.\.\.analysis\.fields \};/u,
  'vision autofill should retain the AI-authored field text');
assert.match(analyzeReference, /suggestedFields\.age = suggestedFields\.apparentAge/u,
  'canonical apparentAge must still be mapped to the rendered workbench age field');
assert.match(analyzeReference, /mergeMissingImageAssetFormFields\(requestedAssetKind, currentForm, suggestedFields\)/u,
  'vision autofill must preserve existing user fields and only fill missing fields');

assert.match(
  selectedStoryboardBatch,
  /manualRuleSetId:\s*activeImagePromptRuleSetId\s*\|\|\s*undefined/u,
  'selected-shot generation must use the same effective rule ID shown by the workbench, including compatibility fallback',
);
assert.match(
  selectedStoryboardBatch,
  /manualPresetId:\s*activeImagePromptPresetId\s*\|\|\s*undefined/u,
  'selected-shot generation must use the same effective preset ID shown by the workbench, including disabled-preset fallback',
);

assert.ok(
  selectedStoryboardBatch.includes('const guardKey = `${requestedProjectId}:${sourceBoard.id}`;')
    && selectedStoryboardBatch.includes('storyboardImageBatchLifecycle.begin(guardKey)'),
  'selected-shot image batches must share the DirectorView project/storyboard guard without a random batch suffix',
);
const selectedStoryboardLeaseStart = selectedStoryboardBatch.indexOf('storyboardImageBatchLifecycle.begin(');
const selectedStoryboardRejectedLease = selectedStoryboardBatch.indexOf('if (!lease)', selectedStoryboardLeaseStart);
const selectedStoryboardRejectedReturn = selectedStoryboardBatch.indexOf('return;', selectedStoryboardRejectedLease);
const selectedStoryboardTaskCreation = selectedStoryboardBatch.indexOf('createImageGenerationTask(');
const selectedStoryboardTaskInsertion = selectedStoryboardBatch.indexOf('generationTasks: [...tasks,');
assert.ok(
  selectedStoryboardLeaseStart >= 0
    && selectedStoryboardRejectedLease > selectedStoryboardLeaseStart
    && selectedStoryboardRejectedReturn > selectedStoryboardRejectedLease
    && selectedStoryboardTaskCreation > selectedStoryboardRejectedReturn
    && selectedStoryboardTaskInsertion > selectedStoryboardTaskCreation,
  'a rejected selected-shot batch lease must return before creating or inserting queued tasks',
);
const selectedBindingReducerStart = selectedStoryboardBatch.indexOf('const currentBoard = project.storyboards.find(');
const selectedBindingReducerEnd = selectedStoryboardBatch.indexOf('return asset;', selectedBindingReducerStart);
assert.ok(selectedBindingReducerStart >= 0 && selectedBindingReducerEnd > selectedBindingReducerStart);
const selectedBindingReducer = selectedStoryboardBatch.slice(selectedBindingReducerStart, selectedBindingReducerEnd);
assert.match(
  selectedBindingReducer,
  /resolveStoryboardImageBinding\(\{\s*lifecycleCurrent:\s*storyboardImageBatchLifecycle\.canBind\(lease\),\s*taskTracked,\s*storyboardPresent:\s*Boolean\(currentBoard\),\s*sourceUnchanged,/u,
  'selected-shot results must use the same lifecycle, task, board and source binding decision as DirectorView',
);
assert.match(
  selectedBindingReducer,
  /candidate\.id === task\.id[\s\S]*?isImageGenerationTask\(candidate\)[\s\S]*?candidate\.batchId === batchId/u,
  'a removed or replaced selected-shot task must not bind its late result',
);
assert.match(
  selectedBindingReducer,
  /task\.sourceFingerprint === storyboardImageSourceFingerprint\(currentBoard, request, \{/u,
  'selected-shot results must compare their request fingerprint with the live storyboard',
);
for (const field of ['characters', 'locations', 'props', 'scenes', 'assets']) {
  assert.ok(
    selectedBindingReducer.includes(`${field}: project.${field}`),
    `selected-shot binding fingerprints must read live project ${field}`,
  );
}
assert.match(
  selectedBindingReducer,
  /const boundBoard = bindingDecision\.shouldBind && currentBoard/u,
  'stale selected-shot results must not call the asset binder',
);
assert.match(selectedBindingReducer, /assets:\s*\[asset, \.\.\.project\.assets\]/u, 'stale results must still be preserved as assets');
assert.match(
  selectedBindingReducer,
  /bindingWarning:\s*\[bindingDecision\.warning,\s*imageSizeWarning\]\.filter\(Boolean\)\.join\(["'] ["']\)\s*\|\|\s*undefined/u,
  'the completed task must preserve automatic-binding and image-size warnings together without empty warning text',
);

assert.match(imageWorkbench, /resolveImagePromptSelection\s*\(/u);
assert.match(imageWorkbench, /buildImagePromptConverterSystemPrompt\s*\(/u);
assert.match(imageWorkbench, /sanitizeFinalImagePrompt\s*\(/u);
assert.match(imageWorkbench, /生图规则集/u);
assert.match(imageWorkbench, /分类预设/u);
assert.match(imageWorkbench, /imagePromptRuleSetIdByBackend/u);
assert.match(imageWorkbench, /privateImagePromptRuleSetIdByBackend/u);
assert.match(imageWorkbench, /imagePromptPresetIdByAssetKind/u);
assert.match(imageWorkbench, /const selectableImagePromptRuleSets = state\.imagePromptRules\.ruleSets\.filter\(\(item\) => item\.enabled\)/u,
  'the dropdown must expose every enabled rule independently of the execution backend');
assert.doesNotMatch(imageWorkbench, /compatibleImagePromptRuleSets/u, 'manual rule choices must not be filtered back to the API backend');
assert.match(imageWorkbench, /imageBackend: dataUrl \|\| remoteUrl \? requestedImageApi\.backend : undefined/u,
  'generated assets must record the physical API rather than infer it from prompt format');
assert.match(selectedStoryboardBatch, /imageBackend: imageApi\.backend/u);
assert.match(storyboardBatch, /imageBackend: imageApi\.backend/u);
for (const field of [
  'imagePromptRuleSetId',
  'imagePromptRuleSetVersion',
  'imagePromptPresetId',
  'imagePromptPresetVersion',
  'imagePromptFormat',
]) {
  assert.match(imageWorkbench, new RegExp(field, 'u'), `workbench missing ${field}`);
  assert.match(storyboardBatch, new RegExp(field, 'u'), `storyboard batch missing ${field}`);
}
assert.doesNotMatch(
  imageWorkbench,
  /Keep the deterministic local prompt|optional converter is unavailable/u,
  'converter failures must not silently fall back to a local prompt',
);
assert.doesNotMatch(
  storyboardBatch,
  /批量剧情出图尚未接入 NovelAI/u,
  'NovelAI must use its native image adapter in storyboard batches',
);
const novelAiReferencePreflightCall = storyboardBatch.indexOf(
  'checkNovelAIReferenceImagePreflight(',
);
const storyboardBatchLeaseStart = storyboardBatch.indexOf(
  'storyboardImageBatchLifecycle.begin(',
);
const storyboardTaskCreation = storyboardBatch.indexOf(
  'createImageGenerationTask(',
);
const storyboardConverterCall = storyboardBatch.indexOf(
  'await requestImagePromptConverter(',
);
assert.ok(
  novelAiReferencePreflightCall >= 0,
  'storyboard batches must run the NovelAI reference-image preflight',
);
assert.ok(
  storyboardBatchLeaseStart >= 0 && storyboardBatchLeaseStart < novelAiReferencePreflightCall,
  'the duplicate-start lease must cover identity enrichment before reference preflight',
);
for (const [boundaryName, boundaryOffset] of [
  ['task creation', storyboardTaskCreation],
  ['text converter', storyboardConverterCall],
] as const) {
  assert.ok(
    boundaryOffset > novelAiReferencePreflightCall,
    `NovelAI reference-image preflight must run before ${boundaryName}`,
  );
}
assert.match(storyboardBatch, /resolveImagePromptSelection\s*\(/u);
assert.match(storyboardBatch, /buildImagePromptConverterSystemPrompt\s*\(/u);
assert.match(storyboardBatch, /sanitizeFinalImagePrompt\s*\(/u);
assert.doesNotMatch(
  imageWorkbench,
  /generatedPrompt\s*\|\|\s*buildImagePrompt/u,
  'unconverted local prompt data must not be displayed as the final image prompt',
);
assert.doesNotMatch(
  imageWorkbench,
  /scope\s*===\s*imageScope|character-image|location-image|prop-image|grid-image/u,
  'the image workbench must not secretly select a legacy video converter preset',
);
const converterCall = imageWorkbench.indexOf('await requestImagePromptConverter(');
const imageModelCall = imageWorkbench.indexOf('await requestImageModel(');
assert.ok(
  converterCall >= 0 && imageModelCall > converterCall,
  'the image model call must remain behind the mandatory AI converter boundary',
);
assert.match(
  createPromptAsset,
  /const requestedGenerationMode = imageGenerationMode;/u,
  'an asynchronous image request must snapshot the ordinary/private lane that launched it',
);
assert.match(
  createPromptAsset,
  /const requestIdentity = \{[\s\S]*?targetEpoch:[\s\S]*?generationMode: requestedGenerationMode,/u,
  'the request identity must include both the target epoch and snapshotted generation lane',
);
assert.match(
  createPromptAsset,
  /patchImageGenerationLane\(requestedGenerationMode, \{[\s\S]*?generatedPrompt: convertedPrompt,[\s\S]*?outputPane: "prompt",?[\s\S]*?\}\);/u,
  'a converted prompt must return to the lane that launched the request even after the user switches modes',
);
assert.match(
  createPromptAsset,
  /patchImageGenerationLane\(requestedGenerationMode, \{[\s\S]*?generatedImagePreview: assetPreviewUrl\(asset\),[\s\S]*?outputPane: "preview",?[\s\S]*?\}\);/u,
  'a generated image must return to the lane that launched the request',
);
assert.doesNotMatch(
  createPromptAsset,
  /setUploadedPreview\(assetPreviewUrl\(asset\)\)/u,
  'a generated image must never replace the reference input for the next request',
);

const privateReferenceMatcherStart = source.indexOf(
  'const isMatchingNsfwPrivateWorkbenchReference',
);
const privateReferenceMatcherEnd = source.indexOf('\n};', privateReferenceMatcherStart);
assert.ok(
  privateReferenceMatcherStart >= 0 && privateReferenceMatcherEnd > privateReferenceMatcherStart,
  'the workbench must keep private-reference disclosure in one explicit matcher',
);
const privateReferenceMatcher = source.slice(
  privateReferenceMatcherStart,
  privateReferenceMatcherEnd + 3,
);
for (const requiredCheck of [
  /hasUsableStoryboardReferencePixels\(asset\)/u,
  /isNsfwPrivateProfileAsset\(asset\)/u,
  /asset\.sourceEntityId === characterId/u,
  /asset\.imageVariant === "private-four-in-one" \|\| nsfwPrivatePartForAsset\(asset\) === privatePart/u,
]) {
  assert.match(
    privateReferenceMatcher,
    requiredCheck,
    'a private reference must have pixels and match both the selected character and private part',
  );
}
assert.match(
  imageWorkbench,
  /privateVariantSelected\s*\?\s*state\.project\.assets\.filter\(\(asset\)\s*=>\s*isMatchingNsfwPrivateWorkbenchReference\(\s*asset,\s*selectedEntityId,\s*nsfwPrivatePart,?\s*\)\)\s*:\s*filterStoryboardReferenceAssets\(state\.project\.assets\)/u,
  'private mode must retain matching private references and all active ordinary creation kinds retain the non-private filter',
);
assert.match(
  imageWorkbench,
  /privateVariantSelected\s*\?\s*isMatchingNsfwPrivateWorkbenchReference\(\s*candidate,\s*selectedEntityId,\s*nsfwPrivatePart,?\s*\)\s*:\s*assetKind\s*===\s*"grid"\s*\?\s*candidate\?\.role\s*===\s*"grid"\s*&&\s*hasUsableStoryboardReferencePixels\(candidate\)\s*:\s*isUsableStoryboardReferenceAsset\(candidate\)/u,
  'selected references must be invalidated when the character, part or mode changes, and grid selections require real grid pixels',
);
assert.doesNotMatch(imageWorkbench, /\busableGridAssets\b/u,
  'active image creation must not reintroduce a grid-only picker after retirement');
assert.match(imageWorkbench, /const assetKind = activeImageAssetKind\(storedAssetKind\);/u,
  'a restored grid creation control must normalize before it can influence private or ordinary reference selection');

assert.match(
  imageWorkbench,
  /const imagePromptAssetKind:[\s\S]*?isPrivateCharacterVariant[\s\S]*?\?\s*"character-private"/u,
  'the private workbench variant must select the dedicated character-private prompt category',
);
assert.match(
  imageWorkbench,
  /const requestedPrivateImageVariant = requestedGenerationMode === "private"[\s\S]*?requestedImageVariant === "private-full-body"[\s\S]*?requestedImageVariant === "private-turnaround"[\s\S]*?requestedImageVariant === "private-four-in-one"[\s\S]*?requestedImageVariant === "private-close-up"/u,
  'the request snapshot must recognize every private image variant',
);
assert.match(
  imageWorkbench,
  /const requestedNsfwPrivatePart:[\s\S]*?requestedImageVariant === "private-close-up"[\s\S]*?\? nsfwPrivatePart[\s\S]*?: "full-body"/u,
  'private full-body, private four-view, and four-in-one requests must bind to the full-body private dossier while close-ups preserve the selected part',
);
assert.match(
  imageWorkbench,
  /const requestedImagePromptAssetKind:[\s\S]*?requestedNsfwPrivatePart[\s\S]*?\? "character-private"/u,
  'queued private generation must continue using character-private after the live form changes',
);
assert.match(
  imageWorkbench,
  /requestImagePromptConverter\(\s*requestedTextApi,\s*requestedImagePromptAssetKind,/u,
  'the prompt converter must receive the snapshotted character-private category',
);
assert.match(
  imageWorkbench,
  /buildImagePrompt\(\s*requestedAssetKind,\s*requestedAssetForm,\s*requestedImageVariant,\s*requestedNsfwPrivatePart,?\s*\)/u,
  'the deterministic conversion source must receive the selected private part',
);
assert.match(
  imageWorkbench,
  /privateImagePromptProblem\(\s*requestedImageVariant,\s*convertedCandidate,\s*requestedNsfwPrivatePart/u,
  'every guarded private variant must use the shared layout validator',
);
assert.match(
  imageWorkbench,
  /privateImageVariantConverterRule\(requestedImageVariant, requestedNsfwPrivatePart\)/u,
  'private converter rules must come from the variant-exclusive shared contract',
);
assert.match(
  imageWorkbench,
  /privateImageVariantRepairRule\(requestedImageVariant, requestedNsfwPrivatePart\)/u,
  'private repair must restate only the requested positive target instead of echoing rejected layout names',
);
assert.match(
  imageWorkbench,
  /const requestedImageCustomRequirement = autofillRequirement\.trim\(\)\.slice\(0, 2000\);[\s\S]*?const baseConversionSource = buildImagePrompt\([\s\S]*?const conversionSource = requestedImageCustomRequirement[\s\S]*?本次生成图片额外要求/u,
  'the custom requirement input must be sent as an image-generation extra requirement, not only as an autofill hint',
);
assert.match(
  imageWorkbench,
  /const requestedNegativePrompt = requestedNsfwPrivatePart\s*\?\s*privateImageVariantNegativePrompt\(requestedImageVariant\)\s*:\s*requestedImageVariant === "five-view"\s*\?\s*sanitizeFinalImagePrompt\(/u,
  'a private image request must use only its variant-specific layout negative instead of inheriting rule, preset, or free-form negatives',
);
assert.match(
  createPromptAsset,
  /const requestedNegativePrompt = requestedNsfwPrivatePart[\s\S]*?ordinaryImageVariantNegativePrompt\(requestedImageVariant\)[\s\S]*?sanitizeFinalImagePrompt\(/u,
  'ordinary image requests must merge the selected variant negative (including the full-body crop guard) before the backend call',
);
assert.match(
  createPromptAsset,
  /ordinaryImageVariantConverterRule\(requestedImageVariant\)/u,
  'ordinary image conversion must carry the selected layout contract into the AI converter',
);
assert.match(
  createPromptAsset,
  /gptImage25MicroNsfwConverterExtraRule\(imagePromptSelection,\s*requestedImagePromptAssetKind,\s*requestedImageVariant\)/u,
  'ordinary image conversion must inject the selected GPT Image 2.5 micro NSFW converter contract before calling the text model',
);
assert.match(
  source,
  /gptImage25MicroNsfwConverterExtraRule\(selection,\s*promptKind,\s*originalTask\.imageVariant\)/u,
  'regeneration prompt reconstruction must preserve the selected GPT Image 2.5 micro NSFW converter contract',
);
assert.ok(
  (source.match(/gptImage25MicroNsfwConverterExtraRule\(imagePromptSelection,\s*"storyboard",\s*"storyboard-frame"\)/gu) || []).length >= 2,
  'both storyboard image converter paths must inject the selected GPT Image 2.5 micro NSFW contract',
);
assert.match(
  createPromptAsset,
  /await requestImageModel\([\s\S]*?negativePrompt:\s*requestedNegativePrompt,/u,
  'the backend request must receive the same ordinary variant negative that was persisted on the queued task',
);
assert.match(
  imageWorkbench,
  /createImageGenerationTask\(\{[\s\S]*?negativePrompt:\s*requestedNegativePrompt\s*\|\|\s*undefined,[\s\S]*?referenceScope:\s*requestedNsfwPrivatePart\s*\?\s*"nsfw-private-profile"\s*:\s*"general"/u,
  'the queued private task must persist the variant-specific requestedNegativePrompt and its private reference scope together',
);
assert.match(
  imageWorkbench,
  /type ImageGenerationMode = "ordinary" \| "private";[\s\S]*?interface ImageGenerationLaneState \{[\s\S]*?referencePreview: string;[\s\S]*?generatedPrompt: string;[\s\S]*?generatedImagePreview: string;[\s\S]*?outputPane: ImageGenerationOutputPane;[\s\S]*?negativePrompt: string;/u,
  'ordinary and private generation must have a complete, reusable lane state rather than sharing transient input/output fields',
);
assert.match(
  imageWorkbench,
  /useState<Record<ImageGenerationMode, ImageGenerationLaneState>>[\s\S]*?ordinary: createImageGenerationLaneState\(\),[\s\S]*?private: createImageGenerationLaneState\(\),/u,
  'the workbench must instantiate separate ordinary and private generation lanes',
);
assert.match(
  imageWorkbench,
  /const activeImageGenerationLane = imageGenerationLanes\[imageGenerationMode\];/u,
  'the visible controls and output must read only the active generation lane',
);
assert.match(
  imageWorkbench,
  /const selectImagePromptRuleSet = \(id: string\) => \{[\s\S]*?clearImageGenerationOutputs\(imageGenerationMode\);[\s\S]*?privateImagePromptRuleSetIdByBackend:[\s\S]*?imagePromptRuleSetIdByBackend:/u,
  'ordinary and private generation must persist independent rule-set choices and clear only the active output',
);
assert.match(
  imageWorkbench,
  /imageGenerationMode === "private"\s*\? "私密生图设置"\s*:\s*assetKind === "grid"\s*\?\s*"3×3 九宫格生成设置"\s*:\s*"普通生图设置"/u,
  'the generation card must identify private, grid and ordinary settings',
);
const imagePanelSection = (startMarker: string, endMarker: string): string => {
  const start = imageWorkbench.indexOf(startMarker);
  const end = imageWorkbench.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `image panel section must exist: ${startMarker}`);
  return imageWorkbench.slice(start, end);
};
const imagePanelRules = imagePanelSection('<section className="image-setting-section image-setting-rules"', '<section className="image-setting-section image-setting-references"');
const imagePanelReferences = imagePanelSection('<section className="image-setting-section image-setting-references"', '<section className="image-setting-section image-setting-spec"');
const imagePanelSpecification = imagePanelSection('<section className="image-setting-section image-setting-spec"', '<div className="image-generate-row image-setting-section"');
const imagePanelActions = imagePanelSection('<div className="image-generate-row image-setting-section"', '<ReferenceImagePickerModal');
const imagePanelHeading = imagePanelSection('<div className="row-between image-output-head">', '<div className="row-between image-generation-mode-bar">');
assert.match(imageWorkbench, /!isStoryboardMode && \(\s*<Card className=\{`image-output-card image-output-refined/u, 'the refined settings panel must remain absent in the independent storyboard-image workflow');
assert.match(imageWorkbench, /className="image-generation-controls" key=\{`image-generation-controls-\$\{imageGenerationMode\}`\}/u, 'ordinary/private controls must retain their lane-specific remount key');
assert.match(imagePanelRules, /value=\{activeImagePromptRuleSetId\}[\s\S]*?selectImagePromptRuleSet\(event\.target\.value\)/u, 'regrouped rules must retain the active rule binding and handler');
assert.match(imagePanelRules, /value=\{activeImagePromptPresetId\}[\s\S]*?selectImagePromptPreset\(event\.target\.value\)/u, 'regrouped presets must retain the active preset binding and handler');
assert.match(imagePanelHeading, /className="image-rule-manager-button"[\s\S]*?onClick=\{\(\) => setView\("rules"\)\}/u, 'the manager button in the compact panel heading must retain rule-center navigation');
assert.match(imagePanelReferences, /type="file"[\s\S]*?onChange=\{uploadReference\}[\s\S]*?onClick=\{\(\) => setReferencePickerOpen\(true\)\}/u, 'regrouped references must retain upload and library selection actions');
assert.match(imagePanelReferences, /imageGenerationMode === "ordinary" && \([\s\S]*?onClick=\{analyzeUploadedReference\}/u, 'AI reference analysis must remain an ordinary-only action');
assert.match(imagePanelReferences, /checked=\{useReferenceImage\}[\s\S]*?disabled=\{!uploadedPreview \|\| !supportsReferenceImageInput \|\| busy \|\| autofillBusy\}[\s\S]*?setUseReferenceImage\(event\.target\.checked\);[\s\S]*?clearImageGenerationOutputs\(imageGenerationMode\)/u, 'real reference transmission must remain explicit, capability checked, and lane scoped');
assert.match(imagePanelSpecification, /value=\{imageGenerationCount\}[\s\S]*?patchActiveImageGenerationLane\(\{ generationCount: normalizeImageBatchCount\(event\.target\.value\) \}\)[\s\S]*?Array\.from\(\{ length: 8 \}/u, 'quantity must retain its working 1–8 per-lane generation setting');
assert.match(imagePanelSpecification, /<ImageOutputSizeControls[\s\S]*?lane=\{imageGenerationMode\}[\s\S]*?onChange=\{changeImageOutputSize\}/u, 'regrouped pixels must still update the active ordinary/private preference');
assert.match(imagePanelReferences, /<details className="image-panel-capability"><summary aria-label="生图更多设置">[\s\S]*?<div className="image-panel-extra-popover">[\s\S]*?imageGenerationMode === "ordinary" && \(\s*<Field\s+className="image-negative-field"/u, 'more settings must retain ordinary-only negative input behind an explicit expandable control');
assert.match(imagePanelReferences, /className="image-negative-field"[\s\S]*?value=\{negativePrompt\}[\s\S]*?setNegativePrompt\(event\.target\.value\)[\s\S]*?disabled=\{busy \|\| autofillBusy \|\| imageWorkbenchApi\.backend === "openai"\}/u, 'collapsed ordinary negatives must keep their value, handler and effective backend capability guard');
assert.doesNotMatch(imagePanelActions, /className="image-negative-field"/u, 'the fixed primary actions must not include a duplicate ordinary negative field');
assert.match(imagePanelActions, /value=\{autofillRequirement\}[\s\S]*?setAutofillRequirement\(event\.target\.value\)[\s\S]*?maxLength=\{2000\}/u, 'the labelled custom requirement must preserve the existing input binding and length limit');
assert.match(imagePanelActions, /assetKind !== "grid" && \([\s\S]*?onClick=\{completeAssetDetails\}/u, 'grid generation must not regain an unrelated autofill button');
assert.match(imagePanelActions, /disabled=\{busy \|\| autofillBusy \|\| Boolean\(imageOutputSizeIssue\) \|\| Boolean\(imageApiSelection\.issue\)\}[\s\S]*?onClick=\{createPromptAsset\}/u, 'the refined primary action must retain generation handling, pixel error protection and unavailable API guard');
assert.doesNotMatch(imageWorkbench, /className="image-results-container"|className="image-generation-output-tabs"|aria-label="本批图片选择预览"/u, 'the workbench must not duplicate task results below its settings');
assert.ok(
  (imageWorkbench.match(/activateOrdinaryImageGeneration/g) || []).length >= 2
    && (imageWorkbench.match(/activatePrivateImageGeneration/g) || []).length >= 2,
  'the ordinary/private generation selectors must call their dedicated mode activators',
);
assert.match(
  imageWorkbench,
  /imageGenerationMode === "ordinary"[\s\S]*?<Field\s+className="image-negative-field"[\s\S]*?label="附加负面提示词"/u,
  'the free-form negative prompt belongs to ordinary generation settings only',
);
assert.doesNotMatch(
  imageWorkbench,
  /disabled=\{privateVariantSelected\s*\|\|\s*state\.settings\.imageApi\.backend\s*===\s*"openai"\}/u,
  'private generation must not expose an ordinary negative-prompt field merely as a disabled control',
);
assert.match(
  imageWorkbench,
  /imageGenerationMode === "private"[\s\S]*?activatePrivateImageGeneration\(item\.part\)/u,
  'private generation settings must expose the selected private part through the private-mode activator',
);
assert.match(
  imageWorkbench,
  /activatePrivateImageGeneration\("full-body", "private-five-view"\)[\s\S]*?activatePrivateImageGeneration\("full-body", "private-four-in-one"\)/u,
  'private generation settings must expose five-view and retain the separate full-body-primary four-in-one output',
);
assert.match(
  imageWorkbench,
  /setOrdinaryImageVariant\(item\.id\);[\s\S]*?setImageVariant\(item\.id\);/u,
  'ordinary variant changes must update the ordinary lane selection without becoming a private-part selection',
);
assert.match(
  imageWorkbench,
  /const \[imageFormPane, setImageFormPane\] = useState<"form" \| "prompt">\("form"\);/u,
  'the left data/prompt pane must own an independent state',
);
assert.match(
  imageWorkbench,
  /type ImageGenerationOutputPane = "prompt" \| "preview";/u,
  'each generation lane must expose only prompt and generated-image output panes',
);
assert.match(
  imageWorkbench,
  /imageFormPane === "prompt"[\s\S]*?className="prompt-copy image-prompt-copy"[\s\S]*?ctx\.handleCopyPrompt\(prompt\)/u,
  'the independent left prompt pane must retain prompt access and copying',
);
assert.doesNotMatch(
  imageWorkbench,
  /imageOutputPane === "summary"|imageOutputPane === "guide"|setImageOutputPane\([^)]*"summary"|setImageOutputPane\([^)]*"guide"/u,
  'the obsolete summary/guide output states must not remain in the workbench',
);
assert.doesNotMatch(
  imageWorkbench,
  /项目实体联动|双 API 工作流/u,
  'internal entity binding and dual-API implementation details must not be shown in the workbench UI',
);
assert.doesNotMatch(
  imageWorkbench,
  /const \[imagePane, setImagePane\]/u,
  'right-side prompt/image output navigation must not clear the left-side character form',
);

assert.match(
  imageWorkbench,
  /const privateRequestedFields = privateAutofillRelevant\s*\?\s*availablePrivateCharacterFields\s*\.filter\(\(item\) => !privateCharacterFieldValue\(assetForm, item\)\)\s*\.map\(\(item\) => item\.formKey\)\s*:\s*\[\]/u,
  'private dossier completion must derive requested keys from gender-applicable fields after merged legacy values are considered',
);
assert.match(
  imageWorkbench,
  /const privateCompleted = await requestCharacterPrivateProfileAutofill\(\s*textApi,\s*effectiveForm,\s*privateRequestedFields,\s*sourceStory,\s*projectContext,\s*undefined,\s*\{ customRequirement: requestedAutofillRequirement \},?\s*\)/u,
  'the image workbench must call the dedicated private-profile API for the selected empty fields',
);
assert.match(
  imageWorkbench,
  /const privateFieldCompleted = privateRequestedFields\.some\(\(field\) => \([\s\S]*?Boolean\(\(completed\[field\] \|\| ""\)\.trim\(\)\)[\s\S]*?const privateProfilePersisted = Boolean\([\s\S]*?resolvedSourceEntityId[\s\S]*?privateFieldCompleted[\s\S]*?characters:\s*privateProfilePersisted[\s\S]*?mergeCharacterPrivateProfileAutofill\(\s*character,\s*completed,\s*sourceContentHash\(sourceStory\),?\s*\)/u,
  'a successful private autofill must merge into its originally bound character even after the visible workbench target changes',
);
assert.match(
  imageWorkbench,
  /if \(!applyToCurrentForm\) return;\s*setAssetForm\(completedForm\);/u,
  'only a still-current autofill request may refresh the visible form',
);
assert.match(
  imageWorkbench,
  /const completeAssetDetails = async \(\) => \{\s*if \(autofillBusy \|\| activeAutofillTaskIdRef\.current\) return;/u,
  'the autofill action must reject a duplicate click before React has committed its busy state',
);
assert.match(
  imageWorkbench,
  /const duplicateAutofillTask = resolvedSourceEntityId[\s\S]*?isAutofillGenerationTask\(candidate\)[\s\S]*?candidate\.status === "queued" \|\| candidate\.status === "running"[\s\S]*?candidate\.sourceEntityId === resolvedSourceEntityId[\s\S]*?if \(duplicateAutofillTask\)/u,
  'returning to a bound entity while its background autofill is still running must not create a second task',
);
assert.match(
  imageWorkbench,
  /const selectEntity = \(id: string\) => \{[\s\S]*?setSelectedEntityId\(id\);[\s\S]{0,500}?resetImageGenerationLaneContent\(\{\s*preserveAutofillRequirement: true\s*\}\);/u,
  'switching entities must clear both ordinary/private outputs while preserving the user autofill requirement',
);
assert.match(
  imageWorkbench,
  /previousImageWorkbenchProjectIdRef\.current = state\.project\.id;[\s\S]*?resetImageGenerationLaneContent\(\);\s*setImageGenerationMode\("ordinary"\);/u,
  'switching projects must clear both generation lanes and return to ordinary generation',
);

assert.match(
  imageWorkbench,
  /const boundCharacter = state\.project\.characters\.find\([\s\S]*?character\.id === requestedEntityId[\s\S]*?requestedAssetForm = \{[\s\S]*?imageWorkbenchEntityToForm\("character", boundCharacter\)[\s\S]*?const requestedPrivateFields = requestedImageVariant === "private-four-in-one"[\s\S]*?privateCharacterFourInOneFieldsForGender\(requestedAssetForm\.gender \|\| "", requestedAssetForm\)[\s\S]*?const missingPrivateFields = requestedPrivateFields\.filter/u,
  'private generation must validate and build its conversion source from the persisted bound character rather than unsaved form text',
);
assert.doesNotMatch(
  imageWorkbench,
  /name:\s*`\$\{name\} · 已转换提示词`|const promptAsset: ReferenceAsset/u,
  'a failed image API call must not create an empty converted-prompt asset',
);
assert.match(
  imageWorkbench,
  /转换提示词已保留在失败任务记录中[\s\S]*?settleImageGenerationTask\([\s\S]*?status:\s*"failed"[\s\S]*?prompt:\s*convertedPrompt/u,
  'a failed image call must retain its converted prompt only on the failed task record',
);

const privateTaskAndAssetMetadata = imageWorkbench.match(
  /referenceScope:\s*requestedNsfwPrivatePart\s*\?\s*"nsfw-private-profile"\s*:\s*"general",\s*nsfwPrivatePart:\s*requestedNsfwPrivatePart/gu,
) || [];
assert.ok(
  privateTaskAndAssetMetadata.length >= 2,
  'private metadata must survive the queued task and successful generated asset',
);
assert.match(
  imageWorkbench,
  /referenceScope:\s*privateVariantSelected\s*\?\s*"nsfw-private-profile"\s*:\s*"general",\s*nsfwPrivatePart:\s*privateVariantSelected\s*\?\s*(?:requestedPrivatePart|nsfwPrivatePart)\s*:\s*undefined/u,
  'uploaded private references must carry the same private scope and part metadata',
);
assert.match(
  source,
  /const privateRegeneration = originalTask\.referenceScope === "nsfw-private-profile"[\s\S]*?isPrivateImageVariant\(originalTask\.imageVariant\)[\s\S]*?const promptKind:[\s\S]*?privateRegeneration\s*\?\s*"character-private"/u,
  'private task regeneration must recognize legacy variants and restore the dedicated prompt category',
);
assert.match(
  source,
  /const requiresPromptConversion = privateRegeneration \|\| landscapeRepair \|\| !originalTask\.prompt\.trim\(\);[\s\S]*?privateImageVariantConverterRule\(originalTask\.imageVariant, privateRegenerationPart\)[\s\S]*?privateRegeneration \|\| landscapeRepair \? \{ prompt: "" \} : \{\}/u,
  'private regeneration must discard stale final prompts and rebuild them with the current exclusive target rule',
);
assert.match(
  source,
  /privateImageVariantRepairRule\(task\.imageVariant, privateRegenerationPart\)[\s\S]*?privateImagePromptProblem\(task\.imageVariant, prompt, privateRegenerationPart\)/u,
  'private regeneration must run the same validation and positive repair path as a new private request',
);
assert.match(
  source,
  /referenceScope:\s*task\.referenceScope,\s*nsfwPrivatePart:\s*task\.nsfwPrivatePart,/u,
  'regenerated assets must retain private scope and part metadata',
);

assert.match(
  imageWorkbench,
  /privateProfileHasAnyValue[\s\S]*?<Button[\s\S]*?disabled=\{busy \|\| autofillBusy\}[\s\S]*?PRIVATE_CHARACTER_FIELD_SPECS\.forEach\(\(item\) => \{\s*next\[item\.formKey\] = "";[\s\S]*?清空私密档案（保存后生效）/u,
  'the workbench must offer an action that clears every private form field',
);
assert.doesNotMatch(
  imageWorkbench,
  /hasConfirmedAdultCharacterEvidence|hasPrivateProfileInput && privateProfileChanged/u,
  'the image workbench must not add a duplicate local age gate to private profile editing or generation',
);

const characterWithPrivateProfile: Character = {
  id: 'character-private-clear-regression',
  name: '测试角色',
  gender: '女',
  apparentAge: '25岁',
  race: '人类',
  appearance: '普通外貌',
  outfit: '普通服装',
  signatureProps: '普通道具',
  personality: '沉静',
  motionHabits: '步伐稳定',
  anchor: '身份锚点',
  negativeContinuity: '保留普通连续性',
  assetIds: ['ordinary-reference'],
  nsfwProfile: {
    fullBody: '旧私密全身资料',
    breasts: '旧胸部资料',
    provenance: 'manual',
  },
};
const clearedPrivateProfileForm = imageWorkbenchEntityToForm(
  'character',
  characterWithPrivateProfile,
);
for (const key of [
  'nsfwFullBody',
  'nsfwBreasts',
  'nsfwVulva',
  'nsfwAnus',
  'nsfwPenis',
  'nsfwScrotum',
]) {
  clearedPrivateProfileForm[key] = '';
}
const characterAfterPrivateClear = buildImageWorkbenchEntity(
  'character',
  characterWithPrivateProfile.id,
  clearedPrivateProfileForm,
  characterWithPrivateProfile,
) as Character;
assert.equal(
  characterAfterPrivateClear.nsfwProfile,
  undefined,
  'saving all cleared private fields must remove the stale private profile',
);
assert.deepEqual(
  characterAfterPrivateClear.assetIds,
  ['ordinary-reference'],
  'clearing a private profile must not remove ordinary character references',
);
assert.equal(
  characterAfterPrivateClear.negativeContinuity,
  '保留普通连续性',
  'clearing a private profile must not erase ordinary character data',
);

console.log('image rule App integration checks passed');
