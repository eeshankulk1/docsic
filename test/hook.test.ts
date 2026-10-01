import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

  it("bounds open notes in an initialized repo's session context", async () => {
    const root = realpathSync(tmpRepo()); // the hook resolves /var -> /private/var; the store is keyed by that path
    write(root, "docs/docsic.json", "{}");
    commit(root);
    const { addNote } = await import("../src/core/memory.js");
    for (let i = 0; i < 20; i++) addNote(root, { title: `note ${i}`, type: i === 7 ? "gotcha" : "idea", body: "line of detail ".repeat(12) });
    const out = hook(root, "session-start");
    const shown = out.split("\n").filter(l => l.startsWith("- (")).length;
    expect(out.split("\n").find(l => l.startsWith("- ("))).toContain("(gotcha) note 7");
    expect(shown).toBeLessThan(20);
    expect(out).toMatch(new RegExp(`\\+${20 - shown} more open notes in .*notes - triage them`));
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

  it("with a hub: recent worklog reads the entry files and the older single file", () => {
    const repos = mkdtempSync(join(tmpdir(), "docsic-repos-"));
    const hubRoot = join(repos, "brain");
    write(hubRoot, "projects/gamma/state.md", "## Now\n- gamma live\n## In flight\n## Next\n");
    const repo = join(repos, "gamma");
    const entry = (date: string, summary: string, pr: number) => JSON.stringify({ date, project: "gamma", summary, pr }) + "\n";
    write(repo, "docs/worklog.jsonl", entry("2026-08-01", "old one", 1) + entry("2026-09-30", "last line of the single file", 2));
    write(repo, "docs/worklog/2026-09/2026-09-29-fix-a.json", entry("2026-09-29", "september entry", 3));
    write(repo, "docs/worklog/2026-10/2026-10-01-feat-b.json", entry("2026-10-01", "first october entry", 4));
    write(repo, "docs/worklog/2026-10/2026-10-02-fix-c.json", entry("2026-10-02", "newest entry", 5));
    write(repo, "docs/worklog/2026-10/2026-10-02-broken.json", "{not json\n");
    writeFileSync(join(process.env.DOCSIC_HOME!, "config.json"), JSON.stringify({ hub: { root: hubRoot, reposRoot: repos, sync: "none" } }));

    const out = hook(repo, "session-start", "g");
    const recent = out.slice(out.indexOf("Recent worklog:"));
    expect(recent).toContain("- 2026-09-30: last line of the single file (2)\n- 2026-10-01: first october entry (4)\n- 2026-10-02: newest entry (5)");
    expect(out).not.toContain("old one");
    expect(out).not.toContain("september entry");

    // A repo with entry files only.
    const fresh = join(repos, "delta");
    write(hubRoot, "projects/delta/state.md", "## Now\n- delta new\n## In flight\n## Next\n");
    write(fresh, "docs/worklog/2026-10/2026-10-03-feat-d.json", entry("2026-10-03", "only entry", 9));
    expect(hook(fresh, "session-start", "d")).toContain("Recent worklog:\n- 2026-10-03: only entry (9)");

    // Same-day entries keep source then file-name order, and unusable newer files take no slot.
    const tied = join(repos, "epsilon");
    write(hubRoot, "projects/epsilon/state.md", "## Now\n- epsilon busy\n## In flight\n## Next\n");
    write(tied, "docs/worklog.jsonl", entry("2026-10-05", "single-file same day", 10));
    write(tied, "docs/worklog/2026-10/2026-10-05-a.json", entry("2026-10-05", "entry a", 11));
    write(tied, "docs/worklog/2026-10/2026-10-05-b.json", entry("2026-10-05", "entry b", 12));
    write(tied, "docs/worklog/2026-10/2026-10-06-x.json", "{not json\n");
    write(tied, "docs/worklog/2026-10/2026-10-06-y.json", "");
    write(tied, "docs/worklog/2026-10/2026-10-06-z.json", JSON.stringify({ date: "2026-10-06" }) + "\n");
    expect(hook(tied, "session-start", "e")).toContain("Recent worklog:\n- 2026-10-05: single-file same day (10)\n- 2026-10-05: entry a (11)\n- 2026-10-05: entry b (12)");
  });
});
