import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  createReviewSessionId,
  parseGitSha,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { markReviewTerminal } from "../../src/domain/review";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewViewedFilesService } from "../../src/services/review-viewed-files-service";
import { must, values } from "./review-invariant-fixtures";

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "patchdesk-viewed-files-"));
  const paths = PatchdeskPaths.forTest(root);
  const reviews = new ReviewStore(paths);
  const viewedFiles = new ViewedFilesStore(paths, { write: () => undefined });
  const service = new ReviewViewedFilesService(
    reviews,
    viewedFiles,
    new ReviewOperationCoordinator(),
  );
  return { reviews, viewedFiles, service };
}

const fileA = must(parseRepoRelativePath("src/a.ts"));
const fileB = must(parseRepoRelativePath("src/b.ts"));

describe("ReviewViewedFilesService", () => {
  it("replaces the current session's Viewed marks with the sent set", async () => {
    const { reviews, viewedFiles, service } = await fixture();
    await reviews.save(values.review);

    await service.save({
      profileId: values.profileId,
      reviewId: values.review.id,
      sessionId: values.sessionId,
      paths: [fileB, fileA],
    });
    const saved = await service.save({
      profileId: values.profileId,
      reviewId: values.review.id,
      sessionId: values.sessionId,
      paths: [fileA],
    });

    expect(saved).toEqual({ _tag: "ok", value: { paths: [fileA] } });
    expect(await viewedFiles.load(values.profileId, values.sessionId)).toEqual({
      _tag: "ok",
      value: [fileA],
    });
  });

  it("refuses marks for a session the Review no longer represents", async () => {
    const { reviews, viewedFiles, service } = await fixture();
    await reviews.save(values.review);
    const oldSessionId = createReviewSessionId({
      ...values.identity,
      headSha: must(parseGitSha("2".repeat(40))),
      baseSha: values.baseSha,
    });

    const saved = await service.save({
      profileId: values.profileId,
      reviewId: values.review.id,
      sessionId: oldSessionId,
      paths: [fileA],
    });

    expect(saved).toEqual({ _tag: "err", error: { reason: "stale_head" } });
    expect(await viewedFiles.load(values.profileId, oldSessionId)).toEqual({
      _tag: "ok",
      value: [],
    });
  });

  it("keeps marks editable after the pull request merges", async () => {
    const { reviews, service } = await fixture();
    await reviews.save(markReviewTerminal(values.review, "merged", values.at));

    expect(
      await service.save({
        profileId: values.profileId,
        reviewId: values.review.id,
        sessionId: values.sessionId,
        paths: [fileA],
      }),
    ).toEqual({ _tag: "ok", value: { paths: [fileA] } });
  });
});
