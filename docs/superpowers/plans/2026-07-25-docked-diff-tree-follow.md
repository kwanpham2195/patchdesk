# Docked diff and passive file-tree follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the desktop review workbench docked while the Pierre CodeView scrolls through every file in All files mode and passively highlights the file being read in the file tree.

**Architecture:** The diff surface emits a de-duplicated passive path from Pierre's public item-top metrics after its existing native scroll handler runs. Each workbench keeps that `activePath` separate from its explicit `selectedPath`; the former updates only the tree's presentation, while the latter continues to control finding navigation, the inspector, and direct diff jumps. The direct workbench receives the same fixed-height overflow boundary already used by the completed-review workbench.

**Tech Stack:** React 19, TypeScript, Tailwind/shadcn Base UI wrappers, `@pierre/diffs` 1.2.12, `@pierre/trees` 1.0.0-beta.5, Vitest, Testing Library, Playwright, packaged Electron CDP QA.

## Global Constraints

- Do not add Dockview or any other docking dependency; the existing CSS grid and flex layout is the fixed desktop layout contract.
- At `min-width: 1280px`, retain the 48px title bar, 232px application rail, 208px review navigator, and 336px inspector contract.
- In All files mode, CodeView is the only diff scroll owner. The workbench shell, header, rails, and inspector stay docked.
- Derive the passive path only from Pierre `CodeView.getTopForItem`; do not inspect rendered headers, poll the DOM, or run a second synchronization loop.
- Call the existing progressive stream scroll handler first. Do not add wheel or touch handlers, `preventDefault`, append-time scroll nudges, or global Pierre styling changes.
- Passive scrolling may update only `activePath`. It must not change `selectedPath`, selected finding/range, inspector contents, draft state, review context, local storage, or GitHub behavior.
- In Selected mode, do not emit passive updates. Tree clicks and keyboard navigation remain explicit selection actions and keep focus behavior.
- Use `model.selectOnlyPath(activePath)` and `model.scrollToPath(activePath, { focus: false, offset: "nearest" })` for the native tree highlight and minimal reveal. Guard that programmatic selection so it cannot call the parent `onSelect` callback.
- Preserve the existing all-files streaming and hydration batching, including the 1,000-file selection ceiling below 200ms in `tests/browser/performance.spec.ts`.
- The renderer remains isolated: no shell execution, privileged renderer work, token storage, GitHub writes, or confirmation-flow changes.

---

## File structure

- Create: `src/renderer/src/review-diff-active-file.ts` — pure, Pierre-independent active-path derivation from ordered loaded item IDs and item-top metrics.
- Create: `tests/renderer/review-diff-active-file.test.ts` — regression coverage for viewport-top derivation and missing metrics.
- Modify: `src/renderer/src/components/review-diff-view.tsx` — expose the optional passive callback and compose it with the existing progressive-scroll callback.
- Modify: `src/renderer/src/components/pierre-file-tree.tsx` — distinguish explicit navigation from passive native tree selection and use nearest-only tree reveal.
- Modify: `src/renderer/src/components/completed-review-workbench.tsx` — own a separate active path for the completed-review route and pass it only to the navigator.
- Modify: `src/renderer/src/components/diff-workbench.tsx` — own the same separate active path and constrain the direct route to a fixed desktop diff surface.
- Modify: `tests/renderer/review-workbench.ui.test.tsx` — prove that a passive update cannot overwrite a selected finding or its inspector state.
- Modify: `tests/renderer/diff-workbench.ui.test.tsx` — prove the direct workbench owns a fixed desktop scroll boundary and wires passive path updates separately.
- Modify: `tests/browser/milestone-9.spec.ts` — cover long-file transition, streamed-file transition, tree selection semantics, docked geometry, compact behavior, and overflow.

### Task 1: Derive the active file without renderer DOM inspection

**Files:**
- Create: `src/renderer/src/review-diff-active-file.ts`
- Create: `tests/renderer/review-diff-active-file.test.ts`

**Interfaces:**
- Consumes: ordered loaded CodeView item IDs, the native `scrollTop`, and a metric getter with Pierre's `getTopForItem(id)` behavior.
- Produces:

```ts
export type ActiveFileItem = { readonly id: string };

export function activeFilePathAtScrollTop(
  items: ReadonlyArray<ActiveFileItem>,
  scrollTop: number,
  getTopForItem: (id: string) => number | undefined,
): string | undefined;
```

