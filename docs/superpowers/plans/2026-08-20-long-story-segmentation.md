# Long-Story Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a long-story planning stage that estimates or accepts a full-film duration, divides the source into user-configurable generation-length video segments, and sends every segment through the existing storyboard prompt workflow.

**Architecture:** Add `VideoSequencePlan` above the existing `Storyboard` model; each `VideoSegment` owns global timing and continuity handoff metadata while linking to one ordinary Storyboard whose shots retain local 0–N timing. Put deterministic beat extraction, duration allocation, validation, and plan mutation in focused pure modules; use the text API only to rank beat boundaries and describe continuity, with local fallback and validation around every response.

**Tech Stack:** React 18, TypeScript, Vite, Electron, Node test scripts through `tsx`, existing text API adapter and local JSON persistence.

---

### Task 1: Persist sequence plans without breaking old projects

**Files:**
- Modify: `src/types.ts:273-405`
- Modify: `src/storage.ts:23-584`
- Modify: `src/stateIntegrity.ts:16-49`
- Modify: `scripts/storage.test.ts`
- Modify: `scripts/integrity.test.ts`

- [ ] **Step 1: Write failing schema migration assertions**

Add assertions that `normalizeState()` upgrades a schema-v5 project to schema 6, adds `project.sequencePlans = []`, preserves old storyboards, and retains supplied sequence plans. Add integrity fixtures with a segment pointing to a missing storyboard and assert a warning is produced.

```ts
assert.equal(normalized.schemaVersion, 6);
assert.deepEqual(normalized.project.sequencePlans, []);
assert.equal(normalized.project.storyboards[0]?.id, legacyBoard.id);
assert.match(diagnostic.warnings.join('\n'), /视频段.*分镜/u);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:storage && npm run test:integrity`

Expected: failure because schema 6 and `sequencePlans` do not exist.

- [ ] **Step 3: Add exact persisted types**

Add `SequenceDurationMode`, `SequenceSegmentationMode`, `SequenceFitStatus`, `VideoSegmentStatus`, `VideoSegment`, and `VideoSequencePlan` to `src/types.ts`. Add `sequencePlans: VideoSequencePlan[]` to `Project`, optional sequence metadata to `Storyboard`, and optional plan/segment metadata to `VideoGenerationTask`.

```ts
export type SequenceDurationMode = 'ai-estimated' | 'fixed';
export type SequenceSegmentationMode = 'natural' | 'fixed';
export type SequenceFitStatus = 'comfortable' | 'balanced' | 'compressed' | 'insufficient';
export type VideoSegmentStatus = 'planned' | 'generating' | 'ready' | 'stale' | 'failed';

export interface VideoSegment {
  id: string;
  index: number;
  title: string;
  globalStartSec: number;
  globalEndSec: number;
  durationSec: number;
  content: string;
  summary: string;
  sourceSceneIds: string[];
  sourceBeatIds: string[];
  narrativePurpose: string;
  entryState: string;
  exitState: string;
  transitionHint: string;
  storyboardId?: string;
  status: VideoSegmentStatus;
  locked?: boolean;
}

export interface VideoSequencePlan {
  id: string;
  title: string;
  sourceStoryTitle: string;
  sourceStoryContent: string;
  durationMode: SequenceDurationMode;
  requestedTotalDurationSec?: number;
  totalDurationSec: number;
  segmentDurationSec: number;
  segmentationMode: SequenceSegmentationMode;
  fitStatus: SequenceFitStatus;
  estimateReason?: string;
  segments: VideoSegment[];
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 4: Implement schema 6 normalization and diagnostics**

Set `CURRENT_SCHEMA_VERSION = 6`, initialize new projects with `sequencePlans: []`, normalize incoming plans defensively, and add dangling plan→segment→storyboard checks without deleting partial imports.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm run test:storage && npm run test:integrity`

Expected: both scripts pass.

- [ ] **Step 6: Review the staged diff before any commit**

Run: `git diff -- src/types.ts src/storage.ts src/stateIntegrity.ts scripts/storage.test.ts scripts/integrity.test.ts`

Expected: only sequence-plan additions. Because these files already contain user work, do not commit if the staged diff includes unrelated edits.

### Task 2: Build the deterministic segmentation engine

