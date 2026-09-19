import * as v from "valibot";

import { definedProps } from "../../domain/defined-props";
import { parseIsoTimestamp, type IsoTimestamp } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  classifyGraphqlErrorBody,
  classifyRestStatus,
  normalizeCommandLabel,
  requestAbortContext,
  type CommandFailure,
} from "./command-runner";
import { commandTimeoutMs } from "./gh-request-runner";
import {
  isEnterpriseServerHost,
  type GitHubCredentials,
} from "./github-credentials";
import {
  ghInvocationFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "./github-request";

/** Mirrors `maxOutputBytes` in `NodeCommandExecutor`: a response larger than this must never be buffered into the main process. */
const maxResponseBytes = 2 * 1024 * 1024;

/** GitHub rejects an API request without one, and gh sent its own. */
const userAgent = "Patchdesk";

const defaultAccept = "application/vnd.github+json";
const restApiVersion = "2022-11-28";

/**
 * How a request reaches the network. Node's `fetch` is the default; the main
 * process injects Electron's `net.fetch`, which uses Chromium's stack and so
 * honours the system proxy and the system trust store the way `gh` did
 * (ADR 0046).
 */
export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The REST and GraphQL roots one GitHub host answers on. */
export type GitHubApiOrigin = {
  readonly rest: string;
  readonly graphql: string;
};

/**
 * The base URL gh derived from the host, now this app's own code (ADR 0046).
 * The GitHub Enterprise Server branch is unverified against a real host —
 * there is none on this machine — so it is pinned by unit tests only.
 */
export function gitHubApiOrigin(host: string): GitHubApiOrigin {
  if (isEnterpriseServerHost(host)) {
    return {
      rest: `https://${host}/api/v3`,
      graphql: `https://${host}/api/graphql`,
    };
  }
  const apiHost = host === "github.com" ? "api.github.com" : `api.${host}`;
  return { rest: `https://${apiHost}`, graphql: `https://${apiHost}/graphql` };
}

/**
 * What one response said about the calling account's remaining quota on that
 * host. ADR 0023 deferred reading this because gh printed response headers
 * onto stdout ahead of the body; over HTTP they arrive on every call.
 */
export type GitHubRateLimitObservation = {
  readonly host: string;
  readonly remaining?: number;
  readonly resetAt?: IsoTimestamp;
  /** `retry-after`, which GitHub sends on a secondary rate limit instead of a reset instant. */
  readonly retryAfterSeconds?: number;
};

/**
 * One settled HTTP request, as the request logger sees it. It carries the
 * normalized endpoint label and nothing else the URL held, so no query string,
 * header, or token can reach the log (ADR 0046). `status` is 0 when no
 * response arrived at all.
 *
 * A read served here no longer spawns a child, so this is what keeps it
 * countable in `scripts/gh-spawn-report.mjs` beside the spawns.
 */
export type GitHubHttpRequestRecord = {
  readonly label: string;
  readonly status: number;
  readonly durationMs: number;
};

/** One GraphQL variable value, as gh's field-type inference produced it. */
type GraphQlVariableValue = string | number | boolean | null;

type GraphQlVariable = GitHubGraphQlRequest["variables"][number];

/** How many response bytes a call may still buffer, shared across a paginated read's pages. */
type ByteBudget = { remaining: number };

const graphQlErrorsSchema = v.looseObject({
  errors: v.optional(v.array(v.unknown())),
});

/**
 * Calls the GitHub API over HTTPS as the account a workspace profile names,
 * replacing the `gh api` child process every read and write paid for (ADR
 * 0046). The reads in `httpServedReadLabels` route through it; the rest still
 * spawn `gh`.
 *
 * Connections are kept alive by the runtime's own fetch dispatcher, which
 * pools per origin, so a burst of calls to one host repeats neither the
 * process launch nor the TLS handshake.
 */
export class GitHubHttpClient {
  constructor(
    private readonly credentials: GitHubCredentials,
    /**
     * Fires once per response that carried rate-limit headers, so the
     * last-observed limit can be cached per host. Defaults to a no-op.
     */
    private readonly onRateLimit: (
      observation: GitHubRateLimitObservation,
    ) => void = () => undefined,
    /** Injectable so a test can point the client at a local fixture server; production always resolves the real host. */
    private readonly origin: (
      host: string,
    ) => GitHubApiOrigin = gitHubApiOrigin,
    /** Defaults to the runtime's own fetch; `src/main` supplies Chromium's. */
    private readonly fetchRequest: GitHubFetch = fetch,
    /**
     * Fires once per HTTP request, a paginated read's every page included, so
     * a served read is countable where a spawn used to be. Defaults to a
     * no-op.
     */
    private readonly onRequest: (
      record: GitHubHttpRequestRecord,
    ) => void = () => undefined,
  ) {}

  /** Run a REST request as the profile's configured GitHub account. */
  async rest(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
    signal?: AbortSignal,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.asProfileAccount(profile, (token) =>
      withRequestDeadline(signal, (deadline) =>
        this.sendRest(request, token, deadline),
      ),
    );
  }

  /** Run a GraphQL request as the profile's configured GitHub account. */
  async graphql(
    profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
    signal?: AbortSignal,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.asProfileAccount(profile, (token) =>
      withRequestDeadline(signal, (deadline) =>
        this.sendGraphQl(request, token, deadline),
      ),
    );
  }

  /**
   * Resolves the profile account's credential, runs the call with it, and
   * drops the credential the host rejected so the next call re-reads it —
   * the same sequence `GhRequestRunner.runAsProfileAccount` performs.
   */
  private async asProfileAccount(
    profile: WorkspaceProfileConfig,
    run: (token: string) => Promise<Result<unknown, CommandFailure>>,
  ): Promise<Result<unknown, CommandFailure>> {
    const token = await this.credentials.tokenFor(profile);
    if (token._tag === "err") return token;
    const response = await run(token.value);
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      this.credentials.forget(profile);
    }
    return response;
  }

  private async sendRest(
    request: GitHubRestRequest,
    token: string,
    signal: AbortSignal,
  ): Promise<Result<unknown, CommandFailure>> {
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: request.accept ?? defaultAccept,
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": restApiVersion,
    });
    if (request.jsonBody !== undefined)
      headers.set("Content-Type", "application/json");
    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      signal,
      ...definedProps({ body: request.jsonBody }),
    };

    // One budget for the whole call, so a paginated read is bounded by the
    // same 2 MiB the single stdout buffer bounded it by.
    const budget: ByteBudget = { remaining: maxResponseBytes };
    const pages: Array<unknown> = [];
    let url: string | undefined =
      `${this.origin(request.host).rest}/${request.path}`;

    const label = labelOf(request);
    while (url !== undefined) {
      const { response, body } = await this.fetchPage(
        label,
        url,
        init,
        request.host,
        budget,
      );
      if (body._tag === "err") return body;
      const failure = responseFailure(response.status, body.value);
      if (failure !== undefined) return err(failure);
      if (request.paginate !== true) return decodeBody(response, body.value);
      const page = parseJsonBody(body.value);
      if (page._tag === "err") return page;
      pages.push(page.value);
      url = nextPageUrl(response.headers);
    }
    // `--paginate --slurp` answered with one array of page bodies.
    return ok(pages);
  }

  private async sendGraphQl(
    request: GitHubGraphQlRequest,
    token: string,
    signal: AbortSignal,
  ): Promise<Result<unknown, CommandFailure>> {
    const { response, body } = await this.fetchPage(
      labelOf(request),
      this.origin(request.host).graphql,
      {
        method: "POST",
        headers: new Headers({
          Authorization: `Bearer ${token}`,
          Accept: defaultAccept,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        }),
        body: JSON.stringify({
          query: request.document,
          variables: Object.fromEntries(request.variables.map(variableEntry)),
        }),
        signal,
      },
      request.host,
      { remaining: maxResponseBytes },
    );
    if (body._tag === "err") return body;
    const failure = responseFailure(response.status, body.value);
    if (failure !== undefined) return err(failure);
    const parsed = parseJsonBody(body.value);
    if (parsed._tag === "err") return parsed;

    // A GraphQL error arrives under HTTP 200, which is why gh exited nonzero
    // on the body rather than on the status.
    const errors = v.safeParse(graphQlErrorsSchema, parsed.value);
    if (errors.success && (errors.output.errors?.length ?? 0) > 0) {
      return err(
        classifyGraphqlErrorBody(body.value) ?? {
          _tag: "CommandFailed",
          stderr: body.value.slice(0, 1024),
        },
      );
    }
    return ok(parsed.value);
  }

  /**
   * One HTTP round trip and its whole body, recorded under the label the gh
   * path would have logged. The record is written whatever the outcome, so a
   * request that never got a response is still counted; a thrown error stays
   * thrown, because `withRequestDeadline` owns what it classifies to.
   */
  private async fetchPage(
    label: string,
    url: string,
    init: RequestInit,
    host: string,
    budget: ByteBudget,
  ): Promise<{
    readonly response: Response;
    readonly body: Result<string, CommandFailure>;
  }> {
    const startedAt = Date.now();
    let status = 0;
    try {
      const response = await this.fetchRequest(url, init);
      status = response.status;
      this.observeRateLimit(host, response.headers);
      return { response, body: await readCappedText(response, budget) };
    } finally {
      this.onRequest({ label, status, durationMs: Date.now() - startedAt });
    }
  }

  private observeRateLimit(host: string, headers: Headers): void {
    const observation = rateLimitObservation(host, headers);
    if (observation !== undefined) this.onRateLimit(observation);
  }
}

