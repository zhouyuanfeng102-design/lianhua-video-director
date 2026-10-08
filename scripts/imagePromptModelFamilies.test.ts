import assert from 'node:assert/strict';
import {
  BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS,
  BUILT_IN_IMAGE_PROMPT_RULE_SETS,
  IMAGE_PROMPT_RULE_CATALOG_VERSION,
  migrateImagePromptRulesState,
  normalizeImagePromptRulesState,
  resolveImagePromptSelection,
  type ImagePromptCategoryPreset,
  type ImagePromptRulesState,
} from '../src/imagePromptRules';
import {
  GOOGLE_NANO_BANANA_RULE_ID,
  GROK_IMAGINE_RULE_ID,
  MODEL_FAMILY_CATEGORY_PRESETS,
  MODEL_FAMILY_FIVE_VIEW_PRESET_IDS,
  MODEL_FAMILY_RULE_SETS,
  isGoogleNanoBananaImageModel,
  isGrokImagineImageModel,
} from '../src/imagePromptModelFamilies';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>): void => {
  tests.push({ name, run });
};

const families = [
  {
    ruleId: GOOGLE_NANO_BANANA_RULE_ID,
    model: 'gemini-2.5-flash-image',
    fiveViewId: MODEL_FAMILY_FIVE_VIEW_PRESET_IDS.google,
    recognizes: isGoogleNanoBananaImageModel,
    models: [
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image',
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-image-preview',
      'gemini-3.1-flash-lite-image',
      'gemini-nano-banana-2.1',
      'google/gemini-2.5-flash-image',
      ' Nano Banana ',
      'nano-banana-pro',
      'nano_banana_2',
    ],
  },
  {
    ruleId: GROK_IMAGINE_RULE_ID,
    model: 'grok-imagine-image-2.0',
    fiveViewId: MODEL_FAMILY_FIVE_VIEW_PRESET_IDS.grok,
    recognizes: isGrokImagineImageModel,
    models: [
      'grok-imagine-image',
      'grok-imagine-image-2.0',
      'grok-imagine-image-quality',
      'grok-imagine-image-pro',
      'grok-imagine-image-2026-03-02',
      'grok-imagine-image-quality-20260403',
      'grok-imagine-image-quality-latest',
      'xai/grok-imagine-image-2.0',
      ' GROK-IMAGINE-IMAGE ',
    ],
  },
] as const;

const familyRuleIds = new Set<string>(families.map((family) => family.ruleId));
const familyPresetIds = new Set(MODEL_FAMILY_CATEGORY_PRESETS.map((preset) => preset.id));
const fiveViewIds = new Set<string>(Object.values(MODEL_FAMILY_FIVE_VIEW_PRESET_IDS));

// Exercise the same normalized records as a persisted library, including
// optional fields whose empty values are omitted when read back from storage.
const savedFactoryState = (): ImagePromptRulesState => normalizeImagePromptRulesState(
  JSON.parse(JSON.stringify(normalizeImagePromptRulesState(undefined))),
);

const legacyState = (): ImagePromptRulesState => {
  const current = savedFactoryState();
  return {
    ...current,
    catalogVersion: 17,
    ruleSets: current.ruleSets.filter((rule) => !familyRuleIds.has(rule.id)),
    categoryPresets: current.categoryPresets.filter((preset) => !familyPresetIds.has(preset.id)),
  };
};

