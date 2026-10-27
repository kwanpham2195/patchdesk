# Run Insights through native CLI accounts and retain native history

Status: Accepted, 2026-10-25. Implementation and verification are tracked separately.

This decision supersedes direct API execution in [ADR 0041](0041-drive-pi-directly-without-flue.md), native-history persistence in [ADR 0016](0016-use-the-local-codex-cli-account.md) and [ADR 0054](0054-use-the-local-pi-cli-account.md), and account-provider availability in [ADR 0055](0055-read-captured-insight-evidence-on-demand.md). [ADR 0043](0043-project-a-bounded-codex-activity-trace.md) continues to own the bounded activity trace. Captured evidence, publication, bounded readers and host authority keep their existing contracts.

## Problem

Patchdesk maintains direct API execution alongside Codex CLI and Pi CLI. That duplicates model discovery, provider invocation, build resources and failure handling. Native conversations were discarded, so debugging required reconstructing provider activity from host diagnostics.

A failed Analysis read illustrates the boundary. Native history may record the command and its output. Patchdesk alone can establish whether the host accepted an operation, published a result, stopped its owned process group and removed temporary credentials.

## Decision

New Brief, Analysis, Guide and Walkthrough runs use Codex CLI account or Pi CLI account. The installed native client owns account access and model support. Patchdesk requires an explicit supported provider before model discovery, evidence preparation or run authorization. A saved API selection remains visibly retired until the maintainer selects a native provider and model. Opening a dialog does not rewrite saved settings; only an accepted start saves its selection.

Historical `pi` provenance keeps its original API key identity. Existing results, receipts, unknown usage and cancellation evidence remain readable. A retired API run cannot resume through another provider. A replacement native run needs its own authorization.

The existing coordinators, Review locks, run journals, evidence bindings, cancellation and publication services retain authority. Native history does not establish successful publication, permit recovery or authorize replay. Guide and Walkthrough continue to publish through host-accepted operations and independently validated results. Reading a retained result does not invoke a provider.

Guide coverage amendment, 2026-10-27 (#830): both native providers accept optional `othersConfirmed` on `finish`. Ungrouped files refuse an unconfirmed finish with bounded inventory counts and up to twenty largest changes, leaving writing and the receipt sequence open. An explicit confirmation or complete grouping permits finish under the existing receipt and publication rules. This adds no group or coverage quota and does not establish inspection completeness.

Each actual native attempt owns private Review-relative metadata and history storage, keyed by Insight type, run and unique attempt. Metadata links existing revision, generation, connection and evidence identities and records requested and observed runtime settings, the first host failure, history capture and independent cleanup outcomes. The bounded diagnostic ring supplements this durable locator. It is not the only way to find an attempt.

Pi generation uses a fresh session directory. Model discovery remains nonpersistent. Codex keeps its existing temporary execution home and archives only allowlisted native history after confirmed process cessation. Credential cleanup is attempted independently of archive success once cleanup is safe. Uncertain cessation protects the temporary home and recovery evidence. Surviving history after an application crash is best effort.

Retained history means captured readable bytes. Completeness remains unknown even when the file is readable and the process has exited. Interrupted or truncated history is described only when that condition is observed. Native processes can buffer or lose final events without leaving malformed records. History availability therefore cannot replace host failure classifications or justify removing the Analysis read-failure parser.

The status boundary exposes bounded safe attempt metadata, excluding private filenames, execution-home locators and native bodies. Routine logs and UI Details do not contain credentials, prompts, source, raw tool arguments or provider prose. This change adds no transcript database, history viewer, export feature or custom storage preference.

Retention follows existing Review protection and deletion. Reviews protected by retained Insights, slots or journals can keep history indefinitely. Active or uncertain attempts remain protected. No fixed expiry is promised and protection is not weakened to reclaim history.

## Consequences

The bundled API runtime, API catalog, executor, private child channel and build resources can be removed after native replacement and stored-run disposition are verified. Shared evidence, result protocols, publication and historical readers remain.

Host diagnostics and native history answer different debugging questions. A readable archive does not prove complete history or safe cleanup. A successful later run does not resolve an earlier unknown cleanup failure.

Pi cleanup proves only its acknowledged abort, drained host work and owned process-group observations where available. Detached Bash descendants remain unproven. These observations do not establish a filesystem or network sandbox.

The UI uses existing run authority and per-Insight settings. Shared controls derive mixed values from those settings; explicit edits affect selected editable rows. Start new generation continues the existing fresh-generation operation and requires its unknown-response and possible-repeat-spend acknowledgment, current identity, recovery evidence and confirmed native cessation.

## Verification

Verify each provider with all four Insights through generation, publication, reopened readers and attempt-history capture. Check metadata privacy, exact run and evidence bindings, observed runtime settings, process outcomes and credential cleanup independently. Verify retired saved choices, historical API provenance, native generation after API removal, desktop and narrow UI layouts, and packaged startup without the API runtime.

Keep existing uncertain runs protected. Do not infer cessation from a missing process or infer historical causes from a later success. A separate bounded follow-up must establish failed-read history equivalence before considering deletion of the Analysis parser.
