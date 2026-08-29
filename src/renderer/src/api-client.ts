import type { LocalApiDesktopRequest } from "../../main/ipc-contract";
import type { RawJsonValue } from "../../domain/json";
import { appLog } from "./lib/logger";

export type ApiFailureKind =
  | "invalid_input"
  | "auth"
  | "forbidden"
  | "unavailable"
  | "timeout"
  | "storage"
  | "stale_head"
  | "revision_conflict"
  | "github_rejected"
  | "pending_review"
  | "ambiguous_write"
  | "rejected"
  | "outcome_unknown"
  | "no_pending_review"
  | "pending_review_locked"
  | "review_write_in_progress"
  | "merge_in_progress"
  | "self_approval_not_allowed"
  | "rate_limited"
  | "assignee_cap_exceeded"
  | "internal";

export class PatchdeskApiError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly status: number,
    readonly retryable: boolean,
    readonly correlationId: string,
    message: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- carries the raw, already-failed response body for diagnostics/logging only; call sites never read structured fields off it.
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "PatchdeskApiError";
  }
}

export async function requestJson(
  path: string,
  init: Omit<LocalApiDesktopRequest, "path"> = {},
): Promise<RawJsonValue | undefined> {
  const startedAt = performance.now();
  const skipLogging = path === "/v1/logs" || path === "/health";
  if (globalThis.window === undefined || !("patchdesk" in window)) {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "renderer-unavailable",
      "Patchdesk desktop services are unavailable.",
    );
  }
  const response = await window.patchdesk.request({ path, ...init });
  const durationMs = Math.round(performance.now() - startedAt);
  if (!skipLogging) {
    const method = init.method ?? "GET";
    if (response.ok) {
      appLog.debug("api", `${method} ${path}`, {
        status: response.status,
        durationMs,
        correlationId: response.correlationId,
      });
    } else {
      appLog.warn("api", `${method} ${path}`, {
        status: response.status,
        durationMs,
        correlationId: response.correlationId,
        error: errorCode(response.body),
      });
    }
  }
  // `DesktopResponse.body` is already typed as the JSON grammar, so no
  // assertion is needed here; each call site runs its own parser against it.
  // `undefined` is preserved rather than folded into `null`: a route that
  // answered with no body at all is not a route that answered `null`.
  if (response.ok) return response.body;

  const serverCode = errorCode(response.body);
  const kind = failureKind(response.status, serverCode);
  throw new PatchdeskApiError(
    kind,
    response.status,
    response.status === 408 ||
      response.status === 429 ||
      response.status >= 500,
    response.correlationId,
    safeMessage(kind),
    response.body,
  );
}

/** Opens the main-process directory picker without exposing filesystem privileges. */
export async function selectDirectory(
  defaultPath?: string,
): Promise<string | undefined> {
  const startedAt = performance.now();
  if (globalThis.window === undefined || !("patchdesk" in window)) {
    throw new PatchdeskApiError(
      "unavailable",
      503,
      true,
      "renderer-unavailable",
      "Patchdesk desktop services are unavailable.",
    );
  }
  const defaultPathField = defaultPath === undefined ? {} : { defaultPath };
  const response = await window.patchdesk.request({
    operation: "selectDirectory",
    ...defaultPathField,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const kind = failureKind(response.status, errorCode(response.body));
    appLog.warn("api", "selectDirectory", {
      status: response.status,
      durationMs,
      correlationId: response.correlationId,
      error: errorCode(response.body),
    });
    throw new PatchdeskApiError(
      kind,
      response.status,
      response.status >= 500,
      response.correlationId,
      safeMessage(kind),
    );
  }
  appLog.debug("api", "selectDirectory", {
    status: response.status,
    durationMs,
    correlationId: response.correlationId,
  });
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the raw IPC response body at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof response.body !== "object" ||
    response.body === null ||
    !("path" in response.body)
  ) {
    throw new PatchdeskApiError(
      "internal",
      500,
      false,
      response.correlationId,
      safeMessage("internal"),
    );
  }
  if (response.body.path === null) return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the raw IPC response body's `path` field at this exact I/O boundary; no earlier parser exists for this primitive shape.
  if (typeof response.body.path === "string" && response.body.path.length > 0)
    return response.body.path;
  throw new PatchdeskApiError(
    "internal",
    500,
    false,
    response.correlationId,
    safeMessage("internal"),
  );
}

/**
 * The copy one screen shows for a failed request: the screen's own wording
 * for the kinds it words differently, and `safeMessage` for the rest.
 *
 * `fallback` is only for a cause that is not a Patchdesk API failure at all —
 * a bug, or a parse that threw — where there is no kind to word.
 */
export type ContextualMessages = Partial<Record<ApiFailureKind, string>> & {
  readonly fallback: string;
};

/**
 * Picks the message a screen shows for a failure.
 *
 * `overrides` names only the kinds this screen says something more useful
 * about than the API does — usually because it can name the action that
 * failed and what to do next. Every other API failure falls back to
 * `safeMessage`, the same bounded copy the error already carries, so a kind
 * the screen has not thought about still gets an accurate sentence instead of
 * one generic line for everything.
 *
 * Nothing this returns is GitHub's own text or the raw response body.
 */
