import { useState } from "react";
import { retainGuide, buildGuideInventory } from "#src/domain/guide";
import { GuideFixtureWorkbench } from "#src/renderer/src/components/guide-fixture-workbench";
import { InsightOutdated } from "#src/renderer/src/components/insight-panels";
import { Button } from "#src/renderer/src/components/ui/button";

const supportingLines = Array.from(
  { length: 80 },
  (_, index) => `+snapshotSupport${index + 1}()`,
).join("\n");
const patchText = `diff --git a/src/recovery.ts b/src/recovery.ts
old mode 100644
new mode 100755
--- a/src/recovery.ts
+++ b/src/recovery.ts
@@ -1 +1 @@
-old
+restorePending()
@@ -20 +20,81 @@
-oldCleanup()
+snapshotCleanup()
${supportingLines}
diff --git a/tests/recovery.test.ts b/tests/recovery.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/recovery.test.ts
@@ -0,0 +1 @@
+expectRecovered()
diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-obsoleteSnapshot()
diff --git a/assets/icon.png b/assets/icon.png
Binary files a/assets/icon.png and b/assets/icon.png differ
diff --git a/scripts/check.sh b/scripts/check.sh
old mode 100644
new mode 100755
`;
const inventory = buildGuideInventory(patchText);
if (inventory._tag === "err") throw new Error("Invalid Guide fixture patch");
const retained = retainGuide(
  {
    groups: [
      {
        title: "Recover pending requests",
        explanation:
          "The request restores its saved state before accepting another submission.\n\n1. Read the pending operation.\n2. Reconcile its result.\n3. Resume the request.",
        files: [
          {
            fileId: "f1",
            relevance:
              "Restores the pending operation before another submission.",
          },
          {
            fileId: "f2",
            relevance: "Checks recovery after an interrupted request.",
          },
        ],
      },
      {
        title: "Keep the recovery owner together",
        explanation:
          "The renamed module keeps the same content. The request continues to use the recovery owner through its new path.",
        files: [
          { fileId: "f1", relevance: "Calls the renamed recovery owner." },
          {
            fileId: "f3",
            relevance: "Moves the owner without changing its file contents.",
          },
        ],
      },
    ],
  },
  { patchText, inventory: inventory.value },
);
if (retained._tag === "err") throw new Error("Invalid Guide fixture result");
const guide = retained.value;
const longTitlePrefix =
  "Recover the interrupted operation with its retained snapshot ".repeat(3);
const navigationPatchText = patchText
  .replaceAll("src/", "src/retained/recovery/evidence/")
  .replaceAll("assets/", "assets/retained/recovery/evidence/");
const navigationInventory = buildGuideInventory(navigationPatchText);
if (navigationInventory._tag === "err")
  throw new Error("Invalid Guide navigation fixture patch");
const navigationRetained = retainGuide(
  {
    groups: Array.from({ length: 12 }, (_, index) => ({
      title:
        index < 2
          ? `${longTitlePrefix}${index === 0 ? "Before retry" : "After refresh"}`
          : `Recovery step ${index + 1}`,
      explanation:
        "Read the pending operation and reconcile its result before another submission.",
      files: navigationInventory.value.slice(0, 5).map((file) => ({
        fileId: file.id,
        relevance: "Retained recovery evidence.",
      })),
    })),
  },
  { patchText: navigationPatchText, inventory: navigationInventory.value },
);
if (navigationRetained._tag === "err")
  throw new Error("Invalid Guide navigation fixture");
const navigationGuide = navigationRetained.value;

/** Deterministic overview evidence; generation uses a local fake result. */
export function GuideFixture(): React.JSX.Element {
  const [outdated, setOutdated] = useState(false);
  const [running, setRunning] = useState(false);
  const [generation, setGeneration] = useState(1);
  const shownGuide = new URLSearchParams(window.location.search).has(
    "guide-navigation",
  )
    ? navigationGuide
    : guide;
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <h2 className="font-semibold">Insights / Guide</h2>
        <p className="text-xs text-muted-foreground">
          Generated · Codex CLI account · fake-provider-fixture · English ·
          revision aaaaaaa · run {generation}
        </p>
        <Button
          variant="outline"
          onClick={() => setOutdated((value) => !value)}
        >
          Show {outdated ? "current" : "outdated"} revision
        </Button>
        <Button
          onClick={() => {
            if (running) {
              setRunning(false);
              setGeneration((value) => value + 1);
            } else setRunning(true);
          }}
        >
          {running
            ? "Complete fake generation"
            : "Generate Guide with fake provider"}
        </Button>
      </div>
      {running ? (
        <p role="status" className="mb-4 text-sm">
          Guide is running. The retained result remains readable.
        </p>
      ) : null}
      {outdated ? (
        <InsightOutdated
          type="guide"
          retainedRevision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          currentRevision="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        />
      ) : (
        <p className="mb-4 text-xs text-muted-foreground">
          Current revision · retained snapshot verified
        </p>
      )}
      <GuideFixtureWorkbench
        key={generation}
        guide={shownGuide}
        outdated={outdated}
      />
    </div>
  );
}
