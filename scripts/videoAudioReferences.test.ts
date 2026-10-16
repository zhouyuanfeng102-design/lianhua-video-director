import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteAssetFromProject } from '../src/assetDeletion';
import { sourceContentHash } from '../src/sourceIntegrity';
import { prepareVideoAudioDraft, renderVideoAudioDraft, resolveVideoAudioReferences, stripVideoAudioPromptBinding, validateVideoAudioReferences, videoAudioBindingId, videoAudioSpeakingCharacterIds } from '../src/videoAudioReferences';
import type { Character, Project, ReferenceAsset, Storyboard, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { FrozenVideoAudioReference, VideoAudioReference } from '../src/videoAudioTypes';
import { videoAudioCapability, videoAudioTextConstraintState } from '../src/videoAudioCapabilities';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';

// Pure data fixtures only: no upload, model, desktop bridge or media decoding.
const character = (id: string, name: string, aliases: string[] = []): Character => ({ id, name, aliases, assetIds: [],
  gender: '', apparentAge: '', race: '', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const asset = (id: string): ReferenceAsset => ({ id, name: `声源 ${id}`, type: 'audio', role: 'audio', mediaType: 'audio',
  mimeType: 'audio/wav', fileName: `${id}.wav`, relativePath: `audio/${id}.wav`, checksum: `checksum-${id}`, tags: [], createdAt: 1, updatedAt: 1 });
const project = (boards: Storyboard[] = []): Project => ({ id: 'audio-project', name: '隔离声音测试', description: '', sourceDocuments: [],
  characters: [character('a', '甲人物', ['小甲']), character('b', '乙人物'), character('c', '丙人物')], locations: [], props: [], scenes: [],
  storyboards: boards, sequencePlans: [], assets: ['voice-a', 'voice-b', 'voice-c', 'voice-n', 'voice-alt'].map(asset), generationTasks: [],
  voicePresets: { characters: { a: { assetId: 'voice-a' }, b: { assetId: 'voice-b' }, c: { assetId: 'voice-c' } }, narrator: { assetId: 'voice-n' } },
  createdAt: 1, updatedAt: 1 });
const board = (prompt: string, patch: Partial<Storyboard> = {}): Storyboard => ({ id: 'board', shots: [], finalPrompt: prompt,
  createdAt: 1, updatedAt: 1, ...patch } as Storyboard);
const draft = (prompt: string, patch: Partial<VideoGenerationDraft> = {}): VideoGenerationDraft => ({ name: '音频测试', prompt,
  backend: 'api', references: [], parameters: {}, source: { storyboardId: 'board', language: 'zh' }, audioSelectionMode: 'project', ...patch });
const api: VideoTaskApiConfig = { enabled: true, provider: 'runninghub', endpoint: 'https://mock.invalid/run', statusEndpointTemplate: 'https://mock.invalid/query',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'url',
  runningHubMappedFields: [0, 1, 2].map((audioIndex) => ({ nodeId: String(144 + audioIndex), fieldName: 'audio', kind: 'audio', audioIndex })) };
const reference = (slotIndex = 0, patch: Partial<VideoAudioReference> = {}): VideoAudioReference => ({ bindingId: videoAudioBindingId(api, slotIndex),
  assetId: 'voice-a', slotIndex, target: { kind: 'character', characterId: 'a' }, retainMode: 'reference', ...patch });
const identity = (characterId = 'a', name = '甲人物', speakerToken = 'VoiceA') => ({ characterId, name, speakerToken, referenceAnchor: `${name}身份保持。` });

test('paired ledger uses explicit speaker IDs and unique aliases, not cast or filenames', () => {
  const prompt = '三人站在桥上，其中两人交谈。';
  const p = project([board(prompt, { audioLedger: [
    { id: 'b', kind: 'dialogue', label: '对白', speakerId: 'b', speaker: '甲人物', text: '好。' },
    { id: 'a', kind: 'dialogue', label: '对白', speaker: '小甲', text: '出发。' },
    { id: 'c', kind: 'ambience', label: '环境', speakerId: 'c', text: '风声' },
  ] })]);
  p.assets[0].name = '乙人物文件名';
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt)), ['a', 'b']);
  const selected = resolveVideoAudioReferences(p, draft(prompt), api);
  assert.deepEqual(selected.map(({ assetId, target }) => ({ assetId, target })), [
    { assetId: 'voice-a', target: { kind: 'character', characterId: 'a' } },
    { assetId: 'voice-b', target: { kind: 'character', characterId: 'b' } },
  ]);
});

