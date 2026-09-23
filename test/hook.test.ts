import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath } from "../src/core/config.js";
import { commit, tmpRepo, write } from "./helpers.js";

const CLI = join(__dirname, "..", "src", "cli.ts");
const TSX = join(__dirname, "..", "node_modules", ".bin", "tsx");

function hook(root: string, event: string, session = "s1", extra: object = {}): string {
  return execFileSync(TSX, [CLI, "hook", event], {
    input: JSON.stringify({ cwd: root, session_id: session, ...extra }),
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

  it("with a hub: injects project memory, the workspace snapshot, and first-mention memory", () => {
    const repos = mkdtempSync(join(tmpdir(), "docsic-repos-"));
    const hubRoot = join(repos, "brain");
    write(hubRoot, "projects/alpha/state.md", "## Now\n- alpha ships v2\n## In flight\n## Next\n");
    write(hubRoot, "projects/alpha/notes/2026-01-01-x.md", "---\ntitle: flaky cache\ntype: gotcha\nstatus: open\ncreated: 2026-01-01\n---\nbody\n");
    write(hubRoot, "projects/beta/state.md", "## Now\n- beta paused\n## In flight\n## Next\n");
    mkdirSync(join(repos, "alpha-wt-feature"), { recursive: true });
    const home = process.env.DOCSIC_HOME!;
    writeFileSync(join(home, "config.json"), JSON.stringify({ hub: { root: hubRoot, reposRoot: repos, sync: "none" } }));

    // A worktree dir maps to its project, no docsic init needed.
    const inProject = hook(join(repos, "alpha-wt-feature"), "session-start", "a");
    expect(inProject).toContain("memory for **alpha**");
    expect(inProject).toContain("alpha ships v2");
    expect(inProject).toContain("flaky cache");

    // The repos root is the workspace: one line per project.
    const ws = hook(repos, "session-start", "b");
    expect(ws).toContain("**alpha**: alpha ships v2");
    expect(ws).toContain("**beta**: beta paused");

    // First mention injects full memory once; a parallel write shows up as a delta.
    expect(hook(repos, "prompt-submit", "b", { prompt: "what's next on beta?" })).toContain("memory for **beta** (first mention");
    expect(hook(repos, "prompt-submit", "b", { prompt: "and beta again" })).toBe("");
    write(hubRoot, "projects/alpha/state.md", "## Now\n- alpha v3 cut\n## In flight\n## Next\n");
    expect(hook(repos, "prompt-submit", "b", { prompt: "unrelated" })).toContain("alpha v3 cut");
    expect(readFileSync(join(home, "sessions", "b.json"), "utf8")).toContain("beta");
  });
});
