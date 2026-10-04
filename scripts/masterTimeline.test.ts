import assert from 'node:assert/strict';
import {
  applyConvertedPromptToShots,
  applyMasterPromptEdit,
  masterPromptConfirmationFingerprint,
  parseMasterTimelinePrompt,
  retimeMasterShotPrompt,
} from '../src/masterTimeline';
import { semanticActionsEquivalent } from '../src/semanticEvents';
import type { Storyboard, VideoSequencePlan, VideoShot } from '../src/types';

const promptEntry = (startSec: number, endSec: number, subject: string, action: string): string => (
  `【${startSec}s-${endSec}s】 主体：@${subject}（专注）[朝向：前方] 正在 [${action}→继续推进→稳定停住]（推动剧情）；空间：前景-碎石 中景-@${subject} 背景-雨夜城门；光影：左侧5600K冷光；镜头：低机位跟拍；台词：无；音效：环境层-[雨声] 动作层-[脚步] 情绪层-[低频鼓点]`
);

const originalPromptLines = [
  promptEntry(0, 4, '剑客', '推开城门'),
  promptEntry(4, 10, '剑客', '穿过门洞'),
];
const originalPrompt = originalPromptLines.join('\n');
const reviewDefects: string[] = [];
const recordUnexpectedAcceptance = (label: string, operation: () => unknown): void => {
  try {
    operation();
    reviewDefects.push(label);
  } catch {
    // Expected rejection.
  }
};

assert.deepEqual(
  parseMasterTimelinePrompt(originalPrompt, 10),
  [
    { startSec: 0, endSec: 4, prompt: originalPromptLines[0] },
    { startSec: 4, endSec: 10, prompt: originalPromptLines[1] },
  ],
  'canonical master entries should retain their complete per-shot prompt text',
);

const missingAudioField = originalPromptLines[0].replace(/；音效：.*$/u, '');
assert.throws(
  () => parseMasterTimelinePrompt([missingAudioField, originalPromptLines[1]].join('\n'), 10),
  /第 1 镜.*音效/u,
  'a canonical entry missing a required field must be rejected',
);

const fakeAudioInsideDialogue = promptEntry(0, 10, '剑客', '穿过门洞')
  .replace('台词：无', '台词：第2s @剑客：“不要把音效：当成字段。”')
  .replace(/；音效：.*$/u, '');
recordUnexpectedAcceptance(
  'audio-like dialogue text accepted without a top-level audio field',
  () => parseMasterTimelinePrompt(fakeAudioInsideDialogue, 10),
);

const duplicateTopLevelSpace = promptEntry(0, 10, '剑客', '穿过门洞')
  .replace('；光影：', '；空间：重复空间；光影：');
recordUnexpectedAcceptance(
  'duplicate top-level canonical field accepted',
  () => parseMasterTimelinePrompt(duplicateTopLevelSpace, 10),
);

const outOfOrderFields = promptEntry(0, 10, '剑客', '穿过门洞')
  .replace(/；空间：([^；]+)；光影：([^；]+)；镜头：/u, '；光影：$2；空间：$1；镜头：');
assert.throws(
  () => parseMasterTimelinePrompt(outOfOrderFields, 10),
  /字段顺序/u,
  'top-level canonical fields in the wrong order must be rejected',
);

const multilineCanonicalPrompt = promptEntry(0, 10, '剑客', '穿过门洞')
  .replace('正在 [', '正在 [\n')
  .replace(/；(空间|光影|镜头|台词|音效)：/gu, '；\n$1：');
assert.deepEqual(
  parseMasterTimelinePrompt(multilineCanonicalPrompt, 10),
  [{ startSec: 0, endSec: 10, prompt: multilineCanonicalPrompt }],
  'canonical field values and field separators may span lines',
);

const orphanQuoteInsideActionChain = promptEntry(
  0,
  10,
  '通讯员',
  '握紧对讲机→抬头发出警报→“未说完的对白',
);
assert.doesNotThrow(
  () => parseMasterTimelinePrompt(orphanQuoteInsideActionChain, 10),
  'an orphan quote inside the bounded 正在 [...] action chain must not swallow later top-level fields',
);

