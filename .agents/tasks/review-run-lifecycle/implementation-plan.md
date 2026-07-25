---
created_at: 2026-07-25
repos: patchdesk
status: ready
spec: ./spec.md
---

# Review-run lifecycle UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every moment of the review-run lifecycle visible and honest: propagate `runId` + `attemptId` at start, add real starting/finalizing/disconnected/reconnect states, and persist run failures so retry actually works.

**Architecture:** PR 1 is renderer-only plus one additive projection field set (Tasks 1–5). PR 2 adds main-process failure persistence via a new `ReviewFailureService` wired next to `ReviewCompletionService` in `createWorkflowInvoker`, changes startup reconciliation to write `ReviewFailed` instead of `Stale`, and settles the renderer on a failed projection (Tasks 6–9). The run registry, coordinator, and GitHub write paths stay untouched.

**Tech Stack:** Electron, React 19, valibot contracts, vitest + @testing-library (jsdom), hono local API. `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional property; omit via conditional spread or rest-destructuring.

## Global Constraints

- `runId` stays process-local and is never persisted; `/v1/reviews/load` never returns a live run handle.
- Reopening a session never auto-restarts a workflow; startup reconciliation never relaunches.
- Provider events, prompts, tool output, credentials stay behind the safe-run projection.
- GitHub writes keep the current-head recheck and explicit confirmation boundary. This plan touches no GitHub write path.
- Copy strings are product decisions; use them verbatim from the task steps.
- Stage explicit paths only; never `git add -A` / `git add .`. Commit style: `<type>: <summary>`, lowercase imperative, no trailing period.
- Per-PR gate: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, `pnpm exec playwright test`.
- Live UI verification uses a dedicated tester subagent over packaged Electron + agent-browser CDP (repo rule; see Tasks 5 and 9).
- No CHANGELOG.md exists in this repo; no changelog step.

---

### Task 1: Propagate runId and attemptId at run start (L1)

**Files:**
- Modify: `src/renderer/src/flows/prepared-review-flow.tsx` (lines 62, 114–153, 296)
- Test: `tests/renderer/prepared-review-flow.ui.test.tsx` (new)

**Interfaces:**
- Consumes: `POST /v1/reviews/run` → `{ runId, attemptId, model, reasoning }`; `POST /v1/runs/review-pr` → `OwnedRun { sessionId, attemptId, runId, projection }`. Both response shapes contain `runId` and `attemptId`.
- Produces: `onWorkbenchPatch({ runId, session })` where `session` is the whole session projection plus `currentAttemptId`. Later tasks rely on `startOwnedRun(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/prepared-review-flow.ui.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreparedReviewFlow, type PreparedReviewFlowWorkbench } from "../../src/renderer/src/flows/prepared-review-flow";

const workbench: PreparedReviewFlowWorkbench = {
  state: "review_started",
  session: {
    id: "session-1",
    key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: "abcdef1234567890" },
  },
};

const models = { models: [{ id: "model-1", label: "Model One" }], defaultModel: "model-1", defaultReasoning: "medium" };

type MockRequest = { readonly path: string; readonly method?: string; readonly body?: unknown };

function mockApi(handler: (request: MockRequest) => { readonly ok: boolean; readonly status: number; readonly body: unknown }) {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request: vi.fn((request: MockRequest) => Promise.resolve({ correlationId: "test", ...handler(request) })) },
  });
}

const ok200 = (body: unknown) => ({ ok: true as const, status: 200, body });

