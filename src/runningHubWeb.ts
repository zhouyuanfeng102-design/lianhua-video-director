import type { VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';

/** Stable IPC identity. The browser window talks to RunningHub; this address never leaves the machine. */
export const RHWEB_ORIGIN = 'http://rhweb.localhost';

export type RunningHubWebSite = 'ai' | 'cn';
export type RunningHubWebKind = 'image' | 'audio' | 'text' | 'number' | 'boolean' | 'select';
export type RunningHubWebBind = 'prompt' | 'idea' | 'image' | 'audio' | 'duration' | 'aspect_ratio' | 'megapixels' | 'fixed';

export interface RunningHubWebField {
  key: string;
  label: string;
  kind: RunningHubWebKind;
  value: string | number | boolean;
  options?: string[];
  bind: RunningHubWebBind;
}

export interface RunningHubWebAccountSession {
  loggedIn: boolean;
  displayName: string;
  coins: string;
  wallet: string;
  checkedAt: number;
}

export interface RunningHubWebAccount {
  id: string;
  name: string;
  site: RunningHubWebSite;
  /** Last identity read from the account window. Absent means it has not been checked. */
  session?: RunningHubWebAccountSession;
}

export interface RunningHubWebApp {
  id: string;
  name: string;
  remoteId: string;
  site: RunningHubWebSite;
  url: string;
  accountId: string;
  fields: RunningHubWebField[];
  instance: string;
  estimate?: string;
  /** False when a later page read no longer matches the saved labels. */
  ready: boolean;
  updatedAt: number;
}

export interface RunningHubWebConfig {
  enabled: boolean;
  accounts: RunningHubWebAccount[];
  activeAccountId?: string | null;
  apps: RunningHubWebApp[];
  activeAppId?: string | null;
}

const binds: RunningHubWebBind[] = ['prompt', 'idea', 'image', 'audio', 'duration', 'aspect_ratio', 'megapixels', 'fixed'];
const kinds: RunningHubWebKind[] = ['image', 'audio', 'text', 'number', 'boolean', 'select'];
const field = (key: string, label: string, kind: RunningHubWebKind, value: string | number | boolean, bind: RunningHubWebBind, options?: string[]): RunningHubWebField => ({
  key, label, kind, value, bind, ...(options ? { options } : {}),
});

/** Labels read from the live app page on 2026-11-06. A later 读取网页 replaces values. */
export const knownMiniMaxH3WebFields = (): RunningHubWebField[] => [
  field('image:1', 'image1', 'image', '', 'image'),
  field('image:2', 'image2（不用就删除）', 'image', '', 'image'),
  field('image:3', 'image3（不用就删除）', 'image', '', 'image'),
  field('image:4', 'image4（不用就删除）', 'image', '', 'image'),
  field('image:5', 'image5（不用就删除）', 'image', '', 'image'),
  field('image:6', 'image6（不用就删除）', 'image', '', 'image'),
  field('audio:1', 'audio1', 'audio', '', 'audio'),
  field('audio:2', 'audio2', 'audio', '', 'audio'),
  field('select:aspect', 'aspect_ratio', 'select', '9:16 (Portrait Widescreen)', 'aspect_ratio', [
    '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)', '4:3 (Standard)',
    '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
  ]),
  field('number:megapixels', '百万像素比(0.8以上要Ultra运行)', 'number', 0.5, 'megapixels'),
  field('number:duration', '时长（5-30s）', 'number', 30, 'duration'),
  field('boolean:auto-prompt', '自动提示词', 'boolean', true, 'fixed'),
  field('text:prompt', '提示词', 'text', '拍摄时尚杂志，性感姿势', 'idea'),
  field('lora:1:name', 'lora_name 1', 'text', 'MysticXXX-ref2va-V4.safetensors', 'fixed'),
  field('lora:1:strength', 'strength_model 1', 'number', 0.4, 'fixed'),
  field('lora:2:name', 'lora_name 2', 'text', 'HMNSFW-AIO-V2.5.safetensors', 'fixed'),
  field('lora:2:strength', 'strength_model 2', 'number', 0.5, 'fixed'),
  field('lora:3:name', 'lora_name 3', 'text', 'H3_Motion_BoosterV2.safetensors', 'fixed'),
  field('lora:3:strength', 'strength_model 3', 'number', 0.6, 'fixed'),
  field('text:trigger', 'Lora触发词', 'text', 'dynv2,', 'fixed'),
  field('boolean:output', '输出<直出/ZIP>', 'boolean', false, 'fixed'),
];

export const defaultRunningHubWebConfig = (): RunningHubWebConfig => ({
  enabled: false,
  accounts: [{ id: 'rh-web-account-ai', name: '国际站', site: 'ai' }],
  activeAccountId: 'rh-web-account-ai',
  apps: [],
  activeAppId: null,
});

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const siteOf = (value: unknown): RunningHubWebSite => value === 'cn' ? 'cn' : 'ai';
const hostFor = (site: RunningHubWebSite) => site === 'cn' ? 'https://www.runninghub.cn' : 'https://www.runninghub.ai';

export const parseRunningHubWebAddress = (input: string): { remoteId: string; site: RunningHubWebSite; url: string } => {
  const raw = input.trim();
  const idOnly = raw.match(/^\d{10,}$/u);
  if (idOnly) {
    const remoteId = idOnly[0];
    return { remoteId, site: 'ai', url: `${hostFor('ai')}/zh-cn/ai-detail/${remoteId}` };
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('请粘贴 RunningHub 应用页链接，或只粘贴应用号。'); }
  if (url.protocol !== 'https:' || (url.hostname !== 'www.runninghub.ai' && url.hostname !== 'www.runninghub.cn' && url.hostname !== 'runninghub.ai' && url.hostname !== 'runninghub.cn')) {
    throw new Error('只接受 runninghub.ai 或 runninghub.cn 的应用页。');
  }
  const remoteId = url.pathname.match(/\/ai-detail\/(\d{10,})/u)?.[1];
  if (!remoteId) throw new Error('这个地址不是应用详情页。请使用含 ai-detail 和应用号的链接。');
  const site: RunningHubWebSite = url.hostname.endsWith('runninghub.cn') ? 'cn' : 'ai';
  return { remoteId, site, url: `${hostFor(site)}/zh-cn/ai-detail/${remoteId}` };
};

const suggestBind = (label: string, kind: RunningHubWebKind, autoPromptOn: boolean): RunningHubWebBind => {
  if (kind === 'image') return 'image';
  if (kind === 'audio') return 'audio';
  if (/时长/u.test(label)) return 'duration';
  if (/aspect|比例/iu.test(label)) return 'aspect_ratio';
  if (/百万像素|megapixel/iu.test(label)) return 'megapixels';
  if (label === '提示词') return autoPromptOn ? 'idea' : 'prompt';
  return 'fixed';
};

export const suggestRunningHubWebBindings = (fields: RunningHubWebField[]): RunningHubWebField[] => {
  const auto = fields.find((item) => item.label === '自动提示词');
  const autoPromptOn = auto?.kind === 'boolean' && auto.value === true;
  return fields.map((item) => ({ ...item, bind: suggestBind(item.label, item.kind, autoPromptOn) }));
};

const allowedBind = (kind: RunningHubWebKind, bind: RunningHubWebBind): boolean => {
  if (bind === 'fixed') return true;
  if (kind === 'image') return bind === 'image';
  if (kind === 'audio') return bind === 'audio';
  if (kind === 'text') return bind === 'prompt' || bind === 'idea';
  if (kind === 'number') return bind === 'duration' || bind === 'megapixels';
  if (kind === 'select') return bind === 'aspect_ratio';
  return false;
};

const normalizeField = (value: unknown): RunningHubWebField | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const kind = kinds.find((item) => item === raw.kind);
  const bind = binds.find((item) => item === raw.bind);
  const key = text(raw.key);
  const label = text(raw.label);
  if (!kind || !bind || !key || !label || !allowedBind(kind, bind)) return undefined;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : undefined;
  let fieldValue: string | number | boolean = '';
  if (kind === 'boolean') fieldValue = raw.value === true;
  else if (kind === 'number') fieldValue = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : Number(raw.value);
  else fieldValue = typeof raw.value === 'string' ? raw.value : '';
  if (kind === 'number' && !Number.isFinite(fieldValue as number)) return undefined;
  return { key, label, kind, value: fieldValue, bind, ...(options?.length ? { options } : {}) };
};

