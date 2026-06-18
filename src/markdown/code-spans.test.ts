import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState, type InlineCodeState } from "./code-spans.js";

/** Render a string where each index is "^" when inside a code span, else " ". */
function maskCodeSpans(text: string, state?: InlineCodeState): string {
  const index = buildCodeSpanIndex(text, state);
  return [...text].map((_, i) => (index.isInside(i) ? "^" : " ")).join("");
}

describe("createInlineCodeState", () => {
  it("starts closed with no open ticks", () => {
    expect(createInlineCodeState()).toEqual({ open: false, ticks: 0 });
  });

  it("returns a fresh object each call", () => {
    expect(createInlineCodeState()).not.toBe(createInlineCodeState());
  });
});

describe("buildCodeSpanIndex", () => {
  it("marks nothing for plain text", () => {
    expect(maskCodeSpans("plain text no code")).toBe("                  ");
  });

  it("returns false for empty input", () => {
    const index = buildCodeSpanIndex("");
    expect(index.isInside(0)).toBe(false);
    expect(index.inlineState).toEqual({ open: false, ticks: 0 });
  });

  it("covers a single-backtick inline span including its delimiters", () => {
    // "a `code` b" -> the span runs from the opening backtick through the closer.
    expect(maskCodeSpans("a `code` b")).toBe("  ^^^^^^  ");
  });

  it("treats text immediately after the closing backtick as outside", () => {
    const index = buildCodeSpanIndex("a `code` b");
    expect(index.isInside(2)).toBe(true); // opening backtick
    expect(index.isInside(7)).toBe(true); // closing backtick
    expect(index.isInside(8)).toBe(false); // trailing space
  });

  it("indexes multiple inline spans independently", () => {
    expect(maskCodeSpans("a `b` and `c` d")).toBe("  ^^^     ^^^  ");
  });

  it("requires a matching backtick run length to close a span", () => {
    // A double-backtick span ignores a lone inner backtick and only closes on "``".
    expect(maskCodeSpans("`` a ` b ``")).toBe("^^^^^^^^^^^");
  });

  it("lets a double-backtick span wrap a single inner backtick", () => {
    expect(maskCodeSpans("a ``co`de`` b")).toBe("  ^^^^^^^^^  ");
  });

  it("extends an unterminated inline span to the end of the text", () => {
    const text = "`unterminated rest";
    expect(maskCodeSpans(text)).toBe("^".repeat(text.length));
  });

  it("reports the open state for an unterminated span", () => {
    const index = buildCodeSpanIndex("text `open");
    expect(index.inlineState).toEqual({ open: true, ticks: 1 });
  });

  it("covers a fenced code block span", () => {
    expect(maskCodeSpans("```\ncode\n```")).toBe("^".repeat("```\ncode\n```".length));
  });

  it("returns false for indices outside the string bounds", () => {
    const index = buildCodeSpanIndex("a `b` c");
    expect(index.isInside(-1)).toBe(false);
    expect(index.isInside(100)).toBe(false);
  });
});

describe("buildCodeSpanIndex inline state threading", () => {
  it("does not mutate the supplied state object", () => {
    const state = createInlineCodeState();
    buildCodeSpanIndex("`open", state);
    expect(state).toEqual({ open: false, ticks: 0 });
  });

  it("closes a span that opened in a previous chunk via carried state", () => {
    const first = buildCodeSpanIndex("before `start", createInlineCodeState());
    expect(first.inlineState).toEqual({ open: true, ticks: 1 });

    // The continuation begins already-open, so the close is detected mid-chunk.
    expect(maskCodeSpans("end` after", first.inlineState)).toBe("^^^^      ");
    const second = buildCodeSpanIndex("end` after", first.inlineState);
    expect(second.inlineState).toEqual({ open: false, ticks: 0 });
  });
});
