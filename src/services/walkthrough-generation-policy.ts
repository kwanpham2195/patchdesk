import { randomUUID } from "node:crypto";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import {
  insightAuthorizationCodec,
  insightRunPolicyCodec,
} from "#src/domain/insight-run-binding-contract";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { IsoTimestamp } from "#src/domain/ids";
import type { WalkthroughPreparedInput } from "#src/domain/walkthrough-preparation";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightRunRef } from "./insight-slot-records";
import { walkthroughTimeoutMs } from "./walkthrough-timeout";

/** Stages begin-time immutable policy and linked authorization without rewriting admitted authority. */
export async function stageWalkthroughDeadline(
  artifacts: InsightArtifactStore,
  run: InsightRunRef,
  previous: InsightArtifactReference,
  prepared: WalkthroughPreparedInput,
  now: IsoTimestamp,
): Promise<
  Result<
    {
      readonly policy: InsightArtifactReference;
      readonly authorization: InsightArtifactReference;
      readonly deadlineAt: string;
    },
    "storage"
  >
> {
  const { profileId, reviewId } = run;
  const prior = await artifacts.readObject(
    profileId,
    reviewId,
    insightAuthorizationCodec,
    previous,
  );
  if (prior._tag === "err" || prior.value.runId !== run.runId)
    return err("storage");
  const deadlineAt = new Date(
    Date.parse(now) +
      walkthroughTimeoutMs({
        patchBytes: prepared.patch.data.bytes,
        contextBytes: prepared.context.data.bytes,
        hunkCount: Math.min(113, prepared.hunks.count),
      }),
  ).toISOString();
  const policy = await artifacts.writeObject(
    profileId,
    reviewId,
    insightRunPolicyCodec,
    { kind: "walkthrough-deadline/1", startedAt: now, deadlineAt },
  );
  if (policy._tag === "err") return err("storage");
  const authorization = await artifacts.writeObject(
    profileId,
    reviewId,
    insightAuthorizationCodec,
    {
      ...prior.value,
      id: randomUUID(),
      policy: policy.value,
      previous: prior.value.id,
    },
  );
  return authorization._tag === "err"
    ? err("storage")
    : ok({
        policy: policy.value,
        authorization: authorization.value,
        deadlineAt,
      });
}
