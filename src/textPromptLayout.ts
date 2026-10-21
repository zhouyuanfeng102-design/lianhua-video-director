/** Request-only ordering. Never sort arrays, rewrite text, or mutate saved data. */
export function orderTextPromptData<T extends object>(value: T, sharedKeys: readonly (keyof T | string)[]): T {
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of sharedKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) ordered[String(key)] = source[String(key)];
  }
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) ordered[key] = source[key];
  }
  return ordered as T;
}

/** Preserve the semantic source schema and every value, including current scene state. */
export function orderSemanticPromptContext<T extends object>(context: T): T {
  const source = context as Record<string, unknown>;
  const understanding = source.storyUnderstandingContext;
  const copy = understanding && typeof understanding === 'object'
    ? { ...source, storyUnderstandingContext: orderTextPromptData(understanding, [
        'usage', 'sourceStoryContent', 'originalSourceContext', 'characterIdentities', 'instruction',
      ]) }
    : { ...source };
  return orderTextPromptData(copy, [
    'kind', 'sourceStoryTitle', 'sourceContentHash', 'segmentCount', 'segmentDurationSec',
    'sourceAuthority', 'creativeDirection', 'pacing', 'characterContinuity', 'shotMode', 'shotCount',
    'storyUnderstandingContext',
  ]) as T;
}
