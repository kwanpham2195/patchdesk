import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Hash an owned, already-validated review artifact without exposing its contents. */
export async function contentHash(path: string): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  return content === undefined ? "" : createHash("sha256").update(content).digest("hex");
}
