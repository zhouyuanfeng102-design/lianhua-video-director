import assert from 'node:assert/strict';
import { h3DescriptionLanguageRule } from '../../src/h3PromptProtocol';

/** Verify the request's language authority, not whether a mocked model can
 * actually translate. Dialogue language and literal H3 syntax stay separate. */
export const assertH3DescriptionLanguage = (system: string, language: '中文' | '英文'): void => {
  const expected = h3DescriptionLanguageRule(language);
  const oppositeMarker = language === '中文' ? 'H3_DESCRIPTION_LANGUAGE_EN_V1' : 'H3_DESCRIPTION_LANGUAGE_ZH_V1';
  assert.equal(system.split(expected).length - 1, 1, `${language} delivery receives exactly one complete language contract`);
  assert.equal(system.includes(oppositeMarker), false, 'a request never carries the opposite description-language authority');
  assert.doesNotMatch(system, /中文正文可作为同一结构的审阅稿|一到两句英文风格/u,
    'shared H3 formatting cannot demote Chinese or force an English visual preface');
};
