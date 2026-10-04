import assert from 'node:assert/strict';
import { CHARACTER_DOSSIER_REFRESH_RULE, synchronizeCharacterDossierRefresh } from '../src/characterDossierPromptRefresh';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { applyOfficialH3Prompt, getOfficialH3SubmissionIssue, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import type { Character, Storyboard } from '../src/types';

const person: Character = { id: 'hero', name: '旅人', gender: '男', apparentAge: '成年', race: '人类', appearance: '新外观',
  outfit: '蓝衣', signatureProps: '', personality: '冷静', motionHabits: '稳步', anchor: '新锚点', negativeContinuity: '', assetIds: [] };
const context = { characters: [person], assets: [] };
const canonical = '【0s-15s】主体：@旅人（旧外观）[朝向：门口] 正在 [站在门边等待]（等待来客）；空间：前景木门，中景旅人，背景走廊；光影：冷光；镜头：固定中景；台词：第1s-第3s @旅人："请进。"；音效：环境层-[风声] 动作层-[无] 情绪层-[无配乐]';
const revisedCanonical = canonical.replace('旧外观', '新外观');
const base: Storyboard = { id: 'board', sceneId: 'scene', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s',
  shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  sourceStoryContent: '旅人在门边等待，并说“请进。”', finalPrompt: canonical,
  shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 15, purpose: '等待', subject: '旅人', action: '站在门边等待', camera: '固定中景',
    transition: '保持', lighting: '冷光', sound: '风声', result: '继续等待', prompt: canonical, locked: true, referenceAssetIds: [], sourceExcerpt: '旅人在门边等待' }],
  audioLedger: [{ id: 'line', kind: 'dialogue', label: '台词', speaker: '旅人', text: '请进。', startSec: 1, endSec: 3 }],
  revisions: [{ id: 'old', createdAt: 1, finalPrompt: canonical }], createdAt: 1, updatedAt: 1,
};
const saved = applyOfficialH3Prompt(base, context);
const dirty = { ...saved, characterDossierDirty: { characterIds: [person.id], updatedAt: 2 } };
const newCanonicalBoard = synchronizeCharacterDossierRefresh(dirty, revisedCanonical, [['shot']], [null]);
const newOfficial = applyOfficialH3Prompt(newCanonicalBoard, context);
const validDelivery = JSON.stringify({ canonicalPrompt: revisedCanonical, h3Prompt: newOfficial.officialPromptZh,
  identityBindings: { version: 1, characters: [] }, shotSourceIds: [['shot']], shotMetadata: [null] });
const snapshot = JSON.stringify(dirty);

assert.equal(hasCurrentOfficialH3Prompt(saved, context), true);
assert.equal(hasCurrentOfficialH3Prompt(dirty, context), false);
assert.match(getOfficialH3SubmissionIssue({ model: 'minimax-h3', prompt: dirty.officialPromptZh }, dirty, context) || '', /人物资料已更新/);
assert.equal(applyOfficialH3Prompt(dirty, context).characterDossierDirty, dirty.characterDossierDirty, 'local compilation cannot clear review requirement');
assert.equal(newCanonicalBoard.audioLedger, dirty.audioLedger);
assert.equal(newCanonicalBoard.revisions, dirty.revisions);
assert.deepEqual(newCanonicalBoard.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), [['shot', 0, 15]]);
assert.throws(() => synchronizeCharacterDossierRefresh(dirty, revisedCanonical.replace('15s', '14s'), [['shot']], [null]), /切点|覆盖|时长/);
assert.throws(() => synchronizeCharacterDossierRefresh(dirty, revisedCanonical, [['wrong']], [null]), /一对一/);
assert.throws(() => synchronizeCharacterDossierRefresh(dirty, revisedCanonical.replace('请进。', '你走吧。'), [['shot']], [null]), /台词或音效/);

const calls: string[] = [];
const refreshed = await generateSingleSegmentPrompt({ board: dirty, context, purpose: 'character-dossier-refresh', clean: (value) => value.trim(),
  now: () => 33, request: async (system, user, stage) => {
    calls.push(stage);
    assert.notEqual(stage, 'convert', 'dossier refresh does not redo initial direction/conversion');
    if (stage === 'translate') throw new Error('fixture translation offline');
    assert.ok(system.includes(CHARACTER_DOSSIER_REFRESH_RULE));
    assert.ok(user.includes('character-dossier-only'));
    assert.ok(user.includes('新外观'));
    assert.ok(user.includes('changedCharacterIds'));
    return validDelivery;
  },
});
assert.deepEqual(calls, ['review', 'translate']);
assert.equal(refreshed.characterDossierDirty, undefined);
assert.equal(refreshed.finalPrompt, revisedCanonical);
assert.equal(refreshed.officialPromptZh, newOfficial.officialPromptZh);
assert.ok(refreshed.officialPromptEnError, 'English failure remains actionable without pretending English is refreshed');
assert.equal(hasCurrentOfficialH3Prompt(refreshed, context), true);
assert.equal(refreshed.revisions, dirty.revisions);
assert.equal(refreshed.audioLedger, dirty.audioLedger);
assert.equal(refreshed.sourceStoryContent, dirty.sourceStoryContent);
assert.equal(refreshed.shots[0].result, dirty.shots[0].result);
assert.equal(refreshed.shots[0].transition, dirty.shots[0].transition);

const regeneratedCalls: string[] = [];
const regenerated = await generateSingleSegmentPrompt({ board: dirty, context, purpose: 'initial',
  converter: { id: 'fixture', name: 'fixture', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true, version: 'test', systemPrompt: '', outputRules: '', updatedAt: 1 },
  clean: (value) => value, request: async (_system, _user, stage) => {
    regeneratedCalls.push(stage);
    if (stage === 'convert') return revisedCanonical;
    if (stage === 'review') return validDelivery;
    throw new Error('fixture translation offline');
  },
});
assert.deepEqual(regeneratedCalls, ['convert', 'review', 'translate']);
assert.equal(regenerated.characterDossierDirty, undefined, 'a full new generation with successful AI review also updates dossier');
assert.equal(hasCurrentOfficialH3Prompt(regenerated, context), true);

let failedCalls = 0;
await assert.rejects(generateSingleSegmentPrompt({ board: dirty, context, purpose: 'character-dossier-refresh', clean: (value) => value,
  request: async (_system, _user, stage) => {
    failedCalls++;
    assert.equal(stage, 'review');
    return validDelivery.replace('请进。', '你走吧。');
  },
}), /台词或音效/);
assert.equal(failedCalls, 4, 'bounded serialization repair then preserves old result');
await assert.rejects(generateSingleSegmentPrompt({ board: dirty, context, purpose: 'character-dossier-refresh', clean: (value) => value,
  request: async () => { throw new Error('fixture offline'); },
}), /fixture offline/);
assert.equal(JSON.stringify(dirty), snapshot, 'all successful and failed refresh requests leave caller data/history unchanged');
console.log('character dossier H3 refresh: stale guard, scoped review, canonical synchronization, audio/schedule preservation, failed review and English recovery passed');
