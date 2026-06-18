import { describe, expect, it } from "vitest";
import { safeJsonStringify } from "./safe-json.js";

describe("safeJsonStringify", () => {
  it("serializes plain JSON values like JSON.stringify", () => {
    expect(safeJsonStringify({ a: 1, b: "x", c: true, d: null })).toBe(
      '{"a":1,"b":"x","c":true,"d":null}',
    );
    expect(safeJsonStringify([1, "two", false])).toBe('[1,"two",false]');
    expect(safeJsonStringify("hi")).toBe('"hi"');
    expect(safeJsonStringify(42)).toBe("42");
    expect(safeJsonStringify(true)).toBe("true");
    expect(safeJsonStringify(null)).toBe("null");
  });

  it("drops undefined properties just like JSON.stringify", () => {
    expect(safeJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("encodes non-finite numbers as null (standard JSON.stringify behavior)", () => {
    expect(safeJsonStringify(Number.NaN)).toBe("null");
    expect(safeJsonStringify(Number.POSITIVE_INFINITY)).toBe("null");
    expect(safeJsonStringify(Number.NEGATIVE_INFINITY)).toBe("null");
  });

  it("converts bigint to its string form at the top level", () => {
    expect(safeJsonStringify(10n)).toBe('"10"');
  });

  it("converts bigint to its string form when nested", () => {
    expect(safeJsonStringify({ a: 5n })).toBe('{"a":"5"}');
  });

  it("replaces a top-level function with the [Function] marker", () => {
    expect(safeJsonStringify(() => {})).toBe('"[Function]"');
  });

  it("replaces a nested function with the [Function] marker", () => {
    expect(safeJsonStringify({ fn: function foo() {} })).toBe('{"fn":"[Function]"}');
  });

  it("serializes a top-level Error to name/message/stack", () => {
    const error = new Error("boom");
    error.stack = "STACK";
    expect(safeJsonStringify(error)).toBe('{"name":"Error","message":"boom","stack":"STACK"}');
  });

  it("serializes a nested Error subclass preserving its name", () => {
    const error = new TypeError("t");
    error.stack = "S2";
    expect(safeJsonStringify({ err: error })).toBe(
      '{"err":{"name":"TypeError","message":"t","stack":"S2"}}',
    );
  });

  it("encodes a top-level Uint8Array as base64 with a type tag", () => {
    expect(safeJsonStringify(new Uint8Array([1, 2, 3]))).toBe(
      '{"type":"Uint8Array","data":"AQID"}',
    );
  });

  it("encodes a nested Uint8Array as base64 with a type tag", () => {
    expect(safeJsonStringify({ buf: new Uint8Array([255, 0, 128]) })).toBe(
      '{"buf":{"type":"Uint8Array","data":"/wCA"}}',
    );
  });

  it("returns null when serialization throws (circular reference)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBeNull();
  });

  it("mirrors JSON.stringify returning undefined for unserializable top-level inputs", () => {
    // JSON.stringify itself returns undefined (not null) for these top-level values;
    // the catch path is never reached, so the declared `string | null` type is widened.
    expect(safeJsonStringify(undefined)).toBeUndefined();
    expect(safeJsonStringify(Symbol("s"))).toBeUndefined();
  });
});
