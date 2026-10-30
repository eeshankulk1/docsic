import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runAgent } from "./core/agent.js";
import { runMechanicalChecks } from "./core/check.js";
import { configPath } from "./core/config.js";
import { loadHub, projectDir, readUserConfig, renderProject, resolveScope, snapshot, syncHub, workspaceSnapshot, type Hub, type HubProject } from "./core/hub.js";
import { load } from "./core/load.js";
import { fitGroups, fitPayload, moreNotesLine, NOTES_BUDGET, orderNotes, takeWithin, type Block } from "./core/budget.js";
import { memoryHome, STATE_BUDGET } from "./core/memory.js";
import { isFinished, supervisorProjects, workerTask, type Task } from "./core/rollcall.js";
import { carryNudge, pickSweep, startSweep, sweepTargetFor } from "./core/sweep.js";
import { findRepoRoot, git, managedRoot } from "./core/repo.js";

/**
 * Harness hook entry points (Claude Code, and Codex via the same payload shape).
 * stdin carries the hook payload; stdout goes back to the harness as context.
 * Hooks are automation only: every one is best-effort and silent when it has nothing to say.
 *
 * Two independent triggers:
 * - the repo ran `docsic init` (docs/docsic.json exists): docs payload, Stop gate
 * - a hub is configured and the cwd maps to a hub project or the workspace: memory injection
 * The Stop hook also asks a session whose branch has work and no PR yet to take
 * waiting note sweep edits along, in either case.
 */
interface Payload { cwd?: string; session_id?: string; prompt?: string; transcript_path?: string; stop_hook_active?: boolean }

interface Marker { head: string; files: Record<string, number>; injected: string[] }

