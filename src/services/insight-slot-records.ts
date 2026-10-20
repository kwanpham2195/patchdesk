import { randomUUID } from "node:crypto";

import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import { definedProps } from "#src/domain/defined-props";
import type {
  ContentHash,
  GitSha,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "#src/domain/ids";
import type {
  InsightArtifactReference,
  InsightArtifactRunId,
  InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "#src/domain/insight-provider";
import {
  type InsightFailure,
  type InsightFailureCategory,
  type InsightType,
} from "#src/domain/insight-record";
import {
  insightAuthorizationCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightProvenanceCodec,
  insightReviewSourceCodec,
  insightRunPolicyCodec,
  type InsightFailureRecord,
} from "#src/domain/insight-run-binding-contract";
import type { InsightJournalKey } from "#src/adapters/storage/insight-run-journal-reader";
import type { InsightJournalState } from "#src/domain/insight-run-journal-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { ReviewSource } from "#src/domain/review-source";

export type InsightSlotKey = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly type: InsightType;
};

/**
 * outcome_unknown: a pointer replacement may be durable; the next operation rereads under the same locks and the
 * affected run stays locked until it does. storage_unavailable: nothing was committed or the failure is definite; from a
 * cancel or settle it can also mean the journal is already terminal while the slot release failed, which recovery completes.
 */
export type InsightSlotFailure =
  | "already_running"
  | "not_active"
  | "storage_unavailable"
  | "outcome_unknown";

export type InsightRunRef = InsightSlotKey & {
  readonly runId: InsightArtifactRunId;
  readonly journalId: string;
};

export type InsightJournalStatus = InsightJournalState["status"];

/**
 * One internal journal transaction; a failure record is staged and referenced only when given. `usageUnknown` re-roots
 * the UsageRoot with hasUnknownUsage set and leaves its entries and every dispatch record untouched.
 */
export type InsightJournalChange = {
  readonly status: InsightJournalStatus;
  readonly cancelEpoch?: number;
  readonly failure?: Pick<InsightFailureRecord, "code" | "phase" | "recovery">;
  readonly usageUnknown?: true;
  /** R<GuidePreparedInput1> a verified Guide preparation installs; the writer lists it among the transaction's objects. */
  readonly guidePreparation?: InsightArtifactReference;
};

export function failed(): Result<never, InsightSlotFailure> {
  return err("storage_unavailable");
}

export function journalKey(run: InsightRunRef): InsightJournalKey {
  return {
    profileId: run.profileId,
    reviewId: run.reviewId,
    journalId: run.journalId,
    runId: run.runId,
  };
}

/** `complete` is excluded: only publication settles it. */
export function isTerminalStatus(status: InsightJournalStatus): boolean {
  return (
    status === "failed" || status === "cancelled" || status === "superseded"
  );
}

/** Before a CandidateRoot exists the run can only have failed in capture. */
export function phaseOf(
  state: InsightJournalState,
): InsightFailureRecord["phase"] {
  return state.candidate === null ? "capture" : "generation";
}

/** D4: `insight-<type>-<token>-<sha12>-review-<12hex>`, disjoint from legacy IDs (which embed the full Review ID with `__`). */
export function currentRunId(
  key: InsightSlotKey,
  headSha: GitSha,
  token: number,
): string {
  const reviewSegment = key.reviewId.slice(key.reviewId.lastIndexOf("__") + 2);
  return `insight-${key.type}-${token}-${headSha.slice(0, 12)}-${reviewSegment}`;
}

/** What admission stages as immutable objects before the journal and slot name them. */
export type InsightAdmissionObjects = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly runId: string;
  readonly type: InsightType;
  readonly source: ReviewSource;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
  readonly captureId: string;
  readonly selection: {
    readonly provider: InsightProvider;
    readonly model: string;
    readonly reasoning: InsightReasoning;
    readonly language: InsightLanguage;
  };
  readonly possibleSpendAcknowledged: boolean;
  readonly authorizedAt: IsoTimestamp;
};

type LegacyFailureMapping = {
  readonly reason: InsightFailure["reason"];
  readonly category: InsightFailureCategory | undefined;
};

/** The failure vocabulary the legacy slot fields can carry; every ErrorCode maps into it or to no category. */
export function legacyFailureFor(
  code: InsightFailureRecord["code"],
): LegacyFailureMapping {
  const category = failureCategory(code);
  if (code === "cancelled") return { reason: "cancelled", category };
  if (code === "superseded") return { reason: "superseded", category };
  return {
    reason: category === "invalid_result" ? "invalid_result" : "failed",
    category,
  };
}

function failureCategory(
  code: InsightFailureRecord["code"],
): InsightFailureCategory | undefined {
  switch (code) {
    case "cancelled":
    case "superseded":
      return undefined;
    case "evidence_missing":
      return "evidence_unavailable";
    case "evidence_changed":
      return "evidence_mismatch";
    case "capability_unavailable":
      return "runtime_unavailable";
    case "provider_refused":
      return "execution_failed";
    case "invalid_schema":
    case "invalid_field":
    case "invalid_reference":
    case "validation_rejected":
    case "orphan_unit":
    case "relation_conflict":
    case "identity_conflict":
      return "invalid_result";
    default:
      return "unexpected_failure";
  }
}

/** Stages the run's DomainIdentity, ReviewSource, Binding, RunPolicy, Provenance and Authorization, and returns every object it wrote so the journal's first LocalIntent can list them. */
export async function stageAdmissionObjects(
  artifacts: InsightArtifactStore,
  input: InsightAdmissionObjects,
): Promise<
  Result<
    {
      readonly binding: InsightArtifactReference;
      readonly authorization: InsightArtifactReference;
      readonly policy: InsightArtifactReference;
      readonly staged: ReadonlyArray<StagedObject>;
    },
    StorageFailure
  >
