import type { CommandOutput, RunCommand } from "./gate-command-lib.mjs";

export type CheckKnipCountOptions = {
  /** Empty for the staged change, or exactly `[base, head]` for a commit pair. */
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly run: RunCommand;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function checkKnipCount(options: CheckKnipCountOptions): Promise<number>;
