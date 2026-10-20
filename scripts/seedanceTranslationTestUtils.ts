import assert from 'node:assert/strict';

export interface SeedanceTranslationTestSlot {
  id: string;
  groupId: string;
  sourceText: string;
  groupSourceText: string;
  before: string;
  after: string;
}

/** A transport double for pipeline/storage tests, not a translation-quality fixture. */
export const createSeedanceTranslationResponse = (
  user: string,
  translate: (slot: SeedanceTranslationTestSlot) => string = () => ' translated description ',
): string => {
  const payload = JSON.parse(user) as { sourcePrompt: string; slots: SeedanceTranslationTestSlot[]; units: unknown[] };
  assert.equal(typeof payload.sourcePrompt, 'string');
  assert.ok(Array.isArray(payload.units));
  assert.ok(Array.isArray(payload.slots));
  return JSON.stringify({ slots: payload.slots.map((slot) => ({ id: slot.id, text: translate(slot) })) });
};
