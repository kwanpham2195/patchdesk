import type { AnalysisResult } from "./analysis-headline";

export type AnalysisFixPromptContext = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headBranch: string;
  readonly baseBranch: string;
};

type ReviewFinding = AnalysisResult["findings"][number];

/**
 * Only the parts of a result this prompt reads, so the renderer's retained
 * Analysis result feeds it without matching the whole retained shape.
 */
type FixPromptResult = {
  readonly changeSummary: string;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly validationPlan: ReadonlyArray<string>;
};

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

const TASK_INSTRUCTIONS =
  "A code review produced the findings below. Fix each one in the codebase. " +
  "For each finding: read the referenced file and lines, make the smallest correct change, " +
  "and add or update a test when the finding is a bug. Do not change unrelated code. " +
  "When you finish, list what you changed per finding and anything you deliberately left alone with the reason.";

/** Builds the markdown prompt a reviewer pastes into a local coding agent to fix open Analysis findings. */
export function renderAnalysisFixPrompt(input: {
  readonly context?: AnalysisFixPromptContext | undefined;
  readonly result: FixPromptResult;
  readonly dismissedFindingIds?: ReadonlySet<string> | undefined;
}): string {
  const sections: string[] = [
    "# Fix review findings",
    renderRepositoryLine(input.context),
    TASK_INSTRUCTIONS,
  ];

  const changeSummary = input.result.changeSummary.trim();
  if (changeSummary !== "")
    sections.push(`## Change summary\n\n${changeSummary}`);

  sections.push(
    `## Findings\n\n${renderFindings(input.result.findings, input.dismissedFindingIds)}`,
  );

  if (input.result.validationPlan.length > 0)
    sections.push(
      `## Verify\n\n${input.result.validationPlan.map((item) => `- [ ] ${item.trim()}`).join("\n")}`,
    );

  return sections.join("\n\n").trimEnd();
}

function renderRepositoryLine(
  context: AnalysisFixPromptContext | undefined,
): string {
  if (context === undefined)
    return "You are working in the repository that this review was produced for.";
  return (
    `You are working in the repository ${context.owner}/${context.repo}, ` +
    `on branch \`${context.headBranch}\` (pull request #${context.number} ` +
    `targeting \`${context.baseBranch}\`).`
  );
}

function renderFindings(
  findings: ReadonlyArray<ReviewFinding>,
  dismissedFindingIds: ReadonlySet<string> | undefined,
): string {
  const open = findings.filter(
    (finding) =>
      finding.disposition !== "dismissed" &&
      dismissedFindingIds?.has(finding.id) !== true,
  );
  const ordered = SEVERITY_ORDER.flatMap((severity) =>
    open.filter((finding) => finding.severity === severity),
  );
  if (ordered.length === 0) return "No open findings.";
  return ordered
    .map((finding, index) => renderFinding(finding, index + 1))
    .join("\n\n");
}

function renderFinding(finding: ReviewFinding, position: number): string {
  const blocks: string[] = [
    `### ${position}. [${finding.severity}] ${finding.title.trim()}`,
  ];

  const facts: string[] = [];
  if (finding.file !== undefined)
    facts.push(`- File: \`${finding.file}${renderLines(finding)}\``);
  if (finding.category !== undefined)
    facts.push(`- Category: ${finding.category}`);
  if (finding.whyItMatters !== undefined)
    facts.push(`- Why it matters: ${finding.whyItMatters.trim()}`);
  if (finding.affectedScenario !== undefined)
    facts.push(`- Affected scenario: ${finding.affectedScenario.trim()}`);
  if (facts.length > 0) blocks.push(facts.join("\n"));

  blocks.push(finding.explanation.trim());

  if (finding.suggestedChange !== undefined)
    blocks.push(`Suggested change: ${finding.suggestedChange.trim()}`);

  return blocks.join("\n\n");
}

function renderLines(finding: ReviewFinding): string {
  if (finding.lineStart === undefined) return "";
  if (finding.lineEnd === undefined) return `:${finding.lineStart}`;
  return `:${finding.lineStart}-${finding.lineEnd}`;
}
