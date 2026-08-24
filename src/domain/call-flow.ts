export type CallFlowNodeStatus = "same" | "added" | "removed";

export type CallFlowNodeKind = "call" | "branch";

/** Lists the language parsers packaged with Patchdesk Call Flow. */
export const CALL_FLOW_LANGUAGE_NAMES = [
  "Go",
  "JavaScript",
  "JSX",
  "TypeScript",
  "TSX",
] as const;

/** Names one packaged Call Flow language parser. */
export type CallFlowLanguageName = (typeof CALL_FLOW_LANGUAGE_NAMES)[number];

export type CallFlowNode = {
  readonly key: string;
  readonly label: string;
  readonly status: CallFlowNodeStatus;
  readonly kind?: CallFlowNodeKind | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly endLine?: number | undefined;
  readonly children: ReadonlyArray<CallFlowNode>;
};

export type CallFlowTree = {
  readonly entry: string;
  readonly ascii: string;
  readonly tree: CallFlowNode;
};

export type CallFlowLanguageSummary = {
  readonly analyzed: ReadonlyArray<CallFlowLanguageName>;
  readonly available: typeof CALL_FLOW_LANGUAGE_NAMES.length;
  readonly skippedChangedFiles: number;
};

export type CallFlowSnapshot = {
  readonly sessionId: string;
  readonly baseSha: string;
  readonly headSha: string;
};

export type CallFlowOutcome =
  | {
      readonly state: "ready";
      readonly snapshot: CallFlowSnapshot;
      readonly trees: ReadonlyArray<CallFlowTree>;
      readonly ascii: string;
      readonly changedSteps: number;
      readonly contextSteps: number;
      readonly impactedFiles: number;
      readonly languages: CallFlowLanguageSummary;
      readonly truncated: boolean;
    }
  | {
      readonly state: "unsupported";
      readonly snapshot: CallFlowSnapshot;
      readonly languages: CallFlowLanguageSummary;
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "metadata_only"
        | "runtime_unavailable"
        | "timed_out"
        | "execution_failed"
        | "too_large"
        | "cancelled";
    };