test('empty dialogue entries and visual descriptions do not inherit voices', () => {
  const prompt = '三人安静行走，没有对白。';
  const p = project([board(prompt, { audioLedger: [{ id: 'empty', kind: 'dialogue', label: '空对白', speakerId: 'a', text: '  ' }] })]);
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt)), []);
  assert.deepEqual(resolveVideoAudioReferences(p, draft(prompt), api), []);
  assert.deepEqual(videoAudioSpeakingCharacterIds(project(), draft('甲人物：身穿灰色外套，静静站立，没有对白。', { source: undefined })), []);
});

test('current participation fingerprint binds speaking people and excludes mentioned or silent cast', () => {
  const prompt = 'integrated_multimodal_description: 两人交谈。';
  const participation: NonNullable<Storyboard['h3CharacterParticipation']> = { version: 1, promptFingerprint: sourceContentHash(prompt), characters: [
    { characterId: 'a', name: '甲人物', presence: 'visible', shotIndex: 1, evidence: '甲人物说话', speaking: true },
    { characterId: 'b', name: '乙人物', presence: 'offscreen', shotIndex: 1, evidence: '乙人物画外回答', speaking: true },
    { characterId: 'c', name: '丙人物', presence: 'mentioned', shotIndex: 1, evidence: '提到丙人物', speaking: true },
  ] };
  const p = project([board(prompt, { officialPromptZh: prompt, h3CharacterParticipation: participation })]);
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt)), ['a', 'b']);
  p.storyboards[0].h3CharacterParticipation = { ...participation, promptFingerprint: 'obsolete' };
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt)), []);
});

test('paired speaker tokens identify the person and English participation requires paired source', () => {
  const prompt = 'integrated_multimodal_description: <s>VoiceA</s><d>出发。</d>';
  const p = project([board(prompt, { officialPromptZh: prompt, h3IdentityBindings: { version: 1, characters: [identity()] } })]);
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt)), ['a']);
  const zh = '两人在桥上交谈。'; const en = 'The two people talk on a bridge.';
  p.storyboards[0] = board(zh, { officialPromptZh: zh, officialPromptEn: en, officialPromptEnSource: zh,
    h3CharacterParticipation: { version: 1, promptFingerprint: sourceContentHash(zh), characters: [
      { characterId: 'b', name: '乙人物', presence: 'visible', shotIndex: 1, evidence: '乙人物回答', speaking: true },
    ] } });
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(en, { source: { storyboardId: 'board', language: 'en' } })), ['b']);
  p.storyboards[0].officialPromptEnSource = 'older source';
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(en, { source: { storyboardId: 'board', language: 'en' } })), []);
});

test('ambiguous names or aliases cannot assign two people to one speaker label', () => {
  const p = project(); p.characters[0].aliases = ['同名']; p.characters[1].aliases = ['同名'];
  const input = draft('同名说：“出发。”', { source: undefined });
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, input), []);
  const exact = board(input.prompt, { audioLedger: [{ id: 'explicit', kind: 'dialogue', label: '对白', speakerId: 'b', speaker: '同名', text: '出发。' }] });
  p.storyboards = [exact];
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, { ...input, source: { storyboardId: 'board' } }), ['b']);
});

