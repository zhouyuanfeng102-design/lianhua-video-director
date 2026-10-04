import type { Project, ReferenceAsset, ReferenceRole, VideoGenerationTask, VideoSegment, VideoTaskApiConfig } from './types';
import type { ComfyVideoWorkflowPreset, VideoBatchItemInput, VideoBatchTailPlacement, VideoGenerationBackend, VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';
import { buildVideoApiBody } from './videoGenerationApi';
import { videoBatchTailReferences } from './videoBatch';
import { bindComfyVideoWorkflow } from './comfyuiVideo';
import { videoReferenceRoleName, videoReferenceUsage } from './videoReferenceUsage';
import { assertVideoReferenceSlots, videoReferenceSlotIndex, videoReferenceSlotSpan } from './videoReferenceSlots';

type TailReferenceProject = Pick<Project, 'id' | 'assets' | 'generationTasks' | 'sequencePlans' | 'storyboards'>;
export interface PreviousSegmentVideoVersion {
  asset: ReferenceAsset;
  task?: VideoGenerationTask;
  label: string;
}
export interface PreviousSegmentVideos {
  previousSegment?: VideoSegment;
  versions: PreviousSegmentVideoVersion[];
  reason?: string;
  reasonCode?: 'invalid-target' | 'first-segment' | 'missing-previous' | 'waiting' | 'no-local-video';
}

const isVideo = (asset: ReferenceAsset): boolean => asset.type === 'video' || asset.mediaType === 'video' || Boolean(asset.mimeType?.startsWith('video/'));
const videoTask = (task: Project['generationTasks'][number]): task is VideoGenerationTask => !task.kind || task.kind === 'video';
const localVideo = (asset: ReferenceAsset): boolean => {
  const path = asset.relativePath?.replace(/\\/gu, '/');
  return isVideo(asset) && !asset.missing && Boolean(path && !/^[/.]|[:\u0000]/u.test(path)
    && path.split('/').every((part) => part !== '..' && part !== '.' && Boolean(part)));
};

/** Resolves the segment relationship independently of any generated video. */
export const lookupPreviousSequenceSegment = (
  project: Pick<Project, 'sequencePlans'>,
  target: { sequencePlanId: string; segmentId: string },
): Pick<PreviousSegmentVideos, 'previousSegment' | 'reason' | 'reasonCode'> => {
  const plans = project.sequencePlans.filter((plan) => plan.id === target.sequencePlanId);
  const plan = plans.length === 1 ? plans[0] : undefined;
  const targets = plan?.segments.filter((segment) => segment.id === target.segmentId) || [];
  const segment = targets.length === 1 ? targets[0] : undefined;
  if (!plan || !segment || !Number.isInteger(segment.index) || segment.index < 1
    || plan.segments.filter((item) => item.index === segment.index).length !== 1) {
    return { reasonCode: 'invalid-target', reason: '当前全片计划或段落已变更，请重新选择段落。' };
  }
  if (segment.index === 1) return { reasonCode: 'first-segment', reason: '这是第一段，没有上一段视频。' };
  const previous = plan.segments.filter((item) => item.index === segment.index - 1);
  if (previous.length !== 1 || plan.segments.filter((item) => item.id === previous[0]?.id).length !== 1) return { reasonCode: 'missing-previous', reason: `当前计划无法唯一找到第 ${segment.index - 1} 段，不能使用其他段的视频替代。` };
  return { previousSegment: previous[0] };
};

/** Look up the actual index - 1 segment, never the previous visible/selected row.
 * This is metadata-only: the desktop extractor still verifies the file and checksum. */
export const lookupPreviousSegmentVideos = (
  project: TailReferenceProject,
  target: { sequencePlanId: string; segmentId: string },
): PreviousSegmentVideos => {
  const locator = lookupPreviousSequenceSegment(project, target);
  if (!locator.previousSegment) return { ...locator, versions: [] };
  const previousSegment = locator.previousSegment;
  const plan = project.sequencePlans.find((entry) => entry.id === target.sequencePlanId)!;

  // Every stored locator is checked. A matching storyboard must not override an
  // explicitly foreign plan/project/segment stored in the source task.
  const storyboardMatches = (id: string): boolean => {
    const boards = project.storyboards.filter((board) => board.id === id);
    if (boards.length > 1) return false;
    const board = boards[0];
    if (board && ((board.sequencePlanId && board.sequencePlanId !== plan.id)
      || (board.segmentId && board.segmentId !== previousSegment.id)
      || (board.segmentIndex != null && board.segmentIndex !== previousSegment.index))) return false;
    const owners = project.sequencePlans.flatMap((entry) => entry.segments
      .filter((part) => part.storyboardId === id)
      .map((part) => ({ planId: entry.id, segmentId: part.id })));
    if (owners.length > 1 || owners.some((owner) => owner.planId !== plan.id || owner.segmentId !== previousSegment.id)) return false;
    return owners.length === 1 || Boolean(board?.sequencePlanId === plan.id && board.segmentId === previousSegment.id);
  };
  const matches = (task?: VideoGenerationTask, asset?: ReferenceAsset): boolean => {
    const source = task?.videoJob?.snapshot.draft.source;
    if (task?.videoJob && task.videoJob.snapshot.projectId !== project.id) return false;
    const planIds = [task?.sequencePlanId, source?.sequencePlanId].filter(Boolean);
    const segmentIds = [task?.segmentId, source?.segmentId].filter(Boolean);
    const indices = [task?.segmentIndex, source?.segmentIndex].filter((value) => value != null);
    if (planIds.some((id) => id !== plan.id) || segmentIds.some((id) => id !== previousSegment.id)
      || indices.some((index) => index !== previousSegment.index)) return false;
    const boardIds = [...new Set([asset?.sourceStoryboardId, task?.storyboardId, source?.storyboardId].filter((id): id is string => Boolean(id)))];
    const directMatch = planIds.length > 0 && segmentIds.length > 0;
    // Explicit plan + segment can survive the deletion of an old storyboard.
    // An extant conflicting storyboard is never ignored, however.
    const boardCompatible = (id: string): boolean => storyboardMatches(id) || (directMatch
      && !project.storyboards.some((board) => board.id === id)
      && !project.sequencePlans.some((entry) => entry.segments.some((part) => part.storyboardId === id)));
    return boardIds.every(boardCompatible) && (directMatch || (boardIds.length > 0 && boardIds.every(storyboardMatches)));
  };
  const resolveTask = (asset: ReferenceAsset): { task?: VideoGenerationTask; invalid: boolean } => {
    const embedded = asset.videoSourceTask;
    if (embedded && (!videoTask(embedded) || (asset.sourceVideoTaskId && embedded.id !== asset.sourceVideoTaskId)
      || (embedded.resultAssetId && embedded.resultAssetId !== asset.id))) return { invalid: true };
    if (embedded) return { task: embedded, invalid: false };
    const live = project.generationTasks.filter(videoTask).filter((task) => task.id === asset.sourceVideoTaskId || task.resultAssetId === asset.id);
    if (live.length > 1) return { invalid: true };
    const task = live[0];
    if (task && ((asset.sourceVideoTaskId && task.id !== asset.sourceVideoTaskId)
      || (task.resultAssetId && task.resultAssetId !== asset.id))) return { invalid: true };
    return { task, invalid: false };
  };
  const versions = project.assets.flatMap((asset): PreviousSegmentVideoVersion[] => {
    if (!localVideo(asset)) return [];
    const { task, invalid } = resolveTask(asset);
    if (invalid || !matches(task, asset)) return [];
    if (task && (task.status !== 'succeeded' || (task.videoJob && (task.videoJob.stage !== 'succeeded'
      || task.videoJob.cancellationPending || task.videoJob.downloadError)))) return [];
    const source = task?.videoJob?.snapshot.draft.source;
    const qualifiers = [source?.language === 'zh' ? '中文稿' : source?.language === 'en' ? '英文稿' : '',
      source?.promptVersion ? `提示词 ${source.promptVersion}` : ''].filter(Boolean);
    return [{ asset, task, label: [asset.name, ...qualifiers].join(' · ') }];
  }).sort((left, right) => right.asset.createdAt - left.asset.createdAt || left.asset.id.localeCompare(right.asset.id));
  if (versions.length) return { previousSegment, versions };
  const pending = project.generationTasks.filter(videoTask).some((task) => matches(task) && (
    ['draft', 'submitting', 'submitted', 'running', 'unknown'].includes(task.status)
    || Boolean(task.videoJob && ['preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading', 'submission-unknown'].includes(task.videoJob.stage))
  ));
  return { previousSegment, versions, reasonCode: pending ? 'waiting' : 'no-local-video', reason: pending
    ? `第 ${previousSegment.index} 段尚未完成并保存到本地，请等待生成完成后再抽取尾帧。`
    : `第 ${previousSegment.index} 段没有可用的本地成片；请先生成或恢复该段视频，不能用原参考图冒充尾帧。` };
};

export interface VideoTailReferencePlacement extends VideoBatchTailPlacement {
  id: string;
  /** Zero-based dense reference position; slotIndex carries its physical slot. */
  index: number;
  role: ReferenceRole;
  semantics: 'first-frame' | 'reference';
  label: string;
  warning?: string;
  replacedAssetId?: string;
  requiresConfirmation: boolean;
  /** Detect references edited while an asynchronous extraction dialog is open. */
  referenceFingerprint: string;
}
export interface VideoTailReferencePlacementInput {
  backend: VideoGenerationBackend;
  workflow?: ComfyVideoWorkflowPreset;
  api?: Pick<VideoTaskApiConfig, 'provider' | 'requestTemplate' | 'runningHubImageRoles' | 'runningHubMappedFields'>;
  references: readonly VideoImageReference[];
}
const referenceFingerprint = (references: readonly VideoImageReference[]): string => JSON.stringify(references.map((reference, index) => (
  videoReferenceSlotIndex(reference, index) === index ? [reference.assetId, reference.role]
    : [reference.assetId, reference.role, videoReferenceSlotIndex(reference, index)]
)));

/** Exercise the same template expansion as submission, with inert unique values.
 * Checking only roles permits an append that a first-image-only template drops. */
const videoTailApiTemplateIssue = (api: VideoTailReferencePlacementInput['api'], references: VideoImageReference[], completeCheck = false): string => {
  if (!completeCheck && (!api?.requestTemplate?.trim() || api.provider === 'minimax')) return '';
  try {
    buildVideoApiBody({ enabled: true, endpoint: '', statusEndpointTemplate: '', authHeader: '', authScheme: '',
      taskIdPath: '', statusPath: '', resultUrlPath: '', ...api }, {
      backend: 'api', name: '尾帧位置预检', prompt: '__tail_reference_prompt_check__', parameters: {}, references,
    }, references.map((_, index) => `https://tail-reference-check.invalid/slot-${index}.png`));
    return '';
  } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
};

/** Prefer a uniquely meaningful slot, never choose between multiple identity
 * images arbitrarily. A single ordinary reference can be replaced directly;
 * an explicit end frame is retained when appending a start frame is possible. */
export const preferredVideoTailReferencePlacement = (
  options: readonly VideoTailReferencePlacement[], references: readonly VideoImageReference[],
): VideoTailReferencePlacement | undefined => {
  if (options.length === 1) return options[0];
  const firstFrame = options.filter((option) => option.semantics === 'first-frame');
  if (firstFrame.length === 1) return firstFrame[0];
  const currentFirstFrame = options.filter((option) => option.mode === 'replace' && references[option.index]?.role === 'first-frame');
  if (currentFirstFrame.length === 1) return currentFirstFrame[0];
  if (references.length === 1) {
    const mode = references[0].role === 'last-frame' ? 'append' : 'replace';
    const preferred = options.filter((option) => option.mode === mode);
    if (preferred.length === 1) return preferred[0];
  }
  return undefined;
};

/** One click is explicit replacement authorization. Prefer a real start slot,
 * then append without disturbing existing references, then a supported ordinary
 * slot. This never invents a mapping or chooses a character-only input. */
export const oneClickVideoTailReferencePlacement = (
  options: readonly VideoTailReferencePlacement[], references: readonly VideoImageReference[],
): VideoTailReferencePlacement | undefined => {
  const ordered = [...options].sort((a, b) => (a.slotIndex ?? a.index) - (b.slotIndex ?? b.index) || a.id.localeCompare(b.id));
  return ordered.find((option) => option.semantics === 'first-frame')
    || ordered.find((option) => option.mode === 'replace' && references[option.index]?.role === 'first-frame')
    || ordered.find((option) => option.mode === 'append')
    || ordered.find((option) => option.mode === 'replace' && ['composition', 'general'].includes(references[option.index]?.role))
    || ordered[0];
};

/** Offers only positions that the actual provider binding can accept. */
export const getVideoTailReferencePlacements = ({ backend, workflow, api, references }: VideoTailReferencePlacementInput): {
  options: VideoTailReferencePlacement[]; reason?: string;
} => {
  try { assertVideoReferenceSlots(references); }
  catch (cause) { return { options: [], reason: cause instanceof Error ? cause.message : String(cause) }; }
  const fingerprint = referenceFingerprint(references);
  const denseIndex = (slotIndex: number): number => {
    const index = references.findIndex((reference, position) => videoReferenceSlotIndex(reference, position) === slotIndex);
    return index < 0 ? references.length : index;
  };
  const make = (slotIndex: number, role: ReferenceRole, semantics: VideoTailReferencePlacement['semantics'], warning?: string): VideoTailReferencePlacement => {
    const index = denseIndex(slotIndex); const mode = index === references.length ? 'append' : 'replace';
    const purpose = semantics === 'first-frame' ? '作为本段首帧' : '作为普通衔接参考';
    return { id: `${mode}-${index}-${role}${slotIndex === index ? '' : `-slot-${slotIndex}`}`, mode, index,
      ...(slotIndex === index ? {} : { slotIndex }), role, semantics, warning,
      label: `${mode === 'append' ? `填入第 ${slotIndex + 1} 个图片槽` : `替换第 ${slotIndex + 1} 个图片槽的参考图`} · ${purpose}`,
      replacedAssetId: references[index]?.assetId, requiresConfirmation: mode === 'replace', referenceFingerprint: fingerprint };
  };
  const replaceAll = (role: ReferenceRole, semantics: VideoTailReferencePlacement['semantics'], warning?: string): VideoTailReferencePlacement => ({
    id: `replace-all-0-${role}`, mode: 'replace-all', index: 0, role, semantics, warning,
    label: `将本段全部 ${references.length} 张参考图替换为 1 张上段尾帧 · ${semantics === 'first-frame' ? '作为本段首帧' : '作为普通衔接参考'}`,
    replacedReferences: references.map((reference) => ({ ...reference })), requiresConfirmation: true, referenceFingerprint: fingerprint,
  });
  const referenceWarning = '此槽是普通/构图参考，尾帧仅用于衔接参考，不保证画面严格从该帧开始；如需强制首帧，请使用明确支持首帧的工作流并绑定首帧槽。';
  const trial = (slotIndex: number, role: ReferenceRole): VideoImageReference[] => {
    const index = denseIndex(slotIndex);
    const tail = { assetId: '__tail__', role, ...(slotIndex === index ? {} : { slotIndex }) };
    return index === references.length ? [...references, tail]
      : references.map((reference, position) => position === index ? tail : reference);
  };
  if (backend === 'comfyui' || (api?.provider === 'runninghub' && api.runningHubImageRoles)) {
    if (backend === 'comfyui' && !workflow) return { options: [], reason: '请先选择视频工作流。' };
    const slots = backend === 'comfyui' ? workflow!.mapping.images : api!.runningHubImageRoles!.map((role) => ({ role }));
    if (!slots.length) return { options: [], reason: '当前工作流没有图片输入槽，请先绑定图片输入。' };
    // Storyboard selections may carry several identity/composition images even
    // when this workflow takes one image. Review their replacement directly;
    // validating the OLD count/roles here made the UI demand manual deletion.
    if (slots.length === 1 && references.length > 1 && [undefined, 'unknown', 'general', 'composition', 'first-frame'].includes(slots[0].role)) {
      const role: ReferenceRole = slots[0].role === 'first-frame' ? 'first-frame' : slots[0].role === 'composition' ? 'composition' : 'general';
      return { options: [replaceAll(role, role === 'first-frame' ? 'first-frame' : 'reference', role === 'first-frame' ? undefined : referenceWarning)] };
    }
    if (videoReferenceSlotSpan(references) > slots.length) return { options: [], reason: `当前参考图已超出 ${slots.length} 个图片槽，请先调整本段选图。` };
    const options = slots.flatMap((slot, index): VideoTailReferencePlacement[] => {
      if (![undefined, 'unknown', 'general', 'composition', 'first-frame'].includes(slot.role)) return [];
      const semantics = slot.role === 'first-frame' ? 'first-frame' : 'reference';
      const role: ReferenceRole = slot.role === 'first-frame' ? 'first-frame' : slot.role === 'composition' ? 'composition' : 'general';
      const next = videoReferenceUsage(trial(index, role), { backend, workflow, api });
      if (next.filter((reference) => reference.role === 'first-frame').length > 1
        || next.some((reference, position) => {
          const mappedRole = slots[videoReferenceSlotIndex(reference, position)]?.role;
          return mappedRole && !['general', 'unknown', reference.role].includes(mappedRole);
        })) return [];
      return [make(index, role, semantics, semantics === 'reference' ? referenceWarning : undefined)];
    });
    return options.length ? { options } : { options, reason: '没有可用的首帧或普通参考槽。请先调整本段图片用途，或在视频连接设置绑定相应图片槽。' };
  }
  const minimax = api?.provider === 'minimax';
  let templateIssue = '';
  const occupiedSlots = new Set(references.map(videoReferenceSlotIndex));
  let firstEmptySlot = 0;
  while (occupiedSlots.has(firstEmptySlot)) firstEmptySlot += 1;
  const options = [...occupiedSlots, firstEmptySlot].sort((left, right) => left - right).flatMap((index): VideoTailReferencePlacement[] => {
    const next = trial(index, 'first-frame');
    // A second first-frame is ambiguous even on a generic API; do not let the
    // provider's findIndex silently use the older image instead of the tail.
    if (next.filter((reference) => reference.role === 'first-frame').length > 1) return [];
    if (minimax && (next.length > 2 || next.some((reference) => !['first-frame', 'last-frame'].includes(reference.role))
      || next.filter((reference) => reference.role === 'last-frame').length > 1)) return [];
    const issue = videoTailApiTemplateIssue(api, next);
    if (issue) { templateIssue = issue; return []; }
    return [make(index, 'first-frame', minimax ? 'first-frame' : 'reference', minimax ? undefined
      : '将以首帧用途传入通用 API；能否固定起始画面取决于接口及请求模板，未确认支持时请视为普通衔接参考。')];
  });
  // A first-image-only template is also a one-image connection. Do not apply
  // this fallback to multi-image or first+last-frame APIs, or to broken templates.
  if (!options.length && !minimax && references.length > 1 && api?.requestTemplate?.trim()
    && !videoTailApiTemplateIssue(api, [{ assetId: '__tail__', role: 'first-frame' }])
    && videoTailApiTemplateIssue(api, [{ assetId: '__tail__', role: 'first-frame' }, { assetId: '__end__', role: 'last-frame' }])) {
    return { options: [replaceAll('first-frame', 'reference', '当前请求模板只传入一张图片；确认后仅发送上段尾帧。能否固定起始画面取决于接口支持。')] };
  }
  return options.length ? { options } : { options, reason: templateIssue || (minimax
    ? 'MiniMax 官方接口仅支持一张首帧和一张尾帧，请先整理本段参考图用途。'
    : '本段存在多个首帧用途，请先整理参考图后再应用尾帧。') };
};

/** A composite is insertion, never replacement: continuity is always image 1,
 * and every selected reference retains its order and purpose after it. Image
 * categories and historical slot-role labels are hints, not selection gates. */
export const getVideoTailCharacterPlacement = ({ backend, workflow, api, references }: VideoTailReferencePlacementInput): {
  placement?: VideoTailReferencePlacement; reason?: string;
} => {
  try { assertVideoReferenceSlots(references); }
  catch (cause) { return { reason: cause instanceof Error ? cause.message : String(cause) }; }
  if (new Set(references.map((reference) => reference.assetId)).size !== references.length) return { reason: '本段参考图有重复，请先调整；不会重复占用图片槽。' };
  let role: ReferenceRole = 'first-frame';
  let semantics: VideoTailReferencePlacement['semantics'] = backend === 'api' && api?.provider === 'minimax' ? 'first-frame' : 'reference';
  let warning = semantics === 'first-frame' ? '' : '将第 1 张图片以首帧用途传入通用 API，其余图片保留所选用途；能否固定起始画面取决于接口及请求模板，未确认支持时请视为普通衔接参考。';
  const needed = videoReferenceSlotSpan(references) + 1;
  const combined = videoBatchTailReferences(references, { mode: 'prepend', index: 0, role }, '__tail__');
  if (backend === 'comfyui' || (api?.provider === 'runninghub' && api.runningHubImageRoles)) {
    if (backend === 'comfyui' && !workflow) return { reason: '请先选择视频工作流。' };
    const slots = backend === 'comfyui' ? workflow!.mapping.images : api!.runningHubImageRoles!.map((slotRole) => ({ role: slotRole }));
    if (needed > slots.length) return { reason: `本地末帧＋参考图需要 ${needed} 个图片槽（1 张末帧＋${references.length} 张参考图），当前工作流只有 ${slots.length} 个；请增加映射槽或调整选图，不会丢弃图片。` };
    const firstRole = slots[0]?.role;
    role = firstRole === 'first-frame' ? 'first-frame' : firstRole === 'composition' ? 'composition' : 'general';
    semantics = role === 'first-frame' ? 'first-frame' : 'reference';
    const warnings = semantics === 'reference' ? ['第 1 槽为普通/构图参考，用于本地末帧画面衔接，不保证视频严格从该帧开始；其余槽保留所选参考图及用途。'] : [];
    if (firstRole && !['unknown', 'general', 'composition', 'first-frame'].includes(firstRole)) {
      warnings.push(`第 1 个图片槽原用途为${videoReferenceRoleName(firstRole)}，本次仍按已选位置传入本地末帧；用途差异仅作提示，不阻止生成。`);
    }
    for (let index = 0; index < references.length; index += 1) {
      const slotIndex = videoReferenceSlotIndex(references[index], index) + 1;
      const slotRole = slots[slotIndex]?.role;
      if (slotRole && !['general', 'unknown', references[index].role].includes(slotRole)) {
        warnings.push(`第 ${slotIndex + 1} 个图片槽原用途为${videoReferenceRoleName(slotRole)}，本次选择用途为${videoReferenceRoleName(references[index].role)}；保留选图，仅提示用途差异，不阻止生成。`);
      }
    }
    warning = warnings.join(' ');
    if (backend === 'comfyui') {
      const usedBindings = combined.map((reference, index) => workflow!.mapping.images[videoReferenceSlotIndex(reference, index)]);
      const bindingKeys = usedBindings.map((binding) => JSON.stringify([binding.nodeId, binding.inputName]));
      if (new Set(bindingKeys).size !== combined.length) return { reason: '当前工作流图片槽重复绑定了同一节点输入，会覆盖参考图；请为每个图片槽绑定独立输入。' };
      try {
        const probePrompt = '__tail_character_prompt_check__';
        const bound = bindComfyVideoWorkflow(workflow!, probePrompt, combined.map((_, index) => `tail-character-slot-${index}.png`), {}, combined);
        if (workflow!.mapping.prompt.some((binding) => bound[binding.nodeId]?.inputs[binding.inputName] !== probePrompt)) {
          return { reason: '当前工作流图片槽与提示词绑定了同一输入，会覆盖提示词；请分别绑定图片和提示词输入。' };
        }
      } catch (cause) { return { reason: cause instanceof Error ? cause.message : String(cause) }; }
    }
  }
  if (backend === 'api') {
    const issue = videoTailApiTemplateIssue(api, [{ ...combined[0], role }, ...combined.slice(1)], true);
    if (issue) return { reason: issue };
  }
  return { placement: { id: `prepend-0-${role}`, mode: 'prepend', index: 0, role, semantics,
    label: `第 1 槽放本地真实末帧${references.length ? `，第 2–${needed} 槽保留 ${references.length} 张参考图及所选用途` : '，不附加其它参考图'}`,
    ...(warning ? { warning } : {}), requiresConfirmation: false, referenceFingerprint: referenceFingerprint(references) } };
};

/** Changes only confirmed references. The extracted asset remains a last-frame asset;
 * first-frame is a use in this draft, not a mutation of the original image. */
export const applyVideoTailReference = ({ references, tailAssetId, placement, confirmed = false }: {
  references: readonly VideoImageReference[];
  tailAssetId: string;
  placement: VideoTailReferencePlacement;
  confirmed?: boolean;
}): VideoImageReference[] => {
  if (!tailAssetId.trim()) throw new Error('尾帧图片尚未保存，不能应用参考图。');
  if (referenceFingerprint(references) !== placement.referenceFingerprint) throw new Error('本段参考图已变化，请重新确认尾帧要使用的图片槽。');
  if (placement.requiresConfirmation && !confirmed) throw new Error('请明确确认替换所选参考图后再应用尾帧。');
  if (placement.mode !== 'replace-all' && references.some((reference, index) => reference.assetId === tailAssetId && (placement.mode === 'prepend' || index !== placement.index))) throw new Error('该尾帧已在本段其他图片槽中，请先调整选图，不能重复添加。');
  return videoBatchTailReferences(references, placement, tailAssetId);
};

/** UI configuration contains no image placeholder or historical video choice.
 * The final predecessor item key is resolved only from the confirmed selection. */
export interface AutomaticVideoTailConfiguration {
  predecessorSegmentId: string;
  predecessorSegmentIndex: number;
  placement: VideoTailReferencePlacement;
  connectionScope: string;
  sequenceFingerprint: string;
  /** Absent keeps the original exact-last-frame path, with no vision request. */
  selectionMode?: 'ai-assisted';
  requireAiSelection?: true;
}
export interface AutomaticVideoTailCandidate {
  key: string;
  sequencePlanId: string;
  segmentId: string;
  segmentIndex: number;
  title?: string;
  draft: VideoGenerationDraft;
}
export interface AutomaticVideoTailEntry {
  segmentId: string;
  segmentIndex: number;
  title: string;
  predecessorSegmentId?: string;
  predecessorSegmentIndex?: number;
  options: VideoTailReferencePlacement[];
  placementId: string;
  keepManual?: boolean;
  reason?: string;
  selectionMode?: 'ai-assisted';
  requireAiSelection?: true;
}
type AutomaticVideoTailContext = Omit<VideoTailReferencePlacementInput, 'references'> & {
  project: Pick<Project, 'sequencePlans'>;
  sequencePlanId: string;
  selected: readonly AutomaticVideoTailCandidate[];
};

export const videoTailSequenceFingerprint = (project: Pick<Project, 'sequencePlans'>, sequencePlanId: string): string =>
  JSON.stringify(project.sequencePlans.filter((plan) => plan.id === sequencePlanId)
    .map((plan) => [plan.id, [...plan.segments].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
      .map((segment) => [segment.id, segment.index, segment.storyboardId])]));

const selectedAutomaticVideoTails = (selected: readonly AutomaticVideoTailCandidate[], sequencePlanId: string): AutomaticVideoTailCandidate[] => {
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const candidate of selected) {
    if (candidate.sequencePlanId !== sequencePlanId) throw new Error('所选段不属于当前计划，请重新选择。');
    if (ids.has(candidate.segmentId) || keys.has(candidate.key)) throw new Error('同一段只能选择一份中文或英文稿，不能重复生成两份。');
    ids.add(candidate.segmentId); keys.add(candidate.key);
  }
  return [...selected].sort((a, b) => a.segmentIndex - b.segmentIndex || a.segmentId.localeCompare(b.segmentId));
};

