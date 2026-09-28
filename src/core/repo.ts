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

/**
 * Like git(), but a real failure (bad pathspec, E2BIG from a huge argv, a corrupted
 * object) throws with git's stderr instead of silently collapsing to "" - callers
 * that would otherwise treat that "" as "nothing matched" and quietly proceed.
 */
export function gitOrThrow(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "").trim() : "";
    const detail = stderr || (e instanceof Error ? e.message : String(e));
    throw new Error(`git ${args.join(" ")}\n${detail}`);
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
