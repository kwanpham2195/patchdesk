import type { CommandOutput, RunCommand } from "./gate-command-lib.mjs";

export type CheckChangedSourceOptions = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly run: RunCommand;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function checkChangedSource(
  options: CheckChangedSourceOptions,
): Promise<number>;
