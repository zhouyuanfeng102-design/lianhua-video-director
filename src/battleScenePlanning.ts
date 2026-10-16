/** Model-authored visual staging, kept separate from source evidence. The app
 * stores these choices; it does not infer a battle, certify facts or choose a
 * crowd size, action count, fighting style or speaking rate. */
export interface BattleSceneStaging {
  version: 1;
  sceneType?: string;
  sourceEventIds?: string[];
  /** Source constraints identified by the model, not locally certified facts. */
  factLocks?: string[];
  /** Adopted visual choices that must never be promoted to novel facts. */
  stagingChoices?: string[];
  actionGroups?: Array<{
    id: string;
    participants?: string[];
    role?: string;
    spatialLayer?: string;
    route?: string;
    objective?: string;
  }>;
  actionPhases?: Array<{
    id: string;
    sourceEventId?: string;
    groupIds?: string[];
    actor?: string;
    target?: string;
    setup?: string;
    trigger?: string;
    contact?: string;
    result?: string;
    recovery?: string;
  }>;
  dialogueBudget?: {
    strategy?: string;
    parallelToAction?: boolean;
    speechDurationSec?: number;
    actionDurationSec?: number;
    preserveDialogueIds?: string[];
  };
  entryState?: string;
  exitState?: string;
}

const record = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const stringValue = (value: unknown): string | undefined => typeof value === 'string' ? value.trim() : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
  : undefined;

const copyStrings = <Field extends string>(raw: Record<string, unknown>, fields: readonly Field[]): Partial<Record<Field, string>> => {
  const copy: Partial<Record<Field, string>> = {};
  for (const field of fields) {
    const value = stringValue(raw[field]);
    if (value !== undefined) copy[field] = value;
  }
  return copy;
};
const finiteDuration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Shape-only deep copy. Optional metadata never becomes a content acceptance
 * gate, source evidence, a local plot classifier or a legacy-data migration. */
export const normalizeBattleSceneStaging = (value: unknown): BattleSceneStaging | undefined => {
  if (!record(value) || value.version !== 1) return undefined;
  const result: BattleSceneStaging = {
    version: 1,
    ...copyStrings(value, ['sceneType', 'entryState', 'exitState']),
  };
  for (const field of ['sourceEventIds', 'factLocks', 'stagingChoices'] as const) {
    const list = strings(value[field]);
    if (list !== undefined) result[field] = list;
  }
  if (Array.isArray(value.actionGroups)) {
    result.actionGroups = value.actionGroups.flatMap((item) => {
      if (!record(item)) return [];
      const id = stringValue(item.id);
      if (!id) return [];
      const participants = strings(item.participants);
      return [{ id, ...copyStrings(item, ['role', 'spatialLayer', 'route', 'objective']),
        ...(participants !== undefined ? { participants } : {}) }];
    });
  }
  if (Array.isArray(value.actionPhases)) {
    result.actionPhases = value.actionPhases.flatMap((item) => {
      if (!record(item)) return [];
      const id = stringValue(item.id);
      if (!id) return [];
      const groupIds = strings(item.groupIds);
      return [{ id, ...copyStrings(item, ['sourceEventId', 'actor', 'target', 'setup', 'trigger', 'contact', 'result', 'recovery']),
        ...(groupIds !== undefined ? { groupIds } : {}) }];
    });
  }
  if (record(value.dialogueBudget)) {
    const budget = value.dialogueBudget;
    const preserveDialogueIds = strings(budget.preserveDialogueIds);
    result.dialogueBudget = {
      ...copyStrings(budget, ['strategy']),
      ...(typeof budget.parallelToAction === 'boolean' ? { parallelToAction: budget.parallelToAction } : {}),
      ...(finiteDuration(budget.speechDurationSec) ? { speechDurationSec: budget.speechDurationSec } : {}),
      ...(finiteDuration(budget.actionDurationSec) ? { actionDurationSec: budget.actionDurationSec } : {}),
      ...(preserveDialogueIds !== undefined ? { preserveDialogueIds } : {}),
    };
  }
  return result;
};

export const normalizeBattleSceneStagingList = (value: unknown): BattleSceneStaging[] => Array.isArray(value)
  ? value.flatMap((item) => {
    const staging = normalizeBattleSceneStaging(item);
    return staging ? [staging] : [];
  }) : [];
