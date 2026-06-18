import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  describe("empty input", () => {
    it("returns null for an empty string", () => {
      expect(parseAbsoluteTimeMs("")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(parseAbsoluteTimeMs("   ")).toBeNull();
      expect(parseAbsoluteTimeMs("\t\n  ")).toBeNull();
    });
  });

  describe("numeric epoch milliseconds", () => {
    it("parses an all-digit string as epoch milliseconds", () => {
      expect(parseAbsoluteTimeMs("1700000000000")).toBe(1700000000000);
    });

    it("trims surrounding whitespace before parsing digits", () => {
      expect(parseAbsoluteTimeMs("  1700000000000  ")).toBe(1700000000000);
    });

    it("treats a leading-zero digit string as a base-10 number", () => {
      expect(parseAbsoluteTimeMs("007")).toBe(7);
    });

    it("accepts a single-digit positive epoch", () => {
      expect(parseAbsoluteTimeMs("1")).toBe(1);
    });
  });

  describe("ISO date-only normalization", () => {
    it("interprets a bare YYYY-MM-DD as UTC midnight", () => {
      expect(parseAbsoluteTimeMs("2024-01-15")).toBe(Date.parse("2024-01-15T00:00:00.000Z"));
    });
  });

  describe("ISO date-time without timezone", () => {
    it("appends Z and interprets the time as UTC", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00")).toBe(
        Date.parse("2024-01-15T12:30:00.000Z"),
      );
    });
  });

  describe("ISO date-time with explicit timezone", () => {
    it("passes through a trailing Z offset", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00Z")).toBe(
        Date.parse("2024-01-15T12:30:00.000Z"),
      );
    });

    it("passes through a lowercase z offset", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00z")).toBe(
        Date.parse("2024-01-15T12:30:00.000Z"),
      );
    });

    it("honors a positive numeric offset", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00+05:30")).toBe(
        Date.parse("2024-01-15T12:30:00+05:30"),
      );
    });

    it("honors a negative numeric offset", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00-08:00")).toBe(
        Date.parse("2024-01-15T12:30:00-08:00"),
      );
    });

    it("honors a colon-less numeric offset", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T12:30:00+0530")).toBe(
        Date.parse("2024-01-15T12:30:00+05:30"),
      );
    });
  });

  describe("invalid input", () => {
    it("returns null for a non-date string", () => {
      expect(parseAbsoluteTimeMs("not a date")).toBeNull();
    });

    it("returns null for digits mixed with letters", () => {
      expect(parseAbsoluteTimeMs("12abc")).toBeNull();
    });

    it("returns null for an out-of-range ISO date", () => {
      expect(parseAbsoluteTimeMs("2024-13-99")).toBeNull();
    });
  });
});
