import assert from 'node:assert/strict';
import { bindComfyVideoWorkflow, freezeComfyVideoWorkflow, importComfyVideoWorkflow, type ComfyVideoNodeMap } from '../src/comfyuiVideo';
import { resolveComfyH3PictureNumbers } from '../src/h3ReferenceImageOrder';
import type { ComfyVideoWorkflowPreset, VideoImageReference } from '../src/videoGenerationTypes';

let groups = 0;
const check = (name: string, run: () => void) => {
  run(); groups += 1; console.log(`PASS ${name}`);
};

// Synthetic graph: physical H3 order deliberately differs from numeric node
// enumeration. No customer prompts, local filenames, credentials or services.
const imageIds = ['90', '10', '70', '30', '50', '20'];
const fixture = (): ComfyVideoNodeMap => ({
  ...Object.fromEntries(imageIds.map((id, index) => [id, {
    class_type: 'LoadImage', inputs: { image: index < 3 ? `fixture-default-${index}.png` : 'None' },
  }])),
  text: { class_type: 'Text', inputs: { text: 'synthetic original prompt' } },
  h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
    prompt: ['text', 0],
    'ref_images.ref_image_0': ['90', 0],
    'ref_images.ref_image_1': ['10', 0],
    'ref_images.ref_image_2': ['70', 0],
    'ref_images.ref_image_3': ['30', 0],
    'ref_images.ref_image_4': ['50', 0],
    'ref_images.ref_image_5': ['20', 0],
    length: 243,
  } },
  sample: { class_type: 'SelfLiftH3Sampler', inputs: { positive: ['h3', 0], latent_image: ['h3', 1], seed: 123 } },
  out: { class_type: 'VHS_VideoCombine', inputs: { images: ['sample', 0], frame_rate: 24, format: 'video/h264-mp4' } },
});
const preset = (graph = fixture()): ComfyVideoWorkflowPreset => ({
  id: 'synthetic-optional-h3-images', name: 'Synthetic H3 optional references', createdAt: 1, updatedAt: 1,
  ...importComfyVideoWorkflow(JSON.stringify(graph)),
});
const refs = (slots: number[]): VideoImageReference[] => slots.map((slotIndex) => ({
  assetId: `fixture-selected-${slotIndex}`, role: 'general', slotIndex,
}));
const sentInputs = (graph: ComfyVideoNodeMap, consumer = 'h3'): Array<[string, unknown]> =>
  Object.entries(graph[consumer].inputs).flatMap(([name, value]): Array<[string, unknown]> => {
    if (/^ref_images\.ref_image_\d+$/u.test(name)) return [[name, value]];
    if (name === 'ref_images' && value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([field, image]) => [`ref_images.${field}`, image]);
    }
    return [];
  });

check('two selected images omit four unused inputs and their exclusive loaders', () => {
  const original = preset();
  assert.deepEqual(original.mapping.images.map((binding) => binding.nodeId), imageIds);
  const bound = bindComfyVideoWorkflow(original, 'synthetic new prompt', ['chosen-0.png', 'chosen-1.png']);
  assert.deepEqual(sentInputs(bound), [
    ['ref_images.ref_image_0', ['90', 0]],
    ['ref_images.ref_image_1', ['10', 0]],
  ]);
  assert.equal(bound['90'].inputs.image, 'chosen-0.png');
  assert.equal(bound['10'].inputs.image, 'chosen-1.png');
  for (const id of imageIds.slice(2)) assert.equal(id in bound, false, `unused loader ${id} must not reach ComfyUI`);
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [0, 1]), [1, 2]);
  assert.equal(bound.text.inputs.text, 'synthetic new prompt');
  assert.equal(bound.h3.inputs.length, 243);
  assert.equal(bound.sample.inputs.seed, 123);
});

check('full selection retains every physical slot without duplicating uploads', () => {
  const original = preset();
  const uploaded = imageIds.map((_, index) => `chosen-${index}.png`);
  const bound = bindComfyVideoWorkflow(original, 'synthetic full prompt', uploaded);
  assert.equal(sentInputs(bound).length, 6);
  imageIds.forEach((id, index) => assert.equal(bound[id].inputs.image, uploaded[index]));
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [0, 1, 2, 3, 4, 5]), [1, 2, 3, 4, 5, 6]);
});

