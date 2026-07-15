#!/usr/bin/env node
/**
 * OpenClaw MEMORY.md consolidation (Sylphx customer-runtime helper)
 *
 * SSOT model (OpenClaw concepts/memory):
 *   - MEMORY.md          curated long-term, auto-injected (bootstrapMaxChars=20000)
 *   - memory/YYYY-MM-DD  daily logs, on-demand via memory_search
 *
 * This tool:
 *   1) Scrubs plaintext secrets (tokens/keys) from MEMORY.md and memory markdown files
 *   2) Archives full scrubbed MEMORY.md under memory/archive/
 *   3) Rebuilds MEMORY.md under a budget with durable sections prioritized
 *   4) Never deletes daily logs
 *
 * Usage:
 *   node memory-consolidate.mjs --workspace /path/to/workspace [--budget 16000] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
}

const workspace = flag("--workspace");
const budget = Number(flag("--budget", "16000")) || 16000;
const dryRun = Boolean(flag("--dry-run", false));
const scrubOnly = Boolean(flag("--scrub-only", false));

if (!workspace || typeof workspace !== "string") {
  console.error("usage: memory-consolidate.mjs --workspace <dir> [--budget 16000] [--dry-run] [--scrub-only]");
  process.exit(2);
}

const SECRET_PATTERNS = [
  // GitLab / GitHub PATs
  /\bglpat-[A-Za-z0-9_\-]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenAI / generic sk
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // AWS secret-looking 40-char base64-ish after common labels
  /((?:aws_secret_access_key|secret[_ ]?access[_ ]?key|SecretAccessKey)\s*[=:]\s*)([A-Za-z0-9\/+=]{30,})/gi,
  // Private keys
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  // Bearer tokens pasted inline
  /((?:Bearer|token|password|credential)\s*[=:]\s*)([A-Za-z0-9_\-\.]{24,})/gi,
];

const PRIORITY_RULES = [
  { re: /安全|security|credential|token|secret|password|1password|op:\/\//i, score: 100 },
  { re: /規則|规则|rules|守則|守则|preferen|workflow|approve|merge|deploy/i, score: 90 },
  { re: /identity|角色|persona|kyle|sl\b|people|key people|telegram|allowlist/i, score: 85 },
  { re: /aws|gcp|account|profile|cloudflare|gitlab|github/i, score: 80 },
  { re: /project|epiow|hypoidea|ymcahk|crm|careops|chatbot/i, score: 70 },
  { re: /lesson|教訓|教训|playbook|standard|技術/i, score: 60 },
  { re: /mapping|canonical|source of truth|ssot/i, score: 55 },
];

function scrubText(text) {
  let out = text;
  let hits = 0;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (match, p1) => {
      hits += 1;
      // Keep labeled prefix when capture group present
      if (typeof p1 === "string" && match.startsWith(p1)) {
        return `${p1}[REDACTED-SECRET]`;
      }
      if (match.startsWith("-----BEGIN")) {
        return "[REDACTED-PRIVATE-KEY]";
      }
      return "[REDACTED-SECRET]";
    });
  }
  // Collapse accidental double redactions
  out = out.replace(/(\[REDACTED-SECRET\]){2,}/g, "[REDACTED-SECRET]");
  return { text: out, hits };
}

function walkMarkdown(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // skip node_modules / caches
      if (["node_modules", ".git", ".bun", ".cache", "media"].includes(ent.name)) continue;
      walkMarkdown(p, acc);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      acc.push(p);
    }
  }
  return acc;
}

function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = { title: "(preamble)", level: 0, lines: [] };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      sections.push(current);
      current = { title: m[2].trim(), level: m[1].length, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function scoreSection(title, body) {
  let score = 10;
  for (const rule of PRIORITY_RULES) {
    if (rule.re.test(title) || rule.re.test(body.slice(0, 400))) {
      score = Math.max(score, rule.score);
    }
  }
  // Prefer shorter durable facts over giant dumps
  if (body.length > 8000) score -= 15;
  if (body.length > 20000) score -= 25;
  return score;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  if (dryRun) {
    console.log(`[dry-run] write ${p} (${content.length} chars)`);
    return;
  }
  fs.writeFileSync(p, content, "utf8");
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore
  }
}

const memoryPath = path.join(workspace, "MEMORY.md");
const memoryDir = path.join(workspace, "memory");
const archiveDir = path.join(memoryDir, "archive");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

if (!fs.existsSync(memoryPath)) {
  console.error(`MEMORY.md missing: ${memoryPath}`);
  process.exit(1);
}

// 1) Scrub MEMORY.md + memory/**/*.md
const scrubTargets = [memoryPath, ...walkMarkdown(memoryDir)];
let totalHits = 0;
for (const file of scrubTargets) {
  const raw = fs.readFileSync(file, "utf8");
  const { text, hits } = scrubText(raw);
  if (hits > 0) {
    totalHits += hits;
    console.log(`scrub ${path.relative(workspace, file)} hits=${hits}`);
    writeFile(file, text);
  }
}
console.log(`scrub_total_hits=${totalHits}`);

