import type { Project, Storyboard } from './types';
import type { H3IdentityRepairResult } from './h3IdentityRepair';
import { getH3IdentityBindingIssues } from './h3IdentityBindings';
import { normalizeCharacterParticipationSnapshot, stampCharacterParticipation } from './characterParticipation';
import { sourceContentHash } from './sourceContentHash';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from './officialPrompt';
import { createStoryboardRevision } from './storyboardVersions';
import { buildSequencePromptHandoff, getSequencePromptHandoffStatus, sealSequencePromptHandoff, stampSequencePromptHandoff } from './sequencePromptHandoff';

/** The repair service can only add identity declarations. Reject accidental
 * whole-body edits at the persistence boundary as well. */
const assertInsertionsOnly = (source: string, result: H3IdentityRepairResult, language: 'zh' | 'en'): void => {
  const separator = source.includes('\r\n') ? '\r\n' : '\n';
  const inserted = result.edits.flatMap((edit) => edit.text.startsWith(separator) && edit.text.endsWith(separator)
    ? edit.text.slice(separator.length, -separator.length).split(separator) : ['']);
  if (inserted.length !== result.insertedSentences.length
    || new Set(inserted).size !== inserted.length
    || inserted.some((sentence) => !result.insertedSentences.includes(sentence))) {
    throw new Error('身份修复包含非身份声明的插入，原稿保持不变。');
  }
  for (const sentence of result.insertedSentences) {
    const binding = result.identityBindings.characters.find((item) => item.referenceAnchor === sentence);
    const identity = binding && [binding.name, binding.subjectToken, binding.speakerToken].filter(Boolean).join(' ');
    if (!binding || sentence !== (language === 'zh' ? `身份：${identity}。` : `Identity: ${identity}.`)) {
      throw new Error('身份修复不能插入剧情或外貌改写。');
    }
  }
  let candidate = source;
  let boundary = source.length + 1;
  for (const edit of [...result.edits].sort((a, b) => b.start - a.start)) {
    if (!Number.isInteger(edit.start) || edit.start < 0 || edit.start > source.length || edit.start >= boundary) {
      throw new Error('身份修复插入位置无效，原稿保持不变。');
    }
    candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.start);
    boundary = edit.start;
  }
  if (candidate !== result.prompt) throw new Error('身份修复试图改动原正文，结果未保存。');
};

export const commitH3IdentityRepair = (
  project: Project, boardId: string,
  results: { zh?: H3IdentityRepairResult; en?: H3IdentityRepairResult },
  now = Date.now(),
): Project => {
  const source = project.storyboards.find((board) => board.id === boardId);
  const context = officialH3ContextForStoryboard(project, source);
  if (!source || !hasCurrentOfficialH3Prompt(source, context)) throw new Error('原中文提示词已变化，修复结果未保存。');
  const englishCurrent = hasCurrentOfficialH3EnglishPrompt(source, context);
  if (results.en && !englishCurrent) throw new Error('原英文提示词已变化，修复结果未保存。');
  if (results.zh) assertInsertionsOnly(source.officialPromptZh!, results.zh, 'zh');
  if (results.en) assertInsertionsOnly(source.officialPromptEn!, results.en, 'en');
  for (const result of [results.zh, results.en]) {
    if (!result) continue;
    const issues = getH3IdentityBindingIssues(result.prompt, result.identityBindings, context.characters)
      .filter((issue) => result.repairedCharacterIds.includes(issue.characterId));
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
  }
  const zhPromptChanged = Boolean(results.zh && results.zh.prompt !== source.officialPromptZh);
  if (zhPromptChanged && englishCurrent && !results.en) throw new Error('中文身份句变化时必须同时修复当前英文，原稿保持不变。');
  const changed = results.zh && (zhPromptChanged || JSON.stringify(results.zh.identityBindings) !== JSON.stringify(source.h3IdentityBindings))
    || results.en && (results.en.prompt !== source.officialPromptEn || JSON.stringify(results.en.identityBindings) !== JSON.stringify(source.h3IdentityBindingsEn));
  if (!changed) return project;
  let repaired: Storyboard = { ...source, updatedAt: now };
  if (results.zh) {
    repaired.officialPromptZh = results.zh.prompt;
    repaired.h3IdentityBindings = results.zh.identityBindings;
    const participation = normalizeCharacterParticipationSnapshot(source.h3CharacterParticipation);
    if (participation?.promptFingerprint === sourceContentHash(source.officialPromptZh!)) {
      repaired.h3CharacterParticipation = stampCharacterParticipation(results.zh.prompt, participation);
    }
    if (source.targetOutput) repaired.targetOutput = { ...source.targetOutput, prompt: results.zh.prompt };
  }
  if (results.en) {
    repaired.officialPromptEn = results.en.prompt;
    repaired.officialPromptEnSource = repaired.officialPromptZh;
    repaired.englishPrompt = results.en.prompt;
    repaired.englishPromptSource = source.finalPrompt;
    repaired.h3IdentityBindingsEn = results.en.identityBindings;
    repaired.officialPromptEnError = '';
  }
  // Only proven identity insertions can re-seal already-current provenance.
  // Never certify a previously stale/unavailable handoff as newly reviewed.
  if (zhPromptChanged && source.sequencePromptHandoff
    && getSequencePromptHandoffStatus(source, project).kind === 'current') {
    repaired.sequencePromptHandoff = sealSequencePromptHandoff(repaired, source.sequencePromptHandoff);
  }
  const history = source.revisions || [];
  const before = createStoryboardRevision(source, history, { reason: 'pre-identity-repair', label: '人物图片绑定修复前', createdAt: now });
  const after = createStoryboardRevision(repaired, [...history, before], { reason: 'identity-repair', label: '人物图片绑定修复', createdAt: now + 1 });
  repaired = { ...repaired, revisions: [...history, before, after], activeRevisionId: after.id };
  let next: Project = { ...project, updatedAt: now, storyboards: project.storyboards.map((board) => board.id === boardId ? repaired : board) };
  if (zhPromptChanged) {
    next = { ...next, storyboards: next.storyboards.map((board) => {
      if (board.id === boardId || board.sequencePromptHandoff?.previousStoryboardId !== boardId
        || !board.sequencePlanId || !board.segmentId
        || getSequencePromptHandoffStatus(board, project).kind !== 'current') return board;
      const handoff = buildSequencePromptHandoff(next, board.sequencePlanId, board.segmentId);
      return handoff.context && !handoff.issue ? stampSequencePromptHandoff(board, handoff.context) : board;
    }) };
  }
  return next;
};
