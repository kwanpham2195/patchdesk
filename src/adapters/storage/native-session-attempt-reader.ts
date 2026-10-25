import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  nativeSessionAttemptSchema,
  nativeSessionAttemptDetailsSchema,
  type NativeSessionAttempt,
} from "#src/domain/native-session-attempt";
import type { InsightRunId } from "#src/domain/ids";
import { containsSensitiveValue } from "./json-file";
import { evidencePathIsOwned } from "./insight-evidence-validation";

export const MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES = 16 * 1024;

/** Reads one owned metadata descriptor and strips private archive locators. */
export async function readNativeSessionAttemptDetails(
  directory: string,
  name: string,
  scope: {
    readonly runId: InsightRunId;
    readonly type: NativeSessionAttempt["type"];
  },
): Promise<
  v.InferOutput<typeof nativeSessionAttemptDetailsSchema> | undefined
> {
  const attemptDirectory = join(directory, name);
  const directoryStat = await lstat(attemptDirectory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o077) !== 0
  )
    return undefined;
  const path = join(attemptDirectory, "attempt.json");
  if (!(await evidencePathIsOwned(directory, path))) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      return undefined;
    const buffer = Buffer.alloc(MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (
      bytes > MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES ||
      bytes !== stat.size
    )
      return undefined;
    const value: unknown = JSON.parse(
      buffer.subarray(0, bytes).toString("utf8"),
    );
    const parsed = v.safeParse(nativeSessionAttemptSchema, value);
    if (
      !parsed.success ||
      parsed.output.attemptId !== name ||
      String(parsed.output.runId) !== String(scope.runId) ||
      parsed.output.type !== scope.type ||
      containsSensitiveValue(parsed.output)
    )
      return undefined;
    const safe = v.parse(
      nativeSessionAttemptDetailsSchema,
      Object.fromEntries(
        Object.entries(parsed.output).filter(
          ([key]) => key !== "historyFile" && key !== "locator",
        ),
      ),
    );
    return safe;
  } finally {
    await file.close();
  }
}
