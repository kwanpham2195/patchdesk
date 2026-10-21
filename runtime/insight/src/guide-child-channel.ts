import { Socket } from "node:net";

import type { InsightArtifactRunId } from "#app/domain/insight-artifact-scalars";

import {
  encodeGuideFrameLine,
  guideAppReplySchema,
  parseGuideFrameLine,
  type GuideAppOutcome,
  type GuideChildFrame,
} from "#app/domain/guide-protocol";

/** The identity the app issued for this connection; every request repeats it and every reply must match it. */
export type GuideConnectionIdentity = {
  readonly runId: InsightArtifactRunId;
  readonly generation: number;
  readonly cancelEpoch: number;
  readonly connection: string;
};

type Distribute<T> = T extends unknown
  ? Omit<T, keyof GuideConnectionIdentity | "correlation">
  : never;
/** A request without the fields the channel adds itself. */
type GuideChannelRequest = Distribute<GuideChildFrame>;

/** The channel failed (closed, mismatched or oversized); the run cannot continue safely. */
export class GuideChannelError extends Error {
  constructor(readonly reason: "closed" | "frame_too_large" | "protocol") {
    super(`Guide channel ${reason}`);
  }
}

export type GuideChannel = {
  /** Sends one request and resolves with the app's answer to exactly that request. */
  call(request: GuideChannelRequest): Promise<GuideAppOutcome>;
  close(): void;
};

/** Opens the private channel the app attached as descriptor 3; there is no other way to reach the app. */
export function openGuideChannel(
  identity: GuideConnectionIdentity,
  descriptor = 3,
): GuideChannel {
  const socket = new Socket({ fd: descriptor, readable: true, writable: true });
  socket.setEncoding("utf8");
  const pending = new Map<
    number,
    {
      resolve: (outcome: GuideAppOutcome) => void;
      reject: (error: GuideChannelError) => void;
    }
  >();
  let correlation = 0;
  let closed = false;
  let buffered = "";
  const failAll = (reason: GuideChannelError["reason"]): void => {
    closed = true;
    for (const waiter of pending.values())
      waiter.reject(new GuideChannelError(reason));
    pending.clear();
  };
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const reply = parseGuideFrameLine(guideAppReplySchema, line);
      const waiter =
        reply._tag === "ok" ? pending.get(reply.value.correlation) : undefined;
      if (
        reply._tag === "err" ||
        waiter === undefined ||
        reply.value.runId !== identity.runId ||
        reply.value.generation !== identity.generation ||
        reply.value.cancelEpoch !== identity.cancelEpoch ||
        reply.value.connection !== identity.connection
      ) {
        failAll("protocol");
        socket.destroy();
        return;
      }
      pending.delete(reply.value.correlation);
      waiter.resolve(reply.value.outcome);
    }
  });
  socket.on("close", () => failAll("closed"));
  socket.on("error", () => failAll("closed"));
  return {
    call(request) {
      if (closed) return Promise.reject(new GuideChannelError("closed"));
      correlation += 1;
      const line = encodeGuideFrameLine({
        ...request,
        ...identity,
        correlation,
      });
      // An oversized frame never reaches the app and consumes no correlation answer.
      if (line._tag === "err")
        return Promise.reject(new GuideChannelError("frame_too_large"));
      return new Promise((resolve, reject) => {
        pending.set(correlation, { resolve, reject });
        socket.write(`${line.value}\n`);
      });
    },
    close() {
      failAll("closed");
      socket.destroy();
    },
  };
}
