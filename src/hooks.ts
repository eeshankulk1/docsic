import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runMechanicalChecks } from "./core/check.js";
import { configPath } from "./core/config.js";
import { loadHub, projectDir, readUserConfig, renderProject, resolveScope, snapshot, syncHub, workspaceSnapshot, type Hub, type HubProject } from "./core/hub.js";
import { load } from "./core/load.js";
import { memoryHome, STATE_BUDGET } from "./core/memory.js";
import { findRepoRoot, git, managedDir, managedRoot } from "./core/repo.js";

/**
 * Harness hook entry points (Claude Code, and Codex via the same payload shape).
 * stdin carries the hook payload; stdout goes back to the harness as context.
 * Hooks are automation only: every one is best-effort and silent when it has nothing to say.
 *
 * Two independent triggers:
 * - the repo ran `docsic init` (docs/docsic.json exists): docs payload, Stop gate
 * - a hub is configured and the cwd maps to a hub project or the workspace: memory injection
 */
interface Payload { cwd?: string; session_id?: string; prompt?: string; transcript_path?: string; stop_hook_active?: boolean }

interface Marker { head: string; files: Record<string, number>; injected: string[] }

function markerPath(session: string): string {
  const dir = join(managedRoot(), "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session}.json`);
}

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
  if (event === "prompt-submit") return promptSubmit(session, p.prompt ?? "", hub);
  if (event === "stop") return stop(root, session, initialized, p);
  if (event === "session-end") return sessionEnd(cwd, root, session, initialized, hub, scope, p.transcript_path);
}

function sessionStart(root: string, session: string, initialized: boolean, hub: Hub | null, scope: ReturnType<typeof resolveScope>): void {
  const out: string[] = [];
  const project = scope?.kind === "project" ? scope.project : null;
  if (initialized) {
    const d = load(root);
    out.push(
      "[docsic] session context",
      d.state ? `## State\n${d.state.trim()}` : "## State\n(none yet - docsic_save state before you stop)",
      d.notes.length ? `## Open notes\n${d.notes.map(n => `- (${n.type}) ${n.title}: ${n.body}`).join("\n")}` : "",
      `## Docs\n${d.docs.map(x => `- ${x.path}${x.status && x.status !== "current" ? ` [${x.status}]` : ""}`).join("\n")}`,
      d.queue.length ? `## Queue\n${d.queue.slice(0, 10).map(q => `- #${q.id} ${q.title}`).join("\n")}` : "",
      d.findings.length ? `## docsic_check\n${d.findings.map(f => `- ${f.rule} ${f.file}: ${f.message}`).join("\n")}` : "",
      d.instructions,
    );
    // State and notes above already come from the hub; add only its memory map.
    if (hub && project) out.push(...renderProject(hub, project, { state: false, notes: false }).blocks);
  } else if (hub && project) {
    out.push(`[docsic] memory for **${project.slug}** (hub: ${projectDir(hub, project.slug)})`);
    const id = identity(hub, project);
    if (id) out.push(`Identity: ${id}`);
    out.push(...renderProject(hub, project).blocks);
    const wl = recentWorklog(project);
    if (wl.length) out.push(`Recent worklog:\n${wl.join("\n")}`);
    out.push("If state.md is stale or missing in-flight facts, update it as you learn them.");
  } else if (hub) {
    const lines = workspaceSnapshot(hub);
    if (lines.length) out.push(`[docsic] project snapshot (full detail: ${hub.root}/projects/<slug>/state.md + notes/)\n${lines.join("\n")}`,
      "When this session starts working on one of these projects, read its state.md first.");
  }
  if (hub) out.push(`Cross-project recall ("have I solved X before, anywhere?"): \`docsic recall --hub <terms>\`.`);

  const marker: Marker = {
    head: initialized ? git(root, ["rev-parse", "HEAD"]) : "",
    files: hub ? snapshot(hub) : {},
    injected: project ? [project.slug] : [],
  };
  writeFileSync(markerPath(session), JSON.stringify(marker));
  const text = out.filter(Boolean).join("\n\n");
  if (text) console.log(text);
}