**Files:**
- Create: `src/storySegmentation.ts`
- Create: `scripts/storySegmentation.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing behavior tests**

Cover beat extraction, local duration estimation, fixed and natural duration allocation, a short-tail case, complete beat coverage, local fallback plan creation, and validation.

```ts
const beats = extractStoryBeats('他推开门。屋内一片漆黑。怪兽从梁上扑下，他侧身闪避。');
assert.ok(beats.length >= 4);
assert.deepEqual(allocateSegmentDurations(24, 8, 'fixed'), [8, 8, 8]);
assert.deepEqual(allocateSegmentDurations(26, 8, 'natural'), [6.5, 6.5, 6.5, 6.5]);
assert.deepEqual(allocateSegmentDurations(24, 8, 'fixed', [4, 8]), [8, 8, 8]);
const plan = buildLocalSequencePlan({
  title: '测试剧情', story: beats.map((beat) => beat.text).join(''),
  totalDurationSec: 24, segmentDurationSec: 8, segmentationMode: 'fixed', sourceSceneIds: [],
});
assert.equal(plan.segments.length, 3);
assert.deepEqual(plan.segments.map((segment) => segment.durationSec), [8, 8, 8]);
assert.equal(new Set(plan.segments.flatMap((segment) => segment.sourceBeatIds)).size, beats.length);
assert.deepEqual(validateSequencePlan(plan), []);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx tsx scripts/storySegmentation.test.ts`

Expected: module-not-found for `src/storySegmentation.ts`.

- [ ] **Step 3: Implement focused pure functions**

Export these exact APIs:

```ts
export interface StoryBeat { id: string; index: number; text: string; weight: number; }
export interface LocalSequencePlanInput {
  title: string;
  story: string;
  totalDurationSec: number;
  segmentDurationSec: number;
  segmentationMode: SequenceSegmentationMode;
  sourceSceneIds: string[];
}

export const extractStoryBeats: (story: string) => StoryBeat[];
export const estimateStoryDurationLocally: (story: string) => {
  minSec: number; recommendedSec: number; maxSec: number;
  fitStatus: SequenceFitStatus; reason: string;
};
export const allocateSegmentDurations: (
  totalDurationSec: number,
  segmentDurationSec: number,
  mode: SequenceSegmentationMode,
  supportedDurationsSec?: number[],
) => number[];
export const buildLocalSequencePlan: (input: LocalSequencePlanInput) => VideoSequencePlan;
export const validateSequencePlan: (plan: VideoSequencePlan) => string[];
```

Beat splitting must use sentence and clause punctuation, then split an oversized remaining beat by text length. Allocation rounds to two decimals, keeps every duration positive and `<= segmentDurationSec`, and adjusts only the final value so the sum exactly equals the total. When `supportedDurationsSec` is supplied, every duration must belong to that list or the function throws an actionable incompatibility error instead of silently changing the total.

- [ ] **Step 4: Register and run the test**

Add `test:segmentation` to `package.json` and include it in `npm test`.

Run: `npm run test:segmentation`

Expected: `long-story segmentation regression checks passed`.

- [ ] **Step 5: Run existing prompt tests**

Run: `npm run test:prompt && npm run test:workflow`

Expected: both pass; no existing timeline semantics change.

### Task 3: Add validated AI planning as an optional enhancement

**Files:**
- Modify: `src/services/llm.ts`
- Modify: `scripts/storySegmentation.test.ts`

- [ ] **Step 1: Add failing parser and request-body tests**

Stub `window.lianhuaDesktop.request`, capture the chat requests, return fenced JSON responses, and assert duration estimation is parsed before the segmentation request and the segment parser accepts only known beat IDs and continuous ranges.

```ts
const estimate = await requestStoryDurationEstimate(textConfig, {
  title: '门后怪兽', story: beats.map((beat) => beat.text).join(''), beats,
});
assert.equal(estimate.recommendedSec, 24);
const result = await requestStorySegmentation(textConfig, {
  title: '门后怪兽', beats, totalDurationSec: 24,
  segmentDurations: [8, 8, 8], sourceSceneIds: ['scene_1'],
});
assert.equal(result.segments.length, 3);
assert.deepEqual(result.segments.flatMap((segment) => segment.sourceBeatIds), beats.map((beat) => beat.id));
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:segmentation`

Expected: `requestStoryDurationEstimate` and `requestStorySegmentation` are not exported.

- [ ] **Step 3: Implement the AI contract**

Add `requestStoryDurationEstimate(config, input)` that returns validated `minSec`, `recommendedSec`, `maxSec`, `fitStatus`, and `reason`. Then add `requestStorySegmentation(config, input)` that asks the model for a segment array containing only `sourceBeatIds`, `title`, `summary`, `narrativePurpose`, `entryState`, `exitState`, and `transitionHint` after local code has allocated the chosen total into concrete segment durations.

The service must reject unknown IDs, duplicate IDs, non-contiguous ranges, missing beats, or a segment count different from `segmentDurations.length`. Segment正文 is rebuilt locally from beats; AI prose never replaces source content.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm run test:segmentation`

