# Local Review Data Cleanup

## Goal

Simplify Settings storage management to one global cleanup action. Users should not need to understand the difference between saved sessions, quarantined sessions, and checkout cache.

## User experience

Settings removes the Saved reviews list, the Older-version saved reviews section, and all per-review cleanup controls. It keeps one compact card:

- Title: `Local review data`
- Action: `Clear local review data`

The confirmation dialog says that the action removes rebuildable checkout/worktree cache, discarded review sessions, and older-version quarantined sessions. It explicitly says that running and recoverable sessions remain. The action is unavailable while another storage action is pending and the dialog closes only after a successful response.

The label is deliberately not `Clear cache`: the operation removes more than cache. The cleanup is destructive from Patchdesk's point of view and requires explicit confirmation.

## Retention policy

The cleanup preserves these session states:

- `Running`
- `Created`
- `ReviewFailed`
- `ReviewCompleted`
- `Stale`

It removes these local records:

- `Discarded` session directories, including their stored attempts and artifacts
- Older-version entries under the profile's quarantine directories
- Rebuildable worktree cache entries, except entries belonging to running sessions

Git worktree registrations are pruned after cache removal. Running sessions and their worktrees are never touched. Domain-level discard transitions used by the review workflow remain unchanged; this design removes only the Settings cleanup controls and storage-management operation that exposed them.

## API and service boundary

Add a dedicated local API operation:

`POST /v1/storage/clear-local-data`

The operation accepts the active `profileId` and delegates to a storage-management service method with the same intent. The service owns the retention classification and performs the cleanup in this order:

1. Load and validate the profile.
2. List sessions and build the protected set from running session IDs.
3. Remove discarded session directories.
4. Remove quarantined session and worktree directories.
5. Remove cache worktrees not protected by a running session or recorded-running state.
6. Prune Git worktree registrations for configured local repositories.

The renderer no longer needs the storage overview projection or the Settings-only discard, quarantine-delete, and cache-clear routes. The existing domain and workflow discard operations remain because they represent review lifecycle transitions rather than storage cleanup.

## Failure behavior

Every filesystem boundary remains path-checked and app-owned. A missing disposable entry is treated as already clean. A storage or Git failure returns an error to the renderer; the UI keeps the confirmation context available for a retry and does not claim success. Partial progress is safe to retry because each cleanup step is idempotent. Running-session protection is evaluated again at cleanup time rather than relying only on renderer state.

## Verification

- Service tests verify that only discarded and quarantined data is removed, recoverable states remain, and running worktrees are protected.
- Storage adapter tests cover safe removal of session and quarantine directories.
- Renderer tests verify that Settings exposes one cleanup action, no per-entry controls, and accurate confirmation copy.
- Local API and desktop-bridge tests verify the new route and remove the obsolete Settings-only route permissions.
- Run the desktop verification order: lint, typecheck, unit/integration tests, build, browser tests, macOS packaging, and packaged smoke QA.

## Out of scope

- Changing review lifecycle semantics or the domain `Discarded` state.
- Deleting recoverable sessions such as completed or failed reviews.
- Adding automatic background cleanup.
- Changing GitHub data or issuing GitHub writes.