/** Plans only selected rows. A gap never authorizes selecting or charging for an extra row. */
export const buildAutomaticVideoTailEntries = ({ project, sequencePlanId, selected, backend, workflow, api }: AutomaticVideoTailContext): AutomaticVideoTailEntry[] => {
  const ordered = selectedAutomaticVideoTails(selected, sequencePlanId);
  return ordered.map((candidate, index): AutomaticVideoTailEntry => {
    const entry = { segmentId: candidate.segmentId, segmentIndex: candidate.segmentIndex,
      title: candidate.title || candidate.draft.name || `第 ${candidate.segmentIndex} 段`, options: [], placementId: '' };
    if (!index) return { ...entry, keepManual: true, reason: '本轮起始段保留手动参考图，不自动依赖前段。' };
    const locator = lookupPreviousSequenceSegment(project, { sequencePlanId, segmentId: candidate.segmentId });
    if (!locator.previousSegment) return { ...entry, reason: locator.reason };
    const predecessor = locator.previousSegment;
    if (!ordered.some((item) => item.segmentId === predecessor.id && item.segmentIndex === predecessor.index)) {
      return { ...entry, reason: `未设置：请同时选择第 ${predecessor.index} 段；不能借用其他段或历史成片，也不会自动增选收费段。` };
    }
    const placements = getVideoTailReferencePlacements({ backend, workflow, api, references: candidate.draft.references });
    const preferred = preferredVideoTailReferencePlacement(placements.options, candidate.draft.references);
    return { ...entry, predecessorSegmentId: predecessor.id, predecessorSegmentIndex: predecessor.index,
      options: placements.options, placementId: preferred?.id || '', reason: placements.reason };
  });
};

