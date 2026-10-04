import assert from 'node:assert/strict';
import {
  applyAutomaticVideoTailEntries, applyVideoTailReference, automaticVideoTailIssue, buildAutomaticVideoTailEntries,
  getVideoTailReferencePlacements, lookupPreviousSegmentVideos, lookupPreviousSequenceSegment,
  preferredVideoTailReferencePlacement, oneClickVideoTailReferencePlacement, buildOneClickVideoTailEntries, resolveAutomaticVideoTailInput, videoTailSequenceFingerprint, videoTailTaskPresentation,
  type AutomaticVideoTailCandidate, type AutomaticVideoTailConfiguration,
} from '../src/videoTailReference';
import type { Project, ReferenceAsset, Storyboard, VideoGenerationTask, VideoSegment, VideoSequencePlan } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoImageReference } from '../src/videoGenerationTypes';

let count = 0;
const test = (name: string, run: () => void) => { run(); count += 1; console.log(`ok ${count} - ${name}`); };
const segment = (index: number): VideoSegment => ({
  id: `segment-${index}`, index, title: `第 ${index} 段`, globalStartSec: (index - 1) * 15, globalEndSec: index * 15,
  durationSec: 15, content: '', summary: '', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '',
  entryState: '', exitState: '', transitionHint: '', storyboardId: `board-${index}`, status: 'ready',
});
const plan: VideoSequencePlan = { id: 'plan', title: '剧情', sourceStoryTitle: '剧情', sourceStoryContent: '',
  durationMode: 'ai-estimated', totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced',
  segments: [segment(3), segment(1), segment(2)], createdAt: 1, updatedAt: 1 };
const video = (id = 'video-1', patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'video', mediaType: 'video', role: 'motion', source: 'generated',
  relativePath: `video/${id}.mp4`, sourceStoryboardId: 'board-1', tags: [], createdAt: 10, updatedAt: 10, ...patch,
});
const task = (patch: Partial<VideoGenerationTask> = {}): VideoGenerationTask => ({
  id: 'task-1', kind: 'video', storyboardId: 'board-1', targetId: 'h3', status: 'succeeded', resultAssetId: 'video-1',
  sequencePlanId: 'plan', segmentId: 'segment-1', segmentIndex: 1, requestBody: {}, createdAt: 1, updatedAt: 10,
  videoJob: { stage: 'succeeded', snapshot: { projectId: 'project', clientId: 'client', images: [],
    draft: { name: '第一段', prompt: '不要改对白', backend: 'comfyui', references: [], parameters: { seed: 72 },
      source: { storyboardId: 'board-1', sequencePlanId: 'plan', segmentId: 'segment-1', segmentIndex: 1, language: 'zh', promptVersion: 'v1' } },
    connection: { backend: 'comfyui' } } }, ...patch,
});
type TestProject = Pick<Project, 'id' | 'sequencePlans' | 'storyboards' | 'assets' | 'generationTasks'>;
const project = (patch: Partial<TestProject> = {}): TestProject => ({
  id: 'project', sequencePlans: [structuredClone(plan)], generationTasks: [], assets: [video()],
  storyboards: [1, 2, 3].map((index) => ({ id: `board-${index}`, sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index } as Storyboard)),
  ...patch,
});
const lookup = (value = project()) => lookupPreviousSegmentVideos(value, { sequencePlanId: 'plan', segmentId: 'segment-2' });

