import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  prepareAllocatedAttemptArtifacts,
  preparedAttemptArtifacts,
} from "../../src/services/review-attempt-artifacts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("prepared attempt artifacts", () => {
  it("copies the prepared snapshot into the allocated retry directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-attempt-artifacts-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const profileId = "cfw" as never;
    const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456" as never;
    const initial = preparedAttemptArtifacts(paths, profileId, sessionId, "001" as never);
    await mkdir(dirname(initial.contextPath), { recursive: true });
    await Promise.all([
      writeFile(initial.contextPath, '{"snapshot":true}', "utf8"),
      writeFile(initial.reviewInputPath, "Review the snapshot.", "utf8"),
    ]);

    const prepared = await prepareAllocatedAttemptArtifacts({
      paths,
      profileId,
      sessionId,
      attemptId: "002" as never,
      sourceAttemptId: "001" as never,
    });

    expect(prepared).toMatchObject({ _tag: "ok", value: { contextPath: expect.stringContaining("attempts/002/context.json"), reviewInputPath: expect.stringContaining("attempts/002/review-input.md") } });
    if (prepared._tag === "err") return;
    await expect(readFile(prepared.value.contextPath, "utf8")).resolves.toBe('{"snapshot":true}');
    await expect(readFile(prepared.value.reviewInputPath, "utf8")).resolves.toBe("Review the snapshot.");
  });
});
