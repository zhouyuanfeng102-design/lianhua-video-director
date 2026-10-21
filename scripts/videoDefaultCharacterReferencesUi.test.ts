import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { emptyVideoDraft, type VideoDirectorBatchDraft } from '../src/videoDirectorDraft';
import { buildOfficialH3SourceFingerprint } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { getVideoApiImageCapacity } from '../src/videoImageCapacity';
import { stampCharacterParticipation } from '../src/characterParticipation';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import type { VideoPromptFormat } from '../src/videoGenerationTypes';
import type { Character, Project, ReferenceAsset, Storyboard, VideoSequencePlan } from '../src/types';

type Props = Record<string, any>;
type Element = React.ReactElement<Props>;
interface Slot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
const nodesOf = (value: React.ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodesOf)
  : React.isValidElement<Props>(value) ? [value, ...nodesOf(value.props.children)] : [];
const textOf = (value: React.ReactNode): string => value == null || typeof value === 'boolean' ? ''
  : Array.isArray(value) ? value.map(textOf).join('') : React.isValidElement<Props>(value) ? textOf(value.props.children) : String(value);
const component = (tree: React.ReactNode, name: string): Element => {
  const node = nodesOf(tree).find((entry) => typeof entry.type === 'function' && entry.type.name === name);
  assert.ok(node, `missing real component ${name}`); return node;
};
const button = (tree: React.ReactNode, label: string): Element => {
  const node = nodesOf(tree).find((entry) => entry.type === 'button' && (entry.props['aria-label'] === label || textOf(entry) === label));
  assert.ok(node, `missing button ${label}`); assert.ok(!node.props.disabled, `${label} must be enabled`); return node;
};
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/VideoDirectorView.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

/** Run the production batch/picker callbacks with isolated React hook state.
 * The capability-reader and compression leaf controls are outside this test;
 * drafts, rows, defaults, slot selection and identity binding remain real. */
function harness(name: 'Batch' | 'Picker', props: Props) {
  let cursor = 0, dirty = true, tree: React.ReactNode;
  let effects: Array<() => void> = [];
  const slots: Slot[] = [];
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next: any) => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; } }];
    },
    useRef(value: unknown) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo(run: () => unknown, deps?: readonly unknown[]) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: run(), deps }; return slots[index].value; },
    useEffect(run: () => (() => void) | void, deps?: readonly unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        const previous = slots[index]; slots[index] = { ...previous, deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = run() || undefined; });
      }
    },
  };
  const productionRequire = createRequire(new URL('../src/components/VideoDirectorView.tsx', import.meta.url));
  const leaves = new Map<string, (props: Props) => null>();
  const leafExports = new Proxy({}, { get(_target, key) {
    if (key === '__esModule') return true;
    const value = String(key);
    if (!leaves.has(value)) leaves.set(value, Object.defineProperty(() => null, 'name', { value }));
    return leaves.get(value);
  } });
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', 'React', `${compiled}\nObject.assign(module.exports, { Batch: VideoBatchPanel, Picker: VideoBatchImagePicker });`)((specifier: string) => {
    if (specifier === 'react') return { ...React, ...hooks };
    if (specifier.endsWith('.css')) return {};
    if (specifier === './VideoReferenceCompression') return { useVideoReferenceCompression: () => ({
      busy: false, summary: null, review: undefined, displayAsset: (asset: ReferenceAsset) => asset, cardControls: () => null,
    }) };
    if (specifier.startsWith('./')) return leafExports;
    return productionRequire(specifier);
  }, module, module.exports, React);
  const render = () => {
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20, `${name} hooks settle`); cursor = 0; dirty = false;
      tree = module.exports[name](props);
      const queue = effects; effects = []; queue.forEach((effect) => effect());
    } while (dirty);
    return tree;
  };
  return { render, dispose: () => slots.forEach((slot) => slot.cleanup?.()) };
}

