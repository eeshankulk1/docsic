import { describe, expect, it } from "vitest";
import { commandGradeHits, runMechanicalChecks } from "../src/core/check.js";
import { commit, tmpRepo, write } from "./helpers.js";

const HUB = `---
owns: [.]
status: current
---
# X
| Doc | Owns |
|---|---|
| [local-dev.md](local-dev.md) | setup |
| [plans/](plans/) | history |
`;

describe("mechanical checks", () => {
  it("passes a clean repo", () => {
    const root = tmpRepo();
    write(root, "docs/architecture.md", HUB);
    write(root, "docs/local-dev.md", "---\nowns: [src/**]\nstatus: current\n---\n# Dev\nRedis is required; the worker will not start without it.\n");
    write(root, "docs/plans/2026-01-01-thing.md", "---\nstatus: done\ndate: 2026-01-01\n---\n# plan\n");
    write(root, "docs/ctx.json", "{}");
    commit(root);
    expect(runMechanicalChecks(root)).toEqual([]);
  });

  it("flags missing index rows, bad links, command-grade facts, bad frontmatter", () => {
    const root = tmpRepo();
    write(root, "docs/architecture.md", HUB + "\nsee [ghost](ghost.md)\n");
    write(root, "docs/api.md", "# API\nRuns on localhost:8000 with DATABASE_URL set.\n");
    write(root, "docs/plans/notes.md", "# no frontmatter\n");
    write(root, "docs/reference/dump.md", "# raw\n");
    write(root, "AGENTS.md", "run `npm run dev` to start\n");
    commit(root);
    const rules = runMechanicalChecks(root).map(f => f.rule);
    for (const r of ["hub-index-complete", "hub-index-valid", "links-resolve", "command-grade-misplaced", "doc-frontmatter", "plan-frontmatter", "reference-frontmatter", "agents-file-clean"])
      expect(rules, r).toContain(r);
    expect(rules).not.toContain("hub-missing");
  });

  it("detects staleness from owns: globs", () => {
    const root = tmpRepo();
    write(root, "docs/architecture.md", HUB.replace("local-dev.md](local-dev.md)", "api.md](api.md)"));
    write(root, "docs/api.md", "---\nowns: [src/api/**]\nstatus: current\n---\n# API\n");
    write(root, "src/api/a.ts", "1");
    commit(root, "docs");
    // second commit strictly later
    const later = new Date(Date.now() + 120_000).toISOString();
    write(root, "src/api/a.ts", "2");
    process.env.GIT_AUTHOR_DATE = later; process.env.GIT_COMMITTER_DATE = later;
    commit(root, "code");
    delete process.env.GIT_AUTHOR_DATE; delete process.env.GIT_COMMITTER_DATE;
    const f = runMechanicalChecks(root).find(x => x.rule === "doc-staleness");
    expect(f?.file).toBe("docs/api.md");
  });
});

describe("commandGradeHits", () => {
  it("catches the strong classes and ignores prose + doc links", () => {
    const hits = commandGradeHits([
      "Set STRIPE_SECRET_KEY before deploying.",
      "The API listens on localhost:3000.",
      "npm run build",
      "Uses claude-sonnet-4-5 by default.",
      "See https://github.com/x/y and the Redis docs.",
      "The worker needs Redis; it will not start without it.",
    ].join("\n"));
    expect(hits.map(h => h.cls)).toEqual(["env var", "port", "shell command", "model ID"]);
  });
});