test('unambiguous saved video maps by storyboard after its task is deleted', () => {
  const result = lookup(); assert.equal(result.previousSegment?.index, 1); assert.equal(result.versions[0].asset.id, 'video-1');
});
test('shuffled list still uses exact index minus one, not an adjacent visible row', () => {
  const result = lookupPreviousSegmentVideos(project({ assets: [video('video-1'), video('video-2', { sourceStoryboardId: 'board-2' })] }),
    { sequencePlanId: 'plan', segmentId: 'segment-3' });
  assert.deepEqual(result.versions.map((version) => version.asset.id), ['video-2']);
});
test('the first segment has no predecessor', () => {
  assert.equal(lookupPreviousSegmentVideos(project(), { sequencePlanId: 'plan', segmentId: 'segment-1' }).reasonCode, 'first-segment');
});
test('a gap does not skip backwards to another segment', () => {
  const value = project(); value.sequencePlans[0].segments = [segment(3), segment(1)];
  assert.equal(lookupPreviousSegmentVideos(value, { sequencePlanId: 'plan', segmentId: 'segment-3' }).reasonCode, 'missing-previous');
});
test('duplicate predecessor indices are ambiguous', () => {
  const value = project(); value.sequencePlans[0].segments.push({ ...segment(1), id: 'duplicate' });
  assert.equal(lookup(value).reasonCode, 'missing-previous');
});
test('deleted or duplicate target plans are invalid', () => {
  assert.equal(lookup(project({ sequencePlans: [] })).reasonCode, 'invalid-target');
  assert.equal(lookup(project({ sequencePlans: [plan, plan] })).reasonCode, 'invalid-target');
});
test('same storyboard reused across plans is not reliable provenance', () => {
  assert.equal(lookup(project({ sequencePlans: [plan, { ...plan, id: 'other-plan' }] })).versions.length, 0);
});
test('matching filenames and labels never establish segment provenance', () => {
  assert.equal(lookup(project({ assets: [video('board-1-segment-1', { sourceStoryboardId: undefined })] })).versions.length, 0);
});
test('a live successful task resolves a legacy resultAssetId-only video', () => {
  const result = lookup(project({ assets: [video('video-1', { sourceStoryboardId: undefined })], generationTasks: [task()] }));
  assert.equal(result.versions[0].task?.id, 'task-1'); assert.match(result.versions[0].label, /中文稿.*v1/u);
});
test('asset-owned provenance survives task removal', () => {
  const result = lookup(project({ assets: [video('video-1', { sourceVideoTaskId: 'task-1', videoSourceTask: task() })] }));
  assert.equal(result.versions[0].task?.id, 'task-1');
});
test('a snapshot alone can locate the exact previous segment', () => {
  const item = task({ storyboardId: '', sequencePlanId: undefined, segmentId: undefined, segmentIndex: undefined });
  assert.equal(lookup(project({ assets: [video('video-1', { sourceStoryboardId: undefined, videoSourceTask: item })] })).versions.length, 1);
});
test('foreign project snapshots never fall back to matching storyboard ids', () => {
  const item = task(); item.videoJob!.snapshot.projectId = 'foreign';
  assert.equal(lookup(project({ assets: [video('video-1', { videoSourceTask: item })] })).versions.length, 0);
});
test('conflicting snapshot and task segment/plan are rejected', () => {
  for (const sourcePatch of [{ sequencePlanId: 'foreign-plan' }, { segmentId: 'segment-2' }, { segmentIndex: 2 }]) {
    const item = task(); Object.assign(item.videoJob!.snapshot.draft.source!, sourcePatch);
    assert.equal(lookup(project({ assets: [video('video-1', { videoSourceTask: item })] })).versions.length, 0);
  }
});
test('a current failed or pending task cannot masquerade as a completed video', () => {
  for (const status of ['draft', 'submitted', 'running', 'failed', 'unknown'] as const) {
    assert.equal(lookup(project({ generationTasks: [task({ status })] })).versions.length, 0);
  }
});
test('remote success still downloading is unavailable', () => {
  const item = task(); item.videoJob!.stage = 'downloading';
  const result = lookup(project({ generationTasks: [item] })); assert.equal(result.versions.length, 0); assert.equal(result.reasonCode, 'waiting');
});
test('pending previous task yields actionable wait notice', () => {
  const item = task({ status: 'running' }); item.videoJob!.stage = 'running';
  const result = lookup(project({ assets: [], generationTasks: [item] })); assert.equal(result.reasonCode, 'waiting'); assert.match(result.reason!, /等待/u);
});
test('unrelated plan pending task does not cause a false wait notice', () => {
  const result = lookup(project({ assets: [], generationTasks: [task({ status: 'running', sequencePlanId: 'another' })] }));
  assert.equal(result.reasonCode, 'no-local-video');
});
test('missing, remote-only, unsafe and wrong-media assets are excluded', () => {
  for (const patch of [{ missing: true }, { relativePath: undefined, url: 'https://example.test/video.mp4' },
    { relativePath: '../video/a.mp4' }, { relativePath: 'C:/video/a.mp4' }, { relativePath: '/video/a.mp4' },
    { relativePath: 'video/../a.mp4' }, { type: 'reference' as const, mediaType: 'image' as const }]) {
    assert.equal(lookup(project({ assets: [video('video-1', patch)] })).versions.length, 0);
  }
});
test('source task id and result asset id contradictions are rejected', () => {
  assert.equal(lookup(project({ assets: [video('video-1', { sourceVideoTaskId: 'wrong', videoSourceTask: task() })] })).versions.length, 0);
  assert.equal(lookup(project({ assets: [video('video-1', { videoSourceTask: task({ resultAssetId: 'wrong' }) })] })).versions.length, 0);
});
test('conflicting storyboard metadata is not allowed even with direct plan/segment links', () => {
  const value = project({ generationTasks: [task()] }); value.storyboards[0].sequencePlanId = 'another';
  assert.equal(lookup(value).versions.length, 0);
});
test('explicit source may retain a video from a deleted historical storyboard', () => {
  const item = task({ storyboardId: 'old-board' }); item.videoJob!.snapshot.draft.source!.storyboardId = 'old-board';
  assert.equal(lookup(project({ assets: [video('video-1', { sourceStoryboardId: 'old-board', videoSourceTask: item })] })).versions.length, 1);
});
test('all completed versions are offered newest first, without choosing a filename', () => {
  const value = project({ assets: [video('old', { createdAt: 2 }), video('new', { createdAt: 4 })] });
  const before = JSON.stringify(value); assert.deepEqual(lookup(value).versions.map((item) => item.asset.id), ['new', 'old']);
  assert.equal(JSON.stringify(value), before, 'lookups never mutate project state');
});

const workflow = (roles: Array<VideoImageReference['role'] | undefined>): ComfyVideoWorkflowPreset => ({
  id: 'flow', name: 'flow', workflowJson: '{}', mapping: { prompt: [], images: roles.map((role, index) => ({ nodeId: String(index), inputName: 'image', role })) }, createdAt: 1, updatedAt: 1,
});
const refs: VideoImageReference[] = [{ assetId: 'character', role: 'character' }, { assetId: 'scene', role: 'composition' }];
const choices = (roles: Parameters<typeof workflow>[0], references: VideoImageReference[] = []) => getVideoTailReferencePlacements({ backend: 'comfyui', workflow: workflow(roles), references });
test('single first-frame slot explicitly replaces the chosen image', () => {
  const references: VideoImageReference[] = [{ assetId: 'old', role: 'first-frame' }];
  const result = choices(['first-frame'], references); assert.equal(result.options.length, 1);
  const choice = result.options[0]; assert.equal(choice.mode, 'replace'); assert.equal(choice.requiresConfirmation, true);
  assert.equal(choice.role, 'first-frame'); assert.equal(choice.semantics, 'first-frame');
  assert.throws(() => applyVideoTailReference({ references, tailAssetId: 'tail', placement: choice }), /明确确认/u);
  assert.deepEqual(applyVideoTailReference({ references, tailAssetId: 'tail', placement: choice, confirmed: true }), [{ assetId: 'tail', role: 'first-frame' }]);
});
test('single general and composition slots do not claim forced first-frame semantics', () => {
  for (const role of ['general', 'composition', undefined] as const) {
    const choice = choices([role], [{ assetId: 'old', role: role || 'general' }]).options[0];
    assert.equal(choice.semantics, 'reference'); assert.match(choice.warning!, /不保证/u); assert.equal(choice.requiresConfirmation, true);
    assert.equal(choice.role, role || 'general');
  }
});

