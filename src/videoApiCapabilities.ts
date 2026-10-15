import type { VideoTaskApiConfig } from './types';
import type { VideoApiModelParameterCapabilities, VideoApiParameterCapabilities, VideoApiParameterControl } from './videoApiCapabilityTypes';
import { genericVideoApiBaseUrl, genericVideoApiEndpoints } from './genericVideoApi';

type JsonRecord = Record<string, unknown>;
type Parameter = 'duration' | 'aspect_ratio' | 'resolution';
type Scalar = string | number;
type Constraint = { type?: string; values?: Scalar[]; min?: number; max?: number; step?: number; default?: Scalar; description?: string };
type Variant = { properties: Record<string, unknown[]>; required: Set<string> };
const fields: Record<Parameter, string[]> = { duration: ['duration', 'seconds', 'duration_seconds'], aspect_ratio: ['aspect_ratio', 'ratio'], resolution: ['resolution'] };
const parameters = Object.keys(fields) as Parameter[];
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): value is Scalar => typeof value === 'string' && value.length <= 200 || typeof value === 'number' && Number.isFinite(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const imageCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const unique = (values: Scalar[]): Scalar[] => [...new Map(values.map((value) => [String(value), value])).values()];
const MAX_VARIANTS = 64;
const owns = (value: object, name: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, name);

/** Imported UI metadata is untrusted; damaged caches fall back to manual inputs. */
const normalizeModelCapabilities = (source: unknown): VideoApiModelParameterCapabilities | undefined => {
  if (!record(source) || !record(source.controls)) return undefined;
  const controls: VideoApiModelParameterCapabilities['controls'] = {};
  const defaults: VideoApiModelParameterCapabilities['defaults'] = {};
  for (const parameter of parameters) {
    const raw = source.controls[parameter];
    if (!record(raw) || !['number', 'select', 'text'].includes(String(raw.kind))) continue;
    if (raw.options !== undefined && (!Array.isArray(raw.options) || raw.options.length > 256 || raw.options.some((value) => typeof value !== 'string' || value.length > 200))) continue;
    if (raw.kind === 'select' && (!Array.isArray(raw.options) || !raw.options.length)) continue;
    if (raw.min !== undefined && !finite(raw.min) || raw.max !== undefined && !finite(raw.max) || raw.step !== undefined && (!finite(raw.step) || raw.step <= 0)) continue;
    if (finite(raw.min) && finite(raw.max) && raw.min > raw.max) continue;
    const normalized: VideoApiParameterControl = {
      kind: raw.kind as VideoApiParameterControl['kind'],
      ...(Array.isArray(raw.options) ? { options: [...raw.options] as string[] } : {}),
      ...(finite(raw.min) ? { min: raw.min } : {}), ...(finite(raw.max) ? { max: raw.max } : {}), ...(finite(raw.step) ? { step: raw.step } : {}),
      ...(typeof raw.restricted === 'boolean' ? { restricted: raw.restricted } : {}), ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 1000) } : {}),
      ...(raw.source === 'models' || raw.source === 'openapi' ? { source: raw.source } : {}),
    };
    controls[parameter] = normalized;
    if (record(source.defaults) && scalar(source.defaults[parameter])) defaults[parameter] = source.defaults[parameter];
  }
  const rawImages = source.imageReferences;
  const imageReferences = record(rawImages) && imageCount(rawImages.maxCount) && ['openapi', 'models'].includes(String(rawImages.source))
    && (rawImages.field === undefined || typeof rawImages.field === 'string' && rawImages.field.length <= 200)
    ? { maxCount: rawImages.maxCount, source: rawImages.source as 'openapi' | 'models', ...(typeof rawImages.field === 'string' ? { field: rawImages.field } : {}) } : undefined;
  if (!Object.keys(controls).length && !imageReferences) return undefined;
  return { controls, defaults, ...(imageReferences ? { imageReferences } : {}), ...(Array.isArray(source.aliases) ? { aliases: source.aliases.filter((value): value is string => typeof value === 'string' && value.length <= 200).slice(0, 64) } : {}) };
};

