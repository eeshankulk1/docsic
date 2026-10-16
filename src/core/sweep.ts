import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runAgent } from "./agent.js";
import { noteDate } from "./budget.js";
import { cliPath } from "./harness.js";
import { runMechanicalChecks } from "./check.js";
import { configPath } from "./config.js";
import { loadHub, openNotes, projectDir, resolveScope, syncHub, type Hub, type OpenNote } from "./hub.js";
import { ARCHIVE, archiveNoteIn, markSweptIn, memoryHome, notesIn, renewNoteIn, today } from "./memory.js";
import { findRepoRoot, git, gitOrThrow, mainCheckout, managedRoot, repoIdentity } from "./repo.js";

/**
 * The note sweep: open notes stay few and current without anyone running
 * triage. A detached process hands each due note to a headless agent, which
 * judges it (absorb, covered, renew, retire) and writes absorbed content into
 * its home; this module does everything mechanical around that judgment:
 * the trigger, the repo worktree, the guard rails on what the agent edited,
 * the docs-only PR (opened, watched, merged), the archive, the state line.
 */

/** A sweep starts when more open notes than this are due one... */
export const SWEEP_BUDGET = 10;
/** ...or a week after the last sweep. A note is due when no sweep has judged it in this long. */
export const SWEEP_EVERY_DAYS = 7;
/** Pinned notes are injected first, so few may be pinned. */
export const PIN_LIMIT = 3;
/** CLAUDE.md / AGENTS.md are read by every session: the sweep keeps them within this many lines... */
export const AGENT_FILE_LINES = 80;
/** ...and adds no line longer than this. */
export const AGENT_FILE_LINE_CHARS = 300;
const BATCH = 30; // notes per agent run
const DAY = 86_400_000;

/** Waits, mutable so tests need not sleep. */
export const SWEEP_TIMING = {
  agentMs: 30 * 60_000,
  pollMs: 15_000,
  /** How long a PR may show no checks before the sweep takes it that the repo runs none. */
  checksGraceMs: 3 * 60_000,
  checksTimeoutMs: 45 * 60_000,
  /** A project's sweep is not started again within this long of the last start. */
  retryMs: 12 * 3_600_000,
};

const AGENT_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "Bash(git log:*)", "Bash(git show:*)", "Bash(git grep:*)",
  "Bash(ls:*)", "Bash(wc:*)", "Bash(gh issue list:*)", "Bash(gh issue view:*)"];
/** The only repo files a sweep may change: existing docs and the agent instruction files. */
const AGENT_FILES = ["CLAUDE.md", "AGENTS.md"];
/** Hub files beside a project's state.md that are never a note's home: the project's identity, and state itself. */
const HUB_NOT_HOMES = ["README.md", "state.md"];

export type SweepTarget = { kind: "hub-project"; slug: string } | { kind: "repo"; root: string };

const daysSince = (date: string, now: number) => (now - Date.parse(date)) / DAY;
const isDue = (n: OpenNote, now: number) => !n.swept || daysSince(n.swept, now) >= SWEEP_EVERY_DAYS;

/** Open notes due a sweep, and why a sweep should start now (null: not yet). */
export function sweepDue(dir: string, now = Date.now()): { open: OpenNote[]; due: OpenNote[]; reason: string | null } {
  const open = openNotes(dir);
  const due = open.filter(n => isDue(n, now));
  if (!due.length) return { open, due, reason: null };
  if (due.length > SWEEP_BUDGET) return { open, due, reason: `${due.length} open notes due, budget ${SWEEP_BUDGET}` };
  const last = open.map(n => n.swept ?? "").filter(Boolean).sort().pop();
  const since = last ?? due.map(n => noteDate(n)).filter(Boolean).sort()[0];
  if (since && daysSince(since, now) >= SWEEP_EVERY_DAYS) return { open, due, reason: last ? `last sweep ${last}` : `open notes since ${since}` };
  return { open, due, reason: null };
}

interface Ctx { key: string; name: string; dir: string; repo: string | null; hub: Hub | null; slug: string | null }

function resolveTarget(t: SweepTarget): Ctx | null {
  if (t.kind === "hub-project") {
    const hub = loadHub();
    const p = hub?.projects.find(p => p.slug === t.slug);
    if (!hub || !p) return null;
    return { key: p.slug, name: p.slug, dir: projectDir(hub, p.slug), repo: repoWithOrigin(p.repo), hub, slug: p.slug };
  }
  const h = memoryHome(t.root);
  return { key: h.slug ?? repoIdentity(t.root), name: h.slug ?? basename(t.root), dir: h.dir, repo: repoWithOrigin(t.root), hub: h.hub, slug: h.slug };
}

