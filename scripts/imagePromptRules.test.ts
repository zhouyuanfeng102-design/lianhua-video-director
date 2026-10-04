import assert from 'node:assert/strict';
import * as imagePromptRuleHelpers from '../src/imagePromptRules';
import {
  BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS,
  BUILT_IN_IMAGE_PROMPT_RULE_SETS,
  FIVE_VIEW_IMAGE_PRESET_IDS,
  IMAGE_PROMPT_RULE_CATALOG_VERSION,
  IMAGE_PROMPT_CURRENT_LAYOUT_CONTRACT,
  IMAGE_PROMPT_FULL_BODY_LAYOUT_CONTRACT,
  IMAGE_PROMPT_PROPORTION_CONTRACT,
  IMAGE_PROMPT_PROP_SCOPE_CONTRACT,
  NOVELAI_IMAGE_PRESET_IDS,
  buildImagePromptConverterSystemPrompt,
  gptImage25MicroNsfwConverterExtraRule,
  migrateImagePromptRulesState,
  getImagePromptCategoryPresetFormat,
  isImagePromptPresetCompatibleWithRule,
  normalizeImagePromptCategoryPreset,
  normalizeImagePromptRuleSet,
  normalizeImagePromptRulesState,
  resolveImagePromptSelection,
  sanitizeImagePromptSegment,
  sanitizeImagePromptSections,
  sanitizeFinalImagePrompt,
  serializeImagePromptSections,
  type ImagePromptAssetKind,
  type ImagePromptRulesState,
} from '../src/imagePromptRules';
import {
  MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE,
  MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE,
} from '../src/nsfwPromptRules';
import {
  FULL_BODY_LAYOUT_RULE,
  ordinaryImageVariantConverterRule,
  privateImageVariantConverterRule,
} from '../src/imageGeneration';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>): void => {
  tests.push({ name, run });
};

const requiredAssetKinds: ImagePromptAssetKind[] = [
  'character',
  'character-private',
  'character-sheet',
  'location',
  'prop',
  'storyboard',
  'grid',
];

const multiPersonBindingPresetIds = [
  'image-preset-krea-2-multi-person-character',
  'image-preset-krea-2-multi-person-storyboard',
  'image-preset-comfyui-multi-person-character',
  'image-preset-comfyui-multi-person-storyboard',
  'image-preset-comfyui-regional-multi-person-storyboard',
] as const;
const novelAiPresetIds: readonly string[] = Object.values(NOVELAI_IMAGE_PRESET_IDS);
const fiveViewPresetIds: readonly string[] = Object.values(FIVE_VIEW_IMAGE_PRESET_IDS);
const fiveViewRuleRecommendations = {
  'image-rule-openai-gpt-image': FIVE_VIEW_IMAGE_PRESET_IDS.gpt,
  'image-rule-krea-2': FIVE_VIEW_IMAGE_PRESET_IDS.krea,
  'image-rule-openai-gpt-image-2-5-micro-nsfw': FIVE_VIEW_IMAGE_PRESET_IDS.micro,
} as const;

const withoutFiveViewModelPresets = (state: ImagePromptRulesState): ImagePromptRulesState => ({
  ...state,
  ruleSets: state.ruleSets.map((rule) => ({
    ...rule,
    categoryPresetIds: rule.categoryPresetIds.filter((id) => !fiveViewPresetIds.includes(id)),
    defaultPresetByAssetKind: {
      ...rule.defaultPresetByAssetKind,
      ...(fiveViewPresetIds.includes(rule.defaultPresetByAssetKind['character-sheet'] || '')
        ? { 'character-sheet': 'image-preset-character-sheet' }
        : {}),
    },
  })),
  categoryPresets: state.categoryPresets.filter((preset) => !fiveViewPresetIds.includes(preset.id)),
});

test('three five-view categories expose provider-specific visual quality while keeping the current layout and medium', () => {
  const presets = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => fiveViewPresetIds.includes(preset.id));
  assert.equal(presets.length, 3);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, 3);
  assert.deepEqual(presets.map((preset) => preset.name), ['GPT2.5 · 五视图精修', 'K2 / Krea-2 · 五视图质感', 'GPT2.5 · 微NSFW五视图']);
  for (const preset of presets) {
    assert.equal(preset.assetKind, 'character-sheet');
    assert.equal(preset.format, 'natural-language');
    assert.equal(preset.enabled, true);
    const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-sheet', manualPresetId: preset.id });
    const system = buildImagePromptConverterSystemPrompt(selection, ordinaryImageVariantConverterRule('five-view'));
    assert.ok(system.includes(IMAGE_PROMPT_CURRENT_LAYOUT_CONTRACT));
    assert.match(system, /单张横向3:2.*五个区域/u);
    assert.match(system, /两个头肩特写各自独立放大/u);
    assert.match(system, /右侧三个全身视图.*同一尺度/u);
    assert.equal(system.includes(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE), false);
  }
  for (const preset of presets.filter((item) => item.id !== FIVE_VIEW_IMAGE_PRESET_IDS.micro)) {
    assert.match(preset.systemPrompt, /当前用户选择的媒介、画风/u);
    assert.match(preset.systemPrompt, /不强制改成真人摄影、灰底工程图/u);
    assert.match(preset.systemPrompt, /不擅加头饰、珠宝、服装层/u);
    assert.match(preset.outputRules, /曝光/u);
    assert.match(preset.outputRules, /材质/u);
    assert.doesNotMatch(preset.negativePrompt || '', /cropped body|multiple views|contact sheet/iu);
  }
});

test('five-view micro style specializes the full-body micro NSFW preset without adding an age gate', () => {
  const micro = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro)!;
  assert.equal(micro.version, '1.2.0');
  assert.match(micro.description, /参考 GPT Image 2\.5 微 NSFW 全身角色图预设/u);
  assert.match(micro.systemPrompt, /五个区域共享同一湿身薄衣摄影条件/u);
  assert.match(micro.systemPrompt, /厚重外袍|轻罗\/薄纱|湿润内层/u);
  assert.match(micro.systemPrompt, /左侧两个头像区域.*湿发.*肩颈水珠.*领口/u);
  assert.match(micro.systemPrompt, /右侧三个全身区域.*水压贴体.*衣摆重量/u);
  assert.match(micro.outputRules, /每一区域都必须保留微 NSFW.*湿透.*薄衣.*贴身.*透光/u);
  assert.match(micro.outputRules, /厚重外层.*轻薄衣料|五个区域共享同一套服装状态/u);
  assert.match(micro.outputRules, /不通过放大胸胯腿.*横向拉伸/u);
  assert.match(micro.negativePrompt || '', /dry clothing|plain dry reference sheet/u);
  assert.doesNotMatch(
    `${micro.description}\n${micro.systemPrompt}\n${micro.outputRules}\n${micro.negativePrompt || ''}`,
    /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b|年龄门禁|安全政策/iu,
  );
  const before = JSON.stringify({ micro });
  const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-sheet', imageVariant: 'five-view', manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw' });
  const system = buildImagePromptConverterSystemPrompt(selection, ordinaryImageVariantConverterRule('five-view'));
  assert.ok(system.includes(micro.systemPrompt));
  assert.ok(system.includes(micro.outputRules));
  assert.ok(system.includes(ordinaryImageVariantConverterRule('five-view')));
  assert.equal(JSON.stringify({ micro }), before);
});

test('catalog-v12 upgrades untouched GPT2.5 micro five-view preset while preserving enabled state', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const characterMicro = current.categoryPresets.find((preset) => preset.id === 'image-preset-gpt-image-2-5-micro-nsfw-character')!;
  const oldMicro = {
    ...characterMicro,
    id: FIVE_VIEW_IMAGE_PRESET_IDS.micro,
    name: 'GPT2.5 · 微NSFW五视图',
    assetKind: 'character-sheet' as const,
    description: '沿用现有 GPT Image 2.5 微 NSFW 角色参考图预设，版式服从本次五视图规格。',
    enabled: false,
  };
  const legacy = {
    ...current,
    catalogVersion: 12,
    categoryPresets: current.categoryPresets.map((preset) => (
      preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro ? oldMicro : preset
    )),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  const micro = migrated.categoryPresets.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro)!;
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.equal(micro.version, '1.2.0');
  assert.equal(micro.enabled, false);
  assert.match(micro.systemPrompt, /五个区域共享同一湿身薄衣摄影条件/u);
  assert.match(micro.systemPrompt, /厚重外袍|轻罗\/薄纱|湿润内层/u);
  assert.match(micro.outputRules, /每一区域都必须保留微 NSFW/u);
  assert.deepEqual(migrated.ruleSets, legacy.ruleSets);
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v12 micro upgrade preserves deletions, edits, disabled choices and frozen libraries', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const characterMicro = current.categoryPresets.find((preset) => preset.id === 'image-preset-gpt-image-2-5-micro-nsfw-character')!;
  const oldMicro = {
    ...characterMicro,
    id: FIVE_VIEW_IMAGE_PRESET_IDS.micro,
    name: 'GPT2.5 · 微NSFW五视图',
    assetKind: 'character-sheet' as const,
    description: '沿用现有 GPT Image 2.5 微 NSFW 角色参考图预设，版式服从本次五视图规格。',
  };
  const legacy = { ...current, catalogVersion: 12, categoryPresets: current.categoryPresets.map((preset) => (
    preset.id === oldMicro.id ? oldMicro : preset
  )) };
  for (const removedIds of [[FIVE_VIEW_IMAGE_PRESET_IDS.micro], fiveViewPresetIds]) {
    const input = { ...legacy, categoryPresets: legacy.categoryPresets.filter((preset) => !removedIds.includes(preset.id)) };
    assert.deepEqual(migrateImagePromptRulesState(input), { ...input, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION });
  }
  for (const edit of [
    { name: 'USER_NAME' }, { description: 'USER_DESCRIPTION' }, { systemPrompt: 'USER_SYSTEM' },
    { outputRules: 'USER_OUTPUT' }, { negativePrompt: 'USER_NEGATIVE' }, { format: 'sd-tags' as const },
    { version: 'custom-1' }, { assetKind: 'character' as const }, { updatedAt: 123 },
  ]) {
    const input = { ...legacy, categoryPresets: legacy.categoryPresets.map((preset) => (
      preset.id === oldMicro.id ? { ...preset, ...edit } : preset
    )) };
    assert.deepEqual(migrateImagePromptRulesState(input), { ...input, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION });
  }
  for (const enabled of [true, false]) {
    const input = { ...legacy, categoryPresets: legacy.categoryPresets.map((preset) => (
      preset.id === oldMicro.id ? { ...preset, enabled } : preset
    )) };
    const before = structuredClone(input);
    const migrated = migrateImagePromptRulesState(input);
    const updated = migrated.categoryPresets.find((preset) => preset.id === oldMicro.id)!;
    assert.equal(updated.version, '1.2.0');
    assert.equal(updated.enabled, enabled);
    assert.deepEqual(input, before, 'migration must not mutate frozen task libraries');
    assert.deepEqual(migrated.ruleSets, input.ruleSets);
    assert.deepEqual(migrated.categoryPresets.filter((preset) => preset.id !== oldMicro.id),
      input.categoryPresets.filter((preset) => preset.id !== oldMicro.id));
    assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
  }
  const deleted = { ...legacy, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION,
    categoryPresets: legacy.categoryPresets.filter((preset) => preset.id !== oldMicro.id) };
  assert.deepEqual(migrateImagePromptRulesState(deleted), deleted);
  const allDeleted = { ...legacy, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION,
    categoryPresets: legacy.categoryPresets.filter((preset) => !fiveViewPresetIds.includes(preset.id)) };
  assert.deepEqual(migrateImagePromptRulesState(allDeleted), allDeleted);
});