/**
 * Binds one wall-clock budget and one cancellation to a whole call, pages
 * included, and classifies everything the transport itself can fail with.
 *
 * A caller-supplied signal wins over the ambient request one, the precedence
 * `withAmbientSignal` gives `CommandRunner`. The three outcomes below are the
 * load-bearing part: a dropped connection, a DNS failure, or a TLS rejection
 * is never a rejection by GitHub, because `writeFailure` turns `CommandFailed`
 * into `rejected` and removes a write intent whose mutation may already have
 * landed (ADR 0035, ADR 0046).
 */
async function withRequestDeadline(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Result<unknown, CommandFailure>>,
): Promise<Result<unknown, CommandFailure>> {
  const ambient = callerSignal ?? requestAbortContext.getStore();
  if (ambient?.aborted === true) return err({ _tag: "CommandAborted" });

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, commandTimeoutMs);
  const onAbort = (): void => controller.abort();
  ambient?.addEventListener("abort", onAbort, { once: true });

  try {
    return await run(controller.signal);
  } catch {
    if (timedOut) return err({ _tag: "CommandTimedOut" });
    // Nothing else aborts this controller, so an abort that is not the
    // deadline is the signal this call was cancelled through.
    if (controller.signal.aborted) return err({ _tag: "CommandAborted" });
    return err({ _tag: "CommandUnavailable" });
  } finally {
    clearTimeout(timeout);
    ambient?.removeEventListener("abort", onAbort);
  }
}

