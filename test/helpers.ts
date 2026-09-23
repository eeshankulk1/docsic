import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "docsic-"));
  process.env.DOCSIC_HOME = mkdtempSync(join(tmpdir(), "docsichome-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  return root;
}

export function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

export function commit(root: string, msg = "c"): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", msg, "--allow-empty"], { cwd: root, stdio: "ignore" });
}
