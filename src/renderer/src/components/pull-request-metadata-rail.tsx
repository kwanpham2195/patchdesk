import { useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  History,
  MessageCircle,
  PenLine,
  XCircle,
} from "lucide-react";

import type {
  GitHubLabel,
  PullRequestAssigneePermission,
} from "../../../domain/github-context";
import type { ReviewVerdictState } from "../../../domain/review-verdicts";
import { PatchdeskApiError } from "../api-client";
import { forbiddenCopy, rateLimitedCopy } from "../github-read-failure-copy";
import { freshnessCopy, type RevisionFreshness } from "../rail-freshness";
import type {
  AssignableUserListResponse,
  PendingReviewProjection,
  ReviewerListResponse,
} from "../renderer-contracts";
import {
  AssigneePicker,
  type AssigneePickerActions,
  type AssigneesSectionActions,
} from "./assignee-picker";
import { LabelChip } from "./label-chip";
import { LabelPicker, type LabelPickerActions } from "./label-picker";
import { ReviewerPicker, type ReviewerPickerActions } from "./reviewer-picker";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

/**
 * One topic section inside `PullRequestMetadataRail`. Exported so a later
 * slice only needs to add another `<RailSection>` rather than rebuild the
 * header row, freshness line, and settings-control slot.
 */
export function RailSection({
  title,
  freshness,
  settings,
  children,
}: {
  readonly title: string;
  readonly freshness: RevisionFreshness;
  readonly settings?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="border-b py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {freshnessCopy(freshness)}
          </p>
        </div>
        {settings}
      </div>
      {children}
    </section>
  );
}

/** Mutable form of `RailSection`'s header props, so a section can assign
 * `settings` only when present instead of a conditional empty-object spread
 * (mirrors `MutableGeneralThreadOverrides` in `conversation.tsx`). */
type MutableRailSectionHeaderProps = {
  title: string;
  freshness: RevisionFreshness;
  settings?: React.ReactNode;
};

/** Mutable form of `AssigneePicker`'s props, for the same reason. */
type MutableAssigneePickerProps = {
  attachedAssignees: ReadonlyArray<string>;
  actions?: AssigneePickerActions;
};

/** Mutable form of `AssigneesSection`'s props, for the same reason. */
type MutableAssigneesSectionProps = {
  assignees: ReadonlyArray<string>;
  freshness: RevisionFreshness;
  refreshedAt: string;
  terminal: boolean;
  actions?: AssigneesSectionActions;
};

/** Mutable form of `ReviewerPicker`'s props, for the same reason. */
type MutableReviewerPickerProps = {
  attachedReviewers: ReadonlyArray<string>;
  actions?: ReviewerPickerActions;
};

/** Mutable form of `ReviewersSection`'s props, for the same reason. */
type MutableReviewersSectionProps = {
  requestedReviewers: ReadonlyArray<string>;
  pendingReview?: PendingReviewProjection;
  freshness: RevisionFreshness;
  refreshedAt: string;
  terminal: boolean;
  actions?: ReviewerPickerActions;
};

/** Mutable form of `PullRequestMetadataRail`'s Labels `<RailSection>` header, for the same reason. */
type MutableLabelsRailSectionProps = {
  title: string;
  freshness: RevisionFreshness;
  settings?: React.ReactNode;
};

type ReviewerRow = NonNullable<ReviewerListResponse["reviewers"]>[number];

type ReviewerSectionReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | { readonly _tag: "ready"; readonly reviewers: ReadonlyArray<ReviewerRow> }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?:
        | "ip_allow_list"
        | "saml"
        | "insufficient_scopes"
        | "unknown";
    };

