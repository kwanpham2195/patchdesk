---
created_at: 2026-08-14
repos:
  - patchdesk
status: ready
spec: plans/audit-2026-08-14-react-doctor-disposition.md
supersedes:
  - .agents/PLANS/2026-08-14-react-doctor-remediation-program.md
  - plans/013-harden-react-toolchain-dependencies.md
  - plans/014-disposition-remaining-react-doctor-debt.md
---

# React Doctor Delta Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining React Doctor work from the current dirty checkout by fixing only proven defects, giving every one of the existing 207 diagnostics a terminal evidence-backed disposition, completing package evidence, and running final repository and live-app verification.

**Architecture:** Reuse completed Plans 009–012 and the existing 207-ID disposition audit. Make only two pre-approved source changes: guard the Electron renderer URL and replace the hand-built image modal with a native dialog while preserving the existing lightbox contract. Treat all other findings through current source, behavior tests, one static-reachability approval gate, package graph evidence, and same-version final scan reconciliation.

**Tech Stack:** Electron 43.x, React 19.1.x, TypeScript 5.9.x, Base UI/shadcn, pnpm 8.8.0, React Doctor 0.9.11, Oxlint 1.78.0, Oxfmt 0.63.0, Vitest 3.2.x, Playwright 1.54.x, Axe.

**Spec:** `plans/audit-2026-08-14-react-doctor-disposition.md`, `plans/audit-2026-08-14-react-doctor-follow-ups.md`, and `plans/audit-2026-08-14-react-toolchain-advisories.md`

## Global Constraints

- Plans 009–012 are complete prerequisites. Do not repeat scanner calibration, lifecycle characterization, committed-ref migration, Conversation identity work, or Mermaid control separation.
- Use the current calibrated baseline: React Doctor `0.9.11`, schema `3`, full scope, `207` warnings, `0` errors, score `57`, complete project, and no skipped checks.
- Use `node_modules/.bin/react-doctor` for baseline, `why`, `rules explain`, and final scans.
- React Doctor is advisory. Completion means every diagnostic has one terminal evidence-backed outcome; it does not require score 100 or zero reported warnings.
- Allowed terminal outcomes are `fixed`, `rejected-with-evidence`, `intentional-ordered-operation`, `observation-with-owner`, and `waived-with-authority`.
- `needs measurement`, `explicit follow-up reference`, and `unavailable` are not terminal outcomes.
- Preserve Review generations, request tokens, cancellation, explicit Refresh, GitHub-write authority, merge confirmation, pending-review ownership, immutable receipts, and ordered storage/journal operations.
- Do not add a reducer, memo, component split, dependency-array change, concurrency change, or positional-key rewrite solely because React Doctor reported it.
- Do not globally suppress correctness, lifecycle, identity, accessibility, async, or security rules.
- Do not delete files, exports, dependencies, fixtures, generated catalogs, lazy entry points, or runtime-loaded modules without one explicit user approval covering the exact deletion set.
- Do not add `any`, `// @ts-` directives, non-null assertions, module mocks, or method spies.
- Tests use public components, hooks, service interfaces, the desktop bridge, or the live Electron app. They do not export private implementation helpers.
- The checkout is dirty. One writer owns it. Re-read each in-scope hunk immediately before editing and preserve all existing work.
- This plan does not authorize branches, worktrees, commits, staging, pushes, or GitHub writes. Leave changes unstaged. A later user instruction can authorize a separate commit workflow.
- Keep `patchdesk logs live` and `patchdesk dev live` active. Restart the dev app after `src/main/` changes.
- Live verification is read-only through CDP `9233`.

---

## Current State and Closed Work

Completed work that this plan consumes without repeating:

- Plan 009: root scanner scope and local React Doctor command.
- Plan 010: Review detection, commit diff, hydration, progressive stream, Insight, log polling, and Mermaid interaction characterization tests.
- Plan 011: `useLatestCommitted` and committed-value ref migration.
- Plan 012: immutable Conversation keys and independent Mermaid controls.
- Existing audit: all 207 current diagnostic IDs appear exactly once in `plans/audit-2026-08-14-react-doctor-disposition.md`.
- Existing dependency work: production audit is clean; Hono, `@hono/node-server`, Mermaid, and DOMPurify are patched; remaining 11 high and 9 moderate findings are development/build-only and documented.

The old umbrella plan and Plans 013–014 are superseded by this delta plan. Their incomplete status is not converted to success.

## File Structure

### Create

- `.agents/research/2026-08-14-react-doctor-delta/initial.json` — immutable schema-3 baseline used for final comparison.
- `src/main/renderer-origin.ts` — pure fail-closed renderer URL parser.
- `tests/main/renderer-origin.test.ts` — renderer URL boundary behavior.

### Modify

- `src/main/electron-main.ts` — use the boundary parser.
- `src/renderer/src/components/markdown-lightbox.tsx` — native `<dialog>` lifecycle and existing zoom/pan behavior.
- `src/renderer/src/use-lightbox.ts` — pass `createElement` children positionally.
- `tests/renderer/markdown-lightbox.ui.test.tsx` — native dialog and open-reset behavior.
- `tests/browser/accessibility.spec.ts` — assert native dialog semantics in the existing Mermaid fixture.
- `plans/audit-2026-08-14-react-doctor-disposition.md` — terminal outcomes and final scan section.
- `plans/audit-2026-08-14-react-doctor-follow-ups.md` — exact static-reachability decision record.
- `plans/audit-2026-08-14-react-toolchain-advisories.md` — final package verification or exact network blocker.

### Assess without source edits

