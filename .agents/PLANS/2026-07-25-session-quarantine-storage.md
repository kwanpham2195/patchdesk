---
created_at: 2026-07-25
repos:
  - patchdesk
status: ready
spec: .agents/tasks/session-quarantine-storage/spec.md
---

# Session Quarantine and Storage Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine unreadable review sessions before preparing a fresh session, then let users safely inspect and reclaim review storage from Settings.

**Architecture:** Add one storage-lifecycle adapter for verified, app-owned review and worktree directories, then use it from a narrow quarantine path in `ReviewSessionPreparation` and a `StorageManagementService` behind the authenticated loopback API. The renderer receives only safe projections and performs explicit per-action confirmations; Electron's `shell.trashItem` remains at the main-process composition boundary.

**Tech Stack:** Electron 43, TypeScript 5.9 strict mode, React 19, Hono, Valibot, Node filesystem APIs, Git worktree commands, Vitest, Playwright.

## Global Constraints

- Quarantine only on `StorageFailure.reason === "invalid_stored_value"`; `not_found`, I/O, permission, and malformed-JSON failures retain their current behavior.
- Quarantine renames session and worktree directories; it never deletes. If either required rename fails, return `SessionStorageUnavailable` and do not prepare a replacement session.
- A `Running` session is never discarded, deleted, quarantined, or cleared from cache.
- Discard retains `session.json` history, changes the session state to `Discarded`, and removes only its managed cache worktree.
- Delete is available only for a validated quarantine entry and moves its session/worktree to the system Trash through an explicit user click.
- Clear cache removes only worktree-cache directories not referenced by a `Running` session, then runs `git worktree prune` for each distinct configured repository `localPath`; it never touches session directories or GitHub.
- Keep `src/domain/` pure, sequence I/O in `src/services/`, and confine filesystem, Git, Electron, and HTTP details to adapters/composition routes.
- Persisted and renderer-boundary values are parsed; do not use `as any`, unchecked JSON casts, `vi.mock`, or `vi.spyOn`.
- No GitHub write, workflow relaunch, change to startup orphan reconciliation, or safe-run projection change is in scope.
- Stage explicit paths only. Commit format: `feat: <summary>` or `test: <summary>`, lowercase imperative, no trailing period.
- Full gate: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test && pnpm package:mac && pnpm test:package-smoke`.
- Packaged/live Electron verification is owned by a dedicated `electron-tester` subagent using `agent-browser` over CDP; the primary implementation agent must not perform live UI actions.

---

## File structure

- `src/domain/review-session.ts` — make the persisted `Discarded` state express discarding an idle historical session as well as a live attempt, and expose the pure legal transition.
- `src/adapters/storage/patchdesk-paths.ts` — centralize normal and quarantine roots for session and worktree directories.
- `src/adapters/storage/review-session-store.ts` — parse the expanded state and explicitly ignore `.quarantine` during normal session enumeration.
- `src/adapters/storage/review-artifact-storage.ts` — new adapter for verified, app-owned review artifact renames, quarantine enumeration, cache-size calculation, and removal of selected cache directories. It never calls Git or Electron.
- `src/services/review-session-preparation.ts` — quarantine only a proven-invalid stored session, then continue through the existing fresh preparation path.
- `src/services/review-worktree-service.ts` — prune a missing stale Git registration before adding a fresh worktree at the reused session path.
- `src/services/storage-management-service.ts` — new use-case service for safe settings projections, discard, quarantine deletion, and cache clearing.
- `src/main/local-api.ts` and `src/main/electron-main.ts` — compose the service, inject the Electron Trash capability, and expose authenticated local-only storage routes.
- `src/renderer/src/flows/settings-flow.tsx` — load the active profile's storage projection, render honest lists/size, and require confirmation for every mutation.
- Focused tests live alongside the existing preparation, worktree, storage, local-API, and profile-settings suites; no new browser suite is needed unless the existing Settings test cannot prove the confirmation flow.

### Task 1: Model discardable stored sessions and safe artifact paths

**Files:**
- Modify: `src/domain/review-session.ts` (state union and pure transition near `discardCurrentAttempt`)
- Modify: `src/adapters/storage/patchdesk-paths.ts` (after `worktreeDirectory`)
- Modify: `src/adapters/storage/review-session-store.ts` (session-state schema, `listSessions`, `parseSessionState`)
- Modify: `tests/domain/review-domain.test.ts` (discard-transition coverage)
- Modify: `tests/storage/patchdesk-storage.test.ts` (persisted-state and normal-listing coverage)

**Interfaces:**
- Produces `discardReviewSession(session, discardedAt): Result<ReviewSession, SessionImmutable | SessionRunning | SessionNotDiscardable>` for Task 3. Only `Created`, `ReviewFailed`, `ReviewCompleted`, and `Stale` are eligible; `Running`, `Merged`, and an already `Discarded` session are rejected. It returns `{ _tag: "Discarded" }` for a session without a current attempt and preserves the existing `{ _tag: "Discarded", attemptId }` shape for an attempted session.
- Produces `quarantinedSessionDirectory(profileId, entryName)` and `quarantinedWorktreeDirectory(profileId, entryName)` only from a validated entry name. Tasks 2 and 3 use these paths instead of reconstructing strings.
- Preserves `listSessions(profileId): Result<ReadonlyArray<ReviewSession>, StorageFailure>` while making the `.quarantine` exclusion explicit, and produces `isRecordedRunning(profileId, sessionId): Promise<Result<boolean, StorageFailure>>` for Task 2. This narrow raw-storage hint treats any persisted `state._tag === "Running"` as protected even when another stored field is invalid.

- [ ] **Step 1: Write failing domain and storage tests.**

Add a domain test proving that idle states can be discarded, while live work cannot:

```ts
expect(discardReviewSession({ ...session, state: { _tag: "Created" } }, times.completed))
  .toMatchObject({ _tag: "ok", value: { state: { _tag: "Discarded" }, updatedAt: times.completed } });
