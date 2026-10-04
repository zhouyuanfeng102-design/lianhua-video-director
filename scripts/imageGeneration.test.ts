import assert from 'node:assert/strict';
import * as imageGenerationHelpers from '../src/imageGeneration';
import {
  CHARACTER_PRIVATE_PROFILE_FORM_FIELDS,
  IMAGE_ASSET_FORM_FIELDS,
  IMAGE_VARIANT_OPTIONS,
  buildImageWorkbenchEntity,
  getImageVariantGenerationSpec,
  hasDuplicateImageWorkbenchEntityName,
  imageWorkbenchEntityToForm,
  mergeCharacterPrivateProfileAutofill,
  mergeMissingImageAssetFormFields,
  missingCharacterPrivateProfileBasisFields,
  missingImageAssetFormFields,
  normalizePrivateSingleImagePrompt,
  privateCloseUpPromptProblem,
  privateFourInOnePromptProblem,
  privateFullBodyPromptProblem,
  privateImagePromptProblem,
  privateImageVariantConverterRule,
  privateImageVariantNegativePrompt,
} from '../src/imageGeneration';
import { buildImagePrompt } from '../src/promptEngine';
import { requestImageModel } from '../src/services/llm';
import * as generationTaskHelpers from '../src/generationTasks';
import {
  createImageGenerationTask,
  imageAssetKindLabel,
  imageGenerationStatusLabel,
  isImageGenerationTask,
  isVideoGenerationTask,
  patchImageGenerationTask,
  settleImageGenerationTask,
} from '../src/generationTasks';
import type { Character, GenerationTask, ImageApiConfig, VideoGenerationTask } from '../src/types';

const referenceOptionBuilder = imageGenerationHelpers as typeof imageGenerationHelpers & {
  buildImageGenerationReferenceOptions?: (
    enabled: boolean,
    dataUrl: string,
  ) => { referenceImages?: string[]; primaryReferenceImageCount?: number };
};
assert.equal(
  typeof referenceOptionBuilder.buildImageGenerationReferenceOptions,
  'function',
  'the image workbench must expose a testable bridge from the selected asset pixels to the image request',
);
assert.deepEqual(
  referenceOptionBuilder.buildImageGenerationReferenceOptions?.(
    true,
    'data:image/webp;base64,AQ==',
  ),
  {
    referenceImages: ['data:image/webp;base64,AQ=='],
    primaryReferenceImageCount: 1,
  },
  'an enabled asset-library reference must become the primary real image input for every supported image backend',
);
assert.deepEqual(
  referenceOptionBuilder.buildImageGenerationReferenceOptions?.(
    false,
    'data:image/png;base64,AA==',
  ),
  {},
  'turning off reference use must remove the pixels from the image request without clearing the selected preview',
);

const characterVariants = IMAGE_VARIANT_OPTIONS.character.map((variant) =>
  getImageVariantGenerationSpec(variant),
);
const fiveView = characterVariants.find((item) => item.id === 'five-view');
assert.ok(fiveView, 'new character generation must offer the five-view sheet');
assert.equal(fiveView.label, '五视图');
assert.ok(!characterVariants.some((item) => item.id === 'turnaround'), 'legacy four-view is not a new-generation option');
const turnaround = getImageVariantGenerationSpec('turnaround');
assert.ok(turnaround, 'legacy turnaround sheets must retain their four-view specification');
assert.equal(turnaround?.label, '四视图');
assert.deepEqual(turnaround?.canvas, { width: 1536, height: 1024 });
assert.match(turnaround?.direction || '', /横向3:2画布/u);
for (const view of ['正面', '严格90度左侧面', '背面', '45度前侧三分之四视图']) {
  assert.match(turnaround?.direction || '', new RegExp(view, 'u'), `four-view prompt omitted ${view}`);
}
assert.match(turnaround?.direction || '', /相同尺寸.*相同相机高度.*同一水平基线/u);
assert.match(turnaround?.direction || '', /正交设定图.*无透视夸张/u);
assert.match(turnaround?.direction || '', /中性灰无缝背景/u);
assert.doesNotMatch(turnaround?.direction || '', /绿幕|绿色背景/u);

const portrait = getImageVariantGenerationSpec('portrait');
assert.deepEqual(portrait.canvas, { width: 1024, height: 1024 });
const fullBody = getImageVariantGenerationSpec('full-body');
assert.match(fullBody.direction, /单幅全身人物图.*不是头像、半身、膝上、中景或下半身裁切/u);
assert.match(fullBody.direction, /从头顶.*双脚.*完整入画/u);
const privateFullBody = getImageVariantGenerationSpec('private-full-body');
assert.deepEqual(privateFullBody.canvas, { width: 1024, height: 1536 });
assert.match(privateFullBody.direction, /2:3竖向画布.*只有一个完整主体.*中央竖轴.*左右两侧/u);
const privateTurnaround = getImageVariantGenerationSpec('private-turnaround');
assert.equal(privateTurnaround.label, '私密四视图');
assert.deepEqual(privateTurnaround.canvas, { width: 1536, height: 1024 });
assert.match(privateTurnaround.direction, /私密全身外貌四视图/u);
assert.match(privateTurnaround.direction, /正面.*严格90度左侧面.*背面.*45度前侧三分之四视图/u);
const privateFourInOne = getImageVariantGenerationSpec('private-four-in-one');
assert.equal(privateFourInOne.label, '私密四合一');
assert.deepEqual(privateFourInOne.canvas, { width: 1536, height: 1024 });
assert.match(privateFourInOne.direction, /私密全身.*主画面/u);
assert.match(privateFourInOne.direction, /辅助部位窗/u);
assert.doesNotMatch(privateFourInOne.direction, /2×2四格布局/u, 'four-in-one must prioritize the full-body main image instead of equal quadrants');

const partiallyCompletedCharacter = {
  name: '用户填写的阿莲',
  gender: '',
  appearance: '  ',
  outfit: '用户指定的青色棉麻长衣',
  props: '',
  personality: '',
  age: '',
  actualAge: '',
  height: '',
  race: '人类',
  motion: '',
  anchor: '',
  style: '电影写实',
};
assert.deepEqual(
  missingImageAssetFormFields('character', partiallyCompletedCharacter),
  ['gender', 'appearance', 'props', 'personality', 'age', 'actualAge', 'height', 'motion', 'anchor'],
  'AI completion must target only structurally blank character fields',
);
for (const authoredText of ['未知', '默认', '待补充', '无资料', '根据剧情']) {
  assert.equal(imageGenerationHelpers.isMissingImageAssetFormField(authoredText), false, 'nonempty authored words are facts, not a local missing-field classification');
  assert.deepEqual(
    mergeMissingImageAssetFormFields('prop', { name: authoredText, material: '' }, { name: 'AI替换', material: authoredText }),
    { name: authoredText, material: authoredText },
    'a present value stays intact and AI text is not filtered from an empty field',
  );
}
assert.ok(
  IMAGE_ASSET_FORM_FIELDS.character.includes('gender'),
  'gender must be a first-class character form field that AI completion is allowed to fill',
);

