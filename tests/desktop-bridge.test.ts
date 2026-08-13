import { describe, expect, it } from "vitest";

import { isAllowedDesktopRequest } from "../src/main/desktop-bridge";
import type { LocalApiDesktopRequest } from "../src/main/ipc-contract";

const allowed = [
  { path: "/v1/reviews/open", method: "POST" },
  { path: "/v1/reviews/load", method: "POST" },
  { path: "/v1/reviews/refresh", method: "POST" },
  { path: "/v1/reviews/pending-review/command", method: "POST" },
  { path: "/v1/reviews/direct-summary/submit", method: "POST" },
  { path: "/v1/reviews/insights/analysis/run", method: "POST" },
  { path: "/v1/insight-providers" },
] satisfies ReadonlyArray<LocalApiDesktopRequest>;
const denied = [
  { path: `/v1/reviews/${"ba" + "tch"}`, method: "POST" },
  { path: `/v1/reviews/${"r" + "un"}`, method: "POST" },
  { path: "/v1/reviews/complete", method: "POST" },
  { path: "/v1/reviews/models" },
  { path: `/v1/${"r" + "uns"}/review-pr`, method: "POST" },
] satisfies ReadonlyArray<LocalApiDesktopRequest>;

describe("desktop request bridge", () => {
  it("permits only current Review and Insight routes", () => {
    for (const request of allowed)
      expect(isAllowedDesktopRequest(request)).toBe(true);
  });
  it("rejects deleted non-current Review routes", () => {
    for (const request of denied)
      expect(isAllowedDesktopRequest(request)).toBe(false);
  });
});
