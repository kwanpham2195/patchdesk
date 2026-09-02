import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokeWalkthroughWithResolvedTimeout,
  resolveWalkthroughTimeoutMs,
} from "../../src/services/child-invocation";
import type { WalkthroughInput } from "../../src/services/walkthrough-operation";

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Nine hunks: two hunk steps (eight per step) against one size step, so the
 * hunk count — the only part of the read an abort can stop — is what decides
 * the bound. */
const NINE_HUNK_PATCH = [
  "diff --git a/a.ts b/a.ts",
  ...Array.from(
    { length: 9 },
    (_, index) => `@@ -${index + 1},1 +${index + 1},2 @@\n+line`,
  ),
  "",
].join("\n");

const FLOOR_PLUS_ONE_STEP_MS = 6 * 60_000;
const FLOOR_PLUS_TWO_STEPS_MS = 7 * 60_000;

async function writeArtifacts(): Promise<{
  readonly contextPath: string;
  readonly patchPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-child-invocation-"));
  roots.push(root);
  const patchPath = join(root, "patch.diff");
  const contextPath = join(root, "context.json");
  await Promise.all([
    writeFile(patchPath, NINE_HUNK_PATCH, "utf8"),
    writeFile(contextPath, "{}", "utf8"),
  ]);
  return { contextPath, patchPath };
}

describe("resolveWalkthroughTimeoutMs", () => {
  it("counts the patch's hunks into the bound when no run is being cancelled", async () => {
    await expect(
      resolveWalkthroughTimeoutMs(await writeArtifacts()),
    ).resolves.toBe(FLOOR_PLUS_TWO_STEPS_MS);
  });

  it("stops counting hunks once the run is aborted", async () => {
    // The same artifacts as above. The only difference is the signal, so a
    // caller that accepts one and drops it returns the value above instead.
    await expect(
      resolveWalkthroughTimeoutMs(await writeArtifacts(), AbortSignal.abort()),
    ).resolves.toBe(FLOOR_PLUS_ONE_STEP_MS);
  });

  it("falls back to the floor rather than throwing when the artifacts cannot be read", async () => {
    await expect(
      resolveWalkthroughTimeoutMs({
        contextPath: join(tmpdir(), "patchdesk-absent-context.json"),
        patchPath: join(tmpdir(), "patchdesk-absent-patch.diff"),
      }),
    ).resolves.toBe(5 * 60_000);
  });
});

/** The same artifacts as above, dressed as the child's own input. */
async function walkthroughInput(): Promise<WalkthroughInput> {
  return {
    profileId: "cfw",
    sessionId: "session",
    model: "test-model",
    reasoning: "medium",
    ...(await writeArtifacts()),
  };
}

/** Stands in for `PiInsightChildInvoker`, recording what the wiring spends
 * on it instead of starting a child process. */
function recordingChild() {
  const bounds: Array<number> = [];
  const signals: Array<AbortSignal> = [];
  return {
    bounds,
    signals,
    async invokeWalkthrough(
      input: WalkthroughInput,
      timeoutMs: number,
      options: { readonly signal: AbortSignal },
    ) {
      bounds.push(timeoutMs);
      signals.push(options.signal);
      return input.patchPath;
    },
  };
}

describe("invokeWalkthroughWithResolvedTimeout", () => {
  it("hands the child the patch-scaled bound and the run's own signal", async () => {
    const child = recordingChild();
    const controller = new AbortController();
    const input = await walkthroughInput();

    await expect(
      invokeWalkthroughWithResolvedTimeout(child, input, {
        signal: controller.signal,
      }),
    ).resolves.toBe(input.patchPath);

    expect(child.bounds).toEqual([FLOOR_PLUS_TWO_STEPS_MS]);
    expect(child.signals).toEqual([controller.signal]);
  });

  it("resolves the bound under the run's own signal, so a cancelled run stops the patch read", async () => {
    const child = recordingChild();

    // Byte-for-byte the same artifacts as the case above; the only difference
    // is that the run is already cancelled. Wiring that resolves the bound
    // without the signal reads the patch to the end regardless and records
    // FLOOR_PLUS_TWO_STEPS_MS here — the case above's value — so this is what
    // fails if the signal is ever dropped between the run and the read.
    await invokeWalkthroughWithResolvedTimeout(
      child,
      await walkthroughInput(),
      { signal: AbortSignal.abort() },
    );

    // Exactly one call, carrying the bound of a patch whose hunks were never
    // counted: the streaming read stopped instead of running on.
    expect(child.bounds).toEqual([FLOOR_PLUS_ONE_STEP_MS]);
  });
});
