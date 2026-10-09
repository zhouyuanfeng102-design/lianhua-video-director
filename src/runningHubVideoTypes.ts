import type { ReferenceRole } from './types';

/** A cloud nodeInfoList field, not a local ComfyUI `inputs` path. */
export interface RunningHubVideoInputBinding { nodeId: string; inputName: string }
/** Local generation-panel positions; these do not create cloud workflow nodes. */
export interface RunningHubLoraSlot {
  model: RunningHubVideoInputBinding;
  strength?: RunningHubVideoInputBinding;
  clipStrength?: RunningHubVideoInputBinding;
  label?: string;
}
/** Display metadata only. Selected fields retain their real request names and values. */
export interface RunningHubGenerationExtras {
  loraSlots?: RunningHubLoraSlot[];
  otherFields?: RunningHubVideoInputBinding[];
  hiddenLoras?: RunningHubVideoInputBinding[];
}
/** Display metadata only; wire values retain the request template's original type. */
export interface RunningHubVideoFieldControl {
  kind: 'number' | 'select' | 'text';
  unit?: 'MP';
  options?: string[];
  /** Display-only names for exact option values, optionally scoped to a ratio. */
  optionLabels?: Record<string, string>;
  optionLabelAspectRatio?: string;
  min?: number;
  max?: number;
  step?: number;
}
export interface RunningHubVideoMapping {
  prompt: RunningHubVideoInputBinding[];
  images: Array<RunningHubVideoInputBinding & { role?: ReferenceRole }>;
  /** Actual selected image count, including a continuation frame. Null disables verified-app adaptation. */
  imageCount?: RunningHubVideoInputBinding | null;
  /** Only explicitly entered task overrides are applied; omitted values keep cloud defaults. */
  parameters?: Record<string, RunningHubVideoInputBinding>;
}
/** Discoverable inputs only. Entries are not submitted until explicitly bound/added. */
export interface RunningHubVideoNodeCatalogEntry {
  nodeId: string;
  fieldName: string;
  fieldValue: string | number | boolean;
  description?: string;
  control?: RunningHubVideoFieldControl;
}
export interface RunningHubVideoWorkflow {
  id: string;
  name: string;
  runKind: 'ai-app' | 'workflow';
  /** Keep long cloud IDs as text; converting these to a JS number corrupts them. */
  remoteId: string;
  /** Original v2 request body. Unmapped values and cloud execution options are retained. */
  requestTemplate: string;
  nodeCatalog?: RunningHubVideoNodeCatalogEntry[];
  /** Explicit per-field UI overrides, keyed by JSON.stringify([nodeId, fieldName]). */
  fieldControls?: Record<string, RunningHubVideoFieldControl>;
  generationExtras?: RunningHubGenerationExtras;
  mapping: RunningHubVideoMapping;
  outputNodeId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface RunningHubVideoConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  workflows: RunningHubVideoWorkflow[];
  activeWorkflowId?: string | null;
}
export interface RunningHubVideoNodeInfo extends Record<string, unknown> {
  nodeId: string;
  fieldName: string;
  fieldValue: unknown;
}
export interface RunningHubVideoRequest extends Record<string, unknown> {
  nodeInfoList: RunningHubVideoNodeInfo[];
}
export interface RunningHubVideoImportResult {
  workflow: RunningHubVideoWorkflow;
  warnings: string[];
  /** A tutorial URL may suggest a connection origin; it never changes the saved connection. */
  baseUrl?: string;
}