// Local code must not reinterpret existing age/anatomy prose as invalid. The
// AI sees the authored facts; explicit user values are not autofill targets.
const legacyNonHumanAgeForm = {
  name: '母巢',
  gender: '雌性',
  morphology: 'monster',
  bodyPlan: '巨大无定形肉质体',
  race: '浪潮母体/巨型聚合生物',
  age: '约四十岁的中年母性面容',
  actualAge: '约千年以上',
  appearance: '巨大肉质与菌毯结构',
};
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.(legacyNonHumanAgeForm, 'age'),
  false,
  'age semantics must not trigger a local validation gate',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.(legacyNonHumanAgeForm, 'actualAge'),
  false,
  'a real non-human age in years must remain valid in actualAge',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    ...legacyNonHumanAgeForm,
    age: '',
    apparentAge: '成熟期（相当于人类成年阶段）',
  }, 'age'),
  false,
  'apparentAge alias wording is also left to the AI',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    ...legacyNonHumanAgeForm,
    age: '1000岁外观',
  }, 'age'),
  false,
  'numeric age wording must not trigger a local guard',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    ...legacyNonHumanAgeForm,
    actualAge: '约八十年（相当于人类成年阶段）',
  }, 'actualAge'),
  false,
  'age equivalence metadata must remain an authored fact',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    ...legacyNonHumanAgeForm,
    age: '成年期大型个体',
  }, 'age'),
  false,
  'species lifecycle wording such as 成年期 must remain valid for non-human subjects',
);
assert.ok(
  !missingImageAssetFormFields('character', legacyNonHumanAgeForm).includes('age'),
  'an existing age must not be treated as missing by local semantic rules',
);
const repairedNonHumanAgeForm = mergeMissingImageAssetFormFields(
  'character',
  legacyNonHumanAgeForm,
  { age: '成熟期大型个体' },
);
assert.equal(
  repairedNonHumanAgeForm.age,
  legacyNonHumanAgeForm.age,
  'autofill must not replace a user-authored nonempty age',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    ...legacyNonHumanAgeForm,
    morphology: 'human-like',
    race: '人类',
    bodyPlan: '',
    age: '约四十岁的中年女性面容',
  }, 'age'),
  false,
  'human characters may retain human visual-age and face wording',
);
assert.deepEqual(
  imageGenerationHelpers.sanitizeNonHumanAgeAnalysisFields?.(
    {
      name: '母巢',
      race: '浪潮母体/巨型聚合生物',
      morphology: 'monster',
      bodyPlan: '巨大无定形肉质体',
      age: '',
      actualAge: '',
    },
    {
      race: '浪潮母体/巨型聚合生物',
      age: '约四十岁的中年母性面容',
      actualAge: '约八十年',
      appearance: '巨大肉质与菌毯结构',
    },
  ),
  {
    race: '浪潮母体/巨型聚合生物',
    age: '约四十岁的中年母性面容',
    actualAge: '约八十年',
    appearance: '巨大肉质与菌毯结构',
  },
  'vision analysis must retain valid strings without local anatomy/age stripping',
);
assert.deepEqual(
  imageGenerationHelpers.sanitizeNonHumanMorphologyAnalysisFields?.(
    {
      name: '玄鳞',
      race: '龙族',
      morphology: 'unknown',
      bodyPlan: '保持龙族原形，未确认部分不添加人类结构',
      appearance: '暗金鳞片、龙首、四足',
      outfit: '',
      motion: '',
      anchor: '',
    },
    {
      race: '人类',
      morphology: 'human-like',
      appearance: '白皙皮肤、黑发、标准人类脸型、双手双脚',
      outfit: '贴合人体比例的长袍',
      motion: '双足直立、人体比例',
      anchor: '人类面容的龙族角色',
    },
  ),
  {
    race: '人类',
    morphology: 'human-like',
    appearance: '白皙皮肤、黑发、标准人类脸型、双手双脚',
    outfit: '贴合人体比例的长袍',
    motion: '双足直立、人体比例',
    anchor: '人类面容的龙族角色',
  },
  'unknown morphology may accept AI facts without a local species classifier',
);
assert.deepEqual(
  imageGenerationHelpers.sanitizeNonHumanMorphologyAnalysisFields?.(
    {
      name: '母巢',
      race: '浪潮母体/巨型聚合生物',
      morphology: 'monster',
      bodyPlan: '巨大无定形肉质体',
      appearance: '巨大肉质与菌毯结构',
    },
    {
      bodyPlan: '标准人形头部、双臂双腿和人体比例',
      appearance: '中年母性面容、黑色短发、白皙皮肤',
    },
  ),
  {
    bodyPlan: '标准人形头部、双臂双腿和人体比例',
    appearance: '中年母性面容、黑色短发、白皙皮肤',
  },
  'analysis transport must not strip valid anatomy strings',
);
assert.deepEqual(
  imageGenerationHelpers.sanitizeNonHumanAgeAnalysisFields?.(
    {
      name: '母巢',
      race: '浪潮母体/巨型聚合生物',
      morphology: 'monster',
      bodyPlan: '巨大无定形肉质体',
      age: '约四十岁的中年母性面容',
    },
    {
      race: '浪潮母体/巨型聚合生物',
      bodyPlan: '巨大无定形肉质体、菌毯结构',
    },
  ),
  {
    race: '浪潮母体/巨型聚合生物',
    bodyPlan: '巨大无定形肉质体、菌毯结构',
  },
  'analysis must not synthesize an empty field to erase a stored age',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    name: '自定义异种',
    morphology: 'custom',
    bodyPlan: '用户定义的多节附肢结构',
    age: '中年面容',
  }, 'age'),
  false,
  'custom morphology must not introduce an age semantics gate',
);
assert.equal(
  imageGenerationHelpers.hasNonHumanAgeTemplateConflict?.({
    name: '待确认人类',
    morphology: 'unknown',
    race: '人类',
    age: '中年面容',
  }, 'age'),
  false,
  'unknown morphology with an explicit human race must retain human age wording',
);
assert.deepEqual(
  imageGenerationHelpers.sanitizeNonHumanAgeAnalysisFields?.(
    { name: '阿莲', race: '人类', morphology: 'human-like' },
    { age: '约四十岁的中年女性面容', actualAge: '四十岁' },
  ),
  { age: '约四十岁的中年女性面容', actualAge: '四十岁' },
  'vision analysis must not reject an explicitly human character age template',
);
const mergedCharacterDetails = mergeMissingImageAssetFormFields(
  'character',
  partiallyCompletedCharacter,
  {
    name: 'AI 不得改名',
    gender: '女',
    appearance: '黑色长发、眉间小痣、清晰五官',
    outfit: 'AI 不得覆盖服装',
    props: '腰间铜铃',
    personality: '沉静果断',
    actualAge: '二十五岁',
    height: '约165cm',
    unknownField: '不得写入表单',
  },
);
assert.equal(mergedCharacterDetails.name, '用户填写的阿莲');
assert.equal(mergedCharacterDetails.gender, '女');
assert.equal(mergedCharacterDetails.outfit, '用户指定的青色棉麻长衣');
assert.equal(mergedCharacterDetails.appearance, '黑色长发、眉间小痣、清晰五官');
assert.equal(mergedCharacterDetails.props, '腰间铜铃');
assert.equal(mergedCharacterDetails.personality, '沉静果断');
assert.equal(mergedCharacterDetails.actualAge, '二十五岁');
assert.equal(mergedCharacterDetails.height, '约165cm');
assert.equal('unknownField' in mergedCharacterDetails, false);
assert.equal(partiallyCompletedCharacter.appearance, '  ', 'completion must not mutate the live form snapshot');

const privateAutofillForm = {
  ...partiallyCompletedCharacter,
  nsfwFullBody: '',
  nsfwBreasts: '用户已填写的稳定胸部资料',
  nsfwVulva: '',
};
const privateAutofillSuggestion = {
  nsfwFullBody: ' AI 补齐的稳定裸体全身资料 ',
  nsfwBreasts: 'AI 不得覆盖已有胸部资料',
  nsfwVulva: 'AI 不得越过本次额外白名单',
};
const ordinaryMergeWithoutPrivateAllowlist = mergeMissingImageAssetFormFields(
  'character',
  privateAutofillForm,
  privateAutofillSuggestion,
);
assert.equal(
  ordinaryMergeWithoutPrivateAllowlist.nsfwFullBody,
  '',
  'ordinary autofill must not merge a private field unless the caller explicitly adds it to the allowlist',
);
assert.equal(
  ordinaryMergeWithoutPrivateAllowlist.nsfwVulva,
  '',
  'private fields must remain outside the default character autofill contract',
);
assert.ok(
  CHARACTER_PRIVATE_PROFILE_FORM_FIELDS.every((field) => !IMAGE_ASSET_FORM_FIELDS.character.includes(field)),
  'the default character field list must not silently opt into any adult private-profile field',
);
const privateMergeWithExplicitAllowlist = mergeMissingImageAssetFormFields(
  'character',
  privateAutofillForm,
  privateAutofillSuggestion,
  ['nsfwFullBody', 'nsfwBreasts'],
);
assert.equal(
  privateMergeWithExplicitAllowlist.nsfwFullBody,
  'AI 补齐的稳定裸体全身资料',
  'an explicitly allowlisted blank private field must be merged and trimmed',
);
assert.equal(
  privateMergeWithExplicitAllowlist.nsfwBreasts,
  '用户已填写的稳定胸部资料',
  'AI private completion must never overwrite an existing user value',
);
assert.equal(
  privateMergeWithExplicitAllowlist.nsfwVulva,
  '',
  'a suggested private field outside the explicit additional allowlist must not be merged',
);