export function contextualMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a `catch` binding is `unknown` by construction; recognising a PatchdeskApiError is what this function is for.
  cause: unknown,
  overrides: ContextualMessages,
): string {
  if (!(cause instanceof PatchdeskApiError)) return overrides.fallback;
  return overrides[cause.kind] ?? safeMessage(cause.kind);
}

/**
 * Whether a failure leaves the write's outcome unknown: GitHub may or may not
 * have applied it. A screen that sees this must offer "check GitHub again"
 * rather than a plain retry, which could apply the write twice.
 */
export function isOutcomeUnknownRetry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a `catch` binding is `unknown` by construction; recognising a PatchdeskApiError is what this function is for.
  cause: unknown,
): cause is PatchdeskApiError {
  return (
    cause instanceof PatchdeskApiError &&
    (cause.kind === "outcome_unknown" ||
      cause.kind === "ambiguous_write" ||
      cause.kind === "timeout")
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- narrows a raw JSON error body (already the local API's own response payload) at this exact I/O boundary; no earlier parser exists for this shape.
function errorCode(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
  if (typeof value !== "object" || value === null || !("error" in value))
    return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
  return typeof value.error === "string" ? value.error : undefined;
}

function failureKind(status: number, code: string | undefined): ApiFailureKind {
  if (code === "timeout" || status === 408 || status === 504) return "timeout";
  if (code === "assignee_cap_exceeded") return "assignee_cap_exceeded";
  if (code?.includes("rate_limited") === true) return "rate_limited";
  if (code === "outcome_unknown") return "outcome_unknown";
  if (code === "review_write_in_progress") return "review_write_in_progress";
  if (code === "merge_in_progress") return "merge_in_progress";
  if (code === "self_approval_not_allowed") return "self_approval_not_allowed";
  if (code?.includes("revision") === true || code === "conflict")
    return "revision_conflict";
  if (code === "not_fresh" || code?.includes("stale") === true)
    return "stale_head";
  if (code === "not_found" || code === "unavailable") return "unavailable";
  if (code === "permission_denied" || code === "confirmation_required")
    return "github_rejected";
  if (code === "pending_review" || code === "pending_review_exists")
    return "pending_review";
  if (code?.includes("storage") === true) return "storage";
  if (code?.includes("ambiguous") === true) return "ambiguous_write";
  if (code?.includes("forbidden") === true) return "forbidden";
  if (status === 401 || status === 403 || code?.includes("auth") === true)
    return "auth";
  if (status === 400 || code === "invalid_input") return "invalid_input";
  if (status === 409 || status === 422) return "github_rejected";
  if (status >= 500) return "unavailable";
  return "internal";
}

function safeMessage(kind: ApiFailureKind): string {
  switch (kind) {
    case "invalid_input":
      return "The request contains invalid information.";
    case "auth":
      return "GitHub authentication is required for this action.";
    case "forbidden":
      return "GitHub blocked this action: the repository or organization restricts access here (an IP allow list, SSO requirement, or token scope). Retrying will not help — check GitHub's access settings for this organization.";
    case "unavailable":
      return "The requested service is currently unavailable.";
    case "timeout":
      return "The request timed out before Patchdesk received a result.";
    case "storage":
      return "Patchdesk could not save the local review state.";
    case "stale_head":
      return "The pull request head changed. Refresh before continuing.";
    case "revision_conflict":
      return "This draft changed elsewhere. Reload it before continuing.";
    case "github_rejected":
      return "GitHub rejected this action.";
    case "pending_review":
      return "You have an unfinished review on this pull request on GitHub. Submit or discard it there, then comment again.";
    case "ambiguous_write":
      return "Patchdesk could not confirm whether GitHub completed the write.";
    case "rejected":
      return "GitHub rejected the pending review write.";
    case "outcome_unknown":
      return "GitHub could not confirm the pending review write. Check GitHub again before continuing.";
    case "no_pending_review":
      return "The pending review no longer exists. Refresh to see the current state.";
    case "pending_review_locked":
      return "The pending review write is still being reconciled. Check GitHub again.";
    case "review_write_in_progress":
      return "Another action is still finishing. Your review was not submitted. Wait a moment, then submit again.";
    case "merge_in_progress":
      return "Another action is still finishing. The merge was not submitted. Wait a moment, then try again.";
    case "self_approval_not_allowed":
      return "You can’t approve your own pull request. Choose Comment or ask another reviewer to approve it.";
    case "rate_limited":
      return "GitHub rate-limited this request. Wait a moment, then try again.";
    case "assignee_cap_exceeded":
      return "GitHub limits a pull request to ten assignees.";
    case "internal":
      return "Patchdesk could not complete the request.";
  }
}

export async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- this is the renderer's own request boundary; every call site immediately parses the result with a dedicated parser (parseInboxResponse, parseGlobalSettings, isProfile, ...).
): Promise<unknown> {
  // SAFETY: only local callers of `api()` supply `init.method`, always one of these five literals.
  const methodField =
    init.method === undefined
      ? {}
      : { method: init.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
  const bodyField = init.body === undefined ? {} : { body: init.body };
  return await requestJson(path, { ...methodField, ...bodyField });
}
