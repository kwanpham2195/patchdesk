---
created_at: 2026-08-04
repos:
  - patchdesk
status: ready-for-agent
---

# PR Overview status sidebar

Status: ready-for-agent

## Problem Statement

The PR Overview overlay contains the information a maintainer needs to decide what to do next, but urgent state can be lost among long pull-request context. Checks, discussion, Insight state, and merge readiness do not yet have one compact visual language with clear icon and text indicators.

A maintainer needs to see, at a glance, whether the represented GitHub state is current, whether checks and discussion need attention, whether Analysis and Walkthrough are usable, and why a merge is ready, needs acknowledgement, or is blocked. They must still be able to inspect the full pull-request context and safely perform the existing refresh, external-navigation, publication, and merge flows.

## Solution

Refine the right-side PR Overview overlay into a dense, status-led sidebar inspired by the supplied merge-status reference. The overlay will show a brief Review summary and revision context first, followed by compact Checks, Discussion, Review status, and Merge readiness sections. Each state uses a recognizable icon, semantic color, and explicit text.

The redesign will preserve the existing Review workbench model: PR Overview remains an on-demand overlay over the diff, GitHub state remains represented until explicit Refresh, Insights remain independent, and merge remains an explicitly confirmed exact-head GitHub write. Existing detail is reorganized behind disclosures or contextual actions rather than deleted.

## User Stories

1. As a maintainer, I want PR Overview to lead with the most relevant Review and revision context, so that I can orient myself before deciding what action to take.
2. As a maintainer, I want to see the represented base branch, head branch, reviewed SHA, and refresh time together, so that I know which pull-request revision I am inspecting.
3. As a maintainer, I want Refresh available from the revision section whenever the Review can refresh, so that I can explicitly replace represented GitHub state when I choose.
4. As a maintainer, I want the overlay to show commit and changed-file counts when GitHub supplied them, so that I can gauge the pull request without leaving the workbench.
5. As a maintainer, I want Checks to show a concise result with a status icon, so that I can immediately distinguish passing, failing, pending, skipped, and unavailable checks.
6. As a maintainer, I want to expand Checks for the complete run list, required-check information, and existing safe check links, so that a compact summary does not hide evidence.
7. As a maintainer, I want failed or pending checks to receive stronger visual emphasis than passing checks, so that actionable problems are not buried.
8. As a maintainer, I want Discussion to show the number of threads and unresolved threads, so that I know whether GitHub conversation needs attention.
9. As a maintainer, I want to expand Discussion to inspect existing threads and Published feedback, so that GitHub-owned feedback remains distinct from the active Review draft without disappearing from the overview.
10. As a maintainer, I want Review status to show Analysis and Walkthrough independently, so that I can tell whether each Insight is not generated, running, current, outdated, or failed.
11. As a maintainer, I want the current mapped-Finding count to be visible with Review status, so that I understand the current Analysis evidence before merging.
12. As a maintainer, I want an available Finding action to take me to current mapped evidence in Files, so that I can judge a merge-policy warning from its source rather than from a summary alone.
13. As a maintainer, I want merge readiness to state plainly whether the Review is ready, requires acknowledgement, or is blocked, so that I do not have to infer merge eligibility from raw status tags.
14. As a maintainer, I want merge readiness to explain the specific available GitHub or Analysis reason, so that I know the next safe action.
15. As a maintainer, I want a current high-severity Finding to remain visible when the workspace profile requires acknowledgement or blocks merge, so that adding it to the Review draft is not mistaken for resolving it.
16. As a maintainer, I want an outdated Analysis result excluded from current merge policy, so that old model evidence cannot govern the current pull request.
17. As a maintainer, I want incomplete GitHub policy evidence to link me safely to the pull request on GitHub, so that I can inspect the authority without Patchdesk overstating what it knows.
18. As a maintainer, I want the merge confirmation flow to remain explicitly confirmed and SHA-bound, so that a visual redesign cannot weaken the GitHub write boundary.
19. As a maintainer, I want a terminal merged or closed Review to remain readable but not show unavailable actions, so that the sidebar reflects the pull-request lifecycle truthfully.
20. As a keyboard user, I want every disclosure and action in PR Overview to have a clear accessible name and predictable focus behavior, so that I can inspect status without a pointer.
21. As a screen-reader user, I want every status communicated in words as well as by icon and color, so that visual emphasis is never the sole source of meaning.
22. As a maintainer, I want closing PR Overview with its close control, Escape, or the backdrop to return focus to its trigger, so that the overlay does not disrupt my Review workbench navigation.
23. As a maintainer, I want the sidebar to remain independently scrollable and usable at constrained desktop widths, so that it does not resize the diff or create viewport overflow.
24. As a maintainer, I want the Review draft to stay visible but non-interactive behind the overlay, so that PR-level inspection does not change or discard local work.

## Implementation Decisions