const characterWithPartialPrivateProfile: Character = {
  id: 'character-private-autofill',
  name: '阿莲',
  gender: '女',
  apparentAge: '25岁成年人',
  actualAge: '25岁',
  height: '约165cm',
  race: '人类',
  appearance: '黑发、浅色皮肤',
  outfit: '青色棉麻长衣',
  signatureProps: '腰间铜铃',
  personality: '沉静',
  motionHabits: '步幅轻稳',
  anchor: '黑发与眉间小痣',
  negativeContinuity: '',
  assetIds: [],
  nsfwProfile: {
    breasts: '用户已确认的胸部资料',
    provenance: 'story-analysis',
    sourceHash: 'old-story-hash',
  },
};
const characterAfterPrivateAutofill = mergeCharacterPrivateProfileAutofill(
  characterWithPartialPrivateProfile,
  {
    nsfwFullBody: ' 稳定裸体全身比例 ',
    nsfwBreasts: 'AI 不得覆盖用户已有资料',
    nsfwVulva: '稳定外阴外观',
  },
  ' current-story-hash ',
);
assert.notStrictEqual(
  characterAfterPrivateAutofill,
  characterWithPartialPrivateProfile,
  'a successful private completion must return a new character snapshot',
);
assert.equal(characterAfterPrivateAutofill.nsfwProfile?.fullBody, '稳定裸体全身比例');
assert.equal(characterAfterPrivateAutofill.nsfwProfile?.vulva, '稳定外阴外观');
assert.equal(
  characterAfterPrivateAutofill.nsfwProfile?.breasts,
  '用户已确认的胸部资料',
  'persisting AI-completed private fields must preserve every existing profile value',
);
assert.equal(
  characterAfterPrivateAutofill.nsfwProfile?.provenance,
  'story-enrichment',
  'an applied private autofill must record its enrichment provenance',
);
assert.equal(
  characterAfterPrivateAutofill.nsfwProfile?.sourceHash,
  'current-story-hash',
  'an applied private autofill must record the trimmed source identity used for the API completion',
);
assert.deepEqual(
  characterWithPartialPrivateProfile.nsfwProfile,
  {
    breasts: '用户已确认的胸部资料',
    provenance: 'story-analysis',
    sourceHash: 'old-story-hash',
  },
  'private autofill persistence must not mutate the current character snapshot',
);

const characterWithNoPrivateGap: Character = {
  ...characterWithPartialPrivateProfile,
  nsfwProfile: {
    fullBody: '用户手工全身资料',
    provenance: 'manual',
    sourceHash: 'manual-source-hash',
  },
};
const privateNoOp = mergeCharacterPrivateProfileAutofill(
  characterWithNoPrivateGap,
  { nsfwFullBody: 'AI 不得改写' },
  'new-api-source-hash',
);
assert.strictEqual(
  privateNoOp,
  characterWithNoPrivateGap,
  'when the API returns only already-populated fields, the merge must be a true no-op',
);
assert.equal(privateNoOp.nsfwProfile?.provenance, 'manual');
assert.equal(privateNoOp.nsfwProfile?.sourceHash, 'manual-source-hash');
assert.deepEqual(
  missingCharacterPrivateProfileBasisFields({
    name: '阿莲',
    gender: '女',
    appearance: '黑发、浅色皮肤、身形高挑',
    age: '',
  }),
  [],
  'private dossier autofill may use ordinary character facts without any age value',
);
assert.deepEqual(
  missingCharacterPrivateProfileBasisFields({
    name: '阿莲',
    gender: '',
    appearance: '',
    race: '',
    anchor: '',
    age: '二十岁',
  }),
  ['性别', '详细外观 / 种族 / 连续性锚点'],
  'private dossier autofill must not treat age as the ordinary visual basis',
);

const existingCharacter = {
  id: 'character-existing',
  name: '旧角色名',
  gender: '女',
  apparentAge: '',
  actualAge: '',
  height: '',
  race: '人类',
  appearance: '旧外观',
  outfit: '旧服装',
  signatureProps: '旧道具',
  personality: '旧气质',
  motionHabits: '旧动作',
  anchor: '旧锚点',
  negativeContinuity: '保留这个隐藏字段',
  assetIds: ['asset-1'],
};
const updatedCharacter = buildImageWorkbenchEntity(
  'character',
  existingCharacter.id,
  {
    name: '  新角色名  ',
    gender: '无性灵体',
    appearance: '新外观',
    outfit: '新服装',
    props: '新道具',
    personality: '新气质',
    age: '二十岁',
    actualAge: '三百六十五岁',
    height: '约170cm',
    race: '狐族',
    motion: '步伐轻盈',
    anchor: '银色发簪',
  },
  existingCharacter,
);
assert.equal(updatedCharacter.name, '新角色名');
assert.equal('gender' in updatedCharacter && updatedCharacter.gender, '无性灵体');
assert.equal('signatureProps' in updatedCharacter && updatedCharacter.signatureProps, '新道具');
assert.equal('apparentAge' in updatedCharacter && updatedCharacter.apparentAge, '二十岁');
assert.equal('actualAge' in updatedCharacter && updatedCharacter.actualAge, '三百六十五岁');
assert.equal('height' in updatedCharacter && updatedCharacter.height, '约170cm');
assert.equal('motionHabits' in updatedCharacter && updatedCharacter.motionHabits, '步伐轻盈');
assert.equal('negativeContinuity' in updatedCharacter && updatedCharacter.negativeContinuity, '保留这个隐藏字段');
assert.deepEqual(updatedCharacter.assetIds, ['asset-1']);
assert.notEqual(updatedCharacter.assetIds, existingCharacter.assetIds, 'save must not reuse the mutable asset id array');
assert.equal(existingCharacter.name, '旧角色名', 'save mapping must not mutate the selected entity');
assert.equal(existingCharacter.gender, '女', 'editing a custom gender must not mutate the selected entity snapshot');
assert.equal(
  imageWorkbenchEntityToForm('character', updatedCharacter).gender,
  '无性灵体',
  'a saved custom gender must round-trip back into the image workbench form',
);
assert.equal(
  imageWorkbenchEntityToForm('character', updatedCharacter).actualAge,
  '三百六十五岁',
  'actual age must round-trip back into the image workbench form separately from apparent age',
);
assert.equal(
  imageWorkbenchEntityToForm('character', updatedCharacter).height,
  '约170cm',
  'character height must round-trip back into the image workbench form',
);

const legacyFemaleStageCharacter: Character = {
  ...existingCharacter,
  id: 'legacy-female-stage',
  name: '露娜·幼体形态',
  baseName: '露娜',
  formLabel: '幼体形态',
  variantOf: '露娜',
  gender: '女',
  apparentAge: '约十二岁',
  height: '约140cm',
  race: '人类少女',
  bodyPlan: '未完全发育的少女骨架，双臂双腿',
  appearance: '幼态脸型与女童身形',
  outfit: '少女款浅色连衣裙',
  anchor: '保持幼体形态与金色长发',
};
const legacyFemaleStageForm = imageWorkbenchEntityToForm('character', legacyFemaleStageCharacter);
assert.equal(legacyFemaleStageForm.name, '露娜·缩小状态');
assert.equal(legacyFemaleStageForm.age, '约十二岁');
assert.equal(legacyFemaleStageForm.height, '约140cm');
assert.doesNotMatch(
  buildImagePrompt('character', legacyFemaleStageForm, 'full-body'),
  /儿童|孩童|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年|未发育/u,
  'old generated lifecycle labels must not flow into a new image conversion source',
);
assert.equal(legacyFemaleStageCharacter.name, '露娜·幼体形态', 'prompt cleanup must not mutate the saved legacy record');

const createdCharacterWithCustomGender = buildImageWorkbenchEntity(
  'character',
  'character-new-custom-gender',
  {
    name: '星海行者',
    gender: '非二元自定义性别',
    appearance: '银白短发与星纹面饰',
    outfit: '深蓝长袍',
    props: '星盘',
    personality: '沉静',
    age: '',
    actualAge: '',
    height: '',
    race: '星灵',
    motion: '动作轻缓',
    anchor: '始终保持银发与星纹面饰',
  },
);
assert.equal(
  'gender' in createdCharacterWithCustomGender && createdCharacterWithCustomGender.gender,
  '非二元自定义性别',
  'creating a character must persist an arbitrary user-defined gender instead of replacing it with an empty default',
);
assert.equal(
  imageWorkbenchEntityToForm('character', createdCharacterWithCustomGender).gender,
  '非二元自定义性别',
  'a newly created custom gender must survive the entity-to-form round trip',
);

// Legacy projects stored a free-form morphology label.  Saving those records
// must normalize the enum without losing the original species/body-plan fact.
const legacyMorphologyForm = {
  name: '旧异种',
  gender: '',
  morphology: '六足甲壳怪物',
  bodyPlan: '',
  appearance: '',
  outfit: '',
  props: '',
  personality: '',
  age: '',
  actualAge: '',
  height: '',
  race: '',
  motion: '',
  anchor: '',
};
const migratedLegacyMonster = buildImageWorkbenchEntity(
  'character',
  'character-legacy-monster',
  legacyMorphologyForm,
);
assert.equal(
  (migratedLegacyMonster as Character).morphology,
  'monster',
  'free-form legacy morphology labels must be normalized to the canonical kind',
);
assert.match(
  (migratedLegacyMonster as Character).bodyPlan || '',
  /六足甲壳怪物/u,
  'the original legacy morphology wording must survive in bodyPlan',
);
const migratedLegacyMechanical = buildImageWorkbenchEntity(
  'character',
  'character-legacy-mechanical',
  { ...legacyMorphologyForm, name: '旧机械体', morphology: '机械生命', bodyPlan: '用户手填的部件连接' },
);
assert.equal((migratedLegacyMechanical as Character).morphology, 'object-energy');
assert.equal(
  (migratedLegacyMechanical as Character).bodyPlan,
  '用户手填的部件连接；机械生命',
  'migration must preserve an existing user body-plan while appending the legacy wording',
);
const explicitlyClearedLegacyMorphology = buildImageWorkbenchEntity(
  'character',
  'character-clear-morphology',
  { ...legacyMorphologyForm, morphology: '', bodyPlan: '' },
  migratedLegacyMonster,
);
assert.equal(
  (explicitlyClearedLegacyMorphology as Character).morphology,
  undefined,
  'an explicitly empty morphology control must still clear a previous value',
);
assert.equal(
  (explicitlyClearedLegacyMorphology as Character).bodyPlan,
  '',
  'an explicitly empty body-plan control must still clear a previous value',
);