test('catalog-v14 GPT Image 2.5 micro NSFW rules are replaced by the 0.6.4 factory rules', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const microRuleId = 'image-rule-openai-gpt-image-2-5-micro-nsfw';
  const microCharacterId = 'image-preset-gpt-image-2-5-micro-nsfw-character';
  const microStoryboardId = 'image-preset-gpt-image-2-5-micro-nsfw-storyboard';
  const dynamicRule = {
    ...current.ruleSets.find((rule) => rule.id === microRuleId)!,
    systemPrompt: '旧版动态上下文前缀合同：先用当前剧情建立开场句，再写湿身薄衣。',
    outputRules: '最终提示词必须先用 1 至 2 句与当前剧情一致的上下文开场。',
    version: '1.1.0',
  };
  const dynamicPresets = current.categoryPresets.map((preset) => {
    if (preset.id === microCharacterId || preset.id === microStoryboardId) {
      return {
        ...preset,
        systemPrompt: `${preset.systemPrompt}\n先沿用动态上下文前缀合同。`,
        outputRules: `${preset.outputRules}\n最终提示词先有与当前剧情一致的上下文。`,
        version: '1.1.0',
      };
    }
    if (preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro) {
      return {
        ...preset,
        systemPrompt: `${preset.systemPrompt}\n先沿用动态上下文前缀合同。`,
        outputRules: `${preset.outputRules}\n在动态上下文开场句之后继续写五视图。`,
        version: '1.2.0',
      };
    }
    return preset;
  });
  const customRule = {
    ...current.ruleSets[0],
    id: 'user-kept-rule',
    systemPrompt: 'USER_RULE_SENTINEL 动态上下文前缀合同',
  };
  const legacy = {
    ...current,
    catalogVersion: 14,
    ruleSets: current.ruleSets.map((rule) => (
      rule.id === microRuleId ? dynamicRule : rule
    )).concat(customRule),
    categoryPresets: dynamicPresets,
  };

  const migrated = migrateImagePromptRulesState(legacy);
  const microRule = migrated.ruleSets.find((rule) => rule.id === microRuleId)!;
  const microCharacter = migrated.categoryPresets.find((preset) => preset.id === microCharacterId)!;
  const microStoryboard = migrated.categoryPresets.find((preset) => preset.id === microStoryboardId)!;
  const microFiveView = migrated.categoryPresets.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro)!;
  const migratedText = JSON.stringify({
    microRule,
    microCharacter,
    microStoryboard,
    microFiveView,
  });

  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.match(microRule.systemPrompt, /湿身/u);
  assert.match(microRule.outputRules, /单一画面时间点/u);
  assert.match(microCharacter.systemPrompt, /全身湿透或半身湿透/u);
  assert.match(microCharacter.systemPrompt, /薄衣贴身/u);
  assert.match(microFiveView.systemPrompt, /全身湿透或半身湿透/u);
  assert.match(microFiveView.outputRules, /每一区域都必须保留微 NSFW/u);
  assert.doesNotMatch(migratedText, /动态上下文前缀合同|动态上下文开场句|最终提示词必须先用 1 至 2 句|最终提示词先有与/u);
  assert.match(migrated.ruleSets.find((rule) => rule.id === 'user-kept-rule')!.systemPrompt, /USER_RULE_SENTINEL/u);

  const selection = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character-sheet',
    imageVariant: 'five-view',
    manualRuleSetId: microRuleId,
    state: migrated,
  });
  const converter = buildImagePromptConverterSystemPrompt(selection, ordinaryImageVariantConverterRule('five-view'));
  assert.match(converter, /全身湿透或半身湿透/u);
  assert.match(converter, /薄衣贴身|轻罗\/薄纱\/丝质衣料贴身/u);
  assert.doesNotMatch(converter, /动态上下文前缀合同|动态上下文开场句|最终提示词必须先用 1 至 2 句/u);
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v16 refreshes untouched GPT2.5 micro NSFW light-clothing rules without age gate text', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const microRuleId = 'image-rule-openai-gpt-image-2-5-micro-nsfw';
  const microCharacterId = 'image-preset-gpt-image-2-5-micro-nsfw-character';
  const microStoryboardId = 'image-preset-gpt-image-2-5-micro-nsfw-storyboard';
  const oldRule = {
    ...current.ruleSets.find((rule) => rule.id === microRuleId)!,
    version: '1.0.0',
    systemPrompt: '面向 GPT Image 2.5 写自然语言生图提示词：用可摄影的湿身、薄衣、贴身布料、逆光透光、皮肤水珠、蒸汽、雨雾、泳池水面或温泉雾气等环境和材质状态表达微 NSFW 氛围；主体身份、服装基底、动作和场景逻辑来自输入，不把普通镜头改写成私密资料图。优先写全身或半身画面、整体轮廓、布料厚薄、湿度、贴合区域、光线方向、遮挡层次和电影摄影质感；弱化直白器官词、性行为词、露骨姿势和局部拆解。',
    outputRules: '只输出一段连贯的自然语言画面描述；不写模型名、政策、规则解释、JSON、Markdown 或参数。微 NSFW 表达必须来自衣物湿透、薄纱/衬衫/裙摆等材质、姿态含蓄、光线和环境，不使用色情化命令、直接裸露要求或私密部位特写；保持单一画面时间点和清楚构图。',
    negativePrompt: 'explicit sexual act, full nudity, genital close-up, pornographic pose, text, logo, watermark',
    enabled: false,
  };
  const legacy = {
    ...current,
    catalogVersion: 15,
    ruleSets: current.ruleSets.map((rule) => (rule.id === microRuleId ? oldRule : rule)),
    categoryPresets: current.categoryPresets.map((preset) => {
      if (preset.id === microCharacterId || preset.id === microStoryboardId) {
        return preset.id === microCharacterId
          ? {
              ...preset,
              version: '1.0.0',
              systemPrompt: '把角色资料组织为单一人物的微 NSFW 角色画面：保持原角色身份、性别或雌雄设定、物种形态、发型脸部、体型、服装基底、配色与道具锚点；视觉状态采用全身湿透或半身湿透、薄衣贴身、布料被雨水或水汽压出轮廓、皮肤水珠、湿发、逆光边缘光、柔雾或室内暖光等可见条件。',
              outputRules: '优先全身、膝上或半身构图，衣物仍作为主要遮挡层，薄透和贴身只表现轮廓、褶皱、湿度与材质；姿态自然克制，目光、手势和身体曲线服务角色气质；不改写成私密资料图、局部器官特写、直接裸露要求或多人物擦边拼贴。',
              negativePrompt: 'explicit sexual act, full nudity, genital close-up, pornographic pose, duplicate body, text, logo, watermark',
              enabled: false,
            }
          : {
              ...preset,
              version: '1.0.0',
              systemPrompt: '把当前分镜转为单一时刻的微 NSFW 剧情静帧：保留剧情主体、场景、动作结果、空间关系和机位；只有在输入存在涉水、雨夜、浴室、温泉、泳池、汗湿、湿衣、换衣边缘或贴身衣料等合理条件时强化湿身薄衣氛围，否则只做轻微光影、材质和轮廓暗示。',
              outputRules: '使用雨水、水汽、汗湿、薄布透光、贴身褶皱、边缘光、遮挡前景和浅景深营造含蓄性感；保持一个时间点、一个机位、一个清楚主体动作；不把普通剧情改成直接裸露、性行为、私密部位特写或四宫格设定板。',
              negativePrompt: 'explicit sexual act, full nudity, genital close-up, pornographic pose, multiple panels, contact sheet, text, logo, watermark',
            };
      }
      if (preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro) {
        return {
          ...preset,
          version: '1.1.0',
          systemPrompt: '把角色资料组织为单张横向3:2的微 NSFW 五视图参考板。先锁定同一角色身份、性别或雌雄设定、物种形态、发型脸部、体型、服装基底、配色与道具锚点，再按五个区域分别写取景。本次当前图片规格优先于通用单主体或旧设定板描述。当前规格为五视图时，明确组织单张横向3:2画布中的五个区域：左侧上下为正面和严格90度左侧面头肩特写，右侧依次为正面、严格90度左侧面、背面全身；两个近景各自独立放大，三个全身保持同尺度、同相机高度、同站立基线。五个视角属于同一角色，不是五名人物；头像不补成全身，不改成五个等宽全身栏。若用户选择其他当前规格，则严格执行该规格的区域数量、位置、视角与取景。保留当前用户选择的媒介、画风与角色资料，不强制改成真人摄影、灰底工程图或新的身份造型；头部与面部结构、发型发色、体型、物种结构、服装基底、配色和明确属于长期稳定装备/辨识物的道具在所有区域一致。只精细表现已有设计，不擅加头饰、珠宝、服装层或新标记；一次性购买物、食物、临时容器、借用物和当前动作手持物不属于人物设定图身份；非类人主体按真实头部、感知结构和附肢表现，不套人类脸部模板。五个区域共享同一湿身薄衣摄影条件：全身湿透或半身湿透、薄衣贴身、布料被雨水或水汽压出轮廓、皮肤水珠、湿发、逆光边缘光、柔雾或室内暖光。左侧两个头像区域表现湿发、肩颈水珠、领口或肩部薄布透光、贴身褶皱和含蓄表情；右侧三个全身区域表现服装被水压贴体后的整体轮廓、袖口和腰带湿痕、衣摆重量、湿润褶皱、腿部和腰身线条暗示。',
          outputRules: '五视图版式优先：左侧两格只做正面和严格90度左侧面头肩特写，右侧三个全身只做正面、严格90度左侧面、背面全身；每一区域都必须保留微 NSFW 的湿透、薄衣、贴身、透光、皮肤水珠和湿发材质状态。衣物仍作为主要遮挡层，薄透和贴身只表现轮廓、褶皱、湿度、材质与曲线暗示；姿态自然克制，五个视角属于同一人物，不变成多人物拼贴、普通干燥设定板、私密资料图、局部器官特写、直接裸露要求或色情姿势。输出一段可直接生图的自然语言画面指令，不写模型参数、政策解释或效果保证。',
        };
      }
      return preset;
    }),
  };

  const migrated = migrateImagePromptRulesState(legacy);
  const microRule = migrated.ruleSets.find((rule) => rule.id === microRuleId)!;
  const microCharacter = migrated.categoryPresets.find((preset) => preset.id === microCharacterId)!;
  const microStoryboard = migrated.categoryPresets.find((preset) => preset.id === microStoryboardId)!;
  const microFiveView = migrated.categoryPresets.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.micro)!;
  const text = JSON.stringify({ microRule, microCharacter, microStoryboard, microFiveView });

  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.equal(microRule.version, '1.1.0');
  assert.equal(microRule.enabled, false);
  assert.equal(microCharacter.version, '1.1.0');
  assert.equal(microCharacter.enabled, false);
  assert.equal(microStoryboard.version, '1.1.0');
  assert.equal(microFiveView.version, '1.2.0');
  assert.match(text, /厚重外袍|轻罗裙|湿润内衬|轻薄衣料/u);
  assert.match(text, /不通过放大胸胯腿|横向拉伸|左右保留雨雾/u);
  assert.doesNotMatch(text, /18\s*岁|年龄门禁|未成年|\bminor\b|\bchild\b|\bteen\b/iu);
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);

  const edited = {
    ...legacy,
    categoryPresets: legacy.categoryPresets.map((preset) => (
      preset.id === microCharacterId
        ? { ...preset, updatedAt: 123, systemPrompt: 'USER_LIGHT_CLOTHING_EDIT' }
        : preset
    )),
  };
  const editedMigrated = migrateImagePromptRulesState(edited);
  assert.equal(
    editedMigrated.categoryPresets.find((preset) => preset.id === microCharacterId)!.systemPrompt,
    'USER_LIGHT_CLOTHING_EDIT',
  );
});

test('new five-view requests recommend matching untouched presets without changing saved defaults', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const before = structuredClone(state);
  for (const model of ['gpt-image-2.5', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-micro-nsfw']) {
    const selected = resolveImagePromptSelection({ backend: 'openai', model, assetKind: 'character-sheet', imageVariant: 'five-view', state });
    assert.equal(selected.preset.id, FIVE_VIEW_IMAGE_PRESET_IDS.gpt, 'model text alone must not opt into micro style');
    assert.equal(selected.presetSource, 'variant-recommendation');
  }
  assert.equal(resolveImagePromptSelection({ backend: 'openai', model: 'krea-2', assetKind: 'character-sheet', imageVariant: 'five-view', state }).preset.id, FIVE_VIEW_IMAGE_PRESET_IDS.krea);
  for (const [ruleId, presetId] of Object.entries(fiveViewRuleRecommendations)) {
    const selected = resolveImagePromptSelection({ backend: 'openai', model: 'gpt-image-2.5', assetKind: 'character-sheet', imageVariant: 'five-view', manualRuleSetId: ruleId, state });
    assert.equal(selected.preset.id, presetId);
    assert.equal(selected.presetSource, 'variant-recommendation');
    assert.equal(selected.ruleSet.defaultPresetByAssetKind['character-sheet'], 'image-preset-character-sheet');
    for (const id of fiveViewPresetIds) {
      assert.ok(selected.ruleSet.categoryPresetIds.includes(id));
      const manual = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-sheet', imageVariant: 'five-view', manualRuleSetId: ruleId, manualPresetId: id, state });
      assert.equal(manual.preset.id, id);
      assert.equal(manual.presetSource, 'manual');
    }
    assert.equal(resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-private', imageVariant: 'private-five-view', manualRuleSetId: ruleId, state }).preset.id, 'image-preset-character-private');
  }
  assert.equal(resolveImagePromptSelection({ backend: 'openai', model: 'gpt-image-2.5', assetKind: 'character-sheet', imageVariant: 'five-view', manualPresetId: 'image-preset-character-sheet', state }).preset.id, 'image-preset-character-sheet');
  assert.deepEqual(state, before, 'recommendations must not rewrite the saved rule library');
});

test('legacy layouts, other compatible models and non-explicit micro rules never gain a five-view preset', () => {
  for (const ruleId of Object.keys(fiveViewRuleRecommendations)) {
    for (const imageVariant of [undefined, 'turnaround', 'full-body'] as const) {
      const selected = resolveImagePromptSelection({ backend: 'openai', model: 'gpt-image-2.5', assetKind: 'character-sheet', imageVariant, manualRuleSetId: ruleId });
      assert.equal(selected.preset.id, 'image-preset-character-sheet');
      assert.equal(selected.presetSource, 'rule-default');
    }
  }
  for (const model of [undefined, 'gpt-image-1', 'dall-e-3', 'other-openai-compatible', 'gpt-image-2-5-micro-nsfw']) {
    const selected = resolveImagePromptSelection({ backend: 'openai', model, assetKind: 'character-sheet', imageVariant: 'five-view' });
    assert.equal(selected.preset.id, 'image-preset-character-sheet');
  }
  const microDefault = normalizeImagePromptRulesState(undefined);
  microDefault.defaultRuleSetByBackend.openai = 'image-rule-openai-gpt-image-2-5-micro-nsfw';
  assert.equal(resolveImagePromptSelection({ backend: 'openai', model: 'gpt-image-2.5', assetKind: 'character-sheet', imageVariant: 'five-view', state: microDefault }).preset.id, 'image-preset-character-sheet');
  for (const backend of ['sd-webui', 'comfyui', 'novelai'] as const) {
    const ordinary = resolveImagePromptSelection({ backend, assetKind: 'character-sheet', imageVariant: 'five-view' });
    assert.equal(fiveViewPresetIds.includes(ordinary.preset.id), false);
    assert.throws(() => resolveImagePromptSelection({ backend, assetKind: 'character-sheet', manualPresetId: FIVE_VIEW_IMAGE_PRESET_IDS.gpt }), /格式.*不兼容/u);
  }
});

test('five-view recommendations respect edited rules, saved bindings and backend defaults', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const factory = state.ruleSets.find((rule) => rule.id === 'image-rule-openai-gpt-image')!;
  const input = { backend: 'openai' as const, model: 'gpt-image-2.5', assetKind: 'character-sheet' as const, imageVariant: 'five-view' as const };
  for (const edited of [
    { ...factory, name: '用户规则名' },
    { ...factory, description: 'USER_DESCRIPTION' },
    { ...factory, systemPrompt: 'USER_RULE_BODY' },
    { ...factory, outputRules: 'USER_OUTPUT' },
    { ...factory, negativePrompt: 'USER_NEGATIVE' },
    { ...factory, enabled: false },
    { ...factory, updatedAt: 123 },
    { ...factory, version: 'custom' },
    { ...factory, categoryPresetIds: [...factory.categoryPresetIds, 'user-preset'] },
    { ...factory, categoryPresetIds: factory.categoryPresetIds.filter((id) => id !== FIVE_VIEW_IMAGE_PRESET_IDS.gpt) },
    { ...factory, defaultPresetByAssetKind: { ...factory.defaultPresetByAssetKind, prop: 'user-prop-preset' } },
  ]) {
    const current = { ...state, ruleSets: state.ruleSets.map((rule) => rule.id === edited.id ? edited : rule) };
    const before = structuredClone(current);
    const selected = resolveImagePromptSelection({ ...input, state: current });
    assert.equal(selected.preset.id, 'image-preset-character-sheet');
    assert.notEqual(selected.presetSource, 'variant-recommendation');
    assert.deepEqual(current, before);
  }
  for (const defaultPresetId of ['image-preset-anime-character-sheet', FIVE_VIEW_IMAGE_PRESET_IDS.micro]) {
    const current = { ...state, ruleSets: state.ruleSets.map((rule) => rule.id === factory.id
      ? { ...rule, defaultPresetByAssetKind: { ...rule.defaultPresetByAssetKind, 'character-sheet': defaultPresetId } }
      : rule) };
    const selected = resolveImagePromptSelection({ ...input, state: current });
    assert.equal(selected.preset.id, defaultPresetId, 'an explicitly configured category default wins');
    assert.equal(selected.presetSource, 'rule-default');
  }
  const customDefault = { ...state, defaultRuleSetByBackend: { ...state.defaultRuleSetByBackend, openai: 'image-rule-generic' } };
  assert.equal(resolveImagePromptSelection({ ...input, state: customDefault }).preset.id, 'image-preset-character-sheet');
  const missingRule = { ...state, ruleSets: state.ruleSets.filter((rule) => rule.id !== factory.id) };
  assert.equal(resolveImagePromptSelection({ ...input, state: missingRule }).preset.id, 'image-preset-character-sheet');
  assert.throws(() => resolveImagePromptSelection({ ...input, manualRuleSetId: factory.id, state: missingRule }), /不存在/u);
});