test('single-slot tail replacement accepts existing subject and character images without clearing them first', () => {
  for (const originalRole of ['subject', 'character'] as const) for (const slotRole of ['general', 'composition', 'first-frame'] as const) {
    const references: VideoImageReference[] = [{ assetId: 'old-identity', role: originalRole }];
    const before = JSON.stringify(references);
    const options = choices([slotRole], references).options;
    assert.equal(options.length, 1);
    const selected = preferredVideoTailReferencePlacement(options, references)!;
    assert.equal(selected.mode, 'replace'); assert.equal(selected.role, slotRole);
    assert.equal(selected.replacedAssetId, 'old-identity'); assert.equal(selected.requiresConfirmation, true);
    assert.deepEqual(applyVideoTailReference({ references, placement: selected, tailAssetId: 'tail', confirmed: true }), [{ assetId: 'tail', role: slotRole }]);
    assert.equal(JSON.stringify(references), before);
  }
});
test('multiple slots permit next free first-frame slot without changing other roles or order', () => {
  const result = choices(['character', 'composition', 'first-frame'], refs); const option = result.options.find((item) => item.mode === 'append')!;
  assert.equal(option.index, 2); assert.equal(option.role, 'first-frame');
  const before = JSON.stringify(refs); const next = applyVideoTailReference({ references: refs, tailAssetId: 'tail', placement: option });
  assert.deepEqual(next, [...refs, { assetId: 'tail', role: 'first-frame' }]); assert.equal(JSON.stringify(refs), before); assert.notEqual(next[0], refs[0]);
});
test('replacing a composition slot retains all unrelated images and their order', () => {
  const option = choices(['character', 'composition'], refs).options[0]; assert.equal(option.index, 1);
  assert.deepEqual(applyVideoTailReference({ references: refs, tailAssetId: 'tail', placement: option, confirmed: true }), [refs[0], { assetId: 'tail', role: 'composition' }]);
});
test('first-frame slots after unfilled preceding slots retain their physical slot', () => {
  const options = choices(['character', 'first-frame'], []).options;
  assert.equal(options.length, 1); assert.equal(options[0].index, 0); assert.equal(options[0].slotIndex, 1);
  assert.deepEqual(applyVideoTailReference({ references: [], tailAssetId: 'tail', placement: options[0] }),
    [{ assetId: 'tail', role: 'first-frame', slotIndex: 1 }]);
});
test('ComfyUI does not append a second first-frame behind an existing first-frame use', () => {
  const options = choices(['general', 'first-frame'], [{ assetId: 'start', role: 'first-frame' }]).options;
  assert.equal(options.some((option) => option.mode === 'append'), false);
});
test('image slot capacity and unsupported role restrictions are enforced', () => {
  assert.equal(choices(['general'], refs).options[0]?.mode, 'replace-all'); assert.equal(choices([]).options.length, 0);
  assert.equal(choices(['general', 'general'], [...refs, { assetId: 'third', role: 'general' }]).options.length, 0,
    'an overfilled multi-slot workflow must not offer blind replacement of all slots');
  assert.equal(choices(['character']).options.length, 0); assert.equal(choices(['last-frame']).options.length, 0);
  assert.equal(getVideoTailReferencePlacements({ backend: 'comfyui', references: [] }).options.length, 0);
});
test('existing wrong-role bindings are not hidden by adding a tail frame', () => {
  assert.equal(choices(['scene', 'first-frame'], [{ assetId: 'wrong', role: 'character' }]).options.length, 0);
});
test('MiniMax API adds a single first-frame and preserves an existing last-frame', () => {
  const references: VideoImageReference[] = [{ assetId: 'end', role: 'last-frame' }];
  const options = getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'minimax' }, references }).options;
  const option = options.find((item) => item.mode === 'append')!; assert.equal(option.role, 'first-frame'); assert.equal(option.semantics, 'first-frame');
  assert.deepEqual(applyVideoTailReference({ references, tailAssetId: 'tail', placement: option }), [...references, { assetId: 'tail', role: 'first-frame' }]);
});
test('MiniMax existing first-frame may only be replaced, never duplicated or last-frame replaced instead', () => {
  const references: VideoImageReference[] = [{ assetId: 'start', role: 'first-frame' }, { assetId: 'end', role: 'last-frame' }];
  const options = getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'minimax' }, references }).options;
  assert.equal(options.length, 1); assert.equal(options[0].index, 0); assert.equal(options[0].mode, 'replace');
});
test('MiniMax unsupported remaining references are not dropped silently', () => {
  assert.equal(getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'minimax' }, references: refs }).options.length, 0);
});
test('generic API warns that provider/template controls actual first-frame support', () => {
  const option = getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'generic' }, references: [] }).options[0];
  assert.equal(option.role, 'first-frame'); assert.equal(option.semantics, 'reference'); assert.match(option.warning!, /接口及请求模板/u);
});
test('generic API with an existing first-frame does not append a second one', () => {
  const options = getVideoTailReferencePlacements({ backend: 'api', references: [{ assetId: 'start', role: 'first-frame' }, ...refs] }).options;
  assert.deepEqual(options.map((option) => option.index), [0]);
});

