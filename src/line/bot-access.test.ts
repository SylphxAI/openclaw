import { describe, expect, it } from "vitest";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeAllowFromWithStore,
} from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("returns an empty result for an undefined list", () => {
    expect(normalizeAllowFrom(undefined)).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: false,
    });
  });

  it("returns an empty result for an empty list", () => {
    expect(normalizeAllowFrom([])).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: false,
    });
  });

  it("trims entries and drops blank/whitespace-only values", () => {
    expect(normalizeAllowFrom(["", "   ", "U1"])).toEqual({
      entries: ["U1"],
      hasWildcard: false,
      hasEntries: true,
    });
  });

  it("strips the line: prefix case-insensitively", () => {
    expect(normalizeAllowFrom(["line:U1", "LINE:U2"]).entries).toEqual(["U1", "U2"]);
  });

  it("strips the line:user: prefix case-insensitively", () => {
    expect(normalizeAllowFrom(["line:user:U1", "LINE:USER:U2"]).entries).toEqual(["U1", "U2"]);
  });

  it("strips only the first prefix occurrence", () => {
    expect(normalizeAllowFrom(["line:user:line:user:U9"]).entries).toEqual(["line:user:U9"]);
  });

  it("leaves entries without a line: prefix unchanged", () => {
    expect(normalizeAllowFrom(["U1", "user:U2", "linex:U3"]).entries).toEqual([
      "U1",
      "user:U2",
      "linex:U3",
    ]);
  });

  it("detects the wildcard entry", () => {
    expect(normalizeAllowFrom(["*", "U1"])).toEqual({
      entries: ["*", "U1"],
      hasWildcard: true,
      hasEntries: true,
    });
  });

  it("treats a whitespace-padded wildcard as a wildcard", () => {
    const result = normalizeAllowFrom(["  *  "]);
    expect(result.entries).toEqual(["*"]);
    expect(result.hasWildcard).toBe(true);
  });

  it("coerces numeric entries to trimmed strings", () => {
    expect(normalizeAllowFrom([123, 0]).entries).toEqual(["123", "0"]);
  });
});

describe("normalizeAllowFromWithStore", () => {
  it("combines allowFrom and storeAllowFrom before normalizing", () => {
    expect(
      normalizeAllowFromWithStore({
        allowFrom: ["line:U1"],
        storeAllowFrom: ["U2"],
      }),
    ).toEqual({
      entries: ["U1", "U2"],
      hasWildcard: false,
      hasEntries: true,
    });
  });

  it("orders allowFrom entries before store entries", () => {
    expect(
      normalizeAllowFromWithStore({
        allowFrom: ["A"],
        storeAllowFrom: ["B"],
      }).entries,
    ).toEqual(["A", "B"]);
  });

  it("returns an empty result when both inputs are omitted", () => {
    expect(normalizeAllowFromWithStore({})).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: false,
    });
  });
});

describe("firstDefined", () => {
  it("returns the first non-undefined value", () => {
    expect(firstDefined(undefined, undefined, "x", "y")).toBe("x");
  });

  it("treats null as defined", () => {
    expect(firstDefined(undefined, null, "z")).toBeNull();
  });

  it("treats false as defined", () => {
    expect(firstDefined(undefined, false)).toBe(false);
  });

  it("treats 0 as defined", () => {
    expect(firstDefined(undefined, 0)).toBe(0);
  });

  it("returns undefined when every value is undefined", () => {
    expect(firstDefined(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when called with no arguments", () => {
    expect(firstDefined()).toBeUndefined();
  });
});

describe("isSenderAllowed", () => {
  it("denies when there are no entries (closed by default)", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom([]), senderId: "U1" })).toBe(false);
  });

  it("allows any sender when a wildcard is present", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["*"]), senderId: "U1" })).toBe(true);
  });

  it("allows a wildcard match even without a senderId", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["*"]) })).toBe(true);
  });

  it("allows a sender whose id is in the list", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["U1", "U2"]), senderId: "U2" })).toBe(true);
  });

  it("denies a sender whose id is not in the list", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["U1", "U2"]), senderId: "U9" })).toBe(
      false,
    );
  });

  it("denies when entries exist but no senderId is provided", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["U1"]) })).toBe(false);
  });

  it("matches against the line:-stripped id form", () => {
    expect(isSenderAllowed({ allow: normalizeAllowFrom(["line:U1"]), senderId: "U1" })).toBe(true);
  });
});