test('manual prompt changes do not reuse an old dialogue or narrator ledger', () => {
  const original = '两人交谈，画外旁白介绍地点。';
  const p = project([board(original, { audioLedger: [
    { id: 'a', kind: 'dialogue', label: '对白', speakerId: 'a', text: '出发。' },
    { id: 'n', kind: 'voiceover', label: '旁白', text: '这是石桥。' },
  ] })]);
  assert.equal(resolveVideoAudioReferences(p, draft(original), api).length, 2);
  assert.deepEqual(resolveVideoAudioReferences(p, draft('三人无对白静静走过石桥。'), api), []);
  assert.deepEqual(resolveVideoAudioReferences(p, draft('乙人物说：“到了。”'), api).map((entry) => entry.target), [{ kind: 'character', characterId: 'b' }]);
});

test('explicit none clears stale references and removes only the previously rendered audio note', () => {
  const p = project(); const original = '甲人物说：“00:03 出发。”';
  const prepared = prepareVideoAudioDraft(p, draft(original), api);
  assert.equal(prepared.audioReferences?.length, 1);
  const cleared = prepareVideoAudioDraft(p, { ...prepared, audioSelectionMode: 'none' }, api);
  assert.deepEqual(cleared.audioReferences, []); assert.equal(cleared.prompt, original); assert.equal(cleared.audioReferenceBinding, undefined);
  assert.deepEqual(resolveVideoAudioReferences(p, { ...prepared, audioSelectionMode: 'none' }, api), []);
});

test('project mode re-resolves edited presets despite a previous prepared reference array', () => {
  const p = project(); const original = '甲人物说：“出发。”';
  const previous = prepareVideoAudioDraft(p, draft(original), api);
  const changed = { ...p, voicePresets: { characters: { a: { assetId: 'voice-alt', retainMode: 'partially_copy' as const, notes: '新的片段范围' } } } };
  const selected = resolveVideoAudioReferences(changed, previous, api);
  assert.equal(selected[0].assetId, 'voice-alt'); assert.equal(selected[0].retainMode, 'partially_copy');
  const prepared = prepareVideoAudioDraft(changed, previous, api);
  assert.equal(prepared.audioReferences?.[0].assetId, 'voice-alt');
  assert.equal((prepared.prompt.match(/<Audio 1>/gu) || []).length, 1); assert.ok(prepared.prompt.startsWith(original));
});

test('override and frozen reuse preserve selected voices without mutating inputs', () => {
  const p = project(); const selected = [reference(2, { notes: '保留已有选择' })];
  const input = draft('两人无对白。', { audioSelectionMode: 'override', audioReferences: selected });
  const selectedResult = resolveVideoAudioReferences(p, input, api);
  assert.deepEqual(selectedResult, selected); assert.notStrictEqual(selectedResult, selected); assert.notStrictEqual(selectedResult[0], selected[0]);
  selectedResult[0].notes = 'changed'; assert.equal(selected[0].notes, '保留已有选择');
  const frozen = { ...input, audioSelectionMode: 'project' as const, reuseTaskId: 'original-task' };
  assert.deepEqual(resolveVideoAudioReferences(p, frozen, api), selected);
  assert.strictEqual(prepareVideoAudioDraft(p, frozen, api), frozen);
});

test('inheritance overflow is retained and rejected rather than truncated', () => {
  const p = project(); const input = draft('甲人物说：“一。”\n乙人物说：“二。”\n丙人物说：“三。”\n旁白：完。');
  const selected = resolveVideoAudioReferences(p, input, api);
  assert.equal(selected.length, 4); assert.deepEqual(selected.map((entry) => entry.slotIndex), [0, 1, 2, 3]);
  assert.equal(selected[3].target.kind, 'voiceover');
  assert.ok(validateVideoAudioReferences(p, { ...input, audioReferences: selected }, api).some((issue) => issue.includes('超出')));
});

