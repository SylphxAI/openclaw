import { describe, expect, it } from "vitest";
import {
  isAcpSessionKey,
  isCronRunSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveThreadParentSessionKey,
} from "./session-key-utils.js";

describe("parseAgentSessionKey", () => {
  it("parses an agent key into agentId and rest", () => {
    expect(parseAgentSessionKey("agent:a:b")).toEqual({ agentId: "a", rest: "b" });
  });

  it("keeps remaining colon segments intact in rest", () => {
    expect(parseAgentSessionKey("agent:a:b:c:d")).toEqual({ agentId: "a", rest: "b:c:d" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseAgentSessionKey("  agent:a:b  ")).toEqual({ agentId: "a", rest: "b" });
  });

  it("drops empty interior segments via filter(Boolean)", () => {
    expect(parseAgentSessionKey("agent:a::b")).toEqual({ agentId: "a", rest: "b" });
  });

  it("returns null when the agentId segment is empty", () => {
    expect(parseAgentSessionKey("agent::b")).toBeNull();
  });

  it("returns null when the agentId is whitespace only", () => {
    expect(parseAgentSessionKey("agent: : ")).toBeNull();
  });

  it("returns null when there are fewer than three segments", () => {
    expect(parseAgentSessionKey("agent:a")).toBeNull();
  });

  it("returns null when the prefix is not 'agent'", () => {
    expect(parseAgentSessionKey("foo:a:b")).toBeNull();
  });

  it("returns null for empty, null, and undefined input", () => {
    expect(parseAgentSessionKey("")).toBeNull();
    expect(parseAgentSessionKey(null)).toBeNull();
    expect(parseAgentSessionKey(undefined)).toBeNull();
  });
});

describe("isCronRunSessionKey", () => {
  it("matches a cron run key under an agent prefix", () => {
    expect(isCronRunSessionKey("agent:a:cron:job:run:1")).toBe(true);
  });

  it("rejects extra trailing segments after the run id", () => {
    expect(isCronRunSessionKey("agent:a:cron:job:run:1:extra")).toBe(false);
  });

  it("rejects an empty cron job segment", () => {
    expect(isCronRunSessionKey("agent:a:cron::run:1")).toBe(false);
  });

  it("requires the agent prefix", () => {
    expect(isCronRunSessionKey("cron:job:run:1")).toBe(false);
  });

  it("returns false for a non-cron agent key", () => {
    expect(isCronRunSessionKey("agent:a:b")).toBe(false);
  });

  it("returns false for nullish input", () => {
    expect(isCronRunSessionKey(null)).toBe(false);
    expect(isCronRunSessionKey(undefined)).toBe(false);
  });
});

describe("isSubagentSessionKey", () => {
  it("matches a bare subagent prefix", () => {
    expect(isSubagentSessionKey("subagent:x")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isSubagentSessionKey("SubAgent:x")).toBe(true);
    expect(isSubagentSessionKey("agent:a:SUBAGENT:x")).toBe(true);
  });

  it("matches a subagent rest under an agent prefix", () => {
    expect(isSubagentSessionKey("agent:a:subagent:x")).toBe(true);
  });

  it("returns false for a non-subagent key", () => {
    expect(isSubagentSessionKey("agent:a:b")).toBe(false);
  });

  it("returns false for nullish input", () => {
    expect(isSubagentSessionKey(null)).toBe(false);
    expect(isSubagentSessionKey(undefined)).toBe(false);
  });
});

describe("isAcpSessionKey", () => {
  it("matches a bare acp prefix", () => {
    expect(isAcpSessionKey("acp:x")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isAcpSessionKey("ACP:x")).toBe(true);
  });

  it("matches an acp rest under an agent prefix", () => {
    expect(isAcpSessionKey("agent:a:acp:x")).toBe(true);
  });

  it("returns false for a non-acp key", () => {
    expect(isAcpSessionKey("agent:a:b")).toBe(false);
  });

  it("returns false for nullish input", () => {
    expect(isAcpSessionKey(null)).toBe(false);
    expect(isAcpSessionKey(undefined)).toBe(false);
  });
});

describe("resolveThreadParentSessionKey", () => {
  it("strips a :thread: suffix to the parent key", () => {
    expect(resolveThreadParentSessionKey("a:b:thread:c")).toBe("a:b");
  });

  it("strips a :topic: suffix to the parent key", () => {
    expect(resolveThreadParentSessionKey("a:b:topic:c")).toBe("a:b");
  });

  it("uses the last marker when both markers are present", () => {
    expect(resolveThreadParentSessionKey("a:thread:b:topic:c")).toBe("a:thread:b");
  });

  it("finds markers case-insensitively but preserves original casing in the parent", () => {
    expect(resolveThreadParentSessionKey("A:B:THREAD:c")).toBe("A:B");
  });

  it("trims surrounding whitespace before locating the marker", () => {
    expect(resolveThreadParentSessionKey("  a:b:thread:c  ")).toBe("a:b");
  });

  it("returns null when the marker is at the start (no parent)", () => {
    expect(resolveThreadParentSessionKey(":thread:c")).toBeNull();
  });

  it("returns null when no marker is present", () => {
    expect(resolveThreadParentSessionKey("a:b:c")).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(resolveThreadParentSessionKey(null)).toBeNull();
    expect(resolveThreadParentSessionKey(undefined)).toBeNull();
  });
});
