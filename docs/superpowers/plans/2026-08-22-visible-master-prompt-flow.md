# Visible Master Prompt Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hidden one-click long-story pipeline with a persisted, visible generate-review-confirm-split workflow.

**Architecture:** Persist the workflow phase on `VideoSequencePlan` and keep the authoritative master prompt in its linked `Storyboard`. Separate the existing combined planner function into master generation and confirmed segmentation, while a focused pure module parses/retimes user-edited canonical timeline entries.

**Tech Stack:** React 18, TypeScript, Electron, Vite, Node test scripts, Playwright.

---

### Task 1: Add master-prompt phase and parsing primitives

**Files:**
- Modify: `src/types.ts`
- Create: `src/masterTimeline.ts`
- Create: `scripts/masterTimeline.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for canonical entry parsing, same-count edits, local retiming, and confirmation fingerprints**

Tests must assert that `parseMasterTimelinePrompt` rejects missing fields, gaps, overlaps, wrong final duration, and changed shot counts; `applyMasterPromptEdit` preserves IDs/metadata while updating `startSec`, `endSec`, and `prompt`; `retimeMasterShotPrompt` changes only the leading timestamp; and `masterPromptConfirmationFingerprint` changes when story, duration, prompt, or shot timing changes.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm run test:master-timeline`

Expected: failure because `src/masterTimeline.ts` and the script do not exist.

- [ ] **Step 3: Add the persisted planning types**

Add to `VideoSequencePlan`:

```ts
planningStage?: 'master-draft' | 'master-confirmed' | 'segmented';
masterPromptConfirmedFingerprint?: string;
masterPromptConfirmedAt?: number;
```

- [ ] **Step 4: Implement the pure timeline helpers**

Export these exact signatures:

```ts
export interface ParsedMasterPromptEntry {
  startSec: number;
  endSec: number;
  prompt: string;
}

export function parseMasterTimelinePrompt(
  prompt: string,
  expectedDurationSec: number,
): ParsedMasterPromptEntry[];

export function applyMasterPromptEdit(
  shots: readonly VideoShot[],
  prompt: string,
  expectedDurationSec: number,
): VideoShot[];

export function retimeMasterShotPrompt(
  prompt: string,
  localStartSec: number,
  localEndSec: number,
): string;

export function masterPromptConfirmationFingerprint(
  plan: Pick<VideoSequencePlan, 'id' | 'sourceStoryContent' | 'totalDurationSec' | 'masterStoryboardId'>,
  board: Pick<Storyboard, 'id' | 'finalPrompt' | 'shots'>,
): string;
```

- [ ] **Step 5: Register and run the focused test**

Add `"test:master-timeline": "tsx scripts/masterTimeline.test.ts"` to `package.json` and include it in `npm test`.

Expected: all master-timeline checks pass.

### Task 2: Normalize and validate persisted planning phases

**Files:**
- Modify: `src/storage.ts`
- Modify: `src/storySegmentation.ts`
- Modify: `src/stateIntegrity.ts`
- Modify: `scripts/storage.test.ts`
- Modify: `scripts/sequencePlan.test.ts`
- Modify: `scripts/integrity.test.ts`

- [ ] **Step 1: Add failing migration tests**

Cover a `master-draft` plan with zero segments, a `master-confirmed` plan with a valid confirmation fingerprint, and a legacy plan with segments but no `planningStage`.

- [ ] **Step 2: Run storage/integrity tests and confirm failure**

Run: `npm run test:storage && npm run test:sequence-plan && npm run test:integrity`

- [ ] **Step 3: Implement normalization**

Normalize legacy non-empty plans to `segmented`; retain valid draft/confirmed stages with empty segments; trim confirmation fields; and clear impossible confirmed metadata when the master storyboard is missing.

- [ ] **Step 4: Split validation responsibilities**

`validateSequencePlan` continues to require segments for `segmented` plans. Draft/confirmed plans use master-storyboard validation and may have zero segments. State diagnostics must distinguish “总提示词待确认” from broken/missing master data.

- [ ] **Step 5: Run focused tests**

Expected: migration and diagnostic checks pass without weakening segmented-plan validation.

### Task 3: Separate master generation from segmentation

**Files:**
- Modify: `src/App.tsx`
- Modify: `scripts/workflowFeatures.test.ts`

- [ ] **Step 1: Replace the old source assertion with failing three-stage assertions**

Assert that `分析并拆段` is absent and these functions/buttons exist:

```ts
generateSequenceMasterPrompt
confirmSequenceMasterPrompt
segmentConfirmedMasterPrompt
① 生成全片总提示词
确认总提示词
② 按总提示词切段
```

Also assert that master generation commits a plan with `segments: []` and `planningStage: 'master-draft'`, while only `segmentConfirmedMasterPrompt` calls `requestStorySegmentation` and `sliceMasterShotsForSegment`.

- [ ] **Step 2: Run workflow tests and confirm failure**

Run: `npm run test:workflow`

