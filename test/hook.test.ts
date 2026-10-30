import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgent } from "../src/core/agent.js";
import { configPath } from "../src/core/config.js";
import { distillPrompt } from "../src/hooks.js";
import type { Task } from "../src/core/rollcall.js";
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

  describe("with rollcall", () => {
    const saved = { PATH: process.env.PATH, ROLLCALL_TASK: process.env.ROLLCALL_TASK };
    afterEach(() => {
      process.env.PATH = saved.PATH;
      for (const k of ["ROLLCALL_TASK", "FAKE_ROLLCALL_STATUS", "FAKE_ROLLCALL_TASK"]) delete process.env[k];
      if (saved.ROLLCALL_TASK) process.env.ROLLCALL_TASK = saved.ROLLCALL_TASK;
    });

    /** Stand-ins first on PATH: rollcall answers from the environment, and any agent CLI does nothing. */
    function fakes(): void {
      const bin = mkdtempSync(join(tmpdir(), "docsic-bin-"));
      const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
      script("rollcall", `case "$1" in status) v="$FAKE_ROLLCALL_STATUS" ;; task) v="$FAKE_ROLLCALL_TASK" ;; esac\n[ -n "$v" ] || exit 1\necho "$v"`);
      script("claude", "exit 0");
      process.env.PATH = `${bin}:${process.env.PATH}`;
      delete process.env.ROLLCALL_TASK;
    }

    function world(cfg: object = {}): { repos: string; hubRoot: string; home: string; alpha: string } {
      tmpRepo(); // a fresh DOCSIC_HOME: the distiller's lock is per project
      const repos = realpathSync(mkdtempSync(join(tmpdir(), "docsic-repos-")));
      const hubRoot = join(repos, "brain");
      for (const slug of ["alpha", "beta"]) write(hubRoot, `projects/${slug}/state.md`, `## Now\n- ${slug} here\n## In flight\n## Next\n`);
      const alpha = join(repos, "alpha");
      mkdirSync(alpha, { recursive: true });
      const home = process.env.DOCSIC_HOME!;
      writeFileSync(join(home, "config.json"), JSON.stringify({ hub: { root: hubRoot, reposRoot: repos, sync: "none" }, ...cfg }));
      return { repos, hubRoot, home, alpha };
    }

    const task = (state: string, stateAt = 1): string => JSON.stringify({ home: "falcon", id: "t1", title: "a task", state, stateAt, pr: null, output: { text: "what shipped" }, sessions: [{ id: "w1" }] });

    it("a supervisor gets memory only for projects with an open task, by first mention or by delta", () => {
      fakes();
      const w = world();
      process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: "falcon" }, tasks: [{ repo: "alpha", state: "working" }, { repo: "beta", state: "landed" }] });
      hook(w.repos, "session-start", "sup");
      const first = hook(w.repos, "prompt-submit", "sup", { prompt: "how are alpha and beta?" });
      expect(first).toContain("memory for **alpha**");
      expect(first).not.toContain("memory for **beta**");

      write(w.hubRoot, "projects/alpha/state.md", "## Now\n- alpha moved\n## In flight\n## Next\n");
      write(w.hubRoot, "projects/beta/state.md", "## Now\n- beta moved\n## In flight\n## Next\n");
      const delta = hook(w.repos, "prompt-submit", "sup", { prompt: "anything new?" });
      expect(delta).toContain("alpha moved");
      expect(delta).not.toContain("beta moved");

      // Once a task opens there, its project is injected at the next mention.
      process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: "falcon" }, tasks: [{ repo: "beta", state: "working" }] });
      expect(hook(w.repos, "prompt-submit", "sup", { prompt: "and beta?" })).toContain("memory for **beta**");
    });

    it("any other session is untouched by rollcall", () => {
      fakes();
      const w = world();
      process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: null }, tasks: [] });
      hook(w.repos, "session-start", "plain");
      expect(hook(w.repos, "prompt-submit", "plain", { prompt: "alpha and beta" })).toContain("memory for **beta**");
    });

    describe("capture", () => {
      const end = (w: { alpha: string }, session: string, transcript: string) => hook(w.alpha, "session-end", session, { transcript_path: transcript });
      const started = (w: { home: string }, session: string) => existsSync(join(w.home, "sessions", `distill-${session.slice(0, 8)}.log`));
      const longLog = (w: { repos: string }, name = "t.jsonl") => { const f = join(w.repos, name); writeFileSync(f, "x".repeat(40_000)); return f; };

      it("a worker waits for its task to finish, then captures it once", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.ROLLCALL_TASK = "falcon:t1";
        const log = longLog(w);

        process.env.FAKE_ROLLCALL_TASK = task("working");
        end(w, "worker-a", log); // a park or a handoff
        expect(started(w, "worker-a")).toBe(false);

        process.env.FAKE_ROLLCALL_TASK = task("landed");
        end(w, "worker-b", log);
        expect(started(w, "worker-b")).toBe(true);
        end(w, "worker-c", log); // the same finish, seen by a resumed session
        expect(started(w, "worker-c")).toBe(false);

        process.env.FAKE_ROLLCALL_TASK = task("landed", 2); // reopened and landed again
        end(w, "worker-d", log);
        expect(started(w, "worker-d")).toBe(true);
      });

      it("a finished task is captured however short its last session", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.ROLLCALL_TASK = "falcon:t1";
        process.env.FAKE_ROLLCALL_TASK = task("closed");
        const short = join(w.repos, "short.jsonl");
        writeFileSync(short, "x");
        end(w, "worker-e", short);
        expect(started(w, "worker-e")).toBe(true);
      });

      it("a supervisor captures nothing", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: "falcon" }, tasks: [] });
        end(w, "sup-a", longLog(w));
        expect(started(w, "sup-a")).toBe(false);
      });

      it("a supervisor rollcall has already ended still captures nothing", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: "falcon" }, tasks: [{ repo: "alpha", state: "working" }] });
        hook(w.repos, "session-start", "sup-b");
        hook(w.repos, "prompt-submit", "sup-b", { prompt: "how is alpha?" });
        process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: null, tasks: [] }); // rollcall's session-end hook ran first
        end(w, "sup-b", longLog(w));
        expect(started(w, "sup-b")).toBe(false);
      });

      it("a supervisor resumed after rollcall ended it keeps its flag", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: { home: "falcon" }, tasks: [{ repo: "alpha", state: "working" }] });
        hook(w.repos, "session-start", "sup-c");
        hook(w.repos, "prompt-submit", "sup-c", { prompt: "how is alpha?" });
        process.env.FAKE_ROLLCALL_STATUS = JSON.stringify({ me: null, tasks: [] });
        hook(w.repos, "session-start", "sup-c"); // resume
        end(w, "sup-c", longLog(w));
        expect(started(w, "sup-c")).toBe(false);
      });

      it("a plain session captures at its end, and again only once it has grown", () => {
        fakes();
        const w = world({ distill: "auto" });
        const log = longLog(w);
        end(w, "plain-a", log);
        expect(started(w, "plain-a")).toBe(true);
        rmSync(join(w.home, "sessions", "distill-plain-a.log"));
        rmSync(join(w.home, "sessions", "distill-alpha.lock"));

        appendFileSync(log, "y".repeat(5_000)); // resumed for a moment
        end(w, "plain-a", log);
        expect(started(w, "plain-a")).toBe(false);

        appendFileSync(log, "y".repeat(30_000));
        end(w, "plain-a", log);
        expect(started(w, "plain-a")).toBe(true);
      });

      it("falls back to the plain session when rollcall cannot answer", () => {
        fakes();
        const w = world({ distill: "auto" });
        process.env.ROLLCALL_TASK = "falcon:t1"; // no FAKE_ROLLCALL_TASK: the command fails
        end(w, "orphan-a", longLog(w));
        expect(started(w, "orphan-a")).toBe(true);
      });

      it("the task prompt carries the report and every transcript, oldest first", () => {
        fakes();
        const dir = mkdtempSync(join(tmpdir(), "docsic-t-"));
        for (const s of ["w1", "w2"]) writeFileSync(join(dir, `${s}.jsonl`), "");
        const t: Task = { home: "falcon", id: "t1", title: "a task", state: "landed", stateAt: 1, pr: null, output: { text: "what shipped" }, sessions: [{ id: "w1" }, { id: "gone" }, { id: "w2" }] };
        const prompt = distillPrompt(join(dir, "w2.jsonl"), "abcdefgh", "scope text", t);
        expect(prompt).toContain("A task just finished (landed): a task");
        expect(prompt).toContain("<report>\nwhat shipped\n</report>");
        expect(prompt).toContain(`${join(dir, "w1.jsonl")}\n${join(dir, "w2.jsonl")}`);
        expect(prompt).not.toContain("gone.jsonl");
        expect(prompt).toContain("REWRITE its state.md");
        expect(distillPrompt("/t.jsonl", "abcdefgh", "scope")).toContain("A coding-agent session just ended");
      });

      it("the distiller launches lean, the sweep with the user's full setup", () => {
        fakes();
        const run = { prompt: "p", cwd: "/", tools: ["Read", "Bash(jq:*)", "Bash(tail:*)"], timeoutMs: 1 };
        const lean = findAgent({ ...run, lean: true })!.args;
        expect(lean).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
        expect(lean[lean.indexOf("--setting-sources") + 1]).toBe("");
        expect(lean.slice(lean.indexOf("--tools"), lean.indexOf("--allowedTools"))).toEqual(["--tools", "Read", "Bash"]);
        expect(lean).not.toContain("--bare"); // it refuses subscription logins
        expect(findAgent(run)!.args).not.toContain("--setting-sources");
      });
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
