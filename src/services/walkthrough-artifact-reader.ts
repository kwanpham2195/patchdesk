import { open } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result";

export type BoundedArtifactReadError =
  | { readonly reason: "input_too_large" }
  | { readonly reason: "read_failed" };

/**
 * Reads at most `maxBytes` from a main-process-owned artifact.
 *
 * The allocation is capped at `maxBytes + 1`, so an oversized file is rejected
 * before its full contents can be materialized in memory.
 */
export async function readBoundedArtifact(
  path: string,
  maxBytes: number,
): Promise<Result<string, BoundedArtifactReadError>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return err({ reason: "read_failed" });
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;

    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    if (bytesRead > maxBytes) {
      return err({ reason: "input_too_large" });
    }
    return ok(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return err({ reason: "read_failed" });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
