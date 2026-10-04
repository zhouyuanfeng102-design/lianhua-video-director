import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal, hasCurrentTextApiConversion } from '../src/appEffects';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { Character, ConverterPreset, Storyboard, VideoShot } from '../src/types';

const help = '我需要您的帮助。';
const reply = '不必惊慌，我已经向你的方向派出了增援，他们伤不到你。';
const rawSource = `  \n  西娅握住通讯器。\n西娅：“${help}”\n母巢：“${reply}”\n  `;
const cue = (speaker: string, text: string, time = 1) => `第${time}s @${speaker}：“${text}”`;
const canonical = (fields: string[]) => fields.map((field, index) => `【${index * 5}s-${(index + 1) * 5}s】 主体：@西娅（紧张）[朝向：通讯器] 正在 [${index ? '停步→侧头听取回应' : '握住通讯器→靠近嘴边'}]（推进求助）；空间：前景-通讯器 中景-西娅 背景-走廊；光影：自然冷光；镜头：稳定中景；台词：${field}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`).join('\n');
const complete = canonical([cue('西娅', help), cue('母巢', reply)]);
const missing = canonical([cue('西娅', help), '无']);
const converter: ConverterPreset = { id: 'source-rules-fixture', name: '源规则隔离验证', workflow: 'all', inputMode: 'all', scope: 'video', enabled: true, version: 'test', systemPrompt: '根据完整原剧情安排可拍摄动作和对白。', outputRules: '保留真实原话，不按固定语速删减。', updatedAt: 1 };
const clean = (value: string) => value.trim();
const makeDraft = (source: string | undefined = rawSource, prompt = complete): Storyboard => {
  const sourceStart = source?.indexOf('西娅握住通讯器。') ?? -1;
  const shots: VideoShot[] = [0, 1].map((index) => ({ id: `source-rule-shot-${index}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5, purpose: '推进求助', subject: '西娅', action: index ? '本地规划备注，不属于原文事实' : '西娅握住通讯器。', camera: '稳定中景', transition: '自然承接', lighting: '自然冷光', sound: '', result: '停步听取回应', referenceAssetIds: [], sourceBeatIds: index ? ['nonexistent-beat'] : [], ...(index === 0 && sourceStart >= 0 ? { sourceStart, sourceEnd: sourceStart + '西娅握住通讯器。'.length } : {}), prompt: prompt.split('\n')[index], locked: false }));
  return { id: 'source-rule-board', sceneId: 'source-rule-scene', sourceStoryContent: source, workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: converter.id, globalLock: '', finalPrompt: prompt, shots, createdAt: 1, updatedAt: 1,
    targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: 'previous-output', parameters: { seed: 1234567, steps: 15 }, referenceManifest: [], warnings: [], generatedAt: 1 } };
};
const jsonBlock = (text: string, tag: string): Record<string, any> => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `missing ${tag}`); return JSON.parse(match[1]);
};

// Correct existing wording is not invalid just because the API elects to keep it.
{
  const draft = makeDraft(); const before = JSON.stringify(draft); let calls = 0;
  const result = await convertStoryboardDraftToFinal({ draft, converter, clean, sourceStoryContent: rawSource, request: async (_system, user) => {
    calls += 1; assert.equal(calls, 1, 'valid/no-op content must not trigger a rewrite merely for textual difference');
    const data = jsonBlock(user, 'video_conversion_data');
    assert.equal(data.sourceStoryContent, rawSource, 'do not trim raw source before applying its UTF-16 offsets');
    assert.equal(data.shotEvidence[0].sourceExcerpt, '', 'do not locally cut the story into evidence first');
    assert.equal(data.shotEvidence[0].sourceStart, draft.shots[0].sourceStart);
    assert.equal(data.shotEvidence[0].sourceEnd, draft.shots[0].sourceEnd);
    assert.equal(data.shotEvidence[1].sourceExcerpt, '', 'unlocated text must not be fabricated from local action notes');
    assert.equal(data.shotEvidence[1].plannedAction, draft.shots[1].action, 'planning notes are explicitly separate from raw-source evidence');
    assert.equal(data.shotEvidence[0].plannedSpace, undefined, 'legacy missing space is not locally inferred from prose');
    assert.equal(data.shotEvidence[0].plannedDirection, undefined, 'legacy missing direction remains missing for AI to resolve');
    assert.equal(data.shotEvidence[0].plannedDialogue, undefined, 'dialogue is not locally extracted into a new authority');
    assert.equal(data.shotEvidence[0].plannedPerformance, undefined);
    assert.equal(data.shotEvidence[0].plannedCamera, draft.shots[0].camera);
    assert.equal(data.shotEvidence[0].plannedResult, draft.shots[0].result);
    assert.equal(data.shotEvidence[0].plannedSound, draft.shots[0].sound, 'an empty saved sound field is preserved verbatim');
    assert.equal(data.shotEvidence[0].previousShot, undefined);
    assert.equal(data.shotEvidence[1].nextShot, undefined);
    assert.equal(data.shotEvidence[1].previousShot.shotId, draft.shots[0].id);
    assert.equal(data.shotEvidence[1].previousShot.plannedResult, draft.shots[0].result);
    assert.equal(data.shotEvidence[0].nextShot.plannedCamera, draft.shots[1].camera);
    assert.deepEqual(data.audioLedgerFacts, [], 'missing sound source facts do not create a locally invented voice');
    assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.globalStartSec, shot.globalEndSec, shot.durationSec]), [[0, 5, 5], [5, 10, 5]]);
    assert.deepEqual(data.shotEvidence.map((shot: any) => shot.localTimeRangeSec), [[0, 5], [0, 5]]);
    assert.equal(data.localStructureDraft, undefined, 'do not send a duplicated full-timeline local draft');
    assert.equal(data.shotEvidence[0].existingDraft ?? data.shotEvidence[0].localStructureDraft, draft.shots[0].prompt);
    return complete;
  } });
  assert.equal(calls, 1); assert.equal(result.finalPrompt, complete); assert.equal(hasCurrentTextApiConversion(result), true);
  assert.deepEqual(result.targetOutput?.parameters, draft.targetOutput?.parameters);
  assert.equal(JSON.stringify(draft), before);
}

// With no raw source, use the canonical speech reader for confirmed bare lines.
{
  const bare = canonical([`第1s @西娅：${help}`, `第1s @母巢：${reply}`]);
  const draft = makeDraft('', bare);
  draft.promptTrace = { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(bare), modelRuleSetId: '', converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1 };
  const redistributed = canonical([`${cue('母巢', reply, 0.3)} ${cue('西娅', help, 4)}`, '无']);
  let calls = 0;
  const result = await convertStoryboardDraftToFinal({ draft, converter, clean, purpose: 'reference-refresh', request: async () => { calls += 1; return redistributed; } });
  assert.equal(calls, 1); assert.equal(result.finalPrompt, redistributed, 'confirmed content may move across shots/times without a rigid per-shot quote comparison');
}

// The model resolves content omissions within the original full-source
// request. Local word matching cannot veto its readable returned result.
{
  let calls = 0;
  const result = await convertStoryboardDraftToFinal({ draft: makeDraft(), converter, clean, request: async (_system, user) => {
    calls += 1;
    assert.equal(calls, 1);
    assert.equal(jsonBlock(user, 'video_conversion_data').sourceStoryContent, rawSource);
    return missing;
  } });
  assert.equal(calls, 1); assert.equal(result.finalPrompt, missing);
}
{
  let calls = 0; const draft = makeDraft(); const before = JSON.stringify(draft);
  const malformed = missing.replace(' 正在 [', ' 动作 [');
  await assert.rejects(convertStoryboardDraftToFinal({ draft, converter, clean, request: async () => { calls += 1; return malformed; } }), /结构|动作链/u);
  assert.equal(calls, 2, 'one initial conversion plus at most one structural repair');
  assert.equal(JSON.stringify(draft), before, 'failed conversion must not replace the saved draft');
}
{
  let calls = 0;
  await assert.rejects(convertStoryboardDraftToFinal({ draft: makeDraft(), converter, clean, request: async () => { calls += 1; throw new Error('isolated transport failure'); } }), /isolated transport failure/u);
  assert.equal(calls, 1, 'transport errors do not become mechanical content-repair retries');
}
console.log('converterSourceRules: exact full source, optional authored provenance, time coordinate hints, no semantic blocking and one structural repair passed');

// A saved custom preset is not overwritten, but its known obsolete factory
// cutting instruction must not re-enter the live system prompt.
{
  const legacyCut = '目标总时长无法容纳完整长句时，只能按原句标点截取能自然说完的连续片段，不能改写、拼接或加速朗读；连两个字都无法容纳时写“台词：无”。';
  const custom = { ...converter, systemPrompt: `${converter.systemPrompt}\n${legacyCut}\n保留用户选择的冷色视觉风格。` };
  const before = JSON.stringify(custom);
  let calls = 0;
  await convertStoryboardDraftToFinal({ draft: makeDraft(), converter: custom, clean, request: async (system) => {
    calls += 1;
    assert.ok(!system.includes(legacyCut));
    assert.ok(system.includes('保留用户选择的冷色视觉风格。'));
    return complete;
  } });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(custom), before);
}

// Dossiers are not shot instructions. Planning may explicitly select one
// field for one shot; ordinary identity and the source remain independent.
{
  const actor: Character = {
    id: 'scoped-actor', name: '西娅', gender: '女', apparentAge: '成年', race: '人类',
    appearance: '短发', outfit: '蓝色外套与长裤', signatureProps: '通讯器', personality: '沉稳',
    motionHabits: '稳步行走', anchor: '左脸小痣', negativeContinuity: '', assetIds: [],
    nsfwProfile: { fullBody: 'SELECTED_FIELD_SENTINEL', breasts: 'UNSELECTED_FIELD_SENTINEL' },
    nsfwBodyAnchors: { stableTraits: ['AGGREGATE_DOSSIER_SENTINEL'], sourceEvidence: 'fixture' },
  };
  for (const explicit of [false, true]) {
    const draft = makeDraft();
    draft.globalLock = '固定人物：西娅，稳定身体锚点：OLD_DOSSIER_SENTINEL；仍属于同一旧字段\n固定场景：走廊';
    if (explicit) draft.shots[0].visiblePrivatePartsByCharacter = { [actor.id]: ['full-body'] };
    const before = JSON.stringify({ actor, draft });
    let calls = 0;
    const result = await convertStoryboardDraftToFinal({ draft, characters: [actor], converter, clean, request: async (system, user) => {
      calls += 1;
      assert.match(system, /亲吻、拥抱、触碰和隔着衣物的动作本身不是脱衣/u);
      const data = jsonBlock(user, 'video_conversion_data');
      assert.doesNotMatch(user, /OLD_DOSSIER_SENTINEL|UNSELECTED_FIELD_SENTINEL|AGGREGATE_DOSSIER_SENTINEL/u);
      assert.equal(data.characterIdentityFacts[0].outfit, actor.outfit);
      assert.equal(data.sourceStoryContent, rawSource);
      assert.ok(data.globalContinuityFacts.includes('固定场景：走廊'));
      const chosen = data.shotEvidence[0].selectedPrivateFacts;
      assert.equal(chosen.length, explicit ? 1 : 0);
      if (explicit) assert.deepEqual(chosen[0].profile, { fullBody: 'SELECTED_FIELD_SENTINEL' });
      else assert.doesNotMatch(user, /SELECTED_FIELD_SENTINEL/u);
      assert.deepEqual(data.shotEvidence[1].selectedPrivateFacts, [], 'selection never leaks into the adjacent shot');
      return complete;
    } });
    assert.equal(calls, 1); assert.equal(result.finalPrompt, complete);
    assert.equal(JSON.stringify({ actor, draft }), before, 'request projection never rewrites the saved dossier or old prompt');
  }
}
