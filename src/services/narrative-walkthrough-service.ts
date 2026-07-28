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
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    const generating = projection("generating");
    this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: generating });

    let invoked: Result<unknown, { readonly reason: string }>;
    try {
      invoked = await this.invoker.invoke({
        profileId: parsed.value.profileId,
        sessionId: parsed.value.sessionId,
        contextPath: this.paths.preparedContextFile(parsed.value.profileId, parsed.value.sessionId),
        patchPath: loaded.value.session.patchPath,
        model: parsed.value.model,
        reasoning: parsed.value.reasoning,
      });
    } catch {
      invoked = err({ reason: "execution_failed" });
    }

    const currentHash = await contentHash(loaded.value.session.patchPath);
    const latestSession = await this.sessions.load(parsed.value.profileId, parsed.value.sessionId);
    const snapshotStillCurrent = latestSession._tag === "ok" &&
      latestSession.value.id === parsed.value.sessionId &&
      latestSession.value.state._tag === "ReviewCompleted" &&
      latestSession.value.key.headSha === loaded.value.snapshot.headSha;
    const current = this.records.get(key);
    if (current === undefined || current.token !== token || current.snapshot.patchHash !== currentHash || !snapshotStillCurrent) {
      if (current?.token === token) this.records.set(key, { token, snapshot: current.snapshot, projection: projection("stale") });
      return ok(projection("stale"));
    }
    if (invoked._tag === "err") {
      const incidentId = await this.recordFailure(parsed.value, invoked.error.reason);
      const failed = projection("failed", incidentId);
      this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: failed });
      return ok(failed);
    }

    const patch = await readFile(loaded.value.session.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) {
      const incidentId = await this.recordFailure(parsed.value, "patch_unavailable");
      const failed = projection("failed", incidentId);
      this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: failed });
      return ok(failed);
    }
    const normalized = normalizeNarrativeWalkthrough(
      invoked.value,
      patch,
      loaded.value.snapshot,
    );
    if (normalized._tag === "err") {
      const incidentId = await this.recordFailure(parsed.value, "invalid_output");
      const failed = projection("failed", incidentId);
      this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: failed });
      return ok(failed);
    }
    const ready: NarrativeWalkthroughProjection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: normalized.value,
    };
    this.records.set(key, { token, snapshot: loaded.value.snapshot, projection: ready });
    return ok(ready);
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
      return err({ reason: "stale_snapshot" });
    }
    return ok(record.projection);
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
    const recorded = await this.diagnostics.record({ profileId: input.profileId, category: "walkthrough", phase: "walkthrough-generation", retryable: true, detail: `Walkthrough generation failed: ${detail}` });
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
