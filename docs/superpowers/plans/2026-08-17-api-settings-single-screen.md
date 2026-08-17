# API Settings Single-Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every API category immediately discoverable and keep the active API settings panel fully visible without page scrolling at supported desktop window sizes.

**Architecture:** Keep all existing API configuration data and handlers in `SettingsView`, but separate display navigation from model API targets with a five-value `SettingsPanel` state. Render one panel at a time inside a fixed-height grid and validate the contract with static CSS/markup tests plus real browser measurements.

**Tech Stack:** React 18, TypeScript, CSS Grid, Node test scripts, Vite, Electron, Browser/Playwright QA, electron-builder.

---

### Task 1: Add failing single-screen regression coverage

**Files:**
- Modify: `scripts/styles.test.ts`
- Modify: `scripts/uiSmoke.mjs`
- Modify: `scripts/webQa.mjs`

- [ ] **Step 1: Replace the old natural-height settings assertion**

Add assertions requiring the final `.settings-view` rule to use `height: 100%`, a bounded grid with `minmax(0, 1fr)`, and hidden page overflow. Add source assertions that `SettingsPanel` includes `image`, `text`, `vision`, `video`, and `credentials`, and defaults to `image`.

```ts
assert.equal(cssProperty('.settings-view', 'height', 'settings workspace'), '100%');
assert.match(cssProperty('.settings-view', 'grid-template-rows', 'settings workspace'), /minmax\(0, 1fr\)/u);
assert.equal(cssProperty('.settings-view', 'overflow', 'settings workspace'), 'hidden');
```

- [ ] **Step 2: Add runtime vertical-overflow and image-panel checks**

When UI smoke opens “API 设置”, measure `.workspace`, click the visible “图片 API” tab, and require the image card and its key fields to remain inside the workspace.

```js
const apiLayout = await evaluate(`(() => {
  const workspace = document.querySelector('.workspace');
  const card = document.querySelector('.image-api-card');
  const workspaceRect = workspace?.getBoundingClientRect();
  const cardRect = card?.getBoundingClientRect();
  return {
    overflowY: Boolean(workspace && workspace.scrollHeight > workspace.clientHeight + 1),
    cardVisible: Boolean(cardRect && workspaceRect && cardRect.bottom <= workspaceRect.bottom + 1),
  };
})()`);
```

- [ ] **Step 3: Run the targeted tests and verify RED**

Run: `npm run test:styles` and the API-focused UI smoke path.  
Expected: FAIL because `.settings-view` is still `height:auto`, only three tabs exist, and the image panel is not the default first panel.

### Task 2: Rebuild SettingsView around five top-level panels

**Files:**
- Modify: `src/App.tsx:8446-9394`

- [ ] **Step 1: Add independent display state**

```tsx
type ApiTarget = 'text' | 'vision' | 'image';
type SettingsPanel = 'image' | 'text' | 'vision' | 'video' | 'credentials';
const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>('image');
```

- [ ] **Step 2: Move all five entry buttons above the active panel**

Render buttons in this order: 图片 API、文本 API、视觉 API、视频任务、密码本. Use `aria-pressed` and the existing color classes so the current panel is explicit and keyboard accessible.

```tsx
<button aria-pressed={settingsPanel === 'image'} onClick={() => setSettingsPanel('image')}>
  <ImageIcon size={14} />图片 API
</button>
```

- [ ] **Step 3: Conditionally render video and credential cards**

Wrap the existing cards without changing their field handlers:

```tsx
{settingsPanel === 'video' && <Card className="api-card video-api-card api-tone-cyan">...</Card>}
{settingsPanel === 'credentials' && <Card className="credential-book-card credential-panel-card api-tone-amber">...</Card>}
```

- [ ] **Step 4: Rename and reuse model panel conditions**

Replace `apiPanel` checks with `settingsPanel` checks. Keep `renderProfileTools`, `renderCredentialFill`, `patchText`, `patchVision`, and `patchImage` unchanged.

- [ ] **Step 5: Run TypeScript and targeted tests**

Run: `npm run build` and `npm run test:styles`.  
Expected: TypeScript succeeds; static tests may remain red only until the CSS task is complete.

### Task 3: Enforce a readable fixed-height settings workspace

**Files:**
- Modify: `src/styles.css:497-538`
- Modify: `src/styles.css:854-891`

- [ ] **Step 1: Restore fixed-height grid behavior**

```css
.settings-view {
  height: 100%;
  min-height: 0;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  align-content: stretch;
  overflow: hidden;
}
.settings-panel-stage { min-height: 0; display: grid; overflow: hidden; }
```

- [ ] **Step 2: Keep every active card within the remaining row**

```css
.settings-panel-stage > .card,
.settings-panel-stage > .api-grid { min-height: 0; height: 100%; }
.single-api-grid .api-card { height: 100%; align-content: start; }
```

- [ ] **Step 3: Compact the video and credential panels without shrinking text**

Use four columns for `.video-api-fields` and the existing five-column credential manager at normal desktop width. Preserve input and label font sizes at or above current accessible minimums.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run: `npm run test:styles`, `npm run build`.  
Expected: both exit 0.

### Task 4: Verify the rendered interaction at supported viewports

**Files:**
- Modify if needed: `scripts/uiSmoke.mjs`
- Modify if needed: `scripts/webQa.mjs`
- QA artifacts: outside committed source or existing managed `.qa-*` directories

- [ ] **Step 1: Start the exact local Vite target**

Run the existing web QA harness using dynamic ports.

- [ ] **Step 2: Exercise the target flow**

Flow: app loads → API 设置 → five tabs visible → 图片 API active by default → switch through text, vision, video, and credentials → each panel is visible and workspace remains at scrollTop 0.

- [ ] **Step 3: Verify 1120×720, 1280×720, and 1280×800**

For each viewport assert:

```js
workspace.scrollHeight <= workspace.clientHeight + 1
workspace.scrollWidth <= workspace.clientWidth + 1
activePanelRect.bottom <= workspaceRect.bottom + 1
```

Capture screenshots and check console errors/warnings and framework overlays.

- [ ] **Step 4: Run Electron desktop QA**

Run the existing Electron smoke/desktop QA against an isolated data directory and confirm the same tab interaction and layout.

### Task 5: Upgrade and deliver version 0.5.2

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `启动莲华视频导演台-EXE.bat`
- Create: `发布说明-0.5.2.md`

- [ ] **Step 1: Update all current-version references**

Set the package version to `0.5.2`, rename the delivery script to `deliver:0.5.2`, point the launcher to the 0.5.2 EXE, and describe the API single-screen change in the new release notes.

- [ ] **Step 2: Run the full verification gate**

Run: `npm test`, `npm run build`, web QA, and Electron desktop QA.  
Expected: all commands exit 0 with no relevant console errors or overflow findings.

- [ ] **Step 3: Build and smoke-test the portable executable**

Run: `npm run pack:win`, then `npm run test:packaged` with an isolated data directory and dynamic CDP port.  
Expected: UI reports `v0.5.2`; save, reload, restore point, encryption, and no-overflow checks pass.

- [ ] **Step 4: Generate and verify delivery artifacts**

Run: `$env:DELIVERY_DIR = Join-Path $PWD '交付'; npm run deliver:0.5.2`. Recompute each SHA256 entry, require release and delivery EXE hashes to match, and compare critical source ZIP entries to the working tree.

- [ ] **Step 5: Preserve earlier releases**

Confirm the existing 0.5.0 and 0.5.1 delivery files remain untouched beside the new 0.5.2 files.
