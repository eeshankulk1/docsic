import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath } from "../src/core/config.js";
import { commit, tmpRepo, write } from "./helpers.js";

const CLI = join(__dirname, "..", "src", "cli.ts");
const TSX = join(__dirname, "..", "node_modules", ".bin", "tsx");

function hook(root: string, event: string, session = "s1"): string {
  return execFileSync(TSX, [CLI, "hook", event], {
    input: JSON.stringify({ cwd: root, session_id: session }),
    encoding: "utf8",
    env: process.env,
  });
}

// A stale doc with a command-grade fact in prose: an error the gate would report.
const BAD = "---\nowns: [src/**]\nstatus: current\n---\n# Dev\nRun it on localhost:3000.\n";

describe("hooks", () => {
  it("stays silent in a repo that never ran docsic init, even with docs/", () => {
    const root = tmpRepo();
    write(root, "docs/local-dev.md", BAD);
    commit(root);
    expect(hook(root, "session-start")).toBe("");
    expect(hook(root, "stop")).toBe("");
  });

  it("stop gates only on docs the session touched", () => {
    const root = tmpRepo();
    write(root, "docs/docsic.json", "{}");
    write(root, "docs/old.md", BAD);
    commit(root);
    hook(root, "session-start");
    expect(hook(root, "stop")).toBe(""); // old.md's error predates the session

    write(root, "docs/new.md", BAD);
    const out = JSON.parse(hook(root, "stop"));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("docs/new.md");
    expect(out.reason).not.toContain("docs/old.md");
  });

  it("reads a pre-rename docs/ctx.json", () => {
    const root = tmpRepo();
    write(root, "docs/docsic.json", "{}");
    renameSync(join(root, "docs/docsic.json"), join(root, "docs/ctx.json"));
    expect(configPath(root)).toBe(join(root, "docs", "ctx.json"));
  });
});
