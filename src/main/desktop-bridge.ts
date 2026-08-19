import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import {
  literal,
  maxLength,
  minLength,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  union,
  unknown,
} from "valibot";

import {
  APP_CAPABILITY_HEADER,
  DESKTOP_REQUEST_CHANNEL,
  type DesktopRequest,
  type DesktopResponse,
  type LocalApiDesktopRequest,
  type SelectDirectoryDesktopRequest,
} from "./ipc-contract";
import type { StartedLocalApi } from "./app-lifecycle";

const requestSchema = union([
  strictObject({
    path: string(),
    method: optional(picklist(["GET", "POST", "PUT", "PATCH", "DELETE"])),
    body: optional(unknown()),
  }),
  strictObject({
    operation: literal("selectDirectory"),
    defaultPath: optional(string()),
  }),
  strictObject({
    operation: literal("setNavigationState"),
    state: picklist(["clear", "dirty_draft", "write_pending"]),
  }),
  strictObject({
    operation: literal("openExternalHttps"),
    url: pipe(string(), minLength(1), maxLength(2_048)),
  }),
]);

/** Mutable draft of `SelectDirectoryDesktopRequest`, built in statements so
 * the optional `defaultPath` is added only when it has a value. */
type MutableSelectDirectoryDesktopRequest = {
  -readonly [
    K in keyof SelectDirectoryDesktopRequest
  ]: SelectDirectoryDesktopRequest[K];
};
/** Mutable draft of `LocalApiDesktopRequest`, built in statements so the
 * optional `method` and `body` are added only when they have a value. */
type MutableLocalApiDesktopRequest = {
  -readonly [K in keyof LocalApiDesktopRequest]: LocalApiDesktopRequest[K];
};

const allowedRoutes = new Set([
  "GET /v1/profiles",
  "POST /v1/profiles",
  "PUT /v1/profiles",
  "POST /v1/profiles/select",
  "GET /v1/settings",
  "PATCH /v1/settings",
  "GET /v1/inbox",
  "POST /v1/watchlist",
  "PATCH /v1/watchlist/path",
  "DELETE /v1/watchlist",

  "GET /v1/watchlist/suggestions",
  "POST /v1/github/access",
  "GET /v1/environment",
  "POST /v1/direct-entry/preview",
  "POST /v1/reviews/inline-conversations/command",
  "POST /v1/reviews/labels/command",
  "GET /v1/reviews/labels",
  "POST /v1/reviews/pending-review/command",
  "POST /v1/reviews/pending-review/recover",
  "POST /v1/reviews/direct-summary/submit",
  "POST /v1/reviews/direct-summary/recover",
  "POST /v1/reviews/published-comments/edit",
  "POST /v1/reviews/published-comments/delete",
  "POST /v1/reviews/published-reviews/dismiss",
  "POST /v1/reviews/open",
  "GET /v1/insight-providers",
  "POST /v1/insight-providers/codex/models",
  "POST /v1/reviews/load",
  "POST /v1/reviews/detect-updates",
  "POST /v1/reviews/insights/analysis/run",
  "POST /v1/reviews/insights/walkthrough/run",
  "POST /v1/reviews/insights/analysis/cancel",
  "POST /v1/reviews/insights/walkthrough/cancel",
  "POST /v1/reviews/insights/walkthrough/progress",
  "POST /v1/reviews/diff-file",
  "POST /v1/reviews/refresh",
  "POST /v1/reviews/commit-diff",
  "POST /v1/reviews/merge",
  "POST /v1/reviews/merge/recover",
  "POST /v1/storage/cache/clear",
  "POST /v1/storage/clear-local-data",
  "GET /v1/diagnostics",
  "POST /v1/diagnostics/support-bundle",
  "GET /v1/logs",
  "POST /v1/logs",
]);

const allowedRoutePatterns = [
  /^GET \/v1\/reviews\/insights\/runs\/[^/]+$/,
  /^POST \/v1\/reviews\/insights\/analysis\/findings\/[^/]+\/(?:add|dismiss)$/,
];

/**
 * Routes registered in `local-api.ts` that are intentionally unreachable
 * through the desktop bridge. `tests/desktop-bridge.test.ts` derives every
 * route Hono actually registers and fails, naming the route, unless it
 * appears here or in `allowedRoutes` / `allowedRoutePatterns` — so adding a
 * Hono route without a matching bridge decision cannot ship silently.
 */
export const deliberatelyDeniedRoutes = new Set([
  // Liveness probe for the local HTTP server process itself; the renderer
  // has no reason to reach it through the desktop bridge.
  "GET /health",
]);

// The renderer projection can carry a large retained Walkthrough plus its full
// patch (a 100+-hunk PR easily exceeds 2 MB of bounded diff text). 8 MB keeps
// real review projections readable without unbounded renderer memory.
const maxResponseBytes = 8 * 1024 * 1024;

export function isAllowedDesktopRequest(
  input: LocalApiDesktopRequest,
): boolean {
  const method = input.method ?? "GET";
  const url = new URL(input.path, "http://patchdesk.invalid");
  if (url.origin !== "http://patchdesk.invalid") return false;
  const route = `${method} ${url.pathname}`;
  return (
    allowedRoutes.has(route) ||
    allowedRoutePatterns.some((pattern) => pattern.test(route))
  );
}

