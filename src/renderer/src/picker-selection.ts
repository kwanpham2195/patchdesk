/**
 * Drops one member from a picker's optimistic-selection set, returning the
 * same set unchanged when the member is not in it so React can skip a
 * re-render it does not need.
 *
 * Every rail picker keeps its pending adds, pending removes, and in-flight
 * writes as `ReadonlySet<string>` keyed by the thing being toggled — a label
 * name in `LabelPicker`, a login in `AssigneePicker` and `ReviewerPicker` —
 * and each of them needs exactly this operation. It lives here so the three
 * share one copy rather than each carrying its own.
 */
export function withoutMember<T extends string>(
  set: ReadonlySet<T>,
  member: T,
): ReadonlySet<T> {
  if (!set.has(member)) return set;
  const next = new Set(set);
  next.delete(member);
  return next;
}
