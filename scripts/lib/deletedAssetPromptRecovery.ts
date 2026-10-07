import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { composeDerivedLocalPrompt, hasCurrentTextApiConversion } from '../../src/appEffects';
import { officialH3ContextForStoryboard } from '../../src/officialH3Context';
import { compileOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../../src/officialPrompt';
import type { Project, Storyboard } from '../../src/types';

export interface RecoveryState {
  project: Project;
  projects: Array<Project | { id: string; __activeProjectReference: true }>;
  [key: string]: unknown;
}

export interface RecoveryTarget { projectId: string; storyboardId: string; sequencePlanId: string; }
export interface RecoveryResult {
  status: 'recoverable' | 'already-current';
  state: RecoveryState;
  removedOutputIds: string[];
  restoredFields: string[];
}

// Only the saved authored delivery and its provenance are restored. In particular
// shots, current image selections, assets, tasks, plans, revisions and settings
// always come from today's state, never from the historical project snapshot.
const promptFields = [
  'finalPrompt', 'promptPlan', 'promptTrace', 'promptMigrationPending',
  'englishPrompt', 'englishPromptSource', 'officialPromptZh', 'officialPromptEn',
  'officialPromptSource', 'officialPromptEnSource', 'officialPromptEnError',
  'h3IdentityBindings', 'h3IdentityBindingsEn', 'targetModelId', 'targetOutput', 'seedance25Output',
] as const satisfies ReadonlyArray<keyof Storyboard>;

const reject = (reason: string): never => { throw new Error(`拒绝定点恢复：${reason}；现有项目不变。`); };
const projectIn = (state: RecoveryState, id: string): Project => {
  const entries = [state.project, ...state.projects.filter((project) => !('__activeProjectReference' in project))]
    .filter((project) => project.id === id) as Project[];
  if (!entries.length || entries.some((project) => !isDeepStrictEqual(project, entries[0]))) {
    return reject('目标项目不存在，或当前项目与项目库副本不一致');
  }
  return entries[0];
};
const boardIn = (project: Project, id: string): Storyboard => {
  const boards = project.storyboards.filter((board) => board.id === id);
  if (boards.length !== 1) return reject('目标分镜不存在或 ID 重复');
  return boards[0];
};
const without = (object: object, keys: readonly string[]): object => Object.fromEntries(
  Object.entries(object).filter(([key]) => !keys.includes(key)),
);

/** A deliberately narrow recovery: proves the historical single-newline
 * deletion defect instead of guessing whether an authored edit was intended. */
export const recoverDeletedAssetPrompt = (
  current: RecoveryState, snapshot: RecoveryState, target: RecoveryTarget, now = Date.now(),
): RecoveryResult => {
  const project = projectIn(current, target.projectId);
  const previousProject = projectIn(snapshot, target.projectId);
  const board = boardIn(project, target.storyboardId);
  const previous = boardIn(previousProject, target.storyboardId);
  if (board.sequencePlanId !== target.sequencePlanId || previous.sequencePlanId !== target.sequencePlanId
    || !board.segmentId || board.segmentId !== previous.segmentId) reject('分镜所属计划或段落不匹配');
  if (hasCurrentTextApiConversion(board)) return { status: 'already-current', state: current, removedOutputIds: [], restoredFields: [] };
  if (board.sourceStale || previous.sourceStale || board.characterDossierDirty) reject('剧情或人物资料已更改');
  const plan = project.sequencePlans.find((item) => item.id === target.sequencePlanId);
  const previousPlan = previousProject.sequencePlans.find((item) => item.id === target.sequencePlanId);
  if (!plan || !previousPlan || plan.sourceStale || !isDeepStrictEqual(plan, previousPlan)
    || !plan.segments.some((segment) => segment.id === board.segmentId && segment.storyboardId === board.id && segment.status === 'ready')) {
    reject('计划或段落已更改，不能复用旧稿');
  }
  if (!hasCurrentTextApiConversion(previous) || previous.promptTrace?.shotPlanMode !== 'ai-complete'
    || !hasCurrentOfficialH3EnglishPrompt(previous, officialH3ContextForStoryboard(previousProject, previous))) {
    reject('备份不是已完成且来源校验通过的中英文原稿');
  }
  if (!isDeepStrictEqual(board.promptTrace, previous.promptTrace)
    || board.finalPrompt !== composeDerivedLocalPrompt(board.shots)
    || previous.finalPrompt.replace(/\n\n/g, '\n') !== board.finalPrompt
    || board.officialPromptEn || board.englishPrompt
    || board.promptPlan?.canonicalPrompt !== board.finalPrompt
    || previous.promptPlan?.canonicalPrompt !== previous.finalPrompt
    || !isDeepStrictEqual(without(board.promptPlan || {}, ['canonicalPrompt']), without(previous.promptPlan || {}, ['canonicalPrompt']))) {
    reject('不符合旧删图程序仅重组镜头换行并清空英文的特征');
  }
  const currentContext = officialH3ContextForStoryboard(project, board);
  if (!hasCurrentOfficialH3Prompt(board, currentContext)
    || board.officialPromptZh !== compileOfficialH3Prompt(board, currentContext).compiled.prompt
    || board.targetModelId !== previous.targetModelId
    || !isDeepStrictEqual(board.targetOutput?.parameters, previous.targetOutput?.parameters)
    || !isDeepStrictEqual(board.targetOutput?.referenceManifest, previous.targetOutput?.referenceManifest)
    || !isDeepStrictEqual(board.h3IdentityBindings, previous.h3IdentityBindings)
    || !isDeepStrictEqual(board.h3IdentityBindingsEn, previous.h3IdentityBindingsEn)
    || board.seedance25Output && !isDeepStrictEqual(board.seedance25Output, previous.seedance25Output)) {
    reject('官方稿、身份标注、Seedance 稿或生成参数存在后续编辑');
  }
  const allowedBoardChanges = [...promptFields, 'shots', 'updatedAt', 'firstFrameAssetId', 'lastFrameAssetId', 'audioLedger'];
  if (!isDeepStrictEqual(without(board, allowedBoardChanges), without(previous, allowedBoardChanges))
    || !isDeepStrictEqual(board.audioLedger || [], previous.audioLedger || [])
    || board.shots.length !== previous.shots.length
    || board.shots.some((shot, index) => !isDeepStrictEqual(without(shot, ['referenceAssetIds']), without(previous.shots[index], ['referenceAssetIds'])))) {
    reject('源剧情、镜头、导演设置或其他分镜内容已更改');
  }
  const previousRefs = new Set([
    ...previous.shots.flatMap((shot) => shot.referenceAssetIds), previous.firstFrameAssetId, previous.lastFrameAssetId,
  ].filter((id): id is string => Boolean(id)));
  const currentAssetIds = new Set(project.assets.map((asset) => asset.id));
  const removedOutputIds = [...previousRefs].filter((id) => !currentAssetIds.has(id));
  const isOwnOutput = (sourceProject: Project, id: string): boolean => {
    const asset = sourceProject.assets.find((item) => item.id === id);
    return Boolean(asset?.source === 'generated' && asset.sourceStoryboardId === board.id
      && !previous.globalReferenceAssetIds?.includes(id));
  };
  if (!removedOutputIds.length || removedOutputIds.some((id) => !isOwnOutput(previousProject, id))) {
    reject('缺少已删除自产首尾帧或分镜图片的证据，或实际输入参考素材已删除');
  }
  const currentRefs = [...board.shots.flatMap((shot) => shot.referenceAssetIds), board.firstFrameAssetId, board.lastFrameAssetId]
    .filter((id): id is string => Boolean(id));
  if (currentRefs.some((id) => !currentAssetIds.has(id) || !previousRefs.has(id) && !isOwnOutput(project, id))) {
    reject('当前参考图含缺失绑定或新输入素材');
  }
  const restored = { ...board };
  for (const field of promptFields) {
    if (Object.prototype.hasOwnProperty.call(previous, field)) {
      (restored as unknown as Record<string, unknown>)[field] = previous[field];
    } else delete (restored as unknown as Record<string, unknown>)[field];
  }
  restored.updatedAt = now;
  if (!hasCurrentTextApiConversion(restored)
    || !hasCurrentOfficialH3EnglishPrompt(restored, officialH3ContextForStoryboard(project, restored))) {
    reject('备份原稿与当前项目上下文不再一致');
  }
  const repairedProject = { ...project, storyboards: project.storyboards.map((item) => item.id === board.id ? restored : item), updatedAt: now };
  return {
    status: 'recoverable', removedOutputIds,
    restoredFields: promptFields.filter((field) => !isDeepStrictEqual(board[field], restored[field])),
    state: {
      ...current,
      project: current.project.id === target.projectId ? repairedProject : current.project,
      projects: current.projects.map((item) => item.id === target.projectId && !('__activeProjectReference' in item) ? repairedProject : item),
    },
  };
};

export const contentChecksum = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Keep the native state checksum envelope without running general migrations
 * or touching the separate encrypted credential vault. */
export const encodeRecoveredState = (state: RecoveryState, now = Date.now()): string => {
  const body = JSON.stringify(without(state, ['integrity']));
  const integrity = { algorithm: 'sha256', checksum: contentChecksum(body), savedAt: now };
  return `${body.slice(0, -1)},"integrity":${JSON.stringify(integrity)}}`;
};

/** The caller checks process names again at the final compare-and-swap. Tests
 * supply the check to cover a newly opened application during preparation. */
export const writeRecoveryWithCompareAndSwap = (
  statePath: string, expectedOriginal: Buffer, replacement: string, assertAppClosed: () => void,
): { backupPath: string } => {
  assertAppClosed();
  const root = dirname(statePath);
  if (existsSync(`${statePath}.previous`) || existsSync(join(root, 'state-vault-transaction.json'))) {
    throw new Error('检测到未完成的保存事务，请先由软件完成恢复；现有项目不变。');
  }
  const lockPath = `${statePath}.prompt-recovery.lock`;
  const lock = openSync(lockPath, 'wx');
  const token = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = `${statePath}.before-prompt-repair-${token}.json`;
  const temporary = `${statePath}.prompt-recovery-${token}.tmp`;
  const durableWrite = (path: string, value: string | Buffer): void => {
    const handle = openSync(path, 'wx');
    try { writeFileSync(handle, value); fsyncSync(handle); } finally { closeSync(handle); }
  };
  try {
    if (!readFileSync(statePath).equals(expectedOriginal)) throw new Error('项目文件已变化，请重新检查；现有项目不变。');
    durableWrite(backupPath, expectedOriginal);
    durableWrite(temporary, replacement);
    assertAppClosed();
    if (!readFileSync(statePath).equals(expectedOriginal)) throw new Error('写入前发现项目文件已变化；取消恢复并保留修改。');
    // Same-directory rename replaces the file atomically; the uniquely named
    // full original backup remains available even after successful repair.
    renameSync(temporary, statePath);
    return { backupPath };
  } finally {
    closeSync(lock);
    if (existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(lockPath);
  }
};
