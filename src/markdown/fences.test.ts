import { describe, expect, it } from "vitest";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "./fences.js";

/**
 * Characterization tests for the code-fence span scanner.
 *
 * `parseFenceSpans` walks a buffer line-by-line, tracking CommonMark-style
 * fenced code blocks. It pins down the exact recorded behaviour:
 *  - fences open on a line of `` ``` `` or `~~~` (length >= 3), indented 0-3 spaces;
 *  - a fence closes only on the same marker character with length >= the
 *    opening run (a longer close is fine, a shorter one is not);
 *  - an unclosed fence at end-of-buffer is still emitted, ending at `buffer.length`;
 *  - `start` is the byte offset of the opening line, `end` is the byte offset of
 *    the end of the closing line (newline-exclusive).
 *
 * `findFenceSpanAt` / `isSafeFenceBreak` treat both span bounds as STRICTLY
 * exclusive: an index is "inside" only when `start < index < end`.
 */
describe("parseFenceSpans", () => {
  it("returns no spans for plain text with no fences", () => {
    expect(parseFenceSpans("hello\nworld")).toEqual([]);
  });

  it("captures a single closed backtick fence with exact offsets", () => {
    const buffer = "a\n```\ncode\n```\nb";
    expect(parseFenceSpans(buffer)).toEqual([
      {
        start: 2, // offset of the opening "```" line
        end: 14, // offset of the end of the closing "```" line (excludes its newline)
        openLine: "```",
        marker: "```",
        indent: "",
      },
    ]);
  });

  it("captures the opening line's info string in openLine but only ticks in marker", () => {
    const buffer = "```ts\ncode\n```";
    const [span] = parseFenceSpans(buffer);
    expect(span?.openLine).toBe("```ts");
    expect(span?.marker).toBe("```");
    expect(span?.indent).toBe("");
  });

  it("supports tilde fences", () => {
    const buffer = "~~~\ncode\n~~~";
    const [span] = parseFenceSpans(buffer);
    expect(span?.marker).toBe("~~~");
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const buffer = "```\ncode\n~~~\nstill code";
    const spans = parseFenceSpans(buffer);
    // tilde line cannot close the backtick fence -> single unclosed span to EOF
    expect(spans).toHaveLength(1);
    expect(spans[0]?.marker).toBe("```");
    expect(spans[0]?.end).toBe(buffer.length);
  });

  it("emits an unclosed fence ending at buffer length", () => {
    const buffer = "```\nnever closed";
    const spans = parseFenceSpans(buffer);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.start).toBe(0);
    expect(spans[0]?.end).toBe(buffer.length);
  });

  it("allows a longer closing run than the opening run", () => {
    const buffer = "```\ncode\n`````";
    const spans = parseFenceSpans(buffer);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end).toBe(buffer.length); // closed by the longer run
  });

  it("does not close on a shorter run; the longer-run closer wins later", () => {
    // open with 4 backticks; a 3-backtick line cannot close it, a 4+ line can.
    const buffer = "````\n```\nstill inside\n````\nafter";
    const spans = parseFenceSpans(buffer);
    expect(spans).toHaveLength(1);
    const closeLineStart = buffer.indexOf("````", 1);
    // span ends at the end of the 4-backtick closing line
    expect(spans[0]?.end).toBe(closeLineStart + 4);
  });

  it("respects 0-3 spaces of indentation on the fence line", () => {
    const buffer = "   ```\ncode\n   ```";
    const [span] = parseFenceSpans(buffer);
    expect(span?.indent).toBe("   ");
  });

  it("does not treat a 4-space-indented run as a fence", () => {
    const buffer = "    ```\nnot a fence";
    expect(parseFenceSpans(buffer)).toEqual([]);
  });

  it("does not treat a run of fewer than three markers as a fence", () => {
    expect(parseFenceSpans("``\ncode\n``")).toEqual([]);
  });

  it("captures multiple sequential fenced blocks", () => {
    const buffer = "```\nfirst\n```\nmiddle\n```\nsecond\n```";
    const spans = parseFenceSpans(buffer);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.end).toBeLessThan(spans[1]?.start ?? -1);
  });

  it("handles a buffer that is exactly a fence marker with no newline", () => {
    const spans = parseFenceSpans("```");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 3, marker: "```" });
  });

  it("returns an empty list for an empty buffer", () => {
    expect(parseFenceSpans("")).toEqual([]);
  });
});

describe("findFenceSpanAt", () => {
  const spans = parseFenceSpans("a\n```\ncode\n```\nb"); // span { start: 2, end: 14 }

  it("finds the span for an index strictly inside it", () => {
    expect(findFenceSpanAt(spans, 7)).toBeDefined();
  });

  it("treats the start boundary as exclusive (not inside)", () => {
    expect(findFenceSpanAt(spans, 2)).toBeUndefined();
  });

  it("treats the end boundary as exclusive (not inside)", () => {
    expect(findFenceSpanAt(spans, 14)).toBeUndefined();
  });

  it("returns undefined for an index outside every span", () => {
    expect(findFenceSpanAt(spans, 0)).toBeUndefined();
    expect(findFenceSpanAt(spans, 15)).toBeUndefined();
  });

  it("returns undefined when there are no spans", () => {
    expect(findFenceSpanAt([], 5)).toBeUndefined();
  });
});

describe("isSafeFenceBreak", () => {
  const spans = parseFenceSpans("a\n```\ncode\n```\nb"); // span { start: 2, end: 14 }

  it("is the negation of being strictly inside a span", () => {
    expect(isSafeFenceBreak(spans, 7)).toBe(false); // inside
    expect(isSafeFenceBreak(spans, 2)).toBe(true); // on start boundary
    expect(isSafeFenceBreak(spans, 14)).toBe(true); // on end boundary
    expect(isSafeFenceBreak(spans, 0)).toBe(true); // before
    expect(isSafeFenceBreak(spans, 15)).toBe(true); // after
  });

  it("is always safe to break when there are no fences", () => {
    expect(isSafeFenceBreak([], 3)).toBe(true);
  });
});