async function startFromDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
  const confirm = await screen.findByRole("button", { name: "Start read-only review" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
}

describe("prepared review run start", () => {
  it("applies runId and attemptId so the workbench enters live progress", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return ok200({ runId: "run-1", attemptId: "001", model: "model-1", reasoning: "medium" });
      throw new Error(`unexpected ${request.path}`);
    });
    const patched = vi.fn();
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={patched} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    await waitFor(() => expect(patched).toHaveBeenCalledWith({
      runId: "run-1",
      session: { ...workbench.session, currentAttemptId: "001" },
    }));
  });

  it("shows an error and patches nothing when the start response lacks attemptId", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return ok200({ runId: "run-1" });
      throw new Error(`unexpected ${request.path}`);
    });
    const patched = vi.fn();
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={patched} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    // findAllByText: Task 2 renders the same error inside the open dialog as well.
    expect((await screen.findAllByText("Patchdesk could not start this read-only review.")).length).toBeGreaterThan(0);
    expect(patched).not.toHaveBeenCalled();
  });

  it("shows the head-change message when the start is rejected with 409", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return { ok: false as const, status: 409, body: { error: "head_changed" } };
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    // findAllByText: Task 2 renders the same error inside the open dialog as well.
    expect((await screen.findAllByText("GitHub changed after this snapshot was prepared. Refresh and reopen before running a review.")).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx`
Expected: FAIL — first test sees `onWorkbenchPatch` called with only `{ runId: "run-1" }`; second test finds no error text.

- [ ] **Step 3: Implement the propagation fix**

In `src/renderer/src/flows/prepared-review-flow.tsx`:

Widen the patch prop type (line 62):

```ts
readonly onWorkbenchPatch: (patch: {
  readonly runId?: string;
  readonly session?: PreparedReviewFlowWorkbench["session"];
}) => void;
```

Replace `startRun`'s return so it keeps both identifiers and reports an invalid response shape:

```ts
const startRun = async (): Promise<{ readonly runId: string; readonly attemptId: string } | undefined> => {
  if (reviewModel === undefined) {
    setRunError("No enabled Pi review model is available. Update the active Pi runtime settings, then try again.");
    return undefined;
  }
  try {
    setRunError(undefined);
    saveReviewExecutionPreference(profileId, { model: reviewModel, reasoning: reviewReasoning });
    const value = await requestJson("/v1/reviews/run", {
      method: "POST",
      body: { profileId, sessionId: workbench.session.id, model: reviewModel, reasoning: reviewReasoning },
    });
    if (isRunStart(value)) return { runId: value.runId, attemptId: value.attemptId };
    setRunError("Patchdesk could not start this read-only review.");
    return undefined;
  } catch (cause: unknown) {
    setRunError(cause instanceof PatchdeskApiError && cause.status === 409
      ? "GitHub changed after this snapshot was prepared. Refresh and reopen before running a review."
      : "Patchdesk could not start this read-only review.");
    return undefined;
  }
};
```

Replace `resumePreparedRun` and `startOwnedRun`:

```ts
const resumePreparedRun = async (): Promise<{ readonly runId: string; readonly attemptId: string } | undefined> => {
  const attemptId = workbench.session.currentAttemptId;
  if (attemptId === undefined) return undefined;
  try {
    const value = await requestJson("/v1/runs/review-pr", {
      method: "POST",
      body: { profileId, sessionId: workbench.session.id, attemptId },
    });
    return isRunStart(value) ? { runId: value.runId, attemptId } : undefined;
  } catch {
    return undefined;
  }
};

const startOwnedRun = async (): Promise<boolean> => {
  const started = workbench.session.currentAttemptId === undefined
    ? await startRun()
    : await resumePreparedRun();
  if (started === undefined) return false;
  onWorkbenchPatch({
    runId: started.runId,
    session: { ...workbench.session, currentAttemptId: started.attemptId },
  });
  return true;
};
```

Update the `isRunStart` guard to require both identifiers:

```ts
function isRunStart(value: unknown): value is { readonly runId: string; readonly attemptId: string } {
  return typeof value === "object" && value !== null
    && "runId" in value && typeof value.runId === "string"
    && "attemptId" in value && typeof value.attemptId === "string";
}
```

Adapt the `SafeRunPanel` `onStart` prop (its type stays `() => Promise<void>`):

```tsx
onStart={async () => { await startOwnedRun(); }}
```

Note: `app.tsx` needs no change — its shallow merge `{ ...current, ...patch }` already replaces top-level `runId` and `session` keys, and the flow always sends the whole session object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/flows/prepared-review-flow.tsx tests/renderer/prepared-review-flow.ui.test.tsx
git commit -m "fix: enter live review progress at run start"
```

---

### Task 2: Starting state and dialog-local errors (Moment 1)

**Files:**
- Modify: `src/renderer/src/flows/prepared-review-flow.tsx` (state block ~line 76, dialog footer ~line 250)
- Test: `tests/renderer/prepared-review-flow.ui.test.tsx`

**Interfaces:**
- Consumes: `startOwnedRun(): Promise<boolean>` from Task 1.
- Produces: `confirmStart(): Promise<void>` used by the dialog confirm button.

- [ ] **Step 1: Write the failing tests**

Append to `tests/renderer/prepared-review-flow.ui.test.tsx`:

```tsx
describe("run dialog starting state", () => {
  it("keeps the dialog open with a busy confirm button while the start is in flight", async () => {
    let release: (() => void) | undefined;
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") {
        return { ok: true as const, status: 200, body: new Promise(() => {}) };
      }
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
    const confirm = await screen.findByRole("button", { name: "Start read-only review" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    const busy = await screen.findByRole("button", { name: "Starting…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Start read-only review" })).toBeNull();
    release?.();
  });

  it("shows start errors inside the dialog when opened from the checks section", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return { ok: false as const, status: 503, body: { error: "storage" } };
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} initialSection="checks" onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
    const confirm = await screen.findByRole("button", { name: "Start read-only review" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Patchdesk could not start this read-only review."));
  });
});
```

(The unused `release` keeps the never-resolving promise obviously intentional; drop it if lint complains and use `void 0` instead.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx`
Expected: FAIL — the dialog closes instantly today, so "Starting…" never appears, and the error lands outside the dialog.

- [ ] **Step 3: Implement the busy state and dialog-local error**

In `prepared-review-flow.tsx`, add state next to `runError`:

```ts
const [starting, setStarting] = useState(false);
```

Add the confirm handler near `startOwnedRun`:

```ts
const confirmStart = async (): Promise<void> => {
  setStarting(true);
  try {
    const started = await startOwnedRun();
    if (started) setRunDialogOpen(false);
  } finally {
    setStarting(false);
  }
};
```

Inside the dialog, above `<DialogFooter>`, render the start error (this makes errors visible from every section, including diff/checks where the ready card is hidden):

```tsx
{runError === undefined ? null : (
  <Alert variant="destructive">
    <AlertTitle>Review was not started</AlertTitle>
    <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
      {runError}
      <Button variant="outline" size="sm" onClick={() => void refreshPrepared()}>Refresh and reopen review</Button>
    </AlertDescription>
  </Alert>
)}
```

Replace the confirm button in `<DialogFooter>`:

```tsx
<Button disabled={reviewModel === undefined || starting} onClick={() => void confirmStart()}>
  {starting ? "Starting…" : "Start read-only review"}
</Button>
```

Keep the existing ready-card `runError` display as a fallback for errors that happen while the dialog is closed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/flows/prepared-review-flow.tsx tests/renderer/prepared-review-flow.ui.test.tsx
git commit -m "feat: show starting state and errors in the run dialog"
```

---

### Task 3: Finalizing state and manual reconnect poll (Moments 4+5)

**Files:**
- Modify: `src/renderer/src/components/safe-run-panel.tsx`
- Test: `tests/renderer/safe-run-panel.ui.test.tsx`

**Interfaces:**
- Consumes: existing `onCompleted?: (profileId, sessionId) => Promise<void>` prop (renamed only in Task 8).
- Produces: `settle(status: "completed"): Promise<void>` internal helper; `pollNonce` state. Task 8 reuses both for the failed branch.

- [ ] **Step 1: Write the failing tests**

Append to `tests/renderer/safe-run-panel.ui.test.tsx`:

```tsx
describe("settling the finished run", () => {
  it("shows a finalizing state while the workbench reloads", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn(() => new Promise<void>(() => {}));
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onCompleted={completed} />);

    expect(await screen.findByText("Finalizing review…")).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the workbench reload fails", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(undefined);
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onCompleted={completed} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
  });
});

describe("disconnected polling", () => {
  it("retries immediately when the user asks for a check", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 5, step: "inspecting" } });
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);

    fireEvent.click(await screen.findByRole("button", { name: "Check again now" }));

    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Run status: running")).toBeTruthy();
  });
});
```

Add `fireEvent` to the existing `@testing-library/react` import in that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run tests/renderer/safe-run-panel.ui.test.tsx`
Expected: FAIL — no "Finalizing review…", no "Retry", no "Check again now".

- [ ] **Step 3: Implement the panel states**

In `safe-run-panel.tsx`, add state:

```ts
const [settling, setSettling] = useState(false);
const [settleError, setSettleError] = useState(false);
const [pollNonce, setPollNonce] = useState(0);
```

Add the settle helper above the effect:

```ts
const settle = async (): Promise<void> => {
  if (onCompleted === undefined) return;
  setSettling(true);
  try {
    await onCompleted(profileId, sessionId);
    setSettling(false);
  } catch {
    setSettling(false);
    setSettleError(true);
  }
};
```

In the polling effect, replace the completed branch:

```ts
if (parsed.value.status === "completed") {
  await settle();
  return;
}
```

Add `pollNonce` to the effect dependency array.

Change the disconnected projection message in the catch block to the honest copy:

```ts
setProjection({ status: "disconnected", elapsedMs: 0, step: "inspecting", message: "Lost the local run connection — retrying automatically." });
```

Add the "Check again now" button inside the message `AlertDescription` (give the description `className="mt-1 flex flex-wrap items-center gap-2"`):

```tsx
{current.status === "disconnected" ? (
  <Button
    variant="outline"
    size="sm"
    onClick={() => {
      setProjection(undefined);
      setPollNonce((nonce) => nonce + 1);
    }}
  >
    Check again now
  </Button>
) : null}
```

Add the settling and settle-error branches immediately after the `runId === undefined` recovery branch, before the normal card render:

```tsx
if (settleError) {
  return (
    <Alert className="mt-4" variant="destructive">
      <CircleAlert />
      <AlertTitle>Could not load the review outcome</AlertTitle>
      <AlertDescription className="mt-2">
        The run finished, but the workbench could not be updated.
        <Button size="sm" className="mt-3 block" onClick={() => { setSettleError(false); void settle(); }}>Retry</Button>
      </AlertDescription>
    </Alert>
  );
}

if (settling) {
  return (
    <Card className="mt-5 gap-0 rounded-lg py-0 shadow-none" aria-live="polite" aria-busy="true">
      <CardContent className="p-0">
        <Item className="rounded-b-none border-0 p-4">
          <ItemContent>
            <ItemTitle>Finalizing review…</ItemTitle>
            <p className="text-xs text-muted-foreground">Saving results</p>
          </ItemContent>
          <ItemActions><Badge variant="secondary"><Spinner />saving</Badge></ItemActions>
        </Item>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/safe-run-panel.ui.test.tsx`
Expected: PASS (all existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/safe-run-panel.tsx tests/renderer/safe-run-panel.ui.test.tsx
git commit -m "feat: add finalizing and manual-check states to the run panel"
```

---

### Task 4: Session state in projection and recovery copy (Moments 6+7)

**Files:**
- Modify: `src/services/review-workbench-projection.ts` (`WorkbenchSessionProjection` type ~line 38, `projectSession` at end of file)
- Modify: `src/renderer/src/renderer-contracts.ts` (`workbenchSessionSchema` ~line 108)
- Modify: `src/renderer/src/flows/prepared-review-flow.tsx` (`PreparedReviewFlowWorkbench` session type, `SafeRunPanel` usage)
- Modify: `src/renderer/src/components/safe-run-panel.tsx` (recovery branch)
- Test: `tests/renderer/renderer-contracts.test.ts`
- Test: `tests/services/review-workbench-projection.test.ts`
- Test: `tests/renderer/safe-run-panel.ui.test.tsx`

**Interfaces:**
- Produces: `WorkbenchSessionProjection.state: ReviewSession["state"]["_tag"]` and `WorkbenchSessionProjection.lastRunFailure?: string`. Renderer contract carries both as optional strings. `SafeRunPanel` gains optional props `recoveryMessage?: string`, `recoveryActionLabel?: string`, `startError?: string`.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/renderer-contracts.test.ts`, extend `sessionProjection` usage with a new case:

```ts
it("carries the session lifecycle state and last run failure", () => {
  const prepared = parseWorkbenchResponse({
    state: "review_started",
    session: { ...sessionProjection, state: "ReviewFailed", lastRunFailure: "The review workflow did not complete." },
    reviewedHeadSha: "2222222222222222222222222222222222222222",
    freshness: "fresh",
    refreshedAt: "2026-07-18T00:00:00.000Z",
    checks: { overall: "unknown", checks: [] },
  });
  expect(prepared?.state).toBe("review_started");
  expect(prepared?.session).toMatchObject({ state: "ReviewFailed", lastRunFailure: "The review workflow did not complete." });
});
```

In `tests/services/review-workbench-projection.test.ts`, extend the existing test `"projects a prepared session without attempt history or preparation work"` (line ~296) with a `session` assertion:

```ts
expect(projection).toMatchObject({ session: { state: "Created" } });
```

and add a new test in the same file, reusing its fixture helpers (same pattern as the prepared test: persist a session via `ReviewSessionStore`, call the projection service `load`):

```ts
it("surfaces the last run failure for a failed session", async () => {
  // Same fixture body as the prepared-session test, but persist the session as:
  //   state: { _tag: "ReviewFailed", attemptId: "001", error: { category: "flue", message: "The review workflow did not complete." } }
  // with no currentAttemptId.
  const projection = await service.load({ profileId, sessionId });
  expect(projection).toMatchObject({
    _tag: "ok",
    value: { session: { state: "ReviewFailed", lastRunFailure: "The review workflow did not complete." } },
  });
});
```

In `tests/renderer/safe-run-panel.ui.test.tsx`:

```tsx
it("uses reconnect copy when the persisted session is still running", async () => {
  Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn() } });
  render(
    <SafeRunPanel
      profileId="cfw"
      sessionId="session"
      attemptId="001"
      recoveryMessage="This review may still be running in the background."
      recoveryActionLabel="Reconnect"
    />,
  );
  expect(await screen.findByText("This review may still be running in the background.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run tests/renderer/renderer-contracts.test.ts tests/services/review-workbench-projection.test.ts tests/renderer/safe-run-panel.ui.test.tsx`
Expected: FAIL — `state`/`lastRunFailure` are stripped by the strict valibot schema, and the panel has no custom-copy props.

- [ ] **Step 3: Implement projection, contract, and copy**

`src/services/review-workbench-projection.ts` — extend the type and `projectSession`:

```ts
export type WorkbenchSessionProjection = {
  readonly id: ReviewSessionId;
  readonly key: {
    readonly profileId: WorkspaceProfileId;
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly prNumber: PullRequestNumber;
    readonly headSha: GitSha;
  };
  readonly state: ReviewSession["state"]["_tag"];
  readonly lastRunFailure?: string;
  readonly currentAttemptId?: ReviewAttemptId;
};
```

```ts
function projectSession(session: ReviewSession): WorkbenchSessionProjection {
  return {
    id: session.id,
    key: {
      profileId: session.key.profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      prNumber: session.key.prNumber,
      headSha: session.key.headSha,
    },
    state: session.state._tag,
    ...(session.state._tag === "ReviewFailed" ? { lastRunFailure: session.state.error.message } : {}),
    ...(session.state._tag === "Stale" && session.state.reason === "orphaned_run"
      ? { lastRunFailure: "Patchdesk restarted before this review run completed." }
      : {}),
    ...(session.currentAttemptId === undefined ? {} : { currentAttemptId: session.currentAttemptId }),
  };
}
```

`src/renderer/src/renderer-contracts.ts` — extend `workbenchSessionSchema`:

```ts
const workbenchSessionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  key: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    host: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.minLength(1)),
    repo: v.pipe(v.string(), v.minLength(1)),
    prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
  }),
  state: v.optional(v.string()),
  lastRunFailure: v.optional(v.string()),
  currentAttemptId: v.optional(v.pipe(v.string(), v.minLength(1))),
});
```

`src/renderer/src/flows/prepared-review-flow.tsx` — extend the session type:

```ts
readonly session: {
  readonly id: string;
  readonly key: {
    readonly profileId: string;
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly headSha: string;
  };
  readonly state?: string;
  readonly lastRunFailure?: string;
  readonly currentAttemptId?: string;
};
```

`src/renderer/src/components/safe-run-panel.tsx` — add the props and use them in the recovery branch:

```ts
readonly recoveryMessage?: string;
readonly recoveryActionLabel?: string;
readonly startError?: string;
```

```tsx
if (runId === undefined) {
  return (
    <Alert className="mt-4">
      <RotateCcw />
      <AlertTitle>This review is not running</AlertTitle>
      <AlertDescription className="mt-2">
        {recoveryMessage ?? "The previous review run did not finish."}
        {startError === undefined ? null : <span className="mt-1 block">{startError}</span>}
        {onStart === undefined ? null : (
          <Button size="sm" className="mt-3 block" disabled={starting} onClick={() => void start()}>
            {starting ? "Starting…" : (recoveryActionLabel ?? "Start review")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
```

Back in `prepared-review-flow.tsx`, pass the new props and surface resume failures:

```tsx
<SafeRunPanel
  profileId={profileId}
  sessionId={workbench.session.id}
  attemptId={workbench.session.currentAttemptId}
  {...(workbench.runId === undefined ? {} : { runId: workbench.runId })}
  {...(workbench.session.state === "Running"
    ? { recoveryMessage: "This review may still be running in the background.", recoveryActionLabel: "Reconnect" }
    : {})}
  {...(runError === undefined ? {} : { startError: runError })}
  onStart={async () => {
    const started = await startOwnedRun();
    if (!started) setRunError("Patchdesk could not start this review run.");
  }}
  onCompleted={loadCompleted}
/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/renderer-contracts.test.ts tests/services/review-workbench-projection.test.ts tests/renderer/safe-run-panel.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/review-workbench-projection.ts src/renderer/src/renderer-contracts.ts src/renderer/src/flows/prepared-review-flow.tsx src/renderer/src/components/safe-run-panel.tsx tests/renderer/renderer-contracts.test.ts tests/services/review-workbench-projection.test.ts tests/renderer/safe-run-panel.ui.test.tsx
git commit -m "feat: explain interrupted and reconnectable review runs"
```

---

### Task 5: PR-1 gate and live QA checkpoint

**Files:** none (verification only)

- [ ] **Step 1: Full repo gate**

Run: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test`
Expected: all green. Fix anything attributable to Tasks 1–4; pre-existing failures must be named in the verification report.

- [ ] **Step 2: Package and spawn the tester subagent**

Run: `pnpm package:mac && pnpm test:package-smoke`

Launch an isolated app and hand QA to the repo's dedicated `electron-tester` subagent (project agent at `.pi/agents/electron-tester.md`; repo rule — the primary agent must not do the live UI steps):

```bash
./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk --user-data-dir=/tmp/patchdesk-qa-lifecycle --remote-debugging-port=9233
```

Tester checklist for the `electron-tester` subagent (it already knows the agent-browser CDP recipe; the task text adds: `snapshot -i` before every interaction, `errors` + `console` after each step, screenshots for evidence):

1. Open a prepared PR session, click **Run review**, confirm the dialog shows **Starting…** and stays open until the run begins.
2. Assert the workbench enters live progress immediately (run status card with step/elapsed) without an inbox detour.
3. Reload the session mid-run: assert the recovery panel says "This review may still be running in the background." with a **Reconnect** button; click it and assert live progress resumes.
4. Assert no page errors, no console errors, and no horizontal overflow (`document.documentElement.scrollWidth - document.documentElement.clientWidth === 0`).

- [ ] **Step 3: Open PR 1**

Base branch per repo convention (verify with `gh pr list --state merged --limit 3 --json baseRefName --jq '.[].baseRefName'`). Title: `fix: review run lifecycle states`. Body cites the spec (`.agents/tasks/review-run-lifecycle/spec.md`) and the exact gate commands run.

---

### Task 6: ReviewFailureService (L2)

**Files:**
- Create: `src/services/review-failure-service.ts`
- Test: `tests/services/review-failure-service.test.ts` (new)

**Interfaces:**
- Consumes: persisted `ReviewSession` + `ReviewAttempt` from `ReviewSessionStore`.
- Produces: `ReviewFailureService.fail(input: unknown): Promise<Result<{ readonly failed: true }, { readonly reason: string }>>`. Task 7 wires it; Task 8 relies on the session becoming `ReviewFailed` with `currentAttemptId` cleared.

- [ ] **Step 1: Write the failing test**

Create `tests/services/review-failure-service.test.ts`, mirroring the `review-completion-service.test.ts` fixture:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { createReviewSession, startNextAttempt } from "../../src/domain/review-session";
import { ReviewFailureService } from "../../src/services/review-failure-service";

const roots: string[] = [];
const at = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewFailureService", () => {
  it("persists a failed attempt and makes the session runnable again", async () => {
    const fixture = await runningReview();

    const failed = await fixture.service.fail({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      category: "flue",
      message: "The review workflow did not complete.",
    });

    expect(failed).toEqual({ _tag: "ok", value: { failed: true } });
    const storedSession = await fixture.store.load(fixture.profileId, fixture.session.id);
    expect(storedSession).toMatchObject({
      _tag: "ok",
      value: {
        state: { _tag: "ReviewFailed", attemptId: "001", error: { category: "flue", message: "The review workflow did not complete." } },
      },
    });
    expect(storedSession._tag === "ok" && storedSession.value.currentAttemptId).toBeUndefined();
    const storedAttempt = await fixture.store.loadAttempt(fixture.profileId, fixture.session.id, fixture.attempt.id);
    expect(storedAttempt).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Failed", error: { category: "flue" } }, completedAt: at },
    });
  });

  it("rejects a failure record for a session that is not running", async () => {
    const fixture = await runningReview();
    const stored = await fixture.store.load(fixture.profileId, fixture.session.id);
    if (stored._tag !== "ok") throw new Error("fixture session missing");
    const { currentAttemptId: _cleared, ...rest } = stored.value;
    expect(await fixture.store.save({ ...rest, state: { _tag: "Created" } })).toEqual({ _tag: "ok", value: undefined });

    const result = await fixture.service.fail({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      category: "flue",
      message: "late failure",
    });

    expect(result).toEqual({ _tag: "err", error: { reason: "not_current" } });
  });
});

function must<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

async function runningReview() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-failure-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const key = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
    headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  };
  const seed = createReviewSession({
    key,
    pr: { headSha: key.headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha },
    createdAt: at,
  });
  const session = {
    ...seed,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seed.id))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seed.id))), headSha: key.headSha },
  };
  const started = must(startNextAttempt(session, []));
  const attempt = {
    id: started.attemptId,
    sessionId: started.session.id,
    state: { _tag: "Running" as const, flueRunId: "fixture-run" },
    flueRunId: "fixture-run",
    model: "fixture-model",
    reviewSkillVersion: must(parseContentHash("a".repeat(64))),
    contextHash: must(parseContentHash("b".repeat(64))),
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, started.session.id, started.attemptId))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, started.session.id, started.attemptId))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, started.session.id, started.attemptId))),
    startedAt: at,
  };
  const store = new ReviewSessionStore(paths);
  expect(await store.save(started.session)).toEqual({ _tag: "ok", value: undefined });
  expect(await store.saveAttempt(profileId, started.session.id, attempt)).toEqual({ _tag: "ok", value: undefined });
  await writeFile(started.session.patchPath, "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -12 +12 @@\n-old\n+new\n", "utf8");
  return {
    service: new ReviewFailureService(paths, () => at),
    store,
    profileId,
    session: started.session,
    attempt,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/services/review-failure-service.test.ts`
Expected: FAIL — module `../../src/services/review-failure-service` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/services/review-failure-service.ts`:

```ts
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";

/**
 * Persists a failed live run so the session becomes visibly runnable again.
 * Clearing currentAttemptId is deliberate: the ready card and the normal
 * start path take over, and resume never re-enters a dead run.
 */
export class ReviewFailureService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp) {}

  async fail(input: unknown): Promise<Result<{ readonly failed: true }, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const attemptId = parseReviewAttemptId(readObjectField(input, "attemptId"));
    const message = readObjectField(input, "message");
    const rawCategory = readObjectField(input, "category");
    const category = rawCategory === "flue" || rawCategory === "storage" ? rawCategory : "unknown";
    if (
      profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err" ||
      typeof message !== "string" || message.length === 0
    ) return err({ reason: "invalid_input" });

    const store = new ReviewSessionStore(this.paths);
    const [session, attempt] = await Promise.all([
      store.load(profileId.value, sessionId.value),
      store.loadAttempt(profileId.value, sessionId.value, attemptId.value),
    ]);
    if (session._tag === "err" || attempt._tag === "err") return err({ reason: "not_found" });
    if (
      session.value.currentAttemptId !== attemptId.value ||
      session.value.state._tag !== "Running" ||
      (attempt.value.state._tag !== "Starting" && attempt.value.state._tag !== "Running")
    ) return err({ reason: "not_current" });

    const error = { category, message };
    const failedAt = this.now();
    const failedAttempt = { ...attempt.value, state: { _tag: "Failed" as const, error }, completedAt: failedAt };
    const { currentAttemptId: _cleared, ...sessionRest } = session.value;
    const failedSession = {
      ...sessionRest,
      state: { _tag: "ReviewFailed" as const, attemptId: attemptId.value, error },
      updatedAt: failedAt,
    };
    const savedAttempt = await store.saveAttempt(profileId.value, sessionId.value, failedAttempt);
    const savedSession = savedAttempt._tag === "ok" ? await store.save(failedSession) : savedAttempt;
    return savedSession._tag === "ok" ? ok({ failed: true as const }) : err({ reason: "storage_failed" });
  }
}
```

(The rest-destructuring omit of `currentAttemptId` is required by `exactOptionalPropertyTypes`; TypeScript and the repo lint config both allow unused rest siblings.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run tests/services/review-failure-service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/review-failure-service.ts tests/services/review-failure-service.test.ts
git commit -m "feat: persist failed review runs as runnable sessions"
```

---

### Task 7: Wire failure persistence and reconcile restarts as ReviewFailed

**Files:**
- Modify: `src/main/electron-main.ts` (`createWorkflowInvoker`)
- Modify: `src/services/review-workbench.ts` (`recoverOrphanedWorkbenchAttempt`, lines 129–161)
- Test: `tests/services/review-workbench.test.ts` (update the orphaned-attempt test, line ~228)

**Interfaces:**
- Consumes: `ReviewFailureService` from Task 6.
- Produces: on any workflow `err`, session `ReviewFailed` is persisted before the run projection goes failed — Task 8's renderer settle then reloads into the banner. Reconciled restart-orphans are also `ReviewFailed` (runnable), never `Stale`.

- [ ] **Step 1: Update the failing test first**

In `tests/services/review-workbench.test.ts`, update the orphaned-attempt test:

```ts
it("marks an orphaned starting attempt failed and the session runnable after Patchdesk restarts", () => {
  const running = {
    ...session,
    state: { _tag: "Running", attemptId: "001" },
  } as ReviewSession;
  const recovered = recoverOrphanedWorkbenchAttempt({
    session: running,
    attempt: { ...attempt, state: { _tag: "Starting" } } as ReviewAttempt,
    recoveredAt: "2026-07-16T00:04:00.000Z" as never,
  });

  expect(recovered).toMatchObject({
    _tag: "ok",
    value: {
      session: {
        state: {
          _tag: "ReviewFailed",
          attemptId: "001",
          error: { category: "flue", message: "Patchdesk restarted before this review run completed." },
        },
      },
      attempt: { state: { _tag: "Failed", error: { category: "flue" } } },
    },
  });
  expect(recovered._tag === "ok" && recovered.value.session.currentAttemptId).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run tests/services/review-workbench.test.ts`
Expected: FAIL — reconciliation currently writes `Stale`/`orphaned_run` and keeps `currentAttemptId`.

- [ ] **Step 3: Implement reconciliation and wiring**

`src/services/review-workbench.ts` — replace the `ok({...})` in `recoverOrphanedWorkbenchAttempt`:

```ts
const { currentAttemptId: _cleared, ...sessionRest } = input.session;
return ok({
  session: {
    ...sessionRest,
    state: {
      _tag: "ReviewFailed",
      attemptId: input.attempt.id,
      error: {
        category: "flue",
        message: "Patchdesk restarted before this review run completed.",
      },
    },
    updatedAt: input.recoveredAt,
  },
  attempt: {
    ...input.attempt,
    state: {
      _tag: "Failed",
      error: {
        category: "flue",
        message: "Patchdesk restarted before this review run completed.",
      },
    },
    completedAt: input.recoveredAt,
  },
});
```

Update the function's doc comment: reconciliation now marks the interruption visibly failed so the session is runnable again, instead of relaunching or stalling.

`src/main/electron-main.ts` — in `createWorkflowInvoker`, construct the service next to `completion` and persist on both error paths:

```ts
const failure = new ReviewFailureService(
  PatchdeskPaths.default(),
  () => new Date().toISOString() as never,
);
```

```ts
const result = await flue.invoke(input, options);
if (result._tag === "err") {
  // Best effort: if this write fails, startup reconciliation is the backstop.
  await failure.fail({
    profileId: input.profileId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    category: "flue",
    message: "The review workflow did not complete.",
  });
  return err({ reason: "failed" as const });
}
options?.onActivity?.("drafting");
const persisted = await completion.complete({
  profileId: input.profileId,
  sessionId: input.sessionId,
  attemptId: input.attemptId,
  result: result.value,
});
if (persisted._tag === "err") {
  await failure.fail({
    profileId: input.profileId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    category: "unknown",
    message: "The review result could not be saved.",
  });
  return err({ reason: "failed" as const });
}
```

Add the import:

```ts
import { ReviewFailureService } from "../services/review-failure-service";
```

(The `failure.fail` result is intentionally not inspected: a `not_current` outcome means completion already won the race, which is fine.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run tests/services/review-workbench.test.ts tests/services/review-failure-service.test.ts tests/services/review-run-coordinator.test.ts tests/storage/review-session-store-begin-attempt.test.ts`
Expected: PASS. Note: `beginAttempt` already accepts `ReviewFailed` sessions (it rejects only `Running`, `Merged`, `Stale`), so no store change is needed — the begin-attempt suite must stay green unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/electron-main.ts src/services/review-workbench.ts tests/services/review-workbench.test.ts
git commit -m "feat: record live and orphaned run failures as review failures"
```

---

### Task 8: Settle on failed projections and show the failure banner

**Files:**
- Modify: `src/renderer/src/components/safe-run-panel.tsx` (rename `onCompleted` → `onSettled`, failed branch, settling copy)
- Modify: `src/renderer/src/flows/prepared-review-flow.tsx` (rename `loadCompleted` → `reloadAfterSettle`, pass `onSettled`, ready-card banner)
- Test: `tests/renderer/safe-run-panel.ui.test.tsx`
- Test: `tests/renderer/prepared-review-flow.ui.test.tsx`
- Test: `tests/domain/maintainer-inbox.test.ts`

**Interfaces:**
- Consumes: persisted `ReviewFailed` from Tasks 6–7; `lastRunFailure` projection from Task 4.
- Produces: `SafeRunPanel` prop `onSettled?: (profileId: string, sessionId: string) => Promise<void>` (replaces `onCompleted`).

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/safe-run-panel.ui.test.tsx`, rename `onCompleted` to `onSettled` in the two existing tests that use it, then append:

```tsx
it("settles the workbench when the run fails", async () => {
  Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "failed", elapsedMs: 30, step: "failed", message: "Review run failed" } }) } });
  const settled = vi.fn();
  render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onSettled={settled} />);

  await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
});
```

In `tests/renderer/prepared-review-flow.ui.test.tsx`, append:

```tsx
it("shows the previous run failure above the ready card", async () => {
  mockApi((request) => {
    if (request.path === "/v1/reviews/models") return ok200(models);
    throw new Error(`unexpected ${request.path}`);
  });
  const failedWorkbench: PreparedReviewFlowWorkbench = {
    ...workbench,
    session: { ...workbench.session, state: "ReviewFailed", lastRunFailure: "The review workflow did not complete." },
  };
  render(<PreparedReviewFlow workbench={failedWorkbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

  expect(await screen.findByText("Previous review run failed")).toBeTruthy();
  expect(screen.getByText(/The review workflow did not complete./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run review" })).toBeTruthy();
});
```

In `tests/domain/maintainer-inbox.test.ts`, append:

```ts
it("offers a fresh run instead of progress for a failed current-head review", () => {
  const row = projectMaintainerInboxRow({
    summary,
    checks: passingChecks,
    activeAccount: "maintainer",
    latestReview: { sessionId, reviewedHeadSha: sha, state: "failed", updatedAt, matchesCurrentHead: true },
    dataFreshness: "fresh",
  });
  expect(row.categories).not.toContain("running");
  expect(row.recommendedAction).toEqual({ kind: "run_review", label: "Run review" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run tests/renderer/safe-run-panel.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/domain/maintainer-inbox.test.ts`
Expected: FAIL — the panel has no `onSettled` prop and never settles on failed; the ready card has no banner. (The inbox test should already pass — keep it as a guard.)

- [ ] **Step 3: Implement settle-on-failed and the banner**

`src/renderer/src/components/safe-run-panel.tsx`:

Rename the prop everywhere: `onCompleted` → `onSettled`. Change `settle` from Task 3 to carry the terminal status for copy:

```ts
const [settling, setSettling] = useState<"completed" | "failed" | undefined>(undefined);

const settle = async (status: "completed" | "failed"): Promise<void> => {
  if (onSettled === undefined) return;
  setSettling(status);
  try {
    await onSettled(profileId, sessionId);
    setSettling(undefined);
  } catch {
    setSettling(undefined);
    setSettleError(true);
  }
};
```

Replace the completed and failed branches in the polling effect:

```ts
if (parsed.value.status === "completed" || parsed.value.status === "failed") {
  await settle(parsed.value.status);
  return;
}
```

Update the settling card copy to follow the status:

```tsx
<ItemTitle>{settling === "completed" ? "Finalizing review…" : "Recording the outcome…"}</ItemTitle>
<p className="text-xs text-muted-foreground">{settling === "completed" ? "Saving results" : "Updating the workbench"}</p>
```

The settle-error retry calls `void settle(projection?.status === "failed" ? "failed" : "completed")` after clearing `settleError`.

`src/renderer/src/flows/prepared-review-flow.tsx`:

Rename `loadCompleted` → `reloadAfterSettle` and pass it as `onSettled={reloadAfterSettle}`. Inside the ready card (the `currentAttemptId === undefined` branch), render the banner above the "Ready to review" heading:

```tsx
{workbench.session.lastRunFailure === undefined ? null : (
  <Alert variant="destructive" className="mb-3">
    <AlertTitle>Previous review run failed</AlertTitle>
    <AlertDescription>{workbench.session.lastRunFailure} You can start a new run.</AlertDescription>
  </Alert>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run tests/renderer/safe-run-panel.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/domain/maintainer-inbox.test.ts tests/services/review-failure-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/safe-run-panel.tsx src/renderer/src/flows/prepared-review-flow.tsx tests/renderer/safe-run-panel.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/domain/maintainer-inbox.test.ts
git commit -m "feat: settle the workbench after failed review runs"
```

---

### Task 9: PR-2 gate and live QA checkpoint

**Files:** none (verification only)

- [ ] **Step 1: Full repo gate**

Run: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test`
Expected: all green. Name any pre-existing failures in the verification report.

- [ ] **Step 2: Package and spawn the tester subagent**

Run: `pnpm package:mac && pnpm test:package-smoke`

Launch with a fresh isolated profile (use a distinct CDP port if 9233 is busy):

```bash
./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk --user-data-dir=/tmp/patchdesk-qa-lifecycle-2 --remote-debugging-port=9233
```

Tester checklist for the `electron-tester` subagent (agent-browser over CDP, `snapshot -i` before interactions, `errors` + `console` after each step, screenshots as evidence):

1. Start a review, wait for live progress, then **quit the app mid-run** and relaunch with the same user-data dir. Reopen the session: assert the ready card shows "Previous review run failed — Patchdesk restarted before this review run completed." and a working **Run review** button.
2. Start a new run from that banner state and assert live progress begins (proves `ReviewFailed` is runnable end to end).
3. Assert the inbox row for that PR no longer says "View review progress" after the failure.
4. Assert no page errors, no console errors, no horizontal overflow.
5. Do not enter any GitHub write confirmation during QA.

- [ ] **Step 3: Open PR 2**

Same base as PR 1. Title: `feat: persist and surface failed review runs`. Body cites the spec and the exact gate commands run.

---

## Self-review notes

- Spec coverage: Moments 0–8 map to Tasks 1–4 (0,1,4,5,6,7) and 6–8 (3, plus 7's reconciliation); Moment 8 and all "boundaries that do not change" are untouched by design. The three spec verification items are resolved in-plan: `beginAttempt` accepts `ReviewFailed` (Task 7, Step 4), inbox maps failed sessions to "Run review" with no code change (Task 8 guard test), session state reaches the renderer via Task 4's projection fields.
- Type consistency: `startOwnedRun(): Promise<boolean>` (Task 1) is consumed by Tasks 2 and 4; `settle(status)` (Task 3) gains the `"failed"` arm in Task 8; `onSettled` is introduced only in Task 8, with Task 3's `onCompleted` renamed there; `lastRunFailure`/`state` names match across projection, contract, flow type, and banner.
- Sequencing: PR 1 never settles on a failed projection, so the registry dead-end loop cannot occur before Task 7 lands persistence. The known pre-Task-6 limitation (failed run requires app restart) is intentional and documented in the spec.
