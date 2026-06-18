import { describe, expect, it } from "vitest";
import { buildUntrustedChannelMetadata } from "./channel-metadata.js";

describe("buildUntrustedChannelMetadata", () => {
  it("wraps entries in the channel-metadata external envelope", () => {
    const result = buildUntrustedChannelMetadata({
      source: "telegram",
      label: "Members",
      entries: ["Alice", "Bob"],
    });

    expect(result).toBe(
      [
        "",
        "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
        "Source: Channel metadata",
        "---",
        "UNTRUSTED channel metadata (telegram)",
        "Members:",
        "Alice",
        "Bob",
        "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
      ].join("\n"),
    );
  });

  it("omits the security warning block", () => {
    const result = buildUntrustedChannelMetadata({
      source: "slack",
      label: "Topic",
      entries: ["Standup"],
    });

    expect(result).toBeDefined();
    expect(result).not.toContain("SECURITY NOTICE");
  });

  it("interpolates the source into the header line", () => {
    const result = buildUntrustedChannelMetadata({
      source: "discord",
      label: "Roles",
      entries: ["admin"],
    });

    expect(result).toContain("UNTRUSTED channel metadata (discord)");
  });

  it("collapses internal whitespace within each entry", () => {
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["  Alice   Smith\t\nJr  "],
    });

    expect(result).toContain("Alice Smith Jr");
    expect(result).not.toContain("Alice   Smith");
  });

  it("drops null, undefined, non-string, and blank entries", () => {
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["Kept", null, undefined, "", "   ", "\t\n"],
    });

    expect(result).toContain("L:\nKept\n");
    // Only the single kept entry remains in the body.
    expect(result?.match(/Kept/g)).toHaveLength(1);
  });

  it("deduplicates repeated entries while preserving first-seen order", () => {
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["Bob", "Alice", "Bob", "Alice"],
    });

    const body = result?.split("L:\n")[1]?.split("\n<<<END")[0];
    expect(body).toBe("Bob\nAlice");
  });

  it("deduplicates entries by their post-normalization form", () => {
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["Alice   Smith", "  Alice Smith  "],
    });

    const body = result?.split("L:\n")[1]?.split("\n<<<END")[0];
    expect(body).toBe("Alice Smith");
  });

  it("returns undefined when no entries survive cleaning", () => {
    expect(
      buildUntrustedChannelMetadata({
        source: "s",
        label: "L",
        entries: [null, undefined, "", "   "],
      }),
    ).toBeUndefined();

    expect(buildUntrustedChannelMetadata({ source: "s", label: "L", entries: [] })).toBeUndefined();
  });

  it("truncates an over-long entry to 400 characters with an ellipsis", () => {
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["x".repeat(450)],
      // Large outer budget so only the per-entry cap applies.
      maxChars: 100_000,
    });

    const body = result?.split("L:\n")[1]?.split("\n<<<END")[0] ?? "";
    expect(body).toHaveLength(400);
    expect(body.endsWith("...")).toBe(true);
    expect(body).toBe(`${"x".repeat(397)}...`);
  });

  it("keeps a 400-character entry intact (boundary is inclusive)", () => {
    const exact = "x".repeat(400);
    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: [exact],
      maxChars: 100_000,
    });

    const body = result?.split("L:\n")[1]?.split("\n<<<END")[0];
    expect(body).toBe(exact);
  });

  it("truncates the assembled metadata to the maxChars budget", () => {
    const result = buildUntrustedChannelMetadata({
      source: "src",
      label: "Lbl",
      entries: ["A", "B", "C"],
      maxChars: 30,
    });

    // The header itself overflows the tiny budget and is truncated with "...".
    expect(result).toContain("UNTRUSTED channel metadata...");
    expect(result).not.toContain("Lbl:");
  });

  it("does not truncate when the assembled metadata exactly fits maxChars", () => {
    const header = "UNTRUSTED channel metadata (s)";
    const inner = `${header}\nL:\nAB`;

    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["AB"],
      maxChars: inner.length,
    });

    expect(result).toContain(inner);
    expect(result).not.toContain("...");
  });

  it("truncates when one character under the exact fit", () => {
    const header = "UNTRUSTED channel metadata (s)";
    const inner = `${header}\nL:\nAB`;

    const result = buildUntrustedChannelMetadata({
      source: "s",
      label: "L",
      entries: ["AB"],
      maxChars: inner.length - 1,
    });

    expect(result).toContain("...");
    expect(result).not.toContain("AB");
  });

  it("yields an empty metadata body when maxChars is zero (but still wraps)", () => {
    const result = buildUntrustedChannelMetadata({
      source: "src",
      label: "Lbl",
      entries: ["A"],
      maxChars: 0,
    });

    expect(result).toBe(
      [
        "",
        "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
        "Source: Channel metadata",
        "---",
        "",
        "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
      ].join("\n"),
    );
  });

  it("defaults the outer budget to 800 characters when maxChars is omitted", () => {
    const entries = Array.from({ length: 30 }, (_, i) => `member-${i}-${"z".repeat(40)}`);
    const result = buildUntrustedChannelMetadata({ source: "s", label: "L", entries });

    const metadata = result?.split("---\n")[1]?.split("\n<<<END")[0] ?? "";
    expect(metadata.length).toBeLessThanOrEqual(800);
    expect(metadata.endsWith("...")).toBe(true);
  });
});
