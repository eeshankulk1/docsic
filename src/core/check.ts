import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG, HUB, hubIndexTargets, listDocs, mdLinks, type Doc } from "./docs.js";
import { git } from "./repo.js";
import { readState, listNotes, tokenBudget, STATE_BUDGET } from "./memory.js";

export interface Finding {
  rule: string;
  file: string;
  line?: number;
  message: string;
  severity: "error" | "warning";
}

const PLAN_STATUS = new Set(["active", "done", "superseded"]);
const DOC_STATUS = new Set(["current", "superseded"]);

/** Command-grade token classes. Precision measured ~100% on these (spec §15). */
const COMMAND_GRADE: { cls: string; re: RegExp }[] = [
  { cls: "port", re: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|port\s*(?:=|:)?\s*)(?::)?(\d{4,5})\b/i },
  { cls: "env var", re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/ },
  { cls: "service URL", re: /https?:\/\/[^\s)`"'>]+/ },
  { cls: "model ID", re: /\b(?:claude-[a-z0-9-]+-\d|gpt-\d[\w.-]*|gemini-[\d.]+[\w-]*|o[134]-[a-z-]+)\b/i },
  { cls: "shell command", re: /^\s*(?:\$\s+)?(?:npm|npx|pnpm|yarn|bun|pip3?|uv|python3?|uvicorn|gunicorn|docker(?:-compose)?|make|cargo|go|git|brew|xcodebuild|fastlane|supabase|vercel|railway|neonctl|gh|\.\/[\w./-]+\.sh)\s+\S/ },
];
const ENV_ALLOW = new Set(["README_MD", "CLAUDE_MD", "AGENTS_MD", "CI_CD", "UI_UX"]);
const DOC_URL_HOSTS = /^https?:\/\/(?:[\w-]+\.)*(?:github\.com|docs\.[\w.-]+|developer\.[\w.-]+|[\w-]+\.dev|wikipedia\.org|npmjs\.com|readthedocs\.io)\b/;

/** Per-file opt-out for docs that quote command-grade facts as examples (a spec, a style guide). */
export const ALLOW_MARKER = "<!-- ctx: allow command-grade -->";

export function commandGradeHits(text: string): { line: number; cls: string; token: string }[] {
  const hits: { line: number; cls: string; token: string }[] = [];
  if (text.includes(ALLOW_MARKER)) return hits;
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
    const line = raw;
    for (const { cls, re } of COMMAND_GRADE) {
      let m = line.match(re);
      // inline code: a command inside backticks mid-sentence still counts
      if (!m && cls === "shell command") for (const seg of line.matchAll(/`([^`]+)`/g)) { m = seg[1].match(re); if (m) break; }
      if (!m) continue;
      const token = cls === "shell command" ? (m.input ?? m[0]).trim().slice(0, 40) : m[0].trim();
      if (cls === "env var" && (ENV_ALLOW.has(token) || /^[A-Z]+_MD$/.test(token))) continue;
      if (cls === "service URL" && DOC_URL_HOSTS.test(token)) continue;
      hits.push({ line: i + 1, cls, token });
    }
  });
  return hits;
}

