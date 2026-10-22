import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { WalkthroughProgressStore } from "#src/adapters/storage/walkthrough-progress-store";
import { parseReviewId, parseWorkspaceProfileId } from "#src/domain/ids";
import type { Result } from "#src/domain/result";
import {
  walkthroughReadingStateCodec,
  walkthroughReviewedSectionCodec,
} from "#src/domain/walkthrough-progress";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid progress fixture");
  return result.value;
}

it("commits and reopens the first Walkthrough progress mark without a prior pointer", async () => {
  // Regression for #821: the first Walkthrough progress save failed.
  const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-progress-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profileId = must(parseWorkspaceProfileId("acme"));
    const reviewId = must(
      parseReviewId("github.com__octo__repo__pr-1__review-aaaaaaaaaaaa"),
    );
    await mkdir(paths.reviewDirectory(profileId, reviewId), {
      recursive: true,
      mode: 0o700,
    });
    const artifacts = new InsightArtifactStore(
      paths,
      readBoundedInsightArtifactFile,
    );
    const indexes = new InsightResultStore(artifacts, profileId, reviewId);
    const store = new WalkthroughProgressStore(
      paths,
      artifacts,
      readBoundedInsightArtifactFile,
    );
    const digest = "a".repeat(64);
    expect(must(await store.read(profileId, reviewId, digest))).toBeUndefined();
    const mark = must(
      await artifacts.writeObject(
        profileId,
        reviewId,
        walkthroughReviewedSectionCodec,
        { sectionId: "s1" },
      ),
    );
    const empty = must(await indexes.emptyIndex("WalkthroughReviewedSection1"));
    const reviewedSections = must(
      await indexes.appendIndex("WalkthroughReviewedSection1", empty, 0, mark),
    );
    const state = {
      result: digest,
      version: 1,
      reviewedSections,
      currentSectionId: null,
    };
    const reference = must(
      await artifacts.writeObject(
        profileId,
        reviewId,
        walkthroughReadingStateCodec,
        state,
      ),
    );

    expect(
      await store.commit(profileId, reviewId, digest, null, 1, reference),
    ).toEqual({ _tag: "ok", value: true });
    const reopened = new WalkthroughProgressStore(
      paths,
      new InsightArtifactStore(paths, readBoundedInsightArtifactFile),
      readBoundedInsightArtifactFile,
    );
    expect(
      must(await reopened.read(profileId, reviewId, digest))?.state,
    ).toEqual(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