export const normalizeRunningHubWebConfig = (value: unknown): RunningHubWebConfig => {
  const fallback = defaultRunningHubWebConfig();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : fallback.accounts).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const account = item as Record<string, unknown>;
    const id = text(account.id);
    const name = text(account.name);
    if (!id || !name) return [];
    const sessionRaw = account.session && typeof account.session === 'object' ? account.session as Record<string, unknown> : undefined;
    const session = sessionRaw && typeof sessionRaw.checkedAt === 'number' ? {
      loggedIn: sessionRaw.loggedIn === true,
      displayName: text(sessionRaw.displayName),
      coins: text(sessionRaw.coins),
      wallet: text(sessionRaw.wallet),
      checkedAt: sessionRaw.checkedAt,
    } : undefined;
    return [{ id, name, site: siteOf(account.site), ...(session ? { session } : {}) }];
  });
  const savedAccounts = Array.isArray(raw.accounts) ? accounts : (accounts.length ? accounts : fallback.accounts);
  const apps = (Array.isArray(raw.apps) ? raw.apps : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const app = item as Record<string, unknown>;
    const id = text(app.id);
    const remoteId = text(app.remoteId);
    const name = text(app.name) || remoteId;
    const accountId = text(app.accountId);
    if (!id || !/^\d{10,}$/u.test(remoteId) || !accountId) return [];
    const boundAccountId = savedAccounts.some((account) => account.id === accountId) ? accountId : (savedAccounts[0]?.id || accountId);
    const fields = (Array.isArray(app.fields) ? app.fields : []).flatMap((entry) => {
      const normalized = normalizeField(entry);
      return normalized ? [normalized] : [];
    });
    const site = siteOf(app.site);
    return [{
      id, name, remoteId, site, accountId: boundAccountId, fields,
      url: `${hostFor(site)}/zh-cn/ai-detail/${remoteId}`,
      instance: text(app.instance) || 'Plus',
      ...(text(app.estimate) ? { estimate: text(app.estimate) } : {}),
      ready: app.ready === true && fields.length > 0,
      updatedAt: typeof app.updatedAt === 'number' ? app.updatedAt : Date.now(),
    }];
  });
  const activeAccountId = savedAccounts.some((account) => account.id === raw.activeAccountId) ? text(raw.activeAccountId) : (savedAccounts[0]?.id ?? null);
  const activeAppId = apps.some((app) => app.id === raw.activeAppId) ? text(raw.activeAppId) : null;
  return { enabled: raw.enabled === true, accounts: savedAccounts, activeAccountId, apps, activeAppId };
};

