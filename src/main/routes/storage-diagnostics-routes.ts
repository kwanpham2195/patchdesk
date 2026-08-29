import type { Context, Hono } from "hono";
import {
  array,
  maxLength,
  minLength,
  object,
  optional,
  picklist,
  pipe,
  record,
  safeParse,
  strictObject,
  string,
  unknown,
} from "valibot";

import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import { rawJsonValueSchema } from "../../domain/json";
import type { LogEntryInput } from "../../domain/log-entry";
import type { LocalApiContainer } from "../local-api-container";
import { jsonBody } from "./json-body";

/** Local data cleanup, the renderer log stream and the diagnostics bundle. */
export function registerStorageDiagnosticsRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { diagnostics, logs, storageManagement } = container;
  const storageCleanup = async (
    context: Context,
    action: "cache" | "local-data",
  ): Promise<Response> => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({ profileId: pipe(string(), minLength(1)) }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return storageResponse(
      context,
      action === "cache"
        ? await storageManagement.clearCache(profileId.value)
        : await storageManagement.clearLocalData(profileId.value),
    );
  };
  app.post("/v1/storage/cache/clear", async (context) =>
    storageCleanup(context, "cache"),
  );
  app.post("/v1/storage/clear-local-data", async (context) =>
    storageCleanup(context, "local-data"),
  );
  app.get("/v1/logs", async (context) => {
    const rawAfter = context.req.query("after");
    const rawLimit = context.req.query("limit");
    const after =
      rawAfter === undefined || !/^\d+$/.test(rawAfter)
        ? undefined
        : Number(rawAfter);
    const limit =
      rawLimit === undefined || !/^\d+$/.test(rawLimit)
        ? undefined
        : Number(rawLimit);
    return context.json(logs.tail(after, limit));
  });
  app.post("/v1/logs", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(object({ entries: array(unknown()) }), body);
    if (!parsed.success || parsed.output.entries.length === 0) {
      return context.json({ error: "invalid_input" }, 400);
    }
    let accepted = 0;
    for (const raw of parsed.output.entries.slice(0, 100)) {
      const candidate = safeParse(rendererLogEntrySchema, raw);
      if (!candidate.success) continue;
      const optionalLogFields: {
        -readonly [
          K in "meta" | "profileId" | "sessionId" | "correlationId"
        ]?: LogEntryInput[K];
      } = {};
      if (candidate.output.meta !== undefined)
        optionalLogFields.meta = candidate.output.meta;
      if (candidate.output.profileId !== undefined)
        optionalLogFields.profileId = candidate.output.profileId;
      if (candidate.output.sessionId !== undefined)
        optionalLogFields.sessionId = candidate.output.sessionId;
      if (candidate.output.correlationId !== undefined)
        optionalLogFields.correlationId = candidate.output.correlationId;
      logs.write({
        process: "renderer",
        level: candidate.output.level,
        topic: candidate.output.topic,
        message: candidate.output.message,
        ...optionalLogFields,
      });
      accepted += 1;
    }
    return context.json({ accepted });
  });
  app.get("/v1/diagnostics", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const events = await diagnostics.recent(profileId.value);
    return events._tag === "ok"
      ? context.json({ events: events.value })
      : context.json({ error: "diagnostics_unavailable" }, 503);
  });
  app.post("/v1/diagnostics/support-bundle", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({
        profileId: pipe(string(), minLength(1)),
        sessionId: optional(pipe(string(), minLength(1))),
      }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const sessionId =
      parsed.output.sessionId === undefined
        ? undefined
        : parseReviewSessionId(parsed.output.sessionId);
    if (sessionId?._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const bundle = await diagnostics.exportSupportBundle(
      sessionId?._tag === "ok"
        ? { profileId: profileId.value, sessionId: sessionId.value }
        : { profileId: profileId.value },
    );
    return bundle._tag === "ok"
      ? context.json(bundle.value)
      : context.json({ error: "diagnostics_unavailable" }, 503);
  });
}

const rendererLogEntrySchema = strictObject({
  level: picklist(["debug", "info", "warn", "error"]),
  topic: pipe(string(), minLength(1), maxLength(48)),
  message: pipe(string(), minLength(1), maxLength(512)),
  meta: optional(record(string(), rawJsonValueSchema)),
  profileId: optional(pipe(string(), minLength(1), maxLength(180))),
  sessionId: optional(pipe(string(), minLength(1), maxLength(180))),
  correlationId: optional(pipe(string(), minLength(1), maxLength(120))),
});

type StorageRouteFailure = {
  readonly _tag:
    | "ProfileNotFound"
    | "ProfileUnavailable"
    | "StorageUnavailable"
    | "SessionRunning"
    | "SessionImmutable"
    | "SessionNotDiscardable"
    | "SessionProtected"
    | "SessionNotFound"
    | "InvalidQuarantineEntryName"
    | "TrashUnavailable";
};

function storageResponse(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | { readonly _tag: "err"; readonly error: StorageRouteFailure },
): Response {
  if (result._tag === "ok") return context.json(result.value);
  const tag = result.error._tag;
  if (tag === "ProfileNotFound" || tag === "SessionNotFound")
    return context.json({ error: "not_found" }, 404);
  if (tag === "ProfileUnavailable" || tag === "StorageUnavailable")
    return context.json({ error: "storage_unavailable" }, 503);
  if (
    tag === "SessionRunning" ||
    tag === "SessionImmutable" ||
    tag === "SessionNotDiscardable" ||
    tag === "SessionProtected"
  )
    return context.json({ error: tag }, 409);
  if (tag === "InvalidQuarantineEntryName")
    return context.json({ error: "invalid_input" }, 400);
  if (tag === "TrashUnavailable")
    return context.json({ error: "trash_unavailable" }, 503);
  return context.json({ error: "storage" }, 503);
}
