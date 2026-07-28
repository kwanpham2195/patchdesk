import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { err, ok, type Result } from "../domain/result";
import { parseWorkspaceProfileId, type WorkspaceProfileId } from "../domain/ids";
import {
  REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
  REVIEW_DIAGNOSTIC_MAX_EVENTS,
  REVIEW_DIAGNOSTIC_MAX_FILE_BYTES,
  normalizeReviewDiagnostic,
  parseReviewDiagnosticEvent,
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

export type ReviewDiagnosticServiceOptions = {
  readonly maxEvents?: number;
  readonly maxDetailLength?: number;
};

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
  private readonly profileLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly now: () => string,
    private readonly createIncidentId: () => string = randomUUID,
    options: ReviewDiagnosticServiceOptions = {},
  ) {
    this.maxEvents = Math.min(REVIEW_DIAGNOSTIC_MAX_EVENTS, Math.max(1, options.maxEvents ?? REVIEW_DIAGNOSTIC_MAX_EVENTS));
    this.maxDetailLength = Math.min(
      REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
      Math.max(1, options.maxDetailLength ?? REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH),
    );
  }

  /** Record one redacted event and return its incident identifier. */
  async record(
    input: Omit<ReviewDiagnosticInput, "incidentId" | "at"> & { readonly incidentId?: string; readonly at?: string },
  ): Promise<Result<ReviewDiagnosticEvent, ReviewDiagnosticFailure>> {
    const normalized = normalizeReviewDiagnostic(
      {
        ...input,
        incidentId: input.incidentId ?? this.createIncidentId(),
        at: input.at ?? this.now(),
      },
      this.maxDetailLength,
    );
    const event = parseReviewDiagnosticEvent(normalized);
    if (event === undefined) return err({ _tag: "ReviewDiagnosticStorageFailed" });
    const profileId = parseWorkspaceProfileId(event.profileId);
    if (profileId._tag === "err") return err({ _tag: "ReviewDiagnosticStorageFailed" });
    return this.withProfileLock(profileId.value, () => this.persist(event));
  }

  /** Read the most recent valid events for one profile. */
  async recent(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<ReviewDiagnosticEvent>, ReviewDiagnosticFailure>> {
    return this.withProfileLock(profileId, async () => {
      const loaded = await this.loadEvents(profileId);
      return loaded._tag === "err" ? loaded : ok(loaded.value.slice(-this.maxEvents));
    });
  }

  /** Build a bounded support bundle containing only sanitized local evidence. */
  async exportSupportBundle(
    input: SupportBundleInput,
  ): Promise<Result<ReviewSupportBundle, ReviewDiagnosticFailure>> {
    return this.withProfileLock(input.profileId, async () => {
      const events = await this.loadEvents(input.profileId);
      if (events._tag === "err") return events;
      const metadata = input.metadata === undefined
        ? undefined
        : parseReviewDiagnosticMetadata({
            ...(input.metadata.title === undefined ? {} : { title: redactDiagnosticDetail(input.metadata.title, this.maxDetailLength) }),
          });
      return ok({
        schemaVersion: 1,
        generatedAt: this.now(),
        profileId: input.profileId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(metadata === undefined ? {} : { metadata }),
        events: events.value.slice(-this.maxEvents),
      });
    });
  }

  private async persist(event: ReviewDiagnosticEvent): Promise<Result<ReviewDiagnosticEvent, ReviewDiagnosticFailure>> {
    const profileId = parseWorkspaceProfileId(event.profileId);
    if (profileId._tag === "err") return err({ _tag: "ReviewDiagnosticStorageFailed" });
    const loaded = await this.loadEvents(profileId.value);
    if (loaded._tag === "err") return loaded;
    const events = [...loaded.value, event].slice(-this.maxEvents);
    try {
      const path = diagnosticFile(this.paths, profileId.value);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      await writeFile(
        temporaryPath,
        `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, path);
      return ok(event);
    } catch {
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    }
  }

  private async loadEvents(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<ReviewDiagnosticEvent>, ReviewDiagnosticFailure>> {
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
        const parsed = parseReviewDiagnosticEvent(JSON.parse(line));
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
    const previous = this.profileLocks.get(profileId);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.profileLocks.set(profileId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.profileLocks.get(profileId) === current) this.profileLocks.delete(profileId);
    }
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

function diagnosticFile(paths: PatchdeskPaths, profileId: WorkspaceProfileId): string {
  return join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl");
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