test('both model families register nine selectable ordinary categories with valid defaults', () => {
  assert.equal(MODEL_FAMILY_RULE_SETS.length, 2);
  assert.equal(MODEL_FAMILY_CATEGORY_PRESETS.length, 18);
  assert.equal(familyPresetIds.size, 18);
  for (const family of families) {
    const rule = BUILT_IN_IMAGE_PROMPT_RULE_SETS.find((candidate) => candidate.id === family.ruleId)!;
    assert.ok(rule, `${family.ruleId} must be exposed in the built-in rule library`);
    assert.equal(rule.format, 'natural-language');
    assert.equal(rule.categoryPresetIds.length, 9);
    const counts: Record<string, number> = {};
    for (const id of rule.categoryPresetIds) {
      const preset = BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((candidate) => candidate.id === id)!;
      assert.ok(preset, `${id} must be exposed in the built-in preset library`);
      counts[preset.assetKind] = (counts[preset.assetKind] || 0) + 1;
      assert.equal(preset.enabled, true);
      assert.equal(preset.format, 'natural-language');
      const selected = resolveImagePromptSelection({
        backend: 'openai', assetKind: preset.assetKind,
        manualRuleSetId: family.ruleId, manualPresetId: id,
      });
      assert.equal(selected.ruleSet.id, family.ruleId);
      assert.equal(selected.preset.id, id);
      assert.equal(selected.presetSource, 'manual');
    }
    assert.deepEqual(counts, {
      character: 2, 'character-sheet': 2, location: 1, prop: 1, storyboard: 2, grid: 1,
    });
    for (const [assetKind, id] of Object.entries(rule.defaultPresetByAssetKind)) {
      assert.ok(rule.categoryPresetIds.includes(id));
      assert.equal(BUILT_IN_IMAGE_PROMPT_CATEGORY_PRESETS.find((preset) => preset.id === id)?.assetKind, assetKind);
    }
    assert.equal(rule.defaultPresetByAssetKind['character-private'], undefined);
  }
});

test('recognized image models automatically select their family on the compatible API channel', () => {
  const state = savedFactoryState();
  const before = structuredClone(state);
  for (const family of families) {
    for (const model of family.models) {
      assert.equal(family.recognizes(model), true, model);
      const selected = resolveImagePromptSelection({ backend: 'openai', model, assetKind: 'character', state });
      assert.equal(selected.ruleSet.id, family.ruleId, model);
      assert.equal(selected.ruleSource, 'backend-default');
      assert.equal(selected.preset.id, selected.ruleSet.defaultPresetByAssetKind.character);
    }
  }
  assert.deepEqual(state, before, 'automatic selection must not change stored defaults');
});

test('chat and video models cannot accidentally activate image family rules', () => {
  for (const model of [
    '', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview',
    'google/gemini-2.5-pro', 'grok-2', 'grok-4', 'grok-4.1',
    'grok-imagine-video', 'xai/grok-imagine-video-1.5', 'other-image-model',
  ]) {
    assert.equal(isGoogleNanoBananaImageModel(model), false, model);
    assert.equal(isGrokImagineImageModel(model), false, model);
    const selected = resolveImagePromptSelection({ backend: 'openai', model, assetKind: 'character' });
    assert.equal(familyRuleIds.has(selected.ruleSet.id), false, model);
  }
  for (const backend of ['all', 'comfyui', 'sd-webui', 'novelai'] as const) {
    for (const family of families) {
      const selected = resolveImagePromptSelection({ backend, model: family.model, assetKind: 'character' });
      assert.equal(familyRuleIds.has(selected.ruleSet.id), false, backend);
    }
  }
});

test('explicit rule and preset choices override model and five-view recommendations', () => {
  for (const family of families) {
    const other = families.find((candidate) => candidate.ruleId !== family.ruleId)!;
    const selected = resolveImagePromptSelection({
      backend: 'openai', model: family.model, assetKind: 'character-sheet', imageVariant: 'five-view',
      manualRuleSetId: other.ruleId, manualPresetId: 'image-preset-character-sheet',
    });
    assert.equal(selected.ruleSet.id, other.ruleId);
    assert.equal(selected.ruleSource, 'manual');
    assert.equal(selected.preset.id, 'image-preset-character-sheet');
    assert.equal(selected.presetSource, 'manual');
    const crossBackend = resolveImagePromptSelection({
      backend: 'comfyui', model: family.model, assetKind: 'character', manualRuleSetId: family.ruleId,
    });
    assert.equal(crossBackend.ruleSet.id, family.ruleId);
    assert.equal(crossBackend.ruleSource, 'manual');
  }
});