test('a first-image-only generic template offers replacement instead of an append that drops the existing picture', () => {
  const references: VideoImageReference[] = [{ assetId: 'subject', role: 'subject' }];
  const result = getVideoTailReferencePlacements({ backend: 'api', api: {
    provider: 'generic', requestTemplate: JSON.stringify({ prompt: '{{prompt}}', image_url: '{{first_image}}' }),
  }, references });
  assert.equal(result.options.length, 1);
  const selected = preferredVideoTailReferencePlacement(result.options, references)!;
  assert.equal(selected.mode, 'replace'); assert.equal(selected.index, 0); assert.equal(selected.role, 'first-frame');
  assert.equal(selected.replacedAssetId, 'subject'); assert.equal(selected.requiresConfirmation, true);
});

test('a generic multi-image template retains explicit replacement and append choices', () => {
  const references: VideoImageReference[] = [{ assetId: 'subject', role: 'character' }];
  for (const placeholder of ['{{images}}', '{{references}}']) {
    const result = getVideoTailReferencePlacements({ backend: 'api', api: {
      provider: 'generic', requestTemplate: JSON.stringify({ prompt: '{{prompt}}', images: placeholder }),
    }, references });
    assert.deepEqual(result.options.map((option) => option.mode), ['replace', 'append']);
    assert.equal(preferredVideoTailReferencePlacement(result.options, references)?.mode, 'replace',
      'the sole ordinary reference has an explicit replacement preview without requiring a delete step');
  }
});

test('last-frame references are retained by preferring append where the API accepts it', () => {
  for (const provider of ['generic', 'minimax'] as const) {
    const references: VideoImageReference[] = [{ assetId: 'end', role: 'last-frame' }];
    const { options } = getVideoTailReferencePlacements({ backend: 'api', api: { provider }, references });
    const selected = preferredVideoTailReferencePlacement(options, references)!;
    assert.equal(selected.mode, 'append'); assert.equal(selected.requiresConfirmation, false);
    assert.deepEqual(applyVideoTailReference({ references, placement: selected, tailAssetId: 'tail' }), [references[0], { assetId: 'tail', role: 'first-frame' }]);
  }
});

test('a one-image API explicitly offers replacing all storyboard selections instead of requiring manual clearing', () => {
  const references: VideoImageReference[] = [{ assetId: 'first', role: 'first-frame' }, { assetId: 'character', role: 'character' }];
  const result = getVideoTailReferencePlacements({ backend: 'api', api: {
    provider: 'generic', requestTemplate: JSON.stringify({ prompt: '{{prompt}}', first_frame: '{{first_image}}' }),
  }, references });
  assert.equal(result.options.length, 1); assert.equal(result.options[0].mode, 'replace-all');
  assert.equal(result.options[0].requiresConfirmation, true);
  assert.throws(() => applyVideoTailReference({ references, placement: result.options[0], tailAssetId: 'tail' }), /明确确认/u);
  assert.deepEqual(applyVideoTailReference({ references, placement: result.options[0], tailAssetId: 'tail', confirmed: true }), [{ assetId: 'tail', role: 'first-frame' }]);
});

test('multiple storyboard reference roles fit a single Comfy slot only after one explicit replace-all confirmation', () => {
  const references: VideoImageReference[] = [
    { assetId: 'storyboard-frame', role: 'subject' }, { assetId: 'identity', role: 'character' }, { assetId: 'place', role: 'scene' },
  ];
  for (const role of ['first-frame', 'general', 'composition', undefined] as const) {
    const before = structuredClone(references);
    const { options, reason } = choices([role], references);
    assert.equal(reason, undefined); assert.equal(options.length, 1);
    const selected = preferredVideoTailReferencePlacement(options, references)!;
    assert.equal(selected.mode, 'replace-all'); assert.deepEqual(selected.replacedReferences, references);
    assert.match(selected.label, /全部 3 张参考图替换为 1 张/u);
    assert.equal(selected.semantics, role === 'first-frame' ? 'first-frame' : 'reference');
    assert.throws(() => applyVideoTailReference({ references, placement: selected, tailAssetId: 'tail' }), /明确确认/u);
    assert.deepEqual(applyVideoTailReference({ references, placement: selected, tailAssetId: 'tail', confirmed: true }), [{ assetId: 'tail', role: role || 'general' }]);
    assert.deepEqual(references, before, 'the configured source selection is unchanged');
    assert.throws(() => applyVideoTailReference({ references: references.slice(1), placement: selected, tailAssetId: 'tail', confirmed: true }), /参考图已变化/u);
    assert.throws(() => applyVideoTailReference({ references, placement: { ...selected, replacedReferences: references.slice(1) }, tailAssetId: 'tail', confirmed: true }), /参考图已变化/u);
  }
});

test('first-and-last-frame templates and true multi-image APIs never collapse unrelated reference selections', () => {
  const references: VideoImageReference[] = [{ assetId: 'character-a', role: 'character' }, { assetId: 'character-b', role: 'character' }];
  for (const requestTemplate of [JSON.stringify({ prompt: '{{prompt}}', first: '{{first_image}}', last: '{{last_image}}' }),
    JSON.stringify({ prompt: '{{prompt}}', images: '{{images}}' })]) {
    assert.ok(!getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'generic', requestTemplate }, references }).options.some((entry) => entry.mode === 'replace-all'));
  }
});

test('invalid or text-only templates explain their actual binding problem before chain configuration', () => {
  for (const requestTemplate of ['{', JSON.stringify({ prompt: '{{prompt}}' })]) {
    const result = getVideoTailReferencePlacements({ backend: 'api', api: { provider: 'generic', requestTemplate }, references: [] });
    assert.equal(result.options.length, 0); assert.match(result.reason!, /模板/u);
  }
});