assert.throws(
  () => parseMasterTimelinePrompt([
    promptEntry(0, 4, '剑客', '推开城门'),
    promptEntry(5, 10, '剑客', '穿过门洞'),
  ].join('\n'), 10),
  /空档|缺口/u,
  'a gap in the master timeline must be rejected',
);

assert.throws(
  () => parseMasterTimelinePrompt([
    promptEntry(0, 6, '剑客', '推开城门'),
    promptEntry(5, 10, '剑客', '穿过门洞'),
  ].join('\n'), 10),
  /重叠/u,
  'overlapping master entries must be rejected',
);

assert.throws(
  () => parseMasterTimelinePrompt([
    promptEntry(0, 4, '剑客', '推开城门'),
    promptEntry(4, 9, '剑客', '穿过门洞'),
  ].join('\n'), 10),
  /最终|总时长|结束/u,
  'the final entry must end at the expected total duration',
);

const promptCrossingFifteenSecondGrid = [
  promptEntry(0, 10, '剑客', '推开城门'),
  promptEntry(10, 20, '剑客', '穿过门洞'),
  promptEntry(20, 30, '剑客', '走入雨幕'),
].join('\n');
assert.throws(
  () => parseMasterTimelinePrompt(promptCrossingFifteenSecondGrid, 30, 15),
  /15.*(?:边界|网格)|(?:边界|网格).*15/u,
  'a master shot must not cross the fixed 15-second segment boundary',
);

assert.throws(
  () => parseMasterTimelinePrompt(promptEntry(1, 10, '剑客', '穿过门洞'), 10),
  /0 秒/u,
  'the first master entry must start at zero',
);

assert.throws(
  () => parseMasterTimelinePrompt('【0s-10s】', 10),
  /正文不能为空/u,
  'an entry with an empty body must be rejected',
);

for (const [startSec, endSec] of [[0, 0], [4, 3]] as const) {
  assert.throws(
    () => parseMasterTimelinePrompt(promptEntry(startSec, endSec, '剑客', '停住'), 10),
    /正时长/u,
    `an entry ending at or before its start (${startSec}s-${endSec}s) must be rejected`,
  );
}

const strictBoundaryCases = [
  {
    label: '0.0005-second non-zero start',
    parse: () => parseMasterTimelinePrompt(promptEntry(0.0005, 10, '剑客', '穿过门洞'), 10),
  },
  {
    label: '0.0005-second gap',
    parse: () => parseMasterTimelinePrompt([
      promptEntry(0, 4, '剑客', '推开城门'),
      promptEntry(4.0005, 10, '剑客', '穿过门洞'),
    ].join('\n'), 10),
  },
  {
    label: '0.0005-second overlap',
    parse: () => parseMasterTimelinePrompt([
      promptEntry(0, 4, '剑客', '推开城门'),
      promptEntry(3.9995, 10, '剑客', '穿过门洞'),
    ].join('\n'), 10),
  },
  {
    label: '0.0005-second early final endpoint',
    parse: () => parseMasterTimelinePrompt(promptEntry(0, 9.9995, '剑客', '穿过门洞'), 10),
  },
] as const;
const unexpectedlyAcceptedBoundaryCases = strictBoundaryCases
  .filter(({ parse }) => {
    try {
      parse();
      return true;
    } catch {
      return false;
    }
  })
  .map(({ label }) => label);
assert.deepEqual(
  unexpectedlyAcceptedBoundaryCases,
  [],
  'master timeline boundaries and adjacency must be exact',
);

