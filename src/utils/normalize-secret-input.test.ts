import { describe, expect, it } from "vitest";
import { normalizeOptionalSecretInput, normalizeSecretInput } from "./normalize-secret-input.js";

describe("normalizeSecretInput", () => {
  it("returns an empty string for non-string input", () => {
    expect(normalizeSecretInput(undefined)).toBe("");
    expect(normalizeSecretInput(null)).toBe("");
    expect(normalizeSecretInput(123)).toBe("");
    expect(normalizeSecretInput(true)).toBe("");
    expect(normalizeSecretInput(Number.NaN)).toBe("");
    expect(normalizeSecretInput({})).toBe("");
    expect(normalizeSecretInput([])).toBe("");
  });

  it("returns plain values untouched", () => {
    expect(normalizeSecretInput("sk-abc")).toBe("sk-abc");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSecretInput("  sk-abc  ")).toBe("sk-abc");
  });

  it("strips embedded carriage returns and line feeds anywhere", () => {
    expect(normalizeSecretInput("sk-\r\nabc")).toBe("sk-abc");
    expect(normalizeSecretInput("sk-\nabc\r")).toBe("sk-abc");
    expect(normalizeSecretInput("a\nb\nc")).toBe("abc");
    expect(normalizeSecretInput("a\rb")).toBe("ab");
  });

  it("strips embedded Unicode line/paragraph separators", () => {
    expect(normalizeSecretInput("line1\u2028line2")).toBe("line1line2");
    expect(normalizeSecretInput("a\u2029b")).toBe("ab");
  });

  it("collapses a mixed run of line-break characters", () => {
    expect(normalizeSecretInput("a\u2028\u2029\r\nb")).toBe("ab");
  });

  it("strips leading/trailing line breaks together with surrounding spaces", () => {
    expect(normalizeSecretInput("\r\n  sk-x  \r\n")).toBe("sk-x");
  });

  it("preserves ordinary spaces inside the value (Bearer <token> safety)", () => {
    expect(normalizeSecretInput("Bearer abc def")).toBe("Bearer abc def");
  });

  it("preserves internal tabs but trims tabs at the ends", () => {
    expect(normalizeSecretInput("a\t\tb")).toBe("a\t\tb");
    expect(normalizeSecretInput("\tsk\t")).toBe("sk");
  });

  it("treats lone whitespace-only input as empty", () => {
    expect(normalizeSecretInput("")).toBe("");
    expect(normalizeSecretInput("   ")).toBe("");
    expect(normalizeSecretInput("\r\n\r\n")).toBe("");
    expect(normalizeSecretInput("\f")).toBe("");
  });
});

describe("normalizeOptionalSecretInput", () => {
  it("returns undefined for blank, empty, or non-string input", () => {
    expect(normalizeOptionalSecretInput("")).toBeUndefined();
    expect(normalizeOptionalSecretInput("   ")).toBeUndefined();
    expect(normalizeOptionalSecretInput("\r\n")).toBeUndefined();
    expect(normalizeOptionalSecretInput(undefined)).toBeUndefined();
    expect(normalizeOptionalSecretInput(null)).toBeUndefined();
    expect(normalizeOptionalSecretInput(0)).toBeUndefined();
  });

  it("returns the normalized string for non-blank input", () => {
    expect(normalizeOptionalSecretInput("x")).toBe("x");
    expect(normalizeOptionalSecretInput("  y  ")).toBe("y");
    expect(normalizeOptionalSecretInput("sk-\r\nabc")).toBe("sk-abc");
  });
});
