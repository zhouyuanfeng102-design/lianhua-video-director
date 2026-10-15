import assert from 'node:assert/strict';
import { getVideoApiModelParameterCapabilities, mergeVideoApiParameterCapabilities, parseVideoApiModelMetadata, parseVideoApiOpenApiCapabilities, parseVideoApiRequestSchemaCapabilities, videoApiCapabilityScope } from '../src/videoApiCapabilities';
import { getVideoApiImageCapacity } from '../src/videoImageCapacity';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import type { VideoTaskApiConfig } from '../src/types';
import type { VideoApiParameterCapabilities } from '../src/videoApiCapabilityTypes';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

const imagePredicate = { type: 'object', required: ['type'], properties: { type: { const: 'image' } } };
const audioPredicate = { type: 'object', required: ['type'], properties: { type: { const: 'audio' } } };
const modelSchema = (model: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { model: { const: model }, ...properties } });
const definitions = {
  A: modelSchema('model-A', { images: { type: 'array', maxItems: 30 } }),
  B: modelSchema('model-B', { images: { $ref: '#/components/schemas/FourImages' } }),
  Mixed: modelSchema('mixed', { references: { type: 'array', maxItems: 8, allOf: [
    { contains: { $ref: '#/components/schemas/ImagePredicate' }, minContains: 0, maxContains: 6 },
    { contains: audioPredicate, minContains: 0, maxContains: 2 },
  ] } }),
  TotalOnly: modelSchema('total-only', { references: { type: 'array', maxItems: 8, allOf: [{ contains: audioPredicate, maxContains: 2 }] } }),
  Zero: modelSchema('zero', { images: { type: 'array', maxItems: 0 } }),
  FourImages: { allOf: [{ type: 'array', maxItems: 40 }, { maxItems: 4 }] },
  ImagePredicate: imagePredicate,
  Historical: modelSchema('historical-unused', { images: { type: 'array', maxItems: 99 } }),
};
const schema = { oneOf: ['A', 'B', 'Mixed', 'TotalOnly', 'Zero'].map((name) => ({ $ref: `#/components/schemas/${name}` })) };
const document = {
  openapi: '3.1.0',
  paths: { '/v1/videos': { post: { requestBody: { content: { 'application/json': { schema } } } } } },
  components: { schemas: definitions },
};
const parsed = parseVideoApiOpenApiCapabilities(document, ['unknown']);
assert.deepEqual(parsed.models['model-A'].imageReferences, { maxCount: 30, source: 'openapi', field: 'images' });
assert.deepEqual(parsed.models['model-B'].imageReferences, { maxCount: 4, source: 'openapi', field: 'images' });
assert.deepEqual(parsed.models.mixed.imageReferences, { maxCount: 6, source: 'openapi', field: 'references' }, 'mixed media total 8 is not the image capacity');
assert.equal(parsed.models['total-only'], undefined, 'audio counts and a total-only maxItems do not declare image capacity');
assert.equal(parsed.models.zero.imageReferences?.maxCount, 0, 'zero explicitly disables image inputs');
assert.equal(parsed.models.unknown, undefined);
assert.equal(parsed.models['historical-unused'], undefined, 'unused historical components are not evidence');
assert.deepEqual(parsed.models['model-A'].controls, {}, 'capacity-only entries are retained without other parameter controls');

const metadata = parseVideoApiModelMetadata({ data: [
  { id: 'metadata', capabilities: { max_images: 17 }, aliases: ['metadata-alias'] },
  { id: 'metadata-schema', parameters: { images: { type: 'array', maxItems: 12 } } },
  { id: 'metadata-zero', constraints: { max_reference_images: 0 } },
  { id: 'metadata-mixed', metadata: { references: { type: 'array', maxItems: 25, allOf: [{ contains: imagePredicate, maxContains: 17 }] } } },
  { id: 'description-only', description: '最多30图', capabilities: { examples: { max_images: 30 } } },
  ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '17'].map((maximum, index) => ({ id: `invalid-${index}`, capabilities: { max_images: maximum } })),
] });
assert.deepEqual(metadata.models.metadata.imageReferences, { maxCount: 17, source: 'models' });
assert.deepEqual(metadata.models['metadata-schema'].imageReferences, { maxCount: 12, source: 'models', field: 'images' });
assert.equal(metadata.models['metadata-zero'].imageReferences?.maxCount, 0);
assert.deepEqual(metadata.models['metadata-mixed'].imageReferences, { maxCount: 17, source: 'models', field: 'references' });
assert.equal(metadata.models['description-only'], undefined);
assert.ok(Object.keys(metadata.models).every((id) => !id.startsWith('invalid-')));
assert.equal(parseVideoApiModelMetadata({ data: [{ id: 'large', max_images: Number.MAX_SAFE_INTEGER }] }).models.large.imageReferences?.maxCount, Number.MAX_SAFE_INTEGER, 'valid upstream capacities are not silently capped');

