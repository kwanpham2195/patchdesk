import * as v from "valibot";

/**
 * A generic JSON value. Every RPC response's `result` is one of these before it is parsed into
 * its own method-specific shape (thread/start, turn/start, model/list, ...); each caller runs
 * its own schema over it rather than reading it as `unknown`.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null_(),
    v.array(jsonValueSchema),
    v.record(v.string(), jsonValueSchema),
  ]),
);
/** An RPC response's `result`, confirmed to be a plain object. */
export const codexRpcResultSchema = v.record(v.string(), jsonValueSchema);