function projectReviewerSectionReadState(
  response: ReviewerListResponse | undefined,
): ReviewerSectionReadState {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready")
    return { _tag: "ready", reviewers: response.reviewers ?? [] };
  if (response.state === "github_rate_limited") {
    const resumeAtField =
      response.resumeAt === undefined ? {} : { resumeAt: response.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (response.state === "github_forbidden") {
    const reasonField =
      response.forbiddenReason === undefined
        ? {}
        : { reason: response.forbiddenReason };
    return { _tag: "github_forbidden", ...reasonField };
  }
  return { _tag: response.state };
}

/**
 * Projects `GET /v1/reviews/assignees`'s candidate list into a login-keyed
 * lookup of resolved avatars, for `AssigneesSection` to match against the
 * bare logins `model.pullRequest.assignees` carries — see that section's own
 * doc comment for why the match happens by login rather than by a richer
 * shape. A login with no `avatarDataUri` (never synced, sync failed, or not
 * present in the candidate list at all) is simply absent from the map, and
 * `Avatar` falls back to its initials badge.
 */
function avatarDataUriByLoginFrom(
  response: AssignableUserListResponse | undefined,
): ReadonlyMap<string, string> {
  const users = response?.state === "ready" ? (response.users ?? []) : [];
  const byLogin = new Map<string, string>();
  for (const user of users) {
    if (user.avatarDataUri !== undefined)
      byLogin.set(user.login, user.avatarDataUri);
  }
  return byLogin;
}

/** Human copy for a submitted review verdict, matching the wording `conversation.tsx`'s `ReviewSummaryEntry` already uses for the same four states. */
function reviewVerdictLabel(verdict: ReviewVerdictState): string {
  switch (verdict) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "commented":
      return "Commented";
    case "dismissed":
      return "Dismissed";
  }
}

/** A verdict's icon, so the outdated marking and each verdict stay legible without relying on colour alone. */
function ReviewVerdictIcon({
  verdict,
}: {
  readonly verdict: ReviewVerdictState;
}): React.JSX.Element {
  switch (verdict) {
    case "approved":
      return <CheckCircle2 className="size-3" />;
    case "changes_requested":
      return <XCircle className="size-3" />;
    case "commented":
      return <MessageCircle className="size-3" />;
    case "dismissed":
      return <Ban className="size-3" />;
  }
}

/**
 * One reviewer row: an initials badge, the login, and either the person's
 * latest submitted verdict or, for a requested-but-unanswered reviewer, an
 * explicit "Requested" label — never blank, since a pending ask is not a
 * silent one. `outdated` renders as a second, plainly-worded badge (text
 * plus icon, not colour alone) rather than a colour change on the verdict
 * badge, so "approved, but not on this revision" stays legible under any
 * colour-vision condition.
 */
function ReviewerListRow({
  reviewer,
}: {
  readonly reviewer: ReviewerRow;
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <Avatar
        name={reviewer.name ?? reviewer.login}
        dataUri={reviewer.avatarDataUri}
        className="size-5 text-[10px]"
      />
      <span className="min-w-0 flex-1 truncate text-xs">{reviewer.login}</span>
      {reviewer.verdict === undefined ? (
        <span className="text-[10px] text-muted-foreground">Requested</span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ReviewVerdictIcon verdict={reviewer.verdict} />
            {reviewVerdictLabel(reviewer.verdict)}
          </Badge>
          {reviewer.outdated ? (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] text-muted-foreground"
            >
              <History className="size-3" />
              Outdated
            </Badge>
          ) : null}
        </span>
      )}
    </li>
  );
}

/**
 * The viewer's own open GitHub pending review, rendered as an additional row
 * — never a replacement for anyone's verdict row. Visually distinct from a
 * submitted verdict through more than colour: a dashed border, an italic
 * "draft" label, and a pen icon on its comment-count badge.
 */
function PendingReviewRow({
  count,
}: {
  readonly count: number;
}): React.JSX.Element {
  return (
    <div
      aria-label="Your review in progress"
      className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/40 px-1.5 py-1"
    >
      <Avatar name="You" className="size-5 text-[10px]" />
      <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
        Your review · draft
      </span>
      <Badge variant="outline" className="gap-1 text-[10px]">
        <PenLine className="size-3" />
        {count} {count === 1 ? "comment" : "comments"}
      </Badge>
    </div>
  );
}

