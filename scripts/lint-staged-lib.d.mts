export type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOutput = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

export type LintStagedOptions = {
  readonly cwd: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Promise<CommandResult>;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly output: CommandOutput;
};

export function lintStaged(options: LintStagedOptions): Promise<number>;
export type CheckSourcePathsOptions = LintStagedOptions;
export function checkSourcePaths(
  paths: ReadonlyArray<string>,
  options: CheckSourcePathsOptions,
): Promise<number>;
