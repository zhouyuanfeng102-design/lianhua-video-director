import type { VideoTaskApiConfig } from './types';
import type { VideoApiParameterCapabilities } from './videoApiCapabilityTypes';
import { fetchGenericVideoModelMetadata, genericVideoApiBaseUrl, genericVideoApiEndpoints } from './genericVideoApi';
import { mergeVideoApiParameterCapabilities, parseVideoApiModelMetadata, parseVideoApiOpenApiCapabilities, videoApiCapabilityScope } from './videoApiCapabilities';

type JsonRecord = Record<string, unknown>;
type Operation = { path: string; item: JsonRecord; operation: JsonRecord; method: 'get' | 'post' | 'delete' };
export interface GenericVideoApiDiscovery {
  models: string[];
  patch: Partial<VideoTaskApiConfig>;
  source: 'openapi' | 'standard';
  message: string;
  warnings: string[];
}
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
const abortError = (): Error => Object.assign(new Error('已取消自动获取。'), { name: 'AbortError' });
const maxDocumentBytes = 512 * 1024;
const oneParameter = (path: string): boolean => (path.match(/\{[^{}]+\}/gu) || []).length === 1;
const replaceParameter = (path: string): string => path.replace(/\{[^{}]+\}/gu, '{id}');

const safeUrl = (value: string, base?: string): URL | undefined => {
  try {
    const url = new URL(value, base);
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
  } catch { return undefined; }
};

/** Explicitly adopting automatic configuration clears the previous service's protocol. */
const standardPatch = (config: VideoTaskApiConfig): Partial<VideoTaskApiConfig> => {
  const endpoints = genericVideoApiEndpoints({ ...config, baseUrl: genericVideoApiBaseUrl(config), endpoint: '', statusEndpointTemplate: '' });
  return {
    provider: 'generic', endpoint: endpoints.submit, statusEndpointTemplate: endpoints.status,
    authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'download_url',
    progressPath: 'progress', errorPath: 'error.message', requestTemplate: '',
    fileIdPath: '', fileEndpointTemplate: '', fileUrlPath: '', cancelEndpointTemplate: '', cancelMethod: 'POST',
    imageUploadEndpoint: '', imageUploadField: '', imageUploadUrlPath: '',
  };
};