const genderedCharacterPromptForm = {
  name: '玄衣道侣',
  gender: '女',
  appearance: '黑发高束、眉峰微挑、身形高挑',
  outfit: '玄黑色修仙长袍',
  props: '黑鞘细剑',
  personality: '沉着警觉',
  age: '外观二十五岁',
  actualAge: '三百六十五岁',
  height: '约170cm',
  race: '人族修仙者',
  motion: '行走时抱剑护在同伴身前',
  anchor: '黑发马尾、玄色长袍与黑鞘细剑保持一致',
  style: '电影写实',
};
const ordinaryGenderedPrompt = buildImagePrompt(
  'character',
  genderedCharacterPromptForm,
  'reference',
);
assert.match(
  ordinaryGenderedPrompt,
  /玄衣道侣[^\n]*女/u,
  'ordinary character image source must state the selected gender explicitly',
);
assert.match(
  ordinaryGenderedPrompt,
  /外观年龄（按此绘制）：外观二十五岁/u,
  'ordinary character image prompts must mark apparent age as the drawable age',
);
assert.match(
  ordinaryGenderedPrompt,
  /身高\/高度（比例锚点）：约170cm/u,
  'ordinary character image prompts must include height as a body-proportion anchor',
);
assert.doesNotMatch(
  ordinaryGenderedPrompt,
  /三百六十五岁|实际年龄/u,
  'ordinary character image prompts must not use actual age as the visual age',
);
const turnaroundGenderedPrompt = buildImagePrompt(
  'character',
  genderedCharacterPromptForm,
  'turnaround',
);
assert.match(
  turnaroundGenderedPrompt,
  /性别设定：女/u,
  'character-sheet image source must state the selected gender explicitly',
);
assert.match(turnaroundGenderedPrompt, /外观年龄（按此绘制）：外观二十五岁/u);
assert.match(turnaroundGenderedPrompt, /身高\/高度（比例锚点）：约170cm/u);
assert.doesNotMatch(turnaroundGenderedPrompt, /三百六十五岁|实际年龄/u);
const privatePromptForm = {
  ...genderedCharacterPromptForm,
  age: '25岁成年人',
  actualAge: '三百六十五岁',
  appearance: '黑发、浅色皮肤、身形高挑',
  outfit: '不得进入私密图的玄黑色长袍',
  props: '不得进入私密图的黑鞘细剑',
  anchor: '不得进入私密图的玄色长袍身份锚点',
  nsfwFullBody: '仅用于全身图的稳定裸体比例资料',
  nsfwBreasts: '仅用于胸部图的稳定外貌资料',
  nsfwVulva: '仅用于外阴图的稳定外貌资料',
  nsfwAnus: '仅用于后庭图的稳定外貌资料',
};
const privateFullBodyPrompt = buildImagePrompt(
  'character',
  privatePromptForm,
  'private-full-body',
  'full-body',
);
assert.match(privateFullBodyPrompt, /仅用于全身图的稳定裸体比例资料/u);
assert.match(privateFullBodyPrompt, /身高\/高度比例：约170cm/u);
assert.doesNotMatch(privateFullBodyPrompt, /玄黑色长袍|黑鞘细剑|玄色长袍身份锚点/u);
assert.doesNotMatch(privateFullBodyPrompt, /仅用于胸部图|仅用于外阴图|仅用于后庭图/u);
assert.doesNotMatch(privateFullBodyPrompt, /25\s*岁|三百六十五岁|年龄|成年|未成年|禁止|不得|不要|严禁|负面/u);
assert.equal(privateFullBodyPromptProblem(privateFullBodyPrompt), '');
const normalizedPrivateFullBody = normalizePrivateSingleImagePrompt(
  '私密全身参考图，未分格单画面，唯一主体从头到脚完整入画。',
  'private-full-body',
);
assert.match(normalizedPrivateFullBody, /一幅连续单画面/u);
assert.match(normalizedPrivateFullBody, /唯一完整主体.*中央竖轴.*左右两侧/u);
assert.doesNotMatch(normalizedPrivateFullBody, /分格/u);
assert.equal(privateFullBodyPromptProblem(normalizedPrivateFullBody), '');
assert.equal(
  privateFullBodyPromptProblem('私密全身参考图，未分格单画面，唯一主体从头到脚完整入画。'),
  '',
  'the old positive single-frame wording must not self-trigger the extra-layout guard',
);
assert.match(
  privateFullBodyPromptProblem('私密全身资料图，未分格单画面，唯一主体从头到脚完整入画，旁边增加头像窗和局部面板。'),
  /多视图|辅助窗|额外面板/u,
);
assert.match(
  privateFullBodyPromptProblem('私密全身资料图，两个完整全身主体并列展示。'),
  /重复出现主体/u,
);
const privatePartPrompt = buildImagePrompt(
  'character',
  privatePromptForm,
  'private-close-up',
  'vulva',
);
assert.match(privatePartPrompt, /当前私密资料（外阴）：仅用于外阴图的稳定外貌资料/u);
assert.doesNotMatch(privatePartPrompt, /仅用于全身图|仅用于胸部图|仅用于后庭图/u);
assert.doesNotMatch(privatePartPrompt, /玄黑色长袍|黑鞘细剑|玄色长袍身份锚点/u);
assert.doesNotMatch(privatePartPrompt, /黑发|脸型|眼睛|身高\/高度比例/u, 'a local close-up must not ask the image model to render distant face, hair, or height anchors');
assert.doesNotMatch(privatePartPrompt, /25\s*岁|三百六十五岁|年龄|成年|未成年|禁止|不得|不要|严禁|负面/u);
assert.equal(privateCloseUpPromptProblem(privatePartPrompt, 'vulva'), '');
assert.equal(
  privateCloseUpPromptProblem('外阴资料特写，未分格微距单画面，外阴占据画面主体。', 'vulva'),
  '',
  'the old positive ungridded wording must remain a valid close-up',
);
assert.match(
  privateCloseUpPromptProblem('外阴资料特写，近景焦点清楚，同时加入胸部辅助窗。', 'vulva'),
  /多视图|辅助窗|额外面板/u,
);
assert.match(
  privateCloseUpPromptProblem('外阴资料特写，近景焦点清楚，同时展示胸部资料。', 'vulva'),
  /其它部位/u,
);
assert.match(
  privateCloseUpPromptProblem('当前部位近景，同时出现完整全身主画面。', 'vulva'),
  /全身画面/u,
);
const privateFullBodyRule = privateImageVariantConverterRule('private-full-body', 'full-body');
assert.match(privateFullBodyRule, /一幅连续单画面/u);
assert.match(privateFullBodyRule, /2:3.*中央竖轴.*左右.*背景/u);
assert.doesNotMatch(privateFullBodyRule, /四视图|四合一|辅助窗|资料板|未分格/u);
const privateFullBodyNegative = privateImageVariantNegativePrompt('private-full-body');
assert.match(privateFullBodyNegative, /second person.*duplicate person.*mirrored person.*multiple views.*character sheet/iu);
assert.equal(privateImageVariantNegativePrompt('private-turnaround'), '');
assert.equal(privateImageVariantNegativePrompt('private-four-in-one'), '');
assert.match(
  normalizePrivateSingleImagePrompt(
    'A single centered full-body subject against a clean background.',
    'private-full-body',
    'natural-language',
  ),
  /Exactly one complete subject.*same clean background continuing on both sides/iu,
);
assert.match(
  normalizePrivateSingleImagePrompt('solo, full body', 'private-full-body', 'sd-tags'),
  /symmetrical negative space.*simple continuous background/iu,
);
const privateCloseUpRule = privateImageVariantConverterRule('private-close-up', 'vulva');
assert.match(privateCloseUpRule, /外阴占据画面主体/u);
assert.doesNotMatch(privateCloseUpRule, /全身|四视图|四合一|辅助窗|资料板|未分格/u);
assert.equal(
  privateImagePromptProblem('private-full-body', '一幅连续单画面，唯一主体从头到脚完整入画。', 'full-body'),
  '',
);
const privateTurnaroundPrompt = buildImagePrompt(
  'character',
  privatePromptForm,
  'private-turnaround',
  'full-body',
);
assert.match(privateTurnaroundPrompt, /私密四视图资料板|私密全身外貌四视图/u);
assert.match(privateTurnaroundPrompt, /正面.*严格90度左侧面.*背面.*45度/u);
assert.match(privateTurnaroundPrompt, /仅用于全身图的稳定裸体比例资料/u);
assert.doesNotMatch(privateTurnaroundPrompt, /仅用于胸部图|仅用于外阴图|仅用于后庭图/u);
assert.doesNotMatch(privateTurnaroundPrompt, /25\s*岁|三百六十五岁|年龄|成年|未成年|禁止|不得|不要|严禁|负面/u);
const privateFourInOnePrompt = buildImagePrompt(
  'character',
  privatePromptForm,
  'private-four-in-one',
  'full-body',
);
assert.match(privateFourInOnePrompt, /私密全身为主画面/u);
assert.match(privateFourInOnePrompt, /辅助窗一胸部/u);
assert.match(privateFourInOnePrompt, /辅助窗二外阴/u);
assert.match(privateFourInOnePrompt, /辅助窗三后庭/u);
assert.match(privateFourInOnePrompt, /三个私密部位仅作为较小辅助窗/u);
assert.match(privateFourInOnePrompt, /恰好四个区域/u);
assert.match(privateFourInOnePrompt, /全身主体只出现一次/u);
assert.match(privateFourInOnePrompt, /辅助窗各出现一次且互不重复/u);
assert.match(privateFourInOnePrompt, /身高\/高度比例：约170cm/u);
assert.doesNotMatch(privateFourInOnePrompt, /玄黑色长袍|黑鞘细剑|玄色长袍身份锚点/u);
assert.doesNotMatch(privateFourInOnePrompt, /25\s*岁|三百六十五岁|年龄|成年|未成年|禁止|不得|不要|严禁|负面/u);
assert.equal(privateFourInOnePromptProblem(privateFourInOnePrompt), '');
assert.match(
  privateFourInOnePromptProblem('私密四视图资料板：正面、左侧面、背面、三分之四全身视图，另有胸部辅助窗。'),
  /四视图/u,
);
assert.match(
  privateFourInOnePromptProblem('私密四合一资料板：主画面全身，辅助窗一胸部，辅助窗二外阴，辅助窗三后庭，第五个面板重复胸部。'),
  /第五/u,
);
assert.match(
  privateFourInOnePromptProblem('私密四合一资料板：两个全身主画面并列，三个辅助窗重复局部。'),
  /重复出现全身/u,
);
assert.throws(
  () => buildImagePrompt('character', privatePromptForm, 'private-close-up'),
  /必须同时指定/u,
);
assert.throws(
  () => buildImagePrompt('character', privatePromptForm, 'private-full-body', 'breasts'),
  /只能使用私密全身/u,
);
assert.throws(
  () => buildImagePrompt('character', privatePromptForm, 'private-turnaround', 'breasts'),
  /私密四视图只能使用私密全身/u,
);
assert.throws(
  () => buildImagePrompt('character', { ...privatePromptForm, nsfwAnus: '' }, 'private-four-in-one', 'full-body'),
  /缺少“后庭外貌”/u,
);
assert.throws(
  () => buildImagePrompt('character', { ...privatePromptForm, nsfwVulva: '' }, 'private-close-up', 'vulva'),
  /缺少“外阴外貌”/u,
);
const ordinaryPromptWithPrivateFields = buildImagePrompt(
  'character',
  privatePromptForm,
  'reference',
);
assert.doesNotMatch(
  ordinaryPromptWithPrivateFields,
  /仅用于全身图|仅用于胸部图|仅用于外阴图|仅用于后庭图/u,
  'ordinary character prompts must not leak private-profile fields',
);
assert.equal(
  hasDuplicateImageWorkbenchEntityName([existingCharacter], '  旧角色名  '),
  true,
  'new entities must reject an existing normalized name',
);
assert.equal(
  hasDuplicateImageWorkbenchEntityName([existingCharacter], '旧角色名', existingCharacter.id),
  false,
  'updating the selected entity must not collide with itself',
);
assert.equal(
  hasDuplicateImageWorkbenchEntityName([existingCharacter], '另一名角色'),
  false,
  'different entity names must remain valid',
);

