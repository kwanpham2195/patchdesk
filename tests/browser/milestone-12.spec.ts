import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "playwright/test";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { createReviewSession } from "../../src/domain/review-session";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parsePullRequestNumber, parseReviewAttemptId, parseWorkspaceProfileId } from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { startLocalApiServer, type LocalApiServer } from "../../src/main/local-api";
import { installTestDesktopBridge } from "./bridge-fixture";

test("normal dashboard direct entry opens the prepared review workbench", async ({ page }) => {
  const renderer = await serve(); const root = await mkdtemp(join(tmpdir(), "patchdesk-normal-")); let api: LocalApiServer | undefined;
  try {
    const started = await startLocalApiServer({ allowedOrigin: origin(renderer), capability: "cap", paths: PatchdeskPaths.forTest(root), github: new FakeGitHubAdapter({ pullRequest: { ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 1 }, title: "Fixture", author: "fixture", headBranch: "feat/fixture", baseBranch: "sit", baseSha: "0123456789abcdef0123456789abcdef01234567", headSha: "abcdef1234567890abcdef1234567890abcdef12", isOpen: true, isDraft: false, reviewState: "approved", mergeability: "mergeable", labels: [], updatedAt: "2026-07-16T00:00:00.000Z" } as never, comments: { threads: [] }, checks: { overall: "passing", checks: [] }, diff: "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1 +1 @@\n-old\n+fixture\n" }) });
    if (started._tag !== "started") throw new Error("api"); api = started.server;
    await installTestDesktopBridge(page, api.url.toString(), "cap");
    await page.goto(origin(renderer));
    await page.getByLabel("Pull request reference").fill("centraldigital/patchdesk#1");
    await page.getByRole("button", { name: "Preview pull request" }).click();
    await expect(page.getByRole("main")).toContainText("Prepared review", { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Fixture" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run review" })).toBeVisible();
    await expect(page.getByText(/^Session /)).toHaveCount(0);
    await page.getByRole("button", { name: "View diff" }).click();
    const diff = page.getByLabel("Diff workbench");
    await expect(diff).toBeVisible();
    expect((await diff.boundingBox())?.width).toBeGreaterThan(900);
    await expect(page.getByRole("button", { name: "Run review" })).toBeVisible();
    await page.screenshot({ path: "test-results/milestone-12-normal-open.png", fullPage: true });
  } finally { if (api !== undefined) await api.stop(); await close(renderer); await rm(root, { recursive: true, force: true }); }
});

test("normal dashboard opens a seeded completed workbench and writes one confirmed pending review", async ({ page }) => {
  const renderer = await serve(); const root = await mkdtemp(join(tmpdir(), "patchdesk-complete-")); let api: LocalApiServer | undefined; let creates = 0;
  try {
    const paths = PatchdeskPaths.forTest(root); await seedCompleted(paths);
    const github = new FakeGitHubAdapter({ authenticatedAccount: { host: "github.com", account: "fixture" }, listOpenPullRequests: [], pullRequest: summary() as never, comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const started = await startLocalApiServer({ allowedOrigin: origin(renderer), capability: "cap", paths, github, reviewWriter: { async createPendingReview() { creates += 1; return { _tag: "ok" as const, value: { reviewId: "9001", state: "PENDING" as const } }; }, async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "9001" } }; } } });
    if (started._tag !== "started") throw new Error("api"); api = started.server;
    await installTestDesktopBridge(page, api.url.toString(), "cap");
    await page.goto(origin(renderer)); await page.getByLabel("Pull request reference").fill("centraldigital/patchdesk#1"); await page.getByRole("button", { name: "Preview pull request" }).click();
    await expect(page.getByRole("main")).toContainText("Review complete"); await expect(page.getByRole("heading", { name: "Persisted review result" })).toBeVisible();
    await page.getByRole("button", { name: "Create pending review" }).click(); await page.getByRole("checkbox", { name: "I understand this creates one pending GitHub review." }).check(); await page.getByRole("button", { name: "Confirm pending review" }).click();
    await expect(page.getByText("Pending review 9001 created.")).toBeVisible(); expect(creates).toBe(1); await page.screenshot({ path: "test-results/milestone-12-completed-workbench.png", fullPage: true });
  } finally { if (api !== undefined) await api.stop(); await close(renderer); await rm(root, { recursive: true, force: true }); }
});

function summary() { return { ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 1 }, title: "Persisted review result", author: "fixture", headBranch: "feat/fixture", baseBranch: "sit", baseSha: "0123456789abcdef0123456789abcdef01234567", headSha: "abcdef1234567890abcdef1234567890abcdef12", isOpen: true, isDraft: false, reviewState: "approved", mergeability: "mergeable", labels: [], updatedAt: "2026-07-16T00:00:00.000Z" }; }
async function seedCompleted(paths: PatchdeskPaths): Promise<void> { const profileId = must(parseWorkspaceProfileId("cfw")); const host = must(parseGitHubHost("github.com")); const owner = must(parseGitHubOwner("centraldigital")); const repo = must(parseGitHubRepoName("patchdesk")); const number = must(parsePullRequestNumber(1)); const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")); const attemptId = must(parseReviewAttemptId("001")); const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] })); await new ProfileStore(paths).save(profile); const session = createReviewSession({ key: { profileId, host, owner, repo, prNumber: number, headSha: sha }, pr: { headSha: sha, isOpen: true, isDraft: false }, patchPath: must(parseAbsolutePath("/tmp/patch.diff")), worktree: { path: must(parseAbsolutePath("/tmp/worktree")), headSha: sha }, createdAt: "2026-07-16T00:00:00.000Z" as never }); const draft = { sessionId: session.id, attemptId, state: { _tag: "LocalDraft" }, summaryBody: "Persisted review result", suggestedEvent: "COMMENT", comments: [{ findingId: "finding", include: true, originalSuggestedBody: "Keep the guard.", body: "Keep the guard.", path: "src/a.ts", line: 1, diffSide: "new", postability: "postable" }], createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" }; await new ReviewSessionStore(paths).save({ ...session, state: { _tag: "ReviewCompleted", attemptId }, currentAttemptId: attemptId, draft: { state: draft.state }, draftContent: draft, visibleResult: { changeSummary: "Persisted review result", verdict: "comment", summary: "Persisted review result", findings: [{ id: "finding", severity: "P2", title: "Guard", file: "src/a.ts", lineStart: 1, diffSide: "new", explanation: "Keep guard.", confidence: "high", mappingStatus: "mapped" }], validationPlan: [], assumptions: [] } } as never); }
function must<T>(value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T { if (value._tag === "err") throw new Error("fixture"); return value.value; }

async function serve(): Promise<Server> { const root = join(process.cwd(), "out/renderer"); const server = createServer(async (request, response) => { const file = normalize(join(root, request.url === undefined || request.url === "/" ? "index.html" : request.url)); if (!file.startsWith(root)) { response.writeHead(400).end(); return; } try { response.writeHead(200, { "Content-Type": extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html" }).end(await readFile(file)); } catch { response.writeHead(404).end(); } }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return server; }
function origin(server: Server): string { const address = server.address(); if (address === null || typeof address === "string") throw new Error("address"); return `http://127.0.0.1:${address.port}`; }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
