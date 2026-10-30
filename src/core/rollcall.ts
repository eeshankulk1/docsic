import { spawnSync } from "node:child_process";
import { resolveScope, type Hub } from "./hub.js";

/**
 * What rollcall, the optional coordinator for parallel agent sessions, knows
 * about a session. A supervisor session routes tasks; each task runs in worker
 * sessions, whose environment names it. Without rollcall every answer here is
 * null, and docsic treats the session as a plain one.
 */
export interface Task {
  home: string;
  id: string;
  title: string;
  state: string;
  stateAt: number;
  pr: string | null;
  output: { text: string } | null;
  sessions: { id: string }[];
}

const finished = (state: string) => state === "landed" || state === "closed";
export const isFinished = (t: Task) => finished(t.state);

function rollcall<T>(args: string[], session: string, cwd: string): T | null {
  const r = spawnSync("rollcall", args, { cwd, encoding: "utf8", timeout: 5_000, env: { ...process.env, ROLLCALL_SESSION: session } });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The task a worker session works on, or null in any other session. */
export function workerTask(session: string, cwd: string): Task | null {
  return process.env.ROLLCALL_TASK ? rollcall<Task>(["task", "show", "here", "--json"], session, cwd) : null;
}

/** The hub projects a supervisor session has an open task in, or null when the session is no supervisor. */
export function supervisorProjects(session: string, cwd: string, hub: Hub): Set<string> | null {
  if (process.env.ROLLCALL_TASK) return null;
  const s = rollcall<{ me: { home: string | null } | null; tasks: { repo: string; state: string }[] }>(["status", "--json"], session, cwd);
  if (!s?.me?.home) return null;
  const slugs = new Set<string>();
  for (const t of s.tasks) {
    const scope = finished(t.state) ? null : resolveScope(`/${t.repo}`, hub);
    if (scope?.kind === "project") slugs.add(scope.project.slug);
  }
  return slugs;
}