test('renamed, edited, disabled or deleted sheet presets opt out of five-view recommendations', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const input = { backend: 'openai' as const, model: 'gpt-image-2.5', assetKind: 'character-sheet' as const, imageVariant: 'five-view' as const };
  for (const id of ['image-preset-character-sheet', FIVE_VIEW_IMAGE_PRESET_IDS.gpt]) {
    const factory = state.categoryPresets.find((preset) => preset.id === id)!;
    for (const edited of [
      { ...factory, name: '用户分类名' },
      { ...factory, description: 'USER_DESCRIPTION' },
      { ...factory, systemPrompt: 'USER_PRESET_BODY' },
      { ...factory, outputRules: 'USER_OUTPUT' },
      { ...factory, negativePrompt: 'USER_NEGATIVE' },
      { ...factory, enabled: false },
      { ...factory, updatedAt: 123 },
      { ...factory, version: 'custom' },
    ]) {
      const current = { ...state, categoryPresets: state.categoryPresets.map((preset) => preset.id === id ? edited : preset) };
      const before = structuredClone(current);
      const selected = resolveImagePromptSelection({ ...input, state: current });
      assert.equal(fiveViewPresetIds.includes(selected.preset.id), false);
      assert.notEqual(selected.presetSource, 'variant-recommendation');
      assert.deepEqual(current, before);
    }
    const deleted = { ...state, categoryPresets: state.categoryPresets.filter((preset) => preset.id !== id) };
    const before = structuredClone(deleted);
    assert.equal(fiveViewPresetIds.includes(resolveImagePromptSelection({ ...input, state: deleted }).preset.id), false);
    assert.deepEqual(deleted, before, 'selection never resurrects a deliberately removed record');
  }
  const custom = { ...state.categoryPresets.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.gpt)!, name: '我的手选分类', systemPrompt: 'USER_PRESET_BODY' };
  const current = { ...state, categoryPresets: state.categoryPresets.map((preset) => preset.id === custom.id ? custom : preset) };
  const manual = resolveImagePromptSelection({ ...input, manualPresetId: custom.id, state: current });
  assert.deepEqual(manual.preset, custom, 'edited categories remain available when explicitly selected');
  assert.equal(manual.presetSource, 'manual');
});

test('compatible fallback cannot silently opt into five-view or micro when ordinary defaults were deleted', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const state = { ...current, categoryPresets: current.categoryPresets.filter((preset) => fiveViewPresetIds.includes(preset.id)) };
  for (const imageVariant of [undefined, 'turnaround', 'five-view'] as const) {
    assert.throws(() => resolveImagePromptSelection({ backend: 'openai', model: 'gpt-image-2.5', assetKind: 'character-sheet', imageVariant, state }), /没有找到/u);
  }
  const explicit = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character-sheet', imageVariant: 'five-view', manualPresetId: FIVE_VIEW_IMAGE_PRESET_IDS.micro, state });
  assert.equal(explicit.preset.id, FIVE_VIEW_IMAGE_PRESET_IDS.micro);
  assert.equal(explicit.presetSource, 'manual');
});

test('catalog eleven adds five-view presets once without rebinding any sheet default', () => {
  const input = { ...withoutFiveViewModelPresets(normalizeImagePromptRulesState(undefined)), catalogVersion: 11 };
  const before = structuredClone(input);
  const migrated = migrateImagePromptRulesState(input);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.deepEqual(migrated.categoryPresets.slice(0, before.categoryPresets.length), before.categoryPresets);
  assert.deepEqual(migrated.categoryPresets.slice(before.categoryPresets.length).map((preset) => preset.id), fiveViewPresetIds);
  for (const previous of before.ruleSets) {
    const next = migrated.ruleSets.find((rule) => rule.id === previous.id)!;
    const expected = Object.entries(fiveViewRuleRecommendations).find(([ruleId]) => ruleId === previous.id)?.[1];
    assert.deepEqual(next, expected ? {
      ...previous,
      categoryPresetIds: [...previous.categoryPresetIds, ...fiveViewPresetIds],
    } : previous);
  }
  assert.deepEqual(migrated.defaultRuleSetByBackend, before.defaultRuleSetByBackend);
  assert.deepEqual(input, before, 'saved libraries and frozen task snapshots are never mutated in place');
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('five-view migration preserves manual bindings, edited/disabled rules and customized or missing base sheets', () => {
  const legacy = { ...withoutFiveViewModelPresets(normalizeImagePromptRulesState(undefined)), catalogVersion: 11 };
  const factoryRule = legacy.ruleSets.find((rule) => rule.id === 'image-rule-openai-gpt-image')!;
  for (const edited of [
    { ...factoryRule, name: '用户规则名称' },
    { ...factoryRule, description: 'USER_DESCRIPTION' },
    { ...factoryRule, systemPrompt: 'USER_RULE_BODY' },
    { ...factoryRule, outputRules: 'USER_OUTPUT' },
    { ...factoryRule, negativePrompt: 'USER_NEGATIVE' },
    { ...factoryRule, enabled: false },
    { ...factoryRule, updatedAt: 123 },
    { ...factoryRule, version: 'custom' },
    { ...factoryRule, categoryPresetIds: [...factoryRule.categoryPresetIds, 'user-preset'] },
    { ...factoryRule, categoryPresetIds: [...factoryRule.categoryPresetIds, 'image-preset-anime-character-sheet'], defaultPresetByAssetKind: { ...factoryRule.defaultPresetByAssetKind, 'character-sheet': 'image-preset-anime-character-sheet' } },
  ]) {
    const next = migrateImagePromptRulesState({ ...legacy, ruleSets: legacy.ruleSets.map((rule) => rule.id === edited.id ? edited : rule) });
    assert.deepEqual(next.ruleSets.find((rule) => rule.id === edited.id), edited);
  }
  for (const categoryPresets of [
    legacy.categoryPresets.filter((preset) => preset.id !== 'image-preset-character-sheet'),
    legacy.categoryPresets.map((preset) => preset.id === 'image-preset-character-sheet' ? { ...preset, enabled: false } : preset),
    legacy.categoryPresets.map((preset) => preset.id === 'image-preset-character-sheet' ? { ...preset, systemPrompt: 'USER_SHEET' } : preset),
  ]) {
    const migrated = migrateImagePromptRulesState({ ...legacy, categoryPresets });
    assert.equal(migrated.ruleSets.find((rule) => rule.id === factoryRule.id)!.defaultPresetByAssetKind['character-sheet'], 'image-preset-character-sheet');
    assert.deepEqual(migrated.categoryPresets.slice(0, categoryPresets.length), categoryPresets);
  }
});

test('five-view migration preserves colliding records, deliberate deletions and custom-only libraries', () => {
  const legacy = { ...withoutFiveViewModelPresets(normalizeImagePromptRulesState(undefined)), catalogVersion: 11 };
  const custom = { ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((preset) => preset.id === FIVE_VIEW_IMAGE_PRESET_IDS.gpt)!, name: '用户同ID分类', systemPrompt: 'USER_STYLE_SENTINEL', enabled: false, updatedAt: 123 };
  const migrated = migrateImagePromptRulesState({ ...legacy, categoryPresets: [...legacy.categoryPresets, custom] });
  assert.deepEqual(migrated.categoryPresets.find((preset) => preset.id === custom.id), custom);
  assert.equal(migrated.ruleSets.find((rule) => rule.id === 'image-rule-openai-gpt-image')!.defaultPresetByAssetKind['character-sheet'], 'image-preset-character-sheet');
  const deleted = { ...migrated,
    ruleSets: migrated.ruleSets.filter((rule) => rule.id !== 'image-rule-krea-2'),
    categoryPresets: migrated.categoryPresets.filter((preset) => preset.id !== FIVE_VIEW_IMAGE_PRESET_IDS.micro),
  };
  assert.deepEqual(migrateImagePromptRulesState(JSON.parse(JSON.stringify(deleted))), deleted);
  for (const ruleSets of [[], [{ ...legacy.ruleSets[0], id: 'user-only' }], [{ ...legacy.ruleSets[0], id: 'constructor' }]]) {
    const input = { ...legacy, ruleSets, categoryPresets: [] };
    assert.deepEqual(migrateImagePromptRulesState(input), { ...input, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION });
  }
  const future = { ...legacy, catalogVersion: 99 };
  assert.deepEqual(migrateImagePromptRulesState(future), future);
});

const kreaMultiPersonBindingPresetIds = [
  'image-preset-krea-2-multi-person-character',
  'image-preset-krea-2-multi-person-storyboard',
] as const;

const comfyuiMultiPersonBindingPresetIds = [
  'image-preset-comfyui-multi-person-character',
  'image-preset-comfyui-multi-person-storyboard',
  'image-preset-comfyui-regional-multi-person-storyboard',
] as const;

test('five-view aliases keep ordinary sheet and private categories separate with current layout priority', () => {
  assert.equal(normalizeImagePromptCategoryPreset({ id: 'five-sheet', category: 'five_view', name: '五区域' })?.assetKind, 'character-sheet');
  assert.equal(normalizeImagePromptCategoryPreset({ id: 'private-five-sheet', category: 'private-five-view', name: '私密五区域' })?.assetKind, 'character-private');
  for (const backend of ['openai', 'comfyui', 'novelai'] as const) {
    for (const kind of ['character-sheet', 'character-private'] as const) {
      const selection = resolveImagePromptSelection({ backend, assetKind: kind });
      const snapshot = JSON.stringify(selection);
      const rule = kind === 'character-sheet'
        ? ordinaryImageVariantConverterRule('five-view')
        : privateImageVariantConverterRule('private-five-view', 'full-body');
      const system = buildImagePromptConverterSystemPrompt(selection, rule);
      assert.equal(selection.preset.assetKind, kind);
      assert.ok(system.includes(IMAGE_PROMPT_CURRENT_LAYOUT_CONTRACT));
      assert.ok(system.includes(rule));
      assert.match(system, /头像区.*不能.*补成全身/u);
      assert.match(system, /同一张设定板.*一次图片生成/u);
      assert.doesNotMatch(system, /也不得把四视图改成无关姿势拼贴|完整主体、统一基线/u);
      if (kind === 'character-private') {
        assert.doesNotMatch(system, /成年人物|18\s*岁|年龄门禁|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu);
      }
      assert.equal(JSON.stringify(selection), snapshot, 'building current request instructions does not migrate user rule libraries');
    }
  }
});

test('catalog-v10 refreshes only exact factory sheet layouts and preserves user choices and frozen libraries', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const baseSheet = current.categoryPresets.find((preset) => preset.id === 'image-preset-character-sheet')!;
  const legacyOutput = '准确表现资料中的性别或雌雄/自定义性别与物种形态；优先横向设定板、正交或低透视、完整主体、统一基线和干净中性背景；不得改变性别或物种结构，不得把非类人主体改成带人类头部的人形怪物，也不得把四视图改成无关姿势拼贴。';
  const legacy = {
    ...current, catalogVersion: 10,
    categoryPresets: current.categoryPresets.map((preset) => preset.assetKind === 'character-sheet'
      && preset.outputRules.includes(baseSheet.outputRules)
      ? { ...preset, version: '1.0.0', outputRules: preset.outputRules.replace(baseSheet.outputRules, legacyOutput) }
      : preset),
  };
  const before = JSON.stringify(legacy);
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.deepEqual(migrated.categoryPresets, current.categoryPresets);
  assert.equal(JSON.stringify(legacy), before, 'migration does not mutate the original saved library');
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
  const oldBase = legacy.categoryPresets.find((preset) => preset.id === baseSheet.id)!;
  const disabled = migrateImagePromptRulesState({ ...legacy,
    categoryPresets: legacy.categoryPresets.map((preset) => preset.id === oldBase.id ? { ...preset, enabled: false } : preset),
  }).categoryPresets.find((preset) => preset.id === oldBase.id)!;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.version, '1.1.0');
  assert.equal(disabled.outputRules, baseSheet.outputRules);
  for (const edited of [
    { ...oldBase, name: '用户重命名设定板' },
    { ...oldBase, description: '用户自定义描述' },
    { ...oldBase, systemPrompt: `${oldBase.systemPrompt}\nCUSTOM_RULE_SENTINEL` },
    { ...oldBase, outputRules: `${oldBase.outputRules}\nCUSTOM_LAYOUT_SENTINEL` },
    { ...oldBase, negativePrompt: 'CUSTOM_NEGATIVE_SENTINEL' },
    { ...oldBase, version: 'user-version' },
    { ...oldBase, updatedAt: 123 },
  ]) {
    const editedMigrated = migrateImagePromptRulesState({ ...legacy,
      categoryPresets: legacy.categoryPresets.map((preset) => preset.id === oldBase.id ? edited : preset),
    }).categoryPresets.find((preset) => preset.id === oldBase.id);
    assert.deepEqual(editedMigrated, edited, 'edited factory-ID records stay byte-for-byte unchanged');
  }
  const deleted = migrateImagePromptRulesState({ ...legacy,
    categoryPresets: legacy.categoryPresets.filter((preset) => preset.id !== oldBase.id),
  });
  assert.equal(deleted.categoryPresets.some((preset) => preset.id === oldBase.id), false);
  const future = { ...legacy, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION + 5 };
  assert.deepEqual(migrateImagePromptRulesState(future), future);
});

test('built-ins expose provider and visual rule sets with every required category binding', () => {
  const names = BUILT_IN_IMAGE_PROMPT_RULE_SETS.map((item) => item.name).join('\n');
  for (const requiredName of [
    '通用',
    'OpenAI',
    'GPT Image',
    'GPT Image 2.5',
    '微 NSFW',
    'Krea-2',
    'NAI V4',
    'SD WebUI',
    'ComfyUI',
    'NovelAI',
    '写实',
    '二次元',
    '国风',
    '特摄',
  ]) {
    assert.match(names, new RegExp(requiredName, 'u'), `missing built-in rule set: ${requiredName}`);
  }

  assert.deepEqual(
    new Set(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.map((item) => item.assetKind)),
    new Set(requiredAssetKinds),
  );
  const presetIds = new Set(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.map((item) => item.id));
  BUILT_IN_IMAGE_PROMPT_RULE_SETS.forEach((ruleSet) => {
    requiredAssetKinds.forEach((assetKind) => {
      const presetId = ruleSet.defaultPresetByAssetKind[assetKind];
      assert.ok(presetId, `${ruleSet.name} does not bind ${assetKind}`);
      assert.ok(presetIds.has(presetId), `${ruleSet.name} binds missing preset ${presetId}`);
    });
  });
});

test('every image asset category offers cinematic, anime, Chinese-art and tokusatsu presets', () => {
  for (const assetKind of requiredAssetKinds) {
    const names = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
      .filter((item) => item.assetKind === assetKind)
      .map((item) => item.name)
      .join('\n');
    for (const theme of ['电影写实', '二次元', '国风', '特摄']) {
      assert.match(names, new RegExp(theme, 'u'), `${assetKind} missing ${theme} preset`);
    }
  }
});

test('eight NAI-specific categories use the native tag/character-caption protocol without changing private rules', () => {
  assert.equal(novelAiPresetIds.length, 8);
  assert.equal(new Set(novelAiPresetIds).size, 8);
  const presets = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => novelAiPresetIds.includes(preset.id));
  assert.equal(presets.length, 8);
  assert.deepEqual(new Set(presets.map((preset) => preset.assetKind)),
    new Set(['character', 'character-sheet', 'location', 'prop', 'storyboard', 'grid']));
  for (const preset of presets) {
    assert.equal(preset.format, 'nai-tags');
    assert.equal(preset.enabled, true);
    assert.match(preset.name, /NovelAI \/ NAI/u);
    assert.match(preset.outputRules, /base tags \| character 1 tags/u);
    assert.match(preset.outputRules, /char_captions/u);
    assert.match(preset.outputRules, /没有出镜人物时只输出基础段/u);
    assert.doesNotMatch(preset.systemPrompt, /penis|vulva|genital|性交|阴茎|阴道|安全政策|年龄门禁/iu,
      'new categories are technical prompt presets, not new sexual-content or provider-policy instructions');
    assert.equal(preset.systemPrompt.includes(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE), false);
    assert.doesNotMatch(preset.outputRules, /格式为[^。]*BREAK|只输出一段自然语言|只输出英文 sd-tags/u);
  }
  const rule = BUILT_IN_IMAGE_PROMPT_RULE_SETS.find((item) => item.id === 'image-rule-novelai')!;
  for (const id of novelAiPresetIds) assert.ok(rule.categoryPresetIds.includes(id));
  assert.equal(rule.defaultPresetByAssetKind['character-private'], 'image-preset-character-private',
    'the existing private-category behavior must not be replaced by this technical catalog update');
  assert.match(presets.find((preset) => preset.id === NOVELAI_IMAGE_PRESET_IDS.grid)!.description, /不承诺/u);
  assert.match(presets.find((preset) => preset.id === NOVELAI_IMAGE_PRESET_IDS.multiStoryboard)!.systemPrompt,
    /不使用 ComfyUI 区域 conditioning/u, 'NAI character captions must not be advertised as regional workflow control');
});

