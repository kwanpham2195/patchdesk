import { describe, expect, it } from "vitest";

import { definedProps } from "../../src/domain/defined-props";

describe("definedProps", () => {
  it("drops keys whose value is undefined", () => {
    const absent: string | undefined = undefined;
    const result = definedProps({ present: "here", absent });

    expect(result).toEqual({ present: "here" });
    expect(Object.hasOwn(result, "absent")).toBe(false);
  });

  it("keeps null, which is a value and not an omission", () => {
    const result = definedProps({ nullable: null });

    expect(Object.hasOwn(result, "nullable")).toBe(true);
    expect(result.nullable).toBeNull();
  });

  it("returns an empty object for an empty input", () => {
    expect(definedProps({})).toEqual({});
  });

  it("copies nested values by reference without inspecting them", () => {
    const nested = { inner: undefined, deep: { value: 1 } };
    const result = definedProps({ nested });

    expect(result.nested).toBe(nested);
    expect(Object.hasOwn(nested, "inner")).toBe(true);
  });

  it("keeps other falsy values", () => {
    const result = definedProps({ zero: 0, empty: "", flag: false });

    expect(result).toEqual({ zero: 0, empty: "", flag: false });
  });

  it("preserves the input key order for the keys it keeps", () => {
    const middle: number | undefined = undefined;
    const result = definedProps({ first: 1, middle, last: 3 });

    expect(Object.keys(result)).toEqual(["first", "last"]);
  });
});