export const buildOneClickVideoTailEntries = (context: AutomaticVideoTailContext): AutomaticVideoTailEntry[] =>
  buildAutomaticVideoTailEntries(context).map((entry) => {
    const references = context.selected.find((candidate) => candidate.segmentId === entry.segmentId)?.draft.references || [];
    return { ...entry,
      placementId: oneClickVideoTailReferencePlacement(entry.options, references)?.id || '' };
  });

/** Applies the full reviewed list, including clearing a previously configured row
 * when the user now leaves its selection blank or makes it the first selected row. */
export const applyAutomaticVideoTailEntries = ({ current, entries, connectionScope, sequenceFingerprint, confirmed = false }: {
  current: Readonly<Record<string, AutomaticVideoTailConfiguration>>;
  entries: readonly AutomaticVideoTailEntry[];
  connectionScope: string;
  sequenceFingerprint: string;
  confirmed?: boolean;
}): Record<string, AutomaticVideoTailConfiguration> => {
  const next = { ...current };
  for (const entry of entries) {
    delete next[entry.segmentId];
    const placement = entry.options.find((option) => option.id === entry.placementId);
    if (!placement || entry.keepManual) continue;
    if (!entry.predecessorSegmentId || !entry.predecessorSegmentIndex) throw new Error('上一段关系已变化，请重新设置自动衔接。');
    if (placement.requiresConfirmation && !confirmed) throw new Error('请明确确认替换清单中的参考图后再启用自动衔接。');
    next[entry.segmentId] = { predecessorSegmentId: entry.predecessorSegmentId,
      predecessorSegmentIndex: entry.predecessorSegmentIndex, placement: structuredClone(placement), connectionScope, sequenceFingerprint,
      ...(entry.selectionMode === 'ai-assisted' ? { selectionMode: 'ai-assisted' as const } : {}),
      ...(entry.requireAiSelection ? { requireAiSelection: true as const } : {}) };
  }
  return next;
};

