import { PatchdeskApiError } from "../../api-client";
import type { AssigneesSectionActions } from "../../components/assignee-picker";
import type { ReviewerPickerActions } from "../../components/reviewer-picker";
import type {
  AssignableUserListResponse,
  RepositoryLabelListResponse,
  ReviewerListResponse,
} from "../../renderer-contracts";

// The repository's full label catalog, as the Labels picker's `fetchLabels`
// reads it -- deliberately a superset of `workbenchFixtureData.pullRequest
// .labels` (one already-attached label plus one not-yet-attached one) so a
// browser test can open the picker and toggle a label that starts
// unchecked.
export const fixtureLabelCatalog: RepositoryLabelListResponse = {
  state: "ready",
  labels: [
    // Deliberately the only label with a `description`, so a browser test
    // can prove the picker renders it for this row and renders nothing
    // extra for the other two (#12's UI half).
    {
      id: "LA_bug",
      name: "bug",
      color: "d73a4a",
      description: "Something isn't working",
    },
    { id: "LA_needs_review", name: "needs-review", color: "0075ca" },
    { id: "LA_documentation", name: "documentation", color: "0e8a16" },
  ],
  totalCount: 3,
  permission: "permitted",
};

// A tiny, obviously-fake `data:` URI standing in for a resolved avatar --
// never a real image, just enough for `Avatar` to take the `<img>` branch
// instead of the initials-badge one. Mirrors the placeholder style
// `conversation.ui.test.tsx` already uses for `authorAvatarDataUri`.
const FIXTURE_AVATAR_DATA_URI = "data:image/png;base64,AAAA";

// The repository's assignable people, as the Assignees picker's
// `fetchAssignableUsers` reads it -- deliberately a superset of
// `workbenchFixtureData.pullRequest.assignees` (one already-assigned person
// plus two not-yet-assigned ones) so a browser test can open the picker,
// search, and toggle someone who starts unchecked. `fetchAssignableUsers`
// filters this list by `query` the same way the real, server-side filter
// does, so the search/debounce wiring has something real to exercise.
// `fixture-assignee` carries a resolved `avatarDataUri` and the other two do
// not, so both `Avatar` branches (cached image, initials fallback) render
// somewhere in this same list -- for the rail's own assignee row and for the
// picker, which reads this exact list.
const fixtureAssignableUsers: NonNullable<AssignableUserListResponse["users"]> =
  [
    {
      id: "MDQ6VXNlcjEwMQ==",
      login: "fixture-assignee",
      avatarDataUri: FIXTURE_AVATAR_DATA_URI,
    },
    { id: "MDQ6VXNlcjEwMg==", login: "fixture-collaborator" },
    { id: "MDQ6VXNlcjEwMw==", login: "fixture-maintainer" },
  ];

async function fixtureFetchAssignableUsers(
  query?: string,
): Promise<AssignableUserListResponse> {
  const users =
    query === undefined || query === ""
      ? fixtureAssignableUsers
      : fixtureAssignableUsers.filter((user) => user.login.includes(query));
  return {
    state: "ready",
    users,
    totalCount: users.length,
    permission: "permitted",
  };
}

export const fixtureAssigneeActions: AssigneesSectionActions = {
  fetchAssignableUsers: fixtureFetchAssignableUsers,
  addAssignees: async () => undefined,
  removeAssignees: async () => undefined,
  assignSelf: async () => ["fixture-viewer"],
};

export const fixtureAssigneeActionsDenied: AssigneesSectionActions = {
  ...fixtureAssigneeActions,
  fetchAssignableUsers: async () => ({
    state: "ready",
    users: fixtureAssignableUsers,
    totalCount: fixtureAssignableUsers.length,
    permission: "denied",
  }),
};

export const fixtureAssigneeActionsUnknown: AssigneesSectionActions = {
  ...fixtureAssigneeActions,
  fetchAssignableUsers: async () => ({
    state: "ready",
    users: fixtureAssignableUsers,
    totalCount: fixtureAssignableUsers.length,
    permission: "unknown",
  }),
};

export const fixtureAssigneeActionsWriteFailure: AssigneesSectionActions = {
  ...fixtureAssigneeActions,
  addAssignees: async () => {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "fixture-assignee-write",
      "Patchdesk could not reach GitHub.",
    );
  },
  removeAssignees: async () => {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "fixture-assignee-write",
      "Patchdesk could not reach GitHub.",
    );
  },
};

export const fixtureAssigneeActionsCapExceeded: AssigneesSectionActions = {
  ...fixtureAssigneeActions,
  addAssignees: async () => {
    throw new PatchdeskApiError(
      "assignee_cap_exceeded",
      400,
      false,
      "fixture-assignee-cap",
      "GitHub limits a pull request to ten assignees.",
    );
  },
};

export const fixtureAssigneeActionsReadFailure: AssigneesSectionActions = {
  ...fixtureAssigneeActions,
  fetchAssignableUsers: async () => ({ state: "github_read" }),
};