const createdLocation = buildImageWorkbenchEntity('location', 'location-new', {
  name: '  雨夜客栈 ',
  description: '木结构两层客栈',
  weather: '深夜暴雨',
  lighting: '烛火主光',
  palette: '冷青与暖橙',
  fixedProps: '柜台、酒坛',
  anchor: '门口红灯笼',
});
assert.deepEqual(createdLocation, {
  id: 'location-new',
  name: '雨夜客栈',
  description: '木结构两层客栈',
  timeWeather: '深夜暴雨',
  lighting: '烛火主光',
  palette: '冷青与暖橙',
  fixedProps: '柜台、酒坛',
  anchor: '门口红灯笼',
  assetIds: [],
});

const legacyLocationForm = imageWorkbenchEntityToForm('location', createdLocation);
assert.equal(Object.hasOwn(legacyLocationForm, 'style'), false, 'old locations must still inherit the director style');
const styledLocation = buildImageWorkbenchEntity('location', createdLocation.id, {
  ...legacyLocationForm, style: '  水彩纸张纹理  ',
}, createdLocation);
assert.equal(imageWorkbenchEntityToForm('location', styledLocation).style, '水彩纸张纹理');
const legacyUpdate = buildImageWorkbenchEntity('location', createdLocation.id, legacyLocationForm, styledLocation);
assert.equal(imageWorkbenchEntityToForm('location', legacyUpdate).style, '水彩纸张纹理', 'older callers without a style field must retain a saved style');
const clearedLocation = buildImageWorkbenchEntity('location', createdLocation.id, {
  ...legacyLocationForm, style: '',
}, styledLocation);
assert.equal(imageWorkbenchEntityToForm('location', clearedLocation).style, '', 'explicit no-preset choice must survive saving');
assert.equal(mergeMissingImageAssetFormFields('location', { style: '水彩纸张纹理' }, { style: '电影写实', lighting: '暖光' }).style, '水彩纸张纹理', 'AI completion must keep the selected scene style');
assert.equal(mergeMissingImageAssetFormFields('location', { style: '' }, { style: '水彩纸张纹理' }).style, '水彩纸张纹理', 'scene style is available to explicit empty-field completion');

const createdProp = buildImageWorkbenchEntity('prop', 'prop-new', {
  name: '染血来信',
  category: '信件',
  material: '宣纸',
  appearance: '边缘破损并沾有暗红血迹',
  effect: '推动调查',
  stateRules: '血迹和折痕始终一致',
});
assert.deepEqual(imageWorkbenchEntityToForm('prop', createdProp), {
  name: '染血来信',
  category: '信件',
  material: '宣纸',
  appearance: '边缘破损并沾有暗红血迹',
  effect: '推动调查',
  stateRules: '血迹和折痕始终一致',
});

const monsterTurnaroundPrompt = buildImagePrompt(
  'character',
  {
    name: '镰刀头',
    race: '非人型巨型怪兽',
    appearance: '头部为弧形骨质巨镰，六足，长尾，黑色甲壳带蓝色发光纹理',
    motion: '六足稳定支撑',
  },
  'turnaround',
);
assert.match(monsterTurnaroundPrompt, /镰刀头/u);
assert.match(monsterTurnaroundPrompt, /同一且唯一的角色.*恰好展示四个/u);
assert.match(monsterTurnaroundPrompt, /正面.*严格90度左侧面.*背面.*45度前侧三分之四视图/u);
assert.doesNotMatch(monsterTurnaroundPrompt, /三视图/u);
assert.doesNotMatch(monsterTurnaroundPrompt, /单个角色参考图|单人干净构图/u);
assert.doesNotMatch(monsterTurnaroundPrompt, /动作习惯：|自然站立|脸型|发型|鞋靴|人类|人体/u);

const legacyMonsterPrompt = buildImagePrompt(
  'character',
  {
    name: '母巢',
    morphology: 'monster',
    bodyPlan: '巨大无定形肉质体、菌毯结构',
    race: '浪潮母体/巨型聚合生物',
    age: '约四十岁的中年母性面容',
    actualAge: '约八十年',
    appearance: '巨大肉质与菌毯结构',
  },
);
assert.match(legacyMonsterPrompt, /约四十岁的中年母性面容/u, 'prompt builders must retain authored age strings for AI interpretation');
assert.match(legacyMonsterPrompt, /巨大无定形肉质体|菌毯结构/u);

