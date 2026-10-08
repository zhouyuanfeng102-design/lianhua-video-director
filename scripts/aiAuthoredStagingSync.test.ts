import assert from 'node:assert/strict';
import { synchronizeAiAuthoredH3StagingDelivery } from '../src/h3StagingDelivery';
import { synchronizeAiAuthoredCharacterDossierRefresh } from '../src/characterDossierPromptRefresh';
import type { H3StagingShotMetadata } from '../src/h3StagingMetadata';
import type { Storyboard } from '../src/types';

const canonical = (cuts: number[], line = '请进。') => cuts.slice(0, -1).map((start, index) =>
  `【${start}s-${cuts[index + 1]}s】主体：旅人倚门等候；空间：门口；光影：日光；镜头：中景；台词：旅人说“${line}”；音效：风声`).join('\n');
const original = canonical([0, 5, 15]);
const board: Storyboard = {
  id: 'synthetic-staging', sceneId: 'scene', workflow: 'drama', inputMode: 'text',
  durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
  converterPresetId: '', globalLock: '', finalPrompt: original, officialPromptZh: 'already saved H3', officialPromptEn: 'already saved English',
  shots: original.split('\n').map((prompt, index) => ({
    id: `source-${index}`, index: index + 1, startSec: [0, 5][index], endSec: [5, 15][index],
    purpose: '等候', subject: '旅人', action: '等候', camera: '中景', lighting: '日光', sound: '风声',
    transition: '保持', result: '等候', prompt, locked: false, referenceAssetIds: [`asset-${index}`],
    sourceExcerpt: `原文${index}`, sourceBeatIds: [`beat-${index}`],
    visiblePrivatePartsByCharacter: { hero: ['full-body'] },
  })),
  audioLedger: [{ id: 'line', kind: 'dialogue', label: '台词', speaker: '旅人', text: '请进。', startSec: 1, endSec: 3 }],
  createdAt: 1, updatedAt: 1,
};
const before = JSON.stringify(board);
const mergedMetadata: H3StagingShotMetadata = {
  sourceBeatIds: ['beat-0'], sourceExcerpt: 'AI给出的实际来源', sourceLocationStatus: 'unlocated',
  nsfwContinuity: null, visiblePrivatePartsByCharacter: {},
};
let passed = 0;
const test = (name: string, run: () => void) => { run(); passed++; console.log(`PASS ${name}`); };

test('readable AI timeline accepts changed exact count and missing optional subject subformat', () => {
  const prompt = canonical([0, 15]);
  const result = synchronizeAiAuthoredH3StagingDelivery(board, prompt, [['source-0', 'source-1']], [mergedMetadata]);
  assert.equal(result.timelineSynchronized, true);
  assert.equal(result.board.finalPrompt, prompt);
  assert.equal(result.board.shots.length, 1);
  assert.equal(result.board.shotCount, 2, 'preserve the user preference without enforcing it');
  assert.equal(result.board.shots[0].subject, '旅人倚门等候');
  assert.deepEqual(result.board.shots[0].visiblePrivatePartsByCharacter, {}, 'use explicit AI scope rather than unioning source scopes');
  assert.deepEqual(result.board.shots[0].sourceBeatIds, ['beat-0']);
});

test('standard canonical subject and action remain structured for image generation and editing', () => {
  const prompt = canonical([0, 5, 15]).replaceAll('旅人倚门等候', '@旅人（蓝衣）[朝向：门口] 正在 [抬手开门→侧身迎客]');
  const result = synchronizeAiAuthoredH3StagingDelivery(board, prompt, [['source-0'], ['source-1']]);
  assert.equal(result.timelineSynchronized, true);
  for (const shot of result.board.shots) {
    assert.equal(shot.subject, '旅人');
    assert.equal(shot.action, '抬手开门→侧身迎客');
  }
  assert.equal(result.board.finalPrompt, prompt);
  assert.deepEqual(result.board.shots.map((shot) => shot.prompt), prompt.split('\n'));
});

