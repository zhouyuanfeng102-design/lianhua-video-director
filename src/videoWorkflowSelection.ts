import type { ComfyVideoConfig, ComfyVideoWorkflowPreset } from './videoGenerationTypes';

/** An explicit destination never silently falls through to another workflow. */
export const resolveComfyVideoWorkflow = (
  config: ComfyVideoConfig | undefined,
  workflowId?: string | null,
): ComfyVideoWorkflowPreset | undefined => {
  if (!config) return undefined;
  if (workflowId) return config.workflows.find((workflow) => workflow.id === workflowId);
  if (config.activeWorkflowId === undefined) return config.workflows[0];
  return config.workflows.find((workflow) => workflow.id === config.activeWorkflowId);
};

/** Restore editable forms from the explicitly selected current connection.
 * Frozen task snapshots bypass this form-only recovery. */
export const restoreComfyVideoWorkflowId = (
  config: ComfyVideoConfig | undefined,
  workflowId?: string | null,
): string | undefined => {
  const explicit = workflowId ? config?.workflows.find((workflow) => workflow.id === workflowId) : undefined;
  return explicit?.id || resolveComfyVideoWorkflow(config)?.id || workflowId || undefined;
};