/** Optional documents use only GET, never follow redirects, and share cancellation with model discovery. */
const getDocument = async (url: URL, config: VideoTaskApiConfig, signal: AbortSignal): Promise<unknown | undefined> => {
  if (signal.aborted) throw abortError();
  const base = safeUrl(genericVideoApiBaseUrl(config));
  if (!base || base.origin !== url.origin) return undefined;
  const key = config.apiKey.trim();
  const authHeader = config.authHeader.trim() || 'Authorization';
  const authScheme = config.authScheme ?? 'Bearer';
  if (/[\r\n]/u.test(`${key}${authHeader}${authScheme}`)) throw new Error('API 认证设置包含无效换行。');
  const headers: Record<string, string> = { Accept: 'application/json', ...(key ? { [authHeader]: `${authScheme ? `${authScheme} ` : ''}${key}` } : {}) };
  const desktop = typeof window !== 'undefined' ? window.lianhuaDesktop : undefined;
  const requestId = `video-discovery-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const controller = new AbortController();
  try {
    const response = await new Promise<{ status: number; body: string } | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); action(); };
      const cancel = () => { controller.abort(); try { void desktop?.cancelModelRequest?.(requestId).catch(() => undefined); } catch { /* Cancellation still settles locally. */ } };
      const onAbort = () => finish(() => { cancel(); reject(abortError()); });
      const timer = setTimeout(() => finish(() => { cancel(); resolve(undefined); }), 2_500);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      const perform = async () => {
        if (desktop?.request) return desktop.request({ requestId, url: url.toString(), method: 'GET', headers, responseType: 'text', redirect: 'error' });
        const response = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
        if (Number(response.headers.get('content-length')) > maxDocumentBytes) { controller.abort(); return undefined; }
        if (!response.body) return { status: response.status, body: await response.text() };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0, body = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxDocumentBytes) { await reader.cancel(); return undefined; }
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
          return { status: response.status, body };
        } finally { reader.releaseLock(); }
      };
      void perform().then((response) => finish(() => resolve(response)), () => finish(() => resolve(undefined)));
    });
    if (signal.aborted) throw abortError();
    if (!response || response.status < 200 || response.status >= 300 || response.body.length > maxDocumentBytes || new TextEncoder().encode(response.body).byteLength > maxDocumentBytes) return undefined;
    const body: unknown = JSON.parse(response.body);
    return record(body) && (typeof body.openapi === 'string' || body.swagger === '2.0') && record(body.paths) ? body : undefined;
  } catch (error) { if (isAbort(error)) throw error; return undefined; }
};

const resolveLocal = (source: unknown, document: JsonRecord, visited = new Set<string>()): JsonRecord | undefined => {
  if (!record(source)) return undefined;
  if (typeof source.$ref !== 'string') return source;
  const ref = source.$ref;
  if (!ref.startsWith('#/') || visited.has(ref)) return undefined;
  visited.add(ref);
  let target: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    if (!record(target)) return undefined;
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!Object.prototype.hasOwnProperty.call(target, key)) return undefined;
    target = target[key];
  }
  return resolveLocal(target, document, visited);
};

const schemaFields = (source: unknown, document: JsonRecord): string[] => {
  const fields = new Set<string>();
  const visit = (source: unknown, prefix: string, depth: number, refs: Set<string>) => {
    if (depth > 8 || fields.size > 256 || !record(source)) return;
    const nextRefs = new Set(refs);
    if (typeof source.$ref === 'string') {
      if (nextRefs.has(source.$ref)) return;
      nextRefs.add(source.$ref);
    }
    const schema = resolveLocal(source, document);
    if (!schema) return;
    for (const variant of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(schema[variant])) for (const entry of schema[variant] as unknown[]) visit(entry, prefix, depth + 1, nextRefs);
    if (record(schema.properties)) for (const [name, value] of Object.entries(schema.properties)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      fields.add(path); visit(value, path, depth + 1, nextRefs);
    }
    if (schema.type === 'array' || schema.items) visit(schema.items, prefix ? `${prefix}.0` : '0', depth + 1, nextRefs);
  };
  visit(source, '', 0, new Set());
  return [...fields];
};

const responseFields = (entry: Operation, document: JsonRecord, errors = false): string[] => {
  const fields = new Set<string>();
  if (!record(entry.operation.responses)) return [];
  for (const [status, response] of Object.entries(entry.operation.responses)) {
    if (!(errors ? /^[45]\d\d$/u : /^2\d\d$/u).test(status)) continue;
    const resolved = resolveLocal(response, document);
    if (!resolved) continue;
    if (record(resolved.content)) for (const [contentType, content] of Object.entries(resolved.content)) {
      if (!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/iu.test(contentType) || !record(content)) continue;
      for (const field of schemaFields(content.schema, document)) fields.add(field);
    }
    for (const field of schemaFields(resolved.schema, document)) fields.add(field);
  }
  return [...fields];
};

/** Prefer explicit well-known field names, but never pick among equal nested candidates. */
const selectField = (fields: string[], names: string[]): string => {
  for (const name of names) {
    if (fields.includes(name)) return name;
    const matches = fields.filter((path) => path.endsWith(`.${name}`));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return '';
  }
  return '';
};

const serverUrl = (document: JsonRecord, entry: Operation, base: URL): URL | undefined => {
  const servers = entry.operation.servers ?? entry.item.servers ?? document.servers;
  if (Array.isArray(servers) && servers.length) {
    const valid = servers.map((server) => record(server) && typeof server.url === 'string' && !server.url.includes('{') ? safeUrl(server.url, `${base.origin}/`) : undefined)
      .filter((server): server is URL => Boolean(server) && server!.origin === base.origin);
    const unique = [...new Map(valid.map((server) => [server.toString(), server])).values()];
    return unique.length === 1 ? unique[0] : undefined;
  }
  // Swagger 2 can also declare a host; it is never allowed to redirect the connection.
  if (typeof document.host === 'string' && document.host !== base.host) return undefined;
  if (typeof document.basePath === 'string') return safeUrl(`${base.origin}${document.basePath}`);
  // Missing servers: reconcile the user's prefix with versioned paths without duplicating /v1.
  const result = new URL(base);
  const versionMatch = result.pathname.match(/^(.*)(\/v\d+(?:beta|alpha)?)(?:\/(?:videos|models))?\/?$/iu);
  if (versionMatch && entry.path.startsWith(`${versionMatch[2]}/`)) result.pathname = versionMatch[1] || '/';
  else if (result.pathname !== '/' && entry.path.startsWith(`${result.pathname.replace(/\/$/u, '')}/`)) result.pathname = '/';
  return result;
};

const operationUrl = (document: JsonRecord, entry: Operation, base: URL): string => {
  if (!entry.path.startsWith('/') || entry.path.startsWith('//') || /[?#]/u.test(entry.path)) return '';
  const server = serverUrl(document, entry, base);
  if (!server) return '';
  const url = safeUrl(`${server.toString().replace(/\/+$/u, '')}${replaceParameter(entry.path)}`);
  if (!url || url.origin !== base.origin) return '';
  // URL serialisation escapes braces; request templates require literal {id}.
  return url.toString().replace(/%7Bid%7D/giu, '{id}');
};

const identifierEndpoint = (document: JsonRecord, entry: Operation, base: URL, names: string[]): string => {
  const endpoint = operationUrl(document, entry, base);
  if (!endpoint) return '';
  if (oneParameter(entry.path)) return endpoint;
  if (entry.path.includes('{')) return '';
  const parameters = new Map<string, JsonRecord>();
  for (const source of [entry.item.parameters, entry.operation.parameters]) if (Array.isArray(source)) for (const raw of source) {
    const parameter = resolveLocal(raw, document);
    if (parameter && typeof parameter.name === 'string') parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const identifiers = [...parameters.values()].filter((parameter) => parameter.in === 'query' && typeof parameter.name === 'string' && names.includes(parameter.name));
  if (identifiers.length !== 1 || [...parameters.values()].some((parameter) => parameter.in === 'query' && parameter.required === true && parameter !== identifiers[0])) return '';
  const url = new URL(endpoint);
  url.searchParams.set(String(identifiers[0].name), '{id}');
  return url.toString().replace(/%7Bid%7D/giu, '{id}');
};

const discoverAuthentication = (document: JsonRecord, entry: Operation, warnings: string[]): Pick<VideoTaskApiConfig, 'authHeader' | 'authScheme'> | undefined => {
  const security = entry.operation.security ?? document.security;
  if (!Array.isArray(security) || !security.length) return undefined;
  const schemes: JsonRecord = record(document.components) && record(document.components.securitySchemes) ? document.components.securitySchemes : record(document.securityDefinitions) ? document.securityDefinitions : {};
  const choices: Array<Pick<VideoTaskApiConfig, 'authHeader' | 'authScheme'>> = [];
  for (const requirement of security) {
    if (!record(requirement) || Object.keys(requirement).length !== 1) continue;
    const scheme = resolveLocal(schemes[Object.keys(requirement)[0]], document);
    if (!scheme) continue;
    if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') choices.push({ authHeader: 'Authorization', authScheme: 'Bearer' });
    else if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(scheme.name)) choices.push({ authHeader: scheme.name, authScheme: '' });
  }
  const unique = [...new Map(choices.map((choice) => [JSON.stringify(choice), choice])).values()];
  if (unique.length === 1 && choices.length === security.length) return unique[0];
  warnings.push('文档认证方式不能唯一识别，请确认高级认证设置。');
  return undefined;
};

const parseDocument = (document: JsonRecord, base: URL, fallback: Partial<VideoTaskApiConfig>): { patch: Partial<VideoTaskApiConfig>; warnings: string[] } | undefined => {
  if (!record(document.paths)) return undefined;
  const operations: Operation[] = [];
  for (const [path, rawItem] of Object.entries(document.paths)) {
    const item = resolveLocal(rawItem, document);
    if (!item) continue;
    for (const method of ['get', 'post', 'delete'] as const) {
      const operation = resolveLocal(item[method], document);
      if (operation) operations.push({ path, item, operation, method });
    }
  }
  const createCandidates = operations.filter((entry) => entry.method === 'post' && !entry.path.includes('{') && !/upload|cancel|receipt|image|audio/iu.test(entry.path)
    && (/videos?(?:\/generations)?\/?$/iu.test(entry.path) || /(?:create|generate|submit).*video|video.*(?:create|generate|submit)/iu.test(String(entry.operation.operationId || ''))))
    .map((entry) => ({ entry, score: /\/videos\/?$/iu.test(entry.path) ? 2 : 1 })).filter(({ entry }) => operationUrl(document, entry, base));
  const maximum = Math.max(...createCandidates.map(({ score }) => score));
  const selected = createCandidates.filter(({ score }) => score === maximum);
  if (selected.length !== 1) return undefined;
  const submit = selected[0].entry;
  const warnings: string[] = [];
  const patch: Partial<VideoTaskApiConfig> = { ...fallback, endpoint: operationUrl(document, submit, base), taskIdPath: '', statusPath: '', resultUrlPath: '', progressPath: '', errorPath: '', statusEndpointTemplate: '' };
  const submitBase = submit.path.replace(/\/$/u, '');
  const taskEndpoint = (entry: Operation) => identifierEndpoint(document, entry, base, ['task_id', 'taskId', 'id', 'job_id', 'jobId', 'generation_id']);
  const getCandidates = operations.filter((entry) => entry.method === 'get' && !/content|download|signed_url|upload|receipt|file|cancel/iu.test(entry.path)
    && (entry.path.replace(/\/\{[^{}]+\}\/?$/u, '') === submitBase || /(?:get|query|retrieve|status).*video|video.*(?:get|query|retrieve|status)/iu.test(String(entry.operation.operationId || ''))))
    .filter(taskEndpoint);
  const direct = getCandidates.filter((entry) => entry.path.replace(/\/\{[^{}]+\}\/?$/u, '') === submitBase);
  const query = direct.length === 1 ? direct[0] : direct.length === 0 && getCandidates.length === 1 ? getCandidates[0] : undefined;
  if (query) patch.statusEndpointTemplate = taskEndpoint(query);
  else warnings.push('文档中任务查询端点不能唯一识别，请在高级设置中确认。');
  const submittedFields = responseFields(submit, document);
  const queriedFields = query ? responseFields(query, document) : [];
  patch.taskIdPath = selectField(submittedFields, ['task_id', 'taskId', 'id', 'job_id', 'jobId', 'generation_id', 'uuid', 'request_id']);
  patch.statusPath = selectField(queriedFields.length ? queriedFields : submittedFields, ['status', 'state', 'task_status', 'taskStatus', 'phase']);
  patch.resultUrlPath = selectField(queriedFields.length ? queriedFields : submittedFields, ['download_url', 'video_url', 'result_url', 'downloadUrl', 'videoUrl', 'url']);
  patch.progressPath = selectField(queriedFields.length ? queriedFields : submittedFields, ['progress', 'percentage', 'percent']);
  const errorFields = [...new Set([...responseFields(submit, document, true), ...(query ? responseFields(query, document, true) : [])])];
  patch.errorPath = selectField(errorFields, ['error.message', 'message', 'error_message', 'errorMessage']);
  if (!patch.taskIdPath || !patch.statusPath) warnings.push('部分任务结果字段不能唯一识别，请确认高级结果映射。');
  if (!patch.resultUrlPath && !/\/videos\/?$/iu.test(submit.path)) warnings.push('文档未声明可识别的视频下载地址字段，请确认高级下载映射。');
  Object.assign(patch, discoverAuthentication(document, submit, warnings));
  const fileId = selectField(queriedFields, ['file_id', 'fileId']);
  const fileEndpoint = (entry: Operation) => identifierEndpoint(document, entry, base, ['file_id', 'fileId', 'id']);
  const fileCandidates = operations.filter((entry) => entry.method === 'get' && /\/files?\//iu.test(entry.path) && fileEndpoint(entry));
  if (fileId && fileCandidates.length === 1) {
    const fileUrl = selectField(responseFields(fileCandidates[0], document), ['download_url', 'downloadUrl', 'url']);
    if (fileUrl) { patch.fileIdPath = fileId; patch.fileEndpointTemplate = fileEndpoint(fileCandidates[0]); patch.fileUrlPath = fileUrl; }
  }
  // Only operations with no nonempty request body are representable by the existing cancellation transport.
  const cancelCandidates = operations.filter((entry) => oneParameter(entry.path) && operationUrl(document, entry, base)
    && (entry.method === 'delete' && query && entry.path === query.path || entry.method === 'post' && entry.path.startsWith(`${submitBase}/`) && /\/cancel\/?$/iu.test(entry.path)))
    .filter((entry) => !entry.operation.requestBody && (!Array.isArray(entry.operation.parameters) || !(entry.operation.parameters as unknown[]).some((value) => record(value) && value.in === 'body' && value.required)));
  if (cancelCandidates.length === 1) { patch.cancelEndpointTemplate = operationUrl(document, cancelCandidates[0], base); patch.cancelMethod = cancelCandidates[0].method === 'delete' ? 'DELETE' : 'POST'; }
  return { patch, warnings };
};

/** Discover only the current connection. Models remain complete and the user's chosen model is never changed. */
export async function discoverGenericVideoApi(
  config: VideoTaskApiConfig,
  options: { signal?: AbortSignal; allowPrivateNetwork?: boolean } = {},
): Promise<GenericVideoApiDiscovery> {
  if (options.signal?.aborted) throw abortError();
  const base = safeUrl(genericVideoApiBaseUrl(config));
  if (!base) throw new Error('请填写有效的 API 地址。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) controller.abort();
    const { models, body } = await fetchGenericVideoModelMetadata(config, { ...options, signal: controller.signal });
    const fallback = standardPatch(config);
    const versioned = new URL(genericVideoApiEndpoints({ ...config, baseUrl: genericVideoApiBaseUrl(config), endpoint: '', statusEndpointTemplate: '' }).models);
    const unversionedPath = base.pathname.replace(/\/(?:v\d+(?:beta|alpha)?)(?:\/(?:videos|models))?\/?$/iu, '').replace(/\/+$/u, '');
    const candidates = [...new Set([
      `${base.origin}${unversionedPath}/openapi.json`,
      `${versioned.origin}${versioned.pathname.replace(/\/models\/?$/u, '')}/openapi.json`,
      `${base.origin}/docs/video-api/openapi.json`,
      ...(unversionedPath ? [`${base.origin}/openapi.json`] : []),
    ])].map((url) => new URL(url));
    const documents = await Promise.all(candidates.map((url) => getDocument(url, config, controller.signal))).catch((error: unknown) => {
      // An optional specification timing out must not discard a model list already received.
      if (timedOut && !options.signal?.aborted) return [];
      throw error;
    });
    const metadata = parseVideoApiModelMetadata(body);
    for (const [index, document] of documents.entries()) if (record(document)) {
      const discovered = parseDocument(document, base, fallback);
      if (discovered) {
        const finalConfig = { ...config, ...discovered.patch };
        const specification = parseVideoApiOpenApiCapabilities(document, [...models, config.model || '']);
        discovered.patch.parameterCapabilities = {
          ...mergeVideoApiParameterCapabilities(metadata, specification), scope: videoApiCapabilityScope(finalConfig), fetchedAt: Date.now(),
          source: Object.keys(metadata.models).length ? 'mixed' : 'openapi', sourceUrl: candidates[index].toString(),
        };
        return { models, ...discovered, source: 'openapi', message: `已获取 ${models.length} 个模型，并按当前网站 OpenAPI 文档补齐接口配置及模型参数。${discovered.warnings.length ? '部分字段需要在高级设置中确认。' : '请选择要使用的模型。'}` };
      }
    }
    const warnings = [documents.some(record) ? '已找到文档，但视频协议不能唯一识别；已补齐标准兼容配置，请确认高级设置。' : '未找到可用 OpenAPI 文档；已补齐标准兼容配置，非标准接口请调整高级设置。'];
    fallback.parameterCapabilities = { ...metadata, scope: videoApiCapabilityScope({ ...config, ...fallback }), source: 'models', fetchedAt: Date.now(), sourceUrl: versioned.toString() };
    return { models, patch: fallback, source: 'standard', warnings, message: `已获取 ${models.length} 个模型。${warnings[0]}请选择要使用的模型。` };
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (timedOut) throw new Error('自动获取超时，请检查 API 地址与网络后重试。');
    if (isAbort(error)) throw abortError();
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

/** Read display-only constraints without modifying protocol, model, parameters or starting a task. */
export async function refreshGenericVideoParameterCapabilities(
  config: VideoTaskApiConfig,
  options: { signal?: AbortSignal; allowPrivateNetwork?: boolean } = {},
): Promise<VideoApiParameterCapabilities> {
  if (options.signal?.aborted) throw abortError();
  const base = safeUrl(genericVideoApiBaseUrl(config));
  if (!base) throw new Error('请填写有效的 API 地址。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) controller.abort();
    const versioned = new URL(genericVideoApiEndpoints(config).models);
    const unversionedPath = base.pathname.replace(/\/(?:v\d+(?:beta|alpha)?)(?:\/(?:videos|models))?\/?$/iu, '').replace(/\/+$/u, '');
    const candidates = [...new Set([
      `${base.origin}${unversionedPath}/openapi.json`, `${versioned.origin}${versioned.pathname.replace(/\/models\/?$/u, '')}/openapi.json`,
      `${base.origin}/docs/video-api/openapi.json`, ...(unversionedPath ? [`${base.origin}/openapi.json`] : []),
    ])].map((url) => new URL(url));
    const [modelsResult, documents] = await Promise.all([
      fetchGenericVideoModelMetadata(config, { ...options, signal: controller.signal }).then((value) => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error })),
      Promise.all(candidates.map((url) => getDocument(url, config, controller.signal))),
    ]);
    if (options.signal?.aborted) throw abortError();
    const metadata = parseVideoApiModelMetadata(modelsResult.value?.body);
    const ids = [...(modelsResult.value?.models || []), config.model || ''];
    const specifications: Array<{ parsed: ReturnType<typeof parseVideoApiOpenApiCapabilities>; index: number }> = [];
    // Documents declaring another host are not evidence about the configured connection.
    for (const [index, document] of documents.entries()) if (record(document) && parseDocument(document, base, standardPatch(config))?.patch.endpoint === genericVideoApiEndpoints(config).submit) {
      const parsed = parseVideoApiOpenApiCapabilities(document, ids);
      if (Object.keys(parsed.models).length || parsed.common) specifications.push({ parsed, index });
    }
    const specification = specifications[0];
    if (!modelsResult.value && !specification) {
      if (timedOut) throw new Error('读取模型参数超时，请检查 API 地址与网络后重试。');
      throw modelsResult.error instanceof Error ? modelsResult.error : new Error('未读取到模型参数，请检查 API 地址与网络后重试。');
    }
    const merged = mergeVideoApiParameterCapabilities(metadata, specification?.parsed || { models: {} });
    return {
      ...merged, scope: videoApiCapabilityScope(config), fetchedAt: Date.now(),
      source: specification ? Object.keys(metadata.models).length ? 'mixed' : 'openapi' : 'models',
      sourceUrl: specification ? candidates[specification.index].toString() : versioned.toString(),
    };
  } catch (error) {
    if (options.signal?.aborted || isAbort(error) && !timedOut) throw abortError();
    if (timedOut) throw new Error('读取模型参数超时，请检查 API 地址与网络后重试。');
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}