function sessionFile(name: string): string {
  const dir = join(managedRoot(), "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

const markerPath = (session: string) => sessionFile(`${session}.json`);

function readMarker(session: string): Marker | null {
  try { return JSON.parse(readFileSync(markerPath(session), "utf8")); } catch { return null; }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function hook(event: string, fallbackRoot: string): Promise<void> {
  if (process.env.DOCSIC_DISTILLER) return; // the distiller's own session must not re-trigger hooks
  const input = await new Promise<string>(res => { let s = ""; process.stdin.on("data", c => (s += c)); process.stdin.on("end", () => res(s)); process.stdin.resume(); });
  let p: Payload = {}; try { p = JSON.parse(input); } catch { /* empty */ }
  const cwd = p.cwd ?? fallbackRoot;
  const root = findRepoRoot(cwd);
  const session = p.session_id ?? "x";
  const initialized = existsSync(configPath(root));
  const hub = loadHub();
  const scope = hub ? resolveScope(cwd, hub) : null;
  if (!initialized && !scope) return;

  if (event === "session-start") return sessionStart(root, session, initialized, hub, scope);
  if (event === "prompt-submit") return promptSubmit(cwd, session, p.prompt ?? "", hub);
  if (event === "stop") return stop(cwd, root, session, initialized, p);
  if (event === "session-end") return sessionEnd(cwd, root, session, initialized, hub, scope, p.transcript_path);
}

const RECALL = `Cross-project recall ("have I solved X before, anywhere?"): \`docsic recall --hub <terms>\`.`;

/** The whole payload goes through fitPayload, in order of worth: anything over the limit never reaches the model. */
function sessionStart(root: string, session: string, initialized: boolean, hub: Hub | null, scope: ReturnType<typeof resolveScope>): void {
  const out: Block[] = [];
  const project = scope?.kind === "project" ? scope.project : null;
  const inHub = hub ? [{ text: RECALL }] : [];
  if (initialized) {
    const d = load(root);
    const home = memoryHome(root).dir;
    const inLoad = "the docsic_load tool";
    // Entry files for the worklog are history, one per PR; a long-lived repo has hundreds. docsic_load lists them.
    const docs = d.docs.filter(x => !x.path.startsWith("docs/worklog/"));
    out.push(
      { text: "[docsic] session context" },
      { text: d.instructions },
      ...inHub,
      { text: openNotesBlock(root, d.notes), more: join(home, "notes") },
      { text: d.state ? `## State\n${d.state.trim()}` : "## State\n(none yet - docsic_save state before you stop)", more: join(home, "state.md") },
      { text: d.findings.length ? `## docsic_check\n${d.findings.map(f => `- ${f.rule} ${f.file}: ${f.message}`).join("\n")}` : "", more: inLoad },
    );
    // State and notes above already come from the hub; add only its memory map.
    if (hub && project) out.push(...renderProject(hub, project, { state: false, notes: false }).blocks);
    out.push(
      { text: `## Docs\n${docs.map(x => `- ${x.path}${x.status && x.status !== "current" ? ` [${x.status}]` : ""}`).join("\n")}`, more: inLoad },
      { text: d.queue.length ? `## Queue\n${d.queue.slice(0, 10).map(q => `- #${q.id} ${q.title}`).join("\n")}` : "", more: inLoad },
    );
  } else if (hub && project) {
    out.push({ text: `[docsic] memory for **${project.slug}** (hub: ${projectDir(hub, project.slug)})` });
    const id = identity(hub, project);
    if (id) out.push({ text: `Identity: ${id}`, more: join(projectDir(hub, project.slug), "README.md") });
    out.push({ text: "If state.md is stale or missing in-flight facts, update it as you learn them." }, ...inHub, ...renderProject(hub, project).blocks);
    const wl = recentWorklog(project);
    if (wl.length) out.push({ text: `Recent worklog:\n${wl.join("\n")}`, more: join(project.repo!, "docs", "worklog") });
  } else if (hub) {
    const lines = workspaceSnapshot(hub);
    if (lines.length) out.push({ text: "When this session starts working on one of these projects, read its state.md first." });
    out.push(...inHub);
    if (lines.length) out.push({ text: `[docsic] project snapshot (full detail: ${hub.root}/projects/<slug>/state.md + notes/)\n${lines.join("\n")}`, more: join(hub.root, "projects") });
  }

  const marker: Marker = {
    head: initialized ? git(root, ["rev-parse", "HEAD"]) : "",
    files: hub ? snapshot(hub) : {},
    injected: project ? [project.slug] : [],
  };
  writeFileSync(markerPath(session), JSON.stringify(marker));
  const text = fitPayload(out);
  if (text) console.log(text);
}

/** Open notes with bodies for an initialized repo, highest-value first, within the notes budget. */
function openNotesBlock(root: string, notes: ReturnType<typeof load>["notes"]): string {
  if (!notes.length) return "";
  const fit = takeWithin(orderNotes(notes), NOTES_BUDGET, n => `- (${n.type}${n.pinned ? ", pinned" : ""}) ${n.title}: ${n.body}`);
  const more = moreNotesLine(fit.rest, join(memoryHome(root).dir, "notes"));
  return `## Open notes\n${[...fit.lines, ...(more ? [more] : [])].join("\n")}`;
}

/**
 * First mention of a hub project injects its memory; writes by parallel
 * sessions are injected as a delta. All of it shares one hook's limit. A
 * supervisor reads no repo, so it gets only the projects it has an open task in.
 */
function promptSubmit(cwd: string, session: string, prompt: string, hub: Hub | null): void {
  if (!hub) return;
  const m = readMarker(session) ?? { head: "", files: {}, injected: [] };
  const current = snapshot(hub);
  const mentioned = hub.projects.filter(p => !m.injected.includes(p.slug) && !hub.skipPromptMatch.includes(p.slug)
    && p.match.some(t => new RegExp(`\\b${esc(t)}\\b`, "i").test(prompt)));
  const changed = Object.keys(m.files).length ? Object.keys(current).filter(x => current[x] !== m.files[x]) : [];
  const tasked = mentioned.length || changed.length ? supervisorProjects(session, cwd, hub) : null;
  const groups: Block[][] = [];
  const shown = new Set<string>();
  for (const p of mentioned) {
    if (tasked && !tasked.has(p.slug)) continue;
    const r = renderProject(hub, p);
    if (!r.blocks.length) continue;
    m.injected.push(p.slug);
    groups.push([{ text: `[docsic] memory for **${p.slug}** (first mention this session):` }, ...r.blocks]);
    r.paths.forEach(x => shown.add(x));
  }
  const delta = changed.filter(x => !shown.has(x) && (!tasked || [...tasked].some(slug => x.startsWith(`${projectDir(hub, slug)}/`))));
  if (delta.length) groups.push([
    { text: "[docsic] project memory changed since this session last read it (another session or worktree):" },
    ...delta.map(x => ({ text: `--- ${basename(x)} (${x}) ---\n${readFileSync(x, "utf8").trim()}`, more: x })),
  ]);
  writeFileSync(markerPath(session), JSON.stringify({ ...m, files: current }));
  const text = fitGroups(groups);
  if (text) console.log(text);
}

/** Blocks once per session for each of: check errors in files the session touched, sweep edits that can ride this branch's coming PR. */
function stop(cwd: string, root: string, session: string, initialized: boolean, p: Payload): void {
  if (p.stop_hook_active) return; // never loop
  const reasons: string[] = [];
  const asked = (name: string) => sessionFile(`${name}-${session}`);
  const ask = (name: string, reason: string) => { writeFileSync(asked(name), ""); reasons.push(reason); };
  if (initialized && !existsSync(asked("gate"))) {
    // Gate only on files this session touched: pre-existing debt is surfaced at
    // session start, not blamed on a session that never went near it.
    const touched = changedSince(root, readMarker(session)?.head ?? "");
    const errors = runMechanicalChecks(root).filter(f => f.severity === "error" && touched.has(f.file));
    if (errors.length) ask("gate", `docsic_check has ${errors.length} error(s). Fix them or say why not:\n` + errors.slice(0, 15).map(e => `- ${e.rule} ${e.file}${e.line ? ":" + e.line : ""}: ${e.message}`).join("\n"));
  }
  const carry = existsSync(asked("carry")) ? null : carryNudge(cwd);
  if (carry) ask("carry", carry);
  if (reasons.length) console.log(JSON.stringify({ decision: "block", reason: reasons.join("\n\n") }));
}

/** Files changed since `base` (committed, staged, unstaged or untracked), relative to the repo root. */
function changedSince(root: string, base: string): Set<string> {
  const lines = [git(root, ["diff", "--name-only", base || "HEAD"]), git(root, ["ls-files", "--others", "--exclude-standard"])].join("\n");
  return new Set(lines.split("\n").filter(Boolean));
}

const MIN_TRANSCRIPT_BYTES = 30_000; // trivial sessions have nothing worth distilling
const LOCK_FRESH_MS = 10 * 60 * 1000;

/**
 * Hands off to a detached `docsic distill` so the session exits immediately,
 * then starts a detached note sweep when this project's open notes are due one.
 */
function sessionEnd(cwd: string, root: string, session: string, initialized: boolean, hub: Hub | null, scope: ReturnType<typeof resolveScope>, transcript?: string): void {
  const target: DistillTarget = scope?.kind === "project" && hub
    ? { kind: "hub-project", slug: scope.project.slug }
    : scope?.kind === "workspace" && !initialized ? { kind: "workspace" }
    : { kind: "repo", root };
  const cfg = readUserConfig();
  if (cfg.distill === "auto") capture({ target, transcript, session, cwd }, root, hub);
  if (cfg.sweep === "auto" || cfg.sweep === "pr" || cfg.sweep === "carry") {
    const sweep = target.kind === "workspace" ? (hub ? pickSweep(hub) : null) : sweepTargetFor(cwd);
    if (sweep) startSweep(sweep, Date.now(), { noMerge: cfg.sweep === "pr", carry: cfg.sweep === "carry" });
  }
}

/**
 * Memory is captured once per unit of work. A worker's task is one unit, however
 * many sessions it took (park, resume, handoff), so its capture waits for the
 * session that ends after the task finished, and reads the task's report, PR
 * and every transcript. A supervisor only routes tasks, so it has nothing of
 * its own to capture. Any other session is its own unit.
 */
function capture(job: DistillJob, root: string, hub: Hub | null): void {
  const { session, cwd } = job;
  const task = workerTask(session, cwd);
  if (task) {
    if (isFinished(task)) distillTask({ ...job, task }, root);
    return;
  }
  if (hub && supervisorProjects(session, cwd, hub)) return;
  distillSession(job, root);
}

function distillTask(job: DistillJob & { task: Task }, root: string): void {
  const { task } = job;
  const once = sessionFile(`distill-task-${task.home}-${task.id}`);
  if (existsSync(once) && readFileSync(once, "utf8") === String(task.stateAt)) return;
  writeFileSync(once, String(task.stateAt));
  startDistiller(job, root);
}

/** A resumed session is distilled again only once it has grown by what a new session would need. */
function distillSession(job: DistillJob, root: string): void {
  const { transcript, session } = job;
  if (!transcript || !existsSync(transcript)) return;
  const size = statSync(transcript).size;
  const seen = sessionFile(`distilled-${session}`);
  const before = existsSync(seen) ? Number(readFileSync(seen, "utf8")) : 0;
  if (size - before < MIN_TRANSCRIPT_BYTES) return;
  const lock = lockFor(job.target, root);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_FRESH_MS) return;
  writeFileSync(lock, session);
  writeFileSync(seen, String(size));
  startDistiller(job, root);
}

function lockFor(target: DistillTarget, root: string): string {
  const key = target.kind === "hub-project" ? target.slug : target.kind === "workspace" ? "workspace" : basename(root);
  return sessionFile(`distill-${key}.lock`);
}

function startDistiller(job: DistillJob, root: string): void {
  const log = openSync(sessionFile(`distill-${job.session.slice(0, 8)}.log`), "w");
  spawn(process.execPath, [process.argv[1], "distill", JSON.stringify({ ...job, lock: lockFor(job.target, root) })], {
    detached: true, stdio: ["ignore", log, log], env: { ...process.env, DOCSIC_DISTILLER: "1" },
  }).unref();
}

/** A finished task is captured only once, so it waits its turn where a plain session would skip. */
function waitForLock(lock: string, session: string): void {
  for (;;) {
    try { writeFileSync(lock, session, { flag: "wx" }); return; } catch { /* held */ }
    try {
      if (Date.now() - statSync(lock).mtimeMs >= LOCK_FRESH_MS) rmSync(lock, { force: true });
      else spawnSync("sleep", ["5"]);
    } catch { /* released between the two calls */ }
  }
}

export type DistillTarget = { kind: "repo"; root: string } | { kind: "hub-project"; slug: string } | { kind: "workspace" };
export interface DistillJob { target: DistillTarget; transcript?: string; session: string; cwd: string; task?: Task }

/**
 * The distiller: a headless agent reads what the session or task left behind
 * and rewrites state / files notes. Runs synchronously inside the detached
 * `docsic distill` process, scoped to the memory directory (its cwd), then
 * syncs the hub.
 */
export function distill(arg: string): void {
  const { target, transcript, session, task, lock } = JSON.parse(arg) as DistillJob & { lock: string };
  const hub = loadHub();
  let dir: string;
  let scopeText: string;
  if (target.kind === "repo") {
    dir = memoryHome(target.root).dir;
    scopeText = `Memory for the repo at ${target.root} lives in ${dir}/ (state.md, notes/).`;
  } else if (!hub) return;
  else if (target.kind === "hub-project") {
    dir = hub.root;
    scopeText = `This work ran in the ${target.slug} project. Its memory lives in ${projectDir(hub, target.slug)}/ (state.md, notes/).`;
  } else {
    dir = hub.root;
    scopeText = `This session ran from the workspace, not a single project. Projects (memory in ${hub.root}/projects/<slug>/):\n` +
      hub.projects.map(p => `- ${p.slug} (aliases: ${p.match.join(", ")})`).join("\n") +
      "\nDetermine from the transcript which of these (if any) the session worked on.";
  }
  if (task) waitForLock(lock, session);
  const ran = runAgent({ prompt: distillPrompt(transcript ?? "", session, scopeText, task), cwd: dir, timeoutMs: 15 * 60 * 1000, lean: true,
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash(jq:*)", "Bash(tail:*)", "Bash(head:*)", "Bash(grep:*)", "Bash(wc:*)"] });
  rmSync(lock, { force: true });
  if (!ran) return;
  if (hub && target.kind !== "repo") syncHub(hub, target.kind === "hub-project" ? target.slug : "workspace", task ? `${task.state} ${task.title}` : "distilled session");
  if (hub && target.kind === "repo") { const h = memoryHome(target.root); if (h.hub && h.slug) syncHub(h.hub, h.slug, task ? `${task.state} ${task.title}` : "distilled session"); }
}

/** Oldest first; a handoff or resume stays in the same worktree, so every session's transcript sits beside the last one. */
function taskTranscripts(task: Task, last: string): string[] {
  if (!last) return [];
  const all = task.sessions.map(s => join(dirname(last), `${s.id}.jsonl`)).filter(existsSync);
  return all.includes(last) ? all : [...all, last];
}

function prDescription(url: string | null): string {
  if (!url) return "";
  const r = spawnSync("gh", ["pr", "view", url, "--json", "title,body", "--jq", `.title + "\n\n" + .body`], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

function taskSource(task: Task, last: string): string {
  const pr = prDescription(task.pr);
  return `You are the docsic distiller. A task just finished (${task.state}): ${task.title}${task.pr ? `\nPR: ${task.pr}` : ""}

The report its agent wrote at the end:
<report>
${task.output?.text.trim() ?? "(none)"}
</report>
${pr ? `\nThe PR description:\n<pr>\n${pr}\n</pr>\n` : ""}
Its session transcripts (JSONL), oldest first:
${taskTranscripts(task, last).join("\n")}

Start from the report and the PR: they say what shipped. Then take from the transcripts what they leave out: the owner's decisions and the gotchas the agent hit (the transcripts may be large; do not read them whole - grep for user messages, decisions, errors, and sample the last ~200 lines of each). Other tasks run at the same time: keep what the old state.md says about them.`;
}

function sessionSource(transcript: string): string {
  return `You are the docsic distiller. A coding-agent session just ended; its transcript (JSONL) is at:
${transcript}

Extract the human-relevant story: pull user messages and key assistant conclusions with grep/jq/tail (the transcript may be large; do not read it whole - sample the start, focus on the last ~200 lines, grep for decisions, builds, PRs). If the session did no meaningful work, do NOTHING and stop.`;
}

export function distillPrompt(transcript: string, session: string, scopeText: string, task?: Task): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${task ? taskSource(task, transcript) : sessionSource(transcript)}

${scopeText}

Bash here runs only jq, tail, head, grep and wc: call each directly with absolute paths, with no cd and no shell variables.

For each project this work materially advanced:

1. REWRITE its state.md (create if missing): where things stand NOW, at most ${STATE_BUDGET} tokens (~40 lines). Read the old one first and keep its plain style. Format:
   _updated: ${today} (session ${session.slice(0, 8)})_
   ## Now       <- 1-3 bullets: current milestone, live versions, what just happened
   ## In flight <- pending reviews, unmerged PRs, items awaiting the user
   ## Next      <- 1-3 bullets: the agreed next steps
   Carry forward still-true facts from the old state.md; drop resolved ones. State replaces; it is not a log.

2. Only if the work produced durable discoveries, gotchas or decisions another agent would need weeks later, write AT MOST 2 notes to its notes/${today}-<kebab-title>.md:
   ---
   title: <short title>
   type: discovery | gotcha | decision | idea
   status: open
   created: ${today}
   ---
   <=10 lines: the fact, why it matters, links (paths, PR/issue URLs). Never routine progress.

Touch nothing except state.md and notes/. Do not commit; docsic syncs after you finish.`;
}

function identity(hub: Hub, p: HubProject): string | null {
  const readme = existsSync(join(projectDir(hub, p.slug), "README.md")) ? readFileSync(join(projectDir(hub, p.slug), "README.md"), "utf8") : "";
  const out: string[] = [];
  for (const line of readme.split("\n").slice(1)) {
    if (!line.trim() || line.startsWith("#")) { if (out.length) break; continue; }
    out.push(line);
  }
  return out.join("\n").trim() || null;
}

/**
 * The newest worklog entries. A repo keeps one entry file per PR under
 * docs/worklog/<YYYY-MM>/<date>-<branch>.json (parallel PRs never touch the
 * same file); an older repo also has the single docs/worklog.jsonl it used to
 * append to. Both are read, and file names sort by date.
 */
function recentWorklog(p: HubProject, n = 3): string[] {
  if (!p.repo) return [];
  const docs = join(p.repo, "docs");
  type Entry = { date: string; summary: string; pr?: number | string };
  const parse = (l: string): Entry | null => {
    try {
      const e = JSON.parse(l);
      return e && typeof e.date === "string" && typeof e.summary === "string" ? e : null;
    } catch { return null; } // one bad entry never hides the rest
  };
  const fromOld: Entry[] = [];
  const fromFiles: Entry[] = []; // newest first
  // Old single file first, so on a same-date tie the newer entry files sort after it.
  try { for (const l of readFileSync(join(docs, "worklog.jsonl"), "utf8").trim().split("\n").slice(-n)) { const e = parse(l); if (e) fromOld.push(e); } } catch { /* no single-file log */ }
  try {
    const dir = join(docs, "worklog");
    let found = 0;
    for (const month of readdirSync(dir).sort().reverse()) {
      if (found >= n) break;
      let names: string[];
      try { names = readdirSync(join(dir, month)); } catch { continue; } // a stray file beside the month dirs
      // Newest first; unreadable or malformed files do not count toward n.
      for (const f of names.filter(f => f.endsWith(".json")).sort().reverse()) {
        if (found >= n) break;
        let e: Entry | null = null;
        try { e = parse(readFileSync(join(dir, month, f), "utf8").trim()); } catch { /* unreadable entry */ }
        if (e) { fromFiles.push(e); found++; }
      }
    }
  } catch { /* no entry files */ }
  // Stable sort over oldest-to-newest input, so same-date ties keep source/name order.
  return [...fromOld, ...fromFiles.reverse()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-n)
    .map(e => `- ${e.date}: ${e.summary}${e.pr ? ` (${e.pr})` : ""}`);
}