test('no mapped capacity preserves explicit choices while default presets remain unused', () => {
  const p = project(); const none = { ...api, runningHubMappedFields: [] };
  assert.deepEqual(resolveVideoAudioReferences(p, draft('甲人物说：“出发。”'), none), []);
  const input = draft('甲人物说：“出发。”', { audioSelectionMode: 'override', audioReferences: [reference()] });
  assert.equal(resolveVideoAudioReferences(p, input, none).length, 1);
  assert.ok(validateVideoAudioReferences(p, input, none).some((issue) => issue.includes('音频输入映射')));
});

test('sparse slot validation keeps independent indexes and catches changed bindings and duplicates', () => {
  const p = project(); const selected = [reference(0), reference(2, { assetId: 'voice-b', target: { kind: 'character', characterId: 'b' } })];
  const input = draft('对白', { audioSelectionMode: 'override', audioReferences: selected });
  assert.deepEqual(validateVideoAudioReferences(p, input, api), []);
  assert.deepEqual(resolveVideoAudioReferences(p, input, api).map((entry) => entry.slotIndex), [0, 2]);
  assert.ok(validateVideoAudioReferences(p, { ...input, audioReferences: [{ ...selected[1], bindingId: 'other-workflow-field' }] }, api).some((issue) => issue.includes('节点已变化')));
  assert.ok(validateVideoAudioReferences(p, { ...input, audioReferences: [selected[1], selected[1]] }, api).some((issue) => issue.includes('重复')));
});

test('plain rendering is idempotent and preserves authored dialogue and timing', () => {
  const p = project(); const original = '00:03 甲人物说：“出发。”\n00:05 乙人物回答：“好。”';
  const input = draft(original, { audioSelectionMode: 'override', audioReferences: [reference(2)] });
  const before = JSON.stringify({ p, input });
  const first = prepareVideoAudioDraft(p, input, api); const second = prepareVideoAudioDraft(p, first, api);
  assert.equal(first.prompt, second.prompt); assert.ok(first.prompt.startsWith(original));
  assert.equal((first.prompt.match(/<Audio 3>/gu) || []).length, 1); assert.equal(first.source?.promptFingerprint, sourceContentHash(first.prompt));
  assert.equal(JSON.stringify({ p, input }), before);
});

test('H3 full-reference defines audio and cites only speaking shots without changing cuts or soundscape', () => {
  const original = 'subject_definitions: 真实材质。\nsummary: 两人交谈。\nretention_analysis: 保持原稿。\ndetailed_description:\n[Shot 1] <s>VoiceA</s><d>出发。</d>\n[Shot 2] At 00:05.000 甲人物静默。\n[Shot 3] At 00:08.000 <s>VoiceA</s><d>等等。</d>\noverall_soundscape: 风声。\nnon_diegetic_music: N/A';
  const p = project([board(original)]);
  const input = draft(original, { audioSelectionMode: 'override', audioReferences: [reference(2)], h3ReferenceBinding: {
    version: 1, projectId: p.id, basePrompt: original, renderedPrompt: original, identities: { version: 1, characters: [identity()] },
  } });
  const first = prepareVideoAudioDraft(p, input, api); const second = prepareVideoAudioDraft(p, first, api);
  assert.equal(first.prompt, second.prompt);
  assert.deepEqual(readH3PromptProtocol(first.prompt)?.shots, readH3PromptProtocol(original)?.shots);
  assert.ok(readH3PromptProtocol(first.prompt));
  assert.equal(first.prompt.match(/<Audio 3>/gu)?.length, 3, 'one definition and two actual speaking shots');
  assert.match(first.prompt, /subject_definitions:\s*<Audio 3>/u);
  assert.match(first.prompt, /\[Shot 3\] At 00:08\.000 镜头 3 音频用途/u);
  assert.equal(first.prompt.match(/\[Shot 2\][\s\S]*?(?=\[Shot 3\])/u)?.[0].includes('<Audio'), false);
  assert.equal(first.prompt.slice(first.prompt.indexOf('overall_soundscape:')), original.slice(original.indexOf('overall_soundscape:')));
  assert.ok(first.prompt.includes('甲人物 (VoiceA)')); assert.strictEqual(p.storyboards[0].finalPrompt, original);
  const changed = renderVideoAudioDraft(p, { ...first, audioReferences: [reference(2, { retainMode: 'weak_reference', notes: '只参考氛围' })] }, api);
  assert.equal((changed.prompt.match(/<Audio 3>/gu) || []).length, 3); assert.ok(changed.prompt.includes('weak_reference'));
  assert.equal(stripVideoAudioPromptBinding(changed.prompt, changed.audioReferenceBinding), original);
});