export function runMechanicalChecks(root: string): Finding[] {
  const findings: Finding[] = [];
  const docs = listDocs(root);
  const docsAbs = join(root, "docs");
  const hub = docs.find(d => d.kind === "hub");

  if (!hub) {
    findings.push({ rule: "hub-missing", file: `docs/${HUB}`, message: "architecture.md is the only required doc and it is missing", severity: "error" });
  } else {
    const targets = hubIndexTargets(hub);
    const has = (rel: string) => targets.has(rel) || targets.has(`./${rel}`);
    for (const d of docs) {
      if (d.kind === "hub" || d.kind === "config" || !d.rel.endsWith(".md")) continue;
      if (d.kind === "plan") { if (!has("plans/") && !has("plans")) findings.push(idx("plans/")); continue; }
      if (d.kind === "reference") { if (!has("reference/") && !has("reference")) findings.push(idx("reference/")); continue; }
      if (!has(d.rel)) findings.push(idx(d.rel));
    }
    for (const t of targets) {
      const target = t.replace(/\/$/, "");
      if (!existsSync(join(docsAbs, target))) {
        findings.push({ rule: "hub-index-valid", file: `docs/${HUB}`, message: `index row points at missing docs/${t}`, severity: "error" });
      }
    }
  }
  // dedupe hub-index-complete rows
  const seen = new Set<string>();
  const deduped = findings.filter(f => { const k = f.rule + f.message; if (seen.has(k)) return false; seen.add(k); return true; });
  findings.length = 0; findings.push(...deduped);

  for (const d of docs) {
    if (d.kind === "narrative" || d.kind === "hub") {
      for (const h of commandGradeHits(d.raw)) {
        findings.push({ rule: "command-grade-misplaced", file: `docs/${d.rel}`, line: h.line, message: `${h.cls} \`${h.token}\` belongs in docs/${CONFIG}`, severity: "error" });
      }
    }
    if (d.kind === "narrative") {
      if (!Array.isArray(d.data.owns) || d.data.owns.length === 0)
        findings.push({ rule: "doc-frontmatter", file: `docs/${d.rel}`, message: "missing `owns:` (code paths this doc describes)", severity: "error" });
      if (d.data.status && !DOC_STATUS.has(String(d.data.status)))
        findings.push({ rule: "doc-frontmatter", file: `docs/${d.rel}`, message: `status must be current|superseded, got ${d.data.status}`, severity: "error" });
      const stale = staleness(root, d);
      if (stale) findings.push({ rule: "doc-staleness", file: `docs/${d.rel}`, message: stale, severity: "warning" });
    }
    if (d.kind === "plan") {
      if (!/^plans\/\d{4}-\d{2}-\d{2}-[\w-]+\.md$/.test(d.rel))
        findings.push({ rule: "plan-frontmatter", file: `docs/${d.rel}`, message: "filename must be YYYY-MM-DD-<slug>.md", severity: "error" });
      if (!PLAN_STATUS.has(String(d.data.status)))
        findings.push({ rule: "plan-frontmatter", file: `docs/${d.rel}`, message: `status must be active|done|superseded, got ${d.data.status ?? "none"}`, severity: "error" });
    }
    if (d.kind === "reference" && !d.data.kind && d.rel.endsWith(".md"))
      findings.push({ rule: "reference-frontmatter", file: `docs/${d.rel}`, message: "missing `kind:`", severity: "error" });
    if (d.rel.endsWith(".md")) {
      for (const { target, line } of mdLinks(d.body)) {
        const abs = resolve(dirname(d.abs), target);
        if (abs.startsWith(docsAbs) && !existsSync(abs))
          findings.push({ rule: "links-resolve", file: `docs/${d.rel}`, line, message: `link target ${target} does not exist`, severity: "error" });
      }
    }
  }

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    for (const h of commandGradeHits(readFileSync(p, "utf8"))) {
      if (h.cls !== "shell command") continue;
      findings.push({ rule: "agents-file-clean", file: name, line: h.line, message: `command \`${h.token}\` belongs in docs/${CONFIG}`, severity: "error" });
    }
  }

  const state = readState(root);
  if (state) {
    const t = tokenBudget(state);
    if (t > STATE_BUDGET) findings.push({ rule: "state-budget", file: "state.md (managed)", message: `${t} tokens, budget ${STATE_BUDGET}`, severity: "error" });
  }
  const cutoff = Date.now() - 30 * 86400_000;
  for (const n of listNotes(root)) {
    if (n.data.status === "open" && n.created && n.created.getTime() < cutoff)
      findings.push({ rule: "note-stale", file: `notes/${n.file} (managed)`, message: `open since ${n.created.toISOString().slice(0, 10)}`, severity: "warning" });
  }
  return findings;

  function idx(rel: string): Finding {
    return { rule: "hub-index-complete", file: `docs/${HUB}`, message: `docs/${rel} is not in the hub index`, severity: "error" };
  }
}

function staleness(root: string, d: Doc): string | null {
  const owns = d.data.owns as string[];
  if (!Array.isArray(owns) || owns.length === 0) return null;
  const docTs = Number(git(root, ["log", "-1", "--format=%ct", "--", `docs/${d.rel}`]));
  if (!docTs) return null;
  const specs = owns.map(g => `:(glob)${g}`);
  const codeTs = Number(git(root, ["log", "-1", "--format=%ct", "--", ...specs]));
  if (!codeTs || codeTs <= docTs) return null;
  const days = Math.round((codeTs - docTs) / 86400);
  return `owned code changed ${days}d after the doc was last touched (${owns.join(", ")})`;
}
