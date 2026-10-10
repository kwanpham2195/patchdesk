// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseGitHubThreadId } from "#src/domain/ids";
import type { ConversationThreadCardData } from "#src/renderer/src/components/conversation-thread-card";
import { useConversationThreadActions } from "#src/renderer/src/hooks/use-conversation-thread-actions";

const parsed = parseGitHubThreadId("thread-1");
if (parsed._tag !== "ok") throw new Error("Invalid fixture thread");
const threadId = parsed.value;
afterEach(cleanup);

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Missing resolve");
  };
  let reject: (cause: Error) => void = () => {
    throw new Error("Missing reject");
  };
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

it.each(["open", "resolved"] as const)(
  "admits one state change from %s before rerender and blocks replies until settlement",
  async (state) => {
    const request = deferred<void>();
    const states: Array<{ id: string; state: string }> = [];
    const replies: string[] = [];
    const thread: ConversationThreadCardData = {
      target: { _tag: "thread", id: threadId },
      state,
      comments: [],
      onSetState: (id, next) => {
        states.push({ id, state: next });
        return request.promise;
      },
      onReply: async (_id, body) => {
        replies.push(body);
      },
    };
    const controls = renderHook(() =>
      useConversationThreadActions(thread, () => undefined),
    );
    act(() => controls.result.current.setReplyBody("Preserved reply draft"));
    const current = controls.result.current;
    let sending = Promise.resolve();
    act(() => {
      sending = current.setThreadState();
      void current.setThreadState();
      void current.reply();
    });
    expect(states).toEqual([
      { id: "thread-1", state: state === "open" ? "resolved" : "open" },
    ]);
    expect(replies).toEqual([]);
    expect(controls.result.current.busy).toBe(true);
    expect(controls.result.current.replyBody).toBe("Preserved reply draft");
    await act(async () => {
      request.resolve(undefined);
      await sending;
    });
    expect(controls.result.current.busy).toBe(false);
    expect(controls.result.current.replyBody).toBe("Preserved reply draft");
  },
);

it("admits one reply before rerender, blocks state changes and preserves the draft after failure", async () => {
  const request = deferred<string | void>();
  const replies: Array<{ id: string; body: string }> = [];
  const states: string[] = [];
  const published: string[] = [];
  const thread: ConversationThreadCardData = {
    target: { _tag: "thread", id: threadId },
    state: "open",
    comments: [],
    onReply: (id, body) => {
      replies.push({ id, body });
      return request.promise;
    },
    onSetState: async (_id, state) => {
      states.push(state);
    },
  };
  const controls = renderHook(() =>
    useConversationThreadActions(thread, (reply) => {
      published.push(reply.id);
    }),
  );
  act(() => controls.result.current.setReplyBody("Reply while waiting"));
  const current = controls.result.current;
  let sending = Promise.resolve();
  act(() => {
    sending = current.reply();
    void current.reply();
    void current.setThreadState();
  });
  expect(replies).toEqual([{ id: "thread-1", body: "Reply while waiting" }]);
  expect(states).toEqual([]);
  expect(controls.result.current.busy).toBe(true);
  await act(async () => {
    request.reject(new Error("Reply failed"));
    await sending;
  });
  expect(controls.result.current.replyError).toBeDefined();
  expect(controls.result.current.replyBody).toBe("Reply while waiting");
  expect(controls.result.current.busy).toBe(false);
  expect(published).toEqual([]);
});

it("publishes the submitted reply while preserving text entered before confirmation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  try {
    const request = deferred<string | void>();
    const published: Array<{ body: string; createdAt: string }> = [];
    const controls = renderHook(() =>
      useConversationThreadActions(
        {
          target: { _tag: "thread", id: threadId },
          state: "open",
          comments: [],
          onReply: () => request.promise,
        },
        (reply) => {
          published.push(reply);
        },
      ),
    );
    act(() => controls.result.current.setReplyBody("Submitted"));
    let sending = Promise.resolve();
    act(() => {
      sending = controls.result.current.reply();
    });
    act(() => controls.result.current.setReplyBody("Newer text"));
    await act(async () => {
      request.resolve("reply-1");
      await sending;
    });
    expect(published).toEqual([
      expect.objectContaining({
        body: "Submitted",
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    ]);
    expect(controls.result.current.replyBody).toBe("Newer text");
    expect(controls.result.current.busy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