check('zero selected reference images leave no mapped default image branches', () => {
  const original = preset();
  const bound = bindComfyVideoWorkflow(original, 'synthetic text-only prompt', []);
  assert.deepEqual(sentInputs(bound), []);
  imageIds.forEach((id) => assert.equal(id in bound, false));
  assert.deepEqual(resolveComfyH3PictureNumbers(original, []), []);
  assert.ok(bound.h3 && bound.sample && bound.out);
});

check('sparse selection keeps physical upload destinations and compresses Picture numbers in consumer order', () => {
  const original = preset();
  // Upload journals can be dense in a different order from the physical
  // selected slots. The fifth slot still receives the first uploaded file.
  const selected = [4, 1];
  const bound = bindComfyVideoWorkflow(original, 'synthetic sparse prompt',
    ['chosen-slot-4.png', 'chosen-slot-1.png'], {}, refs(selected));
  assert.equal(bound['50'].inputs.image, 'chosen-slot-4.png');
  assert.equal(bound['10'].inputs.image, 'chosen-slot-1.png');
  assert.deepEqual(sentInputs(bound), [
    ['ref_images.ref_image_1', ['10', 0]],
    ['ref_images.ref_image_4', ['50', 0]],
  ]);
  assert.deepEqual(resolveComfyH3PictureNumbers(original, selected), [2, 1],
    'the upload order must not redefine the model consumer order');
  for (const id of ['90', '70', '30', '20']) assert.equal(id in bound, false);
});

check('nested optional reference inputs follow the same selection and numbering rules', () => {
  const graph = fixture();
  const nested: Record<string, unknown> = {};
  for (const [name, value] of sentInputs(graph)) {
    nested[name.slice('ref_images.'.length)] = value;
    delete graph.h3.inputs[name];
  }
  graph.h3.inputs.ref_images = nested;
  // Keep an explicit legacy mapping: importer ancestry is independent of this
  // request-local nested-input behavior.
  const original = { workflowJson: JSON.stringify(graph), mapping: {
    prompt: [{ nodeId: 'text', inputName: 'text' }],
    images: imageIds.map((nodeId) => ({ nodeId, inputName: 'image' })),
    outputNodeId: 'out',
  } };
  const bound = bindComfyVideoWorkflow(original, 'synthetic nested prompt', ['chosen-slot-3.png'], {}, refs([3]));
  assert.deepEqual(sentInputs(bound), [['ref_images.ref_image_3', ['30', 0]]]);
  assert.equal(bound['30'].inputs.image, 'chosen-slot-3.png');
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [3]), [1]);
  for (const id of imageIds.filter((id) => id !== '30')) assert.equal(id in bound, false);
});

check('unused known image transform branches are removed while selected transforms are preserved', () => {
  const graph = fixture();
  graph.scale0 = { class_type: 'ImageScale', inputs: { image: ['90', 0], width: 512, height: 512, upscale_method: 'nearest-exact', crop: 'disabled' } };
  graph.scale1 = { class_type: 'ImageScaleBy', inputs: { image: ['10', 0], upscale_method: 'nearest-exact', scale_by: 1 } };
  graph.h3.inputs['ref_images.ref_image_0'] = ['scale0', 0];
  graph.h3.inputs['ref_images.ref_image_1'] = ['scale1', 0];
  const original = preset(graph);
  const bound = bindComfyVideoWorkflow(original, 'synthetic scaled prompt', ['chosen-slot-1.png'], {}, refs([1]));
  assert.equal('90' in bound, false);
  assert.equal('scale0' in bound, false);
  assert.ok(bound['10'] && bound.scale1);
  assert.deepEqual(bound.scale1.inputs, graph.scale1.inputs);
  assert.deepEqual(sentInputs(bound), [['ref_images.ref_image_1', ['scale1', 0]]]);
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [1]), [1]);
});

check('unmapped fixed reference material remains present and retains its Picture position', () => {
  const original = preset();
  original.mapping.images = original.mapping.images.filter((binding) => binding.nodeId !== '90');
  const bound = bindComfyVideoWorkflow(original, 'synthetic fixed-reference prompt', ['chosen-former-slot-1.png']);
  assert.deepEqual(sentInputs(bound), [
    ['ref_images.ref_image_0', ['90', 0]],
    ['ref_images.ref_image_1', ['10', 0]],
  ]);
  assert.equal(bound['90'].inputs.image, 'fixture-default-0.png');
  assert.equal(bound['10'].inputs.image, 'chosen-former-slot-1.png');
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [0]), [2]);
});

