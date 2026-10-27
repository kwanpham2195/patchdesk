import * as v from "valibot";

import type {
  ContentHash,
  GitSha,
  InsightRunId,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "./ids";
import type { InsightType } from "./insight-record";

/** Bounds apply to final NDJSON encoding, including metadata and links. */
export const EVIDENCE_PAGE_BYTES = 32_768;
/** Physical NDJSON lines, not source citation lines. */
export const EVIDENCE_PAGE_LINES = 256;
/** Final serialized record bytes, including its newline. */
export const EVIDENCE_RECORD_BYTES = 2_048;

const pageIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{64}-p[1-9]\d*$/),
  v.brand("EvidencePageId"),
);
/** A page identifier includes the bundle identity, so another run cannot reuse it. */
export type EvidencePageId = v.InferOutput<typeof pageIdSchema>;
/** Parse model-supplied page IDs without accepting filesystem paths. */
export function parseEvidencePageId(input: string): EvidencePageId | undefined {
  const parsed = v.safeParse(pageIdSchema, input);
  return parsed.success ? parsed.output : undefined;
}

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
/** Expected failure codes contain no evidence excerpts or sensitive paths. */
export type InsightEvidenceFailure = {
  readonly _tag: "InsightEvidenceFailure";
  readonly reason:
    | "evidence_unavailable"
    | "evidence_mismatch"
    | "invalid_input";
};
/** Coordinates belong to the original source, never the page's physical lines. */
export type EvidenceSite = {
  readonly fileId?: string;
  readonly hunkAlias?: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly sourceLine?: number;
};
/** Every text fragment retains byte offsets into its original captured artifact. */
export type EvidenceFragment = EvidenceSite & {
  readonly kind: "fragment";
  readonly sourceId: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly fragmentIndex: number;
  readonly continued: boolean;
  readonly text: string;
};
/** Compact traversal links never carry long filenames or source text. */
type EvidenceLink = {
  readonly kind: "link";
  readonly relation:
    | "inventory"
    | "citations"
    | "context"
    | "identity"
    | "diff"
    | "snapshot";
  readonly pageId: EvidencePageId;
  readonly fileId?: string;
};
/** Evidence records are fragmented before pagination. */
export type EvidenceRecord = EvidenceFragment | EvidenceLink;
/** Parent-held source bytes and digests remain authoritative after publication. */
export type EvidenceSource = {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly sha256: string;
};
/** Parent-held page bytes and records support integrity checks and bounded search. */
type EvidencePage = {
  readonly id: EvidencePageId;
  readonly text: string;
  readonly sha256: string;
  readonly records: ReadonlyArray<EvidenceRecord>;
};
/** This descriptor is retained in the parent, not reconstructed from the writable manifest. */
type InsightEvidenceBundleBase = {
  readonly identity: InsightEvidenceIdentity;
  readonly bundleId: string;
  readonly directory: string;
  readonly pages: ReadonlyArray<EvidencePage>;
  readonly sources: ReadonlyArray<EvidenceSource>;
  readonly manifestText: string;
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
/** Pages remain only for Insights that have not moved to the tree format. */
export type InsightEvidenceBundle = InsightEvidenceBundleBase &
  (
    | {
        readonly tree: InsightEvidenceTree;
        readonly entryPageId?: never;
        readonly patchPath?: never;
      }
    | {
        readonly tree?: never;
        readonly entryPageId: EvidencePageId;
        readonly patchPath: string;
      }
  );
/** Search results refer to captured offsets and the page carrying the match start. */
export type EvidenceSearchMatch = EvidenceSite & {
  readonly sourceId: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly pageId: EvidencePageId;
};
/** Search never returns unbounded source excerpts. */
export type EvidenceSearchResult = {
  readonly matches: ReadonlyArray<EvidenceSearchMatch>;
  readonly cursor: string | null;
};
