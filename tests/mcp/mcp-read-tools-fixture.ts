import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import * as v from "valibot";

import type { McpAppFixture } from "../main/mcp-app-fixture";

/** The parts of a workbench projection the MCP read-tool tests compare with. */
const workbenchSchema = v.looseObject({
  review: v.looseObject({ id: v.string() }),
  session: v.looseObject({
    id: v.string(),
    key: v.looseObject({ headSha: v.string() }),
  }),
  revision: v.looseObject({ patchHash: v.string() }),
  localDrafts: v.array(v.looseObject({ line: v.number() })),
  changeIntent: v.unknown(),
  insights: v.looseObject({
    analysis: v.looseObject({
      retained: v.optional(
        v.looseObject({
          value: v.looseObject({
            findings: v.array(v.looseObject({ id: v.string() })),
          }),
        }),
      ),
    }),
  }),
});

export type Workbench = v.InferOutput<typeof workbenchSchema>;

export async function call(
  client: Client,
  name: string,
  args: Parameters<Client["callTool"]>[0]["arguments"],
): Promise<{ readonly isError: boolean; readonly content: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    content: result.structuredContent,
  };
}

export async function openRoute(
  fixture: McpAppFixture,
  checkout: string,
): Promise<Workbench> {
  const opened = await fixture.route(
    "v1/reviews/open-local",
    JSON.stringify({
      profileId: "acme",
      host: "github.com",
      owner: "octo-org",
      repo: "patchdesk",
      source: { kind: "working_tree", checkout },
    }),
  );
  return v.parse(workbenchSchema, opened.body);
}

export async function loadRoute(
  fixture: McpAppFixture,
  reviewId: string,
): Promise<Workbench> {
  const loaded = await fixture.route(
    "v1/reviews/load",
    JSON.stringify({ profileId: "acme", reviewId }),
  );
  return v.parse(workbenchSchema, loaded.body);
}

export async function addNote(
  fixture: McpAppFixture,
  workbench: Workbench,
  line: number,
): Promise<void> {
  const added = await fixture.route(
    "v1/reviews/local-drafts/notes/add",
    JSON.stringify({
      profileId: "acme",
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      path: "long.txt",
      side: "new",
      startLine: line,
      line,
      text: `Note on line ${String(line)}`,
    }),
  );
  if (added.status !== 200) throw new Error("note not added");
}

/** Opens a local Review of an untracked 30-line file with a note on each of lines 1 to `count`. */
export async function reviewWithNotes(
  fixture: McpAppFixture,
  count: number,
): Promise<Workbench> {
  await writeFile(
    join(fixture.repositoryPath, "long.txt"),
    Array.from(
      { length: 30 },
      (_, index) => `line ${String(index + 1)}\n`,
    ).join(""),
  );
  const workbench = await openRoute(fixture, fixture.repositoryPath);
  for (let line = 1; line <= count; line += 1)
    await addNote(fixture, workbench, line);
  return workbench;
}

export const pageSchema = v.looseObject({
  localDrafts: v.array(v.looseObject({ line: v.number() })),
  markdown: v.string(),
  nextCursor: v.optional(v.string()),
});
