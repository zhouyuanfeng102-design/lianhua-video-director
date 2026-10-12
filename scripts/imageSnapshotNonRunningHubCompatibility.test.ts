import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { captureImageApiSnapshot, resolveImageApiForRegeneration } from '../src/imageApiSelection';
import type { ImageApiConfig } from '../src/types';

test('existing non-RunningHub image snapshots remain retryable after save/reload without new cloud-library fields', async () => {
  for (const backend of ['openai', 'sd_webui', 'comfyui', 'novelai'] as const) {
    const state = createInitialState();
    state.settings.imageApi = { ...state.settings.imageApi, backend, enabled: true,
      baseUrl: 'https://legacy.example.test', apiKey: 'LEGACY_FAKE_KEY', model: 'legacy-model' };
    const initial = normalizeState(state);
    const before = initial.settings.imageApi;
    assert.equal(Object.hasOwn(before, 'runningHubWorkflows'), false, `${backend}: original has no RH field`);
    assert.equal(Object.hasOwn(before, 'activeRunningHubWorkflowId'), false);
    const snapshot = await captureImageApiSnapshot(before, null);
    const restored = normalizeState(JSON.parse(serializeStateForStorage(initial).serialized));
    assert.equal(Object.hasOwn(restored.settings.imageApi, 'runningHubWorkflows'), false, `${backend}: roundtrip must not add a new execution field`);
    assert.equal(Object.hasOwn(restored.settings.imageApi, 'activeRunningHubWorkflowId'), false);
    const retry: ImageApiConfig = await resolveImageApiForRegeneration(restored.settings, snapshot);
    assert.equal(retry.backend, backend);
    assert.equal(retry.baseUrl, before.baseUrl);
    assert.equal(retry.model, before.model);
    assert.equal(retry.apiKey, before.apiKey);
  }
});