test('multiple ordinary reference slots require an explicit selection, while a unique first-frame slot is preferred', () => {
  const references: VideoImageReference[] = [{ assetId: 'subject-a', role: 'subject' }, { assetId: 'subject-b', role: 'character' }];
  const general = getVideoTailReferencePlacements({ backend: 'api', references }).options;
  assert.equal(preferredVideoTailReferencePlacement(general, references), undefined);
  const mapped = choices(['general', 'first-frame'], references).options;
  const selected = preferredVideoTailReferencePlacement(mapped, references)!;
  assert.equal(selected.index, 1); assert.equal(selected.mode, 'replace');
  assert.deepEqual(applyVideoTailReference({ references, placement: selected, tailAssetId: 'tail', confirmed: true }), [references[0], { assetId: 'tail', role: 'first-frame' }]);
});
test('changes during extraction require re-confirming the reference target', () => {
  const option = choices(['character', 'composition'], refs).options[0];
  assert.throws(() => applyVideoTailReference({ references: [...refs].reverse(), tailAssetId: 'tail', placement: option, confirmed: true }), /已变化/u);
});
test('an unsaved image or duplicate reference cannot be applied', () => {
  const option = choices(['character', 'composition'], refs).options[0];
  assert.throws(() => applyVideoTailReference({ references: refs, tailAssetId: '', placement: option, confirmed: true }), /尚未保存/u);
  assert.throws(() => applyVideoTailReference({ references: refs, tailAssetId: 'character', placement: option, confirmed: true }), /重复添加/u);
});
test('tampered slot index or mode cannot overwrite an unrelated reference', () => {
  const option = choices(['character', 'composition'], refs).options[0];
  assert.throws(() => applyVideoTailReference({ references: refs, tailAssetId: 'tail', placement: { ...option, index: -1 }, confirmed: true }), /失效/u);
  assert.throws(() => applyVideoTailReference({ references: refs, tailAssetId: 'tail', placement: { ...option, mode: 'append' }, confirmed: true }), /失效/u);
});

const autoCandidate = (index: number, language: 'zh' | 'en' = 'zh', references: VideoImageReference[] = [{ assetId: `manual-${index}`, role: 'first-frame' }]): AutomaticVideoTailCandidate => ({
  key: `board-${index}:${language}`, sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index,
  title: `第 ${index} 段`, draft: { backend: 'comfyui', workflowId: 'flow', name: `第 ${index} 段`,
    prompt: language === 'zh' ? `第 ${index} 段原始中文对白` : `Segment ${index}, keep original dialogue`,
    references, parameters: { seed: 17 }, source: { sequencePlanId: 'plan', segmentId: `segment-${index}`,
      segmentIndex: index, storyboardId: `board-${index}`, language } },
});
const automaticContext = (selected = [autoCandidate(1), autoCandidate(2), autoCandidate(3)]) => ({
  project: project({ assets: [], generationTasks: [] }), sequencePlanId: 'plan', selected,
  backend: 'comfyui' as const, workflow: workflow(['first-frame']), connectionScope: 'comfy:flow', toolsAvailable: true,
});
const automaticConfigurations = (context: ReturnType<typeof automaticContext>): Record<string, AutomaticVideoTailConfiguration> => applyAutomaticVideoTailEntries({
  current: {}, entries: buildAutomaticVideoTailEntries(context), connectionScope: context.connectionScope,
  sequenceFingerprint: videoTailSequenceFingerprint(context.project, context.sequencePlanId), confirmed: true,
});

test('automatic predecessor lookup works with zero completed videos', () => {
  const value = project({ assets: [], generationTasks: [] });
  const found = lookupPreviousSequenceSegment(value, { sequencePlanId: 'plan', segmentId: 'segment-2' });
  assert.equal(found.previousSegment?.id, 'segment-1'); assert.equal(found.reason, undefined);
  assert.equal(lookupPreviousSegmentVideos(value, { sequencePlanId: 'plan', segmentId: 'segment-2' }).reasonCode, 'no-local-video');
});

test('ambiguous current index and duplicate predecessor ids cannot configure a chain', () => {
  const targetDuplicate = project(); targetDuplicate.sequencePlans[0].segments.push({ ...segment(2), id: 'duplicate-current' });
  assert.equal(lookupPreviousSequenceSegment(targetDuplicate, { sequencePlanId: 'plan', segmentId: 'segment-2' }).reasonCode, 'invalid-target');
  const predecessorDuplicate = project(); predecessorDuplicate.sequencePlans[0].segments[0].id = 'segment-1';
  assert.equal(lookupPreviousSequenceSegment(predecessorDuplicate, { sequencePlanId: 'plan', segmentId: 'segment-2' }).reasonCode, 'missing-previous');
});

test('zero-video batch prepares 1→2→3 without adding an image or rewriting a draft', () => {
  const context = automaticContext(); const before = JSON.stringify(context);
  const configurations = automaticConfigurations(context);
  const items = context.selected.map((candidate) => ({ itemKey: candidate.key, draft: structuredClone(candidate.draft),
    previousTail: resolveAutomaticVideoTailInput({ ...context, candidate, configuration: configurations[candidate.segmentId] }) }));
  assert.equal(items.length, 3); assert.equal(items[0].previousTail, undefined);
  assert.equal(items[1].previousTail?.predecessorItemKey, 'board-1:zh'); assert.equal(items[2].previousTail?.predecessorItemKey, 'board-2:zh');
  assert.deepEqual(items[1].previousTail?.placement, { mode: 'replace', index: 0, role: 'first-frame', replacedAssetId: 'manual-2' });
  assert.deepEqual(items.map((item) => item.draft.references[0].assetId), ['manual-1', 'manual-2', 'manual-3']);
  assert.equal(JSON.stringify(context), before); assert.equal(context.project.assets.length, 0); assert.equal(context.project.generationTasks.length, 0);
});