test('only an explicit five-view layout recommends the matching family sheet', () => {
  const state = savedFactoryState();
  const before = structuredClone(state);
  for (const family of families) {
    const input = { backend: 'openai' as const, model: family.model, assetKind: 'character-sheet' as const, state };
    const selected = resolveImagePromptSelection({ ...input, imageVariant: 'five-view' });
    assert.equal(selected.preset.id, family.fiveViewId);
    assert.equal(selected.presetSource, 'variant-recommendation');
    for (const imageVariant of [undefined, 'turnaround', 'reference', 'full-body'] as const) {
      const ordinary = resolveImagePromptSelection({ ...input, imageVariant });
      assert.equal(ordinary.preset.id, ordinary.ruleSet.defaultPresetByAssetKind['character-sheet']);
      assert.equal(ordinary.presetSource, 'rule-default');
      assert.equal(fiveViewIds.has(ordinary.preset.id), false);
    }
    const character = resolveImagePromptSelection({ ...input, assetKind: 'character', imageVariant: 'full-body' });
    assert.equal(character.preset.assetKind, 'character');
    assert.equal(character.presetSource, 'rule-default');
  }
  assert.deepEqual(state, before);
});

test('edited rules and explicit sheet bindings opt out of five-view recommendations', () => {
  for (const family of families) {
    const state = savedFactoryState();
    const rule = state.ruleSets.find((candidate) => candidate.id === family.ruleId)!;
    const input = { backend: 'openai' as const, model: family.model, assetKind: 'character-sheet' as const, imageVariant: 'five-view' as const };
    for (const edited of [
      { ...rule, systemPrompt: 'USER_RULE_BODY', updatedAt: 123 },
      { ...rule, categoryPresetIds: rule.categoryPresetIds.filter((id) => id !== family.fiveViewId) },
    ]) {
      const current = { ...state, ruleSets: state.ruleSets.map((candidate) => candidate.id === rule.id ? edited : candidate) };
      const selected = resolveImagePromptSelection({ ...input, state: current });
      assert.equal(selected.ruleSet.id, family.ruleId);
      assert.equal(selected.preset.id, rule.defaultPresetByAssetKind['character-sheet']);
      assert.notEqual(selected.presetSource, 'variant-recommendation');
    }
    const rebound = {
      ...state,
      ruleSets: state.ruleSets.map((candidate) => candidate.id === rule.id ? {
        ...candidate,
        defaultPresetByAssetKind: { ...candidate.defaultPresetByAssetKind, 'character-sheet': 'image-preset-character-sheet' },
      } : candidate),
    };
    const selected = resolveImagePromptSelection({ ...input, state: rebound });
    assert.equal(selected.preset.id, 'image-preset-character-sheet');
    assert.equal(selected.presetSource, 'rule-default');
  }
});

