import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function findRepoRoot(cwd: string = process.cwd()): string {
  const out = git(cwd, ["rev-parse", "--show-toplevel"]);
  return out || resolve(cwd);
}

/** ssh/https collapse, .git dropped, lowercased. Repos with no remote key by root-path hash. */
export function normalizeRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^git@([^:]+):/, "$1/");
  u = u.replace(/^ssh:\/\/(?:git@)?/, "").replace(/^https?:\/\//, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/, "");
  return u;
}

export function repoIdentity(root: string): string {
  const remote = git(root, ["remote", "get-url", "origin"]);
  const key = remote ? normalizeRemote(remote) : `local:${resolve(root)}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  const slug = (remote ? key.split("/").pop() : root.split("/").pop()) || "repo";
  return `${slug}-${hash}`;
}

export function managedRoot(): string {
  return process.env.CTX_HOME || join(homedir(), ".ctx");
}

export function managedDir(root: string): string {
  const dir = join(managedRoot(), repoIdentity(root));
  if (!existsSync(dir)) mkdirSync(join(dir, "notes"), { recursive: true });
  return dir;
}

export function docsDir(root: string): string {
  return join(root, "docs");
}
