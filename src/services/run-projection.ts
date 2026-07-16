import * as v from "valibot";
import { err, ok, type Result } from "../domain/result";

export type SafeRunProjection = { readonly status: "queued" | "connecting" | "running" | "completed" | "failed" | "disconnected"; readonly elapsedMs: number; readonly step: "preparing" | "inspecting" | "complete" | "failed"; readonly message?: string };
const schema = v.strictObject({ status: v.picklist(["queued", "connecting", "running", "completed", "failed", "disconnected"]), elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)), step: v.picklist(["preparing", "inspecting", "complete", "failed"]), message: v.optional(v.pipe(v.string(), v.maxLength(240))) });
/** Drop raw Flue events and expose only renderer-safe run state. */
export function projectSafeRun(input: unknown): Result<SafeRunProjection, { readonly _tag: "InvalidRunProjection" }> { const parsed = v.safeParse(schema, input); return parsed.success ? ok({ status: parsed.output.status, elapsedMs: parsed.output.elapsedMs, step: parsed.output.step, ...(parsed.output.message === undefined ? {} : { message: parsed.output.message }) }) : err({ _tag: "InvalidRunProjection" }); }