test('replace-all configuration is reversible, language-independent, and bound to the reviewed original selection', () => {
  const original: VideoImageReference[] = [{ assetId: 'storyboard-image', role: 'subject' }, ...refs];
  const context = automaticContext([autoCandidate(1), autoCandidate(2, 'zh', original)]);
  const before = structuredClone(context.selected);
  const entries = buildAutomaticVideoTailEntries(context);
  assert.equal(entries[1].options[0].mode, 'replace-all');
  assert.throws(() => applyAutomaticVideoTailEntries({ current: {}, entries, connectionScope: context.connectionScope,
    sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan') }), /明确确认/u);
  const configuration = automaticConfigurations(context)['segment-2'];
  const input = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration })!;
  assert.equal(input.placement.mode, 'replace-all'); assert.deepEqual(input.placement.replacedReferences, original);
  context.selected[0] = autoCandidate(1, 'en');
  assert.equal(resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration })?.predecessorItemKey, 'board-1:en');
  entries[1].placementId = '';
  const cancelled = applyAutomaticVideoTailEntries({ current: { 'segment-2': configuration }, entries,
    connectionScope: context.connectionScope, sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan') });
  assert.equal(cancelled['segment-2'], undefined); assert.deepEqual(context.selected[1], before[1], 'cancelling restores the exact original selected refs without touching assets');
  assert.equal(resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration: cancelled['segment-2'] }), undefined);
  context.selected[1].draft.references = [{ assetId: 'new-selection', role: 'first-frame' }];
  assert.throws(() => resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration }), /选图或用途已变化/u);
});

test('batch chain starts from first selected index even with shuffled selection', () => {
  const context = automaticContext([autoCandidate(3), autoCandidate(2)]);
  const entries = buildAutomaticVideoTailEntries(context);
  assert.deepEqual(entries.map((entry) => entry.segmentIndex), [2, 3]); assert.equal(entries[0].keepManual, true);
  const configurations = automaticConfigurations(context);
  assert.equal(configurations['segment-2'], undefined); assert.equal(configurations['segment-3'].predecessorSegmentId, 'segment-2');
  assert.deepEqual(context.selected.map((candidate) => candidate.segmentIndex), [3, 2], 'selection order is not mutated');
});

test('selected 1 and 3 never use 1 for 3 or silently add paid segment 2', () => {
  const context = automaticContext([autoCandidate(1), autoCandidate(3)]);
  const entries = buildAutomaticVideoTailEntries(context);
  assert.equal(entries.length, 2); assert.equal(entries[1].options.length, 0); assert.match(entries[1].reason!, /第 2 段/u);
  assert.match(entries[1].reason!, /不会自动增选收费段/u); assert.deepEqual(automaticConfigurations(context), {});
  assert.equal(context.selected.length, 2);
});

test('missing segment in plan cannot be substituted by older saved video', () => {
  const context = automaticContext([autoCandidate(1), autoCandidate(3)]);
  context.project.sequencePlans[0].segments = [segment(3), segment(1)]; context.project.assets.push(video());
  const entries = buildAutomaticVideoTailEntries(context);
  assert.equal(entries[1].options.length, 0); assert.match(entries[1].reason!, /不能使用其他段/u);
});

test('predecessor language is taken at submit, not stored when configuring', () => {
  const context = automaticContext(); const configurations = automaticConfigurations(context);
  context.selected[0] = autoCandidate(1, 'en'); context.selected[1] = autoCandidate(2, 'en');
  const child = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration: configurations['segment-2'] });
  const grandchild = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[2], configuration: configurations['segment-3'] });
  assert.equal(child?.predecessorItemKey, 'board-1:en'); assert.equal(grandchild?.predecessorItemKey, 'board-2:en');
  assert.equal(context.selected.length, 3); assert.equal(configurations['segment-2'].placement.replacedAssetId, 'manual-2');
});

test('both languages of the same segment and foreign-plan choices are rejected', () => {
  assert.throws(() => buildAutomaticVideoTailEntries(automaticContext([autoCandidate(1), autoCandidate(1, 'en')])), /只能选择一份/u);
  assert.throws(() => buildAutomaticVideoTailEntries(automaticContext([{ ...autoCandidate(1), sequencePlanId: 'foreign' }, autoCandidate(2)])), /不属于当前计划/u);
});

