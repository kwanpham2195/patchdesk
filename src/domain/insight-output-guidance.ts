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
    "Write a Brief: the structure of this change -- its flow, ownership, and where to start reading.",
    "In ownership.notes, give at most one short note for each changed file, keyed by its exact path from the patch. Say what the file is responsible for after the change; do not say what the code does. A note that only re-words the file name teaches nothing: for a test file, name the behavior the tests hold in place, not the file they sit next to.",
    "In startHere.lead, write one sentence of reading advice: which file to read first, and why the rest follow from it.",
    "In startHere.order, list the first 3 to 5 files to read, in the order to read them, each by its exact path from the patch and with a short why. Patchdesk drops a path that is not a file this patch changes.",
    "In flow, give at most one tree of each kind that the patch changes: call_tree, control_flow, and component. Before you write a tree, list every entry point whose behavior this patch changes -- each command, request path, and error path -- and give each one a root. A changed file with no root in any tree is a gap, not a simplification. Omit a kind the patch does not change, and omit flow entirely when the patch adds, removes, or reorders no step, such as a rename, a docs change, or a pure refactor.",
    "A call_tree is the smallest call graph that makes the change clear: each step is the real function or method name with its parameter names as written in the patch, such as validateManualDays(command, suggestion), never a sentence; its children are the calls made inside it, in the order they run; name a call once under each caller and never nest a step under itself; when a step has both a definition hunk and a call-site hunk, cite both on that one line. Never list a test function as a step; tests belong to ownership.notes, not to flow.",
    "For example, a change that adds validation before saving is the root handleSave(request) unchanged, with children validateRequest(request) added and persistPlan(plan) unchanged.",
    "A control_flow step is one short pseudocode line, such as on(save), if stops are empty, or return cached result, never a full sentence and never a bare function name. A step you can only name by its identifier belongs in call_tree; when both the conditions and the call graph changed, give both trees. A component step is the component name in angle brackets, such as <SessionToolbar>, with hooks as plain names -- only for user-interface component trees such as React or Vue; omit component for code with no user interface.",
    "Build each tree as nested steps, and mark each step added, removed, or unchanged. When the patch deletes a line that set a value or took a branch, show that step as removed. When an added step can return an error or exit early, show each new exit as its own step; a new failure mode for data that already exists is the step a reviewer most needs.",
    "Give an added or removed step the h alias of the hunk that shows it when the patch shows it, and leave citations empty when it does not -- never omit a step for lack of a citation, and never cite a description or commit alias in flow. Mark a step added only when it did not exist before the patch, removed only when it no longer exists after it, and unchanged when it exists on both sides even if its body changed; show what changed inside an unchanged step as its added and removed children, and cite on the unchanged step the hunk that changes its body.",
    "Keep each label within 120 characters. Keep each tree at most three levels deep and fifteen steps.",
    "Never invent motivation, intent, trade-offs, or product impact.",
    "Do not narrate the patch file by file and do not restate code that the diff already shows.",
    "Write no numbers and no counts in prose; a flow label copies the identifier from the patch as written, digits included. Patchdesk produces every count from a tool.",
  ].join(" ");
}
