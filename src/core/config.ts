import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docsDir } from "./repo.js";

export interface Stack { name: string; dir: string; runner?: string; testCommand?: string; buildCommand?: string }
export interface CtxConfig {
  updated: string;
  stacks: Stack[];
  devServer?: { command?: string; port?: number; baseUrl?: string };
  backend?: { baseUrl?: string; startCommand?: string; seedCommand?: string | null; resetCommand?: string | null };
  worker?: { startCommand?: string; broker?: string };
  lifecycle?: { startAll?: string; platform?: string };
  env?: Record<string, { file?: string; required?: string[]; optional?: string[] }>;
  models?: Record<string, string>;
  auth?: { bypassEnv?: string; notes?: string };
  routes?: { key?: string[]; skip?: string[] };
  notes?: string;
  [k: string]: unknown;
}

export function configPath(root: string): string {
  return join(docsDir(root), "ctx.json");
}

export function readConfig(root: string): CtxConfig | null {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function writeConfig(root: string, cfg: CtxConfig): void {
  cfg.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + "\n");
}