function fixture(format: VideoPromptFormat) {
  const state = createInitialState();
  const makeCharacter = (id: string, name: string): Character => ({ id, name, gender: '', apparentAge: '成年', race: '人类', appearance: '', outfit: '',
    signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [`image-${id}`] });
  const current = [makeCharacter('a', '青岚'), makeCharacter('b', '明川'), makeCharacter('c', '白露'), makeCharacter('d', '玄霜')];
  const other = makeCharacter('other', '秦墨');
  const characters = [...current, other];
  const assets: ReferenceAsset[] = characters.map((character) => ({ id: character.assetIds[0], name: `${character.name}人物图`, type: 'character',
    role: 'character', referenceRole: 'character', characterReferenceId: character.id, sourceEntityId: character.id, sourceEntityKind: 'character',
    mediaType: 'image', mimeType: 'image/png', source: 'upload', url: `https://fixture.invalid/${character.id}.png`, tags: [], createdAt: 1, updatedAt: 1 }));
  const project = { ...state.project, id: 'default-reference-ui-project', characters, assets, generationTasks: [], sourceDocuments: [],
    scenes: [], storyboards: [], sequencePlans: [] } as Project;
  const boards: Storyboard[] = [1, 2].map((index) => {
    const cast = index === 2 ? current : [other];
    const anchors = cast.map((character, offset) => `Identity: ${character.name} (S${offset + 1}), adult warrior in opaque armor.`);
    const ordinary = `${cast.map((character) => character.name).join('、')}在石桥上保持各自站位，彼此相隔三米；摄影机平视中景。`;
    const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchors.join(' ')} ${ordinary}\noverall_soundscape: 微风。\nnon_diegetic_music: N/A`;
    return { id: `board-${index}`, sceneId: `scene-${index}`, sourceStoryTitle: `第${index}段`, sourceStoryContent: ordinary,
      workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '15s', shotMode: 'auto', pace: 'standard',
      aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
      globalReferenceAssetIds: [], shots: [], finalPrompt: ordinary, officialPromptZh: prompt, targetModelId: 'minimax-h3',
      targetOutput: { targetId: 'minimax-h3', prompt, parameters: {}, referenceManifest: [], warnings: [], generatedAt: 1 },
      h3IdentityBindings: { version: 1, characters: cast.map((character, offset) => ({ characterId: character.id, name: character.name,
        speakerToken: `(S${offset + 1})`, referenceAnchor: anchors[offset] })) },
      h3CharacterParticipation: stampCharacterParticipation(prompt, { version: 1, characters: cast.map((character) => ({
        characterId: character.id, name: character.name, presence: 'visible', shotIndex: 1, evidence: ordinary,
      })) }),
      sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index, segmentCount: 2, createdAt: 1, updatedAt: index,
    } as Storyboard;
  });
  project.scenes = boards.map((board, index) => ({ id: board.sceneId, title: board.sourceStoryTitle || '', content: board.sourceStoryContent || '',
    summary: '', characterIds: index === 1 ? current.map((character) => character.id) : [other.id], locationIds: [], propIds: [], storyboardIds: [board.id], createdAt: 1, updatedAt: 1 }));
  const plan: VideoSequencePlan = { id: 'plan', title: '两段独立人物', sourceStoryTitle: '完整故事', sourceStoryContent: boards.map((board) => board.sourceStoryContent).join('\n'),
    durationMode: 'ai-estimated', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', createdAt: 1, updatedAt: 1,
    segments: boards.map((board, index) => ({ id: board.segmentId!, index: index + 1, title: board.sourceStoryTitle || '', globalStartSec: index * 10,
      globalEndSec: (index + 1) * 10, durationSec: 10, content: board.sourceStoryContent || '', summary: '', sourceSceneIds: [board.sceneId], sourceBeatIds: [],
      narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready' })) };
  project.storyboards = boards; project.sequencePlans = [plan];
  boards.forEach((board) => { board.officialPromptSource = buildOfficialH3SourceFingerprint(board, officialH3ContextForStoryboard(project, board)); });
  if (format === 'seedance') {
    boards.forEach((board, index) => {
      const cast = index === 1 ? current : [other];
      const prompt = [
        '视频规格：时长10秒，画幅16:9，分辨率720p，立体声。',
        '参考素材与职责：本段未提供图片参考。',
        `主体连续性：${cast.map((character) => `${character.name}为成年人物，身穿灰色外套`).join('。')}。`,
        `一句话概述：${cast.map((character) => character.name).join('、')}在石桥上会面。`,
        `连续时间轴：0至10秒，${cast.map((character) => `${character.name}站在石桥上`).join('；')}。`,
        '全局约束：保留人物和站位，无对白。',
      ].join('\n');
      board.seedance25Output = { targetId: 'seedance-2.5', promptZh: prompt, durationSec: 10,
        referenceManifest: [], sourceFingerprint: '', warnings: [], generatedAt: 1 };
    });
    // Pictures were generated after the text; its saved manifest is still empty.
    for (const role of ['first-frame', 'last-frame'] as const) {
      const asset: ReferenceAsset = { id: role, name: role, type: role, role, referenceRole: role,
        mediaType: 'image', mimeType: 'image/png', source: 'generated', sourceStoryboardId: boards[1].id,
        imageVariant: role, url: `https://fixture.invalid/${role}.png`, tags: [], createdAt: 2, updatedAt: 2 };
      project.assets.push(asset);
      if (role === 'first-frame') boards[1].firstFrameAssetId = asset.id;
      else boards[1].lastFrameAssetId = asset.id;
    }
    project.locations = [{ id: 'bridge-location', name: '石桥', description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: ['bridge-image'] },
      { id: 'other-location', name: '别段场景', description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: ['other-scene-image'] }];
    project.assets.push(...project.locations.map((location): ReferenceAsset => ({ id: location.assetIds[0], name: location.name,
      type: 'location', role: 'scene', referenceRole: 'scene', sourceEntityKind: 'location', sourceEntityId: location.id,
      mediaType: 'image', url: `https://fixture.invalid/${location.id}.png`, tags: [], createdAt: 2, updatedAt: 2 })));
    boards[1].sceneStaging = [{ version: 1, sceneId: 'bridge-location' }];
    boards.forEach((board) => { board.seedance25Output!.sourceFingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board)); });
  }
  const settings = { ...state.settings, videoBackend: 'api' as const, videoSource: 'api' as const, activeVideoApiProfileId: null, videoApiProfiles: [],
    videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic' as const, model: 'capacity-not-read', apiKey: '',
      baseUrl: 'https://fixture.invalid', endpoint: '/generate', requestTemplate: '', parameterCapabilities: undefined } };
  assert.equal(getVideoApiImageCapacity(settings.videoTaskApi), undefined, 'the fixture has no advertised image count limit');
  return { project, settings, current, other, format };
}

