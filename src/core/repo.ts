import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
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

function identityFor(key: string, slug: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `${slug || "repo"}-${hash}`;
}

function localIdentity(root: string): string {
  return identityFor(`local:${resolve(root)}`, root.split("/").pop() || "repo");
}

export function repoIdentity(root: string): string {
  const remote = git(root, ["remote", "get-url", "origin"]);
  if (!remote) return localIdentity(root);
  const key = normalizeRemote(remote);
  return identityFor(key, key.split("/").pop() || "repo");
}

export function managedRoot(): string {
  if (process.env.DOCSIC_HOME) return process.env.DOCSIC_HOME;
  const root = join(homedir(), ".docsic");
  // Pre-rename store (the package was called ctx): adopt it once.
  const legacy = join(homedir(), ".ctx");
  if (!existsSync(root) && existsSync(legacy)) renameSync(legacy, root);
  return root;
}

/** Resolves the store; when a remote appears after a path-keyed store was created, the store moves with it. */
export function managedDir(root: string): string {
  const dir = join(managedRoot(), repoIdentity(root));
  if (!existsSync(dir)) {
    const old = join(managedRoot(), localIdentity(root));
    if (old !== dir && existsSync(old)) renameSync(old, dir);
    else mkdirSync(join(dir, "notes"), { recursive: true });
  }
  return dir;
}

export function docsDir(root: string): string {
  return join(root, "docs");
}