test('fresh NAI selection defaults to native categories and supports per-character multi-person captions', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const defaults: Partial<Record<ImagePromptAssetKind, string>> = {
    character: NOVELAI_IMAGE_PRESET_IDS.character,
    'character-sheet': NOVELAI_IMAGE_PRESET_IDS.characterSheet,
    location: NOVELAI_IMAGE_PRESET_IDS.location,
    prop: NOVELAI_IMAGE_PRESET_IDS.prop,
    storyboard: NOVELAI_IMAGE_PRESET_IDS.storyboard,
    grid: NOVELAI_IMAGE_PRESET_IDS.grid,
  };
  for (const [assetKind, presetId] of Object.entries(defaults)) {
    const selected = resolveImagePromptSelection({ backend: 'novelai', assetKind: assetKind as ImagePromptAssetKind, state });
    assert.equal(selected.preset.id, presetId);
    assert.equal(selected.presetSource, 'rule-default');
    assert.equal(selected.ruleSet.format, 'nai-tags');
    assert.equal(selected.preset.format, 'nai-tags');
  }
  for (const [assetKind, presetId] of [
    ['character', NOVELAI_IMAGE_PRESET_IDS.multiCharacter], ['storyboard', NOVELAI_IMAGE_PRESET_IDS.multiStoryboard],
  ] as const) {
    const selected = resolveImagePromptSelection({ backend: 'novelai', assetKind, manualPresetId: presetId, state });
    const prompt = buildImagePromptConverterSystemPrompt(selected);
    assert.equal(selected.presetSource, 'manual');
    assert.match(prompt, /输出格式 nai-tags/u);
    assert.match(prompt, /char_captions/u);
    assert.doesNotMatch(prompt, /输出格式 sd-tags：/u);
    assert.equal(sanitizeFinalImagePrompt('masterpiece, outdoors | 1girl, blue coat, on left | 1boy, red coat, on right', 'nai-tags'),
      'masterpiece, outdoors | 1girl, blue coat, on left | 1boy, red coat, on right');
  }
});

test('explicit NAI/Krea/Comfy category protocol conflicts fail clearly instead of mixing contracts', () => {
  const state = normalizeImagePromptRulesState(undefined);
  for (const presetId of ['image-preset-krea-2-multi-person-character', 'image-preset-comfyui-multi-person-character']) {
    assert.throws(() => resolveImagePromptSelection({ backend: 'novelai', assetKind: 'character', manualPresetId: presetId, state }),
      /分类预设.*格式.*nai-tags.*不兼容/u);
  }
  assert.throws(() => resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'character', manualPresetId: NOVELAI_IMAGE_PRESET_IDS.multiCharacter, state,
  }), /分类预设.*nai-tags.*sd-tags.*不兼容/u);
  const manualNaiRule = resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'character', manualRuleSetId: 'image-rule-novelai',
    manualPresetId: NOVELAI_IMAGE_PRESET_IDS.multiCharacter, state,
  });
  assert.equal(manualNaiRule.backend, 'comfyui', 'format compatibility must not rewrite the selected transport backend');
  assert.equal(manualNaiRule.ruleSet.format, 'nai-tags');
  assert.equal(manualNaiRule.preset.id, NOVELAI_IMAGE_PRESET_IDS.multiCharacter);
});

test('GPT Image 2.5 dedicated categories stay available to natural-language rules but not NAI', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const nai = state.ruleSets.find((rule) => rule.id === 'image-rule-novelai')!;
  const openai = state.ruleSets.find((rule) => rule.id === 'image-rule-openai-gpt-image')!;
  for (const [kind, id] of [
    ['character', 'image-preset-gpt-image-2-5-micro-nsfw-character'],
    ['storyboard', 'image-preset-gpt-image-2-5-micro-nsfw-storyboard'],
  ] as const) {
    const preset = state.categoryPresets.find((item) => item.id === id)!;
    assert.equal(preset.format, 'natural-language');
    assert.equal(isImagePromptPresetCompatibleWithRule(preset, nai), false);
    assert.equal(isImagePromptPresetCompatibleWithRule(preset, openai), true);
    assert.throws(() => resolveImagePromptSelection({ backend: 'novelai', assetKind: kind, manualPresetId: id, state }),
      /分类预设.*natural-language.*nai-tags.*不兼容/u);
    assert.equal(resolveImagePromptSelection({ backend: 'openai', assetKind: kind, manualPresetId: id, state }).preset.id, id);
    const { format: _format, ...legacy } = preset;
    assert.equal(getImagePromptCategoryPresetFormat(legacy), 'natural-language',
      'unchanged pre-metadata GPT presets retain their natural-language protocol');
    assert.equal(isImagePromptPresetCompatibleWithRule(legacy, nai), false);
    const edited = { ...legacy, systemPrompt: '用户改写的通用画面规则，按当前所选输出协议整理。' };
    assert.equal(getImagePromptCategoryPresetFormat(edited), undefined);
    assert.equal(isImagePromptPresetCompatibleWithRule(edited, nai), true,
      'an old customized preset must not be restricted solely because it retained a built-in ID');
  }
});

test('automatic category fallback skips declared conflicts without mutating stored default selections', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const rule = state.ruleSets.find((item) => item.id === 'image-rule-novelai')!;
  rule.defaultPresetByAssetKind.character = 'image-preset-krea-2-multi-person-character';
  rule.categoryPresetIds = ['image-preset-krea-2-multi-person-character', NOVELAI_IMAGE_PRESET_IDS.multiCharacter];
  const before = structuredClone(state);
  const selected = resolveImagePromptSelection({ backend: 'novelai', assetKind: 'character', state });
  assert.equal(selected.preset.id, NOVELAI_IMAGE_PRESET_IDS.multiCharacter);
  assert.equal(selected.presetSource, 'compatible-first');
  assert.deepEqual(state, before, 'selection may skip an incompatible default but cannot overwrite the user’s saved choice');
  state.categoryPresets = state.categoryPresets.filter((preset) => preset.assetKind !== 'character'
    || preset.id === 'image-preset-krea-2-multi-person-character');
  assert.throws(() => resolveImagePromptSelection({ backend: 'novelai', assetKind: 'character', state }), /没有找到/u,
    'an incompatible category cannot be used merely because it is the last enabled item');
});

test('protocol inference recognizes untouched legacy built-ins without restricting portable or custom presets', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const naiRule = state.ruleSets.find((rule) => rule.id === 'image-rule-novelai')!;
  const krea = state.categoryPresets.find((preset) => preset.id === 'image-preset-krea-2-multi-person-character')!;
  const { format: _format, ...legacy } = krea;
  assert.equal(getImagePromptCategoryPresetFormat(legacy), 'natural-language');
  assert.equal(isImagePromptPresetCompatibleWithRule(legacy, naiRule), false);
  const edited = { ...legacy, name: '用户自定义分类', outputRules: '使用当前所选规则的输出格式。' };
  assert.equal(getImagePromptCategoryPresetFormat(edited), undefined, 'edited old built-in text is no longer a reliable protocol declaration');
  assert.equal(isImagePromptPresetCompatibleWithRule(edited, naiRule), true);
  const generic = state.categoryPresets.find((preset) => preset.id === 'image-preset-character')!;
  assert.equal(isImagePromptPresetCompatibleWithRule(generic, naiRule), true);
  const custom = { ...generic, id: 'user-portable-character', name: '用户通用分类', enabled: true };
  state.categoryPresets.push(custom);
  assert.equal(resolveImagePromptSelection({ backend: 'novelai', assetKind: 'character', manualPresetId: custom.id, state }).preset.id, custom.id);
  assert.equal(normalizeImagePromptCategoryPreset({ ...custom, format: 'nai-tags' })?.format, 'nai-tags');
  assert.equal(normalizeImagePromptCategoryPreset({ ...custom, format: undefined, outputFormat: 'sd-tags' })?.format, 'sd-tags');
  assert.equal(normalizeImagePromptCategoryPreset({ ...custom, format: 'not-a-format' })?.format, undefined);
});

test('private character presets reuse the positive-only 墨色江湖 dossier rule without contaminating normal character presets', () => {
  assert.equal(IMAGE_PROMPT_RULE_CATALOG_VERSION, 16);
  assert.doesNotMatch(
    MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE,
    /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b|安全政策|safety policy|permitted/iu,
    'the image-specific NSFW guidance must not add a duplicate age or provider-policy gate',
  );
  const privatePresets = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
    .filter((preset) => preset.assetKind === 'character-private');
  assert.ok(privatePresets.length > 0, 'the private character category needs its own presets');
  for (const preset of privatePresets) {
    assert.equal(
      preset.systemPrompt.split(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE).length - 1,
      1,
      `${preset.name} must reuse the single positive private-image rule exactly once`,
    );
    assert.doesNotMatch(
      `${preset.description}\n${preset.systemPrompt}\n${preset.outputRules}`,
      /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b|禁止|不得|不要|严禁|负面|negative/iu,
    );
    assert.equal(preset.version, '1.5.0');
    assert.match(preset.outputRules, /当前画面规格是唯一版式合同/u,
      `${preset.name} must route by the current private target instead of expanding every layout`);
    assert.match(preset.outputRules, /单画面.*唯一完整主体.*中央轴.*两侧.*同一背景/u);
    assert.doesNotMatch(
      preset.outputRules,
      /私密全身呈现[\s\S]{0,120}私密四视图呈现[\s\S]{0,120}四合一/u,
      `${preset.name} must not mix full-body, four-view, four-in-one and close-up layout text in one output rule`,
    );
    assert.doesNotMatch(
      `${preset.systemPrompt}\n${preset.outputRules}`,
      /私密四视图|私密四合一|局部特写|未分格/u,
      `${preset.name} must not preload mutually exclusive layout names into every private request`,
    );
    assert.equal(preset.negativePrompt || '', '');
  }

  const nonPrivatePresets = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
    .filter((preset) => preset.assetKind !== 'character-private');
  for (const preset of nonPrivatePresets) {
    assert.equal(
      preset.systemPrompt.includes(MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE),
      false,
      `${preset.name} must remain free of the private NSFW rule`,
    );
    assert.equal(preset.systemPrompt.includes(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE), false);
  }

  const state = normalizeImagePromptRulesState(undefined);
  const privateSelection = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character-private',
    state,
  });
  assert.equal(privateSelection.preset.id, 'image-preset-character-private');
  assert.equal(privateSelection.preset.assetKind, 'character-private');
  assert.equal(
    buildImagePromptConverterSystemPrompt(privateSelection)
      .split(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE).length - 1,
    1,
  );

  const normalSelection = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character',
    state,
  });
  assert.equal(normalSelection.preset.id, 'image-preset-character');
  assert.equal(
    buildImagePromptConverterSystemPrompt(normalSelection)
      .includes(MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE),
    false,
  );
  assert.equal(
    buildImagePromptConverterSystemPrompt(normalSelection)
      .includes(MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE),
    false,
  );
});

test('selection prefers an enabled manual rule, then backend default, then compatible first item', () => {
  const base = normalizeImagePromptRulesState(undefined);
  const manual = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character',
    manualRuleSetId: 'image-rule-anime',
    state: base,
  });
  assert.equal(manual.ruleSet.id, 'image-rule-anime');
  assert.equal(manual.ruleSource, 'manual');

  const backendDefault = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character',
    state: base,
  });
  assert.equal(backendDefault.ruleSet.id, 'image-rule-openai-gpt-image');
  assert.equal(backendDefault.ruleSource, 'backend-default');

  const withoutDefault: ImagePromptRulesState = {
    ...base,
    ruleSets: [
      base.ruleSets.find((item) => item.id === 'image-rule-realism')!,
      base.ruleSets.find((item) => item.id === 'image-rule-openai-gpt-image')!,
    ],
    defaultRuleSetByBackend: {},
  };
  const compatibleFirst = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'location',
    state: withoutDefault,
  });
  assert.equal(compatibleFirst.ruleSet.id, 'image-rule-realism');
  assert.equal(compatibleFirst.ruleSource, 'compatible-first');
});

test('ComfyUI can manually select every enabled rule without coercing its format or replacing its backend', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const before = JSON.stringify(state);
  for (const rule of state.ruleSets.filter((item) => item.enabled)) {
    const selected = resolveImagePromptSelection({
      backend: 'comfyui',
      model: 'current-custom-workflow-model',
      assetKind: 'storyboard',
      manualRuleSetId: rule.id,
      state,
    });
    assert.equal(selected.backend, 'comfyui');
    assert.equal(selected.ruleSet.id, rule.id, 'manual cross-backend choices must never fall back to the ComfyUI rule');
    assert.equal(selected.ruleSource, 'manual');
    assert.equal(selected.ruleSet.format, rule.format);
    assert.equal(selected.preset.id, rule.defaultPresetByAssetKind.storyboard);
    const contract = buildImagePromptConverterSystemPrompt(selected);
    assert.ok(contract.includes(`目标后端：comfyui；规则集：${rule.name}`));
    assert.ok(contract.includes(`输出格式 ${rule.format}：`));
    if (rule.format === 'natural-language') {
      assert.doesNotMatch(contract, /输出格式 sd-tags：|输出格式 nai-tags：/u);
    }
  }
  assert.equal(JSON.stringify(state), before, 'rule selection must not mutate the saved library');
});

test('manual cross-backend selection outranks default and model-specific recommendations', () => {
  const state = normalizeImagePromptRulesState(undefined);
  for (const [backend, model, ruleId] of [
    ['openai', 'krea-2', 'image-rule-comfyui'],
    ['sd-webui', 'current-sd-model', 'image-rule-krea-2'],
    ['all', '', 'image-rule-novelai'],
  ] as const) {
    const selected = resolveImagePromptSelection({ backend, model, assetKind: 'character', manualRuleSetId: ruleId, state });
    assert.equal(selected.backend, backend);
    assert.equal(selected.ruleSet.id, ruleId);
    assert.equal(selected.ruleSource, 'manual');
  }
});

test('manual ComfyUI natural-language selection leaves the caller backend, model and workflow parameters untouched', () => {
  const input = {
    backend: 'comfyui' as const,
    model: 'flux-current-model',
    workflowJson: '{"sampler":{"seed":987654321,"steps":15,"cfg":4.5}}',
    assetKind: 'storyboard' as const,
    manualRuleSetId: 'image-rule-krea-2',
    state: normalizeImagePromptRulesState(undefined),
  };
  const before = JSON.stringify(input);
  const selection = resolveImagePromptSelection(input);
  assert.equal(selection.backend, input.backend);
  assert.equal(selection.ruleSet.id, 'image-rule-krea-2');
  assert.equal(selection.ruleSet.format, 'natural-language');
  assert.equal(JSON.stringify(input), before, 'selecting a rule must not switch or rewrite the caller generation configuration');
});