- Later consumers: `ReviewDiffSurface` uses the returned path after `handleViewerScroll` completes. `undefined` means retain the currently highlighted tree row.

- [ ] **Step 1: Write the failing pure-function tests**

Create `tests/renderer/review-diff-active-file.test.ts` with ordered paths and fixed item positions. Cover the first file, a transition at the second file top, a path whose metric is not yet available, and an empty loaded list.

```ts
import { describe, expect, it } from "vitest";
import { activeFilePathAtScrollTop } from "../../src/renderer/src/review-diff-active-file";

const items = [{ id: "a.ts" }, { id: "b.ts" }, { id: "c.ts" }];
const positions = new Map([["a.ts", 0], ["b.ts", 320], ["c.ts", 640]]);
const topFor = (id: string): number | undefined => positions.get(id);

describe("activeFilePathAtScrollTop", () => {
  it("returns the last item at or above the CodeView viewport top", () => {
    expect(activeFilePathAtScrollTop(items, 319, topFor)).toBe("a.ts");
    expect(activeFilePathAtScrollTop(items, 320, topFor)).toBe("b.ts");
  });

  it("skips unavailable metrics and returns no replacement when none are measurable", () => {
    expect(activeFilePathAtScrollTop(items, 500, (id) => id === "a.ts" ? 0 : undefined)).toBe("a.ts");
    expect(activeFilePathAtScrollTop(items, 0, () => undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- --run tests/renderer/review-diff-active-file.test.ts`

Expected: FAIL because `review-diff-active-file` does not exist.

- [ ] **Step 3: Implement the smallest deterministic derivation**

Create `src/renderer/src/review-diff-active-file.ts`. Iterate in the supplied rendered order and retain the path with the largest defined top that is less than or equal to `scrollTop`; return `undefined` only when no item has a usable top at or above the viewport rule. Do not sort, read the DOM, or use a header element.

```ts
export type ActiveFileItem = { readonly id: string };

export function activeFilePathAtScrollTop(
  items: ReadonlyArray<ActiveFileItem>,
  scrollTop: number,
  getTopForItem: (id: string) => number | undefined,
): string | undefined {
  let activePath: string | undefined;
  let activeTop = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const top = getTopForItem(item.id);
    if (top !== undefined && top <= scrollTop && top >= activeTop) {
      activePath = item.id;
      activeTop = top;
    }
  }

  return activePath;
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/review-diff-active-file.test.ts`

Expected: PASS; the transition uses the exact second-file top and missing metrics do not invent a path.

- [ ] **Step 5: Commit the isolated helper and its tests**

```bash
git add src/renderer/src/review-diff-active-file.ts tests/renderer/review-diff-active-file.test.ts
git commit -m "feat: derive active diff file from Pierre metrics"
```

### Task 2: Emit a de-duplicated passive active path from CodeView

**Files:**
- Modify: `src/renderer/src/components/review-diff-view.tsx:103-119, 230-279, 473-500`
- Test: `tests/renderer/review-workbench.ui.test.tsx`

**Interfaces:**
- Consumes: `activeFilePathAtScrollTop`, `PierreCodeView<T>` from `use-progressive-review-diff-stream.ts`, `loadedCount`, and the existing `handleViewerScroll`.
- Produces:

```ts
type ReviewDiffViewProps = {
  readonly onActiveFileChange?: (path: string) => void;
};
```

- Behavior: only a native CodeView `onScroll` in `preferences.fileMode === "all"` can call `onActiveFileChange`; duplicate paths and missing metric results do not call it.

- [ ] **Step 1: Add a failing renderer interaction test for state separation**

In `tests/renderer/review-workbench.ui.test.tsx`, render a review with `src/a.ts` and `src/b.ts`, select the mapped finding on `src/b.ts`, then invoke the `ReviewDiffView` active-path prop through a narrowly mocked `ReviewDiffView`. Assert the review region still has `data-selected-path="src/b.ts"`, the inspector still says `Finding mapped · new lines 7–8`, and the tree receives the new active path without changing the selected finding.

```ts
expect(screen.getByLabelText("Review diff")).toHaveAttribute(
  "data-selected-path",
  "src/b.ts",
);
expect(screen.getByText(/Finding mapped · new lines/)).toBeTruthy();
expect(activeTreePaths.at(-1)).toBe("src/a.ts");
```

