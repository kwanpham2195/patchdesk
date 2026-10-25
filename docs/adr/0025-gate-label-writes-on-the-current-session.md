# Gate Label Writes On The Current Session

GitHub label changes use `ReviewWriteGate.requireCurrentSession`, not
`requireFresh`. Freshness is required for diff-anchored writes because a
comment on a stale patch can target the wrong lines. A new commit does not
invalidate a label, so requiring a Fresh patch would block label changes after
someone pushes. `LabelService.execute` and `LabelService.list` use the same
current-session check.

Label permission has three states in `RepositoryLabelPermission`:
`permitted`, `denied`, and `unknown`. The check fails closed. GitHub's `triage`
role can apply and dismiss labels without pull-request write access, so
`canManageLabels` is derived separately from `pullRequestsWrite`.

The optional `getRepositoryPermission` adapter read supplies this evidence. If
the read is missing or resolves an account other than the one configured for
the profile, permission is `unknown`. `execute` allows a write only when
permission is explicitly `permitted`. The picker shows each state: enabled,
disabled with a no-manage message, or enabled with a caveat. Treating `unknown`
as `permitted` would offer an action GitHub may refuse. Treating it as `denied`
would hide a capability the account may have.

The permission read was also fixed to parse the collaborator-permission
endpoint's `role_name` field instead of its legacy `permission` field. The
legacy field reports only `admin`, `write`, `read`, or `none`; it cannot
represent `triage`. That mismatch had denied `pullRequestsWrite`, `canDismiss`,
`canEdit`, and `canDelete` to every non-admin account. Labeling exposed the
problem.

A confirmed label change is recorded as an own-write in the
`RecentReviewWrite` journal. Without a `LabelChange` entry,
`ReviewObservationService.containsRecentWrites` could let a poll replace the
projection before it includes the new label. The journal already prevents this
race for other writes. Label changes do not affect the "Updates available"
banner, which depends on head-SHA identity.