/** A capability belongs to the complete saved address/protocol, not to a model name alone. */
export const videoApiCapabilityScope = (config: Partial<VideoTaskApiConfig>): string => {
  const normalized = { baseUrl: config.baseUrl, endpoint: config.endpoint || '', statusEndpointTemplate: config.statusEndpointTemplate || '', provider: config.provider };
  const canonical = (value: string) => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${url.search}`; } catch { return value.trim().replace(/\/+$/u, ''); } };
  const endpoints = genericVideoApiEndpoints(normalized);
  return JSON.stringify([canonical(genericVideoApiBaseUrl(normalized)), canonical(endpoints.submit), canonical(endpoints.status)]);
};

export const getVideoApiModelParameterCapabilities = (config: Partial<VideoTaskApiConfig>): VideoApiModelParameterCapabilities | undefined => {
  const capabilities = config.parameterCapabilities;
  if (!record(capabilities) || capabilities.scope !== videoApiCapabilityScope(config) || !record(capabilities.models)) return undefined;
  const model = config.model?.trim() || '';
  if (model && owns(capabilities.models, model)) return normalizeModelCapabilities(capabilities.models[model]);
  const aliases = model ? Object.values(capabilities.models).map(normalizeModelCapabilities).filter((entry) => entry?.aliases?.includes(model)) : [];
  return aliases.length === 1 ? aliases[0] : aliases.length ? undefined : normalizeModelCapabilities(capabilities.common);
};

const resolve = (source: unknown, document: JsonRecord, visited = new Set<string>()): JsonRecord | undefined => {
  if (!record(source)) return undefined;
  if (typeof source.$ref !== 'string') return source;
  if (!source.$ref.startsWith('#/') || visited.has(source.$ref)) return undefined;
  visited.add(source.$ref);
  let target: unknown = document;
  for (const part of source.$ref.slice(2).split('/')) {
    const name = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!record(target) || !owns(target, name)) return undefined;
    target = target[name];
  }
  const resolved = resolve(target, document, visited);
  if (!resolved) return undefined;
  // OpenAPI 3.1 permits siblings on refs. Preserve these constraints rather than silently replacing them.
  const siblings = Object.fromEntries(Object.entries(source).filter(([name]) => name !== '$ref'));
  return Object.keys(siblings).length ? { allOf: [resolved, siblings] } : resolved;
};

const allowedValues = (schema: JsonRecord): Scalar[] | undefined => scalar(schema.const) ? [schema.const]
  : Array.isArray(schema.enum) && schema.enum.length <= 256 && schema.enum.every(scalar) ? unique(schema.enum) : undefined;
const commonStep = (left?: number, right?: number): number | undefined => {
  if (!left || !right) return left || right;
  for (let scale = 1; scale <= 1_000_000; scale *= 10) {
    const a = Math.round(left * scale), b = Math.round(right * scale);
    if (Math.abs(left * scale - a) > 1e-8 || Math.abs(right * scale - b) > 1e-8) continue;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0) return undefined;
    let x = a, y = b;
    while (y) { const next = x % y; x = y; y = next; }
    const common = a / x * b;
    return Number.isSafeInteger(common) ? common / scale : undefined;
  }
  return undefined;
};
const alignRange = (constraint: Constraint): Constraint => {
  if (!constraint.step || constraint.step <= 0) return constraint;
  return {
    ...constraint,
    ...(constraint.min !== undefined ? { min: Number((Math.ceil(constraint.min / constraint.step - 1e-10) * constraint.step).toPrecision(12)) } : {}),
    ...(constraint.max !== undefined ? { max: Number((Math.floor(constraint.max / constraint.step + 1e-10) * constraint.step).toPrecision(12)) } : {}),
  };
};
const mergeConstraint = (left: Constraint, right: Constraint): Constraint => {
  const values = left.values && right.values ? left.values.filter((value) => right.values!.some((other) => String(other) === String(value))) : left.values || right.values;
  const result: Constraint = {
    ...left, ...right,
    ...(values ? { values } : {}),
    ...(left.min !== undefined || right.min !== undefined ? { min: Math.max(left.min ?? -Infinity, right.min ?? -Infinity) } : {}),
    ...(left.max !== undefined || right.max !== undefined ? { max: Math.min(left.max ?? Infinity, right.max ?? Infinity) } : {}),
    ...(left.step || right.step ? { step: commonStep(left.step, right.step) } : {}),
  };
  if (result.values) result.values = result.values.filter((value) => typeof value !== 'number' || (result.min === undefined || value >= result.min) && (result.max === undefined || value <= result.max));
  return alignRange(result);
};
const unionConstraints = (entries: Constraint[]): Constraint | undefined => {
  if (!entries.length) return undefined;
  if (entries.length === 1) return entries[0];
  const first = entries[0];
  const result: Constraint = { ...(entries.every((entry) => entry.type === first.type) ? { type: first.type } : {}), ...(first.description ? { description: first.description } : {}) };
  if (entries.every((entry) => entry.values)) result.values = unique(entries.flatMap((entry) => entry.values || []));
  if (entries.every((entry) => entry.min !== undefined)) result.min = Math.min(...entries.map((entry) => entry.min!));
  if (entries.every((entry) => entry.max !== undefined)) result.max = Math.max(...entries.map((entry) => entry.max!));
  if (entries.every((entry) => entry.step === first.step)) result.step = first.step;
  if (first.default !== undefined && entries.every((entry) => entry.default === first.default)) result.default = first.default;
  return result;
};
const propertyConstraint = (source: unknown, document: JsonRecord, depth = 0): Constraint | undefined => {
  if (depth > 12) return undefined;
  const schema = resolve(source, document);
  if (!schema) return undefined;
  const type = typeof schema.type === 'string' ? schema.type : Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : undefined;
  let result: Constraint = {
    ...(typeof type === 'string' ? { type } : {}), ...(allowedValues(schema) ? { values: allowedValues(schema) } : {}),
    ...(finite(schema.minimum) ? { min: schema.minimum } : {}), ...(finite(schema.maximum) ? { max: schema.maximum } : {}),
    ...(type === 'integer' || finite(schema.multipleOf) && schema.multipleOf > 0 ? { step: commonStep(type === 'integer' ? 1 : undefined, finite(schema.multipleOf) && schema.multipleOf > 0 ? schema.multipleOf : undefined) } : {}),
    ...(scalar(schema.default) ? { default: schema.default } : {}), ...(typeof schema.description === 'string' ? { description: schema.description.slice(0, 1000) } : {}),
  };
  if (finite(schema.exclusiveMinimum) && type === 'integer') result.min = Math.floor(schema.exclusiveMinimum) + 1;
  if (finite(schema.exclusiveMaximum) && type === 'integer') result.max = Math.ceil(schema.exclusiveMaximum) - 1;
  if (schema.exclusiveMinimum === true && result.min !== undefined && type === 'integer') result.min += 1;
  if (schema.exclusiveMaximum === true && result.max !== undefined && type === 'integer') result.max -= 1;
  if (Array.isArray(schema.allOf)) for (const entry of schema.allOf.slice(0, MAX_VARIANTS)) {
    const constraint = propertyConstraint(entry, document, depth + 1);
    if (constraint) result = mergeConstraint(result, constraint);
  }
  for (const variant of ['oneOf', 'anyOf']) if (Array.isArray(schema[variant])) {
    const branches = schema[variant] as unknown[];
    const parsed = branches.slice(0, MAX_VARIANTS).map((entry) => propertyConstraint(entry, document, depth + 1));
    // Unresolved or too many branches must never create a false enum/range restriction.
    if (branches.length > MAX_VARIANTS || parsed.some((entry) => !entry)) return {};
    const combined = unionConstraints(parsed.filter((entry): entry is Constraint => Boolean(entry)));
    if (combined) result = mergeConstraint(result, combined);
  }
  return alignRange(result);
};

const modelValues = (source: unknown, document: JsonRecord): string[] | undefined => {
  const constraint = propertyConstraint(source, document);
  return constraint?.values?.filter((value): value is string => typeof value === 'string');
};
const mergeVariants = (left: Variant, right: Variant): Variant => {
  const properties = { ...left.properties };
  for (const [name, entries] of Object.entries(right.properties)) properties[name] = [...(properties[name] || []), ...entries];
  return { properties, required: new Set([...left.required, ...right.required]) };
};
/** Only model-only conditions can be applied without knowing the draft's other parameters. */
const conditionMatchesModel = (source: unknown, document: JsonRecord, model: string): boolean | undefined => {
  const condition = resolve(source, document);
  if (!condition) return undefined;
  if (!record(condition.properties) || !owns(condition.properties, 'model') || Object.keys(condition.properties).some((name) => name !== 'model')) return undefined;
  if (Array.isArray(condition.required) && condition.required.some((name) => name !== 'model')) return undefined;
  const allowed = modelValues(condition.properties.model, document);
  return allowed ? allowed.includes(model) : undefined;
};
const expand = (source: unknown, document: JsonRecord, model: string, depth = 0): Variant[] => {
  if (depth > 12) return [];
  const schema = resolve(source, document);
  if (!schema) return [];
  const properties = record(schema.properties) ? schema.properties : {};
  const allowed = owns(properties, 'model') ? modelValues(properties.model, document) : undefined;
  if (allowed && !allowed.includes(model)) return [];
  let variants: Variant[] = [{ properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, [value]])), required: new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []) }];
  const combine = (branches: Variant[]) => { if (!branches.length || variants.length * branches.length > MAX_VARIANTS) { variants = []; return; } variants = variants.flatMap((left) => branches.map((right) => mergeVariants(left, right))); };
  if (Array.isArray(schema.allOf)) for (const entry of schema.allOf.slice(0, MAX_VARIANTS)) combine(expand(entry, document, model, depth + 1));
  for (const key of ['oneOf', 'anyOf']) if (Array.isArray(schema[key])) {
    const branches = schema[key] as unknown[];
    if (branches.length > MAX_VARIANTS) return [];
    const expanded: Variant[] = [];
    for (const entry of branches) {
      const variants = expand(entry, document, model, depth + 1);
      if (!variants.length) {
        const names = modelNames(entry, document);
        // An unresolved alternative may support this model with other limits; do not silently drop it.
        if (!names.size || names.has(model)) return [];
      }
      expanded.push(...variants);
    }
    combine(expanded);
  }
  if (schema.if) {
    const match = conditionMatchesModel(schema.if, document, model);
    if (match === true && schema.then) combine(expand(schema.then, document, model, depth + 1));
    else if (match === false && schema.else) combine(expand(schema.else, document, model, depth + 1));
  }
  return variants;
};

const control = (constraint: Constraint, source: 'openapi' | 'models', required: boolean): VideoApiParameterControl | undefined => {
  if (constraint.values && !constraint.values.length || constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max) return undefined;
  const numeric = constraint.type === 'integer' || constraint.type === 'number' || constraint.min !== undefined || constraint.max !== undefined;
  return {
    kind: constraint.values ? 'select' : numeric ? 'number' : 'text', source, required,
    restricted: Boolean(constraint.values),
    ...(constraint.values ? { options: constraint.values.map(String) } : {}),
    ...(constraint.min !== undefined ? { min: constraint.min } : {}), ...(constraint.max !== undefined ? { max: constraint.max } : {}),
    ...(constraint.step !== undefined ? { step: constraint.step } : {}), ...(constraint.description ? { description: constraint.description } : {}),
  };
};

/** Count only an unconditional predicate identifying every image reference.
 * A predicate for audio, a particular role, or another subset is not an image capacity. */
const imageContainsPredicate = (source: unknown, document: JsonRecord): boolean => {
  const safePredicate = (source: unknown, depth = 0): boolean => {
    if (depth > 12) return false;
    const schema = resolve(source, document);
    if (!schema || schema.type !== undefined && schema.type !== 'object') return false;
    const permitted = new Set(['type', 'properties', 'required', 'allOf', 'oneOf', 'anyOf', 'description', 'title']);
    if (Object.keys(schema).some((key) => !permitted.has(key))) return false;
    if (schema.properties !== undefined && (!record(schema.properties) || Object.keys(schema.properties).some((key) => key !== 'type'))) return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => key !== 'type'))) return false;
    if (record(schema.properties) && owns(schema.properties, 'type')) {
      const type = resolve(schema.properties.type, document);
      if (!type || Object.keys(type).some((key) => !['type', 'const', 'enum', 'description', 'title'].includes(key))) return false;
    }
    return ['allOf', 'oneOf', 'anyOf'].every((key) => schema[key] === undefined || Array.isArray(schema[key])
      && (schema[key] as unknown[]).length <= MAX_VARIANTS && (schema[key] as unknown[]).every((entry) => safePredicate(entry, depth + 1)));
  };
  if (!safePredicate(source)) return false;
  const variants = expand(source, document, '');
  return Boolean(variants.length) && variants.every((variant) => {
    if (!variant.required.has('type') || !variant.properties.type) return false;
    const constraints = variant.properties.type.map((entry) => propertyConstraint(entry, document));
    if (constraints.some((entry) => !entry)) return false;
    const constraint = constraints.reduce<Constraint>((merged, entry) => mergeConstraint(merged, entry!), {});
    return constraint.values?.length === 1 && constraint.values[0] === 'image';
  });
};

const imageArrayMaximum = (source: unknown, document: JsonRecord, field: 'images' | 'references', depth = 0): number | undefined => {
  if (depth > 12) return undefined;
  const schema = resolve(source, document);
  if (!schema || schema.type !== undefined && schema.type !== 'array') return undefined;
  const limits: number[] = [];
  if (field === 'images' && imageCount(schema.maxItems)) limits.push(schema.maxItems);
  if (field === 'references' && imageCount(schema.maxContains) && imageContainsPredicate(schema.contains, document)) limits.push(schema.maxContains);
  if (Array.isArray(schema.allOf)) {
    if (schema.allOf.length > MAX_VARIANTS) return undefined;
    for (const entry of schema.allOf) {
      const maximum = imageArrayMaximum(entry, document, field, depth + 1);
      if (maximum !== undefined) limits.push(maximum);
    }
  }
  for (const key of ['oneOf', 'anyOf']) if (Array.isArray(schema[key])) {
    const branches = schema[key] as unknown[];
    if (!branches.length || branches.length > MAX_VARIANTS) return undefined;
    const maxima = branches.map((entry) => imageArrayMaximum(entry, document, field, depth + 1));
    if (maxima.some((maximum) => maximum === undefined)) return undefined;
    limits.push(Math.max(...(maxima as number[])));
  }
  // maxItems on a mixed-media array is a total, never evidence of an image
  // capacity by itself. It may only tighten an explicit image maxContains.
  if (field === 'references' && limits.length) {
    const totalMaximum = imageArrayMaximum(source, document, 'images', depth);
    if (totalMaximum !== undefined) limits.push(totalMaximum);
  }
  return limits.length ? Math.min(...limits) : undefined;
};

const parseImageReferences = (variants: Variant[], document: JsonRecord, source: 'openapi' | 'models'): VideoApiModelParameterCapabilities['imageReferences'] => {
  const entries = variants.map((variant) => {
    const candidates = (['images', 'references'] as const).flatMap((field) => {
      const limits = (variant.properties[field] || []).map((entry) => imageArrayMaximum(entry, document, field)).filter(imageCount);
      return limits.length ? [{ field, maxCount: Math.min(...limits) }] : [];
    });
    // Two independent image arrays do not declare a combined slot capacity.
    return candidates.length === 1 ? candidates[0] : undefined;
  });
  if (!entries.length || entries.some((entry) => !entry || entry.field !== entries[0]?.field)) return undefined;
  const known = entries as Array<{ field: 'images' | 'references'; maxCount: number }>;
  return { maxCount: Math.max(...known.map((entry) => entry.maxCount)), source, field: known[0].field };
};

const parseVariants = (variants: Variant[], document: JsonRecord, source: 'openapi' | 'models'): VideoApiModelParameterCapabilities => {
  const result: VideoApiModelParameterCapabilities = { controls: {}, defaults: {} };
  const imageReferences = parseImageReferences(variants, document, source);
  if (imageReferences) result.imageReferences = imageReferences;
  for (const parameter of parameters) {
    const entries = variants.map((variant) => {
      const name = fields[parameter].find((name) => variant.properties[name]);
      if (!name) return undefined;
      const constraints = variant.properties[name].map((schema) => propertyConstraint(schema, document));
      if (constraints.some((constraint) => !constraint)) return undefined;
      return { constraint: constraints.reduce<Constraint>((merged, constraint) => mergeConstraint(merged, constraint!), {}), required: variant.required.has(name) };
    });
    // Any alternative that does not declare a parameter makes its restrictions unknown.
    if (!entries.length || entries.some((entry) => !entry)) continue;
    const parsed = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const constraint = unionConstraints(parsed.map((entry) => entry.constraint));
    if (!constraint) continue;
    const fieldControl = control(constraint, source, parsed.every((entry) => entry.required));
    if (fieldControl) result.controls[parameter] = fieldControl;
    if (constraint.default !== undefined) result.defaults[parameter] = constraint.default;
  }
  return result;
};

const modelNames = (source: unknown, document: JsonRecord, output = new Set<string>(), depth = 0): Set<string> => {
  if (depth > 12 || output.size > 512) return output;
  const schema = resolve(source, document);
  if (!schema) return output;
  if (record(schema.properties)) for (const name of modelValues(schema.properties.model, document) || []) output.add(name);
  for (const key of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(schema[key])) for (const branch of (schema[key] as unknown[]).slice(0, MAX_VARIANTS)) modelNames(branch, document, output, depth + 1);
  if (schema.if) modelNames(schema.if, document, output, depth + 1);
  return output;
};
const hasCapabilities = (entry: VideoApiModelParameterCapabilities): boolean => Object.keys(entry.controls).length > 0 || Boolean(entry.imageReferences);

/** Parse a JSON request schema only; never crawl the historical component definitions. */
export const parseVideoApiRequestSchemaCapabilities = (schema: unknown, document: JsonRecord, ids: string[] = []): Pick<VideoApiParameterCapabilities, 'models' | 'common'> => {
  const declared = [...modelNames(schema, document)];
  const models: Record<string, VideoApiModelParameterCapabilities> = Object.create(null) as Record<string, VideoApiModelParameterCapabilities>;
  for (const id of [...new Set([...ids, ...declared])].slice(0, 512)) {
    const capability = parseVariants(expand(schema, document, id), document, 'openapi');
    if (hasCapabilities(capability)) models[id] = capability;
  }
  const common = declared.length ? undefined : parseVariants(expand(schema, document, ''), document, 'openapi');
  return { models, ...(common && hasCapabilities(common) ? { common } : {}) };
};

export const parseVideoApiOpenApiCapabilities = (document: unknown, ids: string[] = [], submitPath?: string): Pick<VideoApiParameterCapabilities, 'models' | 'common'> => {
  if (!record(document) || !record(document.paths)) return { models: {} };
  const candidates = Object.entries(document.paths).filter(([path, item]) => record(item) && record(item.post) && !path.includes('{') && !/upload|cancel|image|audio/iu.test(path)
    && (submitPath ? path === submitPath : /videos?(?:\/generations)?\/?$/iu.test(path) || /(?:create|generate|submit).*video|video.*(?:create|generate|submit)/iu.test(String((item.post as JsonRecord).operationId || ''))));
  const standard = submitPath ? candidates : candidates.filter(([path]) => /\/videos\/?$/iu.test(path));
  const selected = standard.length ? standard : candidates;
  if (selected.length !== 1) return { models: {} };
  const operation = (selected[0][1] as JsonRecord).post as JsonRecord;
  const body = resolve(operation.requestBody, document);
  const jsonContent = body && record(body.content) ? Object.entries(body.content).filter(([name, item]) => /^application\/(?:[\w.+-]*\+)?json(?:;|$)/iu.test(name) && record(item)) : [];
  if (jsonContent.length === 1) return parseVideoApiRequestSchemaCapabilities((jsonContent[0][1] as JsonRecord).schema, document, ids);
  const legacy = Array.isArray(operation.parameters) ? operation.parameters.map((item) => resolve(item, document)).filter((item) => item?.in === 'body') : [];
  return legacy.length === 1 ? parseVideoApiRequestSchemaCapabilities(legacy[0]?.schema, document, ids) : { models: {} };
};

/** Recognized, explicitly structured metadata only. A model ID or an example is not evidence of a limit. */
export const parseVideoApiModelMetadata = (body: unknown): Pick<VideoApiParameterCapabilities, 'models'> => {
  const entries = Array.isArray(body) ? body : record(body) && Array.isArray(body.data) ? body.data : record(body) && Array.isArray(body.models) ? body.models : [];
  const models: Record<string, VideoApiModelParameterCapabilities> = Object.create(null) as Record<string, VideoApiModelParameterCapabilities>;
  for (const raw of entries.slice(0, 512)) {
    if (!record(raw)) continue;
    const id = [raw.id, raw.name, raw.model].find((value) => typeof value === 'string' && value.trim());
    if (typeof id !== 'string') continue;
    const containers = [raw, raw.capabilities, raw.parameters, raw.constraints, raw.metadata].filter(record);
    const metadata: JsonRecord = Object.assign({}, ...containers);
    const capability: VideoApiModelParameterCapabilities = { controls: {}, defaults: {} };
    const arrayImages = parseImageReferences([{ properties: Object.fromEntries(['images', 'references'].filter((field) => owns(metadata, field)).map((field) => [field, [metadata[field]]])), required: new Set() }], metadata, 'models');
    const explicitCounts = ['max_images', 'max_reference_images'].map((field) => metadata[field]).filter(imageCount);
    if (arrayImages) capability.imageReferences = { ...arrayImages, maxCount: Math.min(arrayImages.maxCount, ...explicitCounts) };
    else if (explicitCounts.length) capability.imageReferences = { maxCount: Math.min(...explicitCounts), source: 'models' };
    for (const parameter of parameters) {
      const aliases = fields[parameter];
      let schema = aliases.map((name) => metadata[name]).find(record);
      const plural = parameter === 'duration' ? ['supported_durations', 'durations', 'supported_seconds'] : parameter === 'resolution' ? ['supported_resolutions', 'resolutions'] : ['supported_aspect_ratios', 'aspect_ratios', 'supported_ratios', 'ratios'];
      const values = [...aliases, ...plural].map((name) => metadata[name]).find((value) => Array.isArray(value) && value.length && value.length <= 256 && value.every(scalar));
      if (Array.isArray(values)) schema = { ...(schema || {}), enum: values };
      if (!schema && parameter === 'duration' && (finite(metadata.min_duration) || finite(metadata.max_duration))) schema = { type: 'number', ...(finite(metadata.min_duration) ? { minimum: metadata.min_duration } : {}), ...(finite(metadata.max_duration) ? { maximum: metadata.max_duration } : {}) };
      if (!schema) continue;
      // Metadata often uses UI spellings for the same explicit numeric boundaries.
      schema = { ...schema, ...(finite(schema.min) && !finite(schema.minimum) ? { minimum: schema.min } : {}), ...(finite(schema.max) && !finite(schema.maximum) ? { maximum: schema.max } : {}), ...(Array.isArray(schema.options) && !schema.enum ? { enum: schema.options } : {}) };
      const parsed = propertyConstraint(schema, schema);
      if (!parsed || !parsed.type && !parsed.values && parsed.min === undefined && parsed.max === undefined) continue;
      const fieldControl = control(parsed, 'models', schema.required === true);
      if (fieldControl) capability.controls[parameter] = fieldControl;
      if (parsed.default !== undefined) capability.defaults[parameter] = parsed.default;
    }
    if (Array.isArray(raw.aliases)) capability.aliases = raw.aliases.filter((value): value is string => typeof value === 'string').slice(0, 64);
    if (hasCapabilities(capability)) models[id.trim()] = capability;
  }
  return { models };
};

export const mergeVideoApiParameterCapabilities = (metadata: Pick<VideoApiParameterCapabilities, 'models' | 'common'>, specification: Pick<VideoApiParameterCapabilities, 'models' | 'common'>): Pick<VideoApiParameterCapabilities, 'models' | 'common'> => {
  const models: Record<string, VideoApiModelParameterCapabilities> = Object.assign(Object.create(null) as Record<string, VideoApiModelParameterCapabilities>, metadata.models);
  for (const [id, entry] of Object.entries(specification.models)) {
    const previous = models[id];
    models[id] = { ...previous, ...entry, controls: { ...previous?.controls, ...entry.controls }, defaults: { ...previous?.defaults, ...entry.defaults } };
  }
  return { models, ...(specification.common || metadata.common ? { common: specification.common || metadata.common } : {}) };
};
