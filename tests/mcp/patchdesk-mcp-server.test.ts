import { afterEach, describe, expect, it } from "vitest";

import { mcpToolNames } from "../../src/mcp/tool-manifest";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  closeMcpTestClients,
  connectLegacyClient,
  mcpProtocolEras,
} from "./mcp-test-clients";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

describe.each(mcpProtocolEras)(
  "patchdesk mcp on the $era era",
  ({ era, connect }) => {
    it("lists the manifest's tools and returns list_repositories as the checkout route does", async () => {
      app = await startAppWithLinkedWorktree();
      const client = await connect(app.socketPath);

      const listed = await client.listTools();
      const called = await client.callTool({
        name: "list_repositories",
        arguments: {},
      });

      expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(
        era === "2026-07-28",
      );
      expect(listed.tools.map((tool) => tool.name)).toEqual(mcpToolNames);
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toMatchObject({
        profile: { id: "acme" },
        repositories: [
          {
            repo: "patchdesk",
            checkouts: JSON.parse(await app.routeCheckouts()),
          },
        ],
      });
    });
  },
);

describe("patchdesk mcp without the app", () => {
  it("still lists its tools and answers a call with app_not_running", async () => {
    const client = await connectLegacyClient(
      "/tmp/pd-mcp-missing/patchdesk.sock",
    );

    const listed = await client.listTools();
    const called = await client.callTool({
      name: "list_repositories",
      arguments: {},
    });

    expect(listed.tools.map((tool) => tool.name)).toEqual(mcpToolNames);
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toMatchObject({
      error: "app_not_running",
    });
  });

  it.each(["review_local", "refresh_review"])(
    "%s discloses the Git objects, ref, and cached worktree it writes",
    async (name) => {
      const client = await connectLegacyClient(
        "/tmp/pd-mcp-missing/patchdesk.sock",
      );

      const listed = await client.listTools();
      const description = listed.tools.find(
        (tool) => tool.name === name,
      )?.description;

      expect(description).toMatch(/git objects/i);
      expect(description).toMatch(/refs\/patchdesk\/local\//);
      expect(description).toMatch(/worktree in its cache/i);
      expect(description).not.toMatch(/no git write/i);
    },
  );
});