check('unknown image-producing transforms remain intact instead of guessing a removable source', () => {
  const graph = fixture();
  graph.unknown = { class_type: 'UnknownImageSwitch', inputs: { image: ['90', 0], enabled: true } };
  graph.h3.inputs['ref_images.ref_image_0'] = ['unknown', 0];
  const original = preset(graph);
  const slot = original.mapping.images.findIndex((binding) => binding.nodeId === '10');
  const bound = bindComfyVideoWorkflow(original, 'synthetic opaque prompt', ['chosen-second.png'], {}, refs([slot]));
  assert.deepEqual(bound.unknown, graph.unknown);
  assert.deepEqual(bound['90'], graph['90']);
  assert.deepEqual(bound.h3.inputs['ref_images.ref_image_0'], ['unknown', 0]);
  assert.equal(resolveComfyH3PictureNumbers(original, [slot]), undefined);
});

check('a loader shared by a separate image output survives removal from H3 references', () => {
  const graph = fixture();
  graph.saveStill = { class_type: 'SaveImage', inputs: { images: ['90', 0], filename_prefix: 'fixture-still' } };
  const original = preset(graph);
  const bound = bindComfyVideoWorkflow(original, 'synthetic shared-output prompt', ['chosen-slot-1.png'], {}, refs([1]));
  assert.equal('ref_images.ref_image_0' in bound.h3.inputs, false);
  assert.deepEqual(bound['90'], graph['90']);
  assert.deepEqual(bound.saveStill, graph.saveStill);
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [1]), [1],
    'an image used by another output no longer occupies the H3 reference list');
});

check('an unused reference loader still needed through its MASK output is preserved', () => {
  const graph = fixture();
  graph.maskImage = { class_type: 'MaskToImage', inputs: { mask: ['90', 1] } };
  graph.saveMask = { class_type: 'SaveImage', inputs: { images: ['maskImage', 0], filename_prefix: 'fixture-mask' } };
  const original = preset(graph);
  const bound = bindComfyVideoWorkflow(original, 'synthetic shared-mask prompt', ['chosen-slot-1.png'], {}, refs([1]));
  assert.equal('ref_images.ref_image_0' in bound.h3.inputs, false);
  for (const id of ['90', 'maskImage', 'saveMask']) assert.deepEqual(bound[id], graph[id]);
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [1]), [1]);
});

check('ImageToVideo first and last frames keep their existing default and numbering behavior', () => {
  const graph: ComfyVideoNodeMap = {
    first: { class_type: 'LoadImage', inputs: { image: 'fixture-first.png' } },
    last: { class_type: 'LoadImage', inputs: { image: 'fixture-last.png' } },
    text: { class_type: 'Text', inputs: { text: 'synthetic I2V prompt' } },
    h3: { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: ['text', 0], first_frame: ['first', 0], last_frame: ['last', 0], length: 243 } },
    out: { class_type: 'VHS_VideoCombine', inputs: { images: ['h3', 0], frame_rate: 24, format: 'video/h264-mp4' } },
  };
  const original = { workflowJson: JSON.stringify(graph), mapping: {
    prompt: [{ nodeId: 'text', inputName: 'text' }],
    images: [{ nodeId: 'first', inputName: 'image' }, { nodeId: 'last', inputName: 'image' }],
    outputNodeId: 'out',
  } };
  const bound = bindComfyVideoWorkflow(original, 'synthetic new I2V prompt', ['chosen-last.png'], {}, refs([1]));
  assert.deepEqual(bound.h3.inputs.first_frame, ['first', 0]);
  assert.deepEqual(bound.h3.inputs.last_frame, ['last', 0]);
  assert.equal(bound.first.inputs.image, 'fixture-first.png');
  assert.equal(bound.last.inputs.image, 'chosen-last.png');
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [1]), [2]);
});

check('scalar DynamicCombo selectors retain all reference inputs and original Picture positions', () => {
  const graph = fixture();
  graph.h3.inputs.ref_images = '6';
  const original = preset(graph);
  const bound = bindComfyVideoWorkflow(original, 'synthetic DynamicCombo prompt', ['chosen-slot-5.png'], {}, refs([5]));
  assert.equal(bound.h3.inputs.ref_images, '6');
  assert.deepEqual(sentInputs(bound), sentInputs(graph));
  assert.equal(bound['20'].inputs.image, 'chosen-slot-5.png');
  imageIds.slice(0, 5).forEach((id) => assert.deepEqual(bound[id], graph[id]));
  assert.deepEqual(resolveComfyH3PictureNumbers(original, [5]), [4],
    'a scalar selector must not be treated as optional Autogrow or compress retained defaults');
});