test('automatic replacement requires explicit confirmation and does not alter other slots', () => {
  const context = automaticContext([autoCandidate(1, 'zh', refs), autoCandidate(2, 'zh', refs)]);
  context.workflow = workflow(['character', 'composition']);
  const entries = buildAutomaticVideoTailEntries(context);
  assert.equal(entries[1].options.length, 1); assert.equal(entries[1].options[0].semantics, 'reference');
  assert.throws(() => applyAutomaticVideoTailEntries({ current: {}, entries, connectionScope: context.connectionScope,
    sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan') }), /明确确认/u);
  const configurations = automaticConfigurations(context);
  const input = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration: configurations['segment-2'] });
  assert.equal(input?.placement.index, 1); assert.equal(input?.placement.role, 'composition'); assert.deepEqual(context.selected[1].draft.references, refs);
});

test('automatic append preserves character and composition reference slots', () => {
  const context = automaticContext([autoCandidate(1, 'zh', refs), autoCandidate(2, 'zh', refs)]);
  context.workflow = workflow(['character', 'composition', 'first-frame']);
  const entries = buildAutomaticVideoTailEntries(context); assert.equal(entries[1].options.find((option) => option.id === entries[1].placementId)?.mode, 'append');
  const configurations = applyAutomaticVideoTailEntries({ current: {}, entries, connectionScope: context.connectionScope,
    sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan') });
  const input = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration: configurations['segment-2'] });
  assert.equal(input?.placement.index, 2); assert.equal(input?.placement.mode, 'append'); assert.deepEqual(context.selected[1].draft.references, refs);
});

test('bulk API setup defaults a single ordinary reference to reviewed replacement, without changing the original selection', () => {
  const selected = [autoCandidate(1, 'zh', [{ assetId: 'hero', role: 'subject' }]), autoCandidate(2, 'zh', [{ assetId: 'scene', role: 'composition' }])];
  const before = JSON.stringify(selected);
  const entries = buildAutomaticVideoTailEntries({ project: project({ assets: [], generationTasks: [] }), sequencePlanId: 'plan', selected,
    backend: 'api', api: { provider: 'generic' } });
  assert.equal(entries[0].keepManual, true);
  const chosen = entries[1].options.find((option) => option.id === entries[1].placementId)!;
  assert.equal(chosen.mode, 'replace'); assert.equal(chosen.replacedAssetId, 'scene'); assert.equal(chosen.requiresConfirmation, true);
  assert.equal(JSON.stringify(selected), before);
});

test('blank bulk selections cancel old links including the new first selected row', () => {
  const context = automaticContext(); const current = automaticConfigurations(context);
  const currentBefore = JSON.stringify(current);
  const entries = buildAutomaticVideoTailEntries({ ...context, selected: [context.selected[1], context.selected[2]] });
  entries[1].placementId = '';
  const next = applyAutomaticVideoTailEntries({ current: { ...current, unselected: current['segment-3'] }, entries,
    connectionScope: context.connectionScope, sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan') });
  assert.equal(next['segment-2'], undefined); assert.equal(next['segment-3'], undefined); assert.ok(next.unselected);
  assert.equal(JSON.stringify(current), currentBefore);
});

test('unselecting exact predecessor blocks submit instead of silently dropping dependency', () => {
  const context = automaticContext(); const configuration = automaticConfigurations(context)['segment-3'];
  context.selected = [context.selected[0], context.selected[2]];
  const input = { ...context, candidate: context.selected[1], configuration };
  assert.match(automaticVideoTailIssue(input), /同时选择第 2 段/u); assert.throws(() => resolveAutomaticVideoTailInput(input), /同时选择第 2 段/u);
});

test('changing references or roles requires reconfirmation before submit', () => {
  const context = automaticContext(); const configuration = automaticConfigurations(context)['segment-2'];
  context.selected[1].draft.references = [{ assetId: 'new-image', role: 'first-frame' }];
  assert.throws(() => resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration }), /选图或用途已变化/u);
  context.selected[1].draft.references = [{ assetId: 'manual-2', role: 'general' }];
  assert.throws(() => resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration }), /选图或用途已变化/u);
});

test('changed connection, missing tools and changed sequence invalidate auto configuration', () => {
  const context = automaticContext(); const configuration = automaticConfigurations(context)['segment-2'];
  const input = { ...context, candidate: context.selected[1], configuration };
  assert.throws(() => resolveAutomaticVideoTailInput({ ...input, connectionScope: 'other' }), /连接已变化/u);
  assert.throws(() => resolveAutomaticVideoTailInput({ ...input, toolsAvailable: false }), /视频抽帧工具/u);
  context.project.sequencePlans[0].segments.find((entry) => entry.id === 'segment-1')!.storyboardId = 'replacement-board';
  assert.throws(() => resolveAutomaticVideoTailInput(input), /计划分段已变化/u);
});

test('reordering plan storage alone does not invalidate a stable exact-index relation', () => {
  const context = automaticContext(); const configuration = automaticConfigurations(context)['segment-2'];
  context.project.sequencePlans[0].segments.reverse();
  assert.equal(automaticVideoTailIssue({ ...context, candidate: context.selected[1], configuration }), '');
});

test('manually changing a placement role cannot bypass workflow slot preflight', () => {
  const context = automaticContext(); const configuration = automaticConfigurations(context)['segment-2'];
  configuration.placement.role = 'last-frame';
  assert.throws(() => resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration }), /选图或用途已变化/u);
});

test('removed auto configuration restores independent input without modifying original images', () => {
  const context = automaticContext(); const candidate = context.selected[1]; const before = JSON.stringify(candidate.draft);
  assert.equal(resolveAutomaticVideoTailInput({ ...context, candidate, configuration: undefined }), undefined);
  assert.equal(JSON.stringify(candidate.draft), before);
});

const pendingTailTask = (phase: NonNullable<NonNullable<VideoGenerationTask['videoJob']>['tailPreparation']>['phase']): VideoGenerationTask => {
  const value = task({ status: 'draft', resultAssetId: undefined }); const job = value.videoJob!;
  job.stage = 'preparing'; job.batchQueueState = 'ready'; job.preparation = { version: 1, phase: 'preparing', uploadedImages: [] };
  job.tailPreparation = { phase, revision: 1, message: `尾帧状态：${phase}` };
  job.snapshot.previousTail = { version: 1, predecessorTaskId: 'previous-task', predecessorItemKey: 'board-1:zh',
    predecessorRequestFingerprint: 'original', sequencePlanId: 'plan', predecessorSegmentId: 'segment-1', predecessorSegmentIndex: 1,
    segmentId: 'segment-2', segmentIndex: 2, referenceIndex: 0, referenceRole: 'first-frame', reservedFrameAssetId: 'reserved' };
  return value;
};

test('waiting and extracting task cards explicitly allow cancelling the unsubmitted task', () => {
  for (const phase of ['waiting', 'extracting'] as const) {
    const result = videoTailTaskPresentation(pendingTailTask(phase));
    assert.equal(result.canCancel, true); assert.equal(result.canRetry, false); assert.equal(result.message, `尾帧状态：${phase}`);
    assert.match(result.statusLabel!, phase === 'waiting' ? /等待上一段/u : /正在抽取/u);
  }
});

test('blocked task card can retry existing preparation even without trackingStopped', () => {
  const value = pendingTailTask('blocked'); assert.equal(value.videoJob?.trackingStopped, undefined);
  const result = videoTailTaskPresentation(value);
  assert.equal(result.canRetry, true); assert.equal(result.canCancel, true); assert.equal(result.statusLabel, '尾帧衔接待处理');
});