test('disabled or missing manual rules fail explicitly while unselected ComfyUI retains its recommended default', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const recommended = resolveImagePromptSelection({ backend: 'comfyui', assetKind: 'storyboard', state });
  assert.equal(recommended.ruleSet.id, 'image-rule-comfyui');
  assert.equal(recommended.ruleSet.format, 'sd-tags');
  assert.equal(recommended.ruleSource, 'backend-default');
  const disabledState = {
    ...state,
    ruleSets: state.ruleSets.map((rule) => ['image-rule-krea-2', 'image-rule-comfyui'].includes(rule.id)
      ? { ...rule, enabled: false }
      : rule),
  };
  assert.throws(() => resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'storyboard', manualRuleSetId: 'image-rule-krea-2', state: disabledState,
  }), /手选生图规则.*已禁用/u);
  assert.throws(() => resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'storyboard', manualRuleSetId: 'missing-rule', state,
  }), /手选生图规则.*不存在/u);
  const fallback = resolveImagePromptSelection({ backend: 'comfyui', assetKind: 'storyboard', state: disabledState });
  assert.equal(fallback.ruleSet.id, 'image-rule-generic');
  assert.equal(fallback.ruleSource, 'compatible-first');
  assert.equal(fallback.ruleSet.enabled, true);
});

test('cross-backend rule selection uses its own category binding and permits an explicit same-category override', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const basePreset = state.categoryPresets.find((preset) => preset.id === 'image-preset-storyboard')!;
  const boundPreset = { ...basePreset, id: 'custom-natural-storyboard', name: '自然语言规则专属分镜' };
  const manualPreset = { ...basePreset, id: 'manual-storyboard-category', name: '用户手选分镜分类' };
  const rule = {
    ...state.ruleSets.find((item) => item.id === 'image-rule-openai-gpt-image')!,
    id: 'custom-openai-rule-for-comfy',
    categoryPresetIds: [boundPreset.id],
    defaultPresetByAssetKind: { storyboard: boundPreset.id },
  };
  const library = {
    ...state,
    ruleSets: [...state.ruleSets, rule],
    categoryPresets: [...state.categoryPresets, boundPreset, manualPreset],
  };
  const selected = resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'storyboard', manualRuleSetId: rule.id, state: library,
  });
  assert.equal(selected.ruleSet.id, rule.id);
  assert.equal(selected.preset.id, boundPreset.id, 'category defaults must come from the selected rule, not the active backend');
  assert.equal(selected.presetSource, 'rule-default');
  assert.equal(selected.ruleSet.format, 'natural-language');
  const overridden = resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'storyboard', manualRuleSetId: rule.id, manualPresetId: manualPreset.id, state: library,
  });
  assert.equal(overridden.preset.id, manualPreset.id);
  assert.equal(overridden.presetSource, 'manual');
  assert.throws(() => resolveImagePromptSelection({
    backend: 'comfyui', assetKind: 'storyboard', manualRuleSetId: rule.id, manualPresetId: manualPreset.id,
    state: { ...library, categoryPresets: library.categoryPresets.map((preset) => preset.id === manualPreset.id ? { ...preset, enabled: false } : preset) },
  }), /分类预设.*不匹配/u);
});

test('Krea-2 resolves its own natural-language rule under the OpenAI-compatible backend', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const resolved = resolveImagePromptSelection(({
    backend: 'openai',
    model: 'krea-2',
    assetKind: 'storyboard',
    state,
  } as unknown) as Parameters<typeof resolveImagePromptSelection>[0]);
  assert.equal(resolved.ruleSet.id, 'image-rule-krea-2');
  assert.equal(resolved.ruleSet.format, 'natural-language');
  const prompt = buildImagePromptConverterSystemPrompt(resolved);
  assert.match(prompt, /Krea-2/u);
  assert.match(prompt, /自然语言|natural-language/u);
  assert.match(prompt, /参考图|style reference|moodboard/iu);
  assert.equal(resolved.ruleSet.format, 'natural-language');
});

test('Krea-2 protects single-subject framing while Krea and ComfyUI keep multi-person binding presets', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const krea = state.ruleSets.find((rule) => rule.id === 'image-rule-krea-2')!;
  assert.equal(krea.version, '1.2.0');
  assert.match(krea.description, /单主体稳定.*多人物/u);
  assert.match(krea.systemPrompt, /只有一个实际主体[\s\S]{0,160}连续背景[\s\S]{0,160}左右保留连续背景/u);
  assert.match(krea.systemPrompt, /两个或更多实际出镜主体[\s\S]{0,80}多人空间锚点/u);
  assert.match(krea.systemPrompt, /左侧|右侧|前景|后景/u);
  assert.match(krea.outputRules, /单主体画面[\s\S]{0,100}唯一完整主体居中[\s\S]{0,100}两侧为同一连续背景/u);
  assert.match(krea.outputRules, /多人同框[\s\S]{0,80}左到右|前到后/u);
  kreaMultiPersonBindingPresetIds.forEach((presetId) => {
    assert.ok(krea.categoryPresetIds.includes(presetId), `Krea rule must allow ${presetId}`);
  });

  const comfyui = state.ruleSets.find((rule) => rule.id === 'image-rule-comfyui')!;
  assert.equal(comfyui.version, '1.1.0');
  assert.equal(comfyui.format, 'sd-tags');
  assert.match(comfyui.systemPrompt, /BREAK/u);
  assert.match(comfyui.systemPrompt, /left character|right character|foreground character|background character/u);
  assert.match(comfyui.outputRules, /最多使用一个 BREAK|one man on left|one woman on right/u);
  assert.match(comfyui.negativePrompt || '', /gender swap|attribute leakage|swapped anatomy|fused bodies|extra full body/u);
  comfyuiMultiPersonBindingPresetIds.forEach((presetId) => {
    assert.ok(comfyui.categoryPresetIds.includes(presetId), `ComfyUI rule must allow ${presetId}`);
  });

  const presetsById = new Map(state.categoryPresets.map((preset) => [preset.id, preset]));
  multiPersonBindingPresetIds.forEach((presetId) => {
    const preset = presetsById.get(presetId);
    assert.ok(preset, `missing multi-person preset ${presetId}`);
    assert.equal(preset?.enabled, true);
  });
  const allNewText = multiPersonBindingPresetIds
    .map((presetId) => {
      const preset = presetsById.get(presetId)!;
      return `${preset.description}\n${preset.systemPrompt}\n${preset.outputRules}\n${preset.negativePrompt || ''}`;
    })
    .join('\n');
  assert.doesNotMatch(
    allNewText,
    /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu,
    'multi-person binding presets must not add a duplicate age gate',
  );
});

test('multi-person Krea and ComfyUI presets are selectable without changing transport formats', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const selectedKrea = resolveImagePromptSelection({
    backend: 'openai',
    model: 'krea-2',
    assetKind: 'storyboard',
    manualPresetId: 'image-preset-krea-2-multi-person-storyboard',
    state,
  });
  assert.equal(selectedKrea.ruleSet.id, 'image-rule-krea-2');
  assert.equal(selectedKrea.ruleSet.format, 'natural-language');
  assert.equal(selectedKrea.preset.id, 'image-preset-krea-2-multi-person-storyboard');
  const kreaPrompt = buildImagePromptConverterSystemPrompt(selectedKrea);
  assert.match(kreaPrompt, /Krea-2/u);
  assert.match(kreaPrompt, /多人物绑定/u);
  assert.match(kreaPrompt, /左|右|前景|后景/u);
  assert.doesNotMatch(kreaPrompt, /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu);

  const selectedComfyui = resolveImagePromptSelection({
    backend: 'comfyui',
    assetKind: 'storyboard',
    manualPresetId: 'image-preset-comfyui-multi-person-storyboard',
    state,
  });
  assert.equal(selectedComfyui.ruleSet.id, 'image-rule-comfyui');
  assert.equal(selectedComfyui.ruleSet.format, 'sd-tags');
  assert.equal(selectedComfyui.preset.id, 'image-preset-comfyui-multi-person-storyboard');
  const comfyuiPrompt = buildImagePromptConverterSystemPrompt(selectedComfyui);
  assert.match(comfyuiPrompt, /输出格式 sd-tags/u);
  assert.match(comfyuiPrompt, /最多(?:使用)?一个 BREAK|base tags, BREAK/u);
  assert.match(comfyuiPrompt, /left character|right character|one man on left|one woman on right/u);

  const selectedRegional = resolveImagePromptSelection({
    backend: 'comfyui',
    assetKind: 'storyboard',
    manualPresetId: 'image-preset-comfyui-regional-multi-person-storyboard',
    state,
  });
  assert.equal(selectedRegional.ruleSet.id, 'image-rule-comfyui');
  assert.equal(selectedRegional.preset.id, 'image-preset-comfyui-regional-multi-person-storyboard');
  assert.match(buildImagePromptConverterSystemPrompt(selectedRegional), /区域|region|Set Area/u);
});

test('GPT Image 2.5 micro NSFW rule and presets are selectable without replacing the OpenAI default', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const openAiDefault = resolveImagePromptSelection({
    backend: 'openai',
    model: 'gpt-image-2.5-flare',
    assetKind: 'character',
    state,
  });
  assert.equal(openAiDefault.ruleSet.id, 'image-rule-openai-gpt-image');
  assert.equal(openAiDefault.preset.id, 'image-preset-character');

  const selectedCharacter = resolveImagePromptSelection({
    backend: 'openai',
    model: 'gpt-image-2.5-sunburst',
    assetKind: 'character',
    manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
    state,
  });
  assert.equal(selectedCharacter.ruleSet.id, 'image-rule-openai-gpt-image-2-5-micro-nsfw');
  assert.equal(selectedCharacter.ruleSet.backend, 'openai');
  assert.equal(selectedCharacter.ruleSet.format, 'natural-language');
  assert.equal(selectedCharacter.preset.id, 'image-preset-gpt-image-2-5-micro-nsfw-character');
  const characterPrompt = buildImagePromptConverterSystemPrompt(selectedCharacter);
  assert.match(characterPrompt, /GPT Image 2\.5/u);
  assert.match(characterPrompt, /微 NSFW/u);
  assert.match(characterPrompt, /湿身|湿透/u);
  assert.match(characterPrompt, /薄衣|贴身布料|透光/u);
  assert.doesNotMatch(
    characterPrompt,
    /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu,
  );

  const selectedStoryboard = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'storyboard',
    manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
    state,
  });
  assert.equal(selectedStoryboard.preset.id, 'image-preset-gpt-image-2-5-micro-nsfw-storyboard');

  const manualPreset = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'storyboard',
    manualPresetId: 'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
    state,
  });
  assert.equal(manualPreset.ruleSet.id, 'image-rule-openai-gpt-image');
  assert.equal(manualPreset.preset.id, 'image-preset-gpt-image-2-5-micro-nsfw-storyboard');
  assert.equal(manualPreset.presetSource, 'manual');
});

test('NovelAI defaults to its NAI rule and still rejects a manually incompatible native transport format', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const resolved = resolveImagePromptSelection({
    backend: 'novelai',
    assetKind: 'storyboard',
    state: {
      ...state,
      defaultRuleSetByBackend: {
        ...state.defaultRuleSetByBackend,
        novelai: 'image-rule-generic',
      },
    },
  });
  assert.equal(resolved.ruleSet.id, 'image-rule-novelai');
  assert.equal(resolved.ruleSet.backend, 'novelai');
  assert.equal(resolved.ruleSet.format, 'nai-tags');
  assert.match(resolved.ruleSet.systemPrompt, /V4|char_captions/u);

  assert.throws(
    () => resolveImagePromptSelection({
      backend: 'novelai',
      assetKind: 'storyboard',
      manualRuleSetId: 'image-rule-generic',
      state,
    }),
    /NovelAI.*不兼容|不兼容.*NovelAI/u,
  );

  assert.throws(
    () => resolveImagePromptSelection({
      backend: 'novelai',
      assetKind: 'character',
      state: {
        ...state,
        ruleSets: state.ruleSets.filter((item) => item.backend !== 'novelai'),
        defaultRuleSetByBackend: {},
      },
    }),
    /NovelAI.*规则/u,
  );
});

test('native NovelAI accepts a manually selected NAI-format rule regardless of its recommendation label', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const custom = {
    ...state.ruleSets.find((rule) => rule.id === 'image-rule-novelai')!,
    id: 'shared-nai-format-rule',
    backend: 'all' as const,
  };
  const selected = resolveImagePromptSelection({
    backend: 'novelai', assetKind: 'character', manualRuleSetId: custom.id,
    state: { ...state, ruleSets: [...state.ruleSets, custom] },
  });
  assert.equal(selected.ruleSet.id, custom.id);
  assert.equal(selected.ruleSet.format, 'nai-tags');
  assert.equal(selected.ruleSource, 'manual');
  assert.equal(selected.backend, 'novelai');
});

test('manual category preset overrides the rule binding only when its asset category matches', () => {
  const state = normalizeImagePromptRulesState(undefined);
  const manualPreset = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character-sheet',
    manualPresetId: 'image-preset-character-sheet',
    state,
  });
  assert.equal(manualPreset.preset.id, 'image-preset-character-sheet');
  assert.equal(manualPreset.presetSource, 'manual');

  const boundPreset = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'prop',
    state,
  });
  assert.equal(boundPreset.preset.id, 'image-preset-prop');
  assert.equal(boundPreset.presetSource, 'rule-default');

  assert.throws(
    () => resolveImagePromptSelection({
      backend: 'openai',
      assetKind: 'prop',
      manualPresetId: 'image-preset-location',
      state,
    }),
    /分类.*不匹配|不匹配.*分类/u,
  );
});

test('normalizers migrate legacy aliases and retain a usable custom NAI rule', () => {
  const category = normalizeImagePromptCategoryPreset({
    id: 'legacy-sheet',
    name: '旧角色设定图',
    category: 'character_sheet',
    prompt: '锁定角色身份与四视图。',
    output: '只输出设定图提示词。',
  }, 100);
  assert.equal(category?.assetKind, 'character-sheet');
  assert.equal(category?.systemPrompt, '锁定角色身份与四视图。');

  const rule = normalizeImagePromptRuleSet({
    id: 'legacy-nai',
    name: '旧 NAI 规则',
    provider: 'nai',
    outputFormat: 'novelai-tags',
    prompt: '输出 NovelAI 标签。',
    presetIds: { character_sheet: 'legacy-sheet' },
  }, 100);
  assert.equal(rule?.backend, 'novelai');
  assert.equal(rule?.format, 'nai-tags');
  assert.equal(rule?.defaultPresetByAssetKind['character-sheet'], 'legacy-sheet');

  const privateCategory = normalizeImagePromptCategoryPreset({
    id: 'legacy-private-character',
    category: 'character_private',
    prompt: '只使用成年角色当前选中的私密档案。',
  }, 100);
  assert.equal(privateCategory?.assetKind, 'character-private');

  const migrated = migrateImagePromptRulesState({
    schemaVersion: 0,
    rules: [rule],
    presets: [category],
    defaults: { nai: 'legacy-nai' },
  });
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.defaultRuleSetByBackend.novelai, 'legacy-nai');
  assert.equal(
    resolveImagePromptSelection({
      backend: 'novelai',
      assetKind: 'character-sheet',
      state: migrated,
    }).ruleSet.id,
    'legacy-nai',
  );
});

