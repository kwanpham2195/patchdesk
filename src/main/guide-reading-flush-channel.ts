import * as v from "valibot";
import type { DesktopOrderlyClose } from "./desktop-orderly-close";
import {
  GUIDE_READING_FLUSH_REQUEST_CHANNEL,
  GUIDE_READING_FLUSH_ACK_CHANNEL,
} from "./ipc-contract";

const requestSchema = v.variant("phase", [
  v.strictObject({
    requestId: v.pipe(v.string(), v.minLength(1)),
    phase: v.literal("inspect"),
  }),
  v.strictObject({
    requestId: v.pipe(v.string(), v.minLength(1)),
    phase: v.literal("admit"),
    approvedDraftRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    approvedRendererId: v.pipe(v.string(), v.minLength(1)),
    retryReading: v.optional(v.boolean()),
  }),
]);
const receiptSchema = v.strictObject({
  saved: v.boolean(),
  state: v.picklist(["clear", "dirty_draft", "write_pending"]),
  draftRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rendererId: v.pipe(v.string(), v.minLength(1)),
});
const ackSchema = v.strictObject({
  requestId: v.pipe(v.string(), v.minLength(1)),
  ...receiptSchema.entries,
});
/** Main-issued identity and admission phase; no review text crosses IPC. */
export type GuideReadingFlushRequest = v.InferOutput<typeof requestSchema>;
/** Acknowledged renderer guard after inspection or saving. */
export type GuideReadingAdmission = v.InferOutput<typeof receiptSchema>;
/** Completion receipt accepted only from the requested main frame. */
export type GuideReadingFlushAck = v.InferOutput<typeof ackSchema>;
type FlushTarget = {
  readonly id: number;
  readonly mainFrame: {
    readonly routingId: number;
    readonly processId: number;
  };
  isDestroyed(): boolean;
  send(channel: string, request: GuideReadingFlushRequest): void;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
};
type AckEvent = {
  readonly sender: { readonly id: number };
  readonly senderFrame: {
    readonly routingId: number;
    readonly processId: number;
  } | null;
};
type FlushHost<Event extends AckEvent> = {
  on(
    channel: string,
    handler: (event: Event, ack: GuideReadingFlushAck) => void,
  ): void;
  off(
    channel: string,
    handler: (event: Event, ack: GuideReadingFlushAck) => void,
  ): void;
};

/** A send-only receipt, replaced frame, timeout or destroyed sender cannot admit teardown. */
export function requestGuideReadingFlush<Event extends AckEvent>(
  host: FlushHost<Event>,
  target: FlushTarget,
  request: GuideReadingFlushRequest,
  timeoutMs: number,
): Promise<GuideReadingAdmission | undefined> {
  if (target.isDestroyed()) return Promise.resolve(undefined);
  const frameId = target.mainFrame.routingId;
  const frameProcess = target.mainFrame.processId;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (receipt: GuideReadingAdmission | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.off(GUIDE_READING_FLUSH_ACK_CHANNEL, acknowledge);
      target.off("destroyed", destroyed);
      resolve(receipt);
    };
    const destroyed = (): void => finish(undefined);
    const acknowledge = (event: Event, ack: GuideReadingFlushAck): void => {
      const parsed = v.safeParse(ackSchema, ack);
      if (
        !parsed.success ||
        parsed.output.requestId !== request.requestId ||
        event.sender.id !== target.id ||
        event.senderFrame?.routingId !== frameId ||
        event.senderFrame?.processId !== frameProcess ||
        target.isDestroyed() ||
        target.mainFrame.routingId !== frameId ||
        target.mainFrame.processId !== frameProcess
      )
        return;
      const { requestId: _requestId, ...receipt } = parsed.output;
      finish(receipt);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    host.on(GUIDE_READING_FLUSH_ACK_CHANNEL, acknowledge);
    target.once("destroyed", destroyed);
    try {
      target.send(GUIDE_READING_FLUSH_REQUEST_CHANNEL, request);
    } catch {
      finish(undefined);
    }
  });
}

/** Keeps inspection and final admission bound to the same renderer lifetime. */
export function guideReadingAdmissionRequests<Event extends AckEvent>(
  host: FlushHost<Event>,
  renderer: () => FlushTarget | undefined,
  nextRequestId: () => string,
  timeoutMs: number,
): Pick<
  ConstructorParameters<typeof DesktopOrderlyClose>[0],
  "inspect" | "flushReading"
> {
  let inspectedTarget: FlushTarget | undefined;
  let inspectedFrame: number | undefined;
  let inspectedProcess: number | undefined;
  return {
    async inspect() {
      inspectedTarget = renderer();
      inspectedFrame = inspectedTarget?.mainFrame.routingId;
      inspectedProcess = inspectedTarget?.mainFrame.processId;
      return inspectedTarget === undefined
        ? {
            saved: true,
            state: "clear",
            draftRevision: 0,
            rendererId: "no-window",
          }
        : requestGuideReadingFlush(
            host,
            inspectedTarget,
            { requestId: nextRequestId(), phase: "inspect" },
            timeoutMs,
          );
    },
    async flushReading(approval, retryReading) {
      const target = renderer();
      if (
        target !== inspectedTarget ||
        target?.mainFrame.routingId !== inspectedFrame ||
        target?.mainFrame.processId !== inspectedProcess
      )
        return undefined;
      return target === undefined
        ? {
            saved: true,
            state: "clear",
            draftRevision: 0,
            rendererId: "no-window",
          }
        : requestGuideReadingFlush(
            host,
            target,
            {
              requestId: nextRequestId(),
              phase: "admit",
              approvedDraftRevision: approval.draftRevision,
              approvedRendererId: approval.rendererId,
              retryReading,
            },
            timeoutMs,
          );
    },
  };
}

type FlushReceiver<Event> = {
  on(
    channel: string,
    handler: (event: Event, request: GuideReadingFlushRequest) => void,
  ): void;
  off(
    channel: string,
    handler: (event: Event, request: GuideReadingFlushRequest) => void,
  ): void;
  send(channel: string, ack: GuideReadingFlushAck): void;
};

/** Preload forwards current guard evidence only after the requested operation settles. */
export function subscribeToGuideReadingFlush<Event>(
  receiver: FlushReceiver<Event>,
  listener: (
    request: GuideReadingFlushRequest,
  ) => Promise<GuideReadingAdmission>,
): () => void {
  let subscribed = true;
  const handler = (_event: Event, request: GuideReadingFlushRequest): void => {
    const parsed = v.safeParse(requestSchema, request);
    if (!parsed.success) return;
    void Promise.resolve()
      .then(() => listener(parsed.output))
      .then((receipt) => {
        const parsedReceipt = v.safeParse(receiptSchema, receipt);
        if (subscribed && parsedReceipt.success)
          receiver.send(GUIDE_READING_FLUSH_ACK_CHANNEL, {
            requestId: parsed.output.requestId,
            ...parsedReceipt.output,
          });
      })
      .catch(() => {
        // No receipt is safer than inventing a clear guard after a failed renderer callback.
      });
  };
  receiver.on(GUIDE_READING_FLUSH_REQUEST_CHANNEL, handler);
  return () => {
    subscribed = false;
    receiver.off(GUIDE_READING_FLUSH_REQUEST_CHANNEL, handler);
  };
}
