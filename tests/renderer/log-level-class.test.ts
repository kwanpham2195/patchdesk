import { describe, expect, it } from "vitest";

import { levelClass } from "../../src/renderer/src/components/logs-panel";
import type { LogLevel } from "../../src/domain/log-entry";

/**
 * The semantic status tokens a log level may be rendered in. Written out here
 * rather than imported, so the test pins the token each level gets instead of
 * restating whatever the component happens to hold.
 */
const cases: ReadonlyArray<[LogLevel, string]> = [
  ["error", "text-destructive"],
  ["warn", "text-status-warning"],
  ["info", "text-status-info"],
  ["debug", "text-muted-foreground"],
];

describe("levelClass", () => {
  it.each(cases)("gives %s the %s semantic token", (level, token) => {
    expect(levelClass(level)).toBe(token);
  });

  it("gives every level a distinct token, so two severities never look alike", () => {
    const tokens = cases.map(([level]) => levelClass(level));
    expect(new Set(tokens).size).toBe(cases.length);
  });

  it("never falls back to a raw colour value outside the semantic scale", () => {
    for (const [level] of cases) {
      expect(levelClass(level)).toMatch(/^text-(destructive|status-|muted-)/);
    }
  });
});
