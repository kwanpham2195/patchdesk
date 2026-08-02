import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { requestMergeOperation } from "../../src/domain/merge-operation";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const roots: string[] = [];
function value<T>(result: Result<T, unknown>): T { if (result._tag === "err") throw new Error("Invalid fixture"); return result.value; }
function operation() { return value(requestMergeOperation({ operationId: "merge-001", profileId: value(parseWorkspaceProfileId("cfw")), sessionId: value(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab")), pr: { host: value(parseGitHubHost("github.com")), owner: value(parseGitHubOwner("centraldigital")), repo: value(parseGitHubRepoName("patchdesk")), number: value(parsePullRequestNumber(42)) }, expectedHeadSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")), method: "squash", acknowledgedWarningCodes: [], startedAt: value(parseIsoTimestamp("2026-08-01T00:00:00.000Z")) })); }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("MergeOperationStore", () => {
  it("round-trips and replaces one current operation per session", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-merge-operation-"))); roots.push(paths.dataDirectory().replace("/data/patchdesk", ""));
    const store = new MergeOperationStore(paths);
    const first = operation();
    await expect(store.begin(first)).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(store.load(first.profileId, first.sessionId)).resolves.toEqual({ _tag: "ok", value: first });
    await expect(store.removeAfterSessionReceipt(first.profileId, first.sessionId)).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(store.load(first.profileId, first.sessionId)).resolves.toMatchObject({ _tag: "err", error: { reason: "not_found" } });
  });

  it("preserves corrupt journal evidence and excludes terminal operations from pending lists", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-merge-operation-"))); roots.push(paths.dataDirectory().replace("/data/patchdesk", ""));
    const store = new MergeOperationStore(paths);
    const first = operation();
    await mkdir(paths.sessionDirectory(first.profileId, first.sessionId), { recursive: true });
    await writeFile(paths.mergeOperationFile(first.profileId, first.sessionId), "{}", "utf8");
    await expect(store.load(first.profileId, first.sessionId)).resolves.toMatchObject({ _tag: "err", error: { reason: "invalid_stored_value" } });
    await expect(store.begin(first)).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(store.listPending(first.profileId)).resolves.toEqual({ _tag: "ok", value: [first] });
  });
});
