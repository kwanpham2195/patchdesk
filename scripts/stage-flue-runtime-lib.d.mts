export type StageFlueRuntimeInput = {
  readonly projectRoot: string;
  readonly runtimeRoot: string;
  readonly run: (command: string, args: string[]) => Promise<string>;
};

export function stageFlueRuntime(input: StageFlueRuntimeInput): Promise<void>;
