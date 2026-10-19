import type { ReferenceRole, VideoTaskApiConfig } from './types';
import type { ComfyVideoWorkflowPreset } from './videoGenerationTypes';
import { getVideoApiImageCapacity } from './videoImageCapacity';
import { videoMotionCapability } from './videoMotionReferences';

export interface VideoPromptExecutionContextInput {
  backend: 'api' | 'comfyui';
  api?: Omit<VideoTaskApiConfig, 'apiKey'>;
  workflow?: Pick<ComfyVideoWorkflowPreset, 'id' | 'name' | 'mapping'>;
  /** Only an explicitly selected mode is read; opaque task values stay private. */
  parameters?: Readonly<Record<string, unknown>>;
}

export interface VideoPromptReferenceInputFact {
  source: 'configured-mapping' | 'request-template' | 'saved-api-capability' | 'adapter-inputs' | 'unknown';
  /** Capacity of editable inputs, not proof of the downstream model's conditioning. */
  maxCount?: number;
  /** A template's offered video slots are not an upstream maximum. */
  configuredSlotCount?: number;
  roles?: ReferenceRole[];
}

export interface VideoPromptExecutionContext {
  version: 1;
  backend: 'api' | 'comfyui';
  provider: NonNullable<VideoTaskApiConfig['provider']> | 'comfyui' | 'unknown';
  model?: string;
  modelSource: 'configured-model' | 'workflow-label' | 'unknown';
  workflowLabel?: string;
  generationMode: 'text' | 'first' | 'first_last' | 'reference' | 'unknown';
  generationModeSource: 'selected-mode' | 'unknown';
  referenceInputs: {
    images: VideoPromptReferenceInputFact;
    audios: VideoPromptReferenceInputFact;
    videos: VideoPromptReferenceInputFact;
  };
  /** Names and editable slots do not establish checkpoint, sampler or wiring. */
  workflowInternals: 'unknown';
}

const unknownInput = (): VideoPromptReferenceInputFact => ({ source: 'unknown' });
const mappedInputs = (maxCount: number, roles?: ReferenceRole[]): VideoPromptReferenceInputFact => ({
  source: 'configured-mapping', maxCount, ...(roles ? { roles: [...roles] } : {}),
});
const mappedIndexedInputs = (indices: Array<number | undefined>): VideoPromptReferenceInputFact =>
  indices.some((index) => !Number.isSafeInteger(index) || index! < 0) ? unknownInput()
    : mappedInputs(indices.length ? Math.max(...indices as number[]) + 1 : 0);

/** A request-local projection of saved facts. It neither inspects a graph nor
 * probes a provider, changes selection, or gates generation. Never serialize
 * the source object: URLs, templates, node values and credentials stay out. */
export const buildVideoPromptExecutionContext = (input: VideoPromptExecutionContextInput): VideoPromptExecutionContext => {
  const api = input.backend === 'api' ? input.api : undefined;
  const provider = input.backend === 'comfyui' ? 'comfyui' : api ? api.provider || 'generic' : 'unknown';
  const model = api?.model?.trim();
  const context: VideoPromptExecutionContext = {
    version: 1, backend: input.backend, provider,
    ...(model ? { model } : {}),
    modelSource: model ? provider === 'runninghub' ? 'workflow-label' : 'configured-model' : 'unknown',
    generationMode: 'unknown', generationModeSource: 'unknown',
    referenceInputs: { images: unknownInput(), audios: unknownInput(), videos: unknownInput() },
    workflowInternals: 'unknown',
  };
  const motionInputs = videoMotionCapability(input);
  if (motionInputs.supported) context.referenceInputs.videos = {
    source: motionInputs.source === 'request-template' ? 'request-template' : 'configured-mapping',
    configuredSlotCount: motionInputs.slotCount,
  };

  if (input.backend === 'comfyui') {
    if (input.workflow) {
      context.workflowLabel = input.workflow.name;
      context.referenceInputs.images = mappedInputs(input.workflow.mapping.images.length,
        input.workflow.mapping.images.map((entry) => entry.role || 'general'));
    }
    return context;
  }
  if (!api) return context;

  if (provider === 'runninghub') {
    // The cloud compiler uses the workflow's display name as api.model. That
    // label must not become a claimed checkpoint or Ref2VA/FL2VA mode.
    if (api.runningHubImageRoles) context.referenceInputs.images = mappedInputs(api.runningHubImageRoles.length, api.runningHubImageRoles);
    else if (api.runningHubMappedFields) {
      const images = api.runningHubMappedFields.filter((entry) => entry.kind === 'image');
      context.referenceInputs.images = mappedIndexedInputs(images.map((entry) => entry.imageIndex));
    }
    if (api.runningHubMappedFields) {
      const audios = api.runningHubMappedFields.filter((entry) => entry.kind === 'audio');
      context.referenceInputs.audios = mappedIndexedInputs(audios.map((entry) => entry.audioIndex));
    }
  } else if (provider === 'rhtv_web') {
    const mode = input.parameters?.rhtv_mode || api.rhtvMode;
    if (mode === 'text' || mode === 'first' || mode === 'first_last' || mode === 'reference') {
      context.generationMode = mode;
      context.generationModeSource = 'selected-mode';
      context.referenceInputs.images = { source: 'adapter-inputs', maxCount: { text: 0, first: 1, first_last: 2, reference: 9 }[mode],
        ...(mode === 'first' ? { roles: ['first-frame'] as ReferenceRole[] }
          : mode === 'first_last' ? { roles: ['first-frame', 'last-frame'] as ReferenceRole[] } : {}) };
    }
  } else if (provider === 'minimax') {
    context.referenceInputs.images = { source: 'adapter-inputs', maxCount: 2, roles: ['first-frame', 'last-frame'] };
  } else {
    const imageCapacity = getVideoApiImageCapacity(api);
    if (imageCapacity) context.referenceInputs.images = { source: 'saved-api-capability', maxCount: imageCapacity.maxCount };
  }
  return context;
};