check('new task snapshots record selected-image semantics while restored historical snapshots retain defaults', () => {
  const original = preset();
  const before = JSON.stringify(original);
  const historicalSnapshot = structuredClone(original);
  const historicalBefore = JSON.stringify(historicalSnapshot);
  assert.equal(original.mapping.h3ReferenceSelection, undefined);

  const selectedSnapshot = freezeComfyVideoWorkflow(original);
  const selectedBefore = JSON.stringify(selectedSnapshot);
  assert.equal(selectedSnapshot.mapping.h3ReferenceSelection, 'selected');
  const sparse = bindComfyVideoWorkflow(selectedSnapshot, 'synthetic first task', ['first-task.png'], {}, refs([5]));
  const full = bindComfyVideoWorkflow(original, 'synthetic second task', imageIds.map((_, index) => `second-task-${index}.png`));
  assert.equal(sentInputs(sparse).length, 1);
  assert.equal(sentInputs(full).length, 6);
  assert.deepEqual(resolveComfyH3PictureNumbers(selectedSnapshot, [5]), [1]);
  assert.equal(full['20'].inputs.image, 'second-task-5.png');

  const legacy = freezeComfyVideoWorkflow(historicalSnapshot, true);
  assert.equal(legacy.mapping.h3ReferenceSelection, 'workflow-defaults');
  const legacyRequest = bindComfyVideoWorkflow(legacy, 'synthetic historical task', ['historical-task.png'], {}, refs([5]));
  assert.equal(sentInputs(legacyRequest).length, 6);
  const originalGraph = fixture();
  imageIds.slice(0, 5).forEach((id) => assert.deepEqual(legacyRequest[id], originalGraph[id]));
  assert.equal(legacyRequest['20'].inputs.image, 'historical-task.png');
  assert.deepEqual(resolveComfyH3PictureNumbers(legacy, [5]), [4],
    'historical Picture positions include the three retained nonempty defaults');

  const restoredSelected = freezeComfyVideoWorkflow(selectedSnapshot, true);
  assert.equal(restoredSelected.mapping.h3ReferenceSelection, 'selected',
    'an explicit new policy survives later restoration instead of reverting to legacy defaults');
  const restoredSelectedRequest = bindComfyVideoWorkflow(restoredSelected,
    'synthetic restored selected task', ['restored-task.png'], {}, refs([5]));
  assert.equal(sentInputs(restoredSelectedRequest).length, 1);
  assert.deepEqual(resolveComfyH3PictureNumbers(restoredSelected, [5]), [1]);

  assert.equal(JSON.stringify(original), before);
  assert.equal(JSON.stringify(historicalSnapshot), historicalBefore);
  assert.equal(JSON.stringify(selectedSnapshot), selectedBefore);
});

check('empty optional audio placeholders are omitted while fixed audio and the original workflow remain intact', () => {
  for (const nested of [false, true]) {
    for (const placeholder of ['None', '', 'null']) {
      const graph = fixture();
      graph.emptyAudio = { class_type: 'LoadAudio', inputs: { audio: placeholder } };
      graph.fixedAudio = { class_type: 'LoadAudio', inputs: { audio: 'fixture-fixed-reference.wav' } };
      if (nested) {
        graph.h3.inputs.ref_audios = { ref_audio_0: ['emptyAudio', 0], ref_audio_1: ['fixedAudio', 0] };
      } else {
        graph.h3.inputs['ref_audios.ref_audio_0'] = ['emptyAudio', 0];
        graph.h3.inputs['ref_audios.ref_audio_1'] = ['fixedAudio', 0];
      }
      const original = preset(graph);
      const before = JSON.stringify(original);
      const bound = bindComfyVideoWorkflow(original, 'synthetic optional-audio prompt', ['chosen.png']);
      const audioInputs = nested
        ? bound.h3.inputs.ref_audios as Record<string, unknown>
        : bound.h3.inputs;
      const emptyField = nested ? 'ref_audio_0' : 'ref_audios.ref_audio_0';
      const fixedField = nested ? 'ref_audio_1' : 'ref_audios.ref_audio_1';
      assert.equal(emptyField in audioInputs, false, `${nested ? 'nested' : 'flattened'} ${JSON.stringify(placeholder)} placeholder`);
      assert.equal('emptyAudio' in bound, false);
      assert.deepEqual(audioInputs[fixedField], ['fixedAudio', 0]);
      assert.deepEqual(bound.fixedAudio, graph.fixedAudio,
        'an unmapped nonempty fixed audio filename is never inferred to be unused');
      assert.equal(JSON.stringify(original), before);
    }
  }
});

