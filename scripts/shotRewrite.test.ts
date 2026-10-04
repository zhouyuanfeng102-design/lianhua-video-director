import assert from 'node:assert/strict';
import { appendShotRewriteGuidance } from '../src/shotRewrite';

const detailedAction = '她抬手解开外套；把外套放到床沿；转身继续原有动作';
const guidance = '强化动作因果、空间方向与镜尾可见结果';

assert.equal(
  appendShotRewriteGuidance(detailedAction, guidance),
  `${detailedAction}；${guidance}`,
  'rewriting must preserve every authored action after Chinese semicolons',
);

assert.equal(
  appendShotRewriteGuidance(`${detailedAction}；`, guidance),
  `${detailedAction}；${guidance}`,
  'a trailing delimiter must not produce an empty action stage',
);

assert.equal(
  appendShotRewriteGuidance(`${detailedAction}；${guidance}`, guidance),
  `${detailedAction}；${guidance}`,
  'repeating the same rewrite must be idempotent',
);

assert.equal(
  appendShotRewriteGuidance('', guidance),
  guidance,
  'an empty action can still receive rewrite guidance',
);

console.log('shotRewrite: authored action chains are preserved during single and bulk rewrites');
