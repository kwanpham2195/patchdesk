# Pierre controlled item versioning

Pierre's CodeView reconciles controlled items by an explicit `version`
(`review-diff-item-version.ts`). The diff view feeds it `annotationKey`, built
from each annotation's id/path/start/end/side/title/explanation and, since Aug
2026, the conversation-thread content (state, updating marker, comment
id/author/body).

**Invariant:** any annotation field that can change in place while the
annotation id stays stable MUST be included in `annotationKey`. Otherwise
Pierre silently keeps the previous annotation metadata and the renderer never
sees the update.

The Aug 2026 bug: the optimistic reply stayed stuck on "Updating…" after the
background refresh because the thread's comments changed but the version did
not — the card kept the old thread prop, so its reconcile effect never fired.
Resolve-state changes had the same latent staleness.

Notes:

- New annotation types with mutable content must extend both the annotation
  shape and `annotationKey`.
- The version also gates hydration swaps (`hydrated`) and file collapse
  (`collapsed`) — see `review-diff-item-version.ts`.