check('empty audio cleanup preserves shared loaders, scalar dynamic schemas and historical defaults', () => {
  for (const nested of [false, true]) {
    const graph = fixture();
    graph.sharedAudio = { class_type: 'LoadAudio', inputs: { audio: 'None' } };
    graph.exclusiveAudio = { class_type: 'LoadAudio', inputs: { audio: '' } };
    graph.saveAudio = { class_type: 'SaveAudio', inputs: { audio: ['sharedAudio', 0], filename_prefix: 'fixture-shared-audio' } };
    if (nested) {
      graph.h3.inputs.ref_audios = { ref_audio_0: ['sharedAudio', 0], ref_audio_1: ['exclusiveAudio', 0] };
    } else {
      graph.h3.inputs['ref_audios.ref_audio_0'] = ['sharedAudio', 0];
      graph.h3.inputs['ref_audios.ref_audio_1'] = ['exclusiveAudio', 0];
    }
    const original = preset(graph);
    const before = JSON.stringify(original);
    const bound = bindComfyVideoWorkflow(original, 'synthetic shared-audio prompt', ['chosen.png']);
    const audioInputs = nested
      ? (bound.h3.inputs.ref_audios || {}) as Record<string, unknown>
      : bound.h3.inputs;
    assert.equal((nested ? 'ref_audio_0' : 'ref_audios.ref_audio_0') in audioInputs, false);
    assert.equal((nested ? 'ref_audio_1' : 'ref_audios.ref_audio_1') in audioInputs, false);
    assert.deepEqual(bound.sharedAudio, graph.sharedAudio,
      'a separate consumer keeps its source even when the H3 optional edge is removed');
    assert.deepEqual(bound.saveAudio, graph.saveAudio);
    assert.equal('exclusiveAudio' in bound, false);

    const historical = freezeComfyVideoWorkflow(original, true);
    const historicalRequest = bindComfyVideoWorkflow(historical, 'synthetic historical-audio prompt', ['chosen.png']);
    assert.deepEqual(historicalRequest.sharedAudio, graph.sharedAudio);
    assert.deepEqual(historicalRequest.exclusiveAudio, graph.exclusiveAudio);
    if (nested) assert.deepEqual(historicalRequest.h3.inputs.ref_audios, graph.h3.inputs.ref_audios);
    else {
      assert.deepEqual(historicalRequest.h3.inputs['ref_audios.ref_audio_0'], ['sharedAudio', 0]);
      assert.deepEqual(historicalRequest.h3.inputs['ref_audios.ref_audio_1'], ['exclusiveAudio', 0]);
    }
    assert.equal(JSON.stringify(original), before);
  }

  const selectorGraph = fixture();
  selectorGraph.emptyAudio = { class_type: 'LoadAudio', inputs: { audio: 'None' } };
  selectorGraph.h3.inputs.ref_audios = '1';
  selectorGraph.h3.inputs['ref_audios.ref_audio_0'] = ['emptyAudio', 0];
  const selectorPreset = preset(selectorGraph);
  const selectorBefore = JSON.stringify(selectorPreset);
  const selectorRequest = bindComfyVideoWorkflow(selectorPreset, 'synthetic dynamic-audio prompt', ['chosen.png']);
  assert.equal(selectorRequest.h3.inputs.ref_audios, '1');
  assert.deepEqual(selectorRequest.h3.inputs['ref_audios.ref_audio_0'], ['emptyAudio', 0]);
  assert.deepEqual(selectorRequest.emptyAudio, selectorGraph.emptyAudio);
  assert.equal(JSON.stringify(selectorPreset), selectorBefore);
});

console.log(`ComfyUI optional H3 reference images: ${groups} groups passed.`);