/** The Reviewers section's fetched body: the read state's failure/loading copy, or its list of reviewer rows plus the empty state. */
function ReviewersSectionBody({
  readState,
}: {
  readonly readState: ReviewerSectionReadState;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading reviewers…
      </p>
    );
  if (readState._tag === "github_auth")
    return (
      <p role="alert" className="text-xs text-destructive">
        GitHub authentication is required before Patchdesk can show this pull
        request&apos;s reviewers.
      </p>
    );
  if (readState._tag === "github_read")
    return (
      <p role="alert" className="text-xs text-destructive">
        Patchdesk could not load this pull request&apos;s reviewers. Refresh to
        retry.
      </p>
    );
  if (readState._tag === "github_rate_limited")
    return (
      <p role="alert" className="text-xs text-destructive">
        {rateLimitedCopy(readState.resumeAt)}
      </p>
    );
  if (readState._tag === "github_forbidden")
    return (
      <p role="alert" className="text-xs text-destructive">
        {forbiddenCopy(readState.reason)}
      </p>
    );
  if (readState.reviewers.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No review has been requested, and none has been submitted.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Pull request reviewers">
      {readState.reviewers.map((reviewer) => (
        <ReviewerListRow key={reviewer.login} reviewer={reviewer} />
      ))}
    </ul>
  );
}

/**
 * The Reviewers section: every reviewer's Revision-bound review verdict (or
 * their pending "Requested" ask), plus the viewer's own open pending review
 * when there is one. Unlike `AssigneesSection` (whose row list comes
 * straight from the `assignees` prop), the verdict-augmented row list here
 * only exists behind `GET /v1/reviews/reviewers`, so this section owns its
 * own fetch-on-mount discipline — once when mounted, again whenever the
 * workbench re-baselines (`refreshedAt` changes), never polling — the same
 * discipline `AssigneesSection` already uses for its own permission read.
 */
function ReviewersSection({
  requestedReviewers,
  pendingReview,
  freshness,
  refreshedAt,
  terminal,
  actions,
}: {
  readonly requestedReviewers: ReadonlyArray<string>;
  readonly pendingReview?: PendingReviewProjection;
  readonly freshness: RevisionFreshness;
  readonly refreshedAt: string;
  readonly terminal: boolean;
  readonly actions?: ReviewerPickerActions;
}): React.JSX.Element {
  const [readState, setReadState] = useState<ReviewerSectionReadState>({
    _tag: "loading",
  });

  useEffect(() => {
    if (actions === undefined) {
      setReadState({ _tag: "loading" });
      return;
    }
    let cancelled = false;
    setReadState({ _tag: "loading" });
    actions
      .fetchReviewers()
      .then((response) => {
        if (cancelled) return;
        setReadState(projectReviewerSectionReadState(response));
      })
      .catch(() => {
        if (!cancelled) setReadState({ _tag: "github_read" });
      });
    return () => {
      cancelled = true;
    };
    // `refreshedAt` re-triggers the fetch on every workbench re-baseline;
    // it is intentionally in the dependency list purely as a re-fetch key.
  }, [actions, refreshedAt]);

  const pickerProps: MutableReviewerPickerProps = {
    attachedReviewers: requestedReviewers,
  };
  if (actions !== undefined) pickerProps.actions = actions;

  const headerProps: MutableRailSectionHeaderProps = {
    title: "Reviewers",
    freshness,
  };
  if (!terminal) headerProps.settings = <ReviewerPicker {...pickerProps} />;

  const pendingCount =
    pendingReview?.state === "pending" ? pendingReview.count : undefined;

  return (
    <RailSection {...headerProps}>
      <div className="flex flex-col gap-1.5">
        <ReviewersSectionBody readState={readState} />
        {pendingCount === undefined ? null : (
          <PendingReviewRow count={pendingCount} />
        )}
      </div>
    </RailSection>
  );
}

