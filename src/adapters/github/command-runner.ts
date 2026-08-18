import { spawn } from "node:child_process";

import * as v from "valibot";

import type { ForbiddenReason } from "../../domain/github-forbidden-reason";
import { err, ok, type Result } from "../../domain/result";
import { discoverExecutable } from "../../main/executable-discovery";

const FORCE_KILL_AFTER_MS = 2_000;

/** An explicit executable and argument vector owned by an external adapter. */
export type CommandRequest = {
  readonly argv: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** Optional adapter-owned working directory; never supplied by the renderer or model. */
  readonly cwd?: string;
  /** Non-secret JSON payload supplied directly to the child process, never through a shell. */
  readonly stdin?: string;
  /** Adapter-owned environment additions; renderer input never reaches this field. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Set false only for a child launched with a complete explicit environment. */
  readonly inheritEnvironment?: boolean;
  /** Caller-owned cancellation; the adapter terminates only its own child process. */
  readonly signal?: AbortSignal;
};

/** Captured completion state from a process execution boundary. */
export type CommandExecution =
  | {
      readonly _tag: "Exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly _tag: "TimedOut";
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "OutputExceeded" }
  | { readonly _tag: "Unavailable" };

/** The narrow process seam used by CommandRunner. */
export interface CommandExecutor {
  execute(input: CommandRequest): Promise<CommandExecution>;
}

/**
 * `ForbiddenReason` itself lives in the domain layer (see
 * `../../domain/github-forbidden-reason.ts`) so `GitHubWriteFailure`, a
 * domain type, can carry it without a domain -> adapter import; re-exported
 * here since existing callers (`github-adapter.ts`,
 * `maintainer-inbox-service.ts`) already import it from this module.
 */
export type { ForbiddenReason };

/** Safe, product-facing classifications for command execution failures. */
export type CommandFailure =
  | { readonly _tag: "CommandTimedOut" }
  | { readonly _tag: "CommandUnavailable" }
  | { readonly _tag: "CommandAuthenticationRequired" }
  | { readonly _tag: "CommandForbidden"; readonly reason: ForbiddenReason }
  | { readonly _tag: "CommandNotFound" }
  | { readonly _tag: "CommandUnsupported" }
  | { readonly _tag: "CommandPendingReview" }
  | { readonly _tag: "CommandRateLimited" }
  | { readonly _tag: "CommandRuntimeUnavailable" }
  | { readonly _tag: "CommandFailed"; readonly stderr?: string }
  | { readonly _tag: "CommandInvalidJson" };

/**
 * Execute explicitly-formed argv commands while retaining raw process output inside the boundary.
 * Expected failures intentionally expose tags only, never stdout, stderr, or command credentials.
 */
export class CommandRunner {
  constructor(
    private readonly executor: CommandExecutor = new NodeCommandExecutor(),
    /**
     * Fires once per execution that reaches the generic CommandFailed
     * fallback with non-empty stderr — i.e. a nonzero exit that matched
     * neither a structured signal nor any regex predicate. Defaults to a
     * no-op; production call sites wire this to AppLogService so future gh
     * wording drift is observable instead of silently swallowed.
     */
    private readonly onUnclassifiedFailure: (stderr: string) => void = () =>
      undefined,
  ) {}

  /** Run a command whose stdout is an opaque text artifact. */
  async runText(
    input: CommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    const execution = await this.executor.execute(input);
    const failure = classifyExecution(execution, this.onUnclassifiedFailure);
    if (failure !== undefined) return err(failure);
    if (execution._tag !== "Exited") return err({ _tag: "CommandFailed" });
    return ok(execution.stdout);
  }

  /** Run a command whose stdout must be one valid JSON value. */
  async runJson(
    input: CommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    const text = await this.runText(input);
    if (text._tag === "err") return text;

    try {
      // SAFETY: JSON.parse's return type is `any`; this cast only narrows it to
      // `unknown` so callers must validate the shape before trusting it.
      return ok(JSON.parse(text.value) as unknown);
    } catch {
      return err({ _tag: "CommandInvalidJson" });
    }
  }
}

