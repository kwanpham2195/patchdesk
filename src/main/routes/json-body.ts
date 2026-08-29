import type { Context } from "hono";

import type { RawJsonValue } from "../../domain/json";

export async function jsonBody(
  context: Context,
): Promise<RawJsonValue | undefined> {
  const maximumBytes = 1024 * 1024;
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    return undefined;
  const stream = context.req.raw.body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // SAFETY: JSON.parse's return type is `any`; this cast narrows it to
    // `RawJsonValue` (the JSON value grammar) so every caller must still
    // validate the parsed body's shape before use.
    return JSON.parse(new TextDecoder().decode(combined)) as RawJsonValue;
  } catch {
    return undefined;
  }
}
