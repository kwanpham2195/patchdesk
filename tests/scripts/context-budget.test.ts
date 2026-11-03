import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  findGrowth,
  hasIncreaseTrailer,
  measureContextBudget,
} from "#scripts/context-budget-lib.mjs";

const root = resolve(import.meta.dirname, "../..");

it("keeps context-budget.json equal to the measured sizes (run node scripts/check-context-budget.mjs --write when this fails)", async () => {
  const budget = JSON.parse(
    await readFile(resolve(root, "context-budget.json"), "utf8"),
  );

  const measured = await measureContextBudget(
    (path) => import(/* @vite-ignore */ `#${path}`),
    root,
  );

  expect(measured).toEqual(budget);
});

it("treats growth as allowed only with a context-increase line", () => {
  expect(findGrowth({ a: 10, b: 5 }, { a: 11, b: 5 })).toEqual([
    "a: 10 -> 11 bytes",
  ]);
  expect(findGrowth({ a: 10 }, { a: 9 })).toEqual([]);
  expect(hasIncreaseTrailer("fix: x\n\ncontext-increase: new rule\n")).toBe(
    true,
  );
  expect(hasIncreaseTrailer("fix: x\n\ncontext-increase:\n")).toBe(false);
  expect(hasIncreaseTrailer("# context-increase: nope\nfix: x")).toBe(false);
});