/**
 * The failure a response status is, or undefined when the status is a success.
 * `classifyRestStatus` owns every code GitHub gives two meanings, 501 among
 * them. Only a status it does not map falls through, and there a 5xx has to
 * stop short of `CommandFailed`: a server error must never read as a
 * rejection, because that removes a write intent (ADR 0035).
 */
function responseFailure(
  status: number,
  body: string,
): CommandFailure | undefined {
  if (status >= 200 && status < 300) return undefined;
  const classified = classifyRestStatus(status, body);
  if (classified !== undefined) return classified;
  if (status >= 500) return { _tag: "CommandUnavailable" };
  return { _tag: "CommandFailed", stderr: body.slice(0, 1024) };
}

/** The label the same request spawned under, so one endpoint reads the same whichever transport served it. */
function labelOf(request: GitHubRequest): string {
  return normalizeCommandLabel(ghInvocationFor(request).argv);
}

/** JSON is parsed; anything else — a diff, an empty 204 — is the text gh would have written to stdout. */
function decodeBody(
  response: Response,
  text: string,
): Result<unknown, CommandFailure> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? parseJsonBody(text) : ok(text);
}

function parseJsonBody(text: string): Result<unknown, CommandFailure> {
  try {
    // SAFETY: JSON.parse's return type is `any`; this cast only narrows it to
    // `unknown` so callers must validate the shape before trusting it.
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err({ _tag: "CommandInvalidJson" });
  }
}

