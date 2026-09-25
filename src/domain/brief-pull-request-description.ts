import type { BriefCitation, NormalizedBrief } from "./brief";
import { briefFlowKindLabel, flowRowLine, flowRows } from "./brief-flow-text";
import type { BriefFlowTree } from "./brief-flow";
import type { BriefOwnership } from "./brief-ownership";
import type { BriefReach } from "./brief-reach";
import type { BriefStartHere } from "./brief-start-here";
import { matchUnifiedHunkHeader } from "./unified-patch";

/**
 * The retained Brief as a pull request description in Markdown (ADR 0050
 * "Handoff"): Flow, Shape, Blast radius, then Start here, in the order the
 * reader draws them. Every citation is written as `path:line`, a hunk at its
 * new-side start line. Only the citations the reader shows as chips are
 * written, and one that names no hunk location is dropped.
 */
export function renderBriefAsPullRequestDescription(
  brief: NormalizedBrief,
): string {
  const sections = [
    ...(brief.flow?.trees ?? []).map(flowSection),
    brief.ownership === undefined
      ? undefined
      : ownershipSection(brief.ownership),
    brief.reach === undefined ? undefined : blastRadiusSection(brief.reach),
    brief.startHere === undefined
      ? undefined
      : startHereSection(brief.startHere),
  ].filter((section) => section !== undefined);
  return `${sections.join("\n\n")}\n`;
}

function flowSection(tree: BriefFlowTree): string {
  const lines = flowRows(tree.nodes).map((row) => {
    // The reader draws chips on a contract tree's root only, and elsewhere on changed steps only.
    const shown =
      tree.kind === "contract" ? row.depth === 0 : row.change !== "unchanged";
    const locations = shown ? citationLocations(row.citations) : [];
    return locations.length === 0
      ? flowRowLine(row)
      : `${flowRowLine(row)}  (${locations.join(", ")})`;
  });
  const fence = fenceFor(lines);
  const kind = briefFlowKindLabel(tree.kind);
  return [
    `### ${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${tree.title}`,
    "",
    `${fence}diff`,
    ...lines,
    fence,
  ].join("\n");
}

/** `path:line` for each hunk citation, in order and without repeats. */
function citationLocations(
  citations: ReadonlyArray<BriefCitation>,
): ReadonlyArray<string> {
  const locations = new Set<string>();
  for (const citation of citations) {
    if (citation.kind !== "hunk" || citation.path === undefined) continue;
    const range = matchUnifiedHunkHeader(citation.label);
    if (range === undefined) continue;
    // A deleted file's hunk has no new-side line; its path is still the location.
    const location =
      range.newStart === 0
        ? citation.path
        : `${citation.path}:${String(range.newStart)}`;
    locations.add(location);
  }
  return [...locations];
}

/** A backtick fence longer than any backtick run in the text, so a label cannot close it. */
function fenceFor(lines: ReadonlyArray<string>): string {
  const longest = Math.max(
    0,
    ...lines.flatMap((line) =>
      (line.match(/`+/g) ?? []).map((run) => run.length),
    ),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function ownershipSection(ownership: BriefOwnership): string {
  const notes = new Map(ownership.notes.map((note) => [note.path, note.note]));
  return [
    "## Shape",
    "",
    ...ownership.files.map((file) => {
      const note = notes.get(file.path);
      const counts = `${file.status}, +${String(file.additions)} -${String(file.deletions)}`;
      return note === undefined
        ? `- \`${file.path}\` (${counts})`
        : `- \`${file.path}\` (${counts}): ${note}`;
    }),
  ].join("\n");
}

function blastRadiusSection(reach: BriefReach): string | undefined {
  const lines = [
    ...reach.symbols.flatMap((symbol) =>
      symbol.outsideCallerFiles === 0
        ? []
        : [
            `- \`${symbol.name}\` is named in ${String(symbol.outsideCallerFiles)} ${symbol.outsideCallerFiles === 1 ? "file" : "files"} outside this change`,
          ],
    ),
    ...reach.removedStillReferenced.map(
      (removed) =>
        `- Removed \`${removed.name}\` is still named in ${removed.paths.map((path) => `\`${path}\``).join(", ")}`,
    ),
    ...reach.untested.map(
      (entry) => `- No changed test mentions \`${entry.path}\``,
    ),
  ];
  if (lines.length === 0) return undefined;
  return ["## Blast radius", "", "Text match, one hop out.", "", ...lines].join(
    "\n",
  );
}

function startHereSection(startHere: BriefStartHere): string {
  return [
    "## Start here",
    "",
    startHere.lead,
    "",
    ...startHere.order.map((entry, index) =>
      entry.why === undefined
        ? `${String(index + 1)}. \`${entry.path}\``
        : `${String(index + 1)}. \`${entry.path}\`: ${entry.why}`,
    ),
  ].join("\n");
}