- [ ] **Step 2: Run the focused renderer test to verify it fails**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx`

Expected: FAIL because `ReviewDiffView` has no active-file callback and the workbench has no separate active-path state.

- [ ] **Step 3: Add the callback and compose the scroll handler**

In `ReviewDiffViewProps`, add the optional `onActiveFileChange` callback. In `ReviewDiffSurface`, keep an `activePathRef` so a scroll event only sends a changed path. Create `handleCodeViewScroll` that invokes the existing streaming handler first, returns immediately unless the mode is `"all"`, then calls the pure helper over `items.slice(0, loadedCount)` using `codeView.getTopForItem`.

```ts
const activePathRef = useRef<string | undefined>(undefined);

const handleCodeViewScroll = useCallback(
  (scrollTop: number, codeView: PierreCodeView<ReviewInlineAnnotation | undefined>): void => {
    handleViewerScroll(scrollTop, codeView);
    if (preferences.fileMode !== "all") return;

    const path = activeFilePathAtScrollTop(
      items.slice(0, loadedCount),
      scrollTop,
      (id) => codeView.getTopForItem(id),
    );
    if (path === undefined || path === activePathRef.current) return;
    activePathRef.current = path;
    onActiveFileChange?.(path);
  },
  [handleViewerScroll, items, loadedCount, onActiveFileChange, preferences.fileMode],
);
```

Pass `handleCodeViewScroll` to CodeView's `onScroll`. Reset `activePathRef.current` when `preferences.fileMode` or the ordered `items` identity changes, so a new all-files stream may report its first actually scrolled file. Do not emit an initial synthetic selection and do not call this callback from the selected-file scroll effect.

- [ ] **Step 4: Run the focused renderer test to verify it passes**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS; an active-path update does not replace the explicit finding navigation state.

- [ ] **Step 5: Commit the CodeView callback boundary**

```bash
git add src/renderer/src/components/review-diff-view.tsx tests/renderer/review-workbench.ui.test.tsx
git commit -m "feat: report active Pierre diff file"
```

### Task 3: Make Pierre tree following passive and minimally revealing

**Files:**
- Modify: `src/renderer/src/components/pierre-file-tree.tsx:1-18`
- Test: `tests/renderer/review-workbench.ui.test.tsx`

**Interfaces:**
- Consumes:

```ts
type PierreFileTreeProps = {
  readonly files: ReadonlyArray<PierreFileTreeItem>;
  readonly selectedPath?: string;
  readonly activePath?: string;
  readonly onSelect: (path: string) => void;
};
```

- Produces: one tree row selected through Pierre for `activePath`; direct tree pointer and keyboard selection still call `onSelect(path)` exactly once.

- [ ] **Step 1: Add failing tests for guarded tree selection**

Mock `useFileTree` in `tests/renderer/review-workbench.ui.test.tsx` so `selectOnlyPath` invokes its captured `onSelectionChange` synchronously. Render `PierreFileTree` with `activePath="src/a.ts"` and assert `onSelect` was not called. Re-render with a user-originated `onSelectionChange(["src/b.ts"])` and assert `onSelect("src/b.ts")` was called once. Assert passive reveal uses these exact options:

```ts
expect(model.selectOnlyPath).toHaveBeenCalledWith("src/a.ts");
expect(model.scrollToPath).toHaveBeenCalledWith("src/a.ts", {
  focus: false,
  offset: "nearest",
});
```

- [ ] **Step 2: Run the focused renderer test to verify it fails**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx`

Expected: FAIL because the tree has no `activePath` and passive programmatic selection is not guarded.

- [ ] **Step 3: Add the guarded active-path effect**

Extend `PierreFileTree` with `activePath`. Keep `selectedPath`'s current direct-navigation reveal with `{ focus: false }`. Add a ref that is true only while the effect invokes `model.selectOnlyPath(activePath)`. Have `onSelectionChange` return without calling `onSelect` when that ref is true. In the active effect, select only the active row and request a nearest reveal so an already-visible row does not move the tree viewport.

