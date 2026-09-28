import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECISIONS_BUDGET, NOTES_BUDGET, orderNotes, takeWithin, tokenBudget } from "../src/core/budget.js";
import { renderProject, type Hub } from "../src/core/hub.js";
import { write } from "./helpers.js";

function hub(): Hub {
  const root = mkdtempSync(join(tmpdir(), "docsic-hub-"));
  return { root, reposRoot: null, projects: [{ slug: "p", match: ["p"], repo: null }], skipPromptMatch: [], sync: "none" };
}

const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

describe("takeWithin", () => {
  it("stops before the budget, always keeps the first item", () => {
    const r = takeWithin(["a".repeat(40), "b".repeat(40), "c".repeat(40)], 20, s => s);
    expect(r.shown).toHaveLength(1);
    expect(r.rest).toHaveLength(2);
    expect(takeWithin(["x".repeat(400)], 10, s => s).shown).toHaveLength(1);
  });

  it("orders notes gotcha > decision > discovery > idea, newest first within a type", () => {
    const n = (file: string, type: string) => ({ file, type });
    const out = orderNotes([n("2026-01-01-a.md", "idea"), n("2026-01-01-b.md", "gotcha"), n("2026-03-01-c.md", "gotcha"), n("2026-02-01-d.md", "decision")]);
    expect(out.map(x => x.file)).toEqual(["2026-03-01-c.md", "2026-01-01-b.md", "2026-02-01-d.md", "2026-01-01-a.md"]);
  });
});

describe("budgeted memory map", () => {
  it("lists decision rows newest-first within budget, then points at the rest", () => {
    const h = hub();
    const rows = Array.from({ length: 60 }, (_, i) => `| ${day(i)} | decision number ${i} ${"x".repeat(90)} | why |`);
    write(h.root, "projects/p/decisions.md", `# Decisions\n\n| Date | Decision | Reasoning |\n|---|---|---|\n${rows.join("\n")}\n`);
    const map = renderProject(h, h.projects[0]).blocks.find(b => b.includes("decisions.md"))!;
    expect(map).toContain("decisions.md (60 rows; read the full row");
    expect(map).toContain(`${day(59)}: decision number 59`);
    expect(map).not.toContain("decision number 0 ");
    const shown = map.split("\n").filter(l => l.startsWith("- ")).length;
    expect(shown).toBeGreaterThan(5);
    expect(map).toContain(`+${60 - shown} older rows in decisions.md - search with docsic recall`);
    expect(tokenBudget(map)).toBeLessThan(DECISIONS_BUDGET + 150);
  });

  it("lists open notes by value within budget; paths cover only what was shown", () => {
    const h = hub();
    for (let i = 0; i < 30; i++) {
      const type = ["gotcha", "decision", "discovery", "idea"][i % 4];
      write(h.root, `projects/p/notes/${day(i)}-note-${i}.md`, `---\ntitle: note ${i} ${"t".repeat(60)}\ntype: ${type}\nstatus: open\ncreated: ${day(i)}\n---\nbody\n`);
    }
    write(h.root, "projects/p/notes/2026-01-01-closed.md", "---\ntitle: closed\ntype: gotcha\nstatus: absorbed\ncreated: 2026-01-01\n---\nx\n");
    const r = renderProject(h, h.projects[0]);
    const block = r.blocks.find(b => b.startsWith("Open notes"))!;
    const lines = block.split("\n").filter(l => l.startsWith("- "));
    expect(lines[0]).toContain("[gotcha] note 28");
    expect(block).not.toContain("[idea]"); // lowest value, pushed past the budget
    expect(block).not.toContain("closed");
    expect(r.paths.filter(p => p.includes("/notes/"))).toHaveLength(lines.length);
    expect(block).toMatch(new RegExp(`\\+${30 - lines.length} more open notes \\(${30 - lines.length} open 30\\+ days\\) in .*/notes - triage them`));
    expect(tokenBudget(block)).toBeLessThan(NOTES_BUDGET + 150);
  });

  it("shows everything, with no trailer, when it fits", () => {
    const h = hub();
    write(h.root, "projects/p/decisions.md", "| Date | Decision | Reasoning |\n|---|---|---|\n| 2026-01-01 | one | r |\n");
    write(h.root, "projects/p/notes/2026-01-01-a.md", "---\ntitle: a\ntype: gotcha\nstatus: open\ncreated: 2026-01-01\n---\nx\n");
    const text = renderProject(h, h.projects[0]).blocks.join("\n");
    expect(text).toContain("- 2026-01-01: one");
    expect(text).not.toMatch(/older row|more open note/);
  });
});
