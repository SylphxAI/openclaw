import { describe, expect, it } from "vitest";
import {
  applyQueueDropPolicy,
  buildCollectPrompt,
  buildQueueSummaryLine,
  buildQueueSummaryPrompt,
  elideQueueText,
  hasCrossChannelItems,
  type QueueState,
  shouldSkipQueueItem,
} from "./queue-helpers.js";

describe("elideQueueText", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(elideQueueText("hello", 10)).toBe("hello");
    expect(elideQueueText("exactly-ten", 11)).toBe("exactly-ten");
  });

  it("slices to limit-1 chars, trims trailing space, and appends an ellipsis", () => {
    expect(elideQueueText("hello world foo", 8)).toBe("hello w…");
    // The slice ends on a space which is trimmed before the ellipsis is added.
    expect(elideQueueText("abc def", 5)).toBe("abc…");
  });

  it("produces just the ellipsis when the limit is zero", () => {
    expect(elideQueueText("abc", 0)).toBe("…");
  });

  it("defaults the limit to 140 characters", () => {
    const long = "x".repeat(200);
    const result = elideQueueText(long);
    expect(result).toHaveLength(140);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("buildQueueSummaryLine", () => {
  it("collapses runs of whitespace, trims, then elides", () => {
    expect(buildQueueSummaryLine("  a   b\n c  ", 100)).toBe("a b c");
  });

  it("applies the elision limit after normalizing whitespace", () => {
    expect(buildQueueSummaryLine("alpha   beta   gamma", 8)).toBe("alpha b…");
  });
});

describe("shouldSkipQueueItem", () => {
  it("never skips when no dedupe predicate is provided", () => {
    expect(shouldSkipQueueItem({ item: 1, items: [1, 2, 3] })).toBe(false);
  });

  it("delegates to the dedupe predicate when present", () => {
    expect(
      shouldSkipQueueItem({ item: 2, items: [1, 2], dedupe: (i, arr) => arr.includes(i) }),
    ).toBe(true);
    expect(
      shouldSkipQueueItem({ item: 9, items: [1, 2], dedupe: (i, arr) => arr.includes(i) }),
    ).toBe(false);
  });
});

describe("applyQueueDropPolicy", () => {
  it("accepts without mutating when the cap is non-positive", () => {
    const queue: QueueState<string> = {
      dropPolicy: "old",
      droppedCount: 0,
      summaryLines: [],
      items: ["a", "b", "c"],
      cap: 0,
    };
    expect(applyQueueDropPolicy({ queue, summarize: (x) => x })).toBe(true);
    expect(queue.items).toEqual(["a", "b", "c"]);
  });

  it("accepts without mutating while below the cap", () => {
    const queue: QueueState<string> = {
      dropPolicy: "old",
      droppedCount: 0,
      summaryLines: [],
      items: ["a"],
      cap: 5,
    };
    expect(applyQueueDropPolicy({ queue, summarize: (x) => x })).toBe(true);
    expect(queue.items).toEqual(["a"]);
  });

  it("rejects the incoming item under the 'new' policy when at capacity", () => {
    const queue: QueueState<string> = {
      dropPolicy: "new",
      droppedCount: 0,
      summaryLines: [],
      items: ["a", "b"],
      cap: 2,
    };
    expect(applyQueueDropPolicy({ queue, summarize: (x) => x })).toBe(false);
    expect(queue.items).toEqual(["a", "b"]);
  });

  it("drops the oldest items under the 'old' policy without recording summaries", () => {
    const queue: QueueState<string> = {
      dropPolicy: "old",
      droppedCount: 0,
      summaryLines: [],
      items: ["a", "b", "c"],
      cap: 2,
    };
    expect(applyQueueDropPolicy({ queue, summarize: (x) => x })).toBe(true);
    expect(queue.items).toEqual(["c"]);
    expect(queue.droppedCount).toBe(0);
    expect(queue.summaryLines).toEqual([]);
  });

  it("records summary lines under the 'summarize' policy and trims to the summary limit", () => {
    const queue: QueueState<string> = {
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
      items: ["a", "b", "c"],
      cap: 2,
    };
    expect(applyQueueDropPolicy({ queue, summarize: (x) => `S:${x}`, summaryLimit: 1 })).toBe(true);
    expect(queue.items).toEqual(["c"]);
    // Two items were dropped (length - cap + 1 = 3 - 2 + 1).
    expect(queue.droppedCount).toBe(2);
    // summaryLimit of 1 keeps only the most recent dropped summary.
    expect(queue.summaryLines).toEqual(["S:b"]);
  });
});

describe("buildQueueSummaryPrompt", () => {
  it("returns undefined when the policy is not 'summarize'", () => {
    expect(
      buildQueueSummaryPrompt({
        state: { dropPolicy: "old", droppedCount: 5, summaryLines: ["x"] },
        noun: "message",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing was dropped", () => {
    expect(
      buildQueueSummaryPrompt({
        state: { dropPolicy: "summarize", droppedCount: 0, summaryLines: [] },
        noun: "message",
      }),
    ).toBeUndefined();
  });

  it("builds a singular default title and lists summary lines", () => {
    const state = { dropPolicy: "summarize" as const, droppedCount: 1, summaryLines: ["x"] };
    expect(buildQueueSummaryPrompt({ state, noun: "message" })).toBe(
      "[Queue overflow] Dropped 1 message due to cap.\nSummary:\n- x",
    );
  });

  it("pluralizes the noun for multiple drops and omits the summary block when empty", () => {
    const state = { dropPolicy: "summarize" as const, droppedCount: 3, summaryLines: [] };
    expect(buildQueueSummaryPrompt({ state, noun: "item" })).toBe(
      "[Queue overflow] Dropped 3 items due to cap.",
    );
  });

  it("honors a custom title", () => {
    const state = { dropPolicy: "summarize" as const, droppedCount: 2, summaryLines: ["a", "b"] };
    expect(buildQueueSummaryPrompt({ state, noun: "x", title: "Custom" })).toBe(
      "Custom\nSummary:\n- a\n- b",
    );
  });

  it("resets the dropped count and summary lines after emitting the prompt", () => {
    const state = { dropPolicy: "summarize" as const, droppedCount: 2, summaryLines: ["a"] };
    buildQueueSummaryPrompt({ state, noun: "x" });
    expect(state.droppedCount).toBe(0);
    expect(state.summaryLines).toEqual([]);
  });
});

describe("buildCollectPrompt", () => {
  it("joins the title and rendered items with blank-line separators", () => {
    expect(
      buildCollectPrompt({
        title: "Pending",
        items: ["a", "b"],
        renderItem: (item, index) => `${index}:${item}`,
      }),
    ).toBe("Pending\n\n0:a\n\n1:b");
  });

  it("includes an optional summary block between the title and items", () => {
    expect(
      buildCollectPrompt({
        title: "Pending",
        items: [],
        summary: "all caught up",
        renderItem: (item) => String(item),
      }),
    ).toBe("Pending\n\nall caught up");
  });
});

describe("hasCrossChannelItems", () => {
  it("returns true as soon as an item is flagged cross-channel", () => {
    expect(hasCrossChannelItems([1, 2], () => ({ cross: true }))).toBe(true);
  });

  it("returns false when every item is unkeyed", () => {
    expect(hasCrossChannelItems([1, 2], () => ({}))).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(hasCrossChannelItems([], () => ({}))).toBe(false);
  });

  it("returns false when all items share a single key", () => {
    expect(hasCrossChannelItems([1, 2], () => ({ key: "same" }))).toBe(false);
  });

  it("returns true when items span more than one key", () => {
    expect(hasCrossChannelItems([1, 2], (item) => ({ key: `key-${item}` }))).toBe(true);
  });

  it("returns true when a keyed item is mixed with an unkeyed one", () => {
    expect(hasCrossChannelItems([1, 2], (item) => (item === 1 ? { key: "k" } : {}))).toBe(true);
  });
});
