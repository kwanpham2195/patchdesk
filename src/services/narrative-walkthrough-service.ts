import { readFile } from "node:fs/promises";
import * as v from "valibot";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseContentHash, parseReviewSessionId, parseWorkspaceProfileId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { normalizeNarrativeWalkthrough, type NarrativeSnapshot, type NarrativeWalkthrough } from "../domain/narrative-walkthrough";
import { err, ok, type Result } from "../domain/result";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import { contentHash } from "./review-artifact-hash";
import type { WalkthroughInput } from "../workflows/generate-walkthrough";

export type NarrativeWalkthroughLifecycle = "idle" | "generating" | "ready" | "failed" | "stale";
export type NarrativeWalkthroughProjection = {
  readonly lifecycle: NarrativeWalkthroughLifecycle;
  readonly noticeKey: "walkthrough-idle" | "walkthrough-generating" | "walkthrough-ready" | "walkthrough-failed" | "walkthrough-stale";
  readonly actionKey?: "walkthrough-retry" | "walkthrough-regenerate";
  readonly incidentId?: string;
  readonly walkthrough?: NarrativeWalkthrough;
};

export type NarrativeWalkthroughFailure = {
  readonly reason: "invalid_input" | "profile_not_found" | "session_not_found" | "not_completed" | "stale_snapshot" | "workflow_unavailable" | "storage_unavailable";
};

export type NarrativeWalkthroughInvoker = {
  invoke(input: WalkthroughInput, options?: { readonly signal?: AbortSignal }): Promise<Result<unknown, { readonly reason: string }>>;
};

type ServiceInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly model?: string;
  readonly reasoning?: "low" | "medium" | "high";
};

type Record = {
  readonly token: number;
  readonly snapshot: NarrativeSnapshot;
  readonly projection: NarrativeWalkthroughProjection;
};

type CommitKind = "stale" | "failed" | "ready" | "stale_publish" | "stale_failed";

type Commit = {
  readonly token: number;
  readonly snapshot: NarrativeSnapshot;
  readonly kind: CommitKind;
  readonly incidentId?: string;
  readonly walkthrough?: NarrativeWalkthrough;
  readonly recordFailureInput?: ServiceInput;
  readonly recordFailureDetail?: string;
};

const identitySchema = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
const inputSchema = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.picklist(["low", "medium", "high"]),
});