for (const morphology of ['', 'unknown', 'custom', 'auto', '修仙者']) {
  const cultivatorFields = {
    name: '叶清碧',
    morphology,
    race: '修仙者',
    bodyPlan: '标准人形躯干，双臂双腿',
    age: '约二十五岁，温婉面容',
    appearance: '柳叶眉、黑发、双眼清澈',
  };
  assert.equal(imageGenerationHelpers.getImageMorphologyNegativePrompt(cultivatorFields), '', `${morphology || 'auto'} must not infer face suppression from prose`);
  assert.equal(imageGenerationHelpers.getImageMorphologyNegativePrompt(cultivatorFields, 'nai-tags'), '');
  for (const variant of [undefined, 'turnaround'] as const) {
    const prompt = buildImagePrompt('character', cultivatorFields, variant);
    assert.ok(prompt.includes(cultivatorFields.bodyPlan));
    assert.ok(prompt.includes(cultivatorFields.age));
    assert.ok(prompt.includes(cultivatorFields.appearance));
    assert.doesNotMatch(prompt, /非人\/异种角色|不得人类化|不添加人形结构|不得自动补成人形|不默认采用人类|禁止.*人类头部/u, 'automatic or custom form must not add a nonhuman anatomy ban');
  }
}
const retainedConcreteMorphology = imageGenerationHelpers.sanitizeNonHumanMorphologyAnalysisFields(
  { morphology: 'human-like', bodyPlan: '用户设定的人形躯干' },
  { morphology: 'monster', age: '约二十五岁', appearance: '清晰五官' },
);
assert.deepEqual(retainedConcreteMorphology, { morphology: 'human-like', age: '约二十五岁', appearance: '清晰五官' }, 'analysis preserves a concrete user selection without stripping other AI-authored strings');
assert.match(imageGenerationHelpers.getImageMorphologyNegativePrompt({ morphology: 'monster', bodyPlan: '六足甲壳' }), /人类头部/u, 'an explicit nonhuman morphology still retains its selected template');

const anthropomorphicTurnaroundPrompt = buildImagePrompt(
  'character',
  {
    name: '狼头守卫',
    race: '狼头人',
    morphology: 'anthropomorphic',
    bodyPlan: '狼头、灰色兽毛、双足直立的人形躯干、两条手臂和一条长尾',
    appearance: '狼吻、尖耳、灰色兽毛；人形躯干与直立双腿',
  },
  'turnaround',
);
assert.match(
  anthropomorphicTurnaroundPrompt,
  /非人头部[\s\S]*人形躯干|人形躯干[\s\S]*非人头部/u,
  '拟人非人四视图必须同时锁定非人头部与人形躯干',
);
assert.match(
  anthropomorphicTurnaroundPrompt,
  /不可互相替换|不能简化成纯人类或纯动物/u,
  '拟人非人四视图必须禁止把混合结构简化成单一物种',
);

const capturedRequests: Array<{ url: string; body?: string }> = [];
const generatedPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: { url: string; body?: string }) => {
        capturedRequests.push(payload);
        return payload.url.includes('/sdapi/')
          ? { status: 200, body: JSON.stringify({ images: [generatedPngBase64] }) }
          : { status: 200, body: JSON.stringify({ data: [{ b64_json: generatedPngBase64 }] }) };
      },
    },
  },
});

const openAiConfig: ImageApiConfig = {
  enabled: true,
  backend: 'openai',
  baseUrl: 'https://images.example.test',
  apiKey: 'test-key',
  model: 'gpt-image-1',
};
const sdConfig: ImageApiConfig = {
  enabled: true,
  backend: 'sd_webui',
  baseUrl: 'https://sd.example.test',
  apiKey: '',
  model: 'sdxl',
};

