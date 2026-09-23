import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { managedRoot } from "./repo.js";

/**
 * The hub: an optional git repo holding memory for many projects, one folder
 * each at <root>/projects/<slug>/ (state.md, notes/, decisions.md, README.md).
 * Configured per user in ~/.docsic/config.json; absent means memory stays in
 * the local store (~/.docsic/<repo-identity>/) and none of this runs.
 *
 * Every folder under projects/ is a project, so archiving one (moving it out)
 * stops its memory being injected. A repo maps to a project when a segment of
 * its path is the slug, an alias, or `<slug>-...` (worktrees like trvld-wt-feed).
 */
export interface HubConfig {
  root: string;
  /** Where the project repos live; lets the memory map list a repo's docs/. */
  reposRoot?: string;
  overrides?: Record<string, { repoDir?: string; aliases?: string[] }>;
  /** Slugs too common as English words to trigger prompt-mention injection. */
  skipPromptMatch?: string[];
  /** "git": commit + push memory changes to the hub's current branch. */
  sync?: "git" | "none";
}

export interface UserConfig {
  hub?: HubConfig;
  /** Session-end distiller: "auto" spawns a background agent that rewrites state and files notes. */
  distill?: "auto" | "off";
}

export interface HubProject { slug: string; match: string[]; repo: string | null }
export interface Hub { root: string; reposRoot: string | null; projects: HubProject[]; skipPromptMatch: string[]; sync: "git" | "none" }

export type Scope = { kind: "project"; project: HubProject } | { kind: "workspace" } | null;

export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

export function userConfigPath(): string {
  return join(managedRoot(), "config.json");
}

export function readUserConfig(): UserConfig {
  try { return JSON.parse(readFileSync(userConfigPath(), "utf8")); } catch { return {}; }
}

export function loadHub(cfg: UserConfig = readUserConfig()): Hub | null {
  const h = cfg.hub;
  if (!h?.root) return null;
  const root = resolve(expandHome(h.root));
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return null;
  const reposRoot = h.reposRoot ? resolve(expandHome(h.reposRoot)) : null;
  const projects: HubProject[] = [];
  for (const e of readdirSync(projectsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const o = h.overrides?.[e.name] ?? {};
    const repoDir = reposRoot ? join(reposRoot, o.repoDir ?? e.name) : null;
    projects.push({
      slug: e.name,
      match: [e.name, ...(o.aliases ?? [])].map(m => m.toLowerCase()),
      repo: repoDir && existsSync(repoDir) ? repoDir : null,
    });
  }
  return { root, reposRoot, projects, skipPromptMatch: h.skipPromptMatch ?? [], sync: h.sync ?? "git" };
}

/** A project directory, the workspace (hub itself or the repos root), or neither. */
export function resolveScope(cwd: string, hub: Hub): Scope {
  const lc = resolve(cwd).toLowerCase();
  if (lc === hub.root.toLowerCase() || lc.startsWith(hub.root.toLowerCase() + "/")) return { kind: "workspace" };
  const segs = lc.split("/");
  for (const p of hub.projects) {
    if (p.match.some(m => segs.some(s => s === m || s.startsWith(`${m}-`)))) return { kind: "project", project: p };
  }
  if (hub.reposRoot && lc === hub.reposRoot.toLowerCase()) return { kind: "workspace" };
  return null;
}

export function projectDir(hub: Hub, slug: string): string {
  return join(hub.root, "projects", slug);
}

function readIf(p: string, max = 8192): string | null {
  try { return existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : null; } catch { return null; }
}

export interface OpenNote { file: string; path: string; title: string; type: string }

export function openNotes(dir: string): OpenNote[] {
  const nd = join(dir, "notes");
  if (!existsSync(nd)) return [];
  const out: OpenNote[] = [];
  for (const f of readdirSync(nd).filter(f => f.endsWith(".md")).sort()) {
    const path = join(nd, f);
    const head = readIf(path, 2048) ?? "";
    if (!/^status:\s*open\s*$/m.test(head)) continue;
    out.push({
      file: f, path,
      title: (head.match(/^title:\s*(.+)$/m)?.[1] ?? f.replace(/\.md$/, "")).trim(),
      type: (head.match(/^type:\s*(.+)$/m)?.[1] ?? "note").trim(),
    });
  }
  return out;
}

export interface DecisionRow { line: number; date: string; decision: string; reasoning: string }

/** decisions.md rows are single physical lines: | Date | Decision | Reasoning | */
export function parseDecisionRows(raw: string | null): DecisionRow[] {
  if (!raw) return [];
  const rows: DecisionRow[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.startsWith("|")) return;
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 4) return;
    const [, date, decision] = cells;
    if (!date || /^:?-+:?$/.test(date) || /^date$/i.test(date)) return;
    rows.push({ line: i + 1, date, decision, reasoning: cells.slice(3, cells.length - 1).join(" | ") });
  });
  return rows;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);