export class NarrativeWalkthroughService {
  private readonly records = new Map<string, Record>();
  private readonly tokens = new Map<string, number>();
  // Per-key critical section: the publication guard re-checks the token plus
  // the snapshot identity after every await that crosses a yield boundary so
  // a superseded result cannot overwrite a newer record. The previous promise
  // is awaited before this one runs, so concurrent generation calls for the
  // same profile/session are serialized.
  private readonly commitLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly profiles: Pick<ProfileStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly paths: PatchdeskPaths,
    private readonly invoker: NarrativeWalkthroughInvoker | undefined,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ) {}

  async generate(input: unknown): Promise<Result<NarrativeWalkthroughProjection, NarrativeWalkthroughFailure>> {
    const parsed = this.parseInput(input);
    if (parsed._tag === "err") return parsed;
    const loaded = await this.loadSnapshot(parsed.value);
    if (loaded._tag === "err") return loaded;
    if (this.invoker === undefined) return err({ reason: "workflow_unavailable" });
    if (parsed.value.model === undefined || parsed.value.reasoning === undefined) return err({ reason: "invalid_input" });

    const key = recordKey(parsed.value.profileId, parsed.value.sessionId);
    // The token bump and the generating record are mutations, but they do not
    // need to be serialized against other in-flight invocations: each call
    // already takes a unique token, and the only consumer of `records` is the
    // final `commit()` decision, which is serialized separately below.
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: projection("generating") });

    const decision = await this.runGeneration(parsed.value, loaded.value, token);

    // The commit section is the only mutation of `this.records` that can
    // overwrite an existing projection. It re-checks the token and snapshot
    // identity under the commit lock so a superseded result cannot overwrite
    // a newer one.
    return this.withCommitLock(key, () => this.commit(key, decision.commit));
  }

  private async withCommitLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previousLock = this.commitLocks.get(key);
    let release!: () => void;
    const currentLock = new Promise<void>((resolve) => { release = resolve; });
    this.commitLocks.set(key, currentLock);
    try {
      if (previousLock !== undefined) await previousLock;
      return await operation();
    } finally {
      release();
      if (this.commitLocks.get(key) === currentLock) this.commitLocks.delete(key);
    }
  }

  private async runGeneration(
    input: ServiceInput,
    loaded: { readonly session: ReviewSession; readonly snapshot: NarrativeSnapshot },
    token: number,
  ): Promise<{ readonly commit: Commit }> {
    if (this.invoker === undefined) return { commit: { token, snapshot: loaded.snapshot, kind: "stale_publish" } };
    let invoked: Result<unknown, { readonly reason: string }>;
    try {
      invoked = await this.invoker.invoke({
        profileId: input.profileId,
        sessionId: input.sessionId,
        contextPath: this.paths.preparedContextFile(input.profileId, input.sessionId),
        patchPath: loaded.session.patchPath,
        model: input.model ?? "",
        reasoning: input.reasoning ?? "medium",
      });
    } catch {
      invoked = err({ reason: "execution_failed" });
    }

    const currentHash = await contentHash(loaded.session.patchPath);
    const latestSession = await this.sessions.load(input.profileId, input.sessionId);
    const snapshotStillCurrent = latestSession._tag === "ok" &&
      latestSession.value.id === input.sessionId &&
      latestSession.value.state._tag === "ReviewCompleted" &&
      latestSession.value.key.headSha === loaded.snapshot.headSha;
    const key = recordKey(input.profileId, input.sessionId);
    if (!this.tokenStillCurrent(key, token, currentHash, loaded.snapshot.headSha) || !snapshotStillCurrent) {
      const parsed = parseContentHash(currentHash);
      if (parsed._tag === "err") return { commit: { token, snapshot: loaded.snapshot, kind: "stale_publish" } };
      return { commit: { token, snapshot: { ...loaded.snapshot, patchHash: parsed.value }, kind: "stale_publish" } };
    }

    if (invoked._tag === "err") {
      return { commit: { token, snapshot: loaded.snapshot, kind: "failed", recordFailureInput: input, recordFailureDetail: invoked.error.reason } };
    }

    const patch = await readFile(loaded.session.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) {
      return { commit: { token, snapshot: loaded.snapshot, kind: "failed", recordFailureInput: input, recordFailureDetail: "patch_unavailable" } };
    }
    const normalized = normalizeNarrativeWalkthrough(invoked.value, patch, loaded.snapshot);
    if (normalized._tag === "err") {
      return { commit: { token, snapshot: loaded.snapshot, kind: "failed", recordFailureInput: input, recordFailureDetail: "invalid_output" } };
    }
    const finalHash = await contentHash(loaded.session.patchPath);
    if (finalHash !== currentHash || !this.tokenStillCurrent(key, token, finalHash, loaded.snapshot.headSha)) {
      const parsed = parseContentHash(finalHash);
      if (parsed._tag === "err") return { commit: { token, snapshot: loaded.snapshot, kind: "stale_publish" } };
      return { commit: { token, snapshot: { ...loaded.snapshot, patchHash: parsed.value }, kind: "stale_publish" } };
    }
    return { commit: { token, snapshot: loaded.snapshot, kind: "ready", walkthrough: normalized.value } };
  }

  async load(input: unknown): Promise<Result<NarrativeWalkthroughProjection, NarrativeWalkthroughFailure>> {
    const parsed = this.parseIdentity(input);
    if (parsed._tag === "err") return parsed;
    const loaded = await this.loadSnapshot(parsed.value);
    if (loaded._tag === "err") return loaded;
    const key = recordKey(parsed.value.profileId, parsed.value.sessionId);
    const record = this.records.get(key);
    if (record === undefined) return ok(projection("idle"));
    const currentHash = await contentHash(loaded.value.session.patchPath);
    if (record.snapshot.headSha !== loaded.value.snapshot.headSha || record.snapshot.patchHash !== currentHash) {
      // Stale snapshots are projected as a renderer-safe regenerate action
      // rather than returned as a raw error so the Design regenerate path
      // stays available without exposing an internal failure envelope.
      return ok(projection("stale"));
    }
    return ok(record.projection);
  }

  private tokenStillCurrent(key: string, token: number, currentHash: string, currentHeadSha: string): boolean {
    const live = this.records.get(key);
    if (live === undefined) return false;
    if (live.token !== token) return false;
    if (live.snapshot.patchHash !== currentHash) return false;
    if (live.snapshot.headSha !== currentHeadSha) return false;
    return true;
  }

  private async commit(key: string, change: Commit): Promise<Result<NarrativeWalkthroughProjection, NarrativeWalkthroughFailure>> {
    const live = this.records.get(key);
    if (live !== undefined && live.token > change.token) {
      // A newer generation already committed. The late caller is informed via
      // the renderer-safe stale projection so the Design regenerate path stays
      // available; the live ready/failed record remains the source of truth.
      return ok(projection("stale"));
    }
    if (change.kind === "ready" && change.walkthrough !== undefined) {
      const readyProjection: NarrativeWalkthroughProjection = {
        lifecycle: "ready",
        noticeKey: "walkthrough-ready",
        walkthrough: change.walkthrough,
      };
      this.records.set(key, { token: change.token, snapshot: change.snapshot, projection: readyProjection });
      return ok(readyProjection);
    }
    if (change.kind === "failed") {
      let incidentId: string | undefined;
      if (change.recordFailureInput !== undefined && change.recordFailureDetail !== undefined) {
        const recorded = await this.recordFailure(change.recordFailureInput, change.recordFailureDetail);
        incidentId = recorded;
      }
      const failed: NarrativeWalkthroughProjection = {
        lifecycle: "failed",
        noticeKey: "walkthrough-failed",
        actionKey: "walkthrough-retry",
        ...(incidentId === undefined ? {} : { incidentId }),
      };
      this.records.set(key, { token: change.token, snapshot: change.snapshot, projection: failed });
      return ok(failed);
    }
    const stale: NarrativeWalkthroughProjection = {
      lifecycle: "stale",
      noticeKey: "walkthrough-stale",
      actionKey: "walkthrough-regenerate",
    };
    this.records.set(key, { token: change.token, snapshot: change.snapshot, projection: stale });
    return ok(stale);
  }

  private parseIdentity(input: unknown): Result<ServiceInput, NarrativeWalkthroughFailure> {
    const parsed = v.safeParse(identitySchema, input);
    if (!parsed.success) return err({ reason: "invalid_input" });
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const sessionId = parseReviewSessionId(parsed.output.sessionId);
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    return ok({ profileId: profileId.value, sessionId: sessionId.value });
  }

  private parseInput(input: unknown): Result<ServiceInput, NarrativeWalkthroughFailure> {
    const parsed = v.safeParse(inputSchema, input);
    if (!parsed.success) return err({ reason: "invalid_input" });
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const sessionId = parseReviewSessionId(parsed.output.sessionId);
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    return ok({ profileId: profileId.value, sessionId: sessionId.value, model: parsed.output.model, reasoning: parsed.output.reasoning });
  }

  private async loadSnapshot(input: ServiceInput): Promise<Result<{ readonly session: ReviewSession; readonly snapshot: NarrativeSnapshot }, NarrativeWalkthroughFailure>> {
    const profile = await this.profiles.load(input.profileId);
    if (profile._tag === "err") return err({ reason: profile.error.reason === "not_found" ? "profile_not_found" : "storage_unavailable" });
    const session = await this.sessions.load(input.profileId, input.sessionId);
    if (session._tag === "err") return err({ reason: session.error.reason === "not_found" ? "session_not_found" : "storage_unavailable" });
    if (session.value.id !== input.sessionId || session.value.key.profileId !== input.profileId) return err({ reason: "session_not_found" });
    if (session.value.state._tag !== "ReviewCompleted") return err({ reason: "not_completed" });
    const patchHash = await contentHash(session.value.patchPath);
    if (patchHash.length === 0) return err({ reason: "stale_snapshot" });
    const parsedPatchHash = parseContentHash(patchHash);
    if (parsedPatchHash._tag === "err") return err({ reason: "stale_snapshot" });
    return ok({
      session: session.value,
      snapshot: { profileId: input.profileId, sessionId: input.sessionId, headSha: session.value.key.headSha, patchHash: parsedPatchHash.value },
    });
  }

  private async recordFailure(input: ServiceInput, detail: string): Promise<string | undefined> {
    if (this.diagnostics === undefined) return undefined;
    const recorded = await this.diagnostics.record({
      profileId: input.profileId,
      sessionId: input.sessionId,
      category: "walkthrough",
      phase: "walkthrough-generation",
      retryable: true,
      detail: `Walkthrough generation failed: ${detail}`,
    });
    return recorded._tag === "ok" ? recorded.value.incidentId : undefined;
  }
}

function recordKey(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): string {
  return `${profileId}:${sessionId}`;
}

function projection(lifecycle: NarrativeWalkthroughLifecycle, incidentId?: string): NarrativeWalkthroughProjection {
  const base = {
    lifecycle,
    noticeKey: `walkthrough-${lifecycle}` as NarrativeWalkthroughProjection["noticeKey"],
    ...(lifecycle === "failed" ? { actionKey: "walkthrough-retry" as const } : lifecycle === "stale" ? { actionKey: "walkthrough-regenerate" as const } : {}),
    ...(incidentId === undefined ? {} : { incidentId }),
  };
  return base;
}