try {
  await requestImageModel(openAiConfig, {
    prompt: monsterTurnaroundPrompt,
    width: turnaround.canvas.width,
    height: turnaround.canvas.height,
  });
  await requestImageModel(sdConfig, {
    prompt: monsterTurnaroundPrompt,
    width: turnaround.canvas.width,
    height: turnaround.canvas.height,
  });
  await requestImageModel(openAiConfig, { prompt: '普通头像' });
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

const openAiTurnaroundBody = JSON.parse(capturedRequests[0]?.body || '{}');
const sdTurnaroundBody = JSON.parse(capturedRequests[1]?.body || '{}');
const openAiPortraitBody = JSON.parse(capturedRequests[2]?.body || '{}');
assert.equal(openAiTurnaroundBody.size, '1536x1024');
assert.equal(sdTurnaroundBody.width, 1536);
assert.equal(sdTurnaroundBody.height, 1024);
assert.equal(openAiPortraitBody.size, '1024x1024');

const imageTask = createImageGenerationTask({
  id: 'image-task-1',
  name: '阿莲四视图',
  assetKind: 'character',
  imageVariant: 'turnaround',
  prompt: monsterTurnaroundPrompt,
  negativePrompt: '文字、水印',
  width: 1536,
  height: 1024,
  backend: 'openai',
  model: 'gpt-image-1',
}, 100);
assert.deepEqual(imageTask, {
  id: 'image-task-1',
  kind: 'image',
  name: '阿莲四视图',
  assetKind: 'character',
  imageVariant: 'turnaround',
  status: 'running',
  prompt: monsterTurnaroundPrompt,
  negativePrompt: '文字、水印',
  width: 1536,
  height: 1024,
  backend: 'openai',
  model: 'gpt-image-1',
  createdAt: 100,
  updatedAt: 100,
});

const legacyVideoTask: VideoGenerationTask = {
  id: 'legacy-video-task',
  storyboardId: 'board-1',
  targetId: 'video-model',
  status: 'submitted',
  requestBody: { prompt: 'video prompt' },
  createdAt: 1,
  updatedAt: 2,
};
const runningTasks: GenerationTask[] = [imageTask, legacyVideoTask];
assert.equal(isImageGenerationTask(imageTask), true);
assert.equal(isImageGenerationTask(legacyVideoTask), false);
assert.equal(isVideoGenerationTask(imageTask), false);
assert.equal(isVideoGenerationTask(legacyVideoTask), true, 'legacy video tasks without kind must remain compatible');
assert.equal(
  isVideoGenerationTask({ ...legacyVideoTask, kind: null } as unknown as GenerationTask),
  true,
  'legacy video tasks with a null discriminator must remain compatible',
);

type AutofillTaskFixture = {
  id: string;
  kind: 'autofill';
  name: string;
  assetKind: 'character' | 'location' | 'prop' | 'grid';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  requestedFields: string[];
  sourceEntityId?: string;
  customRequirement?: string;
  model: string;
  result?: Record<string, string>;
  bindingWarning?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};
type AutofillTaskProjectFixture = {
  id: string;
  updatedAt: number;
  generationTasks: GenerationTask[];
};
type AutofillTaskStateFixture = {
  project: AutofillTaskProjectFixture;
  projects: AutofillTaskProjectFixture[];
  activeProjectId: string;
};
const autofillHelpers = generationTaskHelpers as unknown as {
  createAutofillGenerationTask?: (
    input: Omit<AutofillTaskFixture, 'kind' | 'status' | 'result' | 'bindingWarning' | 'error' | 'createdAt' | 'updatedAt'>,
    timestamp?: number,
    status?: AutofillTaskFixture['status'],
  ) => AutofillTaskFixture;
  addAutofillGenerationTaskToOwningProject?: (
    current: AutofillTaskStateFixture,
    requestedProjectId: string,
    task: AutofillTaskFixture,
    timestamp?: number,
  ) => AutofillTaskStateFixture;
  completeAutofillGenerationTaskForOwningProject?: (
    current: AutofillTaskStateFixture,
    requestedProjectId: string,
    taskId: string,
    result: Record<string, string>,
    appliedToForm: boolean,
    timestamp?: number,
  ) => AutofillTaskStateFixture;
  patchAutofillGenerationTaskForOwningProject?: (
    current: AutofillTaskStateFixture,
    requestedProjectId: string,
    taskId: string,
    patch: Partial<Pick<AutofillTaskFixture, 'status' | 'result' | 'bindingWarning' | 'error'>>,
    timestamp?: number,
  ) => AutofillTaskStateFixture;
  isAutofillGenerationTask?: (task: GenerationTask) => boolean;
  canApplyAutofillResult?: (
    requested: { projectId: string; assetKind: AutofillTaskFixture['assetKind']; selectedEntityId: string; targetEpoch: number; taskId: string },
    current: { projectId: string; assetKind: AutofillTaskFixture['assetKind']; selectedEntityId: string; targetEpoch: number; taskId: string },
    workbenchMounted: boolean,
  ) => boolean;
  advanceAutofillTargetEpoch?: (
    currentEpoch: number,
    change: {
      selectedEntityId: string;
      fieldKey?: string;
      previousValue?: string;
      nextValue?: string;
      targetReplaced?: boolean;
    },
  ) => number;
  settleAutofillGenerationTask?: (
    tasks: readonly GenerationTask[],
    originalTask: AutofillTaskFixture,
    patch: {
      status: 'succeeded' | 'failed';
      result?: Record<string, string>;
      bindingWarning?: string;
      error?: string;
    },
    timestamp?: number,
  ) => GenerationTask[];
  autofillGenerationStatusLabel?: (status: AutofillTaskFixture['status']) => string;
  removeGenerationTask?: (
    tasks: readonly GenerationTask[],
    taskId: string,
  ) => {
    tasks: GenerationTask[];
    removed: boolean;
    blocked: boolean;
  };
  settleImageGenerationTask?: (
    tasks: readonly GenerationTask[],
    originalTask: GenerationTask,
    patch: {
      status: 'succeeded' | 'failed';
      resultAssetId?: string;
      bindingWarning?: string;
      error?: string;
    },
    timestamp?: number,
  ) => GenerationTask[];
};

const rawAutofillTask = {
  id: 'autofill-task-raw',
  kind: 'autofill',
  name: 'AI 补齐阿莲资料',
  assetKind: 'character',
  status: 'running',
  requestedFields: ['appearance'],
  sourceEntityId: 'character-a',
  model: 'text-model',
  createdAt: 400,
  updatedAt: 400,
} as unknown as GenerationTask;
assert.equal(
  isVideoGenerationTask(rawAutofillTask),
  false,
  'autofill tasks must never enter video polling or retry paths',
);
assert.equal(
  typeof autofillHelpers.createAutofillGenerationTask,
  'function',
  'AI autofill needs a first-class task creator',
);
assert.equal(typeof autofillHelpers.isAutofillGenerationTask, 'function');
assert.equal(typeof autofillHelpers.addAutofillGenerationTaskToOwningProject, 'function');
assert.equal(typeof autofillHelpers.completeAutofillGenerationTaskForOwningProject, 'function');
assert.equal(typeof autofillHelpers.patchAutofillGenerationTaskForOwningProject, 'function');
assert.equal(typeof autofillHelpers.canApplyAutofillResult, 'function');
assert.equal(typeof autofillHelpers.advanceAutofillTargetEpoch, 'function');
assert.equal(typeof autofillHelpers.settleAutofillGenerationTask, 'function');
assert.equal(typeof autofillHelpers.autofillGenerationStatusLabel, 'function');

const autofillTask = autofillHelpers.createAutofillGenerationTask!({
  id: 'autofill-task-1',
  name: 'AI 补齐阿莲资料',
  assetKind: 'character',
  requestedFields: ['appearance', 'outfit'],
  sourceEntityId: 'character-a',
  customRequirement: '重点补齐服装材质与面部辨识特征',
  model: 'text-model',
}, 500);
assert.deepEqual(autofillTask, {
  id: 'autofill-task-1',
  kind: 'autofill',
  name: 'AI 补齐阿莲资料',
  assetKind: 'character',
  status: 'running',
  requestedFields: ['appearance', 'outfit'],
  sourceEntityId: 'character-a',
  customRequirement: '重点补齐服装材质与面部辨识特征',
  model: 'text-model',
  createdAt: 500,
  updatedAt: 500,
});
assert.equal(autofillHelpers.isAutofillGenerationTask!(autofillTask as unknown as GenerationTask), true);
assert.equal(isImageGenerationTask(autofillTask as unknown as GenerationTask), false);
assert.equal(isVideoGenerationTask(autofillTask as unknown as GenerationTask), false);

const projectA: AutofillTaskProjectFixture = {
  id: 'project-a',
  updatedAt: 1,
  generationTasks: [],
};
const projectB: AutofillTaskProjectFixture = {
  id: 'project-b',
  updatedAt: 2,
  generationTasks: [],
};
const activeProjectBState: AutofillTaskStateFixture = {
  project: projectB,
  projects: [projectA, projectB],
  activeProjectId: projectB.id,
};
const taskQueuedForA = autofillHelpers.addAutofillGenerationTaskToOwningProject!(
  activeProjectBState,
  projectA.id,
  autofillTask,
  510,
);
assert.strictEqual(taskQueuedForA.project, projectB, 'creating an A task while B is visible must not replace B');
assert.deepEqual(taskQueuedForA.project.generationTasks, []);
assert.deepEqual(
  taskQueuedForA.projects.find((project) => project.id === projectA.id)?.generationTasks,
  [autofillTask],
  'the task must be retained by the project that started it',
);

const autofillCompletedAfterSwitch = autofillHelpers.completeAutofillGenerationTaskForOwningProject!(
  taskQueuedForA,
  projectA.id,
  autofillTask.id,
  { appearance: '银白长发，琥珀色眼睛', outfit: '深青束袖长袍' },
  false,
  600,
);
const completedAutofillTask = autofillCompletedAfterSwitch.projects
  .find((project) => project.id === projectA.id)
  ?.generationTasks.find((task) => task.id === autofillTask.id) as unknown as AutofillTaskFixture;
assert.equal(completedAutofillTask.status, 'succeeded');
assert.deepEqual(completedAutofillTask.result, {
  appearance: '银白长发，琥珀色眼睛',
  outfit: '深青束袖长袍',
});
assert.match(
  completedAutofillTask.bindingWarning || '',
  /未自动应用/u,
  'a successful result that no longer owns the visible form must explain that it was not applied',
);
assert.strictEqual(autofillCompletedAfterSwitch.project, projectB);
assert.deepEqual(autofillCompletedAfterSwitch.project.generationTasks, []);

const failedAutofillInA = autofillHelpers.patchAutofillGenerationTaskForOwningProject!(
  taskQueuedForA,
  projectA.id,
  autofillTask.id,
  { status: 'failed', error: '文本模型请求失败' },
  620,
);
const failedAutofillTask = failedAutofillInA.projects
  .find((project) => project.id === projectA.id)
  ?.generationTasks.find((task) => task.id === autofillTask.id) as unknown as AutofillTaskFixture;
assert.equal(failedAutofillTask.status, 'failed');
assert.equal(failedAutofillTask.error, '文本模型请求失败');
assert.equal(failedAutofillTask.updatedAt, 620);

const requestedAutofillIdentity = {
  projectId: projectA.id,
  assetKind: 'character' as const,
  selectedEntityId: 'character-a',
  targetEpoch: 3,
  taskId: autofillTask.id,
};
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    requestedAutofillIdentity,
    { ...requestedAutofillIdentity },
    true,
  ),
  true,
);
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    requestedAutofillIdentity,
    { ...requestedAutofillIdentity, projectId: projectB.id },
    true,
  ),
  false,
  'a result from project A must not merge into the visible form for project B',
);
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    requestedAutofillIdentity,
    { ...requestedAutofillIdentity, selectedEntityId: 'character-b' },
    true,
  ),
  false,
  'a result for entity A must not merge into entity B',
);
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    requestedAutofillIdentity,
    { ...requestedAutofillIdentity },
    false,
  ),
  false,
  'an unmounted workbench must reject its old request even after the user later returns',
);
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    requestedAutofillIdentity,
    { ...requestedAutofillIdentity, taskId: 'newer-autofill-task' },
    true,
  ),
  false,
  'an older request must not overwrite a newer request for the same entity',
);
assert.equal(
  autofillHelpers.canApplyAutofillResult!(
    {
      ...requestedAutofillIdentity,
      selectedEntityId: '',
      targetEpoch: 3,
    },
    {
      ...requestedAutofillIdentity,
      selectedEntityId: '',
      targetEpoch: 4,
    },
    true,
  ),
  false,
  'renaming or resetting an unsaved manual target must reject the old result even though both entity IDs are empty',
);

assert.ok(autofillHelpers.advanceAutofillTargetEpoch);
assert.equal(
  autofillHelpers.advanceAutofillTargetEpoch(7, {
    selectedEntityId: '',
    fieldKey: 'name',
    previousValue: '阿莲',
    nextValue: '青荷',
  }),
  8,
  'renaming an unsaved manual record must replace its target identity',
);
assert.equal(
  autofillHelpers.advanceAutofillTargetEpoch(7, {
    selectedEntityId: '',
    fieldKey: 'name',
    previousValue: '阿莲',
    nextValue: '',
  }),
  8,
  'clearing the manual record name must replace its target identity',
);
assert.equal(
  autofillHelpers.advanceAutofillTargetEpoch(7, {
    selectedEntityId: '',
    fieldKey: 'appearance',
    previousValue: '',
    nextValue: '黑色长发、眉间小痣',
  }),
  7,
  'filling another blank field on the same manual target must not invalidate its in-flight completion',
);
assert.equal(
  autofillHelpers.advanceAutofillTargetEpoch(7, {
    selectedEntityId: 'character-a',
    fieldKey: 'name',
    previousValue: '阿莲',
    nextValue: '青荷',
  }),
  7,
  'a saved entity keeps its stable ID when its editable form name changes',
);
assert.equal(
  autofillHelpers.advanceAutofillTargetEpoch(7, {
    selectedEntityId: '',
    targetReplaced: true,
  }),
  8,
  'selecting or resetting a workbench target must always advance the target epoch',
);

