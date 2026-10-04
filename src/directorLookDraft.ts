/** Unconfirmed director/visual editor choices, independent of a saved prompt
 * or the confirmed whole-film generation settings. */
export interface DirectorLookDraft {
  directorStyleId: string;
  directorCategory: string;
  directorStyleName: string;
  directorStyleSummary: string;
  visualStyle: string;
  styleId: string;
}

const directorLookDraftFields: readonly (keyof DirectorLookDraft)[] = [
  'directorStyleId',
  'directorCategory',
  'directorStyleName',
  'directorStyleSummary',
  'visualStyle',
  'styleId',
];

/** Accept a complete authored draft only. Empty strings and whitespace are
 * intentional choices, not requests to infer defaults. Ignore unknown keys
 * and copy the whitelist so persisted data cannot alias the live editor. */
export const normalizeDirectorLookDraft = (value: unknown): DirectorLookDraft | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const draft = value as Record<string, unknown>;
  if (!directorLookDraftFields.every((key) => (
    Object.prototype.hasOwnProperty.call(draft, key) && typeof draft[key] === 'string'
  ))) return undefined;
  return {
    directorStyleId: draft.directorStyleId as string,
    directorCategory: draft.directorCategory as string,
    directorStyleName: draft.directorStyleName as string,
    directorStyleSummary: draft.directorStyleSummary as string,
    visualStyle: draft.visualStyle as string,
    styleId: draft.styleId as string,
  };
};
