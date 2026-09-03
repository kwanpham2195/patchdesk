import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../../src/renderer/src/lib/relative-time";

const now = Date.parse("2026-09-02T12:00:00.000Z");

function secondsBefore(seconds: number): string {
  return new Date(now - seconds * 1_000).toISOString();
}

describe("formatRelativeTime", () => {
  it("counts seconds under a minute", () => {
    expect(formatRelativeTime(secondsBefore(1), now)).toBe("1 s ago");
    expect(formatRelativeTime(secondsBefore(59), now)).toBe("59 s ago");
  });

  it("switches to minutes at sixty seconds", () => {
    expect(formatRelativeTime(secondsBefore(60), now)).toBe("1 min ago");
    expect(formatRelativeTime(secondsBefore(59 * 60 + 59), now)).toBe(
      "59 min ago",
    );
  });

  it("switches to hours at sixty minutes", () => {
    expect(formatRelativeTime(secondsBefore(3_600), now)).toBe("1 h ago");
    expect(formatRelativeTime(secondsBefore(23 * 3_600 + 3_599), now)).toBe(
      "23 h ago",
    );
  });

  it("switches to days at twenty-four hours", () => {
    expect(formatRelativeTime(secondsBefore(86_400), now)).toBe("1 d ago");
    expect(formatRelativeTime(secondsBefore(14 * 86_400), now)).toBe(
      "14 d ago",
    );
  });

  it("clamps the present and the future to just now", () => {
    expect(formatRelativeTime(secondsBefore(0), now)).toBe("just now");
    expect(formatRelativeTime(secondsBefore(-90), now)).toBe("just now");
  });

  it("returns an unreadable value as given", () => {
    expect(formatRelativeTime("not a date", now)).toBe("not a date");
  });
});
