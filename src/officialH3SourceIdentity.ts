import type { Storyboard } from './types';
import { sourceContentHash } from './sourceContentHash';
import { publicVideoContinuityLock } from './videoPrivateScope';

// Unaffected public v7 artifacts keep their identity. Only artifacts using
// the changed automatic/private inputs receive the scope revision suffix.
export const OFFICIAL_H3_SOURCE_VERSION = 'official-h3-v7';
export const OFFICIAL_H3_PRIVATE_SCOPE_REVISION = ':private-scope-v1';

/**
 * Keep the source selection identical to buildOfficialH3CompileInput.  The
 * canonical prompt is intentionally not trimmed here: older generated boards
 * persist the exact converter output (including a harmless trailing space),
 * and the fingerprint must be checked against that same byte sequence.
 */
export const canonicalPromptSource = (
  board: Pick<Storyboard, 'finalPrompt' | 'promptPlan'>,
): string => board.promptPlan?.canonicalPrompt || board.finalPrompt || '';

export const needsOfficialPrivateScopeRevision = (
  board: Pick<Storyboard, 'promptPlan'> & Partial<Pick<Storyboard, 'globalLock' | 'shots'>>,
): boolean => Boolean(
  (board.globalLock && publicVideoContinuityLock(board.globalLock) !== board.globalLock)
  || (board.promptPlan?.constraints || []).some((constraint) => (
    !/^制作要求\s*[：:]/u.test(constraint.trim())
    && publicVideoContinuityLock(constraint) !== constraint
  ))
  || (board.shots || []).some((shot) => Object.values(shot.visiblePrivatePartsByCharacter || {})
    .some((parts) => Array.isArray(parts) && parts.length > 0)),
);

/** Source identity only; does not infer or validate authored shot content. */
export const officialH3CanonicalSourceMatches = (
  board: Pick<Storyboard, 'finalPrompt' | 'officialPromptSource' | 'promptPlan'>
    & Partial<Pick<Storyboard, 'globalLock' | 'shots'>>,
): boolean => Boolean(
  board.officialPromptSource
  && board.officialPromptSource.startsWith(`${OFFICIAL_H3_SOURCE_VERSION}:${sourceContentHash(
    canonicalPromptSource(board),
  )}:`)
  && (!needsOfficialPrivateScopeRevision(board)
    || board.officialPromptSource.endsWith(OFFICIAL_H3_PRIVATE_SCOPE_REVISION)),
);
