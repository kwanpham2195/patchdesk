import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isReadOnlyCommand } from "../../src/adapters/codex/codex-command-allowlist";

let worktree = "";
let outside = "";

beforeAll(async () => {
  worktree = await mkdtemp(join(tmpdir(), "patchdesk-codex-allowlist-"));
  await mkdir(join(worktree, "src", "domain"), { recursive: true });
  await writeFile(join(worktree, "src", "a.ts"), "export const a = 1;");
  await writeFile(
    join(worktree, "src", "domain", "throwaway-page-range.ts"),
    "export const pageRange = 1;",
  );
  await writeFile(join(worktree, "knip.json"), "{}");
  await symlink(tmpdir(), join(worktree, "src", "escape"));
  // A PR can commit `src/x -> <outside>` beside a real root-level `x/passwd`.
  outside = await mkdtemp(join(tmpdir(), "patchdesk-codex-outside-"));
  await writeFile(join(outside, "passwd"), "root:x:0:0");
  await mkdir(join(worktree, "x"));
  await writeFile(join(worktree, "x", "passwd"), "not a secret");
  await symlink(outside, join(worktree, "src", "x"));
});

afterAll(async () => {
  await rm(worktree, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// Codex sends `shlex_join(["/bin/zsh", "-lc", script])`, observed live in #243.
const observedChain =
  '/bin/zsh -lc "git status -sb && git log --oneline -5 && sed -n \'1,200p\' src/domain/throwaway-page-range.ts && rg -n \\"pageRange|pageCount\\" src"';

describe("isReadOnlyCommand", () => {
  it.each([
    "pwd",
    "cat src/a.ts",
    "cat -n src/a.ts",
    "cat knip.json",
    "head -n 50 src/a.ts",
    "tail -n 20 src/a.ts",
    "sed -n '1,80p' src/a.ts",
    "wc -l src/a.ts",
    "rg -n foo src",
    "rg -n -i -C 3 foo src",
    "rg -n -C3 --glob '*.ts' foo src",
    "rg --files src",
    "rg -n -e foo",
    "grep -rn foo src",
    "grep -n '--include=*.ts' -e foo src",
    "find src -name '*.ts' -type f",
    "find src -maxdepth 2 -type d",
    "git status",
    "git status -sb",
    "git diff",
    "git diff HEAD",
    "git diff --stat main...HEAD",
    "git diff HEAD -- src/a.ts",
    "git show abc1234",
    "git show HEAD:src/a.ts",
    "git log --oneline -5",
    "git log -n 5 '--format=%h %s'",
    "git --no-pager diff --name-only",
    "git ls-files src",
    "git rev-parse HEAD",
    "/bin/zsh -lc 'cat knip.json'",
    "git diff 'HEAD~1'",
    "/bin/bash -c \"git diff 'HEAD~1'\"",
    observedChain,
  ])("accepts %s", async (command) => {
    await expect(isReadOnlyCommand(command, worktree, worktree)).resolves.toBe(
      true,
    );
  });

  it.each([
    "",
    "./cat src/a.ts",
    "pnpm exec tsc --noEmit",
    "/bin/zsh -lc 'pnpm exec tsc --noEmit'",
    "ls src",
    "pwd src",
    // Paths outside the worktree.
    "cat /etc/passwd",
    "cat ../a.ts",
    "cat src/../../a.ts",
    "cat src/escape",
    "cat src/missing.ts",
    "rg foo /etc",
    "git diff HEAD -- ../a.ts",
    "head -n 50",
    // Flags that write, execute, or follow links out of the worktree.
    "sed -i '' src/a.ts",
    "sed -n '1w out' src/a.ts",
    "sed -e 1p src/a.ts",
    "rg --pre cat foo src",
    "rg --pre=cat foo src",
    "rg -z foo src",
    "rg -L foo src",
    "rg --follow foo src",
    "grep -R foo src",
    "tail -f src/a.ts",
    "find src -delete",
    "find src -exec cat '{}' +",
    "find -L src",
    "find src -follow",
    "find src -name x src",
    "git -c core.pager=cat log",
    "git -C src status",
    "git diff --output=out",
    "git log --output out",
    "git diff --ext-diff",
    "git diff --textconv",
    "git checkout src/a.ts",
    "git diff HEAD '$(id)'",
    // Shell syntax Patchdesk does not judge.
    "/bin/zsh -lc 'cat src/a.ts; rm -rf src'",
    "/bin/zsh -lc 'cat src/a.ts | head'",
    "/bin/zsh -lc 'cat src/a.ts || pwd'",
    "/bin/zsh -lc 'cat src/a.ts&&pwd'",
    "/bin/zsh -lc 'cat src/a.ts && '",
    "/bin/zsh -lc '&& cat src/a.ts'",
    "/bin/zsh -lc 'cat src/a.ts 2>/dev/null'",
    "/bin/zsh -lc 'cat src/*'",
    "/bin/zsh -lc 'cat ~/a.ts'",
    "/bin/zsh -lc 'git diff HEAD~1'",
    "/bin/zsh -lc 'cat src/escap^x'",
    "/bin/zsh -lc 'cat =cat'",
    "/bin/zsh -lc 'cat {src,x}/a.ts'",
    "/bin/zsh -lc 'cat $HOME/a.ts'",
    '/bin/zsh -lc "cat src/a.ts \\"$(id)\\""',
    "/bin/zsh -lc 'cat `id`'",
    "/bin/zsh -lc 'cat src/a.ts\npwd'",
    "/bin/zsh -lc 'cat src/a.ts' extra",
    "/bin/zsh -i -c 'cat src/a.ts'",
    "/usr/local/bin/zsh -lc 'cat src/a.ts'",
    "zsh -lc 'cat src/a.ts'",
    "/bin/zsh -lc \"/bin/zsh -lc 'cat src/a.ts'\"",
    "/bin/zsh -lc 'cat '",
    "cat  src/a.ts",
    "git diff HEAD~1",
    "git log --all",
  ])("declines %s", async (command) => {
    await expect(isReadOnlyCommand(command, worktree, worktree)).resolves.toBe(
      false,
    );
  });

  // zsh resolves a relative path against the request cwd, which the model chooses inside the worktree.
  it.each([
    ["src", "cat x/passwd", false],
    ["src", "/bin/zsh -lc 'cat x/passwd'", false],
    ["src", "head -n 5 x/passwd", false],
    ["src", "git diff -- x/passwd", false],
    ["src", "git diff x/passwd", false],
    [".", "cat src/x/passwd", false],
    ["src", "cat a.ts", true],
    ["src", "/bin/zsh -lc 'rg -n pageRange domain'", true],
    [".", "cat x/passwd", true],
  ])("in cwd %s, answers %s with %s", async (cwd, command, expected) => {
    await expect(
      isReadOnlyCommand(command, worktree, join(worktree, cwd)),
    ).resolves.toBe(expected);
  });
});
