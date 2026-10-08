import type { Storyboard } from './types';

/** Saved delivery notices are display metadata, never content eligibility checks. */
export const normalizeH3DeliveryWarnings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];

export const storyboardH3DeliveryWarnings = (
  board: Pick<Storyboard, 'h3DeliveryWarnings' | 'h3DeliveryWarningsEn'> | undefined,
  language: 'zh' | 'en' = 'zh',
): string[] => {
  const chinese = normalizeH3DeliveryWarnings(board?.h3DeliveryWarnings);
  // English is derived from this Chinese delivery; shared timeline/association
  // notices remain visible while the language of an incomplete review is clear.
  return language === 'en'
    ? normalizeH3DeliveryWarnings([
      ...chinese.map((warning) => `中文交付：${warning}`),
      ...normalizeH3DeliveryWarnings(board?.h3DeliveryWarningsEn),
    ])
    : chinese;
};