- `src/renderer/src/app.tsx` — loading reset is already in `finally`.
- `src/renderer/src/components/settings-modal.tsx` and `src/renderer/src/flows/settings-flow.tsx` — save callback resolves `boolean` and catches request failures.
- `src/renderer/src/components/narrative-walkthrough.tsx` — root key handler delegates bubbled shortcuts and is not an activation target.
- `src/main/desktop-bridge.ts` and `src/renderer/src/api-client.ts` — bridge returns `ok` and `status`; renderer rejects non-OK responses.
- All lifecycle, identity, performance, giant-component, reducer, ordered-await, and bounded-collection findings already listed in the disposition audit.

---

## Milestone 1: Freeze the Delta Baseline and Normalize Ownership

### Task 1: Prove the current 207-ID baseline and assign terminal owners

**Files:**

- Create: `.agents/research/2026-08-14-react-doctor-delta/initial.json`
- Modify: `plans/audit-2026-08-14-react-doctor-disposition.md`
- Modify: `plans/audit-2026-08-14-react-doctor-follow-ups.md`

**Interfaces:**

- Consumes: React Doctor schema-3 JSON from the current checkout.
- Produces: one immutable baseline plus one audit row per original ID with an owner task and allowed terminal outcome.

- [ ] **Step 1: Record the dirty-tree preimage**

```bash
git status -sb
git --no-pager diff --color=never --stat
git --no-pager diff --color=never --cached --stat
node_modules/.bin/react-doctor --version
```

Expected: React Doctor `0.9.11`. Do not stage, commit, switch branches, or create a worktree.

- [ ] **Step 2: Create the immutable baseline directory and scan**

```bash
mkdir -p .agents/research/2026-08-14-react-doctor-delta
node_modules/.bin/react-doctor \
  --json --blocking none --yes --scope full --no-cache \
  --json-out .agents/research/2026-08-14-react-doctor-delta/initial.json
jq -e '
  .schemaVersion == 3 and
  .ok == true and
  .summary.totalDiagnosticCount == 207 and
  .summary.errorCount == 0 and
  .summary.warningCount == 207 and
  all(.projects[]; .complete == true and (.skippedChecks | length) == 0)
' .agents/research/2026-08-14-react-doctor-delta/initial.json
```

Expected: `jq` exits `0`. If the count differs, update the audit and this plan's baseline before source edits.

- [ ] **Step 3: Compare the scan IDs with the existing audit without altering IDs**

```bash
BASE_DIR=.agents/research/2026-08-14-react-doctor-delta
jq -r '.projects[].diagnostics[].id' "$BASE_DIR/initial.json" | sort > "$BASE_DIR/scan.ids"
rg --no-filename -o '`[^`]+::[0-9]+:[0-9]+::[^`]+::[0-9a-f]+`' \
  plans/audit-2026-08-14-react-doctor-disposition.md \
  | tr -d '`' | sort -u > "$BASE_DIR/audit.ids"
test "$(wc -l < "$BASE_DIR/audit.ids" | tr -d ' ')" = "207"
diff -u "$BASE_DIR/scan.ids" "$BASE_DIR/audit.ids"
```

Expected: exactly 207 unique IDs and no diff. Do not use `sed` on IDs.

- [ ] **Step 4: Apply one exact row contract**

Every original diagnostic bullet must use this complete shape:

```text
`full diagnostic ID` — **terminal-outcome**; owner: `exact source path or Task N`; evidence: concrete source invariant; verification: `exact command or test path`; review trigger: concrete event that requires reconsideration.
```

Do not remove the full diagnostic ID. An outcome without all four fields is incomplete.

- [ ] **Step 5: Normalize lifecycle and identity rows as one audit-only unit**

Review these rules against the existing renderer tests: `exhaustive-deps`, `jsx-no-constructed-context-values`, `no-adjust-state-on-prop-change`, `no-array-index-as-key`, `no-children-prop`, `no-derived-useState`, `no-effect-chain`, `no-loading-flag-reset-outside-finally`, `no-pass-data-to-parent`, `no-pass-live-state-to-parent`, `no-prop-callback-in-effect`, `no-reset-all-state-on-prop-change`, `no-set-state-after-await-in-effect`, `no-side-effect-in-state-updater-function`, `no-static-element-interactions`, `no-unowned-async-error-clear`, `only-export-components`, `prefer-html-dialog`, `prefer-tag-over-role`, `rerender-lazy-ref-init`, `rerender-memo-with-default-value`, and `rerender-state-only-in-handlers`.

- Stateful/reorderable identity with an immutable domain ID: owner is the component and trigger is a failing reorder test.
- Reconstructed stateless Markdown/token identity: `rejected-with-evidence`; verification is the existing generated Markdown or pull-request description test.
- Generation, cancellation, effect dependency, prop reset, and stale completion: `observation-with-owner`; trigger is a failing existing race test or a reproduced stale user-visible result.
- Shared shadcn/Base UI variant exports: `rejected-with-evidence`; evidence names importing callers or package-local primitive ownership.
- Renderer URL and lightbox fixes remain owned by Tasks 2–3. App, Settings, and walkthrough rejections remain owned by Task 4. Both Item findings remain owned by Task 5.

- [ ] **Step 6: Normalize ordered async rows as one audit-only unit**

Review `async-await-in-loop` and `server-sequential-independent-await` rows against their current service/storage tests. Use `intentional-ordered-operation` only after naming one exact invariant: first-success search, durable write order, journal sequence, cleanup dependency, rate bound, or deterministic failure order. Owner is the current service/adapter. Trigger is a new test proving operations independent without changing result order or failure classification.

- [ ] **Step 7: Normalize bounded performance and architecture rows as one audit-only unit**

Review `js-cache-property-access`, `js-combine-iterations`, `js-hoist-intl`, `js-set-map-lookups`, `no-fetch-response-used-without-status-check`, `no-giant-component`, `no-json-parse-stringify-clone`, `no-unguarded-throwing-parse-call`, `prefer-module-scope-static-value`, and `prefer-useReducer`.

- Small bounded collections and formatters: `rejected-with-evidence`; evidence names the bound and current performance gate.
- Giant components and reducer suggestions: `observation-with-owner`; trigger is a named maintenance defect or an invalid state representable by current types.
- JSON serialization test and desktop bridge status handling: `rejected-with-evidence`; verification names the existing contract test.
- Renderer URL remains owned by Task 2.

- [ ] **Step 8: Normalize static reachability and package-policy rows as one audit-only unit**

Review `require-pnpm-hardening`, `unused-dependency`, `unused-dev-dependency`, `unused-export`, and `unused-file`.

- Static candidates: `observation-with-owner` until Task 5 obtains one user decision; do not call them dead code.
- Pnpm hardening: owner is package-manager maintenance; evidence records pnpm `8.8.0`, missing root `pnpm-workspace.yaml`, and current option support; trigger is an explicitly approved package-manager upgrade.
- Dependency candidates: owner is package maintenance; trigger is Task 5's exact reachability and approval result.

- [ ] **Step 9: Validate every original row has all required fields**

```bash
python3 - <<'PY'
from pathlib import Path
import re

