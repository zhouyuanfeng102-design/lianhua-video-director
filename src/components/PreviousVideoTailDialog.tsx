import type { ReferenceAsset } from '../types';
import type { VideoImageReference } from '../videoGenerationTypes';
import type { WorkbenchMediaSource, WorkbenchProgress } from '../videoWorkbenchTypes';
import type { VideoTailFrameSelectionSummary } from '../videoFrameSelection';

// The former tail-frame dialog is intentionally removed. The director now
// performs an explicit one-click action and reports progress inline.
export interface TailFrameTools {
  available: boolean;
  busy: boolean;
  progress?: WorkbenchProgress;
  extract: (source: WorkbenchMediaSource) => Promise<ReferenceAsset>;
  selectFrame?: (source: WorkbenchMediaSource, context: TailFrameSelectionContext, signal: AbortSignal) => Promise<TailFrameSelectionResult>;
  cancel: () => Promise<void>;
}

export interface TailFrameSelectionContext {
  sequencePlanId: string;
  segmentId: string;
  /** Complete selected Chinese/English prompt, without local semantic extraction. */
  prompt: string;
  references: readonly VideoImageReference[];
  requireAiSelection?: true;
}

export interface TailFrameSelectionResult {
  frame: ReferenceAsset;
  selection: VideoTailFrameSelectionSummary;
  candidates: Array<{ id: string; timeSec: number; isLastFrame: boolean; asset: ReferenceAsset }>;
}
