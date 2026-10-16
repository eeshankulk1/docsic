import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recall } from "../src/core/recall.js";
import { applyCarry, carryNudge, PIN_LIMIT, startSweep, sweep, sweepDue, SWEEP_BUDGET, SWEEP_TIMING } from "../src/core/sweep.js";
import { commit, tmpRepo, write } from "./helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const note = (title: string, type: string, created: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ntype: ${type}\nstatus: open\ncreated: ${created}\n${extra}---\n\n${body}\n`;
const doc = (owns: string, text: string) => `---\nowns: [${owns}]\nstatus: current\n---\n\n${text}\n`;

// Stand-ins for the agent CLI and gh, first on PATH. The agent writes the
// decisions and edits the test hands it; gh records its calls, and its
// "merge" pushes the PR branch to origin's main; "pr view" prints FAKE_GH_VIEW, or finds no PR.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_AGENT_PLAN, "utf8"));
const args = process.argv.slice(2);
const work = args[args.indexOf("--add-dir") + 1];
const n = fs.readdirSync(work).filter(f => /^notes-\\d+\\.md$/.test(f)).length;
const files = [...fs.readFileSync(path.join(work, "notes-" + n + ".md"), "utf8").matchAll(/^### (.+)$/gm)].map(m => m[1]);
fs.writeFileSync(path.join(work, "prompt-" + n + ".txt"), args[1]);
fs.writeFileSync(path.join(work, "sweep-" + n + ".json"), JSON.stringify({ notes: plan.decisions.filter(d => files.includes(d.file) || d.file === "stray.md") }));
for (const e of plan.edits) fs.appendFileSync(path.isAbsolute(e.path) ? e.path : path.join(process.cwd(), e.path), e.append);
`;
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr create") echo "https://github.com/x/alpha/pull/7" ;;
  "pr checks") echo "[{\\"name\\":\\"Docs gate\\",\\"bucket\\":\\"\${FAKE_GH_CHECKS:-pass}\\"}]" ;;
  "pr merge") git push -q origin HEAD:main ;;
  "pr view") [ -n "$FAKE_GH_VIEW" ] && echo "$FAKE_GH_VIEW" || exit 1 ;;
esac
`;

interface World { repos: string; hub: string; notes: string; repo: string; origin: string; home: string; ghLog: string }

function world(opts: { init?: boolean } = {}): World {
  const repo0 = tmpRepo(); // sets DOCSIC_HOME
  const home = process.env.DOCSIC_HOME!;
  const repos = realpathSync(mkdtempSync(join(tmpdir(), "docsic-repos-")));
  const repo = join(repos, "alpha");
  renameSync(repo0, repo);
  git(repo, "checkout", "-q", "-B", "main");
  write(repo, "docs/architecture.md", doc("src/**", "# Alpha\n\n| Doc | Owns |\n|---|---|\n| [local-dev.md](local-dev.md) | dev |\n| [deploy.md](deploy.md) | deploy |"));
  write(repo, "docs/local-dev.md", doc("src/**", "# Local dev\n\nInstall, then run."));
  write(repo, "docs/deploy.md", doc("deploy/**", "# Deploy\n\nIt ships from main."));
  write(repo, "docs/worklog/2026-10/2026-10-01-feat-a.json", `{"date":"2026-10-01","project":"alpha","summary":"a","pr":1}\n`);
  write(repo, "CLAUDE.md", "# Alpha\n\n## Gotchas\n- one\n");
  write(repo, "src/app.ts", "export const x = 1;\n");
  if (opts.init !== false) write(repo, "docs/docsic.json", "{}\n"); // ran docsic init: the command-grade rules apply
  commit(repo, "init");
  const origin = mkdtempSync(join(tmpdir(), "docsic-origin-"));
  git(origin, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  const hub = join(repos, "brain");
  const notes = join(hub, "projects/alpha/notes");
  write(hub, "projects/alpha/state.md", "_updated: 2026-10-01_\n## Now\n- alpha v2 live\n## In flight\n## Next\n");
  write(hub, "projects/alpha/decisions.md", "| Date | Decision | Reasoning |\n|---|---|---|\n| 2026-09-01 | Old call | why |\n");
  const notesSpec: [string, string][] = [
    ["2026-09-01-redis.md", note("Redis first", "gotcha", "2026-09-01", "The worker needs redis running first.")],
    ["2026-09-02-cache.md", note("Cache layout", "discovery", "2026-09-02", "The cache is per user.")],
    ["2026-09-03-old.md", note("Old memcache idea", "idea", "2026-09-03", "Try memcache for the quokka feed.")],
    ["2026-09-04-auth.md", note("Auth double check", "gotcha", "2026-09-04", "Tokens are verified twice on purpose.")],
    ["2026-09-05-unclear.md", note("Something odd", "discovery", "2026-09-05", "Saw an odd log line once.")],
    ["2026-09-06-claude.md", note("Long gotcha", "gotcha", "2026-09-06", "A long one.")],
    ["2026-09-07-choice.md", note("Chose X", "decision", "2026-09-07", "We chose X over Y.")],
    ["2026-09-08-port.md", note("Deploy port", "gotcha", "2026-09-08", "It serves on a port.")],
    ["2026-08-01-legacy.md", "---\ntitle: Legacy\ntype: gotcha\nstatus: absorbed\ncreated: 2026-08-01\nabsorbed-into: docs/local-dev.md\n---\n\nOld.\n"],
  ];
  for (const [f, t] of notesSpec) write(notes, f, t);
  writeFileSync(join(home, "config.json"), JSON.stringify({ hub: { root: hub, reposRoot: repos, sync: "none" } }));

  const bin = mkdtempSync(join(tmpdir(), "docsic-bin-"));
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const ghLog = join(bin, "gh.log");
  process.env.FAKE_GH_LOG = ghLog;
  const plan = join(bin, "plan.json");
  writeFileSync(plan, JSON.stringify({
    decisions: [
      { file: "2026-09-01-redis.md", outcome: "absorb", into: "repo:docs/local-dev.md", reason: "local-dev.md owns worker setup" },
      { file: "2026-09-02-cache.md", outcome: "covered", into: "docs/architecture.md", reason: "architecture.md states it" },
      { file: "2026-09-03-old.md", outcome: "retire", reason: "memcache was dropped in #12" },
      { file: "2026-09-04-auth.md", outcome: "renew", evidence: "guards src/app.ts token checks", pin: true },
      { file: "2026-09-06-claude.md", outcome: "absorb", into: "repo:CLAUDE.md", reason: "every session needs it" },
      { file: "2026-09-07-choice.md", outcome: "absorb", into: "hub:decisions.md", reason: "a decision" },
      { file: "2026-09-08-port.md", outcome: "absorb", into: "repo:docs/deploy.md", reason: "deploy.md owns serving" },
      { file: "stray.md", outcome: "retire", reason: "not in the batch" },
    ],
    edits: [
      { path: "docs/local-dev.md", append: "\nStart redis before the worker.\n" },
      { path: "docs/deploy.md", append: "\nServe it on localhost:3000.\n" },
      { path: "CLAUDE.md", append: `- ${"x".repeat(400)}\n` },
      { path: "src/app.ts", append: "// the agent should not touch this\n" },
      { path: "docs/new.md", append: "a new doc\n" },
      { path: join(hub, "projects/alpha/decisions.md"), append: "| 2026-10-16 | Chose X | over Y |\n" },
    ],
  }));
  process.env.FAKE_AGENT_PLAN = plan;
  return { repos, hub, notes, repo, origin, home, ghLog };
}

const fm = (path: string) => readFileSync(path, "utf8");
const savedPath = process.env.PATH;
const quiet = { log: () => {} };
const alpha = { kind: "hub-project", slug: "alpha" } as const;
const pr9 = (state: string) => JSON.stringify({ number: 9, state, url: "https://github.com/x/alpha/pull/9" });
const CLI = join(__dirname, "..", "src", "cli.ts");
const TSX = join(__dirname, "..", "node_modules", ".bin", "tsx");

// Each sweep runs dozens of git commands; under a parallel run that can pass the 30s default.
describe("note sweep", { timeout: 120_000 }, () => {
  beforeEach(() => { SWEEP_TIMING.pollMs = 5; });
  afterEach(() => { process.env.PATH = savedPath; delete process.env.FAKE_GH_CHECKS; delete process.env.FAKE_GH_VIEW; });

  it("is due past the budget, or a week after the last sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsic-due-"));
    const now = Date.parse("2026-10-16T12:00:00Z");
    write(dir, "notes/2026-10-15-a.md", note("a", "idea", "2026-10-15", "x"));
    expect(sweepDue(dir, now).reason).toBeNull();
    for (let i = 0; i < SWEEP_BUDGET; i++) write(dir, `notes/2026-10-15-n${i}.md`, note(`n${i}`, "idea", "2026-10-15", "x"));
    expect(sweepDue(dir, now).reason).toBe(`${SWEEP_BUDGET + 1} open notes due, budget ${SWEEP_BUDGET}`);

    // Swept two days ago: not due, so not counted, whatever their number.
    const swept = mkdtempSync(join(tmpdir(), "docsic-due-"));
    for (let i = 0; i < 15; i++) write(swept, `notes/2026-09-01-n${i}.md`, note(`n${i}`, "idea", "2026-09-01", "x", "swept: 2026-10-14\n"));
    expect(sweepDue(swept, now).due).toHaveLength(0);
    expect(sweepDue(swept, now).reason).toBeNull();
    // A new note waits for the weekly clock; nine days later every note is due again.
    write(swept, "notes/2026-10-16-new.md", note("new", "gotcha", "2026-10-16", "x"));
    expect(sweepDue(swept, now).reason).toBeNull();
    expect(sweepDue(swept, now + 9 * 86_400_000).reason).toBe("16 open notes due, budget 10");

    const old = mkdtempSync(join(tmpdir(), "docsic-due-"));
    write(old, "notes/2026-10-01-a.md", note("a", "idea", "2026-10-01", "x"));
    expect(sweepDue(old, now).reason).toBe("open notes since 2026-10-01");
  });

  it("absorbs into docs through a merged PR, archives, renews, pins, and keeps what it could not place", async () => {
    const w = world();
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, quiet))!;

    expect(r.pr).toEqual({ number: 7, url: "https://github.com/x/alpha/pull/7", merged: true });
    expect(r.docs).toEqual(["docs/local-dev.md"]);
    const calls = fm(w.ghLog);
    expect(calls).toMatch(/^pr create --base main --head docs\/note-sweep-\S+ --title docs: note sweep \d{4}-\d{2}-\d{2} --body Docs-only\./m);
    expect(calls).toContain("| Redis first | `docs/local-dev.md` | local-dev.md owns worker setup |");
    expect(calls).toMatch(/^pr merge 7 --squash$/m);

    // What landed on main: the absorbed line and a worklog entry, nothing the guard rails reverted.
    expect(git(w.origin, "show", "main:docs/local-dev.md")).toContain("Start redis before the worker.");
    expect(git(w.origin, "show", "main:docs/deploy.md")).not.toContain("localhost");
    expect(git(w.origin, "show", "main:CLAUDE.md")).not.toContain("xxxx");
    expect(git(w.origin, "show", "main:src/app.ts")).toBe("export const x = 1;");
    expect(git(w.origin, "ls-tree", "-r", "--name-only", "main")).not.toContain("docs/new.md");
    const entry = git(w.origin, "ls-tree", "-r", "--name-only", "main").split("\n").find(f => f.includes("note-sweep"))!;
    expect(JSON.parse(git(w.origin, "show", `main:${entry}`))).toMatchObject({ project: "alpha", pr: 7 });
    expect(git(w.origin, "branch", "--list", "docs/*")).toBe(""); // the PR branch is deleted
    expect(git(w.repo, "worktree", "list").split("\n")).toHaveLength(1);

    // The open set: the renewed note (pinned) and the three it could not place.
    const open = readdirSync(w.notes).filter(f => f.endsWith(".md")).sort();
    expect(open).toEqual(["2026-09-04-auth.md", "2026-09-05-unclear.md", "2026-09-06-claude.md", "2026-09-08-port.md"]);
    expect(fm(join(w.notes, "2026-09-04-auth.md"))).toMatch(/renewed: \d{4}-.*\nevidence: guards src\/app.ts token checks\npinned: true/s);
    expect(fm(join(w.notes, "2026-09-05-unclear.md"))).toMatch(/^swept: \d{4}-\d{2}-\d{2}$/m);
    expect(r.notes.find(n => n.file === "2026-09-06-claude.md")!.why).toMatch(/a line added to CLAUDE.md is 402 characters/);
    expect(r.notes.find(n => n.file === "2026-09-08-port.md")!.why).toMatch(/gained a docsic check error \(command-grade-misplaced\)/);

    // Everything else is in the archive, with where it went and why.
    const archive = join(w.notes, "archive");
    expect(readdirSync(archive).sort()).toEqual(["2026-08-01-legacy.md", "2026-09-01-redis.md", "2026-09-02-cache.md", "2026-09-03-old.md", "2026-09-07-choice.md"]);
    expect(fm(join(archive, "2026-09-01-redis.md"))).toContain('into: "docs/local-dev.md (PR #7)"');
    expect(fm(join(archive, "2026-09-03-old.md"))).toMatch(/status: archived\ncreated: 2026-09-03\noutcome: retired\narchived: .*\nreason: "memcache was dropped in #12"/);
    expect(fm(join(archive, "2026-09-07-choice.md"))).toContain("into: decisions.md (hub)");
    expect(fm(join(archive, "2026-08-01-legacy.md"))).toContain("into: docs/local-dev.md");
    expect(fm(join(w.hub, "projects/alpha/decisions.md"))).toContain("| 2026-10-16 | Chose X | over Y |");

    expect(r.counts).toEqual({ absorbed: 2, covered: 1, retired: 1, renewed: 1, open: 3 });
    const state = fm(join(w.hub, "projects/alpha/state.md"));
    expect(state).toMatch(/## Now\n- Note sweep \d{4}-\d{2}-\d{2}: 8 -> 4 open notes \(2 absorbed, 1 covered, 1 retired, 1 renewed, 3 left open\); docs PR #7 merged\. Swept notes are in notes\/archive\/; docsic recall finds them\.\n- alpha v2 live/);

    const prompt = fm(join(w.home, "sweeps/alpha/prompt-1.txt"));
    expect(prompt).toContain("docs/architecture.md indexes every doc");
    expect(prompt).toContain(join(w.hub, "projects/alpha/decisions.md"));
    expect(prompt).toContain(`at most ${PIN_LIMIT} pinned`);

    // Recall still finds a retired note, labelled as history.
    const hit = recall(w.repo, "quokka memcache").find(h => h.source.includes("2026-09-03-old.md"))!;
    expect(hit.source).toContain("retired - memcache was dropped in #12");

    // A second sweep straight after finds nothing due.
    expect(await sweep({ kind: "hub-project", slug: "alpha" }, { ...quiet, auto: true })).toBeNull();
  });

  it("closes the PR when its checks fail and leaves the absorbed notes open", async () => {
    const w = world();
    process.env.FAKE_GH_CHECKS = "fail";
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, quiet))!;
    expect(r.pr).toMatchObject({ number: 7, merged: false });
    expect(fm(w.ghLog)).toMatch(/^pr close 7 --comment The note sweep closed this: its checks failed\./m);
    expect(git(w.origin, "show", "main:docs/local-dev.md")).not.toContain("redis");
    expect(fm(join(w.notes, "2026-09-01-redis.md"))).toMatch(/status: open[\s\S]*swept: /);
    expect(existsSync(join(w.notes, "archive/2026-09-03-old.md"))).toBe(true);
    expect(fm(join(w.hub, "projects/alpha/state.md"))).toContain("docs PR #7 not merged, its notes stay open");
  });

  it("no-merge: opens the docs PR and stops, its notes stay open for review", async () => {
    const w = world();
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, { ...quiet, noMerge: true }))!;
    expect(r.pr).toEqual({ number: 7, url: "https://github.com/x/alpha/pull/7", merged: false });
    const calls = fm(w.ghLog);
    expect(calls).toContain("It leaves this PR for review rather than merging it.");
    expect(calls).not.toMatch(/^pr (checks|merge|close)/m);
    expect(git(w.origin, "branch", "--list", "docs/*")).toMatch(/docs\/note-sweep-/); // left for the reviewer
    expect(git(w.origin, "show", "main:docs/local-dev.md")).not.toContain("redis");
    expect(fm(join(w.notes, "2026-09-01-redis.md"))).toMatch(/status: open[\s\S]*swept: /);
    expect(r.notes.find(n => n.file === "2026-09-01-redis.md")!.why).toBe("written into docs/local-dev.md, in docs PR #7 awaiting review");
    expect(existsSync(join(w.notes, "archive/2026-09-02-cache.md"))).toBe(true);
    expect(fm(join(w.hub, "projects/alpha/state.md"))).toContain("docs PR #7 awaits review, its notes stay open until a sweep finds them covered");
  });

  it("a repo that never ran docsic init keeps a doc edit that quotes a port", async () => {
    world({ init: false });
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, { ...quiet, dryRun: true }))!;
    expect(r.docs).toEqual(["docs/deploy.md", "docs/local-dev.md"]);
  });

  it("reverts a doc edit no absorbed note names, and keeps the named one", async () => {
    world({ init: false });
    const plan = process.env.FAKE_AGENT_PLAN!;
    const p = JSON.parse(readFileSync(plan, "utf8"));
    p.decisions = p.decisions.filter((d: { file: string }) => d.file !== "2026-09-08-port.md"); // nothing names docs/deploy.md
    p.decisions.find((d: { file: string }) => d.file === "2026-09-01-redis.md").into = "repo:./docs/local-dev.md#setup";
    writeFileSync(plan, JSON.stringify(p));
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, { ...quiet, dryRun: true }))!;
    expect(r.docs).toEqual(["docs/local-dev.md"]);
    expect(r.notes.find(n => n.file === "2026-09-01-redis.md")!.result).toBe("absorbed");
  });

  it("dry run: judges and writes, then reports and undoes", async () => {
    const w = world();
    const r = (await sweep({ kind: "hub-project", slug: "alpha" }, { ...quiet, dryRun: true }))!;
    expect(r.dryRun).toBe(true);
    expect(r.counts.absorbed).toBe(2);
    expect(existsSync(w.ghLog)).toBe(false);
    expect(readdirSync(w.notes)).not.toContain("archive");
    expect(fm(join(w.notes, "2026-09-05-unclear.md"))).not.toContain("swept:");
    expect(fm(join(w.notes, "2026-08-01-legacy.md"))).toContain("status: absorbed");
    expect(fm(join(w.hub, "projects/alpha/decisions.md"))).not.toContain("Chose X");
    expect(fm(join(w.home, "sweeps/alpha/hub-decisions.md"))).toContain("Chose X");
    expect(fm(join(w.home, "sweeps/alpha/docs.patch"))).toContain("+Start redis before the worker.");
    expect(fm(join(w.hub, "projects/alpha/state.md"))).not.toContain("Note sweep");
    expect(git(w.repo, "branch", "--list", "docs/*")).toBe("");
  });

  it("carry: stages the docs edits, a branch with an open PR takes them, and its notes archive once they reach main", async () => {
    const w = world();
    const carryFile = join(w.home, "sweeps/alpha.carry.json");
    const r = (await sweep(alpha, { ...quiet, carry: true }))!;
    expect(r.pr).toBeNull();
    expect(existsSync(w.ghLog) ? fm(w.ghLog) : "").not.toMatch(/^pr create/m);
    const [carry] = JSON.parse(fm(carryFile)).carries;
    expect(carry.files).toEqual(["docs/local-dev.md"]);
    expect(carry.patch).toContain("+Start redis before the worker.");
    expect(fm(join(w.notes, "2026-09-01-redis.md"))).toContain("status: open");
    expect(r.notes.find(n => n.file === "2026-09-01-redis.md")!.why).toBe("written into docs/local-dev.md, waiting to ride the next PR");
    expect(existsSync(join(w.notes, "archive/2026-09-03-old.md"))).toBe(true); // the other outcomes apply at once
    expect(fm(join(w.hub, "projects/alpha/state.md"))).toContain("the docs edits for 1 of them wait to ride the next PR");
    expect(fm(join(w.home, "sweeps/alpha/prompt-1.txt"))).toContain("carries the rest into the repo's next PR");

    // While no PR has them, no new sweep starts.
    expect(await sweep(alpha, { ...quiet, carry: true, all: true })).toBeNull();

    // Not asked on main, nor on a branch with no open PR; the Stop hook asks a branch with one, once per session.
    expect(carryNudge(w.repo)).toBeNull();
    git(w.repo, "checkout", "-q", "-b", "feat/x");
    expect(carryNudge(w.repo)).toBeNull();
    process.env.FAKE_GH_VIEW = pr9("OPEN");
    expect(carryNudge(w.repo)).toMatch(/absorbed 1 note into docs\/local-dev\.md.*PR #9 on this branch\. Run `docsic sweep apply`/);
    const stop = () => execFileSync(TSX, [CLI, "hook", "stop"], { input: JSON.stringify({ cwd: w.repo, session_id: "s1" }), encoding: "utf8", env: process.env });
    expect(JSON.parse(stop())).toMatchObject({ decision: "block", reason: expect.stringContaining("docsic sweep apply") });
    expect(stop()).toBe("");

    expect(applyCarry(w.repo).message).toMatch(/wrote the sweep edits for 1 note into docs\/local-dev\.md\. Commit and push them to PR #9/);
    expect(fm(join(w.repo, "docs/local-dev.md"))).toContain("Start redis before the worker.");
    expect(carryNudge(w.repo)).toBeNull();

    // Riding an open PR, the edits block no sweep: their note is not judged again and their doc is left alone.
    const r2 = (await sweep(alpha, { ...quiet, carry: true, all: true }))!;
    expect(r2.notes.map(n => n.file)).not.toContain("2026-09-01-redis.md");
    expect(fm(join(w.home, "sweeps/alpha/prompt-1.txt"))).toContain("Not docs/local-dev.md: earlier sweep edits to it wait in an open PR");
    expect(JSON.parse(fm(carryFile)).carries).toHaveLength(1);

    commit(w.repo, "feat x");
    git(w.repo, "push", "-q", "origin", "feat/x:main"); // the PR merges
    process.env.FAKE_GH_VIEW = pr9("MERGED");
    await sweep(alpha, { ...quiet, carry: true });
    expect(fm(join(w.notes, "archive/2026-09-01-redis.md"))).toMatch(/outcome: absorbed[\s\S]*into: "docs\/local-dev\.md \(PR #9\)"/);
    expect(existsSync(carryFile)).toBe(false);
    expect(fm(join(w.hub, "projects/alpha/state.md"))).toMatch(/^- Note sweep \S+: 1 note carried with PR #9 landed; 4 open notes\./m);
  });

  it("carry: edits no PR picks up in a week go out as a docs-only PR, merged on green", async () => {
    const w = world();
    const carryFile = join(w.home, "sweeps/alpha.carry.json");
    await sweep(alpha, { ...quiet, carry: true });
    const j = JSON.parse(fm(carryFile));
    j.carries[0].date = "2026-01-01";
    writeFileSync(carryFile, JSON.stringify(j));
    const r = (await sweep(alpha, { ...quiet, carry: true, all: true }))!;
    expect(r.pr).toMatchObject({ number: 7, merged: true });
    expect(git(w.origin, "show", "main:docs/local-dev.md")).toContain("Start redis before the worker.");
    expect(fm(join(w.notes, "archive/2026-09-01-redis.md"))).toContain('into: "docs/local-dev.md (PR #7)"');
    expect(existsSync(carryFile)).toBe(false);
  });

  it("carry: dropped when it no longer applies, or when the PR that carried it closes without it", async () => {
    const w = world();
    const carryFile = join(w.home, "sweeps/alpha.carry.json");
    await sweep(alpha, { ...quiet, carry: true });
    git(w.repo, "checkout", "-q", "-b", "feat/y");
    write(w.repo, "docs/local-dev.md", doc("src/**", "# Local dev\n\nRewritten."));
    expect(applyCarry(w.repo).message).toContain("no longer apply here");
    expect(existsSync(carryFile)).toBe(false);
    expect(fm(join(w.notes, "2026-09-01-redis.md"))).toContain("status: open");

    git(w.repo, "checkout", "-q", "--", "docs/local-dev.md");
    await sweep(alpha, { ...quiet, carry: true, all: true }); // judges it again and stages fresh edits
    process.env.FAKE_GH_VIEW = pr9("OPEN");
    applyCarry(w.repo);
    process.env.FAKE_GH_VIEW = pr9("CLOSED");
    const lines: string[] = [];
    await sweep(alpha, { log: l => lines.push(l), carry: true });
    expect(lines).toContain("sweep: dropped the edits carried for 1 note (PR #9 closed without them); they are judged again");
    expect(fm(join(w.notes, "2026-09-01-redis.md"))).toContain("status: open");
    expect(existsSync(carryFile)).toBe(false);
  });

  it("the session-end hook starts a sweep when one is due, once per retry window", () => {
    const w = world();
    const now = Date.now();
    expect(startSweep({ kind: "hub-project", slug: "alpha" }, now)).toBe(true);
    expect(JSON.parse(fm(join(w.home, "sweeps/alpha.json"))).started).toBe(new Date(now).toISOString());
    expect(startSweep({ kind: "hub-project", slug: "alpha" }, now + 60_000)).toBe(false);
    expect(startSweep({ kind: "hub-project", slug: "alpha" }, now + SWEEP_TIMING.retryMs + 1)).toBe(true);
  });
});

describe("docsic sweep arguments", () => {
  const run = (...a: string[]) => {
    try { return { code: 0, out: execFileSync(TSX, [CLI, ...a], { cwd: mkdtempSync(join(tmpdir(), "docsic-args-")), encoding: "utf8", stdio: "pipe", env: { ...process.env, DOCSIC_HOME: mkdtempSync(join(tmpdir(), "docsic-home-")) } }) }; }
    catch (e: any) { return { code: e.status as number, out: `${e.stdout}${e.stderr}` }; }
  };

  it("prints help for --help and -h instead of sweeping", () => {
    for (const h of ["--help", "-h"]) {
      const r = run("sweep", h);
      expect(r.code).toBe(0);
      expect(r.out).toContain("docsic sweep apply");
      expect(r.out).not.toMatch(/judging|nothing to sweep|open notes/);
    }
  });

  it("refuses an argument it does not know, and sweeps nothing", () => {
    const r = run("sweep", "--project", "alpha", "--dryrun");
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown argument --dryrun; nothing swept");
    expect(run("sweep", "stray").out).toContain("unknown argument stray");
    for (const a of [["--project"], ["--project", "--dry-run"]]) expect(run("sweep", ...a).code).toBe(2);
  });
});