/** First mention of a hub project injects its memory; writes by parallel sessions are injected as a delta. */
function promptSubmit(session: string, prompt: string, hub: Hub | null): void {
  if (!hub) return;
  const m = readMarker(session) ?? { head: "", files: {}, injected: [] };
  const current = snapshot(hub);
  const out: string[] = [];
  const shown = new Set<string>();
  for (const p of hub.projects) {
    if (m.injected.includes(p.slug) || hub.skipPromptMatch.includes(p.slug)) continue;
    if (!p.match.some(t => new RegExp(`\\b${esc(t)}\\b`, "i").test(prompt))) continue;
    const r = renderProject(hub, p);
    if (!r.blocks.length) continue;
    m.injected.push(p.slug);
    out.push(`[docsic] memory for **${p.slug}** (first mention this session):`, ...r.blocks);
    r.paths.forEach(x => shown.add(x));
  }
  if (Object.keys(m.files).length) {
    const delta = Object.keys(current).filter(x => current[x] !== m.files[x] && !shown.has(x));
    if (delta.length) {
      out.push("[docsic] project memory changed since this session last read it (another session or worktree):");
      for (const x of delta.slice(0, 6)) out.push(`--- ${basename(x)} (${x}) ---\n${readFileSync(x, "utf8").slice(0, 4096).trim()}`);
    }
  }
  writeFileSync(markerPath(session), JSON.stringify({ ...m, files: current }));
  if (out.length) console.log(out.join("\n\n"));
}

function stop(root: string, session: string, initialized: boolean, p: Payload): void {
  if (!initialized || p.stop_hook_active) return; // never loop
  // Gate only on files this session touched: pre-existing debt is surfaced at
  // session start, not blamed on a session that never went near it.
  const touched = changedSince(root, readMarker(session)?.head ?? "");
  const errors = runMechanicalChecks(root).filter(f => f.severity === "error" && touched.has(f.file));
  if (!errors.length) return;
  const gate = join(managedDir(root), `gate-${session}`);
  if (existsSync(gate)) return; // one nudge per session
  writeFileSync(gate, "");
  console.log(JSON.stringify({ decision: "block", reason: `docsic_check has ${errors.length} error(s). Fix them or say why not:\n` + errors.slice(0, 15).map(e => `- ${e.rule} ${e.file}${e.line ? ":" + e.line : ""}: ${e.message}`).join("\n") }));
}

/** Files changed since `base` (committed, staged, unstaged or untracked), relative to the repo root. */
function changedSince(root: string, base: string): Set<string> {
  const lines = [git(root, ["diff", "--name-only", base || "HEAD"]), git(root, ["ls-files", "--others", "--exclude-standard"])].join("\n");
  return new Set(lines.split("\n").filter(Boolean));
}

const MIN_TRANSCRIPT_BYTES = 30_000; // trivial sessions have nothing worth distilling
const LOCK_FRESH_MS = 10 * 60 * 1000;

/** Hands off to a detached `docsic distill` so the session exits immediately. */
function sessionEnd(cwd: string, root: string, session: string, initialized: boolean, hub: Hub | null, scope: ReturnType<typeof resolveScope>, transcript?: string): void {
  if (readUserConfig().distill !== "auto") return;
  if (!transcript || !existsSync(transcript) || statSync(transcript).size < MIN_TRANSCRIPT_BYTES) return;
  const target: DistillTarget = scope?.kind === "project" && hub
    ? { kind: "hub-project", slug: scope.project.slug }
    : scope?.kind === "workspace" && !initialized ? { kind: "workspace" }
    : { kind: "repo", root };
  const key = target.kind === "hub-project" ? target.slug : target.kind === "workspace" ? "workspace" : basename(root);
  const lock = join(managedRoot(), "sessions", `distill-${key}.lock`);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_FRESH_MS) return;
  writeFileSync(lock, session);
  const log = openSync(join(managedRoot(), "sessions", `distill-${session.slice(0, 8)}.log`), "w");
  spawn(process.execPath, [process.argv[1], "distill", JSON.stringify({ target, transcript, session, cwd })], {
    detached: true, stdio: ["ignore", log, log], env: { ...process.env, DOCSIC_DISTILLER: "1" },
  }).unref();
}

export type DistillTarget = { kind: "repo"; root: string } | { kind: "hub-project"; slug: string } | { kind: "workspace" };

/**
 * The distiller: a headless agent reads the transcript and rewrites state /
 * files notes. Runs synchronously inside the detached `docsic distill` process,
 * scoped to the memory directory (its cwd), then syncs the hub.
 */
