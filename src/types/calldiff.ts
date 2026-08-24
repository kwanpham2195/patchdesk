export type DiffNodeKind = "call" | "branch";

export type DiffNode = {
  readonly key: string;
  readonly label: string;
  readonly status: "same" | "added" | "removed";
  readonly kind?: DiffNodeKind;
  readonly file?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly children: ReadonlyArray<DiffNode>;
};

export type DiffResult = {
  readonly mode: "diff";
  readonly from: string;
  readonly to: string;
  readonly message?: string;
  readonly trees: ReadonlyArray<{
    readonly entry: string;
    readonly ascii: string;
    readonly tree: DiffNode;
  }>;
  readonly ascii: string;
};

export type DiffRunOptions = {
  readonly cwd?: string;
  readonly from?: string;
  readonly to?: string;
  readonly entries?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly paths?: ReadonlyArray<string>;
  readonly maxDepth?: number;
  readonly color?: boolean;
  readonly locs?: boolean;
};

export declare function runDiff(options?: DiffRunOptions): DiffResult;
