import type { AppSettings, AppState, Project } from './types';

export type PersistedActiveProjectReference = { id: string; __activeProjectReference: true };
export type PersistedAppState = Omit<AppState, 'projects'> & {
  schemaVersion: number;
  projects: Array<Project | PersistedActiveProjectReference>;
};

export interface StateSerializationPolicy {
  currentSchemaVersion: number;
  maxBytes: number;
  desktopBrowserCacheBytes: number;
}

export interface EncodedStateSnapshot {
  serialized: string;
  sizeBytes: number;
  /** Already redacted and encoded in the worker; never a second large object. */
  browserCache?: string;
  browserCacheError?: { name: string; message: string };
}

/** Count UTF-8 without allocating another full-size encoded copy of the state. */
export const stateUtf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/** Pure shared implementation for synchronous exports and the renderer worker. */
export const serializeStateSnapshot = (
  state: AppState,
  policy: StateSerializationPolicy,
): { serializedState: PersistedAppState; serialized: string; sizeBytes: number } => {
  let activeJson: string | undefined;
  const projects = state.projects?.map((project): Project | PersistedActiveProjectReference => {
    if (project.id !== state.project.id) return project;
    if (project !== state.project) {
      activeJson ??= JSON.stringify(state.project);
      if (JSON.stringify(project) !== activeJson) return project;
    }
    return { id: project.id, __activeProjectReference: true };
  });
  const serializedState: PersistedAppState = {
    ...state,
    ...(projects ? { projects } : {}),
    schemaVersion: typeof state.schemaVersion === 'number' && Number.isFinite(state.schemaVersion)
      ? Math.max(policy.currentSchemaVersion, Math.floor(state.schemaVersion))
      : policy.currentSchemaVersion,
  };
  const serialized = JSON.stringify(serializedState);
  const sizeBytes = stateUtf8ByteLength(serialized);
  if (sizeBytes > policy.maxBytes) {
    throw new Error(`项目状态大小为 ${(sizeBytes / 1024 / 1024).toFixed(1)} MiB，超过 ${policy.maxBytes / 1024 / 1024} MiB 本地保存上限。请先导出不常用项目备份，再按需整理项目库；现有文件和素材未被删除`);
  }
  return { serializedState, serialized, sizeBytes };
};

const stateWithoutSecrets = <T extends { settings: AppSettings }>(state: T): T => {
  const clone = JSON.parse(JSON.stringify(state)) as T;
  clone.settings.textApi.apiKey = '';
  clone.settings.visionApi.apiKey = '';
  clone.settings.imageApi.apiKey = '';
  clone.settings.videoTaskApi.apiKey = '';
  if (clone.settings.comfyuiVideo) clone.settings.comfyuiVideo.apiKey = '';
  if (clone.settings.runningHubVideo) clone.settings.runningHubVideo.apiKey = '';
  clone.settings.videoApiProfiles?.forEach((profile) => { profile.apiKey = ''; });
  clone.settings.apiCredentialBook.forEach((item) => { item.apiKey = ''; });
  clone.settings.textApiProfiles.forEach((item) => { item.apiKey = ''; });
  clone.settings.visionApiProfiles.forEach((item) => { item.apiKey = ''; });
  clone.settings.imageApiProfiles.forEach((item) => { item.apiKey = ''; });
  return clone;
};

export const encodeStateSnapshot = (
  state: AppState,
  policy: StateSerializationPolicy,
  desktop: boolean,
): EncodedStateSnapshot => {
  const { serializedState, serialized, sizeBytes } = serializeStateSnapshot(state, policy);
  const result: EncodedStateSnapshot = { serialized, sizeBytes };
  if (desktop && sizeBytes > policy.desktopBrowserCacheBytes) return result;
  try {
    result.browserCache = JSON.stringify(stateWithoutSecrets(serializedState));
  } catch (error) {
    // As before, failure of the optional browser mirror cannot invalidate a
    // successful desktop write. Browser-only callers report it at the write boundary.
    result.browserCacheError = {
      name: error instanceof Error ? error.name : '',
      message: error instanceof Error ? error.message : '浏览器缓存编码失败',
    };
  }
  return result;
};

export interface StateSerializationRequest {
  id: number;
  state: AppState;
  policy: StateSerializationPolicy;
}
export type StateSerializationReply =
  | { id: number; ok: true; result: EncodedStateSnapshot }
  | { id: number; ok: false; error: string };

/** Each message is synchronous inside the single worker, preserving worker FIFO. */
export const handleStateSerializationRequest = (request: StateSerializationRequest): StateSerializationReply => {
  try {
    return { id: request.id, ok: true, result: encodeStateSnapshot(request.state, request.policy, true) };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : '本地存档编码失败' };
  }
};