const withoutPrivateCharacterCatalog = (state: ImagePromptRulesState): ImagePromptRulesState => ({
  ...state,
  ruleSets: state.ruleSets.map((rule) => {
    const defaultPresetByAssetKind = { ...rule.defaultPresetByAssetKind };
    delete defaultPresetByAssetKind['character-private'];
    return {
      ...rule,
      categoryPresetIds: rule.categoryPresetIds
        .filter((id) => id !== 'image-preset-character-private'),
      defaultPresetByAssetKind,
    };
  }),
  categoryPresets: state.categoryPresets
    .filter((preset) => preset.assetKind !== 'character-private'),
});

const withoutGptImage25MicroNsfwCatalog = (state: ImagePromptRulesState): ImagePromptRulesState => ({
  ...state,
  ruleSets: state.ruleSets
    .filter((rule) => rule.id !== 'image-rule-openai-gpt-image-2-5-micro-nsfw'),
  categoryPresets: state.categoryPresets
    .filter((preset) => ![
      'image-preset-gpt-image-2-5-micro-nsfw-character',
      'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
    ].includes(preset.id)),
});

const withoutMultiPersonBindingCatalog = (state: ImagePromptRulesState): ImagePromptRulesState => ({
  ...state,
  ruleSets: state.ruleSets.map((rule) => ({
    ...rule,
    categoryPresetIds: rule.categoryPresetIds
      .filter((presetId) => !multiPersonBindingPresetIds.includes(
        presetId as (typeof multiPersonBindingPresetIds)[number],
      )),
  })),
  categoryPresets: state.categoryPresets
    .filter((preset) => !multiPersonBindingPresetIds.includes(
      preset.id as (typeof multiPersonBindingPresetIds)[number],
    )),
});

const withoutNovelAiCategoryCatalog = (state: ImagePromptRulesState): ImagePromptRulesState => ({
  ...state,
  ruleSets: state.ruleSets.map((rule) => rule.id !== 'image-rule-novelai' ? rule : {
    ...rule,
    version: '1.0.0',
    categoryPresetIds: rule.categoryPresetIds.filter((id) => !novelAiPresetIds.includes(id)),
    defaultPresetByAssetKind: Object.fromEntries(Object.entries(rule.defaultPresetByAssetKind).map(([kind, id]) => [
      kind, novelAiPresetIds.includes(id) ? `image-preset-${kind}` : id,
    ])),
  }),
  categoryPresets: state.categoryPresets.filter((preset) => !novelAiPresetIds.includes(preset.id)),
});

const catalogV1ImageRuleLibrary = (): ImagePromptRulesState => {
  const state = withoutMultiPersonBindingCatalog(
    withoutGptImage25MicroNsfwCatalog(
      withoutPrivateCharacterCatalog(withoutNovelAiCategoryCatalog(withoutFiveViewModelPresets(normalizeImagePromptRulesState(undefined)))),
    ),
  );
  return {
    ...state,
    catalogVersion: 1,
    ruleSets: structuredClone(state.ruleSets),
    categoryPresets: structuredClone(state.categoryPresets),
    defaultRuleSetByBackend: { comfyui: 'image-rule-sd-webui', openai: 'image-rule-generic' },
  };
};

const legacyImageRuleLibrary = () => {
  const state = catalogV1ImageRuleLibrary();
  return {
    schemaVersion: 1,
    ruleSets: structuredClone(state.ruleSets.filter((rule) => rule.id !== 'image-rule-krea-2')),
    categoryPresets: structuredClone(state.categoryPresets),
    defaultRuleSetByBackend: { comfyui: 'image-rule-sd-webui', openai: 'image-rule-generic' },
  };
};

test('catalog six gains NAI choices once while preserving existing default, disabled, renamed and colliding user records', () => {
  const state = withoutNovelAiCategoryCatalog(normalizeImagePromptRulesState(undefined));
  state.catalogVersion = 6;
  const nai = state.ruleSets.find((rule) => rule.id === 'image-rule-novelai')!;
  nai.name = '我的 NAI 规则名称';
  nai.enabled = false;
  nai.updatedAt = 12345;
  nai.defaultPresetByAssetKind.character = 'user-chosen-character';
  nai.categoryPresetIds.push('user-chosen-character');
  state.defaultRuleSetByBackend.novelai = 'user-chosen-rule';
  const collision = {
    ...state.categoryPresets.find((preset) => preset.id === 'image-preset-prop')!,
    id: NOVELAI_IMAGE_PRESET_IDS.prop, name: '用户原有同ID分类', systemPrompt: '保留用户写的器物说明。', enabled: false, updatedAt: 8765,
  };
  state.categoryPresets.push(collision);
  const before = structuredClone(state);
  const after = migrateImagePromptRulesState(state);
  assert.equal(after.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.deepEqual(after.defaultRuleSetByBackend, before.defaultRuleSetByBackend);
  assert.deepEqual(after.ruleSets.find((rule) => rule.id === nai.id), {
    ...nai, categoryPresetIds: [...new Set([...nai.categoryPresetIds, ...novelAiPresetIds])],
  }, 'only optional preset IDs are appended; rule text, enabled state and existing defaults are unchanged');
  assert.deepEqual(after.categoryPresets.slice(0, before.categoryPresets.length), before.categoryPresets);
  assert.deepEqual(after.categoryPresets.find((preset) => preset.id === collision.id), collision);
  for (const id of novelAiPresetIds) assert.equal(after.categoryPresets.filter((preset) => preset.id === id).length, 1);
  assert.deepEqual(state, before);
  assert.deepEqual(migrateImagePromptRulesState(after), after);
});

test('NAI catalog upgrades preserve edited rule bodies, deleted rules and custom-only libraries', () => {
  const legacy = { ...withoutNovelAiCategoryCatalog(normalizeImagePromptRulesState(undefined)), catalogVersion: 6 };
  const nai = legacy.ruleSets.find((rule) => rule.id === 'image-rule-novelai')!;
  nai.systemPrompt = '这是用户改写的 NAI 规则，不要覆盖。';
  nai.updatedAt = 1000;
  const before = structuredClone(nai);
  const after = migrateImagePromptRulesState(legacy);
  assert.deepEqual(after.ruleSets.find((rule) => rule.id === nai.id), before,
    'customized rule bodies and bindings must not be rewritten during the catalog addition');
  assert.ok(after.categoryPresets.some((preset) => preset.id === NOVELAI_IMAGE_PRESET_IDS.multiCharacter));
  const deleted = { ...legacy, ruleSets: legacy.ruleSets.filter((rule) => rule.id !== 'image-rule-novelai') };
  const afterDelete = migrateImagePromptRulesState(deleted);
  assert.equal(afterDelete.ruleSets.some((rule) => rule.id === 'image-rule-novelai'), false);
  assert.equal(afterDelete.categoryPresets.some((preset) => novelAiPresetIds.includes(preset.id)), false);
  for (const ruleSets of [[], [{ ...nai, id: 'user-only-nai' }]]) {
    const input = { schemaVersion: 1, catalogVersion: 6, ruleSets, categoryPresets: [], defaultRuleSetByBackend: {} };
    assert.deepEqual(migrateImagePromptRulesState(input), { ...input, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION });
  }
});

test('NAI categories deleted or disabled after the new catalog stay that way after reload', () => {
  const state = normalizeImagePromptRulesState(undefined);
  state.categoryPresets = state.categoryPresets.filter((preset) => preset.id !== NOVELAI_IMAGE_PRESET_IDS.multiCharacter)
    .map((preset) => preset.id === NOVELAI_IMAGE_PRESET_IDS.location ? { ...preset, enabled: false } : preset);
  state.ruleSets = state.ruleSets.map((rule) => ({ ...rule,
    categoryPresetIds: rule.categoryPresetIds.filter((id) => id !== NOVELAI_IMAGE_PRESET_IDS.multiCharacter),
  }));
  const before = structuredClone(state);
  const reloaded = migrateImagePromptRulesState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reloaded, before);
  assert.throws(() => resolveImagePromptSelection({ backend: 'novelai', assetKind: 'character', manualPresetId: NOVELAI_IMAGE_PRESET_IDS.multiCharacter, state: reloaded }), /不存在/u);
  assert.throws(() => resolveImagePromptSelection({ backend: 'novelai', assetKind: 'location', manualPresetId: NOVELAI_IMAGE_PRESET_IDS.location, state: reloaded }), /不匹配/u);
  const future = { ...withoutNovelAiCategoryCatalog(state), catalogVersion: 99 };
  assert.deepEqual(migrateImagePromptRulesState(future), future, 'future catalogs must not be downgraded or repopulated');
});

test('legacy nine-rule libraries gain Krea and the private character catalog once while preserving edits and defaults', () => {
  const legacy = legacyImageRuleLibrary();
  legacy.ruleSets[0].name = '用户改名的通用规则';
  legacy.ruleSets[0].systemPrompt = '保留用户完整规则正文。';
  legacy.ruleSets[0].enabled = false;
  const before = structuredClone(legacy);
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.ruleSets.length, 11);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  for (const beforeRule of before.ruleSets) {
    const afterRule = migrated.ruleSets.find((rule) => rule.id === beforeRule.id)!;
    const expectedAddedPresetIds = beforeRule.id === 'image-rule-comfyui'
      ? ['image-preset-character-private', ...comfyuiMultiPersonBindingPresetIds]
      : ['image-preset-character-private', ...(beforeRule.id === 'image-rule-novelai' ? novelAiPresetIds : []),
          ...(beforeRule.id === 'image-rule-openai-gpt-image' ? fiveViewPresetIds : [])];
    assert.deepEqual(afterRule, {
      ...beforeRule,
      categoryPresetIds: [...beforeRule.categoryPresetIds, ...expectedAddedPresetIds],
      defaultPresetByAssetKind: {
        ...beforeRule.defaultPresetByAssetKind,
        'character-private': 'image-preset-character-private',
      },
    }, `migration rewrote user fields on ${beforeRule.id}`);
  }
  assert.deepEqual(
    migrated.categoryPresets.slice(0, before.categoryPresets.length),
    before.categoryPresets,
  );
  assert.deepEqual(
    migrated.categoryPresets.slice(before.categoryPresets.length),
    [
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => kreaMultiPersonBindingPresetIds.includes(
        preset.id as (typeof kreaMultiPersonBindingPresetIds)[number],
      )),
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => preset.assetKind === 'character-private'),
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => [
        'image-preset-gpt-image-2-5-micro-nsfw-character',
        'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
      ].includes(preset.id)),
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => comfyuiMultiPersonBindingPresetIds.includes(
        preset.id as (typeof comfyuiMultiPersonBindingPresetIds)[number],
      )),
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => novelAiPresetIds.includes(preset.id)),
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.filter((preset) => fiveViewPresetIds.includes(preset.id)),
    ],
  );
  assert.deepEqual(migrated.defaultRuleSetByBackend, before.defaultRuleSetByBackend);
  assert.deepEqual(legacy, before, 'the migration must not mutate its input');
  const krea = migrated.ruleSets.find((rule) => rule.id === 'image-rule-krea-2')!;
  assert.equal(krea.name, 'Krea-2 自然语言生图规则');
  assert.equal(krea.format, 'natural-language');
  assert.equal(krea.enabled, true);
  const microNsfw = migrated.ruleSets.find((rule) => rule.id === 'image-rule-openai-gpt-image-2-5-micro-nsfw')!;
  assert.equal(microNsfw.name, 'GPT Image 2.5 微 NSFW 生图规则');
  assert.equal(microNsfw.format, 'natural-language');
  assert.equal(microNsfw.defaultPresetByAssetKind.character, 'image-preset-gpt-image-2-5-micro-nsfw-character');
  assert.equal(microNsfw.defaultPresetByAssetKind.storyboard, 'image-preset-gpt-image-2-5-micro-nsfw-storyboard');
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated, 'migration must be idempotent');
});

test('normalization does not falsely stamp a legacy catalog as already upgraded', () => {
  const normalized = normalizeImagePromptRulesState(legacyImageRuleLibrary());
  assert.equal(normalized.catalogVersion, 0);
  assert.equal(normalized.ruleSets.length, 9);
  assert.equal(migrateImagePromptRulesState(normalized).ruleSets.length, 11);
});

