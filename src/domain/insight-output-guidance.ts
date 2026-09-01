export type GuidedInsightType = "analysis" | "walkthrough" | "brief";

const SIMPLIFIED_TECHNICAL_ENGLISH = [
  "Write all human-readable text in ASD-STE100 / Simplified Technical English.",
  "Use short, direct sentences in the active voice. Put one main idea in each sentence.",
  "Prefer common words. Define an uncommon technical term when the reader needs it.",
  "Keep exact code identifiers, paths, commands, and API names. Do not replace them with approximate terms.",
  "Do not use idioms, promotional language, ornamental prose, or rhetorical questions.",
].join(" ");

const REVIEWER_FRAMING = [
  "Write for a reviewer who must understand the net change and decide where to inspect.",
  "Use an inverted pyramid: state the evidenced goal and reason first, then the behavior change, reviewer impact, decisions, and fine detail.",
  "Never invent motivation, intent, trade-offs, or product impact. Mark missing evidence as an assumption or an unresolved item.",
  "Do not narrate the patch file by file or restate code that the diff already shows.",
  "Derive public API and compatibility impact from the evidence when it applies.",
  "Do not repeat one topic across the summary, findings, callouts, unresolved items, and assumptions unless each occurrence adds a different fact.",
].join(" ");

/** Fixed human-readable output guidance shared by every Insight provider. */
export function insightOutputGuidance(type: GuidedInsightType): string {
  if (type === "analysis") {
    return [
      SIMPLIFIED_TECHNICAL_ENGLISH,
      REVIEWER_FRAMING,
      "Keep the change summary short and reviewer-focused.",
      "Choose the smallest Markdown form that makes each point clear. Use a short paragraph for one connected idea. Use a bullet outline when the reader must scan several facts, steps, effects, conditions, or findings. Do not put several independent ideas in one large paragraph.",
      "When a relationship is easier to see than to describe, use one focused sketch: pseudocode for logic, a call tree for control flow, a component tree for UI structure, a shallow file tree for responsibility, or a compact diff for a change in shape. Include only the calls, files, states, and boundaries needed for the point.",
      "Return the intended Markdown structure directly. The renderer preserves it and does not rewrite paragraphs into outlines.",
      "Keep facts, assumptions, and unresolved questions separate.",
    ].join(" ");
  }

  if (type === "walkthrough") {
    return [
      SIMPLIFIED_TECHNICAL_ENGLISH,
      REVIEWER_FRAMING,
      "Explain the change as a short semantic walkthrough, not as a file inventory.",
      "Choose the smallest Markdown form that makes each point clear. Use a short paragraph for one connected idea and a bullet outline for several facts or steps. Do not put several independent ideas in one large paragraph.",
      "Return the intended Markdown structure directly. The renderer preserves it.",
      "Group related hunks by behavior. State the behavior before consequences and validation.",
    ].join(" ");
  }

  return [
    SIMPLIFIED_TECHNICAL_ENGLISH,
    "Write a Brief: what this change is for, in 2 to 4 sentences, ordered from coarse to granular. State the goal first.",
    "Cite every sentence. Each sentence carries one or more aliases from the supplied citation manifest, and a sentence you cannot cite is written as an assumption instead.",
    "Check each claim in the description against the patch. In descriptionDrift.claimed, list a claim about behavior -- what the code does, or no longer does -- that the patch does not support: quote the sentence, cite the description paragraph it comes from, and say in the note what you looked for in the patch.",
    'Do not put a claim about a build, a test run, a benchmark, lint, CI, a screenshot, or a manual check in descriptionDrift.claimed. A patch cannot carry a verification result, so a line such as "the test suite passes" is never drift.',
    "In descriptionDrift.undescribed, list behavior that the patch changes and the description does not mention, and cite the hunks that show it. Do not add an entry you cannot cite.",
    "In ownership.notes, give at most one short note for each changed file, keyed by its exact path from the patch. Say what the file is responsible for after the change; do not say what the code does.",
    "In ownership.contract, name the one hunk whose signature or type explains the rest of the patch: put its h alias in citation and write a one-line caption. Omit ownership.contract if no single hunk does that.",
    "In startHere.lead, write one sentence of reading advice: which file to read first, and why the rest follow from it.",
    "In startHere.order, list the first 3 to 5 files to read, in the order to read them, each by its exact path from the patch and with a short why. Patchdesk drops a path that is not a file this patch changes.",
    "In flow, give at most two trees, each a runtime sequence the patch changes, as nested steps, and mark each step added, removed, or unchanged.",
    "Give every added or removed step an h alias citing the hunk that adds or removes it; a description or commit alias does not count for flow, and an unchanged step needs no citation and only gives the changed steps their place.",
    "Keep each label a short verb phrase within 80 characters. Keep each tree at most three levels deep and fifteen steps.",
    "Omit flow entirely when the patch adds, removes, or reorders no step, such as a rename, a docs change, or a pure refactor.",
    "Never invent motivation, intent, trade-offs, or product impact. If the evidence does not state why the change was made, say so as an assumption.",
    "Do not narrate the patch file by file and do not restate code that the diff already shows.",
    "Write no numbers and no counts. Patchdesk produces every count from a tool.",
  ].join(" ");
}
