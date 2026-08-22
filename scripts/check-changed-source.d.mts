import type { CommandOutput, CommandResult } from "./lint-staged-lib.mjs";

export type CheckChangedSourceOptions = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Promise<CommandResult>;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function checkChangedSource(
  options: CheckChangedSourceOptions,
): Promise<number>;