test('catalog-v1 libraries gain private presets and bindings without duplicating Krea or replacing user data', () => {
  const catalogV1 = catalogV1ImageRuleLibrary();
  catalogV1.ruleSets[0].name = '用户保留的 v1 规则名';
  catalogV1.ruleSets[0].defaultPresetByAssetKind['character-private'] = 'user-private-preset';
  catalogV1.categoryPresets.push({
    ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((preset) => (
      preset.id === 'image-preset-character-private'
    ))!,
    id: 'user-private-preset',
    name: '用户私密预设',
  });
  const before = structuredClone(catalogV1);
  const migrated = migrateImagePromptRulesState(catalogV1);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.equal(
    migrated.ruleSets.filter((rule) => rule.id === 'image-rule-krea-2').length,
    1,
  );
  assert.equal(migrated.ruleSets[0].name, '用户保留的 v1 规则名');
  assert.equal(
    migrated.ruleSets[0].defaultPresetByAssetKind['character-private'],
    'user-private-preset',
    'an explicit private default must not be overwritten',
  );
  assert.ok(migrated.ruleSets[0].categoryPresetIds.includes('image-preset-character-private'));
  assert.equal(
    migrated.categoryPresets.filter((preset) => preset.id === 'user-private-preset').length,
    1,
  );
  assert.deepEqual(catalogV1, before, 'catalog-v1 migration must not mutate its input');
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v2 built-in private presets migrate to positive-only prompts while preserving enabled state', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const legacy = {
    ...current,
    catalogVersion: 2,
    categoryPresets: current.categoryPresets.map((preset) => (
      preset.assetKind === 'character-private'
        ? {
            ...preset,
            description: '为明确成年角色生成私密资料图。',
            systemPrompt: MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE,
            outputRules: '只生成一个已明确为 18 岁以上的成年主体。',
            negativePrompt: 'minor, child, teen, default outfit',
            enabled: preset.id === 'image-preset-character-private' ? false : preset.enabled,
          }
        : preset
    )),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  const expectedById = new Map(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
    .filter((preset) => preset.assetKind === 'character-private')
    .map((preset) => [preset.id, preset]));
  migrated.categoryPresets
    .filter((preset) => preset.assetKind === 'character-private')
    .forEach((preset) => {
      const expected = expectedById.get(preset.id)!;
      assert.equal(preset.systemPrompt, expected.systemPrompt);
      assert.equal(preset.outputRules, expected.outputRules);
      assert.equal(preset.negativePrompt || '', '');
    });
  assert.equal(
    migrated.categoryPresets.find((preset) => preset.id === 'image-preset-character-private')?.enabled,
    false,
  );
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v3 built-in private presets migrate to current-target private layout', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const legacy = {
    ...current,
    catalogVersion: 3,
    categoryPresets: current.categoryPresets.map((preset) => (
      preset.assetKind === 'character-private'
        ? {
            ...preset,
            version: '1.1.0',
            outputRules: '画面采用一个主体和一个静止资料时刻；四合一呈现全身与三个私密部位的 2×2 资料板。',
            enabled: preset.id === 'image-preset-character-private' ? false : preset.enabled,
          }
        : preset
    )),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  const expectedById = new Map(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
    .filter((preset) => preset.assetKind === 'character-private')
    .map((preset) => [preset.id, preset]));
  migrated.categoryPresets
    .filter((preset) => preset.assetKind === 'character-private')
    .forEach((preset) => {
      const expected = expectedById.get(preset.id)!;
      assert.equal(preset.version, '1.5.0');
      assert.equal(preset.systemPrompt, expected.systemPrompt);
      assert.equal(preset.outputRules, expected.outputRules);
      assert.match(preset.outputRules, /当前画面规格是唯一版式合同/u);
      assert.doesNotMatch(preset.outputRules, /四合一以私密全身为最大主画面[\s\S]*较小辅助窗/u);
    });
  assert.equal(
    migrated.categoryPresets.find((preset) => preset.id === 'image-preset-character-private')?.enabled,
    false,
  );
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v7 built-in private presets migrate away from mixed layout wording', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const legacy = {
    ...current,
    catalogVersion: 7,
    categoryPresets: current.categoryPresets.map((preset) => (
      preset.assetKind === 'character-private'
        ? {
            ...preset,
            version: '1.2.0',
            outputRules: '画面采用一个主体和一个静止资料时刻。私密全身呈现完整主体构图，私密四视图呈现同一主体正面、侧面、背面和三分之四设定板，四合一以私密全身为最大主画面，三个私密局部作为较小辅助窗。',
            enabled: preset.id === 'image-preset-character-private' ? false : preset.enabled,
          }
        : preset
    )),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  migrated.categoryPresets
    .filter((preset) => preset.assetKind === 'character-private')
    .forEach((preset) => {
      assert.equal(preset.version, '1.5.0');
      assert.match(preset.outputRules, /当前画面规格是唯一版式合同/u);
      assert.doesNotMatch(preset.outputRules, /私密全身呈现[\s\S]{0,120}私密四视图呈现[\s\S]{0,120}四合一/u);
    });
  assert.equal(
    migrated.categoryPresets.find((preset) => preset.id === 'image-preset-character-private')?.enabled,
    false,
  );
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v8 private presets migrate away from single-image self-trigger wording', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const legacy = {
    ...current,
    catalogVersion: 8,
    categoryPresets: current.categoryPresets.map((preset) => (
      preset.assetKind === 'character-private'
        ? {
            ...preset,
            version: '1.3.0',
            outputRules: '画面采用当前输入目标对应的唯一版式。当前目标为单画面时保持一个未分格画面和唯一主体；当前目标为资料板时按输入资料组织。',
            enabled: preset.id === 'image-preset-character-private' ? false : preset.enabled,
          }
        : preset
    )),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  migrated.categoryPresets
    .filter((preset) => preset.assetKind === 'character-private')
    .forEach((preset) => {
      assert.equal(preset.version, '1.5.0');
      assert.match(preset.outputRules, /当前画面规格是唯一版式合同/u);
      assert.doesNotMatch(preset.outputRules, /未分格|当前目标为资料板/u);
    });
  assert.equal(
    migrated.categoryPresets.find((preset) => preset.id === 'image-preset-character-private')?.enabled,
    false,
  );
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('catalog-v9 upgrades untouched Krea and private presets to single-subject framing while preserving enabled state', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const legacy = {
    ...current,
    catalogVersion: 9,
    ruleSets: current.ruleSets.map((rule) => rule.id === 'image-rule-krea-2'
      ? {
          ...rule,
          version: '1.1.0',
          description: '面向 Krea-2 探索式生成、风格参考、Moodboard 和多人物同框的自然语言描述。',
          systemPrompt: '允许模型在不改变核心主体与剧情事实的前提下探索视觉方向。参考图或风格参考存在时保持身份。',
          outputRules: '输出自然语言画面描述。',
        }
      : rule),
    categoryPresets: current.categoryPresets.map((preset) => preset.assetKind === 'character-private'
      ? {
          ...preset,
          version: '1.4.0',
          outputRules: '输入资料末尾的当前画面规格是唯一版式合同。',
          enabled: preset.id === 'image-preset-character-private' ? false : preset.enabled,
        }
      : preset),
  };
  const migrated = migrateImagePromptRulesState(legacy);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  const krea = migrated.ruleSets.find((rule) => rule.id === 'image-rule-krea-2')!;
  assert.equal(krea.version, '1.2.0');
  assert.match(krea.systemPrompt, /只有一个实际主体.*连续背景/u);
  migrated.categoryPresets.filter((preset) => preset.assetKind === 'character-private').forEach((preset) => {
    assert.equal(preset.version, '1.5.0');
    assert.match(preset.outputRules, /唯一完整主体.*中央轴.*两侧.*同一背景/u);
  });
  assert.equal(migrated.categoryPresets.find((preset) => preset.id === 'image-preset-character-private')?.enabled, false);
  assert.deepEqual(migrateImagePromptRulesState(migrated), migrated);
});

test('existing custom or disabled Krea rules are not replaced or enabled by catalog migration', () => {
  const current = normalizeImagePromptRulesState(undefined);
  const custom = { ...current.ruleSets.find((rule) => rule.id === 'image-rule-krea-2')!,
    name: '我的 Krea', systemPrompt: '我的规则正文', enabled: false, version: 'custom-8', updatedAt: 8 };
  const migrated = migrateImagePromptRulesState({ ...legacyImageRuleLibrary(), ruleSets: [custom] });
  assert.deepEqual(migrated.ruleSets, [custom]);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
});

test('catalog migration adds only missing Krea dependencies, private, GPT Image 2.5 and multi-person presets', () => {
  const legacy = legacyImageRuleLibrary();
  const existingPreset = legacy.categoryPresets.find((preset) => preset.id === 'image-preset-character')!;
  existingPreset.name = '用户角色分类';
  existingPreset.enabled = false;
  legacy.categoryPresets = legacy.categoryPresets.filter((preset) => preset.id !== 'image-preset-prop');
  const before = structuredClone(legacy.categoryPresets);
  const migrated = migrateImagePromptRulesState(legacy);
  assert.deepEqual(migrated.categoryPresets.slice(0, before.length), before);
  assert.deepEqual(
    migrated.categoryPresets.slice(before.length).map((preset) => preset.id),
    [
      'image-preset-prop',
      ...kreaMultiPersonBindingPresetIds,
      ...BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS
        .filter((preset) => preset.assetKind === 'character-private')
        .map((preset) => preset.id),
      'image-preset-gpt-image-2-5-micro-nsfw-character',
      'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
      ...comfyuiMultiPersonBindingPresetIds,
      ...novelAiPresetIds,
      ...fiveViewPresetIds,
    ],
  );
});

test('empty and custom-only libraries are not repopulated with built-ins', () => {
  for (const ruleSets of [[], [{ ...legacyImageRuleLibrary().ruleSets[0], id: 'user-custom-only' }]]) {
    const input = { schemaVersion: 1, ruleSets, categoryPresets: [], defaultRuleSetByBackend: {} };
    const migrated = migrateImagePromptRulesState(input);
    assert.deepEqual(migrated.ruleSets, ruleSets);
    assert.deepEqual(migrated.categoryPresets, []);
    assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  }
});

test('Krea, private preset, GPT Image 2.5 micro NSFW and multi-person preset deletion stays deleted after reload', () => {
  const migrated = migrateImagePromptRulesState(legacyImageRuleLibrary());
  const deleted = {
    ...migrated,
    ruleSets: migrated.ruleSets
      .filter((rule) => !['image-rule-krea-2', 'image-rule-openai-gpt-image-2-5-micro-nsfw'].includes(rule.id))
      .map((rule) => {
        const defaultPresetByAssetKind = { ...rule.defaultPresetByAssetKind };
        delete defaultPresetByAssetKind['character-private'];
        if (defaultPresetByAssetKind.character === 'image-preset-gpt-image-2-5-micro-nsfw-character') {
          defaultPresetByAssetKind.character = 'image-preset-character';
        }
        if (defaultPresetByAssetKind.storyboard === 'image-preset-gpt-image-2-5-micro-nsfw-storyboard') {
          defaultPresetByAssetKind.storyboard = 'image-preset-storyboard';
        }
        return {
          ...rule,
          categoryPresetIds: rule.categoryPresetIds
            .filter((id) => ![
              'image-preset-character-private',
              'image-preset-gpt-image-2-5-micro-nsfw-character',
              'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
              FIVE_VIEW_IMAGE_PRESET_IDS.micro,
              ...multiPersonBindingPresetIds,
            ].includes(id)),
          defaultPresetByAssetKind,
        };
      }),
    categoryPresets: migrated.categoryPresets
      .filter((preset) => (
        preset.assetKind !== 'character-private'
        && ![
          'image-preset-gpt-image-2-5-micro-nsfw-character',
          'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
          FIVE_VIEW_IMAGE_PRESET_IDS.micro,
        ].includes(preset.id)
        && !multiPersonBindingPresetIds.includes(
          preset.id as (typeof multiPersonBindingPresetIds)[number],
        )
      )),
  };
  const reloaded = migrateImagePromptRulesState(normalizeImagePromptRulesState(JSON.parse(JSON.stringify(deleted))));
  assert.equal(reloaded.ruleSets.some((rule) => rule.id === 'image-rule-krea-2'), false);
  assert.equal(reloaded.ruleSets.some((rule) => rule.id === 'image-rule-openai-gpt-image-2-5-micro-nsfw'), false);
  assert.equal(reloaded.categoryPresets.some((preset) => preset.assetKind === 'character-private'), false);
  assert.equal(reloaded.categoryPresets.some((preset) => preset.id.includes('micro-nsfw')), false);
  assert.equal(reloaded.categoryPresets.some((preset) => (multiPersonBindingPresetIds as readonly string[]).includes(preset.id)), false);
  assert.ok(reloaded.categoryPresets.some((preset) => preset.id === NOVELAI_IMAGE_PRESET_IDS.multiCharacter),
    'deleting older provider-specific presets must not erase unrelated new NAI categories');
  assert.deepEqual(reloaded, deleted);
});

test('future catalog markers are not downgraded or used to resurrect Krea or private presets', () => {
  const future = { ...legacyImageRuleLibrary(), catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION + 5 };
  const migrated = migrateImagePromptRulesState(future);
  assert.equal(migrated.catalogVersion, future.catalogVersion);
  assert.equal(migrated.ruleSets.length, 9);
  assert.equal(migrated.categoryPresets.some((preset) => preset.assetKind === 'character-private'), false);
  assert.equal(migrated.ruleSets.some((rule) => rule.id === 'image-rule-openai-gpt-image-2-5-micro-nsfw'), false);
  assert.equal(migrated.categoryPresets.some((preset) => preset.id.includes('micro-nsfw')), false);
  assert.equal(migrated.categoryPresets.some((preset) => preset.id.includes('multi-person')), false);
});

test('legacy aliases use the same one-time catalog upgrade and cloned bindings stay independent', () => {
  const legacy = legacyImageRuleLibrary();
  const builtInsBefore = structuredClone(BUILT_IN_IMAGE_PROMPT_RULE_SETS);
  const migrated = migrateImagePromptRulesState({ schemaVersion: 0, rules: legacy.ruleSets,
    presets: legacy.categoryPresets, defaults: legacy.defaultRuleSetByBackend });
  assert.equal(migrated.ruleSets.length, 11);
  assert.deepEqual(migrated.defaultRuleSetByBackend, legacy.defaultRuleSetByBackend);
  const krea = migrated.ruleSets.find((rule) => rule.id === 'image-rule-krea-2')!;
  krea.categoryPresetIds.push('user-preset');
  krea.defaultPresetByAssetKind.prop = 'user-preset';
  assert.deepEqual(BUILT_IN_IMAGE_PROMPT_RULE_SETS, builtInsBefore, 'migrated rule bindings must not mutate the built-in catalog');
});

test('converter system prompt layers the backend rule, category preset, and exact output format contract', () => {
  const selection = resolveImagePromptSelection({
    backend: 'novelai',
    assetKind: 'character',
    state: normalizeImagePromptRulesState(undefined),
  });
  const prompt = buildImagePromptConverterSystemPrompt(selection, '保留用户指定的蓝色发带。');
  assert.match(prompt, /NovelAI/u);
  assert.match(prompt, /角色参考图/u);
  assert.match(prompt, /nai-tags/u);
  assert.match(prompt, /基础段.*角色段/u);
  assert.match(prompt, /蓝色发带/u);
  assert.doesNotMatch(prompt, /undefined|null/u);
});

test('current prop scope overrides broad custom preset wording at runtime without rewriting saved styles or wardrobes', () => {
  for (const assetKind of ['character', 'character-sheet', 'storyboard'] as const) {
    const baseline = resolveImagePromptSelection({ backend: 'openai', assetKind });
    const custom = {
      ...baseline,
      ruleSet: {
        ...baseline.ruleSet,
        id: `custom-prop-rule-${assetKind}`,
        systemPrompt: '自定义电影写实风格，保留服装。CUSTOM_PROP_RULE_SENTINEL',
        outputRules: '保留全部固定道具。',
      },
      preset: {
        ...baseline.preset,
        id: `custom-prop-preset-${assetKind}`,
        systemPrompt: '修仙集市背景与青色长衣。CUSTOM_PROP_PRESET_SENTINEL',
        outputRules: '人物卡中所有固定道具都要手持。',
      },
    };
    const before = JSON.stringify(custom);
    const prompt = buildImagePromptConverterSystemPrompt(custom, 'CUSTOM_PROP_EXTRA_SENTINEL');
    for (const marker of ['CUSTOM_PROP_RULE_SENTINEL', 'CUSTOM_PROP_PRESET_SENTINEL', 'CUSTOM_PROP_EXTRA_SENTINEL']) {
      assert.ok(prompt.includes(marker), 'runtime scope must not delete custom style instructions');
      assert.ok(prompt.lastIndexOf(IMAGE_PROMPT_PROP_SCOPE_CONTRACT) > prompt.indexOf(marker),
        'the current stable-vs-transient prop boundary must remain after every custom instruction layer');
    }
    assert.equal(JSON.stringify(custom), before, 'building a prompt must not mutate saved custom rules or category presets');
    assert.match(prompt, /修仙集市背景与青色长衣/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /人物参考图、多人身份图和五视图仅继承全文明确的长期装备/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /在分镜静帧中[^\n]*仅在当前选定瞬间明确可见时描写/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /独立道具参考图不受人物身份图的携带限制/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /已经放下、交出或吃完/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /不要按“剑”或“食物”等类别一刀切/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /保留题材、世界观、背景风格、服装与真正的长期装备/u);
    assert.match(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /不强制每镜手持/u);
    assert.doesNotMatch(IMAGE_PROMPT_PROP_SCOPE_CONTRACT, /signatureProps|stateRules|scenes|JSON|props\/content\/summary/u,
      'the image-specific contract must not request the story-analysis data schema');
  }
});

test('explicit ordinary full-body requests override broad preset framing language', () => {
  const selection = resolveImagePromptSelection({
    backend: 'openai',
    model: 'gpt-image-2.5',
    assetKind: 'character',
    imageVariant: 'full-body',
    manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
  });
  const system = buildImagePromptConverterSystemPrompt(
    selection,
    ordinaryImageVariantConverterRule('full-body'),
    'full-body',
  );
  assert.match(system, /优先全身、膝上或半身构图/u, 'the source preset still documents its broad default');
  assert.ok(system.includes(IMAGE_PROMPT_FULL_BODY_LAYOUT_CONTRACT));
  assert.match(system, /当前请求明确选择普通单幅全身规格/u);
  assert.match(system, /头顶.*脚底.*完整入画/u);
  assert.match(system, /优先于预设中.*膝上或半身/u);
  assert.ok(
    system.lastIndexOf(IMAGE_PROMPT_FULL_BODY_LAYOUT_CONTRACT)
      > system.indexOf('优先全身、膝上或半身构图'),
    'the request-time full-body contract must appear after the broad preset wording',
  );
});

test('GPT Image 2.5 micro NSFW converter extra rule forces ordinary prompts to become visual micro NSFW without age gate text', () => {
  const selection = resolveImagePromptSelection({
    backend: 'openai',
    model: 'gpt-image-2.5',
    assetKind: 'character',
    imageVariant: 'full-body',
    manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
  });
  const extraRule = gptImage25MicroNsfwConverterExtraRule(selection, 'character', 'full-body');
  assert.match(extraRule, /GPT Image 2\.5 微 NSFW 生图提示词整理器/u);
  assert.match(extraRule, /<image_converter_worldbook>/u);
  assert.match(extraRule, /【system_rule】当前选择的 GPT Image 2\.5 微 NSFW 规则优先/u);
  assert.match(extraRule, /【visual_rule】最终画面至少包含环境湿润状态/u);
  assert.match(extraRule, /不得只输出普通干燥角色提示词/u);
  assert.match(extraRule, /至少写入三类/u);
  assert.match(extraRule, /雨雾|水汽|湿发|轻薄衣料|薄纱透光|贴身褶皱|水光/u);
  assert.match(extraRule, /厚重外袍|轻罗裙|湿润中衣|湿披风/u);
  assert.match(extraRule, /古风.*雨夜廊下|现代.*雨后街巷|奇幻.*湖畔水雾/u);
  assert.match(extraRule, /横向3:2全身图.*左右保留雨雾/u);
  assert.match(extraRule, /不通过放大胸胯腿.*横向拉伸/u);
  assert.match(extraRule, /衣物仍是主要遮挡层/u);
  assert.match(extraRule, /输出前自检：最终提示词已经从普通干燥画面转成微 NSFW/u);
  assert.doesNotMatch(
    extraRule,
    /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu,
    'micro NSFW converter support must not duplicate the external age gate',
  );

  const system = buildImagePromptConverterSystemPrompt(
    selection,
    [
      gptImage25MicroNsfwConverterExtraRule(selection, 'character', 'full-body'),
      ordinaryImageVariantConverterRule('full-body'),
    ].join('\n'),
    'full-body',
  );
  assert.match(system, /<image_converter_worldbook>/u);
  assert.match(system, /当前已明确选择 GPT Image 2\.5 微 NSFW/u);
  assert.match(system, /不得只输出普通干燥角色提示词/u);
  assert.match(system, /厚重外袍|轻罗裙|湿润中衣|湿披风/u);
  assert.match(system, /横向3:2画布.*连续环境和自然留白|横向3:2全身图.*左右保留雨雾/u);
  assert.match(system, /不要把“微 NSFW”字样写进最终提示词/u);
  assert.doesNotMatch(system, /18\s*岁|年龄门禁|未成年|\bminor\b|\bchild\b|\bteen\b/iu);
});

test('ordinary full-body framing includes an anti-stretch anatomy guard without leaking NSFW rules', () => {
  const contract = `${FULL_BODY_LAYOUT_RULE}\n${IMAGE_PROMPT_FULL_BODY_LAYOUT_CONTRACT}`;
  assert.match(contract, /单幅全身|完整入画/u);
  assert.match(contract, /正常透视/u);
  assert.match(contract, /横向3:2画布.*连续环境和自然留白/u);
  assert.doesNotMatch(contract, /占据画面主要区域/u);
  assert.match(contract, /比例/u);
  // A canvas can be the correct pixel size while the model still widens the
  // body. Keep this check semantic (rather than coupling to one exact
  // wording) so future copy edits retain at least one explicit anti-distortion
  // instruction.
  assert.ok(
    [/横向拉伸/u, /水平拉伸/u, /广角畸变/u, /透视畸变/u, /身体不变形/u, /轴线稳定/u, /头身比例/u]
      .some((guard) => guard.test(contract)),
    'ordinary full-body prompt must explicitly guard against horizontal/anatomical distortion',
  );
  assert.doesNotMatch(contract, /NSFW|私密部位|裸体|裸露/u,
    'ordinary full-body layout must not import private-image content rules');
  assert.match(MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE, /body proportions/u,
    'the existing NSFW visual continuity rule remains available and unchanged');
});

test('proportion contract is applied to body-bearing ordinary prompts without contaminating private or non-body prompts', () => {
  const storyboard = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'storyboard',
    state: normalizeImagePromptRulesState(undefined),
  });
  const storyboardSystem = buildImagePromptConverterSystemPrompt(storyboard);
  assert.ok(storyboardSystem.includes(IMAGE_PROMPT_PROPORTION_CONTRACT),
    'storyboard conversion has no explicit variant but still needs a body-stability contract');
  assert.match(storyboardSystem, /横向拉宽|纵向压扁|正常透视/u);

  const location = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'location',
    state: normalizeImagePromptRulesState(undefined),
  });
  assert.doesNotMatch(
    buildImagePromptConverterSystemPrompt(location),
    /普通人物生图必须保持自然人体|横向拉宽|纵向压扁/u,
    'location prompts must not receive body-specific wording',
  );

  const privateCharacter = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'character-private',
    imageVariant: 'private-full-body',
    state: normalizeImagePromptRulesState(undefined),
  });
  assert.doesNotMatch(
    buildImagePromptConverterSystemPrompt(privateCharacter, undefined, 'private-full-body'),
    /普通人物生图必须保持自然人体|横向拉宽|纵向压扁/u,
    'private prompts keep their existing NSFW/private rule path',
  );
  assert.match(privateCharacter.preset.systemPrompt, /私密|身体|资料/u);
});