const parse = (value: unknown, ids: string[] = []) => parseVideoApiRequestSchemaCapabilities(value, value as Record<string, unknown>, ids);
const union = { oneOf: [modelSchema('branch', { images: { type: 'array', maxItems: 4 } }), modelSchema('branch', { images: { type: 'array', maxItems: 30 } })] };
assert.equal(parse(union).models.branch.imageReferences?.maxCount, 30, 'all resolved alternatives permit their largest explicit image count');
const unknownBranch = { oneOf: [modelSchema('branch', { images: { type: 'array', maxItems: 4 } }), modelSchema('branch', { duration: { type: 'integer' } })] };
assert.equal(parse(unknownBranch).models.branch?.imageReferences, undefined, 'an alternative without image capacity keeps the result unknown');
const remoteBranch = { oneOf: [modelSchema('branch', { images: { type: 'array', maxItems: 4 } }), { $ref: 'https://unrelated.invalid/request.json' }] };
assert.equal(parse(remoteBranch).models.branch, undefined, 'unresolved alternatives are not guessed or fetched');
const arrayUnion = modelSchema('array-union', { images: { anyOf: [{ type: 'array', maxItems: 4 }, { type: 'array', maxItems: 17 }] } });
assert.equal(parse(arrayUnion).models['array-union'].imageReferences?.maxCount, 17);
assert.equal(parse(modelSchema('array-unknown', { images: { anyOf: [{ type: 'array', maxItems: 4 }, { type: 'array' }] } })).models['array-unknown'], undefined);
const mixedAllOf = modelSchema('intersected', { references: { allOf: [
  { type: 'array', maxItems: 5 }, { contains: imagePredicate, maxContains: 30 },
] } });
assert.equal(parse(mixedAllOf).models.intersected.imageReferences?.maxCount, 5, 'a total upper bound only tightens an explicit image count');
const imageSubset = modelSchema('subset', { references: { type: 'array', maxItems: 30, contains: {
  type: 'object', required: ['type', 'role'], properties: { type: { const: 'image' }, role: { const: 'first_frame' } },
}, maxContains: 1 } });
assert.equal(parse(imageSubset).models.subset, undefined, 'one particular image role is not the capacity of all images');
const conditional = { properties: { model: { type: 'string' }, images: { type: 'array' } }, allOf: [
  { if: { properties: { model: { const: 'conditioned' } } }, then: { properties: { images: { maxItems: 17 } } } },
  { if: { properties: { mode: { const: 'frames' } } }, then: { properties: { images: { maxItems: 2 } } } },
] };
assert.equal(parse(conditional, ['conditioned']).models.conditioned.imageReferences?.maxCount, 17);
assert.equal(parse(conditional, ['unconditioned']).models.unconditioned, undefined, 'non-model conditions are not assumed');
assert.equal(parse(modelSchema('examples', { images: { type: 'array', description: '最多30图', examples: [{ maxItems: 30 }] } })).models.examples, undefined);