> {
  const { profileId, reviewId } = input;
  const staged: StagedObject[] = [];
  const profile = await artifacts.writeTextRoot(profileId, reviewId, profileId);
  if (profile._tag === "err") return profile;
  staged.push(textRootObject(profile.value));
  const review = await artifacts.writeTextRoot(profileId, reviewId, reviewId);
  if (review._tag === "err") return review;
  staged.push(textRootObject(review.value));
  const session = await artifacts.writeTextRoot(
    profileId,
    reviewId,
    input.sessionId,
  );
  if (session._tag === "err") return session;
  staged.push(textRootObject(session.value));
  const run = await artifacts.writeTextRoot(profileId, reviewId, input.runId);
  if (run._tag === "err") return run;
  staged.push(textRootObject(run.value));
  const model = await artifacts.writeTextRoot(
    profileId,
    reviewId,
    input.selection.model,
  );
  if (model._tag === "err") return model;
  staged.push(textRootObject(model.value));
  const identity = await artifacts.writeObject(
    profileId,
    reviewId,
    insightDomainIdentityCodec,
    {
      profileId: profile.value,
      reviewId: review.value,
      sessionId: session.value,
      runId: run.value,
    },
  );
  if (identity._tag === "err") return identity;
  staged.push({ schema: "DomainIdentity", root: identity.value });
  const sourceValue = await reviewSourceValue(artifacts, input, staged);
  if (sourceValue._tag === "err") return sourceValue;
  const source = await artifacts.writeObject(
    profileId,
    reviewId,
    insightReviewSourceCodec,
    sourceValue.value,
  );
  if (source._tag === "err") return source;
  staged.push({ schema: "ReviewSource", root: source.value });
  const binding = await artifacts.writeObject(
    profileId,
    reviewId,
    insightBindingCodec,
    {
      identityId: randomUUID(),
      identity: identity.value,
      kind: input.type,
      baseSha: input.baseSha,
      headSha: input.headSha,
      patchHash: input.patchHash,
      source: source.value,
      captureId: input.captureId,
    },
  );
  if (binding._tag === "err") return binding;
  staged.push({ schema: "Binding", root: binding.value });
  const policy = await artifacts.writeObject(
    profileId,
    reviewId,
    insightRunPolicyCodec,
    { kind: "no-total-deadline/1" },
  );
  if (policy._tag === "err") return policy;
  staged.push({ schema: "RunPolicy", root: policy.value });
  const selection = await artifacts.writeObject(
    profileId,
    reviewId,
    insightProvenanceCodec,
    {
      provider: input.selection.provider,
      model: model.value,
      reasoning: input.selection.reasoning,
      language: input.selection.language,
      origin: "generated",
    },
  );
  if (selection._tag === "err") return selection;
  staged.push({ schema: "Provenance", root: selection.value });
  const authorization = await artifacts.writeObject(
    profileId,
    reviewId,
    insightAuthorizationCodec,
    {
      id: randomUUID(),
      runId: input.runId,
      kind: "start",
      policy: policy.value,
      selection: selection.value,
      authorizedAt: input.authorizedAt,
      previous: null,
      possibleSpendAcknowledged: input.possibleSpendAcknowledged,
      unknownDispatchDisposition: null,
    },
  );
  if (authorization._tag === "err") return authorization;
  staged.push({ schema: "Authorization", root: authorization.value });
  return ok({
    binding: binding.value,
    authorization: authorization.value,
    policy: policy.value,
    staged,
  });
}

/** A staged object named for a LocalIntent's ObjectDigest list. */
type StagedObject = {
  readonly schema: string;
  readonly root: InsightArtifactReference;
};

/** A TextRoot's own object is its block index; the blocks below it are reached through that index. */
function textRootObject(root: InsightTextRootDescriptor): StagedObject {
  return { schema: "Index<BlobBlock>", root: root.data.blocks.root };
}

async function reviewSourceValue(
  artifacts: InsightArtifactStore,
  input: InsightAdmissionObjects,
  staged: StagedObject[],
) {
  const { profileId, reviewId, source } = input;
  const optional = async (value: string | undefined) => {
    if (value === undefined) return ok(undefined);
    const root = await artifacts.writeTextRoot(profileId, reviewId, value);
    if (root._tag === "ok") staged.push(textRootObject(root.value));
    return root;
  };
  if (source.kind === "pull_request")
    return ok({ kind: source.kind, prNumber: Number(source.prNumber) });
  const checkout = await optional(source.checkout);
  if (checkout._tag === "err") return checkout;
  if (source.kind === "commit")
    return ok({
      kind: source.kind,
      commitSha: source.commitSha,
      ...definedProps({ checkout: checkout.value }),
    });
  const branch = await optional(source.branch);
  if (branch._tag === "err") return branch;
  if (source.kind === "working_tree")
    return ok({
      kind: source.kind,
      ...definedProps({ branch: branch.value, checkout: checkout.value }),
    });
  const other = await optional(
    source.kind === "branch" ? source.baseBranch : source.baseRef,
  );
  if (other._tag === "err") return other;
  if (branch.value === undefined || other.value === undefined)
    return err(writeFailure());
  return ok(
    source.kind === "branch"
      ? {
          kind: source.kind,
          branch: branch.value,
          baseBranch: other.value,
          ...definedProps({ checkout: checkout.value }),
        }
      : {
          kind: source.kind,
          branch: branch.value,
          baseRef: other.value,
          ...definedProps({ checkout: checkout.value }),
        },
  );
}

function writeFailure(): StorageFailure {
  return {
    _tag: "StorageFailure",
    operation: "write",
    reason: "invalid_stored_value",
  };
}