test('converter keeps a code-level per-character appearance contract above weak legacy custom rules', () => {
  const baseline = resolveImagePromptSelection({
    backend: 'openai',
    assetKind: 'storyboard',
    state: normalizeImagePromptRulesState(undefined),
  });
  const weakLegacySelection = {
    ...baseline,
    ruleSet: {
      ...baseline.ruleSet,
      id: 'legacy-user-openai-rule',
      name: '旧项目自定义自然语言规则',
      systemPrompt: '把资料写成自然语言画面。',
      outputRules: '只输出最终提示词。',
      version: '1.0.0',
    },
    preset: {
      ...baseline.preset,
      id: 'legacy-user-storyboard-preset',
      name: '旧项目自定义分镜预设',
      systemPrompt: '选择当前镜头的一个静止瞬间。',
      outputRules: '不要输出制作说明。',
      version: '1.0.0',
    },
  };

  const prompt = buildImagePromptConverterSystemPrompt(weakLegacySelection);
  assert.match(
    prompt,
    /每(?:名|个)(?:实际)?出镜(?:的)?(?:人物|角色)/u,
    'the converter itself must cover every visible character even when a persisted custom rule is weak',
  );
  for (const contract of [
    /性别|雌雄/u,
    /种族|物种/u,
    /脸型|五官/u,
    /发型|发色/u,
    /体型|体态/u,
    /服装|衣着/u,
    /固定道具|随身道具/u,
    /连续性锚点|稳定锚点/u,
  ]) {
    assert.match(
      prompt,
      contract,
      `the code-level visible identity contract omitted ${contract.source}`,
    );
  }
  assert.match(
    prompt,
    /(?:(?:角色名|姓名|称谓)[\s\S]{0,100}(?:不得|不能)[\s\S]{0,60}(?:替代|代替)[\s\S]{0,40}(?:外貌|外观)|(?:不得|不能)[\s\S]{0,60}(?:只|仅)[\s\S]{0,40}(?:角色名|姓名|称谓))/u,
    'a role name such as “小师妹” must never stand in for visible identity details',
  );
  assert.match(
    prompt,
    /多(?:人|角色)[\s\S]{0,120}(?:逐人|逐名|逐角色|分别|一一)[\s\S]{0,100}(?:对应|绑定|归属)/u,
    'a multi-character frame must bind each appearance block to its own character instead of mixing identities',
  );
});

test('natural-language sanitization removes wrappers and serializes a readable character section', () => {
  assert.equal(
    sanitizeImagePromptSegment('```text\n基础：  雨夜  街道\n电影光影\n```', 'natural-language'),
    '雨夜 街道，电影光影',
  );
  assert.equal(
    serializeImagePromptSections({
      base: '雨夜街道，冷蓝逆光',
      character: '林舟穿黑色风衣，手持旧伞',
    }, 'natural-language'),
    '雨夜街道，冷蓝逆光\n角色：林舟穿黑色风衣，手持旧伞',
  );
});

test('SD tag sanitization deduplicates tags and uses BREAK between base and character sections', () => {
  assert.equal(
    sanitizeImagePromptSegment('masterpiece， cinematic lighting, masterpiece\n(low quality:1.2)', 'sd-tags'),
    'masterpiece, cinematic lighting, (low quality:1.2)',
  );
  assert.equal(
    serializeImagePromptSections({
      base: ['masterpiece', 'cinematic lighting'],
      character: ['1girl', 'black coat'],
    }, 'sd-tags'),
    'masterpiece, cinematic lighting, BREAK, 1girl, black coat',
  );
});

test('NAI tag sanitization preserves weights and serializes isolated base and character sections', () => {
  assert.equal(
    sanitizeImagePromptSegment('masterpiece, {dramatic lighting}, masterpiece, [fog]', 'nai-tags'),
    'masterpiece, {dramatic lighting}, [fog]',
  );
  assert.equal(
    serializeImagePromptSections({
      base: 'masterpiece, {dramatic lighting}',
      character: '1girl, blue ribbon, {detailed eyes}',
    }, 'nai-tags'),
    'masterpiece, {dramatic lighting} | 1girl, blue ribbon, {detailed eyes}',
  );
  assert.deepEqual(
    sanitizeImagePromptSections({
      base: 'masterpiece, masterpiece, cinematic lighting',
      character: '1girl, 1girl, blue ribbon',
    }, 'nai-tags'),
    {
      base: 'masterpiece, cinematic lighting',
      character: '1girl, blue ribbon',
    },
  );
});

test('final prompt sanitization preserves one independent NovelAI segment per character', () => {
  assert.equal(
    sanitizeFinalImagePrompt(
      '基础：masterpiece, cinematic lighting | 角色：1girl, blue ribbon | 角色：1boy, black coat',
      'nai-tags',
    ),
    'masterpiece, cinematic lighting | 1girl, blue ribbon | 1boy, black coat',
  );
  assert.equal(
    sanitizeFinalImagePrompt(
      'masterpiece, cinematic lighting | | 1girl, blue ribbon || 1boy, black coat | ',
      'nai-tags',
    ),
    'masterpiece, cinematic lighting | 1girl, blue ribbon | 1boy, black coat',
    'empty NovelAI sections are removed without merging the remaining character identities',
  );
  assert.equal(
    sanitizeFinalImagePrompt('masterpiece, cinematic lighting BREAK 1girl, blue ribbon BREAK detailed eyes', 'sd-tags'),
    'masterpiece, cinematic lighting, BREAK, 1girl, blue ribbon, detailed eyes',
  );
});

test('final prompt boundary accepts AI wording without local similarity, field-label or language judgments', () => {
  const helpers = imagePromptRuleHelpers as typeof imagePromptRuleHelpers & {
    assertValidFinalImagePrompt?: (
      value: unknown,
      format: 'natural-language' | 'sd-tags' | 'nai-tags',
      source?: string,
    ) => string;
  };
  assert.equal(
    typeof helpers.assertValidFinalImagePrompt,
    'function',
    'final image prompts need one reusable transport boundary',
  );
  assert.ok(helpers.assertValidFinalImagePrompt);
  const assertValid = helpers.assertValidFinalImagePrompt;
  const source = '林舟穿黑色风衣站在雨夜街口，蓝色霓虹映在积水中。';

  assert.equal(
    assertValid(source, 'natural-language', source),
    source,
    'matching input facts are not evidence of a local semantic error',
  );
  assert.equal(
    assertValid('林舟穿黑色风衣站在雨夜街口，蓝色霓虹映在积水中，电影感。', 'natural-language', source),
    '林舟穿黑色风衣站在雨夜街口，蓝色霓虹映在积水中，电影感。',
  );
  assert.equal(
    assertValid('角色名称：林舟，外观：黑发，动作：站在雨夜街口，电影写实', 'natural-language'),
    '角色名称：林舟，外观：黑发，动作：站在雨夜街口，电影写实',
    'the AI may deliberately retain field-style wording',
  );
  assert.equal(
    assertValid('雨夜街道, 黑发少女, cinematic lighting', 'nai-tags'),
    '雨夜街道, 黑发少女, cinematic lighting',
    'mixed-language wording is accepted by the local transport boundary',
  );
  for (const format of ['sd-tags', 'nai-tags'] as const) {
    const prose = 'The cultivator stands beside the old pine while pale evening light catches the silver embroidery on her robe.';
    assert.equal(assertValid(prose, format), prose, 'word count, punctuation and missing commas do not trigger local semantic repair');
    assert.equal(assertValid('修仙者约二十五岁，正常人类外貌', format), '修仙者约二十五岁, 正常人类外貌');
  }
  assert.equal(
    assertValid('左侧人物 | 右侧人物', 'natural-language'),
    '左侧人物 | 右侧人物',
    'natural-language separators are authored text rather than a quality error',
  );
  assert.equal(
    assertValid('```text\n林舟站在雨夜街口。\n```', 'natural-language'),
    '林舟站在雨夜街口。',
    'removable response wrappers do not trigger semantic repair',
  );
  assert.equal(
    assertValid(
      'masterpiece, cinematic lighting | 1girl, black hair, blue ribbon | 1boy, short hair, black coat',
      'nai-tags',
    ),
    'masterpiece, cinematic lighting | 1girl, black hair, blue ribbon | 1boy, short hair, black coat',
  );
  assert.equal(
    assertValid('masterpiece, cinematic lighting | | 1girl, blue ribbon | ', 'nai-tags'),
    'masterpiece, cinematic lighting | 1girl, blue ribbon',
  );
  assert.throws(
    () => assertValid('masterpiece, BREAK, cinematic lighting BREAK 1girl, blue ribbon', 'sd-tags'),
    /BREAK|分隔/u,
  );
  assert.throws(
    () => assertValid('masterpiece, cinematic lighting BREAK   ', 'sd-tags'),
    /基础段|角色段|完整/u,
  );
  assert.equal(
    assertValid('(masterpiece:1.2), [cinematic fog], BREAK, 1girl, {blue ribbon}', 'sd-tags'),
    '(masterpiece:1.2), [cinematic fog], BREAK, 1girl, {blue ribbon}',
  );
  assert.equal(
    assertValid('masterpiece, <lora:cinematic_style:0.8>, BREAK, 1girl, (blue eyes:1.15)', 'sd-tags'),
    'masterpiece, <lora:cinematic_style:0.8>, BREAK, 1girl, (blue eyes:1.15)',
  );
  assert.equal(
    assertValid('masterpiece, 2::dramatic lighting:: | 1girl, {{{blue ribbon}}}', 'nai-tags'),
    'masterpiece, 2::dramatic lighting:: | 1girl, {{{blue ribbon}}}',
  );
  assert.throws(() => assertValid('   ', 'natural-language'), /为空/u);
  assert.throws(() => assertValid('```text\n```', 'natural-language'), /为空/u);
  for (const nonText of [null, undefined, {}, ['prompt'], 123, true]) {
    assert.throws(() => assertValid(nonText, 'natural-language'), /必须是文本/u,
      'invalid payload types must not be coerced into plausible prompt text');
  }
});

let passed = 0;
for (const item of tests) {
  try {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name}`);
  } catch (error) {
    console.error(`FAIL ${item.name}`);
    throw error;
  }
}
console.log(`image prompt rules: ${passed}/${tests.length} passed`);
