import * as v from "valibot";

import { rawJsonValueSchema, type RawJsonValue } from "../../domain/json";
import type { LogEntryInput } from "../../domain/log-entry";
import type { Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { normalizeCommandLabel, type CommandFailure } from "./command-runner";
import type { GitHubCredentials } from "./github-credentials";
import {
  ghInvocationFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "./github-request";

/**
 * Runs the HTTP transport beside `gh` for reads and records where the two
 * answers disagree, before any call site moves off `gh` (ADR 0046, issue
 * #292).
 *
 * gh's answer is always the one served. The shadow call starts concurrently,
 * is never awaited on the serving path, and every failure of it is swallowed
 * here, so switching the shadow on cannot change what a read returns, when it
 * returns, or how it fails.
 *
 * It doubles read traffic against the same rate limit and resolves the
 * profile credential itself, so a cold credential cache costs one extra
 * `gh auth token` spawn per five-minute window. That is why it is off unless
 * `PATCHDESK_TRANSPORT_SHADOW=1` is set at launch.
 */

/** Which of the runner's two seams the answer came back through. */
type ShadowResponseBody = "json" | "text";

/** What the shadow call reported about one request, as one log entry. */
type ShadowOutcome = "match" | "diverged" | "skipped";

/** Why a read was not compared. Not a divergence. */
type ShadowSkipReason = "no_token";

/** How two answers to the same request disagreed. */
type ShadowDivergenceKind = "value" | "failure_tag" | "ok_vs_err";

/** Longest `firstDifference` string written to the log, so one deep path cannot fill a line. */
const maxFirstDifferenceLength = 120;

/**
 * Paths excluded from a GraphQL comparison because GitHub recomputes them per
 * request: the shadow and the gh call spend two budgets against one account,
 * so `rateLimit` cannot agree by design (observed on
 * `api graphql MaintainerInboxSearch` in the first shadow window).
 */
const volatileGraphQlPaths: ReadonlySet<string> = new Set(["$.data.rateLimit"]);

/** Every path is compared for a REST answer; only GraphQL carries a volatile one. */
const noVolatilePaths: ReadonlySet<string> = new Set();

/**
 * The HTTP transport the shadow compares against, narrowed to the two calls
 * it makes. `GitHubHttpClient` satisfies it; a test supplies its own.
 */
export interface GitHubShadowTransport {
  rest(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>>;
  /** The response bytes, for a read gh answered through `ghText` (see `send`). */
  restText(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>>;
  graphql(
    profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>>;
}

/** One request gh is already serving, handed to the shadow to compare against. */
export type ShadowObservation = {
  readonly profile: WorkspaceProfileConfig;
  readonly request: GitHubRequest;
  /** gh's answer, already in flight. The caller keeps ownership of it. */
  readonly served: Promise<Result<unknown, CommandFailure>>;
  readonly body: ShadowResponseBody;
};

type ShadowDivergence = {
  readonly kind: ShadowDivergenceKind;
  /** Where the two answers first differ: a JSON path, or `byte <offset>` for text. */
  readonly firstDifference?: string;
  readonly ghTag?: string;
  readonly shadowTag?: string;
};

type SettledCall = {
  readonly result: Result<unknown, CommandFailure>;
  readonly durationMs: number;
};

/**
 * Whether a request only reads, judged conservatively: a shadowed call is
 * made twice, so anything that might mutate is left alone. A REST request
 * carrying a body but no method is not a read — `gh api --input` defaults to
 * POST.
 */
export function isShadowableRead(request: GitHubRequest): boolean {
  if (request.kind === "rest") {
    return request.method === undefined && request.jsonBody === undefined;
  }
  return isQueryDocument(request.document);
}

/** GraphQL sends reads and writes to one endpoint; only the document says which. */
export function isQueryDocument(document: string): boolean {
  const body = document.replace(/^(?:\s|#[^\n]*)*/, "");
  return body.startsWith("{") || /^query\b/.test(body);
}

/** Compares the HTTP transport against gh for one read and logs what it found. */
export class TransportShadow {
  constructor(
    private readonly transport: GitHubShadowTransport,
    private readonly credentials: GitHubCredentials,
    private readonly log: (entry: LogEntryInput) => void,
  ) {}

  /**
   * Starts the shadow call beside a read gh is already serving, and returns
   * at once. The comparison is detached on purpose: it owns its own failures,
   * reports through the log, and never settles anything the caller awaits.
   */
  observe(observation: ShadowObservation): void {
    if (!isShadowableRead(observation.request)) return;
    void this.compare(observation).catch(() => undefined);
  }

  private async compare(observation: ShadowObservation): Promise<void> {
    const label = normalizeCommandLabel(
      ghInvocationFor(observation.request).argv,
    );
    const token = await this.credentials.tokenFor(observation.profile);
    if (token._tag === "err") {
      this.skip(label, "no_token");
      return;
    }

    const startedAt = Date.now();
    const shadowed = this.send(
      observation.profile,
      observation.request,
      observation.body,
    );
    const [gh, shadow] = await Promise.all([
      settledCall(observation.served, startedAt),
      settledCall(shadowed, startedAt),
    ]);

    const divergence = divergenceOf(
      gh.result,
      shadow.result,
      observation.body,
      observation.request.kind === "graphql"
        ? volatileGraphQlPaths
        : noVolatilePaths,
    );
    this.record({
      label,
      outcome: divergence === undefined ? "match" : "diverged",
      divergence,
      reason: undefined,
      ghMs: gh.durationMs,
      shadowMs: shadow.durationMs,
    });
  }

  /** A read the shadow left alone, recorded so the report can tell it from a clean one. */
  private skip(label: string, reason: ShadowSkipReason): void {
    this.record({
      label,
      outcome: "skipped",
      divergence: undefined,
      reason,
      ghMs: undefined,
      shadowMs: undefined,
    });
  }

  /**
   * The shadow call, made through the same seam gh's answer came back on: the
   * client parses a JSON read and hands over a text read's bytes, so asking
   * for the wrong one would report `CommandInvalidJson` against gh's success
   * and log a divergence that is the shadow's own.
   *
   * A GraphQL document observed as text stays on `graphql`. There is no such
   * caller, and if one appeared the comparison would fail on shape rather than
   * on bytes -- the same outcome `asText` produces for it on the served path.
   */
  private async send(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
    body: ShadowResponseBody,
  ): Promise<Result<unknown, CommandFailure>> {
    if (request.kind === "graphql")
      return this.transport.graphql(profile, request);
    return body === "text"
      ? this.transport.restText(profile, request)
      : this.transport.rest(profile, request);
  }

  /**
   * Writes the one entry per shadowed call. Every field is either a fixed
   * word, a normalized label, a duration, or a path of JSON keys, so no
   * response body, token, or header value can reach the log.
   */
  private record(entry: {
    readonly label: string;
    readonly outcome: ShadowOutcome;
    readonly divergence: ShadowDivergence | undefined;
    readonly reason: ShadowSkipReason | undefined;
    readonly ghMs: number | undefined;
    readonly shadowMs: number | undefined;
  }): void {
    this.log({
      process: "main",
      level: entry.outcome === "diverged" ? "warn" : "debug",
      topic: "transport-shadow",
      message: `${entry.outcome} ${entry.label}`,
      meta: {
        label: entry.label,
        outcome: entry.outcome,
        reason: entry.reason,
        kind: entry.divergence?.kind,
        firstDifference: entry.divergence?.firstDifference,
        ghTag: entry.divergence?.ghTag,
        shadowTag: entry.divergence?.shadowTag,
        ghMs: entry.ghMs,
        shadowMs: entry.shadowMs,
      },
    });
  }
}

/** Both durations are measured from the shadow's start, so they compare like for like. */
async function settledCall(
  call: Promise<Result<unknown, CommandFailure>>,
  startedAt: number,
): Promise<SettledCall> {
  const result = await call;
  return { result, durationMs: Date.now() - startedAt };
}

/**
 * How the two answers disagreed, or undefined when they agree. Two failures
 * match on their tag alone: the tag is what every caller branches on, and the
 * two transports reach it from different evidence (gh from its own stderr, the
 * client from the response status).
 */
function divergenceOf(
  gh: Result<unknown, CommandFailure>,
  shadow: Result<unknown, CommandFailure>,
  body: ShadowResponseBody,
  volatilePaths: ReadonlySet<string>,
): ShadowDivergence | undefined {
  if (gh._tag === "err" || shadow._tag === "err") {
    const ghTag = gh._tag === "err" ? gh.error._tag : "ok";
    const shadowTag = shadow._tag === "err" ? shadow.error._tag : "ok";
    if (gh._tag !== shadow._tag) return { kind: "ok_vs_err", ghTag, shadowTag };
    return ghTag === shadowTag
      ? undefined
      : { kind: "failure_tag", ghTag, shadowTag };
  }

  if (body === "text") {
    const ghText = v.safeParse(v.string(), gh.value);
    const shadowText = v.safeParse(v.string(), shadow.value);
    if (!ghText.success || !shadowText.success) {
      return { kind: "value", firstDifference: "$" };
    }
    const offset = firstDifferingByte(ghText.output, shadowText.output);
    return offset === undefined
      ? undefined
      : { kind: "value", firstDifference: `byte ${offset}` };
  }

  const ghJson = v.safeParse(rawJsonValueSchema, gh.value);
  const shadowJson = v.safeParse(rawJsonValueSchema, shadow.value);
  if (!ghJson.success || !shadowJson.success) {
    return { kind: "value", firstDifference: "$" };
  }
  const path = firstDifferingPath(
    ghJson.output,
    shadowJson.output,
    "$",
    volatilePaths,
  );
  return path === undefined
    ? undefined
    : {
        kind: "value",
        firstDifference: path.slice(0, maxFirstDifferenceLength),
      };
}

/** The offset of the first byte the two texts disagree on, counted over UTF-8. */
function firstDifferingByte(gh: string, shadow: string): number | undefined {
  const ghBytes = Buffer.from(gh, "utf8");
  const shadowBytes = Buffer.from(shadow, "utf8");
  const shared = Math.min(ghBytes.length, shadowBytes.length);
  for (let offset = 0; offset < shared; offset += 1) {
    if (ghBytes[offset] !== shadowBytes[offset]) return offset;
  }
  return ghBytes.length === shadowBytes.length ? undefined : shared;
}

/** Narrows a JSON object without re-deciding the grammar the parse above already settled. */
const jsonObjectSchema: v.GenericSchema<
  Readonly<Record<string, RawJsonValue>>
> = v.record(v.string(), rawJsonValueSchema);

/**
 * The path of the first value the two answers disagree on, in the order a
 * reader would walk them, or undefined when they are deeply equal.
 */
function firstDifferingPath(
  gh: RawJsonValue,
  shadow: RawJsonValue,
  path: string,
  volatilePaths: ReadonlySet<string>,
): string | undefined {
  if (Array.isArray(gh) || Array.isArray(shadow)) {
    if (!Array.isArray(gh) || !Array.isArray(shadow)) return path;
    if (gh.length !== shadow.length) return `${path}.length`;
    for (const [index, item] of gh.entries()) {
      const at = firstDifferingPath(
        item,
        shadow[index] ?? null,
        `${path}[${index}]`,
        volatilePaths,
      );
      if (at !== undefined) return at;
    }
    return undefined;
  }

  const ghObject = v.is(jsonObjectSchema, gh);
  const shadowObject = v.is(jsonObjectSchema, shadow);
  if (ghObject && shadowObject) {
    return firstDifferingKey(gh, shadow, path, volatilePaths);
  }
  if (ghObject || shadowObject) return path;
  return gh === shadow ? undefined : path;
}

/**
 * Own keys only, on both sides: a body parsed from JSON inherits
 * `Object.prototype`, so indexing it for a key it does not carry answers with
 * an inherited member rather than with undefined.
 */
function firstDifferingKey(
  gh: Readonly<Record<string, RawJsonValue>>,
  shadow: Readonly<Record<string, RawJsonValue>>,
  path: string,
  volatilePaths: ReadonlySet<string>,
): string | undefined {
  for (const [key, value] of Object.entries(gh)) {
    const at = `${path}.${key}`;
    if (volatilePaths.has(at)) continue;
    if (!Object.hasOwn(shadow, key)) return at;
    const differing = firstDifferingPath(
      value,
      shadow[key] ?? null,
      at,
      volatilePaths,
    );
    if (differing !== undefined) return differing;
  }
  for (const key of Object.keys(shadow)) {
    if (volatilePaths.has(`${path}.${key}`)) continue;
    if (!Object.hasOwn(gh, key)) return `${path}.${key}`;
  }
  return undefined;
}