test('edited, disabled and deleted sheet presets remain respected after storage round trips', () => {
  for (const family of families) {
    const state = savedFactoryState();
    const rule = state.ruleSets.find((candidate) => candidate.id === family.ruleId)!;
    const input = { backend: 'openai' as const, model: family.model, assetKind: 'character-sheet' as const, imageVariant: 'five-view' as const };
    for (const id of [rule.defaultPresetByAssetKind['character-sheet']!, family.fiveViewId]) {
      for (const edit of [{ name: 'USER_RENAMED' }, { systemPrompt: 'USER_PRESET_BODY', updatedAt: 456 }, { enabled: false }]) {
        const current = {
          ...state,
          categoryPresets: state.categoryPresets.map((preset) => preset.id === id ? { ...preset, ...edit } : preset),
        };
        const before = structuredClone(current);
        const selected = resolveImagePromptSelection({ ...input, state: current });
        assert.notEqual(selected.presetSource, 'variant-recommendation');
        assert.equal(fiveViewIds.has(selected.preset.id), false);
        assert.deepEqual(current, before);
      }
      const deleted = { ...state, categoryPresets: state.categoryPresets.filter((preset) => preset.id !== id) };
      const before = structuredClone(deleted);
      const selected = resolveImagePromptSelection({ ...input, state: deleted });
      assert.notEqual(selected.presetSource, 'variant-recommendation');
      assert.equal(fiveViewIds.has(selected.preset.id), false);
      assert.deepEqual(deleted, before);
    }
    const edited = { ...state.categoryPresets.find((preset) => preset.id === family.fiveViewId)!, systemPrompt: 'USER_FIVE_VIEW' };
    const manualState = { ...state, categoryPresets: state.categoryPresets.map((preset) => preset.id === edited.id ? edited : preset) };
    const manual = resolveImagePromptSelection({ ...input, manualPresetId: edited.id, state: manualState });
    assert.equal(manual.preset.systemPrompt, 'USER_FIVE_VIEW');
    assert.equal(manual.presetSource, 'manual');
  }
});

test('removed or disabled family rules fall back without being restored by selection', () => {
  for (const family of families) {
    const state = savedFactoryState();
    for (const ruleSets of [
      state.ruleSets.filter((rule) => rule.id !== family.ruleId),
      state.ruleSets.map((rule) => rule.id === family.ruleId ? { ...rule, enabled: false } : rule),
    ]) {
      const current = { ...state, ruleSets };
      const before = structuredClone(current);
      const input = { backend: 'openai' as const, model: family.model, assetKind: 'character' as const, state: current };
      assert.notEqual(resolveImagePromptSelection(input).ruleSet.id, family.ruleId);
      assert.throws(() => resolveImagePromptSelection({ ...input, manualRuleSetId: family.ruleId }), /不存在|已禁用/u);
      assert.deepEqual(current, before);
    }
  }
});

test('catalog seventeen adds both families once and preserves existing records and defaults', () => {
  const legacy = legacyState();
  legacy.ruleSets[0] = { ...legacy.ruleSets[0], name: 'USER_RULE', systemPrompt: 'USER_RULE_BODY', updatedAt: 123 };
  legacy.categoryPresets[0] = { ...legacy.categoryPresets[0], outputRules: 'USER_OUTPUT', enabled: false, updatedAt: 456 };
  legacy.defaultRuleSetByBackend.openai = 'image-rule-generic';
  const before = structuredClone(legacy);
  const migrated = migrateImagePromptRulesState(legacy);
  assert.ok(IMAGE_PROMPT_RULE_CATALOG_VERSION >= 18);
  assert.equal(migrated.catalogVersion, IMAGE_PROMPT_RULE_CATALOG_VERSION);
  assert.deepEqual(migrated.ruleSets.slice(0, before.ruleSets.length), before.ruleSets);
  assert.deepEqual(migrated.categoryPresets.slice(0, before.categoryPresets.length), before.categoryPresets);
  assert.deepEqual(new Set(migrated.ruleSets.slice(before.ruleSets.length).map((rule) => rule.id)), familyRuleIds);
  assert.deepEqual(new Set(migrated.categoryPresets.slice(before.categoryPresets.length).map((preset) => preset.id)), familyPresetIds);
  assert.deepEqual(migrated.defaultRuleSetByBackend, before.defaultRuleSetByBackend);
  assert.deepEqual(legacy, before, 'migration must not mutate saved task libraries');
  const persisted = normalizeImagePromptRulesState(JSON.parse(JSON.stringify(migrated)));
  assert.deepEqual(migrateImagePromptRulesState(persisted), persisted);
});

