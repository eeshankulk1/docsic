import { describe, expect, it } from "vitest";
import { absorbNote, addNote, listNotes, readState, writeState } from "../src/core/memory.js";
import { normalizeRemote } from "../src/core/repo.js";
import { tmpRepo } from "./helpers.js";

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
