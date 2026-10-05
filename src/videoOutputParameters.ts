import type { VideoTaskApiConfig } from './types';
import type { ComfyVideoWorkflowPreset, VideoGenerationSource } from './videoGenerationTypes';
import type { RunningHubVideoFieldControl } from './runningHubVideoTypes';

export const videoOutputParameterKeys = ['duration', 'aspect_ratio', 'resolution', 'width', 'height'] as const;
export type VideoOutputParameterKey = typeof videoOutputParameterKeys[number];

export const isVideoOutputParameterKey = (key: string): key is VideoOutputParameterKey =>
  (videoOutputParameterKeys as readonly string[]).includes(key);

/** Capabilities come from explicit mappings, never node names or current override values. */
export const availableVideoParameterKeys = (
  source: VideoGenerationSource,
  api?: Pick<VideoTaskApiConfig, 'provider' | 'runningHubMappedFields' | 'requestTemplate'>,
  workflow?: Pick<ComfyVideoWorkflowPreset, 'mapping'>,
): string[] => {
  if (source === 'comfyui') return Object.keys(workflow?.mapping.parameters || {});
  if (source === 'api' && api?.provider === 'rhtv_web') return ['duration', 'resolution'];
  if (source === 'runninghub' || api?.provider === 'runninghub' && Array.isArray(api.runningHubMappedFields)) return [...new Set(
    (api?.runningHubMappedFields || []).flatMap((field) => field.kind === 'parameter' && field.parameter ? [field.parameter] : []),
  )];
  if (api?.provider === 'runninghub') {
    // The older Video API template route has no mapping records. Expose only
    // placeholders that its existing expansion protocol will actually replace.
    const found = new Set<string>();
    const visit = (value: unknown) => {
      if (typeof value === 'string') {
        for (const match of value.matchAll(/\{\{(duration|aspect_ratio|resolution|width|height|seed)\}\}/gu)) found.add(match[1]);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    try { visit(JSON.parse(api.requestTemplate || '{}')); } catch { /* A damaged template exposes no capabilities. */ }
    return [...found];
  }
  return ['duration', 'resolution', 'seed'];
};

export const readVideoParameterText = (text: string): { value: Record<string, unknown>; issue: string } => {
  // Inspect number tokens before JSON.parse can round them. JSON strings (including
  // escaped quotes/backslashes and nested string values) are opaque and skipped.
  const tokens = text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu);
  for (const token of tokens) {
    if (!token[1]) continue;
    const value = Number(token[1]);
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return { value: {}, issue: '参数 JSON 含超出安全精度的数字。请按接口要求给长数加双引号改为字符串；原文本已保留，尚未提交。' };
    }
  }
  try {
    const parsed: unknown = JSON.parse(text.trim() ? text : '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象');
    return { value: parsed as Record<string, unknown>, issue: '' };
  } catch {
    return { value: {}, issue: '参数 JSON 不是有效对象，请先修正下方高级参数；原文本已保留。' };
  }
};

export const videoParameterInputText = (value: unknown): string =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);