/**
 * The Assignees section: the pull request's current assignees (each
 * rendered with their GitHub avatar when one resolved, otherwise an
 * initials badge) or, when nobody is assigned, a plain empty state plus a
 * one-click self-assign shortcut. Unlike `LabelPicker` (which fetches only
 * once its own popover opens), this section fetches the real
 * GitHub-evidenced assign permission itself, once on mount and again
 * whenever the workbench re-baselines (`refreshedAt` changes) — the
 * self-assign shortcut's visibility depends on that permission before the
 * picker is ever opened, and detection must never poll on its own. That same
 * fetch doubles as the source of each assignee's avatar: `assignees` itself
 * is only bare logins (`model.pullRequest.assignees`), so this section
 * matches each one against the candidate list's resolved `avatarDataUri` by
 * login (`avatarDataUriByLoginFrom`) — a login absent from that list (or
 * whose avatar never resolved) simply falls back to the initials badge.
 */
function AssigneesSection({
  assignees,
  freshness,
  refreshedAt,
  terminal,
  actions,
}: {
  readonly assignees: ReadonlyArray<string>;
  readonly freshness: RevisionFreshness;
  readonly refreshedAt: string;
  readonly terminal: boolean;
  readonly actions?: AssigneesSectionActions;
}): React.JSX.Element {
  const [permission, setPermission] =
    useState<PullRequestAssigneePermission>("unknown");
  // The rail renders assignees as bare logins (`assignees` below), not the
  // richer `AssignableUser` rows `fetchAssignableUsers` returns, so this
  // matches each displayed login back to its resolved avatar by hand — the
  // candidate list this same fetch already populates doubles as the source
  // of avatar data for the rail's own assignee rows.
  const [avatarDataUriByLogin, setAvatarDataUriByLogin] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());

  useEffect(() => {
    if (actions === undefined) {
      setPermission("unknown");
      setAvatarDataUriByLogin(new Map());
      return;
    }
    let cancelled = false;
    actions
      .fetchAssignableUsers()
      .then((response) => {
        if (cancelled) return;
        setPermission(
          response?.state === "ready"
            ? (response.permission ?? "unknown")
            : "unknown",
        );
        setAvatarDataUriByLogin(avatarDataUriByLoginFrom(response));
      })
      .catch(() => {
        if (cancelled) return;
        setPermission("unknown");
        setAvatarDataUriByLogin(new Map());
      });
    return () => {
      cancelled = true;
    };
    // `refreshedAt` re-triggers the fetch on every workbench re-baseline;
    // it is intentionally in the dependency list purely as a re-fetch key.
  }, [actions, refreshedAt]);

  const [selfAssignPending, setSelfAssignPending] = useState<
    ReadonlyArray<string>
  >([]);
  const [selfAssignBusy, setSelfAssignBusy] = useState(false);
  const [selfAssignError, setSelfAssignError] = useState<string>();
  // Drops each optimistically self-assigned login once the authoritative
  // `assignees` prop catches up with it, mirroring `LabelPicker`'s
  // adjust-state-during-render reconciliation.
  const [prevAssignees, setPrevAssignees] = useState(assignees);
  if (prevAssignees !== assignees) {
    setPrevAssignees(assignees);
    if (selfAssignPending.length > 0) {
      const assigneeSet = new Set(assignees);
      const next = selfAssignPending.filter((login) => !assigneeSet.has(login));
      if (next.length !== selfAssignPending.length) setSelfAssignPending(next);
    }
  }
  const visibleAssignees =
    selfAssignPending.length === 0
      ? assignees
      : [...assignees, ...selfAssignPending];

  const onSelfAssign = (): void => {
    if (actions === undefined || selfAssignBusy) return;
    setSelfAssignError(undefined);
    setSelfAssignBusy(true);
    actions
      .assignSelf()
      .then((added) => {
        setSelfAssignPending((current) => {
          const alreadyPending = new Set(current);
          return [
            ...current,
            ...added.filter((login) => !alreadyPending.has(login)),
          ];
        });
      })
      .catch((cause: unknown) => {
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setSelfAssignError(
          `Patchdesk could not assign you to this pull request.${reason}`,
        );
      })
      .finally(() => setSelfAssignBusy(false));
  };

  const pickerProps: MutableAssigneePickerProps = {
    attachedAssignees: visibleAssignees,
  };
  if (actions !== undefined) pickerProps.actions = actions;

  const headerProps: MutableRailSectionHeaderProps = {
    title: "Assignees",
    freshness,
  };
  if (!terminal) headerProps.settings = <AssigneePicker {...pickerProps} />;

  return (
    <RailSection {...headerProps}>
      {visibleAssignees.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Nobody is assigned.</p>
          {!terminal && permission !== "denied" ? (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={selfAssignBusy || actions === undefined}
                onClick={onSelfAssign}
              >
                {selfAssignBusy ? <Spinner className="size-3" /> : null}
                Assign yourself
              </Button>
              {permission === "unknown" ? (
                <p className="text-xs text-muted-foreground">
                  Patchdesk could not confirm you can manage assignees here — a
                  change may be refused.
                </p>
              ) : null}
              {selfAssignError === undefined ? null : (
                <p role="alert" className="text-xs text-destructive">
                  {selfAssignError}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <ul
          className="flex flex-col gap-1.5"
          aria-label="Pull request assignees"
        >
          {visibleAssignees.map((login) => (
            <li key={login} className="flex items-center gap-2">
              <Avatar
                name={login}
                dataUri={avatarDataUriByLogin.get(login)}
                className="size-5 text-[10px]"
              />
              <span className="truncate text-xs">{login}</span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

/**
 * The sticky right-hand rail on the Conversation tab, holding one
 * `RailSection` per pull-request metadata topic, in order: Reviewers,
 * Assignees, Labels. `ReviewWorkbench` builds this element (it holds the
 * model) and passes it to `Conversation` as a plain `rail` prop, which keeps
 * the rail off the Diff and Insights tabs by construction — `Conversation`
 * only ever renders what it's given.
 *
 * Under `terminal` (the Review is no longer open), every section renders
 * read-only: `settings` is withheld entirely rather than left to
 * `LabelPicker`'s own "no actions wired" fallback, so a later section that
 * always has actions wired still goes read-only under Terminal.
 */
export function PullRequestMetadataRail({
  labels,
  assignees,
  requestedReviewers,
  pendingReview,
  freshness,
  refreshedAt,
  terminal,
  labelActions,
  assigneeActions,
  reviewerActions,
}: {
  readonly labels: ReadonlyArray<GitHubLabel>;
  readonly assignees: ReadonlyArray<string>;
  readonly requestedReviewers: ReadonlyArray<string>;
  readonly pendingReview?: PendingReviewProjection;
  readonly freshness: RevisionFreshness;
  readonly refreshedAt: string;
  readonly terminal: boolean;
  readonly labelActions?: LabelPickerActions;
  readonly assigneeActions?: AssigneesSectionActions;
  readonly reviewerActions?: ReviewerPickerActions;
}): React.JSX.Element {
  const reviewersSectionProps: MutableReviewersSectionProps = {
    requestedReviewers,
    freshness,
    refreshedAt,
    terminal,
  };
  if (pendingReview !== undefined)
    reviewersSectionProps.pendingReview = pendingReview;
  if (reviewerActions !== undefined)
    reviewersSectionProps.actions = reviewerActions;

  const assigneesSectionProps: MutableAssigneesSectionProps = {
    assignees,
    freshness,
    refreshedAt,
    terminal,
  };
  if (assigneeActions !== undefined)
    assigneesSectionProps.actions = assigneeActions;

  const labelsSectionHeaderProps: MutableLabelsRailSectionProps = {
    title: "Labels",
    freshness,
  };
  if (!terminal)
    labelsSectionHeaderProps.settings = (
      <LabelPicker
        attachedLabels={labels}
        {...(labelActions === undefined ? {} : { actions: labelActions })}
      />
    );

  return (
    <aside
      aria-label="Pull request metadata"
      className="w-full min-[1100px]:sticky min-[1100px]:top-0 min-[1100px]:w-[272px] min-[1100px]:shrink-0"
    >
      <ReviewersSection {...reviewersSectionProps} />
      <AssigneesSection {...assigneesSectionProps} />
      <RailSection {...labelsSectionHeaderProps}>
        {labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">No labels.</p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Pull request labels"
          >
            {labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        )}
      </RailSection>
    </aside>
  );
}
