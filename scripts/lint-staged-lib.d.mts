import type { CommandOutput, RunCommand } from "./gate-command-lib.mjs";

export type LintStagedOptions = {
  readonly cwd: string;
  readonly run: RunCommand;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function lintStaged(options: LintStagedOptions): Promise<number>;
export type CheckSourcePathsOptions = LintStagedOptions & {
  readonly base: string;
  readonly head: string;
};
export function checkSourcePaths(
  paths: ReadonlyArray<string>,
  options: CheckSourcePathsOptions,
): Promise<number>;

export type CheckFileSizesOptions = {
  readonly cwd: string;
  readonly run: RunCommand;
  readonly base: string;
  readonly head: string;
  readonly output: CommandOutput;
};
export function checkFileSizes(
  files: ReadonlyArray<string>,
  options: CheckFileSizesOptions,
): Promise<number>;
