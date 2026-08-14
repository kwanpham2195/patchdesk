# Changelog

## Unreleased

- Recovered Reviews automatically after an upgrade leaves incompatible local session or snapshot data, preserved the old files in quarantine, and restored review-comment controls after GitHub reconciliation.
- Migrated Pi Analysis and Walkthrough to a bounded Flue 2 one-shot child runtime with strict results and packaged runtime verification.
- Reduced Inbox and Settings startup work by loading the Review workbench only when a saved Review opens.
- Kept a proven GitHub pending review usable for inspection, comments, submission, and discard when one Analysis Finding cannot be linked to its exact thread.
- Removed obsolete local Review batches, Review attempts, incremental revision updates, and their startup migrations; Review, Insight, and GitHub pending-review state are now the only review authorities.
- Updated same-revision pull request metadata immediately after Patchdesk publishes a confirmed review summary.

- Added provider-aware Insight runs with explicit Pi or Codex CLI account selection, live model validation, and read-only represented-worktree inspection.
- Improved Analysis and Walkthrough output with reviewer-first framing, evidence-based context, and Simplified Technical English.