expect(discardReviewSession({ ...session, state: { _tag: "Running", attemptId: "001" as never } }, times.completed))
  .toEqual({ _tag: "err", error: { _tag: "SessionRunning" } });
```

In `tests/storage/patchdesk-storage.test.ts`, create a valid session plus `reviews/.quarantine/<entry>/session.json`; assert `listSessions(profile.id)` returns only the valid session and that parsing `{ _tag: "Discarded" }` succeeds. Save a deliberately invalid result on an otherwise `Running` record and assert `isRecordedRunning()` returns `true`, so Task 2 cannot move a live run aside.

- [ ] **Step 2: Run the focused tests to prove the contract is absent.**

Run:

```bash
pnpm test -- --run tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts
```

Expected: FAIL because the idle `Discarded` state is not representable/parsible and no quarantine-path API exists.

- [ ] **Step 3: Implement the smallest persisted-state and path changes.**

In `ReviewSessionState`, make only `Discarded.attemptId` optional. Add a pure transition which guards terminal/live states without mutating attempts:

```ts
export function discardReviewSession(
  session: ReviewSession,
  discardedAt: IsoTimestamp,
): Result<ReviewSession, SessionImmutable | SessionRunning | SessionNotDiscardable> {
  if (session.state._tag === "Merged") return err({ _tag: "SessionImmutable" });
  if (session.state._tag === "Running") return err({ _tag: "SessionRunning" });
  if (
    session.state._tag !== "Created" &&
    session.state._tag !== "ReviewFailed" &&
    session.state._tag !== "ReviewCompleted" &&
    session.state._tag !== "Stale"
  ) return err({ _tag: "SessionNotDiscardable" });
  return ok({
    ...session,
    state: session.currentAttemptId === undefined
      ? { _tag: "Discarded" }
      : { _tag: "Discarded", attemptId: session.currentAttemptId },
    updatedAt: discardedAt,
  });
}
```

Update the Valibot `Discarded` variant to `attemptId: v.optional(v.string())`, parse it only when present, and skip `entry === ".quarantine"` before `parseReviewSessionId(entry)`. Implement `isRecordedRunning()` by parsing only the stored JSON envelope needed to identify `state._tag === "Running"`; do not require the rest of the session to parse before honoring that safety guard. Add path helpers for `reviews/.quarantine/<validated-entry>` and `review-worktrees/.quarantine/<validated-entry>`; do not let arbitrary renderer strings reach `join()`.

- [ ] **Step 4: Run the focused tests again.**

Run:

```bash
pnpm test -- --run tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts
```

Expected: PASS. Confirm legacy attempted-discard records still parse with their `attemptId`, while idle historical discards parse without one.

- [ ] **Step 5: Commit the self-contained model/storage slice.**

```bash
git add src/domain/review-session.ts src/adapters/storage/patchdesk-paths.ts src/adapters/storage/review-session-store.ts tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts
git diff --cached --check
git commit -m "feat: model discardable stored sessions"
```

### Task 2: Quarantine an invalid session before fresh preparation

**Files:**
- Create: `src/adapters/storage/review-artifact-storage.ts`
- Modify: `src/services/review-session-preparation.ts` (dependencies and `prepareSerialized`)
- Modify: `src/services/review-worktree-service.ts` (prune stale registration before add)
- Modify: `src/main/local-api.ts` (compose the adapter for normal preparation)
- Modify: `tests/services/review-session-preparation.test.ts`
- Modify: `tests/services/review-worktree.test.ts`

**Interfaces:**
- Produces `ReviewArtifactStorage.quarantine(profileId, sessionId, at): Promise<Result<{ readonly entryName: string }, StorageFailure>>`.
- `entryName` is generated internally as `<sessionId>.<YYYYMMDDTHHMMSS>` from the injected ISO timestamp. The adapter moves the cache worktree first (missing is accepted), then the session directory. It returns an error for any other rename failure.
- `ReviewSessionPreparation` consumes a `ReviewArtifactStorage`; no renderer, GitHub, or worktree API learns quarantine details.
- `ReviewWorktreeService.prepare()` runs `git -C <repo> worktree prune` immediately before `worktree add` when the managed target does not already have matching Patchdesk metadata.

- [ ] **Step 1: Write failing preparation and worktree tests.**

Extend the preparation fixture to save an intentionally invalid `session.json` at the derived session ID and create matching data/cache marker directories. Then assert a PR open returns `prepared`, the new root session is valid, and both old markers moved into matching `.quarantine/<session-id>.20260725T000000` locations:

```ts
expect(result).toMatchObject({ _tag: "ok", value: { disposition: "prepared" } });
expect(await exists(paths.quarantinedSessionDirectory(profileId, entryName))).toBe(true);
expect(await exists(paths.quarantinedWorktreeDirectory(profileId, entryName))).toBe(true);
expect(await exists(paths.sessionFile(profileId, targetId))).toBe(true);
```

Add a second fixture that makes the session rename fail; assert exactly `{ _tag: "err", error: { _tag: "SessionStorageUnavailable" } }` and no GitHub diff request. Add an invalid-but-`Running` fixture and assert the same honest error with both original directories still present. In `tests/services/review-worktree.test.ts`, assert the recorded argv contains `git -C /fixture/repository worktree prune` before `worktree add` for a missing target.

- [ ] **Step 2: Run the focused tests to prove current behavior is unsafe.**

Run:

```bash
pnpm test -- --run tests/services/review-session-preparation.test.ts tests/services/review-worktree.test.ts
```

Expected: FAIL: invalid stored data returns `SessionStorageUnavailable`; no quarantined roots exist; a stale worktree registration is not pruned.

- [ ] **Step 3: Implement quarantine and fresh-worktree behavior.**

Make `ReviewArtifactStorage` own filesystem mechanics with `mkdir`, `rename`, `readdir`, and `lstat`. Validate every derived path is beneath its respective Patchdesk root and reject symbolic links during destructive operations. Its quarantine core must preserve the same timestamp for both roots:

```ts
const entryName = `${sessionId}.${toQuarantineStamp(at)}`;
const worktreeMoved = await renameIfPresent(sourceWorktree, quarantinedWorktree);
if (worktreeMoved._tag === "err") return worktreeMoved;
return renameRequired(sourceSession, quarantinedSession).then((moved) =>
  moved._tag === "ok" ? ok({ entryName }) : moved,
);
```

In `prepareSerialized`, replace only this branch:

```ts
if (stored._tag === "err" && stored.error.reason === "invalid_stored_value") {
  const running = await deps.sessions.isRecordedRunning(input.profileId, sessionId);
  if (running._tag === "err" || running.value) return err({ _tag: "SessionStorageUnavailable" });
  const quarantined = await deps.artifacts.quarantine(input.profileId, sessionId, deps.now());
  if (quarantined._tag === "err") return err({ _tag: "SessionStorageUnavailable" });
} else if (stored._tag === "err" && stored.error.reason !== "not_found") {
  return err({ _tag: "SessionStorageUnavailable" });
}
```

Do not quarantine `invalid_json`: it is intentionally outside the specified `invalid_stored_value` trigger. In `ReviewWorktreeService.prepare`, prune only after resolving the configured repository and only when it is about to add a target whose metadata does not match.

- [ ] **Step 4: Run targeted verification.**

Run:

```bash
pnpm test -- --run tests/services/review-session-preparation.test.ts tests/services/review-worktree.test.ts tests/storage/patchdesk-storage.test.ts
```

Expected: PASS. Confirm an invalid persisted value opens as a clean preparation, an invalid record marked `Running` and a failed rename remain honest storage errors, normal readers hide `.quarantine`, and fresh worktree creation prunes stale registrations first.

- [ ] **Step 5: Commit the quarantine slice.**

```bash
git add src/adapters/storage/review-artifact-storage.ts src/services/review-session-preparation.ts src/services/review-worktree-service.ts src/main/local-api.ts tests/services/review-session-preparation.test.ts tests/services/review-worktree.test.ts
git diff --cached --check
git commit -m "feat: quarantine invalid review sessions"
```

### Task 3: Add storage-management use cases and authenticated local routes

**Files:**
- Create: `src/services/storage-management-service.ts`
- Modify: `src/adapters/storage/review-artifact-storage.ts` (safe quarantine enumeration, size, and cache-child removal operations)
- Modify: `src/main/local-api.ts` (service composition and routes)
- Modify: `src/main/electron-main.ts` (inject `shell.trashItem` as the main-process Trash capability)
- Create: `tests/services/storage-management-service.test.ts`
- Modify: `tests/local-api-auth.test.ts`

**Interfaces:**
- `StorageManagementService.list(profileId)` returns only this safe projection:

```ts
type StorageOverview = {
  readonly sessions: ReadonlyArray<{
    readonly id: string;
    readonly prLabel: string;
    readonly state: "Created" | "ReviewFailed" | "ReviewCompleted" | "Stale" | "Discarded" | "Merged" | "Running";
    readonly updatedAt: string;
    readonly canDiscard: boolean;
  }>;
  readonly quarantined: ReadonlyArray<{ readonly entryName: string; readonly quarantinedAt: string }>;
  readonly cacheBytes: number;
};
```

- `discard`, `deleteQuarantined`, and `clearCache` accept parsed domain IDs, return narrow tagged failures, and do not expose local paths or command output.
- New routes: `GET /v1/storage?profileId=...`, `POST /v1/storage/discard`, `POST /v1/storage/quarantine/delete`, and `POST /v1/storage/cache/clear`. All remain behind the existing origin + capability middleware.
- `LocalApiConfiguration` receives an optional `trash: { move(path: string): Promise<Result<void, StorageFailure>> }`. `electron-main.ts` supplies it with `shell.trashItem`; test startup supplies a recording fake. Missing Trash support makes only delete return a typed unavailable response.

- [ ] **Step 1: Write failing service and HTTP boundary tests.**

Create service fixtures with one `Created`, one `ReviewCompleted`, one `Running`, and one quarantined entry. Assert:

```ts
expect((await service.list(profileId)).value.sessions.map((entry) => entry.canDiscard))
  .toEqual([true, true, false]);
