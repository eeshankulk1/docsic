import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Harness = "claude-code" | "codex" | "cursor";
export interface HarnessReport { harness: Harness; registered: boolean; hooks: boolean; detail: string }

/** Absolute path to this package's CLI entry, so registrations survive `npx` caches moving. */
export function cliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cli.js");
}

function has(cmd: string): boolean {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
}

export function detect(): Harness[] {
  const out: Harness[] = [];
  const home = homedir();
  if (existsSync(join(home, ".claude")) || has("claude")) out.push("claude-code");
  if (existsSync(join(home, ".codex")) || has("codex")) out.push("codex");
  if (existsSync(join(home, ".cursor"))) out.push("cursor");
  return out;
}

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}
function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

const SERVER = { command: "node", args: [cliPath(), "serve"] };

export function register(h: Harness): HarnessReport {
  const home = homedir();
  if (h === "claude-code") {
    const p = join(home, ".claude.json");
    const j = readJson(p);
    j.mcpServers = { ...(j.mcpServers ?? {}), ctx: { type: "stdio", ...SERVER } };
    writeJson(p, j);
    const hooks = installClaudeHooks(join(home, ".claude", "settings.json"));
    return { harness: h, registered: true, hooks, detail: `~/.claude.json mcpServers.ctx; hooks in ~/.claude/settings.json` };
  }
  if (h === "codex") {
    const p = join(home, ".codex", "config.toml");
    let toml = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!/\[mcp_servers\.ctx\]/.test(toml)) {
      toml += `\n[mcp_servers.ctx]\ncommand = "node"\nargs = [${SERVER.args.map(a => JSON.stringify(a)).join(", ")}]\n`;
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, toml);
    }
    return { harness: h, registered: true, hooks: false, detail: "~/.codex/config.toml [mcp_servers.ctx]" };
  }
  const p = join(home, ".cursor", "mcp.json");
  const j = readJson(p);
  j.mcpServers = { ...(j.mcpServers ?? {}), ctx: SERVER };
  writeJson(p, j);
  return { harness: h, registered: true, hooks: false, detail: "~/.cursor/mcp.json mcpServers.ctx" };
}

/** SessionStart injects ctx load; Stop runs the repair gate once per session. Idempotent. */
function installClaudeHooks(settingsPath: string): boolean {
  const s = readJson(settingsPath);
  s.hooks = s.hooks ?? {};
  const cli = JSON.stringify(cliPath());
  const entries: [string, string][] = [
    ["SessionStart", `node ${cli} hook session-start`],
    ["Stop", `node ${cli} hook stop`],
  ];
  for (const [event, command] of entries) {
    const list: any[] = s.hooks[event] ?? [];
    const already = list.some(e => (e.hooks ?? []).some((h: any) => String(h.command).includes("ctx") && String(h.command).includes("hook")));
    if (!already) list.push({ hooks: [{ type: "command", command, timeout: 30 }] });
    s.hooks[event] = list;
  }
  writeJson(settingsPath, s);
  return true;
}
