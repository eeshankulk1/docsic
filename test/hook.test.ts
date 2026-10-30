import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

  describe("no hook prints past Claude Code's 10,000 character line", () => {
    const LINE = 10_000;
    const big = (word: string, n: number) => Array.from({ length: n }, (_, i) => `- ${word} ${i} ${"x".repeat(60)}`).join("\n");

    /** A project with far more memory than fits: long state, decisions, many notes with one gotcha among them. */
    function overfull(hubRoot: string, slug: string): void {
      write(hubRoot, `projects/${slug}/README.md`, `# ${slug}\n\nWhat ${slug} is.\n`);
      write(hubRoot, `projects/${slug}/state.md`, `## Now\n${big(`${slug}-state`, 150)}\n## In flight\n## Next\n`);
      write(hubRoot, `projects/${slug}/decisions.md`, `| Date | Decision | Reasoning |\n|---|---|---|\n${Array.from({ length: 80 }, (_, i) => `| 2026-01-${String(i % 28 + 1).padStart(2, "0")} | decision ${i} ${"y".repeat(120)} | why |`).join("\n")}\n`);
      for (let i = 0; i < 12; i++) write(hubRoot, `projects/${slug}/notes/2026-01-${String(i + 1).padStart(2, "0")}-n.md`, `---\ntitle: ${i === 5 ? `${slug} gotcha` : `idea ${i}`}\ntype: ${i === 5 ? "gotcha" : "idea"}\nstatus: open\ncreated: 2026-01-${String(i + 1).padStart(2, "0")}\n---\nbody\n`);
    }

    function setup(): { repos: string; hubRoot: string } {
      const repos = realpathSync(mkdtempSync(join(tmpdir(), "docsic-repos-")));
      const hubRoot = join(repos, "brain");
      for (const slug of ["alpha", "beta", "gamma"]) overfull(hubRoot, slug);
      writeFileSync(join(process.env.DOCSIC_HOME!, "config.json"), JSON.stringify({ hub: { root: hubRoot, reposRoot: repos, sync: "none" } }));
      return { repos, hubRoot };
    }

    it("in a hub project: gotchas and state stay, the rest says where it went", () => {
      const { repos, hubRoot } = setup();
      mkdirSync(join(repos, "alpha"), { recursive: true });
      const out = hook(join(repos, "alpha"), "session-start", "h1");
      expect(out.length).toBeLessThanOrEqual(LINE);
      expect(out).toContain("[gotcha] alpha gotcha");
      expect(out).toContain("alpha-state 0");
      expect(out).toContain(`[cut to fit: the rest is in ${join(hubRoot, "projects/alpha")}`);
    });

    it("in an initialized repo: same, and worklog entry files stay out of the doc list", () => {
      const { repos } = setup();
      const repo = join(repos, "alpha");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: repo });
      write(repo, "docs/docsic.json", "{}");
      write(repo, "docs/architecture.md", "---\nowns: [src/**]\nstatus: current\n---\n# A\n");
      for (let i = 0; i < 300; i++) write(repo, `docs/worklog/2026-10/2026-10-01-pr-${i}.json`, "{}\n");
      const out = hook(repo, "session-start", "h2");
      expect(out.length).toBeLessThanOrEqual(LINE);
      expect(out).toContain("alpha gotcha");
      expect(out).toContain("alpha-state 0");
      expect(out).toContain("docs/architecture.md");
      expect(out).not.toContain("docs/worklog/");
    });

    it("at the first mention of several projects, with parallel writes on top", () => {
      const { repos, hubRoot } = setup();
      hook(repos, "session-start", "h3");
      for (let i = 0; i < 9; i++) write(hubRoot, `projects/gamma/notes/2026-02-0${i + 1}-new.md`, `---\ntitle: parallel ${i}\ntype: idea\nstatus: open\ncreated: 2026-02-0${i + 1}\n---\n${big("written", 80)}\n`);
      const out = hook(repos, "prompt-submit", "h3", { prompt: "compare alpha with beta" });
      expect(out.length).toBeLessThanOrEqual(LINE);
      expect(out).toContain("[gotcha] alpha gotcha");
      expect(out).toContain("[gotcha] beta gotcha");
      expect(out).toContain("beta-state 0");
      expect(out).toContain("project memory changed since");
    });

    it("in the workspace, with many projects", () => {
      const { repos, hubRoot } = setup();
      for (let i = 0; i < 300; i++) write(hubRoot, `projects/p${i}/state.md`, `## Now\n- ${"z".repeat(120)}\n## In flight\n## Next\n`);
      const out = hook(repos, "session-start", "h4");
      expect(out.length).toBeLessThanOrEqual(LINE);
      expect(out).toContain("**alpha**");
      expect(out).toContain("docsic recall --hub");
    });
  });

  it("with sweep auto: session end starts a sweep for a project whose notes are due", () => {
    const repos = mkdtempSync(join(tmpdir(), "docsic-repos-"));
    const hubRoot = join(repos, "brain");
    for (let i = 0; i < 3; i++) write(hubRoot, `projects/zeta/notes/2026-01-0${i + 1}-n.md`, `---\ntitle: n${i}\ntype: idea\nstatus: open\ncreated: 2026-01-0${i + 1}\n---\nx\n`);
    write(hubRoot, "projects/eta/notes/2026-01-01-n.md", "---\ntitle: n\ntype: idea\nstatus: open\ncreated: 2099-01-01\n---\nx\n");
    mkdirSync(join(repos, "zeta"), { recursive: true });
    mkdirSync(join(repos, "eta"), { recursive: true });
    const home = process.env.DOCSIC_HOME!;
    writeFileSync(join(home, "config.json"), JSON.stringify({ hub: { root: hubRoot, reposRoot: repos, sync: "none" }, sweep: "auto" }));
    hook(join(repos, "eta"), "session-end", "s-eta");
    expect(existsSync(join(home, "sweeps", "eta.json"))).toBe(false); // its one note is not due yet
    hook(join(repos, "zeta"), "session-end", "s-zeta");
    expect(JSON.parse(readFileSync(join(home, "sweeps", "zeta.json"), "utf8")).started).toMatch(/^\d{4}-/);
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