const originalFetch = globalThis.fetch;
let apiCalls = 0, taskStarts = 0;
globalThis.fetch = async () => { apiCalls += 1; throw new Error('Default reference selection must not call text, vision, image or video APIs'); };
const cleanups: Array<() => void> = [];
try {
 for (const format of ['h3', 'seedance'] as const) {
  const value = fixture(format), originalProject = structuredClone(value.project);
  const snapshots: VideoDirectorBatchDraft[] = [];
  const controller = { start: async () => { taskStarts += 1; throw new Error('No task may be started'); },
    startBatch: async () => { taskStarts += 1; throw new Error('No batch may be started'); } };
  const props = { project: value.project, settings: value.settings, controller, initialDraft: emptyVideoDraft(value.settings),
    initialParameterText: '{}', onSubmittingChange: () => {}, onBatchDraftChange: (draft: VideoDirectorBatchDraft) => snapshots.push(structuredClone(draft)) };
  const batch = harness('Batch', props); cleanups.push(batch.dispose);
  if (format === 'seedance') {
    const selector = nodesOf(batch.render()).find((entry) => entry.type === 'select' && entry.props['aria-label'] === '批量提示词格式');
    assert.ok(selector, 'real batch format selector is present');
    selector.props.onChange({ target: { value: format } }); batch.render();
  }
  assert.deepEqual(snapshots.at(-1)?.referenceOverrides || {}, {}, 'untouched rows have no manual selection override');
  const openPicker = (parent = batch, segmentIndex = 2) => {
    button(parent.render(), `第 ${segmentIndex} 段选择参考图`).props.onClick();
    const picker = component(parent.render(), 'VideoBatchImagePicker');
    const ui = harness('Picker', picker.props); cleanups.push(ui.dispose);
    return ui;
  };
  const pictureNodes = (ui: ReturnType<typeof harness>) => nodesOf(component(ui.render(), 'VideoReferencePickerPanels').props.images)
    .filter((entry) => entry.type === 'button' && entry.props.className === 'vd-image-pick');
  const selectedIds = (ui: ReturnType<typeof harness>) => pictureNodes(ui).filter((entry) => entry.props['aria-pressed'])
    .map((entry) => value.project.assets.find((asset) => entry.props['aria-label'] === `取消选择图片 ${asset.name}`)!.id);
  const characterChips = (ui: ReturnType<typeof harness>) => {
    const dialog = component(ui.render(), 'VideoPickerDialog');
    const hint = dialog.props.headerContent as Element;
    return nodesOf((hint.type as (props: Props) => React.ReactNode)(hint.props)).filter((entry) => entry.props['data-character-id']);
  };
  const apply = async (ui: ReturnType<typeof harness>, parent = batch) => { await button(ui.render(), '使用本段图片').props.onClick(); parent.render(); };
  const imageIds = value.current.map((character) => character.assetIds[0]);
  const expectedIds = format === 'seedance' ? [...imageIds, 'first-frame', 'last-frame', 'bridge-image'] : imageIds;
  const firstCharacterSlot = format === 'seedance' ? 4 : 1;

  let picker = openPicker();
  assert.deepEqual(selectedIds(picker), expectedIds, `${format}: opening segment 2 preselects its identities and explicit later frames`);
  assert.deepEqual(characterChips(picker).map((chip) => [chip.props['data-character-id'], chip.props['data-reference-status']]),
    value.current.map((character) => [character.id, 'bound']), 'each visible segment character is associated with its own selected image');
  characterChips(picker).forEach((chip, index) => assert.match(textOf(chip), new RegExp(`已选.*已关联图片 ${index + firstCharacterSlot}`, 'u')));
  assert.equal(pictureNodes(picker).find((entry) => entry.props['aria-label'] === `选择图片 ${value.other.name}人物图`)?.props['aria-pressed'], false,
    'another segment character remains available for manual selection but never enters defaults');
  assert.equal(pictureNodes(picker).filter((entry) => entry.props['aria-pressed']).every((entry) => nodesOf(entry).some((child) => child.type === 'img')), true,
    'selected reference cards render their matching character thumbnails');
  await apply(picker);
  const applied = snapshots.at(-1)?.referenceOverrides['segment-2'];
  assert.deepEqual(applied?.map((reference) => reference.assetId), format === 'seedance' ? ['first-frame', 'last-frame', 'bridge-image', ...imageIds] : imageIds);
  if (format === 'seedance') assert.deepEqual(applied?.slice(0, 2).map((reference) => reference.role), ['first-frame', 'last-frame']);

  picker = openPicker();
  assert.deepEqual(selectedIds(picker), expectedIds, 'confirming and reopening retains selected references');
  button(component(picker.render(), 'VideoReferencePickerPanels').props.images, '取消选择图片 白露人物图').props.onClick();
  const remaining = expectedIds.filter((id) => id !== 'image-c');
  assert.deepEqual(selectedIds(picker), remaining);
  assert.equal(characterChips(picker).find((chip) => chip.props['data-character-id'] === 'c')?.props['data-reference-status'], 'unselected');
  await apply(picker);
  picker = openPicker();
  assert.deepEqual(selectedIds(picker), remaining, 'a manually deselected character is not automatically inserted again');

  for (const entry of pictureNodes(picker).filter((image) => image.props['aria-pressed'])) entry.props.onClick();
  assert.deepEqual(selectedIds(picker), []);
  await apply(picker);
  assert.deepEqual(snapshots.at(-1)?.referenceOverrides['segment-2'], [], 'manual clearing saves an explicit empty override');
  picker = openPicker();
  assert.deepEqual(selectedIds(picker), [], 'reopening an explicitly cleared segment keeps zero references');
  assert.ok(characterChips(picker).every((chip) => chip.props['data-reference-status'] === 'unselected'));
  const savedBatch = structuredClone(snapshots.at(-1)!);
  const restored = harness('Batch', { ...props, savedBatch }); cleanups.push(restored.dispose);
  const restoredPicker = openPicker(restored);
  assert.deepEqual(selectedIds(restoredPicker), [], 'restoring the saved batch preserves the explicit empty selection');
  component(restoredPicker.render(), 'VideoPickerDialog').props.onClose(); restored.render();
  assert.deepEqual(selectedIds(openPicker(restored, 1)), [value.other.assetIds[0]], 'clearing segment 2 does not remove another segment defaults');
  assert.equal(apiCalls, 0); assert.equal(taskStarts, 0); assert.deepEqual(value.project.generationTasks, []);
  assert.deepEqual(value.project, originalProject, 'opening, selecting, clearing and confirming never change project assets, source H3 or segment records');
  console.log(`PASS ${format} default video references: identities${format === 'seedance' ? ' and later frames despite empty manifest' : ''}, per-segment binding, manual removals and persistent empty overrides; no API/task/source changes.`);
 }
} finally {
  cleanups.reverse().forEach((dispose) => dispose());
  globalThis.fetch = originalFetch;
}
