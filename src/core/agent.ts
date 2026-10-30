import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The headless agent CLI that background jobs (the distiller, the note sweep)
 * hand their judgment to. The server never calls a model; these jobs run
 * outside it, in their own detached process.
 */
export interface AgentRun {
  prompt: string;
  cwd: string;
  addDirs?: string[];
  tools: string[];
  timeoutMs: number;
  /** The prompt carries all the job needs: skip the user's settings, instructions, plugins, MCP servers and skills. */
  lean?: boolean;
}

/** Claude Code flags for a lean run. `--bare` would go further, but it refuses subscription logins. */
function leanFlags(tools: string[]): string[] {
  return ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--tools", ...new Set(tools.map(t => t.replace(/\(.*$/, "")))];
}

function findOnPath(bin: string): string | null {
  for (const d of (process.env.PATH ?? "").split(":")) if (d && existsSync(join(d, bin))) return join(d, bin);
  return null;
}

/** Claude Code first, Codex CLI as fallback; both confined to `cwd` plus `addDirs`. */
export function findAgent(run: AgentRun): { bin: string; args: string[] } | null {
  const add = run.addDirs ?? [];
  const claude = findOnPath("claude");
  if (claude) return { bin: claude, args: ["-p", run.prompt, "--model", "sonnet", "--permission-mode", "acceptEdits",
    ...add.flatMap(d => ["--add-dir", d]), ...(run.lean ? leanFlags(run.tools) : []), "--allowedTools", ...run.tools] };
  const codex = findOnPath("codex") ?? (existsSync("/Applications/ChatGPT.app/Contents/Resources/codex") ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null);
  if (codex) return { bin: codex, args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", run.cwd,
    ...add.flatMap(d => ["--add-dir", d]), run.prompt] };
  return null;
}

/**
 * Runs the agent to completion. DOCSIC_DISTILLER keeps docsic's own hooks
 * (any installed version) quiet inside the agent's session. False when no
 * agent CLI is installed.
 */
export function runAgent(run: AgentRun): boolean {
  const agent = findAgent(run);
  if (!agent) return false;
  spawnSync(agent.bin, agent.args, { cwd: run.cwd, stdio: "inherit", env: { ...process.env, DOCSIC_DISTILLER: "1" }, timeout: run.timeoutMs });
  return true;
}
