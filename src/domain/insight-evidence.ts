import type {
  ContentHash,
  GitSha,
  InsightRunId,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "./ids";
import type { InsightType } from "./insight-record";

/** Exact captured Review and run ownership. */
export type InsightEvidenceIdentity = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly runId: InsightRunId;
  readonly type: InsightType;
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly patchHash: ContentHash;
  readonly intentHash: string | null;
};
/** Fixed local diagnostics never contain evidence paths or content. */
export type InsightEvidenceFailureDetail =
  | "manifest_unavailable"
  | "manifest_invalid"
  | "file_missing"
  | "file_unreadable"
  | "size_hash_mismatch"
  | "unexpected_entry"
  | "identity_mismatch"
  | "tree_invalid"
  | "cancelled";

/** Expected failure codes contain no evidence excerpts or sensitive paths. */
export type InsightEvidenceFailure = {
  readonly _tag: "InsightEvidenceFailure";
  readonly detail?: InsightEvidenceFailureDetail;
  readonly reason:
    | "evidence_unavailable"
    | "evidence_mismatch"
    | "invalid_input";
};
/** Parent-held source bytes and digests remain authoritative after publication. */
export type EvidenceSource = {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly sha256: string;
};
/** This descriptor is retained in the parent, not reconstructed from the writable manifest. */
export type InsightEvidenceBundle = {
  readonly identity: InsightEvidenceIdentity;
  readonly bundleId: string;
  readonly directory: string;
  readonly sources: ReadonlyArray<EvidenceSource>;
  readonly manifestText: string;
  readonly tree: InsightEvidenceTree;
};
/** The host retains this index separately from the model-readable manifest. */
type InsightEvidenceTree = {
  readonly format: "insight-evidence-tree/1";
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly diffs: ReadonlyArray<string>;
  readonly snapshots: ReadonlyArray<{
    readonly path: string;
    readonly name: string;
  }>;
};
