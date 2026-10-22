import * as v from "valibot";
const lengthIssue = v.looseObject({
  type: v.literal("max_length"),
  input: v.string(),
  requirement: v.number(),
});

/** Reports at most two violated field lengths, never producer text or captured paths. */
export function walkthroughInputLimitDiagnostic(
  issues: ReadonlyArray<v.BaseIssue<unknown>>,
): string | undefined {
  const details: string[] = [];
  for (const issue of issues) {
    const parsed = v.safeParse(lengthIssue, issue);
    if (!parsed.success) continue;
    const path = v.getDotPath(issue);
    if (path === null || !/^(title|focus|prose|hunkIds\.\d+)$/.test(path))
      continue;
    details.push(
      `${path}_${parsed.output.input.length}_gt_${parsed.output.requirement}`,
    );
    if (details.length === 2) break;
  }
  return details.length === 0 ? undefined : details.join(",");
}