export const createRunningHubWebApp = (address: string, accountId: string, existing: RunningHubWebApp[] = []): RunningHubWebApp => {
  const parsed = parseRunningHubWebAddress(address);
  if (existing.some((app) => app.remoteId === parsed.remoteId && app.site === parsed.site)) throw new Error('这个应用页已经在网页应用库里。');
  const known = parsed.remoteId === '2104753059472990209' && parsed.site === 'ai';
  const now = Date.now();
  return {
    id: `rh-web-app-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: known ? 'Minimax-H3 (30s直出)多图生视频自动提示词-小白全能版' : `网页应用 ${parsed.remoteId}`,
    remoteId: parsed.remoteId,
    site: parsed.site,
    url: parsed.url,
    accountId,
    fields: known ? knownMiniMaxH3WebFields() : [],
    instance: 'Plus',
    ...(known ? { estimate: '≈ 477 RH币' } : {}),
    ready: known,
    updatedAt: now,
  };
};

export const mergeRunningHubWebRead = (
  app: RunningHubWebApp,
  read: { fields: RunningHubWebField[]; instance?: string; estimate?: string; name?: string },
): RunningHubWebApp => {
  const incoming = suggestRunningHubWebBindings(read.fields);
  const previous = new Map(app.fields.map((item) => [item.key, item.bind]));
  const fields = incoming.map((item) => ({ ...item, bind: previous.get(item.key) && allowedBind(item.kind, previous.get(item.key)!) ? previous.get(item.key)! : item.bind }));
  const sameShape = app.fields.length === fields.length && app.fields.every((item, index) => item.key === fields[index]?.key && item.label === fields[index]?.label);
  const sameLabels = app.fields.map((item) => item.label).join('\n') === fields.map((item) => item.label).join('\n');
  const pageName = read.name?.trim();
  return {
    ...app,
    ...(pageName ? { name: pageName } : {}),
    fields,
    instance: read.instance?.trim() || app.instance,
    ...(read.estimate?.trim() ? { estimate: read.estimate.trim() } : {}),
    ready: fields.length > 0 && (app.fields.length === 0 || sameShape || (app.ready && sameLabels)),
    updatedAt: Date.now(),
  };
};

const slotOf = (reference: { slotIndex?: number }, index: number) => reference.slotIndex ?? index;

const optionForRatio = (wanted: string, options: string[] | undefined): string => {
  if (!options?.length) return wanted;
  const exact = options.find((option) => option === wanted);
  if (exact) return exact;
  const prefixed = options.find((option) => option.startsWith(`${wanted} `) || option.startsWith(`${wanted}(`));
  if (prefixed) return prefixed;
  throw new Error(`网页比例选项里没有 ${wanted}。`);
};

const parameterValue = (parameters: Record<string, unknown>, name: string): unknown => (
  Object.prototype.hasOwnProperty.call(parameters, name) && parameters[name] !== '' ? parameters[name] : undefined
);

export const buildRhWebBody = (
  config: Omit<VideoTaskApiConfig, 'apiKey'>,
  draft: VideoGenerationDraft,
  images: string[],
  audios: string[] = [],
): Record<string, unknown> => {
  const fields = config.rhWebFields || [];
  if (!config.rhWebPageUrl || !config.rhWebAccountId || !fields.length) throw new Error('RH 网页应用还没有读到表单，请先在 RH 网页里读取并保存。');
  const imageFields = fields.filter((item) => item.bind === 'image');
  const audioFields = fields.filter((item) => item.bind === 'audio');
  if (draft.references.length !== images.length) throw new Error('参考图和已准备的文件数量不一致，尚未提交。');
  if ((draft.audioReferences?.length || 0) !== audios.length) throw new Error('参考音频和已准备的文件数量不一致，尚未提交。');
  if (draft.references.length > imageFields.length) throw new Error(`这个网页应用有 ${imageFields.length} 个图片槽，本次选了 ${draft.references.length} 张，不会丢图。`);
  if ((draft.audioReferences?.length || 0) > audioFields.length) throw new Error(`这个网页应用有 ${audioFields.length} 个音频槽，本次选了 ${draft.audioReferences?.length || 0} 段，不会丢音频。`);
  if (draft.videoReferences?.length) throw new Error('这个网页应用没有参考视频槽。');
  const supported = new Set(['duration', 'aspect_ratio', 'megapixels', 'idea']);
  const extra = Object.keys(draft.parameters).filter((key) => parameterValue(draft.parameters, key) !== undefined && !supported.has(key));
  if (extra.length) throw new Error(`RH 网页没有这些参数的绑定：${extra.join('、')}。`);
  for (const name of supported) {
    if (parameterValue(draft.parameters, name) !== undefined && !fields.some((item) => item.bind === name)) {
      throw new Error(`参数 ${name} 还没绑到网页字段。`);
    }
  }
  let instance = config.rhWebInstance || 'Plus';
  const rawPrompt = draft.origin === 'custom' && draft.promptMode === 'raw';
  // A new director delivery is already an executable H3 script. Reusing a
  // historical task retains its frozen page-field contract instead.
  const completeH3Prompt = draft.source?.promptFormat === 'h3' && !draft.reuseTaskId;
  const assignments = fields.map((item) => {
    if ((rawPrompt || completeH3Prompt)
      && item.label === '自动提示词' && item.kind === 'boolean') {
      return { key: item.key, label: item.label, kind: item.kind, value: false };
    }
    if (item.bind === 'image') {
      const index = imageFields.findIndex((candidate) => candidate.key === item.key);
      const referenceIndex = draft.references.findIndex((reference, referenceOrder) => slotOf(reference, referenceOrder) === index);
      return { key: item.key, label: item.label, kind: item.kind, value: referenceIndex >= 0 ? images[referenceIndex] : '' };
    }
    if (item.bind === 'audio') {
      const index = audioFields.findIndex((candidate) => candidate.key === item.key);
      const referenceIndex = (draft.audioReferences || []).findIndex((reference, referenceOrder) => slotOf(reference, referenceOrder) === index);
      return { key: item.key, label: item.label, kind: item.kind, value: referenceIndex >= 0 ? audios[referenceIndex] : '' };
    }
    if (item.label === '提示词' || item.bind === 'prompt' || item.bind === 'idea') {
      if (rawPrompt || completeH3Prompt && (item.bind === 'prompt' || item.bind === 'idea')) {
        return { key: item.key, label: item.label, kind: item.kind, value: draft.prompt };
      }
      const idea = item.bind === 'idea' ? parameterValue(draft.parameters, 'idea') : undefined;
      const explicit = typeof idea === 'string' ? idea.trim() : '';
      const chosen = item.bind === 'idea'
        ? (explicit && explicit !== '拍摄时尚杂志，性感姿势' ? explicit : draft.prompt.trim())
        : item.bind === 'prompt' || String(item.value).trim() === '拍摄时尚杂志，性感姿势'
          ? draft.prompt.trim()
          : String(item.value);
      if (!chosen.trim() || chosen.trim() === '拍摄时尚杂志，性感姿势') throw new Error('提示词是空的，尚未提交。');
      return { key: item.key, label: item.label, kind: item.kind, value: chosen };
    }
    if (item.bind === 'duration' || item.bind === 'megapixels') {
      const raw = parameterValue(draft.parameters, item.bind);
      const source = raw === undefined ? item.value : raw;
      const text = typeof source === 'number' ? String(source) : String(source ?? '').trim();
      const value = typeof source === 'number' ? source : Number(text);
      if (!text || !Number.isFinite(value)) throw new Error(`${item.label} 需要数字。`);
      if (item.bind === 'megapixels' && value >= 0.8) instance = 'Ultra';
      return { key: item.key, label: item.label, kind: item.kind, value };
    }
    if (item.bind === 'aspect_ratio') {
      const raw = parameterValue(draft.parameters, 'aspect_ratio');
      const wanted = raw === undefined ? String(item.value) : String(raw);
      return { key: item.key, label: item.label, kind: item.kind, value: optionForRatio(wanted, item.options) };
    }
    return { key: item.key, label: item.label, kind: item.kind, value: item.value };
  });
  return {
    prompt: draft.prompt,
    account_id: config.rhWebAccountId,
    page_url: config.rhWebPageUrl,
    instance,
    fields: assignments,
  };
};

export const compileRunningHubWebApi = (config: RunningHubWebConfig, appId?: string): VideoTaskApiConfig => {
  if (!config.enabled) throw new Error('请先在 RH 网页里启用连接。');
  const id = appId && appId !== '__runninghub_web_unselected__' ? appId : config.activeAppId;
  const app = config.apps.find((item) => item.id === id);
  if (!app) throw new Error('请先选择已读取的 RH 网页应用。');
  if (!app.ready || !app.fields.length) throw new Error(`“${app.name}”还没完成网页读取，不能生成。`);
  if (!app.fields.some((item) => item.bind === 'prompt' || item.bind === 'idea')) throw new Error('请把网页上的提示词格绑到完整提示词或短想法。');
  const account = config.accounts.find((item) => item.id === app.accountId)
    || config.accounts.find((item) => item.id === config.activeAccountId)
    || config.accounts[0];
  if (!account) throw new Error('请先添加 RH 网页登录位并登录。');
  return {
    enabled: true,
    provider: 'rh_web',
    model: app.name,
    endpoint: `${RHWEB_ORIGIN}/v1/videos`,
    statusEndpointTemplate: `${RHWEB_ORIGIN}/v1/videos/{id}`,
    imageUploadEndpoint: `${RHWEB_ORIGIN}/v1/assets`,
    imageUploadUrlPath: 'upload_id',
    apiKey: '',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    taskIdPath: 'id',
    statusPath: 'status',
    resultUrlPath: 'result_url',
    rhWebAccountId: account.id,
    rhWebPageUrl: app.url,
    rhWebInstance: app.instance,
    rhWebFields: app.fields.map((item) => ({ ...item, ...(item.options ? { options: [...item.options] } : {}) })),
  };
};

export const isRunningHubWebAppReady = (app: RunningHubWebApp | undefined): boolean => Boolean(app?.ready && app.fields.length && app.fields.some((item) => item.bind === 'prompt' || item.bind === 'idea'));

/** Values already on the app page. Prompt and media slots stay in their own controls. */
export const runningHubWebPageParameters = (
  fields: readonly RunningHubWebField[] | undefined,
  instance?: string,
  estimate?: string,
): { label: string; value: string }[] => {
  const lines: { label: string; value: string }[] = [];
  if (instance?.trim()) lines.push({ label: '运行机型', value: instance.trim() });
  if (estimate?.trim()) lines.push({ label: '页面预估', value: estimate.trim() });
  for (const field of fields || []) {
    if (field.bind === 'prompt' || field.bind === 'idea' || field.bind === 'image' || field.bind === 'audio') continue;
    const value = field.value === true ? '开' : field.value === false ? '关' : String(field.value ?? '').trim();
    if (!value) continue;
    lines.push({ label: field.label, value });
  }
  return lines;
};

/** Drop one saved login slot. Web apps stay; a remaining slot takes over their login. */
export const removeRunningHubWebAccount = (config: RunningHubWebConfig, accountId: string): RunningHubWebConfig => {
  const accounts = config.accounts.filter((item) => item.id !== accountId);
  const activeAccountId = accounts.some((item) => item.id === config.activeAccountId)
    ? (config.activeAccountId || null)
    : (accounts[0]?.id ?? null);
  const apps = config.apps.map((app) => app.accountId === accountId && activeAccountId ? { ...app, accountId: activeAccountId } : app);
  return { ...config, accounts, activeAccountId, apps };
};

export interface RhWebControlRequest {
  action: 'login' | 'read' | 'session' | 'forget';
  accountId: string;
  site?: RunningHubWebSite;
  url?: string;
}

export interface RhWebControlResult {
  running?: boolean;
  message?: string;
  fields?: RunningHubWebField[];
  instance?: string;
  estimate?: string;
  name?: string;
  open?: boolean;
  loggedIn?: boolean;
  displayName?: string;
  coins?: string;
  wallet?: string;
}
