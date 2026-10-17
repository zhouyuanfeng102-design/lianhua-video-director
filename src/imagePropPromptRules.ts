import { IMAGE_PROMPT_PROP_SPECIFICATION_RULE } from './imagePropSpecification';
import type { ImagePromptCategoryPreset, ImagePromptRuleSet } from './imagePromptRules';

const nextVersion = (version: string): string => {
  const [major = 1, minor = 0] = version.split('.').map(Number);
  return `${major + (minor === 9 ? 1 : 0)}.${minor === 9 ? 0 : minor + 1}.0`;
};

export const withPropImageSpecificationPreset = (preset: ImagePromptCategoryPreset): ImagePromptCategoryPreset => preset.assetKind !== 'prop' ? { ...preset } : {
  ...preset,
  systemPrompt: [preset.systemPrompt, IMAGE_PROMPT_PROP_SPECIFICATION_RULE].join('\n'),
  outputRules: preset.outputRules
    .replace('主体完整且无遮挡，背景克制，关键结构和使用痕迹清楚；不得复制多个物品或增加无关装饰文字。',
      '按当前特写或三视图规格取景；特写不强求完整轮廓，三视图逐区完整展示同一物品，关键结构和使用痕迹清楚。除三视图所需观察面外不增加物品副本、无关装饰或文字。')
    .replace('展示图、图标和局部特写按当前规格取景；完整展示只用于明确要求完整主体的画面，不把特写拉远。多角度仅在当前规格要求时出现，不重复物品、不凭空添加使用者、广告文案或标签；被遮挡部位不透视补画。',
      '特写保持当前近距离取景，不强制拉远；三视图按当前指定三区域展示同一物品，允许三个必要观察面，不增加第四视图或物品副本，不凭空添加使用者、广告文案或标签；各角度按自然遮挡呈现，不透视补画内部结构。'),
  version: nextVersion(preset.version),
};

export const withPropImageSpecificationRule = (rule: ImagePromptRuleSet): ImagePromptRuleSet => ({
  ...rule,
  categoryPresetIds: [...rule.categoryPresetIds],
  defaultPresetByAssetKind: { ...rule.defaultPresetByAssetKind },
  outputRules: [rule.outputRules, '仅当本次资产分类为独立物品时应用以下规则：', IMAGE_PROMPT_PROP_SPECIFICATION_RULE].join('\n'),
  version: nextVersion(rule.version),
});
