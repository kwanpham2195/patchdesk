import { createHash } from "node:crypto";
import * as v from "valibot";

import { insightArtifactHashSchema } from "#app/domain/insight-artifact-scalars";
import {
  GUIDE_REQUEST_CHUNK_BYTES,
  type GuideRefusalReason,
} from "#app/domain/guide-protocol";
import { GuideChannelError, type GuideChannel } from "./guide-child-channel";

/** Provider APIs whose installed pi-ai adapter passes `options.fetch` to the SDK client that performs the HTTP request. */
export const GUIDE_FETCH_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);

/** The app declined, or the route cannot be recorded; nothing was sent. */
export class GuideDispatchRefused extends Error {
  constructor(
    readonly reason:
      | GuideRefusalReason
      | "unsupported_route"
      | "unsupported_body"
      | "channel"
      | "unknown"
      | "finished"
      | "concurrent",
  ) {
    super(`Guide dispatch refused: ${reason}`);
  }
}

type FetchFunction = typeof globalThis.fetch;

/** Shared by the tools and the fetch hook: writing closed, the app's outcome unknown, a sent request unconfirmed. */
export type GuideSessionState = {
  finished: boolean;
  /** The app could not say whether a call or admission was recorded; nothing more is requested or sent. */
  halted: boolean;
  /** A permitted request was handed to the network and no complete response was confirmed, so its effect is unknown. */
  unconfirmed: boolean;
};

/**
 * Wraps the SDK's fetch. The exact string body about to go on the wire is staged to the app in bounded chunks, the
 * app records it and its hash durably, and only after the app's permission names the same hash and length does the real
 * fetch run with that very body. Headers, URL and credentials never leave this process. A body that is not a string
 * (a stream, a form) cannot be recorded exactly and is refused before any network use; there is no fallback.
 */
export function createRecordedFetch(
  channel: GuideChannel,
  state: GuideSessionState,
  baseFetch: FetchFunction = globalThis.fetch,
): FetchFunction {
  let inFlight = false;
  return async (input, init) => {
    if (state.finished) throw new GuideDispatchRefused("finished");
    if (state.halted || state.unconfirmed)
      throw new GuideDispatchRefused("unknown");
    const parsedBody = v.safeParse(v.string(), init?.body);
    if (!parsedBody.success) throw new GuideDispatchRefused("unsupported_body");
    const body = parsedBody.output;
    // Each recorded request is the only one on this connection until its response has been consumed.
    if (inFlight) throw new GuideDispatchRefused("concurrent");
    inFlight = true;
    try {
      const bytes = Buffer.from(body, "utf8");
      const digest = v.parse(
        insightArtifactHashSchema,
        createHash("sha256").update(bytes).digest("hex"),
      );
      const opened = await call(channel, {
        kind: "request_open",
        totalBytes: Math.max(1, bytes.length),
      });
      if (opened.status !== "handle") throw refusedBy(state, opened);
      for (
        let offset = 0;
        offset < bytes.length;
        offset += GUIDE_REQUEST_CHUNK_BYTES
      ) {
        const chunk = bytes.subarray(
          offset,
          offset + GUIDE_REQUEST_CHUNK_BYTES,
        );
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- chunks must arrive in offset order
        const stored = await call(channel, {
          kind: "request_chunk",
          handle: opened.handle,
          offset,
          data: chunk.toString("base64"),
        });
        if (stored.status !== "stored") throw refusedBy(state, stored);
      }
      const permission = await call(channel, {
        kind: "request_commit",
        handle: opened.handle,
        sha256: digest,
        bytes: Math.max(1, bytes.length),
      });
      if (
        permission.status !== "permission" ||
        permission.sha256 !== digest ||
        permission.bytes !== Math.max(1, bytes.length)
      )
        throw refusedBy(state, permission);
      if (init?.signal?.aborted === true)
        throw new GuideDispatchRefused("cancelled");
      // Headers do not confirm completion; successful streams are confirmed by the SDK terminal result.
      state.unconfirmed = true;
      const response = await baseFetch(input, init);
      // SDKs may swallow transport aborts; keep read errors unknown even if a partial stream had a stop reason.
      if (response.body === null) {
        if (!response.ok) state.unconfirmed = false;
        return response;
      }
      const reader = response.body.getReader();
      let cancelled = false;
      const responseBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (cancelled) return;
            if (part.done) {
              if (!response.ok) state.unconfirmed = false;
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(part.value);
          } catch (cause) {
            if (cancelled) return;
            state.halted = true;
            reader.releaseLock();
            controller.error(cause);
          }
        },
        async cancel(reason) {
          cancelled = true;
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      });
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      inFlight = false;
    }
  };
}

async function call(
  channel: GuideChannel,
  request: Parameters<GuideChannel["call"]>[0],
) {
  try {
    return await channel.call(request);
  } catch (cause: unknown) {
    throw cause instanceof GuideChannelError
      ? new GuideDispatchRefused("channel")
      : cause;
  }
}

function refusedBy(
  state: GuideSessionState,
  outcome: { readonly status: string; readonly reason?: GuideRefusalReason },
): GuideDispatchRefused {
  if (outcome.status === "unknown") {
    state.halted = true;
    return new GuideDispatchRefused("unknown");
  }
  return refused(outcome);
}

function refused(outcome: {
  readonly status: string;
  readonly reason?: GuideRefusalReason;
}): GuideDispatchRefused {
  return new GuideDispatchRefused(
    outcome.status === "refused" && outcome.reason !== undefined
      ? outcome.reason
      : "channel",
  );
}