interface AutomaticVideoTailResolution extends AutomaticVideoTailContext {
  candidate: AutomaticVideoTailCandidate;
  configuration?: AutomaticVideoTailConfiguration;
  connectionScope: string;
  toolsAvailable: boolean;
}
export const automaticVideoTailIssue = ({ candidate, configuration, project, sequencePlanId, selected, backend, workflow, api, connectionScope, toolsAvailable }: AutomaticVideoTailResolution): string => {
  if (!configuration) return '';
  if (!toolsAvailable) return '自动衔接需要可用的本地视频抽帧工具';
  if (configuration.connectionScope !== connectionScope) return '连接已变化，请重新确认自动衔接图片槽';
  if (configuration.sequenceFingerprint !== videoTailSequenceFingerprint(project, sequencePlanId)) return '计划分段已变化，请重新设置自动衔接';
  try { selectedAutomaticVideoTails(selected, sequencePlanId); } catch (cause) { return (cause as Error).message; }
  if (candidate.sequencePlanId !== sequencePlanId) return '本段不属于当前计划，请重新选择';
  const locator = lookupPreviousSequenceSegment(project, { sequencePlanId, segmentId: candidate.segmentId });
  if (!locator.previousSegment || locator.previousSegment.id !== configuration.predecessorSegmentId
    || locator.previousSegment.index !== configuration.predecessorSegmentIndex
    || locator.previousSegment.index !== candidate.segmentIndex - 1) return locator.reason || '上一段关系已变化，请重新设置自动衔接';
  const input = { backend, workflow, api, references: candidate.draft.references };
  const composite = configuration.placement.mode === 'prepend' ? getVideoTailCharacterPlacement(input) : undefined;
  if (composite && !composite.placement) return composite.reason || '本段参考图或图片槽已变化，请重新设置本地末帧＋参考图';
  const options = composite?.placement ? [composite.placement] : getVideoTailReferencePlacements(input).options;
  const matching = options.find((option) => (
    option.id === configuration.placement.id && option.referenceFingerprint === configuration.placement.referenceFingerprint
    && option.replacedAssetId === configuration.placement.replacedAssetId && option.semantics === configuration.placement.semantics
    && JSON.stringify(option.replacedReferences) === JSON.stringify(configuration.placement.replacedReferences)
    && option.mode === configuration.placement.mode && option.index === configuration.placement.index && option.role === configuration.placement.role
    && option.slotIndex === configuration.placement.slotIndex
  ));
  if (!matching) return '本段选图或用途已变化，请重新确认自动衔接位置';
  if (!selected.some((entry) => entry.segmentId === configuration.predecessorSegmentId && entry.segmentIndex === configuration.predecessorSegmentIndex)) {
    return `自动衔接需要同时选择第 ${configuration.predecessorSegmentIndex} 段；不会用其他段代替，也不会自动增选收费段`;
  }
  return '';
};

