import { createHash } from "node:crypto";
import type * as v from "valibot";

import {
  EXPLANATION_MAX_REQUEST_BYTES,
  EXPLANATION_REQUEST_CHUNK_BYTES,
  type explanationRequestChunkSchema,
  type explanationRequestCommitSchema,
} from "#src/domain/explanation-channel";
import { err, ok, type Result } from "#src/domain/result";

type StagedRequest = {
  readonly handle: number;
  readonly totalBytes: number;
  readonly chunks: Buffer[];
  received: number;
};

/** One connection owns one unfinished exact request body; a new open replaces the previous handle. */
export class ExplanationRequestStaging {
  private staged: StagedRequest | undefined;
  private nextHandle = 1;

  open(
    totalBytes: number,
  ):
    | { readonly status: "handle"; readonly handle: number }
    | { readonly status: "refused"; readonly reason: "too_large" } {
    if (totalBytes > EXPLANATION_MAX_REQUEST_BYTES)
      return { status: "refused", reason: "too_large" };
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.staged = { handle, totalBytes, chunks: [], received: 0 };
    return { status: "handle", handle };
  }

  chunk(
    frame: v.InferOutput<typeof explanationRequestChunkSchema>,
  ):
    | { readonly status: "stored" }
    | { readonly status: "refused"; readonly reason: "invalid_input" } {
    const staged = this.staged;
    if (staged === undefined || staged.handle !== frame.handle)
      return { status: "refused", reason: "invalid_input" };
    const bytes = Buffer.from(frame.data, "base64");
    if (
      frame.offset !== staged.received ||
      bytes.length === 0 ||
      bytes.length > EXPLANATION_REQUEST_CHUNK_BYTES ||
      staged.received + bytes.length > staged.totalBytes
    ) {
      this.staged = undefined;
      return { status: "refused", reason: "invalid_input" };
    }
    staged.chunks.push(bytes);
    staged.received += bytes.length;
    return { status: "stored" };
  }

  /** Consumes the handle even on refusal; durable dispatch admission remains the caller's responsibility. */
  take(
    frame: v.InferOutput<typeof explanationRequestCommitSchema>,
  ): Result<string, "invalid_input" | "unsupported"> {
    const staged = this.staged;
    this.staged = undefined;
    if (
      staged === undefined ||
      staged.handle !== frame.handle ||
      staged.received !== staged.totalBytes ||
      frame.bytes !== staged.totalBytes
    )
      return err("invalid_input");
    const body = Buffer.concat(staged.chunks);
    if (createHash("sha256").update(body).digest("hex") !== frame.sha256)
      return err("invalid_input");
    try {
      return ok(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      );
    } catch {
      return err("unsupported");
    }
  }
}
