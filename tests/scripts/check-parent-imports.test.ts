import { describe, expect, it } from "vitest";
import { findParentImports } from "#scripts/check-parent-imports.mjs";

describe("parent module import guard", () => {
  it("rejects parent-climbing module syntax including type imports and JSDoc", () => {
    const source = `import type { Item } from "../item";
export { value } from '../value';
const loaded = import('../dynamic');
const required = require('../required');
type Detail = import('../detail').Detail;
/** @type {import('../jsdoc').Info} */
const annotated = {};
`;
    expect(
      findParentImports("example.ts", source).map(
        (item) => item.split(": ")[1],
      ),
    ).toEqual([
      "../item",
      "../value",
      "../dynamic",
      "../required",
      "../detail",
      "../jsdoc",
    ]);
  });

  it("rejects class-member and dangling EOF JSDoc imports", () => {
    const source = `class Example {
/** @type {import("../member").Info} */
member;
}
/** @type {import("../eof").Info} */`;
    expect(
      findParentImports("example.js", source).map(
        (item) => item.split(": ")[1],
      ),
    ).toEqual(["../member", "../eof"]);
  });

  it("preserves filesystem traversal values and fixture snippets", () => {
    const source = `const traversal = "../etc/passwd";
const fixture = 'import { value } from "../external-repo/module"';
const jsdocFixture = '/** @type {import("../external-repo/type").Info} */';
import { local } from "./local";
import { shared } from "#src/domain/shared";`;
    expect(findParentImports("example.ts", source)).toEqual([]);
  });
});