const originalShots: VideoShot[] = [
  {
    id: 'master-shot-1',
    index: 1,
    startSec: 0,
    endSec: 4,
    purpose: '建立城门与人物',
    subject: '剑客',
    action: '推开城门',
    camera: '全景',
    transition: '动作承接',
    lighting: '冷蓝逆光',
    sound: '雨声',
    result: '城门打开',
    referenceAssetIds: ['character-swordsman', 'location-gate'],
    prompt: originalPromptLines[0],
    locked: true,
  },
  {
    id: 'master-shot-2',
    index: 2,
    startSec: 4,
    endSec: 10,
    purpose: '进入城内',
    subject: '剑客',
    action: '穿过门洞',
    camera: '跟拍',
    transition: '淡出',
    lighting: '冷暖交界',
    sound: '脚步声',
    result: '进入城内',
    referenceAssetIds: ['character-swordsman'],
    prompt: originalPromptLines[1],
    locked: false,
  },
];

const editedPromptLines = [
  promptEntry(0, 3, '剑客', '缓慢推开城门'),
  promptEntry(3, 10, '剑客', '迅速穿过门洞'),
];
const editedShots = applyMasterPromptEdit(originalShots, editedPromptLines.join('\n'), 10);

const manualEditWithOutOfRangeSoundCue = [
  promptEntry(0, 4, '剑客', '推开城门'),
  promptEntry(4, 10, '剑客', '穿过门洞')
    .replace('动作层-[脚步]', '动作层-[第9s脚步落地]'),
].join('\n');
assert.throws(
  () => applyMasterPromptEdit(originalShots, manualEditWithOutOfRangeSoundCue, 10),
  /第 2 镜音效.*第9s.*0-6s.*相对/u,
  'manually confirming a master prompt must reject sound cues outside their own shot duration',
);

assert.deepEqual(
  editedShots.map(({ startSec, endSec, action, prompt }) => ({ startSec, endSec, action, prompt })),
  [
    {
      startSec: 0,
      endSec: 3,
      action: '缓慢推开城门→继续推进→稳定停住',
      prompt: editedPromptLines[0],
    },
    {
      startSec: 3,
      endSec: 10,
      action: '迅速穿过门洞→继续推进→稳定停住',
      prompt: editedPromptLines[1],
    },
  ],
  'same-count edits must synchronize timing, visible prompt text, and the internal action chain',
);
editedShots.forEach((shot, index) => {
  const original = originalShots[index];
  const {
    startSec: _oldStart,
    endSec: _oldEnd,
    action: _oldAction,
    prompt: _oldPrompt,
    ...originalMetadata
  } = original;
  const {
    startSec: _newStart,
    endSec: _newEnd,
    action: _newAction,
    prompt: _newPrompt,
    ...editedMetadata
  } = shot;
  assert.deepEqual(editedMetadata, originalMetadata, `shot ${index + 1} non-authoring metadata must be retained`);
  assert.notEqual(shot, original, `shot ${index + 1} should be copied instead of mutated`);
});
assert.deepEqual(
  originalShots.map(({ startSec, endSec, prompt }) => ({ startSec, endSec, prompt })),
  [
    { startSec: 0, endSec: 4, prompt: originalPromptLines[0] },
    { startSec: 4, endSec: 10, prompt: originalPromptLines[1] },
  ],
  'applying an edit must not mutate the persisted input shots',
);

assert.throws(
  () => applyMasterPromptEdit(
    [
      { ...originalShots[0], startSec: 0, endSec: 10 },
      { ...originalShots[1], startSec: 10, endSec: 30 },
    ],
    promptCrossingFifteenSecondGrid,
    30,
    15,
  ),
  /15.*(?:边界|网格)|(?:边界|网格).*15/u,
  'an edited master prompt that removes the 15-second boundary cannot be confirmed',
);

const visibleSubjectEdit = applyMasterPromptEdit(
  [originalShots[0]],
  promptEntry(0, 10, '守门剑客', '缓慢推开城门'),
  10,
);
assert.equal(
  visibleSubjectEdit[0].subject,
  '守门剑客',
  'the internal shot subject must follow the subject visible in the edited master prompt',
);