- This is a renderer-composition change to the canonical PR Overview used by the unified Review workbench. It will consume the existing Review projection and will not introduce a second Review, merge, Insight, or GitHub-state owner.
- The overlay retains its current right-edge modal behavior, full-height independent scroll area, focus containment, close methods, and focus restoration. It overlays the workbench instead of resizing it.
- The body order is: Review summary; revision and freshness; compact counts; Checks; Discussion; Review status; Merge readiness and the existing merge entry point; then longer pull-request description or other secondary context.
- Summary and revision information remain directly visible. Secondary details use disclosure rows, preserving existing readable pull-request description, thread, Published feedback, check, and merge-reason content.
- Status presentation uses one shared renderer mapping from typed state to an icon, explicit label, and semantic treatment. Passing/current/ready states use the existing success token; pending or acknowledgement states use the warning token; failures and blocked states use the destructive token; unavailable, skipped, and unknown states use muted treatment. No raw palette values or color-only states are introduced.
- The Checks section retains the full existing check data, including required status, completion/conclusion, duplicate grouping, and validated external URLs. A separate reduced check mapper must not discard requirement metadata or create a competing set of check rules.
- Revision context is derived from already represented pull-request data: base and head branches, reviewed and current head where available, refresh status/time, commits, and changed-file count. Missing optional GitHub data is omitted or described as unavailable rather than fabricated.
- Discussion combines its compact count with the existing thread and Published feedback inspection content. Published feedback stays GitHub-owned and is never presented as editable Review draft content.
- Review status represents Analysis and Walkthrough independently. Mapped-Finding count includes only current safely mapped Findings. Any Finding navigation returns to the existing Files/Findings experience and cannot navigate to outdated evidence.
- Merge readiness remains derived by the established merge-readiness policy. The sidebar renders human-readable reasons and policy warnings, including the Analysis-Finding case, but never exposes raw internal blocker or warning tags.
- The existing merge confirmation path remains the only merge action. When merge is blocked, PR Overview shows the reason without duplicating a blocked confirmation surface; when merge is eligible or needs acknowledgement, the existing method selection and explicit confirmation remain intact.
- Refresh continues to be explicit. Detecting updates may pause GitHub writes, but it does not replace the visible checks, discussion, or revision in the open overlay.
- The implementation will use the existing Base UI-backed components, existing semantic tokens, and installed icon library. It will not add a UI, icon, animation, or color dependency.

## Testing Decisions

- The primary test seam is the Review workbench renderer projection rendered through its deterministic workbench flow. Tests will assert user-visible content, accessible names, disclosure behavior, navigation, and enabled or disabled actions rather than component internals or CSS implementation details.
- Renderer coverage will exercise passing, failing, pending, skipped, and unavailable checks; empty and populated discussion; each independent Analysis and Walkthrough status; current mapped-Finding counts; ready, acknowledgement-required, blocked, and terminal merge readiness; explicit refresh; and safe external GitHub navigation.
- A regression test will prove detailed checks preserve requirement metadata and the established safe external-link pathway after the compact summary is introduced.
- A regression test will prove incomplete GitHub evidence uses the existing safe Open on GitHub action and that raw merge tags never render.
- A regression test will prove the Finding action appears only for current mapped evidence and routes to the existing current Files/Findings surface.
- Existing PR Overview keyboard and modal tests are the prior art for close behavior, focus restoration, backdrop handling, and continued workbench visibility. They will remain green and gain assertions for the new status rows.
- Existing check-list tests are the prior art for grouping, ordering, disclosure, and safe external links. Existing merge-confirmation tests are the prior art for acknowledgement and exact-confirmation behavior.
- Browser coverage will verify the sidebar at the existing desktop widths and a constrained width: no viewport overflow, a usable independent scroll area, reachable merge controls, and a recognizable non-interactive workbench behind the overlay.
- Before completion, a dedicated tester subagent will perform isolated Electron QA with deterministic fixtures. It will verify status contrast and text redundancy, keyboard navigation, responsive geometry, and the absence of GitHub or model writes.

## Out of Scope

- Changing Review identity, represented GitHub state, explicit-refresh rules, Insight lifecycle, Finding mapping, Review draft ownership, Published feedback ownership, or merge authorization.
- Changing workspace-level Analysis merge-policy settings or GitHub policy discovery.
- Adding merge bypass controls, automatic merge, GitHub writes, or a new merge method.
- Replacing the diff surface, Review navigator, Review draft dock, or Insights UI.
- Adding new animations, dashboards, charts, gradients, custom themes, or dependencies.
- Redesigning the legacy non-canonical PR Overview path beyond any safe shared check or status presentation extraction needed to avoid duplicated logic.

## Further Notes

- The supplied GitHub merge-status image is visual direction for hierarchy, density, and status signaling. Patchdesk retains its existing dark neutral and indigo design language rather than copying GitHub controls or copy verbatim.
- The approved unified Review workbench design remains the composition reference where it agrees with the product specification and ADRs.
- Implementation must preserve the pre-existing uncommitted PR Overview work and reconcile it with this specification rather than overwriting it blindly.
