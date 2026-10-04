const trimTrailingActionSeparators = (value: string): string => value
  .trim()
  .replace(/[；;]+\s*$/u, '')
  .trim();

/**
 * Adds rewrite guidance without discarding any authored action stage.
 * The old UI implementation kept only the text before the first Chinese
 * semicolon, which silently removed the remainder of a detailed action chain.
 */
export const appendShotRewriteGuidance = (action: string, guidance: string): string => {
  const preservedAction = trimTrailingActionSeparators(action);
  const normalizedGuidance = trimTrailingActionSeparators(guidance);
  if (!normalizedGuidance) return preservedAction;
  if (!preservedAction) return normalizedGuidance;

  const stages = preservedAction
    .split(/[；;]/u)
    .map((stage) => stage.trim())
    .filter(Boolean);
  if (stages.includes(normalizedGuidance)) return preservedAction;

  return `${preservedAction}；${normalizedGuidance}`;
};
