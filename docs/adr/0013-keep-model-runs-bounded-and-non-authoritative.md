# Keep model runs bounded and non-authoritative

> **Note.** The one-shot child no longer runs on Flue; it drives a Pi agent
> loop directly (ADR 0041). It is still one finite child per run, and the
> authority boundary below is unchanged.

Patchdesk owns every Analysis and Walkthrough operation. The app prepares immutable revision artifacts, starts one finite Flue 2 one-shot child, validates a strict structured result, and decides whether that result may replace retained content or change GitHub review state.

Pi-backed Analysis instructions keep trusted Patchdesk policy above untrusted repository criteria and prepared pull request evidence. Pi-backed Analysis receives only session-bound changed-file inspection and immutable Git reads; Pi-backed Walkthrough receives bounded stored artifacts with no tools or write surface. The ADR "Use the local Codex CLI account" is a limited exception for either Codex-backed Insight type: Codex may use verified sandboxed read-only inspection tools only against Patchdesk's immutable represented-review worktree, never the maintainer's original checkout. Neither operation can mutate the checkout, write to GitHub, publish feedback, change threads, or merge.

Patchdesk computes Finding mapping, postability, freshness, and merge eligibility after model output passes validation. Exact prompt wording, default models, reasoning defaults, and tuning may change without changing this authority boundary.
