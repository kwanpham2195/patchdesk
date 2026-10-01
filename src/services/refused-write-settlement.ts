import {
  refusalFinality,
  type RefusalCause,
  type WriteKind,
} from "../domain/github-write-refusal";

/** What a write service does with a refusal: report it, or keep the uncertain-outcome path. */
export type RefusalSettlement =
  | { readonly _tag: "Refused"; readonly cause: RefusalCause }
  | { readonly _tag: "OutcomeUnknown" };

/**
 * The one place a GitHub refusal is settled (ADR 0046, issue #755). It
 * returns `Refused` with the cause and each service maps that to its own
 * reason. A refusal is final with no read when `refusalFinality` says a landed
 * first delivery cannot produce it. Otherwise `isUnchanged` runs the kind's
 * existing read, and the refusal is final only when it shows the state the
 * write would change is still unchanged. A final refusal records the
 * rejection and releases the lock through `recordRejection`; a read that
 * fails or shows the change, or a rejection that cannot be recorded, leaves the
 * write on today's outcome-unknown path for ADR 0035 recovery.
 */
export async function settleRefusedWrite(input: {
  readonly kind: WriteKind;
  readonly cause: RefusalCause;
  /** The kind's existing read: true only when it proves the write did not land. */
  readonly isUnchanged: () => Promise<boolean>;
  /** Records the rejection and releases the write lock; false when that could not be persisted. */
  readonly recordRejection: () => Promise<boolean>;
}): Promise<RefusalSettlement> {
  const final =
    refusalFinality(input.kind, input.cause) === "final" ||
    (await input.isUnchanged());
  return final && (await input.recordRejection())
    ? { _tag: "Refused", cause: input.cause }
    : { _tag: "OutcomeUnknown" };
}
