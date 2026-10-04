import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { resolveVideoPromptNavigation } from '../src/videoPromptNavigation';
import { frozenVideoReferenceAsset } from '../src/videoProvenance';
import { assetPreviewUrl } from '../src/media';
import type { Project } from '../src/types';

const project = createInitialState().project;
project.storyboards = [
  { id: 'a1', sequencePlanId: 'A', segmentId: 'A-1' },
  { id: 'b2', sequencePlanId: 'B', segmentId: 'B-2' },
  { id: 'orphan', sequencePlanId: 'A', segmentId: 'A-1' },
  { id: 'single' },
] as Project['storyboards'];
project.sequencePlans = [
  { id: 'A', segments: [{ id: 'A-1', storyboardId: 'a1' }] },
  { id: 'B', segments: [{ id: 'B-2', storyboardId: 'b2' }] },
] as Project['sequencePlans'];
assert.deepEqual(resolveVideoPromptNavigation(project, 'b2', { sequencePlanId: 'A', language: 'en' }), {
  storyboardId: 'b2', mode: 'sequence', planId: 'B', segmentId: 'B-2', language: 'en',
}, 'actual storyboard membership wins over an old selected plan or stale source hint');
assert.equal(resolveVideoPromptNavigation(project, 'single')?.mode, 'single');
assert.equal(resolveVideoPromptNavigation(project, 'orphan')?.mode, 'single', 'an old board must not silently open the newer board occupying its old segment');
assert.equal(resolveVideoPromptNavigation(project, 'deleted'), undefined);
const frozen = frozenVideoReferenceAsset({ assetId: 'original', name: '原图', role: 'character', relativePath: 'images/原图.png', checksum: 'original-bytes', freezeState: 'frozen', url: 'https://changed.test/not-original.png' });
assert.equal(assetPreviewUrl(frozen), 'lianhua-asset://local/images/%E5%8E%9F%E5%9B%BE.png');
assert.equal(frozen.checksum, 'original-bytes');
assert.equal(frozen.missing, false);
assert.equal(assetPreviewUrl(frozenVideoReferenceAsset({ assetId: 'inline', name: '原图', role: 'general', dataUrl: 'data:image/png;base64,AAAA', freezeState: 'frozen' })), 'data:image/png;base64,AAAA');
console.log('video prompt navigation and frozen-reference preview checks passed');
