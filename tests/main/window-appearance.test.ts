import { describe, expect, it } from "vitest";

import { windowBackgroundColor } from "../../src/main/window-appearance";

/**
 * The window is created before any renderer exists, so this mapping is the
 * only thing standing between a stored appearance and the colour the user
 * sees while Patchdesk loads and in the strip a resize exposes.
 */
describe("window background colour", () => {
  it.each([
    { appearance: "light", systemPrefersDark: false, expected: "#f2f0ec" },
    { appearance: "light", systemPrefersDark: true, expected: "#f2f0ec" },
    { appearance: "dark", systemPrefersDark: false, expected: "#040404" },
    { appearance: "dark", systemPrefersDark: true, expected: "#040404" },
    { appearance: "system", systemPrefersDark: false, expected: "#f2f0ec" },
    { appearance: "system", systemPrefersDark: true, expected: "#040404" },
  ] as const)(
    "paints $appearance as $expected when the OS dark preference is $systemPrefersDark",
    ({ appearance, systemPrefersDark, expected }) => {
      expect(windowBackgroundColor(appearance, systemPrefersDark)).toBe(
        expected,
      );
    },
  );
});
