import { describe, expect, it } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch", () => {
  it("returns a non-object patch verbatim, replacing the base", () => {
    expect(applyMergePatch({ a: 1 }, 5)).toBe(5);
    expect(applyMergePatch({ a: 1 }, "str")).toBe("str");
    expect(applyMergePatch({ a: 1 }, null)).toBeNull();
  });

  it("returns an array patch verbatim (arrays are not plain objects)", () => {
    expect(applyMergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  it("deletes a key when its patch value is null", () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  it("ignores null for a key absent from the base", () => {
    expect(applyMergePatch({ a: 1 }, { b: null })).toEqual({ a: 1 });
  });

  it("recursively merges nested plain objects", () => {
    expect(applyMergePatch({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });

  it("replaces a scalar base value with a nested object patch", () => {
    expect(applyMergePatch({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  });

  it("replaces arrays wholesale rather than merging by index", () => {
    expect(applyMergePatch({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("starts from an empty object when the base is not a plain object", () => {
    expect(applyMergePatch(5, { a: 1 })).toEqual({ a: 1 });
    expect(applyMergePatch(null, { a: 1 })).toEqual({ a: 1 });
    expect(applyMergePatch([1, 2], { a: 1 })).toEqual({ a: 1 });
  });

  it("sets a key to undefined rather than deleting it (only null deletes)", () => {
    const result = applyMergePatch({ a: 1 }, { b: undefined }) as Record<string, unknown>;
    expect("b" in result).toBe(true);
    expect(result.b).toBeUndefined();
    expect(result.a).toBe(1);
  });

  it("clones the base for an empty patch without mutating it", () => {
    const base = { a: 1 };
    const result = applyMergePatch(base, {});
    expect(result).toEqual({ a: 1 });
    expect(result).not.toBe(base);
  });

  it("does not mutate the base object during a nested merge", () => {
    const base = { a: { x: 1 } };
    const result = applyMergePatch(base, { a: { y: 2 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});