// The pull request's reviewer rows, as the Reviewers section's own
// `fetchReviewers` (no query) reads it -- deliberately covers three states
// in one fixture: a requested reviewer with no verdict yet
// ("fixture-reviewer", matching `workbenchFixtureData.pullRequest
// .requestedReviewers`), a current, on-revision approval
// ("fixture-approved-reviewer"), and an outdated changes-requested verdict
// ("fixture-outdated-reviewer") -- so a single browser test can assert the
// requested-pending state, a verdict badge, and the outdated marking
// together.
// `fixture-approved-reviewer` carries a resolved `avatarDataUri`; the other
// two do not, so the Reviewers section renders both an `<img>` and an
// initials badge in the same list.
const fixtureReviewerRows: NonNullable<ReviewerListResponse["reviewers"]> = [
  { login: "fixture-reviewer", outdated: false },
  {
    login: "fixture-approved-reviewer",
    verdict: "approved",
    outdated: false,
    submittedAt: "2026-07-16T00:00:00.000Z",
    avatarDataUri: FIXTURE_AVATAR_DATA_URI,
  },
  {
    login: "fixture-outdated-reviewer",
    verdict: "changes_requested",
    outdated: true,
    submittedAt: "2026-07-10T00:00:00.000Z",
  },
];

// GitHub's own suggested reviewers, as the Reviewer picker's own fetch reads
// it -- one collaborator flagged only `isAuthor`, so a browser test can
// assert the picker's honest, Patchdesk-authored suggestion caption.
const fixtureSuggestedReviewers: NonNullable<
  ReviewerListResponse["suggested"]
> = [
  {
    isAuthor: true,
    isCommenter: false,
    reviewer: {
      login: "fixture-suggested-reviewer",
      avatarDataUri: FIXTURE_AVATAR_DATA_URI,
    },
  },
];

// The repository's reviewer candidates, as the Reviewer picker's
// `fetchReviewers` reads it -- includes the already-requested reviewer (so
// the picker can prove it starts checked), the suggested collaborator (so
// the picker can prove it renders once, grouped above the rest), and one
// not-yet-requested collaborator for toggling. `fixture-suggested-reviewer`
// carries a resolved `avatarDataUri` (it's the row the picker actually
// renders an avatar from -- see `ReviewerCandidateRow`); the other two do
// not, so the picker's suggested group and its plain candidate list each
// exercise a different `Avatar` branch.
const fixtureReviewerCandidates: NonNullable<
  ReviewerListResponse["candidates"]
> = [
  { id: "MDQ6VXNlcjIwMQ==", login: "fixture-reviewer" },
  {
    id: "MDQ6VXNlcjIwMg==",
    login: "fixture-suggested-reviewer",
    avatarDataUri: FIXTURE_AVATAR_DATA_URI,
  },
  { id: "MDQ6VXNlcjIwMw==", login: "fixture-other-reviewer" },
];

async function fixtureFetchReviewers(
  query?: string,
): Promise<ReviewerListResponse> {
  const candidates =
    query === undefined || query === ""
      ? fixtureReviewerCandidates
      : fixtureReviewerCandidates.filter((candidate) =>
          candidate.login.includes(query),
        );
  return {
    state: "ready",
    reviewers: fixtureReviewerRows,
    suggested: fixtureSuggestedReviewers,
    candidates,
    candidatesTotalCount: candidates.length,
    permission: "permitted",
  };
}

export const fixtureReviewerActions: ReviewerPickerActions = {
  fetchReviewers: fixtureFetchReviewers,
  requestReviewers: async () => undefined,
  removeReviewers: async () => undefined,
};

export const fixtureReviewerActionsEmpty: ReviewerPickerActions = {
  ...fixtureReviewerActions,
  fetchReviewers: async () => ({
    state: "ready",
    reviewers: [],
    suggested: [],
    candidates: fixtureReviewerCandidates,
    candidatesTotalCount: fixtureReviewerCandidates.length,
    permission: "permitted",
  }),
};

export const fixtureReviewerActionsDenied: ReviewerPickerActions = {
  ...fixtureReviewerActions,
  fetchReviewers: async () => ({
    state: "ready",
    reviewers: fixtureReviewerRows,
    suggested: fixtureSuggestedReviewers,
    candidates: fixtureReviewerCandidates,
    candidatesTotalCount: fixtureReviewerCandidates.length,
    permission: "denied",
  }),
};

export const fixtureReviewerActionsUnknown: ReviewerPickerActions = {
  ...fixtureReviewerActions,
  fetchReviewers: async () => ({
    state: "ready",
    reviewers: fixtureReviewerRows,
    suggested: fixtureSuggestedReviewers,
    candidates: fixtureReviewerCandidates,
    candidatesTotalCount: fixtureReviewerCandidates.length,
    permission: "unknown",
  }),
};

export const fixtureReviewerActionsWriteFailure: ReviewerPickerActions = {
  ...fixtureReviewerActions,
  requestReviewers: async () => {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "fixture-reviewer-write",
      "Patchdesk could not reach GitHub.",
    );
  },
  removeReviewers: async () => {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "fixture-reviewer-write",
      "Patchdesk could not reach GitHub.",
    );
  },
};

export const fixtureReviewerActionsReadFailure: ReviewerPickerActions = {
  ...fixtureReviewerActions,
  fetchReviewers: async () => ({ state: "github_read" }),
};
