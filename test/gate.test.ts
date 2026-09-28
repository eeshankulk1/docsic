import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { formatGate, parseWaivers, runGate } from "../src/core/gate.js";
import * as repo from "../src/core/repo.js";
import { commit, tmpRepo, write } from "./helpers.js";

const head = (root: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

/** A repo with an api doc owning src/api/**, committed as the base. */
function base(extraConfig?: object): { root: string; sha: string } {
  const root = tmpRepo();
  write(root, "docs/architecture.md", "---\nowns: [src/core/**]\n---\n\n# Architecture\n\n| [api.md](api.md) | routes |\n");
  write(root, "docs/api.md", "---\nowns:\n  - src/api/**\n  - src/schemas.ts\nstatus: current\n---\n\n# API\n");
  write(root, "src/api/routes.ts", "export {}\n");
  write(root, "src/core/x.ts", "export {}\n");
  if (extraConfig) write(root, "docs/gate.json", JSON.stringify(extraConfig));
  commit(root, "base");
  return { root, sha: head(root) };
}

describe("docsic gate", () => {
  it("requires a doc when its owned code changes, and passes once the doc is edited", () => {
    const { root, sha } = base();
    write(root, "src/api/routes.ts", "export const x = 1\n");
    commit(root, "code");
    let r = runGate(root, { base: sha });
    expect(r.ok).toBe(false);
    expect(r.required).toEqual([{ doc: "docs/api.md", status: "missing", triggers: ["src/api/routes.ts"] }]);

    write(root, "docs/api.md", "---\nowns: [src/api/**]\n---\n\n# API\n\nnew route\n");
    commit(root, "docs");
    r = runGate(root, { base: sha });
    expect(r.ok).toBe(true);
    expect(r.required[0].status).toBe("edited");
  });

  it("nothing required when no owns: matches; a doc-only change never triggers another doc", () => {
    const { root, sha } = base();
    write(root, "docs/architecture.md", "---\nowns: [src/core/**]\n---\n\n# Architecture\n\n| [api.md](api.md) | routes, edited |\n");
    commit(root);
    const r = runGate(root, { base: sha });
    expect(r.required).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts a waiver with a reason, rejects a too-short one", () => {
    const { root, sha } = base();
    write(root, "src/schemas.ts", "export {}\n");
    commit(root);
    let r = runGate(root, { base: sha, body: "## Summary\n- stuff\n\nDocs-skip: api.md - renamed a private helper, no contract change\n" });
    expect(r.ok).toBe(true);
    expect(r.required[0]).toMatchObject({ doc: "docs/api.md", status: "waived", reason: "renamed a private helper, no contract change" });

    r = runGate(root, { base: sha, body: "Docs-skip: docs/api.md - n/a" });
    expect(r.ok).toBe(false);
    expect(r.required[0].reason).toMatch(/too short/);
  });

  it("counts uncommitted and untracked changes, so it runs before the commit too", () => {
    const { root, sha } = base();
    write(root, "src/api/new.ts", "export {}\n"); // untracked
    const r = runGate(root, { base: sha });
    expect(r.required.map(d => d.triggers)).toEqual([["src/api/new.ts"]]);
  });

  it("reports unowned code, honoring ignore; docs/ is never unowned", () => {
    const { root, sha } = base({ ignore: ["test/**"] });
    write(root, "lib/util.ts", "export {}\n");
    write(root, "test/a.test.ts", "\n");
    write(root, "docs/plans/2026-01-01-x.md", "---\nstatus: active\n---\n");
    commit(root);
    const r = runGate(root, { base: sha });
    expect(r.unowned).toEqual(["lib/util.ts"]);
    expect(r.ok).toBe(true); // unowned is a warning, not a failure
  });

  it("doesn't crash when docs/gate.json ignore is malformed (not an array)", () => {
    const { root, sha } = base({ ignore: "test/**" });
    write(root, "lib/util.ts", "export {}\n");
    commit(root);
    const r = runGate(root, { base: sha });
    expect(r.unowned).toEqual(["lib/util.ts"]);
  });

  it("gate.json owns makes a non-doc file (a test manifest) required", () => {
    const { root, sha } = base({ owns: { ".claude/test-manifest.json": ["Makefile"] } });
    write(root, "Makefile", "test:\n\ttrue\n");
    commit(root);
    let r = runGate(root, { base: sha });
    expect(r.required).toEqual([{ doc: ".claude/test-manifest.json", status: "missing", triggers: ["Makefile"] }]);
    r = runGate(root, { base: sha, body: "Docs-skip: .claude/test-manifest.json - only a comment changed in the Makefile" });
    expect(r.ok).toBe(true);
  });

  it("reports waivers for docs the change doesn't require", () => {
    const { root, sha } = base();
    write(root, "src/api/routes.ts", "export const y = 2\n");
    commit(root);
    const r = runGate(root, { base: sha, body: "- Docs-skip: `api.md` — internal refactor only\nDocs-skip: memory.md - not relevant here at all" });
    expect(r.ok).toBe(true);
    expect(r.unusedWaivers).toEqual(["memory.md"]);
  });

  it("fails loudly when the base can't be resolved", () => {
    const { root } = base();
    expect(() => runGate(root, { base: "origin/nope" })).toThrow(/no merge base/);
  });

  it("fails loudly (not a silent pass) when a real git failure happens mid-scan, e.g. E2BIG from a huge owns: list", () => {
    const { root, sha } = base();
    write(root, "src/api/routes.ts", "export const x = 2\n");
    commit(root);
    const spy = vi.spyOn(repo, "gitOrThrow").mockImplementation(() => {
      throw new Error("spawnSync git E2BIG");
    });
    try {
      expect(() => runGate(root, { base: sha })).toThrow(/docsic gate:.*E2BIG/);
    } finally {
      spy.mockRestore();
    }
  });

  describe("readme cadence", () => {
    /** README committed first, then `n` more commits on the base. */
    function withReadme(n: number, config: object = { readme: { every: 3 } }): { root: string; readmeSha: string } {
      const root = tmpRepo();
      write(root, "README.md", "# x\n");
      write(root, "src/a.ts", "export {}\n");
      write(root, "docs/gate.json", JSON.stringify(config));
      commit(root, "readme");
      const readmeSha = head(root);
      for (let i = 0; i < n; i++) commit(root, `pr ${i}`);
      return { root, readmeSha };
    }

    it("is due once `every` PRs landed since README.md changed, never failing the gate", () => {
      let { root, readmeSha } = withReadme(2);
      let r = runGate(root, { base: head(root) });
      expect(r.readme).toMatchObject({ due: false, prs: 2, every: 3, since: readmeSha.slice(0, 7) });
      expect(formatGate(r)).not.toContain("readme:");

      commit(root, "pr 3");
      r = runGate(root, { base: head(root) });
      expect(r.readme).toMatchObject({ due: true, prs: 3 });
      expect(r.readme!.reason).toMatch(/3 PRs landed since README.md last changed/);
      expect(r.readme!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.ok).toBe(true);
      expect(formatGate(r)).toContain("readme: due - 3 PRs");
    });

    it("is due when a top-level directory appears or disappears; dot dirs and ignored dirs don't count", () => {
      const { root } = withReadme(0, { readme: { every: 10 }, ignore: ["test/**"] });
      write(root, "ios/App.swift", "\n");
      write(root, ".github/ci.yml", "\n");
      write(root, "test/a.test.ts", "\n");
      commit(root, "ios");
      write(root, "worker/main.py", "\n"); // untracked, added by this change
      execFileSync("git", ["rm", "-q", "-r", "src"], { cwd: root });
      const r = runGate(root, { base: head(root) });
      expect(r.readme).toMatchObject({ due: true, prs: 1, dirs: { added: ["ios", "worker"], removed: ["src"] } });
      expect(r.readme!.reason).toMatch(/new top-level dirs ios\/, worker\/; top-level dir removed: src\//);
    });

    it("is not due when this change edits README.md", () => {
      const { root } = withReadme(5);
      write(root, "README.md", "# x\n\nrefreshed\n");
      const r = runGate(root, { base: head(root) });
      expect(r.readme).toMatchObject({ due: false, reason: "README.md is edited in this change" });
      expect(r.unowned).toEqual([]); // never reported as unowned code
    });

    it("is due when README.md is missing; readme.every 0 turns the check off", () => {
      const { root, sha } = base();
      expect(runGate(root, { base: sha }).readme).toMatchObject({ due: true, reason: "README.md is missing" });
      const off = base({ readme: { every: 0 } });
      expect(runGate(off.root, { base: off.sha }).readme).toBeUndefined();
    });
  });

  it("parses waiver variants", () => {
    const w = parseWaivers("Docs-skip: api.md - a\n* Docs-skip: `docs/x.md`: b\nnot Docs-skip: y.md - c\n");
    expect([...w.keys()]).toEqual(["api.md", "docs/x.md"]);
  });
});
