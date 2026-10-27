# Read captured Insight evidence as plain files

Status: Accepted, 2026-10-27. All four Insights read the plain-file tree.

This decision supersedes the evidence page format and native read rules in [ADR 0055](0055-read-captured-insight-evidence-on-demand.md). Its capture authority, validation timing, Walkthrough operations and result authority stay unchanged. [ADR 0056](0056-run-insights-through-native-cli-accounts.md) leaves Codex CLI and Pi CLI as the Insight providers; both have native file-reading tools.

## Problem

Pages expand captured source into repeated JSON records and place full head snapshots in the same continuation chains as the diff. The model must finish every chain even when it needs only a small part of a snapshot.

On a 53-file review, the model stopped after reading a few pages and reported Analysis incomplete because the remaining evidence would exceed its context. Plain diffs and optional surrounding code avoid that mandatory reading cost.

## Decision

Each run gets one immutable directory, `evidence/<run>/`, under the session's `prepared/` root:

```text
README.md            what is here and how to cite it
files.json           changed files in canonical patch order
hunks.json           hN, fN, path, old/new ranges and header
diff/<path>.diff     one captured unified diff block
head/<path>          captured regular head text, where available
context/<name>       context sources allowed for this Insight
manifest.json        relative paths, byte counts and sha256 digests
```

The model starts with README.md and files.json, reads every diff, then opens head snapshots where surrounding code is needed. Native tools can still truncate output; ordinary line ranges let the model read large files. An unread head snapshot is not missing evidence.

### Paths and content

The diff and head directories mirror repository paths. A Git-quoted name, case or Unicode collision, file/directory conflict, or unsafe segment uses `_unrepresentable/fN` instead. files.json records that mapping alongside original paths, status, mode metadata, binary state, additions, deletions, hunk IDs and snapshot state. Symlinks, submodules and binary files remain metadata; they never become head text files.

Analysis, Guide and Walkthrough capture head snapshots with the existing limits of 512 KiB per file and 4 MiB per run. A skipped snapshot records its reason, including oversized, nonregular, deleted or over the run total. Brief captures no snapshots. Base blobs are not captured; removed lines remain in the diff.

Context preserves each Insight's existing exclusions. Analysis retains review input; Guide and Walkthrough exclude Change intent.

### Identity and citations

`parseNarrativePatch` assigns `hN` in canonical patch order. Guide's complete inventory assigns `fN` in file order. Concatenating diff files in files.json order must reproduce the captured patch hash.

Brief and Walkthrough cite hunk IDs; Guide cites file IDs. Analysis continues to cite repository path, side and source lines, validated against the captured patch. Physical diff-file lines are never citations. Analysis's complete and incomplete result contracts remain unchanged.

### Host authority

The host builds the tree and retains its manifest authority separately from the model-readable manifest.json. It installs the tree by atomic rename under the Review lock. Before invocation, after invocation and before retaining output, it recursively checks the exact file and directory set, rejects symlinks, checks containment through `isPathContained`, and verifies regular-file byte counts and sha256 digests through `O_NOFOLLOW` reads.

Files have mode 0444. Directories stay owner-writable so ordinary retention removal works without changing modes first. Codex's workspace-write sandbox does not cover the evidence root, and Pi has no filesystem sandbox. Post-invocation validation enforces integrity. Any change fails the run and preserves the previous result.

### Migration

Analysis moved first on both native providers. Brief, Guide and Walkthrough now use the same tree and native reading instructions. The page builder, page references, continuation traversal and store page/search methods remain pending deletion in a separate follow-up. Result and reader pagination are separate from the captured evidence format.

The page format postdates the latest release, so no compatibility path is required. An unsettled preparation in the page format fails closed and requires re-preparation. Retained results keep their semantic citations and remain readable.

## Consequences

Models can inspect the complete diff without reading every full head snapshot. The tree avoids repeated fragment coordinates and continuation records. Capture and validation costs still grow with the captured content.

All four Insights now read the tree. Guide and Walkthrough capture head snapshots within the existing limits; Brief still captures neither snapshots nor review context. The host-held recursive index remains the integrity authority, independently of the model-readable manifest.

The page format code remains until the deletion follow-up. Its presence does not authorize a page fallback for a new run. This decision does not establish better result quality, Pi's compliance with mode bits, or completion within a generation deadline. Live native runs must establish those outcomes separately. Guide coverage remains a separate follow-up in #830.
