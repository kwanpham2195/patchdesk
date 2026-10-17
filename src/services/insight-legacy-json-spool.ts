import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { LegacyJsonTokenizer } from "./insight-legacy-json-tokenizer";

/** Lexical spool statistics are not source-schema acceptance or conversion evidence. */
export type LegacyJsonSpool = {
  readonly tokens: number;
  readonly decodedCodeUnits: number;
  readonly sourceHash: string;
  readonly sourceBytes: number;
};

/** Writes bounded private NDJSON events, preserving fragments instead of rebuilding a JSON value. */
export async function spoolLegacyJson(
  source: FileHandle,
  destination: FileHandle,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LegacyJsonSpool> {
  const tokenizer = new LegacyJsonTokenizer();
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(16384);
  let tokens = 0;
  let decodedCodeUnits = 0;
  let sourceBytes = 0;
  const hash = createHash("sha256");
  for (;;) {
    options.signal?.throwIfAborted();
    const read = await source.read(buffer, 0, buffer.length, sourceBytes);
    hash.update(buffer.subarray(0, read.bytesRead));
    sourceBytes += read.bytesRead;
    if (!Number.isSafeInteger(sourceBytes))
      throw new RangeError("Legacy JSON byte count exhausted");
    const chunk =
      read.bytesRead === 0
        ? decoder.end()
        : decoder.write(buffer.subarray(0, read.bytesRead));
    decodedCodeUnits += chunk.length;
    if (!Number.isSafeInteger(decodedCodeUnits))
      throw new RangeError("Legacy JSON code-unit count exhausted");
    for (const token of tokenizer.write(chunk)) {
      options.signal?.throwIfAborted();
      await destination.writeFile(`${JSON.stringify(token)}\n`, "utf8");
      tokens += 1;
      if (!Number.isSafeInteger(tokens))
        throw new RangeError("Legacy JSON token count exhausted");
    }
    if (read.bytesRead === 0) break;
  }
  for (const token of tokenizer.finish()) {
    options.signal?.throwIfAborted();
    await destination.writeFile(`${JSON.stringify(token)}\n`, "utf8");
    tokens += 1;
    if (!Number.isSafeInteger(tokens))
      throw new RangeError("Legacy JSON token count exhausted");
  }
  return {
    tokens,
    decodedCodeUnits,
    sourceHash: hash.digest("hex"),
    sourceBytes,
  };
}
