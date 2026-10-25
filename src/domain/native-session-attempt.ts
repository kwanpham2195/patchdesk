import * as v from "valibot";
import { parseReviewSessionId } from "./ids";
import { explanationFrameIdentity } from "./explanation-channel";
import { insightArtifactReferenceSchema } from "./insight-artifact-scalars";

const scalar = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.check((text) =>
    [...text].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }),
  ),
);
const number = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const reasoning = v.picklist(["minimal", "low", "medium", "high", "xhigh"]);
const capture = v.variant("status", [
  v.strictObject({
    status: v.picklist(["not_started", "pending", "missing", "failed"]),
    completeness: v.literal("unknown"),
  }),
  v.strictObject({
    status: v.literal("retained"),
    completeness: v.literal("unknown"),
    bytes: number,
    sha256: hash,
  }),
]);
const cleanup = v.strictObject({
  scope: v.picklist([
    "pi_abort_ack_and_owned_group_only",
    "pi_owned_group_only",
    "codex_owned_group_only",
  ]),
  detachedBashDescendants: v.literal("unproven"),
  abort: v.picklist(["not_required", "pending", "acknowledged", "unknown"]),
  hostWork: v.picklist(["not_applicable", "pending", "drained", "unknown"]),
  process: v.picklist(["not_started", "pending", "succeeded", "unknown"]),
  archive: v.picklist(["pending", "succeeded", "failed", "not_applicable"]),
  credentialHome: v.picklist([
    "not_applicable",
    "pending",
    "succeeded",
    "failed",
    "protected",
  ]),
});
const failure = v.strictObject({
  phase: v.picklist([
    "prepare",
    "preflight",
    "start",
    "execution",
    "cleanup",
    "capture",
  ]),
  code: v.picklist([
    "storage",
    "native_preflight",
    "native_start_refused",
    "native_start_unknown",
    "native_execution",
    "native_observation",
    "native_abort",
    "host_work_unknown",
    "native_stop",
    "history_capture",
    "credential_cleanup",
  ]),
});
const fields = {
  format: v.literal("native-session-attempt/1"),
  attemptId: v.pipe(v.string(), v.uuid()),
  type: v.picklist(["brief", "analysis", "guide", "walkthrough"]),
  runId: explanationFrameIdentity.runId,
  sessionId: v.pipe(
    v.string(),
    v.maxLength(1024),
    v.check((value) => parseReviewSessionId(value)._tag === "ok"),
  ),
  generation: explanationFrameIdentity.generation,
  cancelEpoch: explanationFrameIdentity.cancelEpoch,
  connection: explanationFrameIdentity.connection,
  requested: v.strictObject({
    provider: v.picklist(["pi-cli-account", "codex-cli-account"]),
    model: scalar,
    reasoning,
  }),
  observed: v.strictObject({
    version: v.exactOptional(scalar),
    nativeProvider: v.exactOptional(scalar),
    model: v.exactOptional(scalar),
    reasoning: v.exactOptional(reasoning),
    nativeSessionId: v.exactOptional(v.pipe(v.string(), v.uuid())),
  }),
  evidence: hash,
  nativeStart: v.exactOptional(insightArtifactReferenceSchema),
  capture,
  firstFailure: v.exactOptional(failure),
  cleanup,
};
/** Safe diagnostic fields contain no native bodies, paths, prompts or capabilities. */
export const nativeSessionAttemptDetailsSchema = v.strictObject(fields);
/** Private history filenames never cross the status boundary. */
export const nativeSessionAttemptSchema = v.strictObject({
  ...fields,
  historyFile: v.exactOptional(
    v.pipe(scalar, v.regex(/^[A-Za-z0-9_.-]+\.jsonl$/u)),
  ),
  locator: v.exactOptional(
    v.strictObject({
      directory: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
      device: number,
      inode: number,
    }),
  ),
});
export type NativeSessionAttempt = v.InferOutput<
  typeof nativeSessionAttemptSchema
>;
export const nativeSessionAttemptPageSchema = v.strictObject({
  attempts: v.pipe(v.array(nativeSessionAttemptDetailsSchema), v.maxLength(2)),
  nextCursor: v.nullable(v.pipe(v.string(), v.uuid())),
});
export type NativeSessionAttemptPage = v.InferOutput<
  typeof nativeSessionAttemptPageSchema
>;
