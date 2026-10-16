/** Model-authored scene choices. These records carry the same world through
 * story conversion, segment allocation and photography; they do not certify
 * source facts or infer geometry from prose. */
export interface SceneStaging {
  version: 1;
  sceneId: string;
  sourceEventIds?: string[];
  worldRelations?: string[];
  participants?: Array<{
    id: string;
    name?: string;
    position?: string;
    bodyFacing?: string;
    gazeTarget?: string;
    actionTarget?: string;
  }>;
  phases?: Array<{
    id: string;
    eventId?: string;
    participantIds?: string[];
    startState?: string;
    action?: string;
    motionPath?: string;
    motionEndpoint?: string;
    endState?: string;
  }>;
  entryState?: string;
  exitState?: string;
}

const record = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const text = (value: unknown): string | undefined => typeof value === 'string' ? value.trim() : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []) : undefined;
const copyText = <Key extends string>(value: Record<string, unknown>, keys: readonly Key[]): Partial<Record<Key, string>> => {
  const result: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const item = text(value[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
};

/** Optional shape-only copy. Missing legacy metadata stays missing; references,
 * direction descriptions and model decisions are never judged or completed. */
export const normalizeSceneStaging = (value: unknown): SceneStaging | undefined => {
  if (!record(value) || value.version !== 1 || !text(value.sceneId)) return undefined;
  const result: SceneStaging = { version: 1, sceneId: text(value.sceneId)!,
    ...copyText(value, ['entryState', 'exitState']) };
  for (const key of ['sourceEventIds', 'worldRelations'] as const) {
    const items = strings(value[key]);
    if (items !== undefined) result[key] = items;
  }
  if (Array.isArray(value.participants)) result.participants = value.participants.flatMap((item) => {
    if (!record(item) || !text(item.id)) return [];
    return [{ id: text(item.id)!, ...copyText(item, ['name', 'position', 'bodyFacing', 'gazeTarget', 'actionTarget']) }];
  });
  if (Array.isArray(value.phases)) result.phases = value.phases.flatMap((item) => {
    if (!record(item) || !text(item.id)) return [];
    const participantIds = strings(item.participantIds);
    return [{ id: text(item.id)!,
      ...copyText(item, ['eventId', 'startState', 'action', 'motionPath', 'motionEndpoint', 'endState']),
      ...(participantIds !== undefined ? { participantIds } : {}) }];
  });
  return result;
};

export const normalizeSceneStagingList = (value: unknown): SceneStaging[] => Array.isArray(value)
  ? value.flatMap((item) => { const staging = normalizeSceneStaging(item); return staging ? [staging] : []; }) : [];

/** Wire description only, shared by existing source-generation requests. */
export const SCENE_STAGING_OUTPUT_SHAPE = '{version:1,sceneId:string,sourceEventIds?:string[],worldRelations?:string[],participants?:[{id:string,name?:string,position?:string,bodyFacing?:string,gazeTarget?:string,actionTarget?:string}],phases?:[{id:string,eventId?:string,participantIds?:string[],startState?:string,action?:string,motionPath?:string,motionEndpoint?:string,endState?:string}],entryState?:string,exitState?:string}';