test('H3 three-field prompts remain usable with audio without manufacturing mixed fields', () => {
  const original = 'integrated_multimodal_description: [Shot 1] 甲人物说 <d>出发。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const p = project(); const input = draft(original, { audioSelectionMode: 'override', audioReferences: [reference()] });
  const rendered = renderVideoAudioDraft(p, input, api);
  assert.equal(rendered.prompt, original); assert.equal(rendered.audioReferenceBinding, undefined);
  assert.deepEqual(validateVideoAudioReferences(p, rendered, api), []);
  assert.deepEqual(rendered.audioReferences, input.audioReferences);
  assert.doesNotMatch(rendered.prompt, /^(?:subject_definitions|summary|retention_analysis|detailed_description):/mu);
  assert.deepEqual(validateVideoAudioReferences(p, { ...input, audioReferences: [] }, api), []);
  assert.equal(renderVideoAudioDraft(p, { ...input, audioReferences: [] }, api).prompt, original);
});

test('English audio notes preserve original spoken text and frozen rendering ignores current presets', () => {
  const original = 'subject_definitions: Neutral light.\nsummary: A departure.\nretention_analysis: Keep the dialogue.\ndetailed_description: [Shot 1] <s>VoiceA</s><d>[Chinese] 出发。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const p = project(); const input = draft(original, { source: { storyboardId: 'board', language: 'en' }, audioSelectionMode: 'override', audioReferences: [reference()] });
  const rendered = renderVideoAudioDraft(p, input, api);
  assert.ok(rendered.prompt.includes('<Audio 1>')); assert.ok(rendered.prompt.includes('<d>[Chinese] 出发。</d>'));
  const changed = { ...p, voicePresets: { characters: { a: { assetId: 'voice-alt' } } } };
  assert.equal(renderVideoAudioDraft(changed, rendered, api).audioReferences?.[0].assetId, 'voice-a');
});

test('edited rendered prompts keep user changes and only one intact audio instruction', () => {
  const p = project();
  const originals = [
    '甲人物说：“00:03 出发。”\n镜头缓慢推进。',
    'subject_definitions: 真实材质。\nsummary: 出发。\nretention_analysis: 保持原文。\ndetailed_description: [Shot 1] <s>VoiceA</s><d>出发。</d>\noverall_soundscape: 风声。\nnon_diegetic_music: N/A',
  ];
  for (const original of originals) {
    const input = draft(original, { h3ReferenceBinding: { version: 1, projectId: p.id, basePrompt: original,
      renderedPrompt: original, identities: { version: 1, characters: [identity()] } } });
    const prepared = prepareVideoAudioDraft(p, input, api);
    assert.equal(prepared.audioReferences?.length, 1);
    const editedBase = `${original.replace('出发。', '现在出发。').replace('真实材质。', '暖色材质。')}\n用户补充：摄像机停在门口。`;
    const editedPrompt = `${prepared.prompt.replace('出发。', '现在出发。').replace('真实材质。', '暖色材质。')}\n用户补充：摄像机停在门口。`;
    assert.equal(stripVideoAudioPromptBinding(editedPrompt, prepared.audioReferenceBinding), editedBase);
    const edited = { ...prepared, prompt: editedPrompt };
    const next = prepareVideoAudioDraft(p, edited, api);
    assert.equal(next.audioReferences?.length, 1); // Editing visual prose must not silently disable the voice.
    assert.equal(next.audioReferenceBinding?.basePrompt, editedBase);
    assert.equal((next.prompt.match(/<Audio 1>/gu) || []).length, original.startsWith('subject_definitions:') ? 2 : 1);
    assert.ok(next.prompt.includes('现在出发。')); assert.ok(next.prompt.includes('用户补充：摄像机停在门口。'));
    assert.equal(prepareVideoAudioDraft(p, next, api).prompt, next.prompt);
    const cleared = prepareVideoAudioDraft(p, { ...edited, audioSelectionMode: 'none' }, api);
    assert.equal(cleared.prompt, editedBase); assert.deepEqual(cleared.audioReferences, []);
    const changedInstruction = editedPrompt.replace('参考音色，使用本段已有台词和原说话时序。', '用户改写的声音要求。');
    assert.ok(stripVideoAudioPromptBinding(changedInstruction, prepared.audioReferenceBinding).includes('用户改写的声音要求。'));
  }
  const replacement = { version: 1 as const, basePrompt: '用户正文。', renderedPrompt: '被替换的内容。附注' };
  assert.equal(stripVideoAudioPromptBinding(replacement.renderedPrompt, replacement), replacement.renderedPrompt);
});

