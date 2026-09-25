import { describe, expect, it } from "vitest";

import {
  enclosingDeclaration,
  mentionKind,
} from "../../src/domain/brief-reach-mentions";

describe("mentionKind", () => {
  it.each([
    { case: "a plain call", line: "  const r = refresh(id);", kind: "call" },
    { case: "a generic call", line: "refresh<Review>(id)", kind: "call" },
    {
      case: "a constructor",
      line: "  return new refresh(deps);",
      kind: "call",
    },
    { case: "a static member", line: "  refresh.start();", kind: "call" },
    { case: "a rendered component", line: "  <refresh open />", kind: "call" },
    {
      case: "a type-only import",
      line: 'import type { refresh } from "./refresh";',
      kind: "type",
    },
    {
      case: "an inline type import",
      line: 'import { type refresh, other } from "./refresh";',
      kind: "type",
    },
    {
      case: "a value import",
      line: 'import { refresh } from "./refresh";',
      kind: "import",
    },
    {
      case: "a re-export",
      line: 'export { refresh } from "./refresh";',
      kind: "import",
    },
    {
      case: "a require",
      line: 'const { refresh } = require("./refresh");',
      kind: "import",
    },
    {
      case: "an annotation",
      line: "  readonly service: refresh;",
      kind: "type",
    },
    {
      case: "a type argument",
      line: "const [rows] = useState<refresh>();",
      kind: "type",
    },
    {
      case: "an extends clause",
      line: "class A extends refresh {}",
      kind: "type",
    },
    {
      case: "an implements clause",
      line: "class A implements refresh {}",
      kind: "type",
    },
    { case: "a cast", line: "const a = value as refresh;", kind: "type" },
    {
      case: "a bare reference",
      line: "  handlers.push(refresh);",
      kind: "other",
    },
  ] as const)("reads $case as $kind", ({ line, kind }) => {
    expect(mentionKind(line, "refresh")).toBe(kind);
  });

  it("matches the name as a whole word only", () => {
    expect(mentionKind("  refreshAll(id);", "refresh")).toBe("other");
  });
});

describe("enclosingDeclaration", () => {
  const file = [
    'import { refresh } from "./refresh";',
    "",
    "export function prepare(id: string) {",
    "  if (id) {",
    "    refresh(id);",
    "  }",
    "}",
    "",
    "export class ReviewService {",
    "  async open(id: string): Promise<void> {",
    "    await refresh(id);",
    "  }",
    "}",
    "",
    "export const handlers = {",
    "  refresh: () => refresh(),",
    "};",
    "refresh();",
  ];

  it("names the function a call sits in, past a nested block", () => {
    expect(enclosingDeclaration(file, 4)).toBe("prepare");
  });

  it("names a method with its class", () => {
    expect(enclosingDeclaration(file, 10)).toBe("ReviewService.open");
  });

  it.each([
    { case: "an import line", index: 0 },
    { case: "a property of a top-level object", index: 15 },
    { case: "a statement at column zero", index: 17 },
  ])("reads $case as top level", ({ index }) => {
    expect(enclosingDeclaration(file, index)).toBeUndefined();
  });

  it("names a function whose signature spans several lines", () => {
    expect(
      enclosingDeclaration(
        [
          "export function computeScope(",
          "  files: ReadonlyArray<string>,",
          "): number {",
          "  if (files.length === 0) {",
          "    return 0;",
          "  } else {",
          "    return refresh(files);",
          "  }",
          "}",
        ],
        6,
      ),
    ).toBe("computeScope");
  });

  it("reads a 500 KB minified line without backtracking across it", () => {
    const minified = `  a(${"):".repeat(250_000)}`;
    const started = performance.now();
    expect(enclosingDeclaration([minified], 0)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("names an arrow component and a Go method", () => {
    expect(
      enclosingDeclaration(
        [
          "export const Panel = ({ id }: Props) => {",
          "  return refresh(id);",
          "};",
        ],
        1,
      ),
    ).toBe("Panel");
    expect(
      enclosingDeclaration(
        [
          "func (s *Service) Open(id string) error {",
          "\treturn refresh(id)",
          "}",
        ],
        1,
      ),
    ).toBe("Open");
  });
});