if (scrubOnly) {
  console.log("scrub-only complete");
  process.exit(0);
}

// 2) Archive full scrubbed MEMORY.md
const full = fs.readFileSync(memoryPath, "utf8");
const originalChars = full.length;
ensureDir(archiveDir);
const archivePath = path.join(archiveDir, `MEMORY-full-${stamp}.md`);
writeFile(archivePath, full);
console.log(`archived ${archivePath} chars=${originalChars}`);

if (originalChars <= budget) {
  // Still rewrite a short header note if scrub changed things
  const note = [
    full.trimEnd(),
    "",
    "---",
    `<!-- consolidated ${stamp}: already within budget (${originalChars}/${budget}) -->`,
    "",
  ].join("\n");
  writeFile(memoryPath, note);
  console.log(`within_budget chars=${originalChars} budget=${budget}`);
  process.exit(0);
}

// 3) Build consolidated MEMORY.md under budget
const sections = parseSections(full);
const scored = sections
  .map((s) => {
    const body = s.lines.join("\n");
    return {
      ...s,
      body,
      score: scoreSection(s.title, body),
      len: body.length,
    };
  })
  .sort((a, b) => b.score - a.score || a.len - b.len);

const header = [
  "# MEMORY.md — Long-Term Memory (consolidated)",
  "",
  `> Consolidated ${stamp}. Full prior MEMORY archived at \`${path.relative(workspace, archivePath)}\`.`,
  "> Daily notes live in `memory/YYYY-MM-DD.md`. Use `memory_search` / `memory_get` for detail.",
  "> **Never store plaintext tokens/keys** — use 1Password `op://` references only.",
  "",
].join("\n");

const footer = [
  "",
  "---",
  "",
  "## Memory map",
  `- Full pre-consolidation MEMORY: \`${path.relative(workspace, archivePath)}\``,
  "- Daily logs: `memory/*.md` (on-demand; not auto-injected)",
  "- Dream notes: `memory/.dreams/` if present",
  "- After major work: run consolidation again (cron recommended every few days)",
  "",
].join("\n");

let used = header.length + footer.length;
const kept = [];
const dropped = [];
for (const sec of scored) {
  // Always try to keep preamble if small
  const piece = sec.body.trimEnd() + "\n\n";
  if (used + piece.length > budget) {
    dropped.push({ title: sec.title, score: sec.score, len: sec.len });
    continue;
  }
  kept.push(sec);
  used += piece.length;
}

// Restore original heading order among kept sections
kept.sort((a, b) => sections.indexOf(a) - sections.indexOf(b) || scored.indexOf(a) - scored.indexOf(b));
// Fix sort: use original order by matching title+first line identity
const order = new Map(sections.map((s, i) => [s, i]));
kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

const body = kept.map((s) => s.body.trimEnd()).join("\n\n") + "\n";
const out = header + body + footer;
writeFile(memoryPath, out);

// Index of dropped sections for operators/agents
const indexPath = path.join(archiveDir, `MEMORY-index-${stamp}.md`);
const index = [
  `# MEMORY consolidation index (${stamp})`,
  "",
  `- Original chars: ${originalChars}`,
  `- Budget: ${budget}`,
  `- Kept sections: ${kept.length}`,
  `- Dropped sections: ${dropped.length}`,
  `- Scrub hits: ${totalHits}`,
  `- Full archive: ${path.relative(workspace, archivePath)}`,
  "",
  "## Kept",
  ...kept.map((s) => `- ${s.title} (score=${s.score}, chars=${s.len})`),
  "",
  "## Deferred to archive / daily memory (not auto-injected)",
  ...dropped.map((s) => `- ${s.title} (score=${s.score}, chars=${s.len})`),
  "",
  "Use memory_search over MEMORY.md + memory/** to recover deferred detail.",
  "",
].join("\n");
writeFile(indexPath, index);

console.log(
  JSON.stringify(
    {
      workspace,
      originalChars,
      consolidatedChars: out.length,
      budget,
      kept: kept.length,
      dropped: dropped.length,
      scrubHits: totalHits,
      archive: path.relative(workspace, archivePath),
      index: path.relative(workspace, indexPath),
      dryRun,
    },
    null,
    2,
  ),
);