for (const explicitSubject of ['Alexander Montgomery', '我妻善逸', 'O’Connor（北方旅人）', 'Alex (the North Traveler)', '于吉', '清泉市夜晚', '林舟与雪衣道侣']) {
  const explicitPrompt = promptEntry(0, 10, explicitSubject, '缓慢推开城门');
  const edited = applyMasterPromptEdit([originalShots[0]], explicitPrompt, 10);
  assert.equal(edited[0].subject, explicitSubject, 'master edits must keep the complete displayed subject rather than tokenize its spelling');
  const converted = applyConvertedPromptToShots([originalShots[0]], explicitPrompt, 10);
  assert.equal(converted[0].subject, explicitSubject, 'converted prompt synchronization must preserve spaces, identity parentheses and name prefixes');
}

const provenanceShots: VideoShot[] = [
  {
    ...originalShots[0],
    sourceBeatIds: ['beat-open-gate'],
    sourceStart: 0,
    sourceEnd: 6,
  },
  {
    ...originalShots[1],
    subject: '守卫',
    action: '点燃火炬',
    referenceAssetIds: ['character-guard'],
    prompt: promptEntry(4, 10, '守卫', '点燃火炬'),
    sourceBeatIds: ['beat-light-torch'],
    sourceStart: 6,
    sourceEnd: 12,
  },
];
const swappedSemanticShots = applyMasterPromptEdit(
  provenanceShots,
  [
    promptEntry(0, 6, '守卫', '点燃火炬'),
    promptEntry(6, 10, '剑客', '推开城门'),
  ].join('\n'),
  10,
);
assert.deepEqual(
  swappedSemanticShots.map((shot) => ({
    subject: shot.subject,
    sourceBeatIds: shot.sourceBeatIds,
    sourceStart: shot.sourceStart,
    sourceEnd: shot.sourceEnd,
    referenceAssetIds: shot.referenceAssetIds,
  })),
  [
    {
      subject: '守卫',
      sourceBeatIds: ['beat-light-torch'],
      sourceStart: 6,
      sourceEnd: 12,
      referenceAssetIds: ['character-guard'],
    },
    {
      subject: '剑客',
      sourceBeatIds: ['beat-open-gate'],
      sourceStart: 0,
      sourceEnd: 6,
      referenceAssetIds: ['character-swordsman', 'location-gate'],
    },
  ],
  'moving visible shot content must move its beat, character-range, and reference-asset provenance instead of retaining the old timeline-slot mapping',
);
assert.throws(
  () => applyMasterPromptEdit(
    provenanceShots,
    [
      promptEntry(0, 5, '陌生人', '踢碎玻璃'),
      promptEntry(5, 10, '另一人', '驶离城门'),
    ].join('\n'),
    10,
  ),
  /无法.*(?:剧情节拍来源|sourceBeatIds)|不能安全保留/u,
  'an edit that cannot be mapped reliably must fail instead of silently retaining false source-beat provenance',
);

const convertedByTimelineSlot = applyConvertedPromptToShots(
  provenanceShots,
  [
    promptEntry(0, 4, '剑客', '掌心压住湿冷门板'),
    promptEntry(4, 10, '守卫', '火光映亮抬起的手腕'),
  ].join('\n'),
  10,
);
assert.deepEqual(
  convertedByTimelineSlot.map((shot) => ({
    subject: shot.subject,
    sourceBeatIds: shot.sourceBeatIds,
    sourceStart: shot.sourceStart,
    sourceEnd: shot.sourceEnd,
    referenceAssetIds: shot.referenceAssetIds,
  })),
  [
    {
      subject: '剑客',
      sourceBeatIds: ['beat-open-gate'],
      sourceStart: 0,
      sourceEnd: 6,
      referenceAssetIds: ['character-swordsman', 'location-gate'],
    },
    {
      subject: '守卫',
      sourceBeatIds: ['beat-light-torch'],
      sourceStart: 6,
      sourceEnd: 12,
      referenceAssetIds: ['character-guard'],
    },
  ],
  'an already validated converter response must keep source provenance by immutable timeline slot even when it rewrites visible actions',
);

