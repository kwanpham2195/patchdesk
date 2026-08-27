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

export type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) => Promise<CommandResult>;

export function resolveCommitRef(
  ref: string,
  name: string,
  context: {
    readonly cwd: string;
    readonly run: RunCommand;
    readonly output: CommandOutput;
  },
): Promise<string | undefined>;

export function pinnedTool(
  name: string,
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
  output: CommandOutput,
): Promise<string | undefined>;

export const spawnCommand: RunCommand;
export const processOutput: CommandOutput;
export function defaultFileExists(path: string): Promise<boolean>;
export function execute(
  run: RunCommand,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  output: CommandOutput,
): Promise<CommandResult | undefined>;
export function hasExit(result: CommandResult, status: number): boolean;
export function replay(result: CommandResult, output: CommandOutput): void;
export function describeCause(cause: unknown): string;