export function distill(arg: string): void {
  const { target, transcript, session } = JSON.parse(arg) as { target: DistillTarget; transcript: string; session: string };
  const hub = loadHub();
  let dir: string;
  let scopeText: string;
  if (target.kind === "repo") {
    dir = memoryHome(target.root).dir;
    scopeText = `Memory for the repo at ${target.root} lives in ${dir}/ (state.md, notes/).`;
  } else if (!hub) return;
  else if (target.kind === "hub-project") {
    dir = hub.root;
    scopeText = `This session ran in the ${target.slug} project. Its memory lives in ${projectDir(hub, target.slug)}/ (state.md, notes/).`;
  } else {
    dir = hub.root;
    scopeText = `This session ran from the workspace, not a single project. Projects (memory in ${hub.root}/projects/<slug>/):\n` +
      hub.projects.map(p => `- ${p.slug} (aliases: ${p.match.join(", ")})`).join("\n") +
      "\nDetermine from the transcript which of these (if any) the session worked on.";
  }
  const prompt = distillPrompt(transcript, session, scopeText);
  const agent = findAgent(prompt, dir);
  if (!agent) return;
  spawnSync(agent.bin, agent.args, { cwd: dir, stdio: "inherit", env: { ...process.env, DOCSIC_DISTILLER: "1" }, timeout: 15 * 60 * 1000 });
  if (hub && target.kind !== "repo") syncHub(hub, target.kind === "hub-project" ? target.slug : "workspace", "distilled session");
  if (hub && target.kind === "repo") { const h = memoryHome(target.root); if (h.hub && h.slug) syncHub(h.hub, h.slug, "distilled session"); }
}

function distillPrompt(transcript: string, session: string, scopeText: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the docsic distiller. A coding-agent session just ended; its transcript (JSONL) is at:
${transcript}

${scopeText}

Extract the human-relevant story: pull user messages and key assistant conclusions with grep/jq/tail (the transcript may be large; do not read it whole - sample the start, focus on the last ~200 lines, grep for decisions, builds, PRs). If the session did no meaningful work, do NOTHING and stop.

Otherwise, for each project the session materially advanced:

1. REWRITE its state.md (create if missing): where things stand NOW, at most ${STATE_BUDGET} tokens (~40 lines). Format:
   _updated: ${today} (session ${session.slice(0, 8)})_
   ## Now       <- 1-3 bullets: current milestone, live versions, what just happened
   ## In flight <- pending reviews, unmerged PRs, items awaiting the user
   ## Next      <- 1-3 bullets: the agreed next steps
   Carry forward still-true facts from the old state.md; drop resolved ones. State replaces; it is not a log.

2. Only if the session produced durable discoveries, gotchas or decisions another agent would need weeks later, write AT MOST 2 notes to its notes/${today}-<kebab-title>.md:
   ---
   title: <short title>
   type: discovery | gotcha | decision | idea
   status: open
   created: ${today}
   ---
   <=10 lines: the fact, why it matters, links (paths, PR/issue URLs). Never routine progress.

Touch nothing except state.md and notes/. Do not commit; docsic syncs after you finish.`;
}

function findOnPath(bin: string): string | null {
  for (const d of (process.env.PATH ?? "").split(":")) if (d && existsSync(join(d, bin))) return join(d, bin);
  return null;
}

/** Claude Code first, Codex CLI as fallback; both confined to the memory directory. */
function findAgent(prompt: string, dir: string): { bin: string; args: string[] } | null {
  const claude = findOnPath("claude");
  if (claude) return { bin: claude, args: ["-p", prompt, "--model", "sonnet", "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Grep", "Glob", "Write", "Edit", "Bash(jq:*)", "Bash(tail:*)", "Bash(head:*)", "Bash(grep:*)", "Bash(wc:*)"] };
  const codex = findOnPath("codex") ?? (existsSync("/Applications/ChatGPT.app/Contents/Resources/codex") ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null);
  if (codex) return { bin: codex, args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", dir, prompt] };
  return null;
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

function recentWorklog(p: HubProject, n = 3): string[] {
  const path = p.repo ? join(p.repo, "docs", "worklog.jsonl") : "";
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").trim().split("\n").slice(-n).map(l => {
      const e = JSON.parse(l);
      return `- ${e.date}: ${e.summary}${e.pr ? ` (${e.pr})` : ""}`;
    });
  } catch { return []; }
}
