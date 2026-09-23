import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMechanicalChecks } from "../src/core/check.js";
import { apply, triage } from "../src/core/init.js";
import { commit, tmpRepo, write } from "./helpers.js";

describe("init triage", () => {
  it("classifies agent artifacts, payloads, other tools; applies without deleting", () => {
    const root = tmpRepo();
    write(root, "tests/AUTH_FIX_SUMMARY.md", "# done\nstuff\n");
    write(root, "DESIGN_NOTES.md", "# design\n");
    write(root, "sample.json", JSON.stringify({ a: "x".repeat(3000) }));
    write(root, ".kiro/spec.md", "spec");
    write(root, "src/README.md", "nested readme");
    write(root, "thoughts.md", "# loose\nprose\n");
    write(root, "README.md", "# App\n");
    commit(root);
    const t = triage(root);
    expect(t.moves.map(m => m.kind).sort()).toEqual(["plan", "plan", "reference"]);
    expect(t.flagged[0]).toMatch(/\.kiro/);
    expect(t.ambiguous).toEqual(["thoughts.md"]);
    const r = apply(root, t);
    expect(r.moved.length).toBe(3);
    expect(existsSync(join(root, "src/README.md"))).toBe(true);
    const plan = readFileSync(join(root, r.moved[0].split(" -> ")[1]), "utf8");
    expect(plan).toMatch(/status: done/);
    expect(plan).toMatch(/original-path: /);
    expect(existsSync(join(root, "docs/docsic.json"))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    commit(root);
    // scaffold is index-complete for what it moved; only the TODO leaf docs are missing
    const rules = runMechanicalChecks(root).map(f => f.rule);
    expect(rules).not.toContain("hub-index-complete");
    expect(rules).not.toContain("plan-frontmatter");
  });
});
