# Notify outside the window

> **Status: Accepted.** Issue #227. Issue #226 (watch a pull request) reuses
> the notifier port, the settings record, the click channel, and this record,
> and amends it. ADR 0032 is unchanged: no notification reads GitHub.

An Analysis run takes minutes, and a maintainer switches to another app while
it runs. Patchdesk said nothing when it finished. A GitHub write whose outcome
Patchdesk could not confirm locks further writes on that Review until the
maintainer checks GitHub again, and that also happened silently: a maintainer
in another app did not know Patchdesk was waiting on them.

## The decision

Patchdesk posts a macOS notification for four events it already knows about:

- An Insight run settles as completed or failed. A cancelled run is the
  maintainer's own doing and a superseded run was replaced, so neither posts.
  The event is raised only after the terminal record is persisted.
- A pull request metadata write or a direct conversation write leaves its own
  operation outcome-unknown. A write refused because an earlier operation
  already holds the lock posts nothing, and neither does one that GitHub
  rejected or that was confirmed and removed.
- Review preparation creates a new session. A resumed session posts nothing.
- A merge completes: GitHub confirmed it, the Review was saved as merged, and
  the merge receipt was removed.

The body names the pull request as `owner/repo#number` and nothing else from
GitHub. Clicking a notification focuses the window and opens its Review
through the renderer's ordinary navigation, so an unsaved draft or a pending
write holds the maintainer where they are, as any other navigation does. An
Insight notification opens the Insights tab on that Insight's reader.

**The one silence rule.** An event about the Review the focused window is
showing posts nothing. The renderer reports its destination to the main
process over the closed desktop request union
(`setNavigationDestination`), and the main process parses the Review id
before the rule sees it.

**Two toggles.** Settings → General → Notifications holds `enabled`, on by
default, which gates every notification, and `preparationAndMerge`, off by
default, which also gates the preparation and merge events. They are stored
as one `notifications` object in `config.json` on the file's existing
`strictObject` schema rather than ADR 0022's per-field fallback: the file is
Patchdesk-owned on both sides and already fails closed as a whole. The
notifier reads them for each event, so a change applies to the next one.

**The port.** Services see `DesktopNotifier` (`src/services/desktop-notifier.ts`),
whose `notify` is synchronous and never throws, and call it through
`postDesktopNotification`, so a notifier defect cannot change the `Result` a
write returns. The main-process implementation (`src/main/desktop-notifier.ts`)
owns the settings read, the rule, Electron's `Notification`, and the click
hand-off. It logs `desktop-notification` `debug` lines: `shown` and `clicked`
with the event kind and Review id, and `skipped` with the kind and
`focused_on_review` or `disabled`.

## Consequences

- A merge or Finish review write left outcome-unknown does not notify yet;
  only the metadata and conversation writes named above do.
- A click for the Review already on screen focuses the window and leaves the
  current tab as it is.
- Opening a Review from Pull requests with the preparation toggle on notifies
  even while the window is focused, because the focused screen is Pull
  requests and not the Review.
- Notifications are not queued: an event raised while Patchdesk is quitting,
  or while `config.json` cannot be read, is logged and dropped.
