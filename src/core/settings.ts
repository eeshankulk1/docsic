import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedDir } from "./repo.js";

/** Per-user adapter choices. Managed, never in the repo (spec §10). */
export interface Settings {
  tracker: "github" | "none";
  hub: "none" | string;
  harness: "claude-code" | "codex" | "cursor" | "mcp";
}

const DEFAULTS: Settings = { tracker: "github", hub: "none", harness: "mcp" };

export function readSettings(root: string): Settings {
  const p = join(managedDir(root), "settings.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { return { ...DEFAULTS }; }
}

export function writeSettings(root: string, s: Partial<Settings>): Settings {
  const merged = { ...readSettings(root), ...s };
  writeFileSync(join(managedDir(root), "settings.json"), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}
