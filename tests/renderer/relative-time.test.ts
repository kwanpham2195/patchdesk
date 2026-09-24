import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../../src/renderer/src/lib/relative-time";

const now = Date.parse("2026-09-02T12:00:00.000Z");

function secondsBefore(seconds: number): string {
  return new Date(now - seconds * 1_000).toISOString();
}

describe("formatRelativeTime", () => {
  it("counts seconds under a minute", () => {
    expect(formatRelativeTime(secondsBefore(1), now)).toBe("1s");
    expect(formatRelativeTime(secondsBefore(59), now)).toBe("59s");
  });

  it("switches to minutes at sixty seconds", () => {
    expect(formatRelativeTime(secondsBefore(60), now)).toBe("1m");
    expect(formatRelativeTime(secondsBefore(59 * 60 + 59), now)).toBe("59m");
  });

  it("switches to hours at sixty minutes", () => {
    expect(formatRelativeTime(secondsBefore(3_600), now)).toBe("1h");
    expect(formatRelativeTime(secondsBefore(23 * 3_600 + 3_599), now)).toBe(
      "23h",
    );
  });

  it("counts elapsed days at twenty-four hours and never names one", () => {
    // A calendar-day word here would contradict the date header a visited row
    // sits under, which buckets by local day rather than elapsed hours.
    expect(formatRelativeTime(secondsBefore(86_400), now)).toBe("1d");
    expect(formatRelativeTime(secondsBefore(2 * 86_400 - 1), now)).toBe("1d");
    expect(formatRelativeTime(secondsBefore(2 * 86_400), now)).toBe("2d");
    expect(formatRelativeTime(secondsBefore(14 * 86_400), now)).toBe("14d");
  });

  it("rolls over to weeks at twenty-eight days", () => {
    expect(formatRelativeTime(secondsBefore(27 * 86_400), now)).toBe("27d");
    expect(formatRelativeTime(secondsBefore(28 * 86_400), now)).toBe("4w");
    expect(formatRelativeTime(secondsBefore(30 * 86_400), now)).toBe("4w");
    expect(formatRelativeTime(secondsBefore(147 * 86_400), now)).toBe("21w");
  });

  it("clamps the present and the future to now", () => {
    expect(formatRelativeTime(secondsBefore(0), now)).toBe("now");
    expect(formatRelativeTime(secondsBefore(-90), now)).toBe("now");
  });

  it("returns an unreadable value as given", () => {
    expect(formatRelativeTime("not a date", now)).toBe("not a date");
  });
});
