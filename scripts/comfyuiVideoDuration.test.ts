import assert from 'node:assert/strict';
import { inferComfyVideoDurationBinding, mergeComfyVideoDurationBinding } from '../src/comfyuiVideoDuration';
import { bindComfyVideoWorkflow, effectiveComfyVideoParameterBindings, importComfyVideoWorkflow } from '../src/comfyuiVideo';
import { availableVideoParameterKeys } from '../src/videoOutputParameters';

type Graph = Parameters<typeof inferComfyVideoDurationBinding>[0];
const expression = 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17';
const h3 = (secondsId = '259', formulaId = '250', videoId = '265'): Graph => ({
  [secondsId]: { class_type: 'PrimitiveFloat', inputs: { value: 12 } },
  [formulaId]: { class_type: 'ComfyMathExpression', inputs: { expression, 'values.a': [secondsId, 0] } },
  [videoId]: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { length: [formulaId, 1] } },
});
const source = h3();
const untouched = structuredClone(source);
assert.deepEqual(inferComfyVideoDurationBinding(source), { nodeId: '259', inputName: 'value' });
assert.deepEqual(source, untouched, 'inference leaves the seconds, conversion formula and H3 length connection intact');
assert.deepEqual(inferComfyVideoDurationBinding(h3('seconds-source', 'frame-math', 'video-conditioning')),
  { nodeId: 'seconds-source', inputName: 'value' }, 'node numbers supply no semantics');

const renamedVariable = h3();
renamedVariable['250'].inputs.expression = expression.replace(/\ba\b/gu, 'b');
renamedVariable['250'].inputs['values.b'] = renamedVariable['250'].inputs['values.a'];
delete renamedVariable['250'].inputs['values.a'];
assert.deepEqual(inferComfyVideoDurationBinding(renamedVariable), { nodeId: '259', inputName: 'value' });

assert.deepEqual(inferComfyVideoDurationBinding({
  video: { class_type: 'MiniMaxH3ImageToVideo', inputs: { duration_seconds: 10 } },
}), { nodeId: 'video', inputName: 'duration_seconds' });
assert.deepEqual(inferComfyVideoDurationBinding({
  value: { class_type: 'PrimitiveInt', inputs: { value: 10 } },
  video: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { video_duration_sec: ['value', 0] } },
}), { nodeId: 'value', inputName: 'value' });
assert.equal(inferComfyVideoDurationBinding({
  video: { class_type: 'VideoGenerator', inputs: { duration: 10, length: 240, fps: 24 } },
  value: { class_type: 'PrimitiveFloat', inputs: { value: 10 } },
}), undefined, 'unlabelled duration, frame counts, fps and numeric primitives do not prove seconds');
assert.equal(inferComfyVideoDurationBinding({
  audio: { class_type: 'AudioTrim', inputs: { duration_seconds: 10 } },
}), undefined, 'an audio duration in the output ancestry is not a video duration');
assert.equal(inferComfyVideoDurationBinding({
  output: { class_type: 'VideoSave', inputs: { duration_seconds: 10 } },
  unknown: { class_type: 'UnknownVideoNode', inputs: { video_duration_seconds: 10 } },
}), undefined, 'video class names or field names on unknown consumers do not prove a generation control');

const unknownFormula = h3();
unknownFormula['250'].inputs.expression = 'a * 30';
assert.equal(inferComfyVideoDurationBinding(unknownFormula), undefined);
const wrongVariable = h3();
wrongVariable['250'].inputs.expression = 'max(5, round(a * 24)) + (5 - (max(5, round(b * 24)) % 17)) % 17';
assert.equal(inferComfyVideoDurationBinding(wrongVariable), undefined);
const wrongOutput = h3();
wrongOutput['265'].inputs.length = ['250', 0];
assert.equal(inferComfyVideoDurationBinding(wrongOutput), undefined);
const unsafePrimitive = h3();
unsafePrimitive['259'].class_type = 'UnknownNumberTransform';
assert.equal(inferComfyVideoDurationBinding(unsafePrimitive), undefined);
assert.equal(inferComfyVideoDurationBinding(source, new Set(['250', '265'])), undefined,
  'an upstream control outside the chosen output branch is not adopted');
