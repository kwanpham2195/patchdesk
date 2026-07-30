# Snapshot-owned review batch

A review batch belongs to one immutable prepared pull request snapshot.

The prepared snapshot creates an empty editable batch before any model run.
Human and model items share that batch. Model items record the attempt that
created them. A later model run replaces only its own items and preserves human
items.

## Decision

Use the prepared session ID as the batch identity. The session ID already
includes the pull request head SHA, so a changed head creates a new batch. Old
snapshot items remain readable but are never copied to the new snapshot.

Persisted v3 attempt-owned batches are read as snapshot-owned batches. Finding
items become model-provenance items with their original attempt ID. Existing
manual and thread items become human-provenance items.

## Consequences

An editable local batch does not block an optional AI review. A batch with an
in-progress, ambiguous, pending, or submitted remote transaction still blocks
another run until its remote state is resolved safely.

GitHub writes continue to use the snapshot batch and the existing confirmation
and fresh-head checks. No renderer, workflow, or storage path keeps a separate
review draft representation.
