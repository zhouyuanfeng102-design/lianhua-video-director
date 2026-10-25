import { assertValidFinalImagePrompt, type ImagePromptRuleSet } from './imagePromptRules';
import { MOSE_JIANGHU_NSFW_IMAGE_CONVERTER_RULE, MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE } from './nsfwPromptRules';
import { requestTextModel } from './services/llm';
import { IMAGE_STORY_SPATIAL_STATE_RULE } from './spatialContinuityRules';
import { withTextApiUsageContext } from './textApiUsage';
import type { CustomImageRuleSnapshot, ImageApiConfig, TextApiConfig } from './types';

const validRuleFormat = (format: unknown): format is CustomImageRuleSnapshot['format'] => (
  format === 'natural-language' || format === 'sd-tags' || format === 'nai-tags'
);

/** Explicit choices include user rules; backend labels are recommendation metadata. */
export const captureCustomImageRule = (
  ruleSets: readonly ImagePromptRuleSet[],
  ruleSetId: string,
  api: Pick<ImageApiConfig, 'backend' | 'model'>,
): CustomImageRuleSnapshot => {
  const rule = ruleSets.find((candidate) => candidate.id === ruleSetId);
  if (!rule) throw new Error('所选自定义生图规则不存在，请重新选择。');
  if (!rule.enabled) throw new Error(`生图规则“${rule.name}”已禁用，请重新选择。`);
  if (!validRuleFormat(rule.format)) throw new Error('所选生图规则的输出格式无效。');
  if (api.backend === 'novelai' && rule.format !== 'nai-tags') {
    throw new Error(`生图规则“${rule.name}”与 NovelAI 的 NAI 标签格式不兼容，请选择 nai-tags 规则。`);
  }
  if (!rule.systemPrompt.trim() && !rule.outputRules.trim()) {
    throw new Error(`生图规则“${rule.name}”没有转换内容，请补充规则或选择不转换。`);
  }
  return {
    version: 1, id: rule.id, name: rule.name, ruleVersion: rule.version,
    format: rule.format, systemPrompt: rule.systemPrompt, outputRules: rule.outputRules,
    ...(rule.negativePrompt?.trim() ? { negativePrompt: rule.negativePrompt } : {}),
  };
};

export interface CustomImagePromptInput {
  userPrompt: string;
  rule: CustomImageRuleSnapshot;
  width: number;
  height: number;
  signal?: AbortSignal;
}

/** One explicit conversion, preserving authored spatial facts without importing
 * project/category/identity data or adding an automatic fallback. */
export const requestCustomImagePrompt = async (
  apiText: TextApiConfig,
  input: CustomImagePromptInput,
): Promise<string> => {
  if (typeof input.userPrompt !== 'string' || !input.userPrompt.trim()) {
    throw new Error('请先填写自定义生图要求。');
  }
  if (!input.rule || input.rule.version !== 1 || !validRuleFormat(input.rule.format)
    || typeof input.rule.systemPrompt !== 'string' || typeof input.rule.outputRules !== 'string'
    || !input.rule.systemPrompt.trim() && !input.rule.outputRules.trim()) {
    throw new Error('本次任务的生图规则快照不完整，不能改为原文直发。');
  }
  if (![input.width, input.height].every((dimension) => Number.isSafeInteger(dimension) && dimension >= 64)) {
    throw new Error('自定义生图尺寸无效，宽和高须为至少 64 的整数像素。');
  }
  const format = {
    'natural-language': '自然语言正文',
    'sd-tags': 'Stable Diffusion 标签；分段时使用 BREAK，不使用 |',
    'nai-tags': 'NovelAI 标签；角色分段时使用 |，不使用 BREAK',
  }[input.rule.format];
  // Cache-safe layout: every fixed rule stays in the system prefix (identical
  // for ordinary/adult). The authored user requirement is the only trailing
  // variable. Image NSFW rules already say "if SFW, ignore", so they remain
  // in the fixed prefix instead of forking the first bytes by content class.
  const systemPrompt = [
    MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE,
    MOSE_JIANGHU_NSFW_IMAGE_CONVERTER_RULE,
    '你是自定义生图提示词转换器。保留用户本次要求，仅按本次明确选择的规则转换为可直接生图的最终提示词。',
    `<selected_image_rule>\n${input.rule.systemPrompt}\n${input.rule.outputRules}\n</selected_image_rule>`,
    IMAGE_STORY_SPATIAL_STATE_RULE,
    `本次输出格式：${format}。`,
    '只返回最终生图提示词文本，不要解释、代码块或 JSON。',
    `本次输出尺寸：${input.width} × ${input.height} 像素。`,
  ].filter(Boolean).join('\n');
  const converted = await requestTextModel(
    withTextApiUsageContext(apiText, {}, 'image-custom-convert'),
    systemPrompt,
    input.userPrompt,
    input.signal,
  );
  return assertValidFinalImagePrompt(converted, input.rule.format, input.userPrompt);
};
