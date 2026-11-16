import type { ComfyVideoInputBinding } from './videoGenerationTypes';

interface DurationNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
type DurationGraph = Record<string, DurationNode>;

const secondsFields = [
  'duration_seconds', 'duration_sec', 'duration_s',
  'video_duration_seconds', 'video_duration_sec', 'video_duration_s',
] as const;
const h3LengthNodes = new Set(['MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageToVideo', 'EmptyMiniMaxH3LatentAV']);
const link = (value: unknown): [string, number] | undefined => Array.isArray(value) && value.length === 2
  && (typeof value[0] === 'string' || Number.isSafeInteger(value[0])) && Number.isInteger(value[1])
  ? [String(value[0]), value[1] as number] : undefined;

/** The workflow itself already converts seconds to H3's 24fps, 17k+5 frame
 * grid. Recognize that exact calculation; never evaluate user expressions. */
const h3SecondsVariable = (expression: unknown): string | undefined => {
  if (typeof expression !== 'string') return undefined;
  const compact = expression.replace(/\s+/gu, '');
  return /^max\(5,round\(([a-z])\*24\)\)\+\(5-\(max\(5,round\(\1\*24\)\)%17\)\)%17$/u.exec(compact)?.[1];
};

/** Discover one proven seconds input without changing the graph or its
 * mappings. A title, node number, default value or bare frame count never
 * supplies units. Conflicting controls remain available for manual mapping. */
export const inferComfyVideoDurationBinding = (
  nodes: DurationGraph,
  allowedNodeIds?: ReadonlySet<string>,
): ComfyVideoInputBinding | undefined => {
  const included = (nodeId: string) => !allowedNodeIds || allowedNodeIds.has(nodeId);
  const numericSource = (nodeId: string, inputName: string): ComfyVideoInputBinding | undefined => {
    if (!included(nodeId)) return undefined;
    const value = nodes[nodeId]?.inputs[inputName];
    if (typeof value === 'number' && Number.isFinite(value)) return { nodeId, inputName };
    const edge = link(value);
    if (!edge || edge[1] !== 0 || !included(edge[0])) return undefined;
    const source = nodes[edge[0]];
    return source && /^(?:PrimitiveFloat|PrimitiveInt)$/u.test(source.class_type)
      && typeof source.inputs.value === 'number' && Number.isFinite(source.inputs.value)
      ? { nodeId: edge[0], inputName: 'value' } : undefined;
  };
  const candidates = new Map<string, ComfyVideoInputBinding>();
  const add = (binding: ComfyVideoInputBinding | undefined) => {
    if (binding) candidates.set(JSON.stringify([binding.nodeId, binding.inputName]), binding);
  };
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!included(nodeId)) continue;
    if (!h3LengthNodes.has(node.class_type)) continue;
    for (const field of secondsFields) {
      // Audio trims and output savers can expose the same unit. Only these
      // known H3 generation nodes establish a video-generation duration.
      if (Object.prototype.hasOwnProperty.call(node.inputs, field)) add(numericSource(nodeId, field));
    }
    const edge = link(node.inputs.length);
    // ComfyMathExpression's output 1 is INT; its FLOAT/BOOL outputs do not
    // authorize using the upstream value as this H3 frame-count control.
    if (!edge || edge[1] !== 1 || !included(edge[0])) continue;
    const expression = nodes[edge[0]];
    if (expression?.class_type !== 'ComfyMathExpression') continue;
    const variable = h3SecondsVariable(expression.inputs.expression);
    if (variable) add(numericSource(edge[0], `values.${variable}`));
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
};

/** Keep all saved user choices authoritative; infer only a missing duration. */
export const mergeComfyVideoDurationBinding = (
  parameters: Record<string, ComfyVideoInputBinding> | undefined,
  inferred: ComfyVideoInputBinding | undefined,
): Record<string, ComfyVideoInputBinding> => inferred && !Object.prototype.hasOwnProperty.call(parameters || {}, 'duration')
  ? { ...parameters, duration: inferred } : parameters || {};
