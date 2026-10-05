import { resolveRunningHubVideoFieldControl } from './runningHubVideoNodes';
import type { RunningHubVideoInputBinding, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from './runningHubVideoTypes';
import type { VideoTaskApiConfig } from './types';

export interface RunningHubVideoImageProtocol {
  imageCount?: RunningHubVideoInputBinding;
  imageCountSource?: 'explicit' | 'verified-app';
  /** Conservative guard where published image-count metadata does not describe sparse-slot behavior. */
  imageCountMode?: 'prefix';
  emptyImageValues: Array<'' | 'None' | 'example.png'>;
  verifiedProfile: boolean;
}

const keyOf = (binding: RunningHubVideoInputBinding) => JSON.stringify([binding.nodeId, binding.inputName]);
const knownImages = ['438', '435', '437', '439', '431', '429'];
const knownCount = { nodeId: '827', inputName: 'value' };
const knownAppId = '2104753059472990209';
const isCountValue = (value: unknown): boolean => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && /^\d+$/u.test(value.trim()) && Number.isSafeInteger(Number(value)));

/**
 * Resolve protocols once, while compiling a newly selected workflow. The exact
 * app profile was verified against its public input metadata and API example on
 * 2026-10-05: 827.value is “使用几张图”; all six LoadImage fields declare
 * example.png as the request default (the metadata also lists None as a UI
 * option). Sending literal None or an empty string to this graph reaches
 * BatchImagesNode as a None tensor, so unused slots keep example.png.
 * Frozen tasks never call this resolver and retain their submitted protocol.
 */
export const resolveRunningHubVideoImageProtocol = (workflow: RunningHubVideoWorkflow): RunningHubVideoImageProtocol => {
  let nodes: RunningHubVideoNodeInfo[] = [];
  try {
    const raw = JSON.parse(workflow.requestTemplate);
    if (Array.isArray(raw?.nodeInfoList)) nodes = raw.nodeInfoList.filter((node: unknown): node is RunningHubVideoNodeInfo => Boolean(node) && typeof node === 'object' && !Array.isArray(node));
  } catch { /* Invalid drafts stay inspectable; workflow validation reports JSON errors. */ }
  const matches = (binding: RunningHubVideoInputBinding) => nodes.filter((node) => node.nodeId === binding.nodeId && node.fieldName === binding.inputName);
  const countNodes = matches(knownCount);
  const imageKeys = new Set(workflow.mapping.images.map(keyOf));
  const verifiedProfile = workflow.runKind === 'ai-app' && workflow.remoteId.trim() === knownAppId
    && workflow.mapping.images.length === knownImages.length && imageKeys.size === knownImages.length
    && knownImages.every((nodeId, index) => {
      const binding = { nodeId, inputName: 'image' }; const found = matches(binding);
      return keyOf(workflow.mapping.images[index]) === keyOf(binding)
        && found.length === 1 && typeof found[0].fieldValue === 'string';
    }) && countNodes.length === 1 && isCountValue(countNodes[0].fieldValue);
  const assigned = [...workflow.mapping.prompt, ...workflow.mapping.images, ...Object.values(workflow.mapping.parameters || {})];
  const availableKnownCount = verifiedProfile && !assigned.some((binding) => keyOf(binding) === keyOf(knownCount));
  const imageCount = workflow.mapping.imageCount ?? (workflow.mapping.imageCount !== null && availableKnownCount ? knownCount : undefined);
  const defaults = workflow.mapping.images.map((binding) => matches(binding)[0]?.fieldValue);
  const emptyImageValues = workflow.mapping.images.map((binding, index): '' | 'None' | 'example.png' => {
    const control = resolveRunningHubVideoFieldControl(workflow, binding)?.control;
    // RunningHub's published AI-app request keeps unused image inputs at the
    // app's own placeholder (currently example.png). Sending literal None or
    // an empty string reaches BatchImagesNode as a None tensor and reproduces
    // error 805; the web UI's cancel action restores this declared default.
    if (verifiedProfile) return 'example.png';
    // A field's declared option is stronger evidence than a legacy blank default.
    if (control?.kind === 'select' && control.options?.includes('None')) return 'None';
    if (defaults[index] === '' || defaults[index] === 'None') return defaults[index] as '' | 'None';
    // Retain existing templates' explicitly mapped peer convention; never use an
    // audio field or unmapped sample image to infer a no-image value.
    return workflow.mapping.images.some((other, peer) => other.inputName === binding.inputName && defaults[peer] === 'None') ? 'None' : '';
  });
  return { emptyImageValues, verifiedProfile, ...(imageCount ? {
    imageCount: { ...imageCount }, imageCountSource: workflow.mapping.imageCount ? 'explicit' as const : 'verified-app' as const,
    ...(verifiedProfile && keyOf(imageCount) === keyOf(knownCount) ? { imageCountMode: 'prefix' as const } : {}),
  } : {}) };
};

/**
 * Upgrade only an old, already frozen exact-app connection at the new-task
 * boundary. Before the placeholder fix, snapshots persisted None/'' for
 * unused image fields. Reusing such a failed task would otherwise submit the
 * same invalid payload even after the workflow editor was corrected. The
 * original snapshot is never rewritten; callers receive a shallow config copy
 * with the six exact image slots carrying the published example.png default.
 */
export const migrateRunningHubVideoApiImageProtocol = <T extends Omit<VideoTaskApiConfig, 'apiKey'>>(config: T): T => {
  if (config.provider !== 'runninghub' || config.runningHubAppId?.trim() !== knownAppId || !Array.isArray(config.runningHubMappedFields)) return config;
  const imageFields = config.runningHubMappedFields.filter((field) => field.kind === 'image');
  const exactProfile = imageFields.length === knownImages.length && knownImages.every((nodeId, index) => {
    const field = imageFields.find((candidate) => candidate.imageIndex === index);
    return field?.nodeId === nodeId && field.fieldName === 'image';
  });
  if (!exactProfile || !imageFields.some((field) => field.emptyValue !== 'example.png')) return config;
  return {
    ...config,
    runningHubMappedFields: config.runningHubMappedFields.map((field) => field.kind === 'image' ? { ...field, emptyValue: 'example.png' as const } : field),
  } as T;
};
