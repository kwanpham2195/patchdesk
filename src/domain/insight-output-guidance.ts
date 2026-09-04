import {
  MAX_FLOW_DEPTH,
  MAX_FLOW_LABEL_LENGTH,
  MAX_FLOW_NODES_PER_TREE,
  MAX_FLOW_TREES,
} from "./brief-flow";

export type GuidedInsightType = "analysis" | "walkthrough" | "brief";

const SIMPLIFIED_TECHNICAL_ENGLISH = [
  "Write all human-readable text in ASD-STE100 / Simplified Technical English.",
  "Use short, direct sentences in the active voice. Put one main idea in each sentence.",
  "Prefer common words. Define an uncommon technical term when the reader needs it.",
  "Keep exact code identifiers, paths, commands, and API names. Do not replace them with approximate terms.",
  "Do not use idioms, promotional language, ornamental prose, or rhetorical questions.",
].join(" ");

const ANALYSIS_REVIEWER_FRAMING = [
  "Write for a reviewer who knows this codebase but has not read the diff. Their time is the scarce resource: give them the framing the code cannot give them, then stop.",
  "Default to short, and order every text coarse to granular, so a reader who stops early still leaves with a correct understanding.",
  "Omit anything that has nothing to say. Most changes have no validation plan, no assumptions, no unresolved items, and no callouts; an empty list is the normal answer, not a failure.",
  "Never invent the why. Motivation, intent, and trade-offs must come from the pull request description, the commits, or a review thread. When you do not know why a change was made, record an unresolved item; never guess.",
  "Do not narrate the patch file by file or restate code that the diff already shows. The Brief Insight owns the structure of the change, so point at it rather than drawing your own call tree, component tree, file tree, or compact diff.",
  "Derive public API and compatibility impact from the evidence when it applies.",
  "Do not repeat one topic across the summary, findings, callouts, unresolved items, and assumptions unless each occurrence adds a different fact.",
].join(" ");

