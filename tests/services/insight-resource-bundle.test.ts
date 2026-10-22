import { expect, it } from "vitest";
import { ok } from "#src/domain/result";
import { createInProcessInsightResourceBundle } from "#src/services/insight-resource-bundle";

it("queues UI reads in order and removes an aborted waiter at capacity", async () => {
  // Regression for #821: concurrent Walkthrough reads were refused instead of queued.
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const resources = createInProcessInsightResourceBundle(
    undefined,
    async (_root, path) => {
      started.push(path);
      await new Promise<void>((resolve) => releases.push(resolve));
      return ok(new Uint8Array());
    },
  );
  try {
    const active = Array.from({ length: 4 }, (_, i) =>
      resources.uiReader("root", `active-${i}`),
    );
    const controller = new AbortController();
    const aborted = resources.withReadSignal(controller.signal, () =>
      resources.uiReader("root", "aborted"),
    );
    const first = resources.uiReader("root", "first");
    const second = resources.uiReader("root", "second");
    expect(started).toEqual(["active-0", "active-1", "active-2", "active-3"]);
    controller.abort();
    expect(await aborted).toEqual({
      _tag: "err",
      error: { _tag: "StorageFailure", operation: "read", reason: "io" },
    });
    releases.shift()?.();
    await active[0];
    expect(started.at(-1)).toBe("first");
    releases.shift()?.();
    await active[1];
    expect(started.at(-1)).toBe("second");
    for (const release of releases.splice(0)) release();
    expect(
      (await Promise.all([...active, first, second])).every(
        (result) => result._tag === "ok",
      ),
    ).toBe(true);
    const drained = resources.uiReader("root", "drained");
    expect(started.at(-1)).toBe("drained");
    releases.shift()?.();
    expect(await drained).toEqual(ok(new Uint8Array()));
    expect(started).not.toContain("aborted");
  } finally {
    for (const release of releases.splice(0)) release();
    await resources.dispose();
  }
});
