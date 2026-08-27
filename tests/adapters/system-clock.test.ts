import { describe, expect, it, vi, afterEach } from "vitest";

import { systemNow } from "../../src/adapters/process/system-clock";
import { parseIsoTimestamp } from "../../src/domain/ids";

// `systemNow` is the one place the wall clock becomes a branded
// `IsoTimestamp` without going through `parseIsoTimestamp`; it asserts the
// format instead of checking it. These cases hold that assertion to the exact
// syntax `parseIsoTimestamp` accepts, so a rewrite that reached for a
// different `Date` formatting (`toString`, `toUTCString`, epoch millis, a
// second-precision ISO string) fails here rather than writing an unparseable
// timestamp into a durable artifact.
describe("systemNow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces a value the durable-timestamp parser accepts", () => {
    expect(parseIsoTimestamp(systemNow())._tag).toBe("ok");
  });

  it("reports the current instant, not a fixed or truncated one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T05:06:07.008Z"));

    expect(systemNow()).toBe("2026-03-04T05:06:07.008Z");
  });
});
