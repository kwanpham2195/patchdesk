import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deliberatelyDeniedRoutes,
  isAllowedDesktopRequest,
} from "../src/main/desktop-bridge";
import type { LocalApiDesktopRequest } from "../src/main/ipc-contract";

/**
 * Hono route registrations look like `app.get("/v1/foo", ...)` or the
 * multi-line equivalent `app.post(\n  "/v1/foo",\n  ...)`. `\s*` spans the
 * newline in the multi-line form, so both are captured by one pattern.
 */
const ROUTE_REGISTRATION =
  /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function toHttpMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  const method = HTTP_METHODS.find((candidate) => candidate === upper);
  if (method === undefined)
    throw new Error(
      `Unrecognized HTTP method literal "${raw}" found while scanning local-api.ts route registrations`,
    );
  return method;
}

type RegisteredRoute = { readonly method: HttpMethod; readonly path: string };

function registeredLocalApiRoutes(): ReadonlyArray<RegisteredRoute> {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "main", "local-api.ts"),
    "utf8",
  );
  const routes: RegisteredRoute[] = [];
  for (const match of source.matchAll(ROUTE_REGISTRATION)) {
    const rawMethod = match[1];
    const path = match[2];
    if (rawMethod === undefined || path === undefined) continue;
    routes.push({ method: toHttpMethod(rawMethod), path });
  }
  return routes;
}

const denied = [
  { path: `/v1/reviews/${"ba" + "tch"}`, method: "POST" },
  { path: `/v1/reviews/${"r" + "un"}`, method: "POST" },
  { path: "/v1/reviews/complete", method: "POST" },
  { path: "/v1/reviews/models" },
  { path: `/v1/${"r" + "uns"}/review-pr`, method: "POST" },
  // The "add" finding action was removed from local-api.ts; only "dismiss"
  // remains registered (see registeredLocalApiRoutes' scan below). Keeps
  // allowedRoutePatterns from pre-authorizing a deleted GitHub-write route.
  {
    path: "/v1/reviews/insights/analysis/findings/finding-1/add",
    method: "POST",
  },
] satisfies ReadonlyArray<LocalApiDesktopRequest>;

describe("desktop request bridge", () => {
  // Cross-checks the allowlist against what local-api.ts actually
  // registers, rather than mirroring a hand-written list of routes: a route
  // present in both this list and the allowlist could be wrong in both
  // places at once (see commit 5dfc7a6, which fixed this exact class of
  // omission once already). Any route Hono registers that is neither
  // allowlisted nor deliberately denied fails this test by name.
  it("classifies every route local-api.ts registers as bridge-allowed or deliberately denied", () => {
    const routes = registeredLocalApiRoutes();
    // Sanity check on the scan itself: a change to local-api.ts's
    // formatting that silently breaks ROUTE_REGISTRATION would otherwise
    // make this test vacuously pass with zero routes checked.
    expect(routes.length).toBeGreaterThan(40);
    for (const { method, path } of routes) {
      const probePath = path.replace(/:[^/]+/g, "probe-value");
      const recognized =
        isAllowedDesktopRequest({ method, path: probePath }) ||
        deliberatelyDeniedRoutes.has(`${method} ${path}`);
      expect(
        recognized,
        `route "${method} ${path}" is registered in local-api.ts but is neither ` +
          `in allowedRoutes/allowedRoutePatterns nor in deliberatelyDeniedRoutes ` +
          `in src/main/desktop-bridge.ts`,
      ).toBe(true);
    }
  });
  it("rejects deleted non-current Review routes", () => {
    for (const request of denied)
      expect(isAllowedDesktopRequest(request)).toBe(false);
  });
});
