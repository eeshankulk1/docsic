import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listDocs } from "./docs.js";
import { docsDir, git, gitOrThrow } from "./repo.js";

/**
 * The PR-scoped docs gate: which docs a change set requires, and whether each
 * one was edited or explicitly waived. Deterministic - an agent writes the doc
 * content, this only decides which docs must be looked at (spec §12).
 */

export interface GateDoc {
  /** repo-relative path: docs/<name>.md, or a non-doc file from `owns` in docs/gate.json */
  doc: string;
  status: "edited" | "waived" | "missing";
  /** changed files its owns: globs matched */
  triggers: string[];
  /** the waiver's reason, or why a waiver didn't count */
  reason?: string;
}

export interface GateResult {
  base: string;
  mergeBase: string;
  changed: number;
  /** docs (and docs/gate.json owns files) that declare owns: - 0 means nothing to enforce */
  owners: number;
  required: GateDoc[];
  /** changed files no owner matches and docs/gate.json `ignore` doesn't exclude */
  unowned: string[];
  /** Docs-skip lines naming something that isn't required (harmless, reported) */
  unusedWaivers: string[];
  /** Advisory README cadence check; never affects ok. Absent when docs/gate.json sets readme.every to 0. */
  readme?: ReadmeCheck;
  ok: boolean;
}

/**
 * README.md is the public face, refreshed on a cadence rather than per PR:
 * due after `every` first-parent commits on the base since it last changed, or
 * when a top-level directory appeared or disappeared since then.
 */
export interface ReadmeCheck {
  due: boolean;
  reason?: string;
  /** short sha of README.md's last change on the base (first-parent) */
  since?: string;
  /** that commit's date (YYYY-MM-DD): what shipped since then is the refresh's input */
  date?: string;
  /** first-parent commits (PRs, in a squash-merge repo) on the base since then */
  prs: number;
  every: number;
  dirs: { added: string[]; removed: string[] };
}
export const README_EVERY = 10;

/**
 * docs/gate.json - its own file, not a key in docsic.json: docsic.json marks a repo
 * that ran `docsic init` (full standard, Stop gate), and a repo can adopt the PR
 * gate without that.
 */
export interface GateConfig { ignore?: string[]; owns?: Record<string, string[]>; readme?: { every?: number } }
export const GATE_CONFIG = "gate.json";

export function readGateConfig(root: string): GateConfig {
  const p = join(docsDir(root), GATE_CONFIG);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) as GateConfig; }
  catch (e) { throw new Error(`docsic gate: docs/${GATE_CONFIG} is not valid JSON (${e instanceof Error ? e.message : e})`); }
}