assert.ok(autofillHelpers.settleAutofillGenerationTask);
const settledAutofillAfterUndo = autofillHelpers.settleAutofillGenerationTask(
  [],
  autofillTask,
  {
    status: 'succeeded',
    result: { appearance: '黑色长发、眉间小痣' },
    bindingWarning: '目标已变化，未自动应用',
  },
  700,
);
assert.deepEqual(settledAutofillAfterUndo, [{
  ...autofillTask,
  status: 'succeeded',
  result: { appearance: '黑色长发、眉间小痣' },
  bindingWarning: '目标已变化，未自动应用',
  updatedAt: 700,
}]);
const failedAutofillAfterUndo = autofillHelpers.settleAutofillGenerationTask(
  [],
  autofillTask,
  { status: 'failed', error: '文本模型请求失败' },
  710,
);
assert.deepEqual(failedAutofillAfterUndo, [{
  ...autofillTask,
  status: 'failed',
  error: '文本模型请求失败',
  updatedAt: 710,
}]);
assert.equal(autofillHelpers.autofillGenerationStatusLabel!('running'), '补齐中');
assert.equal(autofillHelpers.autofillGenerationStatusLabel!('succeeded'), '已完成');
assert.equal(autofillHelpers.autofillGenerationStatusLabel!('failed'), '失败');

const succeededTasks = patchImageGenerationTask(runningTasks, imageTask.id, {
  status: 'succeeded',
  resultAssetId: 'asset-1',
  resultUrl: 'https://images.example.test/asset-1.png',
  error: undefined,
}, 200);
const succeededImageTask = succeededTasks.find(isImageGenerationTask);
assert.equal(succeededImageTask?.status, 'succeeded');
assert.equal(succeededImageTask?.resultAssetId, 'asset-1');
assert.equal(succeededImageTask?.resultUrl, 'https://images.example.test/asset-1.png');
assert.equal(succeededImageTask?.updatedAt, 200);
assert.equal(succeededImageTask?.createdAt, 100);
assert.equal(succeededTasks[1], legacyVideoTask, 'patching an image task must not mutate legacy video tasks');

const failedTasks = patchImageGenerationTask(runningTasks, imageTask.id, {
  status: 'failed',
  error: '图像接口请求失败：配额不足',
}, 300);
const failedImageTask = failedTasks.find(isImageGenerationTask);
assert.equal(failedImageTask?.status, 'failed');
assert.equal(failedImageTask?.error, '图像接口请求失败：配额不足');
assert.equal(failedImageTask?.resultAssetId, undefined);
assert.equal(imageTask.status, 'running', 'task transitions must not mutate the original task');
assert.equal(imageGenerationStatusLabel('running'), '生成中');
assert.equal(imageGenerationStatusLabel('succeeded'), '已完成');
assert.equal(imageGenerationStatusLabel('failed'), '失败');

assert.equal(
  typeof autofillHelpers.removeGenerationTask,
  'function',
  'task deletion must go through a lifecycle-aware reducer',
);
assert.ok(autofillHelpers.removeGenerationTask);
const blockedRunningImageRemoval = autofillHelpers.removeGenerationTask(
  runningTasks,
  imageTask.id,
);
assert.equal(blockedRunningImageRemoval.blocked, true);
assert.equal(blockedRunningImageRemoval.removed, false);
assert.strictEqual(
  blockedRunningImageRemoval.tasks,
  runningTasks,
  'a running image task must remain present until its worker settles',
);
const queuedImageTask = createImageGenerationTask({
  ...imageTask,
  id: 'queued-image-task',
}, 350, 'queued');
const queuedTasks: GenerationTask[] = [queuedImageTask, legacyVideoTask];
const blockedQueuedImageRemoval = autofillHelpers.removeGenerationTask(
  queuedTasks,
  queuedImageTask.id,
);
assert.equal(blockedQueuedImageRemoval.blocked, false, 'queued work can be revoked and deleted before its worker starts');
assert.equal(blockedQueuedImageRemoval.removed, true);
assert.deepEqual(blockedQueuedImageRemoval.tasks, [legacyVideoTask]);
const removableImageTask = {
  ...imageTask,
  status: 'succeeded' as const,
};
const completedTasks: GenerationTask[] = [removableImageTask, legacyVideoTask];
const completedImageRemoval = autofillHelpers.removeGenerationTask(
  completedTasks,
  removableImageTask.id,
);
assert.equal(completedImageRemoval.blocked, false);
assert.equal(completedImageRemoval.removed, true);
assert.deepEqual(completedImageRemoval.tasks, [legacyVideoTask]);

assert.equal(
  typeof autofillHelpers.settleImageGenerationTask,
  'function',
  'a completed worker must restore its terminal task record when undo removed the queued snapshot',
);
assert.ok(autofillHelpers.settleImageGenerationTask);
const restoredSettledTask = autofillHelpers.settleImageGenerationTask(
  [],
  imageTask,
  {
    status: 'succeeded',
    resultAssetId: 'asset-after-undo',
    bindingWarning: '撤销后完成，未自动绑定',
  },
  360,
);
assert.equal(restoredSettledTask.length, 1);
assert.deepEqual(restoredSettledTask[0], {
  ...imageTask,
  status: 'succeeded',
  resultAssetId: 'asset-after-undo',
  bindingWarning: '撤销后完成，未自动绑定',
  updatedAt: 360,
});

const storyboardImageTask = createImageGenerationTask({
  id: 'storyboard-image-task-1',
  name: '第 2 镜分镜图片',
  assetKind: 'storyboard',
  imageVariant: 'storyboard-frame',
  prompt: '严格依据第 2 镜剧情生成的画面',
  width: 1536,
  height: 1024,
  backend: 'openai',
  model: 'gpt-image-1',
  sourceStoryboardId: 'board-1',
  sourceShotId: 'shot-2',
  batchId: 'batch-1',
  imagePromptRuleSetId: 'image-rule-openai-gpt-image',
  imagePromptRuleSetVersion: '1.0.0',
  imagePromptPresetId: 'image-preset-storyboard',
  imagePromptPresetVersion: '1.0.0',
  imagePromptFormat: 'natural-language',
}, 400, 'queued');
assert.equal(storyboardImageTask.assetKind, 'storyboard');
assert.equal(storyboardImageTask.imageVariant, 'storyboard-frame');
assert.equal(storyboardImageTask.sourceStoryboardId, 'board-1');
assert.equal(storyboardImageTask.sourceShotId, 'shot-2');
assert.equal(storyboardImageTask.batchId, 'batch-1');
assert.equal(storyboardImageTask.imagePromptRuleSetId, 'image-rule-openai-gpt-image');
assert.equal(storyboardImageTask.imagePromptRuleSetVersion, '1.0.0');
assert.equal(storyboardImageTask.imagePromptPresetId, 'image-preset-storyboard');
assert.equal(storyboardImageTask.imagePromptPresetVersion, '1.0.0');
assert.equal(storyboardImageTask.imagePromptFormat, 'natural-language');
assert.equal(storyboardImageTask.status, 'queued');
assert.equal(imageAssetKindLabel('storyboard'), '剧情分镜');
assert.equal(imageGenerationStatusLabel('queued'), '排队中');

const tracedStoryboardTasks = patchImageGenerationTask(
  [storyboardImageTask],
  storyboardImageTask.id,
  {
    imagePromptRuleSetId: 'image-rule-custom-openai',
    imagePromptRuleSetVersion: '2.3.0',
    imagePromptPresetId: 'image-preset-custom-storyboard',
    imagePromptPresetVersion: '4.5.0',
    imagePromptFormat: 'natural-language',
  },
  410,
);
const tracedStoryboardTask = tracedStoryboardTasks.find(isImageGenerationTask);
assert.equal(tracedStoryboardTask?.imagePromptRuleSetId, 'image-rule-custom-openai');
assert.equal(tracedStoryboardTask?.imagePromptRuleSetVersion, '2.3.0');
assert.equal(tracedStoryboardTask?.imagePromptPresetId, 'image-preset-custom-storyboard');
assert.equal(tracedStoryboardTask?.imagePromptPresetVersion, '4.5.0');
assert.equal(tracedStoryboardTask?.imagePromptFormat, 'natural-language');

const settledStoryboardTasks = settleImageGenerationTask(
  [],
  storyboardImageTask,
  {
    status: 'failed',
    error: '转换器拒绝了无效结果',
    imagePromptRuleSetId: 'image-rule-custom-openai',
    imagePromptRuleSetVersion: '2.3.0',
    imagePromptPresetId: 'image-preset-custom-storyboard',
    imagePromptPresetVersion: '4.5.0',
    imagePromptFormat: 'natural-language',
  },
  420,
);
const settledStoryboardTask = settledStoryboardTasks.find(isImageGenerationTask);
assert.equal(settledStoryboardTask?.imagePromptRuleSetId, 'image-rule-custom-openai');
assert.equal(settledStoryboardTask?.imagePromptRuleSetVersion, '2.3.0');
assert.equal(settledStoryboardTask?.imagePromptPresetId, 'image-preset-custom-storyboard');
assert.equal(settledStoryboardTask?.imagePromptPresetVersion, '4.5.0');
assert.equal(settledStoryboardTask?.imagePromptFormat, 'natural-language');

console.log('image variant prompt and canvas regression checks passed');