Expected: local and AI cases pass.

### Task 4: Add pure plan editing and stale-propagation helpers

**Files:**
- Create: `src/sequencePlan.ts`
- Create: `scripts/sequencePlan.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing editing tests**

Test selecting by ID, updating segment 2, locking a segment, splitting, merging, reordering, linking a storyboard, and marking current/next segments stale.

```ts
const changed = updateSequenceSegment(plan, plan.segments[1].id, { summary: '新摘要' });
assert.equal(changed.segments[1].status, 'stale');
assert.equal(changed.segments[2].status, 'stale');
const linked = linkSegmentStoryboard(changed, changed.segments[0].id, 'board_1');
assert.equal(linked.segments[0].storyboardId, 'board_1');
assert.equal(linked.segments[0].status, 'ready');
```

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/sequencePlan.test.ts`

Expected: module-not-found for `src/sequencePlan.ts`.

- [ ] **Step 3: Implement immutable helpers**

Export `updateSequenceSegment`, `splitSequenceSegment`, `mergeSequenceSegments`, `reorderSequenceSegment`, `lockSequenceSegment`, `linkSegmentStoryboard`, `validateAndNormalizeSequencePlan`, and `sequencePlanSourceChanged` as pure functions. Every timing mutation recomputes indices and global start/end values before validation.

- [ ] **Step 4: Register and run tests**

Run: `npm run test:sequence-plan`

Expected: `sequence plan editing regression checks passed`.

### Task 5: Add the two-stage planner UI without increasing page height

**Files:**
- Modify: `src/App.tsx:770-1110`
- Modify: `src/App.tsx:3430-4190`
- Modify: `src/styles.css:610-810`
- Modify: `scripts/styles.test.ts`

- [ ] **Step 1: Add failing static UI assertions**

Assert the source exposes `single` and `sequence` production modes, stage buttons, AI/fixed total-duration controls, a segment filmstrip, and distinct current/all generation actions. Assert the planner and director panels occupy the same bounded stage.

```ts
assert.match(appSource, /单段直出/u);
assert.match(appSource, /长剧情拆段/u);
assert.match(appSource, /AI估算总时长/u);
assert.match(appSource, /分析并拆段/u);
assert.match(appSource, /生成当前段提示词/u);
assert.match(appSource, /顺序生成全部/u);
assert.match(css, /\.director-stage[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:styles`

Expected: missing long-story UI labels.

- [ ] **Step 3: Add App state and planning handlers**

Add production mode, sequence stage, duration mode, total duration, segmentation mode, active plan ID, active segment ID, and planning state. `analyzeAndCreateSequencePlan()` must build local beats first, call the AI planner only when configured, validate the result, then write one plan to `project.sequencePlans` through a functional state update.

For AI-estimated mode, call `requestStoryDurationEstimate()` first, let the user accept or override the recommended total, allocate concrete durations locally, and only then request beat grouping. For fixed mode, skip the estimate request.

- [ ] **Step 4: Render the reusable director stage**

Render `SequencePlannerPanel` when stage is `plan`; render the existing director controls when stage is `direct`. After confirmation, keep only the compact `SequenceFilmstrip` above the controls. Do not mount both full panels simultaneously.

The planning panel must expose editable segment summary/content, duration and handoff state plus split, merge, reorder and lock actions backed only by the pure helpers from Task 4.

- [ ] **Step 5: Add compact responsive CSS**

Use CSS grid for four planning controls, horizontal overflow only inside the filmstrip, and height-bounded stage content. At `max-height: 760px`, reduce gaps and help copy while keeping buttons at least 24px high.

- [ ] **Step 6: Run static tests and build**

Run: `npm run test:styles && npm run build`

Expected: both pass.

### Task 6: Generate an ordinary Storyboard for the selected video segment

**Files:**
- Modify: `src/App.tsx:1893-2210`
- Modify: `src/promptEngine.ts:424-535`
- Modify: `scripts/promptEngine.test.ts`
- Modify: `scripts/workflowFeatures.test.ts`

- [ ] **Step 1: Write failing local-time and continuity tests**

Create a segment with global time 8–16 seconds and assert its generated shots span local 0–8 seconds. Assert the entry state appears once in the global lock and the exit state appears in the final result constraint.

