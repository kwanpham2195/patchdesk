import { DiffWorkbench } from "../components/diff-workbench";

const patch = buildLargePatchFixture();

/** Isolated performance fixture avoids loading unrelated Review fixture code. */
export function PerformanceFixture(): React.JSX.Element {
  return (
    <DiffWorkbench
      patch={patch}
      finding={{
        file: "src/generated/file-0999.ts",
        lineStart: 1,
        diffSide: "new",
      }}
    />
  );
}

function buildLargePatchFixture(): string {
  const files: Array<string> = [];
  const oldLine = `-${"old-value-".padEnd(79, "x")}`;
  const newLine = `+${"new-value-".padEnd(79, "y")}`;
  for (let index = 0; index < 1_000; index += 1) {
    const number = String(index).padStart(4, "0");
    const path = `src/generated/file-${number}.ts`;
    const changes: Array<string> = [];
    for (let line = 0; line < 64; line += 1) changes.push(oldLine, newLine);
    files.push(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,64 +1,64 @@\n${changes.join("\n")}\n`,
    );
  }
  return files.join("");
}