/**
 * Spawns real OS processes. `discover` and `spawnProcess` are constructor-injectable
 * so tests can supply a faithful fake seam instead of mocking `node:child_process`
 * or the executable-discovery module.
 */
export class NodeCommandExecutor implements CommandExecutor {
  constructor(
    private readonly discover: (
      executable: string,
    ) => Promise<string | undefined> = discoverExecutable,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    const executable = input.argv[0];
    if (executable === undefined) return { _tag: "Unavailable" };
    const resolvedExecutable = await this.discover(executable);
    if (resolvedExecutable === undefined || input.signal?.aborted) {
      return { _tag: "Unavailable" };
    }

    return new Promise((resolve) => {
      const cwdField = input.cwd === undefined ? {} : { cwd: input.cwd };
      const child = this.spawnProcess(resolvedExecutable, input.argv.slice(1), {
        ...cwdField,
        shell: false,
        detached: process.platform !== "win32",
        env:
          input.inheritEnvironment === false
            ? input.environment
            : input.environment === undefined
              ? process.env
              : { ...process.env, ...input.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      const maxOutputBytes = 2 * 1024 * 1024;

      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const terminate = (): void => {
        terminateOwnedProcess(child.pid, "SIGTERM");
        forceKill ??= setTimeout(
          () => terminateOwnedProcess(child.pid, "SIGKILL"),
          FORCE_KILL_AFTER_MS,
        );
      };
      const onAbort = (): void => terminate();
      const finish = (execution: CommandExecution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(execution);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs);

      if (input.signal?.aborted) {
        terminate();
      } else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > maxOutputBytes) {
          outputExceeded = true;
          terminate();
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > maxOutputBytes) {
          outputExceeded = true;
          terminate();
        }
      });
      child.stdin?.end(input.stdin);
      child.once("error", () => finish({ _tag: "Unavailable" }));
      child.once("close", (exitCode) => {
        if (outputExceeded) {
          finish({ _tag: "OutputExceeded" });
          return;
        }
        if (timedOut) {
          finish({ _tag: "TimedOut", stdout, stderr });
          return;
        }
        finish({ _tag: "Exited", exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}

function classifyExecution(
  execution: CommandExecution,
  onUnclassifiedFailure: (stderr: string) => void,
): CommandFailure | undefined {
  if (execution._tag === "TimedOut") return { _tag: "CommandTimedOut" };
  if (execution._tag === "Unavailable") return { _tag: "CommandUnavailable" };
  if (execution._tag === "OutputExceeded") return { _tag: "CommandFailed" };
  if (execution.exitCode === 0) return undefined;

  const structured = classifyStructuredFailure(
    execution.stdout,
    execution.stderr,
  );
  if (structured !== undefined) return structured;

  const fallback = classifyByStderrPattern(execution.stderr);
  if (fallback !== undefined) return fallback;

  if (execution.stderr.length > 0) onUnclassifiedFailure(execution.stderr);
  return { _tag: "CommandFailed", stderr: execution.stderr.slice(0, 1024) };
}

/**
 * `gh api` (REST) and `gh api graphql` (GraphQL) failures both carry
 * structured, non-prose signal that this app can key on directly instead of
 * regex-matching English error text (see plan 007 Decision Before Editing).
 * This is gated purely on the *shape* of stdout/stderr, not on which command
 * produced them: no protocol hint is threaded through CommandRequest.
 *
 * That is a deliberate deviation from the plan's stated recommendation
 * (explicit `errorProtocol` hint threaded from every call site). Threading a
 * hint would require touching every `gh api ...` call site in
 * github-adapter.ts (~50 sites), which a concurrent change was landing
 * against at the same time. Content-sniffing is safe here because every
 * non-gh-api caller of CommandRunner (`git` subcommands, `gh auth status`,
 * `gh --version`, and the non-gh flue-insight child in
 * flue-insight-child-invoker.ts) never emits a JSON stdout body containing a
 * string `status` field or an `errors` array shaped like GitHub's API
 * responses, so those callers safely fall through untouched. The one risk
 * the plan calls out for content-sniffing — a plain exit code carrying no
 * content fingerprint — only matters for the exit-code-4 "no auth
 * configured" shortcut, which this change deliberately does not implement
 * (the existing `isAuthenticationFailure` phrase list already covers that
 * message; see no-auth-configured-exit4.json).
 */
function classifyStructuredFailure(
  stdout: string,
  stderr: string,
): CommandFailure | undefined {
  const restStatus = extractRestStatus(stdout, stderr);
  if (restStatus !== undefined) {
    const classified = classifyRestStatus(
      restStatus.status,
      restStatus.message,
    );
    if (classified !== undefined) return classified;
  }

  const graphqlSignal = extractGraphqlErrorSignal(stdout);
  if (graphqlSignal !== undefined) {
    const classified = classifyGraphqlSignal(graphqlSignal);
    if (classified !== undefined) return classified;
  }

  return undefined;
}

/**
 * Loose on purpose: this validates the small subset of a `gh api` REST error
 * body this classifier reads, not the full response shape (which varies per
 * endpoint). Extra fields are allowed and ignored.
 */
const restErrorBodySchema = v.looseObject({
  status: v.optional(v.string()),
  message: v.optional(v.string()),
});

/**
 * Loose for the same reason: only the fields this classifier reads from a
 * `gh api graphql` error entry (see Decision Before Editing #3 in plan 007).
 * `message` and `extensions.saml_failure` were added by plan 009 to
 * attribute a FORBIDDEN error to a specific ForbiddenReason.
 */
const graphqlErrorEntrySchema = v.looseObject({
  type: v.optional(v.string()),
  message: v.optional(v.string()),
  extensions: v.optional(
    v.looseObject({
      code: v.optional(v.string()),
      saml_failure: v.optional(v.boolean()),
    }),
  ),
});
const graphqlErrorBodySchema = v.looseObject({
  errors: v.optional(v.array(graphqlErrorEntrySchema)),
});

type RestStatusSignal = { readonly status: number; readonly message: string };

/**
 * `gh api` REST failures print a JSON error body to stdout with a string
 * `status` field (e.g. `{"message":"Not Found",...,"status":"404"}`), and a
 * one-line stderr `gh: <message> (HTTP <code>)`. Either is a reliable,
 * gh-owned structured signal; prefer stdout since it also carries the full
 * message text for the 401/403/422 content disambiguation below.
 */
function extractRestStatus(
  stdout: string,
  stderr: string,
): RestStatusSignal | undefined {
  return extractRestStatusFromStdout(stdout) ?? extractRestStatusFromStderr(stderr);
}

function extractRestStatusFromStdout(
  stdout: string,
): RestStatusSignal | undefined {
  const raw = parseJson(stdout);
  if (raw === undefined) return undefined;
  const parsed = v.safeParse(restErrorBodySchema, raw);
  if (!parsed.success) return undefined;
  const status = parsed.output.status;
  if (status === undefined || !/^\d{3}$/.test(status)) return undefined;
  return { status: Number(status), message: parsed.output.message ?? "" };
}

function extractRestStatusFromStderr(
  stderr: string,
): RestStatusSignal | undefined {
  const match = /\(HTTP (\d{3})\)\s*$/.exec(stderr.trimEnd());
  const code = match?.[1];
  if (code === undefined) return undefined;
  return { status: Number(code), message: stderr };
}

/**
 * Maps a REST HTTP status to a CommandFailure using status-specific message
 * content where GitHub documents two distinct meanings behind the same code
 * (403: primary/secondary rate limit vs genuine forbidden; 422: the
 * one-pending-review-per-user constraint vs any other validation failure).
 * Returns undefined for a recognized-but-unmapped status (e.g. 5xx), which
 * falls through to the regex fallback and then generic CommandFailed —
 * unchanged from today's behavior for those codes.
 */
function classifyRestStatus(
  status: number,
  message: string,
): CommandFailure | undefined {
  switch (status) {
    case 401:
      return { _tag: "CommandAuthenticationRequired" };
    case 403:
      return isRateLimitFailure(message)
        ? { _tag: "CommandRateLimited" }
        : { _tag: "CommandForbidden", reason: classifyForbiddenReason(message) };
    case 404:
      return { _tag: "CommandNotFound" };
    case 405:
    case 415:
    case 501:
      return { _tag: "CommandUnsupported" };
    case 422:
      return isPendingReviewFailure(message)
        ? { _tag: "CommandPendingReview" }
        : { _tag: "CommandUnsupported" };
    case 429:
      return { _tag: "CommandRateLimited" };
    default:
      return undefined;
  }
}

type GraphqlErrorSignal = {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
  readonly samlFailure?: boolean;
};

/**
 * `gh api graphql` failures carry no HTTP status anywhere (live-verified: no
 * `(HTTP nnn)` suffix in stderr for a GraphQL call). The structured signal
 * instead lives in stdout's `errors[0].type` (resolution-time errors, e.g.
 * NOT_FOUND, INSUFFICIENT_SCOPES) or `errors[0].extensions.code`
 * (schema-validation errors, e.g. undefinedField — intentionally
 * unmapped below; a bad query is a client bug, not a taxonomy gap).
 */
function extractGraphqlErrorSignal(
  stdout: string,
): GraphqlErrorSignal | undefined {
  const raw = parseJson(stdout);
  if (raw === undefined) return undefined;
  const parsed = v.safeParse(graphqlErrorBodySchema, raw);
  if (!parsed.success) return undefined;
  const first = parsed.output.errors?.[0];
  if (first === undefined) return undefined;
  const type = first.type;
  const code = first.extensions?.code;
  const message = first.message;
  const samlFailure = first.extensions?.saml_failure;
  if (type === undefined && code === undefined) return undefined;
  const typeField = type === undefined ? {} : { type };
  const codeField = code === undefined ? {} : { code };
  const messageField = message === undefined ? {} : { message };
  const samlFailureField =
    samlFailure === undefined ? {} : { samlFailure };
  return { ...typeField, ...codeField, ...messageField, ...samlFailureField };
}

/**
 * Maps only the `errors[].type` values this investigation could either
 * live-verify or find documented in GitHub's public GraphQL error-type enum.
 * NOT_FOUND and INSUFFICIENT_SCOPES are live-verified (plan 007). FORBIDDEN
 * is also live-reproduced (plan 009 — an IP-allow-list-blocked read, see
 * graphql-forbidden-ip-allow-list.json); classifyForbiddenReason further
 * attributes it to a specific closed ForbiddenReason. UNPROCESSABLE,
 * INTERNAL, and SERVICE_UNAVAILABLE were never observed or confirmed, so
 * they intentionally fall through to the regex fallback rather than being
 * guessed at.
 */
function classifyGraphqlSignal(
  signal: GraphqlErrorSignal,
): CommandFailure | undefined {
  if (signal.type === "NOT_FOUND") return { _tag: "CommandNotFound" };
  if (signal.type === "INSUFFICIENT_SCOPES") {
    return { _tag: "CommandForbidden", reason: "insufficient_scopes" };
  }
  if (signal.type === "FORBIDDEN") {
    return {
      _tag: "CommandForbidden",
      reason: classifyForbiddenReason(signal.message ?? "", signal.samlFailure),
    };
  }
  return undefined;
}

/**
 * Parses raw process stdout at the I/O boundary. The result is intentionally
 * `unknown`; every caller below validates its shape with a valibot schema
 * (restErrorBodySchema / graphqlErrorBodySchema) before trusting any field,
 * matching this codebase's `v.safeParse`-at-the-boundary convention.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- this is the JSON.parse boundary itself; every call site immediately validates the result with a valibot schema (restErrorBodySchema / graphqlErrorBodySchema) before reading any field.
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    // SAFETY: JSON.parse's return type is `any`; this cast only narrows it
    // to `unknown` so every caller must validate the shape before trusting it.
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Last-resort fallback: gh's stderr prose is not a stable contract. Prefer
 * the structured paths above; these regexes exist for shapes gh doesn't
 * expose structurally (network-level failures, older gh versions, and the
 * non-gh flue-insight child process).
 */
function classifyByStderrPattern(stderr: string): CommandFailure | undefined {
  if (isAuthenticationFailure(stderr)) {
    return { _tag: "CommandAuthenticationRequired" };
  }
  if (isNotFoundFailure(stderr)) return { _tag: "CommandNotFound" };
  if (isPendingReviewFailure(stderr)) {
    return { _tag: "CommandPendingReview" };
  }
  if (isUnsupportedFailure(stderr)) return { _tag: "CommandUnsupported" };
  // GitHub's primary rate limit responds with HTTP 403, which also matches
  // isForbiddenFailure's bare `\b403\b`; check rate-limit wording first so a
  // 403 rate-limit response classifies as CommandRateLimited, not CommandForbidden.
  if (isRateLimitFailure(stderr)) return { _tag: "CommandRateLimited" };
  if (isForbiddenFailure(stderr)) {
    return { _tag: "CommandForbidden", reason: classifyForbiddenReason(stderr) };
  }
  if (isRuntimeFailure(stderr)) return { _tag: "CommandRuntimeUnavailable" };
  return undefined;
}

function terminateOwnedProcess(
  pid: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process may already have exited between the timeout/output event and termination.
  }
}

function isAuthenticationFailure(stderr: string): boolean {
  return /(?:gh auth login|not logged in|not logged into|authentication required|authentication failed)/i.test(
    stderr,
  );
}

function isForbiddenFailure(stderr: string): boolean {
  return /(?:\b403\b|forbidden|resource not accessible)/i.test(stderr);
}

/**
 * Determines *why* GitHub refused a request as forbidden. `samlFailure`
 * (GraphQL's structured `extensions.saml_failure` flag) takes precedence
 * when available and does not depend on message wording. `ip_allow_list`
 * is message-pattern matching — GitHub does not expose IP-allow-list as a
 * distinct structured signal — so it is a last resort requiring a fixture
 * per plan 007's discipline (see tests/fixtures/gh-command-failures/).
 * `insufficient_scopes` is set by the caller (GraphQL only, from
 * errors[].type) and never reaches this function.
 */
function classifyForbiddenReason(
  message: string,
  samlFailure?: boolean,
): ForbiddenReason {
  if (samlFailure === true) return "saml";
  if (/ip allow list/i.test(message)) return "ip_allow_list";
  return "unknown";
}

function isNotFoundFailure(stderr: string): boolean {
  return /(?:\b404\b|not found|not protected)/i.test(stderr);
}

function isUnsupportedFailure(stderr: string): boolean {
  return /(?:\b405\b|\b415\b|\b422\b|\b501\b|unsupported|not implemented)/i.test(
    stderr,
  );
}

function isPendingReviewFailure(stderr: string): boolean {
  // A user can hold only one pending review per pull request; comment creation
  // fails with this until the pending review is submitted or discarded.
  return /pending review per pull request/i.test(stderr);
}

function isRateLimitFailure(stderr: string): boolean {
  return /(?:\b429\b|rate[ -]?limit|too many requests|quota exceeded)/i.test(
    stderr,
  );
}

function isRuntimeFailure(stderr: string): boolean {
  return /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|cannot find (?:module|package)|missing dependency)/i.test(
    stderr,
  );
}