test('cancelled or already submitted dependencies never expose local tail retry', () => {
  const cancelled = pendingTailTask('cancelled');
  const stopping = pendingTailTask('blocked'); stopping.videoJob!.cancellationPending = true;
  const queuedCancelled = pendingTailTask('blocked'); queuedCancelled.videoJob!.batchQueueState = 'cancelled';
  const submitted = pendingTailTask('blocked'); submitted.remoteTaskId = 'remote-existing';
  const uncertain = pendingTailTask('blocked'); uncertain.videoJob!.preparation!.phase = 'post-started';
  for (const value of [cancelled, stopping, queuedCancelled, submitted, uncertain]) {
    assert.equal(videoTailTaskPresentation(value).canRetry, false); assert.equal(videoTailTaskPresentation(value).canCancel, false);
  }
});

test('one-click uses an explicit first-frame slot and preserves other references', () => {
  const context = automaticContext([autoCandidate(1, 'zh', refs), autoCandidate(2, 'zh', refs)]);
  context.workflow = workflow(['character', 'composition', 'first-frame']);
  const entries = buildOneClickVideoTailEntries(context);
  const config = applyAutomaticVideoTailEntries({ current: {}, entries, connectionScope: context.connectionScope,
    sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan'), confirmed: true });
  const tail = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration: config['segment-2'] })!;
  assert.equal(tail.placement.mode, 'append'); assert.equal(tail.placement.index, 2);
  assert.equal(tail.selectionMode, undefined); assert.equal(tail.requireAiSelection, undefined);
  assert.ok(entries.every((entry) => entry.selectionMode === undefined && entry.requireAiSelection === undefined));
  const replacedLegacySetting = applyAutomaticVideoTailEntries({ current: { 'segment-2': { ...config['segment-2'], selectionMode: 'ai-assisted', requireAiSelection: true } },
    entries, connectionScope: context.connectionScope, sequenceFingerprint: videoTailSequenceFingerprint(context.project, 'plan'), confirmed: true });
  assert.equal(replacedLegacySetting['segment-2'].selectionMode, undefined);
  assert.equal(replacedLegacySetting['segment-2'].requireAiSelection, undefined, 'an explicit new local setup cannot inherit an old visual-AI requirement');
  assert.deepEqual(context.selected[1].draft.references, refs);
});
test('one-click prefers an available append instead of dropping identity references on generic APIs', () => {
  const references = [{ assetId: 'hero', role: 'character' as const }, { assetId: 'scene', role: 'scene' as const }];
  const options = getVideoTailReferencePlacements({ backend: 'api', references }).options;
  const placement = oneClickVideoTailReferencePlacement(options, references)!;
  assert.equal(placement.mode, 'append');
  assert.deepEqual(applyVideoTailReference({ references, placement, tailAssetId: 'tail', confirmed: true }).slice(0, 2), references);
});
test('one-click can replace only the supported ordinary slot when all slots are occupied', () => {
  const options = choices(['character', 'composition'], refs).options;
  assert.equal(oneClickVideoTailReferencePlacement(options, refs)?.index, 1);
  assert.equal(oneClickVideoTailReferencePlacement([], refs), undefined);
});
test('a vacant first slot accepts the tail without moving later identities or changing dense dependency indices', () => {
  const references: VideoImageReference[] = [
    { assetId: 'hero', role: 'character', slotIndex: 1 }, { assetId: 'mentor', role: 'character', slotIndex: 3 },
  ];
  const options = choices(['first-frame', 'character', 'character', 'character'], references).options;
  assert.equal(options.length, 1);
  const option = options[0];
  assert.equal(option.mode, 'append'); assert.equal(option.index, 2); assert.equal(option.slotIndex, 0);
  const result = applyVideoTailReference({ references, tailAssetId: 'tail', placement: option });
  assert.deepEqual(result, [...references, { assetId: 'tail', role: 'first-frame', slotIndex: 0 }]);
  assert.throws(() => applyVideoTailReference({ references, tailAssetId: 'tail', placement: { ...option, slotIndex: 1 } }), /重复绑定/u);
});

test('replacement and asynchronous fingerprints preserve a physical slot independently of array position', () => {
  const references: VideoImageReference[] = [
    { assetId: 'hero', role: 'character', slotIndex: 1 }, { assetId: 'scene', role: 'composition', slotIndex: 3 },
  ];
  const option = choices(['character', 'character', 'character', 'composition'], references).options[0];
  assert.equal(option.index, 1); assert.equal(option.slotIndex, 3);
  assert.deepEqual(applyVideoTailReference({ references, tailAssetId: 'tail', placement: option, confirmed: true }),
    [references[0], { assetId: 'tail', role: 'composition', slotIndex: 3 }]);
  assert.throws(() => applyVideoTailReference({ references: [references[0], { ...references[1], slotIndex: 2 }],
    tailAssetId: 'tail', placement: option, confirmed: true }), /已变化/u);
  assert.equal(choices(['first-frame', 'character'], references).options.length, 0);
});

test('automatic first-slot vacancy keeps slotIndex separate from the dense placement index', () => {
  const references: VideoImageReference[] = [{ assetId: 'character', role: 'character', slotIndex: 1 }];
  const context = { ...automaticContext([autoCandidate(1), autoCandidate(2, 'zh', references)]), workflow: workflow(['first-frame', 'character']) };
  const entries = buildOneClickVideoTailEntries(context);
  const configuration = applyAutomaticVideoTailEntries({ current: {}, entries, connectionScope: context.connectionScope,
    sequenceFingerprint: videoTailSequenceFingerprint(context.project, context.sequencePlanId), confirmed: true })['segment-2'];
  const input = resolveAutomaticVideoTailInput({ ...context, candidate: context.selected[1], configuration });
  assert.equal(input?.placement.index, 1); assert.equal(input?.placement.slotIndex, 0);
  assert.equal(input?.predecessorItemKey, context.selected[0].key);
});

console.log(`videoTailReference: ${count} regression checks passed`);
