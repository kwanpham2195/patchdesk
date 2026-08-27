import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { isNotFound, writeAtomicFile } from "../adapters/storage/json-file";
import { KeyedMutex } from "../domain/keyed-mutex";
import { err, ok, type Result } from "../domain/result";
import {
  parseWorkspaceProfileId,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
  REVIEW_DIAGNOSTIC_MAX_EVENTS,
  REVIEW_DIAGNOSTIC_MAX_FILE_BYTES,
  normalizeReviewDiagnostic,
  sanitizeReviewDiagnosticEvent,
  parseReviewDiagnosticMetadata,
  redactDiagnosticDetail,
  type ReviewDiagnosticEvent,
  type ReviewDiagnosticInput,
  type ReviewDiagnosticMetadata,
  type ReviewSupportBundle,
} from "../domain/review-diagnostic";

export type ReviewDiagnosticFailure = {
  readonly _tag: "ReviewDiagnosticStorageFailed";
};

/** Mutable draft of `ReviewSupportBundle`, built in statements so the
 * optional `sessionId`/`metadata` fields are added only when present. */
type MutableReviewSupportBundle = {
  -readonly [K in keyof ReviewSupportBundle]: ReviewSupportBundle[K];
};

export type ReviewDiagnosticServiceOptions = {
  readonly maxEvents?: number;
  readonly maxDetailLength?: number;
  /** Best-effort projection of each recorded event into the unified log stream. */
  readonly mirror?: (event: ReviewDiagnosticEvent) => void;
};

/** Process-wide, so two service instances still serialize one profile. */
const processProfileLocks = new KeyedMutex();

export type SupportBundleInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId?: string;
  readonly metadata?: ReviewDiagnosticMetadata;
};

/**
 * Persists bounded, redacted diagnostic evidence and produces safe support
 * bundles. Technical event fields never become renderer projections.
 */
export class ReviewDiagnosticService {
  private readonly maxEvents: number;
  private readonly maxDetailLength: number;
  private readonly mirror: ((event: ReviewDiagnosticEvent) => void) | undefined;
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly now: () => string,
    private readonly createIncidentId: () => string = randomUUID,
    options: ReviewDiagnosticServiceOptions = {},
  ) {
    this.maxEvents = Math.min(
      REVIEW_DIAGNOSTIC_MAX_EVENTS,
      Math.max(1, options.maxEvents ?? REVIEW_DIAGNOSTIC_MAX_EVENTS),
    );
    this.maxDetailLength = Math.min(
      REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
      Math.max(
        1,
        options.maxDetailLength ?? REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
      ),
    );
    this.mirror = options.mirror;
  }

  /** Record one redacted event and return its incident identifier. */
  async record(
    input: Omit<ReviewDiagnosticInput, "incidentId" | "at"> & {
      readonly incidentId?: string;
      readonly at?: string;
    },
  ): Promise<Result<ReviewDiagnosticEvent, ReviewDiagnosticFailure>> {
    const normalized = normalizeReviewDiagnostic(
      {
        ...input,
        incidentId: input.incidentId ?? this.createIncidentId(),
        at: input.at ?? this.now(),
      },
      this.maxDetailLength,
    );
    const profileId = parseWorkspaceProfileId(input.profileId);
    if (profileId._tag === "err")
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    const event = sanitizeReviewDiagnosticEvent(
      normalized,
      profileId.value,
      this.maxDetailLength,
    );
    if (event === undefined)
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    const persisted = await this.withProfileLock(profileId.value, () =>
      this.persist(event),
    );
    if (persisted._tag === "ok") this.mirror?.(persisted.value);
    return persisted;
  }

  /** Read the most recent valid events for one profile. */
  async recent(
    profileId: WorkspaceProfileId,
  ): Promise<
    Result<ReadonlyArray<ReviewDiagnosticEvent>, ReviewDiagnosticFailure>
  > {
    return this.withProfileLock(profileId, async () => {
      const loaded = await this.loadEvents(profileId);
      return loaded._tag === "err"
        ? loaded
        : ok(loaded.value.slice(-this.maxEvents));
    });
  }

  /** Build a bounded support bundle containing only sanitized local evidence. */
  async exportSupportBundle(
    input: SupportBundleInput,
  ): Promise<Result<ReviewSupportBundle, ReviewDiagnosticFailure>> {
    return this.withProfileLock(input.profileId, async () => {
      const events = await this.loadEvents(input.profileId);
      if (events._tag === "err") return events;
      const metadata =
        input.metadata === undefined
          ? undefined
          : (() => {
              const title =
                input.metadata?.title === undefined
                  ? undefined
                  : redactDiagnosticDetail(
                      input.metadata.title,
                      this.maxDetailLength,
                    );
              return title === undefined
                ? undefined
                : parseReviewDiagnosticMetadata({ title });
            })();
      const bundle: MutableReviewSupportBundle = {
        schemaVersion: 1,
        generatedAt: this.now(),
        profileId: input.profileId,
        events: events.value.slice(-this.maxEvents),
      };
      if (input.sessionId !== undefined) bundle.sessionId = input.sessionId;
      if (metadata !== undefined) bundle.metadata = metadata;
      return ok(bundle);
    });
  }

  private async persist(
    event: ReviewDiagnosticEvent,
  ): Promise<Result<ReviewDiagnosticEvent, ReviewDiagnosticFailure>> {
    const profileId = parseWorkspaceProfileId(event.profileId);
    if (profileId._tag === "err")
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    const loaded = await this.loadEvents(profileId.value);
    if (loaded._tag === "err") return loaded;
    const events = [...loaded.value, event].slice(-this.maxEvents);
    const path = diagnosticFile(this.paths, profileId.value);
    const written = await writeAtomicFile(
      path,
      `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    return written._tag === "ok"
      ? ok(event)
      : err({ _tag: "ReviewDiagnosticStorageFailed" });
  }

  private async loadEvents(
    profileId: WorkspaceProfileId,
  ): Promise<
    Result<ReadonlyArray<ReviewDiagnosticEvent>, ReviewDiagnosticFailure>
  > {
    let contents: string;
    try {
      contents = await readBoundedText(diagnosticFile(this.paths, profileId));
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    }
    const events: Array<ReviewDiagnosticEvent> = [];
    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = sanitizeReviewDiagnosticEvent(
          JSON.parse(line),
          profileId,
          this.maxDetailLength,
        );
        if (parsed !== undefined) events.push(parsed);
      } catch {
        // Preserve valid evidence around one malformed line.
      }
    }
    return ok(events.slice(-this.maxEvents));
  }

  private async withProfileLock<T>(
    profileId: WorkspaceProfileId,
    operation: () => Promise<Result<T, ReviewDiagnosticFailure>>,
  ): Promise<Result<T, ReviewDiagnosticFailure>> {
    return processProfileLocks.run(profileId, operation);
  }
}

async function readBoundedText(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    const start = Math.max(0, details.size - REVIEW_DIAGNOSTIC_MAX_FILE_BYTES);
    const length = Math.min(details.size, REVIEW_DIAGNOSTIC_MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, start);
    const contents = buffer.subarray(0, read.bytesRead).toString("utf8");
    if (start === 0) return contents;
    const firstLine = contents.indexOf("\n");
    return firstLine === -1 ? "" : contents.slice(firstLine + 1);
  } finally {
    await handle.close();
  }
}

function diagnosticFile(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
): string {
  return join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl");
}
