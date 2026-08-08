import type { LocalApiDesktopRequest } from "../../main/ipc-contract";

export type ApiFailureKind =
  | "invalid_input"
  | "auth"
  | "unavailable"
  | "timeout"
  | "storage"
  | "stale_head"
  | "revision_conflict"
  | "github_rejected"
  | "ambiguous_write"
  | "internal";

export class PatchdeskApiError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly status: number,
    readonly retryable: boolean,
    readonly correlationId: string,
    message: string,
  ) {
    super(message);
    this.name = "PatchdeskApiError";
  }
}

export async function requestJson(
  path: string,
  init: Omit<LocalApiDesktopRequest, "path"> = {},
): Promise<unknown> {
  if (typeof window === "undefined" || !("patchdesk" in window)) {
    throw new PatchdeskApiError("unavailable", 503, true, "renderer-unavailable", "Patchdesk desktop services are unavailable.");
  }
  const response = await window.patchdesk.request({ path, ...init });
  if (response.ok) return response.body;

  const serverCode = errorCode(response.body);
  const kind = failureKind(response.status, serverCode);
  throw new PatchdeskApiError(
    kind,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
    response.correlationId,
    safeMessage(kind),
  );
}

/** Opens the main-process directory picker without exposing filesystem privileges. */
export async function selectDirectory(defaultPath?: string): Promise<string | undefined> {
  if (typeof window === "undefined" || !("patchdesk" in window)) {
    throw new PatchdeskApiError("unavailable", 503, true, "renderer-unavailable", "Patchdesk desktop services are unavailable.");
  }
  const response = await window.patchdesk.request({ operation: "selectDirectory", ...(defaultPath === undefined ? {} : { defaultPath }) });
  if (!response.ok) {
    const kind = failureKind(response.status, errorCode(response.body));
    throw new PatchdeskApiError(kind, response.status, response.status >= 500, response.correlationId, safeMessage(kind));
  }
  if (typeof response.body !== "object" || response.body === null || !("path" in response.body)) {
    throw new PatchdeskApiError("internal", 500, false, response.correlationId, safeMessage("internal"));
  }
  if (response.body.path === null) return undefined;
  if (typeof response.body.path === "string" && response.body.path.length > 0) return response.body.path;
  throw new PatchdeskApiError("internal", 500, false, response.correlationId, safeMessage("internal"));
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  return typeof value.error === "string" ? value.error : undefined;
}

function failureKind(status: number, code: string | undefined): ApiFailureKind {
  if (code === "timeout" || status === 408 || status === 504) return "timeout";
  if (code?.includes("revision") === true || code === "conflict") return "revision_conflict";
  if (code === "not_fresh" || code?.includes("stale") === true) return "stale_head";
  if (code === "not_found" || code === "unavailable") return "unavailable";
  if (code === "permission_denied" || code === "confirmation_required") return "github_rejected";
  if (code?.includes("storage") === true) return "storage";
  if (code?.includes("ambiguous") === true) return "ambiguous_write";
  if (status === 401 || status === 403 || code?.includes("auth") === true) return "auth";
  if (status === 400 || code === "invalid_input") return "invalid_input";
  if (status === 409 || status === 422) return "github_rejected";
  if (status >= 500) return "unavailable";
  return "internal";
}

function safeMessage(kind: ApiFailureKind): string {
  switch (kind) {
    case "invalid_input": return "The request contains invalid information.";
    case "auth": return "GitHub authentication is required for this action.";
    case "unavailable": return "The requested service is currently unavailable.";
    case "timeout": return "The request timed out before Patchdesk received a result.";
    case "storage": return "Patchdesk could not save the local review state.";
    case "stale_head": return "The pull request head changed. Refresh before continuing.";
    case "revision_conflict": return "This draft changed elsewhere. Reload it before continuing.";
    case "github_rejected": return "GitHub rejected this action.";
    case "ambiguous_write": return "Patchdesk could not confirm whether GitHub completed the write.";
    case "internal": return "Patchdesk could not complete the request.";
  }
}