```ts
assert.equal(board.globalStartSec, 8);
assert.equal(board.globalEndSec, 16);
assert.equal(board.shots[0].startSec, 0);
assert.equal(board.shots.at(-1)?.endSec, 8);
assert.match(board.finalPrompt, /承接上一段/u);
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:prompt && npm run test:workflow`

Expected: segment metadata and continuity input are missing.

- [ ] **Step 3: Extract an explicit segment generation input**

Refactor the existing builder behind this signature while preserving the no-argument single-segment path:

```ts
interface StoryboardGenerationOverride {
  sequencePlanId: string;
  segment: VideoSegment;
  segmentCount: number;
}

const buildStoryboard = async (
  override?: StoryboardGenerationOverride,
): Promise<Storyboard | undefined>;
```

When override exists, construct a synthetic source scene from `segment.content`, set duration from `segment.durationSec`, attach sequence metadata, and add continuityIn/continuityOut. Pass a click wrapper `onClick={() => void buildStoryboard()}` so React never supplies a MouseEvent as the override.

- [ ] **Step 4: Link the generated board atomically**

In the same functional `setState`, insert or replace the Storyboard, link its ID into source scenes, and update the matching sequence segment to `ready` with `storyboardId`. Do not write the full-film duration into the board.

- [ ] **Step 5: Run tests and build**

Run: `npm run test:prompt && npm run test:workflow && npm run build`

Expected: segment and legacy paths pass.

### Task 7: Add serial all-segment generation, grouped browsing, and export

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/appEffects.ts`
- Modify: `scripts/appEffects.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing queue and ordering tests**

Test that the queue returns unlocked segments in index order, skips ready/locked segments unless explicitly selected, stops after cancellation, and resumes at the first planned/failed/stale segment.

```ts
assert.deepEqual(
  pendingSequenceSegmentIds(plan),
  plan.segments.filter((segment) => segment.status !== 'ready' && !segment.locked).map((segment) => segment.id),
);
```

- [ ] **Step 2: Implement queue selectors and cancellation identity**

Add pure selectors to `appEffects.ts`. In App, run `for...of` with one awaited generation at a time and a sequence operation identity containing project ID, plan ID, source snapshot, and cancellation epoch. Save after every segment.

- [ ] **Step 3: Group timeline navigation by plan**

In the storyboard switcher, render sequence plans as groups with segment buttons in order. Legacy boards remain in the existing ungrouped list. Selecting a segment activates its linked Storyboard.

- [ ] **Step 4: Add ordered export**

Build a deterministic TXT with a plan header and one section per segment containing global time, local duration, entry/exit state, and final prompt. Build a JSON manifest with the same order and IDs. Reuse `downloadText()`.

- [ ] **Step 5: Run tests**

Run: `npm run test:app-effects && npm run test:workflow && npm run test:storyboard-versions`

Expected: all pass.

### Task 8: Complete end-to-end verification and release packaging

**Files:**
- Modify: `scripts/workflowUiSmoke.mjs`
- Modify: `scripts/workflowUiSmoke.test.mjs`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `发布说明-0.5.6.md`

- [ ] **Step 1: Extend UI smoke checks**

At 1120×720 and 1280×720, verify single/sequence mode switching, AI/fixed duration controls, custom segment seconds, plan creation, segment switching, zero workspace overflow, visible generation actions, and no console errors.

- [ ] **Step 2: Run targeted tests**

Run: `npm run test:segmentation && npm run test:sequence-plan && npm run test:storage && npm run test:prompt && npm run test:styles && npm run test:workflow-smoke-unit`

Expected: all pass.

- [ ] **Step 3: Run full verification**

Run: `npm test`

Expected: every suite passes.

Run: `npm run build`

Expected: TypeScript and Vite build pass.

Run: `git diff --check`

Expected: exit 0; line-ending notices are acceptable.

- [ ] **Step 4: Perform real UI QA**

Use the project Playwright workflow at 1120×720, 1280×720, and 1280×800. Confirm the planner replaces rather than stacks above the director controls, the filmstrip alone scrolls horizontally when needed, current-segment prompts use local 0–N timing, and no element overlaps its siblings.

- [ ] **Step 5: Version and package**

Set package and launcher metadata to 0.5.6, write release notes covering long-story segmentation and compatibility, run `npm run pack:win`, `npm run deliver:0.5.6`, packaged smoke with explicit isolated data/output directories, `npm run test:package`, and verify every SHA-256 manifest entry.
