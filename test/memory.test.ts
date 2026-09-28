import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_SYNC_SCRIPT } from "../src/core/hub.js";
import { absorbNote, addNote, listNotes, readState, writeState } from "../src/core/memory.js";
import { normalizeRemote } from "../src/core/repo.js";
import { commit, tmpRepo, write } from "./helpers.js";

describe("state", () => {
  it("round-trips within budget and rejects over budget", () => {
    const root = tmpRepo();
    writeState(root, "## Now\nx\n## In flight\ny\n## Next\nz\n");
    expect(readState(root)).toContain("## Now");
    expect(() => writeState(root, "## Now\n## In flight\n## Next\n" + "word ".repeat(1000))).toThrow(/budget/);
    expect(() => writeState(root, "## Now\nonly")).toThrow(/In flight/);
  });
});

describe("notes", () => {
  it("adds, lists, absorbs, caps body length", () => {
    const root = tmpRepo();
    const f = addNote(root, { title: "Redis gotcha", type: "gotcha", body: "worker needs redis" });
    expect(listNotes(root)[0].data.status).toBe("open");
    absorbNote(root, f, "docs/local-dev.md");
    expect(listNotes(root)[0].data.status).toBe("absorbed");
    expect(() => addNote(root, { title: "long", type: "idea", body: Array(12).fill("l").join("\n") })).toThrow(/max 10/);
  });
});

describe("repo identity", () => {
  it("collapses ssh/https/.git", () => {
    const a = normalizeRemote("git@github.com:Eesh/Ctx.git");
    expect(normalizeRemote("https://github.com/eesh/ctx")).toBe(a);
    expect(normalizeRemote("ssh://git@github.com/eesh/ctx.git/")).toBe(a);
  });
});

describe("managed store re-keying", () => {
  it("moves a path-keyed store when a remote appears", async () => {
    const { execFileSync } = await import("node:child_process");
    const { managedDir } = await import("../src/core/repo.js");
    const root = tmpRepo();
    writeState(root, "## Now\na\n## In flight\nb\n## Next\nc\n");
    const before = managedDir(root);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:x/y.git"], { cwd: root });
    const after = managedDir(root);
    expect(after).not.toBe(before);
    expect(readState(root)).toContain("## Now");
  });
});

describe("hub-backed memory", () => {
  it("writes state and notes into the hub project folder the repo maps to", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repos = mkdtempSync(join(tmpdir(), "docsic-repos-"));
    const hubRoot = join(repos, "brain");
    mkdirSync(join(hubRoot, "projects", "shop"), { recursive: true });
    const root = tmpRepo();
    const repo = join(repos, "Shop.ai");
    renameSync(root, repo);
    writeFileSync(join(process.env.DOCSIC_HOME!, "config.json"), JSON.stringify({
      hub: { root: hubRoot, reposRoot: repos, sync: "none", overrides: { shop: { repoDir: "Shop.ai", aliases: ["shop.ai"] } } },
    }));
    writeState(repo, "## Now\nhub\n## In flight\n## Next\n");
    addNote(repo, { title: "Hub note", type: "idea", body: "x" });
    expect(readFileSync(join(hubRoot, "projects", "shop", "state.md"), "utf8")).toContain("hub");
    expect(listNotes(repo)[0].data.title).toBe("Hub note");
  });
});

describe("hub sync", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const sync = (hubRoot: string) => execFileSync("sh", ["-c", HUB_SYNC_SCRIPT, "sh", "mem(x): test"], { cwd: hubRoot, stdio: "ignore" });

  it("commits and pushes state and notes only, and survives a hub with no notes", () => {
    const remote = mkdtempSync(join(tmpdir(), "docsic-remote-"));
    git(remote, "init", "-q", "--bare");
    const hubRoot = tmpRepo();
    git(hubRoot, "remote", "add", "origin", remote);
    write(hubRoot, "projects/a/README.md", "curated");
    commit(hubRoot, "init");
    git(hubRoot, "push", "-q", "-u", "origin", "HEAD");

    write(hubRoot, "projects/a/state.md", "## Now\n");
    sync(hubRoot);
    expect(git(hubRoot, "log", "-1", "--name-only", "--format=%s")).toBe("mem(x): test\n\nprojects/a/state.md");

    write(hubRoot, "projects/a/notes/n.md", "note");
    write(hubRoot, "projects/b/state.md", "## Now\n");
    write(hubRoot, "projects/a/README.md", "curated edit");
    sync(hubRoot);
    expect(git(hubRoot, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["projects/a/notes/n.md", "projects/b/state.md"]);
    expect(git(hubRoot, "status", "--porcelain")).toBe("M projects/a/README.md");
    expect(git(remote, "rev-parse", "HEAD")).toBe(git(hubRoot, "rev-parse", "HEAD"));
  });
});
