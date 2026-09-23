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
    j.mcpServers = { ...(j.mcpServers ?? {}), docsic: { type: "stdio", ...SERVER } };
    delete j.mcpServers.ctx; // pre-rename registration
    writeJson(p, j);
    const hooks = installClaudeHooks(join(home, ".claude", "settings.json"));
    return { harness: h, registered: true, hooks, detail: `~/.claude.json mcpServers.docsic; hooks in ~/.claude/settings.json` };
  }
  if (h === "codex") {
    const p = join(home, ".codex", "config.toml");
    let toml = existsSync(p) ? readFileSync(p, "utf8") : "";
    const legacy = /\n?\[mcp_servers\.ctx\]\n(?:(?!\[)[^\n]*\n?)*/;
    if (legacy.test(toml)) { toml = toml.replace(legacy, "\n"); writeFileSync(p, toml); }
    if (!/\[mcp_servers\.docsic\]/.test(toml)) {
      toml += `\n[mcp_servers.docsic]\ncommand = "node"\nargs = [${SERVER.args.map(a => JSON.stringify(a)).join(", ")}]\n`;
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, toml);
    }
    return { harness: h, registered: true, hooks: false, detail: "~/.codex/config.toml [mcp_servers.docsic]" };
  }
  const p = join(home, ".cursor", "mcp.json");
  const j = readJson(p);
  j.mcpServers = { ...(j.mcpServers ?? {}), docsic: SERVER };
  delete j.mcpServers.ctx;
  writeJson(p, j);
  return { harness: h, registered: true, hooks: false, detail: "~/.cursor/mcp.json mcpServers.docsic" };
}

/**
 * SessionStart injects context; UserPromptSubmit injects hub memory on first mention;
 * Stop runs the repair gate once per session; SessionEnd hands the transcript to the
 * distiller (when enabled in ~/.docsic/config.json). Idempotent.
 */
function installClaudeHooks(settingsPath: string): boolean {
  const s = readJson(settingsPath);
  s.hooks = s.hooks ?? {};
  const cli = JSON.stringify(cliPath());
  const entries: [string, string][] = [
    ["SessionStart", `node ${cli} hook session-start`],
    ["UserPromptSubmit", `node ${cli} hook prompt-submit`],
    ["Stop", `node ${cli} hook stop`],
    ["SessionEnd", `node ${cli} hook session-end`],
  ];
  for (const [event, command] of entries) {
    // Drop pre-rename ctx hooks, then add ours unless something already runs `docsic ... hook`.
    const list: any[] = (s.hooks[event] ?? [])
      .map((e: any) => ({ ...e, hooks: (e.hooks ?? []).filter((h: any) => !/ctx\/dist\/cli\.js"? hook /.test(String(h.command))) }))
      .filter((e: any) => e.hooks.length);
    const already = list.some(e => e.hooks.some((h: any) => /docsic.* hook /.test(String(h.command))));
    if (!already) list.push({ hooks: [{ type: "command", command, timeout: 30 }] });
    s.hooks[event] = list;
  }
  writeJson(settingsPath, s);
  return true;
}
