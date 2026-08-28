import { describe, expect, it } from "vitest";

import { countLines } from "../../scripts/file-growth-lib.mjs";
import { checkFileSizes } from "../../scripts/lint-staged-lib.mjs";

type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

const cwd = "/fixture/project";
const base = "base-rev";
const head = "head-rev";
const file = "src/big.ts";

const success = (stdout = ""): CommandResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: "",
});

/**
 * Runs the size ratchet over one file whose content at each revision comes
 * from `contents`, keyed by the `<revision>:<path>` spec `git show` is given.
 * A spec that is not listed reports "absent", exactly as git does for a path
 * a revision does not have -- which is how a new file is expressed here.
 */
async function ratchet(
  contents: Readonly<Record<string, string>>,
  paths: ReadonlyArray<string> = [file],
) {
  const stderr: string[] = [];
  const commands: string[] = [];
  const run = async (
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<CommandResult> => {
    commands.push(`${command} ${args.join(" ")}`);
    expect(command).toBe("git");
    if (args[0] === "rev-parse") return success("resolved\n");
    if (args[0] === "diff") return success("");
    expect(args[0]).toBe("show");
    const content = contents[args[1] ?? ""];
    if (content === undefined) {
      return {
        status: 128,
        signal: null,
        stdout: "",
        stderr: "fatal: path does not exist",
      };
    }
    return success(content);
  };

  const result = await checkFileSizes(paths, {
    cwd,
    run,
    base,
    head,
    output: { stdout: () => {}, stderr: (text: string) => stderr.push(text) },
  });
  return { result, stderr: stderr.join(""), commands };
}

/**
 * A file made of `importBlock`, one blank line, and `bodyLines` distinct
 * statements. Total lines are `countLines(importBlock) + 1 + bodyLines`, so
 * a test can put a file at an exact size on either side of the ceiling.
 */
function sourceOf(importBlock: string, bodyLines: number): string {
  const body = Array.from(
    { length: bodyLines },
    (_, index) => `const value${index} = ${index};`,
  );
  return `${importBlock}\n\n${body.join("\n")}\n`;
}

/** `n` lines with no imports at all, so the exemption can never apply. */
function plainLines(n: number): string {
  return `${Array.from({ length: n }, (_, index) => `line ${index}`).join("\n")}\n`;
}

/**
 * A file whose imports sit above a multi-line object literal, then nothing
 * else. This is the shape the exemption was smuggled through: something below
 * the imports that runs for many lines and grows by as many as the author
 * likes. Total lines are `countLines(importBlock) + 3 + entries`.
 */
function withObjectLiteral(importBlock: string, entries: number): string {
  const keys = Array.from(
    { length: entries },
    (_, index) => `  key${index}: ${index},`,
  );
  return `${importBlock}\n\nconst obj = {\n${keys.join("\n")}\n};\n`;
}

/** Two specifiers over four lines, the shape Oxfmt gives a long import. */
const WRAPPED_TWO = `import {\n  alpha,\n  beta,\n} from "./m";`;
/** The same import with a third specifier: one line longer, nothing else. */
const WRAPPED_THREE = `import {\n  alpha,\n  beta,\n  gamma,\n} from "./m";`;

describe("the 1,000-line ceiling", () => {
  // Before this rule, the ratchet only blocked a file that was ALREADY over
  // 1,000 lines. Anything between 501 and 999 could grow freely, and the
  // commit that took it over the line could take it as far as it liked. Two
  // files in this repository's own history did exactly that and are now
  // frozen above the ceiling for good.

  it("fails a 999-line file that grows to 1,001 -- the blind band's cliff", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(1001),
      [`${base}:${file}`]: plainLines(999),
    });

    expect(result).toBe(1);
    expect(stderr).toContain(file);
    expect(stderr).toContain("999");
    expect(stderr).toContain("1001");
    expect(stderr).toContain("Move something out");
  });

  it("fails a mid-band file that jumps clean over the ceiling in one change", async () => {
    // 763 -> 1,111 is the real shape: tests/scripts/lint-staged.test.ts made
    // that jump in one commit under the old rule and never came back.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(1111),
      [`${base}:${file}`]: plainLines(763),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("1111");
  });

  it("passes ordinary growth inside the band, well short of the ceiling", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(999),
      [`${base}:${file}`]: plainLines(600),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("passes a 999-line file that grows to exactly 1,000", async () => {
    // 1,000 is the last legal size, not the first illegal one.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(1000),
      [`${base}:${file}`]: plainLines(999),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("passes a file far over the ceiling that shrinks", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(2999),
      [`${base}:${file}`]: plainLines(3000),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("passes a file over the ceiling that comes back under it", async () => {
    // The shape of this milestone's own fix: tests/scripts/lint-staged.test.ts
    // was 1,109 lines and the split brought it to 979. A base above the
    // ceiling and a head below it is a different clause of the rule from a
    // head that merely shrinks, and it is the clause a file uses on the one
    // change that matters most -- the one that fixes it.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(979),
      [`${base}:${file}`]: plainLines(1109),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("passes a file one line over the ceiling that lands one line under it", async () => {
    // The boundary of the same clause: 1,001 -> 999 crosses the ceiling by
    // the smallest step there is.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(999),
      [`${base}:${file}`]: plainLines(1001),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("still fails a file far over the ceiling that grows by one line", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(3001),
      [`${base}:${file}`]: plainLines(3000),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("3001");
  });

  it("fails a file at exactly 1,000 lines at base that grows to 1,001", async () => {
    // The old rule read "already OVER 1,000 lines", so this exact growth was
    // allowed and put the file above the ceiling for good.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(1001),
      [`${base}:${file}`]: plainLines(1000),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("1000");
    expect(stderr).toContain("1001");
  });
});

describe("the 500-line new-file limit", () => {
  it("fails a new file at 501 lines", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(501),
    });

    expect(result).toBe(1);
    expect(stderr).toContain(file);
    expect(stderr).toContain("501");
    expect(stderr).toContain("Move something out");
  });

  it("passes a new file at exactly 500 lines", async () => {
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: plainLines(500),
    });

    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("skips a *.generated.ts file, however large, without even reading it", async () => {
    const generated = "src/adapters/pi/pi-ai-catalog.generated.ts";
    const { result, stderr, commands } = await ratchet({}, [generated]);

    expect(result).toBe(0);
    expect(stderr).toBe("");
    expect(commands).toEqual([]);
  });
});

describe("the import-specifier exemption, through the ratchet", () => {
  it("passes the E3 change: a third specifier wraps an import onto its own line", async () => {
    // src/main/local-api.ts at 3,033 lines. Naming an imported type instead
    // of repeating it inline needed a third specifier, Oxfmt wrapped the
    // import, and 3,033 -> 3,034 was refused -- by a rule whose whole point
    // is to make files smaller.
    const { result, stderr } = await ratchet({
      [`${base}:${file}`]: sourceOf(WRAPPED_TWO, 3028),
      [`${head}:${file}`]: sourceOf(WRAPPED_THREE, 3028),
    });

    expect(countLines(sourceOf(WRAPPED_TWO, 3028))).toBe(3033);
    expect(countLines(sourceOf(WRAPPED_THREE, 3028))).toBe(3034);
    expect(result).toBe(0);
    expect(stderr).toBe("");
  });

  it("fails the same file when one body line is added alongside the import", async () => {
    // One statement smuggled in behind an honest import.
    const { result, stderr } = await ratchet({
      [`${base}:${file}`]: sourceOf(WRAPPED_TWO, 3028),
      [`${head}:${file}`]: sourceOf(WRAPPED_THREE, 3029),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("3035");
    expect(stderr).toContain("Move something out");
  });

  it("never forgives a new file, however much of it is imports", async () => {
    // A new file has no base to compare against, so there is no growth to
    // call import-only. The 500-line new-file limit stands on its own.
    const { result, stderr } = await ratchet({
      [`${head}:${file}`]: sourceOf(WRAPPED_THREE, 501),
    });

    expect(result).toBe(1);
    expect(stderr).toContain("new file");
    expect(stderr).toContain("507");
  });

  it("refuses two hundred body lines smuggled behind a commented import", async () => {
    // The exemption's worst case, measured. An earlier version ended an
    // import declaration at the first line whose trimmed text ended in `;`,
    // so a trailing `// why` made the scan run on and swallow the object
    // literal below -- and every line added inside it then counted as an
    // import line, which paid for itself. 1,000 -> 1,201 with the gate
    // green. The file is ordinary TypeScript: Oxfmt-clean either side, every
    // specifier used.
    const before = withObjectLiteral(`import { alpha } from "./m";`, 996);
    const after = withObjectLiteral(
      `import { alpha } from "./m";\nimport { gamma } from "./o";\nimport { beta } from "./n"; // why`,
      1195,
    );

    expect(countLines(before)).toBe(1000);
    expect(countLines(after)).toBe(1201);

    const { result, stderr } = await ratchet({
      [`${base}:${file}`]: before,
      [`${head}:${file}`]: after,
    });

    expect(result).toBe(1);
    expect(stderr).toContain("1000");
    expect(stderr).toContain("1201");
  });
});
