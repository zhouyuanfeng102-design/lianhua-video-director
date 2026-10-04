import type { ReferenceRole, VideoTaskApiConfig } from './types';
import type { ComfyVideoWorkflowPreset, VideoGenerationBackend, VideoImageReference } from './videoGenerationTypes';
import { videoReferenceSlotIndex } from './videoReferenceSlots';

export interface VideoReferenceUsageContext {
  backend: VideoGenerationBackend;
  workflow?: ComfyVideoWorkflowPreset;
  // Accept readonly role tuples from saved/configured connections as well as
  // mutable arrays from legacy settings.  Usage resolution never mutates the
  // provider mapping.
  api?: Pick<VideoTaskApiConfig, 'provider'> & { runningHubImageRoles?: readonly ReferenceRole[] };
  /**
   * The roles chosen for this particular segment.  This is deliberately
   * separate from the workflow/API mapping: a physical image input can have
   * a different purpose in every segment.  The old mapping is retained as a
   * compatibility fallback when this field is omitted (legacy snapshots).
   */
  slotRoles?: readonly (ReferenceRole | undefined)[];
}

const mappedImageRoles = (context: VideoReferenceUsageContext): readonly (ReferenceRole | undefined)[] | undefined => (
  context.backend === 'comfyui'
    ? context.workflow?.mapping.images.map((slot) => slot.role)
    : context.api?.provider === 'runninghub' ? context.api.runningHubImageRoles : undefined
);

/** A composite picker stores only its editable slots. Convert their purpose
 * memory to physical slots when a preceding slot is reserved for the tail. */
export const offsetVideoReferenceSlotRoles = (
  roles: readonly (ReferenceRole | undefined)[] | undefined,
  offset = 0,
): (ReferenceRole | undefined)[] | undefined => roles === undefined ? undefined
  : [...Array.from({ length: offset }, () => undefined), ...roles];

/** A boundary slot describes how this submission uses the selected pixels,
 * not the asset's original category. Only explicit workflow mappings authorize
 * the override; an ordinary first image is never guessed to be a first frame.
 * `offset` accounts for a reserved tail slot before a composite's identities. */
export const videoReferenceUsage = (
  references: readonly VideoImageReference[],
  context: VideoReferenceUsageContext,
  offset = 0,
): VideoImageReference[] => {
  const mappedRoles = mappedImageRoles(context);
  const segmentRoles = context.slotRoles;
  return references.map((reference, index) => {
    const slot = videoReferenceSlotIndex(reference, index) + offset;
    const segmentRole = segmentRoles?.[slot];
    const mappedRole = mappedRoles?.[slot];
    return {
      ...reference,
      // New drafts always pass their per-segment slot roles.  Only legacy
      // calls without them may use the historical first/last mapping as a
      // compatibility fallback; never overwrite a deliberate segment role.
      role: segmentRoles !== undefined
        ? (segmentRole || reference.role)
        : (mappedRole === 'first-frame' || mappedRole === 'last-frame' ? mappedRole : reference.role),
    };
  });
};

const slotRoleNames: Record<ReferenceRole, string> = {
  'first-frame': '首帧', 'last-frame': '尾帧', character: '人物', subject: '主体', scene: '场景',
  prop: '道具', style: '风格', motion: '动作', composition: '构图', camera: '摄影', audio: '音频',
  dialogue: '对白', 'clay-render': 'Clay Render', creative: '创意', general: '通用参考', unknown: '未指定参考',
};
export const videoReferenceRoleName = (role: ReferenceRole): string => slotRoleNames[role] || '未指定参考';
const explicitSlotRole = (role: ReferenceRole | undefined): ReferenceRole | undefined => (
  role && role !== 'general' && role !== 'unknown' ? role : undefined
);

/** Display names for the slots these selected pixels actually occupy. Explicit
 * mapped roles retain their full slot order (including slots before offset).
 * Flexible/unmapped slots use the user's effective role, never image content.
 * A conflicting historical workflow role is shown as a visible notice only;
 * it never changes the selected role or blocks submission. */
export const videoReferenceSlotLabels = (
  references: readonly VideoImageReference[],
  context: VideoReferenceUsageContext,
  offset = 0,
  rememberedRoles: readonly ReferenceRole[] = [],
): string[] => {
  if (!Number.isSafeInteger(offset) || offset < 0) return references.map(() => '未分配（槽位无效）');
  const mappedRoles = mappedImageRoles(context);
  const effective = videoReferenceUsage(references, context, offset);
  const counts = new Map<ReferenceRole, number>();
  const countRole = (role: ReferenceRole): number => {
    const count = (counts.get(role) || 0) + 1;
    counts.set(role, count);
    return count;
  };
  const rolesBySlot = new Map<number, ReferenceRole>();
  rememberedRoles.forEach((role, index) => { if (role) rolesBySlot.set(index + offset, role); });
  effective.forEach((reference, index) => rolesBySlot.set(videoReferenceSlotIndex(reference, index) + offset, reference.role));
  const ordinals = new Map<number, number>();
  // Count real/mapped slots only; a malformed imported slot number must not
  // turn a small selection into an unbounded rendering loop.
  const orderedSlots = [...new Set([
    ...(context.slotRoles === undefined ? (mappedRoles || []).map((_, index) => index) : []),
    ...rolesBySlot.keys(),
  ])].sort((a, b) => a - b);
  for (const slot of orderedSlots) {
    const role = context.slotRoles === undefined
      ? explicitSlotRole(mappedRoles?.[slot]) || rolesBySlot.get(slot)
      : rolesBySlot.get(slot);
    if (role) ordinals.set(slot, countRole(role));
  }
  return effective.map((reference, index) => {
    const slotIndex = videoReferenceSlotIndex(reference, index) + offset;
    if (mappedRoles && slotIndex >= mappedRoles.length) return `未分配（槽${slotIndex + 1}，超出槽位）`;
    const mappedRole = explicitSlotRole(mappedRoles?.[slotIndex]);
    const actualRole = Object.prototype.hasOwnProperty.call(slotRoleNames, reference.role) ? reference.role : 'unknown';
    // Once a segment supplied its own roles, show that deliberate choice as
    // the primary label.  Legacy callers without slotRoles retain the old
    // mapped-label presentation for compatibility.
    const role = context.slotRoles !== undefined ? actualRole : mappedRole || actualRole;
    const ordinal = ordinals.get(slotIndex) || 1;
    const name = `${slotRoleNames[role]}${role === 'first-frame' || role === 'last-frame' ? '' : ordinal}`;
    const mismatch = mappedRole && mappedRole !== actualRole
      ? context.slotRoles !== undefined ? ` · 原槽${slotRoleNames[mappedRole]}，仅提示` : ` · 当前${slotRoleNames[actualRole]}，用途不匹配`
      : '';
    return `${name}（槽${slotIndex + 1}）${mismatch}`;
  });
};