test('catalog migration preserves colliding user records including disabled family entries', () => {
  const legacy = legacyState();
  const current = savedFactoryState();
  const customRule = {
    ...current.ruleSets.find((rule) => rule.id === GOOGLE_NANO_BANANA_RULE_ID)!,
    name: 'USER_GOOGLE_RULE', systemPrompt: 'USER_RULE_BODY', enabled: false, updatedAt: 789,
  };
  const customPreset: ImagePromptCategoryPreset = {
    ...current.categoryPresets.find((preset) => preset.id === MODEL_FAMILY_FIVE_VIEW_PRESET_IDS.grok)!,
    name: 'USER_GROK_SHEET', outputRules: 'USER_SHEET_OUTPUT', enabled: false, updatedAt: 987,
  };
  const input = {
    ...legacy, ruleSets: [...legacy.ruleSets, customRule], categoryPresets: [...legacy.categoryPresets, customPreset],
    defaultRuleSetByBackend: { ...legacy.defaultRuleSetByBackend, openai: customRule.id },
  };
  const before = structuredClone(input);
  const migrated = migrateImagePromptRulesState(input);
  assert.deepEqual(migrated.ruleSets.find((rule) => rule.id === customRule.id), customRule);
  assert.deepEqual(migrated.categoryPresets.find((preset) => preset.id === customPreset.id), customPreset);
  assert.equal(migrated.ruleSets.filter((rule) => rule.id === customRule.id).length, 1);
  assert.equal(migrated.categoryPresets.filter((preset) => preset.id === customPreset.id).length, 1);
  assert.deepEqual(migrated.defaultRuleSetByBackend, before.defaultRuleSetByBackend);
  assert.deepEqual(input, before);
});

test('deleting family rules or presets after catalog eighteen never resurrects them', () => {
  const current = savedFactoryState();
  for (const deleted of [
    {
      ...current,
      ruleSets: current.ruleSets.filter((rule) => rule.id !== GOOGLE_NANO_BANANA_RULE_ID),
      categoryPresets: current.categoryPresets.filter((preset) => preset.id !== MODEL_FAMILY_FIVE_VIEW_PRESET_IDS.grok),
    },
    {
      ...current,
      ruleSets: current.ruleSets.filter((rule) => !familyRuleIds.has(rule.id)),
      categoryPresets: current.categoryPresets.filter((preset) => !familyPresetIds.has(preset.id)),
    },
  ]) {
    assert.deepEqual(migrateImagePromptRulesState(JSON.parse(JSON.stringify(deleted))), deleted);
    assert.deepEqual(normalizeImagePromptRulesState(deleted), deleted);
  }
});

test('empty and custom-only libraries do not receive unsolicited model families', () => {
  const legacy = legacyState();
  const customPreset = { ...legacy.categoryPresets[0], id: 'user-preset', enabled: true };
  const customRule = {
    ...legacy.ruleSets[0], id: 'user-rule', categoryPresetIds: [customPreset.id],
    defaultPresetByAssetKind: { [customPreset.assetKind]: customPreset.id },
  };
  for (const input of [
    { ...legacy, ruleSets: [], categoryPresets: [], defaultRuleSetByBackend: {} },
    { ...legacy, ruleSets: [customRule], categoryPresets: [customPreset], defaultRuleSetByBackend: { openai: customRule.id } },
  ]) {
    const before = structuredClone(input);
    assert.deepEqual(migrateImagePromptRulesState(input), { ...input, catalogVersion: IMAGE_PROMPT_RULE_CATALOG_VERSION });
    assert.deepEqual(input, before);
  }
  const future = { ...legacy, catalogVersion: 99 };
  assert.deepEqual(migrateImagePromptRulesState(future), future);
});

let passed = 0;
for (const item of tests) {
  try {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name}`);
  } catch (error) {
    console.error(`FAIL ${item.name}`);
    throw error;
  }
}
console.log(`image prompt model families: ${passed}/${tests.length} passed`);