test('deleted live voice presets detach without changing saved task audio or authored provenance', () => {
  const original = '甲人物说：“出发。”';
  const p = project([board(original, { audioLedger: [{ id: 'a', kind: 'dialogue', label: '对白', speakerId: 'a', text: '出发。', sourceAssetId: 'voice-a' }] })]);
  p.voicePresets = { characters: { a: { assetId: 'voice-a' }, b: { assetId: 'voice-b' }, c: { assetId: 'voice-a' } }, narrator: { assetId: 'voice-a' } };
  const frozen: FrozenVideoAudioReference = { ...reference(), name: '原声音', relativePath: 'audio/frozen.wav', checksum: 'frozen-checksum', freezeState: 'frozen' };
  const { apiKey: _apiKey, ...safeApi } = api;
  const task: VideoGenerationTask = { id: 'saved-task', kind: 'video', storyboardId: 'board', targetId: 'mock', status: 'succeeded', requestBody: { prompt: original },
    videoJob: { stage: 'succeeded', snapshot: { projectId: p.id, draft: draft(original, { audioSelectionMode: 'override', audioReferences: [reference()] }),
      connection: { backend: 'api', api: safeApi }, images: [], audios: [frozen], clientId: 'client' } }, createdAt: 1, updatedAt: 1 };
  p.generationTasks = [task]; p.assets.push({ ...asset('result'), type: 'video', mediaType: 'video', role: 'motion', videoSourceTask: task });
  const before = JSON.stringify(p); const after = deleteAssetFromProject(p, 'voice-a', 10);
  assert.deepEqual(after.voicePresets?.characters, { b: { assetId: 'voice-b' } }); assert.equal(after.voicePresets?.narrator, undefined);
  assert.strictEqual(after.generationTasks, p.generationTasks); assert.strictEqual(after.generationTasks[0].videoJob, task.videoJob);
  assert.strictEqual(after.assets.find((entry) => entry.id === 'result')?.videoSourceTask, task);
  assert.equal(after.storyboards[0].audioLedger?.[0].sourceAssetId, undefined); assert.equal(after.storyboards[0].audioLedger?.[0].text, '出发。');
  assert.equal(after.storyboards[0].finalPrompt, original); assert.equal(JSON.stringify(p), before);
  assert.deepEqual(validateVideoAudioReferences(after, task.videoJob!.snapshot.draft, api, [frozen]), []);
});

test('deleting unrelated media keeps project voice preset identity', () => {
  const p = project(); p.assets.push({ ...asset('picture'), type: 'reference', mediaType: 'image', role: 'composition' });
  assert.strictEqual(deleteAssetFromProject(p, 'picture', 10).voicePresets, p.voicePresets);
  assert.strictEqual(deleteAssetFromProject(p, 'absent', 10), p);
});

