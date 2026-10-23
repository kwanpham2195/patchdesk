import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightReasoning } from "#src/domain/insight-provider";
import type { CodexAppServerFailure } from "./codex-app-server-client";
import { classifyRpcFailure, type RpcChild } from "./codex-app-server-rpc";
const MODEL_DISCOVERY_DEADLINE_MS = 30_000;
const MAX_MODEL_PAGES = 50;
const MAX_MODELS = 512;
const MAX_MODEL_BYTES = 4 * 1024 * 1024;
/** A renderer-safe model entry returned by Codex's live model/list method. */
export type CodexModel = {
  readonly id: string;
  readonly label: string;
  readonly reasoning: ReadonlyArray<InsightReasoning>;
  readonly defaultReasoning?: InsightReasoning;
};

const modelListItemSchema = v.looseObject({
  id: v.string(),
  displayName: v.optional(v.string()),
  hidden: v.optional(v.boolean()),
  supportedReasoningEfforts: v.optional(
    v.array(v.looseObject({ reasoningEffort: v.optional(v.string()) })),
  ),
  defaultReasoningEffort: v.optional(v.string()),
});
const modelListResultSchema = v.looseObject({
  data: v.array(modelListItemSchema),
  nextCursor: v.optional(v.nullable(v.string())),
});
type ModelListItem = v.InferOutput<typeof modelListItemSchema>;

/**
 * Walks `model/list` to the end of its cursor chain on an already-started
 * child, under every discovery bound at once: a wall-clock deadline, a page
 * cap, a response-byte cap, a model-count cap, and a seen-cursor set that
 * stops a runtime looping the same cursor back. Shared by `listModels` (which
 * owns a throwaway child) and `runTurn` (which reuses the turn's own child) so
 * the two cannot drift apart on which bound is enforced.
 *
 * An empty catalog is a failure, not an empty success: a Codex runtime that
 * advertises no model at all is unusable, and every caller would otherwise
 * have to re-derive that.
 */
export async function paginateModelList(
  child: RpcChild,
  signal?: AbortSignal,
): Promise<Result<ReadonlyArray<CodexModel>, CodexAppServerFailure>> {
  const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
  const models: CodexModel[] = [];
  let bytes = 0;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    if (signal?.aborted)
      return err({ reason: "cancelled", phase: "model_list" });
    if (Date.now() >= deadline)
      return err({ reason: "timed_out", phase: "model_list" });
    const params =
      cursor === undefined
        ? { includeHidden: false }
        : { includeHidden: false, cursor };
    const response = await child.request(
      "model/list",
      params,
      signal,
      deadline - Date.now(),
    );
    if (response._tag === "err")
      return err({
        reason: classifyRpcFailure(response.error),
        phase: "model_list",
      });
    bytes += Buffer.byteLength(JSON.stringify(response.value), "utf8");
    if (bytes > MAX_MODEL_BYTES)
      return err({ reason: "runtime_unavailable", phase: "model_list" });
    const parsedResult = v.safeParse(modelListResultSchema, response.value);
    if (!parsedResult.success)
      return err({ reason: "invalid_result", phase: "model_list" });
    const pageModels = parseModelPage(parsedResult.output.data);
    if (pageModels._tag === "err")
      return err({ reason: "invalid_result", phase: "model_list" });
    models.push(...pageModels.value);
    if (models.length > MAX_MODELS)
      return err({ reason: "runtime_unavailable", phase: "model_list" });
    const nextCursor = parsedResult.output.nextCursor ?? undefined;
    if (nextCursor === undefined)
      return models.length === 0
        ? err({ reason: "runtime_unavailable", phase: "model_list" })
        : ok(models);
    if (seenCursors.has(nextCursor))
      return err({ reason: "runtime_unavailable", phase: "model_list" });
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  // The page cap ran out with a cursor still outstanding: the catalog is
  // larger than discovery is willing to walk, so it is not usable as read.
  return err({ reason: "runtime_unavailable", phase: "model_list" });
}

function parseModelPage(
  data: ReadonlyArray<ModelListItem>,
): Result<ReadonlyArray<CodexModel>, "invalid_models"> {
  const models: CodexModel[] = [];
  let bytes = 0;
  for (const item of data) {
    if (item.id.length > 200) return err("invalid_models");
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > MAX_MODEL_BYTES) return err("invalid_models");
    if (item.hidden === true) continue;
    const efforts: Array<InsightReasoning> =
      item.supportedReasoningEfforts?.flatMap(
        (effort): ReadonlyArray<InsightReasoning> => {
          const value = effort.reasoningEffort;
          if (value === "minimal") return ["minimal"];
          if (value === "low") return ["low"];
          if (value === "medium") return ["medium"];
          if (value === "high") return ["high"];
          if (value === "xhigh") return ["xhigh"];
          return [];
        },
      ) ?? [];
    if (efforts.length === 0) continue;
    const defaultValue = item.defaultReasoningEffort;
    const defaultReasoning =
      defaultValue === "minimal" ||
      defaultValue === "low" ||
      defaultValue === "medium" ||
      defaultValue === "high" ||
      defaultValue === "xhigh"
        ? defaultValue
        : undefined;
    const model: CodexModel = {
      id: item.id,
      label: item.displayName ?? item.id,
      reasoning: [...new Set(efforts)],
    };
    models.push(
      defaultReasoning === undefined ? model : { ...model, defaultReasoning },
    );
  }
  return ok(models);
}