/** Presentation comes from the selected connection (including frozen task snapshots). */
export const videoOutputParameterPresentation = (
  api?: Pick<VideoTaskApiConfig, 'runningHubParameterControls' | 'runningHubMappedFields'>,
  parameters: Record<string, unknown> = {},
): { controls: Record<string, RunningHubVideoFieldControl>; defaultValues: Record<string, unknown> } => {
  const controls = { ...api?.runningHubParameterControls };
  const defaultValues: Record<string, unknown> = {};
  for (const field of api?.runningHubMappedFields || []) {
    if (field.kind !== 'parameter' || !field.parameter) continue;
    Object.defineProperty(defaultValues, field.parameter, { value: field.originalValue, enumerable: true });
    // Older snapshots have field names and defaults, but no UI metadata. Infer the
    // unit only; never borrow today's workflow ranges or change historical values.
    if (!controls[field.parameter] && /^(?:megapixels?|百万像素)$/iu.test(field.fieldName.replace(/[\s_-]+/gu, ''))) {
      Object.defineProperty(controls, field.parameter, { value: { kind: 'number', unit: 'MP' }, enumerable: true });
    }
    const control = controls[field.parameter];
    if (control?.optionLabels && control.optionLabelAspectRatio) {
      const aspect = api?.runningHubMappedFields?.find((entry) => entry.nodeId === field.nodeId && entry.kind === 'parameter'
        && entry.fieldName.toLowerCase().replace(/[\s_-]+/gu, '') === 'aspectratio');
      if (aspect?.parameter) {
        const ratio = (value: unknown) => typeof value === 'string' ? value.trim().match(/^(\d+)\s*:\s*(\d+)(?:\s|\(|$)/u)?.slice(1).join(':') : undefined;
        const effective = Object.prototype.hasOwnProperty.call(parameters, aspect.parameter) && parameters[aspect.parameter] !== undefined
          ? parameters[aspect.parameter] : aspect.originalValue;
        if (ratio(effective) !== ratio(control.optionLabelAspectRatio)) {
          const { optionLabels: _labels, ...withoutSizes } = control;
          controls[field.parameter] = withoutSizes;
        }
      }
    }
  }
  return { controls, defaultValues };
};

/** Request overrides are shown separately from the story's planned segment duration. */
export const videoOutputParameterSummary = (
  parameters: Record<string, unknown>,
  api?: Pick<VideoTaskApiConfig, 'runningHubParameterControls' | 'runningHubMappedFields'>,
): string => {
  const { controls } = videoOutputParameterPresentation(api, parameters);
  return videoOutputParameterKeys
  .filter((key) => Object.prototype.hasOwnProperty.call(parameters, key) && parameters[key] !== undefined)
  .map((key) => {
    const value = videoParameterInputText(parameters[key]);
    if (key === 'duration') return `请求时长 ${value} 秒`;
    const control = controls[key];
    if (control?.unit === 'MP') {
      const option = control.options?.find((entry) => entry === value || value.trim() !== '' && Number(entry) === Number(value)) ?? value;
      const size = control.optionLabels?.[option];
      return `请求像素 ${value} MP${size ? `（${size}）` : ''}`;
    }
    if (key === 'aspect_ratio') return `请求画面比例 ${value}`;
    if (key === 'resolution') return `请求分辨率 ${value}`;
    return `${key === 'width' ? '请求宽度' : '请求高度'} ${value} 像素`;
  }).join(' · ');
};

/** Edit only the requested key in the current JSON draft. Rendering never rewrites its bytes. */
export const changeVideoParameterText = (
  text: string,
  key: string,
  input: string,
): { text: string; value: Record<string, unknown>; issue: string } => {
  const parsed = readVideoParameterText(text);
  if (parsed.issue) return { ...parsed, text };
  if (['__proto__', 'prototype', 'constructor'].includes(key)) {
    return { ...parsed, text, issue: '此参数名不可用，原参数已保留。' };
  }
  const value = { ...parsed.value };
  if (!input.trim()) delete value[key];
  else if (key === 'resolution' || key === 'aspect_ratio') value[key] = input;
  else {
    let next: unknown = input;
    try {
      const candidate: unknown = JSON.parse(input);
      // Keep long numeric text exact. Do not introduce precision loss before the backend validates it.
      if (typeof candidate !== 'number' || Number.isFinite(candidate) && (!Number.isInteger(candidate) || Number.isSafeInteger(candidate))) next = candidate;
    } catch { /* Partial numeric input and custom values remain editable as text. */ }
    value[key] = next;
  }
  // No-op interactions must not invalidate a frozen batch retry's original-text baseline.
  if (JSON.stringify(value) === JSON.stringify(parsed.value)) return { text, value, issue: '' };
  return { text: JSON.stringify(value, null, 2), value, issue: '' };
};