test('actual Seedance timed dialogue and English aliases outrank an older paired ledger', () => {
  const prompt = '- 0.60s - 8.50s 甲人物（年轻女性，清亮声线，画内）：“出发。”\n- 8.70s - 11.20s 乙人物（轻盈女声）：“马上来。”\n丙人物：穿着长袍，闭口倾听。';
  const p = project([board(prompt, { seedance25Output: { promptZh: prompt } as Storyboard['seedance25Output'], audioLedger: [
    { id: 'obsolete', kind: 'dialogue', label: '旧说话人', speakerId: 'c', text: '旧稿的话。' },
  ] })]);
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(prompt, { source: { storyboardId: 'board', promptFormat: 'seedance', language: 'zh' } })), ['a', 'b']);
  p.characters[0].aliases = ['Alice']; p.characters[1].aliases = ['Bob'];
  const english = '0.5s - 2.5s Alice (young female, bright timbre): "Come here."\n- 2.7s - 4.0s Bob (light voice): “Coming.”';
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(english, { source: { language: 'en', promptFormat: 'seedance' } })), ['a', 'b']);
  const silent = 'subject_definitions: <s>VoiceA</s> is a woman.\ndetailed_description: [Shot 1] <s>VoiceA</s><d>[English] Silence.</d>';
  assert.deepEqual(videoAudioSpeakingCharacterIds(p, draft(silent, { h3ReferenceBinding: { version: 1, projectId: p.id,
    basePrompt: silent, renderedPrompt: silent, identities: { version: 1, characters: [identity()] } } })), []);
});

