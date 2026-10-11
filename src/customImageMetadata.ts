import type { CustomImageDraft, CustomImageInput, CustomImageRuleSnapshot } from './types';
import { defaultImageOutputSize, normalizeImageOutputSizes } from './imageOutputSize';

const recordOf = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);

/** Copy only request facts; arbitrary imported fields and connection secrets never survive. */
export const normalizeCustomImageRuleSnapshot = (value: unknown): CustomImageRuleSnapshot | undefined => {
  const record = recordOf(value);
  if (!record || record.version !== 1
    || typeof record.id !== 'string' || !record.id.trim()
    || typeof record.name !== 'string' || !record.name.trim()
    || typeof record.ruleVersion !== 'string'
    || !['natural-language', 'sd-tags', 'nai-tags'].includes(String(record.format))
    || typeof record.systemPrompt !== 'string' || typeof record.outputRules !== 'string') return undefined;
  return {
    version: 1, id: record.id, name: record.name, ruleVersion: record.ruleVersion,
    format: record.format as CustomImageRuleSnapshot['format'],
    systemPrompt: record.systemPrompt, outputRules: record.outputRules,
    ...(typeof record.negativePrompt === 'string' ? { negativePrompt: record.negativePrompt } : {}),
  };
};

export const normalizeCustomImageInput = (value: unknown): CustomImageInput | undefined => {
  const record = recordOf(value);
  if (!record || record.version !== 1 || typeof record.userPrompt !== 'string'
    || (record.promptMode !== 'raw' && record.promptMode !== 'rules')) return undefined;
  const ruleSelection = normalizeCustomImageRuleSnapshot(record.ruleSelection);
  return {
    version: 1, userPrompt: record.userPrompt, promptMode: record.promptMode,
    ...(ruleSelection ? { ruleSelection } : {}),
    ...(record.operation === 'initial' || record.operation === 'saved-final' || record.operation === 'reconvert'
      ? { operation: record.operation } : {}),
  };
};

/** An absent draft stays absent. Older/partial drafts start with conversion disabled. */
export const normalizeCustomImageDraft = (value: unknown): CustomImageDraft | undefined => {
  const record = recordOf(value);
  if (!record || record.version !== 1) return undefined;
  const sizePreference = recordOf(record.sizePreference);
  return {
    version: 1, userPrompt: typeof record.userPrompt === 'string' ? record.userPrompt : '',
    referenceAssetIds: Array.isArray(record.referenceAssetIds)
      ? Array.from(new Set(record.referenceAssetIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))) : [],
    sizePreference: sizePreference
      ? normalizeImageOutputSizes({ ordinary: sizePreference }).ordinary
      : { ...defaultImageOutputSize(), aspect: '1:1' },
    promptMode: record.promptMode === 'rules' ? 'rules' : 'raw',
    ...(typeof record.ruleSetId === 'string' && record.ruleSetId.trim() ? { ruleSetId: record.ruleSetId } : {}),
  };
};
