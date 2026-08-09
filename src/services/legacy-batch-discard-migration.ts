import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "../adapters/storage/json-file";
import {
  isDiscardableLegacyBatchState,
} from "../domain/review-batch";
import type { ReviewSession } from "../domain/review-session";
import type { ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

export type BatchDiscardMigrationResult = {
  /** Sessions whose local batch evidence was removed. */
  readonly discarded: number;
  /** Sessions left untouched (no eligible evidence, non-covered state, or unreadable entry). */
  readonly skipped: number;
};

type BatchDiscardMarker = {
  readonly schemaVersion: 1;
  readonly profileId: WorkspaceProfileId;
  readonly completedAt: string;
};

export type BatchDiscardMigrationOptions = {
  /** The marker is optional for in-memory callers; production always supplies paths. */
  readonly paths?: PatchdeskPaths;
  readonly now?: () => string;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
  /** Test hook used to model a process interruption between durable stages. */
  readonly afterDiscard?: (sessionId: ReviewSessionId) => Promise<void>;
};

/**
 * One-time product-approved discard of legacy local batch evidence.
 *
 * Approved treatment (2026-08-09): persisted `batchContent` records in the
 * Local, PendingReview, Applying, and PartialFailure states are removed from
 * stored sessions. The migration performs no GitHub read or write, never
 * retries a remote operation, and never records a claim about remote state:
 * removing local evidence is not proof that a GitHub pending review is
 * absent. Submitted and Completed records and sessions without batch evidence
 * are left untouched; unreadable entries remain for the recovery/quarantine
 * owner.
 *
 * The per-profile marker is written only after every eligible session has been
 * stripped, so an interruption between saves leaves the remaining sessions for
 * the next run and can never strip the same session twice.
 */
export class LegacyBatchDiscardMigration {
  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "scanSessionEntries" | "save">,
    private readonly options: BatchDiscardMigrationOptions = {},
  ) {}

  async migrateProfile(
    profileId: WorkspaceProfileId,
  ): Promise<Result<BatchDiscardMigrationResult, StorageFailure>> {
    const marker = await this.readMarker(profileId);
    if (marker._tag === "err") return marker;
    if (marker.value !== undefined) return ok({ discarded: 0, skipped: 0 });

    const scanned = await this.sessions.scanSessionEntries(profileId);
    if (scanned._tag === "err") return scanned;

    let discarded = 0;
    let skipped = scanned.value.invalidEntries.length;
    for (const session of scanned.value.sessions) {
      if (
        session.batchContent === undefined ||
        !isDiscardableLegacyBatchState(session.batchContent.state)
      ) {
        skipped += 1;
        continue;
      }
      const saved = await this.sessions.save(withoutBatchEvidence(session));
      if (saved._tag === "err") return saved;
      discarded += 1;
      await this.options.diagnostics?.record({
        profileId,
        sessionId: session.id,
        category: "migration",
        phase: "batch-content-discard",
        retryable: false,
        detail: "Legacy local batch evidence was removed by the approved discard treatment.",
      });
      if (this.options.afterDiscard !== undefined) {
        await this.options.afterDiscard(session.id);
      }
    }

    const written = await this.writeMarker(profileId);
    if (written._tag === "err") return written;
    return ok({ discarded, skipped });
  }

  private async readMarker(
    profileId: WorkspaceProfileId,
  ): Promise<Result<BatchDiscardMarker | undefined, StorageFailure>> {
    if (this.options.paths === undefined) return ok(undefined);
    const stored = await readJsonFile(
      this.options.paths.batchDiscardMarkerFile(profileId),
    );
    if (stored._tag === "err") {
      return stored.error.reason === "not_found" ? ok(undefined) : stored;
    }
    return isBatchDiscardMarker(stored.value, profileId)
      ? ok(stored.value)
      : err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "invalid_stored_value",
        });
  }

  private async writeMarker(
    profileId: WorkspaceProfileId,
  ): Promise<Result<void, StorageFailure>> {
    if (this.options.paths === undefined) return ok(undefined);
    const marker: BatchDiscardMarker = {
      schemaVersion: 1,
      profileId,
      completedAt: this.options.now?.() ?? new Date().toISOString(),
    };
    return writeAtomicJson(
      this.options.paths.batchDiscardMarkerFile(profileId),
      marker,
    );
  }
}

function withoutBatchEvidence(session: ReviewSession): ReviewSession {
  const { batch: discardedBatch, batchContent: discardedBatchContent, ...sessionWithoutBatch } = session;
  void discardedBatch;
  void discardedBatchContent;
  return sessionWithoutBatch;
}

function isBatchDiscardMarker(
  value: unknown,
  profileId: WorkspaceProfileId,
): value is BatchDiscardMarker {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    schemaVersion?: unknown;
    profileId?: unknown;
    completedAt?: unknown;
  };
  return (
    candidate.schemaVersion === 1 &&
    candidate.profileId === profileId &&
    typeof candidate.completedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.completedAt))
  );
}