/** Fixed human-readable output guidance shared by every Insight provider. */
export function insightOutputGuidance(type: GuidedInsightType): string {
  if (type === "analysis") {
    return [
      SIMPLIFIED_TECHNICAL_ENGLISH,
      ANALYSIS_REVIEWER_FRAMING,
      "Keep the change summary short and reviewer-focused.",
      "Choose the smallest Markdown form that makes each point clear. Use a short paragraph for one connected idea. Use a bullet outline when the reader must scan several facts, steps, effects, conditions, or findings. Do not put several independent ideas in one large paragraph.",
      "Return the intended Markdown structure directly. The renderer preserves it and does not rewrite paragraphs into outlines.",
      "Keep facts, assumptions, and unresolved questions separate.",
    ].join(" ");
  }

  if (type === "walkthrough") {
    return [
      SIMPLIFIED_TECHNICAL_ENGLISH,
      "Write for a reviewer who must understand how the change behaves and decide where to inspect.",
      "State what the patch does, never why it was made: never invent motivation, intent, trade-offs, or product impact, and never copy them from the pull request description.",
      "Do not narrate the patch file by file or restate code that the diff already shows.",
      "Do not repeat one topic across chapters and sections unless each occurrence adds a different fact.",
      "Explain the change as a short semantic walkthrough, not as a file inventory.",
      // The Walkthrough reader shows every title and prose string literally, so Markdown arrives as visible punctuation.
      "Write every chapter title, section title, and prose string as plain text. Use no Markdown: no bullet or heading markers, no emphasis markers, and no backticks. Write an identifier or a path as itself, with no quoting around it.",
      "Group related hunks by behavior. State the behavior before consequences and validation.",
    ].join(" ");
  }

  // One rule per line under a heading: the model applies these while it writes
  // a tree, and a single paragraph of them buried the call-tree rules.
  return [
    SIMPLIFIED_TECHNICAL_ENGLISH,
    "",
    "WHAT A BRIEF IS",
    "Write a Brief: the structure of this change -- its flow, ownership, and where to start reading.",
    "Never invent motivation, intent, trade-offs, or product impact.",
    "Do not narrate the patch file by file and do not restate code that the diff already shows.",
    "Write no numbers and no counts in prose; a flow label copies the identifier from the patch as written, digits included. Patchdesk produces every count from a tool.",
    "",
    "OWNERSHIP NOTES",
    "In ownership.notes, give at most one short note for each changed file, keyed by its exact path from the patch.",
    "Say what the file is responsible for after the change; do not say what the code does.",
    "A note that only re-words the file name teaches nothing: for a test file, name the behavior the tests hold in place, not the file they sit next to.",
    "Together the notes read as a shallow file tree of who owns what:",
    "src/",
    "|-- commands/       # parses user actions",
    "|-- sessions/       # owns session state",
    "`-- transport/      # sends API requests",
    "",
    "START HERE",
    "In startHere.lead, write one sentence of reading advice: which file to read first, and why the rest follow from it.",
    "In startHere.order, list the first 3 to 5 files to read, in the order to read them, each by its exact path from the patch and with a short why.",
    "Patchdesk drops a path that is not a file this patch changes.",
    "",
    "WHEN TO GIVE A FLOW TREE",
    "In flow, give at most one tree of each kind that the patch changes: call_tree, control_flow, and component.",
    "Before you write a tree, list every entry point whose behavior this patch changes -- each command, request path, and error path -- and give each one a root.",
    "A changed file with no root in any tree is a gap, not a simplification.",
    "Omit a kind the patch does not change.",
    "Omit flow entirely when the patch adds, removes, or reorders no step, such as a rename, a docs change, or a pure refactor.",
    "Build each tree as nested steps, and mark each step added, removed, or unchanged.",
    "",
    "CALL_TREE",
    "A call_tree is the smallest call graph that makes the change clear.",
    "Each step is the real function or method name with its parameter names as written in the patch, such as validateManualDays(command, suggestion), never a sentence.",
    "The children of a step are the calls made inside it, in the order they run.",
    "Name a call once under each caller, and never nest a step under itself.",
    "Write a new early return inside an unchanged step as return <ErrorName>, with no prose after it; it belongs in control_flow when you can state the condition that reaches it.",
    "Never list a test function as a step; tests belong to ownership.notes, not to flow.",
    "A call-tree change reads like this, where the step that gained a child stays unchanged and only the new child is added:",
    " submitForm",
    "   createSession",
    "     persistPrompt",
    "+    expandSkillMention",
    "     launchAgent",
    "   navigateToSession",
    "+    subscribeToEvents",
    "",
    "CONTROL_FLOW",
    "A control_flow step is one short pseudocode line, such as on(save), if stops are empty, or return cached result, never a full sentence and never a bare function name.",
    "A step you can only name by its identifier belongs in call_tree.",
    "When both the conditions and the call graph changed, give both trees.",
    "An on ... entry point is a root; the if ... and return ... steps that follow it are its children, nested under the condition they depend on. A condition or a return is never a root.",
    "A control-flow change reads like this:",
    " on(save)",
    "-  write content",
    "+  if content is unchanged",
    "+    return cached result",
    "+  write new content",
    "+  invalidate cache",
    "",
    "COMPONENT",
    "A component step is the component name in angle brackets, such as <SessionToolbar>, with hooks as plain names.",
    "Give a component tree only for a user-interface component tree such as React or Vue; omit component for code with no user interface.",
    "A component change reads like this:",
    " <SessionPage>",
    "   useSessionEvents()",
    "   <SessionToolbar>",
    "+    <RunSkillButton>",
    "   <SessionTimeline>",
    "+    <SkillResultCard>",
    "",
    "MARKING ADDED, REMOVED, AND UNCHANGED",
    "Mark a step added only when it did not exist before the patch, removed only when it no longer exists after it, and unchanged when it exists on both sides even if its body changed.",
    "Read the hunk's - and + lines to decide, never its context lines or its @@ header.",
    "Never mark a step added because a test for it is new: a branch a new test reaches was already there.",
    "A step that only gained a child stays unchanged; show what changed inside it as its added and removed children.",
    "When the patch deletes a line that set a value or took a branch, show that step as removed.",
    "When an added step can return an error or exit early, show each new exit as its own step; a new failure mode for data that already exists is the step a reviewer most needs.",
    "",
    "CITATIONS",
    "Give an added or removed step the h alias of the hunk that shows it when the patch shows it, and leave citations empty when it does not -- never omit a step for lack of a citation, and never cite a description or commit alias in flow.",
    "Cite on an unchanged step the hunk that changes its body.",
    "When a step has both a definition hunk and a call-site hunk, cite both on that one line.",
    "",
    "LIMITS",
    `Give at most ${MAX_FLOW_TREES} flow trees, one for each kind.`,
    `Keep each tree at most ${MAX_FLOW_DEPTH} levels deep and at most ${MAX_FLOW_NODES_PER_TREE} steps.`,
    `Keep each label within ${MAX_FLOW_LABEL_LENGTH} characters.`,
  ].join("\n");
}
