import type { AppState, ReferenceAsset } from './types';
import {
  sequencePlanMasterConfirmationIssue,
  sequencePlanMasterDirectorSettingsIssue,
  sequencePlanMasterStoryboardIssue,
  validateSequencePlan,
} from './storySegmentation';
import { isSemanticSequencePlan } from './semanticSequencePlan';

export interface StateDiagnostic {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: {
    storyboards: number;
    sequencePlans: number;
    segments: number;
    shots: number;
    assets: number;
    missingAssets: number;
    orphanReferences: number;
  };
}

export const diagnoseState = (state: AppState): StateDiagnostic => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assetIds = new Set(state.project.assets.map((asset) => asset.id));
  const storyboardIds = new Set(state.project.storyboards.map((board) => board.id));
  const sequencePlans = Array.isArray(state.project.sequencePlans) ? state.project.sequencePlans : [];
  const orphanReferences: string[] = [];
  state.project.storyboards.forEach((board) => {
    if (!board.id) errors.push('存在缺少 ID 的分镜组');
    if (!board.shots.length) warnings.push(`分镜组 ${board.id} 没有镜头`);
    board.shots.forEach((shot) => {
      if (!shot.id) errors.push(`分镜组 ${board.id} 存在缺少 ID 的镜头`);
      shot.referenceAssetIds.forEach((id) => { if (!assetIds.has(id)) orphanReferences.push(`${shot.id}:${id}`); });
    });
  });
  state.project.scenes.forEach((scene) => scene.storyboardIds.forEach((id) => {
    if (!storyboardIds.has(id)) warnings.push(`场景 ${scene.title} 引用了缺失的分镜组 ${id}`);
  }));
  sequencePlans.forEach((plan) => {
    if (!plan.id) errors.push('存在缺少 ID 的序列计划');
    const segments = Array.isArray(plan.segments) ? plan.segments : [];
    const semantic = isSemanticSequencePlan(plan);
    const planningStage = plan.planningStage === 'master-draft'
      || plan.planningStage === 'master-confirmed'
      || plan.planningStage === 'segmented'
      ? plan.planningStage
      : segments.length > 0
        ? 'segmented'
        : 'master-draft';
    const masterIssue = semantic ? undefined : planningStage === 'master-confirmed'
      ? sequencePlanMasterConfirmationIssue(plan, state.project.storyboards)
      : sequencePlanMasterStoryboardIssue(plan, state.project.storyboards);
    if (masterIssue) {
      warnings.push(`序列计划 ${plan.id || '(unknown)'}：${masterIssue}`);
    } else if (!semantic && planningStage === 'master-draft') {
      warnings.push(`序列计划 ${plan.id || '(unknown)'}：全片总提示词待确认。`);
    }
    if (semantic) {
      validateSequencePlan(plan).forEach((issue) => warnings.push(`序列计划 ${plan.id || '(unknown)'}：${issue}`));
    }
    const directorSettingsIssue = planningStage === 'master-confirmed' || planningStage === 'segmented'
      ? sequencePlanMasterDirectorSettingsIssue(
          plan,
          state.project.directorSettingsConfirmedFingerprint || "",
        )
      : undefined;
    if (directorSettingsIssue) {
      warnings.push(`序列计划 ${plan.id || '(unknown)'}：${directorSettingsIssue}`);
    }
    if (segments.length > 0 && planningStage !== 'segmented') {
      warnings.push(`序列计划 ${plan.id || '(unknown)'}：全片规划阶段与已存在的视频分段数据矛盾，请修复阶段状态。`);
    }
    const masterStoryboardId = !semantic && typeof plan.masterStoryboardId === 'string'
      ? plan.masterStoryboardId.trim()
      : '';
    let hasMissingMasterShotLinks = false;
    segments.forEach((segment) => {
      if (!segment.id) errors.push(`序列计划 ${plan.id || '(unknown)'} 存在缺少 ID 的片段`);
      const segmentLabel = `序列片段 ${segment.id || '(unknown)'}`;
      const storyboardId = typeof segment.storyboardId === 'string'
        ? segment.storyboardId.trim()
        : '';
      const linkedBoard = storyboardId
        ? state.project.storyboards.find((board) => board.id === storyboardId)
        : undefined;
      if (storyboardId && !storyboardIds.has(storyboardId)) {
        warnings.push(`${segmentLabel} 引用了缺失的分镜组 ${storyboardId}`);
        if (segment.status === 'ready') {
          warnings.push(`${segmentLabel} 标记为已完成，但对应分镜结果缺失，请重新生成本段`);
        }
      }
      if (segment.status === 'ready' && !storyboardId) {
        warnings.push(`${segmentLabel} 标记为已完成但没有分镜 ID，结果缺失，请重新生成本段`);
      } else if (
        segment.status === 'ready'
        && linkedBoard
        && (typeof linkedBoard.finalPrompt !== 'string' || !linkedBoard.finalPrompt.trim())
      ) {
        warnings.push(`${segmentLabel} 对应分镜 ${storyboardId} 的最终提示词为空，结果不完整，请重新生成本段`);
      }
      if (segment.status === 'generating') {
        warnings.push(`${segmentLabel} 仍处于生成中状态；应用启动时会自动修复为失败并提供重试`);
      }
      if (segment.status === 'failed' && !segment.failureReason?.trim()) {
        warnings.push(`${segmentLabel} 已失败但没有记录失败原因`);
      }
      if (segment.sourceShotIds !== undefined) {
        if (
          !Array.isArray(segment.sourceShotIds)
          || segment.sourceShotIds.some((shotId) => typeof shotId !== 'string' || !shotId.trim())
        ) {
          warnings.push(`${segmentLabel} 的 sourceShotIds 格式无效`);
        }
      }
      if (masterStoryboardId && (!Array.isArray(segment.sourceShotIds) || segment.sourceShotIds.length === 0)) {
        hasMissingMasterShotLinks = true;
      }
    });
    if (masterStoryboardId && hasMissingMasterShotLinks) {
      warnings.push(`序列计划 ${plan.id || '(unknown)'} 的总时间轴已生成，但部分片段缺少 sourceShotIds`);
    }
  });
  const seenAssetIds = new Set<string>();
  const duplicateIds = state.project.assets.filter((asset) => {
    if (seenAssetIds.has(asset.id)) return true;
    seenAssetIds.add(asset.id); return false;
  });
  if (duplicateIds.length) errors.push(`存在 ${duplicateIds.length} 个重复资产 ID`);
  if (orphanReferences.length) warnings.push(`存在 ${orphanReferences.length} 个失效的镜头资产引用`);
  const missingAssets = state.project.assets.filter((asset: ReferenceAsset) => asset.missing).length;
  if (missingAssets) warnings.push(`${missingAssets} 个托管媒体文件缺失`);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      storyboards: state.project.storyboards.length,
      sequencePlans: sequencePlans.length,
      segments: sequencePlans.reduce((sum, plan) => sum + (Array.isArray(plan.segments) ? plan.segments.length : 0), 0),
      shots: state.project.storyboards.reduce((sum, board) => sum + board.shots.length, 0),
      assets: state.project.assets.length,
      missingAssets,
      orphanReferences: orphanReferences.length,
    },
  };
};