const renderedActionProvenanceShot: VideoShot = {
  ...provenanceShots[0],
  action: '怪兽撞碎成排集装箱',
  prompt: promptEntry(0, 10, '镰刀头怪兽', '从海面跃出'),
};
const visualOnlyPromptEdit = renderedActionProvenanceShot.prompt.replace(
  '空间：',
  '空间：QA三阶段确认·',
);
const [visualOnlyEditedShot] = applyMasterPromptEdit(
  [renderedActionProvenanceShot],
  visualOnlyPromptEdit,
  10,
);
assert.deepEqual(
  {
    sourceBeatIds: visualOnlyEditedShot.sourceBeatIds,
    sourceStart: visualOnlyEditedShot.sourceStart,
    sourceEnd: visualOnlyEditedShot.sourceEnd,
    referenceAssetIds: visualOnlyEditedShot.referenceAssetIds,
  },
  {
    sourceBeatIds: renderedActionProvenanceShot.sourceBeatIds,
    sourceStart: renderedActionProvenanceShot.sourceStart,
    sourceEnd: renderedActionProvenanceShot.sourceEnd,
    referenceAssetIds: renderedActionProvenanceShot.referenceAssetIds,
  },
  'a visual-only prompt edit must use the persisted visible action to retain its original source provenance',
);

const synonymEditedShots = applyMasterPromptEdit(
  originalShots,
  [
    promptEntry(0, 4, '剑客', '推开木门'),
    promptEntry(4, 10, '剑客', '伸手把门推开'),
  ].join('\n'),
  10,
);
assert.deepEqual(
  synonymEditedShots.map((shot) => shot.action),
  [
    '推开木门→继续推进→稳定停住',
    '伸手把门推开→继续推进→稳定停住',
  ],
  'every edited visible action chain must replace the corresponding stale internal shot action',
);
assert.equal(
  semanticActionsEquivalent(synonymEditedShots[0].action, synonymEditedShots[1].action),
  true,
  'downstream semantic de-duplication must see synonymous actions from the edited visible prompt',
);

const missingVisibleActionChain = promptEntry(0, 10, '剑客', '推开城门')
  .replace(/\s+正在\s*\[[^\]]+\]/u, '');
assert.throws(
  () => applyMasterPromptEdit([originalShots[0]], missingVisibleActionChain, 10),
  /第 1 镜.*正在.*动作链/u,
  'a prompt without the canonical visible action chain must be rejected instead of retaining stale shot.action',
);
const misleadingLaterAction = missingVisibleActionChain.replace(
  '空间：前景-碎石',
  '空间：前景-正在 [雨幕摇曳] 的碎石',
);
assert.throws(
  () => applyMasterPromptEdit([originalShots[0]], misleadingLaterAction, 10),
  /第 1 镜.*正在.*动作链/u,
  'an action-like phrase in a later field must not masquerade as the missing canonical subject action chain',
);

assert.throws(
  () => applyMasterPromptEdit(originalShots, promptEntry(0, 10, '剑客', '独自穿过城门'), 10),
  /镜头数量.*2.*1|2.*1.*镜头数量/u,
  'removing a shot through text editing must be rejected',
);
assert.throws(
  () => applyMasterPromptEdit(originalShots, [
    promptEntry(0, 3, '剑客', '推开城门'),
    promptEntry(3, 6, '剑客', '穿过门洞'),
    promptEntry(6, 10, '剑客', '走入雨幕'),
  ].join('\n'), 10),
  /镜头数量.*2.*3|2.*3.*镜头数量/u,
  'adding a shot through text editing must be rejected',
);

const sourceShotPrompt = '【4s-10s】 主体：@剑客；镜头内提示【不要改】；台词：第2s @剑客："等等。"';
assert.equal(
  retimeMasterShotPrompt(sourceShotPrompt, 0, 3.5),
  '【0s-3.5s】 主体：@剑客；镜头内提示【不要改】；台词：第2s @剑客："等等。"',
  'local retiming must replace only the leading timestamp',
);
recordUnexpectedAcceptance(
  'retimed interval collapsed to an identical formatted boundary',
  () => retimeMasterShotPrompt(sourceShotPrompt, 0.0001, 0.0004),
);
for (const [startSec, endSec] of [
  [Number.NaN, 1],
  [-0.1, 1],
  [1, 1],
  [2, 1],
] as const) {
  assert.throws(
    () => retimeMasterShotPrompt(sourceShotPrompt, startSec, endSec),
    /局部镜头时间/u,
    `invalid local interval ${startSec}s-${endSec}s must be rejected`,
  );
}
assert.throws(
  () => retimeMasterShotPrompt('主体：@剑客；镜头：跟拍', 0, 1),
  /前导时间戳/u,
  'retiming requires an existing leading timestamp',
);