```ts
const applyingPassivePath = useRef(false);

const { model } = useFileTree({
  // existing paths, statuses, expansion, and search settings
  onSelectionChange: (paths) => {
    const path = paths[0];
    if (path !== undefined && !applyingPassivePath.current) onSelect(path);
  },
});

useEffect(() => {
  if (activePath === undefined) return;
  applyingPassivePath.current = true;
  model.selectOnlyPath(activePath);
  applyingPassivePath.current = false;
  model.scrollToPath(activePath, { focus: false, offset: "nearest" });
}, [activePath, model]);
```

Expose `data-active-path={activePath}` on `<FileTree>` for black-box assertions only; do not persist it or use it as a navigation input.

- [ ] **Step 4: Run the focused renderer tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS; programmatic passive highlights do not call the explicit navigation callback, while direct tree selection still does.

- [ ] **Step 5: Commit passive tree following**

```bash
git add src/renderer/src/components/pierre-file-tree.tsx tests/renderer/review-workbench.ui.test.tsx
git commit -m "feat: passively follow the active diff file in the tree"
```

### Task 4: Separate active and selected state in both workbenches and lock the direct desktop surface

**Files:**
- Modify: `src/renderer/src/components/completed-review-workbench.tsx:159-192, 345-370, 460-500`
- Modify: `src/renderer/src/components/diff-workbench.tsx:43-117, 118-211`
- Test: `tests/renderer/review-workbench.ui.test.tsx`
- Test: `tests/renderer/diff-workbench.ui.test.tsx`

**Interfaces:**
- Consumes: `ReviewDiffView.onActiveFileChange` and `PierreFileTree.activePath` from Tasks 2 and 3.
- Produces: an `activePath` state in each workbench that is never read by the header, selected finding, selected range, inspector, draft, review context, or storage preference functions.

- [ ] **Step 1: Extend the failing direct-workbench test**

In `tests/renderer/diff-workbench.ui.test.tsx`, use a mock `ReviewDiffView` that exposes an `Emit active path` button. Start with `src/a.ts` selected, emit `src/b.ts`, and assert the header still displays `src/a.ts`, while the mocked tree sees `activePath="src/b.ts"`. Assert the desktop workbench central surface has `overflow-hidden` and the diff region is the scrollable flex child rather than an outer `overflow-auto` document surface.

```ts
await user.click(screen.getByRole("button", { name: "Emit active path" }));
expect(screen.getByText("src/a.ts", { selector: "p" })).toBeTruthy();
expect(treeProps.activePath).toBe("src/b.ts");
expect(screen.getByLabelText("Diff workbench").className).toContain("min-[1100px]:h-");
```

- [ ] **Step 2: Run the focused direct and completed workbench tests to verify they fail**

Run: `pnpm test -- --run tests/renderer/diff-workbench.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx`

Expected: FAIL because neither workbench has a separate active path and the direct route still gives its center column outer scroll ownership.

- [ ] **Step 3: Wire state without changing explicit navigation semantics**

In both workbenches:

1. Initialize `activePath` from the first parsed file.
2. When an explicit tree click, mapped finding, range navigation, or incremental surface switch sets `selectedPath`, set `activePath` to the same path in that explicit action.
3. Pass `activePath` to every visible `PierreFileTree`, including the compact sheet.
4. Pass only `onActiveFileChange={setActivePath}` to `ReviewDiffView`.
5. Do not pass `activePath` to `selectedPath`, selected lines, finding state, the review header, or any persistence API.

For `DiffWorkbench`, move its current header unchanged into a `shrink-0` child of the new central flex column, remove `sticky top-0` from that header, and replace the desktop outer-scroll column with the same ownership model as `CompletedReviewWorkbench`:

```tsx
<section className="grid min-w-0 min-[1100px]:h-[calc(100vh-3.5rem)] min-[1100px]:grid-cols-[15rem_minmax(0,1fr)] max-[1099px]:grid-cols-1">
  <aside className="min-w-0 overflow-hidden border-r bg-card p-3 max-[1099px]:hidden">
    <PierreFileTree
      files={fileRows}
      {...(selectedPath === undefined ? {} : { selectedPath })}
      {...(activePath === undefined ? {} : { activePath })}
      onSelect={selectFile}
    />
  </aside>
  <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
    <ReviewDiffView
      patch={patch}
      parsedFiles={parsedDiff.files}
      fileStatsByPath={parsedDiff.statsByPath}
      {...(selectedPath === undefined ? {} : { selectedPath })}
      preferences={preferences}
      collapsedPaths={collapsedPaths}
      onPreferencesChange={updatePreferences}
      onCollapsedPathsChange={setCollapsedPaths}
      onActiveFileChange={setActivePath}
    />
  </div>
</section>
```

