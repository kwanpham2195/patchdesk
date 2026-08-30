# Navigation and overlays

## Summary

Patchdesk has two primary destinations: the Pull requests screen and a Review workbench identified by its Review. Settings opens above either destination and does not replace it. Navigation preserves safe screen position, moves focus when the destination changes, and refuses to discard a dirty draft or abandon a GitHub write whose result is still pending.

## The simple case

The app opens on the last saved destination. The maintainer selects a pull request and enters its Review workbench, then uses the Back control or Navigate to return to Pull requests. The document title and titlebar name the current destination.

Settings opens from the titlebar, Navigate, ⌘,, or the native application menu. It defaults to General unless the caller targets a section. Closing it reveals the same destination and returns focus to the control that opened it.

Within a Review workbench, Patchdesk saves the active top-level tab, navigator section, and selected file for that Review. Reloading or relaunching restores valid saved values without applying one Review's position to another.

## The task, event by event

```mermaid
stateDiagram-v2
    [*] --> pullRequests : launch or navigate home
    pullRequests --> workbench : open Review
    workbench --> pullRequests : Back or Navigate
    pullRequests --> settings : open Settings
    workbench --> settings : open Settings
    settings --> pullRequests : close over Pull requests
    settings --> workbench : close over Review
    workbench --> blocked : dirty draft or write pending
    blocked --> workbench : stay or wait
    blocked --> pullRequests : save or discard allows navigation
```

### Arrive

On launch, Patchdesk reads the saved destination. An absent, malformed, or unrecognized value falls back to Pull requests. A workbench destination includes the Review ID; Patchdesk loads the Review before rendering the full workbench.

The app title becomes `Pull requests · Patchdesk` or `Review workbench · Patchdesk`. After a true destination change, Patchdesk focuses the first `h1` inside the main content. A Skip to content link targets the same main region.

When Settings opens, it remembers an opener for focus return. A caller can target General, Workspace, Review, Data & recovery, or Logs. Direct calls without a section open General.

### Leave unchanged

Choosing the current destination again does nothing. Closing a clean Settings overlay keeps the underlying destination, clears the session-only Settings restore marker, and returns focus to the opener.

Closing Navigate without choosing a command records no destination change. Opening a Settings section, reading it, and closing it does not change the underlying Review or Pull requests state.

### Begin an action

Opening a Review stores its validated workbench projection and changes the destination to that Review's workbench key. The Review code loads only after Patchdesk has a canonical Review projection.

Back, Navigate, Pull request presets, profile switching, and commands from the native menu call the same destination owners as visible buttons. A clean destination request saves its key and clears the workbench payload when leaving the workbench.

Opening Settings is refused when navigation state is not clear. ⌘K and the titlebar Settings control are also disabled or ignored. The native close path reads the same navigation state from the renderer.

### While the action runs

While Review preparation or route code is loading, Patchdesk shows a loading status. A route-load failure replaces it with a workbench load error and Retry; Retry creates a fresh route loader attempt without changing the Review identity.

Workbench position updates save the active tab, navigator section, and selected path under the Review ID. Selected paths are limited to 2,000 characters. Settings section changes write a session-only restore marker while the overlay remains open.

If navigation is dirty, Patchdesk parks the requested destination behind the leave dialog. If a GitHub write is pending, the dialog offers only Wait for completion. If a local review draft is dirty, it offers Stay or Discard changes and leave; the feature that owns the draft can provide a Save path in its own guard.

### Settle

A successful destination change updates the screen, stored destination key, title, and focus. Leaving the workbench drops its loaded renderer projection, while durable Review state remains local.

Closing Settings normally clears its reload marker and restores opener focus. If the renderer reloads while Settings is open, the overlay reopens on the saved section. A fresh app launch does not reopen Settings because the marker uses session storage.

Closing the desktop window or quitting while state is clear proceeds. Dirty draft state opens a native warning that can keep the app open or discard the latest unsaved edit. GitHub write pending state prevents close and tells the maintainer to wait for the final result.

## Variants

| Variant | Before the action runs | While the action runs |
| --- | --- | --- |
| Workspace profile and GitHub account | The active profile appears in the titlebar and scopes destinations that load data. | Applying another profile clears the loaded workbench, resets the Pull requests request, and returns to Pull requests. |
| Pull request and Review state | A workbench destination needs a Review ID and a loadable local projection. | Revision and remote-state changes update the workbench without changing its destination key unless the Review itself changes. |
| GitHub permissions and merge readiness | Navigation and Settings do not require GitHub write permission. | Permission changes affect controls in the destination, not navigation itself. A pending write still blocks leaving until settlement. |
| Network, local tool, and Insight provider availability | Previously stored destinations and view positions are local. Loading their content can still fail. | A route or data-load failure shows local Retry where provided. Settings remains an overlay over the last rendered destination. |
| Input path: mouse, keyboard, or desktop menu | Back, titlebar controls, Navigate, ⌘K, ⌘,, and native menu actions reach the same owners. | The blocked state disables or ignores Settings and Navigate commands regardless of input path. |

