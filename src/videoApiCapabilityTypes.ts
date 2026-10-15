import type { RunningHubVideoFieldControl } from './runningHubVideoTypes';

export type VideoApiParameterKey = 'duration' | 'aspect_ratio' | 'resolution';

export interface VideoApiParameterControl extends RunningHubVideoFieldControl {
  /** True only for an explicit schema enum/const, not recommended examples. */
  restricted?: boolean;
  required?: boolean;
  description?: string;
  source?: 'openapi' | 'models';
}

export interface VideoApiModelParameterCapabilities {
  controls: Partial<Record<VideoApiParameterKey, VideoApiParameterControl>>;
  /** Display-only service defaults; no implicit request overrides. */
  defaults: Partial<Record<VideoApiParameterKey, string | number>>;
  /** Explicit upstream image capacity; missing means unknown, including cached legacy metadata. */
  imageReferences?: { maxCount: number; source: 'openapi' | 'models'; field?: string };
  aliases?: string[];
}

export interface VideoApiParameterCapabilities {
  /** Non-secret effective service scope; stale cross-service data is ignored. */
  scope: string;
  source: 'openapi' | 'models' | 'mixed';
  sourceUrl?: string;
  fetchedAt: number;
  models: Record<string, VideoApiModelParameterCapabilities>;
  common?: VideoApiModelParameterCapabilities;
}