test('Seedance audio uses @Audio inside the existing reference chapter with reversible replacement and sparse slots', () => {
  const original = '### 视频规格\n30秒。\n### 参考素材与职责\n- 本段未绑定外部图像、视频或音频媒体素材。所有人物沿用原设定。\n### 主体连续性\n甲人物与乙人物。\n### 一句话概述\n交谈。\n### 连续时间轴\n- 0.60s - 8.50s 甲人物（年轻女声）：“出发。”\n- 8.70s - 11.20s 乙人物（清亮女声）：“好。”\n### 全局约束\n保留对白。';
  const p = project(); const input = draft(original, { source: { promptFormat: 'seedance', language: 'zh' }, audioSelectionMode: 'override',
    audioReferences: [reference(), reference(2, { assetId: 'voice-b', target: { kind: 'character', characterId: 'b' } })] });
  const first = renderVideoAudioDraft(p, input, api);
  assert.equal(renderVideoAudioDraft(p, first, api).prompt, first.prompt);
  assert.equal(first.prompt.match(/@Audio 1/gu)?.length, 1); assert.equal(first.prompt.match(/@Audio 3/gu)?.length, 1);
  assert.doesNotMatch(first.prompt, /<Audio /u); assert.doesNotMatch(first.prompt, /未绑定外部/u);
  assert.deepEqual(first.prompt.match(/^### .+$/gmu), original.match(/^### .+$/gmu));
  assert.equal(first.prompt.split('### 主体连续性')[1], original.split('### 主体连续性')[1]);
  assert.match(first.prompt.split('### 主体连续性')[0], /@Audio 1[\s\S]*@Audio 3/u);
  assert.equal(stripVideoAudioPromptBinding(first.prompt, first.audioReferenceBinding), original);
  const edited = { ...first, prompt: first.prompt.replace('30秒。', '30秒，暖光。') };
  assert.equal(stripVideoAudioPromptBinding(edited.prompt, edited.audioReferenceBinding), original.replace('30秒。', '30秒，暖光。'));
  const cleared = prepareVideoAudioDraft(p, { ...edited, audioSelectionMode: 'none' }, api);
  assert.equal(cleared.prompt, original.replace('30秒。', '30秒，暖光。')); assert.deepEqual(cleared.audioReferences, []);
  assert.strictEqual(prepareVideoAudioDraft(p, { ...first, reuseTaskId: 'old-task' }, api).prompt, first.prompt);
  const existing = original.replace('- 本段未绑定外部图像、视频或音频媒体素材。所有人物沿用原设定。', '@Image 1: a room.');
  const inserted = renderVideoAudioDraft(p, { ...input, prompt: existing }, api);
  assert.ok(inserted.prompt.includes('@Image 1: a room.')); assert.equal(stripVideoAudioPromptBinding(inserted.prompt, inserted.audioReferenceBinding), existing);
});

test('AI-updated H3 audio definitions and shot citations are reused without duplicate declarations', () => {
  const original = 'subject_definitions: <Audio 1> is the voice timbre for 甲人物.\nsummary: One word.\nretention_analysis: Keep the dialogue.\ndetailed_description: [Shot 1] 甲人物 says <d>出发。</d> using <Audio 1>.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const rendered = renderVideoAudioDraft(project(), draft(original, { audioSelectionMode: 'override', audioReferences: [reference()] }), api);
  assert.equal(rendered.prompt, original); assert.equal(rendered.prompt.match(/<Audio 1>/gu)?.length, 2);
});

test('confirmed character samples inherit only for actual speakers and preserve explicit preset, none and frozen authority', () => {
  const p = project(); p.voicePresets = undefined;
  p.characters[0].voiceProfile = { version: 1, perceivedAge: '年轻成年女声', timbre: '轻盈清亮', referenceAssetId: 'voice-a', source: 'manual' };
  p.characters[1].voiceProfile = { version: 1, referenceAssetId: 'voice-b' };
  const input = draft('- 0.50s - 2.00s 甲人物（轻声）：“出发。”');
  assert.deepEqual(resolveVideoAudioReferences(p, input, api).map((entry) => entry.assetId), ['voice-a']);
  p.voicePresets = { characters: { a: { assetId: 'voice-alt', retainMode: 'fully_copy' } } };
  assert.equal(resolveVideoAudioReferences(p, input, api)[0].assetId, 'voice-alt');
  assert.deepEqual(resolveVideoAudioReferences(p, { ...input, audioSelectionMode: 'none' }, api), []);
  assert.deepEqual(resolveVideoAudioReferences(p, { ...input, audioSelectionMode: 'override', audioReferences: [] }, api), []);
  const frozen = { ...input, reuseTaskId: 'old-task', audioReferences: [reference(2, { assetId: 'voice-b' })] };
  assert.equal(resolveVideoAudioReferences(p, frozen, api)[0].assetId, 'voice-b');
});

test('capability status follows implemented input mapping and never blocks a text-only request', () => {
  assert.equal(videoAudioCapability(undefined).status, 'unknown'); assert.equal(videoAudioCapability(api).status, 'supported');
  assert.equal(videoAudioCapability({ ...api, runningHubMappedFields: [] }).status, 'unsupported');
  assert.equal(videoAudioCapability({ ...api, runningHubMappedFields: [{ nodeId: '', fieldName: 'audio', kind: 'audio', audioIndex: 0 }] }).status, 'unsupported');
  const malformed = { ...api, runningHubMappedFields: [null, { nodeId: 2, fieldName: null, kind: 'audio', audioIndex: 0 }] } as unknown as VideoTaskApiConfig;
  assert.equal(videoAudioCapability(malformed).status, 'unsupported');
  assert.deepEqual(resolveVideoAudioReferences(project(), draft('甲人物说：“出发。”'), malformed), []);
  const classic = { ...api, provider: 'generic' as const, model: '特价2.5需要过人脸技术-可参考过人脸素材库', endpoint: 'https://video.laoliimage2.win/v1/videos' };
  assert.equal(videoAudioCapability(classic).status, 'unsupported');
  assert.deepEqual(validateVideoAudioReferences(project(), draft('甲人物说：“出发。”'), classic), []);
  assert.equal(videoAudioTextConstraintState('年轻女性声线，轻盈清亮。'), 'present');
  assert.equal(videoAudioTextConstraintState('A young adult voice timbre.'), 'present');
  assert.equal(videoAudioTextConstraintState('外表18岁，金发，身穿红铠。'), 'missing');
});