Changing input path does not bypass navigation state. A native window close uses a native prompt because the renderer can no longer be trusted to remain visible during desktop shutdown.

## Cancel and interrupt

| Event | Before the action runs | While the action runs |
| --- | --- | --- |
| Cancel, Stop, or Escape | Closing Navigate or a clean Settings overlay keeps the current destination. Dirty guards return to the current task when cancelled. | Cancel cannot override write pending. A dirty guard can stay, save where offered, or discard before continuing. |
| Navigate to another Patchdesk screen, Review, Settings section, or workspace profile | Same-destination requests do nothing. Clean destination and section changes proceed. | A parked destination waits behind dirty state. Profile switching has its own latest-request guard and returns to Pull requests only after success. |
| Start another action or request a refresh | Refresh acts inside Pull requests and does not create a destination. Opening Settings overlays the destination. | Refresh or route loading can show the shared busy bar. Navigation guards remain owned by draft or write state. |
| GitHub, the network, a local tool, or an Insight provider fails or times out | Stored route and position reads do not need them. Destination content can show a read failure after arrival. | Review route import failure offers Retry. Data failures remain within the active destination unless a profile switch succeeds. |
| Close Settings, reload the renderer, close the window, or quit Patchdesk | Clean Settings closes and clears restore state. Reload restores the last destination and valid position. | Dirty close requires confirmation. Write pending prevents close. Renderer reload can restore destination and Settings section but not arbitrary unsaved drafts. |
| The pull request, represented revision, pending review, permission, or other target changes elsewhere | The workbench can open with readonly or changed state when its Review still exists. | Remote changes alter feature controls and freshness. They do not apply another Review's saved position. |
| macOS focus, a file or folder picker, or another input path takes control | Normal Settings close returns focus to the opener. Destination changes focus the new screen heading. | Native dialogs and pickers temporarily own focus. Hand verification must confirm focus after every native return path. |

After interruption, Patchdesk keeps the current destination unless it explicitly accepted a new one. Saved position is convenience state; it never authorizes an action or proves the loaded Review is current.

## Interactions with other systems

**Workspace profile and identity.** Profile selection is global navigation context. A successful switch reloads Pull requests under the selected profile and clears the in-memory workbench.

**Review revision and freshness.** A Review destination stays keyed to the Review across revisions. The workbench projection owns freshness; navigation only owns where it is shown.

**Local persistence and recovery.** Destination and per-Review position use local storage and survive relaunch. Open Settings section uses session storage and survives reload only. Invalid values are ignored or partially degraded.

**GitHub permissions and write authority.** Navigation never grants write authority. It blocks departure during a pending write so the main process can report the final GitHub result.

**Network, local tools, and Insight providers.** They affect content inside a destination. Navigation shell, saved position, and Settings overlay state are local.

**Concurrent operations and locking.** Dirty and write-pending states are one renderer navigation state. Profile and Review owners still use their own request generations and main-process locks.

**Feedback, errors, and diagnostics.** Loading statuses and route errors appear in main content. Native close warnings explain whether unsaved local text or a GitHub result is at risk.

**Preferences, keyboard commands, and desktop integration.** ⌘K opens Navigate and ⌘, opens Settings when navigation is clear. Native menu Settings and Refresh actions raise the window before delivery. Window bounds persist separately from workbench position.

**Supported input and accessibility limits.** Keyboard and mouse navigation are in scope. Destination changes focus the new `h1`; screen-reader behavior is not a supported product claim.

## Edge cases

- A saved workbench position applies only to its Review ID.
- Corrupt position data is ignored. One malformed field can drop while other valid fields still restore.
- Removed tab or section names from an older build do not block restoration of still-valid fields.
- Settings restore values longer than 48 characters and selected paths longer than 2,000 characters are clamped before validation.
- A second app launch focuses or recreates the existing Patchdesk window rather than opening a second working instance.
- Closing the only window on macOS does not necessarily quit the app; activating the app can recreate or focus the workbench window.
- Settings cannot open while navigation is blocked, including through ⌘, or the native menu.
- The Navigate palette closes before it dispatches a destination or Pull requests action.

## Open questions and verification

- Live desktop verification is pending because this task did not run with the required herdr dev and log panes.
- Confirm focus after every destination change, normal Settings close, dirty-guard cancellation, and native close cancellation.
- Confirm that Escape and clicking outside Settings clear the restore marker on a clean close and cannot bypass the dirty guard.
- Confirm the exact visible restore after a renderer reload from each workbench tab, navigator section, and selected file.
- Confirm behavior when the saved workbench destination refers to a Review that local cleanup removed; source inspection for the load fallback belongs in `pull-requests/opening-a-review.md`.

Verified against Patchdesk application source commit `3100615`.
