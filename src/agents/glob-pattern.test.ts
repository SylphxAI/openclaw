import { describe, expect, it } from "vitest";
import {
  type CompiledGlobPattern,
  compileGlobPattern,
  compileGlobPatterns,
  matchesAnyGlobPattern,
} from "./glob-pattern.js";

const identity = (value: string) => value;
const lower = (value: string) => value.trim().toLowerCase();

describe("compileGlobPattern", () => {
  it("compiles a normalized-empty input to an empty exact pattern", () => {
    expect(compileGlobPattern({ raw: "", normalize: identity })).toEqual({
      kind: "exact",
      value: "",
    });
  });

  it("treats whitespace-only input as empty via the normalizer", () => {
    expect(compileGlobPattern({ raw: "   ", normalize: lower })).toEqual({
      kind: "exact",
      value: "",
    });
  });

  it("compiles a lone star to the catch-all pattern", () => {
    expect(compileGlobPattern({ raw: "*", normalize: identity })).toEqual({ kind: "all" });
  });

  it("compiles a star-free token to an exact pattern", () => {
    expect(compileGlobPattern({ raw: "exec", normalize: identity })).toEqual({
      kind: "exact",
      value: "exec",
    });
  });

  it("applies the normalizer before classifying the pattern", () => {
    expect(compileGlobPattern({ raw: "  EXEC  ", normalize: lower })).toEqual({
      kind: "exact",
      value: "exec",
    });
  });

  it("compiles a star-containing token to an anchored regex", () => {
    const pattern = compileGlobPattern({ raw: "web_*", normalize: identity });
    expect(pattern.kind).toBe("regex");
    if (pattern.kind === "regex") {
      expect(pattern.value.source).toBe("^web_.*$");
    }
  });

  it("escapes regex metacharacters around the star", () => {
    const pattern = compileGlobPattern({ raw: "a.b*", normalize: identity });
    expect(pattern.kind).toBe("regex");
    if (pattern.kind === "regex") {
      expect(pattern.value.source).toBe("^a\\.b.*$");
      expect(pattern.value.test("a.bcd")).toBe(true);
      expect(pattern.value.test("axbcd")).toBe(false);
    }
  });
});

describe("compileGlobPatterns", () => {
  it("returns an empty list when raw is not an array", () => {
    expect(compileGlobPatterns({ raw: undefined, normalize: identity })).toEqual([]);
  });

  it("compiles each entry and drops empty exact patterns", () => {
    const compiled = compileGlobPatterns({
      raw: ["*", "", "   ", "exec", "web_*"],
      normalize: lower,
    });
    expect(compiled.map((pattern) => pattern.kind)).toEqual(["all", "exact", "regex"]);
  });

  it("retains non-empty exact patterns", () => {
    const compiled = compileGlobPatterns({ raw: ["read", "write"], normalize: identity });
    expect(compiled).toEqual([
      { kind: "exact", value: "read" },
      { kind: "exact", value: "write" },
    ]);
  });
});

describe("matchesAnyGlobPattern", () => {
  it("returns false against an empty pattern list", () => {
    expect(matchesAnyGlobPattern("anything", [])).toBe(false);
  });

  it("matches everything when an all pattern is present", () => {
    expect(matchesAnyGlobPattern("anything", [{ kind: "all" }])).toBe(true);
  });

  it("matches an exact pattern only on full equality", () => {
    const patterns: CompiledGlobPattern[] = [{ kind: "exact", value: "exec" }];
    expect(matchesAnyGlobPattern("exec", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("execute", patterns)).toBe(false);
  });

  it("matches a regex pattern against the whole value", () => {
    const patterns = compileGlobPatterns({ raw: ["web_*"], normalize: identity });
    expect(matchesAnyGlobPattern("web_search", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("browse_web_search", patterns)).toBe(false);
  });

  it("returns true when any pattern in the list matches", () => {
    const patterns = compileGlobPatterns({ raw: ["read", "web_*"], normalize: identity });
    expect(matchesAnyGlobPattern("web_fetch", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("read", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("write", patterns)).toBe(false);
  });
});
