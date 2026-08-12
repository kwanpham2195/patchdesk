import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Hash exact already-validated review bytes without exposing them to callers. */
export function hashReviewArtifactContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hash an owned, already-validated review artifact without exposing its contents. */
export async function contentHash(path: string): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  return content === undefined ? "" : hashReviewArtifactContent(content);
}