assert.deepEqual(inferComfyVideoDurationBinding(source, new Set(Object.keys(source))),
  { nodeId: '259', inputName: 'value' });

const conflicting = { ...h3(), ...h3('other-seconds', 'other-formula', 'other-video') };
assert.equal(inferComfyVideoDurationBinding(conflicting), undefined, 'different proven controls need an explicit mapping');
const shared = h3();
shared.other = { class_type: 'MiniMaxH3ImageToVideo', inputs: { length: ['250', 1] } };
assert.deepEqual(inferComfyVideoDurationBinding(shared), { nodeId: '259', inputName: 'value' },
  'multiple consumers sharing one proven control retain one mapping');

const existing = { seed: { nodeId: 'sampler', inputName: 'seed' } };
const inferred = inferComfyVideoDurationBinding(source);
assert.deepEqual(mergeComfyVideoDurationBinding(existing, inferred), { ...existing, duration: { nodeId: '259', inputName: 'value' } });
assert.equal(Object.prototype.hasOwnProperty.call(existing, 'duration'), false, 'old saved maps stay untouched');
const explicit = { ...existing, duration: { nodeId: 'manual', inputName: 'seconds' } };
assert.equal(mergeComfyVideoDurationBinding(explicit, inferred), explicit, 'an explicit saved duration wins');
assert.equal(mergeComfyVideoDurationBinding(existing, undefined), existing);

const executable = {
  ...h3(),
  text: { class_type: 'Text', inputs: { text: 'synthetic prompt' } },
  out: { class_type: 'VHS_VideoCombine', inputs: { images: ['265', 0], frame_rate: 24, format: 'video/h264-mp4' } },
};
Object.assign(executable['265'].inputs, { prompt: ['text', 0] });
const imported = importComfyVideoWorkflow(JSON.stringify(executable));
assert.deepEqual(imported.mapping.parameters?.duration, { nodeId: '259', inputName: 'value' });
const legacy = structuredClone(imported);
delete legacy.mapping.parameters!.duration;
const originalText = legacy.workflowJson;
const originalMapping = structuredClone(legacy.mapping);
assert.ok(availableVideoParameterKeys('comfyui', undefined, legacy).includes('duration'),
  'single, batch and custom UI all use the same effective parameter keys');
assert.deepEqual(effectiveComfyVideoParameterBindings(legacy).duration, { nodeId: '259', inputName: 'value' });
const request = bindComfyVideoWorkflow(legacy, 'synthetic duration override', [], { duration: 8.5 });
assert.equal(request['259'].inputs.value, 8.5);
assert.equal(request['250'].inputs.expression, expression);
assert.deepEqual(request['265'].inputs.length, ['250', 1]);
assert.equal(request.out.inputs.frame_rate, 24);
assert.equal(legacy.workflowJson, originalText);
assert.deepEqual(legacy.mapping, originalMapping);
const edited = structuredClone(legacy);
const editedGraph = JSON.parse(edited.workflowJson);
editedGraph['250'].inputs.expression = 'a * 30';
edited.workflowJson = JSON.stringify(editedGraph);
assert.ok(!availableVideoParameterKeys('comfyui', undefined, edited).includes('duration'),
  'edited graph text invalidates cached inference');
const manual = structuredClone(legacy);
manual.mapping.parameters!.duration = { nodeId: 'out', inputName: 'frame_rate' };
assert.equal(bindComfyVideoWorkflow(manual, 'synthetic explicit mapping', [], { duration: 18 }).out.inputs.frame_rate, 18,
  'explicit user mapping remains authoritative even when inference points elsewhere');

console.log('ComfyUI video seconds-source inference checks passed.');
