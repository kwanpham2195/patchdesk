import { Socket } from "node:net";

import type * as v from "valibot";

import {
  encodeExplanationFrameLine,
  parseExplanationFrameLine,
  type ExplanationConnectionIdentity,
  type ExplanationFrameIdentity,
} from "#app/domain/explanation-channel";

/** The channel failed (closed, mismatched or oversized); the run cannot continue safely. */
export class ExplanationChannelError extends Error {
  constructor(readonly reason: "closed" | "frame_too_large" | "protocol") {
    super(`Guide channel ${reason}`);
  }
}

export type ExplanationChannel<TRequest, TOutcome> = {
  /** Sends one request and resolves with the app's answer to exactly that request. */
  call(request: TRequest): Promise<TOutcome>;
  close(): void;
};

/** Opens the private channel the app attached as descriptor 3; there is no other way to reach the app. */
export function openExplanationChannel<
  TRequest extends { readonly kind: string },
  TOutcome,
>(
  identity: ExplanationConnectionIdentity,
  replySchema: v.GenericSchema<
    unknown,
    ExplanationFrameIdentity & { readonly outcome: TOutcome }
  >,
  descriptor = 3,
): ExplanationChannel<TRequest, TOutcome> {
  const socket = new Socket({ fd: descriptor, readable: true, writable: true });
  socket.setEncoding("utf8");
  const pending = new Map<
    number,
    {
      resolve: (outcome: TOutcome) => void;
      reject: (error: ExplanationChannelError) => void;
    }
  >();
  let correlation = 0;
  let closed = false;
  let buffered = "";
  const failAll = (reason: ExplanationChannelError["reason"]): void => {
    closed = true;
    for (const waiter of pending.values())
      waiter.reject(new ExplanationChannelError(reason));
    pending.clear();
  };
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const reply = parseExplanationFrameLine(replySchema, line);
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
      if (closed) return Promise.reject(new ExplanationChannelError("closed"));
      correlation += 1;
      const line = encodeExplanationFrameLine({
        ...request,
        ...identity,
        correlation,
      });
      // An oversized frame never reaches the app and consumes no correlation answer.
      if (line._tag === "err")
        return Promise.reject(new ExplanationChannelError("frame_too_large"));
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
