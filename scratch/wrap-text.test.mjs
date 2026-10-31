import assert from "node:assert/strict";
import { test } from "node:test";

import { longestLine, wrapText } from "./wrap-text.mjs";

test("wraps at spaces within the width", () => {
  assert.equal(wrapText("the quick brown fox", 9), "the quick\nbrown fox");
});

test("keeps an overlong word whole", () => {
  assert.equal(wrapText("a extraordinarily b", 5), "a\nextraordinarily\nb");
});

test("rejects a non-positive width", () => {
  assert.throws(() => wrapText("x", 0), RangeError);
});

test("reports the longest wrapped line", () => {
  assert.equal(longestLine("ab\nabcd\nabc"), 4);
});
