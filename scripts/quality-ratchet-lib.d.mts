import type { CommandOutput, RunCommand } from "./gate-command-lib.mjs";

export type RatchetOptions = {
  readonly cwd: string;
  readonly run: RunCommand;
  /** The revision holding the change under test; `""` is the index. */
  readonly revision: string;
  /** Every repo-root-relative path that change touches. */
  readonly changedPaths: ReadonlyArray<string>;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function checkLintRatchet(options: RatchetOptions): Promise<number>;
export function checkKnipRatchet(options: RatchetOptions): Promise<number>;