Keep the current one-column compact mode and sheets; only the desktop route gets the fixed viewport height. Preserve `fillViewport={false}` by using `h-full min-h-0` at desktop rather than a viewport calculation.

- [ ] **Step 4: Run the focused workbench tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/diff-workbench.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS; passive state and explicit state differ when instructed, and direct desktop layout no longer delegates vertical diff scrolling to an outer document container.

- [ ] **Step 5: Commit workbench state and layout ownership**

```bash
git add src/renderer/src/components/completed-review-workbench.tsx src/renderer/src/components/diff-workbench.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/diff-workbench.ui.test.tsx
git commit -m "feat: dock review diffs and separate active file state"
```

### Task 5: Prove native scrolling, passive follow, and desktop geometry in the browser

**Files:**
- Modify: `tests/browser/milestone-9.spec.ts`
- Read-only guard: `tests/browser/performance.spec.ts`

**Interfaces:**
- Consumes: the fixture route, `[data-active-path]`, `[data-selected-path]`, `.review-diff-viewport`, native tree `treeitem` roles, and `[data-review-scroll-container]`.
- Produces: browser regression coverage for the live renderer; the existing performance threshold remains unchanged.

- [ ] **Step 1: Add failing browser cases**

Add these exact cases to `tests/browser/milestone-9.spec.ts`:

1. At 1440px wide, scroll the native `.review-diff-viewport` from a long first file into the second file. Wait for `file-tree-container[data-active-path="src/b.ts"]`; assert the review region stays `data-selected-path="src/a.ts"` and the selected finding/inspector text has not changed.
2. Scroll through the fixture's streamed boundary. Wait for the loaded-file count to increase, then continue scrolling until `data-active-path` becomes the newly streamed file. Assert the stream still has no Load more button.
3. With `src/a.ts` already visible in the tree, assert its tree scroll position remains unchanged after a passive same-row update; for an offscreen path, assert `scrollTop` changes only enough to bring the target treeitem inside its own viewport. Assert `document.activeElement` is not the tree host after passive follow.
4. Click and use keyboard navigation on a treeitem. Assert `data-selected-path` changes and CodeView scrolls to that file; this distinguishes an explicit tree action from passive follow.
5. At 1280px and 1440px, assert `document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1` for the completed-review fixture, `document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1`, and that `.review-diff-viewport` has `scrollHeight > clientHeight`.
6. At 960px, assert the compact sheet still opens and no horizontal overflow occurs.

Use native mouse wheel input over `.review-diff-viewport`; do not set `scrollTop` directly for the behavior tests.

```ts
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, 2_000);
await expect(
  page.locator('file-tree-container[data-active-path="src/b.ts"]'),
).toBeVisible();
await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute(
  "data-selected-path",
  "src/a.ts",
);
```

- [ ] **Step 2: Run the targeted browser suite to verify the new cases fail**

Run: `pnpm exec playwright test tests/browser/milestone-9.spec.ts`

Expected: FAIL before the implementation because the tree has no active-path attribute and the direct route is not docked at desktop width.

- [ ] **Step 3: Stabilize only test fixtures, not production scroll behavior**

If the current two-file fixture cannot exercise a streamed transition or offscreen tree row, extend the fixture patch with deterministic additional files and unchanged content. Keep test waits on loaded-file count and active-path attributes; do not add delays, synthetic scroll events, or production-only test branches.

- [ ] **Step 4: Run the targeted browser suite to verify it passes**

Run: `pnpm exec playwright test tests/browser/milestone-9.spec.ts`

Expected: PASS at 1280px, 1440px, and 960px; native CodeView scrolling updates only the passive tree state, and no page-level overflow is introduced.

- [ ] **Step 5: Run the unchanged performance guard**

Run: `pnpm exec playwright test tests/browser/performance.spec.ts`

Expected: PASS with the existing 1,000-file selection assertion below 200ms; do not edit the threshold.

- [ ] **Step 6: Commit browser regression coverage**

```bash
git add tests/browser/milestone-9.spec.ts
git commit -m "test: cover docked diff tree following"
```

