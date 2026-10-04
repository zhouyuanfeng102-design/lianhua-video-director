import type { AppSettings, ImageApiConfig, ImageApiExecutionSnapshot, ImageApiProfile } from './types';

type ImageApiSettings = Pick<AppSettings, 'imageApi' | 'imageApiProfiles' | 'activeImageApiProfileId' | 'privateImageApiProfileId'>;
type WorkbenchMode = 'ordinary' | 'private';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// API profiles can contain an imported ComfyUI workflow.  The workbench is
// rendered frequently while a generation is in progress, so canonicalising
// that workflow on every render can temporarily multiply a large object graph.
// Cache only the derived comparison key; returned configurations remain fresh
// clones because callers are allowed to edit their local request snapshot.
const executionKeyCache = new WeakMap<object, string>();
const unavailableConfig = (): ImageApiConfig => ({ enabled: false, backend: 'openai', baseUrl: '', apiKey: '', model: '' });
const backendLabels: Record<ImageApiConfig['backend'], string> = {
  openai: 'Images API', sd_webui: 'SD WebUI', comfyui: 'ComfyUI', novelai: 'NovelAI',
};
const endpointKey = (value: string): string => value.trim().replace(/\/+$/u, '');
const sameConnection = (left: Pick<ImageApiConfig, 'backend' | 'baseUrl'>, right: Pick<ImageApiConfig, 'backend' | 'baseUrl'>): boolean => (
  left.backend === right.backend && endpointKey(left.baseUrl) === endpointKey(right.baseUrl)
);

/** Only non-secret labels enter the picker; neither endpoint nor credentials are shown. */
export const imageApiChoiceLabel = (config: ImageApiConfig, name = ''): string => {
  const model = config.backend === 'comfyui'
    ? config.comfyuiWorkflows?.find((workflow) => workflow.id === config.activeComfyuiWorkflowId)?.name || '当前工作流'
    : config.model.trim() || '未设模型';
  return [name, backendLabels[config.backend], model, config.enabled ? '' : '已停用'].filter(Boolean).join(' · ');
};

const profileConfig = (profile: ImageApiProfile): ImageApiConfig => {
  const { id: _id, name: _name, createdAt: _createdAt, updatedAt: _updatedAt, ...config } = profile;
  return clone(config);
};

export const resolveWorkbenchImageApi = (
  settings: ImageApiSettings,
  mode: WorkbenchMode,
): { config: ImageApiConfig; profileId: string | null; issue: string } => {
  const overrideId = mode === 'private' ? settings.privateImageApiProfileId?.trim() : '';
  if (overrideId) {
    const profile = settings.imageApiProfiles.find((item) => item.id === overrideId);
    if (!profile) return { config: unavailableConfig(), profileId: overrideId, issue: '所选生图 API 配置已删除，请重新选择；不会改用其他配置。' };
    return {
      config: profileConfig(profile), profileId: profile.id,
      issue: profile.enabled ? '' : '所选生图 API 配置已停用，请选择已启用的配置，或在 API 设置中启用。',
    };
  }
  const current = settings.imageApi;
  const active = settings.imageApiProfiles.find((item) => item.id === settings.activeImageApiProfileId);
  return {
    config: clone(current),
    profileId: active && sameConnection(active, current) && active.apiKey === current.apiKey && active.enabled === current.enabled
      && executionConfigurationKey(active) === executionConfigurationKey(current) ? active.id : null,
    issue: '',
  };
};

const sha256 = async (value: string): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const connectionFingerprint = (config: Pick<ImageApiConfig, 'backend' | 'baseUrl'>): Promise<string> => (
  sha256(JSON.stringify([config.backend, endpointKey(config.baseUrl)]))
);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, canonical(entry)]))
    : value;