expect(await service.discard({ profileId, sessionId: running.id }))
  .toEqual({ _tag: "err", error: { _tag: "SessionRunning" } });
expect(await service.clearCache(profileId)).toMatchObject({ _tag: "ok" });
expect(await exists(paths.worktreeDirectory(profileId, running.id))).toBe(true);
```

Also assert discard writes `Discarded` while retaining `session.json`, removes the eligible managed worktree, delete calls the recording Trash mover for the validated quarantined session/worktree only, and clear removes non-running cache children before recording `git worktree prune` once per unique `localPath`.

In `tests/local-api-auth.test.ts`, start the API with this fixture and assert a capability-authenticated `GET /v1/storage?profileId=cfw` returns no filesystem paths; malformed IDs return 400; mutating routes use parsed JSON and cannot accept traversal-shaped quarantine names.

- [ ] **Step 2: Run the focused tests to prove the routes and policy do not exist.**

Run:

```bash
pnpm test -- --run tests/services/storage-management-service.test.ts tests/local-api-auth.test.ts
```

Expected: FAIL because no service/routes exist and no lifecycle policy protects running sessions.

- [ ] **Step 3: Implement the service, storage adapter operations, and routes.**

The service owns policy and ordering:

```ts
if (session.state._tag === "Running") return err({ _tag: "SessionRunning" });
if (
  session.state._tag !== "Created" &&
  session.state._tag !== "ReviewFailed" &&
  session.state._tag !== "ReviewCompleted" &&
  session.state._tag !== "Stale"
) return err({ _tag: "SessionNotDiscardable" });
const discarded = discardReviewSession(session, now());
if (discarded._tag === "err") return discarded;
const saved = await sessions.save(discarded.value);
if (saved._tag === "err") return err({ _tag: "StorageUnavailable" });
const removed = await removeManagedWorktree(profile, session);
return removed._tag === "ok" ? ok(undefined) : removed;
```

For cache clear, derive the protected directory-name set from `listSessions(profileId).filter((session) => session.state._tag === "Running")`; the artifact adapter may remove only direct cache children that are neither protected IDs nor symlinks. It may remove `.quarantine` as cache-only data, but never data-side `reviews/.quarantine`. After filesystem removal, run `git -C <localPath> worktree prune` for deduplicated configured local paths. Treat command failure as a truthful local storage failure, never include stderr in the response.

Use a strict quarantine-entry parser (`<valid-session-id>.<YYYYMMDDTHHMMSS>`) before every list projection or Trash action. `deleteQuarantined` must call the injected Trash mover only for adapter-derived session/worktree paths; absence of the worktree is accepted. Do not use `rm()` for either quarantine directory.

Wire the service once in `startLocalApiServer`; parse query/body fields before calling it and return `{ error: "storage" }` or `{ error: "invalid_input" }` rather than raw failures. In Electron composition, inject:

```ts
trash: {
  async move(path) {
    try {
      await shell.trashItem(path);
      return ok(undefined);
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  },
},
```

- [ ] **Step 4: Run targeted verification.**

Run:

```bash
pnpm test -- --run tests/services/storage-management-service.test.ts tests/local-api-auth.test.ts tests/storage/patchdesk-storage.test.ts
```

Expected: PASS. Confirm every normal storage response is path-free; discard excludes running sessions; deletion uses Trash rather than `rm`; cache clearing preserves running worktrees and executes one prune per repository path.

- [ ] **Step 5: Commit the service and route slice.**

```bash
git add src/services/storage-management-service.ts src/adapters/storage/review-artifact-storage.ts src/main/local-api.ts src/main/electron-main.ts tests/services/storage-management-service.test.ts tests/local-api-auth.test.ts
git diff --cached --check
git commit -m "feat: manage local review storage"
```

### Task 4: Render the Settings Storage section with explicit confirmations

**Files:**
- Modify: `src/renderer/src/flows/settings-flow.tsx` (storage state, fetch/mutate handlers, section cards, confirmation dialog)
- Modify: `tests/renderer/profile-settings.test.tsx`

**Interfaces:**
- Consumes `GET /v1/storage?profileId=<active profile>` and the three command routes from Task 3.
- Produces no filesystem, Git, or Electron calls. The only mutation requests are exact user-confirmed route calls with `{ profileId, sessionId }` or `{ profileId, entryName }`.
- Every successful mutation reloads the storage overview for the active profile; request failures appear as a safe inline error without optimistically changing the list/size.

- [ ] **Step 1: Write failing renderer tests.**

Extend the desktop bridge fake to return this storage projection. Test that Settings renders the three sections and accurate safety copy, then that the destructive button alone does not issue a request:

```tsx
expect(screen.getByText("Saved reviews")).toBeTruthy();
expect(screen.getByText("Review cache")).toBeTruthy();
await user.click(screen.getByRole("button", { name: "Discard centraldigital/patchdesk#42" }));
expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/storage/discard" }));
await user.click(screen.getByRole("button", { name: "Confirm discard" }));
await waitFor(() => expect(request).toHaveBeenCalledWith({
  path: "/v1/storage/discard", method: "POST", body: { profileId: "cfw", sessionId: "session-1" },
}));
```

Add parallel tests for `Delete older review` and `Clear review cache`: each requires its own confirmation, `Running` has no Discard button, and copy says clear never removes saved sessions or touches GitHub.

- [ ] **Step 2: Run the focused renderer test to prove the section is missing.**

Run:

```bash
pnpm test -- --run tests/renderer/profile-settings.test.tsx
```

Expected: FAIL because Settings neither loads storage nor renders the three confirmed actions.

- [ ] **Step 3: Implement a thin, accessible Settings client.**

Add local parsed projection helpers in `settings-flow.tsx` that accept only arrays/strings/non-negative finite cache bytes before rendering. Load on active-profile change, not at module scope, and ignore a stale response after the profile changes. Add a `storageAction` discriminated state instead of three duplicated dialogs:

```ts
type StorageAction =
  | { readonly kind: "discard"; readonly sessionId: string; readonly label: string }
  | { readonly kind: "delete-quarantine"; readonly entryName: string }
  | { readonly kind: "clear-cache" };
```

Render:

- **Saved reviews**: `prLabel`, state, `updatedAt`; show `Discard <label>` only when `canDiscard` is true. State text only for `Running`.
- **Older-version saved reviews**: static honest explanation, timestamp, and `Delete older review`.
- **Review cache**: formatted byte size and `Clear review cache`.

Reuse the existing `AlertDialog` pattern. Its descriptions must state exactly: discard keeps the saved session and removes its checkout; delete moves the quarantined copy to Trash; clear removes rebuildable checkouts only and never saved sessions or GitHub data. Disable only the action under confirmation while its request is pending, show `Alert` on error, and reload after success.

- [ ] **Step 4: Run focused UI verification.**

Run:

```bash
pnpm test -- --run tests/renderer/profile-settings.test.tsx
pnpm test:ui
```

Expected: PASS. Confirm keyboard-accessible dialog controls and the absence of a discard action for a running session.

- [ ] **Step 5: Commit the renderer slice.**

```bash
git add src/renderer/src/flows/settings-flow.tsx tests/renderer/profile-settings.test.tsx
git diff --cached --check
git commit -m "feat: add review storage settings"
```

### Task 5: Prove the feature through application and packaged surfaces

**Files:**
- Modify only if evidence exposes a defect: the smallest file from Tasks 1–4 and its focused test
- Test: existing focused suites plus the full repository gate

**Interfaces:**
- Consumes all completed local API routes and packaged Electron build.
- Produces verification evidence only; it must not introduce a test-only bypass for capability checks, Trash confirmation, or the running-session exclusion.

- [ ] **Step 1: Run focused regression suites together.**

```bash
pnpm test -- --run tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts tests/services/review-session-preparation.test.ts tests/services/review-worktree.test.ts tests/services/storage-management-service.test.ts tests/local-api-auth.test.ts tests/renderer/profile-settings.test.tsx
```

Expected: PASS. If any test fails, repair the behavior before continuing; do not weaken assertions or relax the performance-test ceiling.

- [ ] **Step 2: Run the full static/unit/build/browser gate.**

```bash
pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test
```

Expected: PASS. Report any environmental blocker with the exact failed command and keep the narrower passing evidence.

- [ ] **Step 3: Package the app.**

```bash
pnpm package:mac
pnpm test:package-smoke
```

Expected: PASS. Do not launch a second package-smoke instance on its CDP port.

- [ ] **Step 4: Delegate the required live packaged-app QA.**

Spawn the dedicated `electron-tester` subagent. Give it the packaged-app CDP recipe from `AGENTS.md` and require screenshots plus concrete evidence for:

```text
1. Seed or use an invalid stored session; opening its PR creates a fresh session and leaves an older-version entry visible.
2. Discard a non-running saved review; the confirmation is required and the session remains listed as Discarded while its checkout disappears.
3. A Running session exposes no discard control and survives Clear review cache.
4. Delete an older-version entry requires confirmation and moves it to Trash.
5. Clear review cache lowers the displayed size and never changes saved-session data or opens GitHub.
```

- [ ] **Step 5: Record completion evidence and commit any verification-only fix.**

If QA finds no defect, do not create a no-op commit. If it finds a narrow fix, add its regression test, re-run the affected gate, then commit explicit paths:

```bash
git add <explicit-fixed-source-path> <explicit-regression-test-path>
git diff --cached --check
git commit -m "fix: preserve storage management safety"
```

## Plan self-review

- **Spec coverage:** Task 2 covers the invalid-value-only quarantine, rename failure, reader exclusion, clean worktree recreation, and unchanged orphan reconciliation. Tasks 1 and 3 cover all saved-session states, discard/history, quarantine Trash deletion, cache sizing/clear/prune, main-process routes, and no GitHub writes. Task 4 covers the Settings lists, exact confirmation behavior, and truthful copy. Task 5 covers the requested full gate and dedicated packaged Electron QA.
- **Deliberate implementation detail:** `invalid_json` is not quarantined because the approved design names only `invalid_stored_value`; its existing storage-unavailable behavior remains intact.
- **Safety check:** The service never sends storage paths to the renderer; the renderer cannot choose a filesystem path or invoke Electron directly. All directory names are validated, root-contained, and symlink-safe before rename, Trash, or removal.
- **Consistency check:** Every later task uses `discardReviewSession`, `ReviewArtifactStorage`, and `StorageManagementService` defined earlier. Worktree cleanup preserves live `Running` directories and uses `git worktree prune` only after cache cleanup.
