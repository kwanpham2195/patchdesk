import type { Hono } from "hono";

import { parseWorkspaceProfileId } from "../../domain/ids";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";

/** The active workspace profile's visited pull requests, as sidebar rows. */
export function registerSidebarRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { sidebarListing } = container;
  app.get("/v1/sidebar/reviews", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return response(context, await sidebarListing.list(profileId.value));
  });
}
