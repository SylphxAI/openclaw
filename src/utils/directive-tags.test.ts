import { describe, expect, it } from "vitest";
import { parseInlineDirectives } from "./directive-tags.js";

describe("parseInlineDirectives", () => {
  it("returns empty defaults for missing input", () => {
    expect(parseInlineDirectives()).toEqual({
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
    expect(parseInlineDirectives("")).toEqual({
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
  });

  it("leaves plain text untouched apart from whitespace normalization", () => {
    const result = parseInlineDirectives("hello world");
    expect(result.text).toBe("hello world");
    expect(result.audioAsVoice).toBe(false);
    expect(result.hasAudioTag).toBe(false);
    expect(result.hasReplyTag).toBe(false);
    expect(result.replyToId).toBeUndefined();
  });

  describe("audio tag", () => {
    it("detects and strips the audio tag by default", () => {
      const result = parseInlineDirectives("hello [[audio_as_voice]] world");
      expect(result.text).toBe("hello world");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
    });

    it("matches case-insensitively and tolerates inner whitespace", () => {
      const result = parseInlineDirectives("a [[  Audio_As_Voice  ]] b");
      expect(result.text).toBe("a b");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
    });

    it("keeps the tag in place when stripAudioTag is false", () => {
      const result = parseInlineDirectives("a [[audio_as_voice]] b", {
        stripAudioTag: false,
      });
      expect(result.text).toBe("a [[audio_as_voice]] b");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
    });
  });

  describe("reply tag", () => {
    it("captures an explicit reply target id", () => {
      const result = parseInlineDirectives("reply [[reply_to:abc123]] now");
      expect(result.text).toBe("reply now");
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToCurrent).toBe(false);
      expect(result.replyToExplicitId).toBe("abc123");
      expect(result.replyToId).toBe("abc123");
    });

    it("flags reply_to_current without resolving an id when none is provided", () => {
      const result = parseInlineDirectives("hey [[reply_to_current]]");
      expect(result.text).toBe("hey");
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBeUndefined();
      expect(result.replyToExplicitId).toBeUndefined();
    });

    it("resolves reply_to_current to the trimmed currentMessageId", () => {
      const result = parseInlineDirectives("hey [[reply_to_current]]", {
        currentMessageId: " m-99 ",
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBe("m-99");
      expect(result.replyToExplicitId).toBeUndefined();
    });

    it("treats a whitespace-only currentMessageId as unresolved", () => {
      const result = parseInlineDirectives("[[reply_to_current]]", {
        currentMessageId: "   ",
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBeUndefined();
    });

    it("prefers an explicit id over reply_to_current", () => {
      const result = parseInlineDirectives("[[reply_to_current]] [[reply_to:X]]", {
        currentMessageId: "cur",
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToExplicitId).toBe("X");
      expect(result.replyToId).toBe("X");
    });

    it("keeps the last explicit id when several are present", () => {
      const result = parseInlineDirectives("[[reply_to:one]] [[reply_to:two]]");
      expect(result.replyToExplicitId).toBe("two");
      expect(result.replyToId).toBe("two");
    });

    it("flags the tag but resolves no id for an empty explicit id", () => {
      const result = parseInlineDirectives("[[reply_to:  ]] tail");
      expect(result.text).toBe("tail");
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToCurrent).toBe(false);
      expect(result.replyToExplicitId).toBeUndefined();
      expect(result.replyToId).toBeUndefined();
    });

    it("keeps the tag in place when stripReplyTags is false", () => {
      const result = parseInlineDirectives("a [[reply_to:z]] b", {
        stripReplyTags: false,
      });
      expect(result.text).toBe("a [[reply_to:z]] b");
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToExplicitId).toBe("z");
    });
  });

  it("parses audio and reply tags together", () => {
    const result = parseInlineDirectives("a [[audio_as_voice]] [[reply_to:z]] b", {
      stripAudioTag: false,
      stripReplyTags: false,
    });
    expect(result.text).toBe("a [[audio_as_voice]] [[reply_to:z]] b");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hasAudioTag).toBe(true);
    expect(result.hasReplyTag).toBe(true);
    expect(result.replyToId).toBe("z");
  });

  it("normalizes whitespace by collapsing runs and trimming around newlines", () => {
    const result = parseInlineDirectives("  a\t\t b  \n  c  ");
    expect(result.text).toBe("a b\nc");
  });
});