path = Path("plans/audit-2026-08-14-react-doctor-disposition.md")
rows = [line for line in path.read_text().splitlines() if re.search(r"`[^`]+::\d+:\d+::[^`]+::[0-9a-f]+`", line)]
assert len(rows) == 207, len(rows)
required = ("owner:", "evidence:", "verification:", "review trigger:")
incomplete = [line for line in rows if not all(field in line for field in required)]
assert not incomplete, "\n".join(incomplete)
PY
```

- [ ] **Step 10: Verify no broad unresolved label remains outside static approval**

```bash
if rg -n 'needs measurement|explicit follow-up reference|unavailable' \
  plans/audit-2026-08-14-react-doctor-disposition.md; then
  exit 1
fi
```

Expected: no matches. Static candidates use `observation-with-owner` until Task 5.

- [ ] **Step 11: Run document checks**

```bash
pnpm exec oxfmt --check \
  plans/audit-2026-08-14-react-doctor-disposition.md \
  plans/audit-2026-08-14-react-doctor-follow-ups.md
git diff --check -- \
  plans/audit-2026-08-14-react-doctor-disposition.md \
  plans/audit-2026-08-14-react-doctor-follow-ups.md
```

**Task acceptance:** baseline JSON is complete; audit IDs equal scan IDs exactly; every row has an owner and no unresolved generic follow-up label.

---

## Milestone 2: Make Only Proven Source Corrections

### Task 2: Guard the Electron renderer origin boundary

**Files:**

- Create: `src/main/renderer-origin.ts`
- Create: `tests/main/renderer-origin.test.ts`
- Modify: `src/main/electron-main.ts:685-688`
- Modify: `plans/audit-2026-08-14-react-doctor-disposition.md`

**Interfaces:**

- Produces: `rendererOrigin(value: string | undefined): string`.
- Contract: return a normalized absolute origin for valid input; return the existing fail-closed value `"null"` for missing or malformed input.

- [ ] **Step 1: Write the failing boundary test**

```ts
import { describe, expect, it } from "vitest";

import { rendererOrigin } from "../../src/main/renderer-origin";

