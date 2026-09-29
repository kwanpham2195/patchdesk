import { execFileSync } from "node:child_process";
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
      source: { kind: "local_branch", baseRef: "refs/heads/main", checkout },
    }),
  );
  return v.parse(workbenchSchema, opened.body);
}

/** Runs git for fixture setup only; the code under test runs git through the production executor. */
function git(cwd: string, ...args: ReadonlyArray<string>): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
}

/** `feat/linked` one commit past `main`, with `develop` created at `main`; `main` is the default branch whatever the maintainer's git config says. */
export async function linkedBranchWithCommit(
  fixture: McpAppFixture,
): Promise<void> {
  git(fixture.repositoryPath, "config", "init.defaultBranch", "main");
  git(fixture.repositoryPath, "branch", "develop");
  await writeFile(join(fixture.linkedPath, "feature.txt"), "feature\n");
  git(fixture.linkedPath, "add", "feature.txt");
  git(fixture.linkedPath, "commit", "-q", "-m", "feature");
}

/** Opens the linked worktree's shared Review against `base` the way the dialog does, in `profile`. */
export async function openInApp(
  fixture: McpAppFixture,
  base: string,
  profile = "acme",
): Promise<Workbench> {
  const opened = await fixture.route(
    "v1/reviews/open-local",
    JSON.stringify({
      profileId: profile,
      host: "github.com",
      owner: "octo-org",
      repo: "patchdesk",
      source: {
        kind: "local_branch",
        baseRef: `refs/heads/${base}`,
        checkout: fixture.linkedPath,
      },
    }),
  );
  if (opened.status !== 200) throw new Error("shared Review not opened");
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

/** Sets the Change intent the way the maintainer's editor does. */
export async function setIntentInApp(
  fixture: McpAppFixture,
  reviewId: string,
  intent:
    | { readonly kind: "text"; readonly markdown: string }
    | { readonly kind: "file"; readonly path: string },
): Promise<void> {
  const set = await fixture.route(
    "v1/reviews/local-intent",
    JSON.stringify({ profileId: "acme", reviewId, intent }),
  );
  if (set.status !== 200) throw new Error("Change intent not set");
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
