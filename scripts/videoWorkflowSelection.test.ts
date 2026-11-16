import assert from 'node:assert/strict';
import { resolveComfyVideoWorkflow, restoreComfyVideoWorkflowId } from '../src/videoWorkflowSelection';
import type { ComfyVideoConfig, ComfyVideoWorkflowPreset } from '../src/videoGenerationTypes';

const preset = (id: string): ComfyVideoWorkflowPreset => ({
  id, name: id, workflowJson: '{}', mapping: { prompt: [], images: [] }, createdAt: 1, updatedAt: 1,
});
const first = preset('first');
const current = preset('current');
const config: ComfyVideoConfig = {
  enabled: true, baseUrl: 'http://localhost:8188', apiKey: '', workflows: [first, current], activeWorkflowId: current.id,
};

assert.equal(resolveComfyVideoWorkflow(config, first.id), first, 'a valid explicit destination overrides the current setting');
assert.equal(restoreComfyVideoWorkflowId(config, first.id), first.id, 'restoring a form preserves an existing explicit selection');
assert.equal(resolveComfyVideoWorkflow(config, 'removed'), undefined, 'submission never substitutes a deleted explicit destination');
assert.equal(restoreComfyVideoWorkflowId(config, 'removed'), current.id, 'an editable stale form restores the explicitly current connection');
assert.equal(restoreComfyVideoWorkflowId(config, ''), current.id, 'a saved empty form inherits the explicitly current connection');
assert.equal(resolveComfyVideoWorkflow(config), current, 'an unspecified destination resolves to the current workflow');

const unselected = { ...config, activeWorkflowId: null };
assert.equal(resolveComfyVideoWorkflow(unselected), undefined, 'explicitly clearing the current selection must not choose the first workflow');
assert.equal(restoreComfyVideoWorkflowId(unselected, 'removed'), 'removed', 'with no current destination a deleted ID remains visible as missing');
assert.equal(restoreComfyVideoWorkflowId(unselected, ''), undefined, 'an explicitly unselected connection stays unselected');

const invalidCurrent = { ...config, activeWorkflowId: 'removed-current' };
assert.equal(resolveComfyVideoWorkflow(invalidCurrent), undefined, 'an invalid current destination never falls through to the first workflow');
assert.equal(restoreComfyVideoWorkflowId(invalidCurrent, 'removed'), 'removed');

const legacy = { ...config, activeWorkflowId: undefined };
assert.equal(resolveComfyVideoWorkflow(legacy), first, 'only pre-selection legacy settings inherit the first workflow');
assert.equal(restoreComfyVideoWorkflowId(legacy), first.id, 'legacy form recovery records the actual selected ID');
assert.equal(resolveComfyVideoWorkflow(legacy, 'removed'), undefined);
assert.equal(restoreComfyVideoWorkflowId(undefined, 'removed'), 'removed');
assert.equal(restoreComfyVideoWorkflowId(undefined), undefined);
assert.equal(resolveComfyVideoWorkflow({ ...legacy, workflows: [] }), undefined);
console.log('ComfyUI workflow selection: explicit, stale, cleared and legacy cases passed.');
