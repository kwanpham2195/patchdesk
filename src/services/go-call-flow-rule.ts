import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import type { DiffNode, DiffResult } from "calldiff";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";

const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GO_DEFINITIONS = 2_500;
const MAX_GO_STEPS_PER_FUNCTION = 512;
const MAX_GO_BODY_STEPS = 5_000;
const MAX_GO_ENTRIES = 100;
const MAX_GO_EXPANDED_NODES = 10_000;
const MAX_GO_DIFF_NODES = 5_000;
const MAX_GO_CALL_LABEL_LENGTH = 96;
const BUILTIN_FUNCTIONS = new Set([
  "append",
  "cap",
  "clear",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "max",
  "min",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
]);
const BUILTIN_CONVERSION_TYPES = new Set([
  "any",
  "bool",
  "byte",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);
export type GoCallFlowRuleOptions = {
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly paths: ReadonlyArray<string>;
  readonly changedPaths: ReadonlyArray<string>;
  readonly maxDepth: number;
  readonly color: false;
  readonly locs: true;
};

/** Typed signal that Go analysis exceeded an app-owned deterministic budget. */
export class GoCallFlowBudgetExceededError extends Error {
  readonly budget: string;

  constructor(budget: string) {
    super(`GoCallFlowRuleBudgetExceeded:${budget}`);
    this.name = "GoCallFlowBudgetExceededError";
    this.budget = budget;
  }
}

type SourceLocation = {
  file: string;
  line: number;
  endLine?: number;
};

type OptionalSourceLocation = {
  file?: string;
  line?: number;
  endLine?: number;
};

type DefinitionLines = {
  line: number;
  endLine?: number;
};

type GoStep =
  | {
      readonly type: "call";
      readonly key: string;
      readonly label: string;
      readonly location: SourceLocation;
    }
  | {
      readonly type: "branch";
      readonly kind:
        | "unresolved"
        | "dependency"
        | "reference"
        | "concurrent"
        | "deferred";
      readonly key: string;
      readonly label: string;
      readonly location: SourceLocation;
      readonly children: ReadonlyArray<GoStep>;
    };

type GoFunction = {
  readonly key: string;
  readonly symbol: string;
  readonly packageQualifier: string;
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly steps: ReadonlyArray<GoStep>;
  readonly exported: boolean;
};

type CallNode = {
  readonly key: string;
  readonly targetKey: string;
  readonly label: string;
  readonly kind:
    | "call"
    | "branch"
    | "unresolved"
    | "dependency"
    | "reference"
    | "concurrent"
    | "deferred";
  readonly depth: number;
  readonly ancestors: ReadonlyArray<string>;
  readonly file?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly children: ReadonlyArray<CallNode>;
};

type ReceiverBinding = {
  readonly name?: string;
  readonly typeName: string;
};

type ExtractionContext = {
  readonly packageKey: string;
  readonly localTypes: ReadonlySet<string>;
  readonly definitions: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
  readonly shadowedValues: ReadonlySet<string>;
  readonly receiver?: ReceiverBinding;
  readonly functionStepBudget: WorkBudget;
  readonly totalStepBudget: WorkBudget;
};

type WorkBudget = {
  readonly name: string;
  readonly limit: number;
  used: number;
};

type RevisionSource = {
  readonly file: string;
  readonly source: string;
};

type PackageDeclarations = {
  readonly packageKey: string;
  readonly types: ReadonlySet<string>;
  readonly definitions: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
};

type MutablePackageDeclarations = {
  readonly types: Set<string>;
  readonly definitions: Set<string>;
  readonly methods: Set<string>;
};

/** Runs the app-owned, syntactic Go language rule over two immutable commits. */
export function runGoCallFlowRule(options: GoCallFlowRuleOptions): DiffResult {
  if (options.paths.some((path) => !path.endsWith(".go"))) {
    throw new Error("Go call-flow rule received a non-Go path");
  }
  const sourcePaths = new Set(options.paths);
  if (
    options.changedPaths.some(
      (path) => !path.endsWith(".go") || !sourcePaths.has(path),
    )
  ) {
    throw new Error("Go call-flow rule received an invalid changed path");
  }
  const before = loadRevision(options.cwd, options.from, options.paths);
  const after = loadRevision(options.cwd, options.to, options.paths);
  const entries = inferEntries(
    before,
    after,
    new Set(options.changedPaths),
    options.maxDepth,
  );
  if (entries.length > MAX_GO_ENTRIES) budgetExceeded("entries");
  const displayEntries = displayEntryNames(entries, before, after);
  const expansionBudget: WorkBudget = {
    name: "expanded-nodes",
    limit: MAX_GO_EXPANDED_NODES,
    used: 0,
  };
  const diffBudget: WorkBudget = {
    name: "diff-nodes",
    limit: MAX_GO_DIFF_NODES,
    used: 0,
  };
  const trees: Array<DiffResult["trees"][number]> = [];

  for (const entry of entries) {
    const tree = diffEntry(
      entry,
      before,
      after,
      options.maxDepth,
      expansionBudget,
      diffBudget,
    );
    if (tree === undefined) continue;
    const ascii = renderDiff(tree, options.locs);
    const displayEntry = displayEntries.get(entry);
    if (displayEntry === undefined) {
      throw new Error(`Go call-flow entry has no definition: ${entry}`);
    }
    trees.push({ entry: displayEntry, ascii, tree });
  }

  const message =
    trees.length === 0
      ? `No Go callstack changes between ${options.from} and ${options.to}.`
      : undefined;
  const ascii =
    message ??
    [
      `go call-flow diff ${options.from} → ${options.to}`,
      "",
      ...trees.map((tree) => tree.ascii),
    ].join("\n\n");
  const result: DiffResult =
    message === undefined
      ? { mode: "diff", from: options.from, to: options.to, trees, ascii }
      : {
          mode: "diff",
          from: options.from,
          to: options.to,
          message,
          trees,
          ascii,
        };
  validateResult(result);
  return result;
}

function loadRevision(
  cwd: string,
  revision: string,
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, GoFunction> {
  const sources: Array<RevisionSource> = [];
  for (const file of [...paths].sort()) {
    const source = readRevisionFile(cwd, revision, file);
    if (source !== undefined) sources.push({ file, source });
  }
  const declarationsByPackage = new Map<string, MutablePackageDeclarations>();
  const definitionBudget: WorkBudget = {
    name: "definitions",
    limit: MAX_GO_DEFINITIONS,
    used: 0,
  };
  for (const item of sources) {
    const declared = packageDeclarations(
      item.file,
      item.source,
      definitionBudget,
    );
    const declarations = declarationsByPackage.get(declared.packageKey) ?? {
      types: new Set<string>(),
      definitions: new Set<string>(),
      methods: new Set<string>(),
    };
    for (const name of declared.types) declarations.types.add(name);
    for (const definition of declared.definitions) {
      declarations.definitions.add(definition);
    }
    for (const method of declared.methods) declarations.methods.add(method);
    declarationsByPackage.set(declared.packageKey, declarations);
  }
  const functions: Array<GoFunction> = [];
  const totalStepBudget: WorkBudget = {
    name: "body-steps",
    limit: MAX_GO_BODY_STEPS,
    used: 0,
  };
  for (const item of sources) {
    functions.push(
      ...extractFunctions(
        item.file,
        item.source,
        declarationsByPackage,
        totalStepBudget,
      ),
    );
  }
  functions.sort((left, right) => {
    const byKey = left.key.localeCompare(right.key);
    if (byKey !== 0) return byKey;
    const byFile = left.file.localeCompare(right.file);
    if (byFile !== 0) return byFile;
    return left.line - right.line;
  });
  const index = new Map<string, GoFunction>();
  for (const fn of functions) {
    if (!index.has(fn.key)) index.set(fn.key, fn);
  }
  return index;
}

function readRevisionFile(
  cwd: string,
  revision: string,
  path: string,
): string | undefined {
  const listed = execFileSync(
    "git",
    ["ls-tree", "--name-only", revision, "--", path],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  if (listed !== path) return undefined;
  return execFileSync("git", ["show", `${revision}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extractFunctions(
  file: string,
  source: string,
  declarationsByPackage: ReadonlyMap<string, MutablePackageDeclarations>,
  totalStepBudget: WorkBudget,
): ReadonlyArray<GoFunction> {
  const tree = parseGo(file, source);
  const identity = packageKey(file, tree.rootNode);
  const qualifier = entryQualifier(file, tree.rootNode);
  const declarations = declarationsByPackage.get(identity);
  const localTypes = declarations?.types ?? new Set<string>();
  const knownDefinitions = declarations?.definitions ?? new Set<string>();
  const knownMethods = declarations?.methods ?? new Set<string>();
  const functions: Array<GoFunction> = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "function_declaration") {
      const name = childByType(node, "identifier")?.text;
      if (name === undefined) continue;
      const parameters = node.namedChildren.find(
        (child) => child.type === "parameter_list",
      );
      const body = childByType(node, "block");
      const shadowedValues = collectValueBindings(
        parameters === undefined ? [] : [parameters],
        body,
      );
      const context = extractionContext(
        identity,
        localTypes,
        knownDefinitions,
        knownMethods,
        shadowedValues,
        totalStepBudget,
      );
      functions.push({
        key: definitionKey(identity, name),
        symbol: name,
        packageQualifier: qualifier,
        label: `${name}${parameterLabel(parameters)}`,
        file,
        ...definitionLines(node),
        steps:
          body === undefined
            ? []
            : collectStatements(file, statementsOf(body), context),
        exported: isExported(name),
      });
      continue;
    }
    if (node.type !== "method_declaration") continue;
    const receiver = receiverBinding(node);
    const name = childByType(node, "field_identifier")?.text;
    if (receiver === undefined || name === undefined) continue;
    const parameterLists = node.namedChildren.filter(
      (child) => child.type === "parameter_list",
    );
    const parameters = parameterLists[1];
    const body = childByType(node, "block");
    const symbol = `${receiver.typeName}.${name}`;
    const shadowedValues = collectValueBindings(parameterLists, body);
    const methodContext = extractionContext(
      identity,
      localTypes,
      knownDefinitions,
      knownMethods,
      shadowedValues,
      totalStepBudget,
      receiver,
    );
    functions.push({
      key: definitionKey(identity, symbol),
      symbol,
      packageQualifier: qualifier,
      label: `${symbol}${parameterLabel(parameters)}`,
      file,
      ...definitionLines(node),
      steps:
        body === undefined
          ? []
          : collectStatements(file, statementsOf(body), methodContext),
      exported: isExported(name),
    });
  }
  return functions;
}

function packageDeclarations(
  file: string,
  source: string,
  definitionBudget: WorkBudget,
): PackageDeclarations {
  const tree = parseGo(file, source);
  const definitions = new Set<string>();
  const methods = new Set<string>();
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "function_declaration") {
      const name = childByType(node, "identifier")?.text;
      if (name !== undefined) {
        reserveBudget(definitionBudget);
        definitions.add(name);
      }
      continue;
    }
    if (node.type !== "method_declaration") continue;
    const receiver = receiverBinding(node);
    const name = childByType(node, "field_identifier")?.text;
    if (receiver !== undefined && name !== undefined) {
      reserveBudget(definitionBudget);
      const symbol = `${receiver.typeName}.${name}`;
      definitions.add(symbol);
      methods.add(symbol);
    }
  }
  return {
    packageKey: packageKey(file, tree.rootNode),
    types: collectDeclaredTypes(tree.rootNode),
    definitions,
    methods,
  };
}

function parseGo(file: string, source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Go);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    throw new Error(`Unable to parse Go source: ${file}`);
  }
  return tree;
}

function packageKey(file: string, root: Parser.SyntaxNode): string {
  return `${dirname(file)}\0${packageName(file, root)}`;
}

function packageName(file: string, root: Parser.SyntaxNode): string {
  const clause = childByType(root, "package_clause");
  const name = clause?.namedChildren[0]?.text;
  if (name === undefined) throw new Error(`Go source has no package: ${file}`);
  return name;
}

function entryQualifier(file: string, root: Parser.SyntaxNode): string {
  const directory = dirname(file).replace(/\\/g, "/");
  const declaredPackage = packageName(file, root);
  if (directory === ".") return declaredPackage;
  return basename(directory) === declaredPackage
    ? directory
    : `${directory}/${declaredPackage}`;
}

function collectDeclaredTypes(root: Parser.SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "type_spec" || node.type === "type_alias") {
      const name = childByType(node, "type_identifier")?.text;
      if (name !== undefined) names.add(name);
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return names;
}

function collectValueBindings(
  parameterLists: ReadonlyArray<Parser.SyntaxNode>,
  body: Parser.SyntaxNode | undefined,
): ReadonlySet<string> {
  const names = new Set<string>();
  const addIdentifiers = (node: Parser.SyntaxNode | undefined): void => {
    if (node === undefined) return;
    if (node.type === "identifier") names.add(node.text);
    else for (const child of node.namedChildren) addIdentifiers(child);
  };
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "func_literal") return;
    if (node.type === "parameter_declaration") {
      for (const child of node.namedChildren) {
        if (child.type === "identifier") names.add(child.text);
      }
      return;
    }
    if (node.type === "short_var_declaration" || node.type === "range_clause") {
      addIdentifiers(node.namedChildren[0]);
    } else if (node.type === "var_spec") {
      const name = node.namedChildren.find(
        (child) => child.type === "identifier",
      );
      if (name !== undefined) names.add(name.text);
    }
    for (const child of node.namedChildren) walk(child);
  };
  for (const parameters of parameterLists) walk(parameters);
  if (body !== undefined) walk(body);
  return names;
}

function receiverBinding(node: Parser.SyntaxNode): ReceiverBinding | undefined {
  const receiverList = node.namedChildren[0];
  if (receiverList?.type !== "parameter_list") return undefined;
  const declaration = childByType(receiverList, "parameter_declaration");
  if (declaration === undefined) return undefined;
  const name = declaration.namedChildren.find(
    (child) => child.type === "identifier",
  )?.text;
  const typeIdentifier = findDescendant(declaration, "type_identifier");
  if (typeIdentifier === undefined) return undefined;
  const typeName = typeIdentifier.text;
  return name === undefined ? { typeName } : { name, typeName };
}

function collectStatements(
  file: string,
  statements: ReadonlyArray<Parser.SyntaxNode>,
  context: ExtractionContext,
): ReadonlyArray<GoStep> {
  const steps: Array<GoStep> = [];
  const seen = new Set<string>();
  const push = (step: GoStep, startIndex: number): void => {
    const mark = `${step.type}:${step.key}:${startIndex}`;
    if (seen.has(mark)) return;
    seen.add(mark);
    reserveBudget(context.functionStepBudget);
    reserveBudget(context.totalStepBudget);
    steps.push(step);
  };

  const walk = (node: Parser.SyntaxNode): void => {
    if (
      node.type === "function_declaration" ||
      node.type === "method_declaration"
    ) {
      return;
    }
    if (node.type === "if_statement") {
      collectIf(file, node, context).forEach((step) =>
        push(step, node.startIndex),
      );
      return;
    }
    if (
      node.type === "expression_switch_statement" ||
      node.type === "type_switch_statement"
    ) {
      collectSwitch(file, node, context).forEach((step) =>
        push(step, node.startIndex),
      );
      return;
    }
    if (node.type === "go_statement" || node.type === "defer_statement") {
      const isDeferred = node.type === "defer_statement";
      const expression = node.namedChildren.find(
        (child) => child.type === "call_expression",
      );
      const callee = expression?.namedChildren[0];
      const functionLiteral = callee?.type === "func_literal";
      const label = isDeferred
        ? callee === undefined || expression === undefined
          ? "defer"
          : functionLiteral
            ? "defer func"
            : `defer ${formatCallLabel(callDisplayCallee(callee, context), expression)}`
        : "go";
      const children =
        expression === undefined || (isDeferred && !functionLiteral)
          ? []
          : collectWrapperExpression(file, expression, context);
      push(
        {
          type: "branch",
          kind: node.type === "go_statement" ? "concurrent" : "deferred",
          key: label,
          label,
          location: sourceLocation(file, node),
          children,
        },
        node.startIndex,
      );
      return;
    }
    if (node.type === "call_expression") {
      const callee = node.namedChildren[0];
      if (callee !== undefined && callee.type !== "func_literal") {
        const step = callStep(file, node, callee, context);
        if (step !== undefined) push(step, node.startIndex);
      }
      for (const child of node.namedChildren) {
        if (child === callee || child.type === "func_literal") continue;
        walk(child);
      }
      return;
    }
    if (node.type === "selector_expression") {
      const symbol = directReceiverSelectorSymbol(node, context.receiver);
      if (symbol !== undefined && context.methods.has(symbol)) {
        push(
          {
            type: "branch",
            kind: "reference",
            key: `reference:${definitionKey(context.packageKey, symbol)}`,
            label: `references ${node.text}`,
            location: sourceLocation(file, node),
            children: [],
          },
          node.startIndex,
        );
      }
      return;
    }
    if (node.type === "func_literal") return;
    for (const child of node.namedChildren) walk(child);
  };

  for (const statement of statements) walk(statement);
  return steps;
}

function collectWrapperExpression(
  file: string,
  expression: Parser.SyntaxNode,
  context: ExtractionContext,
): ReadonlyArray<GoStep> {
  const callee = expression.namedChildren[0];
  if (callee?.type === "func_literal") {
    const body = childByType(callee, "block");
    return body === undefined
      ? []
      : collectStatements(file, statementsOf(body), context);
  }
  return collectStatements(file, [expression], context);
}

function collectIf(
  file: string,
  node: Parser.SyntaxNode,
  context: ExtractionContext,
): ReadonlyArray<GoStep> {
  const blocks = node.namedChildren.filter((child) => child.type === "block");
  const consequent = blocks[0];
  const alternative = node.namedChildren.find(
    (child) =>
      child !== consequent &&
      (child.type === "if_statement" || child.type === "block"),
  );
  const conditionCandidates =
    consequent === undefined
      ? node.namedChildren
      : node.namedChildren.slice(0, node.namedChildren.indexOf(consequent));
  const steps: Array<GoStep> = conditionCandidates.flatMap((candidate) =>
    collectStatements(file, [candidate], context),
  );
  if (consequent !== undefined) {
    steps.push(...collectStatements(file, statementsOf(consequent), context));
  }
  if (alternative?.type === "if_statement") {
    steps.push(...collectIf(file, alternative, context));
  } else if (alternative?.type === "block") {
    steps.push(...collectStatements(file, statementsOf(alternative), context));
  }
  return steps;
}

function collectSwitch(
  file: string,
  node: Parser.SyntaxNode,
  context: ExtractionContext,
): ReadonlyArray<GoStep> {
  const isClause = (child: Parser.SyntaxNode): boolean =>
    child.type === "expression_case" ||
    child.type === "type_case" ||
    child.type === "default_case";
  const steps: Array<GoStep> = [];
  for (const subject of node.namedChildren) {
    if (isClause(subject)) continue;
    steps.push(...collectStatements(file, [subject], context));
  }
  for (const clause of node.namedChildren) {
    if (!isClause(clause)) continue;
    const statementList = childByType(clause, "statement_list");
    if (statementList !== undefined) {
      steps.push(
        ...collectStatements(file, statementList.namedChildren, context),
      );
    }
  }
  return steps;
}

function callStep(
  file: string,
  call: Parser.SyntaxNode,
  callee: Parser.SyntaxNode,
  context: ExtractionContext,
): GoStep | undefined {
  if (
    callee.type === "identifier" &&
    BUILTIN_FUNCTIONS.has(callee.text) &&
    !context.definitions.has(callee.text) &&
    !context.shadowedValues.has(callee.text)
  ) {
    return undefined;
  }
  if (isSyntaxProvableConversion(callee, context.localTypes)) return undefined;
  let symbol: string | undefined;
  if (callee.type === "identifier") {
    symbol = callee.text;
  } else if (callee.type === "selector_expression") {
    symbol = directReceiverSelectorSymbol(callee, context.receiver);
  }
  if (
    symbol !== undefined &&
    context.definitions.has(symbol) &&
    !context.shadowedValues.has(symbol)
  ) {
    return {
      type: "call",
      key: definitionKey(context.packageKey, symbol),
      label: formatCallLabel(symbol, call),
      location: sourceLocation(file, call),
    };
  }
  if (!isReceiverRootedSelector(callee, context.receiver)) return undefined;
  const exact = callee.text;
  const dependencyLabel = receiverDependencyLabel(callee, context.receiver);
  const label = formatCallLabel(dependencyLabel ?? exact, call);
  return {
    type: "branch",
    kind: dependencyLabel === undefined ? "unresolved" : "dependency",
    key:
      dependencyLabel === undefined
        ? `unresolved:${exact}\0${label}`
        : `dependency:${exact}\0${label}`,
    label,
    location: sourceLocation(file, call),
    children: [],
  };
}

function callDisplayCallee(
  callee: Parser.SyntaxNode,
  context: ExtractionContext,
): string {
  let symbol: string | undefined;
  if (callee.type === "identifier") symbol = callee.text;
  else if (callee.type === "selector_expression") {
    symbol = directReceiverSelectorSymbol(callee, context.receiver);
  }
  if (
    symbol !== undefined &&
    context.definitions.has(symbol) &&
    !context.shadowedValues.has(symbol)
  ) {
    return symbol;
  }
  return receiverDependencyLabel(callee, context.receiver) ?? callee.text;
}

function formatCallLabel(callee: string, call: Parser.SyntaxNode): string {
  const argumentsNode = childByType(call, "argument_list");
  const argumentsList: Array<string> = [];
  for (const argument of argumentsNode?.namedChildren ?? []) {
    if (argument.type !== "comment") {
      argumentsList.push(normalizeCallArgument(argument.text));
    }
  }
  if (argumentsList.length === 0) return boundedEmptyCallLabel(callee);
  const complete = `${callee}(${argumentsList.join(", ")})`;
  if (complete.length <= MAX_GO_CALL_LABEL_LENGTH) return complete;
  const included: Array<string> = [];
  for (const argument of argumentsList) {
    const candidate = `${callee}(${[...included, argument, "…"].join(", ")})`;
    if (candidate.length > MAX_GO_CALL_LABEL_LENGTH) break;
    included.push(argument);
  }
  return included.length === 0
    ? boundedEllipsisCallLabel(callee)
    : `${callee}(${[...included, "…"].join(", ")})`;
}

function boundedEmptyCallLabel(callee: string): string {
  const complete = `${callee}()`;
  return complete.length <= MAX_GO_CALL_LABEL_LENGTH
    ? complete
    : boundedEllipsisCallLabel(callee);
}

function boundedEllipsisCallLabel(callee: string): string {
  const maxCalleeLength = MAX_GO_CALL_LABEL_LENGTH - "(…)".length;
  return `${callee.slice(0, maxCalleeLength)}(…)`;
}

function normalizeCallArgument(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function isSyntaxProvableConversion(
  callee: Parser.SyntaxNode,
  localTypes: ReadonlySet<string>,
): boolean {
  if (callee.type === "identifier") {
    return (
      BUILTIN_CONVERSION_TYPES.has(callee.text) || localTypes.has(callee.text)
    );
  }
  if (
    ![
      "array_type",
      "channel_type",
      "function_type",
      "generic_type",
      "interface_type",
      "map_type",
      "pointer_type",
      "slice_type",
      "struct_type",
    ].includes(callee.type)
  ) {
    return false;
  }
  const typeIdentifier = findDescendant(callee, "type_identifier");
  return typeIdentifier === undefined || localTypes.has(typeIdentifier.text);
}

function isReceiverRootedSelector(
  selector: Parser.SyntaxNode,
  receiver: ReceiverBinding | undefined,
): boolean {
  if (receiver?.name === undefined || selector.type !== "selector_expression") {
    return false;
  }
  let root = selector.namedChildren[0];
  while (root?.type === "selector_expression") {
    root = root.namedChildren[0];
  }
  return root?.type === "identifier" && root.text === receiver.name;
}

function receiverDependencyLabel(
  selector: Parser.SyntaxNode,
  receiver: ReceiverBinding | undefined,
): string | undefined {
  if (
    receiver?.name === undefined ||
    selector.type !== "selector_expression" ||
    selector.namedChildren[0]?.type !== "selector_expression" ||
    !isReceiverRootedSelector(selector, receiver)
  ) {
    return undefined;
  }
  const receiverPrefix = new RegExp(`^${receiver.name}\\s*\\.\\s*`);
  const label = selector.text.replace(receiverPrefix, "");
  return label === selector.text || label.length === 0 ? undefined : label;
}

function directReceiverSelectorSymbol(
  selector: Parser.SyntaxNode,
  receiver: ReceiverBinding | undefined,
): string | undefined {
  if (receiver?.name === undefined || selector.type !== "selector_expression") {
    return undefined;
  }
  const object = selector.namedChildren[0];
  const field = childByType(selector, "field_identifier");
  if (
    object?.type !== "identifier" ||
    object.text !== receiver.name ||
    field === undefined
  ) {
    return undefined;
  }
  return `${receiver.typeName}.${field.text}`;
}

function displayEntryNames(
  entries: ReadonlyArray<string>,
  before: ReadonlyMap<string, GoFunction>,
  after: ReadonlyMap<string, GoFunction>,
): ReadonlyMap<string, string> {
  const functions = new Map<string, GoFunction>();
  const symbolCounts = new Map<string, number>();
  for (const entry of entries) {
    const fn = after.get(entry) ?? before.get(entry);
    if (fn === undefined) continue;
    functions.set(entry, fn);
    symbolCounts.set(fn.symbol, (symbolCounts.get(fn.symbol) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const fn = functions.get(entry);
    if (fn === undefined) continue;
    const display =
      (symbolCounts.get(fn.symbol) ?? 0) > 1
        ? `${fn.packageQualifier}.${fn.symbol}`
        : fn.symbol;
    if (used.has(display)) {
      throw new Error(`Go call-flow display entry collision: ${display}`);
    }
    used.add(display);
    names.set(entry, display);
  }
  return names;
}

function inferEntries(
  before: ReadonlyMap<string, GoFunction>,
  after: ReadonlyMap<string, GoFunction>,
  changedPaths: ReadonlySet<string>,
  maxDepth: number,
): ReadonlyArray<string> {
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  const reverse = new Map<string, Set<string>>();
  addReverseEdges(reverse, before);
  addReverseEdges(reverse, after);
  const distance = new Map<string, number>();
  const queue: Array<string> = [];
  for (const key of allKeys) {
    if (
      functionSignature(before.get(key)) === functionSignature(after.get(key))
    ) {
      continue;
    }
    distance.set(key, 0);
    queue.push(key);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const callee = queue[index];
    if (callee === undefined) continue;
    const nextDistance = (distance.get(callee) ?? 0) + 1;
    if (nextDistance > maxDepth) continue;
    for (const caller of reverse.get(callee) ?? []) {
      const previous = distance.get(caller);
      if (previous !== undefined && previous <= nextDistance) continue;
      distance.set(caller, nextDistance);
      queue.push(caller);
    }
  }
  const affected = [...distance.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const changedFileAffected = affected.filter((key) => {
    const fn = after.get(key) ?? before.get(key);
    return fn !== undefined && changedPaths.has(fn.file);
  });
  const preferred =
    changedFileAffected.length > 0 ? changedFileAffected : affected;
  const exported = preferred.filter(
    (key) =>
      before.get(key)?.exported === true || after.get(key)?.exported === true,
  );
  return topmostEntries(
    exported.length > 0 ? exported : preferred,
    before,
    after,
  );
}

function topmostEntries(
  candidates: ReadonlyArray<string>,
  before: ReadonlyMap<string, GoFunction>,
  after: ReadonlyMap<string, GoFunction>,
): ReadonlyArray<string> {
  if (candidates.length < 2) return candidates;
  const candidateSet = new Set(candidates);
  const adjacency = new Map<string, Set<string>>();
  addForwardEdges(adjacency, before);
  addForwardEdges(adjacency, after);
  const reachable = new Map<string, ReadonlySet<string>>();
  for (const candidate of candidates) {
    const found = new Set<string>();
    const visited = new Set([candidate]);
    const queue: Array<string> = [candidate];
    for (let index = 0; index < queue.length; index += 1) {
      const caller = queue[index];
      if (caller === undefined) continue;
      const callees = [...(adjacency.get(caller) ?? [])].sort((left, right) =>
        left.localeCompare(right),
      );
      for (const callee of callees) {
        if (candidateSet.has(callee) && callee !== candidate) found.add(callee);
        if (visited.has(callee)) continue;
        visited.add(callee);
        queue.push(callee);
      }
    }
    reachable.set(candidate, found);
  }
  const topComponents = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          reachable.get(other)?.has(candidate) === true &&
          reachable.get(candidate)?.has(other) !== true,
      ),
  );
  const roots: Array<string> = [];
  for (const candidate of topComponents) {
    if (
      roots.some(
        (root) =>
          reachable.get(root)?.has(candidate) === true &&
          reachable.get(candidate)?.has(root) === true,
      )
    ) {
      continue;
    }
    roots.push(candidate);
  }
  return roots;
}

function addForwardEdges(
  forward: Map<string, Set<string>>,
  index: ReadonlyMap<string, GoFunction>,
): void {
  for (const [caller, fn] of index) {
    const callees = forward.get(caller) ?? new Set<string>();
    const visit = (steps: ReadonlyArray<GoStep>): void => {
      for (const step of steps) {
        if (step.type === "branch") visit(step.children);
        else callees.add(step.key);
      }
    };
    visit(fn.steps);
    forward.set(caller, callees);
  }
}

function addReverseEdges(
  reverse: Map<string, Set<string>>,
  index: ReadonlyMap<string, GoFunction>,
): void {
  for (const [caller, fn] of index) {
    const visit = (steps: ReadonlyArray<GoStep>): void => {
      for (const step of steps) {
        if (step.type === "branch") {
          visit(step.children);
          continue;
        }
        const callers = reverse.get(step.key) ?? new Set<string>();
        callers.add(caller);
        reverse.set(step.key, callers);
      }
    };
    visit(fn.steps);
  }
}

function functionSignature(fn: GoFunction | undefined): string {
  if (fn === undefined) return "missing";
  const signatureSteps = (
    steps: ReadonlyArray<GoStep>,
  ): ReadonlyArray<object> =>
    steps.map((step) =>
      step.type === "call"
        ? { type: step.type, key: step.key, label: step.label }
        : {
            type: step.type,
            kind: step.kind,
            key: step.key,
            label: step.label,
            children: signatureSteps(step.children),
          },
    );
  return JSON.stringify({ label: fn.label, steps: signatureSteps(fn.steps) });
}

function buildCallTree(
  key: string,
  index: ReadonlyMap<string, GoFunction>,
  maxDepth: number,
  budget: WorkBudget,
): CallNode {
  return expandCall(
    key,
    index,
    0,
    maxDepth,
    new Set<string>(),
    undefined,
    undefined,
    budget,
  );
}

function expandCall(
  key: string,
  index: ReadonlyMap<string, GoFunction>,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  callSite: SourceLocation | undefined,
  callLabel: string | undefined,
  budget: WorkBudget,
): CallNode {
  reserveBudget(budget);
  const fn = index.get(key);
  const ancestors = [...visiting];
  const label =
    callLabel ?? fn?.label ?? (key.includes("(") ? key : `${key}()`);
  const location =
    depth === 0 && fn !== undefined
      ? locationFields(fn.file, fn.line, fn.endLine)
      : callSite === undefined
        ? {}
        : locationFields(callSite.file, callSite.line, callSite.endLine);
  if (depth >= maxDepth || fn === undefined) {
    return {
      key: callNodeKey(key, label, callLabel !== undefined),
      targetKey: key,
      label,
      kind: "call",
      depth,
      ancestors,
      ...location,
      children: [],
    };
  }
  if (visiting.has(key)) {
    return {
      key: callNodeKey(key, `${label} ⇄`, callLabel !== undefined),
      targetKey: key,
      label: `${label} ⇄`,
      kind: "call",
      depth,
      ancestors,
      ...location,
      children: [],
    };
  }
  visiting.add(key);
  const children = expandSteps(
    fn.steps,
    index,
    depth + 1,
    maxDepth,
    visiting,
    budget,
  );
  visiting.delete(key);
  return {
    key: callNodeKey(key, label, callLabel !== undefined),
    targetKey: key,
    label,
    kind: "call",
    depth,
    ancestors,
    ...location,
    children,
  };
}

function callNodeKey(
  targetKey: string,
  label: string,
  isCallSite: boolean,
): string {
  return isCallSite ? `${targetKey}\0${label}` : targetKey;
}

function expandSteps(
  steps: ReadonlyArray<GoStep>,
  index: ReadonlyMap<string, GoFunction>,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  budget: WorkBudget,
): ReadonlyArray<CallNode> {
  return steps.map((step) => {
    if (step.type === "call") {
      return expandCall(
        step.key,
        index,
        depth,
        maxDepth,
        visiting,
        step.location,
        step.label,
        budget,
      );
    }
    reserveBudget(budget);
    return {
      key: step.key,
      targetKey: step.key,
      label: step.label,
      kind: step.kind,
      depth,
      ancestors: [...visiting],
      ...locationFields(
        step.location.file,
        step.location.line,
        step.location.endLine,
      ),
      children: expandSteps(
        step.children,
        index,
        depth,
        maxDepth,
        visiting,
        budget,
      ),
    };
  });
}

type DiffContext = {
  readonly before: ReadonlyMap<string, GoFunction>;
  readonly after: ReadonlyMap<string, GoFunction>;
  readonly maxDepth: number;
  readonly expansionBudget: WorkBudget;
  readonly diffBudget: WorkBudget;
};

function diffEntry(
  key: string,
  before: ReadonlyMap<string, GoFunction>,
  after: ReadonlyMap<string, GoFunction>,
  maxDepth: number,
  expansionBudget: WorkBudget,
  diffBudget: WorkBudget,
): DiffNode | undefined {
  const beforeFn = before.get(key);
  const afterFn = after.get(key);
  if (beforeFn === undefined && afterFn === undefined) return undefined;
  const empty: CallNode = {
    key,
    targetKey: key,
    label: afterFn?.label ?? beforeFn?.label ?? key,
    kind: "call",
    depth: 0,
    ancestors: [],
    children: [],
  };
  const beforeTree =
    beforeFn === undefined
      ? empty
      : buildCallTree(key, before, maxDepth, expansionBudget);
  const afterTree =
    afterFn === undefined
      ? empty
      : buildCallTree(key, after, maxDepth, expansionBudget);
  const diff = diffNodes(beforeTree, afterTree, {
    before,
    after,
    maxDepth,
    expansionBudget,
    diffBudget,
  });
  if (beforeFn === undefined) return { ...diff, status: "added" };
  if (afterFn === undefined) return { ...diff, status: "removed" };
  return treeHasChanges(diff) ? diff : undefined;
}

function diffNodes(
  before: CallNode,
  after: CallNode,
  context: DiffContext,
): DiffNode {
  reserveBudget(context.diffBudget);
  return {
    key: after.key,
    label: after.label,
    status: "same",
    kind: after.kind,
    ...pickLocation(after, before),
    children: diffChildren(before.children, after.children, context),
  };
}

function diffChildren(
  before: ReadonlyArray<CallNode>,
  after: ReadonlyArray<CallNode>,
  context: DiffContext,
): ReadonlyArray<DiffNode> {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0),
  );
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const beforeNode = before[left];
      const afterNode = after[right];
      if (beforeNode === undefined || afterNode === undefined) continue;
      const row = lengths[left];
      if (row === undefined) continue;
      row[right] =
        beforeNode.key === afterNode.key
          ? (lengths[left + 1]?.[right + 1] ?? 0) + 1
          : Math.max(
              lengths[left + 1]?.[right] ?? 0,
              lengths[left]?.[right + 1] ?? 0,
            );
    }
  }
  const result: Array<DiffNode> = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    const beforeNode = before[left];
    const afterNode = after[right];
    if (beforeNode === undefined || afterNode === undefined) break;
    if (beforeNode.key === afterNode.key) {
      result.push(diffNodes(beforeNode, afterNode, context));
      left += 1;
      right += 1;
    } else if (
      (lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0)
    ) {
      result.push(
        diffUnmatchedNode(
          beforeNode,
          "removed",
          context,
          hasCallSiteVariant(beforeNode, after),
        ),
      );
      left += 1;
    } else {
      result.push(
        diffUnmatchedNode(
          afterNode,
          "added",
          context,
          hasCallSiteVariant(afterNode, before),
        ),
      );
      right += 1;
    }
  }
  while (left < before.length) {
    const node = before[left];
    if (node !== undefined)
      result.push(
        diffUnmatchedNode(
          node,
          "removed",
          context,
          hasCallSiteVariant(node, after),
        ),
      );
    left += 1;
  }
  while (right < after.length) {
    const node = after[right];
    if (node !== undefined)
      result.push(
        diffUnmatchedNode(
          node,
          "added",
          context,
          hasCallSiteVariant(node, before),
        ),
      );
    right += 1;
  }
  return result;
}

function hasCallSiteVariant(
  node: CallNode,
  candidates: ReadonlyArray<CallNode>,
): boolean {
  return (
    node.kind === "call" &&
    candidates.some(
      (candidate) =>
        candidate.kind === "call" &&
        candidate.targetKey === node.targetKey &&
        candidate.key !== node.key,
    )
  );
}

function diffUnmatchedNode(
  node: CallNode,
  status: "added" | "removed",
  context: DiffContext,
  callSiteChanged = false,
): DiffNode {
  if (callSiteChanged) {
    reserveBudget(context.diffBudget);
    return {
      key: node.key,
      label: node.label,
      status,
      kind: node.kind,
      ...pickLocation(node),
      children: [],
    };
  }
  if (node.kind !== "call") {
    return markTree(node, status, context);
  }
  if (
    !context.before.has(node.targetKey) ||
    !context.after.has(node.targetKey)
  ) {
    reserveBudget(context.diffBudget);
    return {
      key: node.key,
      label: node.label,
      status,
      kind: node.kind,
      ...pickLocation(node),
      children: [],
    };
  }
  const counterpartIndex = status === "added" ? context.before : context.after;
  const counterpart = expandCall(
    node.targetKey,
    counterpartIndex,
    node.depth,
    context.maxDepth,
    new Set(node.ancestors),
    undefined,
    undefined,
    context.expansionBudget,
  );
  const compared =
    status === "added"
      ? diffNodes(counterpart, node, context)
      : diffNodes(node, counterpart, context);
  return {
    ...compared,
    key: node.key,
    label: node.label,
    status,
    kind: node.kind,
    ...pickLocation(node),
  };
}

function markTree(
  node: CallNode,
  status: "added" | "removed",
  context: DiffContext,
): DiffNode {
  reserveBudget(context.diffBudget);
  return {
    key: node.key,
    label: node.label,
    status,
    kind: node.kind,
    ...pickLocation(node),
    children: node.children.map((child) =>
      diffUnmatchedNode(child, status, context),
    ),
  };
}

function treeHasChanges(node: DiffNode): boolean {
  return (
    node.status !== "same" ||
    node.children.some((child) => treeHasChanges(child))
  );
}

function renderDiff(root: DiffNode, locations: boolean): string {
  const lines: Array<string> = [];
  const walk = (
    node: DiffNode,
    indent: string,
    last: boolean,
    rootNode: boolean,
  ): void => {
    const branch = rootNode ? "" : last ? "└─ " : "├─ ";
    const status =
      node.status === "added" ? "+" : node.status === "removed" ? "-" : " ";
    const location =
      locations && node.file !== undefined && node.line !== undefined
        ? `  ${node.file}:${node.line}${node.endLine === undefined ? "" : `-${node.endLine}`}`
        : "";
    const semantic =
      node.kind === "unresolved"
        ? "[unresolved] "
        : node.kind === "dependency"
          ? "[dependency] "
          : node.kind === "reference"
            ? "[reference] "
            : "";
    lines.push(
      `${status} ${indent}${branch}${semantic}${node.label}${location}`,
    );
    const rail =
      node.kind === "branch" ? "   " : last || rootNode ? "   " : "│  ";
    const childIndent = rootNode ? "" : `${indent}${rail}`;
    node.children.forEach((child, index) =>
      walk(child, childIndent, index === node.children.length - 1, false),
    );
  };
  walk(root, "", true, true);
  return lines.join("\n");
}

function validateResult(result: DiffResult): void {
  const visit = (node: DiffNode): void => {
    if (
      node.key.length === 0 ||
      node.label.length === 0 ||
      !["same", "added", "removed"].includes(node.status) ||
      (node.kind !== undefined &&
        ![
          "call",
          "branch",
          "unresolved",
          "dependency",
          "reference",
          "concurrent",
          "deferred",
        ].includes(node.kind)) ||
      (node.line !== undefined && node.line < 1) ||
      (node.endLine !== undefined && node.endLine < 1)
    ) {
      throw new Error("Go call-flow rule produced malformed output");
    }
    for (const child of node.children) visit(child);
  };
  for (const tree of result.trees) {
    if (tree.entry.length === 0) {
      throw new Error("Go call-flow rule produced an empty entry");
    }
    visit(tree.tree);
  }
}

function extractionContext(
  packageIdentity: string,
  localTypes: ReadonlySet<string>,
  definitions: ReadonlySet<string>,
  methods: ReadonlySet<string>,
  shadowedValues: ReadonlySet<string>,
  totalStepBudget: WorkBudget,
  receiver?: ReceiverBinding,
): ExtractionContext {
  const base = {
    packageKey: packageIdentity,
    localTypes,
    definitions,
    methods,
    shadowedValues,
    functionStepBudget: {
      name: "body-steps-per-function",
      limit: MAX_GO_STEPS_PER_FUNCTION,
      used: 0,
    },
    totalStepBudget,
  };
  return receiver === undefined ? base : { ...base, receiver };
}

function definitionKey(packageIdentity: string, symbol: string): string {
  return `go:${JSON.stringify([packageIdentity, symbol])}`;
}

function reserveBudget(budget: WorkBudget): void {
  budget.used += 1;
  if (budget.used > budget.limit) budgetExceeded(budget.name);
}

function budgetExceeded(name: string): never {
  throw new GoCallFlowBudgetExceededError(name);
}

function findDescendant(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findDescendant(child, type);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sourceLocation(file: string, node: Parser.SyntaxNode): SourceLocation {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const location: SourceLocation = { file, line };
  if (endLine !== line) location.endLine = endLine;
  return location;
}

function definitionLines(node: Parser.SyntaxNode): DefinitionLines {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const location: DefinitionLines = { line };
  if (line !== endLine) location.endLine = endLine;
  return location;
}

function locationFields(
  file: string,
  line: number,
  endLine: number | undefined,
): SourceLocation {
  const location: SourceLocation = { file, line };
  if (endLine !== undefined) location.endLine = endLine;
  return location;
}

function pickLocation(
  primary: CallNode,
  fallback?: CallNode,
): OptionalSourceLocation {
  const selected = primary.file === undefined ? fallback : primary;
  if (selected?.file === undefined || selected.line === undefined) return {};
  return locationFields(selected.file, selected.line, selected.endLine);
}

function statementsOf(
  node: Parser.SyntaxNode,
): ReadonlyArray<Parser.SyntaxNode> {
  const list = childByType(node, "statement_list");
  return list?.namedChildren ?? node.namedChildren;
}

function childByType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function parameterLabel(node: Parser.SyntaxNode | undefined): string {
  if (node === undefined) return "()";
  const names: Array<string> = [];
  for (const parameter of node.namedChildren) {
    if (parameter.type !== "parameter_declaration") continue;
    const identifiers = parameter.namedChildren.filter(
      (child) => child.type === "identifier",
    );
    if (identifiers.length === 0) names.push("_");
    else names.push(...identifiers.map((identifier) => identifier.text));
  }
  return names.length === 0 ? "()" : `(${names.join(", ")})`;
}

function isExported(name: string): boolean {
  const first = name[0];
  return (
    first !== undefined &&
    first === first.toUpperCase() &&
    first !== first.toLowerCase()
  );
}