test('absent or unreadable companion timeline cannot discard existing Chinese or English', () => {
  for (const prompt of [undefined, '', 'unreadable canonical', canonical([0, 16]), canonical([1, 15])]) {
    const result = synchronizeAiAuthoredH3StagingDelivery(board, prompt);
    assert.equal(result.timelineSynchronized, false);
    assert.equal(result.board, board);
    assert.match(result.warnings.join(' '), /正文已保留，时间轴待同步/u);
    assert.equal(result.board.officialPromptZh, 'already saved H3');
    assert.equal(result.board.officialPromptEn, 'already saved English');
  }
});

test('changed shots never guess source scope from matching array positions', () => {
  const revised = canonical([0, 7, 15]);
  for (const sources of [undefined, [['missing'], ['source-1']], [['source-0']]]) {
    const result = synchronizeAiAuthoredH3StagingDelivery(board, revised, sources);
    assert.equal(result.timelineSynchronized, false);
    assert.equal(result.board.shots, board.shots);
    assert.match(result.warnings.join(' '), /未合并、复制或清空旧镜头资料/u);
  }
});

test('explicit one-to-one mapping moves metadata by source ID, never slot position', () => {
  const result = synchronizeAiAuthoredH3StagingDelivery(board, canonical([0, 7, 15]), [['source-1'], ['source-0']]);
  assert.equal(result.timelineSynchronized, true);
  assert.deepEqual(result.board.shots.map((shot) => shot.id), ['source-1', 'source-0']);
  assert.deepEqual(result.board.shots.map((shot) => shot.sourceExcerpt), ['原文1', '原文0']);
  assert.deepEqual(result.board.shots.map((shot) => shot.referenceAssetIds), [['asset-1'], ['asset-0']]);
});

test('invalid source IDs remain warnings when explicit AI metadata independently describes the shots', () => {
  const result = synchronizeAiAuthoredH3StagingDelivery(board, canonical([0, 15]), [['missing']], [mergedMetadata]);
  assert.equal(result.timelineSynchronized, true);
  assert.match(result.warnings.join(' '), /来源记录待关联/u);
  assert.deepEqual(result.board.shots[0].referenceAssetIds, []);
  assert.equal(result.board.shots[0].sourceExcerpt, 'AI给出的实际来源');
});

test('source-preserving exact unchanged shots do not require supplemental mapping', () => {
  const result = synchronizeAiAuthoredH3StagingDelivery(board, original);
  assert.equal(result.timelineSynchronized, true);
  assert.deepEqual(result.board.shots.map((shot) => shot.sourceExcerpt), ['原文0', '原文1']);
});

test('AI dossier refresh accepts changed dialogue and cuts without local rejection', () => {
  const changed = canonical([0, 7, 15], '你回来啦。');
  const result = synchronizeAiAuthoredCharacterDossierRefresh(board, changed, [['source-0'], ['source-1']]);
  assert.equal(result.timelineSynchronized, true);
  assert.equal(result.board.finalPrompt, changed);
  assert.match(result.board.shots[0].dialogue!, /你回来啦/u);
  assert.equal(result.board.audioLedger, undefined, 'outdated audio cache is not attached to revised AI prose');
  assert.equal(result.board.shots[0].result, board.shots[0].result);
});

test('appearance-only dossier update retains exactly unchanged sound cache', () => {
  const result = synchronizeAiAuthoredCharacterDossierRefresh(board, original.replaceAll('旅人倚门等候', '蓝衣旅人倚门等候'), [['source-0'], ['source-1']]);
  assert.equal(result.timelineSynchronized, true);
  assert.equal(result.board.audioLedger, board.audioLedger);
});

assert.equal(JSON.stringify(board), before, 'all sync attempts leave caller data unchanged');
console.log(`AI-authored staging synchronization: ${passed} offline cases passed; no project data or live API used`);
