import assert from 'node:assert/strict';
import {
  VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CAUSALITY_RULE,
  VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE, videoActionChoreographyRuleForScope,
  withVideoActionChoreographyScope, type VideoActionChoreographyScope,
} from '../src/videoActionChoreographyRules';
import { LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V2_8_0, LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V2_8_0 } from '../src/videoActionLegacyV280Rules';

// Exact shipped blocks are independent of current rule composition. Only the
// request is normalized; the fixture models a saved preset plus user additions.
const legacyBlocks = [LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V2_8_0, LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V2_8_0];
const currentBlocks = [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CAUSALITY_RULE];
const scopes: VideoActionChoreographyScope[] = ['planning', 'generation', 'existing', 'translation', 'format-only'];
const before = '用户前置要求：保留原本的缓慢绕行。VIDEO_ACTION_CHOREOGRAPHY_V1 只是我的说明。';
const after = '用户后置要求：打完保留拍土、整理、再次起势；不要减少次数。';
let cases = 0;
for (const legacy of legacyBlocks) {
  for (const scope of scopes) {
    for (const targetFormat of [undefined, 'seedance'] as const) {
      const saved = { systemPrompt: `${before}\n${legacy}\n${after}` };
      const snapshot = JSON.stringify(saved);
      const target = targetFormat === 'seedance' && scope === 'translation'
        ? VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE : videoActionChoreographyRuleForScope(scope);
      const actual = withVideoActionChoreographyScope(saved.systemPrompt, scope, targetFormat);
      assert.equal(actual, `${before}\n\n${after}\n\n${target}`);
      assert.equal(actual.includes(legacy), false, 'the complete old block cannot remain beside its replacement');
      assert.equal(withVideoActionChoreographyScope(actual, scope, targetFormat), actual, 'request normalization is idempotent');
      assert.equal(JSON.stringify(saved), snapshot, 'saved preset and user additions are untouched');
      cases++;
    }
  }
}

// Both old wrappers can occur in a composed system message. Neither may leave
// the old source rule behind, while current generation/causality wrappers are
// still normalized by the same established entry point.
for (const blocks of [legacyBlocks, [...legacyBlocks, ...currentBlocks]]) {
  const result = withVideoActionChoreographyScope(blocks.join('\n\n'), 'generation');
  assert.equal(result, VIDEO_ACTION_CHOREOGRAPHY_RULE);
  assert.equal(result.split('NOVEL_ACTION_SOURCE_V1').length - 1, 1);
  cases++;
}

// A user-edited near-match and shared wording are not a shipped complete block.
// Do not broaden removal to a marker, a partial paragraph or a matching prefix.
for (const legacy of legacyBlocks) {
  const customized = legacy.replace('NOVEL_ACTION_SOURCE_V1：', 'NOVEL_ACTION_SOURCE_V1：用户自行改写：');
  assert.notEqual(customized, legacy);
  assert.equal(withVideoActionChoreographyScope(customized, 'generation'), `${customized}\n\n${VIDEO_ACTION_CHOREOGRAPHY_RULE}`);
  const fragment = legacy.slice(0, legacy.indexOf('\n\n'));
  assert.equal(withVideoActionChoreographyScope(fragment, 'generation'), `${fragment}\n\n${VIDEO_ACTION_CHOREOGRAPHY_RULE}`);
  cases += 2;
}
console.log(`PASS ${cases} offline V2.8.0 action-rule compatibility cases: exact old blocks replaced once across all scopes/targets; custom text, near-matches and saved presets preserved.`);