describe("rendererOrigin", () => {
  it("returns the origin for an absolute renderer URL", () => {
    expect(rendererOrigin("http://localhost:5173/review?id=42")).toBe(
      "http://localhost:5173",
    );
  });

  it("fails closed for missing or malformed runtime input", () => {
    expect(rendererOrigin(undefined)).toBe("null");
    expect(rendererOrigin("not a URL")).toBe("null");
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

```bash
pnpm test -- --run tests/main/renderer-origin.test.ts
```

Expected: fail because `src/main/renderer-origin.ts` does not exist.

- [ ] **Step 3: Implement the boundary parser**

```ts
/** Returns the renderer origin or the fail-closed opaque origin. */
export function rendererOrigin(value: string | undefined): string {
  if (value === undefined || !URL.canParse(value)) return "null";
  return new URL(value).origin;
}
```

- [ ] **Step 4: Use it from Electron main**

Add:

```ts
import { rendererOrigin } from "./renderer-origin";
```

Replace the existing helper body with:

```ts
function getRendererOrigin(): string {
  return rendererOrigin(process.env.ELECTRON_RENDERER_URL);
}
```

- [ ] **Step 5: Run focused proof and changed-file scan**

```bash
pnpm test -- --run tests/main/renderer-origin.test.ts
pnpm lint
pnpm typecheck
node_modules/.bin/react-doctor \
  --json --blocking none --yes \
  --scope files --base HEAD --include-untracked --no-cache \
  --json-out /tmp/patchdesk-renderer-origin.json
jq -e '[.projects[].diagnostics[] | select(.rule == "no-unguarded-throwing-parse-call")] | length == 0' \
  /tmp/patchdesk-renderer-origin.json
git diff --check -- \
  src/main/renderer-origin.ts \
  src/main/electron-main.ts \
  tests/main/renderer-origin.test.ts
```

- [ ] **Step 6: Update the exact audit row**

Mark `src/main/electron-main.ts::687:47::react-doctor/no-unguarded-throwing-parse-call::dfdf095868eae247b9168d541f2d52c05542d0bda510f998f562f4babfbad9d3` as `fixed`. Record the focused test and changed-file scan.

**Task acceptance:** malformed runtime input cannot throw; the focused test passes; the target diagnostic is absent from the changed-file scan.

### Task 3: Use a native lightbox dialog and explicit React children

**Files:**

- Modify: `src/renderer/src/components/markdown-lightbox.tsx`
- Modify: `src/renderer/src/use-lightbox.ts`
- Modify: `tests/renderer/markdown-lightbox.ui.test.tsx`
- Modify: `tests/browser/accessibility.spec.ts:286-319`
- Modify: `plans/audit-2026-08-14-react-doctor-disposition.md`

**Interfaces:**

- Preserve `MarkdownLightbox({ open, onClose, children }): JSX.Element | null`.
- Preserve `useLightbox(): { lightbox; open; close }`.
- Native `cancel` owns Escape. The dialog key handler owns only `+`, `=`, `-`, and `0` zoom shortcuts.
- Close/reopen resets scale to 100% and fit-to-screen.

- [ ] **Step 1: Add a local native-dialog test polyfill without spies**

In `tests/renderer/markdown-lightbox.ui.test.tsx`, import `beforeEach` and save the original methods:

```ts
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: originalShowModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: originalClose,
  });
});
```

Replace the current `afterEach(cleanup)` with this cleanup block.

- [ ] **Step 2: Add native dialog and reset tests**

```ts
it("opens as a native modal and delegates cancel to onClose", () => {
  const onClose = vi.fn();
  render(
    <MarkdownLightbox open onClose={onClose}>
      <div className="size-24" />
    </MarkdownLightbox>,
  );

  const dialog = screen.getByRole("dialog", { name: "Image viewer" });
  expect(dialog.tagName).toBe("DIALOG");
  expect((dialog as HTMLDialogElement).open).toBe(true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes when empty lightbox space is clicked", () => {
  const onClose = vi.fn();
  render(
    <MarkdownLightbox open onClose={onClose}>
      <div className="size-24" />
    </MarkdownLightbox>,
  );

  const dialog = screen.getByRole("dialog", { name: "Image viewer" });
  fireEvent.click(dialog);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("resets zoom and fit state after close and reopen", async () => {
  const user = userEvent.setup();
  const view = render(
    <MarkdownLightbox open onClose={vi.fn()}>
      <div className="size-24" />
    </MarkdownLightbox>,
  );

  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByText("125%")).toBeTruthy();

  view.rerender(
    <MarkdownLightbox open={false} onClose={vi.fn()}>
      <div className="size-24" />
    </MarkdownLightbox>,
  );
  view.rerender(
    <MarkdownLightbox open onClose={vi.fn()}>
      <div className="size-24" />
    </MarkdownLightbox>,
  );

  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Actual size" })).toBeTruthy();
});
```

- [ ] **Step 3: Run the tests and confirm the native-tag failure**

```bash
pnpm test -- --run tests/renderer/markdown-lightbox.ui.test.tsx
```

Expected before the fix: the native-dialog test fails because the current element is a `DIV`.

- [ ] **Step 4: Implement native dialog lifecycle**

Change the React import to include `useLayoutEffect` and `type KeyboardEvent`. Add:

```ts
const dialogRef = useRef<HTMLDialogElement>(null);

useLayoutEffect(() => {
  const dialog = dialogRef.current;
  if (dialog === null) return;
  if (!dialog.open) dialog.showModal();
  return () => {
    if (dialog.open) dialog.close();
  };
}, [open]);

const handleKeyDown = useCallback(
  (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key === "+" || event.key === "=") zoomIn();
    else if (event.key === "-") zoomOut();
    else if (event.key === "0") reset();
  },
  [reset, zoomIn, zoomOut],
);
```

Remove the global `window.addEventListener("keydown", ...)` effect. Native `cancel` now owns Escape.

- [ ] **Step 5: Replace the modal return block exactly**

Keep `if (!open) return null;`, then use this complete return block:

```tsx
return (
  <dialog
    ref={dialogRef}
    aria-label="Image viewer"
    className="fixed inset-0 z-50 m-0 flex h-screen max-h-none w-screen max-w-none flex-col items-center justify-center border-0 bg-background/98 p-0 backdrop-blur-sm backdrop:bg-transparent"
    onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}
    onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
    onKeyDown={handleKeyDown}
  >
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-white hover:bg-white/10"
        onClick={zoomOut}
        aria-label="Zoom out"
        disabled={scale <= MIN_SCALE}
      >
        <Minus />
      </Button>
      <span className="min-w-[3.5rem] text-center text-xs text-white tabular-nums">
        {Math.round(scale * 100)}%
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-white hover:bg-white/10"
        onClick={zoomIn}
        aria-label="Zoom in"
        disabled={scale >= MAX_SCALE}
      >
        <Plus />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-white hover:bg-white/10"
        onClick={toggleFit}
        aria-label={fitToScreen ? "Actual size" : "Fit to screen"}
      >
        <Maximize2 className={fitToScreen ? "opacity-100" : "opacity-50"} />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-white hover:bg-white/10"
        onClick={onClose}
        aria-label="Close"
      >
        <X />
      </Button>
    </div>

    <div
      ref={viewportRef}
      role="region"
      aria-label="Zoomable content"
      className={
        fitToScreen
          ? "flex max-h-[90vh] max-w-[90vw] items-center justify-center overflow-auto"
          : "h-[90vh] w-[90vw] cursor-grab overflow-auto touch-none active:cursor-grabbing"
      }
      onPointerDown={startPan}
      onPointerMove={pan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      <div
        className={fitToScreen ? undefined : "w-max"}
        style={fitToScreen ? undefined : { zoom: scale }}
      >
        {children}
      </div>
    </div>
  </dialog>
);
```

- [ ] **Step 6: Pass `createElement` children positionally**

Replace the `lightbox` callback in `src/renderer/src/use-lightbox.ts` with:

```ts
const lightbox = useCallback(
  () =>
    createElement(MarkdownLightbox, { open: isOpen, onClose: close }, content),
  [isOpen, close, content],
);
```

- [ ] **Step 7: Extend the existing browser test with native assertions**

After `await expect(dialog).toBeVisible()` in `tests/browser/accessibility.spec.ts`, add:

```ts
expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
expect(
  await dialog.evaluate((element) => (element as HTMLDialogElement).open),
).toBe(true);
```

Keep the existing serious-violation, Escape, hidden-dialog, and focus-return assertions.

- [ ] **Step 8: Verify renderer and browser behavior**

```bash
pnpm test -- --run \
  tests/renderer/markdown-lightbox.ui.test.tsx \
  tests/renderer/pull-request-description.ui.test.tsx
pnpm build
pnpm exec playwright test tests/browser/accessibility.spec.ts
pnpm lint
pnpm typecheck
node_modules/.bin/react-doctor \
  --json --blocking none --yes \
  --scope files --base HEAD --include-untracked --no-cache \
  --json-out /tmp/patchdesk-lightbox.json
jq -e '[.projects[].diagnostics[] | select(
  .rule == "prefer-html-dialog" or .rule == "no-children-prop"
)] | length == 0' /tmp/patchdesk-lightbox.json
git diff --check -- \
  src/renderer/src/components/markdown-lightbox.tsx \
  src/renderer/src/use-lightbox.ts \
  tests/renderer/markdown-lightbox.ui.test.tsx \
  tests/browser/accessibility.spec.ts
```

- [ ] **Step 9: Update the exact audit rows**

Mark these outcomes:

- `src/renderer/src/components/markdown-lightbox.tsx::122:7::react-doctor/prefer-html-dialog::e457dd05d6aebd8d946d70431d2c0f65ec260bc40211aac840f2e4c519e82e7d` — `fixed`.
- `src/renderer/src/use-lightbox.ts::24:9::react-doctor/no-children-prop::8ff34865dc449e9edef32d5d3d2b7a18daa3796a7d70547637932cf071e3fd13` — `fixed`.
- Lightbox `no-reset-all-state-on-prop-change` — `rejected-with-evidence`; close/reopen reset is required behavior and now has a direct test.

**Task acceptance:** native dialog semantics, Escape, focus return, zoom, pan, close/reopen reset, Axe, and explicit children all pass.

### Task 4: Reclassify false positives without production edits

**Files:**

- Assess: `src/renderer/src/app.tsx:303-325`
- Assess: `src/renderer/src/components/settings-modal.tsx:124-140`
- Assess: `src/renderer/src/flows/settings-flow.tsx:169-220`
- Assess: `src/renderer/src/components/narrative-walkthrough.tsx:270-277`
- Assess: `src/main/desktop-bridge.ts:210-224`
- Assess: `src/renderer/src/api-client.ts`
- Modify: `plans/audit-2026-08-14-react-doctor-disposition.md`

**Interfaces:**

- No production interface changes.
- Evidence is current source plus existing behavior tests.

- [ ] **Step 1: Prove App already resets loading in `finally`**

```bash
node_modules/.bin/react-doctor why --cwd "$PWD" src/renderer/src/app.tsx:324
pnpm test -- --run \
  tests/renderer/app.ui.test.tsx \
  tests/renderer/inbox-refresh-scheduler.test.ts
```

Inspect `refreshInbox`: `setInboxRefreshing(false)` is inside `finally` and is generation-guarded. Mark the diagnostic `rejected-with-evidence`; do not edit the function.

- [ ] **Step 2: Prove Settings save failures resolve `false`**

```bash
node_modules/.bin/react-doctor why --cwd "$PWD" src/renderer/src/components/settings-modal.tsx:130
pnpm test -- --run \
  tests/renderer/profile-settings.test.tsx \
  tests/renderer/settings-modal.ui.test.tsx
```

Inspect `SettingsFlow.saveProfile`: it catches `unknown`, displays an error, returns `false`, and clears its own pending state in `finally`. `SettingsModal.saveAndContinue` receives `Promise<boolean>`, so the current reset runs for all contract-compliant outcomes. Mark the diagnostic `rejected-with-evidence`; do not add a production `try/finally` for an impossible rejecting callback.

- [ ] **Step 3: Prove the walkthrough wrapper is delegated keyboard scope**

```bash
node_modules/.bin/react-doctor why --cwd "$PWD" src/renderer/src/components/narrative-walkthrough.tsx:271
pnpm test -- --run tests/renderer/narrative-walkthrough.ui.test.tsx
```

Use the existing tests `supports j/k vim aliases only when no editor control has focus` and `returns focus to the section heading on Escape`. The root receives bubbled keyboard events and is not an activation target. Mark the diagnostic `rejected-with-evidence` under the canonical delegated-wrapper exception. Do not add `role="application"`, `role="button"`, or `tabIndex={0}`.

- [ ] **Step 4: Retain the bridge status-check rejection**

```bash
node_modules/.bin/react-doctor why --cwd "$PWD" src/main/desktop-bridge.ts:221
pnpm test -- --run tests/renderer/renderer-contracts.test.ts
```

Verify the bridge returns `ok: response.ok` and `status`, while `requestJson` rejects non-OK responses and preserves the structured body. Keep `rejected-with-evidence`; do not add a second status policy.

- [ ] **Step 5: Verify the audit no longer calls these confirmed failures**

```bash
if rg -n 'app\.tsx.*confirmed failure|settings-modal\.tsx.*confirmed failure|narrative-walkthrough\.tsx.*confirmed failure|desktop-bridge\.ts.*confirmed failure' \
  plans/audit-2026-08-14-react-doctor-disposition.md; then
  exit 1
fi
pnpm exec oxfmt --check plans/audit-2026-08-14-react-doctor-disposition.md
git diff --check -- plans/audit-2026-08-14-react-doctor-disposition.md
```

**Task acceptance:** four findings have exact source/test evidence and no speculative source edit.

---

## Milestone 3: Resolve Decisions and Finish Verification

### Task 5: Produce one static-reachability approval set

**Files:**

- Modify: `plans/audit-2026-08-14-react-doctor-follow-ups.md`
- Modify after decision: `plans/audit-2026-08-14-react-doctor-disposition.md`
- After approval, modify or delete only the exact candidates in the approved execution checklist below.

**Interfaces:**

- Produces one user decision covering the exact candidate set.
- No deletion command existed until the user approved exact paths/symbols; the user approved the set with “approve all”.

### Approved execution checklist (user decision: “approve all”)

- [x] Remove dependencies `@fontsource-variable/geist` and `@electron-toolkit/utils` only.
- [x] Remove export visibility only (retain local declarations and behavior where applicable) for `src/adapters/storage/json-file.ts#appendJsonLine`, `src/domain/contracts.ts#reviewPrWorkflowOutputSchema`, `src/domain/contracts.ts#parseGitHubPullRequestDto`, `src/domain/contracts.ts#parseReviewPrWorkflowOutput`, `src/domain/contracts.ts#parseStartReviewRequest`, `src/domain/insight-provider.ts#parseInsightSelection`, `src/domain/insight-provider.ts#isInsightProvider`, `src/domain/log-entry.ts#fitsLogEntryBytes`, `src/domain/pending-review.ts#isPendingReviewConfirmed`, `src/domain/pull-request.ts#pullRequestInputSchema`, `src/renderer/src/components/pr-overview-sheet.tsx#PullRequestOverviewSheet`, `src/renderer/src/components/review-workbench.tsx#usePublishedFeedbackNavigation`, `src/renderer/src/flows/inbox-flow.tsx#InboxScreen`, `src/renderer/src/flows/inbox-flow.tsx#Pending`, `src/renderer/src/review-copy.ts#WALKTHROUGH_LIFECYCLE_KEYS`, `src/services/review-commit-service.ts#commitDiffFailureReason`, `src/services/review-preparation-journal.ts#promoteStagedArtifact`, and `src/services/walkthrough-operation.ts#walkthroughInputSchema`.
- [x] Remove files `src/renderer/src/components/dashboard-empty-state.tsx`, `src/renderer/src/format-byte-size.ts`, `src/renderer/src/hooks/use-mobile.ts`, and `src/renderer/src/review-identity.ts` only.
- [x] Retain absent `minimumReleaseAge`/`trustPolicy`, `src/renderer/src/main.tsx`, and generated `src/renderer/src/components/ui/dropdown-menu.tsx`, `src/renderer/src/components/ui/item.tsx`, `src/renderer/src/components/ui/toggle-group.tsx`, and `src/renderer/src/components/ui/toggle.tsx`; do not change `ItemGroup` role while unreachable.
- [x] After removal, verify focused tests, build/bundle/package gates, lint, typecheck, formatting, static searches, React Doctor, audit accounting, and no staged files; authorized verification is complete and the follow-up record records the second approval and final retained static set.

- [x] Second explicit approval recorded: remove only the cascaded exports/declarations `src/domain/contracts.ts#githubPullRequestDtoSchema`, `src/domain/contracts.ts#startReviewRequestSchema`, and `src/domain/log-entry.ts#LOG_MAX_ENTRY_BYTES`; do not remove any other newly exposed item.
- [x] **Step 1: Run exact symbol and file reachability searches**

```bash
rg -n 'appendJsonLine|reviewPrWorkflowOutputSchema|parseGitHubPullRequestDto|parseReviewPrWorkflowOutput|parseStartReviewRequest|parseInsightSelection|isInsightProvider|fitsLogEntryBytes|isPendingReviewConfirmed|pullRequestInputSchema|PullRequestOverviewSheet|usePublishedFeedbackNavigation|InboxScreen|Pending|WALKTHROUGH_LIFECYCLE_KEYS|commitDiffFailureReason|promoteStagedArtifact|walkthroughInputSchema' \
  src tests scripts electron.vite.config.ts package.json
rg -n 'dashboard-empty-state|dropdown-menu|components/ui/item|toggle-group|components/ui/toggle|format-byte-size|use-mobile|renderer/src/main|review-identity' \
  src tests scripts electron.vite.config.ts package.json
rg -n '@fontsource-variable/geist|@electron-toolkit/utils|font-family.*Geist|--font-geist' \
  src resources tests scripts electron.vite.config.ts package.json
pnpm why @fontsource-variable/geist
pnpm why @electron-toolkit/utils
pnpm --version
test ! -e pnpm-workspace.yaml
pnpm help config > /tmp/patchdesk-pnpm-config-help.txt
if rg -n 'minimumReleaseAge|trustPolicy' /tmp/patchdesk-pnpm-config-help.txt; then
  printf 'Pinned pnpm documents the hardening options.\n'
else
  printf 'Pinned pnpm does not document the hardening options.\n'
fi
pnpm config get minimumReleaseAge
pnpm config get trustPolicy
pnpm build
pnpm test:bundle
```

- [x] **Step 2: Record one evidence list**

For each candidate, add exactly these fields to `plans/audit-2026-08-14-react-doctor-follow-ups.md`:

```text
- Candidate: exact path or exported symbol
- Static references: exact search result or none
- Build/runtime entry evidence: exact entry point, generated use, fixture use, or none
- Appears intentional: yes or no, with reason
- Proposed outcome: retain, remove export only, remove dependency, or remove file
- Required verification: focused test plus build/bundle/package gate
```

For `src/renderer/src/components/ui/item.tsx`, record both current diagnostics in the same candidate entry:

- `unused-file`: static reachability decision.
- `prefer-tag-over-role`: if retained but unreachable, use `observation-with-owner` with review trigger `replace ItemGroup with native <ul> before this primitive becomes reachable`.

For both `require-pnpm-hardening` diagnostics, record pnpm `8.8.0`, absence of root `pnpm-workspace.yaml`, the installed help/config output, owner `package-manager maintenance`, and review trigger `explicit approval to upgrade the pinned pnpm major or create root workspace policy`.

- [x] **Step 3: Ask the user once for the complete decision set**

Present all candidates in one grouped request. Do not delete or modify source while waiting.

- [x] **Step 4: Close each audit row from the user decision**

- Approved but unexecuted removal: keep `observation-with-owner` and add marker `approved-removal-pending`; do not call it fixed.
- Explicit retain: mark `observation-with-owner` and quote the user's authority plus the review trigger.
- Runtime/build entry point: mark `rejected-with-evidence`.

- [x] **Step 5: Execute only the approved removals after user decision**

The approved dependencies, exports, and files were removed without staging. Local declarations required by active behavior were retained, the documented exceptions were not changed, and removed rows were changed to `fixed` only after verification.

**Task acceptance:** one evidence list and two explicit user decisions exist; only approved source removal occurred; every original 207 static row has an authority-backed terminal outcome; the full final scan contains only the documented retained exceptions and no cascaded unapproved signatures.

### Task 6: Complete package evidence without speculative upgrades

**Files:**

- Modify: `plans/audit-2026-08-14-react-toolchain-advisories.md`
- Assess: `package.json`, `pnpm-lock.yaml`, `runtime/flue/package.json`, `runtime/flue/pnpm-lock.yaml`
- Do not change package versions unless a new production advisory is found.

**Interfaces:**

- Production audit authority: pnpm graph and audit JSON.
- Development/build findings remain separate from shipped runtime findings.
- Flue exact closure remains unchanged.

- [x] **Step 1: Capture current audit results**

```bash
pnpm audit --prod --audit-level high --json > /tmp/patchdesk-audit-prod.json
PROD_STATUS=$?
pnpm audit --audit-level high --json > /tmp/patchdesk-audit-full.json
FULL_STATUS=$?
printf 'production=%s full=%s\n' "$PROD_STATUS" "$FULL_STATUS"
jq '.metadata.vulnerabilities' /tmp/patchdesk-audit-prod.json
jq '.metadata.vulnerabilities' /tmp/patchdesk-audit-full.json
```

Expected: production status `0` and no production findings; full status can be nonzero for documented development/build findings.

- [x] **Step 2: Confirm patched direct versions and unchanged Flue closure**

```bash
pnpm why hono
pnpm why @hono/node-server
pnpm why mermaid
pnpm why dompurify
jq '{runtime:.dependencies}' runtime/flue/package.json
shasum -a 256 runtime/flue/pnpm-lock.yaml
```

Expected root versions: Hono `4.13.2`, `@hono/node-server` `2.1.1`, Mermaid `11.16.1`, DOMPurify `3.4.13`. Expected Flue direct versions: `@flue/runtime` `2.0.3` and `@earendil-works/pi-ai` `0.84.1`.

- [x] **Step 3: Run package gates once against the unchanged graph**

```bash
pnpm test:bundle
if pnpm package:mac; then
  pnpm test:package-smoke
else
  printf 'Current package and current-package smoke: not run.\n'
  exit 1
fi
git diff --check -- package.json pnpm-lock.yaml runtime/flue/package.json runtime/flue/pnpm-lock.yaml
```

If `pnpm package:mac` fails only while downloading Electron, record the exact command, timestamp, host/IP, and `ETIMEDOUT` text as `not run: external download unavailable`. Current-package smoke is also not run. A passing smoke result from an older package is historical evidence only. Do not report current pass and do not change dependencies to bypass the network.

- [x] **Step 4: Update the advisory record**

Record audit counts, direct versions, Flue digest, bundle result, package result, smoke result, and residual development/build owners in `plans/audit-2026-08-14-react-toolchain-advisories.md`.

- [x] **Step 5: Stop on a changed production graph**

If the production audit is no longer clean or a patched direct version regressed, stop and request a separate dependency decision. Do not add overrides or upgrade Electron, Vite, electron-builder, React Doctor, or Flue in this evidence task.

**Task acceptance:** production audit is clean; direct patched versions and Flue closure are proven; package evidence is pass or precisely recorded as externally unavailable; no speculative upgrade occurs.

### Task 7: Reconcile final diagnostics and run all product gates

**Files:**

- Create: `.agents/research/2026-08-14-react-doctor-delta/final.json`
- Modify: `plans/audit-2026-08-14-react-doctor-disposition.md`
- No source edits in this task.

**Interfaces:**

- Consumes immutable `initial.json` and final schema-3 scan.
- Produces zero unclassified initial logical findings and zero new unreviewed final signatures.

- [ ] **Step 1: Run the same complete final scan**

```bash
BASE_DIR=.agents/research/2026-08-14-react-doctor-delta
node_modules/.bin/react-doctor \
  --json --blocking none --yes --scope full --no-cache \
  --json-out "$BASE_DIR/final.json"
jq -e '
  .schemaVersion == 3 and
  .ok == true and
  all(.projects[]; .complete == true and (.skippedChecks | length) == 0)
' "$BASE_DIR/final.json"
jq '.summary' "$BASE_DIR/final.json"
```

- [ ] **Step 2: Compare stable signatures so line shifts do not look new**

```bash
jq -r '.projects[].diagnostics[] | [.plugin, .rule, .normalizedFilePath, .message] | @tsv' \
  "$BASE_DIR/initial.json" | sort > "$BASE_DIR/initial.signatures"
jq -r '.projects[].diagnostics[] | [.plugin, .rule, .normalizedFilePath, .message] | @tsv' \
  "$BASE_DIR/final.json" | sort > "$BASE_DIR/final.signatures"
comm -13 "$BASE_DIR/initial.signatures" "$BASE_DIR/final.signatures" \
  > "$BASE_DIR/new.signatures"
if test -s "$BASE_DIR/new.signatures"; then
  cat "$BASE_DIR/new.signatures"
  exit 1
fi
```

Expected: no new logical signatures. Fixed findings may disappear; unchanged findings may have shifted IDs.

- [ ] **Step 3: Verify all original audit IDs remain exactly once**

```bash
rg --no-filename -o '`[^`]+::[0-9]+:[0-9]+::[^`]+::[0-9a-f]+`' \
  plans/audit-2026-08-14-react-doctor-disposition.md \
  | tr -d '`' | sort > "$BASE_DIR/audit-final.ids"
test "$(wc -l < "$BASE_DIR/audit-final.ids" | tr -d ' ')" = "207"
sort -u "$BASE_DIR/audit-final.ids" > "$BASE_DIR/audit-final-unique.ids"
diff -u "$BASE_DIR/audit-final.ids" "$BASE_DIR/audit-final-unique.ids"
```

Expected: 207 rows and no duplicate original ID. Final shifted IDs go in a separate `Final scan` section and are not inserted into the original 207-row manifest.

- [ ] **Step 4: Verify every original row is terminal**

```bash
if rg -n 'confirmed failure|needs measurement|explicit follow-up reference|unavailable|approved-removal-pending|fixed-after-approved-removal' \
  plans/audit-2026-08-14-react-doctor-disposition.md; then
  exit 1
fi
```

Expected: no matches after Tasks 2–6 and any approved-removal task are complete.

- [ ] **Step 5: Run the full repository gate in required order**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm test:performance
pnpm test:bundle
git diff --check
```

Do not weaken the existing 1,000-file performance thresholds.

- [ ] **Step 6: Restart the dev app because main-process code changed**

In `patchdesk dev live`, stop the current process and run:

```bash
pnpm dev -- --remote-debugging-port=9233
```

Confirm the local API starts and DevTools listens on `127.0.0.1:9233`.

- [ ] **Step 7: Run read-only live Electron verification**

Use `patchdesk-electron-tester` against CDP `9233`:

1. Open an existing Review.
2. Wait for background update detection and confirm HTTP 200.
3. Change Review tabs and return; confirm no duplicate detector request.
4. Open the Mermaid fixture lightbox and verify native dialog, zoom, Escape, explicit Close, and focus return.
5. Open Settings and verify the current profile save-error surface remains retryable.
6. Inspect page errors, console errors, and `patchdesk.jsonl` for new failures.
7. Confirm no GitHub write endpoint was called.

- [ ] **Step 8: Record the final comparison**

Append a `Final scan` section to the disposition audit with:

- React Doctor version, schema, scope, completeness, skipped checks, score, error count, warning count, and affected file count.
- Fixed signatures and their focused tests.
- Retained signatures grouped by terminal outcome.
- New signature count, which must be zero.
- Full gate results.
- Live verification result.
- Package gate result or exact external-download blocker.

- [ ] **Step 9: Run final document and diff checks**

```bash
pnpm exec oxfmt --check \
  .agents/PLANS/2026-08-14-complete-react-doctor-remediation.md \
  plans/audit-2026-08-14-react-doctor-disposition.md \
  plans/audit-2026-08-14-react-doctor-follow-ups.md \
  plans/audit-2026-08-14-react-toolchain-advisories.md
git diff --check
```

**Task acceptance:** no unclassified initial finding, no new logical diagnostic signature, full repository gates pass, package evidence is honest, and read-only live verification passes without a GitHub write.

---

## Stop Conditions

Stop the affected task and ask the user when:

- The baseline is not the expected complete 207-diagnostic scan.
- A proposed source change has no failing behavior test and is not one of Tasks 2–3.
- Native dialog behavior cannot preserve Escape, focus return, zoom, pan, or Axe results.
- Static reachability evidence suggests an intentional or runtime-loaded target and removal lacks exact approval.
- Production audit is not clean or a fix requires a major Electron, Vite, electron-builder, React Doctor, or Flue change.
- A change would alter Review freshness, generation ownership, cancellation, explicit Refresh, GitHub-write authority, or ordered storage/journal work.
- Existing dirty work overlaps an edit and ownership cannot be separated safely.

## Final Acceptance Criteria

- Plans 009–012 remain accepted and are not reimplemented.
- The initial baseline is React Doctor 0.9.11, schema 3, complete, 207 warnings, 0 errors, score 57, and no skipped checks.
- All 207 original IDs remain exactly once in the audit with a terminal outcome and owner.
- The renderer URL parser fails closed for malformed input.
- The lightbox uses native dialog semantics and preserves reset, zoom, pan, Escape, explicit Close, focus return, and Axe behavior.
- App loading, Settings save, walkthrough keyboard, and desktop bridge findings have current source/test evidence and no speculative edit.
- Static reachability has one explicit user decision; no unapproved deletion occurs.
- Production audit is clean, patched direct versions are proven, and Flue remains unchanged.
- No new final diagnostic signature exists.
- Format, lint, typecheck, full Vitest, build, full Playwright, performance, bundle, and diff checks pass.
- Package evidence is pass or precisely reported as externally unavailable.
- Read-only live Electron verification passes and causes no GitHub write.

## Execution Handoff

This plan is ready for review, not automatic execution. The user must choose an execution mode separately:

1. **Subagent-Driven:** one writer task at a time, with read-only review between milestones.
2. **Inline Execution:** execute tasks in this session with a checkpoint after each task.

Neither choice authorizes commits, branches, worktrees, staging, pushes, deletions, or GitHub writes.
