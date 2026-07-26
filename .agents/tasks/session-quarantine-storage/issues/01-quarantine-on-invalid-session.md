# Quarantine invalid stored sessions on prepare

Type: task
Status: needs-triage

When `ReviewSessionPreparation.prepareSerialized` loads the stored session
and gets `invalid_stored_value`, rename the session dir and its cache
worktree into sibling `.quarantine/` directories (timestamped), then continue
with a fresh preparation. Only `invalid_stored_value` triggers this; I/O and
permission errors keep `SessionStorageUnavailable`. If a rename fails, keep
the honest error instead of preparing over unmoved data. `listSessions` and
other readers explicitly exclude `.quarantine/`.

Root cause evidence: `cfw-bo-staff-api` PR #717 — Jul-23 session with a
22-line finding range rejected by the current 10-line cap in
`projectFinding` (`src/domain/review-result.ts`), blocking preparation with
"Could not prepare".

Spec: `../spec.md` (workstream A).

## Comments