/**
 * The sweep for a directory: its repo's main checkout when it is in one (the
 * repo the docs PR goes to, and its memory, hub or local), else the hub
 * project it maps to. A session's own checkout beats the hub's idea of where
 * the project's repo lives.
 */
export function sweepTargetFor(cwd: string): SweepTarget {
  const root = findRepoRoot(cwd);
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) === "true") return { kind: "repo", root: mainCheckout(root) };
  const hub = loadHub();
  const scope = hub ? resolveScope(cwd, hub) : null;
  return scope?.kind === "project" ? { kind: "hub-project", slug: scope.project.slug } : { kind: "repo", root };
}

/** A repo the sweep can open a PR in: the top of a git checkout that has an origin. */
function repoWithOrigin(p: string | null): string | null {
  if (!p || !existsSync(p)) return null;
  const top = git(p, ["rev-parse", "--show-toplevel"]);
  if (!top || realpathSync(top) !== realpathSync(p)) return null;
  return git(top, ["remote", "get-url", "origin"]) ? top : null;
}

function paths(key: string) {
  const root = join(managedRoot(), "sweeps");
  return { root, work: join(root, key), marker: join(root, `${key}.json`), lock: join(root, `${key}.lock`), log: join(root, `${key}.log`) };
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** For a workspace session: the hub project most overdue a sweep, if any is due. */
export function pickSweep(hub: Hub, now = Date.now()): SweepTarget | null {
  let best: { slug: string; n: number } | null = null;
  for (const p of hub.projects) {
    const d = sweepDue(projectDir(hub, p.slug), now);
    if (d.reason && (!best || d.due.length > best.n)) best = { slug: p.slug, n: d.due.length };
  }
  return best ? { kind: "hub-project", slug: best.slug } : null;
}

/**
 * Session-end trigger: start a detached `docsic sweep` when the target's notes
 * are due one and no sweep of it started recently. Returns whether it started.
 */
export function startSweep(t: SweepTarget, now = Date.now(), opts: { noMerge?: boolean } = {}): boolean {
  const c = resolveTarget(t);
  if (!c || !sweepDue(c.dir, now).reason) return false;
  const f = paths(c.key);
  const last = readJson<{ started?: string }>(f.marker)?.started;
  if (last && now - Date.parse(last) < SWEEP_TIMING.retryMs) return false;
  mkdirSync(f.root, { recursive: true });
  writeFileSync(f.marker, JSON.stringify({ started: new Date(now).toISOString() }) + "\n");
  const log = openSync(f.log, "w");
  const target = t.kind === "hub-project" ? ["--project", t.slug] : ["--repo", t.root];
  spawn(process.execPath, [cliPath(), "sweep", ...target, "--auto", ...(opts.noMerge ? ["--no-merge"] : [])], {
    detached: true, stdio: ["ignore", log, log], env: { ...process.env, DOCSIC_DISTILLER: "1" },
  }).unref();
  return true;
}

export interface SweepOptions {
  /** Judge and write, then report and undo: no PR, no archive, no hub or state change. */
  dryRun?: boolean;
  /**
   * Open the docs PR and stop there: a person reviews and merges it. Its
   * notes stay open, and once it merges a later sweep finds them covered.
   */
  noMerge?: boolean;
  /** Judge every open note, not only the due ones. */
  all?: boolean;
  /** Judge at most this many notes, oldest first. */
  limit?: number;
  /** Started by the trigger: re-check it and stop when nothing is due. */
  auto?: boolean;
  log?: (line: string) => void;
}

interface Decision { file: string; outcome: "absorb" | "covered" | "renew" | "retire"; into?: string; reason?: string; evidence?: string; pin?: boolean }
export interface Judged { file: string; title: string; result: "absorbed" | "covered" | "retired" | "renewed" | "open"; into?: string; why: string }
export interface SweepReport {
  project: string; date: string; dryRun: boolean; before: number; after: number;
  counts: Record<Judged["result"], number>;
  pr: { number: number; url: string; merged: boolean } | null;
  docs: string[]; hub: string[]; notes: Judged[]; line: string; problems: string[];
}

/** Runs one sweep in this process (the detached `docsic sweep`, or by hand). */
export async function sweep(t: SweepTarget, opts: SweepOptions = {}): Promise<SweepReport | null> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const c = resolveTarget(t);
  if (!c) { log("sweep: no memory for that target"); return null; }
  const f = paths(c.key);
  mkdirSync(f.root, { recursive: true });
  const holder = readJson<number>(f.lock);
  if (holder && alive(holder)) { log(`sweep: a sweep of ${c.name} is already running (pid ${holder})`); return null; }
  writeFileSync(f.lock, String(process.pid));
  const started = new Date().toISOString();
  if (!opts.dryRun) writeFileSync(f.marker, JSON.stringify({ started }) + "\n");
  try {
    const report = await sweepLocked(c, f.work, opts, log);
    if (!opts.dryRun) writeFileSync(f.marker, JSON.stringify({ started, finished: new Date().toISOString(), result: report?.line ?? "nothing to sweep" }) + "\n");
    return report;
  } finally {
    rmSync(f.lock, { force: true });
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function sweepLocked(c: Ctx, workDir: string, opts: SweepOptions, log: (s: string) => void): Promise<SweepReport | null> {
  const date = today();
  if (!opts.dryRun) {
    const moved = migrateAbsorbed(c.dir);
    if (moved) log(`sweep: moved ${moved} absorbed note${moved > 1 ? "s" : ""} into notes/${ARCHIVE}/`);
  }
  const { open, due, reason } = sweepDue(c.dir);
  if (opts.auto && !reason) { log("sweep: not due"); return null; }
  const judge = (opts.all ? open : due).slice(0, opts.limit ?? Infinity);
  if (!judge.length) { log("sweep: no open notes to judge"); return null; }
  log(`sweep ${c.name}: judging ${judge.length} of ${open.length} open notes${reason ? ` (${reason})` : ""}`);

  const work = resetWork(workDir, c.repo);
  const wt = c.repo ? addWorktree(c.repo, join(work, "repo"), log) : null;
  const problems: string[] = [];
  if (!c.repo) problems.push("no repo checkout with an origin, so no docs PR");
  try {
    const baseline = wt ? errorCounts(wt.path) : new Map<string, number>();
    const hubFiles = editableHubFiles(c);
    const pinned = open.filter(n => n.pinned).map(n => n.file);

    const decisions = new Map<string, Decision>();
    const batches: OpenNote[][] = [];
    for (let i = 0; i < judge.length; i += BATCH) batches.push(judge.slice(i, i + BATCH));
    for (const [i, batch] of batches.entries()) {
      const bundle = join(work, `notes-${i + 1}.md`), out = join(work, `sweep-${i + 1}.json`);
      writeFileSync(bundle, batch.map(n => `### ${n.file}\n\n${readFileSync(n.path, "utf8").trim()}\n`).join("\n"));
      const ran = runAgent({
        prompt: sweepPrompt({ name: c.name, bundle, out, count: batch.length, wt, hubFiles, pinned, date }),
        cwd: wt?.path ?? work, addDirs: [work, c.dir], tools: AGENT_TOOLS, timeoutMs: SWEEP_TIMING.agentMs,
      });
      if (!ran) { log("sweep: no agent CLI (claude or codex) on PATH"); break; }
      const files = new Set(batch.map(n => n.file));
      for (const d of readDecisions(out, files, log)) decisions.set(d.file, d);
    }
    if (!decisions.size) {
      for (const h of hubFiles) if (read(h.path) !== h.before) writeFileSync(h.path, h.before);
      log("sweep: the agent decided nothing, so nothing changed");
      return null;
    }

    const docs: Landed = wt ? await landDocs(wt, c, judge, decisions, baseline, opts, log) : { kept: [], pr: null, merged: false, reverted: {} };
    if (docs.problem) problems.push(docs.problem);
    const hubChanged = hubFiles.filter(h => read(h.path) !== h.before);
    if (opts.dryRun) {
      // Keep what the agent wrote for the reader, then put the hub back.
      for (const h of hubChanged) { writeFileSync(join(work, `hub-${h.name}`), read(h.path) ?? ""); writeFileSync(h.path, h.before); }
    }

    const judged = judge.map(n => outcome(n, decisions.get(n.file), docs, hubChanged.map(h => h.name), opts.dryRun ?? false));
    // A pin is renewed like the note: a judged note keeps it only if the agent pins it again.
    const judgedFiles = new Set(judge.map(n => n.file));
    let pins = pinned.filter(f => !judgedFiles.has(f)).length;
    for (const j of judged) {
      const d = decisions.get(j.file);
      if (j.result === "renewed" && d?.pin) {
        if (pins < PIN_LIMIT) pins++; else { d.pin = false; j.why += " (not pinned: pin limit reached)"; }
      }
      if (opts.dryRun) continue;
      try {
        if (j.result === "open") markSweptIn(c.dir, j.file, date);
        else if (j.result === "renewed") renewNoteIn(c.dir, j.file, { evidence: d!.evidence!, pin: d!.pin, date });
        else archiveNoteIn(c.dir, j.file, { outcome: j.result, into: j.into, reason: j.why, date });
      } catch (e) { // a session absorbed or edited it while the agent ran
        log(`sweep: left ${j.file} as it is: ${e instanceof Error ? e.message : e}`);
      }
    }

    const counts = { absorbed: 0, covered: 0, retired: 0, renewed: 0, open: 0 };
    for (const j of judged) counts[j.result]++;
    const before = open.length;
    const after = before - counts.absorbed - counts.covered - counts.retired;
    const line = sweepLine(date, before, after, counts, docs);
    if (!opts.dryRun) {
      writeSweepLine(c.dir, line);
      if (c.hub && c.slug) syncHub(c.hub, c.slug, `note sweep, ${before} -> ${after} open`, hubChanged.map(h => `projects/${c.slug}/${h.name}`));
    }
    const report: SweepReport = {
      project: c.name, date, dryRun: !!opts.dryRun, before, after, counts, pr: docs.pr,
      docs: docs.kept, hub: hubChanged.map(h => h.name), notes: judged, line, problems,
    };
    log(formatReport(report, work));
    return report;
  } finally {
    if (wt) removeWorktree(wt);
  }
}

function read(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/** Notes absorbed before the archive existed sit in notes/ with status absorbed; they move into it. */
function migrateAbsorbed(dir: string): number {
  let n = 0;
  for (const note of notesIn(dir)) {
    if (note.data.status !== "absorbed") continue;
    archiveNoteIn(dir, note.file, { outcome: "absorbed", reason: "absorbed before the note archive existed" });
    n++;
  }
  return n;
}

/** A fresh work dir; a worktree a crashed sweep left there is unregistered first. */
function resetWork(work: string, repo: string | null): string {
  if (repo && existsSync(join(work, "repo"))) git(repo, ["worktree", "remove", "--force", join(work, "repo")]);
  rmSync(work, { recursive: true, force: true });
  if (repo) git(repo, ["worktree", "prune"]);
  mkdirSync(work, { recursive: true });
  return work;
}

interface Worktree { repo: string; path: string; branch: string; base: string; defaultBranch: string }

/** A worktree on a new branch from the remote default branch: the sweep checks notes against current main. */
function addWorktree(repo: string, path: string, log: (s: string) => void): Worktree | null {
  git(repo, ["fetch", "-q", "origin"]);
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); // origin/main
  const base = head || ["origin/main", "origin/master"].find(b => git(repo, ["rev-parse", "--verify", "-q", b])) || "";
  if (!base) { log(`sweep: ${repo} has no origin default branch; no docs PR`); return null; }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).toLowerCase(); // 20261016t0830
  const branch = `docs/note-sweep-${stamp}`;
  try {
    gitOrThrow(repo, ["worktree", "add", "-q", "-b", branch, path, base]);
  } catch (e) {
    log(`sweep: could not add a worktree: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  return { repo, path, branch, base, defaultBranch: base.replace(/^origin\//, "") };
}

function removeWorktree(wt: Worktree): void {
  git(wt.repo, ["worktree", "remove", "--force", wt.path]);
  git(wt.repo, ["branch", "-D", wt.branch]);
}

interface HubFile { name: string; path: string; before: string }

/**
 * The project's existing hub docs (decisions.md, backlog.md, and whatever
 * else the owner keeps beside state.md) the agent may add absorbed notes to;
 * one with uncommitted edits is left alone.
 */
function editableHubFiles(c: Ctx): HubFile[] {
  if (!c.hub || !c.slug) return [];
  const out: HubFile[] = [];
  for (const name of readdirSync(c.dir).filter(f => f.endsWith(".md") && !HUB_NOT_HOMES.includes(f)).sort()) {
    const path = join(c.dir, name);
    const before = read(path);
    if (before === null) continue;
    if (c.hub.sync === "git" && git(c.hub.root, ["status", "--porcelain", "--", `projects/${c.slug}/${name}`])) continue;
    out.push({ name, path, before });
  }
  return out;
}

function readDecisions(out: string, files: Set<string>, log: (s: string) => void): Decision[] {
  const raw = readJson<{ notes?: unknown }>(out);
  if (!raw || !Array.isArray(raw.notes)) { log(`sweep: no decisions in ${out}`); return []; }
  const ok: Decision[] = [];
  for (const x of raw.notes as Partial<Decision>[]) {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const d: Decision = { file: String(x?.file ?? ""), outcome: x?.outcome as Decision["outcome"], into: str(x?.into), reason: str(x?.reason), evidence: str(x?.evidence), pin: x?.pin === true };
    const why = !files.has(d.file) ? "not a note in this batch"
      : d.outcome === "absorb" && !/^(repo|hub):\S/.test(d.into ?? "") ? "absorb needs into repo:<path> or hub:<file>"
      : d.outcome === "covered" && !d.into ? "covered needs into"
      : d.outcome === "retire" && !d.reason ? "retire needs a reason"
      : d.outcome === "renew" && !d.evidence ? "renew needs evidence"
      : !["absorb", "covered", "renew", "retire"].includes(d.outcome) ? `unknown outcome ${d.outcome}` : null;
    if (why) { log(`sweep: ignoring the decision for ${d.file || "?"}: ${why}`); continue; }
    ok.push(d);
  }
  return ok;
}

/** What happens to one note, given the agent's decision and what actually landed. */
function outcome(n: OpenNote, d: Decision | undefined, docs: Landed, hubChanged: string[], dryRun: boolean): Judged {
  const base = { file: n.file, title: n.title };
  if (!d) return { ...base, result: "open", why: "no decision: its home was unclear" };
  if (d.outcome === "covered") return { ...base, result: "covered", into: d.into, why: d.reason ?? "already covered" };
  if (d.outcome === "retire") return { ...base, result: "retired", why: d.reason! };
  if (d.outcome === "renew") return { ...base, result: "renewed", why: d.evidence! };
  const { where, path } = home(d.into!);
  if (where === "hub") {
    return hubChanged.includes(path)
      ? { ...base, result: "absorbed", into: `${path} (hub)`, why: d.reason ?? `absorbed into ${path}` }
      : { ...base, result: "open", why: `absorb into hub ${path} did not happen (the file is not one the sweep may edit, or was not changed)` };
  }
  if (!docs.kept.includes(path)) return { ...base, result: "open", why: `absorb into ${path} was not kept${docs.reverted[path] ? `: ${docs.reverted[path]}` : ""}` };
  if (dryRun) return { ...base, result: "absorbed", into: path, why: d.reason ?? `absorbed into ${path}` };
  if (docs.review) return { ...base, result: "open", why: `written into ${path}, in docs PR #${docs.pr!.number} awaiting review` };
  if (!docs.merged) return { ...base, result: "open", why: `absorb into ${path} did not land: ${docs.problem ?? "the docs PR did not merge"}` };
  return { ...base, result: "absorbed", into: `${path} (PR #${docs.pr!.number})`, why: d.reason ?? `absorbed into ${path}` };
}

/** "repo:./docs/a.md#setup" -> repo, docs/a.md: the file an absorb wrote to. */
function home(into: string): { where: string; path: string } {
  const i = into.indexOf(":");
  return { where: into.slice(0, i), path: into.slice(i + 1).replace(/#.*$/, "").replace(/^\.\//, "").trim() };
}

interface Landed { kept: string[]; pr: { number: number; url: string; merged: boolean } | null; merged: boolean; review?: boolean; problem?: string; reverted: Record<string, string> }

/** Rules that are a repo's standard only once it ran `docsic init` (as for the Stop hook): before that, its docs may well quote commands. */
const INIT_ONLY_RULES = new Set(["command-grade-misplaced", "agents-file-clean"]);

/** Error findings by file + rule + message, counted, so a new one is visible whatever line it lands on. */
function errorCounts(root: string): Map<string, number> {
  const m = new Map<string, number>();
  const initialized = existsSync(configPath(root));
  for (const f of runMechanicalChecks(root)) {
    if (f.severity !== "error" || (!initialized && INIT_ONLY_RULES.has(f.rule))) continue;
    const k = `${f.file}\0${f.rule}\0${f.message}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function changedFiles(wt: string): { tracked: string[]; untracked: string[] } {
  const lines = (s: string) => s.split("\n").filter(Boolean);
  return { tracked: lines(git(wt, ["diff", "--name-only", "HEAD"])), untracked: lines(git(wt, ["ls-files", "--others", "--exclude-standard"])) };
}

/** Why a change to CLAUDE.md / AGENTS.md is over budget, or null. */
function agentFileOver(wt: string, f: string): string | null {
  const before = git(wt, ["show", `HEAD:${f}`]).split("\n");
  const after = (read(join(wt, f)) ?? "").trimEnd().split("\n");
  if (after.length > AGENT_FILE_LINES && after.length > before.length) return `${f} would be ${after.length} lines (budget ${AGENT_FILE_LINES})`;
  const old = new Set(before);
  const long = after.find(l => !old.has(l) && l.length > AGENT_FILE_LINE_CHARS);
  return long ? `a line added to ${f} is ${long.length} characters (at most ${AGENT_FILE_LINE_CHARS})` : null;
}

/**
 * Guard rails, then the PR. The agent may only have edited existing docs and
 * the agent instruction files; anything else is reverted, as is an
 * instruction file pushed past its budget and a doc that gained a check
 * error. What is left goes out as one docs-only PR, merged once its checks
 * pass; on any failure the PR is closed and its notes stay open.
 */
async function landDocs(wt: Worktree, c: Ctx, judge: OpenNote[], decisions: Map<string, Decision>, baseline: Map<string, number>, opts: SweepOptions, log: (s: string) => void): Promise<Landed> {
  const reverted: Record<string, string> = {};
  const revert = (f: string, why: string, tracked: boolean) => {
    if (tracked) git(wt.path, ["checkout", "HEAD", "--", f]); else rmSync(join(wt.path, f), { force: true });
    reverted[f] = why;
    log(`sweep: reverted ${f}: ${why}`);
  };
  const first = changedFiles(wt.path);
  for (const f of first.untracked) revert(f, "the sweep edits existing files only", false);
  for (const f of first.tracked) {
    if (!existsSync(join(wt.path, f))) revert(f, "the sweep deletes nothing", true);
    else if (!f.startsWith("docs/") && !AGENT_FILES.includes(f)) revert(f, "outside docs/ and the agent instruction files", true);
    else if (AGENT_FILES.includes(f)) { const over = agentFileOver(wt.path, f); if (over) revert(f, over, true); }
  }
  const after = errorCounts(wt.path);
  const worse = new Map<string, string>(); // file -> the rule it broke
  for (const [k, n] of after) if (n > (baseline.get(k) ?? 0)) { const [file, rule] = k.split("\0"); if (!worse.has(file)) worse.set(file, rule); }
  for (const f of changedFiles(wt.path).tracked) if (worse.has(f)) revert(f, `it gained a docsic check error (${worse.get(f)})`, true);

  const kept = changedFiles(wt.path).tracked;
  if (!kept.length) return { kept, pr: null, merged: false, reverted };
  if (opts.dryRun) {
    writeFileSync(join(dirname(wt.path), "docs.patch"), git(wt.path, ["diff", "HEAD"]) + "\n");
    return { kept, pr: null, merged: false, reverted };
  }

  const date = today();
  const absorbed = judge.flatMap(n => {
    const d = decisions.get(n.file);
    const path = d?.outcome === "absorb" && d.into?.startsWith("repo:") ? home(d.into).path : null;
    return path && kept.includes(path) ? [{ title: n.title, path, reason: d!.reason ?? "" }] : [];
  });
  const fail = (problem: string, pr: Landed["pr"] = null): Landed => { log(`sweep: ${problem}`); return { kept, pr, merged: false, problem, reverted }; };
  try {
    gitOrThrow(wt.path, ["add", "--", ...kept]);
    gitOrThrow(wt.path, ["commit", "-q", "-m", `docs: note sweep ${date}`, "-m", `${absorbed.length} open notes from ${c.name}'s memory, written into the docs that own them.`]);
    gitOrThrow(wt.path, ["push", "-q", "-u", "origin", wt.branch]);
  } catch (e) {
    return fail(`could not commit or push the docs branch: ${e instanceof Error ? e.message.split("\n").slice(-1)[0] : e}`);
  }
  const created = gh(wt.path, ["pr", "create", "--base", wt.defaultBranch, "--head", wt.branch,
    "--title", `docs: note sweep ${date}`, "--body", prBody(c, wt, absorbed, !!opts.noMerge)]);
  const url = created.out.trim().split("\n").pop() ?? "";
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
  if (!created.ok || !number) {
    git(wt.path, ["push", "-q", "origin", "--delete", wt.branch]);
    return fail(`gh pr create failed: ${created.err || created.out}`.trim());
  }
  const pr = { number, url, merged: false };
  log(`sweep: opened ${url}`);
  const close = (why: string): Landed => {
    gh(wt.path, ["pr", "close", String(number), "--comment", `The note sweep closed this: ${why}. Its notes stay open for the next sweep.`]);
    git(wt.path, ["push", "-q", "origin", "--delete", wt.branch]);
    return fail(`docs PR #${number} closed: ${why}`, pr);
  };
  const entry = worklogEntry(wt, c, number, absorbed.length);
  if (entry) {
    try {
      gitOrThrow(wt.path, ["add", "--", entry]);
      gitOrThrow(wt.path, ["commit", "-q", "-m", `docs: worklog entry for #${number}`]);
      gitOrThrow(wt.path, ["push", "-q", "origin", wt.branch]);
    } catch { return close("could not push its worklog entry"); }
  }
  if (opts.noMerge) return { kept, pr, merged: false, review: true, reverted };
  const checks = await waitChecks(wt.path, number);
  if (checks !== "pass") return close(checks === "fail" ? "its checks failed" : "its checks did not finish in time");
  const merged = gh(wt.path, ["pr", "merge", String(number), mergeMethod(wt)]);
  if (!merged.ok) return close(`the merge was refused (${merged.err.split("\n")[0]})`);
  git(wt.path, ["push", "-q", "origin", "--delete", wt.branch]);
  log(`sweep: merged #${number}`);
  return { kept, pr: { ...pr, merged: true }, merged: true, reverted };
}

function gh(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  return { ok: r.status === 0, out: r.stdout ?? "", err: ((r.stderr ?? "").trim() || r.error?.message) ?? "" };
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Polls the PR's checks; all complete and none failed, two polls running, is a pass. */
async function waitChecks(cwd: string, pr: number): Promise<"pass" | "fail" | "timeout"> {
  const start = Date.now();
  let settled = 0;
  for (;;) {
    let checks: { bucket?: string }[] = [];
    try { checks = JSON.parse(gh(cwd, ["pr", "checks", String(pr), "--json", "name,bucket"]).out || "[]"); } catch { /* none yet */ }
    if (checks.some(c => c.bucket === "fail" || c.bucket === "cancel")) return "fail";
    const done = checks.length > 0 && !checks.some(c => c.bucket === "pending");
    if (done) { if (++settled >= 2) return "pass"; }
    else { settled = 0; if (!checks.length && Date.now() - start > SWEEP_TIMING.checksGraceMs) return "pass"; } // the repo runs no checks
    if (Date.now() - start > SWEEP_TIMING.checksTimeoutMs) return "timeout";
    await sleep(SWEEP_TIMING.pollMs);
  }
}

/** The merge the repo's recent PRs used: merge commits when its history has them, else squash. */
function mergeMethod(wt: Worktree): string {
  const subjects = git(wt.path, ["log", wt.base, "--first-parent", "-10", "--format=%s"]);
  return /^Merge pull request /m.test(subjects) ? "--merge" : "--squash";
}

/**
 * A repo that keeps a worklog (docs/worklog/, one entry file per PR) gets this
 * PR's entry, so a CI check that wants one passes. Returns its path, or null.
 */
function worklogEntry(wt: Worktree, c: Ctx, pr: number, n: number): string | null {
  if (!existsSync(join(wt.path, "docs", "worklog")) && !existsSync(join(wt.path, "docs", "worklog.jsonl"))) return null;
  const date = today();
  const rel = `docs/worklog/${date.slice(0, 7)}/${date}-${wt.branch.replace(/\//g, "-")}.json`;
  mkdirSync(dirname(join(wt.path, rel)), { recursive: true });
  writeFileSync(join(wt.path, rel), JSON.stringify({ date, project: c.name, summary: `Note sweep: ${n} open note${n === 1 ? "" : "s"} written into the docs that own them.`, pr, why: "Open notes stay few; what they knew lives in the docs." }) + "\n");
  return rel;
}

function prBody(c: Ctx, wt: Worktree, absorbed: { title: string; path: string; reason: string }[], review: boolean): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  return [
    `Docs-only. The docsic note sweep found ${absorbed.length} open note${absorbed.length === 1 ? "" : "s"} in ${c.name}'s memory whose permanent home is one of these docs, checked each against \`${wt.base}\`, and wrote it in. ${review ? "It leaves this PR for review rather than merging it." : "It merges this PR once the checks pass."}`,
    "",
    "| Note | Into | Why |",
    "|---|---|---|",
    ...absorbed.map(a => `| ${cell(a.title)} | \`${a.path}\` | ${cell(a.reason)} |`),
    "",
    review
      ? `Its notes stay open until it merges; the next sweep then finds them covered and moves them to the note archive, where \`docsic recall\` still finds them.`
      : `Once this merges, each note moves to the note archive with a pointer here; \`docsic recall\` still finds it.`,
  ].join("\n");
}

function sweepLine(date: string, before: number, after: number, n: Record<Judged["result"], number>, docs: Landed): string {
  const parts = (["absorbed", "covered", "retired", "renewed"] as const).filter(k => n[k]).map(k => `${n[k]} ${k}`);
  if (n.open) parts.push(`${n.open} left open`);
  const pr = !docs.pr ? (docs.problem ? `; no docs PR (${docs.problem})` : "")
    : docs.merged ? `; docs PR #${docs.pr.number} merged`
    : docs.review ? `; docs PR #${docs.pr.number} awaits review, its notes stay open until a sweep finds them covered`
    : `; docs PR #${docs.pr.number} not merged, its notes stay open`;
  return `- Note sweep ${date}: ${before} -> ${after} open notes (${parts.join(", ")})${pr}. Swept notes are in notes/${ARCHIVE}/; docsic recall finds them.`;
}

/** The sweep's one line under ## Now in state.md, replacing the last sweep's. */
function writeSweepLine(dir: string, line: string): void {
  const p = join(dir, "state.md");
  let s = read(p) ?? "## Now\n\n## In flight\n\n## Next\n";
  const prev = /^- Note sweep \d{4}-\d{2}-\d{2}:.*$/m;
  if (prev.test(s)) s = s.replace(prev, () => line);
  else if (/^## Now.*$/m.test(s)) s = s.replace(/^## Now.*$/m, m => `${m}\n${line}`);
  else s = `## Now\n${line}\n\n${s}`;
  writeFileSync(p, s.trimEnd() + "\n");
}

function formatReport(r: SweepReport, work: string): string {
  const rows = r.notes.map(n => `  ${n.result.padEnd(8)} ${n.file}${n.into ? ` -> ${n.into}` : ""}: ${n.why}`);
  return [
    `${r.dryRun ? "[dry run] " : ""}${r.line.replace(/^- /, "")}`,
    ...rows,
    ...(r.docs.length ? [`docs changed: ${r.docs.join(", ")}${r.dryRun ? ` (patch: ${join(work, "docs.patch")})` : ""}`] : []),
    ...(r.hub.length ? [`hub files changed: ${r.hub.join(", ")}${r.dryRun ? ` (copies in ${work})` : ""}`] : []),
    ...r.problems.map(p => `problem: ${p}`),
  ].join("\n");
}

function sweepPrompt(a: { name: string; bundle: string; out: string; count: number; wt: Worktree | null; hubFiles: HubFile[]; pinned: string[]; date: string }): string {
  const homes: string[] = [];
  if (a.wt) homes.push(
    `  - "repo:docs/<doc>.md": the existing doc that owns the code the note is about. docs/architecture.md indexes every doc, and each doc's \`owns:\` frontmatter lists the code it covers. Edit existing docs only; never create one. Never put exact commands, ports, env var names, URLs or model IDs in a doc's prose (they belong in the repo's config), so a note that is only a command is covered or stays open.`,
    `  - "repo:CLAUDE.md" (or "repo:AGENTS.md", whichever the repo has): only a gotcha that fits no doc and that every session in this repo must know, as one line of at most ${AGENT_FILE_LINE_CHARS} characters. The file must stay within ${AGENT_FILE_LINES} lines: every line there costs every session.`);
  for (const h of a.hubFiles) homes.push(h.name === "decisions.md"
    ? `  - "hub:decisions.md": a decision. Append one row \`| ${a.date} | <decision> | <reasoning> |\` to the table in ${h.path}.`
    : h.name === "backlog.md"
      ? `  - "hub:backlog.md": an idea worth keeping. Add one line to ${h.path}, in the format already there.`
      : `  - "hub:${h.name}": what belongs in ${h.path} (read it first). Add it where it fits, in the format already there.`);
  const allowed = [...(a.wt ? ["existing files under docs/", ...AGENT_FILES] : []), ...a.hubFiles.map(h => h.path), a.out];
  return `You are the docsic note sweep for ${a.name}. Open notes are knowledge in transit to a permanent home; the ones that never get there pile up until no session reads them. Judge each note in ${a.bundle} (${a.count} notes; each starts with "### <file>") and give it exactly one outcome.

${a.wt
    ? `Your working directory is a fresh worktree of ${a.name}'s repo at ${a.wt.base}: current main. Check every claim against it before you decide or write anything: grep the code, read the doc, \`git log -S <term>\`. A note the code no longer bears out is retired, not absorbed.`
    : `${a.name} has no repo checkout the sweep can open a PR in, so no repo doc can be edited this time.`}

Outcomes:
- absorb: true on current main, with a clear permanent home. Write it into that home, short, in the voice of the text around it, and name the home in "into":
${homes.length ? homes.join("\n") : "  (no home is writable this time: use the other outcomes, or leave the note out)"}
- covered: a doc or the code already says it. "into" points there (a doc path, "code:<path>", or "hub:<file>"). Write nothing.
- renew: still true AND still in use, and you can name the evidence in "evidence": the code it guards, a recent commit or PR, an open issue. Looking important is not evidence. "pin": true only for a gotcha every session here must see first (at most ${PIN_LIMIT} pinned; pinned now: ${a.pinned.join(", ") || "none"}).
- retire: wrong, resolved, superseded, a duplicate of another note, or in-flight state such as build numbers or PRs awaiting review (state.md owns those). "reason" says which.

If you cannot tell where a note belongs, leave it out of your decisions: it stays open. Never guess a note into a doc.

Write your decisions to ${a.out}, one per note you judged:
{"notes": [
  {"file": "<file>", "outcome": "absorb", "into": "repo:docs/local-dev.md", "reason": "<one line>"},
  {"file": "<file>", "outcome": "covered", "into": "docs/api.md", "reason": "<one line>"},
  {"file": "<file>", "outcome": "renew", "evidence": "<one line>", "pin": false},
  {"file": "<file>", "outcome": "retire", "reason": "<one line>"}
]}
A later reader finds "reason" in the archive, so make it specific.

Edit nothing but ${allowed.join(", ")}. Do not commit, push or open a PR: once you finish, docsic reverts edits outside those files, opens one docs PR and merges it when its checks pass, and archives each note with your reason.`;
}
