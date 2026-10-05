import type { ImagePromptRulesState } from './imagePromptRules';
import type { ImageGenerationTask, ReferenceAsset } from './types';

type SelectionRecord = Pick<ImageGenerationTask,
  'imagePromptRuleSetId' | 'imagePromptRuleSetName' | 'imagePromptRuleSetVersion'
  | 'imagePromptPresetId' | 'imagePromptPresetName' | 'imagePromptPresetVersion'>;
type CatalogEntry = { id: string; name: string; version: string };
export interface ImageRuleLabel { text: string; title: string }

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const hasRecord = (value: SelectionRecord): boolean => Object.values(value).some((entry) => Boolean(clean(entry)));
const selectionRecord = (value: SelectionRecord): SelectionRecord => ({
  imagePromptRuleSetId: value.imagePromptRuleSetId,
  imagePromptRuleSetName: value.imagePromptRuleSetName,
  imagePromptRuleSetVersion: value.imagePromptRuleSetVersion,
  imagePromptPresetId: value.imagePromptPresetId,
  imagePromptPresetName: value.imagePromptPresetName,
  imagePromptPresetVersion: value.imagePromptPresetVersion,
});

const label = (idValue: unknown, nameValue: unknown, versionValue: unknown, catalog: readonly CatalogEntry[]): ImageRuleLabel => {
  const id = clean(idValue); const name = clean(nameValue); const version = clean(versionValue);
  if (!id && !name && !version) return { text: '未记录', title: '此任务没有保存这一项配置，不能从当前设置确定历史使用情况。' };
  const versionLabel = version ? `v${version.replace(/^v/i, '')}` : '版本未记录';
  const identity = `ID：${id || '未记录'}；版本：${version || '未记录'}`;
  if (name) return { text: `${name} · ${versionLabel}`, title: `本次任务保存的名称。${identity}` };
  // A legacy ID+version can locate a catalog entry. Make this fallback visible:
  // users may have renamed even that revision; it is not a frozen task name.
  const matches = id && version ? catalog.filter((entry) => entry.id === id && entry.version === version) : [];
  if (matches.length === 1 && clean(matches[0].name)) return {
    text: `${matches[0].name} · ${versionLabel}（名称按记录匹配）`,
    title: `旧任务未保存名称，按已记录的 ID 和版本匹配规则库名称；任务配置未改动。${identity}`,
  };
  return { text: `${id ? `ID：${id}` : '名称未记录'} · ${versionLabel}`, title: `历史名称未记录，规则可能已更新或删除。${identity}` };
};

/** Task history wins over the live catalog. Only the task's exact result asset
 * may supply a missing record; current workbench selections are never inputs. */
export const imageTaskRuleMetadata = (
  task: ImageGenerationTask,
  rules?: Pick<ImagePromptRulesState, 'ruleSets' | 'categoryPresets'>,
  resultAsset?: ReferenceAsset,
): { rule: ImageRuleLabel; preset: ImageRuleLabel } => {
  const stored = selectionRecord(task);
  const record = hasRecord(stored) ? stored
    : resultAsset && resultAsset.id === task.resultAssetId ? selectionRecord(resultAsset) : stored;
  return {
    rule: label(record.imagePromptRuleSetId, record.imagePromptRuleSetName, record.imagePromptRuleSetVersion, rules?.ruleSets ?? []),
    preset: label(record.imagePromptPresetId, record.imagePromptPresetName, record.imagePromptPresetVersion, rules?.categoryPresets ?? []),
  };
};