const config: VideoTaskApiConfig = { enabled: true, provider: 'generic', baseUrl: 'https://capacity-fixture.invalid', endpoint: '', statusEndpointTemplate: '', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', model: 'model-A', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'download_url' };
const capabilities: VideoApiParameterCapabilities = { ...mergeVideoApiParameterCapabilities(metadata, parsed), source: 'mixed', sourceUrl: 'https://capacity-fixture.invalid/docs/video-api/openapi.json', scope: videoApiCapabilityScope(config), fetchedAt: 1 };
assert.equal(getVideoApiModelParameterCapabilities({ ...config, parameterCapabilities: capabilities })?.imageReferences?.maxCount, 30);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, model: 'model-B', parameterCapabilities: capabilities })?.imageReferences?.maxCount, 4);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, model: 'metadata-alias', parameterCapabilities: capabilities })?.imageReferences?.maxCount, 17, 'only explicitly returned aliases share capacity');
assert.equal(getVideoApiModelParameterCapabilities({ ...config, model: 'unknown', parameterCapabilities: capabilities }), undefined);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, baseUrl: 'https://another-fixture.invalid', parameterCapabilities: capabilities }), undefined);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, endpoint: 'https://capacity-fixture.invalid/custom', parameterCapabilities: capabilities }), undefined);
assert.equal(getVideoApiModelParameterCapabilities({ ...config, statusEndpointTemplate: 'https://capacity-fixture.invalid/custom/{id}', parameterCapabilities: capabilities }), undefined);
for (const maximum of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '30']) {
  const damaged = { ...capabilities, models: { 'model-A': { controls: {}, defaults: {}, imageReferences: { maxCount: maximum, source: 'openapi' } } } };
  assert.equal(getVideoApiModelParameterCapabilities({ ...config, parameterCapabilities: damaged as VideoApiParameterCapabilities }), undefined);
}
const zero = getVideoApiModelParameterCapabilities({ ...config, model: 'zero', parameterCapabilities: capabilities });
assert.equal(zero?.imageReferences?.maxCount, 0);
const merged = mergeVideoApiParameterCapabilities({ models: { shared: { controls: { duration: { kind: 'number', min: 1 } }, defaults: {} } } }, { models: { shared: { controls: {}, defaults: {}, imageReferences: { maxCount: 4, source: 'openapi', field: 'images' } } } });
assert.equal(merged.models.shared.controls.duration?.min, 1);
assert.equal(merged.models.shared.imageReferences?.maxCount, 4);

const configured = { ...config, parameterCapabilities: capabilities };
assert.deepEqual(getVideoApiImageCapacity(configured), { maxCount: 30, source: 'openapi', field: 'images', fetchedAt: 1, sourceUrl: capabilities.sourceUrl });
assert.deepEqual(getVideoApiImageCapacity({ ...configured, model: 'metadata' }), { maxCount: 17, source: 'models', fetchedAt: 1, sourceUrl: 'https://capacity-fixture.invalid/v1/models' });
assert.equal(getVideoApiImageCapacity({ ...configured, requestTemplate: '{"prompt":"{{prompt}}","images":"{{images}}"}' }), undefined, 'custom templates do not inherit the built-in submit schema capacity');
assert.equal(getVideoApiImageCapacity({ ...configured, provider: 'minimax' }), undefined, 'other provider protocols retain their existing mapping rules');
assert.equal(getVideoApiImageCapacity({ ...configured, model: 'unknown' }), undefined);
assert.equal(getVideoApiImageCapacity({ ...configured, baseUrl: 'https://another-fixture.invalid' }), undefined);

const sevenImageConfig = { ...config, model: 'seven', parameterCapabilities: {
  scope: videoApiCapabilityScope(config), source: 'models' as const, fetchedAt: 2,
  models: { seven: { controls: {}, defaults: {}, imageReferences: { maxCount: 7, source: 'models' as const } } },
} };
const eightImages = Array.from({ length: 8 }, (_, index) => `https://original-fixture.invalid/image-${index}.png`);
const submission: VideoGenerationDraft = { name: '明确上游容量', backend: 'api', prompt: '保持完整提示词与所选图片顺序。', parameters: {}, references: eightImages.map((_, index) => ({ assetId: `image-${index}`, role: 'general' })) };
assert.throws(() => buildVideoApiBody(sevenImageConfig, submission, eightImages), /7.*8/u, 'the body builder blocks the actual returned seven-image capacity before submission');
const unknownCapacityBody = buildVideoApiBody({ ...sevenImageConfig, parameterCapabilities: undefined }, submission, eightImages);
assert.deepEqual(unknownCapacityBody.images, eightImages, 'unknown capacity sends all selected originals without a locally guessed ceiling');
assert.equal(unknownCapacityBody.prompt, submission.prompt);
assert.throws(() => buildVideoApiBody({ ...configured, model: 'zero' }, { ...submission, references: [submission.references[0]] }, [eightImages[0]]), /0.*1/u);
console.log('videoImageCapacity: explicit model/schema counts, mixed-media separation, unknown branches, cache scope and zero capacity passed');