const executionConfigurationKey = (config: ImageApiConfig): string => {
  const cached = executionKeyCache.get(config as object);
  if (cached !== undefined) return cached;
  const result = JSON.stringify(canonical(
    Object.fromEntries(Object.entries(config).filter(([key]) => ![
      'id', 'name', 'createdAt', 'updatedAt', 'apiKey', 'baseUrl', 'model', 'enabled',
    ].includes(key))),
  ));
  executionKeyCache.set(config as object, result);
  return result;
};
/** Include every execution option, including future/imported options, without storing its content. */
const executionFingerprint = (config: ImageApiConfig): Promise<string> => sha256(executionConfigurationKey(config));

/** Never persist endpoints, API keys or workflows: all can embed credentials. */
export const captureImageApiSnapshot = async (config: ImageApiConfig, profileId: string | null): Promise<ImageApiExecutionSnapshot> => {
  const frozen = clone(config);
  const [connection, execution] = await Promise.all([connectionFingerprint(frozen), executionFingerprint(frozen)]);
  return {
    version: 1, profileId, connectionFingerprint: connection, executionFingerprint: execution,
    config: { enabled: frozen.enabled, backend: frozen.backend, model: frozen.model },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Invalid snapshots remain a closed, unavailable snapshot, never a legacy fallback. */
export const normalizeImageApiSnapshot = (value: unknown): ImageApiExecutionSnapshot | undefined => {
  if (value === undefined) return undefined;
  const invalid = (): ImageApiExecutionSnapshot => ({
    version: 1, profileId: null, connectionFingerprint: '', executionFingerprint: '', config: { enabled: false, backend: 'openai', model: '' },
  });
  if (!isRecord(value) || value.version !== 1 || (value.profileId !== null && typeof value.profileId !== 'string')) return invalid();
  const config = value.config;
  if (!isRecord(config) || typeof config.enabled !== 'boolean'
    || !['openai', 'sd_webui', 'comfyui', 'novelai'].includes(String(config.backend))
    || typeof config.model !== 'string'
    || typeof value.connectionFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.connectionFingerprint)
    || typeof value.executionFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.executionFingerprint)) return invalid();
  return {
    version: 1, profileId: value.profileId as string | null, connectionFingerprint: value.connectionFingerprint,
    executionFingerprint: value.executionFingerprint,
    config: { enabled: config.enabled, backend: config.backend as ImageApiConfig['backend'], model: config.model },
  };
};

/** A retry reuses the original endpoint/model/workflow, not the workbench's later choice. */
export const resolveImageApiForRegeneration = async (
  settings: ImageApiSettings,
  snapshot?: ImageApiExecutionSnapshot,
): Promise<ImageApiConfig> => {
  if (snapshot === undefined) return clone(settings.imageApi); // Legacy tasks retain their established behavior.
  const normalized = normalizeImageApiSnapshot(snapshot)!;
  if (!normalized.config.enabled || !normalized.connectionFingerprint) {
    throw new Error('原任务的生图 API 快照不可用，请返回工作台选择配置后创建新任务；不会自动改用其他配置。');
  }
  const source = normalized.profileId
    ? settings.imageApiProfiles.find((profile) => profile.id === normalized.profileId)
    : settings.imageApi;
  const credentialSource = source ? clone(source) : undefined;
  if (!credentialSource || !credentialSource.enabled
    || await connectionFingerprint(credentialSource) !== normalized.connectionFingerprint) {
    throw new Error('原任务的生图 API 配置已删除、停用或更换服务地址，请恢复原配置后重试；不会把原任务发送到其他服务。');
  }
  if (await executionFingerprint(credentialSource) !== normalized.executionFingerprint) {
    throw new Error('原任务的生图执行参数或工作流已改变，请恢复原配置后重试，或在工作台按新配置创建任务；不会自动使用新参数。');
  }
  return { ...clone(credentialSource), ...normalized.config };
};

/** In-memory only. Never log or serialize this value: it can contain credentials. */
export const imageApiRegenerationSourceIdentity = (
  settings: ImageApiSettings,
  snapshot?: ImageApiExecutionSnapshot,
): string => {
  const profileId = normalizeImageApiSnapshot(snapshot)?.profileId;
  const source = profileId ? settings.imageApiProfiles.find((profile) => profile.id === profileId) : settings.imageApi;
  return JSON.stringify(source || null);
};