### Task 6: Verify the renderer and the packaged Electron surface

**Files:**
- Modify only generated visual snapshots if the approved visual change makes the current snapshot differ: `tests/browser/milestone-9.spec.ts-snapshots/pierre-unified-darwin.png`, `tests/browser/milestone-9.spec.ts-snapshots/pierre-split-darwin.png`
- Do not modify: `tests/browser/performance.spec.ts`

**Interfaces:**
- Consumes: the completed implementation, existing test scripts, and an isolated packaged app started with a unique user-data directory and CDP port.
- Produces: evidence that the desktop workbench is docked and the actual packaged Electron app has no console/page errors or horizontal overflow.

- [ ] **Step 1: Run static and renderer gates**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
```

Expected: every command exits 0. If a snapshot changes only because the approved tree active-row treatment is visible, inspect it and update only the corresponding expected snapshot.

- [ ] **Step 2: Build and smoke-test the package**

Run:

```bash
pnpm package:mac
pnpm test:package-smoke
```

Expected: the macOS package is created and the smoke suite exits 0.

- [ ] **Step 3: Have the dedicated tester perform packaged-app CDP QA**

The dedicated tester subagent owns this interactive check. Start a fresh packaged app using a distinct user-data directory and an unused CDP port, for example:

```bash
./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk --user-data-dir=/tmp/patchdesk-docked-diff-qa --remote-debugging-port=9234
```

The tester must use `agent-browser` over CDP, beginning with `agent-browser skills get core` and `agent-browser skills get electron`. Before every interaction, capture `snapshot -i`; after each route/workflow, inspect `errors` and `console`; capture a screenshot to `/tmp/patchdesk-docked-diff-qa.png`. The tester must verify:

1. Customer-management PR #118 opens in the packaged app without starting a GitHub write confirmation.
2. At 1440px, the application rail, review tree, toolbar, and inspector remain docked while the CodeView viewport scrolls through files.
3. The tree highlight follows CodeView native wheel/trackpad scrolling, tree focus is not stolen, and a tree click still explicitly navigates.
4. `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0` on the review page.
5. No page errors or console errors are reported.

The tester returns the screenshot path and the concrete assertions observed. Do not replace this with unit tests or a non-packaged renderer run.

- [ ] **Step 4: Commit only approved snapshot updates, if any**

```bash
git add tests/browser/milestone-9.spec.ts-snapshots/pierre-unified-darwin.png tests/browser/milestone-9.spec.ts-snapshots/pierre-split-darwin.png
git commit -m "test: update approved Pierre workbench snapshots"
```

Run this step only when a reviewed visual snapshot changed. If no snapshot files changed, do not create an empty commit.

## Self-review

### Spec coverage

- Docked blue outer workbench and a CodeView-owned red diff scroll region: Task 4 layout ownership and Task 5 desktop geometry assertions.
- Infinite All files reading with native progressive streaming: Task 2 composes the existing stream callback before active derivation; Task 5 proves a streamed-file boundary and absence of a load-more control.
- Tree highlight only, not inspector or selection mutation: Tasks 2–4 separate `activePath` from `selectedPath`; Tasks 2 and 5 assert the selected finding and inspector remain unchanged.
- Soft reveal with no focus theft: Task 3 uses Pierre's `offset: "nearest"` and `focus: false`; Task 5 checks both minimal reveal and focus preservation.
- Explicit tree pointer and keyboard semantics: Task 3 guards only programmatic selection; Task 5 verifies direct navigation.
- No Dockview, polling, scroll hooks, scroll nudges, persistence, or GitHub behavior changes: Global Constraints and Tasks 1–4 restrict the implementation boundary.
- Desktop, compact, accessibility, overflow, performance, renderer, browser, package, and packaged-app coverage: Tasks 5 and 6.

### Placeholder scan

The plan contains no unfinished implementation markers or generic test instructions. Each task names the files, the public interface, the focused test command, the intended implementation, and the exact commit scope.

### Type consistency

`activeFilePathAtScrollTop` returns `string | undefined`; `ReviewDiffView.onActiveFileChange` accepts only a defined `string`; each workbench stores that string in `activePath`; and `PierreFileTree.activePath` consumes the same optional string. `selectedPath` remains the existing optional string and is never substituted with `activePath`.