/**
 * Reads the body as it streams and stops at the budget instead of buffering
 * whatever arrives, so a large diff cannot exhaust the main process. The
 * `CommandFailed` tag matches what `OutputExceeded` classified to.
 *
 * `ignoreBOM` keeps a leading U+FEFF in the text, which the default decoder
 * and `Response.text()` both strip. gh wrote its stdout through Node's utf8
 * stream decoder, which keeps it, and one byte of difference in a compare
 * response changes `canonicalPatchHash` (ADR 0026).
 */
async function readCappedText(
  response: Response,
  budget: ByteBudget,
): Promise<Result<string, CommandFailure>> {
  const stream = response.body;
  if (stream === null) return ok("");
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    budget.remaining -= chunk.value.byteLength;
    if (budget.remaining < 0) {
      await reader.cancel();
      return err({ _tag: "CommandFailed" });
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return ok(text + decoder.decode());
}

/** The next page gh followed under `--paginate`, read from the same `Link` header. */
function nextPageUrl(headers: Headers): string | undefined {
  const link = headers.get("link");
  if (link === null) return undefined;
  return /<([^>]+)>\s*;\s*rel="next"/.exec(link)?.[1];
}

function variableEntry(
  variable: GraphQlVariable,
): readonly [
  string,
  GraphQlVariableValue | ReadonlyArray<GraphQlVariableValue>,
] {
  if (variable.kind === "string") return [variable.name, variable.value];
  if (variable.kind === "list")
    return [variable.name, variable.values.map(inferredValue)];
  return [variable.name, inferredValue(String(variable.value))];
}

/**
 * gh's `-F` inferred a field's type from its text (`magicFieldValue` in gh's
 * api.go) — which is why `kind: "string"` exists, to keep a numeric-looking
 * branch or owner a GraphQL String. Inferring from the same text keeps every
 * variable the type GitHub already receives.
 */
function inferredValue(text: string): GraphQlVariableValue {
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return text;
}

function rateLimitObservation(
  host: string,
  headers: Headers,
): GitHubRateLimitObservation | undefined {
  const remaining = integerHeader(headers.get("x-ratelimit-remaining"));
  const reset = integerHeader(headers.get("x-ratelimit-reset"));
  const retryAfterSeconds = integerHeader(headers.get("retry-after"));
  const resetAt = reset === undefined ? undefined : instantAt(reset);
  if (
    remaining === undefined &&
    resetAt === undefined &&
    retryAfterSeconds === undefined
  ) {
    return undefined;
  }
  return {
    host,
    ...definedProps({ remaining, resetAt, retryAfterSeconds }),
  };
}

function integerHeader(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

/** `x-ratelimit-reset` counts seconds since the epoch; the rest of the app holds instants. */
function instantAt(epochSeconds: number): IsoTimestamp | undefined {
  const date = new Date(epochSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  const parsed = parseIsoTimestamp(date.toISOString());
  return parsed._tag === "ok" ? parsed.value : undefined;
}