/** Fails closed: a stale/missing dependency must not turn into an independent
 * paid task. The draft remains static; the engine creates and fills its reserved slot. */
export const resolveAutomaticVideoTailInput = (input: AutomaticVideoTailResolution): VideoBatchItemInput['previousTail'] => {
  if (!input.configuration) return undefined;
  const issue = automaticVideoTailIssue(input);
  if (issue) throw new Error(issue);
  const predecessor = input.selected.find((entry) => entry.segmentId === input.configuration!.predecessorSegmentId)!;
  const placement = input.configuration.placement;
  return { predecessorItemKey: predecessor.key,
    ...(input.configuration.selectionMode === 'ai-assisted' ? { selectionMode: 'ai-assisted' as const } : {}),
    ...(input.configuration.requireAiSelection ? { requireAiSelection: true as const } : {}), placement: {
    mode: placement.mode, index: placement.index, role: placement.role, replacedAssetId: placement.replacedAssetId,
    ...(placement.slotIndex === undefined ? {} : { slotIndex: placement.slotIndex }),
    ...(placement.replacedReferences ? { replacedReferences: placement.replacedReferences.map((reference) => ({ ...reference })) } : {}),
  } };
};

export const videoTailTaskPresentation = (task: VideoGenerationTask): {
  statusLabel?: string; message?: string; canRetry: boolean; canCancel: boolean;
} => {
  const job = task.videoJob; const tail = job?.tailPreparation;
  const beforePost = Boolean(job?.snapshot.previousTail && job.preparation?.phase === 'preparing' && !task.remoteTaskId && task.status !== 'unknown');
  const cancelled = job?.batchQueueState === 'cancelled' || tail?.phase === 'cancelled' || Boolean(job?.cancellationPending);
  const pending = beforePost && !cancelled && Boolean(tail && ['waiting', 'extracting', 'blocked'].includes(tail.phase));
  const statusLabel = !pending ? undefined : tail?.phase === 'blocked' ? '尾帧衔接待处理'
    : tail?.phase === 'extracting' ? '正在抽取上段尾帧' : '等待上一段视频';
  return { statusLabel, message: pending ? tail?.message : undefined,
    canRetry: Boolean(pending && tail?.phase === 'blocked'), canCancel: pending };
};