export function installDesktopRequestBridge(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  senderId: number,
  server: StartedLocalApi,
  rendererOrigin: string,
  operations: {
    readonly selectDirectory: (input: {
      readonly defaultPath?: string;
    }) => Promise<string | undefined>;
    readonly setNavigationState: (
      state: "clear" | "dirty_draft" | "write_pending",
    ) => void;
    readonly openExternalHttps: (url: string) => Promise<boolean>;
  },
): void {
  ipc.removeHandler(DESKTOP_REQUEST_CHANNEL);
  ipc.handle(
    DESKTOP_REQUEST_CHANNEL,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the desktop bridge's raw IPC-message I/O boundary; the very next statement runs `safeParse(requestSchema, input)` against it before anything else touches it.
    async (event, input: unknown): Promise<DesktopResponse> => {
      const correlationId = randomUUID();
      const parsed = safeParse(requestSchema, input);
      const request: DesktopRequest | undefined = !parsed.success
        ? undefined
        : "operation" in parsed.output
          ? parsed.output.operation === "setNavigationState"
            ? { operation: parsed.output.operation, state: parsed.output.state }
            : parsed.output.operation === "openExternalHttps"
              ? { operation: parsed.output.operation, url: parsed.output.url }
              : (() => {
                  const selectDirectoryRequest: MutableSelectDirectoryDesktopRequest =
                    { operation: parsed.output.operation };
                  if (parsed.output.defaultPath !== undefined)
                    selectDirectoryRequest.defaultPath =
                      parsed.output.defaultPath;
                  return selectDirectoryRequest;
                })()
          : (() => {
              const localApiRequest: MutableLocalApiDesktopRequest = {
                path: parsed.output.path,
              };
              if (parsed.output.method !== undefined)
                localApiRequest.method = parsed.output.method;
              if (parsed.output.body !== undefined)
                localApiRequest.body = parsed.output.body;
              return localApiRequest;
            })();
      if (request === undefined || event.sender.id !== senderId) {
        return {
          ok: false,
          status: 400,
          body: { error: "invalid_input" },
          correlationId,
        };
      }

      if ("operation" in request) {
        if (request.operation === "setNavigationState") {
          operations.setNavigationState(request.state);
          return { ok: true, status: 200, body: {}, correlationId };
        }
        if (request.operation === "openExternalHttps") {
          try {
            const opened = await operations.openExternalHttps(request.url);
            return { ok: true, status: 200, body: { opened }, correlationId };
          } catch {
            return {
              ok: false,
              status: 500,
              body: { error: "external_open_failed" },
              correlationId,
            };
          }
        }
        try {
          const path = await operations.selectDirectory(
            request.defaultPath === undefined
              ? {}
              : { defaultPath: request.defaultPath },
          );
          return {
            ok: true,
            status: 200,
            body: { path: path ?? null },
            correlationId,
          };
        } catch {
          return {
            ok: false,
            status: 500,
            body: { error: "directory_picker_failed" },
            correlationId,
          };
        }
      }

      if (!isAllowedDesktopRequest(request)) {
        return {
          ok: false,
          status: 400,
          body: { error: "invalid_input" },
          correlationId,
        };
      }

      const method = request.method ?? "GET";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const requestInit: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: rendererOrigin,
            "X-Patchdesk-Correlation-Id": correlationId,
            [APP_CAPABILITY_HEADER]: server.capability,
          },
          signal: controller.signal,
        };
        if (request.body !== undefined)
          requestInit.body = JSON.stringify(request.body);
        const response = await fetch(
          new URL(request.path.slice(1), server.url),
          requestInit,
        );
        const ok = response.ok;
        const status = response.status;
        if (!ok) {
          const body = await readBridgeResponseBody(response, maxResponseBytes);
          return { ok: false, status, body, correlationId };
        }
        const body = await readBridgeResponseBody(response, maxResponseBytes);
        return {
          ok,
          status,
          body,
          correlationId,
        };
      } catch (cause: unknown) {
        return {
          ok: false,
          status:
            cause instanceof Error && cause.name === "AbortError" ? 504 : 503,
          body: {
            error:
              cause instanceof Error && cause.name === "AbortError"
                ? "timeout"
                : "unavailable",
          },
          correlationId,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  );
}

async function readBridgeResponseBody(
  response: Response,
  maxResponseBytes: number,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- this is the desktop bridge's raw HTTP-response-body I/O boundary; the renderer runs its own route-specific parser against DesktopResponse.body, so there is no single concrete type to return here.
): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes)
    return { error: "response_too_large" };
  const text = new TextDecoder().decode(bytes);
  return text.length === 0 ? undefined : parseJson(text);
}

// No explicit return type: this is the same raw-body boundary as above, and
// annotating it `unknown` would discard the `{ error: "invalid_response" }`
// fallback's known shape for no benefit — every caller already treats the
// result as unparsed.
function parseJson(value: string) {
  try {
    // SAFETY: JSON.parse's return type is `any`; this cast narrows it to
    // `unknown` so every caller must validate the parsed body before use.
    return JSON.parse(value) as unknown;
  } catch {
    return { error: "invalid_response" };
  }
}
