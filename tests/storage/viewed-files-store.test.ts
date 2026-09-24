import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import type { LogEntryInput } from "../../src/domain/log-entry";
import {
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const profile = parseWorkspaceProfileId("acme");
const session = parseReviewSessionId(
  "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-bbbbbbbb__0123456789ab",
);
const fileA = parseRepoRelativePath("src/a.ts");
const fileB = parseRepoRelativePath("docs/b.md");
if (
  profile._tag === "err" ||
  session._tag === "err" ||
  fileA._tag === "err" ||
  fileB._tag === "err"
)
  throw new Error("invalid fixture ids");

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "patchdesk-viewed-files-store-"));
  const paths = PatchdeskPaths.forTest(root);
  const logged: LogEntryInput[] = [];
  const store = new ViewedFilesStore(paths, {
    write: (entry) => logged.push(entry),
  });
  return { paths, store, logged };
}

describe("ViewedFilesStore", () => {
  it("writes the marks into the session directory and reads them back", async () => {
    const { paths, store } = await fixture();

    const saved = await store.save(profile.value, session.value, [
      fileA.value,
      fileB.value,
      fileA.value,
    ]);

    expect(saved).toEqual({ _tag: "ok", value: [fileB.value, fileA.value] });
    const file = paths.viewedFilesFile(profile.value, session.value);
    expect(dirname(file)).toBe(
      paths.sessionDirectory(profile.value, session.value),
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      paths: ["docs/b.md", "src/a.ts"],
    });
    expect(await store.load(profile.value, session.value)).toEqual({
      _tag: "ok",
      value: [fileB.value, fileA.value],
    });
  });

  it("reads a session with no record as no marks", async () => {
    const { store } = await fixture();

    expect(await store.load(profile.value, session.value)).toEqual({
      _tag: "ok",
      value: [],
    });
  });

  it.each([
    ["unparseable JSON", "{not json"],
    [
      "a path that climbs out of the repository",
      JSON.stringify({ schemaVersion: 1, paths: ["../secrets"] }),
    ],
  ])(
    "moves a record with %s aside and reads no marks",
    async (_case, contents) => {
      const { paths, store, logged } = await fixture();
      const file = paths.viewedFilesFile(profile.value, session.value);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");

      expect(await store.load(profile.value, session.value)).toEqual({
        _tag: "ok",
        value: [],
      });
      expect(
        await readFile(
          paths.viewedFilesQuarantineFile(profile.value, session.value),
          "utf8",
        ),
      ).toBe(contents);
      expect(logged).toMatchObject([{ level: "warn", topic: "viewed-files" }]);
      expect(await store.load(profile.value, session.value)).toEqual({
        _tag: "ok",
        value: [],
      });
    },
  );
});
