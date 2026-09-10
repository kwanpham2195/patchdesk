import { describe, expect, it } from "vitest";

import {
  formatCompactRelativeTime,
  formatRelativeTime,
} from "../../src/renderer/src/lib/relative-time";

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

describe("formatCompactRelativeTime", () => {
  it("counts seconds under a minute", () => {
    expect(formatCompactRelativeTime(secondsBefore(1), now)).toBe("1s");
    expect(formatCompactRelativeTime(secondsBefore(59), now)).toBe("59s");
  });

  it("switches to minutes at sixty seconds", () => {
    expect(formatCompactRelativeTime(secondsBefore(60), now)).toBe("1m");
    expect(formatCompactRelativeTime(secondsBefore(59 * 60 + 59), now)).toBe(
      "59m",
    );
  });

  it("switches to hours at sixty minutes", () => {
    expect(formatCompactRelativeTime(secondsBefore(3_600), now)).toBe("1h");
    expect(
      formatCompactRelativeTime(secondsBefore(23 * 3_600 + 3_599), now),
    ).toBe("23h");
  });

  it("names the day before at twenty-four hours", () => {
    expect(formatCompactRelativeTime(secondsBefore(86_400), now)).toBe(
      "yesterday",
    );
    expect(formatCompactRelativeTime(secondsBefore(2 * 86_400), now)).toBe(
      "2d",
    );
    expect(formatCompactRelativeTime(secondsBefore(14 * 86_400), now)).toBe(
      "14d",
    );
  });

  it("rolls over to weeks at twenty-eight days", () => {
    expect(formatCompactRelativeTime(secondsBefore(27 * 86_400), now)).toBe(
      "27d",
    );
    expect(formatCompactRelativeTime(secondsBefore(28 * 86_400), now)).toBe(
      "4w",
    );
    expect(formatCompactRelativeTime(secondsBefore(30 * 86_400), now)).toBe(
      "4w",
    );
    expect(formatCompactRelativeTime(secondsBefore(147 * 86_400), now)).toBe(
      "21w",
    );
  });

  it("clamps the present and the future to now", () => {
    expect(formatCompactRelativeTime(secondsBefore(0), now)).toBe("now");
    expect(formatCompactRelativeTime(secondsBefore(-90), now)).toBe("now");
  });

  it("returns an unreadable value as given", () => {
    expect(formatCompactRelativeTime("not a date", now)).toBe("not a date");
  });
});