const plan: Pick<VideoSequencePlan, 'id' | 'sourceStoryContent' | 'totalDurationSec' | 'segmentDurationSec' | 'masterStoryboardId'> = {
  id: 'sequence-1',
  sourceStoryContent: '剑客推门进入雨夜城池。',
  totalDurationSec: 10,
  segmentDurationSec: 5,
  masterStoryboardId: 'master-board-1',
};
const board: Pick<Storyboard, 'id' | 'finalPrompt' | 'shots'> = {
  id: 'master-board-1',
  finalPrompt: originalPrompt,
  shots: originalShots,
};
const fingerprint = masterPromptConfirmationFingerprint(plan, board);
if (!/^master-[0-9a-f]{32}$/u.test(fingerprint)) {
  reviewDefects.push('confirmation fingerprint is narrower than 128 bits');
}
assert.equal(
  fingerprint,
  masterPromptConfirmationFingerprint(structuredClone(plan), structuredClone(board)),
  'the confirmation fingerprint must be stable for identical persisted inputs',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint({ ...plan, id: 'sequence-2' }, board),
  'plan identity changes must invalidate master-prompt confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint({ ...plan, sourceStoryContent: `${plan.sourceStoryContent}城门随后关闭。` }, board),
  'story edits must invalidate master-prompt confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint({ ...plan, totalDurationSec: 12 }, board),
  'total-duration edits must invalidate master-prompt confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint({ ...plan, segmentDurationSec: 2.5 }, board),
  'fixed segment-duration edits must invalidate master-prompt confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint({ ...plan, masterStoryboardId: 'master-board-2' }, board),
  'master storyboard linkage changes must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, { ...board, id: 'master-board-2' }),
  'master storyboard identity changes must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, { ...board, finalPrompt: `${board.finalPrompt}\n` }),
  'master prompt edits must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 0 ? { ...shot, endSec: 3.5 } : shot),
  }),
  'shot end-time edits must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 1 ? { ...shot, startSec: 4.5 } : shot),
  }),
  'shot start-time edits must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 1 ? { ...shot, prompt: `${shot.prompt} 已编辑` } : shot),
  }),
  'per-shot prompt edits must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 1 ? { ...shot, action: '转身离开门洞' } : shot),
  }),
  'per-shot action edits must invalidate confirmation even when the visible prompt is unchanged',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 1 ? { ...shot, id: 'master-shot-replaced' } : shot),
  }),
  'shot identity changes must invalidate confirmation',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 0
      ? { ...shot, sourceBeatIds: ['beat-open-gate'] }
      : shot),
  }),
  'source-beat provenance changes must invalidate confirmation even when every visible prompt stays unchanged',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 0
      ? { ...shot, sourceStart: 0, sourceEnd: 6 }
      : shot),
  }),
  'source character-range provenance changes must invalidate confirmation even when every visible prompt stays unchanged',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 0
      ? { ...shot, subject: '冒名剑客' }
      : shot),
  }),
  'internal subject changes must invalidate confirmation when the visible prompt is unchanged',
);
assert.notEqual(
  fingerprint,
  masterPromptConfirmationFingerprint(plan, {
    ...board,
    shots: board.shots.map((shot, index) => index === 0
      ? { ...shot, referenceAssetIds: ['replacement-character-reference'] }
      : shot),
  }),
  'reference-asset provenance changes must invalidate confirmation when the visible prompt is unchanged',
);

assert.deepEqual(reviewDefects, [], 'code-quality review defects must be rejected');

console.log('master timeline parsing and confirmation checks passed');
