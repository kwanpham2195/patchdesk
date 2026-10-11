import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestGuideReadingFlush,
  guideReadingAdmissionRequests,
  subscribeToGuideReadingFlush,
  type GuideReadingFlushRequest,
  type GuideReadingFlushAck,
} from "#src/main/guide-reading-flush-channel";
import { GUIDE_READING_FLUSH_ACK_CHANNEL } from "#src/main/ipc-contract";

type AckEvent = {
  sender: { id: number };
  senderFrame: { routingId: number; processId: number } | null;
};
type AckHandler = (event: AckEvent, ack: GuideReadingFlushAck) => void;
type RequestHandler = (
  event: undefined,
  request: GuideReadingFlushRequest,
) => void;
function bus() {
  const acknowledgements = new Map<string, Set<AckHandler>>();
  const requests = new Map<string, Set<RequestHandler>>();
  const destroyed = new Set<() => void>();
  const sent: GuideReadingFlushAck[] = [];
  let gone = false;
  const sender = { id: 7, mainFrame: { routingId: 11, processId: 1 } };
  const emit = (
    ack: GuideReadingFlushAck,
    event: AckEvent = {
      sender: { id: sender.id },
      senderFrame: sender.mainFrame,
    },
  ): void => {
    for (const handler of acknowledgements.get(
      GUIDE_READING_FLUSH_ACK_CHANNEL,
    ) ?? [])
      handler(event, ack);
  };
  return {
    emit,
    sent,
    destroy() {
      gone = true;
      for (const handler of destroyed) handler();
    },
    sender,
    host: {
      on(channel: string, handler: AckHandler) {
        const entries = acknowledgements.get(channel) ?? new Set<AckHandler>();
        entries.add(handler);
        acknowledgements.set(channel, entries);
      },
      off(channel: string, handler: AckHandler) {
        acknowledgements.get(channel)?.delete(handler);
      },
    },
    target: {
      ...sender,
      isDestroyed: () => gone,
      send(channel: string, request: GuideReadingFlushRequest) {
        for (const handler of requests.get(channel) ?? [])
          handler(undefined, request);
      },
      once(_event: "destroyed", handler: () => void) {
        destroyed.add(handler);
      },
      off(_event: "destroyed", handler: () => void) {
        destroyed.delete(handler);
      },
    },
    receiver: {
      on(channel: string, handler: RequestHandler) {
        const entries = requests.get(channel) ?? new Set<RequestHandler>();
        entries.add(handler);
        requests.set(channel, entries);
      },
      off(channel: string, handler: RequestHandler) {
        requests.get(channel)?.delete(handler);
      },
      send(_channel: string, ack: GuideReadingFlushAck) {
        sent.push(ack);
        emit(ack);
      },
    },
  };
}
const receipt = {
  saved: true,
  state: "clear",
  draftRevision: 0,
  rendererId: "renderer",
} as const;
afterEach(() => vi.useRealTimers());
describe("Guide reading flush channel", () => {
  it.each(["frame", "process", "target"] as const)(
    "refuses a changed %s between inspection and admission",
    async (replacement) => {
      const ipc = bus();
      const seen: GuideReadingFlushRequest[] = [];
      const stop = subscribeToGuideReadingFlush(
        ipc.receiver,
        async (request) => {
          seen.push(request);
          return receipt;
        },
      );
      let target = ipc.target;
      const admission = guideReadingAdmissionRequests(
        ipc.host,
        () => target,
        () => "bound-close",
        1000,
      );
      const approval = await admission.inspect();
      if (approval === undefined) throw new Error("Missing inspection");
      if (replacement === "frame") ipc.sender.mainFrame.routingId += 1;
      else if (replacement === "process") ipc.sender.mainFrame.processId += 1;
      else target = bus().target;
      expect(await admission.flushReading(approval, false)).toBeUndefined();
      expect(seen.map((request) => request.phase)).toEqual(["inspect"]);
      stop();
    },
  );

  it("passes the approved renderer identity and explicit Retry through the final request", async () => {
    const ipc = bus();
    const seen: GuideReadingFlushRequest[] = [];
    const stop = subscribeToGuideReadingFlush(ipc.receiver, async (request) => {
      seen.push(request);
      return receipt;
    });
    let requestId = 0;
    const admission = guideReadingAdmissionRequests(
      ipc.host,
      () => ipc.target,
      () => `close-${++requestId}`,
      1000,
    );
    const approval = await admission.inspect();
    if (approval === undefined) throw new Error("Missing inspection");
    expect((await admission.flushReading(approval, true))?.saved).toBe(true);
    expect(seen[1]).toMatchObject({
      phase: "admit",
      approvedRendererId: "renderer",
      approvedDraftRevision: 0,
      retryReading: true,
    });
    stop();
  });

  it("waits for saved completion instead of request delivery", async () => {
    const ipc = bus();
    let saved: ((value: boolean) => void) | undefined;
    const saving = new Promise<boolean>((resolve) => {
      saved = resolve;
    });
    const stop = subscribeToGuideReadingFlush(ipc.receiver, async () => ({
      ...receipt,
      saved: await saving,
    }));
    let closed = false;
    const completion = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      {
        requestId: "close-1",
        phase: "admit",
        approvedDraftRevision: 0,
        approvedRendererId: "renderer",
      },
      1000,
    ).then((value) => {
      closed = value?.saved ?? false;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    saved?.(true);
    await completion;
    expect(closed).toBe(true);
    stop();
  });
  it("ignores another sender, a subframe and a stale request before accepting the matching receipt", async () => {
    const ipc = bus();
    let settled = false;
    const saving = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "close-2", phase: "inspect" },
      1000,
    ).then((value) => {
      settled = true;
      return value;
    });
    ipc.emit(
      { requestId: "close-2", ...receipt },
      { sender: { id: 8 }, senderFrame: { routingId: 11, processId: 1 } },
    );
    ipc.emit(
      { requestId: "close-2", ...receipt },
      { sender: { id: 7 }, senderFrame: { routingId: 12, processId: 1 } },
    );
    ipc.emit(
      { requestId: "close-2", ...receipt },
      { sender: { id: 7 }, senderFrame: { routingId: 11, processId: 2 } },
    );
    ipc.emit({ requestId: "close-1", ...receipt });
    await Promise.resolve();
    expect(settled).toBe(false);
    ipc.emit({ requestId: "close-2", ...receipt });
    expect(await saving).toEqual(receipt);
  });
  it("times out and does not let the old receipt settle the retry", async () => {
    vi.useFakeTimers();
    const ipc = bus();
    const first = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "first", phase: "inspect" },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBeUndefined();
    let settled = false;
    const retry = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      {
        requestId: "retry",
        phase: "admit",
        approvedDraftRevision: 0,
        approvedRendererId: "renderer",
      },
      1000,
    ).then((value) => {
      settled = true;
      return value;
    });
    ipc.emit({ requestId: "first", ...receipt });
    await Promise.resolve();
    expect(settled).toBe(false);
    ipc.emit({ requestId: "retry", ...receipt, saved: false });
    expect((await retry)?.saved).toBe(false);
  });
  it("refuses a late old-process receipt even when the routing ID is reused", async () => {
    vi.useFakeTimers();
    const ipc = bus();
    const oldProcess = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "old-process", phase: "inspect" },
      1000,
    );
    ipc.sender.mainFrame.processId = 2;
    ipc.emit(
      { requestId: "old-process", ...receipt },
      { sender: { id: 7 }, senderFrame: { routingId: 11, processId: 1 } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await oldProcess).toBeUndefined();
    const currentProcess = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "current-process", phase: "inspect" },
      1000,
    );
    ipc.emit({ requestId: "current-process", ...receipt });
    expect(await currentProcess).toEqual(receipt);
  });

  it("refuses renderer destruction or frame replacement", async () => {
    vi.useFakeTimers();
    const ipc = bus();
    const replaced = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "old-frame", phase: "inspect" },
      1000,
    );
    ipc.sender.mainFrame.routingId = 12;
    ipc.emit(
      { requestId: "old-frame", ...receipt },
      { sender: { id: 7 }, senderFrame: { routingId: 11, processId: 1 } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await replaced).toBeUndefined();
    const destroyed = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "destroyed", phase: "inspect" },
      1000,
    );
    ipc.destroy();
    expect(await destroyed).toBeUndefined();
    expect(
      await requestGuideReadingFlush(
        ipc.host,
        ipc.target,
        { requestId: "gone", phase: "inspect" },
        1000,
      ),
    ).toBeUndefined();
  });
  it("keeps unexpected review text out of acknowledgement IPC", async () => {
    vi.useFakeTimers();
    const ipc = bus();
    const stop = subscribeToGuideReadingFlush(ipc.receiver, async () => ({
      ...receipt,
      body: "private review text",
    }));
    const saving = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "private-receipt", phase: "inspect" },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await saving).toBeUndefined();
    expect(ipc.sent).toEqual([]);
    stop();
  });

  it("withholds admission after a rejected renderer callback and releases the preload subscription", async () => {
    vi.useFakeTimers();
    const ipc = bus();
    const stop = subscribeToGuideReadingFlush(ipc.receiver, async () => {
      throw new Error("save failed");
    });
    const failure = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "failure", phase: "inspect" },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failure).toBeUndefined();
    stop();
    const afterDisposal = requestGuideReadingFlush(
      ipc.host,
      ipc.target,
      { requestId: "disposed", phase: "inspect" },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await afterDisposal).toBeUndefined();
  });
});
