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
  readonly run: LintStagedOptions["run"];
  readonly base: string;
  readonly head: string;
  readonly output: CommandOutput;
};
export function checkFileSizes(
  files: ReadonlyArray<string>,
  options: CheckFileSizesOptions,
): Promise<number>;
