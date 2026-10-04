# 28×28 Visual Style Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 28 one-to-one visual styles and editable presets, auto-link them in the director UI, and inject concrete style anchors into every generated shot.

**Architecture:** Create a pure `visualStyles.ts` catalog shared by UI, persistence, and prompt rendering. Preserve saved names/IDs, add a schema-8 migration for only newly introduced preset IDs, and keep UI linking event-driven so loading an old project does not mutate it.

**Tech Stack:** TypeScript, React 18, Vite, Electron, Node `assert` regression scripts.

---

### Task 1: Pure visual-style catalog

**Files:**
- Create: `src/visualStyles.ts`
- Create: `scripts/visualStyles.test.ts`
- Modify: `package.json`

- [ ] Write a failing catalog test asserting 28 unique IDs/names/preset IDs, complete anchors and one-to-one presets.
- [ ] Run `npx tsx scripts/visualStyles.test.ts`; expect failure because the module does not exist.
- [ ] Implement `visualStyleDefinitions`, `findVisualStyleDefinition`, `resolveVisualStylePrompt`, `matchedStylePresetId`, and `createBuiltInVisualStylePresets(timestamp)`.
- [ ] Add `test:visual-styles` and include it in `npm test`.
- [ ] Run `npm run test:visual-styles`; expect pass.

### Task 2: Storage defaults and schema-8 migration

**Files:**
- Modify: `src/storage.ts`
- Modify: `scripts/storage.test.ts`
- Modify: `scripts/integrity.test.ts`

- [ ] Write failing tests for 28 new-project presets and schema-7 migration that appends 24 new IDs while preserving edits, custom presets, deleted legacy presets, and idempotence.
- [ ] Run `npm run test:storage && npm run test:integrity`; expect migration assertions to fail.
- [ ] Generate `defaultStylePresets` from the catalog, raise `CURRENT_SCHEMA_VERSION` to 8, and append only `NEW_VISUAL_STYLE_PRESET_IDS` when loading schema below 8.
- [ ] Re-run storage and integrity tests; expect pass.

### Task 3: UI linking and prompt anchors

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/promptEngine.ts`
- Modify: `scripts/workflowFeatures.test.ts`
- Modify: `scripts/promptEngine.test.ts`

- [ ] Write failing tests that require the App dropdown to consume the shared catalog, require selection to call a pure linked-selection helper, and require wasteland anchors without a generic realism suffix.
- [ ] Run `npm run test:workflow && npm run test:prompt`; expect the new assertions to fail.
- [ ] Replace the local option array with the shared catalog and add `applyVisualStyleSelection(name, availablePresetIds, currentPresetId)` returning `{ visualStyle, stylePresetId, matched }`.
- [ ] Wire the dropdown to apply the matching preset and notify; leave manual preset selection independent.
- [ ] Resolve prompt anchors in `renderTimelineShot`; use a neutral fallback for `no_style` and a compatibility fallback for unknown saved names.
- [ ] Re-run workflow and prompt tests; expect pass.

### Task 4: Version, delivery, and verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `README.md`, launch scripts, delivery script metadata
- Create: `发布说明-0.5.15.md`
- Test: `scripts/createDelivery.test.mjs`

- [ ] Write/update release tests for 0.5.15 and verify they fail on 0.5.14 metadata.
- [ ] Increment all authoritative version locations to 0.5.15 and document the 28×28 library and wasteland preset.
- [ ] Run `npm test`, `npm run build`, `npm run test:ui-sequence`, and `npm run test:electron`.
- [ ] Run `npm run pack:win`, then packaged smoke against the produced 0.5.15 EXE at 1120×720, 1280×720, and 1280×800.
- [ ] Run `npm run deliver:0.5.15`, verify release/delivery hashes match, and preserve 0.5.14 artifacts.

No commits are created because the shared worktree already contains user-owned changes and the prior handoff explicitly prohibited committing them.