/** `Docs-skip: api.md - reason` (also `docs/api.md`, backticks, a list bullet, or `:`/en/em dash as separator). */
const WAIVER = /^\s*(?:[-*]\s+)?Docs-skip:\s*`?([^\s`]+?\.\w+)`?\s*[-:–—]+\s+(.+?)\s*$/gim;
export const MIN_REASON = 10;

export function parseWaivers(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(WAIVER)) out.set(m[1].replace(/^\.\//, ""), m[2]);
  return out;
}

export function runGate(root: string, opts: { base?: string; body?: string } = {}): GateResult {
  const base = opts.base || "origin/main";
  const mergeBase = git(root, ["merge-base", base, "HEAD"]);
  if (!mergeBase) throw new Error(`docsic gate: no merge base with ${base} - fetch it first (in CI: actions/checkout with fetch-depth: 0)`);

  // Committed, staged and unstaged changes since the merge base, plus untracked
  // files: the same answer before the commit (the ship skill) and in CI.
  // gitOrThrow, not git: an empty result here must mean "nothing matched", never
  // "the command failed" (a bad pathspec, E2BIG from a huge owns: list, a corrupt
  // repo) - silently treating a real failure as "no changes" would let the gate
  // pass a PR it never actually checked.
  const changedIn = (specs: string[]): string[] => {
    const lines = (s: string) => s.split("\n").filter(Boolean);
    let tracked: string[], untracked: string[];
    try {
      tracked = lines(gitOrThrow(root, ["diff", "--name-only", mergeBase, "--", ...specs]));
      untracked = lines(gitOrThrow(root, ["ls-files", "--others", "--exclude-standard", "--", ...specs]));
    } catch (e) {
      throw new Error(`docsic gate: ${e instanceof Error ? e.message : e}`);
    }
    return [...new Set([...tracked, ...untracked])].sort();
  };
  const glob = (g: string) => `:(glob)${g}`;
  const changed = new Set(changedIn(["."]));

  const gate = readGateConfig(root);
  const owners: { doc: string; globs: string[] }[] = [];
  for (const d of listDocs(root)) {
    if ((d.kind === "narrative" || d.kind === "hub") && Array.isArray(d.data.owns) && d.data.owns.length)
      owners.push({ doc: `docs/${d.rel}`, globs: d.data.owns });
  }
  for (const [doc, globs] of Object.entries(gate.owns ?? {})) {
    if (Array.isArray(globs) && globs.length) owners.push({ doc, globs });
  }

  const waivers = parseWaivers(opts.body ?? "");
  const waiverFor = (doc: string) => waivers.get(doc) ?? (doc.startsWith("docs/") ? waivers.get(doc.slice(5)) : undefined);
  const used = new Set<string>();

  const required: GateDoc[] = [];
  for (const o of owners) {
    // A doc never requires itself, and docs/ edits never trigger another doc.
    const triggers = changedIn(o.globs.map(glob)).filter(f => f !== o.doc && !f.startsWith("docs/"));
    if (!triggers.length) continue;
    if (changed.has(o.doc)) { required.push({ doc: o.doc, status: "edited", triggers }); continue; }
    const reason = waiverFor(o.doc);
    if (reason !== undefined) {
      used.add(o.doc); used.add(o.doc.replace(/^docs\//, ""));
      if (reason.length >= MIN_REASON) required.push({ doc: o.doc, status: "waived", triggers, reason });
      else required.push({ doc: o.doc, status: "missing", triggers, reason: `waiver reason too short (need ${MIN_REASON}+ characters): "${reason}"` });
      continue;
    }
    required.push({ doc: o.doc, status: "missing", triggers });
  }

  const exclude = [
    ":(exclude)docs/**",
    ":(exclude,icase)README.md", // the README has its own cadence check, never an owner
    ...owners.map(o => `:(exclude)${o.doc}`),
    ...owners.flatMap(o => o.globs.map(g => `:(exclude,glob)${g}`)),
    ...(Array.isArray(gate.ignore) ? gate.ignore : []).map(g => `:(exclude,glob)${g}`),
  ];
  const unowned = owners.length ? changedIn([".", ...exclude]) : [];

  const readme = readmeCheck(root, base, changed, gate);
  return {
    base,
    mergeBase,
    changed: changed.size,
    owners: owners.length,
    required,
    unowned,
    unusedWaivers: [...waivers.keys()].filter(k => !used.has(k)),
    ...(readme ? { readme } : {}),
    ok: required.every(r => r.status !== "missing"),
  };
}

/** Non-dot top-level directories: a new one (ios/, worker/) is a new surface the README should name. */
function topDirs(names: string[], ignore: string[]): Set<string> {
  const skip = new Set(ignore.map(g => g.replace(/\/\*\*?$/, "")));
  return new Set(names.filter(d => d && !d.startsWith(".") && !skip.has(d)));
}

/** Best effort: git failures here only weaken an advisory, so they never throw. */
function readmeCheck(root: string, base: string, changed: Set<string>, gate: GateConfig): ReadmeCheck | undefined {
  const every = typeof gate.readme?.every === "number" ? gate.readme.every : README_EVERY;
  if (every <= 0) return undefined;
  const ignore = Array.isArray(gate.ignore) ? gate.ignore : [];
  const name = git(root, ["ls-tree", "--name-only", base]).split("\n").find(f => /^readme\.md$/i.test(f)) ?? "README.md";
  const empty: ReadmeCheck = { due: false, prs: 0, every, dirs: { added: [], removed: [] } };
  if (changed.has(name)) return { ...empty, reason: `${name} is edited in this change` };
  const [sha, date] = git(root, ["log", "-1", "--first-parent", "--format=%H %cs", base, "--", name]).split(" ");
  if (!sha || !git(root, ["ls-tree", "--name-only", base, "--", name])) {
    return existsSync(join(root, name)) ? empty : { ...empty, due: true, reason: `${name} is missing` };
  }
  const prs = Number(git(root, ["rev-list", "--count", "--first-parent", `${sha}..${base}`])) || 0;
  const then = topDirs(git(root, ["ls-tree", "-d", "--name-only", sha]).split("\n"), ignore);
  // The working tree, not HEAD: a dir this change adds (even untracked) counts, one it deleted doesn't.
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
  const firsts = files.filter(f => f.includes("/")).map(f => f.slice(0, f.indexOf("/")));
  const now = new Set([...topDirs(firsts, ignore)].filter(d => existsSync(join(root, d))));
  const added = [...now].filter(d => !then.has(d)).sort();
  const removed = [...then].filter(d => !now.has(d)).sort();
  const reasons = [
    prs >= every ? `${prs} PRs landed since ${name} last changed (${date}; every ${every})` : "",
    added.length ? `new top-level dir${added.length > 1 ? "s" : ""} ${added.map(d => `${d}/`).join(", ")}` : "",
    removed.length ? `top-level dir${removed.length > 1 ? "s" : ""} removed: ${removed.map(d => `${d}/`).join(", ")}` : "",
  ].filter(Boolean);
  return { due: reasons.length > 0, ...(reasons.length ? { reason: reasons.join("; ") } : {}), since: sha.slice(0, 7), date, prs, every, dirs: { added, removed } };
}

export function formatGate(r: GateResult): string {
  const out: string[] = [`docs gate: base ${r.base} (${r.mergeBase.slice(0, 7)}), ${r.changed} changed files`];
  const readme = r.readme?.due ? `readme: due - ${r.readme.reason}` : null;
  if (!r.owners) {
    out.push("no doc declares owns: - nothing to enforce (add owns: frontmatter to docs/*.md)");
    if (readme) out.push(readme);
    return out.join("\n");
  }
  if (!r.required.length) out.push("no doc's owns: matched this change - nothing required");
  const width = Math.max(...r.required.map(d => d.doc.length), 0);
  for (const d of r.required) {
    const t = `${d.triggers[0]}${d.triggers.length > 1 ? ` (+${d.triggers.length - 1})` : ""}`;
    const label = d.status === "missing" ? "MISSING" : d.status;
    const detail = d.status === "waived" ? `waived: ${d.reason}` : d.reason ?? `<- ${t}`;
    out.push(`  ${label.padEnd(8)} ${d.doc.padEnd(width)}  ${detail}`);
  }
  if (r.unowned.length) {
    out.push(`unowned (no doc owns these - add to a doc's owns: or to ignore in docs/gate.json):`);
    for (const f of r.unowned.slice(0, 20)) out.push(`  ${f}`);
    if (r.unowned.length > 20) out.push(`  ... ${r.unowned.length - 20} more`);
  }
  if (r.unusedWaivers.length) out.push(`waivers for docs this change doesn't require (ignored): ${r.unusedWaivers.join(", ")}`);
  if (readme) out.push(readme);
  const missing = r.required.filter(d => d.status === "missing").length;
  out.push(missing
    ? `${missing} of ${r.required.length} required docs missing: edit them, or add \`Docs-skip: <doc> - <reason>\` to the PR body`
    : `ok: ${r.required.length} required, all edited or waived`);
  return out.join("\n");
}
