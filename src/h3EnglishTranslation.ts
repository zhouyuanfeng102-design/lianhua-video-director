import {
  translateVideoPromptToEnglish,
  type TranslateVideoPromptToEnglishOptions,
} from './promptTranslation';

export type TranslateH3PromptWithinBudgetOptions = TranslateVideoPromptToEnglishOptions;

/** Legacy name kept for callers; there is no local character budget. H3 uses
 * the same whole-prompt translator and optional AI review as short stories. */
export const translateH3PromptWithinBudget = (
  options: TranslateH3PromptWithinBudgetOptions,
): Promise<string> => translateVideoPromptToEnglish(options);
