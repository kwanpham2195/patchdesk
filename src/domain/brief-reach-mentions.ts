/*
 * Where a Blast radius name is mentioned outside the pull request: the line,
 * the declaration it sits in, and what kind of mention the line reads as.
 *
 * Every rule here is a text rule over one line or one file, like the rest of
 * the block, so a "call" is a line shaped like a call, not a resolved one.
 */

/** How one line mentions a name, read from its text alone. */
export type BriefReachMentionKind = "call" | "type" | "import" | "other";

/** One line outside the pull request that names a changed or removed symbol. */
export type BriefReachMention = {
  readonly path: string;
  /** 1-based line number at the represented head. */
  readonly line: number;
  /** The nearest declaration the line sits in; absent at a file's top level. */
  readonly enclosing?: string;
  readonly kind: BriefReachMentionKind;
};

/** Past thirty sites one name stops being a list a reviewer reads. */
export const MAX_MENTIONS_PER_NAME = 30;
/** The whole block's site budget, so a Brief with many names stays small on disk. */
export const MAX_MENTIONS_TOTAL = 200;

/** The order sites are kept under a cap and drawn under a file. */
export const MENTION_KIND_ORDER: ReadonlyArray<BriefReachMentionKind> = [
  "call",
  "type",
  "import",
  "other",
];

/**
 * One kind rule per row, tried in order; the first row whose pattern matches
 * the line decides. `import type` comes before the plain import row so a
 * type-only import reads as a type mention.
 */
const MENTION_KIND_RULES: ReadonlyArray<{
  readonly kind: BriefReachMentionKind;
  readonly pattern: (name: string) => RegExp;
}> = [
  {
    kind: "type",
    pattern: (name) =>
      new RegExp(
        `^\\s*(?:import|export)\\s+type\\b|^\\s*import\\b.*\\btype\\s+${word(name)}`,
      ),
  },
  {
    kind: "import",
    pattern: () => /^\s*import\b|^\s*export\b[^;]*\bfrom\s*["']|\brequire\s*\(/,
  },
  {
    kind: "call",
    pattern: (name) =>
      new RegExp(
        [
          `${word(name)}\\s*(?:<[^<>]*>)?\\s*\\(`,
          `\\bnew\\s+${word(name)}`,
          `${word(name)}\\s*\\.`,
          `<${word(name)}(?=[\\s/])`,
        ].join("|"),
      ),
  },
  {
    kind: "type",
    pattern: (name) =>
      new RegExp(
        [
          `:\\s*${word(name)}`,
          `<\\s*${word(name)}\\s*>`,
          `\\b(?:extends|implements|as)\\s+${word(name)}`,
        ].join("|"),
      ),
  },
];

/** What kind of mention `text` makes of `name`; `other` when no rule matches. */
export function mentionKind(text: string, name: string): BriefReachMentionKind {
  return (
    MENTION_KIND_RULES.find((rule) => rule.pattern(name).test(text))?.kind ??
    "other"
  );
}

/**
 * Declaration heads the enclosing scan recognizes, one row per kind of head.
 * Each captures the declared name; `method` rows are later qualified with the
 * class they sit in.
 */
const DECLARATION_RULES: ReadonlyArray<{
  readonly declares: "function" | "class" | "method";
  readonly pattern: RegExp;
}> = [
  {
    declares: "function",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  },
  {
    declares: "class",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  },
  {
    // An arrow or function expression bound to a name, including a React component.
    declares: "function",
    pattern:
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)?\s*(?::[^=]*)?(?:=>|$)|[A-Za-z_$][\w$]*\s*=>)/,
  },
  {
    // Go: `func Name(` and `func (r *T) Name(`.
    declares: "function",
    pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  },
  { declares: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  {
    // An indented method head whose line ends in `{`.
    declares: "method",
    pattern:
      /^\s+(?:(?:public|private|protected|static|async|override|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::[^{]*)?\{\s*$/,
  },
  {
    // A modifier-led method head whose parameters continue on the next lines; a bare `name(` is a call.
    declares: "method",
    pattern:
      /^\s+(?:(?:public|private|protected|static|async|override|get|set)\s+)+(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(\s*$/,
  },
];

/** Words that open a block with a method-like head but declare nothing. */
const CONTROL_WORDS: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "function",
]);

/**
 * The nearest declaration `lineIndex` (0-based) sits in, by indentation: the
 * scan walks up to each line indented less than the last block it passed, and
 * stops at the first one that is a declaration head. A non-declaration at
 * column zero (`export const table = {`) ends the scan, so a mention there
 * reads as top level. A method is named `Class.method` when its class is found
 * the same way.
 */
export function enclosingDeclaration(
  lines: ReadonlyArray<string>,
  lineIndex: number,
): string | undefined {
  const own = lines[lineIndex];
  if (own === undefined) return undefined;
  const found = declarationAbove(lines, lineIndex, indentation(own) + 1);
  if (found === undefined || found.declares !== "method") return found?.name;
  const owner = declarationAbove(lines, found.index - 1, found.indent);
  return owner?.declares === "class"
    ? `${owner.name}.${found.name}`
    : found.name;
}

function declarationAbove(
  lines: ReadonlyArray<string>,
  from: number,
  belowIndent: number,
):
  | {
      readonly name: string;
      readonly declares: "function" | "class" | "method";
      readonly index: number;
      readonly indent: number;
    }
  | undefined {
  let limit = belowIndent;
  for (let index = from; index >= 0 && limit > 0; index -= 1) {
    const text = lines[index] ?? "";
    if (isContinuation(text.trim())) continue;
    const indent = indentation(text);
    if (indent >= limit) continue;
    const head = declarationHead(text);
    if (head !== undefined) return { ...head, index, indent };
    limit = indent;
  }
  return undefined;
}

/** A declaration head fits well inside this; longer lines are cut so the head rules cannot backtrack across a minified line. */
const MAX_DECLARATION_LINE_LENGTH = 500;

function declarationHead(line: string):
  | {
      readonly name: string;
      readonly declares: "function" | "class" | "method";
    }
  | undefined {
  const text = line.slice(0, MAX_DECLARATION_LINE_LENGTH);
  for (const rule of DECLARATION_RULES) {
    const name = rule.pattern.exec(text)?.[1];
    if (name !== undefined && !CONTROL_WORDS.has(name))
      return { name, declares: rule.declares };
  }
  return undefined;
}

/**
 * A line that neither opens nor closes the block a mention sits in: blank, a
 * comment, the `): Type {` tail of a multi-line signature, or `} else {`.
 */
function isContinuation(trimmed: string): boolean {
  return (
    trimmed === "" ||
    /^(?:\/\/|\/\*|\*)/.test(trimmed) ||
    trimmed.startsWith(")") ||
    (trimmed.startsWith("}") && trimmed.endsWith("{"))
  );
}

function indentation(text: string): number {
  return text.length - text.trimStart().length;
}

/** The name as a whole word; `$` is legal in an identifier and must be escaped. */
function word(name: string): string {
  return `(?<![\\w$])${name.replaceAll("$", "\\$")}(?![\\w$])`;
}
