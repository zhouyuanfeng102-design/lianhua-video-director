import { parseMasterTimelinePrompt, topLevelCanonicalFieldLocations } from './masterTimeline';
import { synchronizeAiAuthoredH3StagingDelivery, synchronizeH3StagingDelivery, type AiAuthoredH3StagingSyncResult } from './h3StagingDelivery';
import type { Storyboard } from './types';
import type { H3StagingShotMetadata } from './h3StagingMetadata';

export const CHARACTER_DOSSIER_REFRESH_RULE = [
  'CHARACTER_DOSSIER_REFRESH_V1：本次仅把用户已确认的新普通人物资料及当前参考图应用到已有提示词。characterIdentityFacts是本次人物的当前资料；changedCharacterIds标识受影响人物。candidatePrompt与canonicalPrompt中的旧外观基准是待更新内容，不得因它们写在旧稿中就覆盖用户新资料。仅更新这些人物的普通身份、外观、体态、惯常服装与参考图职责；剧情明确的临时换装/动作状态仍以当前剧情为准。其他人物不改。',
  '保留原剧情事件、动作因果、人物出场与说话人、每句对白原字、已有台词和音效时间、音乐及音量安排、机位与光影、镜头顺序、镜数、镜头id、固定切点和总时长。不能重新导演、拆镜、合镜或借资料更新补新剧情。原文没有要求时，不因为新服装或资料自动改变人物动作或可见范围；私密资料不属于本次覆盖范围。原H3中的主体编号和声源编号保持；转移人物后的当前ID以给定资料为准。',
  '只返回完整JSON对象：{"canonicalPrompt":"与原镜数、切点一致的完整普通六字段正文","h3Prompt":"同一内容的完整合法H3正文","identityBindings":{"version":1,"characters":[]},"shotSourceIds":[["对应原shot.id"]],"shotMetadata":[null]}。两稿同步更新普通人物事实，禁止只改H3留下旧canonicalPrompt；shotSourceIds严格一对一且原序，每项仅包含该位置原shot.id；shotMetadata全部为null，不改变来源范围和已保存镜头状态。canonicalPrompt沿用原【起始s-结束s】主体/空间/光影/镜头/台词/音效六字段格式；台词、音效字段原文保持。',
  'H3原section名称、参考标签语法、[Shot N]与At切点格式保持，不添加人物资料JSON到H3正文。只更新实际变更的图片编号/职责与普通身份句，保持有效referenceAnchor逐字对应；不把管理别名写入对白。不要审核说明、代码围栏或局部补丁。',
].join('\n');

const soundFields = (prompt: string): string[] => {
  const fields = topLevelCanonicalFieldLocations(prompt);
  return ['台词：', '音效：'].map((name) => {
    const index = fields.findIndex((field) => field.field === name);
    return index < 0 ? '' : prompt.slice(fields[index].start + name.length, fields[index + 1]?.start).replace(/[；;]\s*$/u, '').trim();
  });
};

/** Serialization checks only: refresh cannot expand into a schedule or audio edit. */
export const synchronizeCharacterDossierRefresh = (
  board: Storyboard, canonicalPrompt: string, shotSourceIds?: readonly (readonly string[])[],
  shotMetadata?: readonly (H3StagingShotMetadata | null)[],
): Storyboard => {
  if (!shotSourceIds || shotSourceIds.length !== board.shots.length || shotSourceIds.some((ids, index) => ids.length !== 1 || ids[0] !== board.shots[index].id)) {
    throw new Error('人物资料更新必须保持原镜头一对一顺序，不能重排、合并或拆分镜头。');
  }
  if (shotMetadata?.some((item) => item !== null)) throw new Error('人物资料更新不能修改原镜头的来源范围或可见状态。');
  const entries = parseMasterTimelinePrompt(canonicalPrompt, board.durationSec);
  if (entries.length !== board.shots.length || entries.some((entry, index) => entry.startSec !== board.shots[index].startSec || entry.endSec !== board.shots[index].endSec)) {
    throw new Error('人物资料更新改变了镜数或时间切点，不能保存。');
  }
  const oldEntries = parseMasterTimelinePrompt(board.finalPrompt, board.durationSec);
  if (oldEntries.length !== board.shots.length || entries.some((entry, index) =>
    JSON.stringify(soundFields(entry.prompt)) !== JSON.stringify(soundFields(oldEntries[index].prompt)))) {
    throw new Error('人物资料更新改变了台词或音效字段，必须保留原文后再交付。');
  }
  const synchronized = synchronizeH3StagingDelivery(board, canonicalPrompt, shotSourceIds);
  return { ...synchronized, audioLedger: board.audioLedger,
    shots: synchronized.shots.map((shot, index) => ({ ...shot,
      result: board.shots[index].result, transition: board.shots[index].transition,
      performance: board.shots[index].performance, direction: board.shots[index].direction,
    })),
  };
};

/** AI owns dossier refresh content; local comparisons only retain valid caches. */
export const synchronizeAiAuthoredCharacterDossierRefresh = (
  board: Storyboard, canonicalPrompt?: string, shotSourceIds?: readonly (readonly string[])[],
  shotMetadata?: readonly (H3StagingShotMetadata | null)[],
): AiAuthoredH3StagingSyncResult => {
  const result = synchronizeAiAuthoredH3StagingDelivery(board, canonicalPrompt, shotSourceIds, shotMetadata);
  if (!result.timelineSynchronized) return result;
  const oldById = new Map(board.shots.map((shot) => [shot.id, shot]));
  const sameSoundCache = result.board.shots.length === board.shots.length && result.board.shots.every((shot) => {
    const old = oldById.get(shot.id);
    return old && old.startSec === shot.startSec && old.endSec === shot.endSec
      && JSON.stringify(soundFields(old.prompt)) === JSON.stringify(soundFields(shot.prompt));
  });
  return {
    ...result,
    board: {
      ...result.board,
      audioLedger: sameSoundCache ? board.audioLedger : undefined,
      shots: result.board.shots.map((shot) => {
        const old = oldById.get(shot.id);
        return old ? { ...shot, result: old.result, transition: old.transition, performance: old.performance, direction: old.direction } : shot;
      }),
    },
  };
};
