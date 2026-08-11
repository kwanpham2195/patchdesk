import type { ReviewResult } from "../domain/review-result";

export type AnalysisReviewBodyScope = {
  readonly baseShort: string;
  readonly headShort: string;
  readonly commitCount: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number }>;
};

/** Renders Patchdesk-owned Analysis fields into the stable GitHub review body. */
export function renderAnalysisReviewBody(input: {
  readonly scope: AnalysisReviewBodyScope;
  readonly result: ReviewResult;
}): string {
  const sections: string[] = [
    "# Review Scope\n" +
      `Diff: ${code(input.scope.baseShort)}...${code(input.scope.headShort)} (${input.scope.commitCount} commits, ${input.scope.fileCount} files, +${input.scope.additions}/-${input.scope.deletions})`,
    `# Pull Request Overview\n${text(input.result.changeSummary)}`,
    `# Reviewed Changes\n${input.scope.changedFiles.length === 0 ? "- No changed files were reported." : input.scope.changedFiles.map((file) => `- ${code(file.path)} (+${file.additions}/-${file.deletions})`).join("\n")}`,
  ];
  if (input.result.validationPlan.length > 0) sections.push(`# Verification\n${input.result.validationPlan.map((item) => `- ${text(item)}`).join("\n")}`);
  sections.push(`# Findings\n${renderFindings(input.result)}`);
  sections.push(`# Verdict\n${verdict(input.result.verdict)}. ${text(input.result.summary)}`);
  const callouts = [
    ...(input.result.callouts ?? []).map((callout) => `- **${text(callout.title)}**: ${text(callout.detail)}`),
    ...(input.result.unresolvedItems ?? []).map((item) => `- Unresolved: ${text(item)}`),
    ...input.result.assumptions.map((item) => `- Assumption: ${text(item)}`),
  ];
  if (callouts.length > 0) sections.push(`# Human Reviewer Callouts\n${callouts.join("\n")}`);
  return sections.join("\n\n");
}

/** Renders only high-level Analysis context for the shared Finish-review summary. */
export function renderAnalysisReviewSummary(input: {
  readonly scope: AnalysisReviewBodyScope;
  readonly result: {
    readonly changeSummary: string;
    readonly validationPlan: ReadonlyArray<string>;
    readonly verdict: ReviewResult["verdict"];
    readonly summary: string;
    readonly callouts?: ReadonlyArray<{ readonly title: string; readonly detail: string }> | undefined;
    readonly unresolvedItems?: ReadonlyArray<string> | undefined;
    readonly assumptions: ReadonlyArray<string>;
  };
}): string {
  const sections: string[] = [
    "# Review Scope\n" +
      `Diff: ${code(input.scope.baseShort)}...${code(input.scope.headShort)} (${input.scope.commitCount} commits, ${input.scope.fileCount} files, +${input.scope.additions}/-${input.scope.deletions})`,
    `# Pull Request Overview\n${text(input.result.changeSummary)}`,
    `# Reviewed Changes\n${input.scope.changedFiles.length === 0 ? "- No changed files were reported." : input.scope.changedFiles.map((file) => `- ${code(file.path)} (+${file.additions}/-${file.deletions})`).join("\n")}`,
  ];
  if (input.result.validationPlan.length > 0) sections.push(`# Verification\n${input.result.validationPlan.map((item) => `- ${text(item)}`).join("\n")}`);
  sections.push(`# Verdict\n${verdict(input.result.verdict)}. ${text(input.result.summary)}`);
  const callouts = [
    ...(input.result.callouts ?? []).map((callout) => `- **${text(callout.title)}**: ${text(callout.detail)}`),
    ...(input.result.unresolvedItems ?? []).map((item) => `- Unresolved: ${text(item)}`),
    ...input.result.assumptions.map((item) => `- Assumption: ${text(item)}`),
  ];
  if (callouts.length > 0) sections.push(`# Human Reviewer Callouts\n${callouts.join("\n")}`);
  return sections.join("\n\n");
}

function renderFindings(result: ReviewResult): string {
  const findings = ["P0", "P1", "P2", "P3"].flatMap((severity) =>
    result.findings
      .filter((finding) => finding.severity === severity)
      .map((finding) => `- **${severity}** ${text(finding.title)}${finding.file === undefined ? "" : ` (${code(finding.file)}${finding.lineStart === undefined ? "" : `:${finding.lineStart}`})`}: ${text(finding.explanation)}`),
  );
  return findings.length === 0 ? "No findings." : findings.join("\n");
}

function verdict(value: ReviewResult["verdict"]): string {
  return value === "approve" ? "Approve" : value === "comment" ? "Comment" : "Request changes";
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function text(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("#", "\\#")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .trim();
}