/** Index of what is knowable about a project - never bodies; the agent reads sources on demand. */
function memoryMap(hub: Hub, p: HubProject): string[] {
  const dir = projectDir(hub, p.slug);
  const lines: string[] = [];
  const rows = parseDecisionRows(readIf(join(dir, "decisions.md"), 131072));
  if (rows.length) {
    lines.push(`decisions.md (${rows.length} rows; read the full row before changing what it governs):`);
    for (const r of rows) lines.push(`- ${r.date}: ${clip(r.decision, 140)}`);
  }
  const extras = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md") && !["README.md", "state.md", "decisions.md"].includes(f)) : [];
  if (extras.length) lines.push(`Other hub docs (${dir}/): ${extras.join(", ")}`);
  if (p.repo && existsSync(join(p.repo, "docs"))) {
    const docs = readdirSync(join(p.repo, "docs")).filter(f => f.endsWith(".md"));
    if (docs.length) lines.push(`Repo docs (${join(p.repo, "docs")}/): ${docs.join(", ")}`);
  }
  return lines;
}

/** State, memory map and open notes for one project. `paths` lets freshness tracking skip what was just shown. */
export function renderProject(hub: Hub, p: HubProject, opts: { state?: boolean; notes?: boolean } = {}): { blocks: string[]; paths: string[] } {
  const dir = projectDir(hub, p.slug);
  const blocks: string[] = [];
  const paths: string[] = [];
  const statePath = join(dir, "state.md");
  const state = opts.state === false ? null : readIf(statePath, 6144);
  if (state) { blocks.push(`--- state.md (current; rewritten each session end) ---\n${state.trim()}`); paths.push(statePath); }
  const map = memoryMap(hub, p);
  if (map.length) blocks.push(`--- memory map (index only; read sources on demand) ---\n${map.join("\n")}`);
  const notes = opts.notes === false ? [] : openNotes(dir);
  if (notes.length) {
    blocks.push(`Open notes (read with the path when relevant; mark absorbed when acted on):\n${notes.map(n => `- [${n.type}] ${n.title} -> ${n.path}`).join("\n")}`);
    paths.push(...notes.map(n => n.path));
  }
  return { blocks, paths };
}

/** The first line under ## Now, for the one-line-per-project workspace snapshot. */
export function stateHeadline(hub: Hub, slug: string): string | null {
  const s = readIf(join(projectDir(hub, slug), "state.md"), 2048);
  if (!s) return null;
  const lines = s.split("\n");
  const now = lines.findIndex(l => /^##\s*Now/i.test(l));
  const line = lines.slice(now >= 0 ? now + 1 : 0).find(l => l.trim() && !l.startsWith("#") && !l.trim().startsWith("_"));
  return line ? line.replace(/^[-*]\s*/, "").trim() : null;
}

export function workspaceSnapshot(hub: Hub): string[] {
  const out: string[] = [];
  for (const p of hub.projects) {
    const s = stateHeadline(hub, p.slug);
    const open = openNotes(projectDir(hub, p.slug)).length;
    if (!s && !open) continue;
    out.push(`- **${p.slug}**: ${s ?? "(no state.md)"}${open ? ` [${open} open note${open > 1 ? "s" : ""}]` : ""}`);
  }
  return out;
}

/** mtimes of every state.md and note, for detecting writes by parallel sessions. */
export function snapshot(hub: Hub): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const p of hub.projects) {
    const dir = projectDir(hub, p.slug);
    const state = join(dir, "state.md");
    if (existsSync(state)) snap[state] = statSync(state).mtimeMs;
    const nd = join(dir, "notes");
    if (existsSync(nd)) for (const f of readdirSync(nd).filter(f => f.endsWith(".md"))) snap[join(nd, f)] = statSync(join(nd, f)).mtimeMs;
  }
  return snap;
}

/**
 * Commit memory changes (state.md and notes/ only) and push, in the background.
 * Never stages anything else; a failed push leaves the commit local.
 */
export function syncHub(hub: Hub, slug: string, summary: string): void {
  if (hub.sync !== "git") return;
  const msg = `mem(${slug}): ${summary}`.slice(0, 120);
  const script = `git add -- 'projects/*/state.md' 'projects/*/notes' && (git diff --cached --quiet || git commit -q -m "$1") && git pull -q --rebase --autostash && git push -q`;
  spawn("sh", ["-c", script, "sh", msg], {
    cwd: hub.root, detached: true, stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).unref();
}