- [ ] **Step 3: Extract master generation**

Rename/split `analyzeAndCreateSequencePlan`. `generateSequenceMasterPrompt` performs optional estimation, builds the full storyboard, persists the board and draft plan, clears segment selection, and stops on the review stage.

- [ ] **Step 4: Implement edit and confirmation actions**

`updateSequenceMasterPrompt` persists raw text and clears confirmation. `confirmSequenceMasterPrompt` parses the text into shots, validates the board, stores the exact fingerprint, changes the stage to `master-confirmed`, and never creates segments.

- [ ] **Step 5: Implement confirmed segmentation**

`segmentConfirmedMasterPrompt` verifies the stored fingerprint against live plan/board data, performs local/AI beat grouping, slices master shots, stores `sourceShotIds`, changes stage to `segmented`, and clears the ordinary segment-review fingerprint.

- [ ] **Step 6: Stabilize async identities**

Master-draft text/status writes must not invalidate their own commit. Story, duration, project, and master-board identity changes must still reject stale async results.

- [ ] **Step 7: Run workflow and build checks**

Run: `npm run test:workflow && npm run build`

Expected: source regression and TypeScript build pass.

### Task 4: Make all three stages visible in the planner

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `scripts/styles.test.ts`
- Modify: `scripts/sequenceUiQa.mjs`

- [ ] **Step 1: Add failing UI/source tests**

Require a `.sequence-master-review` card, editable `全片总视频提示词` textarea, validation message, copy/regenerate/confirm buttons, and a separate split button. Require the segment workspace to remain absent after master generation.

- [ ] **Step 2: Run UI/source tests and confirm failure**

Run: `npm run test:styles && npm run test:ui-sequence`

- [ ] **Step 3: Implement stage-specific rendering**

Setup stage shows duration controls and `① 生成全片总提示词`. Review stage shows the full prompt editor. Confirmed stage additionally enables `② 按总提示词切段`. Segmented stage shows the existing filmstrip/editor and `确认分段，进入③单段导演`.

- [ ] **Step 4: Preserve compact desktop layout**

The master review textarea occupies the flexible center region; its actions stay in a fixed footer. At 1120×720, 1280×720, and 1280×800 there must be no document/workspace overflow or covered controls.

- [ ] **Step 5: Rewrite the browser flow smoke**

The smoke must verify in order: zero segments after master generation, visible prompt, disabled split before confirmation, persisted review after reload, editable prompt invalidates confirmation, confirmation enables split, 24-second/8-second split yields three segments, and all local prompts begin at 0 seconds.

- [ ] **Step 6: Run browser verification**

Run a preview server and `npm run test:ui-sequence`.

Expected: all three viewports and the three-stage behavioral flow pass with no console errors.

### Task 5: Preserve confirmed master text in generated segments and exports

**Files:**
- Modify: `src/sequencePlan.ts`
- Modify: `src/App.tsx`
- Modify: `src/appEffects.ts`
- Modify: `scripts/sequencePlan.test.ts`
- Modify: `scripts/appEffects.test.ts`

- [ ] **Step 1: Add failing retiming/export tests**

Verify a master shot crossing an 8-second boundary appears in both segments with clipped local timestamps, edited body text survives unchanged, and TXT/JSON exports contain both master and derived local prompts.

- [ ] **Step 2: Preserve and retime `shot.prompt` during slicing**

`sliceMasterShotsForSegment` must call `retimeMasterShotPrompt` instead of clearing `prompt`.

- [ ] **Step 3: Stop rebuilding master-derived prompt bodies**

For segment generation with a master slice, compose `finalPrompt` and `promptPlan.canonicalPrompt` from the retimed slice prompts after continuity metadata is built. Do not call the segment-story renderer over those prompt bodies.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:sequence-plan && npm run test:app-effects && npm run test:workflow`.

### Task 6: Version, package, and verify 0.5.12

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `发布说明-0.5.12.md`
- Modify: versioned launcher/delivery expectations in `scripts/createDelivery.test.mjs`

- [ ] **Step 1: Bump version metadata to 0.5.12**

Update package metadata, README package name, launcher matching, delivery command, and release-review expectations.

- [ ] **Step 2: Run full source verification**

Run: `npm test && npm run build && git diff --check`

Expected: exit code 0; only the existing non-blocking Vite chunk-size warning may remain.

- [ ] **Step 3: Run the real browser workflow**

Run: `npm run test:ui-sequence`

Expected: visible three-stage flow passes at all supported viewports.

- [ ] **Step 4: Build and test the portable executable**

Run: `npm run pack:win`, then run `npm run test:packaged` with isolated `APP_EXECUTABLE`, `LIANHUA_DATA_DIR`, `EXPECTED_DATA_DIR`, and `QA_OUTPUT` values.

- [ ] **Step 5: Create and hash the delivery**

Run: `npm run deliver:0.5.12`, compare release/delivery EXE SHA-256 values, and verify every manifest entry.

