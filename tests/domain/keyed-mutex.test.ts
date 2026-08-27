import { describe, expect, it } from "vitest";

import { KeyedMutex } from "../../src/domain/keyed-mutex";

/** A promise a test releases by hand, to park one operation inside the lock. */
type Barrier = {
  readonly wait: Promise<void>;
  readonly release: () => void;
};

function barrier(): Barrier {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release?.() } satisfies Barrier;
}

describe("KeyedMutex", () => {
  it("runs an uncontended operation without yielding first", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const run = mutex.run("key", async () => {
      events.push("started");
    });

    // `ReviewOperationCoordinator` callers depend on this: a free key must not
    // cost a microtask, or a command that only wanted to check the lock would
    // observe the map before the operation was placed in it.
    expect(events).toEqual(["started"]);
    await run;
  });

  it("serializes one key while other keys proceed", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const held = barrier();

    const first = mutex.run("a", async () => {
      events.push("a1-start");
      await held.wait;
      events.push("a1-end");
    });
    const second = mutex.run("a", async () => {
      events.push("a2");
    });
    const other = mutex.run("b", async () => {
      events.push("b1");
    });

    expect(events).toEqual(["a1-start", "b1"]);
    held.release();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });

  it("releases the key when the operation throws", async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run("key", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(mutex.run("key", async () => "after")).resolves.toBe("after");
    expect(mutex.tryEnter("key")).toBeTypeOf("function");
  });

  it("is not reentrant: a nested take of the same key never settles", async () => {
    const mutex = new KeyedMutex();
    let nestedRan = false;

    const nested = mutex.run("key", async () =>
      mutex.run("key", async () => {
        nestedRan = true;
      }),
    );
    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => resolve("timed-out"), 50);
    });

    // Reentrancy is what turns a nested lock take from a visible hang into
    // silent corruption, so it stays absent on purpose.
    await expect(Promise.race([nested, timeout])).resolves.toBe("timed-out");
    expect(nestedRan).toBe(false);
  });

  it("tryEnter takes a free key, refuses a held one, and queues run behind it", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const release = mutex.tryEnter("key");
    expect(release).toBeTypeOf("function");
    expect(mutex.tryEnter("key")).toBeUndefined();

    const queued = mutex.run("key", async () => {
      events.push("queued");
    });
    expect(events).toEqual([]);

    release?.();
    await queued;
    expect(events).toEqual(["queued"]);
    expect(mutex.tryEnter("key")).toBeTypeOf("function");
  });

  it("refuses tryEnter while a run holds the key", async () => {
    const mutex = new KeyedMutex();
    const held = barrier();

    const running = mutex.run("key", async () => held.wait);
    expect(mutex.tryEnter("key")).toBeUndefined();

    held.release();
    await running;
    expect(mutex.tryEnter("key")).toBeTypeOf("function");
  });
});
